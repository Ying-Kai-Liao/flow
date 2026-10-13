import type { AgentInfo } from 'claude-code'
import type { Activity, AgentRow, Handover, LogEvent, Session, TestSlots } from '../types'
import { isReviewer, LIVE_STATUS, MANAGER, WORKER, WORKERS } from './core'
import { ENDED } from './deliver'
import type { DeliverOptions } from './deliver'
import { agentFor, asksQuestion, noticeText, settle } from './dag'
import type { AgentFact, Facts, Notice, Plan } from './dag'
import { askingNames } from './inbox'
import type { Inbox } from './inbox'
import { labelOf } from './meter'
import { ROLE } from './pane'
import { sessionRow } from './sessions'
import { branchOwners } from './state'

// Syncing the plans and refreshing the roster. The atoms and the hooks stay in register.tsx; this takes
// closures over them (the engine refuses `$` across an import).
export type RosterIo = {
  list: () => Promise<AgentInfo[]>
  now: () => Promise<number>
  plan: () => Promise<Plan>
  updatePlan: (fn: (p: Plan) => Plan) => Promise<void>
  activity: () => Promise<Record<string, Activity>>
  updateActivity: (fn: (all: Record<string, Activity>) => Record<string, Activity>) => Promise<void>
  handovers: () => Promise<Record<string, Handover>>
  seen: () => Promise<Record<string, AgentFact>>
  setSeen: (known: Record<string, AgentFact>) => Promise<void>
  log: () => Promise<LogEvent[]>
  inbox: () => Promise<Inbox>
  roster: () => Promise<AgentRow[]>
  setRoster: (rows: AgentRow[]) => Promise<void>
  setNow: (t: number) => Promise<void>
  sessions: () => Promise<Record<string, Session>>
  testSlots: () => Promise<TestSlots>
  toast: (text: string) => void
  status: (line: string | undefined) => void
  // Wakes main with a prompt, on the next tick.
  wakeMain: (text: string) => void
  autoSweep: () => void
  settleSlots: (rows: AgentRow[], t: number) => Promise<void>
  unhanded: () => Promise<number>
  preflightTick: (rows: AgentRow[]) => Promise<void>
  deliver: (id: string, text: string, opts?: DeliverOptions) => Promise<boolean>
  tellMain: (name: string, text: string) => Promise<void>
  markResumable: (id: string) => void
  decisionPhrases: () => string[]
  maxManagers: () => number
  slotLimit: () => number
  typecheckSlots?: () => Promise<TestSlots>
  typecheckLimit?: () => number
}

// Managers whose end already freed a slot (and woke main), so a poll does not wake it twice.
// Module state, as it was in register.tsx: shared by every poll.
const freedSeen = new Set<string>()

export const isManagerOf = (owner: string, name: string | undefined) =>
  name !== undefined && (name === owner || (name.startsWith(owner + '-') && /^\d+$/.test(name.slice(owner.length + 1))))

// Whose graph an agent works on: its own name, or the manager it continues (`<name>-N`); main has none.
export function planOwner(plans: Plan, name: string | undefined): string {
  if (name === undefined) return 'main'
  if (plans[name]) return name
  const m = /^(.+)-\d+$/.exec(name)
  return m && plans[m[1]!] ? m[1]! : name
}

export const liveManagers = (rows: AgentRow[]) => rows.filter(a => a.type === MANAGER && !ENDED.has(a.status))

// Settles every plan against the roster and handovers in one update, then tells each owner once.
// `edit` changes the plan first (the plan tool); `quietOwner` is the caller, who sees the outcome
// in its own tool result and needs no message.
export async function syncPlansTo(
  io: RosterIo, rows: AgentRow[], edit?: (p: Plan) => Plan, quietOwner?: string,
): Promise<Plan> {
  // Marked before the first await, so two overlapping polls count an ended manager once.
  const freed = rows.filter(a => a.type === MANAGER && ENDED.has(a.status) && !freedSeen.has(a.id))
  for (const a of freed) freedSeen.add(a.id)
  if (edit === undefined && Object.keys(await io.plan()).length === 0) return {}
  const [acts, hs] = await Promise.all([io.activity(), io.handovers()])
  const agents: AgentFact[] = rows.map(a => ({
    id: a.id, name: a.name, status: a.status, answer: acts[a.id]?.answer,
    children: rows.filter(c => c.parentId === a.id && LIVE_STATUS.has(c.status)).length,
    at: acts[a.id]?.lastAt,
    childAt: Math.max(0, ...rows.filter(c => c.parentId === a.id).map(c => acts[c.id]?.lastAt ?? 0)),
  }))
  const known = { ...(await io.seen()) }
  const present = new Set(rows.map(a => a.name))
  for (const a of agents) if (a.name !== undefined) known[a.name] = a
  for (const [name, a] of Object.entries(known)) if (!present.has(name)) agents.push(a)
  if (JSON.stringify(known) !== JSON.stringify(await io.seen())) await io.setSeen(known)
  const owners = branchOwners(await io.log())
  const facts: Facts = {
    agents, owners,
    handovers: Object.values(hs),
    phrases: io.decisionPhrases(),
    asking: askingNames(await io.inbox()),
  }
  const slots = Math.max(0, io.maxManagers() - liveManagers(rows).length)
  let notices: Notice[] = []
  let result: Plan = {}
  await io.updatePlan(p => {
    const r = settle(edit ? edit(p) : p, facts, { slots })
    notices = r.notices
    result = r.plan
    // A slot freed while ready tasks wait: tell main again, once per ended manager.
    const waiting = Object.values(r.plan['main'] ?? {}).filter(n => n.state === 'ready')
    if (freed.length > 0 && slots > 0 && waiting.length > 0 && !notices.some(n => n.owner === 'main')) {
      notices = [...notices, { owner: 'main', ready: waiting, blocked: [], done: [], slots }]
    }
    return r.plan
  })
  for (const n of notices) {
    if (n.owner === quietOwner) continue
    const text = noticeText(n)
    if (n.owner === 'main') {
      io.wakeMain(text)
    } else {
      const agent = agentFor(n.owner, rows.filter(a => !ENDED.has(a.status)))
      if (agent) await io.deliver(agent.id, text).catch(() => undefined)
      else {
        // The owner ended its turn to wait (the host reports it completed or drops it): a ready node means it
        // has work left, so the notice wakes it. Only a manager that cannot be resumed sends it to main.
        const gone = agentFor(n.owner, agents.filter(a => a.status !== 'failed' && a.status !== 'killed'))
        if (gone?.id !== undefined) {
          io.markResumable(gone.id)
          await io.deliver(gone.id, text, { onGone: t => io.tellMain(n.owner, t) }).catch(() => undefined)
        } else if (agentFor(n.owner, agents) !== undefined) await io.tellMain(n.owner, text)
      }
    }
  }
  return result
}

// The roster as the board shows it: every agent of the session, with its role.
export async function refreshTo(io: RosterIo): Promise<AgentRow[]> {
  const [list, t, before, acts] = await Promise.all([
    io.list(), io.now(), io.roster(), io.activity(),
  ])
  const rows: AgentRow[] = list.map(a => ({
    id: a.id, name: a.name, description: a.description, type: a.type,
    status: a.status, parentId: a.parentId,
  }))
  // Workers in other harnesses stand in the tree like agents, under the manager that started them.
  rows.push(...Object.values(await io.sessions()).map(sessionRow))
  const was = new Map(before.map(a => [a.id, a.status]))
  const ended: string[] = []
  const askers = askingNames(await io.inbox())
  for (const a of rows) {
    const prev = was.get(a.id)
    // The reviewer's worktree (detached at the base) goes once the reviewer is gone, also when
    // its ending was not seen as a transition (a reload left the roster record empty).
    if (ENDED.has(a.status) && isReviewer(a.type) && (prev === undefined || (prev !== a.status && !ENDED.has(prev)))) io.autoSweep()
    if (prev === undefined || prev === a.status || ENDED.has(prev)) continue
    if (ENDED.has(a.status) && acts[a.id] !== undefined) ended.push(a.id)
    if (ENDED.has(a.status) || a.status === 'idle') {
      const asks = asksQuestion(acts[a.id]?.answer, io.decisionPhrases()) || askers.includes(a.name ?? '')
      const role = ROLE[a.type] ? `${ROLE[a.type]} ` : ''
      io.toast(`${role}${labelOf(a)}: ${asks ? 'asks a question' : a.status === 'idle' ? 'finished its turn' : a.status}`)
    }
  }
  if (ended.length > 0) {
    await io.updateActivity(all => {
      const next = { ...all }
      for (const id of ended) if (next[id] !== undefined && next[id]!.endedAt === undefined) next[id] = { ...next[id]!, endedAt: t }
      return next
    })
  }
  if (JSON.stringify(rows) !== JSON.stringify(before)) await io.setRoster(rows)
  await io.setNow(t)
  // Free the test slots of ended agents and pass them on.
  await io.settleSlots(rows, t)

  const hs = Object.values(await io.handovers())
  const live = rows.filter(a => !ENDED.has(a.status))
  const count = (type: string) => live.filter(a => a.type === type || (type === WORKER && WORKERS.has(a.type))).length
  const queued = hs.filter(h => h.status === 'pending' || h.status === 'taken').length
  const awaiting = hs.filter(h => h.status === 'awaiting').length
  const parts = [
    count(MANAGER) && `${count(MANAGER)} managers`,
    count(WORKER) && `${count(WORKER)} workers`,
    queued && `reviewer: ${queued} PR${queued > 1 ? 's' : ''}`,
    awaiting && `${awaiting} awaiting approval`,
  ].filter(Boolean)
  const unhanded = await io.unhanded()
  if (unhanded) parts.push(`${unhanded} unhanded`)
  const slots = await io.testSlots()
  const tc = io.typecheckSlots ? await io.typecheckSlots() : undefined
  const slotPart = (slots.holders.length || slots.waiters.length ? ` · tests ${slots.holders.length}/${io.slotLimit()}` : '')
    + (tc && (tc.holders.length || tc.waiters.length) ? ` · tsc ${tc.holders.length}/${io.typecheckLimit?.() ?? 1}` : '')
  io.status(rows.length === 0 && hs.length === 0 && !unhanded ? undefined
    : `flow: ${parts.length ? parts.join(' · ') : `${live.length} live`}${slotPart} · /flow`)
  await syncPlansTo(io, rows).catch(() => undefined)
  await io.preflightTick(rows).catch(() => undefined)
  return rows
}
