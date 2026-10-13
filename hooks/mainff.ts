// Fast-forward of the repo's main checkout after a reviewer batch. The reviewer runs worktree-isolated
// and the host refuses its git calls on the main checkout, so the plugin (not subject to that
// isolation) does it when the reviewer reports "done". Never stash, reset, checkout, clean or force.
import { parsePorcelain } from './clean'

export type Run = { exitCode: number; stdout: string; stderr: string }
// Runs one argv, git first.
export type GitRunner = (argv: string[]) => Promise<Run>

// The line that says what went wrong: git's last error:/fatal: line, else the first line. A fetch's first
// stderr line is "From <url>" chatter, which used to hide the real error.
const reason = (r: Run): string => {
  const lines = (r.stderr.trim() || r.stdout.trim()).split('\n').map(l => l.trim()).filter(l => l !== '')
  const meaningful = lines.filter(l => /^(error|fatal):/.test(l)).pop() ?? lines[0]
  return meaningful?.slice(0, 160) || `exit ${r.exitCode}`
}
// Another git process in the shared .git holds or just moved a ref: the auto cleanup sweep runs
// `git fetch origin --prune` right as the reviewer reports "done", and both update origin/<base>.
const LOCKED = /cannot lock ref|unable to update local ref|\.lock'?: File exists|Unable to create '.*\.lock'/i
// Fetch attempts in all. Each retry is one more fetch, by which time the other fetch has finished.
const FETCH_TRIES = 3
const notUpdated = (why: string): string => `main checkout not updated: ${why}`

// One line: "main checkout fast-forwarded to <sha>" or "main checkout not updated: <reason>".
export async function fastForwardMain(git: GitRunner, base: string): Promise<string> {
  try {
    const wl = await git(['git', 'worktree', 'list', '--porcelain'])
    if (wl.exitCode !== 0) return notUpdated(`worktree list failed: ${reason(wl)}`)
    const main = parsePorcelain(wl.stdout)[0]?.path
    if (main === undefined) return notUpdated('no main checkout found')
    // Untracked files do not count as dirty; an incoming file that would overwrite one fails the merge.
    const st = await git(['git', '-C', main, 'status', '--porcelain', '--untracked-files=no'])
    if (st.exitCode !== 0) return notUpdated(`status failed: ${reason(st)}`)
    if (st.stdout.trim() !== '') return notUpdated('dirty')
    const br = await git(['git', '-C', main, 'branch', '--show-current'])
    if (br.exitCode !== 0) return notUpdated(`branch check failed: ${reason(br)}`)
    const on = br.stdout.trim()
    if (on === '') return notUpdated('on a detached HEAD')
    if (on !== base) return notUpdated(`on branch ${on}`)
    // Fetch and merge apart, not `git pull`: a fetch that lost the ref race to a concurrent fetch is
    // retried; the merge then reads the remote-tracking ref, which is current either way.
    let fetched = await git(['git', '-C', main, 'fetch', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`])
    for (let i = 1; i < FETCH_TRIES && fetched.exitCode !== 0 && LOCKED.test(fetched.stderr); i++) {
      fetched = await git(['git', '-C', main, 'fetch', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`])
    }
    if (fetched.exitCode !== 0) return notUpdated(`ff failed: ${reason(fetched)}`)
    const merged = await git(['git', '-C', main, 'merge', '--ff-only', `refs/remotes/origin/${base}`])
    if (merged.exitCode !== 0) return notUpdated(`ff failed: ${reason(merged)}`)
    const sha = await git(['git', '-C', main, 'rev-parse', '--short', 'HEAD'])
    return `main checkout fast-forwarded to ${sha.exitCode === 0 ? sha.stdout.trim() : 'origin/' + base}`
  } catch (err) {
    return notUpdated(`ff failed: ${(err instanceof Error ? err.message : String(err)).split('\n')[0]?.slice(0, 160) ?? ''}`)
  }
}

// One fast-forward at a time; several "done" calls in a batch queue behind each other. A repeat is
// harmless: the second fetch and merge find nothing to do and answers fast-forwarded to the same sha.
let chain: Promise<unknown> = Promise.resolve()
export function serialFastForward(git: GitRunner, base: string): Promise<string> {
  const next = chain.then(() => fastForwardMain(git, base), () => fastForwardMain(git, base))
  chain = next
  return next
}

// What a reviewer run did with the queue, for the line of a run that never reached "done".
export type RunWork = { touched: boolean; ready: boolean; line?: string }

export const noteWork = (w: RunWork | undefined, action: string): RunWork => {
  const cur = w ?? { touched: false, ready: false }
  if (action === 'ready') return { ...cur, touched: true, ready: true }
  if (action === 'take' || action === 'back') return { ...cur, touched: true }
  return cur
}

// The main-checkout line for the final report of a run: the one "done" produced, else why none ran.
// undefined for a run that did no batch work.
export function runLine(w: RunWork | undefined): string | undefined {
  if (w === undefined || (!w.touched && w.line === undefined)) return undefined
  if (w.line !== undefined) return w.line
  return notUpdated(w.ready ? 'batch awaits /flow push' : 'nothing pushed')
}
