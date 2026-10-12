import type { AgentInfo } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { addStep, addTurn, epochOf, costBlock, costOf, hitRate, humanTokens, mergeLedgers, money, normalizeLedger, pruneLedger, prCost, priceOf, reportSuffix, ZERO } from '../hooks/cost'
import type { Ledger } from '../types'
import { changeLedger, forgetLedgerLoad, loadLedger, saveLedger } from '../hooks/cost-run'
import type { CostIo } from '../hooks/cost-run'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

// Steps counted at t=1_000_000 unless a test says otherwise.
const add = (l: Ledger, key: string, model: string, usage: unknown, who?: Parameters<typeof addStep>[4], now = 1_000_000) => addStep(l, key, model, usage, who, now)
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
  l = add(l, 'a', 'claude-haiku-5-5', { input_tokens: 150_000, output_tokens: 1000 })
  l = add(l, 'a', 'claude-haiku-5-5', { input_tokens: 50_000 })
  // 150k at 0.50 + 1k out at 2.50, then 50k at 0.10.
  near(costOf('claude-haiku-5-5', l.a!.models['claude-haiku-5-5']!), 0.075 + 0.0025 + 0.005)
  // The threshold counts the whole prompt: cache reads too.
  l = add({}, 'b', 'claude-haiku-5-5', { input_tokens: 10, cache_read_input_tokens: 100_000 })
  near(costOf('claude-haiku-5-5', l.b!.models['claude-haiku-5-5']!), (10 * 0.5 + 100_000 * 0.05) / 1e6)
})

test('hit rate is cache read over every prompt token', () => {
  near(hitRate(bucket({ input: 10, write5m: 10, write1h: 10, read: 70 })), 0.7)
  expect(hitRate(bucket({ output: 5 }))).toBeUndefined()
})

test('steps add up across steps and models; missing fields count as 0; the cache write splits when the usage says so', () => {
  let l: Ledger = {}
  l = add(l, 'w1', 'claude-sonnet-5-5', { input_tokens: 100, cache_creation_input_tokens: 40, cache_read_input_tokens: 10, output_tokens: 5 }, { role: 'worker', name: 'w' })
  l = add(l, 'w1', 'claude-sonnet-5-5', { input_tokens: 1, cache_creation_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 } })
  l = add(l, 'w1', 'claude-haiku-5-5', { output_tokens: 7 })
  l = add(l, 'w1', 'claude-haiku-5-5', undefined)
  l = add(l, 'w1', 'claude-haiku-5-5', {})
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
  l = add(l, 'm1', m, use, { role: 'manager', name: 'csv' })
  l = add(l, 'w1', m, use, { role: 'worker', name: 'csv-worker', manager: 'csv', branch: 'flow/csv-worker' })
  l = add(l, 'w2', m, use, { role: 'worker', name: 'csv-worker-2', manager: 'csv-2', branch: 'flow/csv-worker' })
  l = add(l, 'w3', m, use, { role: 'worker', name: 'other', manager: 'other', branch: 'flow/other' })
  l = add(l, 'q1', m, use, { role: 'reviewer', name: 'reviewer-1' })
  l = add(l, 'main@1', m, use)
  near(prCost(l, 'flow/csv-worker').usd, 8)
  const text = costBlock(l, [{ pr: 7, branch: 'flow/csv-worker' }], true, { start: 0, live: new Set() }).join('\n')
  expect(text).toContain('Cost (estimates at API list prices):')
  expect(text).toContain('manager csv total (with its workers): ~$12.00')
  expect(text).toContain('PR #7 (flow/csv-worker) workers: ~$8.00')
  expect(text).toContain('reviewer total: ~$4.00')
  expect(text).toContain('main total: ~$4.00')
  expect(text).toContain('session total: ~$24.00')
  expect(text).toContain('not counted')
  expect(costBlock({}, [], false, { start: 0, live: new Set() })).toEqual([])
})

test('the block lists this session only; the all-time line counts both; a live agent stays in', () => {
  const m = 'claude-opus-5-5'
  const use = { input_tokens: 1_000_000 }
  const day = 24 * 3600 * 1000
  let l: Ledger = {}
  l = add(l, 'main@100', m, use, undefined, 100)
  l = add(l, 'old', m, use, { role: 'worker', name: 'old-worker', branch: 'flow/old' }, 200)
  l = add(l, 'main@5000', m, use, undefined, 5000)
  l = add(l, 'new', m, use, { role: 'worker', name: 'new-worker', branch: 'flow/new' }, 5100)
  l = add(l, 'kept', m, use, { role: 'worker', name: 'kept-worker', branch: 'flow/kept' }, 300)
  expect(Object.keys(l)).toEqual(['main@100', 'old', 'main@5000', 'new', 'kept'])
  expect(l['main@100']!.name).toBe('main')
  const text = costBlock(l, [{ pr: 1, branch: 'flow/old' }, { pr: 2, branch: 'flow/new' }], false, { start: 5000, live: new Set(['kept']) }).join('\n')
  expect(text).toContain('worker new-worker')
  expect(text).toContain('worker kept-worker')
  expect(text).not.toContain('old-worker')
  expect(text).toContain('PR #2')
  expect(text).not.toContain('PR #1')
  expect(text).toContain('session total: ~$12.00')
  expect(text).toMatch(/All time \(since \d{4}-\d{2}-\d{2}\): ~\$20\.00/)
  void day
})

test('pruneLedger drops entries older than 90 days and entries with no lastAt', () => {
  const day = 24 * 3600 * 1000
  const now = 200 * day
  const e = { role: 'worker' as const, name: 'x', models: {} }
  const l: Ledger = { fresh: { ...e, lastAt: now - 89 * day }, stale: { ...e, lastAt: now - 91 * day }, none: e }
  expect(Object.keys(pruneLedger(l, now))).toEqual(['fresh'])
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
  on('session.usage', () => ({ value: { startedAt: 900_000, rateLimits: [], context: { window: 200_000, tokens: undefined, percent: undefined } } }))
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

test('after a restart the ledger on disk is history: only this session is listed, the all-time line has both, main is keyed per session', async ($, on) => {
  const w = world(on)
  const old = { role: 'worker', name: 'gone', branch: 'flow/gone', firstAt: 500_000, lastAt: 500_000, models: { 'claude-opus-5-5': bucket({ input: 1_000_000 }) } }
  const noStamp = { role: 'worker', name: 'unstamped', models: { 'claude-opus-5-5': bucket({ input: 1_000_000 }) } }
  w.files.set('/r/.git/flow/ledger.json', JSON.stringify({ old, noStamp, 'main@100': { ...old, role: 'main', name: 'main' } }))
  await step($, 'w1')
  await step($, undefined)
  const text = await status($)
  expect(text).not.toContain('worker gone')
  expect(text).toContain('worker csv-worker [claude-opus-5-5]: ~$4.00')
  expect(text).toContain('main total: ~$4.00')
  expect(text).toContain('session total: ~$8.00')
  expect(text).toMatch(/All time \(since \d{4}-\d{2}-\d{2}\): ~\$16\.00/)
  await w.clock.advance(3500)
  await w.clock.settle()
  const saved = JSON.parse([...w.files].find(([k]) => k.startsWith('/r/.git/flow/ledger.json.'))![1]) as Record<string, unknown>
  expect(Object.keys(saved).sort()).toEqual(['__epoch', 'main@100', 'main@900000', 'old', 'w1'])
})

test('addTurn counts per agent; old rows read as 0; merging adds turns; an agent with no row gets an empty one', () => {
  let l: Ledger = add({}, 'w1', 'claude-opus-5-5', { input_tokens: 1000 })
  expect(l.w1?.turns).toBeUndefined()
  l = addTurn(addTurn(l, 'w1', 2_000_000), 'w1', 3_000_000)
  expect(l.w1?.turns).toBe(2)
  expect(addTurn({}, 'w9', 5).w9).toMatchObject({ turns: 1, models: {} })
  expect(mergeLedgers(l, { w1: { ...l.w1!, turns: 3 } }).w1?.turns).toBe(5)
})

test('the cost line shows turns and cache write per turn; rows without turns render as before; totals sum turns', () => {
  const m = { 'claude-opus-5-5': bucket({ write5m: 300_000, write1h: 100_000 }) }
  const ledger: Ledger = {
    a: { role: 'worker', name: 'a', models: m, turns: 4, lastAt: 1 },
    b: { role: 'worker', name: 'b', models: m, lastAt: 1 },
  }
  const text = costBlock(ledger, [], false, { start: 0, live: new Set() }).join('\n')
  expect(text).toMatch(/worker a .*hit [^\n]*, 4 turns, ~100k cache write\/turn\)/)
  expect(text).not.toMatch(/worker b [^\n]*turns/)
  expect(text).toMatch(/session total: [^\n]*, 4 turns, ~200k cache write\/turn\)/)
})

test('turn.complete counts one turn per turn id, for main and agents, and ledger.json keeps it', async ($, on) => {
  const w = world(on)
  on('turn.complete', (_, e) => ({ text: e.answer }) as never)
  await step($, 'w1')
  const done = (turnId: string, agentId?: string) => $.turn.complete({ turnId, agentId, answer: 'x', durationMs: 1, isAborted: true, reason: 'answer' } as never)
  await done('t1', 'w1')
  await done('t1', 'w1')
  await done('t2', 'w1')
  await done('t1', undefined)
  expect(await status($)).toMatch(/worker csv-worker [^\n]*, 2 turns, ~/)
  await w.clock.advance(3500)
  await w.clock.settle()
  const saved = JSON.parse([...w.files].find(([k]) => k.startsWith('/r/.git/flow/ledger.json'))![1]) as Record<string, { turns?: number }>
  expect(saved.w1?.turns).toBe(2)
  expect(saved['main@900000']?.turns).toBe(1)
})

test('loading the ledger again after a plugin reload does not multiply the totals', async () => {
  const disk: Ledger = { w1: { role: 'worker', name: 'w1', models: { m: bucket({ input: 100 }) }, turns: 2, lastAt: 1000 } }
  let atom: Ledger = {}
  let loaded = false
  const io = {
    stateDir: async () => '/s', readJson: async () => disk, now: async () => 2000,
    ledger: async () => atom, updateLedger: async (fn: (l: Ledger) => Ledger) => { atom = fn(atom) },
    loaded: async () => loaded, markLoaded: async () => { loaded = true },
    setEpoch: async () => {},
  } as unknown as CostIo
  forgetLedgerLoad()
  // What this run counted before the first load is added to the history.
  atom = { w1: { role: 'worker', name: 'w1', models: { m: bucket({ input: 10 }) }, turns: 1, lastAt: 1500 } }
  await loadLedger(io)
  expect(atom.w1?.turns).toBe(3)
  const once = JSON.stringify(atom)
  // Reloads: the module variable is gone, the atoms and the disk file stay.
  for (let i = 0; i < 3; i++) { forgetLedgerLoad(); await loadLedger(io) }
  expect(JSON.stringify(atom)).toBe(once)
})

// A fake plugin process: its own atoms (they survive a "reload"), a shared file and clock.
type Disk = { text?: string }
function process_(disk: Disk, timers: (() => void)[] = []) {
  let view: Ledger = {}
  let delta: Ledger = {}
  let epoch = ''
  let loaded = false
  const io: CostIo = {
    stateDir: async () => '/s', readJson: async () => (disk.text === undefined ? undefined : JSON.parse(disk.text)),
    writeJsonAtomic: async (_p, obj) => { disk.text = JSON.stringify(obj); return true },
    mkdirp: async () => {}, now: async () => 5000, after: (_ms, fn) => { timers.push(fn) },
    ledger: async () => view, updateLedger: async fn => { view = fn(view) },
    delta: async () => delta, updateDelta: async fn => { delta = fn(delta) },
    epoch: async () => epoch, setEpoch: async e => { epoch = e },
    loaded: async () => loaded, markLoaded: async () => { loaded = true },
    startedAt: async () => 0, liveIds: async () => [], hasSessions: async () => false,
  }
  const count = (key: string, input: number) => changeLedger(io, l => add(l, key, 'm', { input_tokens: input }, { role: 'worker', name: key }, 4000))
  const save = () => saveLedger(io)
  return { io, count, save, view: () => view, delta: () => delta, epoch: () => epoch }
}
const onDisk = (d: Disk) => JSON.parse(d.text ?? '{}') as Record<string, unknown> & { __epoch?: string }
const inputOf = (l: Ledger, k: string) => l[k]?.models.m?.input

test('a reload after a rebuild (new epoch on disk) does not restore the old totals and keeps entries since', async () => {
  const disk: Disk = { text: JSON.stringify({ __epoch: 'e1', old: { role: 'worker', name: 'old', models: { m: bucket({ input: 6000 }) }, lastAt: 4000 } }) }
  const p = process_(disk)
  forgetLedgerLoad()
  await p.count('new', 7)
  await p.save()
  expect(onDisk(disk).__epoch).toBe('e1')
  // A rebuild rewrites the file with a new epoch and the true total.
  disk.text = JSON.stringify({ __epoch: 'rebuilt', old: { role: 'worker', name: 'old', models: { m: bucket({ input: 600 }) }, lastAt: 4000 }, new: { role: 'worker', name: 'new', models: { m: bucket({ input: 7 }) }, lastAt: 4000 } })
  forgetLedgerLoad()
  await p.count('newer', 3)
  await p.save()
  const out = normalizeLedger(onDisk(disk))
  expect(onDisk(disk).__epoch).toBe('rebuilt')
  expect(inputOf(out, 'old')).toBe(600)
  expect(inputOf(out, 'new')).toBe(7)
  expect(inputOf(out, 'newer')).toBe(3)
  expect(JSON.stringify(p.view())).toBe(JSON.stringify(out))
  expect(p.epoch()).toBe('rebuilt')
  expect(p.delta()).toEqual({})
})

test('two sessions sharing one file keep both sets of deltas', async () => {
  const disk: Disk = {}
  const a = process_(disk)
  const b = process_(disk)
  forgetLedgerLoad()
  await a.count('x', 10)
  await a.save()
  forgetLedgerLoad()
  await b.count('x', 5)
  await b.count('y', 1)
  await b.save()
  await a.count('x', 100)
  await a.save()
  const out = normalizeLedger(onDisk(disk))
  expect(inputOf(out, 'x')).toBe(115)
  expect(inputOf(out, 'y')).toBe(1)
})

test('a ledger without an epoch still loads; the first save stamps one and the stamp is not an entry', async () => {
  const disk: Disk = { text: JSON.stringify({ w: { role: 'worker', name: 'w', models: { m: bucket({ input: 4 }) }, lastAt: 4000 } }) }
  const p = process_(disk)
  forgetLedgerLoad()
  await loadLedger(p.io)
  expect(inputOf(p.view(), 'w')).toBe(4)
  expect(p.epoch()).toBe('')
  await p.count('w', 1)
  await p.save()
  const raw = onDisk(disk)
  expect(raw.__epoch).toBeTruthy()
  expect(epochOf(raw)).toBe(raw.__epoch)
  expect(Object.keys(normalizeLedger(raw))).toEqual(['w'])
  expect(Object.keys(pruneLedger(normalizeLedger(raw), 5000))).toEqual(['w'])
  expect(inputOf(normalizeLedger(raw), 'w')).toBe(5)
})

test('a first save creates the file with an epoch; a reload without a disk change does not double the base', async () => {
  const disk: Disk = {}
  const p = process_(disk)
  forgetLedgerLoad()
  await p.count('w', 8)
  await p.save()
  const epoch = onDisk(disk).__epoch
  expect(epoch).toBeTruthy()
  for (let i = 0; i < 3; i++) { forgetLedgerLoad(); await p.count('w', 0); await p.save() }
  expect(inputOf(normalizeLedger(onDisk(disk)), 'w')).toBe(8)
  expect(inputOf(p.view(), 'w')).toBe(8)
  expect(onDisk(disk).__epoch).toBe(epoch)
})

test('a failed write keeps the deltas for the next save', async () => {
  const disk: Disk = {}
  const p = process_(disk)
  const real = p.io.writeJsonAtomic
  p.io.writeJsonAtomic = async () => false
  forgetLedgerLoad()
  await p.count('w', 2)
  await p.save()
  expect(disk.text).toBeUndefined()
  p.io.writeJsonAtomic = real
  await p.count('w', 3)
  await p.save()
  expect(inputOf(normalizeLedger(onDisk(disk)), 'w')).toBe(5)
})

test('a step counted without identity after a save keeps the entry\'s real role, manager and branch', async () => {
  const disk: Disk = { text: JSON.stringify({ __epoch: 'e', w: { role: 'worker', name: 'csv', manager: 'mgr', branch: 'flow/csv', models: { m: bucket({ input: 4 }) }, lastAt: 4000 } }) }
  const p = process_(disk)
  forgetLedgerLoad()
  await changeLedger(p.io, l => add(l, 'w', 'm', { input_tokens: 1 }, undefined, 4500))
  await p.save()
  await changeLedger(p.io, l => add(l, 'w', 'm', { input_tokens: 2 }, undefined, 4600))
  await p.save()
  const w = normalizeLedger(onDisk(disk)).w
  expect(w).toMatchObject({ role: 'worker', name: 'csv', manager: 'mgr', branch: 'flow/csv' })
  expect(w?.models.m?.input).toBe(7)
})

test('a turn counted after a save adds one turn, not the whole count again', async () => {
  const disk: Disk = { text: JSON.stringify({ __epoch: 'e', w: { role: 'worker', name: 'csv', models: { m: bucket({ input: 4 }) }, turns: 5, lastAt: 4000 } }) }
  const p = process_(disk)
  forgetLedgerLoad()
  await changeLedger(p.io, l => addTurn(l, 'w', 4500))
  await p.save()
  await changeLedger(p.io, l => addTurn(l, 'w', 4600))
  await p.save()
  expect(normalizeLedger(onDisk(disk)).w?.turns).toBe(7)
})
