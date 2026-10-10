// Push gate: with push_mode confirm the reviewer builds and checks a batch, saves it under a local ref and stops;
// the user starts the push (/flow push). Pure rules, so the reviewer tool, the commands and the inbox answer stay
// thin; the disk half (push.json next to inbox.json), the inbox item and the tools are in register.tsx.
//
// One batch at a time. Its life: 'ready' (awaits the user) -> 'pushing' (released; a reviewer pushes it) -> gone once
// every PR is done. A PR sent back, or a base that moved, turns it into 'rebuilding'; the reviewer builds it again
// and records it ready (a new sha, so a new batch id). Dropped, it is gone and every PR is returned.

import type { BatchItem, Handover, Inbox, PushState, Question, ReadyBatch } from '../types'

export type { BatchItem, PushState, ReadyBatch }

export type PushMode = 'auto' | 'confirm'

// Unknown values fall back to auto, the behaviour before the setting existed.
export const parsePushMode = (v: unknown): PushMode => v === 'confirm' ? 'confirm' : 'auto'

export const EMPTY_PUSH: PushState = {}

export const PUSH_KIND = 'push'
export const PUSH_ANSWER = 'push'
export const LATER_ANSWER = 'not yet'
export const DROP_ANSWER = 'drop'

export const SENT_BACK_REASON = 'sent back by the user at push'
export const DROPPED_REASON = 'batch dropped by the user at push'

// The batch is named after its head: a rebuild has a new head, so it is a new batch.
export const batchId = (sha: string): string => sha.slice(0, 8)
export const refOf = (id: string): string => `refs/flow/push/${id}`

const isStr = (v: unknown): v is string => typeof v === 'string' && v !== ''

// A stored file read back from disk; anything malformed is dropped.
export function normalizePush(raw: unknown): PushState {
  const b = (raw as { batch?: unknown } | null)?.batch as Record<string, unknown> | null | undefined
  if (typeof b !== 'object' || b === null) return {}
  const state = b.state
  if (state !== 'ready' && state !== 'pushing' && state !== 'rebuilding') return {}
  if (!isStr(b.id) || !isStr(b.sha) || !isStr(b.baseSha) || !isStr(b.ref) || typeof b.createdAt !== 'number') return {}
  const prs = Array.isArray(b.prs) ? b.prs.filter((n): n is number => Number.isInteger(n) && (n as number) > 0) : []
  if (prs.length === 0) return {}
  const items = (Array.isArray(b.items) ? b.items : []).filter((i): i is BatchItem => {
    const r = i as Record<string, unknown> | null
    return typeof r === 'object' && r !== null && Number.isInteger(r.pr) && typeof r.title === 'string' && typeof r.evidence === 'string'
  }).map(i => ({ pr: i.pr, title: i.title, branch: typeof i.branch === 'string' ? i.branch : '', head: typeof i.head === 'string' ? i.head : '', evidence: i.evidence }))
  return {
    batch: {
      id: b.id, state, prs, items, sha: b.sha, baseSha: b.baseSha, ref: b.ref, check: typeof b.check === 'string' ? b.check : '',
      createdAt: b.createdAt,
      ...(isStr(b.version) ? { version: b.version } : {}),
      ...(isStr(b.qid) ? { qid: b.qid } : {}),
      ...(typeof b.releasedAt === 'number' ? { releasedAt: b.releasedAt } : {}),
      ...(isStr(b.reason) ? { reason: b.reason } : {}),
    },
  }
}

export function newBatch(a: { sha: string; baseSha: string; check: string; version?: string; items: BatchItem[]; now: number }): ReadyBatch {
  const id = batchId(a.sha)
  return {
    id, state: 'ready', prs: a.items.map(i => i.pr), items: a.items, sha: a.sha, baseSha: a.baseSha, ref: refOf(id), check: a.check, createdAt: a.now,
    ...(a.version !== undefined && a.version !== '' ? { version: a.version } : {}),
  }
}

export const itemOf = (h: Handover): BatchItem => ({
  pr: h.pr, title: h.title, branch: h.branch, head: h.head,
  evidence: h.evidence === undefined ? 'no evidence recorded' : `${h.evidence.ran.length} ran, exercised: ${h.evidence.exercised.slice(0, 80)}, ${h.evidence.notVerified.length} not verified`,
})

const prList = (prs: number[]): string => prs.map(n => `#${n}`).join(', ')

// ---- the inbox item ----

export const pushQuestion = (b: ReadyBatch): string =>
  `Push batch ${b.id}: ${prList(b.prs)}${b.version === undefined ? '' : ` as ${b.version}`}?`

export function pushContext(b: ReadyBatch): string {
  return [
    `Built on ${b.baseSha.slice(0, 8)}, head ${b.sha.slice(0, 8)}; check: ${b.check || 'not recorded'}.`,
    ...b.items.map(i => `#${i.pr} ${i.title} [${i.evidence}]`),
    `Answer "${PUSH_ANSWER}" to push it, "send back #<pr>" to return one PR (the rest is rebuilt and asked again), "${DROP_ANSWER}" to return them all, "${LATER_ANSWER}" to decide later.`,
  ].join(' ')
}

export function openPushItem(inbox: Inbox, b: ReadyBatch, now: number): { inbox: Inbox; q: Question } {
  const q: Question = {
    id: `q${inbox.next}`, owner: 'push', addressee: 'main', question: pushQuestion(b),
    options: [PUSH_ANSWER, LATER_ANSWER, DROP_ANSWER], default: LATER_ANSWER, blocking: true, context: pushContext(b), kind: PUSH_KIND,
    askedAt: now, state: 'open', delivered: true, askerIsManager: false,
  }
  return { inbox: { ...inbox, next: inbox.next + 1, items: [...inbox.items, q] }, q }
}

// Closes the batch's item when it is still open (idempotent: an answer already closed it).
export function closePushItem(inbox: Inbox, qid: string | undefined, answer: string, by: string, now: number): Inbox {
  if (qid === undefined) return inbox
  const open = inbox.items.some(x => x.id === qid && x.state === 'open')
  if (!open) return inbox
  return { ...inbox, items: inbox.items.map(x => (x.id === qid ? { ...x, state: 'answered' as const, answer, answeredBy: by, answeredAt: now, delivered: true } : x)) }
}

export type Verdict = { kind: 'push' } | { kind: 'back'; pr: number } | { kind: 'drop' } | { kind: 'later' } | { kind: 'unknown' }

// What the user's answer to the push item means: "push", "send back #3" (or "back 3"), "drop", "not yet".
export function parseVerdict(answer: string): Verdict {
  const a = answer.trim().toLowerCase()
  if (a === PUSH_ANSWER) return { kind: 'push' }
  if (a === DROP_ANSWER) return { kind: 'drop' }
  if (a === LATER_ANSWER) return { kind: 'later' }
  const back = /^(?:send\s+back|back)\s+#?(\d+)$/.exec(a)
  if (back !== null) return { kind: 'back', pr: Number(back[1]) }
  return { kind: 'unknown' }
}

// ---- the rules ----

// A batch in any state holds the reviewer's queue: pending handovers go in after it.
export const holdsQueue = (s: PushState): boolean => s.batch !== undefined

export type Step<T> = { kind: 'refused'; why: string } | ({ kind: 'ok' } & T)

const stateText = (b: ReadyBatch): string => b.state === 'pushing' ? 'is already released and being pushed' : 'is being rebuilt'

export function releaseStep(b: ReadyBatch | undefined, now: number): Step<{ batch: ReadyBatch }> {
  if (b === undefined) return { kind: 'refused', why: 'Nothing ready to push.' }
  if (b.state !== 'ready') return { kind: 'refused', why: `Batch ${b.id} ${stateText(b)}.` }
  return { kind: 'ok', batch: { ...b, state: 'pushing', releasedAt: now } }
}

// Sending a PR back: the rest is rebuilt (the batch head contains the PR), or the batch is gone when it was the last.
export function sendBackStep(b: ReadyBatch | undefined, pr: number): Step<{ batch: ReadyBatch | undefined }> {
  if (b === undefined) return { kind: 'refused', why: 'Nothing ready to push.' }
  if (b.state !== 'ready') return { kind: 'refused', why: `Batch ${b.id} ${stateText(b)}.` }
  if (!b.prs.includes(pr)) return { kind: 'refused', why: `PR #${pr} is not in batch ${b.id} (${prList(b.prs)}).` }
  const prs = b.prs.filter(n => n !== pr)
  if (prs.length === 0) return { kind: 'ok', batch: undefined }
  const { qid: _q, ...rest } = b
  return { kind: 'ok', batch: { ...rest, state: 'rebuilding', prs, items: b.items.filter(i => i.pr !== pr), reason: `PR #${pr} was sent back by the user` } }
}

export function dropStep(b: ReadyBatch | undefined): Step<{ batch: ReadyBatch }> {
  if (b === undefined) return { kind: 'refused', why: 'Nothing ready to push.' }
  if (b.state !== 'ready') return { kind: 'refused', why: `Batch ${b.id} ${stateText(b)}.` }
  return { kind: 'ok', batch: b }
}

// After a reviewer done/back: a PR that is neither ready nor taken left the batch; none left, the batch is finished.
export function settlePrs(b: ReadyBatch | undefined, statusOf: (pr: number) => Handover['status'] | undefined): ReadyBatch | undefined {
  if (b === undefined) return undefined
  const prs = b.prs.filter(n => { const s = statusOf(n); return s === 'ready' || s === 'taken' })
  if (prs.length === 0) return undefined
  return prs.length === b.prs.length ? b : { ...b, prs, items: b.items.filter(i => prs.includes(i.pr)) }
}

// The PRs of a stale ready batch that may be recorded again: ready ones, and the ones the reviewer took for a rebuild.
export const recordable = (s: Handover['status'] | undefined): boolean => s === 'taken' || s === 'ready'

// ---- text ----

export const COMMANDS = '/flow push to push it, /flow push back <pr> to send a PR back, /flow push drop to return them all'

export function renderBatch(b: ReadyBatch): string[] {
  const head = b.state === 'ready'
    ? `Batch ${b.id} ready to push: ${prList(b.prs)}${b.version === undefined ? '' : ` (${b.version})`}`
    : b.state === 'pushing'
      ? `Batch ${b.id} released, a reviewer is pushing it: ${prList(b.prs)}${b.version === undefined ? '' : ` (${b.version})`}`
      : `Batch ${b.id} is being rebuilt${b.reason === undefined ? '' : ` (${b.reason})`}: ${prList(b.prs)}`
  return [
    head,
    `  built on ${b.baseSha.slice(0, 8)}, head ${b.sha.slice(0, 8)}, ref ${b.ref}; check: ${b.check || 'not recorded'}`,
    ...b.items.map(i => `  #${i.pr} ${i.title} [${i.evidence}]`),
    ...(b.state === 'ready' ? [`  ${COMMANDS}`] : []),
  ]
}

// The line `mcp__flow__reviewer list` shows a reviewer while a batch exists; undefined while it awaits the user.
export function reviewerNote(b: ReadyBatch): string {
  if (b.state === 'ready') {
    return `No pending handovers to take: batch ${b.id} (${prList(b.prs)}) awaits the user's /flow push. Do not start another batch; new handovers wait behind it.`
  }
  const facts = `batch ${b.id}: PRs ${prList(b.prs)}; sha ${b.sha}; built on base sha ${b.baseSha}; ref ${b.ref}${b.version === undefined ? '' : `; version ${b.version}`}; check: ${b.check || 'not recorded'}`
  return b.state === 'pushing'
    ? `PUSH RUN: the user released ${facts}. Follow "Push run" in your instructions. Pending handovers wait until it is done.`
    : `REBUILD RUN: ${b.reason ?? 'the batch is stale'}. Rebuild ${facts} (the sha is the old head; the PRs listed are the ones to keep). Follow "Push run" in your instructions. Pending handovers wait until it is ready again.`
}
