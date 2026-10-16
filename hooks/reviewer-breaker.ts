import type { Breaker, Inbox, Question } from '../types'

// The reviewer respawn circuit breaker, as pure rules. A reviewer that dies at once (a usage limit, an API
// error, a sign-in problem) leaves handovers pending, and each end used to start the next reviewer: one a
// second, for as long as the cause lasted. The breaker spaces the starts out and, after a few short runs
// in a row, stops them and asks main. The I/O (state file, inbox, timer) is in reviewer-run.ts.

// A reviewer that ended sooner than this did no real work.
export const SHORT_RUN_MS = 30_000
// The wait before the next start after the 1st, 2nd, 3rd... short run in a row; the last entry is the cap.
export const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000]
// This many short runs in a row halt the queue.
export const HALT_AFTER = 3
// A backstop that does not depend on how runs end: this many starts in a rolling hour halt the queue.
export const MAX_STARTS_PER_HOUR = 20
export const HOUR_MS = 3_600_000
// A reviewer in a terminal that has relayed no flow tool call this long after its start never reached the plugin.
export const REACH_MS = 180_000
// The start of a halt error, and of the run's error, for a reviewer whose flow tools never reached the plugin.
export const UNREACHABLE_ERROR = 'its flow tools never reached the plugin'

export const REVIEWER_KIND = 'reviewer'
export const RETRY_ANSWER = 'retry'
export const NOT_NOW_ANSWER = 'not now'

export const EMPTY_BREAKER: Breaker = { streak: 0 }

// State written before the breaker existed, or damaged, reads as an empty history.
export function normalizeBreaker(raw: unknown): Breaker {
  if (typeof raw !== 'object' || raw === null) return EMPTY_BREAKER
  const r = raw as Record<string, unknown>
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  const out: Breaker = { streak: num(r.streak) && r.streak > 0 ? Math.floor(r.streak) : 0 }
  const run = r.run as Record<string, unknown> | undefined | null
  if (run && typeof run.name === 'string' && num(run.startedAt)) {
    out.run = { name: run.name, startedAt: run.startedAt, ...(typeof run.reached === 'boolean' ? { reached: run.reached } : {}), ...(num(run.reachFrom) ? { reachFrom: run.reachFrom } : {}) }
  }
  if (num(r.endedAt)) out.endedAt = r.endedAt
  if (typeof r.error === 'string') out.error = r.error
  if (Array.isArray(r.starts)) out.starts = r.starts.filter(num)
  if (num(r.unreachable) && r.unreachable > 0) out.unreachable = Math.floor(r.unreachable)
  if (r.unreachableTold === true) out.unreachableTold = true
  const halt = r.halt as Record<string, unknown> | undefined | null
  if (halt && num(halt.at)) {
    out.halt = { at: halt.at, error: typeof halt.error === 'string' ? halt.error : 'unknown', ...(typeof halt.qid === 'string' ? { qid: halt.qid } : {}) }
  }
  return out
}

export const delayFor = (streak: number): number => BACKOFF_MS[Math.min(Math.max(streak, 1), BACKOFF_MS.length) - 1]!

export type Decision = { kind: 'spawn' } | { kind: 'wait'; ms: number } | { kind: 'halt' } | { kind: 'cap' }

export const recentStarts = (b: Breaker, now: number): number[] => (b.starts ?? []).filter(t => now - t < HOUR_MS)

export const CAP_ERROR = `the hourly start cap was reached (${MAX_STARTS_PER_HOUR} reviewer starts in an hour)`

// Whether a reviewer may start now.
export function decide(b: Breaker, now: number): Decision {
  if (b.halt !== undefined) return { kind: 'halt' }
  if (recentStarts(b, now).length >= MAX_STARTS_PER_HOUR) return { kind: 'cap' }
  const left = waitLeft(b, now)
  if (left > 0) return { kind: 'wait', ms: left }
  return { kind: 'spawn' }
}

// The first reviewer whose tools never reached the plugin is replaced at once (a fresh process usually loads them);
// the next ones wait as short runs do.
export const unreachableDelay = (n: number): number => (n <= 1 ? 0 : delayFor(n - 1))

// How long the next start still waits after the last end: the longer of the short-run and the unreachable backoff.
// After an unreachable end the short-run backoff does not apply: a fresh reviewer is the fix, not waiting.
function waitLeft(b: Breaker, now: number): number {
  if (b.endedAt === undefined) return 0
  const short = b.streak > 0 && b.error?.startsWith(UNREACHABLE_ERROR) !== true ? delayFor(b.streak) : 0
  const unreached = (b.unreachable ?? 0) > 0 ? unreachableDelay(b.unreachable!) : 0
  return Math.max(short, unreached) - (now - b.endedAt)
}

// `tracked`: the plugin watches whether this run's flow tools reach it (see endRun); a run recorded without it never
// counts as unreachable.
export const startRun = (b: Breaker, name: string, now: number, tracked = false): Breaker =>
  ({ ...b, run: { name, startedAt: now, ...(tracked ? { reached: false } : {}) }, starts: [...recentStarts(b, now), now] })

// A flow tool call of the run `name` arrived: its tools work, and the unreachable streak ends.
export function reachRun(b: Breaker, name: string): Breaker {
  if (b.run?.name !== name || b.run.reached !== false) return b
  const { unreachable: _u, unreachableTold: _t, ...rest } = b
  return { ...rest, run: { ...b.run, reached: true } }
}

// A spawn the host denied never ran: its run and its start time go.
export function abandonRun(b: Breaker, name: string, startedAt: number): Breaker {
  if (b.run?.name !== name) return b
  const { run: _run, ...rest } = b
  const i = (b.starts ?? []).lastIndexOf(startedAt)
  return { ...rest, starts: (b.starts ?? []).filter((_, j) => j !== i) }
}

const firstLine = (text: string): string => {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > 200 ? `${line.slice(0, 199)}…` : line
}

export type RunEnd = { name: string; now: number; answer: string; reason?: string; status?: string }

// What the host told us about a failed end. The turn.complete event has no error field, so the text is
// the answer when it carries one, else a plain description of the signal.
export function errorText(e: RunEnd): string {
  if (e.answer.trim() !== '' && (e.reason === 'error' || e.status === 'failed')) return firstLine(e.answer)
  if (e.reason === 'error') return 'the reviewer\'s turn ended on an API error (the host gave no error text)'
  if (e.status === 'failed') return 'the host reported the reviewer\'s run as failed (no error text)'
  if (e.answer.trim() === '') return 'ended with no answer (the host gave no error text)'
  return firstLine(e.answer)
}

export const isFailure = (e: RunEnd): boolean => e.answer.trim() === '' || e.reason === 'error' || e.status === 'failed'

// A reviewer ended. Only the run the plugin started counts, and only once (the run is cleared). One that answered
// without a flow tool call ever reaching the plugin is `unreachable`: it counts in its own streak, not the short-run
// one, so the next start is a fresh reviewer at once; the halt after HALT_AFTER in a row stays the backstop. A failed
// end (an API error, no answer) is a short or failed run as before: it never got as far as calling a tool.
export function endRun(b: Breaker, e: RunEnd): { breaker: Breaker; halted: boolean; unreachable?: true } {
  if (b.run === undefined || b.run.name !== e.name) return { breaker: b, halted: false }
  const lived = e.now - b.run.startedAt
  if (b.run.reached === false && !isFailure(e)) {
    const { run: _run, error: _error, ...kept } = b
    const unreachable = (b.unreachable ?? 0) + 1
    const error = `${UNREACHABLE_ERROR} (ended after ${Math.round(lived / 1000)}s: ${errorText(e)})`
    const halted = unreachable >= HALT_AFTER
    return { breaker: { ...kept, unreachable, endedAt: e.now, error, ...(halted ? { halt: { at: e.now, error } } : {}) }, halted, unreachable: true }
  }
  const short = lived < SHORT_RUN_MS
  const failed = isFailure(e)
  const { run: _run, error: _error, ...rest } = b
  if (!short && !failed) return { breaker: { ...rest, streak: 0, endedAt: e.now }, halted: false }
  const streak = short ? b.streak + 1 : 1
  const error = failed ? errorText(e) : `ended after ${Math.round(lived / 1000)}s: ${errorText(e)}`
  const halted = streak >= HALT_AFTER
  return { breaker: { ...rest, streak, endedAt: e.now, error, ...(halted ? { halt: { at: e.now, error } } : {}) }, halted }
}

// Retry, /flow resume and a new session: the halt and the wait go, one more short run halts again.
export function clearHalt(b: Breaker): Breaker {
  const { halt: _halt, endedAt: _endedAt, ...rest } = b
  return { ...rest, streak: Math.min(b.streak, HALT_AFTER - 1), ...(b.unreachable !== undefined ? { unreachable: Math.min(b.unreachable, HALT_AFTER - 1) } : {}) }
}

// What main is told, once per unreachable streak, when a reviewer ends without its tools reaching the plugin.
export function unreachableNotice(name: string, error: string): string {
  return `flow: reviewer ${name} ended, but ${error}. Its mcp__flow__* calls were answered by the host, not by flow (e.g. "no tool.call hook answered this call"): flow's hooks were not running in that process. The plugin starts a fresh reviewer in a new worktree; after ${HALT_AFTER} in a row it halts the queue and asks you. Said once until a reviewer reaches the plugin again.`
}

export const haltQuestion = 'The reviewer cannot start: it keeps ending at once. Retry?'

export function haltContext(error: string): string {
  if (error.startsWith(UNREACHABLE_ERROR)) return `The last ${HALT_AFTER} reviewers ended without one flow tool call reaching the plugin (${error}), so the plugin stopped starting them; handed-over PRs wait. Their flow tools were answered by the host, not by flow: check that the flow plugin loads (/plugin, or a reload), then answer "${RETRY_ANSWER}" to start a fresh reviewer, or "${NOT_NOW_ANSWER}" to leave the queue halted (/flow resume retries later).`
  if (error === CAP_ERROR) return `The plugin stopped starting reviewers: ${error}. Handed-over PRs wait. Retry clears the halt but not the start history, so a new reviewer starts only once the last hour holds fewer than ${MAX_STARTS_PER_HOUR} starts. Answer "${RETRY_ANSWER}" to try, or "${NOT_NOW_ANSWER}" to leave the queue halted.`
  return `The last ${HALT_AFTER} reviewers each ended within ${SHORT_RUN_MS / 1000}s, so the plugin stopped starting them; handed-over PRs wait. Last error: ${error}. Fix the cause (usage limit, sign-in, network), then answer "${RETRY_ANSWER}" to start a reviewer, or "${NOT_NOW_ANSWER}" to leave the queue halted (/flow resume retries later).`
}

// The one inbox item for a halt: blocking, addressed to main, owned by "reviewer" (not an agent), and
// never answered by a standing answer or a default.
export function openHaltItem(inbox: Inbox, error: string, now: number): { inbox: Inbox; q: Question } {
  const q: Question = {
    id: `q${inbox.next}`, owner: 'reviewer', addressee: 'main', question: haltQuestion,
    options: [RETRY_ANSWER, NOT_NOW_ANSWER], default: NOT_NOW_ANSWER, blocking: true, context: haltContext(error), kind: REVIEWER_KIND,
    askedAt: now, state: 'open', delivered: true, askerIsManager: false,
  }
  return { inbox: { ...inbox, next: inbox.next + 1, items: [...inbox.items, q] }, q }
}

export const isRetry = (answer: string): boolean => answer.trim().toLowerCase() === RETRY_ANSWER

// One line for status and the pane, or undefined when the breaker is quiet.
export function breakerLine(b: Breaker, now: number): string | undefined {
  if (b.halt !== undefined) {
    return `Reviewer halted: ${b.halt.error}.${b.halt.qid === undefined ? ' Run /flow resume' : ` Answer ${b.halt.qid} "${RETRY_ANSWER}" or run /flow resume`} to retry; handed-over PRs wait.`
  }
  if ((b.streak > 0 || (b.unreachable ?? 0) > 0) && b.error !== undefined) {
    const left = waitLeft(b, now)
    if (left > 0) return `Reviewer backing off ${Math.ceil(left / 1000)}s after: ${b.error}.`
  }
  return undefined
}
