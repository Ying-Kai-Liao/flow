// Fast-forward of the repo's main checkout after a reviewer batch. The reviewer runs worktree-isolated
// and the host refuses its git calls on the main checkout, so the plugin (not subject to that
// isolation) does it when the reviewer reports "done". Never stash, reset, checkout, clean or force.
import { parsePorcelain } from './clean'

export type Run = { exitCode: number; stdout: string; stderr: string }
// Runs one argv, git first.
export type GitRunner = (argv: string[]) => Promise<Run>

const reason = (r: Run): string => (r.stderr.trim() || r.stdout.trim()).split('\n')[0]?.slice(0, 160) || `exit ${r.exitCode}`
const notUpdated = (why: string): string => `main checkout not updated: ${why}`

// One line: "main checkout fast-forwarded to <sha>" or "main checkout not updated: <reason>".
export async function fastForwardMain(git: GitRunner, base: string): Promise<string> {
  try {
    const wl = await git(['git', 'worktree', 'list', '--porcelain'])
    if (wl.exitCode !== 0) return notUpdated(`worktree list failed: ${reason(wl)}`)
    const main = parsePorcelain(wl.stdout)[0]?.path
    if (main === undefined) return notUpdated('no main checkout found')
    // Untracked files do not count as dirty; an incoming file that would overwrite one fails the pull.
    const st = await git(['git', '-C', main, 'status', '--porcelain', '--untracked-files=no'])
    if (st.exitCode !== 0) return notUpdated(`status failed: ${reason(st)}`)
    if (st.stdout.trim() !== '') return notUpdated('dirty')
    const br = await git(['git', '-C', main, 'branch', '--show-current'])
    if (br.exitCode !== 0) return notUpdated(`branch check failed: ${reason(br)}`)
    const on = br.stdout.trim()
    if (on === '') return notUpdated('on a detached HEAD')
    if (on !== base) return notUpdated(`on branch ${on}`)
    const pull = await git(['git', '-C', main, 'pull', '--ff-only', 'origin', base])
    if (pull.exitCode !== 0) return notUpdated(`ff failed: ${reason(pull)}`)
    const sha = await git(['git', '-C', main, 'rev-parse', '--short', 'HEAD'])
    return `main checkout fast-forwarded to ${sha.exitCode === 0 ? sha.stdout.trim() : 'origin/' + base}`
  } catch (err) {
    return notUpdated(`ff failed: ${(err instanceof Error ? err.message : String(err)).split('\n')[0]?.slice(0, 160) ?? ''}`)
  }
}

// One fast-forward at a time; several "done" calls in a batch queue behind each other. A repeat is
// harmless: the second pull finds nothing to do and answers fast-forwarded to the same sha.
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
