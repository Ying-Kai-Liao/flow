import type { AgentInfo } from 'claude-code'
import { expect, mock } from 'claude-code/testing'
import { test } from './support'
import type { TestBody } from 'claude-code/testing'

import { DEFAULT_SUITE_COMMANDS, slotRefusal, suiteRun } from '../hooks/testguard'

const P = DEFAULT_SUITE_COMMANDS
const hit = (c: string, p = P) => suiteRun(c, p) !== undefined

test('whole-suite commands are matched, also behind wrappers and chains', () => {
  for (const c of [
    'claude plugin test .',
    'claude plugin test . --reporter dot',
    'cd /repo && claude plugin test .',
    'git status; claude plugin test .',
    'claude plugin test . | tail -20',
    'false || npm run check',
    'npm run check',
    'npm test',
    'FOO=1 time npm test',
    'npm test -- --watch=false',
    'bash -c "cd x && npm run check"',
    'claude plugin test tests/*.test.ts',
    'claude plugin test',
    'claude plugin test /private/tmp/lite-149-sub',
    'cd /private/tmp/x && claude plugin test .',
    'cd /private/tmp/x && claude plugin test',
    'claude plugin test tests',
    'claude plugin test tests/',
    'claude plugin test a.ts b.ts c.ts d.ts e.ts f.ts',
    'echo $(npm test)',
    'git status\nnpm test',
  ]) expect([c, hit(c)]).toEqual([c, true])
})

test('single files and unrelated commands run freely', () => {
  for (const c of [
    'claude plugin test tests/foo.test.ts',
    'claude plugin test --file tests/a.test.ts',
    'claude plugin test tests/a.test.ts tests/b.test.ts tests/c.test.ts',
    'claude plugin test a.ts b.ts c.ts d.ts e.ts',
    'npm test tests/foo.test.ts',
    'git status',
    'echo "claude plugin test ."',
    'grep "npm test" README.md',
    'npm run build',
    'npm install',
  ]) expect([c, hit(c)]).toEqual([c, false])
})

test('the matched segment is returned, and an empty pattern list never matches', () => {
  expect(suiteRun('cd x && npm test | tail', P)).toBe('npm test')
  expect(suiteRun('npm test', [])).toBeUndefined()
  expect(suiteRun('pytest', ['pytest'])).toBe('pytest')
  expect(suiteRun('go test ./...', ['go test'])).toBe('go test ./...')
  expect(suiteRun('pytest tests/test_a.py', ['pytest'])).toBeUndefined()
})

const holder = (key: string, claimed?: boolean, since = 1_000) => ({ key, name: key, label: 'full suite', since, ...(claimed === undefined ? {} : { claimed }) })
const rows = (...ids: string[]) => ids.map(id => ({ id, description: id, type: 'flow:worker', status: 'running' })) as never
const T = 2_000

test('slotRefusal: a confirmed holder passes; others are told who holds', () => {
  const st = { holders: [holder('w1')], waiters: [] }
  expect(slotRefusal(st, rows('w1', 'w2'), 'w1', 1, T, 'npm test')).toBeUndefined()
  const no = slotRefusal(st, rows('w1', 'w2'), 'w2', 1, T, 'npm test')!
  expect(no).toContain('acquire')
  expect(no).toContain('w1 (full suite')
  expect(slotRefusal({ holders: [], waiters: [] }, rows('w2'), 'w2', 1, T, 'npm test')).toContain('free')
})

test('slotRefusal: an unconfirmed grant, an ended holder and an expired lease do not count; main is keyed "main"', () => {
  const unclaimed = { holders: [holder('w1', false)], waiters: [] }
  expect(slotRefusal(unclaimed, rows('w1'), 'w1', 1, T, 'npm test')).toContain('unconfirmed')
  const ended = [{ id: 'w1', description: 'w1', type: 'flow:worker', status: 'completed' }] as never
  expect(slotRefusal({ holders: [holder('w1')], waiters: [] }, ended, 'w1', 1, T, 'npm test')).toContain('free')
  expect(slotRefusal({ holders: [holder('w1')], waiters: [] }, rows('w1'), 'w1', 1, 1_000 + 46 * 60_000, 'npm test')).toContain('free')
  expect(slotRefusal({ holders: [holder('main')], waiters: [] }, rows(), 'main', 1, T, 'npm test')).toBeUndefined()
})

// --- The hook ---

const AGENTS: AgentInfo[] = [
  { id: 'w1', name: 'w1', description: 'w', type: 'flow:worker', status: 'running' },
  { id: 'w2', name: 'w2', description: 'w', type: 'flow:worker', status: 'running' },
]

function world(on: Parameters<TestBody>[1]) {
  mock.clock(on, { now: 1_000_000 })
  on('agent.list', () => ({ value: AGENTS }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('tool.call', () => ({ result: 'ran' }))
}

const slot = ($: any, action: string, agentId?: string) =>
  $.tool.call({ tool: 'mcp__flow__test_slot', action, agentId, wait_s: 0 } as never)
const bash = ($: any, command: string, agentId?: string) => $.tool.call({ tool: 'Bash', command, agentId } as never)
const denied = (r: unknown) => JSON.stringify(r).includes('deny')

test('the hook denies a whole-suite run without a slot and lets a holder through', async ($, on) => {
  world(on)
  const no = await bash($, 'cd /repo && npm run check', 'w1')
  expect(denied(no)).toBe(true)
  expect(JSON.stringify(no)).toContain('free')
  await slot($, 'acquire', 'w1')
  expect((await bash($, 'npm run check', 'w1')).result).toBe('ran')
  const other = await bash($, 'npm run check', 'w2')
  expect(JSON.stringify(other)).toContain('w1')
  // A single file never needs a slot.
  expect((await bash($, 'claude plugin test tests/a.test.ts', 'w2')).result).toBe('ran')
  await slot($, 'release', 'w1')
  expect(denied(await bash($, 'npm test', 'w1'))).toBe(true)
})

test('the hook keys the main session as "main"', async ($, on) => {
  world(on)
  expect(denied(await bash($, 'claude plugin test .'))).toBe(true)
  await slot($, 'acquire')
  expect((await bash($, 'claude plugin test .')).result).toBe('ran')
})
