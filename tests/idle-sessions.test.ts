import { expect } from 'claude-code/testing'
import type { Handover, Session } from '../types'
import { mirror } from '../hooks/core'
import { ENDED_SHOWN_MS, IDLE_GRACE_MS, idleSessions, parsePrStates, quietSince } from '../hooks/idle-sessions'
import type { IdleInputs, PrState } from '../hooks/idle-sessions'
import { EMPTY_BREAKER } from '../hooks/reviewer-breaker'
import { startQueue } from '../hooks/reviewer-run'
import type { QueueIo } from '../hooks/reviewer-run'
import { sessionLive } from '../hooks/sessions'
import { listSessions } from '../hooks/session-run'
import { test } from './support'

// Which finished terminal sessions the occasional sweep stops (idle-sessions.ts), rule by rule.

const NOW = 100_000_000
const OLD = NOW - IDLE_GRACE_MS - 1

const sess = (name: string, o: Partial<Session> = {}): Session => ({
  name, harness: 'claude', host: 'tmux', handle: `flow-${name}`, worktree: `/w/${name}`, branch: `flow/${name}`,
  promptFile: `/s/${name}/prompt.md`, reportFile: `/s/${name}/report.md`, start: 'claude', owner: 'main', ownerName: 'main',
  status: 'reported', startedAt: 1, reportAt: OLD, ...o,
})
const pr = (number: number, branch: string, state: string): PrState => ({ number, headRefName: branch, state })
const ho = (pr: number, branch: string, status: string, reportTo = 'm1'): Handover => ({ pr, branch, status, reportTo } as unknown as Handover)

function inputs(sessions: Session[], o: Partial<IdleInputs> = {}): IdleInputs {
  return { sessions, owned: new Set(sessions.map(s => s.name)), handovers: [], prs: [], asking: [], plans: {}, agents: [], now: NOW, ...o }
}
const names = (i: IdleInputs) => idleSessions(i).map(x => x.name)

test('a reported or exited worker whose PR merged or closed is stopped, with the PR as the reason', async () => {
  const a = sess('a')
  const b = sess('b', { status: 'exited', reportAt: undefined, endedAt: OLD })
  const r = idleSessions(inputs([a, b], { prs: [pr(1, 'flow/a', 'MERGED'), pr(2, 'flow/b', 'CLOSED')] }))
  expect(r).toEqual([{ name: 'a', reason: 'PR #1 merged' }, { name: 'b', reason: 'PR #2 closed' }])
})

test('a worker is kept with no PR, an open PR, a queued handover, an open ask, or while running or idle', async () => {
  const merged = [pr(1, 'flow/a', 'MERGED')]
  expect(names(inputs([sess('a')], { prs: [] }))).toEqual([])
  expect(names(inputs([sess('a')], { prs: [pr(1, 'flow/a', 'CLOSED'), pr(2, 'flow/a', 'OPEN')] }))).toEqual([])
  expect(names(inputs([sess('a', { status: 'exited', endedAt: OLD })], { prs: [pr(2, 'flow/a', 'OPEN')] }))).toEqual([])
  expect(names(inputs([sess('a')], { prs: merged, handovers: [ho(1, 'flow/a', 'pending')] }))).toEqual([])
  expect(names(inputs([sess('a')], { prs: merged, handovers: [ho(1, 'flow/a', 'taken')] }))).toEqual([])
  expect(names(inputs([sess('a')], { prs: merged, handovers: [ho(1, 'flow/a', 'awaiting')] }))).toEqual([])
  expect(names(inputs([sess('a')], { prs: merged, handovers: [ho(1, 'flow/a', 'ready')] }))).toEqual([])
  expect(names(inputs([sess('a')], { prs: merged, asking: ['a'] }))).toEqual([])
  expect(names(inputs([sess('a', { status: 'running' })], { prs: merged }))).toEqual([])
  expect(names(inputs([sess('a', { status: 'idle', screenAt: OLD })], { prs: merged }))).toEqual([])
  // A done handover does not hold it.
  expect(names(inputs([sess('a')], { prs: merged, handovers: [ho(1, 'flow/a', 'done')] }))).toEqual(['a'])
})

test('a worker matches its PR by exact branch: a -N continuation\'s merged PR is not its own', async () => {
  expect(names(inputs([sess('a')], { prs: [pr(1, 'flow/a-2', 'MERGED')] }))).toEqual([])
})

test('gh unknown: no worker stops; a manager still stops when nothing else holds it', async () => {
  const w = sess('a', { ownerName: 'm1' })
  const m = sess('m1', { role: 'manager', branch: 'main' })
  expect(names(inputs([w, m], { prs: undefined }))).toEqual([])
  expect(names(inputs([sess('w', { ownerName: 'm1', status: 'stopped', endedAt: OLD }), m], { prs: undefined }))).toEqual(['m1'])
})

test('the grace period: a report or end younger than IDLE_GRACE_MS waits; old records fall back', async () => {
  const merged = [pr(1, 'flow/a', 'MERGED')]
  expect(names(inputs([sess('a', { reportAt: NOW - IDLE_GRACE_MS + 1000 })], { prs: merged }))).toEqual([])
  expect(names(inputs([sess('a', { reportAt: NOW - IDLE_GRACE_MS })], { prs: merged }))).toEqual(['a'])
  // Reported without reportAt: unknown, kept.
  expect(names(inputs([sess('a', { reportAt: undefined })], { prs: merged }))).toEqual([])
  // Exited without endedAt: checkedAt, then startedAt.
  expect(quietSince(sess('a', { status: 'exited', endedAt: undefined, checkedAt: 7 }))).toBe(7)
  expect(quietSince(sess('a', { status: 'exited', endedAt: undefined, checkedAt: undefined, startedAt: 3 }))).toBe(3)
  expect(names(inputs([sess('a', { status: 'exited', reportAt: undefined, checkedAt: NOW - 1000 })], { prs: merged }))).toEqual([])
})

test('only sessions this main owns are stopped', async () => {
  const merged = [pr(1, 'flow/a', 'MERGED')]
  expect(names(inputs([sess('a')], { prs: merged, owned: new Set() }))).toEqual([])
})

test('a reported manager with nothing left open is stopped', async () => {
  const m = sess('m1', { role: 'manager', branch: 'main' })
  expect(idleSessions(inputs([m]))).toEqual([{ name: 'm1', reason: 'manager reported, nothing left open' }])
})

test('a manager running or idle is never stopped', async () => {
  expect(names(inputs([sess('m1', { role: 'manager', status: 'running' })]))).toEqual([])
  expect(names(inputs([sess('m1', { role: 'manager', status: 'idle', screenAt: OLD })]))).toEqual([])
})

test('a manager is kept while it owns a live worker session or a live agent', async () => {
  const m = sess('m1', { role: 'manager', branch: 'main' })
  expect(names(inputs([m, sess('w', { ownerName: 'm1', status: 'running' })]))).toEqual([])
  expect(names(inputs([m, sess('w', { owner: 'session:m1', ownerName: 'x', status: 'idle' })]))).toEqual([])
  expect(names(inputs([m], { agents: [{ id: 'a1', name: 'w', status: 'running', parentId: 'session:m1' }] }))).toEqual([])
  expect(names(inputs([m], { agents: [{ id: 'a1', name: 'w', status: 'completed', parentId: 'session:m1' }] }))).toEqual(['m1'])
})

test('a manager whose last worker stops in the same pass stops with it', async () => {
  const m = sess('m1', { role: 'manager', branch: 'main' })
  const w = sess('w', { ownerName: 'm1' })
  expect(names(inputs([m, w], { prs: [pr(1, 'flow/w', 'MERGED')] }))).toEqual(['w', 'm1'])
  // The worker another main owns is not stopped here, so the manager waits too.
  expect(names(inputs([m, w], { prs: [pr(1, 'flow/w', 'MERGED')], owned: new Set(['m1']) }))).toEqual([])
})

test('a manager is kept with a queued handover of its own or its workers\', an open PR of a worker, an ask, or an open plan node', async () => {
  const m = sess('m1', { role: 'manager', branch: 'main' })
  const w = sess('w', { ownerName: 'm1', status: 'stopped', endedAt: OLD })
  const base = [m, w]
  expect(names(inputs(base, { handovers: [ho(1, 'flow/x', 'pending', 'm1')] }))).toEqual([])
  expect(names(inputs(base, { handovers: [ho(1, 'flow/x', 'taken', 'm1-2')] }))).toEqual([])
  expect(names(inputs(base, { handovers: [ho(1, 'flow/x', 'awaiting', 'm1')] }))).toEqual([])
  expect(names(inputs(base, { handovers: [ho(1, 'flow/x', 'ready', 'm1')] }))).toEqual([])
  expect(names(inputs(base, { handovers: [ho(1, 'flow/x', 'returned', 'm1')] }))).toEqual(['m1'])
  expect(names(inputs(base, { handovers: [ho(1, 'flow/w', 'pending', 'other')] }))).toEqual([])
  expect(names(inputs(base, { handovers: [ho(1, 'flow/x', 'pending', 'w')] }))).toEqual([])
  expect(names(inputs(base, { handovers: [ho(1, 'flow/x', 'pending', 'other')] }))).toEqual(['m1'])
  expect(names(inputs(base, { prs: [pr(1, 'flow/w', 'OPEN')] }))).toEqual([])
  expect(names(inputs(base, { asking: ['m1'] }))).toEqual([])
  expect(names(inputs(base, { asking: ['w'] }))).toEqual([])
  for (const state of ['waiting', 'ready', 'running'] as const) {
    expect(names(inputs(base, { plans: { m1: { n: { id: 'n', title: 'n', after: [], until: 'merged', state } } } }))).toEqual([])
  }
  expect(names(inputs(base, { plans: { m1: { n: { id: 'n', title: 'n', after: [], until: 'merged', state: 'done' } } } }))).toEqual(['m1'])
})

test('a reviewer reported or idle with nothing queued is stopped; a pending, awaiting, taken or ready handover keeps it', async () => {
  const r = sess('reviewer-3', { role: 'reviewer', branch: '(detached origin/main)', status: 'idle', reportAt: undefined, screenAt: OLD })
  expect(idleSessions(inputs([r]))).toEqual([{ name: 'reviewer-3', reason: 'reviewer waiting, no handover queued' }])
  expect(names(inputs([{ ...r, status: 'reported', reportAt: OLD }]))).toEqual(['reviewer-3'])
  expect(names(inputs([r], { handovers: [ho(1, 'flow/x', 'pending')] }))).toEqual([])
  expect(names(inputs([r], { handovers: [ho(1, 'flow/x', 'taken')] }))).toEqual([])
  // An approval or a batch waiting for /flow push keeps it too; done and returned do not.
  expect(names(inputs([r], { handovers: [ho(1, 'flow/x', 'awaiting')] }))).toEqual([])
  expect(names(inputs([r], { handovers: [ho(1, 'flow/x', 'ready')] }))).toEqual([])
  expect(names(inputs([r], { handovers: [ho(1, 'flow/x', 'done'), ho(2, 'flow/y', 'returned')] }))).toEqual(['reviewer-3'])
  expect(names(inputs([{ ...r, status: 'running' }]))).toEqual([])
  // Idle only just now: the grace counts from its last screen change.
  expect(names(inputs([{ ...r, screenAt: NOW - 1000 }]))).toEqual([])
})

test('a stopped session is never picked again', async () => {
  expect(names(inputs([sess('a', { status: 'stopped', endedAt: OLD })], { prs: [pr(1, 'flow/a', 'MERGED')] }))).toEqual([])
})

test('parsePrStates reads gh\'s list and refuses anything else', async () => {
  expect(parsePrStates('[{"number":1,"headRefName":"flow/a","state":"MERGED"},{"x":1}]')).toEqual([pr(1, 'flow/a', 'MERGED')])
  expect(parsePrStates('')).toEqual([])
  expect(parsePrStates('{}')).toBeUndefined()
  expect(parsePrStates('nope')).toBeUndefined()
})

test('session list: live sessions in full, recently ended ones short, older ended ones as a count', async () => {
  const out = listSessions([
    sess('live', { status: 'running', startedAt: 5 }),
    sess('recent', { status: 'stopped', endedAt: NOW - 2 * 3600_000 }),
    sess('old1', { status: 'exited', endedAt: NOW - ENDED_SHOWN_MS - 1 }),
    sess('old2', { status: 'stopped', endedAt: undefined, checkedAt: undefined, startedAt: 1 }),
  ], NOW)
  const lines = out.split('\n')
  expect(lines[0]).toContain('live: claude in tmux')
  expect(lines[0]).toContain('owner main')
  expect(lines[1]).toBe('recent: stopped, ended 2h0m ago')
  expect(lines[2]).toBe('and 2 older ended sessions')
  expect(lines).toHaveLength(3)
  expect(listSessions([], NOW)).toBe('No sessions.')
})

test('after a reviewer session is stopped, a new handover starts a fresh reviewer and types into nothing', async () => {
  mirror.deployInfos = []
  // The reviewer session as register.tsx finds it: the live one on record.
  let rev = sess('reviewer-1', { role: 'reviewer', status: 'stopped', endedAt: OLD })
  const typed: string[] = []
  const spawned: string[] = []
  let breaker = EMPTY_BREAKER
  const handovers: Record<string, Handover> = { 9: { ...ho(9, 'flow/x', 'pending'), at: 1, head: 'abc' } }
  const io: QueueIo = {
    agents: async () => [],
    batch: async () => undefined,
    handovers: async () => handovers,
    deploys: async () => ({ targets: {} }) as never,
    runs: async () => 1,
    setRuns: async () => undefined,
    spawn: async input => { spawned.push(input.name); return { terminal: true } },
    reviewerSession: async () => (sessionLive(rev) ? rev : undefined),
    nudge: async (_s, text) => { typed.push(text); return undefined },
    setTold: async () => undefined,
    breaker: {
      stateDir: async () => undefined, readJson: async () => undefined, writeJson: async () => undefined, mkdir: async () => undefined,
      get: async () => breaker, set: async b => { breaker = b }, now: async () => NOW,
      withInbox: async fn => fn({ items: [] } as never).out, toast: () => undefined,
    },
    wait: () => undefined,
  }
  expect(await startQueue(io, 'other')).toBe('Started reviewer reviewer-2.')
  expect(spawned).toEqual(['reviewer-2'])
  expect(typed).toEqual([])
  // While it was live, the same handover was typed into it instead.
  rev = { ...rev, status: 'idle' }
  spawned.length = 0
  await startQueue(io, 'other')
  expect(typed).toHaveLength(1)
  expect(spawned).toEqual([])
})
