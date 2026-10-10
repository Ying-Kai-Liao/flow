// Deleting a merged PR branch on the remote. The reviewer used to chain `git push && git push origin
// --delete <branch>`; a rejected push still deleted the branch and GitHub closed the PR for good. So
// the plugin deletes, when the reviewer reports "done", and only once the branch tip is in origin/<base>.
import type { GitRunner, Run } from './mainff'

const reason = (r: Run): string => (r.stderr.trim() || r.stdout.trim()).split('\n')[0]?.slice(0, 160) || `exit ${r.exitCode}`
const kept = (branch: string, why: string): string => `branch ${branch} kept: ${why}`
// A plain branch name: no option-like, revision or refspec syntax can slip into the git argv.
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

// One line: "branch <b> deleted", "branch <b> already gone" or "branch <b> kept: <why>". Never throws.
export async function deleteMergedBranch(git: GitRunner, branch: string | undefined, base: string): Promise<string> {
  const b = (branch ?? '').trim()
  if (b === '') return kept('?', 'no branch recorded')
  try {
    if (!SAFE_BRANCH.test(b) || b.includes('..') || b.endsWith('.lock')) return kept(b, 'not a plain branch name')
    if (b === base || b === `origin/${base}`) return kept(b, 'it is the base branch')
    const ls = await git(['git', 'ls-remote', '--heads', 'origin', `refs/heads/${b}`])
    if (ls.exitCode !== 0) return kept(b, `ls-remote failed: ${reason(ls)}`)
    const tip = ls.stdout.trim().split('\n')[0]?.split(/\s+/)[0] ?? ''
    if (tip === '') return `branch ${b} already gone`
    if (!/^[0-9a-f]{40,64}$/.test(tip)) return kept(b, 'unreadable remote tip')
    const fb = await git(['git', 'fetch', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`, `refs/heads/${b}`])
    if (fb.exitCode !== 0) return kept(b, `fetch failed: ${reason(fb)}`)
    // Exit 0: merged; 1: not an ancestor; anything else: git could not tell.
    const anc = await git(['git', 'merge-base', '--is-ancestor', tip, `refs/remotes/origin/${base}`])
    if (anc.exitCode === 1) return kept(b, `not merged into origin/${base}`)
    if (anc.exitCode !== 0) return kept(b, `ancestry check failed: ${reason(anc)}`)
    // The lease makes the delete fail if the branch moved since the tip we checked.
    const del = await git(['git', 'push', `--force-with-lease=refs/heads/${b}:${tip}`, 'origin', `:refs/heads/${b}`])
    if (del.exitCode !== 0) return kept(b, `push failed: ${reason(del)}`)
    return `branch ${b} deleted`
  } catch (err) {
    return kept(b, `delete failed: ${(err instanceof Error ? err.message : String(err)).split('\n')[0]?.slice(0, 160) ?? ''}`)
  }
}
