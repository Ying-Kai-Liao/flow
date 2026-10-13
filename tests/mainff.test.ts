import { expect } from 'claude-code/testing'
import { test } from './support'

import { fastForwardMain, noteWork, runLine } from '../hooks/mainff'
import type { GitRunner, Run } from '../hooks/mainff'

const res = (stdout = '', exitCode = 0, stderr = ''): Run => ({ exitCode, stdout, stderr })
const WORKTREES = 'worktree /main\nHEAD abc\nbranch refs/heads/main\n\nworktree /main/.claude/worktrees/w\nHEAD def\nbranch refs/heads/flow/x\n'

// A git double: `status`, `branch`, `fetch` (one answer per attempt, the last repeating) and `merge`
// answers are set per test; every argv is recorded.
function fake(o: { status?: Run; branch?: Run; fetch?: Run[]; merge?: Run } = {}) {
  const calls: string[][] = []
  let fetches = 0
  const git: GitRunner = async (argv) => {
    calls.push(argv)
    if (argv[1] === 'worktree') return res(WORKTREES)
    if (argv.includes('status')) return o.status ?? res('')
    if (argv.includes('--show-current')) return o.branch ?? res('main\n')
    if (argv.includes('fetch')) return o.fetch?.[Math.min(fetches++, o.fetch.length - 1)] ?? res()
    if (argv.includes('merge')) return o.merge ?? res('Updating\n')
    if (argv.includes('--short')) return res('abc1234\n')
    return res()
  }
  const fetchCalls = () => calls.filter(c => c.includes('fetch'))
  const pulled = () => calls.some(c => c.includes('fetch') || c.includes('merge') || c.includes('pull'))
  const forbidden = () => calls.some(c => ['stash', 'reset', 'checkout', 'clean', '--force', '-f'].some(w => c.includes(w)))
  return { git, calls, fetchCalls, pulled, forbidden }
}

test('a clean main checkout on the base is fast-forwarded with --ff-only against the first worktree', async () => {
  const f = fake()
  expect(await fastForwardMain(f.git, 'main')).toBe('main checkout fast-forwarded to abc1234')
  expect(f.fetchCalls()).toEqual([['git', '-C', '/main', 'fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main']])
  expect(f.calls.find(c => c.includes('merge'))).toEqual(['git', '-C', '/main', 'merge', '--ff-only', 'refs/remotes/origin/main'])
  expect(f.calls.some(c => c.includes('pull'))).toBe(false)
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

test('a failed merge: not updated: ff failed with the reason, nothing forced', async () => {
  const f = fake({ merge: res('', 1, 'error: untracked working tree files would be overwritten\n') })
  const line = await fastForwardMain(f.git, 'main')
  expect(line).toBe('main checkout not updated: ff failed: error: untracked working tree files would be overwritten')
  expect(f.forbidden()).toBe(false)
})

// What `git pull` printed when the auto cleanup sweep's `git fetch origin --prune` moved
// origin/main in the shared .git mid-fetch (reproduced with two worktrees and a concurrent fetch).
const LOST_RACE = res('', 1, [
  'From https://github.com/Ying-Kai-Liao/flow',
  ' * branch            main       -> FETCH_HEAD',
  "error: cannot lock ref 'refs/remotes/origin/main': is at 1741f24 but expected 9b7e23b",
  ' ! 9b7e23b..1741f24  main       -> origin/main  (unable to update local ref)',
].join('\n'))

test('a fetch that loses the ref race to a concurrent fetch is retried, then the checkout is fast-forwarded', async () => {
  const f = fake({ fetch: [LOST_RACE, res()] })
  expect(await fastForwardMain(f.git, 'main')).toBe('main checkout fast-forwarded to abc1234')
  expect(f.fetchCalls().length).toBe(2)
  expect(f.calls.some(c => c.includes('merge'))).toBe(true)
  expect(f.forbidden()).toBe(false)
})

test('the lock retry is bounded: three fetches, then the git error line, never "From <url>", and no merge', async () => {
  const f = fake({ fetch: [LOST_RACE] })
  const line = await fastForwardMain(f.git, 'main')
  expect(line).toBe("main checkout not updated: ff failed: error: cannot lock ref 'refs/remotes/origin/main': is at 1741f24 but expected 9b7e23b")
  expect(f.fetchCalls().length).toBe(3)
  expect(f.calls.some(c => c.includes('merge'))).toBe(false)
})

test('a fetch that fails for another reason (no network) is not retried and names the fatal line', async () => {
  const f = fake({ fetch: [res('', 128, "fatal: unable to access 'https://github.com/x/': Could not resolve host: github.com\n")] })
  expect(await fastForwardMain(f.git, 'main')).toBe("main checkout not updated: ff failed: fatal: unable to access 'https://github.com/x/': Could not resolve host: github.com")
  expect(f.fetchCalls().length).toBe(1)
})

test('a failure with no error: or fatal: line falls back to its first line', async () => {
  const f = fake({ merge: res('', 1, 'Not possible to fast-forward, aborting.\n') })
  expect(await fastForwardMain(f.git, 'main')).toBe('main checkout not updated: ff failed: Not possible to fast-forward, aborting.')
})

test('a run that pushed nothing has no pull: the line says why', () => {
  expect(runLine(noteWork(noteWork(undefined, 'take'), 'back'))).toBe('main checkout not updated: nothing pushed')
  expect(runLine(noteWork(noteWork(undefined, 'take'), 'ready'))).toBe('main checkout not updated: batch awaits /flow push')
  expect(runLine(undefined)).toBeUndefined()
  expect(runLine(noteWork(undefined, 'list'))).toBeUndefined()
  expect(runLine({ touched: true, ready: false, line: 'main checkout fast-forwarded to abc1234' })).toBe('main checkout fast-forwarded to abc1234')
})
