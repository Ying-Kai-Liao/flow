// Per-target deploy gates: whether the queue may deploy a target in this batch. Pure rules; the disk
// half (deploys.json next to inbox.json), the inbox item and the tool are in register.tsx.
//
// A target is `auto` (the queue deploys it every batch) or `confirm` (it waits for the user's approval
// through the inbox). Either can be held by a person. Env changes a handed-over PR needs on the target
// are checked by the same gate (order: hold, env answers, deploy approval, then the env commands), so
// the queue keeps calling one gate. No secret value exists anywhere in here: a secret is set by the user.

import type { Approval, Deploys, DeployMode, EnvChange, EnvDone, Handover, Hold, Inbox, Question, TargetState } from '../types'

export type { Approval, Deploys, DeployMode, EnvChange, EnvDone, Hold, TargetState }

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
    if (Array.isArray(r.envDone)) {
      const done = r.envDone.filter((e): e is EnvDone => {
        const d = e as Record<string, unknown> | null
        return typeof d === 'object' && d !== null && Number.isInteger(d.pr) && typeof d.name === 'string' && typeof d.at === 'number' &&
          (d.how === 'command' || d.how === 'user' || d.how === 'secret' || d.how === 'dropped' || d.how === 'superseded')
      }).map(e => ({ pr: e.pr, name: e.name, how: e.how, at: e.at }))
      if (done.length > 0) s.envDone = done
    }
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
  // Env: items still open, one declined (until release), or approved changes the user must apply themselves
  // (the caller opens an `apply` item for each entry).
  | { kind: 'envAwaits'; qids: string[] }
  | { kind: 'envHeld'; why: string }
  | { kind: 'envAsk'; entries: EnvEntry[]; reopen: EnvReopen[]; open: string[] }
  // Go, after the queue runs the env command for each entry and calls env-applied.
  | { kind: 'goEnv'; apply: EnvEntry[] }

const holdText = (h: Hold): string =>
  `held by ${h.by}${h.reason ? ` (${h.reason})` : ''}${h.until === 'released' ? ' until released' : ' for this batch'}`

// The gate for one target at one sha. Holds win over everything. A batch hold is spent by the call it
// stops. Then the target's env changes (all answered, none declined), then, on a confirm target, the
// deploy approval: so the user is not asked to approve a deploy that cannot go yet. An approval covers
// exactly the sha it was opened for; a pending item follows the newest sha the gate is called with (one
// open item per target); an approval for another sha is stale. Only a Go records env changes as done.
export function decideGate(
  ts: TargetState | undefined, mode: DeployMode, sha: string, isOpen: (qid: string) => boolean, env?: EnvInput, at = 0,
): { gate: Gate; state: TargetState } {
  const cur = ts ?? {}
  if (cur.hold !== undefined) {
    const why = holdText(cur.hold)
    if (cur.hold.until === 'released') return { gate: { kind: 'held', why }, state: cur }
    const { hold: _h, ...rest } = cur
    return { gate: { kind: 'held', why }, state: rest }
  }
  const e = env === undefined ? undefined : decideEnv(env)
  if (e !== undefined && e.kind !== 'clear') return { gate: e, state: cur }
  const go = (state: TargetState): { gate: Gate; state: TargetState } => {
    if (e === undefined) return { gate: { kind: 'go' }, state }
    const next = withEnvDone(state, e.record.map(r => ({ pr: r.entry.pr, name: r.entry.change.name, how: r.how, at })))
    return { gate: e.apply.length === 0 ? { kind: 'go' } : { kind: 'goEnv', apply: e.apply }, state: next }
  }
  if (mode === 'auto') return go(cur)
  const a = cur.approval
  if (a !== undefined && a.state === 'approved' && a.sha === sha) return go(cur)
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

// envCommand: the target's env_command template, when it has one.
export type TargetInfo = { name: string; mode: DeployMode; envCommand?: string }

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
export function renderList(targets: TargetInfo[], d: Deploys, behind: Record<string, number>, env: Record<string, string> = {}): string {
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
    if (env[t.name]) parts.push(env[t.name]!)
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

// ---- env changes ----
//
// A handover can list env/secret changes per target. Each becomes inbox items for the user (kind `env`,
// never answered by a standing rule unless it names the kind). A secret never has a value in flow: the
// user sets it and answers done. A non-secret value is applied by the queue only through the target's
// `env_command`; without one the user applies it and answers done.

export const ENV_KIND = 'env'
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
export const YES = 'yes'
export const NO = 'no'
export const DONE = 'done'
export const NOT_YET = 'not yet'

const isYes = (a: string | undefined): boolean => (a ?? '').trim().toLowerCase() === YES
const isDone = (a: string | undefined): boolean => (a ?? '').trim().toLowerCase() === DONE

// One pending change with the PR that needs it.
export type EnvEntry = { pr: number; change: EnvChange }
export type ItemView = { qid: string; open: boolean; answer?: string }
export type EnvInput = {
  // The pending changes of this target, oldest handover first.
  pending: EnvEntry[]
  item: (qid: string) => ItemView | undefined
  // The `apply` item (the user applies an approved value themselves) for a change, if one was opened.
  applyItem: (pr: number, target: string, name: string) => ItemView | undefined
  hasCommand: boolean
}

// The changes still to settle for a target: handovers that are taken or done, not yet recorded for it.
export function pendingEnv(handovers: Handover[], target: string, ts: TargetState | undefined): EnvEntry[] {
  const done = new Set((ts?.envDone ?? []).map(d => `${d.pr}:${d.name}`))
  return [...handovers]
    .filter(h => h.status === 'taken' || h.status === 'done')
    .sort((a, b) => a.at - b.at)
    .flatMap(h => (h.env ?? []).filter(c => c.target === target && !done.has(`${h.pr}:${c.name}`)).map(change => ({ pr: h.pr, change })))
}

// Two PRs changing the same NAME on one target: the later handover's value wins; the earlier is superseded.
function split(pending: EnvEntry[]): { effective: EnvEntry[]; superseded: EnvEntry[] } {
  const last = new Map<string, EnvEntry>()
  for (const e of pending) last.set(e.change.name, e)
  return { effective: [...last.values()], superseded: pending.filter(e => last.get(e.change.name) !== e) }
}

// Only "no" on a non-secret change is a decline. "Not yet" (or anything but the good answer) on a secret, a
// login step or an apply item means still waiting: the gate opens a fresh item for it. A missing item counts as declined.
type Settle = 'open' | 'ok' | 'no' | 'notyet'
const settled = (v: ItemView | undefined, good: (a: string | undefined) => boolean, declinable: boolean): Settle =>
  v === undefined ? 'no' : v.open ? 'open' : good(v.answer) ? 'ok' : declinable ? 'no' : 'notyet'

// The user's answers to a change: its own item and its login step. `reopen` names the item fields to replace.
function answers(e: EnvEntry, item: EnvInput['item']): { open: string[]; reopen: Array<'qid' | 'loginQid'>; no?: string } {
  const open: string[] = []
  const reopen: Array<'qid' | 'loginQid'> = []
  let no: string | undefined
  const c = e.change
  const own = settled(item(c.qid), c.secret === true ? isDone : isYes, c.secret !== true)
  if (own === 'open') open.push(c.qid)
  else if (own === 'notyet') reopen.push('qid')
  else if (own === 'no') no = `env change ${c.name} declined`
  if (c.loginQid !== undefined) {
    const login = settled(item(c.loginQid), isDone, false)
    if (login === 'open') open.push(c.loginQid)
    else if (login === 'notyet') reopen.push('loginQid')
  }
  return { open, reopen, ...(no !== undefined ? { no } : {}) }
}

export type EnvReopen = { entry: EnvEntry; field: 'qid' | 'loginQid' }
export type EnvDecision =
  | { kind: 'clear'; apply: EnvEntry[]; record: Array<{ entry: EnvEntry; how: EnvDone['how'] }> }
  | { kind: 'envAwaits'; qids: string[] }
  | { kind: 'envHeld'; why: string }
  // Fresh items to open: apply items for `entries`, new copies of the answered-"not yet" items in `reopen`;
  // `open` are the ones already waiting.
  | { kind: 'envAsk'; entries: EnvEntry[]; reopen: EnvReopen[]; open: string[] }

// Declined wins (the target waits for a release), then open items, then the items answered "not yet" and the
// apply items the user still owes; clear when everything is settled. `apply` are the commands to run, `record`
// what is done at Go. One open item per change: an open one is reused, a new one comes only after "not yet".
export function decideEnv(env: EnvInput): EnvDecision {
  if (env.pending.length === 0) return { kind: 'clear', apply: [], record: [] }
  const { effective, superseded } = split(env.pending)
  const open: string[] = []
  const reopen: EnvReopen[] = []
  for (const e of env.pending) {
    const a = answers(e, env.item)
    if (a.no !== undefined) return { kind: 'envHeld', why: a.no }
    open.push(...a.open)
    reopen.push(...a.reopen.map(field => ({ entry: e, field })))
  }
  if (reopen.length > 0) return { kind: 'envAsk', entries: [], reopen, open: [...new Set(open)] }
  if (open.length > 0) return { kind: 'envAwaits', qids: [...new Set(open)] }
  const apply: EnvEntry[] = []
  const record: Array<{ entry: EnvEntry; how: EnvDone['how'] }> = superseded.map(entry => ({ entry, how: 'superseded' as const }))
  const ask: EnvEntry[] = []
  for (const e of effective) {
    if (e.change.secret === true) { record.push({ entry: e, how: 'secret' }); continue }
    if (env.hasCommand) { apply.push(e); continue }
    const v = env.applyItem(e.pr, e.change.target, e.change.name)
    if (v === undefined) ask.push(e)
    else if (v.open) open.push(v.qid)
    else if (isDone(v.answer)) record.push({ entry: e, how: 'user' })
    else ask.push(e)
  }
  if (ask.length > 0) return { kind: 'envAsk', entries: ask, reopen: [], open }
  if (open.length > 0) return { kind: 'envAwaits', qids: open }
  return { kind: 'clear', apply, record }
}

export function withEnvDone(ts: TargetState | undefined, add: EnvDone[]): TargetState {
  const cur = ts ?? {}
  const have = new Set((cur.envDone ?? []).map(d => `${d.pr}:${d.name}`))
  const fresh = add.filter(d => !have.has(`${d.pr}:${d.name}`))
  return fresh.length === 0 ? cur : { ...cur, envDone: [...(cur.envDone ?? []), ...fresh] }
}

// The changes a release drops: only those the user declined with "no".
export const declinedEntries = (env: Pick<EnvInput, 'pending' | 'item'>): EnvEntry[] =>
  env.pending.filter(e => answers(e, env.item).no !== undefined)

// Single quotes, so a value is one shell word whatever it holds.
export const shellQuote = (v: string): string => `'${v.replaceAll("'", `'\\''`)}'`

// The env_command with {name} and {value} filled in; one pass, so a value holding "{name}" stays as typed.
export const envCommandFor = (template: string, name: string, value: string): string =>
  template.replace(/\{(name|value)\}/g, (_m, k: string) => (k === 'name' ? name : shellQuote(value)))

export function envChangeQuestion(c: Pick<EnvChange, 'target' | 'name' | 'value' | 'secret' | 'why'>): string {
  return c.secret === true
    ? `Secret ${c.name} on ${c.target} is set by you (${c.why}). Set it, then answer done`
    : `Set ${c.name}=${c.value ?? ''} on ${c.target}? (${c.why})`
}

export type Draft = Pick<EnvChange, 'target' | 'name' | 'value' | 'secret' | 'why' | 'login'>

function envItem(inbox: Inbox, q: Pick<Question, 'question' | 'options' | 'default' | 'context' | 'env'>, now: number): { inbox: Inbox; q: Question } {
  const item: Question = {
    ...q, id: `q${inbox.next}`, owner: 'env', addressee: 'main', blocking: true, kind: ENV_KIND,
    askedAt: now, state: 'open', delivered: false, askerIsManager: false,
  }
  return { inbox: { next: inbox.next + 1, items: [...inbox.items, item] }, q: item }
}

// The items for one change of one PR: the login step (if any) and the change itself. A re-handover of the
// same PR reuses the earlier items by target and name: an open one follows the new text, an answered one
// stays when the change is the same, anything else gets a fresh item.
export function openEnvItems(inbox: Inbox, pr: number, d: Draft, prev: EnvChange | undefined, now: number): { inbox: Inbox; change: EnvChange; fresh: Question[] } {
  let cur = inbox
  const fresh: Question[] = []
  const same = prev !== undefined && prev.value === d.value && (prev.secret === true) === (d.secret === true)
  // An earlier item is kept when it is still open, or answered positively and nothing changed.
  const keep = (qid: string | undefined, text: string, unchanged: boolean, good: (a: string | undefined) => boolean, context: string): string | undefined => {
    const x = qid === undefined ? undefined : cur.items.find(i => i.id === qid)
    if (x === undefined) return undefined
    if (x.state === 'open') {
      cur = { ...cur, items: cur.items.map(i => (i.id === x.id ? { ...i, question: text, context } : i)) }
      return x.id
    }
    return unchanged && good(x.answer) ? x.id : undefined
  }
  let loginQid: string | undefined
  if (d.login !== undefined) {
    const text = `Do this yourself: ${d.login}`
    const ctx = `Step for env change ${d.name} on ${d.target} (PR #${pr}); that change waits for it. Answer "${DONE}" when you have.`
    loginQid = keep(prev?.loginQid, text, prev?.login === d.login, isDone, ctx)
    if (loginQid === undefined) {
      const r = envItem(cur, { question: text, options: [DONE, NOT_YET], default: NOT_YET, context: ctx, env: { role: 'login', target: d.target, name: d.name, pr } }, now)
      cur = r.inbox; fresh.push(r.q); loginQid = r.q.id
    }
  }
  const secret = d.secret === true
  const ctx = `PR #${pr}, target ${d.target}.${loginQid !== undefined ? ` Do the login step first (${loginQid}).` : ''} ${secret
    ? `Flow never sees the value. Answer "${DONE}" once it is set.`
    : `Answer "${YES}" to let flow apply it before ${d.target} deploys (through the target's env_command, else you apply it), "${NO}" to hold ${d.target} until main releases it.`}`
  let qid = keep(prev?.qid, envChangeQuestion(d), same, secret ? isDone : isYes, ctx)
  if (qid === undefined) {
    const r = envItem(cur, {
      question: envChangeQuestion(d), options: secret ? [DONE, NOT_YET] : [YES, NO], default: secret ? NOT_YET : NO, context: ctx,
      env: { role: secret ? 'secret' : 'change', target: d.target, name: d.name, pr },
    }, now)
    cur = r.inbox; fresh.push(r.q); qid = r.q.id
  }
  const change: EnvChange = {
    target: d.target, name: d.name, ...(d.value !== undefined ? { value: d.value } : {}), ...(secret ? { secret: true as const } : {}),
    why: d.why, ...(d.login !== undefined ? { login: d.login } : {}), qid, ...(loginQid !== undefined ? { loginQid } : {}),
  }
  return { inbox: cur, change, fresh }
}

// The item that asks the user to apply an approved value themselves.
export const openApplyItem = (inbox: Inbox, e: EnvEntry, now: number): { inbox: Inbox; q: Question } => envItem(inbox, {
  question: `Apply ${e.change.name}=${e.change.value ?? ''} on ${e.change.target} yourself, answer ${DONE}`,
  options: [DONE, NOT_YET], default: NOT_YET,
  context: `Approved for PR #${e.pr}; ${e.change.target} has no env_command, so flow cannot apply it. ${e.change.target} waits for this.`,
  env: { role: 'apply', target: e.change.target, name: e.change.name, pr: e.pr },
}, now)

// A fresh copy of an item the user answered "not yet", so the change keeps one open item.
export const reopenItem = (inbox: Inbox, old: Question, now: number): { inbox: Inbox; q: Question } =>
  envItem(inbox, { question: old.question, options: old.options, default: old.default, ...(old.context !== undefined ? { context: old.context } : {}), ...(old.env !== undefined ? { env: old.env } : {}) }, now)

// Items the plugin closes itself (a returned PR, a dropped change): answered by "flow" with a note.
export function closeEnvItems(inbox: Inbox, qids: string[], note: string, now: number): Inbox {
  return {
    ...inbox,
    items: inbox.items.map(x => (qids.includes(x.id) && x.state === 'open'
      ? { ...x, state: 'answered' as const, answer: note, answeredBy: 'flow', answeredAt: now, delivered: true } : x)),
  }
}

export const itemViewOf = (inbox: Inbox): EnvInput['item'] => qid => {
  const x = inbox.items.find(i => i.id === qid)
  return x === undefined ? undefined : { qid, open: x.state === 'open', ...(x.answer !== undefined ? { answer: x.answer } : {}) }
}

// The newest apply item for a change (answered ones count: "not yet" holds the target).
export const applyViewOf = (inbox: Inbox): EnvInput['applyItem'] => (pr, target, name) => {
  const x = [...inbox.items].reverse().find(i => i.env?.role === 'apply' && i.env.pr === pr && i.env.target === target && i.env.name === name)
  return x === undefined ? undefined : { qid: x.id, open: x.state === 'open', ...(x.answer !== undefined ? { answer: x.answer } : {}) }
}

const stateWord = (e: EnvEntry, ts: TargetState | undefined, item: EnvInput['item']): string => {
  const d = ts?.envDone?.find(x => x.pr === e.pr && x.name === e.change.name)
  if (d !== undefined) return d.how === 'command' ? 'applied by command' : d.how === 'user' ? 'applied by user' : d.how === 'secret' ? 'secret set by user' : d.how
  const a = answers(e, item)
  return a.no !== undefined ? 'declined' : a.reopen.length > 0 ? 'not done yet' : a.open.length > 0 ? `awaits the user (${a.open.join(', ')})` : 'approved, not applied yet'
}

// One entry per change of a handover, names only: for the queue's list.
export function envSummary(h: Handover, ts: (target: string) => TargetState | undefined, item: EnvInput['item']): string {
  return (h.env ?? []).map(c => `${c.name} on ${c.target} (${c.secret === true ? 'secret' : 'value'}): ${stateWord({ pr: h.pr, change: c }, ts(c.target), item)}`).join('; ')
}

// The deploy tool's list: pending env changes of one target.
export function envListLine(entries: EnvEntry[], ts: TargetState | undefined, item: EnvInput['item']): string {
  if (entries.length === 0) return ''
  return `env pending: ${entries.map(e => `${e.change.name} (PR #${e.pr}, ${e.change.secret === true ? 'secret' : 'value'}, ${stateWord(e, ts, item)})`).join(', ')}`
}

// The handover tool's env field, checked whole. A refusal never repeats a value: it names the entry by
// its position and name only.
export function parseEnvInput(raw: unknown, targets: TargetInfo[]): { drafts: Draft[] } | { error: string } {
  if (raw === undefined || raw === null) return { drafts: [] }
  if (!Array.isArray(raw)) return { error: 'env must be a list of {target, name, value or secret: true, why, login?}.' }
  if (raw.length === 0) return { drafts: [] }
  if (targets.length === 0) return { error: 'env changes need a deploy target, and none is configured (deploy_targets). Say the change in the PR text and in pending instead.' }
  const out: Draft[] = []
  for (const [i, r] of raw.entries()) {
    const at = `env[${i}]`
    if (typeof r !== 'object' || r === null) return { error: `${at} must be an object.` }
    const e = r as Record<string, unknown>
    const target = typeof e.target === 'string' ? e.target.trim() : ''
    const bad = unknownTarget(targets, target)
    if (bad !== undefined) return { error: `${at}.target: ${bad}` }
    const name = typeof e.name === 'string' ? e.name : ''
    if (!ENV_NAME.test(name)) return { error: `${at}.name must be an env var name (letters, digits, underscore; not starting with a digit).` }
    const label = `${at} (${name} on ${target})`
    const secret = e.secret
    if (secret !== undefined && secret !== true && secret !== false) return { error: `${label}: secret must be true when set.` }
    if (secret === true && e.value !== undefined) return { error: `${label}: give either value or secret: true, not both. A secret has no value in flow; the user sets it.` }
    if (secret !== true && e.value === undefined) return { error: `${label}: give a value, or secret: true when the user sets it themselves.` }
    if (secret !== true && (typeof e.value !== 'string' || /[\n\r\0]/.test(e.value))) return { error: `${label}: value must be a single-line string.` }
    const why = typeof e.why === 'string' ? e.why.trim() : ''
    if (why === '') return { error: `${label}: why is required.` }
    if (e.login !== undefined && (typeof e.login !== 'string' || e.login.trim() === '')) return { error: `${label}: login must be text naming the step the user does themselves.` }
    if (out.some(o => o.target === target && o.name === name)) return { error: `${label}: listed twice.` }
    out.push({
      target, name, why,
      ...(secret === true ? { secret: true as const } : { value: e.value as string }),
      ...(typeof e.login === 'string' ? { login: e.login.trim() } : {}),
    })
  }
  return { drafts: out }
}
