import type { AgentInfo } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { unhandedPrs } from '../hooks/register'
import type { Activity, AgentRow, Handover, OpenPr } from '../types'

const MIN = 60_000
const NOW = 100 * MIN
const pr = (n: number, branch: string, extra: Partial<OpenPr> = {}): OpenPr =>
  ({ number: n, title: `PR ${n}`, headRefName: branch, isDraft: false, url: `u${n}`, ...extra })
const agent = (id: string, name: string, status: string): AgentRow => ({ id, name, description: '', type: 'flow:worker', status })
const ended = (at: number): Activity => ({ startedAt: 0, lastAt: at, log: [], endedAt: at })
const handover = (n: number, status: Handover['status'], reason?: string): Handover =>
  ({ pr: n, title: '', head: 'h', branch: 'flow/x', reportTo: 'm', verified: '', pending: '', afterDeploy: '', status, at: 0, reason })
const numbers = (r: { pr: number }[]) => r.map(u => u.pr)

test('the rule: draft, non-flow branch, handovers', () => {
  const prs = [pr(1, 'flow/a', { isDraft: true }), pr(2, 'feature/b'), pr(3, 'flow/c'), pr(4, 'flow/d'), pr(5, 'flow/e'), pr(6, 'flow/f')]
  const hs = { 4: handover(4, 'pending'), 5: handover(5, 'done'), 6: handover(6, 'returned', 'head moved') }
  const out = unhandedPrs(prs, hs, [], {}, NOW)
  expect(numbers(out)).toEqual([3, 6])
  expect(out[0]!.note).toBe('no agent in this session')
  expect(out[1]!.note).toBe('returned: head moved')
})

test('a live worker or its continuation keeps the PR out', () => {
  const prs = [pr(1, 'flow/csv')]
  for (const status of ['pending', 'running', 'waiting', 'idle']) {
    expect(unhandedPrs(prs, {}, [agent('w', 'csv', status)], {}, NOW)).toEqual([])
  }
  const roster = [agent('w', 'csv', 'completed'), agent('w2', 'csv-2', 'running')]
  expect(unhandedPrs(prs, {}, roster, { w: ended(0) }, NOW)).toEqual([])
  // csv-export is another task, not a continuation of csv.
  expect(numbers(unhandedPrs(prs, {}, [agent('x', 'csv-export', 'running')], {}, NOW))).toEqual([1])
})

test('a worker that ended inside the grace period is not flagged yet, after it is', () => {
  const prs = [pr(1, 'flow/csv')]
  const roster = [agent('w', 'csv', 'completed')]
  expect(unhandedPrs(prs, {}, roster, { w: ended(NOW - 5 * MIN) }, NOW)).toEqual([])
  const out = unhandedPrs(prs, {}, roster, { w: ended(NOW - 30 * MIN) }, NOW)
  expect(out[0]!.note).toBe('no handover, worker csv ended 30m ago')
  expect(unhandedPrs(prs, {}, roster, { w: ended(NOW - 5 * MIN) }, NOW, MIN)).toHaveLength(1)
})

const RUN = (exitCode: number, stdout: string, stderr = '') =>
  ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
const PANE = { component: 'Pane', props: { title: 'Flow' } as never, requestId: 'flow' } as const
const hostStubs = (on: Parameters<Parameters<typeof test>[1]>[1]) => {
  on('agent.list', () => ({ value: [] as AgentInfo[] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
}

test('status lists them; a gh failure keeps the old list and says so', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  let fail = false
  hostStubs(on)
  on('process.run', () => fail ? RUN(1, '', 'gh: not logged in') : RUN(0, JSON.stringify([pr(102, 'flow/old'), pr(103, 'main-fix')])))

  const first = String((await $.tool.call({ tool: 'mcp__flow__status' } as never)).result)
  expect(first).toContain('Needs attention:')
  expect(first).toContain('#102 PR 102 (flow/old) — no agent in this session')
  expect(first).not.toContain('#103')

  fail = true
  await clock.advance(2 * MIN)
  const second = String((await $.tool.call({ tool: 'mcp__flow__status' } as never)).result)
  expect(second).toContain('#102')
  expect(second).toContain('gh: not logged in')
})

test('the pane shows one warning line while PRs are unhanded', async ($, on) => {
  mock.clock(on, { now: NOW })
  hostStubs(on)
  on('process.run', () => RUN(0, JSON.stringify([pr(102, 'flow/a'), pr(103, 'flow/b')])))
  await $.tool.call({ tool: 'mcp__flow__status' } as never)
  const ui = await $.ui.mount({ plugin: 'flow', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /2 PRs nobody handed over: #102 #103/ })).toBeDefined()
  await ui.unmount()
})

test('the pane and status say nothing when there are none', async ($, on) => {
  mock.clock(on, { now: NOW })
  hostStubs(on)
  on('process.run', () => RUN(0, '[]'))
  const text = String((await $.tool.call({ tool: 'mcp__flow__status' } as never)).result)
  expect(text).not.toContain('Needs attention')
  const ui = await $.ui.mount({ plugin: 'flow', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /nobody handed over/ })).toBeUndefined()
  await ui.unmount()
})

test('with the merge queue off nothing is flagged', { options: { merge_queue: false } }, async ($, on) => {
  mock.clock(on, { now: NOW })
  hostStubs(on)
  on('process.run', () => RUN(0, JSON.stringify([pr(102, 'flow/a')])))
  const text = String((await $.tool.call({ tool: 'mcp__flow__status' } as never)).result)
  expect(text).not.toContain('Needs attention')
  const ui = await $.ui.mount({ plugin: 'flow', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /nobody handed over/ })).toBeUndefined()
  await ui.unmount()
})
