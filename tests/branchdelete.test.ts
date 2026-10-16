import { expect } from 'claude-code/testing'
import { test } from './support'

import { deleteMergedBranch } from '../hooks/branchdelete'
import { remoteDeleteRefusal } from '../hooks/guards'
import { NO_FAILS, needsTree, noteRelease, runTree, withFailed, withFlaky } from '../hooks/testfail'
import type { CallerDirIo, TestFails } from '../hooks/testfail'
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

test('a failed run is recorded with its names; a pass on the same label and sha after it is flaky', () => {
  const failed = noteRelease(NO_FAILS, 'a1', 'full check', 'fail', ['t one', ' t two ', 't one'], 'abc1234')
  expect(failed.event).toEqual({ kind: 'tests-failed', text: 'full check: failed: t one, t two' })
  expect(failed.answer).toContain('t one, t two')
  const other = noteRelease(failed.state, 'a1', 'other label', 'pass', undefined, 'abc1234')
  expect(other.event).toBeUndefined()
  const other2 = noteRelease(failed.state, 'a2', 'full check', 'pass', undefined, 'abc1234')
  expect(other2.event).toBeUndefined()
  const passed = noteRelease(failed.state, 'a1', 'full check', 'pass', undefined, 'abc1234')
  expect(passed.event).toEqual({ kind: 'flaky', text: 'full check: flaky: t one, t two' })
  expect(passed.answer).toBe('flaky: t one, t two (failed, passed on rerun): name it in your report as flaky: <test>.')
  expect(passed.state.flaky).toEqual({ a1: ['t one', 't two'] })
  expect(noteRelease(passed.state, 'a1', 'full check', 'pass', undefined, 'abc1234').event).toBeUndefined()
  // A short and a full sha of the same commit are the same tree.
  expect(noteRelease(failed.state, 'a1', 'full check', 'pass', undefined, 'abc1234def5678').event?.kind).toBe('flaky')
})

test('a fail without names still records and asks for the names in the report', () => {
  const n = noteRelease(NO_FAILS, 'a1', 'tests', 'fail', undefined, 'abc1234')
  expect(n.event?.text).toBe('tests: fail (names not given)')
  expect(n.answer).toContain('in your report')
  expect(noteRelease(n.state, 'a1', 'tests', 'pass', undefined, 'abc1234').event?.kind).toBe('flaky')
  expect(noteRelease(NO_FAILS, 'a1', 'tests', undefined, undefined)).toEqual({ state: NO_FAILS, answer: '' })
})

test('a pass on a different tree than the failure is a fix, not flaky', () => {
  const failed = noteRelease({ ...NO_FAILS, flaky: { a1: ['old'] } }, 'a1', 'tests', 'fail', ['t one'], 'abc1234aaaa')
  const passed = noteRelease(failed.state, 'a1', 'tests', 'pass', undefined, 'def5678bbbb')
  expect(passed.event).toBeUndefined()
  expect(passed.answer).toBe('Passed on a different tree than the failure (abc1234 → def5678): a fix, not flaky.')
  expect(passed.state.flaky).toEqual({ a1: ['old'] })
  expect(passed.state.last).toEqual({})
  // An uncommitted fix on the same HEAD is another tree too.
  const dirty = noteRelease(failed.state, 'a1', 'tests', 'pass', undefined, 'abc1234aaaa+0badf00d')
  expect(dirty.event).toBeUndefined()
  // Two fails before a pass: the latest fail's tree wins.
  const again = noteRelease(failed.state, 'a1', 'tests', 'fail', ['t one'], 'def5678bbbb')
  expect(noteRelease(again.state, 'a1', 'tests', 'pass', undefined, 'def5678bbbb').event?.kind).toBe('flaky')
})

test('a pass where either tree is unknown is not flaky, and drops the fail', () => {
  const noTree = noteRelease(NO_FAILS, 'a1', 'tests', 'fail', ['t one'])
  const p1 = noteRelease(noTree.state, 'a1', 'tests', 'pass', undefined, 'abc1234')
  expect(p1.event).toBeUndefined()
  expect(p1.answer).toContain('not counted as flaky')
  expect(p1.state).toEqual(NO_FAILS)
  const withTree = noteRelease(NO_FAILS, 'a1', 'tests', 'fail', ['t one'], 'abc1234')
  const p2 = noteRelease(withTree.state, 'a1', 'tests', 'pass', undefined, undefined)
  expect(p2.event).toBeUndefined()
  expect(p2.state).toEqual(NO_FAILS)
})

test('old state with string[] fails loads and counts as an unknown tree', () => {
  const old = { last: { 'a1\u0000tests': ['t one'], 'a2\u0000tests': 'junk' }, flaky: {} } as unknown as TestFails
  expect(needsTree(old, 'a1', 'tests', 'pass')).toBe(true)
  const p = noteRelease(old, 'a1', 'tests', 'pass', undefined, 'abc1234')
  expect(p.event).toBeUndefined()
  expect(p.state.flaky).toEqual({})
  expect(Object.keys(p.state.last)).toEqual(['a2\u0000tests'])
  expect(noteRelease(old, 'a2', 'tests', 'pass', undefined, 'abc1234').event).toBeUndefined()
  // A new fail on top of old state is recorded in the new shape.
  expect(noteRelease(old, 'a1', 'tests', 'fail', ['t two'], 'abc1234').state.last['a1\u0000tests']).toEqual({ names: ['t two'], tree: 'abc1234' })
})

test('the tree of a run: the given sha, else the caller\'s HEAD plus a hash of its uncommitted diff', async () => {
  const io = (status: string, diff = '') => {
    const ran: string[] = []
    const r: CallerDirIo & { ran: string[] } = {
      ran,
      sessions: async () => ({ m1: { worktree: '/wt/m1' } }) as never,
      agents: async () => [{ id: 'w1', name: 'csv-worker', description: 'w', type: 'flow:worker', status: 'running' }],
      exec: async argv => {
        ran.push(argv.join(' '))
        if (argv[1] === 'worktree') return { exitCode: 0, stdout: 'worktree /r/.claude/worktrees/agent-w1\nHEAD abc\nbranch refs/heads/flow/csv-worker\n', stderr: '' }
        if (argv.includes('rev-parse')) return { exitCode: 0, stdout: 'abc1234def\n', stderr: '' }
        if (argv.includes('status')) return { exitCode: 0, stdout: status, stderr: '' }
        return { exitCode: 0, stdout: diff, stderr: '' }
      },
      cwd: async () => '/r',
    }
    return r
  }
  const clean = io('')
  expect(await runTree(clean, 'w1', ' 9f9f9f9 ')).toBe('9f9f9f9')
  expect(clean.ran).toEqual([])
  expect(await runTree(clean, 'w1', undefined)).toBe('abc1234def')
  expect(clean.ran).toContain('git -C /r/.claude/worktrees/agent-w1 rev-parse HEAD')
  const relayed = io('')
  await runTree(relayed, 'session:m1', undefined)
  expect(relayed.ran).toContain('git -C /wt/m1 rev-parse HEAD')
  const main = io('')
  await runTree(main, undefined, undefined)
  expect(main.ran).toContain('git -C /r rev-parse HEAD')
  const a = await runTree(io(' M a.ts\n', 'diff one'), 'w1', undefined)
  const b = await runTree(io(' M a.ts\n', 'diff two'), 'w1', undefined)
  expect(a).toMatch(/^abc1234def\+[0-9a-f]{8}$/)
  expect(a).not.toBe(b)
  expect(await runTree(io(' M a.ts\n', 'diff one'), 'w1', undefined)).toBe(a)
  // No io to look with, or git failing: unknown.
  expect(await runTree({}, 'w1', undefined)).toBeUndefined()
  const broken = { ...io(''), exec: async () => ({ exitCode: 128, stdout: '', stderr: 'not a git repo' }) }
  expect(await runTree(broken, 'w1', undefined)).toBeUndefined()
})

test('flaky names are appended to a report once; failed names go into a back reason', () => {
  expect(withFlaky('full check: 9 passed', ['t one'])).toBe('full check: 9 passed | flaky: t one')
  expect(withFlaky('full check: 9 passed | flaky: t one', ['t one'])).toBe('full check: 9 passed | flaky: t one')
  expect(withFlaky('ok', undefined)).toBe('ok')
  expect(withFailed('tests failed', ['a', 'b'])).toBe('tests failed | failed: a, b')
  expect(withFailed('tests failed', undefined)).toBe('tests failed')
})
