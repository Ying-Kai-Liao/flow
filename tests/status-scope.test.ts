import type { AgentInfo } from 'claude-code'
import { expect, mock } from 'claude-code/testing'
import { timedTest as test } from './support'
import type { TestBody } from 'claude-code/testing'

import { fill, SESSION_PROMPT, WORKER_PROMPT } from '../hooks/prompts'
import type { Settings } from '../hooks/prompts'
import { cappedHandovers } from '../hooks/status-run'
import type { Handover } from '../types'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]
const DIR = '/r/.git/flow'

const handover = (pr: number, reportTo: string, status: Handover['status'], at: number, extra: Partial<Handover> = {}): Handover =>
  ({ pr, title: `Title ${pr}`, head: `head${pr}000000`, branch: `flow/b${pr}`, reportTo, verified: '', pending: 'none', afterDeploy: 'none', status, at, ...extra }) as Handover

// gh: the stdout for a `gh pr list` call (by its --state), else gh prints nothing (an unreadable answer: a failure).
function world(on: On, hs: Handover[], onTool?: (e: unknown) => void, gh: Record<string, string> = {}) {
  mock.clock(on, { now: 1_000_000 })
  const agents: AgentInfo[] = [
    { id: 'm1', name: 'csv-export', description: 'm', type: 'flow:manager', status: 'running' },
    { id: 'w1', name: 'csv-worker', description: 'w', type: 'flow:worker', status: 'running', parentId: 'm1' },
    { id: 'm2', name: 'other-task', description: 'm', type: 'flow:manager', status: 'running' },
    { id: 'w2', name: 'other-worker', description: 'w', type: 'flow:worker', status: 'running', parentId: 'm2' },
    { id: 'q1', name: 'reviewer-1', description: 'q', type: 'flow:reviewer', status: 'running' },
  ]
  const files = new Map<string, string>()
  for (const h of hs) files.set(`${DIR}/handovers/${h.pr}.json`, JSON.stringify(h))
  on('agent.list', () => ({ value: agents }))
  on('session.usage', () => ({ value: { startedAt: 900_000, rateLimits: [], context: { window: 200_000, tokens: undefined, percent: undefined } } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.exists', (_, e) => ({ value: files.has((e as unknown as { path: string }).path) }))
  on('fs.stat', () => { throw new Error('ENOENT') })
  on('session.start', () => ({ cwd: '/r' }))
  on('command.register', () => ({ value: undefined } as never))
  on('tool.register', (_, e) => { onTool?.(e); return { value: undefined } as never })
  on('agent.register', (_, e) => ({ value: { agent: (e as unknown as { name: string }).name } }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('fs.list', (_, e) => ({ value: [...files.keys()].filter(k => k.startsWith(`${e.path}/`)).map(k => ({ name: k.slice(e.path.length + 1), isDirectory: false })) }) as never)
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('fs.read', (_, e) => {
    const t = files.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('process.run', (_, e) => {
    const state = e.argv[0] === 'gh' && e.argv[1] === 'pr' && e.argv[2] === 'list' ? e.argv[e.argv.indexOf('--state') + 1] ?? '' : ''
    return { value: { exitCode: 0, stdout: e.argv[1] === 'rev-parse' ? '/r/.git\n' : gh[state] ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { agents, files }
}

const start = ($: Dollar) => ($ as never as { session: { start: (e: unknown) => Promise<unknown> } }).session.start({ cwd: '/r', surface: null, isInteractive: false })
const status = ($: Dollar, extra: Record<string, unknown> = {}) => $.tool.call({ tool: 'mcp__flow__status', ...extra } as never).then(r => String(r.result))

// Ten finished PRs (the newest are 10 and 9), one open PR per manager.
const FIXTURE = [
  ...Array.from({ length: 10 }, (_, i) => handover(i + 1, i % 2 === 0 ? 'csv-export' : 'other-task', 'done', 100 + i, { sha: 'abc', report: `merged ${'x'.repeat(400)}` })),
  handover(20, 'csv-export', 'pending', 500),
  handover(21, 'other-task', 'returned', 501, { reason: 'fix it' }),
]

test('main and the reviewer see everything; finished PRs are capped to the newest 5 with a count and clipped lines', async ($, on) => {
  world(on, FIXTURE)
  await start($)
  for (const text of [await status($), await status($, { agentId: 'q1' })]) {
    expect(text).toContain('csv-worker')
    expect(text).toContain('other-worker')
    expect(text).toContain('#20 pending')
    expect(text).toContain('#21 returned')
    for (const n of [10, 9, 8, 7, 6]) expect(text).toContain(`#${n} done`)
    for (const n of [5, 4, 3, 2, 1]) expect(text).not.toContain(`#${n} done`)
    expect(text).toContain('+5 earlier finished PRs (mcp__flow__status pr:<n> for one)')
    expect(text).not.toContain('x'.repeat(200))
    // Only the report is clipped: the title stays.
    expect(text).toContain('— Title 10')
  }
})

test('a successor manager sees workers parented to its predecessor', async ($, on) => {
  const { agents } = world(on, FIXTURE)
  agents.push({ id: 'm1b', name: 'csv-export-2', description: 'm', type: 'flow:manager', status: 'running' })
  await start($)
  const text = await status($, { agentId: 'm1b' })
  expect(text).toContain('csv-worker')
  expect(text).not.toContain('other-worker')
})

test('pr:<n> on a capped old PR still gives its full handover line', async ($, on) => {
  world(on, FIXTURE)
  await start($)
  const text = await status($, { pr: 1 })
  expect(text).toContain('#1 done')
  expect(text).toContain('x'.repeat(400))
  expect(text).toContain('Owner of PR #1')
})

test('a manager sees its own subtree and its own PRs only', async ($, on) => {
  world(on, FIXTURE)
  await start($)
  const text = await status($, { agentId: 'm1' })
  expect(text).toContain('csv-worker')
  expect(text).not.toContain('other-worker')
  expect(text).not.toContain('other-task')
  expect(text).toContain('#20 pending')
  expect(text).not.toContain('#21')
  expect(text).not.toContain('State:')
})

test('a worker sees itself and its manager, with no handovers', async ($, on) => {
  world(on, FIXTURE)
  await start($)
  const text = await status($, { agentId: 'w1' })
  expect(text).toContain('csv-worker')
  expect(text).toContain('csv-export')
  expect(text).not.toContain('other-worker')
  expect(text).not.toContain('Handed-over PRs')
  expect(text).not.toContain('#20')
})

test('old handovers with fields missing still render', async ($, on) => {
  const old = { pr: 3, title: 'Old', branch: 'flow/old', head: 'abcdef012345', reportTo: 'csv-export', status: 'done', at: 1 } as unknown as Handover
  const bare = { pr: 4, title: 'Bare', branch: 'flow/bare', head: 'abcdef012345', reportTo: 'csv-export', status: 'returned', at: 2 } as unknown as Handover
  world(on, [old, bare])
  await start($)
  const text = await status($)
  expect(text).toContain('#3 done')
  expect(text).toContain('#4 returned')
  expect(cappedHandovers([old, bare]).hidden).toBe(0)
})

test('pruned handovers leave the list for one summary line; pr:<n> still shows one in full; a manager sees only its own', async ($, on) => {
  world(on, [
    ...FIXTURE,
    handover(91, 'other-task', 'returned', 600, { reason: 'fix it', pruned: { at: 1, reason: 'closed on GitHub' } }),
    handover(181, 'csv-export', 'returned', 601, { reason: 'tests', pruned: { at: 1, reason: 'closed on GitHub' } }),
    handover(182, 'csv-export', 'returned', 602, { reason: 'tests', pruned: { at: 1, reason: 'merged on GitHub' } }),
  ])
  await start($)
  const all = await status($)
  expect(all).toContain('Pruned handovers: #91, #181 (closed on GitHub), #182 (merged on GitHub)')
  expect(all).not.toContain('#91 returned')
  expect(all).toContain('#21 returned')
  const mine = await status($, { agentId: 'm1' })
  expect(mine).toContain('Pruned handovers: #181 (closed on GitHub), #182 (merged on GitHub)')
  expect(mine).not.toContain('#91')
  expect(await status($, { agentId: 'w1' })).not.toContain('Pruned handovers')
  expect(await status($, { pr: 91 })).toContain('#91 returned (flow/b91 @ head9100, from other-task) returned: fix it; pruned, the PR is closed on GitHub')
})

test('status prunes a returned handover whose PR GitHub closed; one still open stays in the list', async ($, on) => {
  world(on, [handover(91, 'csv-export', 'returned', 1, { reason: 'fix it' }), handover(92, 'csv-export', 'returned', 2, { reason: 'fix it' })], undefined,
    { closed: JSON.stringify([{ number: 91 }]), merged: '[]' })
  await start($)
  const text = await status($)
  expect(text).toContain('Pruned handovers: #91 (closed on GitHub)')
  expect(text).toContain('#92 returned')
  expect(await status($, { pr: 91 })).toContain('returned: fix it; pruned, the PR is closed on GitHub')
  expect(await status($, { pr: 92 })).not.toContain('pruned')
})

test('the main-only standing and push tools and the old-name queue are deferred; status, ask, reviewer and check stay loaded', async ($, on) => {
  const seen = new Map<string, boolean>()
  world(on, [], e => {
    const t = e as { name: string; isDeferred?: boolean }
    seen.set(t.name, t.isDeferred === true)
  })
  await start($)
  expect(seen.get('standing')).toBe(true)
  expect(seen.get('push')).toBe(true)
  expect(seen.get('queue')).toBe(true)
  for (const name of ['status', 'ask', 'reviewer', 'check']) expect(seen.get(name)).toBe(false)
})

test('cappedHandovers keeps every open handover and only caps the finished ones', () => {
  const list = [handover(1, 'a', 'pending', 1), ...Array.from({ length: 8 }, (_, i) => handover(i + 2, 'a', 'done', i + 2)), handover(10, 'a', 'returned', 3)]
  const { shown, hidden } = cappedHandovers(list)
  expect(hidden).toBe(3)
  expect(shown.filter(h => h.status !== 'done').map(h => h.pr)).toEqual([1, 10])
  expect(shown.filter(h => h.status === 'done').map(h => h.pr).sort((a, b) => a - b)).toEqual([5, 6, 7, 8, 9])
})

test('the session prompt puts the shared worker rules first and the per-session values after', () => {
  expect(SESSION_PROMPT.startsWith(WORKER_PROMPT)).toBe(true)
  for (const slot of ['{{HARNESS}}', '{{OWNER}}', '{{NAME}}', '{{BRANCH}}', '{{REPORT}}']) expect(SESSION_PROMPT.indexOf(slot)).toBeGreaterThan(WORKER_PROMPT.length)
  expect(SESSION_PROMPT.trimEnd().endsWith('# Your brief')).toBe(true)
  const settings = { base: 'main', testCommand: '', fullCheck: '', deployCommand: '', deployTargets: [], stateFile: undefined, mergeMethod: 'merge', mergeMode: 'auto', useReviewer: true, maxWorkers: 3, testSlots: 1, workerModel: 'sonnet', managerModel: 'opus', reviewerModel: 'opus', language: 'English', bigFiles: [], bigFileLines: 1500, migrationsDir: '', decisionPhrases: [], workerChecks: [], alwaysTests: [] } as Settings
  const shared = fill(WORKER_PROMPT, settings)
  expect(fill(SESSION_PROMPT, settings).startsWith(shared)).toBe(true)
})

