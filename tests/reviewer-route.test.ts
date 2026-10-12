import { expect } from 'claude-code/testing'
import { test } from './support'
import type { Activity, Handover } from '../types'
import type { Plan } from '../hooks/dag'
import type { Inbox } from '../hooks/inbox'
import { isManagerOf, planOwner } from '../hooks/roster-run'
import { managerFinished, needLines, needToken, normText, resolveReportTo, reviewerReport, reviewerSendGuard } from '../hooks/reviewer-route'
import type { Forwarded, RouteIo } from '../hooks/reviewer-route'

type Row = { id: string; name?: string; type: string; status: string; parentId?: string }
type W = {
  agents?: Row[]
  activity?: Record<string, Partial<Activity>>
  handovers?: Record<string, Partial<Handover>>
  plans?: Plan
  inbox?: unknown[]
  seen?: Record<string, { status: string; id?: string; answer?: string }>
  forwarded?: Forwarded
}

function fake(w: W = {}) {
  let fwd: Forwarded = w.forwarded ?? { keys: {}, lines: {} }
  const notes: [string, string][] = []
  const main: string[] = []
  const io: RouteIo = {
    agents: async () => w.agents ?? [],
    activity: async () => (w.activity ?? {}) as Record<string, Activity>,
    handovers: async () => (w.handovers ?? {}) as Record<string, Handover>,
    plans: async () => w.plans ?? {},
    inbox: async () => ({ items: w.inbox ?? [] }) as unknown as Inbox,
    seenAgents: async () => w.seen ?? {},
    forwarded: async () => fwd,
    updateForwarded: async fn => { fwd = fn(fwd) },
    messages: async () => [],
    planOwner, isManagerOf,
    appendNote: async (name, line) => { notes.push([name, line]); return true },
    today: async () => '2026-10-13',
    toMain: t => { main.push(t) },
  }
  return { io, notes, main, fwd: () => fwd }
}

const mgr = (id: string, name: string, status: string, parentId?: string): Row => ({ id, name, type: 'flow:manager', status, ...(parentId && { parentId }) })
const worker = (id: string, name: string, status: string, parentId?: string): Row => ({ id, name, type: 'flow:worker', status, ...(parentId && { parentId }) })

test('normText collapses whitespace', async () => {
  expect(normText('  a \n\t b  ')).toBe('a b')
})

test('needLines extracts needs-a-person and pending-decisions lines, cut at " | "', async () => {
  const text = 'done #5 | Needs a person: check the dashboard | pending decisions: none yet\nOther line\npending decisions:   a   b\nneeds a person: second'
  expect(needLines(text)).toEqual(['Needs a person: check the dashboard', 'pending decisions: none yet', 'pending decisions: a b', 'needs a person: second'])
  expect(needLines('nothing to see')).toEqual([])
  expect(needLines('needs a person:|x')).toEqual(['needs a person:'])
})

test('a done line and a lone line give equal needs lines', async () => {
  expect(needLines('PR #3 done | needs a person: look | next')).toEqual(needLines('needs a person: look'))
})

test('needToken keys needs-a-person lines by PR, and leaves other lines as they are', async () => {
  expect(needToken('needs a person: verify PR #12 on staging')).toBe('needs:pr:12')
  expect(needToken('Needs a person: reworded, see PR#12')).toBe('needs:pr:12')
  expect(needToken('needs a person: no number here')).toBe('needs a person: no number here')
  expect(needToken('pending decisions: PR #12 merge mode')).toBe('pending decisions: PR #12 merge mode')
})

test('reviewerReport appends the main-checkout line, once, and only for a run with batch work', async () => {
  expect(reviewerReport('all done', undefined)).toBeUndefined()
  expect(reviewerReport('all done', { touched: false, ready: false })).toBeUndefined()
  expect(reviewerReport('   ', { touched: true, ready: false })).toBeUndefined()
  expect(reviewerReport(' done #1 ', { touched: true, ready: false })).toBe('done #1\nmain checkout not updated: nothing pushed')
  expect(reviewerReport('done', { touched: true, ready: true })).toBe('done\nmain checkout not updated: batch awaits /flow push')
  expect(reviewerReport('done', { touched: true, ready: false, line: 'main checkout fast-forwarded to abc' })).toBe('done\nmain checkout fast-forwarded to abc')
  // already carries the line: not duplicated
  expect(reviewerReport('done\nmain checkout fast-forwarded to abc', { touched: true, ready: false, line: 'main checkout fast-forwarded to abc' })).toBe('done\nmain checkout fast-forwarded to abc')
  expect(reviewerReport('main checkout not updated: x', { touched: true, ready: false })).toBe('main checkout not updated: x')
})

test('resolveReportTo: absent, own name and main pass through', async () => {
  const { io } = fake({ agents: [mgr('m1', 'boss', 'running')] })
  expect(await resolveReportTo(io, undefined, 'm1')).toEqual({ name: 'boss' })
  expect(await resolveReportTo(io, '  ', 'm1')).toEqual({ name: 'boss' })
  expect(await resolveReportTo(io, 42, 'm1')).toEqual({ name: 'boss' })
  expect(await resolveReportTo(io, 'boss', 'm1')).toEqual({ name: 'boss' })
  expect(await resolveReportTo(io, 'main', 'm1')).toEqual({ name: 'main' })
  // no caller, or a caller not on the roster: main
  expect(await resolveReportTo(io, undefined, undefined)).toEqual({ name: 'main' })
  expect(await resolveReportTo(io, undefined, 'ghost')).toEqual({ name: 'main' })
})

test('resolveReportTo refuses a name no agent carries, naming the caller', async () => {
  const { io } = fake({ agents: [mgr('m1', 'boss', 'running'), mgr('m2', 'other', 'running')] })
  const r = await resolveReportTo(io, 'nobody', 'm1')
  expect('refuse' in r && r.refuse).toContain('report_to "nobody" matches no agent')
  expect('refuse' in r && r.refuse).toContain('Your own name is "boss"')
})

test('resolveReportTo accepts another manager, including by continuation name, even when ended', async () => {
  const { io } = fake({ agents: [mgr('m1', 'boss', 'running'), mgr('m2', 'other-2', 'completed')] })
  expect(await resolveReportTo(io, 'other', 'm1')).toEqual({ name: 'other' })
  expect(await resolveReportTo(io, 'other-2', 'm1')).toEqual({ name: 'other-2' })
})

test('resolveReportTo corrects the caller\'s own worker to the caller, with a note', async () => {
  const { io } = fake({ agents: [mgr('m1', 'boss', 'running'), worker('w1', 'wk', 'running', 'm1'), worker('w2', 'foreign', 'running', 'm9')] })
  const r = await resolveReportTo(io, 'wk', 'm1')
  expect(r).toEqual({ name: 'boss', note: ' report_to "wk" is your own worker, so the report goes to you ("boss") instead.' })
  // someone else's worker is accepted as given
  expect(await resolveReportTo(io, 'foreign', 'm1')).toEqual({ name: 'foreign' })
  // main has no id, so it is never corrected
  expect(await resolveReportTo(io, 'wk', undefined)).toEqual({ name: 'wk' })
})

const open = (state: string, extra: object = {}) => ({ state, ...extra })

test('managerFinished is true when nothing is left for the manager', async () => {
  const { io } = fake({ agents: [mgr('m1', 'boss', 'completed')] })
  expect(await managerFinished(io, ['m1'], 'boss', [mgr('m1', 'boss', 'completed'), worker('w1', 'w', 'idle', 'm1')])).toBe(true)
})

test('managerFinished is false while a child runs or is pending, or was active after the manager', async () => {
  const { io } = fake({})
  for (const status of ['running', 'pending']) {
    expect(await managerFinished(io, ['m1'], 'boss', [worker('w1', 'w', status, 'm1')])).toBe(false)
  }
  // A running child of another parent, or a row without parentId, does not count.
  expect(await managerFinished(io, ['m1'], 'boss', [worker('w1', 'w', 'running', 'm2'), worker('w2', 'x', 'running')])).toBe(true)
  const later = fake({ activity: { m1: { lastAt: 10 }, w1: { lastAt: 20 } } })
  expect(await managerFinished(later.io, ['m1'], 'boss', [worker('w1', 'w', 'idle', 'm1')])).toBe(false)
  const earlier = fake({ activity: { m1: { lastAt: 30 }, w1: { lastAt: 20 } } })
  expect(await managerFinished(earlier.io, ['m1'], 'boss', [worker('w1', 'w', 'idle', 'm1')])).toBe(true)
  // any of several ids counts as the manager's own time
  expect(await managerFinished(earlier.io, ['m0', 'm1'], 'boss', [worker('w1', 'w', 'idle', 'm1')])).toBe(true)
})

test('managerFinished is false with an open handover for the manager or its continuations', async () => {
  for (const status of ['pending', 'awaiting', 'taken', 'returned']) {
    const { io } = fake({ handovers: { '1': { pr: 1, status: status as Handover['status'], reportTo: 'boss' } } })
    expect(await managerFinished(io, ['m1'], 'boss', [])).toBe(false)
  }
  const cont = fake({ handovers: { '1': { pr: 1, status: 'pending', reportTo: 'boss' } } })
  expect(await managerFinished(cont.io, ['m1'], 'boss-2', [])).toBe(false)
  for (const status of ['done', 'ready']) {
    const { io } = fake({ handovers: { '1': { pr: 1, status: status as Handover['status'], reportTo: 'boss' } } })
    expect(await managerFinished(io, ['m1'], 'boss', [])).toBe(true)
  }
  const other = fake({ handovers: { '1': { pr: 1, status: 'pending', reportTo: 'someone' } } })
  expect(await managerFinished(other.io, ['m1'], 'boss', [])).toBe(true)
})

test('managerFinished is false with an open plan node, true when all are done', async () => {
  const node = (state: string) => ({ id: 'n', title: '', after: [], until: 'merged', state })
  for (const state of ['waiting', 'ready', 'running']) {
    const { io } = fake({ plans: { boss: { n: node(state) } } as unknown as Plan })
    expect(await managerFinished(io, ['m1'], 'boss', [])).toBe(false)
    // a continuation reads its manager's graph
    expect(await managerFinished(io, ['m1'], 'boss-2', [])).toBe(false)
  }
  const done = fake({ plans: { boss: { n: node('done') } } as unknown as Plan })
  expect(await managerFinished(done.io, ['m1'], 'boss', [])).toBe(true)
})

test('managerFinished is false with an open blocking ask, true with a non-blocking or answered one', async () => {
  const blocking = fake({ inbox: [open('open', { blocking: true, owner: 'boss' })] })
  expect(await managerFinished(blocking.io, ['m1'], 'boss', [])).toBe(false)
  const nonBlocking = fake({ inbox: [open('open', { blocking: false, owner: 'boss' }), open('answered', { blocking: true, owner: 'boss' }), open('open', { blocking: true, owner: 'zed' })] })
  expect(await managerFinished(nonBlocking.io, ['m1'], 'boss', [])).toBe(true)
})

test('managerFinished is false when its last answer waits for the very report it gets', async () => {
  const w: W = {
    activity: { m1: { lastAt: 5, answer: 'Handed #7 over.\n\nWaiting for the reviewer to merge #7.' } },
    handovers: { '7': { pr: 7, status: 'done', reportTo: 'boss' } },
  }
  const { io } = fake(w)
  expect(await managerFinished(io, ['m1'], 'boss', [], 'merged #7')).toBe(false)
  expect(await managerFinished(io, ['m1'], 'boss', [], 'merged #8')).toBe(true)
  expect(await managerFinished(io, ['m1'], 'boss', [])).toBe(true)
  // the answer falls back to the last roster snapshot when the activity has none
  const seen = fake({ ...w, activity: {}, seen: { boss: { status: 'completed', answer: 'Waiting on #7 merge.' } } })
  expect(await managerFinished(seen.io, ['m1'], 'boss', [], 'done #7')).toBe(false)
})

test('reviewerSendGuard passes calls to main, everyone, the empty name and non-managers', async () => {
  const { io, main } = fake({ agents: [worker('w1', 'wk', 'completed'), mgr('m1', 'boss', 'completed')] })
  for (const to of ['', 'main', '*', 'w1', 'wk']) expect(await reviewerSendGuard(io, 'r1', to, 'x')).toBeUndefined()
  expect(main).toEqual([])
})

test('reviewerSendGuard lets a message to a running manager through', async () => {
  const { io, main } = fake({ agents: [mgr('m1', 'boss', 'running')] })
  expect(await reviewerSendGuard(io, 'r1', 'boss', 'done #1')).toBeUndefined()
  expect(main).toEqual([])
})

test('reviewerSendGuard refuses a send to a finished manager: notes it and tells main once', async () => {
  const { io, notes, main, fwd } = fake({ agents: [mgr('m1', 'boss', 'killed')] })
  const r = await reviewerSendGuard(io, 'r1', 'boss', 'Merged  #4 fine')
  expect(r).toContain('Not sent: boss has finished')
  expect(r).toContain('noted the report for boss')
  expect(notes).toEqual([['boss', '- 2026-10-13 progress: reviewer report: Merged #4 fine']])
  expect(main).toEqual(['Report for boss (finished), from the reviewer:\nMerged  #4 fine'])
  expect(fwd().keys['r1|boss|4']).toEqual([])
  expect(fwd().lines['r1']).toEqual(['Merged #4 fine'])
})

test('reviewerSendGuard matches an ended manager by id and by name', async () => {
  const { io, main } = fake({ agents: [mgr('m1', 'boss', 'failed')] })
  expect(await reviewerSendGuard(io, 'r1', 'm1', 'x #1')).toContain('Not sent: boss')
  expect(main).toHaveLength(1)
})

test('reviewerSendGuard does not send the same needs lines to main twice', async () => {
  const n = fake({ agents: [mgr('m1', 'boss', 'killed')] })
  await reviewerSendGuard(n.io, 'r1', 'boss', 'done #4 | needs a person: check PR #4 live')
  const dup = await reviewerSendGuard(n.io, 'r1', 'boss', 'done #4 | needs a person: check PR #4 live')
  expect(dup).toContain('already forwarded to main')
  expect(n.main).toHaveLength(1)
  // a reworded line for the same PR is not new, even under another PR-set key
  const reworded = await reviewerSendGuard(n.io, 'r1', 'boss', 'again #4 #5 | needs a person: PR #4 still needs a look')
  expect(reworded).toContain('already forwarded to main')
  expect(n.main).toHaveLength(1)
  // a different PR's line is new and only the new lines go to main
  const fresh = await reviewerSendGuard(n.io, 'r1', 'boss', 'done #6 | needs a person: check PR #6 live')
  expect(fresh).toContain('sent the new lines to main')
  expect(n.main[1]).toBe('Report for boss (finished), from the reviewer:\nneeds a person: check PR #6 live')
  // another run id starts fresh
  expect(await reviewerSendGuard(n.io, 'r2', 'boss', 'done #4 | needs a person: check PR #4 live')).toContain('sent it to main')
})

test('reviewerSendGuard reports an unknown name as no such agent, without a note', async () => {
  const { io, notes, main } = fake({})
  const r = await reviewerSendGuard(io, 'r1', 'ghost', 'hello')
  expect(r).toContain('Not sent: ghost matches no agent')
  expect(notes).toEqual([])
  expect(main).toEqual(['Report for ghost (no such agent), from the reviewer:\nhello'])
})

test('reviewerSendGuard wakes a completed manager that still has work, unless it failed or was killed', async () => {
  const w: W = { agents: [mgr('m1', 'boss', 'completed')], handovers: { '1': { pr: 1, status: 'pending', reportTo: 'boss' } } }
  const a = fake(w)
  expect(await reviewerSendGuard(a.io, 'r1', 'boss', 'merged #1')).toBeUndefined()
  // nothing left: refused
  const b = fake({ agents: [mgr('m1', 'boss', 'completed')] })
  expect(await reviewerSendGuard(b.io, 'r1', 'boss', 'merged #1')).toContain('Not sent')
  // dropped from the roster: judged from the last snapshot
  const c = fake({ seen: { boss: { status: 'completed', id: 'm1' } }, handovers: w.handovers })
  expect(await reviewerSendGuard(c.io, 'r1', 'boss', 'merged #1')).toBeUndefined()
  const d = fake({ seen: { boss: { status: 'killed', id: 'm1' } }, handovers: w.handovers })
  expect(await reviewerSendGuard(d.io, 'r1', 'boss', 'merged #1')).toContain('matches no agent')
})

test('reviewerSendGuard treats an idle manager as finished only when nothing is left', async () => {
  const idle = fake({ agents: [mgr('m1', 'boss', 'idle')] })
  const r = await reviewerSendGuard(idle.io, 'r1', 'boss', 'merged #1')
  expect(r).toContain('Not sent')
  expect(idle.main[0]).toContain('boss (finished; not woken)')
  const busy = fake({ agents: [mgr('m1', 'boss', 'idle'), worker('w1', 'w', 'running', 'm1')] })
  expect(await reviewerSendGuard(busy.io, 'r1', 'boss', 'merged #1')).toBeUndefined()
  const withHandover = fake({ agents: [mgr('m1', 'boss', 'idle')], handovers: { '2': { pr: 2, status: 'taken', reportTo: 'boss' } } })
  expect(await reviewerSendGuard(withHandover.io, 'r1', 'boss', 'merged #1')).toBeUndefined()
})

test('reviewerSendGuard caps the forwarded history', async () => {
  const keys: Record<string, string[]> = {}
  for (let i = 0; i < 450; i++) keys[`k${i}`] = []
  const { io, fwd } = fake({ agents: [mgr('m1', 'boss', 'killed')], forwarded: { keys, lines: {} } })
  await reviewerSendGuard(io, 'r1', 'boss', 'x #1')
  expect(Object.keys(fwd().keys).length).toBe(401)
  expect(Object.keys(fwd().keys).at(-1)).toBe('r1|boss|1')
})
