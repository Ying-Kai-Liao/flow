import { expect } from 'claude-code/testing'
import { test } from './support'

import { deleteMergedBranch } from '../hooks/branchdelete'
import { remoteDeleteRefusal } from '../hooks/guards'
import { NO_FAILS, noteRelease, withFailed, withFlaky } from '../hooks/testfail'
import type { GitRunner, Run } from '../hooks/mainff'

const res = (stdout = '', exitCode = 0, stderr = ''): Run => ({ exitCode, stdout, stderr })
const TIP = 'a'.repeat(40)

function fake(o: { ls?: Run; fetch?: Run; anc?: Run; push?: Run } = {}) {
  const calls: string[][] = []
  const git: GitRunner = async argv => {
    calls.push(argv)
    if (argv[1] === 'ls-remote') return o.ls ?? res(`${TIP}\trefs/heads/flow/x\n`)
    if (argv[1] === 'fetch') return o.fetch ?? res()
    if (argv[1] === 'merge-base') return o.anc ?? res()
    if (argv[1] === 'push') return o.push ?? res()
    return res()
  }
  return { git, calls, pushed: () => calls.some(c => c[1] === 'push') }
}

test('a merged branch is deleted with a lease on its tip', async () => {
  const f = fake()
  expect(await deleteMergedBranch(f.git, 'flow/x', 'main')).toBe('branch flow/x deleted')
  expect(f.calls.find(c => c[1] === 'push')).toEqual(['git', 'push', `--force-with-lease=refs/heads/flow/x:${TIP}`, 'origin', ':refs/heads/flow/x'])
})

test('a branch not in origin/base is kept and nothing is pushed', async () => {
  const f = fake({ anc: res('', 1) })
  expect(await deleteMergedBranch(f.git, 'flow/x', 'main')).toBe('branch flow/x kept: not merged into origin/main')
  expect(f.pushed()).toBe(false)
})

test('a moved branch (lease rejected) is kept', async () => {
  const f = fake({ push: res('', 1, 'stale info') })
  expect(await deleteMergedBranch(f.git, 'flow/x', 'main')).toBe('branch flow/x kept: push failed: stale info')
})

test('a branch already gone from the remote', async () => {
  const f = fake({ ls: res('') })
  expect(await deleteMergedBranch(f.git, 'flow/x', 'main')).toBe('branch flow/x already gone')
  expect(f.pushed()).toBe(false)
})

test('a failing fetch, ls-remote or ancestry check keeps the branch', async () => {
  expect(await deleteMergedBranch(fake({ fetch: res('', 128, 'no network') }).git, 'flow/x', 'main')).toBe('branch flow/x kept: fetch failed: no network')
  expect(await deleteMergedBranch(fake({ ls: res('', 128, 'down') }).git, 'flow/x', 'main')).toBe('branch flow/x kept: ls-remote failed: down')
  const f = fake({ anc: res('', 128, 'bad object') })
  expect(await deleteMergedBranch(f.git, 'flow/x', 'main')).toBe('branch flow/x kept: ancestry check failed: bad object')
  expect(f.pushed()).toBe(false)
})

test('never the base branch, an empty branch or an odd name; a throwing runner does not throw', async () => {
  const f = fake()
  expect(await deleteMergedBranch(f.git, 'main', 'main')).toBe('branch main kept: it is the base branch')
  expect(await deleteMergedBranch(f.git, undefined, 'main')).toBe('branch ? kept: no branch recorded')
  expect(await deleteMergedBranch(f.git, '--all', 'main')).toBe('branch --all kept: not a plain branch name')
  expect(f.calls).toEqual([])
  const boom: GitRunner = async () => { throw new Error('spawn failed') }
  expect(await deleteMergedBranch(boom, 'flow/x', 'main')).toBe('branch flow/x kept: delete failed: spawn failed')
})

test('the guard refuses every remote-delete form, alone or in a chain', () => {
  for (const cmd of [
    'git push origin --delete flow/x', 'git push -d origin flow/x', 'git push origin :flow/x', 'git push origin :refs/heads/flow/x',
    'git push origin HEAD:main && git push origin --delete flow/x', 'git -C /w push origin --delete x', 'sh -c "git push origin :x"', 'echo $(git push origin -d x)',
  ]) expect([cmd, remoteDeleteRefusal(cmd)?.includes('"done"')]).toEqual([cmd, true])
})

test('the guard allows the reviewer\'s normal pushes', () => {
  for (const cmd of [
    'git push origin HEAD:main', 'git push origin v1.2.3', 'git push -u origin HEAD', 'git push origin HEAD:flow/x', 'git push origin HEAD:main && git tag x',
    'git push --force-with-lease=refs/heads/x:abc origin HEAD:x', 'echo "git push origin --delete x"', 'git branch -d x',
  ]) expect([cmd, remoteDeleteRefusal(cmd)]).toEqual([cmd, undefined])
})

test('a failed run is recorded with its names; a pass on the same label after it is flaky', () => {
  const failed = noteRelease(NO_FAILS, 'a1', 'full check', 'fail', ['t one', ' t two ', 't one'])
  expect(failed.event).toEqual({ kind: 'tests-failed', text: 'full check: failed: t one, t two' })
  expect(failed.answer).toContain('t one, t two')
  const other = noteRelease(failed.state, 'a1', 'other label', 'pass', undefined)
  expect(other.event).toBeUndefined()
  const other2 = noteRelease(failed.state, 'a2', 'full check', 'pass', undefined)
  expect(other2.event).toBeUndefined()
  const passed = noteRelease(failed.state, 'a1', 'full check', 'pass', undefined)
  expect(passed.event).toEqual({ kind: 'flaky', text: 'full check: flaky: t one, t two' })
  expect(passed.answer).toBe('flaky: t one, t two (failed, passed on rerun): name it in your report as flaky: <test>.')
  expect(passed.state.flaky).toEqual({ a1: ['t one', 't two'] })
  expect(noteRelease(passed.state, 'a1', 'full check', 'pass', undefined).event).toBeUndefined()
})

test('a fail without names still records and asks for the names in the report', () => {
  const n = noteRelease(NO_FAILS, 'a1', 'tests', 'fail', undefined)
  expect(n.event?.text).toBe('tests: fail (names not given)')
  expect(n.answer).toContain('in your report')
  expect(noteRelease(n.state, 'a1', 'tests', 'pass', undefined).event?.kind).toBe('flaky')
  expect(noteRelease(NO_FAILS, 'a1', 'tests', undefined, undefined)).toEqual({ state: NO_FAILS, answer: '' })
})

test('flaky names are appended to a report once; failed names go into a back reason', () => {
  expect(withFlaky('full check: 9 passed', ['t one'])).toBe('full check: 9 passed | flaky: t one')
  expect(withFlaky('full check: 9 passed | flaky: t one', ['t one'])).toBe('full check: 9 passed | flaky: t one')
  expect(withFlaky('ok', undefined)).toBe('ok')
  expect(withFailed('tests failed', ['a', 'b'])).toBe('tests failed | failed: a, b')
  expect(withFailed('tests failed', undefined)).toBe('tests failed')
})
