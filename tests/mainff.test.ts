import { expect } from 'claude-code/testing'
import { test } from './support'

import { fastForwardMain, noteWork, runLine } from '../hooks/mainff'
import type { GitRunner, Run } from '../hooks/mainff'

const res = (stdout = '', exitCode = 0, stderr = ''): Run => ({ exitCode, stdout, stderr })
const WORKTREES = 'worktree /main\nHEAD abc\nbranch refs/heads/main\n\nworktree /main/.claude/worktrees/w\nHEAD def\nbranch refs/heads/flow/x\n'

// A git double: `status`, `branch` and `pull` answers are set per test; every argv is recorded.
function fake(o: { status?: Run; branch?: Run; pull?: Run } = {}) {
  const calls: string[][] = []
  const git: GitRunner = async (argv) => {
    calls.push(argv)
    if (argv[1] === 'worktree') return res(WORKTREES)
    if (argv.includes('status')) return o.status ?? res('')
    if (argv.includes('--show-current')) return o.branch ?? res('main\n')
    if (argv.includes('pull')) return o.pull ?? res('Updating\n')
    if (argv.includes('--short')) return res('abc1234\n')
    return res()
  }
  const pulled = () => calls.some(c => c.includes('pull'))
  const forbidden = () => calls.some(c => ['stash', 'reset', 'checkout', 'clean', '--force', '-f'].some(w => c.includes(w)))
  return { git, calls, pulled, forbidden }
}

test('a clean main checkout on the base is fast-forwarded with --ff-only against the first worktree', async () => {
  const f = fake()
  expect(await fastForwardMain(f.git, 'main')).toBe('main checkout fast-forwarded to abc1234')
  const pull = f.calls.find(c => c.includes('pull'))
  expect(pull).toEqual(['git', '-C', '/main', 'pull', '--ff-only', 'origin', 'main'])
  expect(f.calls.some(c => c.includes('status') && c.includes('--untracked-files=no'))).toBe(true)
  expect(f.forbidden()).toBe(false)
})

test('tracked changes: not updated: dirty, and no pull', async () => {
  const f = fake({ status: res(' M hooks/a.ts\n') })
  expect(await fastForwardMain(f.git, 'main')).toBe('main checkout not updated: dirty')
  expect(f.pulled()).toBe(false)
  expect(f.forbidden()).toBe(false)
})

test('untracked files alone do not count as dirty (status is asked without them)', async () => {
  const f = fake({ status: res('') })
  expect(await fastForwardMain(f.git, 'main')).toContain('fast-forwarded')
  expect(f.pulled()).toBe(true)
})

test('another branch: not updated, no pull', async () => {
  const f = fake({ branch: res('feature\n') })
  expect(await fastForwardMain(f.git, 'main')).toBe('main checkout not updated: on branch feature')
  expect(f.pulled()).toBe(false)
})

test('a detached HEAD: not updated, no pull', async () => {
  const f = fake({ branch: res('\n') })
  expect(await fastForwardMain(f.git, 'main')).toBe('main checkout not updated: on a detached HEAD')
  expect(f.pulled()).toBe(false)
})

test('a failed pull: not updated: ff failed with the reason, nothing forced', async () => {
  const f = fake({ pull: res('', 1, 'error: untracked working tree files would be overwritten\n') })
  const line = await fastForwardMain(f.git, 'main')
  expect(line).toBe('main checkout not updated: ff failed: error: untracked working tree files would be overwritten')
  expect(f.forbidden()).toBe(false)
})

test('a run that pushed nothing has no pull: the line says why', () => {
  expect(runLine(noteWork(noteWork(undefined, 'take'), 'back'))).toBe('main checkout not updated: nothing pushed')
  expect(runLine(noteWork(noteWork(undefined, 'take'), 'ready'))).toBe('main checkout not updated: batch awaits /flow push')
  expect(runLine(undefined)).toBeUndefined()
  expect(runLine(noteWork(undefined, 'list'))).toBeUndefined()
  expect(runLine({ touched: true, ready: false, line: 'main checkout fast-forwarded to abc1234' })).toBe('main checkout fast-forwarded to abc1234')
})
