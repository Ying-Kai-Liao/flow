import { expect } from 'claude-code/testing'
import { test } from './support'
import { lookupPrs, MAX_LOOKUPS, reconcileStale, recentPrs, resetStaleThrottle } from '../hooks/stale-handovers'
import type { StaleIo } from '../hooks/stale-handovers'
import type { Handover } from '../types'

const h = (pr: number, status: Handover['status']): Handover =>
  ({ pr, title: '', head: `head${pr}00000000`, branch: `flow/b${pr}`, reportTo: 'm', verified: '', pending: '', afterDeploy: '', status, at: pr })

function world(list: Handover[], extra: Partial<StaleIo> = {}, roster: { id: string; type: string; status: string }[] = []) {
  const db: Record<string, Handover> = Object.fromEntries(list.map(x => [String(x.pr), x]))
  const calls = { gh: 0, git: 0, now: 0, pruned: 0, views: [] as number[] }
  const io: StaleIo = {
    now: async () => calls.now,
    handovers: async () => ({ ...db }),
    agents: async () => roster,
    isAncestor: async () => { calls.git++; return false },
    mergedPrs: async () => { calls.gh++; return new Map() },
    closedPrs: async () => new Set<number>(),
    prState: async pr => { calls.views.push(pr); return 'OPEN' },
    save: async x => { db[String(x.pr)] = x },
    savePruned: async x => { calls.pruned++; db[String(x.pr)] = x },
    ...extra,
  }
  return { io, db, calls }
}

test('a merged PR becomes done with the merge commit; others stay', async () => {
  resetStaleThrottle()
  const w = world([h(1, 'pending'), h(2, 'taken'), h(3, 'pending')], { mergedPrs: async () => new Map([[1, 'abcdef1234567'], [2, '']]) }, [{ id: 'q', type: 'flow:reviewer', status: 'running' }])
  await reconcileStale(w.io)
  expect(w.db['1']).toMatchObject({ status: 'done', sha: 'abcdef12', report: 'merged elsewhere (abcdef12)' })
  expect(w.db['2']).toMatchObject({ status: 'done', sha: 'head2000', report: 'merged elsewhere (head2000)' })
  expect(w.db['3']!.status).toBe('pending')
})

test('a head that is an ancestor of the base is done without asking gh', async () => {
  resetStaleThrottle()
  const w = world([h(4, 'pending')], { isAncestor: async () => true })
  await reconcileStale(w.io)
  expect(w.db['4']).toMatchObject({ status: 'done', report: 'merged elsewhere (head4000)' })
  expect(w.calls.gh).toBe(0)
})

test('taken goes back to pending only when no reviewer is live', async () => {
  resetStaleThrottle()
  const dead = world([h(5, 'taken')], {}, [{ id: 'q', type: 'flow:reviewer', status: 'completed' }, { id: 'w', type: 'flow:worker', status: 'running' }])
  await reconcileStale(dead.io)
  expect(dead.db['5']!.status).toBe('pending')
  resetStaleThrottle()
  const alive = world([h(5, 'taken')], {}, [{ id: 'q', type: 'flow:reviewer', status: 'running' }])
  await reconcileStale(alive.io)
  expect(alive.db['5']!.status).toBe('taken')
  // Even when the caller is that reviewer: it may be mid-work on its own record.
  await reconcileStale(alive.io)
  expect(alive.db['5']!.status).toBe('taken')
})

test('ready, returned and done keep their status', async () => {
  resetStaleThrottle()
  const w = world((['ready', 'returned', 'done'] as const).map((s, i) => h(10 + i, s)), { isAncestor: async () => true })
  await reconcileStale(w.io)
  expect(Object.values(w.db).map(x => x.status)).toEqual(['ready', 'returned', 'done'])
  expect(w.calls.git).toBe(0)
  expect(w.db['11']!.pruned).toBeUndefined()
})

test('gh is called once per gap; failures leave records alone and never throw', async () => {
  resetStaleThrottle()
  const w = world([h(6, 'pending')], { mergedPrs: async () => undefined })
  await reconcileStale(w.io)
  expect(w.db['6']!.status).toBe('pending')
  w.calls.now = 30_000
  await reconcileStale(w.io)
  expect(w.calls.gh).toBe(0)
  const boom = world([h(7, 'pending')], { isAncestor: async () => { throw new Error('x') } })
  await reconcileStale(boom.io)
  expect(boom.db['7']!.status).toBe('pending')
})

test('a handover that changed meanwhile is not overwritten', async () => {
  resetStaleThrottle()
  const w = world([h(8, 'pending')], { isAncestor: async () => true })
  let reads = 0
  const base = w.io.handovers
  w.io.handovers = async () => (++reads > 1 ? { '8': { ...h(8, 'returned') } } : base())
  await reconcileStale(w.io)
  expect(w.db['8']!.status).toBe('pending')
})

test('a PR closed on GitHub returns its pending, awaiting and taken handovers; open ones stay; a merged one is done', async () => {
  resetStaleThrottle()
  const w = world([h(20, 'awaiting'), h(21, 'pending'), h(22, 'taken'), h(23, 'awaiting'), h(24, 'awaiting')], {
    closedPrs: async () => new Set([20, 21, 22, 24]),
    mergedPrs: async () => new Map([[24, 'abcdef1234567']]),
  }, [{ id: 'q', type: 'flow:reviewer', status: 'running' }])
  await reconcileStale(w.io)
  for (const n of ['20', '21', '22']) expect(w.db[n]).toMatchObject({ status: 'returned', reason: 'PR closed on GitHub' })
  expect(w.db['23']!.status).toBe('awaiting')
  expect(w.db['24']!.status).toBe('done')
})

test('a failing closed-PR lookup leaves awaiting handovers alone', async () => {
  resetStaleThrottle()
  const w = world([h(30, 'awaiting')], { closedPrs: async () => undefined })
  await reconcileStale(w.io)
  expect(w.db['30']!.status).toBe('awaiting')
  resetStaleThrottle()
  const boom = world([h(31, 'awaiting')], { closedPrs: async () => { throw new Error('x') } })
  await reconcileStale(boom.io)
  expect(boom.db['31']!.status).toBe('awaiting')
})

test('a returned handover whose PR GitHub closed or merged is marked pruned, the record kept; one whose PR is open stays', async () => {
  resetStaleThrottle()
  const w = world([h(91, 'returned'), h(181, 'returned'), h(182, 'returned'), h(200, 'returned'), h(5, 'done')], {
    closedPrs: async () => new Set([91, 181]),
    mergedPrs: async () => new Map([[182, 'abc'], [5, 'def']]),
  })
  w.calls.now = 7_000
  await reconcileStale(w.io)
  expect(w.db['91']).toMatchObject({ status: 'returned', pruned: { at: 7_000, reason: 'closed on GitHub' } })
  expect(w.db['181']!.pruned?.reason).toBe('closed on GitHub')
  expect(w.db['182']).toMatchObject({ status: 'returned', pruned: { reason: 'merged on GitHub' } })
  // Still open on GitHub: a worker may yet fix it.
  expect(w.db['200']!.pruned).toBeUndefined()
  expect(w.db['5']!.pruned).toBeUndefined()
  expect(w.calls.pruned).toBe(3)
  // Once pruned, never again: the next pass changes nothing.
  w.calls.now = 200_000
  await reconcileStale(w.io)
  expect(w.calls.pruned).toBe(3)
})

test('a gh failure prunes no returned handover', async () => {
  resetStaleThrottle()
  const w = world([h(91, 'returned')], { closedPrs: async () => undefined, mergedPrs: async () => undefined })
  await reconcileStale(w.io)
  expect(w.db['91']!.pruned).toBeUndefined()
  resetStaleThrottle()
  const boom = world([h(92, 'returned')], { closedPrs: async () => { throw new Error('x') } })
  await reconcileStale(boom.io)
  expect(boom.db['92']!.pruned).toBeUndefined()
})

test('a returned handover moved on meanwhile is not pruned', async () => {
  resetStaleThrottle()
  const w = world([h(93, 'returned')], { closedPrs: async () => new Set([93]) })
  let reads = 0
  const base = w.io.handovers
  w.io.handovers = async () => (++reads > 1 ? { '93': { ...h(93, 'pending') } } : base())
  await reconcileStale(w.io)
  expect(w.calls.pruned).toBe(0)
})

test('recentPrs: callers within the gap share one gh lookup, also while it is in flight', async () => {
  resetStaleThrottle()
  let gh = 0
  let now = 0
  const io = { now: async () => now, mergedPrs: async () => { gh++; return new Map([[1, '']]) }, closedPrs: async () => new Set([2]) }
  const [a, b] = await Promise.all([recentPrs(io), recentPrs(io)])
  expect(gh).toBe(1)
  expect(a.closed?.has(2)).toBe(true)
  expect(b.merged?.has(1)).toBe(true)
  now = 30_000
  await recentPrs(io)
  expect(gh).toBe(1)
  now = 61_000
  await recentPrs(io)
  expect(gh).toBe(2)
})

test('an old returned PR outside the recent lists is looked up on its own and pruned; an open one stays; the lists failing asks nothing', async () => {
  resetStaleThrottle()
  const w = world([h(91, 'returned'), h(181, 'returned'), h(182, 'returned'), h(240, 'returned')], {
    closedPrs: async () => new Set([240]),
    prState: async pr => { w.calls.views.push(pr); return pr === 91 ? 'CLOSED' : pr === 181 ? 'MERGED' : 'OPEN' },
  })
  await reconcileStale(w.io)
  expect(w.calls.views).toEqual([91, 181, 182])
  expect(w.db['91']!.pruned?.reason).toBe('closed on GitHub')
  expect(w.db['181']!.pruned?.reason).toBe('merged on GitHub')
  expect(w.db['182']!.pruned).toBeUndefined()
  expect(w.db['240']!.pruned?.reason).toBe('closed on GitHub')
  // Inside the gap the open answer is reused, not asked again.
  w.calls.now = 30_000
  await reconcileStale(w.io)
  expect(w.calls.views).toEqual([91, 181, 182])
  resetStaleThrottle()
  const down = world([h(91, 'returned')], { mergedPrs: async () => undefined })
  await reconcileStale(down.io)
  expect(down.calls.views).toEqual([])
})

test('a failed single-PR lookup is unknown: nothing is pruned, and it is asked again next pass', async () => {
  resetStaleThrottle()
  const w = world([h(91, 'returned'), h(92, 'returned')], {
    prState: async pr => { w.calls.views.push(pr); if (pr === 92) throw new Error('gh'); return undefined },
  })
  await reconcileStale(w.io)
  expect(w.db['91']!.pruned).toBeUndefined()
  expect(w.db['92']!.pruned).toBeUndefined()
  await reconcileStale(w.io)
  expect(w.calls.views).toEqual([91, 92, 91, 92])
})

test('lookupPrs asks at most 10 per pass, reuses answers inside the gap and asks again after it', async () => {
  resetStaleThrottle()
  let now = 0
  const asked: number[] = []
  const io = { now: async () => now, prState: async (pr: number) => { asked.push(pr); return 'CLOSED' as const } }
  const prs = Array.from({ length: 13 }, (_, i) => i + 1)
  const first = await lookupPrs(io, prs)
  expect(MAX_LOOKUPS).toBe(10)
  expect(asked).toEqual(prs.slice(0, 10))
  expect([...first.keys()]).toEqual(prs.slice(0, 10))
  // The next pass: the 10 known come from memory, the 3 left are asked.
  now = 20_000
  const second = await lookupPrs(io, prs)
  expect(asked.length).toBe(13)
  expect(second.size).toBe(13)
  now = 90_000
  await lookupPrs(io, [1])
  expect(asked.length).toBe(14)
})
