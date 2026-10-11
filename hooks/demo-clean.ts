// What is left of a real (token-using) /flow init demo: its worktree and branch. Only names the demo gave
// itself are matched (branch flow/flow-demo, flow/flow-demo-<slug>); anything else is never touched.

import { parsePorcelain } from './clean'

export const DEMO_BRANCH = /^flow\/flow-demo(?:-[a-z0-9-]+)?$/
export const DEMO_AGENT = /^flow-demo(?:-[a-z0-9-]+)?$/

export type DemoCleanup = { worktrees: { path: string; branch: string }[]; branches: string[]; kept: string[] }

// `porcelain` is `git worktree list --porcelain` (the main checkout first), `branches` the local branch names.
export function planCleanup(porcelain: string, branches: string[]): DemoCleanup {
  const [, ...others] = parsePorcelain(porcelain)
  const kept: string[] = []
  const held = new Set<string>()
  const worktrees: DemoCleanup['worktrees'] = []
  for (const w of others) {
    if (w.branch === undefined || !DEMO_BRANCH.test(w.branch)) continue
    if (w.locked !== undefined) { kept.push(`${w.path} is locked`); held.add(w.branch); continue }
    worktrees.push({ path: w.path, branch: w.branch })
  }
  const own = branches.filter(b => DEMO_BRANCH.test(b))
  return { worktrees, branches: [...new Set(own)].filter(b => !held.has(b)), kept }
}
