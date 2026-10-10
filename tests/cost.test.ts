import type { AgentInfo } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { addStep, costBlock, costOf, hitRate, humanTokens, money, normalizeLedger, prCost, priceOf, reportSuffix, ZERO } from '../hooks/cost'
import type { Ledger } from '../types'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const bucket = (b: Partial<typeof ZERO>) => ({ ...ZERO, ...b })
const near = (a: number | undefined, b: number) => expect(Math.abs((a ?? NaN) - b)).toBeLessThan(1e-9)

test('price lookup: exact ids, dated ids, [1m] and -latest drop out', () => {
  near(costOf('claude-opus-5-5', bucket({ input: 1_000_000 })), 4)
  near(costOf('claude-opus-5-5[1m]', bucket({ input: 1_000_000 })), 4)
  near(costOf('claude-sonnet-4-6-20260101', bucket({ output: 1_000_000 })), 15)
  near(costOf('claude-haiku-4-5-latest', bucket({ input: 1_000_000 })), 1)
  near(costOf('claude-opus-5-5', bucket({ read: 1_000_000 })), 0.2)
  near(costOf('claude-opus-4-8', bucket({ read: 1_000_000 })), 0.5)
  near(costOf('claude-fable-5-1', bucket({ read: 1_000_000 })), 0.25)
})

test('cache writes cost 1.25x (5m) and 2x (1h) of input', () => {
  near(costOf('claude-sonnet-4-6', bucket({ write5m: 1_000_000 })), 3.75)
  near(costOf('claude-sonnet-4-6', bucket({ write1h: 1_000_000 })), 6)
})

test('an alias or an unknown version is priced as the newest of its family; an unknown model has no price', () => {
  near(costOf('opus', bucket({ input: 1_000_000 })), 4)
  near(costOf('sonnet[1m]', bucket({ input: 1_000_000 })), 2)
  near(costOf('haiku', bucket({ input: 1_000_000 })), 0.1)
  near(costOf('claude-opus-9-9', bucket({ input: 1_000_000 })), 4)
  near(costOf('claude-opus-5-5-preview', bucket({ input: 1_000_000 })), 4)
  expect(priceOf('gpt-9')).toBeUndefined()
  expect(costOf('gpt-9', bucket({ input: 5 }))).toBeUndefined()
  expect(money(0, true)).toBe('~$?')
})

test('haiku 5.5 prompts over 100K tokens are priced per step at the long tier', () => {
  let l: Ledger = {}
  l = addStep(l, 'a', 'claude-haiku-5-5', { input_tokens: 150_000, output_tokens: 1000 })
  l = addStep(l, 'a', 'claude-haiku-5-5', { input_tokens: 50_000 })
  // 150k at 0.50 + 1k out at 2.50, then 50k at 0.10.
  near(costOf('claude-haiku-5-5', l.a!.models['claude-haiku-5-5']!), 0.075 + 0.0025 + 0.005)
  // The threshold counts the whole prompt: cache reads too.
  l = addStep({}, 'b', 'claude-haiku-5-5', { input_tokens: 10, cache_read_input_tokens: 100_000 })
  near(costOf('claude-haiku-5-5', l.b!.models['claude-haiku-5-5']!), (10 * 0.5 + 100_000 * 0.05) / 1e6)
})

test('hit rate is cache read over every prompt token', () => {
  near(hitRate(bucket({ input: 10, write5m: 10, write1h: 10, read: 70 })), 0.7)
  expect(hitRate(bucket({ output: 5 }))).toBeUndefined()
})

test('steps add up across steps and models; missing fields count as 0; the cache write splits when the usage says so', () => {
  let l: Ledger = {}
  l = addStep(l, 'w1', 'claude-sonnet-5-5', { input_tokens: 100, cache_creation_input_tokens: 40, cache_read_input_tokens: 10, output_tokens: 5 }, { role: 'worker', name: 'w' })
  l = addStep(l, 'w1', 'claude-sonnet-5-5', { input_tokens: 1, cache_creation_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 } })
  l = addStep(l, 'w1', 'claude-haiku-5-5', { output_tokens: 7 })
  l = addStep(l, 'w1', 'claude-haiku-5-5', undefined)
  l = addStep(l, 'w1', 'claude-haiku-5-5', {})
  expect(l.w1!.models['claude-sonnet-5-5']).toEqual({ input: 101, write5m: 50, write1h: 20, read: 10, output: 5 })
  expect(l.w1!.models['claude-haiku-5-5']).toEqual(bucket({ output: 7 }))
  expect(l.w1!.name).toBe('w')
})

test('a ledger read from disk drops what is not an entry', () => {
  expect(normalizeLedger({ a: { name: 'x', role: 'worker', models: {} }, b: 3, c: { name: 1 } })).toEqual({ a: { name: 'x', role: 'worker', models: {} } })
  expect(normalizeLedger('nope')).toEqual({})
})

test('totals per manager (with its workers and successors) and per PR (a -2 successor on the same branch)', () => {
  const use = { input_tokens: 1_000_000 }
  let l: Ledger = {}
  const m = 'claude-opus-5-5'
  l = addStep(l, 'm1', m, use, { role: 'manager', name: 'csv' })
  l = addStep(l, 'w1', m, use, { role: 'worker', name: 'csv-worker', manager: 'csv', branch: 'flow/csv-worker' })
  l = addStep(l, 'w2', m, use, { role: 'worker', name: 'csv-worker-2', manager: 'csv-2', branch: 'flow/csv-worker' })
  l = addStep(l, 'w3', m, use, { role: 'worker', name: 'other', manager: 'other', branch: 'flow/other' })
  l = addStep(l, 'q1', m, use, { role: 'reviewer', name: 'reviewer-1' })
  l = addStep(l, 'main', m, use)
  near(prCost(l, 'flow/csv-worker').usd, 8)
  const text = costBlock(l, [{ pr: 7, branch: 'flow/csv-worker' }], true).join('\n')
  expect(text).toContain('Cost (estimates at API list prices):')
  expect(text).toContain('manager csv total (with its workers): ~$12.00')
  expect(text).toContain('PR #7 (flow/csv-worker) workers: ~$8.00')
  expect(text).toContain('reviewer total: ~$4.00')
  expect(text).toContain('main total: ~$4.00')
  expect(text).toContain('session total: ~$24.00')
  expect(text).toContain('not counted')
  expect(costBlock({}, [], false)).toEqual([])
})

test('numbers are humanised and dollars compact', () => {
  expect(humanTokens(950)).toBe('950')
  expect(humanTokens(12_345)).toBe('12.3k')
  expect(humanTokens(1_234_567)).toBe('1.2M')
  expect(money(3.456)).toBe('~$3.46')
  expect(money(0.034)).toBe('~$0.034')
})

const PR = { state: 'OPEN', isDraft: false, headRefOid: 'abc1234def5678', headRefName: 'flow/csv-worker', title: 'Export', body: '## Verification\nRan:\n- `bun test`: pass\nExercised: ran it\nNot verified:\n- full check' }

// A manager with a worker, a reviewer; steps come from `usage`.
function world(on: On) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const agents: AgentInfo[] = [
    { id: 'm1', name: 'csv-export', description: 'm', type: 'flow:manager', status: 'running' },
    { id: 'w1', name: 'csv-worker', description: 'w', type: 'flow:worker', status: 'running', parentId: 'm1' },
    { id: 'q1', name: 'merge-queue-1', description: 'q', type: 'flow:queue', status: 'running' },
  ]
  const files = new Map<string, string>()
  const usage: { model: string; input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } = {
    model: 'claude-opus-5-5', input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
  }
  on('agent.list', () => ({ value: agents }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('fs.read', (_, e) => {
    const t = files.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('process.run', (_, e) => ({ value: { exitCode: 0, stdout: e.argv[1] === 'rev-parse' ? '/r/.git\n' : e.argv[0] === 'gh' ? JSON.stringify(PR) : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('turn.step', async function* () {
    return { turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: { ...usage } } as never
  })
  return { agents, files, usage, clock }
}

const step = async ($: Dollar, agentId?: string) => {
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'opus', messageCount: 1, agentId } as never)
  for await (const chunk of stream) void chunk
  return stream.result
}
const status = ($: Dollar) => $.tool.call({ tool: 'mcp__flow__status' } as never).then(r => String(r.result))

test('status shows the cost block; the step result passes untouched; an ended agent stays in it', async ($, on) => {
  const w = world(on)
  await step($, 'w1')
  await step($, 'w1')
  await step($, undefined)
  w.usage.model = 'claude-sonnet-4-6'
  await step($, 'm1')
  w.agents.length = 0
  const text = await status($)
  expect(text).toContain('Cost (estimates at API list prices):')
  expect(text).toContain('worker csv-worker [claude-opus-5-5]: ~$8.00')
  expect(text).toContain('manager csv-export [claude-sonnet-4-6]: ~$3.00')
  expect(text).toContain('main total: ~$4.00')
  expect(text).toContain('session total: ~$15.00')
  expect(text).toContain('manager csv-export total (with its workers): ~$11.00')
})

test('the ledger is written to the state dir', async ($, on) => {
  const w = world(on)
  await step($, 'w1')
  await w.clock.advance(3500)
  await w.clock.settle()
  // The mocked `mv` moves nothing, so the temp file next to the target is what was written.
  const saved = [...w.files].find(([k]) => k.startsWith('/r/.git/flow/ledger.json'))?.[1]
  expect(saved).toBeDefined()
  expect(JSON.parse(saved!).w1.models['claude-opus-5-5'].input).toBe(1_000_000)
})

test('the reviewer\'s done report gets the PR\'s cost once, and handover lines show it', async ($, on) => {
  const w = world(on)
  void w
  await step($, 'w1')
  const handover = await $.tool.call({ tool: 'mcp__flow__handover', pr: 7, agentId: 'm1', verified: 'v', pending: 'none', after_deploy: 'none' } as never)
  expect(String(handover.result)).not.toMatch(/^Refused/)
  expect(await status($)).toMatch(/#7 pending[^\n]*\| cost: ~\$4\.00/)
  const done = () => $.tool.call({ tool: 'mcp__flow__queue', action: 'done', pr: 7, sha: 'abc', report: 'merged', agentId: 'q1' } as never)
  await done()
  await done()
  const line = (await status($)).split('\n').find(l => l.startsWith('#7')) ?? ''
  expect(line).toContain('merged | cost: ~$4.00')
  expect(line.match(/\| cost:/g)?.length).toBe(1)
})

test('after a restart the ledger on disk is the history new steps are added to', async ($, on) => {
  const w = world(on)
  w.files.set('/r/.git/flow/ledger.json', JSON.stringify({ old: { role: 'worker', name: 'gone', branch: 'flow/gone', models: { 'claude-opus-5-5': bucket({ input: 1_000_000 }) } } }))
  await step($, 'w1')
  const text = await status($)
  expect(text).toContain('worker gone [claude-opus-5-5]: ~$4.00')
  expect(text).toContain('session total: ~$8.00')
})
