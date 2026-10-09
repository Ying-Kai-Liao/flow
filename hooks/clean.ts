// Which leftover worktrees and local branches of finished agents can go. Pure: register.tsx runs
// git and gh, hands the parsed answers here, and removes what comes back in `remove`.
// Only clean work that is on the base, in a merged PR, or pushed with its PR closed is removed;
// uncommitted, unpushed, locked and live work is listed for a person, never touched.

export type Worktree = {
  path: string
  head?: string
  // Short name, without refs/heads/; absent on a detached HEAD.
  branch?: string
  // The lock reason ('' when locked without one); absent when not locked.
  locked?: string
  // The directory is gone; `git worktree prune` drops the entry.
  prunable: boolean
}

// `git worktree list --porcelain`, the main checkout first; bare entries are skipped.
export function parsePorcelain(text: string): Worktree[] {
  const out: Worktree[] = []
  for (const block of text.split(/\n\n+/)) {
    const lines = block.split('\n')
    if (lines.includes('bare')) continue
    const get = (k: string) => {
      const l = lines.find(x => x === k || x.startsWith(`${k} `))
      return l === undefined ? undefined : l.slice(k.length + 1)
    }
    const path = get('worktree')
    if (path === undefined || path === '') continue
    const branch = get('branch')?.replace(/^refs\/heads\//, '')
    const locked = get('locked')
    out.push({
      path,
      ...(get('HEAD') && { head: get('HEAD') }),
      ...(branch && { branch }),
      ...(locked !== undefined && { locked }),
      prunable: get('prunable') !== undefined,
    })
  }
  return out
}

// Untracked links to the plugin type definitions a worker makes for tsc; never work.
const TYPE_LINKS = new Set(['types', 'types/', '.claude-plugin/types', '.claude-plugin/types/'])

// The files `git status --porcelain` names, minus the type-definition links.
export function dirtyFiles(status: string): string[] {
  return status.split('\n').filter(l => l.trim() !== '')
    .filter(l => !(l.startsWith('?? ') && TYPE_LINKS.has(l.slice(3).trim())))
    .map(l => l.slice(3).trim())
}

// An agent that may still use its worktree: running, waiting, or idle between turns.
export const isLive = (status: string): boolean => ['pending', 'running', 'waiting', 'idle'].includes(status)

export type PrRow = { number: number; headRefName: string; headRefOid: string; state: string }
export type RosterEntry = { id: string; name?: string; live: boolean; cwd?: string }

export type CleanInputs = {
  main: string
  base: string
  worktrees: Worktree[]
  // `git status --porcelain` per worktree path; absent when it could not be read.
  status: Record<string, string>
  // Local branches and their tips.
  branches: Record<string, string>
  // Shas known to be ancestors of origin/<base>.
  onBase: Set<string>
  // origin/<branch> tips.
  remote: Record<string, string>
  // undefined: gh failed, ancestry only.
  prs?: PrRow[]
  // "a b": a is an ancestor of b (b a sha or origin/<branch>), as asked by ancestryQueries.
  ancestry: Set<string>
  roster: RosterEntry[]
  // Pids from lock reasons that no longer run.
  deadPids?: Set<number>
  // Worktree paths a handoff record keeps for a successor not spawned yet.
  waiting?: Set<string>
}

export type Kept = { kind: 'worktree' | 'branch'; name: string; reason: string; needsLook: boolean }
export type Sweep = {
  remove: { worktrees: string[]; branches: string[] }
  // Locked worktrees whose lock belongs to an agent that ended: unlocked before removal.
  unlock: string[]
  keep: Kept[]
}

const linked = (i: Pick<CleanInputs, 'main'>, w: Worktree) =>
  w.path !== i.main && w.path.startsWith(`${i.main.replace(/\/+$/, '')}/.claude/worktrees/`)

const merged = (i: Pick<CleanInputs, 'prs'>, branch?: string) =>
  (i.prs ?? []).filter(p => p.state === 'MERGED' && (branch === undefined || p.headRefName === branch))

// The pairs ancestry needs beyond onBase, as "a b": a sha against a merged PR head of its branch,
// and against origin/<branch>. register.tsx answers each with `git merge-base --is-ancestor`.
export function ancestryQueries(i: Omit<CleanInputs, 'ancestry'>): string[] {
  const out = new Set<string>()
  const ask = (sha: string | undefined, branch: string | undefined) => {
    if (sha === undefined || i.onBase.has(sha)) return
    if (branch === undefined) return
    for (const p of merged(i, branch)) if (p.headRefOid && p.headRefOid !== sha) out.add(`${sha} ${p.headRefOid}`)
    if (i.remote[branch] !== undefined && i.remote[branch] !== sha) out.add(`${sha} origin/${branch}`)
  }
  for (const w of i.worktrees) if (linked(i, w) && !w.prunable) ask(w.head, w.branch)
  for (const [b, sha] of Object.entries(i.branches)) ask(sha, b)
  return [...out]
}

type Verdict = { ok: true } | { ok: false; reason: string; needsLook: boolean }

// Whether a commit's work is safe to drop: on the base, in a merged PR, or (worktrees only)
// pushed with a closed PR.
function landed(i: CleanInputs, sha: string, branch: string | undefined, closedOk: boolean): Verdict {
  if (i.onBase.has(sha)) return { ok: true }
  if (merged(i).some(p => p.headRefOid === sha)) return { ok: true }
  if (branch !== undefined && merged(i, branch).some(p => i.ancestry.has(`${sha} ${p.headRefOid}`))) return { ok: true }
  const pushed = branch !== undefined && (i.remote[branch] === sha || i.ancestry.has(`${sha} origin/${branch}`))
  const prs = branch === undefined ? [] : (i.prs ?? []).filter(p => p.headRefName === branch)
  const closed = prs.find(p => p.state === 'CLOSED')
  if (closedOk && pushed && closed !== undefined) return { ok: true }
  if (closed !== undefined) return { ok: false, reason: `PR #${closed.number} closed without merging${pushed ? ', pushed' : ''}`, needsLook: true }
  if (branch === undefined) return { ok: false, reason: 'detached HEAD with commits not on the base', needsLook: true }
  if (merged(i, branch).length > 0) return { ok: false, reason: 'unpushed commits after its PR was merged', needsLook: true }
  if (pushed) return { ok: false, reason: 'pushed, not merged, no PR', needsLook: true }
  return { ok: false, reason: 'unpushed commits', needsLook: true }
}

// The live agents' claim on a worktree: its path ends in agent-<id>, it is their cwd, or it is
// on their branch flow/<name>.
function liveOwner(i: CleanInputs, path: string | undefined, branch: string | undefined): RosterEntry | undefined {
  return i.roster.find(a => a.live && (
    (path !== undefined && (path.endsWith(`/agent-${a.id}`) || a.cwd === path || a.cwd?.startsWith(`${path}/`) === true)) ||
    (branch !== undefined && a.name !== undefined && branch === `flow/${a.name}`)))
}

const LOCK_AGENT = /\bagent-([0-9a-zA-Z]+)\b/
const LOCK_PID = /\bpid (\d+)\b/

// A lock is stale when the agent it names ended in this session's roster, or its process is gone.
function staleLock(i: CleanInputs, reason: string): boolean {
  const id = LOCK_AGENT.exec(reason)?.[1]
  const pid = Number(LOCK_PID.exec(reason)?.[1] ?? NaN)
  const agent = id === undefined ? undefined : i.roster.find(a => a.id === id)
  if (agent !== undefined) return !agent.live
  return id !== undefined && Number.isInteger(pid) && i.deadPids?.has(pid) === true
}

export function selectCleanup(i: CleanInputs): Sweep {
  const sweep: Sweep = { remove: { worktrees: [], branches: [] }, unlock: [], keep: [] }
  const keep = (kind: Kept['kind'], name: string, reason: string, needsLook: boolean) =>
    sweep.keep.push({ kind, name, reason, needsLook })
  // Branches checked out in a worktree that stays (the main checkout included).
  const held = new Map<string, string>()
  for (const w of i.worktrees) {
    if (!linked(i, w)) {
      if (w.branch !== undefined) held.set(w.branch, w.path)
      continue
    }
    const hold = () => { if (w.branch !== undefined) held.set(w.branch, w.path) }
    if (w.prunable) {
      sweep.remove.worktrees.push(w.path)
      continue
    }
    const live = liveOwner(i, w.path, w.branch)
    if (live !== undefined) {
      keep('worktree', w.path, `in use by ${live.name ?? live.id}`, false)
      hold()
      continue
    }
    if (i.waiting?.has(w.path)) {
      keep('worktree', w.path, 'waiting for its successor', false)
      hold()
      continue
    }
    const status = i.status[w.path]
    if (status === undefined || w.head === undefined) {
      keep('worktree', w.path, 'git status failed', true)
      hold()
      continue
    }
    const dirty = dirtyFiles(status)
    if (dirty.length > 0) {
      const named = dirty.slice(0, 3).join(', ') + (dirty.length > 3 ? ` and ${dirty.length - 3} more` : '')
      keep('worktree', w.path, `uncommitted changes: ${named}`, true)
      hold()
      continue
    }
    const v = landed(i, w.head, w.branch, true)
    if (!v.ok) {
      keep('worktree', w.path, v.reason, v.needsLook)
      hold()
      continue
    }
    if (w.locked !== undefined) {
      if (!staleLock(i, w.locked)) {
        keep('worktree', w.path, 'locked', true)
        hold()
        continue
      }
      sweep.unlock.push(w.path)
    }
    sweep.remove.worktrees.push(w.path)
  }

  for (const [b, tip] of Object.entries(i.branches)) {
    if (b === i.base) continue
    const at = held.get(b)
    if (at !== undefined) {
      // The main checkout's branch is the person's own business.
      if (at !== i.main) keep('branch', b, `checked out in ${at}`, false)
      continue
    }
    const open = (i.prs ?? []).find(p => p.state === 'OPEN' && p.headRefName === b)
    if (open !== undefined) {
      keep('branch', b, `PR #${open.number} is open`, false)
      continue
    }
    const live = liveOwner(i, undefined, b)
    if (live !== undefined) {
      keep('branch', b, `in use by ${live.name ?? live.id}`, false)
      continue
    }
    const v = landed(i, tip, b, false)
    if (v.ok) sweep.remove.branches.push(b)
    else keep('branch', b, v.reason, v.needsLook)
  }
  return sweep
}

// The listing /flow clean and mcp__flow__clean answer with.
export function sweepText(s: Sweep, opts: { applied: boolean; removed?: Sweep['remove']; failed?: Kept[]; note?: string; dryHint?: string }): string {
  const lines: string[] = []
  if (opts.note) lines.push(opts.note)
  const gone = opts.applied ? opts.removed ?? s.remove : s.remove
  const verb = opts.applied ? 'Removed' : 'Would remove'
  if (gone.worktrees.length) lines.push(`${verb} ${gone.worktrees.length} worktree${gone.worktrees.length > 1 ? 's' : ''}:`, ...gone.worktrees.map(p => `  ${p}`))
  if (gone.branches.length) lines.push(`${verb} ${gone.branches.length} branch${gone.branches.length > 1 ? 'es' : ''}:`, ...gone.branches.map(b => `  ${b}`))
  if (!gone.worktrees.length && !gone.branches.length) lines.push(opts.applied ? 'Removed nothing.' : 'Nothing to remove.')
  const kept = [...(opts.failed ?? []), ...s.keep]
  const look = kept.filter(k => k.needsLook)
  const busy = kept.filter(k => !k.needsLook)
  if (look.length) lines.push('Kept for a person to decide:', ...look.map(k => `  ${k.kind} ${k.name}: ${k.reason}`))
  if (busy.length) lines.push('Kept, in use:', ...busy.map(k => `  ${k.kind} ${k.name}: ${k.reason}`))
  if (!opts.applied && opts.dryHint && (s.remove.worktrees.length || s.remove.branches.length)) lines.push(opts.dryHint)
  return lines.join('\n')
}

// The pane's and status's one line; undefined when there is nothing to say.
export function leftoverLine(c: { worktrees: number; branches: number; needsLook: number }): string | undefined {
  if (c.worktrees === 0 && c.branches === 0 && c.needsLook === 0) return undefined
  const parts = [
    `${c.worktrees} leftover worktree${c.worktrees === 1 ? '' : 's'}`,
    `${c.branches} branch${c.branches === 1 ? '' : 'es'}`,
    ...(c.needsLook ? [`${c.needsLook} need${c.needsLook === 1 ? 's' : ''} a look`] : []),
  ]
  return `${parts.join(' · ')} · /flow clean`
}
