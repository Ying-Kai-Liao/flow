import type { AgentInfo } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { checkEvidence } from '../hooks/evidence'
import { globMatches, guardTestsFor, mergeGuardTests, parseGuardTests, suggestGlobs, suggestionsFor } from '../hooks/guardtests'
import { mergeLayers } from '../hooks/settings'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const MAP = { 'src/routes/**': ['test/admin.test.ts'], 'sql/**': ['test/migrations.test.ts'], 'src/**': ['test/admin.test.ts'] }

test('glob matching: ** any depth including none, * one segment, ? one char, whole path', () => {
  const table: [string, string, boolean][] = [
    ['src/routes/**', 'src/routes/a.ts', true],
    ['src/routes/**', 'src/routes/deep/er/a.ts', true],
    ['src/routes/**', 'src/other/a.ts', false],
    ['src/**/a.ts', 'src/a.ts', true],
    ['src/**/a.ts', 'src/x/y/a.ts', true],
    ['src/*.ts', 'src/a.ts', true],
    ['src/*.ts', 'src/x/a.ts', false],
    ['a?.ts', 'ab.ts', true],
    ['a?.ts', 'a/.ts', false],
    ['routes.ts', 'src/routes.ts', false],
    ['**/routes.ts', 'routes.ts', true],
    ['**/routes.ts', 'src/routes.ts', true],
    ['src/a.ts', 'src/axts', false],
    ['src/routes/**', './src/routes/a.ts', true],
  ]
  for (const [glob, path, want] of table) expect([glob, path, globMatches(glob, path)]).toEqual([glob, path, want])
})

test('guardTestsFor: each test once, with every glob and file that triggered it, in map order', () => {
  const hits = guardTestsFor(['src/routes/a.ts', 'src/routes/b.ts', 'README.md', 'src/routes/a.ts'], MAP)
  expect(hits).toEqual([{ test: 'test/admin.test.ts', globs: ['src/routes/**', 'src/**'], files: ['src/routes/a.ts', 'src/routes/b.ts'] }])
  expect(guardTestsFor(['README.md'], MAP)).toEqual([])
  expect(guardTestsFor(['sql/001.sql', 'src/x.ts'], MAP).map(h => h.test)).toEqual(['test/migrations.test.ts', 'test/admin.test.ts'])
  // A deleted file is just a path in the diff: it matches like any other.
  expect(guardTestsFor(['src/routes/gone.ts'], MAP)).toHaveLength(1)
})

test('parseGuardTests accepts an object or a JSON string and rejects other shapes', () => {
  expect(parseGuardTests({ 'a/**': ['t', 't', ' '] })).toEqual({ 'a/**': ['t'] })
  expect(parseGuardTests('{"a/**":["t"]}')).toEqual({ 'a/**': ['t'] })
  for (const bad of [['x'], 'not json', 5, null, { 'a/**': 'test' }, { 'a/**': [1] }]) expect(parseGuardTests(bad)).toBeUndefined()
})

test('settings: the personal map merges per glob with the repo map; bad shapes are warned and dropped', () => {
  const r = mergeLayers({}, [
    { path: 'repo', text: JSON.stringify({ guard_tests: { 'src/**': ['a', 'b'], 'sql/**': ['m'] } }) },
    { path: 'personal', text: JSON.stringify({ guard_tests: { 'src/**': ['b', 'c'], 'ui/**': ['u'] } }) },
  ])
  expect(r.raw.guard_tests).toEqual({ 'src/**': ['a', 'b', 'c'], 'sql/**': ['m'], 'ui/**': ['u'] })
  expect(r.warnings).toEqual([])

  const bad = mergeLayers({ guard_tests: '{"x/**":["t"]}' }, [
    { path: 'repo', text: JSON.stringify({ guard_tests: { 'src/**': 'oops' } }) },
    { path: 'personal', text: JSON.stringify({ guard_tests: ['nope'] }) },
  ])
  expect(bad.raw.guard_tests).toEqual({ 'x/**': ['t'] })
  expect(bad.warnings.filter(w => w.includes('"guard_tests"'))).toHaveLength(2)
  expect(mergeGuardTests({ a: ['1'] }, { a: ['1', '2'] })).toEqual({ a: ['1', '2'] })
})

const BODY = (ran: string[]) => `## Verification\nRan:\n${ran.map(r => `- ${r}`).join('\n')}\nExercised: ran it\nNot verified:\n- deploy`

test('checkEvidence: a guard test must appear under Ran, backticks optional, and the refusal names the globs', () => {
  const guard = guardTestsFor(['src/routes/a.ts'], MAP)
  const missing = checkEvidence(BODY(['`npm test`: pass']), [], guard)
  expect('problems' in missing && missing.problems).toEqual(['guard test `test/admin.test.ts` (for `src/routes/**`, `src/**`) does not appear under `Ran:`'])
  expect('evidence' in checkEvidence(BODY(['`node --test test/admin.test.ts`: pass']), [], guard)).toBe(true)
  expect('evidence' in checkEvidence(BODY(['node --test test/admin.test.ts: pass']), [], guard)).toBe(true)
  expect('evidence' in checkEvidence(BODY(['npm test: pass']), [], [])).toBe(true)
})

test('suggestions: the deepest common directory of the non-test files, else top-level directories (at most 3)', () => {
  expect(suggestGlobs(['src/routes/a.ts', 'src/routes/b.ts', 'test/admin.test.ts'], 'test/admin.test.ts')).toEqual(['src/routes/**'])
  expect(suggestGlobs(['src/routes/a.ts', 'src/db/b.ts'], 'test/x.test.ts')).toEqual(['src/**'])
  expect(suggestGlobs(['a/x.ts', 'b/y.ts', 'c/z.ts', 'd/w.ts'], 't')).toEqual(['a/**', 'b/**', 'c/**'])
  expect(suggestGlobs(['README.md'], 't')).toEqual([])
  // Only test files changed: they are used rather than nothing.
  expect(suggestGlobs(['test/a.test.ts', 'test/b.test.ts'], 'test/other.test.ts')).toEqual(['test/**'])
})

test('suggestionsFor skips a failed test the map already requires for these files', () => {
  const files = ['src/routes/a.ts', 'src/routes/b.ts']
  expect(suggestionsFor(files, ['test/admin.test.ts'], MAP)).toEqual([])
  expect(suggestionsFor(files, ['test/other.test.ts', 'test/other.test.ts'], MAP)).toEqual([{ test: 'test/other.test.ts', glob: 'src/routes/**', files }])
})

// ---- through the plugin ----

const DIR = '/r/.git/flow'
// Plugin options carry strings only, so /config passes the map as JSON.
const OPTS = { guard_tests: JSON.stringify({ 'src/routes/**': ['test/admin.test.ts'] }) }
const out = (stdout = '', exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })

function world(on: On, body: string, gh: { diff?: string[]; diffFails?: boolean } = {}) {
  mock.clock(on, { now: 1_000_000 })
  const agents: AgentInfo[] = [
    { id: 'm1', name: 'csv-export', description: 'm', type: 'flow:manager', status: 'running' },
    { id: 'w1', name: 'csv-worker', description: 'w', type: 'flow:worker', status: 'running', parentId: 'm1' },
  ]
  const files = new Map<string, string>()
  const calls: string[] = []
  on('agent.list', () => ({ value: agents }))
  on('agent.spawn', (_, e) => {
    const input = e as unknown as { subagent_type?: string; subagentType?: string; name?: string; description: string }
    agents.push({ id: 'q1', name: input.name ?? 'merge-queue-1', description: input.description, type: input.subagent_type ?? input.subagentType ?? '', status: 'running' })
    return { model: 'sonnet', agentId: 'q1' }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.send', () => ({ isDelivered: true as const }))
  on('session.cwd', () => ({ value: '/r' }) as never)
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('fs.read', (_, e) => {
    const t = files.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('process.run', (_, e) => {
    const a = e.argv
    calls.push(a.join(' '))
    if (a[0] === 'git' && a[1] === 'rev-parse') return out(a.includes('--show-toplevel') ? '/r\n' : '/r/.git\n')
    if (a[0] === 'git' && a[1] === 'worktree') return out('worktree /r/.claude/worktrees/agent-w1\nHEAD abc\nbranch refs/heads/flow/csv-worker\n')
    if (a[0] === 'git' && a.includes('diff')) return out('src/routes/a.ts\nREADME.md\n')
    if (a[0] === 'git' && a.includes('status')) return out(' M sql/001.sql\n?? test/new.test.ts\nR  old.ts -> src/routes/new.ts\n')
    if (a[0] === 'gh' && a[2] === 'view') return out(JSON.stringify({ state: 'OPEN', isDraft: false, headRefOid: 'abc1234def', headRefName: 'flow/csv', title: 'T', body }))
    if (a[0] === 'gh' && a[2] === 'diff') return gh.diffFails ? out('', 1, 'HTTP 502') : out((gh.diff ?? ['src/routes/a.ts', 'src/routes/b.ts']).join('\n') + '\n')
    if (a[0] === 'mv') {
      const t = files.get(a[1] ?? '')
      if (t !== undefined) { files.set(a[2] ?? '', t); files.delete(a[1] ?? '') }
    }
    return out()
  })
  return { agents, files, calls }
}

const guardTool = ($: Dollar, extra: Record<string, unknown> = {}) =>
  $.tool.call({ tool: 'mcp__flow__guard_tests', agentId: 'w1', ...extra } as never).then(r => String(r.result))
const handover = ($: Dollar) => $.tool.call({ tool: 'mcp__flow__handover', pr: 7, report_to: 'csv-export', agentId: 'm1' } as never).then(r => String(r.result))
const back = ($: Dollar, extra: Record<string, unknown> = {}) =>
  $.tool.call({ tool: 'mcp__flow__queue', action: 'back', pr: 7, reason: 'test failed', agentId: 'q1', ...extra } as never).then(r => String(r.result))
const inbox = ($: Dollar) => $.command.run({ command: 'flow', args: 'inbox' } as never).then(r => r.text ?? '')

test('guard_tests tool: not configured', async ($, on) => {
  world(on, '')
  expect(await guardTool($)).toBe('guard_tests is not configured: no guard tests to run.')
})

test('guard_tests tool: with files, lists the test, the glob and the files; no match says so', { options: OPTS }, async ($, on) => {
  world(on, '')
  const r = await guardTool($, { files: ['src/routes/a.ts', 'README.md'] })
  expect(r).toContain('`test/admin.test.ts` (for `src/routes/**`: src/routes/a.ts)')
  expect(r).toContain('mcp__flow__test_slot')
  expect(r).toContain('`Ran:`')
  expect(await guardTool($, { files: ['README.md'] })).toBe('No guard tests match your diff.')
})

test('guard_tests tool: with no input it diffs the caller\'s worktree plus uncommitted and renamed files', { options: OPTS }, async ($, on) => {
  const w = world(on, '')
  const r = await guardTool($)
  expect(r).toContain('`test/admin.test.ts`')
  expect(r).toContain('src/routes/a.ts')
  expect(r).toContain('src/routes/new.ts')
  expect(w.calls).toContain('git -C /r/.claude/worktrees/agent-w1 diff --name-only --no-renames origin/main...HEAD')
  expect(w.calls.some(c => c.startsWith('git -C /r/.claude/worktrees/agent-w1 status'))).toBe(true)
})

test('handover: a missing guard test is refused naming the glob; listing it lets it through; same answer twice', { options: OPTS }, async ($, on) => {
  const w = world(on, '## Verification\nRan:\n- `npm test`: pass\nExercised: ran it\nNot verified:\n- deploy')
  const r = await handover($)
  expect(r).toMatch(/^Refused:/)
  expect(r).toContain('guard test `test/admin.test.ts` (for `src/routes/**`) does not appear under `Ran:`')
  expect(await handover($)).toBe(r)
  expect(w.calls).toContain('gh pr diff 7 --name-only')
})

test('handover: the guard test under Ran passes', { options: OPTS }, async ($, on) => {
  world(on, '## Verification\nRan:\n- `node --test test/admin.test.ts`: pass\nExercised: ran it\nNot verified:\n- deploy')
  expect(await handover($)).toContain('Handed over PR #7')
})

test('handover: a PR that touches no guarded path, or no guard_tests at all, is unchanged', async ($, on) => {
  const w = world(on, '## Verification\nRan:\n- `npm test`: pass\nExercised: ran it\nNot verified:\n- deploy')
  expect(await handover($)).toContain('Handed over PR #7')
  expect(w.calls.some(c => c.startsWith('gh pr diff'))).toBe(false)
})

test('handover: no guarded files in the diff passes', { options: OPTS }, async ($, on) => {
  world(on, '## Verification\nRan:\n- `npm test`: pass\nExercised: ran it\nNot verified:\n- deploy', { diff: ['README.md'] })
  expect(await handover($)).toContain('Handed over PR #7')
})

test('handover: a failing gh pr diff refuses with its error', { options: OPTS }, async ($, on) => {
  world(on, '## Verification\nRan:\n- `node --test test/admin.test.ts`: pass\nExercised: ran it\nNot verified:\n- deploy', { diffFails: true })
  const r = await handover($)
  expect(r).toMatch(/^Refused: gh pr diff 7 --name-only failed/)
  expect(r).toContain('HTTP 502')
})

const OKBODY = '## Verification\nRan:\n- `npm test`: pass\nExercised: ran it\nNot verified:\n- deploy'

test('queue back with failed_tests files one question to main; again for the same test files no duplicate', async ($, on) => {
  world(on, OKBODY)
  expect(await handover($)).toContain('Handed over')
  const r = await back($, { failed_tests: ['test/admin.test.ts'] })
  expect(r).toContain('PR #7: returned.')
  expect(r).toContain('Asked main')
  const box = await inbox($)
  expect(box).toContain('PR #7 was sent back: `test/admin.test.ts` failed. It changed src/routes/a.ts, src/routes/b.ts.')
  expect(box).toContain('{"src/routes/**":["test/admin.test.ts"]}')
  expect(box).toContain('[guard-tests]')
  expect(box).toContain('non-blocking')
  expect(box).toContain('a) Add it to my personal flow config')
  expect(box).toContain('b) No  (default)')
  // The queue sends it back again.
  expect(await back($, { failed_tests: ['test/admin.test.ts'] })).not.toContain('Asked main')
  expect((await inbox($)).match(/was sent back/g)).toHaveLength(1)
})

test('queue back: no failed_tests, or a test the map already requires, files nothing', { options: OPTS }, async ($, on) => {
  world(on, '## Verification\nRan:\n- `node --test test/admin.test.ts`: pass\nExercised: ran it\nNot verified:\n- deploy')
  await handover($)
  expect(await back($)).toBe('PR #7: returned.')
  expect(await back($, { failed_tests: ['test/admin.test.ts'] })).toBe('PR #7: returned.')
  expect(await inbox($)).toBe('No open questions.')
})

test('queue back: a failing gh pr diff is noted, the send-back stands', async ($, on) => {
  const gh = { diffFails: false }
  world(on, OKBODY, gh)
  await handover($)
  gh.diffFails = true
  const r = await back($, { failed_tests: ['test/admin.test.ts'] })
  expect(r).toContain('PR #7: returned.')
  expect(r).toContain('No guard suggestion')
})

test('answering Add writes the personal config (merged, no duplicates) and tells main to share it; No only records', async ($, on) => {
  const w = world(on, OKBODY)
  const personal = `${DIR}/config.json`
  w.files.set(personal, JSON.stringify({ worker_model: 'opus', guard_tests: { 'sql/**': ['m.test.ts'], 'src/routes/**': ['other.test.ts'] } }))
  await handover($)
  await back($, { failed_tests: ['test/admin.test.ts'] })
  const r = await $.tool.call({ tool: 'mcp__flow__answer', answers: [{ id: 'q1', choice: 'a' }] } as never).then(x => String(x.result))
  expect(r).toContain('q1: Add it to my personal flow config')
  expect(r).toContain('copy it into .claude/flow.json')
  const cfg = JSON.parse(w.files.get(personal) ?? '{}') as Record<string, unknown>
  expect(cfg.worker_model).toBe('opus')
  expect(cfg.guard_tests).toEqual({ 'sql/**': ['m.test.ts'], 'src/routes/**': ['other.test.ts', 'test/admin.test.ts'] })
  expect(w.files.has('/r/.claude/flow.json')).toBe(false)

  // Same suggestion again, answered Add again: already there, nothing duplicated.
  await back($, { failed_tests: ['test/admin.test.ts'] })
  const again = await $.tool.call({ tool: 'mcp__flow__answer', answers: [{ id: 'q2', choice: 'Add it to my personal flow config' }] } as never).then(x => String(x.result))
  expect(again).toContain('Already in')
  expect((JSON.parse(w.files.get(personal) ?? '{}') as { guard_tests: Record<string, string[]> }).guard_tests['src/routes/**']).toEqual(['other.test.ts', 'test/admin.test.ts'])

  await back($, { failed_tests: ['test/second.test.ts'] })
  const no = await $.tool.call({ tool: 'mcp__flow__answer', answers: [{ id: 'q3', choice: 'No' }] } as never).then(x => String(x.result))
  expect(no).toContain('q3: No')
  expect(JSON.stringify(JSON.parse(w.files.get(personal) ?? '{}'))).not.toContain('second.test.ts')
})
