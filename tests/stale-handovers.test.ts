import { expect } from 'claude-code/testing'
import { test } from './support'
import { reconcileStale, resetStaleThrottle } from '../hooks/stale-handovers'
import type { StaleIo } from '../hooks/stale-handovers'
import type { Handover } from '../types'

const h = (pr: number, status: Handover['status']): Handover =>
  ({ pr, title: '', head: `head${pr}00000000`, branch: `flow/b${pr}`, reportTo: 'm', verified: '', pending: '', afterDeploy: '', status, at: pr })

function world(list: Handover[], extra: Partial<StaleIo> = {}, roster: { id: string; type: string; status: string }[] = []) {
  const db: Record<string, Handover> = Object.fromEntries(list.map(x => [String(x.pr), x]))
  const calls = { gh: 0, git: 0, now: 0 }
  const io: StaleIo = {
    now: async () => calls.now,
    handovers: async () => ({ ...db }),
    agents: async () => roster,
    isAncestor: async () => { calls.git++; return false },
    mergedPrs: async () => { calls.gh++; return new Map() },
    save: async x => { db[String(x.pr)] = x },
    ...extra,
  }
  return { io, db, calls }
}

test('a merged PR becomes done with the merge commit; others stay', async () => {
  resetStaleThrottle()
  const w = world([h(1, 'pending'), h(2, 'taken'), h(3, 'pending')], { mergedPrs: async () => new Map([[1, 'abcdef1234567'], [2, '']]) }, [{ id: 'q', type: 'flow:reviewer', status: 'running' }])
  await reconcileStale(w.io, undefined)
  expect(w.db['1']).toMatchObject({ status: 'done', sha: 'abcdef12', report: 'merged elsewhere (abcdef12)' })
  expect(w.db['2']).toMatchObject({ status: 'done', sha: 'head2000', report: 'merged elsewhere (head2000)' })
  expect(w.db['3']!.status).toBe('pending')
})

test('a head that is an ancestor of the base is done without asking gh', async () => {
  resetStaleThrottle()
  const w = world([h(4, 'pending')], { isAncestor: async () => true })
  await reconcileStale(w.io, undefined)
  expect(w.db['4']).toMatchObject({ status: 'done', report: 'merged elsewhere (head4000)' })
  expect(w.calls.gh).toBe(0)
})

test('taken goes back to pending only when no other live reviewer exists', async () => {
  resetStaleThrottle()
  const dead = world([h(5, 'taken')], {}, [{ id: 'q', type: 'flow:reviewer', status: 'completed' }, { id: 'w', type: 'flow:worker', status: 'running' }])
  await reconcileStale(dead.io, undefined)
  expect(dead.db['5']!.status).toBe('pending')
  resetStaleThrottle()
  const alive = world([h(5, 'taken')], {}, [{ id: 'q', type: 'flow:reviewer', status: 'running' }])
  await reconcileStale(alive.io, undefined)
  expect(alive.db['5']!.status).toBe('taken')
  // The caller itself is the only live reviewer: the old record is not its own work.
  await reconcileStale(alive.io, 'q')
  expect(alive.db['5']!.status).toBe('pending')
})

test('awaiting, ready, returned and done are never touched', async () => {
  resetStaleThrottle()
  const w = world((['awaiting', 'ready', 'returned', 'done'] as const).map((s, i) => h(10 + i, s)), { isAncestor: async () => true })
  await reconcileStale(w.io, undefined)
  expect(Object.values(w.db).map(x => x.status)).toEqual(['awaiting', 'ready', 'returned', 'done'])
  expect(w.calls.git).toBe(0)
})

test('gh is called once per gap; failures leave records alone and never throw', async () => {
  resetStaleThrottle()
  const w = world([h(6, 'pending')], { mergedPrs: async () => undefined })
  await reconcileStale(w.io, undefined)
  expect(w.db['6']!.status).toBe('pending')
  w.calls.now = 30_000
  await reconcileStale(w.io, undefined)
  expect(w.calls.gh).toBe(0)
  const boom = world([h(7, 'pending')], { isAncestor: async () => { throw new Error('x') } })
  await reconcileStale(boom.io, undefined)
  expect(boom.db['7']!.status).toBe('pending')
})

test('a handover that changed meanwhile is not overwritten', async () => {
  resetStaleThrottle()
  const w = world([h(8, 'pending')], { isAncestor: async () => true })
  let reads = 0
  const base = w.io.handovers
  w.io.handovers = async () => (++reads > 1 ? { '8': { ...h(8, 'returned') } } : base())
  await reconcileStale(w.io, undefined)
  expect(w.db['8']!.status).toBe('pending')
})
