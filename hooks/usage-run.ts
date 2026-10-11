import type { Activity, AgentRow, Role } from '../types'
import { addStep, addTurn } from './cost'
import { changeLedger, loadLedger, mainKey, type CostIo } from './cost-run'
import { MANAGER, WORKERS } from './core'
import { labelOf, limitLabel, thresholdOf, windowOf } from './meter'
import { ROLE } from './pane'
import type { WarnSettings } from './settings'

// The usage accounting behind turn.step and turn.complete. The atoms and the hooks stay in
// register.tsx; this takes closures over them (the engine refuses `$` across an import).
export type UsageIo = {
  cost: CostIo
  now: () => Promise<number>
  activity: () => Promise<Record<string, Activity>>
  updateActivity: (fn: (acts: Record<string, Activity>) => Record<string, Activity>) => Promise<void>
  agents: () => Promise<AgentRow[]>
  toast: (text: string) => void
  // The wrap-up message for an agent between turns.
  sendWrapUp: (me: AgentRow, percent: number, limit: string) => Promise<void>
  // Main's one-time warning; returns main's window when known.
  warnMain: () => Promise<number | undefined>
  // Main's model and window, held in register.tsx.
  mainModel: () => string | undefined
  setMainModel: (model: string | undefined) => void
  mainWindow: () => number | undefined
  setMainWindow: (window: number) => void
}

type Handoff = WarnSettings & { handoff: boolean }
type StepEvent = { agentId?: string; model: string }

// Context used by an agent: the input side of its latest step. Cosmetic: never fails the step.
export async function meterStep(io: UsageIo, settings: Handoff, e: StepEvent, r: any): Promise<void> {
  try {
    const id = e.agentId
    if (id === undefined) {
      io.setMainModel(e.model)
    } else if (r?.usage) {
      const tokens = r.usage.input_tokens + r.usage.cache_creation_input_tokens + r.usage.cache_read_input_tokens
      // The API's id usually lacks `[1m]`; keep the engine's when it has it, or the window is guessed at 200k.
      const model = e.model.includes('[1m]') ? e.model : r.usage.model || e.model
      const t = await io.now()
      const spawned = (await io.activity())[id]?.spawnWindow
      const window = windowOf(model, io.mainModel(), io.mainWindow(), tokens, spawned)
      await io.updateActivity(acts => {
        const a = acts[id] ?? { startedAt: t, lastAt: t, log: [] }
        return { ...acts, [id]: { ...a, usage: { tokens, model, ...(spawned !== undefined && { window }) } } }
      })
      // Tell a worker or manager once when it reaches the threshold. Marked before it is sent, so a
      // send that fails (the agent already ended) is not retried every step. Below it again (the
      // agent compacted) the mark clears, so a later crossing tells it again.
      const percent = Math.min(100, Math.round(tokens / window * 100))
      const past = tokens >= thresholdOf(settings, window)
      const was = (await io.activity())[id]
      if (settings.handoff && !past && was?.handoffNotifiedAt !== undefined) {
        await io.updateActivity(acts => {
          const a = acts[id]
          if (a === undefined) return acts
          const { handoffNotifiedAt: _n, handoffPercent: _p, remindedPercent: _r, callsPastLimit: _k, ...rest } = a
          return { ...acts, [id]: rest }
        })
      }
      if (settings.handoff && past && was?.handoffNotifiedAt === undefined) {
        const me = (await io.agents()).find(a => a.id === id)
        if (me && (WORKERS.has(me.type) || me.type === MANAGER)) {
          await io.updateActivity(acts => {
            const a = acts[id] ?? { startedAt: t, lastAt: t, log: [] }
            return { ...acts, [id]: { ...a, handoffNotifiedAt: t, handoffPercent: percent, remindedPercent: percent, callsPastLimit: 0, remindersSent: a.remindersSent ?? 0 } }
          })
          io.toast(`${ROLE[me.type]} ${labelOf(me)}: past ${limitLabel(settings, window)} context, handing off`)
          // For an agent between turns; one in a turn reads the reminder on its next tool call.
          await io.sendWrapUp(me, percent, limitLabel(settings, window))
        }
      }
    }
    if (id === undefined) {
      const w = await io.warnMain()
      if (w !== undefined) io.setMainWindow(w)
    }
  } catch {
    // The meter is cosmetic: never fail the agent's step over it.
  }
}

// One step's tokens into the cost ledger. Best-effort: the step passes untouched.
export async function countStep(io: UsageIo, e: StepEvent, r: any): Promise<void> {
  try {
    if (r?.usage) {
      const key = e.agentId ?? await mainKey(io.cost)
      const model = r.usage.model || e.model
      await loadLedger(io.cost)
      // A step that arrives before its spawn was seen takes its identity from the roster.
      let who: { role: Role; name: string; manager?: string; branch?: string } | undefined
      if (e.agentId !== undefined && (await io.cost.ledger())[key] === undefined) {
        const all = await io.agents()
        const me = all.find(a => a.id === e.agentId)
        if (me) {
          const role = (ROLE[me.type] ?? 'other') as Role
          const parent = all.find(a => a.id === me.parentId)
          const name = labelOf(me)
          who = { role, name, ...(role === 'worker' && parent?.name !== undefined && { manager: parent.name }), ...(role === 'worker' && { branch: `flow/${name}` }) }
        }
      }
      await changeLedger(io.cost, (l, now) => addStep(l, key, model, r.usage, who, now))
    }
  } catch {
    // The ledger is best-effort: the step passes untouched.
  }
}

// A completed turn counts once per agent (interrupted or errored too: it still wrote the cache).
// `counted` is per plugin instance; a missing turnId always counts.
export async function countTurn(io: CostIo, counted: Set<string>, agentId: string | undefined, turnId: string | undefined): Promise<void> {
  try {
    const key = agentId ?? await mainKey(io)
    const once = turnId === undefined || !counted.has(`${key}:${turnId}`)
    if (turnId !== undefined) counted.add(`${key}:${turnId}`)
    if (once) {
      await loadLedger(io)
      await changeLedger(io, (l, now) => addTurn(l, key, now))
    }
  } catch {
    // The ledger is best-effort: the turn passes untouched.
  }
}
