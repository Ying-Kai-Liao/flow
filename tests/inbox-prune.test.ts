import { expect } from 'claude-code/testing'
import { timedTest as test } from './support'
import { applyPrunes, autoPrune, explicitCandidates, linkedPr, prunePreview, pruneCandidates, pruneIds, pruneResult, AUTO_PRUNE, PRUNED, USER_PRUNE } from '../hooks/inbox-prune'
import type { PruneFacts, PruneIo } from '../hooks/inbox-prune'
import { archiveRowText, EMPTY_INBOX, findItem, inboxHead, KEEP, markAnswered, renderArchive, renderInbox, renderItem } from '../hooks/inbox'
import type { Inbox } from '../hooks/inbox'
import { suggestionQuestion } from '../hooks/guardtests'
import { suggest } from '../hooks/standing'
import { inboxData } from '../hooks/decide-eval'
import type { Handover, LogEvent, Question } from '../types'

const NOW = 10_000_000

const item = (id: string, over: Partial<Question> = {}): Question => ({
  id, owner: 'w', addressee: 'mgr', question: `question ${id}`, options: ['Yes', 'No'], default: 'Yes', blocking: false,
  askedAt: 1000, state: 'open', delivered: false, ...over,
})
const fyi = (id: string, over: Partial<Question> = {}): Question => item(id, { kind: 'fyi', options: [KEEP, 'Undo'], default: KEEP, ...over })
const box = (...items: Question[]): Inbox => ({ next: 100, nextD: 100, items })

const ho = (pr: number, status: Handover['status'], over: Partial<Handover> = {}): Handover =>
  ({ pr, title: `T${pr}`, head: `h${pr}0000000`, branch: `flow/b${pr}`, reportTo: 'mgr', verified: '', pending: '', afterDeploy: '', status, at: pr, ...over })

// Nothing merged or closed, nobody over, nobody live: a fact set a test fills in.
const facts = (over: Partial<PruneFacts> = {}): PruneFacts => ({
  handovers: {}, merged: new Set(), closed: new Set(), ended: new Set(), live: new Set(), ...over,
})
const hs = (...list: Handover[]) => Object.fromEntries(list.map(h => [String(h.pr), h]))

// An old guard suggestion: its PR only in the text (guardtests.ts wording), no pr field.
const oldGuard = (id: string, pr: number): Question => {
  const { pr: _pr, ...asked } = suggestionQuestion(pr, { test: 'tests/state.test.ts', glob: 'hooks/**', files: ['hooks/a.ts'] })
  return item(id, { ...asked, owner: 'reviewer-3', addressee: 'main' })
}

test('a guard suggestion is filed with its PR, and an old one is linked by the "PR #N" its text opens with', () => {
  expect(suggestionQuestion(244, { test: 't', glob: 'g/**', files: ['g/a'] }).pr).toBe(244)
  expect(linkedPr(oldGuard('q53', 244))).toBe(244)
  expect(linkedPr(item('q1', { pr: 7 }))).toBe(7)
  expect(linkedPr(item('q2', { kind: 'env', env: { role: 'change', target: 't', name: 'N', pr: 9 } }))).toBe(9)
  // A "#N" in free text is no link, not even "PR #N" at the start of a question that is no guard suggestion.
  expect(linkedPr(item('q3', { question: 'PR #12 was sent back: rebase?' }))).toBeUndefined()
  expect(linkedPr(fyi('d1', { question: 'Kept #12 as is' }))).toBeUndefined()
})

test('a linked item goes once its PR is merged (handover done or GitHub) or closed; an open or unknown PR keeps it', () => {
  const inbox = box(oldGuard('q53', 244), item('q2', { pr: 7 }), item('q3', { pr: 8 }), item('q4', { pr: 9 }), item('q5', { pr: 10 }))
  const got = pruneCandidates(inbox, facts({
    handovers: hs(ho(244, 'done'), ho(9, 'pending'), ho(10, 'returned')), merged: new Set([7]), closed: new Set([8]),
  }))
  expect(got).toEqual([
    { id: 'q53', reason: 'PR #244 merged', pr: 244 },
    { id: 'q2', reason: 'PR #7 merged', pr: 7 },
    { id: 'q3', reason: 'PR #8 closed', pr: 8 },
  ])
})

test('a linked item never falls back to the owner rule: its PR decides', () => {
  const f = facts({ handovers: hs(ho(5, 'done', { branch: 'flow/w' })), ended: new Set(['w']) })
  expect(pruneCandidates(box(item('q1', { pr: 6 })), f)).toEqual([])
})

test('an unlinked item goes when its owner finished, nobody live is addressed and every PR of the owner is merged or closed', () => {
  const inbox = box(fyi('d109', { owner: 'prune-x', addressee: 'mgr-gone' }), item('q7', { owner: 'prune-x', addressee: 'mgr-gone' }))
  const f = facts({
    handovers: hs(ho(12, 'done', { branch: 'flow/prune-x' }), ho(14, 'returned', { branch: 'flow/prune-x' }), ho(15, 'returned', { branch: 'flow/prune-x' }), ho(99, 'pending')),
    merged: new Set([14]), closed: new Set([15]), ended: new Set(['prune-x']),
  })
  expect(pruneCandidates(inbox, f)).toEqual([
    { id: 'd109', reason: 'owner prune-x finished; PRs #12, #14 merged, PR #15 closed' },
    { id: 'q7', reason: 'owner prune-x finished; PRs #12, #14 merged, PR #15 closed' },
  ])
})

test("a manager's item counts the PRs that report to it, by family name", () => {
  const inbox = box(fyi('d1', { owner: 'csv-export-2', addressee: 'main', askerIsManager: true }))
  const f = facts({ handovers: hs(ho(30, 'done', { reportTo: 'csv-export', branch: 'flow/csv-worker' })), ended: new Set(['csv-export']) })
  expect(pruneCandidates(inbox, f)).toEqual([{ id: 'd1', reason: 'owner csv-export-2 finished; PR #30 merged' }])
})

test('an unlinked item stays: owner never seen, owner live, no handover, a PR still open, or addressed to an agent that runs', () => {
  const done = ho(12, 'done', { branch: 'flow/w' })
  const d = fyi('d1')
  // Never seen: endedOwners leaves it out, so ended is empty.
  expect(pruneCandidates(box(d), facts({ handovers: hs(done) }))).toEqual([])
  // Finished, but without a single handover.
  expect(pruneCandidates(box(d), facts({ ended: new Set(['w']) }))).toEqual([])
  // One of its PRs is still open (returned, open on GitHub).
  expect(pruneCandidates(box(d), facts({ handovers: hs(done, ho(13, 'returned', { branch: 'flow/w' })), ended: new Set(['w']) }))).toEqual([])
  // Its manager still runs and may answer it.
  expect(pruneCandidates(box(d), facts({ handovers: hs(done), ended: new Set(['w']), live: new Set(['mgr']) }))).toEqual([])
  expect(pruneCandidates(box(d), facts({ handovers: hs(done), ended: new Set(['w']) }))).toEqual([{ id: 'd1', reason: 'owner w finished; PR #12 merged' }])
})

test('deploy, env, push and reviewer items and escalation links are never auto-pruned, whatever their PR or owner', () => {
  const env = { role: 'change' as const, target: 'prod', name: 'N', pr: 12 }
  const inbox = box(
    item('q1', { kind: 'deploy', pr: 12 }), item('q2', { kind: 'env', env }), item('q3', { kind: 'push' }), item('q4', { kind: 'reviewer' }),
    item('q5', { escalated: 'r1' }), item('q6', { forQ: 'q7' }), item('q7', { viaQ: 'q6', escalated: 'via q6' }), item('q8', { viaQ: 'q6' }),
  )
  const f = facts({ handovers: hs(ho(12, 'done', { branch: 'flow/w' })), merged: new Set([12]), ended: new Set(['w']) })
  expect(pruneCandidates(inbox, f)).toEqual([])
})

test('applying: a decision is kept, a question answered "Pruned", by flow, delivered, with no auto or rule field; answered items untouched', () => {
  const inbox = box(fyi('d1', { auto: { by: 'jev', confidence: 0.5 } }), item('q1'), item('q2', { state: 'answered', answer: 'No', answeredBy: 'mgr' }))
  const r = applyPrunes(inbox, [{ id: 'd1', reason: 'r1' }, { id: 'q1', reason: 'r2', pr: 4 }, { id: 'q2', reason: 'r3' }, { id: 'q9', reason: 'r4' }], AUTO_PRUNE, NOW)
  const d1 = findItem(r.inbox, 'd1')!
  expect(d1).toMatchObject({ state: 'answered', answer: KEEP, answeredBy: 'flow', via: 'flow', answeredAt: NOW, delivered: true, pruned: { at: NOW, reason: 'r1', by: 'flow' } })
  expect('auto' in d1).toBe(false)
  expect(findItem(r.inbox, 'q1')).toMatchObject({ state: 'answered', answer: PRUNED, pruned: { reason: 'r2', by: 'flow' } })
  expect(findItem(r.inbox, 'q2')).toEqual(inbox.items[2])
  expect(r.skipped).toEqual(['q2', 'q9'])
  // By the person or main: who is recorded, the way each answers.
  expect(findItem(applyPrunes(inbox, [{ id: 'q1', reason: 'x' }], USER_PRUNE, NOW).inbox, 'q1')).toMatchObject({ answeredBy: 'the user', via: 'user', pruned: { by: 'the user' } })
  expect(findItem(applyPrunes(inbox, [{ id: 'q1', reason: 'x' }], 'main', NOW).inbox, 'q1')).toMatchObject({ answeredBy: 'main', via: 'main' })
})

test('pruning again changes nothing: the same inbox comes back', () => {
  const f = facts({ handovers: hs(ho(244, 'done')) })
  const first = applyPrunes(box(oldGuard('q53', 244)), pruneCandidates(box(oldGuard('q53', 244)), f), AUTO_PRUNE, NOW).inbox
  expect(pruneCandidates(first, f)).toEqual([])
  const again = applyPrunes(first, [{ id: 'q53', reason: 'PR #244 merged' }], AUTO_PRUNE, NOW + 1)
  expect(again.inbox).toBe(first)
  expect(again.pruned).toEqual([])
})

test('a pruned item is no longer answerable: markAnswered reports it answered', () => {
  const pruned = applyPrunes(box(fyi('d1')), [{ id: 'd1', reason: 'r' }], AUTO_PRUNE, NOW).inbox
  expect(markAnswered(pruned, 'd1', 'Undo', 'main', NOW).kind).toBe('answered')
})

test('explicit candidates: deploy, env, push and reviewer items are refused one line each; unknown, answered and pruned ids say so; aliases resolve', () => {
  const env = { role: 'secret' as const, target: 'prod', name: 'N', pr: 12 }
  const inbox = box(
    item('q1', { kind: 'deploy' }), item('q2', { kind: 'env', env }), item('q3', { kind: 'push' }), item('q4', { kind: 'reviewer' }),
    item('q5', { pr: 3 }), item('q6', { state: 'answered', answer: 'No' }),
    item('q7', { state: 'answered', answer: PRUNED, pruned: { at: 1, reason: 'PR #3 merged', by: 'flow' } }),
    fyi('d8', { alias: 'q20' }), item('q9', { escalated: 'r1' }),
  )
  const r = explicitCandidates(inbox, ['q1', 'Q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q20', 'q9', 'q99', 'q5'], 'pruned by the user')
  expect(r.cands).toEqual([{ id: 'q5', reason: 'pruned by the user', pr: 3 }, { id: 'd8', reason: 'pruned by the user' }, { id: 'q9', reason: 'pruned by the user' }])
  expect(r.lines).toEqual([
    'q1: not pruned, a deploy approval: answer it (/flow answer q1 <choice>) or hold its target (/flow hold <target>).',
    'q2: not pruned, an env change: answer it with /flow answer q2 <choice>.',
    'q3: not pruned, a push: /flow push drop returns the batch.',
    'q4: not pruned, a reviewer retry: answer it with /flow answer q4 <choice>.',
    'q6: already answered ("No"); nothing to prune.',
    'q7: already pruned (PR #3 merged); nothing to prune.',
    'q99: no such question or decision.',
  ])
})

// A PruneIo over one in-memory inbox; prs and agents as the test sets them.
function world(start: Inbox, over: Partial<PruneIo> = {}) {
  let inbox = start
  const log: Array<Omit<LogEvent, 'ts'>> = []
  const calls = { writes: 0, prs: 0 }
  const io: PruneIo = {
    now: async () => NOW,
    inbox: async () => inbox,
    withInbox: async fn => { const r = fn(inbox); if (r.inbox !== inbox) calls.writes++; inbox = r.inbox; return r.out },
    handovers: async () => hs(ho(244, 'done'), ho(12, 'done', { branch: 'flow/w' })),
    agents: async () => [{ name: 'w', status: 'completed' }, { name: 'mgr', status: 'completed' }],
    seen: async () => ({}),
    prs: async () => { calls.prs++; return { merged: new Map(), closed: new Set() } },
    appendLog: async e => { log.push(e) },
    ...over,
  }
  return { io, log, calls, box: () => inbox }
}

test('auto-prune: prunes, logs one prune event per item with its PR, and running it again prunes nothing', async () => {
  const w = world(box(oldGuard('q53', 244), fyi('d109'), item('q1', { kind: 'deploy', pr: 244 })))
  const pruned = await autoPrune(w.io)
  expect(pruned?.map(q => q.id)).toEqual(['q53', 'd109'])
  expect(w.log).toEqual([
    { event: 'prune', owner: 'main', agent: 'reviewer-3', id: 'q53', pr: 244, text: 'PR #244 merged' },
    { event: 'prune', owner: 'mgr', agent: 'w', id: 'd109', text: 'owner w finished; PR #12 merged' },
  ])
  expect(findItem(w.box(), 'q1')!.state).toBe('open')
  expect(await autoPrune(w.io)).toEqual([])
  expect(w.calls.writes).toBe(1)
  expect(w.log.length).toBe(2)
})

test('auto-prune: a gh failure prunes nothing and never throws; nothing prunable asks gh nothing', async () => {
  const failed = world(box(oldGuard('q53', 244)), { prs: async () => ({ merged: undefined, closed: new Set() }) })
  expect(await autoPrune(failed.io)).toBeUndefined()
  expect(await prunePreview(failed.io)).toBeUndefined()
  expect(findItem(failed.box(), 'q53')!.state).toBe('open')
  expect(failed.calls.writes).toBe(0)
  const boom = world(box(oldGuard('q53', 244)), { prs: async () => { throw new Error('gh') } })
  expect(await autoPrune(boom.io)).toBeUndefined()
  // Only protected or answered items, or an owner that still runs: gh is not asked at all.
  const quiet = world(box(item('q1', { kind: 'deploy', pr: 244 }), item('q2', { state: 'answered' }), item('q3', { owner: 'live-one' })),
    { agents: async () => [{ name: 'live-one', status: 'running' }] })
  expect(await autoPrune(quiet.io)).toEqual([])
  expect(await prunePreview(quiet.io)).toEqual([])
  expect(quiet.calls.prs).toBe(0)
})

test('auto-prune judges the inbox the write reads: an answer given meanwhile is never overwritten', async () => {
  const w = world(box(oldGuard('q53', 244)))
  const answered = { ...box(oldGuard('q53', 244)), items: [{ ...oldGuard('q53', 244), state: 'answered' as const, answer: 'No', answeredBy: 'main' }] }
  w.io.withInbox = async fn => fn(answered).out
  expect(await autoPrune(w.io)).toEqual([])
  expect(w.log).toEqual([])
})

test('the preview lists without pruning; pruneIds prunes the named items and refuses the rest', async () => {
  const w = world(box(oldGuard('q53', 244), item('q2', { kind: 'push' }), item('q3', { owner: 'never-seen' })))
  expect(await prunePreview(w.io)).toEqual([{ id: 'q53', reason: 'PR #244 merged', pr: 244 }])
  expect(findItem(w.box(), 'q53')!.state).toBe('open')
  const lines = await pruneIds(w.io, ['q3', 'q2'], USER_PRUNE, 'pruned by the user')
  expect(lines).toEqual(['Pruned q3 (pruned by the user); nobody is told.', 'q2: not pruned, a push: /flow push drop returns the batch.'])
  expect(findItem(w.box(), 'q3')).toMatchObject({ state: 'answered', answer: PRUNED, pruned: { by: 'the user', reason: 'pruned by the user' } })
  expect(await pruneIds(w.io, ['q3'], USER_PRUNE, 'pruned by the user')).toEqual(['q3: already pruned (pruned by the user); nothing to prune.'])
  expect(pruneResult(undefined)).toContain('gh failed')
  expect(pruneResult([])).toBe('Nothing to prune.')
})

test('a pruned item shows in /flow inbox, the archive, the item view and the status head; open counts drop', () => {
  const inbox = applyPrunes(box(oldGuard('q53', 244), fyi('d109'), item('q1', { addressee: 'main', blocking: true })),
    [{ id: 'q53', reason: 'PR #244 merged', pr: 244 }, { id: 'd109', reason: 'owner x finished; PR #12 merged' }], AUTO_PRUNE, NOW).inbox
  const text = renderInbox(inbox, NOW + 60_000)
  expect(text).toContain('Pruned in the last day: q53 (PR #244 merged), d109 (owner x finished; PR #12 merged)')
  expect(text.split('\n')[0]).toBe('1 question (1 blocking).')
  expect(renderInbox(inbox, NOW + 60_000, { width: 40 }).split('\n').find(l => l.startsWith('Pruned'))!.length).toBeLessThanOrEqual(40)
  // A day later the line is gone; the archive keeps them.
  expect(renderInbox(inbox, NOW + 2 * 86_400_000)).not.toContain('Pruned in the last day')
  const archive = renderArchive(inbox, NOW + 60_000)
  expect(archive).toContain('q53 Pruned: PR #244 merged (1 min ago)')
  expect(archive).toContain('d109 Pruned: owner x finished; PR #12 merged')
  expect(archive).not.toContain('Kept')
  expect(archiveRowText(findItem(inbox, 'q53')!, NOW)).not.toContain(PRUNED + ' (by')
  expect(renderItem(inbox, 'd109', NOW)).toContain('Pruned: owner x finished; PR #12 merged (by flow, 0 min ago); nobody was told.')
  expect(inboxHead(inbox, NOW).join('\n')).toContain('Inbox: 2 stale items pruned in the last 24 h')
  // Nothing open at all: the line still shows.
  const all = applyPrunes(inbox, [{ id: 'q1', reason: 'r' }], 'main', NOW).inbox
  expect(renderInbox(all, NOW)).toContain('Pruned in the last day: ')
  expect(renderInbox(EMPTY_INBOX, NOW)).not.toContain('Pruned')
})

test('a prune is nobody\'s answer: no standing-rule suggestion counts it and decide_eval takes no label from it', () => {
  const qs = [1, 2, 3].map(n => item(`q${n}`, { topic: 'naming', addressee: 'main' }))
  const pruned = applyPrunes(box(...qs), qs.map(q => ({ id: q.id, reason: 'r' })), 'main', NOW).inbox
  expect(suggest(pruned, [])).toEqual([])
  // The same three answered by main would be a suggestion.
  const byMain = qs.reduce((b, q) => { const m = markAnswered(b, q.id, 'No', 'main', NOW); return m.kind === 'ok' ? m.inbox : b }, box(...qs))
  expect(suggest(byMain, []).length).toBe(1)
  const kept = applyPrunes(box(fyi('d1'), fyi('d2')), [{ id: 'd1', reason: 'r' }], 'main', NOW).inbox
  const answered = markAnswered(kept, 'd2', KEEP, 'main', NOW)
  const items = answered.kind === 'ok' ? answered.inbox.items : []
  expect(inboxData(items).records.map(r => r.id)).toEqual(['d2'])
})
