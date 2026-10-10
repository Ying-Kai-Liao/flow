import type { HandoffRecord, Leftovers, LogEvent, Session } from '../types'
import { sessionKey } from './sessions'

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

// The type-link paths `git status` lists as untracked: the only files apply deletes itself so a
// plain `git worktree remove` goes through. Exactly the ignored ones, nothing else.
export function typeLinks(status: string): string[] {
  return status.split('\n').filter(l => l.startsWith('?? ') && TYPE_LINKS.has(l.slice(3).trim()))
    .map(l => l.slice(3).trim().replace(/\/$/, ''))
}

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
  // sha -> the commits (short sha + subject, origin/<base>..sha) whose whole change from the merge
  // base is already on origin/<base>, file for file; see containedCandidates.
  contained?: Record<string, string[]>
  // The pid of the Claude process running this plugin; absent when it could not be told. A lock
  // that names it was made in this session, so $.agent.list() knows its agent.
  ownPid?: number
  // The pid of the plugin's process and its ancestors, up to the Claude process: the plugin's
  // process runner need not be a direct child of Claude, so a lock may name any of them.
  ownPids?: Set<number>
  // Worktrees whose lock file is older than 10 minutes; a younger or unaged lock may belong to an
  // agent that is still starting and not yet in the roster.
  oldLocks?: Set<string>
}

export type Kept = { kind: 'worktree' | 'branch'; name: string; reason: string; needsLook: boolean }
export type Sweep = {
  remove: { worktrees: string[]; branches: string[] }
  // Locked worktrees whose lock belongs to an agent that ended: unlocked before removal.
  unlock: string[]
  keep: Kept[]
  // Type links to delete before the plain remove, per worktree path that is in remove.
  links: Record<string, string[]>
  // Unpushed commits dropped because a merged PR of the branch family already holds their content.
  dropped: { kind: 'worktree' | 'branch'; name: string; commits: string[] }[]
}

const linked = (i: Pick<CleanInputs, 'main'>, w: Worktree) =>
  w.path !== i.main && w.path.startsWith(`${i.main.replace(/\/+$/, '')}/.claude/worktrees/`)

// flow/x and flow/x-2 are one line of work: a continuation or rebase reuses the name with a suffix.
const family = (b: string) => b.replace(/-\d+$/, '')

const mergedFamily = (i: Pick<CleanInputs, 'prs'>, branch: string) =>
  (i.prs ?? []).filter(p => p.state === 'MERGED' && family(p.headRefName) === family(branch))

// Worktrees whose handoff record keeps them for a successor: not taken, not continued, and the
// branch has no merged PR (the work was complete after all, so nobody will come).
export function waitingPaths(
  hs: { branch: string; worktree?: string; takenBy?: string; at: number }[],
  continued: { branch?: string; ts: string }[],
  prs: PrRow[] | undefined,
): Set<string> {
  return new Set(hs.filter(h => h.worktree !== undefined && h.takenBy === undefined
    && !continued.some(l => l.branch === h.branch && Date.parse(l.ts) >= h.at)
    && !(prs ?? []).some(p => p.state === 'MERGED' && p.headRefName === h.branch)).map(h => h.worktree!))
}

// The shas register.tsx checks for content equivalence: tips not on the base whose branch family
// has a merged PR. It answers with `contained` (every file the commits changed since the merge
// base has the same tree entry on origin/<base>, so nothing is lost), which landed() trusts.
export function containedCandidates(i: Omit<CleanInputs, 'ancestry'>): string[] {
  const out = new Set<string>()
  const ask = (sha: string | undefined, branch: string | undefined) => {
    if (sha === undefined || branch === undefined || i.onBase.has(sha)) return
    if (mergedFamily(i, branch).length > 0) out.add(sha)
  }
  for (const w of i.worktrees) if (linked(i, w) && !w.prunable) ask(w.head, w.branch)
  for (const [b, sha] of Object.entries(i.branches)) ask(sha, b)
  return [...out]
}

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

type Verdict = { ok: true; dropped?: string[] } | { ok: false; reason: string; needsLook: boolean }

// Whether a commit's work is safe to drop: on the base, in a merged PR, or (worktrees only)
// pushed with a closed PR.
function landed(i: CleanInputs, sha: string, branch: string | undefined, closedOk: boolean): Verdict {
  if (i.onBase.has(sha)) return { ok: true }
  if (merged(i).some(p => p.headRefOid === sha)) return { ok: true }
  if (branch !== undefined && merged(i, branch).some(p => i.ancestry.has(`${sha} ${p.headRefOid}`))) return { ok: true }
  const same = i.contained?.[sha]
  if (branch !== undefined && same !== undefined && mergedFamily(i, branch).length > 0) {
    return same.length > 0 ? { ok: true, dropped: same } : { ok: true }
  }
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

// A lock is stale when the agent it names ended in this session's roster, is unknown to it while
// the lock is this session's own, or its process is gone.
function staleLock(i: CleanInputs, reason: string, path: string): boolean {
  const id = LOCK_AGENT.exec(reason)?.[1]
  const pid = Number(LOCK_PID.exec(reason)?.[1] ?? NaN)
  const agent = id === undefined ? undefined : i.roster.find(a => a.id === id || a.id === `agent-${id}`)
  if (agent !== undefined) return !agent.live
  // Same process, same session: the roster lists every agent it started, nested ones included
  // (AgentInfo.parentId), so an agent missing from it is gone. Another pid proves nothing.
  if (id !== undefined && Number.isInteger(pid) && (pid === i.ownPid || i.ownPids?.has(pid) === true)) return i.oldLocks?.has(path) === true
  return id !== undefined && Number.isInteger(pid) && i.deadPids?.has(pid) === true
}

export function selectCleanup(i: CleanInputs): Sweep {
  const sweep: Sweep = { remove: { worktrees: [], branches: [] }, unlock: [], keep: [], links: {}, dropped: [] }
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
      if (!staleLock(i, w.locked, w.path)) {
        keep('worktree', w.path, 'locked', true)
        hold()
        continue
      }
      sweep.unlock.push(w.path)
    }
    if (v.dropped) sweep.dropped.push({ kind: 'worktree', name: w.path, commits: v.dropped })
    const links = typeLinks(status)
    if (links.length > 0) sweep.links[w.path] = links
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
    if (v.ok) {
      sweep.remove.branches.push(b)
      if (v.dropped) sweep.dropped.push({ kind: 'branch', name: b, commits: v.dropped })
    }
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
  const lost = s.dropped.filter(d => gone[d.kind === 'worktree' ? 'worktrees' : 'branches'].includes(d.name))
  if (lost.length) {
    lines.push('Dropping unpushed commits whose content a merged PR already holds:')
    for (const d of lost) lines.push(`  ${d.kind} ${d.name}:`, ...d.commits.map(c => `    ${c}`))
  }
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
  // worktrees and branches are what a sweep would remove; needsLook is what it keeps for a person to decide.
  const gone = [
    ...(c.worktrees ? [`${c.worktrees} worktree${c.worktrees === 1 ? '' : 's'}`] : []),
    ...(c.branches ? [`${c.branches} branch${c.branches === 1 ? '' : 'es'}`] : []),
  ]
  const parts = [
    ...(gone.length ? [`${gone.join(' and ')} can be removed`] : []),
    ...(c.needsLook ? [`${c.needsLook} hold${c.needsLook === 1 ? 's' : ''} work that isn't merged`] : []),
  ]
  return `Cleanup: ${parts.join(', ')}. /flow clean lists them`
}

// This session's pids: `start` and its ancestors up to and including the nearest `claude` process,
// walked with `step` (undefined when ps fails). A chain that meets no claude within `max` steps,
// pid 1 or a repeat is not trusted: empty. Stopping at the nearest one keeps a nested claude from
// claiming the locks of the session whose shell it runs in.
export async function ancestorPids(start: number, step: (pid: number) => Promise<{ ppid: number; comm: string } | undefined>, max = 12): Promise<Set<number>> {
  const out = new Set<number>()
  let pid: number | undefined = start
  for (let n = 0; n < max && pid !== undefined && Number.isInteger(pid) && pid > 1 && !out.has(pid); n++) {
    out.add(pid)
    const r = await step(pid)
    if (r === undefined) break
    if (r.comm.trim().split('/').pop() === 'claude') return out
    pid = r.ppid
  }
  return new Set()
}

// --- Sweep: reading git and gh, and removing what is safe ----------------------------------------
// The engine handle `$` is never passed across an import, so the caller hands in these calls.

export type CleanIo = {
  // A process run; a failure to start throws.
  exec: (argv: string[], timeoutMs: number) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  agents: () => Promise<{ id: string; status: string; name?: string }[]>
  cwd: () => Promise<string | undefined>
  handoffs: () => Promise<HandoffRecord[]>
  sessions: () => Promise<Session[]>
  log: () => Promise<LogEvent[]>
  append: (event: Omit<LogEvent, 'ts'>) => Promise<void>
  setLeftovers: (counts: Leftovers) => Promise<void>
}

export type CleanGathered = { inputs?: CleanInputs; notes: string[]; error?: string }

// Everything selectCleanup needs, read once: one fetch, one gh call, then local git.
async function gatherClean(io: CleanIo, base: string): Promise<CleanGathered> {
  const run = async (argv: string[]) => {
    try {
      return await io.exec(argv, 60_000)
    } catch (err) {
      return { exitCode: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
    }
  }
  const first = (r: { stderr: string }) => r.stderr.trim().split('\n')[0]?.slice(0, 200) || 'no output'
  const notes: string[] = []
  const fetched = await run(['git', 'fetch', 'origin', '--prune'])
  if (fetched.exitCode !== 0) notes.push(`git fetch origin failed (${first(fetched)}): judged against the refs as they were.`)
  const wl = await run(['git', 'worktree', 'list', '--porcelain'])
  if (wl.exitCode !== 0) return { notes, error: `git worktree list failed: ${first(wl)}` }
  const worktrees = parsePorcelain(wl.stdout)
  const main = worktrees[0]?.path
  if (main === undefined) return { notes, error: 'git worktree list gave no checkout.' }
  const refs = async (prefix: string) => {
    const r = await run(['git', 'for-each-ref', '--format=%(refname:short) %(objectname)', prefix])
    const out: Record<string, string> = {}
    for (const l of r.stdout.split('\n')) {
      const [name, sha] = l.trim().split(' ')
      if (name && sha) out[name] = sha
    }
    return out
  }
  const branches = await refs('refs/heads')
  const remote: Record<string, string> = {}
  for (const [name, sha] of Object.entries(await refs('refs/remotes/origin'))) {
    if (name.startsWith('origin/') && name !== 'origin/HEAD') remote[name.slice('origin/'.length)] = sha
  }
  if (remote[base] === undefined) return { notes, error: `origin/${base} not found: nothing is judged without the base.` }
  const onBase = new Set((await run(['git', 'for-each-ref', '--merged', `origin/${base}`, '--format=%(objectname)', 'refs/heads'])).stdout
    .split('\n').map(l => l.trim()).filter(Boolean))
  const status: Record<string, string> = {}
  const deadPids = new Set<number>()
  for (const w of worktrees.slice(1)) {
    if (w.prunable) continue
    const st = await run(['git', '-C', w.path, 'status', '--porcelain'])
    if (st.exitCode === 0) status[w.path] = st.stdout
    if (w.head !== undefined && !onBase.has(w.head)
      && (await run(['git', 'merge-base', '--is-ancestor', w.head, `origin/${base}`])).exitCode === 0) onBase.add(w.head)
    const pid = /\bpid (\d+)\b/.exec(w.locked ?? '')?.[1]
    if (pid !== undefined && (await run(['ps', '-p', pid])).exitCode !== 0) deadPids.add(Number(pid))
  }
  let prs: PrRow[] | undefined
  const gh = await run(['gh', 'pr', 'list', '--state', 'all', '--limit', '300', '--json', 'number,headRefName,headRefOid,state'])
  try {
    if (gh.exitCode !== 0) throw new Error(first(gh))
    const parsed = JSON.parse(gh.stdout || '[]') as unknown
    if (!Array.isArray(parsed)) throw new Error('unexpected gh output')
    prs = parsed as PrRow[]
  } catch (err) {
    notes.push(`gh pr list failed (${err instanceof Error ? err.message : String(err)}): squash-merged work is not recognised, only what is on origin/${base}.`)
  }
  // A successor continuing in a handed-off worktree runs there; one not spawned yet may still claim it.
  const hs = await io.handoffs()
  const continued = (await io.log()).filter(l => l.event === 'continue')
  const cwdOf = new Map(hs.filter(h => h.takenBy !== undefined && h.worktree !== undefined).map(h => [h.takenBy!, h.worktree!]))
  const waiting = waitingPaths(hs, continued, prs)
  const roster = (await io.agents()).map(a => ({
    id: a.id, live: isLive(a.status), ...(a.name !== undefined && { name: a.name }),
    ...(a.name !== undefined && cwdOf.has(a.name) && { cwd: cwdOf.get(a.name) }),
  }))
  // The main session may itself run in a linked worktree: never pull the floor from under it.
  const here = await io.cwd().catch(() => undefined)
  if (here) roster.push({ id: 'main', live: true, name: 'the main session', cwd: here })
  // A worker in another harness lives in its worktree until it is stopped or its terminal is gone.
  for (const s of await io.sessions()) {
    roster.push({ id: sessionKey(s.name), live: s.status === 'running' || s.status === 'reported', name: s.name, cwd: s.worktree })
  }
  const partial: Omit<CleanInputs, 'ancestry'> = { main, base, worktrees, status, branches, onBase, remote, prs, roster, deadPids, waiting }
  // Content equivalence for tips a merged PR of the branch family may have replaced (a rebase
  // leaves the old commits behind): contained when every file they changed since the merge base
  // has the very same tree entry on origin/<base>. Anything odd (quoted names, many files) is not.
  const contained: Record<string, string[]> = {}
  for (const sha of containedCandidates(partial)) {
    const mb = (await run(['git', 'merge-base', sha, `origin/${base}`])).stdout.trim()
    const diff = await run(['git', 'diff', '--name-only', '--no-renames', mb, sha])
    const files = diff.stdout.split('\n').filter(Boolean)
    if (!mb || diff.exitCode !== 0 || files.length > 200 || files.some(f => f.startsWith('"'))) continue
    let same = true
    for (const f of files) {
      const [a, b] = await Promise.all([sha, `origin/${base}`].map(r => run(['git', 'ls-tree', r, '--', f])))
      if (a!.exitCode !== 0 || b!.exitCode !== 0 || a!.stdout.trim() !== b!.stdout.trim()) { same = false; break }
    }
    if (!same) continue
    const log = await run(['git', 'log', '--format=%h %s', `origin/${base}..${sha}`])
    if (log.exitCode === 0) contained[sha] = log.stdout.split('\n').filter(Boolean)
  }
  partial.contained = contained
  // The lock names the Claude process; the plugin's runner may sit below it, so the chain up to the
  // nearest claude process counts as this session. Works with an empty roster (after a reload): an agent absent
  // from it is judged by its lock's age. An unreadable chain means no lock is broken.
  const own = await ancestorPids(Number((await run(['sh', '-c', 'echo $PPID'])).stdout.trim()), async pid => {
    const r = await run(['ps', '-o', 'ppid=,comm=', '-p', String(pid)])
    const m = /^\s*(\d+)\s+(.*)$/.exec(r.stdout.trim())
    return r.exitCode === 0 && m ? { ppid: Number(m[1]), comm: m[2]! } : undefined
  })
  if (own.size > 0) {
    partial.ownPids = own
    // A fresh agent's worktree is locked before the roster lists it; only an old lock is judged.
    // Unknown age (no admin dir, no lock file) counts as young.
    const oldLocks = new Set<string>()
    for (const w of worktrees.slice(1)) {
      const lp = Number(/\bpid (\d+)\b/.exec(w.locked ?? '')?.[1] ?? NaN)
      if (!own.has(lp)) continue
      const dir = await run(['git', '-C', w.path, 'rev-parse', '--absolute-git-dir'])
      if (dir.exitCode !== 0) continue
      const old = await run(['find', `${dir.stdout.trim()}/locked`, '-mmin', '+10'])
      if (old.exitCode === 0 && old.stdout.trim() !== '') oldLocks.add(w.path)
    }
    partial.oldLocks = oldLocks
  }
  const ancestry = new Set<string>()
  for (const q of ancestryQueries(partial)) {
    const [a, b] = q.split(' ')
    if ((await run(['git', 'merge-base', '--is-ancestor', a!, b!])).exitCode === 0) ancestry.add(q)
  }
  return { inputs: { ...partial, ancestry }, notes }
}

// One sweep at a time: the reviewer's `done`, a reviewer ending and /flow clean may meet.
let sweepChain: Promise<unknown> = Promise.resolve()
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = sweepChain.then(fn, fn)
  sweepChain = run.catch(() => undefined)
  return run
}

const leftoverCounts = (s: Sweep, failed: Kept[] = [], applied = false): Leftovers => ({
  worktrees: applied ? 0 : s.remove.worktrees.length,
  branches: applied ? 0 : s.remove.branches.length,
  needsLook: s.keep.filter(k => k.needsLook).length + failed.length,
})

// A sweep: the listing, and with apply the removal of what selectCleanup marked safe. A removal
// that fails is kept with git's message; nothing is forced. `started` runs once it holds the lock.
export async function sweep(io: CleanIo, base: string, apply: boolean, dryHint?: string, started?: () => void): Promise<string> {
  return exclusive(async () => {
    started?.()
    const g = await gatherClean(io, base)
    if (g.inputs === undefined) return [...g.notes, g.error ?? 'Cleanup failed.'].join('\n')
    const s = selectCleanup(g.inputs)
    const note = g.notes.join('\n') || undefined
    if (!apply) {
      await io.setLeftovers(leftoverCounts(s))
      return sweepText(s, { applied: false, ...(note && { note }), ...(dryHint && { dryHint }) })
    }
    const git = async (argv: string[]) => {
      try {
        return await io.exec(['git', ...argv], 60_000)
      } catch (err) {
        return { exitCode: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
      }
    }
    const failed: Kept[] = []
    const removed: Sweep['remove'] = { worktrees: [], branches: [] }
    const stuck = new Set<string>()
    const byPath = new Map(g.inputs.worktrees.map(w => [w.path, w]))
    for (const path of s.remove.worktrees) {
      const w = byPath.get(path)
      // A missing directory: prune drops the entry.
      if (w?.prunable) { removed.worktrees.push(path); continue }
      if (s.unlock.includes(path)) await git(['worktree', 'unlock', path])
      // Untracked type links block a plain remove: unlink the links themselves (never followed). A real directory under that name is somebody's files: left for git to refuse.
      for (const l of s.links[path] ?? []) {
        const at = `${path}/${l}`
        // `test -L` then `rm` (no trailing slash, no -r): removes the link, never its target.
        const isLink = await io.exec(['test', '-L', at], 10_000).then(r => r.exitCode === 0, () => false)
        if (isLink) await io.exec(['rm', '-f', '--', at], 10_000).catch(() => undefined)
      }
      const r = await git(['worktree', 'remove', path])
      if (r.exitCode === 0) removed.worktrees.push(path)
      else {
        failed.push({ kind: 'worktree', name: path, reason: `kept: ${r.stderr.trim().split('\n')[0] || 'git worktree remove failed'}`, needsLook: true })
        if (w?.branch !== undefined) stuck.add(w.branch)
      }
    }
    await git(['worktree', 'prune'])
    for (const b of s.remove.branches) {
      if (stuck.has(b)) {
        failed.push({ kind: 'branch', name: b, reason: 'its worktree could not be removed', needsLook: true })
        continue
      }
      const r = await git(['branch', '-D', b])
      if (r.exitCode === 0) removed.branches.push(b)
      else failed.push({ kind: 'branch', name: b, reason: `kept: ${r.stderr.trim().split('\n')[0] || 'git branch -D failed'}`, needsLook: true })
    }
    await io.setLeftovers(leftoverCounts(s, failed, true))
    if (removed.worktrees.length || removed.branches.length) {
      await io.append({
        event: 'clean', owner: 'main',
        text: `removed ${[...removed.worktrees.map(p => `worktree ${p.split('/').pop()}`), ...removed.branches.map(b => `branch ${b}`)].join(', ')}`
          + s.dropped.filter(d => (d.kind === 'worktree' ? removed.worktrees : removed.branches).includes(d.name))
            .map(d => `; dropped unpushed in ${d.kind} ${d.name.split('/').pop()}: ${d.commits.join(' | ')}`).join(''),
      })
    }
    return sweepText(s, { applied: true, removed, failed, ...(note && { note }) })
  })
}
