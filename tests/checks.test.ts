import { expect, test } from 'claude-code/testing'
import {
  addChecks, anyMatch, closeChecks, compareVersions, dueForPrompt, EMPTY_CHECKS, groupOpen, inboxChecksSection, markStarted, normalizeChecks, paneChecksLine,
  parseNeeds, renderCheckDetail, renderChecksForAgents, renderChecksTable, versionInSteps,
} from '../hooks/checks'
import type { Checks } from '../hooks/checks'

const seed = (): Checks => addChecks(EMPTY_CHECKS, 37, 'Title 37', 'abc', [
  { steps: 'install 0.3.31, restart, look at the pane', version: '0.3.31' },
  { steps: 'open the dashboard', version: '0.3.29' },
  { steps: 'talk to it' },
  { steps: 'install 0.3.30 and check', version: '0.3.30' },
], 1000).checks

test('parseNeeds reads each line, stops at the field separator and the end of the line', () => {
  const r = 'full check: 3 passed | after_deploy: needs a person: PR #37: install 0.3.31, look at pane | pending decisions: none\nneeds a person: PR #34: try it'
  expect(parseNeeds(r)).toEqual([{ pr: 37, steps: 'install 0.3.31, look at pane' }, { pr: 34, steps: 'try it' }])
  expect(parseNeeds('after_deploy: passed')).toEqual([])
  expect(parseNeeds(undefined)).toEqual([])
})

test('versionInSteps prefers "install X" and falls back to any version', () => {
  expect(versionInSteps('see 0.1.2 then install 0.3.31')).toBe('0.3.31')
  expect(versionInSteps('on 0.3.30 try it')).toBe('0.3.30')
  expect(versionInSteps('no version')).toBeUndefined()
})

test('compareVersions is numeric per part', () => {
  expect(compareVersions('0.3.9', '0.3.10')).toBeLessThan(0)
  expect(compareVersions('1.0.0', '0.9.9')).toBeGreaterThan(0)
  expect(compareVersions('0.3.31', '0.3.31')).toBe(0)
})

test('the same PR and steps are never added twice, whatever the case or spacing', () => {
  const a = addChecks(EMPTY_CHECKS, 5, 't', 'x', [{ steps: 'Look  at it.' }], 1)
  expect(a.added.map(c => c.id)).toEqual(['c1'])
  const b = addChecks(a.checks, 5, 't', 'x', [{ steps: 'look at it' }, { steps: 'another' }], 2)
  expect(b.added.map(c => c.id)).toEqual(['c2'])
  expect(addChecks(b.checks, 6, 't', 'x', [{ steps: 'look at it' }], 3).added.length).toBe(1)
})

test('groups: newer than installed per version ascending, ready, no version, unknown', () => {
  const g = groupOpen(seed(), '0.3.29')
  expect(g.install.map(x => x.version)).toEqual(['0.3.30', '0.3.31'])
  expect(g.ready.map(c => c.id)).toEqual(['c2'])
  expect(g.none.map(c => c.id)).toEqual(['c3'])
  const u = groupOpen(seed(), undefined)
  expect(u.unknown.length).toBe(3)
  expect(u.install.length).toBe(0)
  const text = renderChecksForAgents(seed(), '0.3.30')
  expect(text).toContain('Needs install of 0.3.31 and a restart:')
  expect(text).toContain('Ready on the installed version 0.3.30:')
  expect(text).toContain('No version:')
  expect(text.indexOf('Needs install')).toBeLessThan(text.indexOf('Ready on'))
})

test('pane and inbox lines count open checks and follow-ups, and are empty when there are none', () => {
  expect(paneChecksLine(EMPTY_CHECKS, '1.0.0')).toBeUndefined()
  expect(inboxChecksSection(EMPTY_CHECKS, '1.0.0')).toEqual([])
  expect(paneChecksLine(seed(), '0.3.30')).toBe('4 checks to try by hand (1 wait for 0.3.31 to be installed). /flow checks lists them')
})

test('closing: pass, fail needs a note and makes a follow-up, closed ones are refused, started marks the follow-up', () => {
  const c = seed()
  const p = closeChecks(c, ['c1', 'c2'], 'pass', 'main', undefined, 5)
  expect('checks' in p && p.checks.items.filter(x => x.state === 'passed').map(x => x.closedBy)).toEqual(['main', 'main'])
  expect(closeChecks(c, ['c1'], 'fail', 'main', ' ', 5)).toEqual({ error: 'a failed check needs a note: what went wrong.' })
  const f = closeChecks(c, ['c3'], 'fail', 'main', 'broke', 5)
  if (!('checks' in f)) throw new Error('expected a close')
  expect(f.text).toContain('Start a manager on the follow-up')
  expect(f.checks.items[2]!.followUp).toEqual({ state: 'open' })
  expect(renderChecksForAgents(f.checks, '0.3.30')).toContain('Open follow-ups from failed checks:')
  expect('error' in closeChecks(f.checks, ['c3'], 'pass', 'main', undefined, 6)).toBe(true)
  expect((closeChecks(f.checks, ['c3'], 'pass', 'main', undefined, 6) as { error: string }).error).toContain('already failed')
  expect('error' in closeChecks(c, ['c9'], 'pass', 'main', undefined, 6)).toBe(true)
  const s = markStarted(f.checks, 'c3', 'fixer')
  if (!('checks' in s)) throw new Error('expected started')
  expect(s.checks.items[2]!.followUp).toEqual({ state: 'started', manager: 'fixer' })
  expect('error' in markStarted(s.checks, 'c3', 'x')).toBe(true)
  expect('error' in markStarted(c, 'c1', 'x')).toBe(true)
})

test('the queue may close only checks with a verify command', () => {
  const c = addChecks(EMPTY_CHECKS, 1, 't', 'x', [{ steps: 'a', verifyCommand: 'npm run smoke' }, { steps: 'b' }], 1).checks
  expect(renderChecksForAgents(c, undefined)).toContain('(scripted: npm run smoke)')
  expect('checks' in closeChecks(c, ['c1'], 'pass', 'flow-queue', 'ok', 2, true)).toBe(true)
  expect((closeChecks(c, ['c2'], 'pass', 'flow-queue', 'ok', 2, true) as { error: string }).error).toContain('only main')
})

test('verify_paths globs: ** crosses directories, * does not', () => {
  expect(anyMatch(['migrations/**'], ['src/a.ts', 'migrations/2026/x.sql'])).toBe(true)
  expect(anyMatch(['migrations/*.sql'], ['migrations/2026/x.sql'])).toBe(false)
  expect(anyMatch(['src/**/*.ts'], ['src/a/b.ts'])).toBe(true)
  expect(anyMatch(['db/**'], ['src/a.ts'])).toBe(false)
})

test('the post-update prompt is due once per installed version, for checks the version covers', () => {
  const c = seed()
  expect(dueForPrompt(c, undefined)).toEqual([])
  expect(dueForPrompt(c, '0.3.30').map(x => x.id)).toEqual(['c2', 'c4'])
  expect(dueForPrompt({ ...c, promptedVersion: '0.3.30' }, '0.3.30')).toEqual([])
})

test('normalizeChecks drops bad items, keeps known fields and continues the ids', () => {
  const r = normalizeChecks({ next: 1, promptedVersion: '1.0.0', items: [
    { id: 'c4', pr: 1, steps: 's', state: 'failed', note: 'n', extra: 1 }, { id: 'x' }, 'no', { id: 'c2', pr: 2, steps: 't', state: 'bogus' },
  ] })
  expect(r.items.length).toBe(1)
  expect(r.items[0]).toMatchObject({ id: 'c4', kind: 'check', note: 'n', followUp: { state: 'open' } })
  expect('extra' in r.items[0]!).toBe(false)
  expect(r.next).toBe(5)
  expect(r.promptedVersion).toBe('1.0.0')
  expect(normalizeChecks('garbage')).toEqual({ next: 1, items: [] })
})

test('the table has one row per open check in groups, never wraps, and drops age then needs when narrow', () => {
  const long = addChecks(seed(), 79, 'Less re-sent text: scoped status, stable-first session prompt, deferred tools', 'a', [{ steps: 'x '.repeat(200), version: '0.3.31' }], 1000).checks
  const now = 1000 + 3 * 86_400_000
  for (const width of [100, 50, 40]) {
    const t = renderChecksTable(long, '0.3.30', width, now)
    for (const l of t.split('\n')) expect(l.length).toBeLessThanOrEqual(width)
    expect(t).not.toContain('mcp__')
    expect(t.indexOf('Try now')).toBeGreaterThan(-1)
    expect(t.indexOf('Try now')).toBeLessThan(t.indexOf('Needs install of 0.3.31'))
    for (const id of ['c1', 'c2', 'c3', 'c4', 'c5']) expect(t).toContain(id)
  }
  const wide = renderChecksTable(long, '0.3.30', 100, now)
  expect(wide).toMatch(/c5\s+#79\s+Less re-sent text.*…\s+install 0.3.31\s+3d/)
  // Too long for one line at 100: one command per line; at a wide terminal they share a line.
  expect(wide).toContain('Pass: /flow checks pass c2 c3\nFail: /flow checks fail c1 <what you saw>\nSkip: /flow checks skip c1 <why>\nDetails: /flow checks c1')
  expect(renderChecksTable(long, '0.3.30', 140, now)).toContain('Pass: /flow checks pass c2 c3 · Fail: /flow checks fail c1 <what you saw> · Skip: /flow checks skip c1 <why> · Details: /flow checks c1')
  expect(renderChecksTable(long, undefined, 100, now)).toContain('Version unknown')
  expect(renderChecksTable(EMPTY_CHECKS, '1.0.0', 100, 1)).toBe('No open checks.')
})

test('failed checks with an open follow-up get their own section; an empty title shows PR only', () => {
  const c = addChecks(EMPTY_CHECKS, 5, '', 'a', [{ steps: 'a' }, { steps: 'b' }], 1).checks
  const f = closeChecks(c, ['c2'], 'fail', 'user', 'blank page', 5)
  if (!('checks' in f)) throw new Error('expected a close')
  const t = renderChecksTable(f.checks, '1.0.0', 80, 100)
  expect(t).toContain('Failed, follow-up open')
  expect(t).toMatch(/c2\s+#5\s+failed: blank page · PR #5/)
  expect(t).not.toContain('start a manager')
})

test('detail view shows everything for one check, and unknown ids say so', () => {
  const c = addChecks(EMPTY_CHECKS, 7, 'T', 'a', [{ steps: 'step one then two', version: '0.3.31', verifyCommand: 'npm run smoke' }], 1).checks
  const d = renderCheckDetail(c, 'c1', '0.3.30', 60_000)
  expect(d).toContain('c1: PR #7 T')
  expect(d).toContain('Version: 0.3.31 (not installed yet)')
  expect(d).toContain('Steps: step one then two')
  expect(d).toContain('Verify command: npm run smoke')
  expect(d).toContain('Skip: /flow checks skip c1 <why>')
  expect(renderCheckDetail(c, 'c8', undefined, 1)).toBe('c8: no such check.')
})

test('skip closes without a follow-up, needs a reason, refuses closed ids and survives a reload', () => {
  const c = seed()
  expect(closeChecks(c, ['c1'], 'skip', 'user', ' ', 5)).toEqual({ error: 'a skipped check needs a reason: why it no longer applies.' })
  const s = closeChecks(c, ['c1', 'c2'], 'skip', 'user', 'superseded', 5)
  if (!('checks' in s)) throw new Error('expected a close')
  expect(s.text).toBe('Skipped: c1, c2.')
  expect(s.failed).toBeUndefined()
  expect(s.checks.items[0]).toMatchObject({ state: 'skipped', note: 'superseded', closedBy: 'user' })
  expect(s.checks.items[0]!.followUp).toBeUndefined()
  expect((closeChecks(s.checks, ['c1'], 'skip', 'user', 'again', 6) as { error: string }).error).toContain('already skipped')
  expect('error' in closeChecks(c, ['c1', 'c9'], 'skip', 'user', 'x', 5)).toBe(true)
  expect('error' in closeChecks(c, ['c1'], 'skip', 'q', 'x', 5, true)).toBe(true)
  expect(normalizeChecks(JSON.parse(JSON.stringify(s.checks))).items[0]!.state).toBe('skipped')
  expect(addChecks(s.checks, 37, 'Title 37', 'abc', [{ steps: 'install 0.3.31, restart, look at the pane' }], 9).added).toEqual([])
})
