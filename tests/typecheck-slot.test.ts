import type { AgentInfo } from 'claude-code'
import { expect, mock } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import { test } from './support'

import { DEFAULT_SUITE_COMMANDS, DEFAULT_TYPECHECK_COMMANDS, suiteRun, typecheckRefusal, typecheckRun, workerSuiteRefusal } from '../hooks/testguard'
import { reapTypecheck, TYPECHECK_LEASE_MS } from '../hooks/typecheck-slots'

const TC = DEFAULT_TYPECHECK_COMMANDS
const holder = (key: string, claimed?: boolean, since = 1_000) => ({ key, name: key, label: 'typecheck', since, ...(claimed === undefined ? {} : { claimed }) })
const rows = (...ids: string[]) => ids.map(id => ({ id, description: id, type: 'flow:worker', status: 'running' })) as never
const none = { holders: [], waiters: [] }
const T = 2_000

test('typecheck commands are matched behind wrappers; help and version are not runs', () => {
  for (const c of ['npm run typecheck', 'cd /repo && tsc -p .', 'tsc --noEmit', 'npx tsc', 'FOO=1 time npm run typecheck', 'bash -c "cd x && tsc"', 'npm run typecheck | tail -5']) {
    expect(typecheckRun(c, TC), c).toBeDefined()
  }
  for (const c of ['tsc --help', 'tsc -h', 'tsc --version', 'npm run check', 'git status', 'echo tsc is nice', 'npm run typecheck-all']) {
    expect(typecheckRun(c, TC), c).toBeUndefined()
  }
  // An empty list turns it off.
  expect(typecheckRun('tsc', [])).toBeUndefined()
})

test('help and version of the test runner are not suite runs; other flags still are', () => {
  const S = DEFAULT_SUITE_COMMANDS
  for (const c of ['claude plugin test --help', 'claude plugin test -h', 'claude plugin test --version', 'npm test -- --help']) {
    expect(suiteRun(c, S), c).toBeUndefined()
  }
  expect(suiteRun('claude plugin test --reporter dot', S)).toBeDefined()
  expect(suiteRun('claude plugin test .', S)).toBeDefined()
})

test('workerSuiteRefusal: only a worker is refused, with the files-you-touched advice', () => {
  expect(workerSuiteRefusal(false, 'claude plugin test .')).toBeUndefined()
  const no = workerSuiteRefusal(true, 'claude plugin test .')!
  expect(no).toContain('scripts/test-files.sh')
  expect(no).toContain('claude plugin test .')
})

test('typecheckRefusal: a confirmed typecheck holder passes; a test-slot holder passes; others are told who holds', () => {
  const tc = { holders: [holder('w1')], waiters: [] }
  expect(typecheckRefusal(tc, none, rows('w1', 'w2'), 'w1', 1, T, 'tsc')).toBeUndefined()
  const no = typecheckRefusal(tc, none, rows('w1', 'w2'), 'w2', 1, T, 'tsc')!
  expect(no).toContain('kind "typecheck"')
  expect(no).toContain('w1 (typecheck')
  expect(typecheckRefusal(none, none, rows('w2'), 'w2', 1, T, 'tsc')).toContain('free')
  // The reviewer's full check holds a test slot: its typecheck must not deadlock.
  expect(typecheckRefusal(none, { holders: [holder('w2')], waiters: [] }, rows('w2'), 'w2', 1, T, 'npm run typecheck')).toBeUndefined()
  // An unconfirmed test grant is no slot.
  expect(typecheckRefusal(none, { holders: [holder('w2', false)], waiters: [] }, rows('w2'), 'w2', 1, T, 'tsc')).toBeDefined()
})

test('typecheckRefusal: unconfirmed, ended and expired typecheck holders do not count; main is keyed "main"', () => {
  expect(typecheckRefusal({ holders: [holder('w1', false)], waiters: [] }, none, rows('w1'), 'w1', 1, T, 'tsc')).toContain('unconfirmed')
  const ended = [{ id: 'w1', description: 'w1', type: 'flow:worker', status: 'completed' }] as never
  expect(typecheckRefusal({ holders: [holder('w1')], waiters: [] }, none, ended, 'w1', 1, T, 'tsc')).toContain('free')
  expect(typecheckRefusal({ holders: [holder('w1')], waiters: [] }, none, rows('w1'), 'w1', 1, 1_000 + TYPECHECK_LEASE_MS + 1, 'tsc')).toContain('free')
  expect(typecheckRefusal({ holders: [holder('main')], waiters: [] }, none, rows(), 'main', 1, T, 'tsc')).toBeUndefined()
})

test('reapTypecheck: the lease is short; idle keeps a slot, a missing agent loses it', () => {
  const r = [{ id: 'a', description: '', type: '', status: 'idle' }]
  const t = 10_000_000
  expect(reapTypecheck({ holders: [holder('a', undefined, t)], waiters: [] }, r, t).state.holders.length).toBe(1)
  const late = reapTypecheck({ holders: [holder('a', undefined, t - 11 * 60_000)], waiters: [] }, r, t)
  expect(late.state.holders).toEqual([])
  expect(late.notes[0]).toContain('typecheck slot')
  expect(reapTypecheck({ holders: [holder('gone')], waiters: [holder('gone')] }, r, t).state).toEqual(none)
})

// --- The hook and the tool ---

const AGENTS: AgentInfo[] = [
  { id: 'w1', name: 'w1', description: 'w', type: 'flow:worker', status: 'running' },
  { id: 'w2', name: 'w2', description: 'w', type: 'flow:worker', status: 'running' },
  { id: 'r1', name: 'r1', description: 'r', type: 'flow:reviewer', status: 'running' },
]

const sent: string[] = []

function world(on: Parameters<TestBody>[1], list = AGENTS) {
  sent.length = 0
  const clock = mock.clock(on, { now: 1_000_000 })
  on('agent.list', () => ({ value: list }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.send', (_: any, e: any) => { sent.push(e.text); return { isDelivered: true as const } })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('tool.call', () => ({ result: 'ran' }))
  return clock
}

const slot = ($: any, action: string, agentId?: string, extra: object = {}) =>
  $.tool.call({ tool: 'mcp__flow__test_slot', action, agentId, wait_s: 0, ...extra } as never).then((r: any) => String(r.result))
const bash = ($: any, command: string, agentId?: string) => $.tool.call({ tool: 'Bash', command, agentId } as never)
const denied = (r: unknown) => JSON.stringify(r).includes('deny')

test('the hook denies a typecheck without a typecheck slot; a test slot is no typecheck slot, except for the full check', async ($, on) => {
  world(on)
  expect(denied(await bash($, 'npm run typecheck', 'w1'))).toBe(true)
  expect((await bash($, 'tsc --help', 'w1')).result).toBe('ran')
  // The test pool does not grant a typecheck slot to a worker...
  await slot($, 'acquire', 'w1')
  expect(await slot($, 'status', 'w1', { kind: 'typecheck' })).toContain('0/1 held')
  await slot($, 'release', 'w1')
  // ...the typecheck pool does, and only until released.
  expect(await slot($, 'acquire', 'w1', { kind: 'typecheck' })).toContain('Typecheck slot granted')
  expect((await bash($, 'npm run typecheck', 'w1')).result).toBe('ran')
  expect(JSON.stringify(await bash($, 'tsc', 'w2'))).toContain('w1')
  // A typecheck slot grants no test slot.
  expect(await slot($, 'status', 'w1')).not.toContain('w1')
  expect(await slot($, 'release', 'w1', { kind: 'typecheck' })).toContain('Released your typecheck slot')
  expect(denied(await bash($, 'tsc -p .', 'w1'))).toBe(true)
  // The reviewer holds a test slot for the full check and typechecks inside it.
  await slot($, 'acquire', 'r1')
  expect((await bash($, 'npm run typecheck', 'r1')).result).toBe('ran')
})

test('typecheck slots queue, grant on release with a message, and do not queue behind a suite', async ($, on) => {
  world(on)
  // A suite holds the only test slot; a typecheck is still instant.
  await slot($, 'acquire', 'r1', { label: 'full check' })
  expect(await slot($, 'acquire', 'w1', { kind: 'typecheck' })).toContain('granted')
  expect(await slot($, 'acquire', 'w2', { kind: 'typecheck' })).toContain('position 1')
  expect(await slot($, 'acquire', 'w1', { kind: 'typecheck' })).toContain('already hold')
  expect(await slot($, 'status', 'w2', { kind: 'typecheck' })).toContain('1 waiting')
  await slot($, 'release', 'w1', { kind: 'typecheck' })
  expect(sent.some(t => t.includes('your typecheck slot is granted'))).toBe(true)
  expect(denied(await bash($, 'tsc', 'w2'))).toBe(true)
  expect(await slot($, 'acquire', 'w2', { kind: 'typecheck' })).toContain('granted')
  expect((await bash($, 'tsc', 'w2')).result).toBe('ran')
})

test('an agent may hold one test slot and one typecheck slot; the lease frees a hung typecheck', async ($, on) => {
  const clock = world(on)
  await slot($, 'acquire', 'r1')
  await slot($, 'acquire', 'r1', { kind: 'typecheck' })
  expect(await slot($, 'status', 'r1')).toContain('held by r1')
  expect(await slot($, 'status', 'r1', { kind: 'typecheck' })).toContain('held by r1')
  await clock.advance(TYPECHECK_LEASE_MS + 1000)
  // Another caller's acquire reaps the expired lease and takes the slot.
  expect(await slot($, 'acquire', 'w1', { kind: 'typecheck' })).toContain('granted')
  expect(await slot($, 'status', 'w1', { kind: 'typecheck' })).toContain('held by w1')
  expect(await slot($, 'status', 'r1')).toContain('held by r1')
})

test('a worker is refused a whole-suite run even with a slot; one to five files run; reviewer and main are unaffected', async ($, on) => {
  world(on)
  await slot($, 'acquire', 'w1')
  for (const c of ['claude plugin test .', 'claude plugin test', 'claude plugin test tests/*.test.ts', 'claude plugin test tests', 'claude plugin test a.ts b.ts c.ts d.ts e.ts f.ts', 'npm run check']) {
    const r = JSON.stringify(await bash($, c, 'w1'))
    expect(r, c).toContain('deny')
    expect(r, c).toContain('scripts/test-files.sh')
  }
  expect((await bash($, 'claude plugin test tests/a.test.ts tests/b.test.ts', 'w1')).result).toBe('ran')
  expect((await bash($, 'claude plugin test --help', 'w1')).result).toBe('ran')
  await slot($, 'release', 'w1')
  await slot($, 'acquire', 'r1')
  expect((await bash($, 'claude plugin test .', 'r1')).result).toBe('ran')
  await slot($, 'release', 'r1')
  await slot($, 'acquire')
  expect((await bash($, 'npm run check')).result).toBe('ran')
})
