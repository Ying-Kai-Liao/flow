import type { Activity, AgentRow, HandoffRecord, LogEvent } from '../types'
import { adviceLine, adviceSuffix } from './decide-use'
import type { DecideUseSettings, HandoffAsk, Lean } from './decide-use'
import { sourceOf } from './decide'
import { lastLineAsks, REPORT_HINT } from './askcards'
import { FLOW_TYPES } from './spawn'
import { buildDigest, findWorktree } from './state'
import { reviewerReport, RELAY_DELAY_MS } from './reviewer-route'
import { isReviewer, MANAGER, TEXT_MAX, WORKERS } from './core'
import type { DeliverOptions } from './deliver'

// The bodies of the turn.step and turn.complete hooks. The registrations (and the `yield* next(...)` of the
// step) stay in register.tsx; this takes closures over the atoms, the roster and the state of register()
// (the engine refuses `$` across an import).
export type TurnIo = {
  now: () => Promise<number>
  // Delivers the texts held for a running agent.
  flushAgent: (id: string) => Promise<void>
  activity: () => Promise<Record<string, Activity>>
  updateActivity: (fn: (acts: Record<string, Activity>) => Record<string, Activity>) => Promise<void>
  // The effort flow routes to each agent, set at spawn; and the agents whose saved effort was already looked up.
  agentEffort: Map<string, string>
  effortSeen: Set<string>
  refresh: () => Promise<AgentRow[]>
  best: (what: string, fn: () => Promise<void>) => Promise<void>
  appendLog: (event: Omit<LogEvent, 'ts'>, max?: number) => Promise<void>
  readLog: () => Promise<LogEvent[]>
  // The running reviewer's batch work, if it did any.
  reviewerWork: (id: string) => Promise<Parameters<typeof reviewerReport>[1]>
  relayReviewerReport: (id: string, name: string, answer: string) => Promise<void>
  reviewerEnded: (name: string, end: { answer: string; reason?: string; status?: string }) => Promise<void>
  // Managers someone other than main woke: a report from one is relayed to main once.
  wokenByOthers: Set<string>
  mainHasAnswer: (answer: string) => Promise<boolean>
  toMain: (text: string) => void
  after: (ms: number, fn: () => void) => void
  // The handoff record.
  stateDir: () => Promise<string | undefined>
  messages: (agentId: string) => Promise<Parameters<typeof buildDigest>[0] | { deny: unknown }>
  run: (argv: string[]) => Promise<{ exitCode: number; stdout: string }>
  mkdirp: (dir: string) => Promise<void>
  write: (path: string, text: string) => Promise<void>
  setHandoff: (branch: string, record: HandoffRecord) => Promise<void>
  lean: (ask: HandoffAsk) => Promise<Lean | undefined>
  toast: (text: string) => void
  deliver: (id: string, text: string, opts?: DeliverOptions) => Promise<boolean>
  maxContinues: () => number
  decideSettings: () => DecideUseSettings
  askCards: () => boolean
}

// Before the step: the agent is running now, and flow's effort for it replaces the host's, only on a model
// that takes one (effort set) and never on main (no agentId). Returns the event to step with.
export async function beforeStep<E extends { agentId?: string; effort?: unknown }>(io: TurnIo, e: E): Promise<E> {
  if (e.agentId !== undefined) await io.flushAgent(e.agentId).catch(() => undefined)
  let step = e
  if (e.agentId !== undefined && e.effort !== undefined) {
    if (!io.effortSeen.has(e.agentId)) {
      io.effortSeen.add(e.agentId)
      if (!io.agentEffort.has(e.agentId)) {
        const saved = (await io.activity().catch(() => ({} as Record<string, { effort?: string }>)))[e.agentId]?.effort
        if (saved !== undefined) io.agentEffort.set(e.agentId, saved)
      }
    }
    const target = io.agentEffort.get(e.agentId)
    if (target !== undefined) step = { ...e, effort: target as E['effort'] }
  }
  return step
}

// A worker's HANDOFF: write the digest, log it, remember where its worktree is, and warn the owner when the
// package keeps handing off. Best-effort throughout: a missing digest still leaves the record.
export async function recordHandoff(io: TurnIo, me: AgentRow, branch: string, owner: string): Promise<void> {
  const maxContinues = io.maxContinues()
  const decideSettings = io.decideSettings()
  const prior = (await io.readLog()).filter(ev => ev.event === 'handoff' && ev.branch === branch)
  // turn.complete can fire again for the same agent; count its handoff once.
  if (prior.some(ev => ev.agent === me.name)) return
  const count = prior.length + 1
  let digestPath: string | undefined
  let note: string | undefined
  await io.best('writing a handoff digest', async () => {
    const dir = await io.stateDir()
    if (dir === undefined) return
    const msgs = await io.messages(me.id)
    if ('deny' in msgs) return
    const path = `${dir}/handoffs/${branch.replaceAll('/', '-')}/${count}.md`
    await io.mkdirp(path.slice(0, path.lastIndexOf('/')))
    note = buildDigest(msgs, branch, me.name ?? me.id)
    await io.write(path, note)
    digestPath = path
  })
  let wt: { path: string; head?: string } | undefined
  await io.best('finding the worktree', async () => {
    const r = await io.run(['git', 'worktree', 'list', '--porcelain'])
    if (r.exitCode === 0) wt = findWorktree(r.stdout, me.id, branch)
  })
  await io.appendLog({ event: 'handoff', agent: me.name, owner, branch, text: digestPath })
  const record: HandoffRecord = {
    branch, agent: me.name ?? me.id, agentId: me.id, owner, at: await io.now(), count,
    ...(digestPath && { digestPath }), ...(wt && { worktree: wt.path, ...(wt.head && { head: wt.head }) }),
  }
  await io.setHandoff(branch, record)
  // decide_handoff: the provider's lean, advice only; max_continues is enforced the same either way.
  const lean = me.parentId === undefined ? undefined : await io.lean({ branch, owner, note, count, maxContinues }).catch(() => undefined)
  const source = sourceOf(decideSettings)
  if (count > maxContinues && me.parentId !== undefined) {
    io.toast(`${branch} has handed off ${count} times: split it`)
    await io.deliver(me.parentId, `flow: ${branch} has handed off ${count} times (max_continues ${maxContinues}). The package is too big for one worker: split the Remaining part of its handoff note into smaller briefs instead of another plain continuation.${lean === undefined ? '' : adviceSuffix(source, lean)}`, { urgent: true }).catch(() => undefined)
  } else if (lean !== undefined && me.parentId !== undefined) {
    const line = adviceLine(source, branch, lean)
    // Advice only: it waits for the manager's next turn (the handoff report itself wakes it).
    if (line !== undefined) await io.deliver(me.parentId, line, { held: true }).catch(() => undefined)
  }
}

// A completed turn's bookkeeping after the cost count: the agent's last answer, the report log, the
// relays to main, the handoff and the reviewer end.
export async function completeTurn(io: TurnIo, e: { agentId?: string; answer: string; reason?: string }): Promise<void> {
  const id = e.agentId
  if (id === undefined) return
  const t = await io.now()
  await io.updateActivity(acts => {
    const a = acts[id] ?? { startedAt: t, lastAt: t, log: [] }
    return { ...acts, [id]: { ...a, lastAt: t, answer: e.answer } }
  })
  // A queue that ended while PRs were still pending: start a fresh one for them.
  const rows = await io.refresh()
  const me = rows.find(a => a.id === id)
  const runWork = me !== undefined && isReviewer(me.type) ? await io.reviewerWork(id) : undefined
  if (me !== undefined && FLOW_TYPES.has(me.type)) {
    await io.best('logging a report', async () => {
      const last = e.answer.trim().split('\n').pop() ?? ''
      const full = isReviewer(me.type) ? reviewerReport(e.answer, runWork) : undefined
      await io.appendLog({ event: 'report', agent: me.name, owner: rows.find(a => a.id === me.parentId)?.name ?? 'main', text: full ?? last }, full === undefined ? TEXT_MAX : 4000)
    })
  }
  // No host notification reaches main for a reviewer the plugin spawned: relay its whole report,
  // only for runs that did batch work.
  if (me !== undefined && isReviewer(me.type)) {
    await io.relayReviewerReport(id, me.name ?? '', e.answer)
  }
  // A manager someone other than main woke: the host returned its answer to that agent, so main
  // gets it here (once; main's own wake-ups never set the mark).
  if (me?.type === MANAGER && io.wokenByOthers.delete(id) && e.answer.trim() !== '') {
    const answer = e.answer.trim()
    // The host may deliver the answer to main itself (a task notification): give it a moment to land,
    // then relay only when main's transcript lacks it.
    io.after(RELAY_DELAY_MS, () => void (async () => {
      if (!(await io.mainHasAnswer(answer))) io.toMain(`Report from manager ${me.name}:\n${answer}${io.askCards() && lastLineAsks(answer) ? `\n${REPORT_HINT}` : ''}`)
    })().catch(() => undefined))
  }
  // `HANDOFF: manager <name>` is a manager's own note, not a worker's branch.
  const handedOff = /^HANDOFF:\s*(?!manager\b)(\S+)\s*$/.exec(e.answer.trim().split('\n').pop() ?? '')
  if (me && WORKERS.has(me.type) && handedOff?.[1] !== undefined) {
    const owner = rows.find(a => a.id === me.parentId)?.name ?? 'main'
    await io.best('recording a handoff', () => recordHandoff(io, me, handedOff[1] as string, owner))
  }
  // A reviewer that ends at once (no answer, an API error) must not be replaced at once: the breaker records
  // the end and decides when, or whether, the next one starts.
  if (me && isReviewer(me.type)) await io.reviewerEnded(me.name ?? '', { answer: e.answer, reason: e.reason, status: me.status })
}
