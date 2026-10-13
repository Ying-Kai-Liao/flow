import type { AgentInfo } from 'claude-code'
import type { Activity, AgentRow, Session, TestSlots } from '../types'
import { LOG_MAX } from './core'
import { killRefusal, remoteDeleteRefusal } from './guards'
import { describeCall } from './pane'
import { stripEngineFields, subagentRefusal } from './relay'
import type { PumpIo, RelayAnswer, RelayCall } from './relay'
import { pumpRelay } from './relay'
import { needLines, normText } from './reviewer-route'
import type { Forwarded } from './reviewer-route'
import type { settingsOf } from './settings'
import { sessionKey, sessionLive } from './sessions'
import { slotRefusal, suiteRun, typecheckRefusal, typecheckRun } from './testguard'
import { isFlowTool } from './toolguard'
import { WRITE_TOOLS } from './toolcall-run'

// The relay's two ends over main's state: the client in a terminal's copy of the plugin (relayToolCall) and the
// pump in main that answers its calls (pumpOnce, relayExec, sendFrom). The engine handle `$` is never passed
// across an import, so register.tsx hands in a RelayRunIo; the same pattern as toolcall-run.ts.

type Settings = ReturnType<typeof settingsOf>

// What this process is when a terminal-started claude loads its own copy of this plugin; FLOW_ROLE / FLOW_NAME /
// FLOW_RELAY tell that copy. Set at session.start; undefined in a normal session (main, or an Agent-tool subagent).
export type RelayMode = { role: 'worker' | 'manager' | 'reviewer'; name: string; dir: string | undefined }

// A flow tool's outcome as the tool.call hook returns it.
export type RelayOut = { result: unknown } | { deny: string }

export type RelayRunIo = {
  // The relay mode set at session.start; only called in a relay copy.
  relay: () => RelayMode
  // The relay client: one call to main through the directory.
  call: (dir: string, req: { tool: string; input: Record<string, unknown>; from: string; role: string; by: string }) => Promise<RelayAnswer>
  agents: () => Promise<AgentInfo[]>
  sessionCwd: () => Promise<string | undefined>
  mainGuard: (e: Record<string, unknown>, cwd: () => Promise<string | undefined>, allow: string[]) => Promise<string | undefined>
  now: () => Promise<number>
  best: (what: string, fn: () => Promise<void>) => Promise<void>
  sessions: () => Promise<Record<string, Session>>
  seenAgents: () => Promise<Record<string, { id?: string }>>
  forwarded: () => Promise<Forwarded>
  toMain: (text: string) => void
  ownerName: (id: string | undefined) => Promise<string>
  routeGuard: (key: string, to: string, text: string) => Promise<string | undefined>
  deliverTerminal: (from: string, key: string, text: string) => Promise<boolean>
  deliver: (id: string, text: string) => Promise<boolean>
  warn: (what: string, err: unknown) => Promise<void>
  myRoleSessions: () => Promise<Session[]>
  pumpIo: PumpIo
}

// What main needs to run one relayed call, over one call's context.
export type RelayExecIo = RelayRunIo & {
  updateActivity: (fn: (acts: Record<string, Activity>) => Record<string, Activity>) => Promise<unknown>
  testSlots: () => Promise<TestSlots>
  typecheckSlots: () => Promise<TestSlots>
  refresh: () => Promise<AgentRow[]>
  slotLimits: () => { test: number; typecheck: number }
  flowTools: readonly string[]
  runFlow: (tool: string, input: Record<string, unknown>) => Promise<RelayAnswer>
}

// Module state, single: the pump's re-entrancy guard.
export const pumpState = { pumping: false }

// What a terminal sees of a message: SendMessage's own envelope names the sender, a typed line cannot.
export const messageFrom = (from: string, text: string): string => `Message from ${from}: ${text}`

// SendMessage to a terminal session, answered as the tool's refusal text: the message went by typing it
// in, which the model must not retry through the host.
export async function deliverToSessionTo(io: RelayRunIo, fromId: string | undefined, target: Session, text: string): Promise<string> {
  const from = fromId === undefined ? 'main' : await io.ownerName(fromId)
  if (!sessionLive(target)) return `Not delivered: session ${target.name} has ${target.status}.`
  const ok = await io.deliverTerminal(from, sessionKey(target.name), messageFrom(from, text))
  return ok ? `Delivered to ${target.name} by flow (terminal session).` : `Not delivered: session ${target.name} could not be reached.`
}

// A terminal manager's report is a file it writes itself: <state dir>/sessions/<name>/report.md, next to its relay dir.
// Exactly that path, by the manager's own thread (not a subagent); nothing else.
function ownReport(r: RelayMode, agentId: string | undefined, e: { tool: string }): boolean {
  if (agentId !== undefined || r.dir === undefined || (e.tool !== 'Write' && e.tool !== 'Edit')) return false
  const file = (e as { file_path?: unknown }).file_path
  return typeof file === 'string' && file === `${r.dir.replace(/\/relay\/?$/, '')}/report.md`
}

// The generic hook in a relay copy. A worker's passes straight through. A manager's or the reviewer's keeps
// the guards that need no state (kills, remote deletes, code edits by a manager, the main checkout), asks
// main for the ones that do (test slots), and answers every flow tool, and a SendMessage to anyone this
// session cannot see, through the relay. Activity and the ledger are main's business.
export async function relayToolCallTo(io: RelayRunIo, settings: Settings, e: { tool: string; agentId?: string; command?: string }): Promise<RelayOut | undefined> {
  const r = io.relay()
  if (r.role === 'worker') return undefined
  const id = e.agentId
  const from = sessionKey(r.name)
  const ask = (tool: string, input: Record<string, unknown>) => r.dir === undefined
    ? Promise.resolve<RelayAnswer>({ result: 'flow relay: FLOW_RELAY is not set, so this session cannot reach the main session.' })
    : io.call(r.dir, { tool, input, from, role: r.role, by: id ?? r.name })
  if (e.tool === 'Bash') {
    const command = String(e.command ?? '')
    const why = killRefusal(command)
    if (why !== undefined) return { deny: why }
    const suite = suiteRun(command, settings.testSlotCommands ?? [])
    if (suite !== undefined) {
      const a = await ask('slot-check', { suite })
      if (a.deny !== undefined) return { deny: a.deny }
      // Anything but "ok" is the relay failing to reach main: the run waits, as a refusal would.
      if (a.result !== 'ok') return { deny: String(a.result) }
    }
    const typecheck = typecheckRun(command, settings.typecheckCommands ?? [])
    if (typecheck !== undefined) {
      const a = await ask('slot-check', { typecheck })
      if (a.deny !== undefined) return { deny: a.deny }
      if (a.result !== 'ok') return { deny: String(a.result) }
    }
    const del = remoteDeleteRefusal(command)
    if (del !== undefined) return { deny: del }
  }
  if (WRITE_TOOLS.includes(e.tool) && r.role === 'manager' && !ownReport(r, id, e)) {
    return { deny: 'flow: managers don\'t edit code. Put the change in a worker\'s brief, or send it to the worker that owns the file.' }
  }
  if (settings.mainGuard) {
    const cwd = async () => (id === undefined || r.role === 'manager' ? io.sessionCwd() : undefined)
    const why = await io.mainGuard(e as unknown as Record<string, unknown>, cwd, settings.mainAllow)
    if (why !== undefined) return { deny: why }
  }
  if (isFlowTool(e.tool)) {
    // A subagent's call reaches main as the manager's; it may look, not write (relay.ts, subagentRefusal).
    // The reviewer's subagents keep the manager-less behaviour they had: its tools are not the ones that decide work.
    if (id !== undefined && r.role === 'manager') {
      const why = subagentRefusal(e.tool, stripEngineFields(e as unknown as Record<string, unknown>), r.name)
      if (why !== undefined) return { deny: why }
    }
    const a = await ask(e.tool, stripEngineFields(e as unknown as Record<string, unknown>))
    return a.deny !== undefined ? { deny: a.deny } : { result: a.result }
  }
  if (e.tool === 'SendMessage') {
    const input = e as unknown as Record<string, unknown>
    const to = String(input.to ?? '')
    if (!(await io.agents()).some(a => a.id === to || a.name === to)) {
      const a = await ask('send', { to, text: String(input.message ?? input.text ?? '') })
      // Whatever main answered is the reason nothing went through the host: "Sent to X by flow." or why not.
      return { deny: a.deny ?? String(a.result) }
    }
  }
  return undefined
}

// Whether every line of a reviewer's text to main was already forwarded to main for that reviewer.
export async function alreadyForwardedTo(io: RelayRunIo, rid: string, text: string): Promise<boolean> {
  const lines = text.split('\n').map(normText).filter(l => l !== '')
  const sent = (await io.forwarded()).lines[rid] ?? []
  return lines.length > 0 && lines.every(l => sent.includes(l) || (needLines(l).length > 0 && needLines(l).every(n => sent.includes(n))))
}

// A SendMessage from a terminal session to someone: as the sender, to a session, an agent or main.
async function sendFrom(io: RelayRunIo, key: string, name: string, to: string, text: string): Promise<RelayAnswer> {
  if (to === '' || to === '*') return { deny: 'Not sent: name one agent or session to send to.' }
  const all = await io.sessions()
  if (all[name]?.role === 'reviewer') {
    let handled: string | undefined
    await io.best('routing a reviewer message', async () => { handled = await io.routeGuard(key, to, text) })
    if (handled !== undefined) return { deny: handled }
  }
  const body = messageFrom(name, text)
  if (to === 'main') {
    if (all[name]?.role === 'reviewer' && await alreadyForwardedTo(io, key, text)) {
      return { deny: 'Not sent: main already has this report (the plugin forwarded it). Do not repeat it.' }
    }
    io.toMain(body)
    return { result: 'Sent to main by flow.' }
  }
  const target = all[to] ?? all[to.replace(/^session:/, '')]
  const onRoster = (await io.agents()).some(a => a.id === to || a.name === to)
  if (target !== undefined && (sessionLive(target) || !onRoster)) {
    if (!sessionLive(target)) return { deny: `Not sent: session ${target.name} has ${target.status}.` }
    return (await io.deliverTerminal(name, sessionKey(target.name), body))
      ? { result: `Sent to ${target.name} by flow.` } : { deny: `Not sent: ${target.name} could not be reached.` }
  }
  const listed = (await io.agents()).find(a => a.id === to || a.name === to)
  // A manager the host dropped from the roster is held by the id last seen for it.
  const seenId = listed === undefined ? (await io.seenAgents())[to]?.id : undefined
  const targetId = listed?.id ?? seenId
  if (targetId === undefined) return { deny: `Not sent: no agent or session named "${to}".` }
  return (await io.deliver(targetId, body)) ? { result: `Sent to ${to} by flow.` } : { deny: `Not sent: ${to} has ended.` }
}

// One relayed call, run in main as the session that left it (`session:<name>`): the flow tools, and
// two pseudo-tools for the guards the copy cannot judge itself (it has no slots, and no roster).
async function relayExec(io: RelayExecIo, call: RelayCall, name: string): Promise<RelayAnswer> {
  const key = sessionKey(name)
  const input = call.input
  await io.best('logging a relayed call', async () => {
    const t = await io.now()
    const line = describeCall({ ...input, tool: call.tool })
    await io.updateActivity(acts => {
      const a = acts[key] ?? { startedAt: t, lastAt: t, log: [] }
      return { ...acts, [key]: { ...a, lastAt: t, log: [...a.log, line].slice(-LOG_MAX) } }
    })
  })
  if (call.tool === 'slot-check' && typeof input.typecheck === 'string') {
    const refused = typecheckRefusal(await io.typecheckSlots(), await io.testSlots(), await io.refresh(), key, io.slotLimits().typecheck, await io.now(), input.typecheck)
    return refused === undefined ? { result: 'ok' } : { deny: refused }
  }
  if (call.tool === 'slot-check') {
    const refused = slotRefusal(await io.testSlots(), await io.refresh(), key, io.slotLimits().test, await io.now(), String(input.suite ?? ''))
    return refused === undefined ? { result: 'ok' } : { deny: refused }
  }
  if (call.tool === 'send') return sendFrom(io, key, name, String(input.to ?? ''), String(input.text ?? ''))
  if (!io.flowTools.includes(call.tool)) return { deny: `flow relay: ${call.tool} is not a flow tool` }
  return io.runFlow(call.tool, { ...input, agentId: key })
}

// One tick of main's pump: runs the calls the role sessions left. Does nothing until one is live, and
// a tick that overlaps the one before it (a slow listing) returns at once.
export async function pumpOnceTo(io: RelayExecIo): Promise<void> {
  if (pumpState.pumping) return
  pumpState.pumping = true
  try {
    if ((await io.myRoleSessions()).length === 0) return
    await pumpRelay(io.pumpIo, (call, name) => relayExec(io, call, name))
  } catch (err) {
    await io.warn('relay pump', err)
  } finally {
    pumpState.pumping = false
  }
}
