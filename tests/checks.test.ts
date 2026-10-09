import { expect, test } from 'claude-code/testing'
import {
  addChecks, anyMatch, closeChecks, compareVersions, dueForPrompt, EMPTY_CHECKS, groupOpen, inboxChecksSection, markStarted, normalizeChecks, paneChecksLine,
  parseNeeds, renderChecks, versionInSteps,
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
  const text = renderChecks(seed(), '0.3.30')
  expect(text).toContain('Needs install of 0.3.31 and a restart:')
  expect(text).toContain('Ready on the installed version 0.3.30:')
  expect(text).toContain('No version:')
  expect(text.indexOf('Needs install')).toBeLessThan(text.indexOf('Ready on'))
})

test('pane and inbox lines count open checks and follow-ups, and are empty when there are none', () => {
  expect(paneChecksLine(EMPTY_CHECKS, '1.0.0')).toBeUndefined()
  expect(inboxChecksSection(EMPTY_CHECKS, '1.0.0')).toEqual([])
  expect(paneChecksLine(seed(), '0.3.30')).toBe('Checks: 4 open (1 need install of 0.3.31)')
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
  expect(renderChecks(f.checks, '0.3.30')).toContain('Open follow-ups from failed checks:')
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
  expect(renderChecks(c, undefined)).toContain('(scripted: npm run smoke)')
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
