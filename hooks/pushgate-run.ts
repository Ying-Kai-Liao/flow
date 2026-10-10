// The push gate's state and actions: push.json behind one chain, the reviewer's "ready", the user's push, send-back
// and drop, and the answer to the push item. The pure rules are in pushgate.ts. The engine handle `$` is never
// passed across an import, so register.tsx hands in the calls.
import type { Handover, LogEvent } from '../types'
import {
  batchId, closePushItem, DROPPED_REASON, dropStep, itemOf, newBatch, normalizePush, openPushItem, parsePushMode, parseVerdict,
  recordable, refOf, releaseStep, renderBatch, sendBackStep, SENT_BACK_REASON, settlePrs,
} from './pushgate'
import type { PushState, ReadyBatch } from './pushgate'
import type { Settings } from './prompts'
import type { Inbox, Question } from './inbox'

export type PushIo = {
  stateDir: () => Promise<string | undefined>
  readJson: (path: string) => Promise<unknown>
  writeJson: (path: string, obj: unknown) => Promise<boolean>
  mkdir: (dir: string) => Promise<unknown>
  push: () => Promise<PushState>
  setPush: (next: PushState) => Promise<void>
  exec: (argv: string[], timeoutMs: number) => Promise<{ exitCode: number; stdout: string }>
  now: () => Promise<number>
  handovers: () => Promise<Record<string, Handover>>
  updateHandovers: (fn: (hs: Record<string, Handover>) => Record<string, Handover>) => Promise<void>
  saveHandover: (h: Handover) => Promise<void>
  appendLog: (event: Omit<LogEvent, 'ts'>) => Promise<void>
  best: (what: string, fn: () => Promise<void>) => Promise<void>
  withInbox: <T>(fn: (cur: Inbox) => { inbox: Inbox; out: T }) => Promise<T>
  ensureQueue: () => Promise<string>
  closeReturnedEnv: (h: Handover) => Promise<void>
  sizeBackNote: (branch: string) => Promise<string | undefined>
  tellManager: (name: string, text: string) => Promise<void>
  // Forget the cut release of a dropped batch (its key is the sorted PR numbers).
  dropRelease: (key: string) => Promise<void>
  toast: (text: string) => void
}

// Push state changes run one after another, like the inbox's.
let pushChain: Promise<unknown> = Promise.resolve()

// Read push.json, let fn change it, write it back atomically and set the atom. fn returns the new state (the same
// object when nothing changed) and whatever the caller wants back.
export function withPush<T>(io: PushIo, fn: (cur: PushState) => { push: PushState; out: T }): Promise<T> {
  const run = async (): Promise<T> => {
    const dir = await io.stateDir()
    const cur = dir === undefined ? await io.push() : normalizePush(await io.readJson(`${dir}/push.json`))
    const { push: next, out } = fn(cur)
    if (next !== cur) {
      if (dir !== undefined) {
        await io.mkdir(dir)
        await io.writeJson(`${dir}/push.json`, next)
      }
      await io.setPush(next)
    }
    return out
  }
  const result = pushChain.then(run, run)
  pushChain = result.catch(() => undefined)
  return result
}

// The commit a local ref points at, or undefined.
async function refSha(io: PushIo, ref: string): Promise<string | undefined> {
  const r = await io.exec(['git', 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], 10_000).catch(() => undefined)
  return r !== undefined && r.exitCode === 0 && r.stdout.trim() !== '' ? r.stdout.trim() : undefined
}

// The batch's ref is deleted once the batch is pushed, dropped or rebuilt. Best effort: a stray ref is harmless.
async function dropRef(io: PushIo, ref: string): Promise<void> {
  await io.exec(['git', 'update-ref', '-d', ref], 10_000).catch(() => undefined)
}


// The user's push, send-back or drop returns a PR the way the reviewer's "back" does.
async function returnPr(io: PushIo, h: Handover, reason: string): Promise<void> {
  const next: Handover = { ...h, status: 'returned', reason }
  await io.updateHandovers(hs => ({ ...hs, [String(h.pr)]: next }))
  await io.best('saving a handover', async () => {
    await io.saveHandover(next)
    await io.appendLog({ event: 'back', owner: next.reportTo, pr: next.pr, branch: next.branch, text: reason })
  })
  await io.closeReturnedEnv(next)
  const size = await io.sizeBackNote(next.branch)
  await io.tellManager(next.reportTo, `flow: PR #${next.pr} was returned: ${reason}. Decide what to do with it, and hand it over again when it is ready.${size === undefined ? '' : ` ${size}`}`)
}

const closeBatchItem = (io: PushIo, qid: string | undefined, answer: string, by: string, at: number) =>
  io.withInbox(cur => ({ inbox: closePushItem(cur, qid, answer, by, at), out: undefined }))

// The reviewer records a checked batch (push_mode confirm): its head is under refs/flow/push/<id>, the PRs become
// "ready", the user is asked.
export async function recordReady(io: PushIo, settings: Settings, input: Record<string, unknown>): Promise<string> {
  if (parsePushMode(settings.pushMode) !== 'confirm') return 'Refused: push_mode is auto, so there is no push gate. Push the batch yourself (step 4).'
  const prs = Array.isArray(input.prs) ? [...new Set(input.prs.map(Number))].filter(n => Number.isInteger(n) && n > 0) : []
  if (prs.length === 0) return 'Refused: prs must list the PR numbers of the batch.'
  const full = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{40}$/i.test(v.trim()) ? v.trim().toLowerCase() : undefined
  const sha = full(input.sha)
  const baseSha = full(input.base_sha)
  if (sha === undefined) return 'Refused: sha must be the full 40-character sha of the batch head (git rev-parse HEAD).'
  if (baseSha === undefined) return 'Refused: base_sha must be the full 40-character sha of origin/<base> you built the batch on.'
  const check = typeof input.check === 'string' ? input.check.trim() : ''
  if (check === '') return 'Refused: check must say, in one line, what the full check gave ("N tests passed" or "none configured").'
  const version = typeof input.version === 'string' ? input.version.trim().replace(/^v/, '') : undefined
  const id = batchId(sha)
  const at = await io.now()
  const hs = await io.handovers()
  for (const n of prs) {
    const h = hs[String(n)]
    if (h === undefined) return `Refused: no handover for PR #${n}.`
    if (!recordable(h.status)) return `Refused: PR #${n} is ${h.status}; a batch holds PRs you took ("take") or that are already ready.`
  }
  const have = await refSha(io, refOf(id))
  if (have !== sha) {
    return `Refused: ${refOf(id)} ${have === undefined ? 'does not exist' : `points at ${have}, not ${sha}`}. Run \`git update-ref ${refOf(id)} HEAD\` in your worktree on the batch head, then call ready again.`
  }
  const items = prs.map(n => itemOf(hs[String(n)]!))
  const batch = newBatch({ sha, baseSha, check, ...(version !== undefined && version !== '' ? { version } : {}), items, now: at })
  type Decided = { kind: 'same' } | { kind: 'awaits'; id: string } | { kind: 'new'; old: ReadyBatch | undefined }
  const decided = await withPush<Decided>(io, cur => {
    if (cur.batch?.state === 'ready') {
      return { push: cur, out: cur.batch.sha === sha ? { kind: 'same' as const } : { kind: 'awaits' as const, id: cur.batch.id } }
    }
    return { push: { batch }, out: { kind: 'new' as const, old: cur.batch } }
  })
  if (decided.kind === 'same') return `Batch ${id} is already recorded and awaits the user's /flow push. End your run.`
  if (decided.kind === 'awaits') return `Refused: batch ${decided.id} already awaits the user's /flow push; there is only one ready batch at a time. Leave your PRs alone and end your run.`
  if (decided.old !== undefined && decided.old.ref !== batch.ref) await dropRef(io, decided.old.ref)
  const q = await io.withInbox(cur => {
    const r = openPushItem(cur, batch, at)
    return { inbox: r.inbox, out: r.q }
  })
  await withPush(io, cur => (cur.batch?.id === id ? { push: { batch: { ...cur.batch, qid: q.id } }, out: undefined } : { push: cur, out: undefined }))
  for (const n of prs) {
    const h = (await io.handovers())[String(n)]!
    const next: Handover = { ...h, status: 'ready' }
    await io.updateHandovers(all => ({ ...all, [String(n)]: next }))
    await io.best('saving a handover', async () => {
      await io.saveHandover(next)
      await io.appendLog({ event: 'ready', owner: next.reportTo, pr: next.pr, branch: next.branch, text: `batch ${id} awaits /flow push` })
    })
  }
  io.toast(`Batch ${id} ready to push (${prs.map(n => `#${n}`).join(' ')}): /flow push`)
  return `Recorded batch ${id}: ${prs.map(n => `#${n}`).join(', ')} are ready and wait for the user's /flow push (inbox ${q.id}). Do not push, delete branches, publish or deploy. End your run now with your report: batch ${id} ready, awaits /flow push.`
}

// After a PR is done or sent back, a batch with none of its PRs left is finished: its ref goes.
export async function settleBatch(io: PushIo): Promise<void> {
  const hs = await io.handovers()
  const ended = await withPush<ReadyBatch | undefined>(io, cur => {
    const b = settlePrs(cur.batch, pr => hs[String(pr)]?.status)
    if (b === cur.batch) return { push: cur, out: undefined }
    return { push: b === undefined ? {} : { batch: b }, out: b === undefined ? cur.batch : undefined }
  })
  if (ended === undefined) return
  await dropRef(io, ended.ref)
  await closeBatchItem(io, ended.qid, 'finished', 'flow', await io.now())
}

// The user's push, send-back and drop (the command, the tool main calls and the answer to the inbox item all land here).
export type PushAct = { kind: 'push' } | { kind: 'back'; pr: number } | { kind: 'drop' }
export async function pushAct(io: PushIo, act: PushAct, by: string): Promise<string> {
  const at = await io.now()
  type Out = { why: string } | { before: ReadyBatch; after?: ReadyBatch | undefined }
  const out = await withPush<Out>(io, cur => {
    const s = act.kind === 'push' ? releaseStep(cur.batch, at) : act.kind === 'back' ? sendBackStep(cur.batch, act.pr) : dropStep(cur.batch)
    if (s.kind === 'refused') return { push: cur, out: { why: s.why } }
    const before = cur.batch!
    if (act.kind === 'drop') return { push: {}, out: { before } }
    return { push: s.batch === undefined ? {} : { batch: s.batch }, out: { before, after: s.batch } }
  })
  if ('why' in out) return out.why
  const { before, after } = out
  const said = act.kind === 'push' ? 'push' : act.kind === 'drop' ? 'drop' : `send back #${act.pr}`
  await closeBatchItem(io, before.qid, said, by, at)
  await io.best('logging the push decision', () => io.appendLog({ event: 'push', owner: 'main', text: `${by}: ${said} (batch ${before.id})` }))
  const hs = await io.handovers()
  if (act.kind === 'push') {
    const queue = await io.ensureQueue()
    return `Batch ${before.id} released (${before.prs.map(n => `#${n}`).join(', ')}). A reviewer pushes it, deletes the merged branches, deploys and marks the PRs done. ${queue}`
  }
  if (act.kind === 'back') {
    const h = hs[String(act.pr)]
    if (h !== undefined) await returnPr(io, h, SENT_BACK_REASON)
    if (after === undefined) {
      await dropRef(io, before.ref)
      return `PR #${act.pr} sent back. It was the last PR of batch ${before.id}: the batch is gone.`
    }
    const queue = await io.ensureQueue()
    return `PR #${act.pr} sent back. The rest of batch ${before.id} (${after.prs.map(n => `#${n}`).join(', ')}) is rebuilt and re-checked, then you are asked again. ${queue}`
  }
  for (const n of before.prs) {
    const h = hs[String(n)]
    if (h !== undefined) await returnPr(io, h, DROPPED_REASON)
  }
  await dropRef(io, before.ref)
  // A dropped batch may be handed over again as it was: its release is not "already cut" any more.
  const key = [...before.prs].sort((a, b) => a - b).join(',')
  await io.dropRelease(key)
  return `Batch ${before.id} dropped: ${before.prs.map(n => `#${n}`).join(', ')} went back to their managers, the ref ${before.ref} is deleted.`
}

// The answer to the push item: "push", "send back #n", "drop"; "not yet" or anything else reopens a fresh item.
export async function onPushAnswer(io: PushIo, q: Question, answer: string, by: string): Promise<string> {
  const v = parseVerdict(answer)
  if (v.kind === 'push') return ` ${await pushAct(io, { kind: 'push' }, by)}`
  if (v.kind === 'back') return ` ${await pushAct(io, { kind: 'back', pr: v.pr }, by)}`
  if (v.kind === 'drop') return ` ${await pushAct(io, { kind: 'drop' }, by)}`
  const at = await io.now()
  const batch = (await io.push()).batch
  if (batch === undefined || batch.state !== 'ready' || batch.qid !== q.id) return ''
  const fresh = await io.withInbox(cur => {
    const r = openPushItem(cur, batch, at)
    return { inbox: r.inbox, out: r.q }
  })
  await withPush(io, cur => (cur.batch?.id === batch.id ? { push: { batch: { ...cur.batch, qid: fresh.id } }, out: undefined } : { push: cur, out: undefined }))
  return v.kind === 'later'
    ? ` Batch ${batch.id} stays ready; ${fresh.id} asks again.`
    : ` "${answer}" is not push, send back #<pr>, drop or not yet; batch ${batch.id} stays ready and ${fresh.id} asks again.`
}

// The lines that tell the user a batch awaits them (status, resume).
export const pushLines = (s: PushState): string[] => (s.batch === undefined ? [] : renderBatch(s.batch))

