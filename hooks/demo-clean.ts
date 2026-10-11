// What is left of a real (token-using) /flow init demo: its worktree and branch. A worktree is the demo's when
// its branch is named flow/flow-demo[-slug], or, for an in-session worker that kept its own branch name
// (worktree-agent-<id>) or a detached HEAD, when it sits under .claude/worktrees, is clean, and its last commit
// adds flow-demo.md and nothing else. Anything that cannot be tied to the demo is never touched.

import { parsePorcelain } from './clean'
import type { Worktree } from './clean'

export const DEMO_BRANCH = /^flow\/flow-demo(?:-[a-z0-9-]+)?$/
export const DEMO_AGENT = /^flow-demo(?:-[a-z0-9-]+)?$/
export const DEMO_FILE = 'flow-demo.md'
// The one diff --name-status line of a demo commit: DEMO_FILE added. Kept literal, in sync with DEMO_FILE.
export const DEMO_DIFF_LINE = 'A\tflow-demo.md'

export type DemoCleanup = { worktrees: { path: string; branch?: string }[]; branches: string[]; kept: string[] }

// Worktrees to look at by their commit: not the main checkout, under .claude/worktrees, not locked, not already matched by name.
export function toInspect(porcelain: string): Worktree[] {
  return parsePorcelain(porcelain).slice(1).filter(w => w.locked === undefined && w.path.includes('/.claude/worktrees/') && !(w.branch !== undefined && DEMO_BRANCH.test(w.branch)))
}

// `git diff --name-status HEAD~1 HEAD` of the worktree is exactly the demo file added, and `git status --porcelain` is empty.
export const isDemoCommit = (diff: string, status: string): boolean => status.trim() === '' && diff.trim() === DEMO_DIFF_LINE

// `porcelain` is `git worktree list --porcelain` (the main checkout first), `branches` the local branch names,
// `confirmed` the paths of other worktrees the caller tied to the demo by isDemoCommit.
export function planCleanup(porcelain: string, branches: string[], confirmed: string[] = []): DemoCleanup {
  const [, ...others] = parsePorcelain(porcelain)
  const kept: string[] = []
  const held = new Set<string>()
  const worktrees: DemoCleanup['worktrees'] = []
  const extra = new Set<string>()
  for (const w of others) {
    const named = w.branch !== undefined && DEMO_BRANCH.test(w.branch)
    if (!named && !(w.locked === undefined && confirmed.includes(w.path) && w.path.includes('/.claude/worktrees/'))) continue
    if (w.locked !== undefined) { kept.push(`${w.path} is locked`); if (w.branch !== undefined) held.add(w.branch); continue }
    worktrees.push({ path: w.path, ...(w.branch !== undefined ? { branch: w.branch } : {}) })
    // A confirmed worker's own branch (worktree-agent-<id>) goes with its worktree.
    if (!named && w.branch !== undefined) extra.add(w.branch)
  }
  const own = [...branches.filter(b => DEMO_BRANCH.test(b)), ...extra]
  return { worktrees, branches: [...new Set(own)].filter(b => !held.has(b)), kept }
}
