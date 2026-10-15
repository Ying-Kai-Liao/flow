// Failing tests under test_slot: which tests failed, and which passed on a rerun of the same tree (flaky). Pure
// helpers; the plugin keeps the state in an atom and logs the events.
import type { AgentInfo } from 'claude-code'
import type { Session } from '../types'
import { findWorktree } from './state'

// A failed run: its test names ([] when it gave none) and the tree it ran on (undefined when unknown).
export type FailedRun = { names: string[]; tree?: string }
export type TestFails = {
  // agent key + label -> its last failed run; a string[] is state from before trees were kept (unknown tree)
  last: Record<string, FailedRun | string[]>
  // agent key -> flaky test names seen during its run
  flaky: Record<string, string[]>
}
export const NO_FAILS: TestFails = { last: {}, flaky: {} }

const MAX_KEPT = 50
const cleanNames = (names: unknown): string[] =>
  Array.isArray(names) ? [...new Set(names.filter((n): n is string => typeof n === 'string').map(n => n.trim()).filter(Boolean))] : []
const slotKey = (agent: string, label: string): string => `${agent}\u0000${label}`
const cleanTree = (tree: unknown): string | undefined => typeof tree === 'string' && tree.trim() !== '' ? tree.trim() : undefined

// Persisted runs come in two shapes; trust neither blindly.
function failedRun(v: unknown): FailedRun {
  if (Array.isArray(v)) return { names: cleanNames(v) }
  const o = v !== null && typeof v === 'object' ? v as Record<string, unknown> : {}
  const tree = cleanTree(o.tree)
  return { names: cleanNames(o.names), ...(tree !== undefined && { tree }) }
}

// Two tree ids name the same tree: equal, or a short and a full sha of the same commit.
function sameTree(a: string, b: string): boolean {
  if (a === b) return true
  const sha = /^[0-9a-f]{7,40}$/i
  return sha.test(a) && sha.test(b) && (a.toLowerCase().startsWith(b.toLowerCase()) || b.toLowerCase().startsWith(a.toLowerCase()))
}
const short = (tree: string | undefined): string => tree === undefined ? 'unknown' : tree.replace(/^([0-9a-f]{7})[0-9a-f]*/i, '$1')

// Whether a release needs the run's tree: a fail, or a pass with a fail on record to compare against.
export function needsTree(state: TestFails, agent: string, label: string, result: unknown): boolean {
  return result === 'fail' || (result === 'pass' && slotKey(agent, label) in state.last)
}

export type ReleaseNote = { state: TestFails; answer: string; event?: { kind: 'tests-failed' | 'flaky'; text: string } }

// What a test_slot "release" with a result means: the answer for the agent, the log event, the new state. A pass
// after a fail is flaky only when both runs were on the same known tree; a pass on another tree is a fix.
export function noteRelease(state: TestFails, agent: string, label: string, result: unknown, failed: unknown, tree?: string): ReleaseNote {
  const k = slotKey(agent, label)
  const names = cleanNames(failed)
  const now = cleanTree(tree)
  if (result === 'fail') {
    const run: FailedRun = { names, ...(now !== undefined && { tree: now }) }
    const last = { ...Object.fromEntries(Object.entries(state.last).slice(-MAX_KEPT)), [k]: run }
    const text = names.length ? `${label}: failed: ${names.join(', ')}` : `${label}: fail (names not given)`
    const answer = names.length
      ? `Failing tests recorded: ${names.join(', ')}.`
      : 'No failing test names given: put the exact names of the failing tests (from the output) in your report.'
    return { state: { ...state, last }, answer, event: { kind: 'tests-failed', text } }
  }
  if (result === 'pass' && k in state.last) {
    const was = failedRun(state.last[k])
    const { [k]: _gone, ...rest } = state.last
    if (was.tree === undefined || now === undefined || !sameTree(was.tree, now)) {
      const answer = was.tree === undefined || now === undefined
        ? 'Passed after a fail, but the tree of a run is unknown: not counted as flaky.'
        : `Passed on a different tree than the failure (${short(was.tree)} → ${short(now)}): a fix, not flaky.`
      return { state: { ...state, last: rest }, answer }
    }
    const flaky = { ...state.flaky, [agent]: [...new Set([...(state.flaky[agent] ?? []), ...was.names])] }
    const list = was.names.length ? was.names.join(', ') : 'an unnamed test'
    return {
      state: { last: rest, flaky },
      answer: `flaky: ${list} (failed, passed on rerun): name it in your report as flaky: <test>.`,
      event: { kind: 'flaky', text: `${label}: flaky: ${list}` },
    }
  }
  return { state, answer: '' }
}

export type CallerDirIo = {
  // The terminal sessions on record, by name.
  sessions: () => Promise<Record<string, Session>>
  agents: () => Promise<AgentInfo[]>
  exec: (argv: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  cwd: () => Promise<string | undefined>
}

// The caller's own worktree, else the session's directory. A relayed call (`session:<name>`) uses that session's
// recorded worktree; the lookup is here, not in register.tsx, because the plugin directory flagged a `$` helper
// returning `s?.worktree` (MOD_CAPABILITY_USE_NOT_PLAIN).
export async function callerDir(io: CallerDirIo, agentId: string | undefined): Promise<string | undefined> {
  let dir: string | undefined
  let mine: string | undefined
  if (agentId !== undefined && agentId.startsWith('session:')) {
    const all = await io.sessions()
    const named = all[agentId.slice('session:'.length)]
    if (named !== undefined) mine = named.worktree
  }
  if (mine !== undefined) dir = mine
  else if (agentId !== undefined) {
    const me = (await io.agents()).find(a => a.id === agentId)
    const wt = await io.exec(['git', 'worktree', 'list', '--porcelain']).catch(() => undefined)
    if (me !== undefined && wt?.exitCode === 0) dir = findWorktree(wt.stdout, me.id, `flow/${me.name ?? me.id}`)?.path
  }
  dir ??= await io.cwd().catch(() => undefined)
  return dir
}

// FNV-1a: cheap, and enough to tell two uncommitted diffs apart.
function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(16).padStart(8, '0')
}

// The tree a run was on: the given sha, else the caller's HEAD, plus a hash of the uncommitted diff when the
// worktree is dirty (an uncommitted fix is another tree). undefined when it cannot be worked out.
export async function runTree(io: Partial<CallerDirIo>, agentId: string | undefined, sha: unknown): Promise<string | undefined> {
  const given = cleanTree(sha)
  if (given !== undefined) return given
  const { sessions, agents, exec, cwd } = io
  if (sessions === undefined || agents === undefined || exec === undefined || cwd === undefined) return undefined
  try {
    const dir = await callerDir({ sessions, agents, exec, cwd }, agentId)
    const git = (...args: string[]) => exec(['git', ...(dir === undefined ? [] : ['-C', dir]), ...args])
    const head = await git('rev-parse', 'HEAD')
    if (head.exitCode !== 0 || head.stdout.trim() === '') return undefined
    const status = await git('status', '--porcelain', '--untracked-files=no')
    if (status.exitCode !== 0) return undefined
    if (status.stdout.trim() === '') return head.stdout.trim()
    const diff = await git('diff', 'HEAD')
    return diff.exitCode === 0 ? `${head.stdout.trim()}+${hash(diff.stdout)}` : undefined
  } catch {
    return undefined
  }
}

// The reviewer's report with "| flaky: a, b" appended for the names it does not mention yet.
export function withFlaky(report: string, flaky: string[] | undefined): string {
  const names = (flaky ?? []).filter(n => !report.includes(n))
  return names.length === 0 ? report : `${report} | flaky: ${names.join(', ')}`
}

// The reason of a "back" with the failing tests named.
export function withFailed(reason: string, failed: unknown): string {
  const names = cleanNames(failed)
  return names.length === 0 ? reason : `${reason} | failed: ${names.join(', ')}`
}
