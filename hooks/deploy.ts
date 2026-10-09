// Per-target deploy gates: whether the queue may deploy a target in this batch. Pure rules; the disk
// half (deploys.json next to inbox.json), the inbox item and the tool are in register.tsx.
//
// A target is `auto` (the queue deploys it every batch) or `confirm` (it waits for the user's approval
// through the inbox). Either can be held by a person. A later check (env changes approved before the
// target deploys) belongs in decideGate, so the queue keeps calling one gate.

import type { Approval, Deploys, DeployMode, Hold, Inbox, Question, TargetState } from '../types'

export type { Approval, Deploys, DeployMode, Hold, TargetState }

export const EMPTY_DEPLOYS: Deploys = { targets: {} }

export const APPROVE = 'deploy'
export const DECLINE = 'not now'
export const DEPLOY_KIND = 'deploy'

export const isApprove = (answer: string | undefined): boolean => (answer ?? '').trim().toLowerCase() === APPROVE

// A stored file read back from disk; anything malformed is dropped.
export function normalizeDeploys(raw: unknown): Deploys {
  const t = (raw as { targets?: unknown } | null)?.targets
  const out: Record<string, TargetState> = {}
  if (typeof t !== 'object' || t === null || Array.isArray(t)) return { targets: out }
  for (const [name, v] of Object.entries(t)) {
    if (typeof v !== 'object' || v === null) continue
    const r = v as Record<string, unknown>
    const s: TargetState = {}
    if (typeof r.deployedSha === 'string' && r.deployedSha !== '') s.deployedSha = r.deployedSha
    if (typeof r.deployedAt === 'number') s.deployedAt = r.deployedAt
    const h = r.hold as Record<string, unknown> | null | undefined
    if (h && (h.until === 'batch' || h.until === 'released') && typeof h.by === 'string' && typeof h.at === 'number') {
      s.hold = { until: h.until, by: h.by, at: h.at, ...(typeof h.reason === 'string' && h.reason !== '' ? { reason: h.reason } : {}) }
    }
    const a = r.approval as Record<string, unknown> | null | undefined
    if (a && typeof a.qid === 'string' && typeof a.sha === 'string' && (a.state === 'pending' || a.state === 'approved') && typeof a.at === 'number') {
      s.approval = { qid: a.qid, sha: a.sha, state: a.state, at: a.at }
    }
    if (r.due === true) s.due = true
    out[name] = s
  }
  return { targets: out }
}

export type Gate =
  | { kind: 'go' }
  | { kind: 'held'; why: string }
  // The existing open item (its sha was moved to this call's).
  | { kind: 'awaits'; qid: string }
  // The caller opens the item and records it with withApproval.
  | { kind: 'ask' }

const holdText = (h: Hold): string =>
  `held by ${h.by}${h.reason ? ` (${h.reason})` : ''}${h.until === 'released' ? ' until released' : ' for this batch'}`

// The gate for one target at one sha. Holds win over approvals. A batch hold is spent by the call it
// stops. An approval covers exactly the sha it was opened for; a pending item follows the newest sha
// the gate is called with (one open item per target); an approval for another sha is stale.
export function decideGate(
  ts: TargetState | undefined, mode: DeployMode, sha: string, isOpen: (qid: string) => boolean,
): { gate: Gate; state: TargetState } {
  const cur = ts ?? {}
  if (cur.hold !== undefined) {
    const why = holdText(cur.hold)
    if (cur.hold.until === 'released') return { gate: { kind: 'held', why }, state: cur }
    const { hold: _h, ...rest } = cur
    return { gate: { kind: 'held', why }, state: rest }
  }
  if (mode === 'auto') return { gate: { kind: 'go' }, state: cur }
  const a = cur.approval
  if (a !== undefined && a.state === 'approved' && a.sha === sha) return { gate: { kind: 'go' }, state: cur }
  if (a !== undefined && a.state === 'pending' && isOpen(a.qid)) {
    return { gate: { kind: 'awaits', qid: a.qid }, state: a.sha === sha ? cur : { ...cur, approval: { ...a, sha } } }
  }
  return { gate: { kind: 'ask' }, state: cur }
}

export const withApproval = (ts: TargetState | undefined, qid: string, sha: string, at: number): TargetState =>
  // A new pending item supersedes an approved but not yet deployed sha, so its `due` goes too.
  ({ ...withoutDue(ts), approval: { qid, sha, state: 'pending', at } })

function withoutDue(ts: TargetState | undefined): TargetState {
  const { due: _d, ...rest } = ts ?? {}
  return rest
}

// The user's answer to an approval item: "deploy" approves its sha and makes a deploy-only run due,
// anything else drops the approval and leaves the target behind.
export function applyAnswer(ts: TargetState | undefined, answer: string): TargetState {
  const cur = ts ?? {}
  if (cur.approval === undefined) return cur
  if (isApprove(answer)) return { ...cur, approval: { ...cur.approval, state: 'approved' }, due: true }
  const { approval: _a, ...rest } = cur
  return rest
}

// After a target deployed. A failure records nothing; the same call twice changes nothing more.
export function recordDeployed(ts: TargetState | undefined, sha: string, ok: boolean, at: number): TargetState {
  const cur = ts ?? {}
  if (!ok) return cur
  const { due: _d, approval, ...rest } = cur
  // The approval is spent by the deploy it approved; a pending or other-sha one stays.
  const keep = approval !== undefined && !(approval.state === 'approved' && approval.sha === sha)
  return {
    ...rest, ...(keep ? { approval } : {}),
    deployedSha: sha, deployedAt: cur.deployedSha === sha && cur.deployedAt !== undefined ? cur.deployedAt : at,
  }
}

export const withHold = (ts: TargetState | undefined, hold: Hold): TargetState => ({ ...(ts ?? {}), hold })

// Releasing makes an auto target due (a deploy-only run catches it up); a confirm target still needs its approval.
export function release(ts: TargetState | undefined, mode: DeployMode): { state: TargetState; had: boolean } {
  const cur = ts ?? {}
  if (cur.hold === undefined) return { state: cur, had: false }
  const { hold: _h, ...rest } = cur
  return { state: mode === 'auto' ? { ...rest, due: true } : rest, had: true }
}

export type TargetInfo = { name: string; mode: DeployMode }

export const unknownTarget = (targets: TargetInfo[], name: string): string | undefined =>
  targets.some(t => t.name === name) ? undefined
    : `Unknown target "${name}". Configured: ${targets.length === 0 ? 'none' : targets.map(t => t.name).join(', ')}.`

const commits = (n: number) => `${n} commit${n === 1 ? '' : 's'}`

// One line per target that needs a look: never deployed through flow, or behind the base. Quiet when up to date.
export function behindLines(targets: TargetInfo[], d: Deploys, behind: Record<string, number>): string[] {
  const out: string[] = []
  for (const t of targets) {
    const ts = d.targets[t.name]
    const held = ts?.hold === undefined ? '' : ` (${holdText(ts.hold)})`
    const n = behind[t.name] ?? 0
    if (ts?.deployedSha === undefined) out.push(`${t.name}: no deploy recorded${held}`)
    else if (n > 0) out.push(`${t.name} behind by ${commits(n)}${held}`)
    else if (held !== '') out.push(`${t.name}${held}`)
  }
  return out
}

// The deploy tool's list: every target with mode, hold, last deployed sha, behind count, open approval.
export function renderList(targets: TargetInfo[], d: Deploys, behind: Record<string, number>): string {
  if (targets.length === 0) return 'No deploy targets configured.'
  return targets.map(t => {
    const ts = d.targets[t.name]
    const n = behind[t.name]
    const parts = [
      `mode ${t.mode}`,
      ts?.hold === undefined ? 'not held' : holdText(ts.hold),
      ts?.deployedSha === undefined ? 'no deploy recorded' : `last deployed ${ts.deployedSha.slice(0, 8)}${n === undefined ? '' : `, behind by ${commits(n)}`}`,
    ]
    const a = ts?.approval
    if (a !== undefined) parts.push(a.state === 'approved' ? `approved ${a.sha.slice(0, 8)} (${a.qid})` : `awaits approval ${a.qid} for ${a.sha.slice(0, 8)}`)
    if (ts?.due === true) parts.push(a?.state === 'approved' ? `DUE: deploy ${a.sha}` : 'DUE: deploy the base head')
    return `${t.name}: ${parts.join('; ')}`
  }).join('\n')
}

export const approvalQuestion = (target: string, sha: string): string => `Deploy ${target} at ${sha.slice(0, 8)}?`

// The inbox item for an approval: blocking, addressed to main, owned by "deploy" (not an agent, so no
// agent shows as asking and nobody is messaged when it is answered). Its question text names the sha.
export function openApprovalItem(inbox: Inbox, target: string, sha: string, context: string, now: number): { inbox: Inbox; q: Question } {
  const q: Question = {
    id: `q${inbox.next}`, owner: 'deploy', addressee: 'main', question: approvalQuestion(target, sha),
    options: [APPROVE, DECLINE], default: DECLINE, blocking: true, context, kind: DEPLOY_KIND,
    askedAt: now, state: 'open', delivered: false, askerIsManager: false,
  }
  return { inbox: { next: inbox.next + 1, items: [...inbox.items, q] }, q }
}

// A newer sha for the same open item: its text and context follow, the id stays.
export function retargetItem(inbox: Inbox, qid: string, target: string, sha: string, context: string): Inbox {
  return {
    ...inbox,
    items: inbox.items.map(x => (x.id === qid && x.state === 'open' ? { ...x, question: approvalQuestion(target, sha), context } : x)),
  }
}

export const openDeployIds = (inbox: Inbox): Set<string> =>
  new Set(inbox.items.filter(x => x.kind === DEPLOY_KIND && x.state === 'open').map(x => x.id))

// What the approval item tells the user: the target, the sha, and the commits since the last deploy.
export function approvalContext(target: string, sha: string, lastSha: string | undefined, log: string[]): string {
  const since = lastSha === undefined
    ? 'no earlier deploy of this target is recorded'
    : `since ${lastSha.slice(0, 8)}: ${log.length === 0 ? 'no commits found' : log.join('; ')}`
  return `target ${target}, sha ${sha}; ${since}. Answer "${APPROVE}" to deploy exactly this sha, "${DECLINE}" to leave the target behind.`
}
