import type { AgentInfo } from 'claude-code'
import { expect, mock } from 'claude-code/testing'
import { test } from './support'
import type { TestBody } from 'claude-code/testing'

import { backNote, effectiveSize, escalate, floorFrom, generation, isSuccessorName, modelFor, parseSize } from '../hooks/routing'
import { costBlock } from '../hooks/cost'
import { isFable, mergeLayers } from '../hooks/settings'
import type { Ledger, Question } from '../types'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

test('parseSize reads the Size line, its reason, and ignores unknown words', () => {
  expect(parseSize('Your name: x\nSize: small — docs only\n# Title')).toEqual({ size: 'small', reason: 'docs only' })
  expect(parseSize('Size: Normal - a few files')).toEqual({ size: 'normal', reason: 'a few files' })
  expect(parseSize('a\nsize: LARGE (cross-cutting)\nb')).toEqual({ size: 'large', reason: 'cross-cutting' })
  expect(parseSize('Size: small')).toEqual({ size: 'small', reason: '' })
  expect(parseSize('Size: tiny')).toBeUndefined()
  expect(parseSize('Size: smaller')).toBeUndefined()
  expect(parseSize('see the Size: small line')).toBeUndefined()
  expect(parseSize('no size here')).toBeUndefined()
})

test('escalate steps one size up and stops at large; the floor is one up from the largest recorded size', () => {
  expect(escalate('small')).toBe('normal')
  expect(escalate('normal')).toBe('large')
  expect(escalate('large')).toBe('large')
  expect(floorFrom([])).toBeUndefined()
  expect(floorFrom([undefined, 'weird'])).toBeUndefined()
  expect(floorFrom(['small'])).toBe('normal')
  expect(floorFrom(['small', 'normal', undefined])).toBe('large')
  expect(modelFor('small', { small: 'haiku', normal: 'sonnet', large: 'sonnet[1m]' })).toBe('haiku')
  expect(generation('x')).toBe(1)
  expect(generation('x-3')).toBe(3)
  expect(isSuccessorName('x-2')).toBe(true)
  expect(isSuccessorName('x-1')).toBe(false)
  expect(effectiveSize(undefined, undefined)).toBeUndefined()
  expect(effectiveSize('small', undefined)).toBe('small')
  expect(effectiveSize('small', 'normal')).toBe('normal')
  expect(effectiveSize('large', 'normal')).toBe('large')
  expect(effectiveSize(undefined, 'normal')).toBe('normal')
})

test('backNote names the continuation one generation up, only after a small or normal worker', () => {
  expect(backNote([{ name: 'csv-fix', size: 'small', spawnModel: 'haiku' }], 'flow/csv-fix'))
    .toBe('Its worker ran small (haiku): continue with a fresh csv-fix-2 worker (Continue on branch: flow/csv-fix); it runs one size up.')
  expect(backNote([{ name: 'csv-fix', size: 'small' }, { name: 'csv-fix-2', size: 'normal', spawnModel: 'sonnet' }], 'flow/csv-fix')).toContain('fresh csv-fix-3 worker')
  expect(backNote([{ name: 'csv-fix', size: 'large' }], 'flow/csv-fix')).toBeUndefined()
  expect(backNote([{ name: 'csv-fix' }], 'flow/csv-fix')).toBeUndefined()
})

test('settings: the new model keys refuse Fable, and reviewer_model defaults to sonnet', () => {
  expect(isFable('fable')).toBe(true)
  const r = mergeLayers({ worker_model_small: 'fable', worker_model_normal: 'Claude-Fable-1', explore_model: 'fable', conflict_model: 'fable', worker_model: 'haiku' }, [])
  expect(r.raw).toEqual({ worker_model: 'haiku' })
  expect(r.warnings.length).toBe(4)
})

const DIR = '/r/.git/flow'
const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const PR = { state: 'OPEN', isDraft: false, headRefOid: 'abc1234def5678', headRefName: 'flow/csv-fix', title: 'Export', body: '## Verification\nRan:\n- `bun test`: pass\nExercised: ran it\nNot verified:\n- full check' }

// A manager (m1) under main, a reviewer (q1); every spawn is recorded and gets an id a1, a2, ...
function world(on: On, spawnFn?: (model: string | undefined, n: number) => unknown) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const agents: AgentInfo[] = [
    { id: 'm1', name: 'csv-export', description: 'm', type: 'flow:manager', status: 'running' },
    { id: 'w0', name: 'csv-fix', description: 'w', type: 'flow:worker', status: 'running', parentId: 'm1' },
    { id: 'q1', name: 'merge-queue-1', description: 'q', type: 'flow:queue', status: 'running' },
  ]
  const files = new Map<string, string>()
  const spawned: { type: string; model?: string; name?: string }[] = []
  const logs: string[] = []
  on('agent.list', () => ({ value: agents }))
  on('session.usage', () => ({ value: { startedAt: 900_000, rateLimits: [], context: { window: 200_000, tokens: undefined, percent: undefined } } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.send', () => ({ isDelivered: true as const }))
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('fs.read', (_, e) => {
    const t = files.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('process.run', (_, e) => {
    const a = e.argv
    if (a[0] === 'git' && a[1] === 'rev-parse') return ok('/r/.git\n')
    if (a[0] === 'gh') return ok(JSON.stringify(PR))
    if (a[0] === 'sh' && a[2]?.includes('>>')) logs.push(a[4] ?? '')
    if (a[0] === 'mv') {
      const t = files.get(a[1] ?? '')
      if (t !== undefined) { files.set(a[2] ?? '', t); files.delete(a[1] ?? '') }
    }
    return ok()
  })
  on('agent.spawn', (_, e) => {
    const ev = e as unknown as { subagentType: string; model?: string; name?: string }
    spawned.push({ type: ev.subagentType, model: ev.model, name: ev.name })
    return (spawnFn?.(ev.model, spawned.length) ?? { model: ev.model ?? 'none', agentId: `a${spawned.length}` }) as never
  })
  return { agents, files, spawned, logs, clock }
}

const spawn = ($: Dollar, name: string, prompt: string, extra: Record<string, unknown> = {}) =>
  $.agent.spawn({ prompt, description: name, name, subagentType: 'flow:worker', parentAgentId: 'm1', ...extra } as never)
const ledger = async (w: ReturnType<typeof world>) => {
  await w.clock.advance(3500)
  await w.clock.settle()
  return JSON.parse(w.files.get(`${DIR}/ledger.json`) ?? '{}') as Ledger
}
const items = (w: ReturnType<typeof world>) => (JSON.parse(w.files.get(`${DIR}/inbox.json`) ?? '{"items":[]}') as { items: Question[] }).items
const OPTS = { preflight: 'off' }

test('Size small spawns on haiku and the ledger records size and spawn model', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await spawn($, 'csv-fix', 'Your name: csv-fix\nSize: small — docs\n# t')
  expect(w.spawned.at(-1)!.model).toBe('haiku')
  const entry = (await ledger(w)).a1!
  expect(entry.size).toBe('small')
  expect(entry.spawnModel).toBe('haiku')
  expect(entry.branch).toBe('flow/csv-fix')
})

test('normal maps to worker_model_normal, large to worker_model; settings change the mapping', { options: { ...OPTS, worker_model_normal: 'opus', worker_model: 'sonnet' } }, async ($, on) => {
  const w = world(on)
  await spawn($, 'one', 'Size: normal')
  await spawn($, 'two', 'Size: large')
  expect(w.spawned.map(s => s.model)).toEqual(['opus', 'sonnet'])
})

test('no Size line: the model param or worker_model as before, size left unset, no decision', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await spawn($, 'csv-fix', 'Your name: csv-fix\n# t', { model: 'opus' })
  await spawn($, 'other', 'Size: tiny\n# t', { model: 'sonnet' })
  expect(w.spawned.map(s => s.model)).toEqual(['opus', 'sonnet'])
  const l = await ledger(w)
  expect(l.a1!.size).toBeUndefined()
  expect(l.a2!.size).toBeUndefined()
  expect(items(w)).toEqual([])
})

test('the Size line beats an explicit model param, and Fable is still denied first', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await spawn($, 'csv-fix', 'Size: small', { model: 'opus' })
  expect(w.spawned.at(-1)!.model).toBe('haiku')
  const denied = await spawn($, 'csv-fix-b', 'Size: small', { model: 'fable' })
  expect(JSON.stringify(denied)).toContain('sub-agents don')
  expect(w.spawned.length).toBe(1)
})

test('a large Size still goes through the [1m] fallback on the routed model', { options: OPTS }, async ($, on) => {
  const w = world(on, (model, n) => model?.includes('[1m]') ? { deny: 'model sonnet[1m] is not available for sub-agents' } : { model: model ?? 'none', agentId: `a${n}` })
  await spawn($, 'csv-fix', 'Size: large', { model: 'haiku' })
  expect(w.spawned.map(s => s.model)).toEqual(['sonnet[1m]', 'sonnet'])
})

test('a -2 successor of a small worker runs normal, then -3 runs large; unsized -2 is unchanged', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await spawn($, 'csv-fix', 'Size: small — docs')
  await spawn($, 'csv-fix-2', 'Your name: csv-fix-2\n# t')
  await spawn($, 'csv-fix-3', 'Your name: csv-fix-3\n# t')
  expect(w.spawned.map(s => s.model)).toEqual(['haiku', 'sonnet', 'sonnet[1m]'])
  const l = await ledger(w)
  expect([l.a1!.size, l.a2!.size, l.a3!.size]).toEqual(['small', 'normal', 'large'])
  // A successor with no sized predecessor on record keeps today's behaviour.
  await spawn($, 'legacy-2', 'Your name: legacy-2', { model: 'opus' })
  expect(w.spawned.at(-1)!.model).toBe('opus')
})

test('a -2 worker with no Continue line (the first never pushed a branch) escalates by name alone', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await spawn($, 'csv-fix', 'Size: small')
  await spawn($, 'csv-fix-2', 'Your name: csv-fix-2\nSize: small\n# t')
  expect(w.spawned.map(s => s.model)).toEqual(['haiku', 'sonnet'])
  expect((await ledger(w)).a2!.branch).toBe('flow/csv-fix-2')
})

test('a declared Size on a successor is raised to the floor, never lowered', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await spawn($, 'csv-fix', 'Size: normal')
  await spawn($, 'csv-fix-2', 'Size: small')
  expect(w.spawned.map(s => s.model)).toEqual(['sonnet', 'sonnet[1m]'])
})

test('Continue on branch escalates from the sized workers on that branch', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await spawn($, 'csv-fix', 'Size: small')
  await spawn($, 'csv-resume', 'Your name: csv-resume\nContinue on branch: flow/csv-fix\n# t')
  expect(w.spawned.map(s => s.model)).toEqual(['haiku', 'sonnet'])
  const l = await ledger(w)
  expect(l.a2!.size).toBe('normal')
  expect(l.a2!.branch).toBe('flow/csv-fix')
  expect(w.logs.join('\n')).toContain('size normal -> sonnet (escalated)')
})

test('a small or normal worker files one worker-size decision for its manager; large and an escalation to large do not', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await spawn($, 'csv-fix', 'Size: small — docs only')
  await spawn($, 'csv-fix', 'Size: small — docs only')
  const fyis = items(w)
  expect(fyis.length).toBe(1)
  expect(fyis[0]).toMatchObject({ kind: 'fyi', owner: 'csv-export', addressee: 'main', topic: 'worker-size', blocking: false, state: 'open' })
  expect(fyis[0]!.question).toBe('csv-fix runs small -> haiku: docs only')
  await spawn($, 'other', 'Size: normal')
  expect(items(w).map(q => q.question)).toEqual(['csv-fix runs small -> haiku: docs only', 'other runs normal -> sonnet: no reason given'])
  await spawn($, 'big', 'Size: large')
  await spawn($, 'other-2', 'Your name: other-2')
  expect(items(w).length).toBe(2)
})

test('a standing rule answers the worker-size decision at once', { options: { ...OPTS, standing_answers: JSON.stringify([{ id: 'sz', topic: 'worker-size', answer: 'Keep' }]) } }, async ($, on) => {
  const w = world(on)
  await spawn($, 'csv-fix', 'Size: small — docs')
  const q = items(w)[0]!
  expect(q.state).toBe('answered')
  expect(q.rule).toBe('sz')
  expect(q.answer).toBe('Keep')
})

test('Explore from a flow agent gets the explore model; from main, or with a model, it is left alone', async ($, on) => {
  const w = world(on)
  const explore = (extra: Record<string, unknown>) => $.agent.spawn({ prompt: 'p', description: 'e', subagentType: 'Explore', ...extra } as never)
  await explore({ parentAgentId: 'm1' })
  await explore({})
  await explore({ parentAgentId: 'm1', model: 'sonnet' })
  await explore({ parentAgentId: 'q1' })
  expect(w.spawned.map(s => s.model)).toEqual(['haiku', undefined, 'sonnet', 'haiku'])
})

test('a reviewer back for a small worker\'s PR carries the continue line; a sized-large or unsized one does not', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await spawn($, 'csv-fix', 'Size: small — docs')
  const call = (input: Record<string, unknown>) => $.tool.call(input as never).then(r => String(r.result))
  expect(await call({ tool: 'mcp__flow__handover', pr: 7, agentId: 'm1', verified: 'v', pending: 'none', after_deploy: 'none' })).not.toMatch(/^Refused/)
  const back = await call({ tool: 'mcp__flow__queue', action: 'back', pr: 7, reason: 'tests fail', agentId: 'q1' })
  expect(back).toContain('Its worker ran small (haiku): continue with a fresh csv-fix-2 worker (Continue on branch: flow/csv-fix); it runs one size up.')
  void w
})

test('costBlock adds a by-size line only when some entry has a size', () => {
  const b = (input: number) => ({ input, write5m: 0, write1h: 0, read: 0, output: 0 })
  const base = { role: 'worker' as const, models: { 'claude-opus-5-5': b(1_000_000) }, lastAt: 5 }
  const sized: Ledger = { a: { ...base, name: 'a', size: 'small' }, b: { ...base, name: 'b' } }
  const scope = { start: 0, live: new Set<string>() }
  expect(costBlock(sized, [], false, scope).join('\n')).toContain('by size: small ~$4.00, unsized ~$4.00')
  expect(costBlock({ b: sized.b! }, [], false, scope).join('\n')).not.toContain('by size')
})
