import { atom, read, update } from 'claude-code'
import type { AgentInfo, AgentSpawnInput, EngineInterface, Register } from 'claude-code'

import type { Activity, AgentRow, Handover, HandoffRecord, LogEvent, OpenPr, PrCache, SlotEntry, TestSlots } from '../types'
import { addNodes, agentFor, asksQuestion, describe, noticeText, settle } from './dag'
import type { Facts, Graph, Notice, Plan } from './dag'
import {
  fill, MANAGER_PROMPT, NO_QUEUE_RULE, QUEUE_PROMPT, QUEUE_RULE, WORKER_PROMPT,
} from './prompts'
import type { Settings } from './prompts'
import { deployTargetsOf, stateFileOf } from './prompts'
import {
  allowed, allowList, killRefusal, mainCheckoutRefusal, mainRelative, parseWorktrees, resolvePath, writeTargets,
} from './guards'
import type { WriteTarget } from './guards'
import { buildDigest, findWorktree, noteKey, ownerFor } from './state'

// The orca-flow pattern inside one Claude Code session. The main session is the super manager
// (the `dispatch` skill); it starts `flow:manager` agents, which start
// `flow:worker` agents in worktrees of their own and hand approved PRs to the
// `flow:queue` agent through this plugin's tools. The pane in main shows the tree.

const PANE = 'flow'
const POLL_MS = 3000
const LOG_MAX = 40
const MANAGER = 'flow:manager'
const WORKER = 'flow:worker'
// A worker continued in its predecessor's worktree: the plugin rewrites a spawn to it, the model never picks it.
const CONTINUE = 'flow:continue'
const WORKERS = new Set([WORKER, CONTINUE])
const QUEUE = 'flow:queue'
const ENDED = new Set(['completed', 'failed', 'killed'])
const LIVE = new Set(['pending', 'running', 'waiting'])
// Display order: what may need a person first, finished agents last.
const ORDER = ['waiting', 'idle', 'running', 'pending', 'failed', 'killed', 'completed']
const GLYPH: Record<string, string> = {
  pending: '○', running: '●', waiting: '◐', idle: '◌', completed: '✓', failed: '✗', killed: '■',
}
const COLOR: Record<string, string> = {
  running: 'suggestion', waiting: 'warning', idle: 'warning', completed: 'success', failed: 'error', killed: 'error',
}
const ROLE: Record<string, string> = { [MANAGER]: 'manager', [WORKER]: 'worker', [CONTINUE]: 'worker', [QUEUE]: 'queue' }
const ROOT_GLYPH = '◆'
const HANDOVER_GLYPH: Record<Handover['status'], string> = {
  pending: '…', taken: '●', done: '✓', returned: '↩',
}

const roster = atom({ plugin: 'flow', key: 'roster' } as const, [] as AgentRow[])
const activity = atom({ plugin: 'flow', key: 'activity' } as const, {} as Record<string, Activity>)
const selected = atom({ plugin: 'flow', key: 'selected' } as const, null as string | null)
// The highlighted card of the tree (an agent id), and the folds the person chose: true folds an
// agent's children away, false keeps them out even when the tree is crowded. Absent = automatic.
const cursor = atom({ plugin: 'flow', key: 'cursor' } as const, null as string | null)
const folded = atom({ plugin: 'flow', key: 'folded' } as const, {} as Record<string, boolean>)
// Following the chat view: the view (an agent id, null for main) in which the person last acted in
// the pane. While the view differs from it, the pane shows the viewed agent; written by handlers only.
const overrideView = atom({ plugin: 'flow', key: 'overrideView' } as const, undefined as string | null | undefined)
// Set once the first card click has told the person how to see that agent's chat.
const hinted = atom({ plugin: 'flow', key: 'hinted' } as const, false)
const now = atom({ plugin: 'flow', key: 'now' } as const, 0)
const handovers = atom({ plugin: 'flow', key: 'handovers' } as const, {} as Record<string, Handover>)
const handoffs = atom({ plugin: 'flow', key: 'handoffs' } as const, {} as Record<string, HandoffRecord>)
const queueRuns = atom({ plugin: 'flow', key: 'queueRuns' } as const, 0)
// The open PRs gh listed last, so the 3 s refresh never calls gh itself.
const prCache = atom({ plugin: 'flow', key: 'prCache' } as const, { prs: [], fetchedAt: 0 } as PrCache)

const PR_POLL_MS = 5 * 60_000
const PR_MIN_GAP_MS = 60_000
// A worker that just ended: its manager is probably reviewing the PR.
const GRACE_MS = 20 * 60_000
// Set by register(); refresh() and the pane flag nothing when there is no merge queue.
let queueOn = true

export type Unhanded = { pr: number; title: string; branch: string; note: string }

// Open flow/* PRs that nobody handed to the merge queue and nobody is working on any more.
// A draft is a WIP handoff, a pending/taken/done handover is in hand, a returned one needs a
// manager again. The worker is the agent named like the branch, or its continuation (-2, -3).
export function unhandedPrs(
  prs: OpenPr[], handovers: Record<string, Handover>, roster: AgentRow[],
  activity: Record<string, Activity>, t: number, graceMs = GRACE_MS,
): Unhanded[] {
  const out: Unhanded[] = []
  for (const p of prs) {
    if (p.isDraft || !p.headRefName.startsWith('flow/')) continue
    const h = handovers[String(p.number)]
    if (h !== undefined && h.status !== 'returned') continue
    const slug = p.headRefName.slice('flow/'.length)
    const mine = roster.filter(a => a.name === slug || (a.name?.startsWith(`${slug}-`) === true && /^\d+$/.test(a.name.slice(slug.length + 1))))
    if (mine.some(a => !ENDED.has(a.status))) continue
    const endedAt = Math.max(...mine.map(a => activity[a.id]?.endedAt ?? activity[a.id]?.lastAt ?? 0))
    if (mine.length > 0 && endedAt > 0 && t - endedAt < graceMs) continue
    const last = mine.length > 0 ? mine.reduce((x, y) => (activity[y.id]?.endedAt ?? 0) >= (activity[x.id]?.endedAt ?? 0) ? y : x) : undefined
    const note = h !== undefined ? `returned: ${h.reason ?? ''}`
      : last === undefined ? 'no agent in this session'
        : `no handover, worker ${labelOf(last)} ended${endedAt > 0 ? ` ${ago(t - endedAt)} ago` : ''}`
    out.push({ pr: p.number, title: p.title, branch: p.headRefName, note })
  }
  return out
}

const unhandedLine = (u: Unhanded): string => `#${u.pr} ${u.title} (${u.branch}) — ${u.note}`

async function currentUnhanded($: EngineInterface): Promise<Unhanded[]> {
  if (!queueOn) return []
  const [cache, hs, rows, acts, t] = await Promise.all([
    read($, prCache), read($, handovers), read($, roster), read($, activity), $.clock.now(),
  ])
  return unhandedPrs(cache.prs, hs, rows, acts, t)
}
const plan = atom({ plugin: 'flow', key: 'plan' } as const, {} as Plan)
const testSlots = atom({ plugin: 'flow', key: 'testSlots' } as const, { holders: [], waiters: [] } as TestSlots)

// A hook has a 10 s budget, a $.clock wait included, so acquire blocks only briefly. A free slot
// is granted to the head waiter at once (claimed: false); it has CLAIM_MS to confirm with acquire,
// else the grant passes on. The grant is signalled by a file and a message, so waiting costs no turns.
const LEASE_MS = 45 * 60_000
const CLAIM_MS = 2 * 60_000
const WAIT_MAX_S = 8
const WAIT_DEFAULT_S = 2
// <git-common-dir>/flow/test-slots, set at session start; undefined when not in a git repo.
let slotDir: string | undefined
const grantFile = (key: string): string | undefined => slotDir && `${slotDir}/${key.replace(/[^\w.-]/g, '_')}.granted`
// The test_slots setting, for refresh()'s status line (set where the settings are read).
let slotLimit = 1

const span = (ms: number): string => {
  const m = Math.floor(ms / 60_000)
  return m < 1 ? `${Math.max(0, Math.round(ms / 1000))}s` : `${m}m`
}
const heldBy = (h: SlotEntry, t: number): string => `${h.name} (${h.label}, ${span(t - h.since)})`

// Drops holders and waiters whose agent ended or is gone and holders past the lease. The main session (key "main") never ends. Returns the new state and what was dropped.
export function reapSlots(state: TestSlots, rows: AgentRow[], t: number): { state: TestSlots; notes: string[] } {
  const status = new Map(rows.map(a => [a.id, a.status]))
  const gone = (key: string) => key !== 'main' && (status.get(key) === undefined || ENDED.has(status.get(key)!))
  const notes: string[] = []
  const holders = state.holders.filter(h => {
    if (gone(h.key)) return false
    if (t - h.since >= LEASE_MS) {
      notes.push(`test slot of ${h.name} (${h.label}) released after ${span(LEASE_MS)}: its lease ran out`)
      return false
    }
    return true
  })
  const waiters = state.waiters.filter(w => !gone(w.key))
  const changed = holders.length !== state.holders.length || waiters.length !== state.waiters.length
  return { state: changed ? { holders, waiters } : state, notes }
}

// Gives free slots to the head waiters, after dropping grants nobody confirmed within CLAIM_MS.
// Pure: the caller does the signalling for `granted`.
export function grantSlots(state: TestSlots, limit: number, t: number): { state: TestSlots; granted: SlotEntry[]; notes: string[] } {
  const notes: string[] = []
  const holders = state.holders.filter(h => {
    if (h.claimed !== false || t - h.since < CLAIM_MS) return true
    notes.push(`test slot offered to ${h.name} (${h.label}) passed on: not confirmed within ${span(CLAIM_MS)}`)
    return false
  })
  const waiters = [...state.waiters]
  const granted: SlotEntry[] = []
  while (holders.length < limit && waiters.length > 0) {
    const w = { ...waiters.shift()!, since: t, claimed: false }
    holders.push(w)
    granted.push(w)
  }
  const changed = holders.length !== state.holders.length || granted.length > 0
  return { state: changed ? { holders, waiters } : state, granted, notes }
}

// Applies `pre`, reaps, grants, and signals: a grant file and a message per new holder, the files
// of everyone who left the line removed. Every slot change goes through here, inside one update().
async function settleSlots($: EngineInterface, rows: AgentRow[], t: number, pre: (s: TestSlots) => TestSlots = s => s, me?: string): Promise<void> {
  const notes: string[] = []
  let granted: SlotEntry[] = []
  let left: string[] = []
  await update($, testSlots, st => {
    notes.length = 0
    const r = reapSlots(pre(st), rows, t)
    const g = grantSlots(r.state, slotLimit, t)
    notes.push(...r.notes, ...g.notes)
    // The caller of acquire is here to hear it: its grant is confirmed on the spot, with no signal.
    const state = me === undefined ? g.state
      : { ...g.state, holders: g.state.holders.map(h => h.key === me ? { ...h, claimed: true } : h) }
    granted = g.granted.filter(h => h.key !== me)
    const stay = new Set([...state.holders, ...state.waiters].map(e => e.key))
    left = [...st.holders, ...st.waiters].map(e => e.key).filter(k => !stay.has(k))
    return state
  })
  for (const n of notes) void $.ui.toast(n)
  await signalSlots($, granted, left)
}

const sh = ($: EngineInterface, script: string, ...args: string[]) =>
  $.process.run(['sh', '-c', script, 'sh', ...args], { timeoutMs: 5_000 }).catch(() => undefined)

async function signalSlots($: EngineInterface, granted: SlotEntry[], left: string[]): Promise<void> {
  for (const key of left) {
    const f = grantFile(key)
    if (f) await sh($, 'rm -f "$1"', f)
  }
  for (const g of granted) {
    const f = grantFile(g.key)
    if (f) await sh($, 'mkdir -p "$(dirname "$1")" && : > "$1"', f)
    if (g.key !== 'main') {
      await $.session.send({
        to: { agentId: g.key },
        text: `flow: your test slot is granted (${g.label}). Call mcp__flow__test_slot acquire to confirm, run, then release.`,
      }).catch(() => undefined)
    }
  }
}

function slotLine(state: TestSlots, limit: number, t: number): string {
  if (state.holders.length === 0 && state.waiters.length === 0) return ''
  const held = state.holders.length ? `held by ${state.holders.map(h => heldBy(h, t)).join(', ')}` : 'free'
  return `Test slots: ${state.holders.length}/${limit} ${held}${state.waiters.length ? ` · ${state.waiters.length} waiting` : ''}`
}

export type TreeItem = { a: AgentRow; depth: number; kids: number; collapsed: boolean }

// The rows of the tree in the order they are drawn and walked. `auto` folds every agent with
// children except the ones on the way to the highlight (a crowded tree); a fold the person chose
// wins over it. `at` is the highlight, moved up to the nearest row that is drawn.
export function treeItems(
  list: AgentRow[], fold: Record<string, boolean>, cur: string | null | undefined, auto: boolean,
  acts: Record<string, Activity> = {},
): { items: TreeItem[]; at: string | undefined } {
  const ids = new Set(list.map(a => a.id))
  const kids = (id: string | undefined) => list
    .filter(a => (id === undefined ? a.parentId === undefined || !ids.has(a.parentId) : a.parentId === id))
    .sort((a, b) => rankOf(a, acts) - rankOf(b, acts))
  const path = new Set<string>()
  for (let a = list.find(x => x.id === cur); a !== undefined && !path.has(a.id); a = list.find(x => x.id === a!.parentId)) path.add(a.id)
  const items: TreeItem[] = []
  const walk = (a: AgentRow, depth: number) => {
    const under = kids(a.id)
    const collapsed = under.length > 0 && (fold[a.id] ?? (auto && !path.has(a.id)))
    items.push({ a, depth, kids: under.length, collapsed })
    if (!collapsed) for (const c of under) walk(c, depth + 1)
  }
  for (const a of kids(undefined)) walk(a, 0)
  const drawn = new Set(items.map(i => i.a.id))
  let at: string | undefined = cur ?? undefined
  while (at !== undefined && !drawn.has(at)) at = list.find(a => a.id === at)?.parentId
  return { items, at }
}

// The window of rows to draw: all of them, or `size` rows with the highlight in the middle.
export function viewOf<T>(items: T[], at: number, size: number): { top: number; rows: T[] } {
  if (items.length <= size) return { top: 0, rows: items }
  const top = Math.min(Math.max(0, at - Math.floor(size / 2)), items.length - size)
  return { top, rows: items.slice(top, top + size) }
}

// One line for a tool call: the tool and its most telling argument.
function describeCall(e: Record<string, unknown>): string {
  const tool = String(e.tool ?? '?').replace(/^mcp__flow__/, '')
  const arg = [e.file_path, e.command, e.pattern, e.path, e.url, e.description, e.action, e.prompt]
    .find(v => typeof v === 'string' && v.length > 0) as string | undefined
  // A command is its first line, cut at a heredoc: its body is code, not news.
  const text = arg === undefined ? '' : (e.command === arg ? arg.split('\n')[0]!.replace(/<<.*$/, '') : arg)
  const short = text === '' ? '' : ' ' + text.replace(/\s+/g, ' ').trim().slice(0, 90)
  return tool + short
}

const base = (path: unknown): string => String(path ?? '').split('/').pop() ?? ''

// What a call is, in a few plain words for a card: never a command's body or a prompt.
export function summarizeCall(e: Record<string, unknown>): string {
  const tool = String(e.tool ?? '?').replace(/^mcp__flow__/, '')
  const file = base(e.file_path)
  switch (tool) {
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return file ? `editing ${file}` : 'editing'
    case 'Write': return file ? `writing ${file}` : 'writing'
    case 'Read': return file ? `reading ${file}` : 'reading'
    case 'Grep': case 'Glob': return 'searching'
    case 'Agent': {
      const role = String(e.subagent_type ?? e.subagentType ?? '').replace(/^flow:/, '')
      const name = String(e.name ?? '')
      return ['started', role === 'manager' || role === 'worker' ? role : 'agent', name].filter(Boolean).join(' ')
    }
    case 'Bash': {
      const cmd = String(e.command ?? '').split('\n')[0]!.trim()
      // git and gh first: a commit message may say "test".
      if (/^git\s+\S+/.test(cmd)) return 'git ' + cmd.split(/\s+/)[1]
      if (/^gh\s+pr\b/.test(cmd)) return 'gh pr ' + (cmd.split(/\s+/)[2] ?? '')
      if (/\b(tsc|test|vitest|jest|pytest)\b/.test(cmd)) return 'running tests'
      return 'running a command'
    }
    default: return tool
  }
}

// Running time as the native subagent row has it: 12s, 1m 43s, 1h 5m.
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

// "↓ 84.0k tokens": the context the agent has taken in, one decimal like the native row.
export function tokensDown(n: number): string {
  return `↓ ${n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n} tokens`
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60}m`
}

function labelOf(a: AgentRow): string {
  return a.name ?? a.description ?? a.id.slice(0, 8)
}

const DEFAULT_WINDOW = 200_000
const METER_CELLS = 12
const CARD_ROWS = 5
const DANGER_PERCENT = 90

const LARGE_WINDOW = 1_000_000

// The model id with what differs between the spellings of one model dropped: `[1m]`, a date suffix, `-latest`.
// `e.model` is the id the engine resolved (it may carry `[1m]`); `usage.model` is the id the API reports.
function modelKey(model: string): string {
  return model.toLowerCase().replace(/\[1m\]/g, '').replace(/-latest$/, '').replace(/-\d{8}$/, '')
}

// A subagent reports no window of its own: borrow the main session's when it runs the same model
// (compared by modelKey), else 200k, or 1M for a `[1m]` model id. Tokens past the assumed window
// prove the window is the 1M one, so a guess is never shown past 100%.
function windowOf(model: string, mainModel: string | undefined, mainWindow: number | undefined, tokens = 0): number {
  const window = mainWindow !== undefined && mainModel !== undefined && modelKey(model) === modelKey(mainModel) ? mainWindow
    : model.includes('[1m]') ? LARGE_WINDOW : DEFAULT_WINDOW
  return tokens > window ? Math.max(window, LARGE_WINDOW) : window
}

// The trigger: the lower of the token setting and the percent of the window, so a 200k model
// still hands off at the percent when the token limit is far above its window.
function thresholdOf(s: { contextWarn: number; contextWarnTokens: number }, window: number): number {
  const byPercent = Math.round(window * s.contextWarn / 100)
  return s.contextWarnTokens > 0 ? Math.min(s.contextWarnTokens, byPercent) : byPercent
}

// The same threshold as a percent of the window, for the meter's marker and colour.
function warnPercent(s: { contextWarn: number; contextWarnTokens: number }, window: number): number {
  return Math.min(100, Math.max(1, Math.round(thresholdOf(s, window) / window * 100)))
}

// What the threshold is called in a message: "40%" or "100k tokens".
function limitLabel(s: { contextWarn: number; contextWarnTokens: number }, window: number): string {
  return s.contextWarnTokens > 0 && s.contextWarnTokens < Math.round(window * s.contextWarn / 100)
    ? `${tokensLabel(s.contextWarnTokens)} tokens` : `${s.contextWarn}%`
}

// The threshold in tokens for the meter, only when the token limit is the one in force.
function limitTokens(s: { contextWarn: number; contextWarnTokens: number }, window: number): string | undefined {
  return limitLabel(s, window).endsWith('tokens') ? tokensLabel(s.contextWarnTokens) : undefined
}

// The line an agent past the threshold reads. A manager keeps going until its workers are done.
function wrapUpText(role: string, percent: number, limit: string): string {
  const handoff = 'follow the Handoff section of your instructions now: commit WIP, push, update the draft PR\'s ## Handoff note, end with HANDOFF: <branch>.'
  return role === 'manager'
    ? `flow: WRAP UP: your context is at ${percent}% (past the ${limit} limit). Start no new work; once none of your workers is running, ${handoff}`
    : `flow: WRAP UP: your context is at ${percent}% (past the ${limit} limit). Stop new work, ${handoff}`
}

function tokensLabel(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

// The bar with a marker cell at the warn threshold, so how close an agent is stays readable.
function cells(percent: number, warn: number): { ch: string; kind: 'mark' | 'fill' | 'empty' }[] {
  const filled = Math.round(Math.min(100, percent) / 100 * METER_CELLS)
  const mark = Math.min(METER_CELLS - 1, Math.floor(warn / 100 * METER_CELLS))
  return Array.from({ length: METER_CELLS }, (_, i) =>
    i === mark ? { ch: '│', kind: 'mark' } : i < filled ? { ch: '█', kind: 'fill' } : { ch: '░', kind: 'empty' })
}

function meterColor(percent: number, warn: number): string | undefined {
  return percent >= DANGER_PERCENT && percent >= warn ? 'error' : percent >= warn ? 'warning' : undefined
}

function rank(status: string): number {
  const i = ORDER.indexOf(status)
  return i === -1 ? ORDER.length : i
}

// An agent told to wrap up sorts with what needs a person, ahead of plain running.
function rankOf(a: AgentRow, acts: Record<string, Activity>): number {
  return handoffOf(a, acts[a.id])?.kind === 'wrapping' ? Math.min(rank(a.status), rank('idle')) : rank(a.status)
}

// Where an agent is in its handoff: told to wrap up and still live, or ended (idle counts) on a
// report whose last line is `HANDOFF: <branch>` (a manager's is `HANDOFF: manager <name>`).
// Old rows without the fields give undefined.
export function handoffOf(a: AgentRow, act: Activity | undefined):
  { kind: 'wrapping'; percent?: number; reminders: number } | { kind: 'done'; to: string } | undefined {
  if (act === undefined) return undefined
  if (ENDED.has(a.status) || a.status === 'idle') {
    const last = (act.answer ?? '').trim().split('\n').pop()?.trim() ?? ''
    if (last.startsWith('HANDOFF:')) return { kind: 'done', to: last.slice('HANDOFF:'.length).trim() }
  }
  if (!ENDED.has(a.status) && act.handoffNotifiedAt !== undefined) {
    return { kind: 'wrapping', percent: act.handoffPercent, reminders: act.remindersSent ?? 0 }
  }
  return undefined
}

function handoffText(h: NonNullable<ReturnType<typeof handoffOf>>): string {
  return h.kind === 'done'
    ? `handed off${h.to ? ` → ${h.to}` : ''}`
    : `wrapping up${h.percent === undefined ? '' : ` (told at ${h.percent}%)`}${h.reminders > 1 ? ` · ${h.reminders} reminders` : ''}`
}

// The pane's context meter marks this percent; the rest of the settings go into the prompts.
type Guards = { mainGuard: boolean; mainAllow: string[] }

function settingsOf(options: Record<string, unknown>, base: string): Settings & { contextWarn: number; contextWarnTokens: number; handoff: boolean; maxManagers: number; maxContinues: number } & Guards {
  const str = (k: string, d: string) => (typeof options[k] === 'string' && options[k] !== '' ? String(options[k]) : d)
  const num = (k: string, d: number) => (typeof options[k] === 'number' ? Number(options[k]) : d)
  return {
    contextWarn: Math.min(100, Math.max(1, Math.round(num('context_warn_percent', 40)))),
    contextWarnTokens: Math.max(0, Math.round(num('context_warn_tokens', 350000))),
    handoff: options.handoff !== false,
    mainGuard: options.main_checkout_guard !== false,
    mainAllow: allowList(typeof options.main_checkout_allow === 'string' ? options.main_checkout_allow : '.claude/'),
    maxContinues: Math.max(0, Math.round(num('max_continues', 2))),
    base: str('base_branch', base),
    testCommand: str('test_command', ''),
    fullCheck: str('full_check_command', ''),
    deployCommand: str('deploy_command', ''),
    deployTargets: deployTargetsOf(options.deploy_targets),
    stateFile: stateFileOf(options.state_file),
    mergeMethod: str('merge_method', 'squash'),
    useQueue: options.merge_queue !== false,
    maxWorkers: num('max_workers', 3),
    maxManagers: Math.max(1, Math.round(num('max_managers', 20))),
    testSlots: Math.max(1, Math.floor(num('test_slots', 1))),
    workerModel: str('worker_model', 'sonnet'),
  }
}

// How many managers main runs at once; refresh needs it to tell main how many slots are free.
let maxManagers = 20
// Managers whose end already freed a slot (and woke main), so a poll does not wake it twice.
const freedSeen = new Set<string>()

const isManagerOf = (owner: string, name: string | undefined) =>
  name !== undefined && (name === owner || (name.startsWith(owner + '-') && /^\d+$/.test(name.slice(owner.length + 1))))

// Whose graph an agent works on: its own name, or the manager it continues (`<name>-N`); main has none.
function planOwner(plans: Plan, name: string | undefined): string {
  if (name === undefined) return 'main'
  if (plans[name]) return name
  const m = /^(.+)-\d+$/.exec(name)
  return m && plans[m[1]!] ? m[1]! : name
}

const liveManagers = (rows: AgentRow[]) => rows.filter(a => a.type === MANAGER && !ENDED.has(a.status))

// Settles every plan against the roster and handovers in one update, then tells each owner once.
// `edit` changes the plan first (the plan tool); `quietOwner` is the caller, who sees the outcome
// in its own tool result and needs no message.
async function syncPlans(
  $: EngineInterface, rows: AgentRow[], edit?: (p: Plan) => Plan, quietOwner?: string,
): Promise<Plan> {
  // Marked before the first await, so two overlapping polls count an ended manager once.
  const freed = rows.filter(a => a.type === MANAGER && ENDED.has(a.status) && !freedSeen.has(a.id))
  for (const a of freed) freedSeen.add(a.id)
  if (edit === undefined && Object.keys(await read($, plan)).length === 0) return {}
  const [acts, hs] = await Promise.all([read($, activity), read($, handovers)])
  const facts: Facts = {
    agents: rows.map(a => ({ name: a.name, status: a.status, answer: acts[a.id]?.answer })),
    handovers: Object.values(hs),
  }
  const slots = Math.max(0, maxManagers - liveManagers(rows).length)
  let notices: Notice[] = []
  let result: Plan = {}
  await update($, plan, p => {
    const r = settle(edit ? edit(p) : p, facts, { slots })
    notices = r.notices
    result = r.plan
    // A slot freed while ready tasks wait: tell main again, once per ended manager.
    const waiting = Object.values(r.plan['main'] ?? {}).filter(n => n.state === 'ready')
    if (freed.length > 0 && slots > 0 && waiting.length > 0 && !notices.some(n => n.owner === 'main')) {
      notices = [...notices, { owner: 'main', ready: waiting, blocked: [], done: [], slots }]
    }
    return r.plan
  })
  for (const n of notices) {
    if (n.owner === quietOwner) continue
    const text = noticeText(n)
    if (n.owner === 'main') {
      $.clock.after(0, () => void $.prompt.submit({ text }).catch(() => undefined))
    } else {
      const agent = agentFor(n.owner, rows.filter(a => !ENDED.has(a.status)))
      if (agent) await $.session.send({ to: { agentId: agent.id }, text }).catch(() => undefined)
    }
  }
  return result
}

function limitsLine(rows: AgentRow[], workers: number): string {
  return `Limits: managers ${liveManagers(rows).length}/${maxManagers}, workers per manager ${workers}`
}

// The roster as the board shows it: every agent of the session, with its role.
async function refresh($: EngineInterface): Promise<AgentRow[]> {
  const [list, t, before, acts] = await Promise.all([
    $.agent.list(), $.clock.now(), read($, roster), read($, activity),
  ])
  const rows: AgentRow[] = list.map(a => ({
    id: a.id, name: a.name, description: a.description, type: a.type,
    status: a.status, parentId: a.parentId,
  }))
  const was = new Map(before.map(a => [a.id, a.status]))
  const ended: string[] = []
  for (const a of rows) {
    const prev = was.get(a.id)
    if (prev === undefined || prev === a.status || ENDED.has(prev)) continue
    if (ENDED.has(a.status) && acts[a.id] !== undefined) ended.push(a.id)
    if (ENDED.has(a.status) || a.status === 'idle') {
      const asks = asksQuestion(acts[a.id]?.answer)
      const role = ROLE[a.type] ? `${ROLE[a.type]} ` : ''
      void $.ui.toast(`${role}${labelOf(a)}: ${asks ? 'asks a question' : a.status === 'idle' ? 'finished its turn' : a.status}`)
    }
  }
  if (ended.length > 0) {
    await update($, activity, all => {
      const next = { ...all }
      for (const id of ended) if (next[id] !== undefined && next[id]!.endedAt === undefined) next[id] = { ...next[id]!, endedAt: t }
      return next
    })
  }
  if (JSON.stringify(rows) !== JSON.stringify(before)) await update($, roster, () => rows)
  await update($, now, () => t)
  // Free the test slots of ended agents and pass them on.
  await settleSlots($, rows, t)

  const hs = Object.values(await read($, handovers))
  const live = rows.filter(a => !ENDED.has(a.status))
  const count = (type: string) => live.filter(a => a.type === type || (type === WORKER && WORKERS.has(a.type))).length
  const queued = hs.filter(h => h.status === 'pending' || h.status === 'taken').length
  const parts = [
    count(MANAGER) && `${count(MANAGER)} managers`,
    count(WORKER) && `${count(WORKER)} workers`,
    queued && `queue: ${queued} PR${queued > 1 ? 's' : ''}`,
  ].filter(Boolean)
  const unhanded = (await currentUnhanded($)).length
  if (unhanded) parts.push(`${unhanded} unhanded`)
  const slots = await read($, testSlots)
  const slotPart = slots.holders.length || slots.waiters.length ? ` · tests ${slots.holders.length}/${slotLimit}` : ''
  $.ui.status(rows.length === 0 && hs.length === 0 && !unhanded ? undefined
    : `flow: ${parts.length ? parts.join(' · ') : `${live.length} live`}${slotPart} · /flow`)
  await syncPlans($, rows).catch(() => undefined)
  return rows
}

async function openPane($: EngineInterface): Promise<void> {
  const r = await $.ui.open({ id: PANE, title: 'Flow' })
  if (!r.isPlaced) void $.ui.toast('flow is running agents: type /flow to watch them')
}

// flow's state on disk: <git-common-dir>/flow/. Shared by every worktree of the repo, never part
// of a working tree. Every helper is best-effort: outside a repo, or when a write fails, it
// does nothing (a failure goes to $.ui.log) and never throws, so a tool call or turn never fails
// over state. `config.json` in this dir belongs to the settings package: never touched here.

const TEXT_MAX = 300
const NOTES_MAX = 3000

let cached: string | undefined

// Forget the resolved dir; a new session resolves it again.
function resetStateDir(): void {
  cached = undefined
}

async function warn($: EngineInterface, what: string, err: unknown): Promise<void> {
  try {
    await $.ui.log(`flow state: ${what}: ${err instanceof Error ? err.message : String(err)}`)
  } catch {
    // No log to write to.
  }
}

// The state dir, or undefined when this is not a repo (or the answer is no absolute path).
async function stateDir($: EngineInterface): Promise<string | undefined> {
  if (cached !== undefined) return cached
  try {
    const r = await $.process.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'])
    const out = r.stdout.trim()
    if (r.exitCode !== 0 || !out.startsWith('/') || out.includes('\n')) return undefined
    cached = `${out.replace(/\/+$/, '')}/flow`
    return cached
  } catch {
    return undefined
  }
}

// Write a temp file next to the target, then rename it over: a reader sees the old file or the new one.
async function writeJsonAtomic($: EngineInterface, path: string, obj: unknown): Promise<boolean> {
  try {
    const tmp = `${path}.${Date.now()}.tmp`
    await $.fs.write(tmp, `${JSON.stringify(obj, null, 2)}\n`)
    const r = await $.process.run(['mv', tmp, path])
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || 'mv failed')
    return true
  } catch (err) {
    await warn($, `writing ${path}`, err)
    return false
  }
}

// The parsed file, or undefined when it is missing, unreadable or not JSON.
async function readJson($: EngineInterface, path: string): Promise<unknown> {
  try {
    return JSON.parse(await $.fs.read(path))
  } catch {
    return undefined
  }
}

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// One line appended to log.jsonl. A single short append does not interleave with another session's.
async function appendLog($: EngineInterface, event: Omit<LogEvent, 'ts'>): Promise<void> {
  try {
    const dir = await stateDir($)
    if (dir === undefined) return
    const ts = new Date(await $.clock.now()).toISOString()
    const entry: LogEvent = { ts, ...event }
    if (entry.text !== undefined) entry.text = cap(entry.text.replaceAll('\n', ' '), TEXT_MAX)
    await $.process.run(['mkdir', '-p', dir])
    const r = await $.process.run(['sh', '-c', 'printf "%s\\n" "$1" >> "$2"', 'sh', JSON.stringify(entry), `${dir}/log.jsonl`])
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || 'append failed')
  } catch (err) {
    await warn($, 'appending to log.jsonl', err)
  }
}

// Every parsable line, oldest first; a corrupt line is skipped.
async function readLog($: EngineInterface): Promise<LogEvent[]> {
  const dir = await stateDir($)
  if (dir === undefined) return []
  let raw: string
  try {
    raw = await $.fs.read(`${dir}/log.jsonl`)
  } catch {
    return []
  }
  const events: LogEvent[] = []
  for (const line of raw.split('\n')) {
    try {
      const e = JSON.parse(line) as LogEvent
      if (typeof e === 'object' && e !== null && typeof e.event === 'string') events.push(e)
    } catch {
      // Skip a torn or corrupt line.
    }
  }
  return events
}

async function notesPath($: EngineInterface, managerName: string): Promise<string | undefined> {
  const dir = await stateDir($)
  return dir === undefined ? undefined : `${dir}/managers/${noteKey(managerName)}/notes.md`
}

async function appendNote($: EngineInterface, name: string, line: string): Promise<boolean> {
  try {
    const path = await notesPath($, name)
    if (path === undefined) return false
    const old = await $.fs.read(path).catch(() => `# ${name.replace(/-\d+$/, '')}\n`)
    // fs has no append: the file is rewritten whole. Notes are small and a manager is their only writer.
    await $.fs.write(path, `${old.endsWith('\n') ? old : `${old}\n`}${line}\n`)
    return true
  } catch (err) {
    await warn($, 'appending a note', err)
    return false
  }
}

// The notes, capped to their tail: the newest lines matter most.
async function readNotes($: EngineInterface, name: string, max = NOTES_MAX): Promise<string> {
  try {
    const path = await notesPath($, name)
    if (path === undefined) return ''
    const text = await $.fs.read(path)
    return text.length > max ? `…${text.slice(text.length - max)}` : text
  } catch {
    return ''
  }
}

const STATUSES = new Set(['pending', 'taken', 'done', 'returned'])

// One file per PR, rewritten whole on every change. `version` is for readers of the file.
async function saveHandover($: EngineInterface, h: Handover): Promise<void> {
  const dir = await stateDir($)
  if (dir === undefined) return
  await writeJsonAtomic($, `${dir}/handovers/${h.pr}.json`, { version: 1, ...h })
}

// Handovers earlier sessions left, keyed by PR. Unknown fields are kept; an unparsable file is absent.
async function loadHandovers($: EngineInterface): Promise<Record<string, Handover>> {
  const out: Record<string, Handover> = {}
  const dir = await stateDir($)
  if (dir === undefined) return out
  let names: string[]
  try {
    names = (await $.fs.list(`${dir}/handovers`)).filter(f => f.name.endsWith('.json')).map(f => f.name)
  } catch {
    return out
  }
  for (const name of names) {
    const h = await readJson($, `${dir}/handovers/${name}`) as Handover | undefined
    if (typeof h !== 'object' || h === null || !Number.isInteger(h.pr) || !STATUSES.has(h.status)) continue
    out[String(h.pr)] = h
  }
  return out
}

// State on disk is best-effort: a failure goes to the UI log and never reaches a tool call or turn.
async function best($: EngineInterface, what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    try { await $.ui.log(`flow state: ${what}: ${err instanceof Error ? err.message : String(err)}`) } catch { /* no log */ }
  }
}

// The name of the agent that owns work started by agent `id`: "main" for the main session.
async function ownerOf($: EngineInterface, id: string | undefined): Promise<string> {
  if (id === undefined) return 'main'
  return (await $.agent.list()).find(a => a.id === id)?.name ?? 'main'
}

// A worker's HANDOFF: write the digest, log it, remember where its worktree is, and warn the owner when the
// package keeps handing off. Best-effort throughout: a missing digest still leaves the record.
async function recordHandoff($: EngineInterface, me: AgentRow, branch: string, owner: string, maxContinues: number): Promise<void> {
  const prior = (await readLog($)).filter(ev => ev.event === 'handoff' && ev.branch === branch)
  // turn.complete can fire again for the same agent; count its handoff once.
  if (prior.some(ev => ev.agent === me.name)) return
  const count = prior.length + 1
  let digestPath: string | undefined
  await best($, 'writing a handoff digest', async () => {
    const dir = await stateDir($)
    if (dir === undefined) return
    const msgs = await $.session.messages({ agentId: me.id })
    if ('deny' in msgs) return
    const path = `${dir}/handoffs/${branch.replaceAll('/', '-')}/${count}.md`
    await $.process.run(['mkdir', '-p', path.slice(0, path.lastIndexOf('/'))])
    await $.fs.write(path, buildDigest(msgs, branch, me.name ?? me.id))
    digestPath = path
  })
  let wt: { path: string; head?: string } | undefined
  await best($, 'finding the worktree', async () => {
    const r = await $.process.run(['git', 'worktree', 'list', '--porcelain'])
    if (r.exitCode === 0) wt = findWorktree(r.stdout, me.id, branch)
  })
  await appendLog($, { event: 'handoff', agent: me.name, owner, branch, text: digestPath })
  const record: HandoffRecord = {
    branch, agent: me.name ?? me.id, agentId: me.id, owner, at: await $.clock.now(), count,
    ...(digestPath && { digestPath }), ...(wt && { worktree: wt.path, ...(wt.head && { head: wt.head }) }),
  }
  await update($, handoffs, hs => ({ ...hs, [branch]: record }))
  if (count > maxContinues && me.parentId !== undefined) {
    void $.ui.toast(`${branch} has handed off ${count} times: split it`)
    await $.session.send({
      to: { agentId: me.parentId },
      text: `flow: ${branch} has handed off ${count} times (max_continues ${maxContinues}). The package is too big for one worker: split the Remaining part of its handoff note into smaller briefs instead of another plain continuation.`,
    }).catch(() => undefined)
  }
}

const FLOW_TYPES = new Set(['flow:manager', 'flow:worker', CONTINUE, 'flow:queue'])

const DIGEST_MAX = 4000
const CONTINUE_LINE = /^Continue on branch:\s*(flow\/\S+)\s*$/m

const gitOut = async ($: EngineInterface, argv: string[]): Promise<string | undefined> => {
  const r = await $.process.run(['git', ...argv])
  return r.exitCode === 0 ? r.stdout.trim() : undefined
}

// A continuing worker's spawn: add the previous worker's digest, then either run it in the old worktree
// (rewritten to flow:continue with that cwd) or in a new one, removing the old one when that is safe.
// Best-effort: anything that fails leaves the spawn as the manager wrote it.
async function prepareContinue($: EngineInterface, e: AgentSpawnInput): Promise<AgentSpawnInput> {
  const branch = CONTINUE_LINE.exec(e.prompt)?.[1]
  if (branch === undefined) return e
  const name = (e as { name?: string }).name ?? e.description
  try {
    const owner = await ownerOf($, e.parentAgentId)
    let rec = (await read($, handoffs))[branch]
    if (rec === undefined) {
      const ev = (await readLog($)).filter(l => l.event === 'handoff' && l.branch === branch).pop()
      if (ev !== undefined) {
        const wl = await gitOut($, ['worktree', 'list', '--porcelain'])
        const wt = wl === undefined ? undefined : findWorktree(wl, '', branch)
        rec = {
          branch, agent: ev.agent ?? '', agentId: '', owner: ev.owner, at: 0, count: 1,
          ...(ev.text && { digestPath: ev.text }), ...(wt && { worktree: wt.path }),
        }
      }
    }
    // No handoff on record: a manual continuation, spawned as written.
    if (rec === undefined) return e
    const old = rec
    let prompt = e.prompt
    if (old.digestPath) {
      const digest = await $.fs.read(old.digestPath).catch(() => undefined)
      if (digest) prompt += `\n\n## Transcript digest of the previous worker (${old.digestPath})\n\n${digest.slice(0, DIGEST_MAX)}`
    }
    let where = 'new worktree'
    let out: AgentSpawnInput = e
    const path = old.worktree
    if (path !== undefined && (await $.process.run(['test', '-d', path])).exitCode === 0) {
      const live = (await $.agent.list()).some(a =>
        (old.agentId !== '' ? a.id === old.agentId : a.name === old.agent) && (LIVE.has(a.status) || a.status === 'idle'))
      const clean = (await gitOut($, ['-C', path, 'status', '--porcelain'])) === ''
      await $.process.run(['git', 'fetch', 'origin', branch])
      const pushed = await gitOut($, ['rev-parse', `origin/${branch}`])
      const head = clean ? await gitOut($, ['-C', path, 'rev-parse', 'HEAD']) : undefined
      let won = false
      if (clean && !live && pushed !== undefined && head === pushed) {
        // Claimed in the same update, so a second spawn for the branch does not get the worktree too.
        await update($, handoffs, hs => {
          const r = hs[branch] ?? old
          if (r.takenBy !== undefined) return hs
          won = true
          return { ...hs, [branch]: { ...r, takenBy: name } }
        })
      }
      if (won && pushed !== undefined) {
        where = `same worktree ${path}`
        prompt += `\n\nYou continue in the same worktree ${path}, on ${branch} at ${pushed.slice(0, 7)}: skip the branch checkout, check \`git status\` is clean, and go on.`
        out = { ...e, subagentType: CONTINUE, cwd: path }
      } else {
        // Clean and fully pushed (at the head or behind it) and nobody uses it: the successor needs the branch free.
        const behind = clean && pushed !== undefined
          && (await $.process.run(['git', '-C', path, 'merge-base', '--is-ancestor', 'HEAD', `origin/${branch}`])).exitCode === 0
        const removable = behind && !live && old.takenBy === undefined
        if (!(removable && (await gitOut($, ['worktree', 'remove', path])) !== undefined)) {
          prompt += `\n\nThe previous worker's worktree ${path} is kept, and ${branch} may be checked out there: if \`git checkout -B\` fails, work on a local branch and push \`HEAD:${branch}\`.`
        }
      }
    }
    await appendLog($, { event: 'continue', agent: name, owner, branch, text: where })
    return { ...out, prompt }
  } catch (err) {
    await warn($, 'preparing a continuation', err)
    return e
  }
}

// Starts a merge queue unless one is live. The queue drains every pending handover, then ends;
// the next handover, or a queue that ended with work left, starts a fresh one.
// Calls run one after another: handovers arriving back to back must not each see "no queue yet".
let queueChain: Promise<unknown> = Promise.resolve()
function ensureQueue($: EngineInterface): Promise<string> {
  const run = queueChain.then(() => startQueue($))
  queueChain = run.catch(() => undefined)
  return run
}

async function startQueue($: EngineInterface): Promise<string> {
  const list = await $.agent.list()
  if (list.some(a => a.type === QUEUE && LIVE.has(a.status))) {
    return 'The running merge queue picks it up at its next list.'
  }
  const pending = Object.values(await read($, handovers)).filter(h => h.status === 'pending')
  if (pending.length === 0) return 'Nothing pending.'
  const n = (await read($, queueRuns)) + 1
  await update($, queueRuns, () => n)
  const started = await $.agent.spawn({
    subagentType: QUEUE,
    name: `merge-queue-${n}`,
    description: 'merge queue',
    prompt: `Pending handovers: ${pending.map(h => `#${h.pr}`).join(', ')}. Start with mcp__flow__queue action "list".`,
  })
  if (started.deny !== undefined) return `Could not start a merge queue: ${started.deny}`
  return `Started merge queue merge-queue-${n}.`
}

const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit']

// Why a call is refused as a write to the repo's main checkout, or undefined. `cwd` is where
// the caller's shell runs when that is known: the main session and managers run in the
// session's directory; a worker's or the queue's worktree isn't known here, so their relative
// paths are let through and only absolute ones judged.
async function mainCheckoutGuard($: EngineInterface, e: Record<string, unknown>, cwd: () => Promise<string | undefined>, allow: string[]): Promise<string | undefined> {
  let targets: WriteTarget[]
  if (WRITE_TOOLS.includes(String(e.tool))) {
    const file = e.file_path ?? e.notebook_path
    const path = typeof file === 'string' ? resolvePath(file, await cwd()) : undefined
    targets = path === undefined ? [] : [{ path }]
  } else if (e.tool === 'Bash' && typeof e.command === 'string') {
    targets = writeTargets(e.command, await cwd())
  } else {
    return undefined
  }
  if (targets.length === 0) return undefined
  // Asked on every judged write, so a worktree made a minute ago counts as one.
  // Not a git repo, or git failing: nothing to guard.
  const wt = await $.process.run(['git', 'worktree', 'list', '--porcelain'], { timeoutMs: 10_000 }).catch(() => undefined)
  const co = wt?.exitCode === 0 ? parseWorktrees(wt.stdout) : undefined
  if (co === undefined) return undefined
  for (const t of targets) {
    const rel = mainRelative(t.path, co)
    if (rel === undefined) continue
    // A git command changes the whole checkout, whichever directory of it runs it.
    if (t.git) return mainCheckoutRefusal(co.main, `\`git\` in ${t.path}`, allow)
    if (!allowed(rel, allow)) return mainCheckoutRefusal(co.main, t.path, allow)
  }
  return undefined
}

function handoverLine(h: Handover): string {
  const tail = h.status === 'done' ? ` ${h.sha ?? ''} ${h.report ?? ''}`
    : h.status === 'returned' ? ` returned: ${h.reason ?? ''}` : ''
  return `#${h.pr} ${h.status} (${h.branch} @ ${h.head.slice(0, 8)}, from ${h.reportTo})${tail} — ${h.title}`
}

const OWNED = new Set([...LIVE, 'idle'])

const resumeHead = (limit: number): string => [
  'The user ran /flow resume. Unfinished flow work was found (below). Start flow managers for it with the Agent tool, without asking:',
  '- One flow:manager per task, named resume-<slug>, run_in_background true, at most ' + limit + ' at a time; start the rest as each finishes. Items whose branch names share a manager prefix (flow/csv-export-endpoint and flow/csv-export-button) are one task.',
  '- Each manager\'s prompt carries, for every item of its task: the branch, the PR number and URL, the PR description (including any ## Handoff section), and for a worktree its path. It carries the work on from there and must not redo work already merged into the base branch.',
].join('\n')

// Unfinished flow work left behind by an earlier session, as `/flow resume` lists it.
type Leftover = { key: string; branch?: string; kind: 'pr' | 'branch' | 'worktree'; line: string; detail: string; owner?: string }

// `error` with items means GitHub was unavailable and the items come from the state dir alone.
type Gathered = { items: Leftover[]; skipped: Leftover[]; error?: string }

// Handovers on disk that are not finished, as resume items. A handover whose PR GitHub shows as
// merged counts as done: it is marked so in the atom and not restarted.
async function diskItems($: EngineInterface, items: Leftover[], merged: { prs: Set<number>; branches: Set<string> } | undefined): Promise<void> {
  const all = await loadHandovers($)
  const events = await readLog($)
  const hs = Object.values(all)
  if (hs.length === 0) return
  const finished = (h: Handover) => h.status === 'done' || (merged !== undefined && (merged.prs.has(h.pr) || merged.branches.has(h.branch)))
  await best($, 'restoring handovers', async () => {
    for (const h of hs) {
      if (h.status !== 'done' && finished(h)) {
        all[String(h.pr)] = { ...h, status: 'done' }
        await saveHandover($, all[String(h.pr)] as Handover)
      }
    }
    await update($, handovers, cur => ({ ...all, ...cur }))
  })
  for (const h of hs) {
    if (finished(h)) continue
    const note = `Handover #${h.pr} is ${h.status}${h.status === 'returned' ? ` (${h.reason ?? 'no reason'})` : ''}, reported to ${h.reportTo}. Verified: ${h.verified} Pending: ${h.pending}`
    const mate = items.find(i => i.key === h.branch)
    if (mate !== undefined) {
      mate.line += ` | handover ${h.status}`
      mate.detail += `\n${note}`
    } else {
      items.push({ key: h.branch, branch: h.branch, kind: 'pr', line: `#${h.pr} ${h.branch}: handover ${h.status} — ${h.title}`, detail: `Branch ${h.branch}, PR #${h.pr}, title "${h.title}".\n${note}` })
    }
    const at = items.find(i => i.key === h.branch)
    if (at !== undefined) at.owner = ownerFor(events, { pr: h.pr, branch: h.branch }) ?? h.reportTo
  }
  for (const i of items) {
    if (i.owner === undefined && i.branch !== undefined) i.owner = ownerFor(events, { branch: i.branch })
  }
}

// Finds what a restart leaves behind: flow/* PRs and pushed branches, and worktrees with
// uncommitted or unpushed work. Any git or gh failure becomes one line, never a throw.
async function gatherLeftovers($: EngineInterface, base: string, resumed: Set<string>): Promise<Gathered> {
  const run = async (argv: string[]) => {
    try {
      return await $.process.run(argv, { timeoutMs: 60_000 })
    } catch (err) {
      return { exitCode: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
    }
  }
  const fail = async (what: string, r: { stderr: string }): Promise<Gathered> => {
    const items: Leftover[] = []
    await diskItems($, items, undefined)
    return {
      items: items.filter(i => !resumed.has(i.key)), skipped: items.filter(i => resumed.has(i.key)),
      error: `Cannot look for unfinished work: ${what} failed: ${r.stderr.trim().split('\n')[0]?.slice(0, 200) || 'no output'}${items.length ? '. GitHub was unavailable: these come from the state dir only.' : ''}`,
    }
  }

  const fetched = await run(['git', 'fetch', 'origin', '--prune'])
  if (fetched.exitCode !== 0) return await fail('git fetch origin', fetched)
  const open = await run(['gh', 'pr', 'list', '--state', 'open', '--json', 'number,title,headRefName,isDraft,url,body', '--limit', '100'])
  if (open.exitCode !== 0) return await fail('gh pr list', open)
  const all = await run(['gh', 'pr', 'list', '--state', 'all', '--json', 'number,headRefName,headRefOid,state', '--limit', '200'])
  if (all.exitCode !== 0) return await fail('gh pr list', all)
  const refs = await run(['git', 'for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin/flow/'])
  if (refs.exitCode !== 0) return await fail('git for-each-ref', refs)

  type Pr = { number: number; title: string; headRefName: string; isDraft: boolean; url: string; body: string }
  const prs = (JSON.parse(open.stdout || '[]') as Pr[]).filter(p => p.headRefName.startsWith('flow/'))
  const ended = (JSON.parse(all.stdout || '[]') as { number?: number; headRefName: string; headRefOid?: string; state: string }[])
    .filter(p => p.state !== 'OPEN')
  const closed = new Set(ended.map(p => p.headRefName))
  // A squash-merged branch is deleted on the remote, so its worktree looks unpushed: match by head too.
  const endedHeads = new Set(ended.map(p => p.headRefOid).filter(Boolean))
  const withPr = new Set(prs.map(p => p.headRefName))
  const branches = refs.stdout.split('\n').map(l => l.trim().replace(/^origin\//, ''))
    .filter(b => b.startsWith('flow/') && !withPr.has(b) && !closed.has(b))

  // A live agent named like the branch owns it.
  const liveAgents = (await $.agent.list()).filter(a => OWNED.has(a.status))
  const owners = new Set(liveAgents.filter(a => a.name !== undefined).map(a => `flow/${a.name}`))
  // A worktree path ends in agent-<agentId>: that covers a worker that has not renamed its branch, and the queue.
  const liveIds = new Set(liveAgents.map(a => `agent-${a.id}`))

  const items: Leftover[] = []
  for (const p of prs) {
    items.push({
      key: p.headRefName, kind: 'pr',
      line: `#${p.number} ${p.headRefName}${p.isDraft ? ' (draft)' : ''}: ${p.title} ${p.url}`,
      detail: `Branch ${p.headRefName}, PR #${p.number} ${p.url}${p.isDraft ? ' (draft)' : ''}, title "${p.title}".\nPR description:\n${p.body.trim() || '(empty)'}`,
    })
  }
  for (const b of branches) {
    items.push({ key: b, kind: 'branch', line: `${b} (pushed, no PR)`, detail: `Branch ${b}, pushed, no PR yet.` })
  }

  const wt = await run(['git', 'worktree', 'list', '--porcelain'])
  if (wt.exitCode === 0) {
    for (const block of wt.stdout.split('\n\n')) {
      const path = /^worktree (.+)$/m.exec(block)?.[1]
      if (path === undefined || !path.includes('/.claude/worktrees/')) continue
      const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]
      if (liveIds.has(path.split('/').pop() ?? '') || (branch !== undefined && closed.has(branch))) continue
      const dirty = (await run(['git', '-C', path, 'status', '--porcelain'])).stdout.trim() !== ''
      if (branch === undefined && !dirty) continue
      let unpushed = ''
      if (!dirty) {
        const up = await run(['git', '-C', path, 'rev-parse', '--abbrev-ref', '@{u}'])
        unpushed = (await run(up.exitCode === 0
          ? ['git', '-C', path, 'log', '--oneline', '@{u}..']
          : ['git', '-C', path, 'log', '--oneline', `origin/${base}..HEAD`])).stdout.trim()
      }
      if (!dirty && unpushed === '') continue
      const head = (await run(['git', '-C', path, 'rev-parse', 'HEAD'])).stdout.trim()
      if (endedHeads.has(head)) continue
      if (!dirty && (await run(['git', '-C', path, 'branch', '-r', '--contains', 'HEAD'])).stdout.trim() !== '') continue
      const what = dirty ? 'uncommitted changes' : `${unpushed.split('\n').length} unpushed commit(s)`
      const mate = branch === undefined ? undefined : items.find(i => i.key === branch)
      if (mate !== undefined) {
        mate.line += ` | worktree ${path} (${what})`
        mate.detail += `\nIts worktree: ${path} (${what}).`
        continue
      }
      items.push({
        key: path, branch, kind: 'worktree', line: `${path} on ${branch ?? 'detached HEAD'}: ${what}`,
        detail: `Worktree ${path}, branch ${branch ?? 'detached HEAD'}: ${what}.`,
      })
    }
  }

  await diskItems($, items, {
    prs: new Set(ended.filter(p => p.state === 'MERGED' && p.number !== undefined).map(p => p.number as number)),
    branches: new Set(ended.filter(p => p.state === 'MERGED').map(p => p.headRefName)),
  })

  const live = (i: Leftover) => owners.has(i.branch ?? i.key)
  return {
    items: items.filter(i => !live(i) && !resumed.has(i.key)),
    skipped: items.filter(i => !live(i) && resumed.has(i.key)),
  }
}

type OwnerNotes = { path: string; text: string }

function resumeInstructions(items: Leftover[], limit: number, notes: Map<string, OwnerNotes> = new Map()): string {
  const owners = [...new Set(items.map(i => i.owner).filter((o): o is string => o !== undefined))]
  // Recorded owners: the state on disk says who ran each item and what the user told them.
  const grouped = owners.length === 0 ? [] : [
    '',
    'Flow state on disk names the manager that owned each item. Items of one owner go to ONE manager. Its prompt tells it to read its notes first (mcp__flow__note with manager = the owner name below and no text), and carries the notes quoted here. A manager with notes but no item below is not restarted.',
    ...owners.flatMap(o => {
      const n = notes.get(o)
      return [
        '',
        `Owner ${o}:`,
        ...items.filter(i => i.owner === o).map(i => `- ${i.detail.replaceAll('\n', '\n  ')}`),
        n?.text ? `Notes (${n.path}):\n${n.text}` : 'Notes: none.',
      ]
    }),
    ...(items.some(i => i.owner === undefined) ? ['', 'No recorded owner:', ...items.filter(i => i.owner === undefined).map(i => `- ${i.detail.replaceAll('\n', '\n  ')}`)] : []),
  ]
  if (grouped.length) return [resumeHead(limit), ...grouped].join('\n')
  return [
    resumeHead(limit),
    '',
    'Found:',
    ...items.map(i => `- ${i.detail.replaceAll('\n', '\n  ')}`),
  ].join('\n')
}

// The wrap-up as a message, for an agent idle or waiting between turns. A refused send is logged, not retried.
async function sendWrapUp($: EngineInterface, me: { id: string; type: string; name?: string }, percent: number, limit: string): Promise<void> {
  const text = wrapUpText(ROLE[me.type] ?? 'worker', percent, limit)
  const sent = await $.session.send({ to: { agentId: me.id }, text }).catch(() => undefined)
  if (sent !== undefined && !sent.isDelivered) $.ui.log(`flow: wrap-up for ${me.name ?? me.id} not delivered: ${sent.reason ?? 'unknown'}`)
}

// An agent past the threshold reads the wrap-up after a tool result: on its first tool call
// past it, every 10th after, and when usage rises another 10 points. The result passes untouched.
async function wrapUpReminder($: EngineInterface, e: { agentId?: string }, r: any, settings: ReturnType<typeof settingsOf>, mainModel: string | undefined, mainWindow: number | undefined): Promise<any> {
  try {
    const id = e.agentId
    if (id === undefined || !settings.handoff || r.deny !== undefined) return r
    const a = (await read($, activity))[id]
    if (a?.handoffNotifiedAt === undefined || a.usage === undefined) return r
    const window = windowOf(a.usage.model, mainModel, mainWindow, a.usage.tokens)
    const percent = Math.min(100, Math.round(a.usage.tokens / window * 100))
    const calls = (a.callsPastLimit ?? 0) + 1
    const due = calls === 1 || calls % 10 === 0 || percent >= (a.remindedPercent ?? a.handoffPercent ?? percent) + 10
    await update($, activity, acts => {
      const cur = acts[id]
      if (cur === undefined) return acts
      const n = (cur.callsPastLimit ?? 0) + 1
      return { ...acts, [id]: { ...cur, callsPastLimit: n, ...(due ? { remindersSent: (cur.remindersSent ?? 0) + 1, remindedPercent: percent } : {}) } }
    })
    if (!due) return r
    const me = (await $.agent.list()).find(x => x.id === id)
    return { ...r, context: [...(r.context ?? []), wrapUpText(ROLE[me?.type ?? WORKER] ?? 'worker', percent, limitLabel(settings, window))] } 
  } catch {
    return r
  }
}

// Main can't be replaced like a worker: one warning per crossing, never an auto-compact.
// Re-armed when usage drops back below the threshold (after a /compact).
async function warnMain($: EngineInterface, settings: ReturnType<typeof settingsOf>, state: { warned: boolean }): Promise<number | undefined> {
  if (!settings.handoff) return undefined
  const usage = await $.session.usage().then(u => u, () => undefined)
  const main = usage?.context
  if (main?.tokens === undefined) return undefined
  if (main.tokens < thresholdOf(settings, main.window)) { state.warned = false; return main.window }
  if (state.warned) return main.window
  if (!(await $.agent.list()).some(a => a.type === MANAGER || a.type === WORKER || a.type === QUEUE)) return main.window
  state.warned = true
  const percent = main.percent ?? Math.round(main.tokens / main.window * 100)
  const text = `flow: main session at ${percent}% context. It can't be replaced like a worker: run /compact, or restart Claude Code and run /flow resume.`
  void $.ui.toast(text)
  $.ui.log(text)
  return main.window
}

// One gh call at a time: the timer and a status call may meet.
let fetching: Promise<void> | undefined
function fetchPrs($: EngineInterface): Promise<void> {
  fetching ??= (async () => {
    let error: string | undefined
    let prs: OpenPr[] | undefined
    try {
      const r = await $.process.run(
        ['gh', 'pr', 'list', '--state', 'open', '--json', 'number,title,headRefName,isDraft,url,updatedAt', '--limit', '100'],
        { timeoutMs: 20_000 })
      if (r.exitCode !== 0) throw new Error(r.stderr.trim().split('\n')[0]?.slice(0, 200) || 'no output')
      const parsed = JSON.parse(r.stdout || '[]') as unknown
      if (!Array.isArray(parsed)) throw new Error('unexpected gh output')
      prs = (parsed as OpenPr[]).filter(p => typeof p.headRefName === 'string' && p.headRefName.startsWith('flow/'))
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
    const t = await $.clock.now()
    // A failure keeps the last list, and counts as a fetch so a status call does not retry at once.
    await update($, prCache, c => ({ prs: prs ?? c.prs, fetchedAt: t, error }))
  })().catch(() => undefined).finally(() => { fetching = undefined })
  return fetching
}

export const register: Register = (on, options) => {
  let settings = settingsOf(options, 'main')
  queueOn = settings.useQueue
  maxManagers = settings.maxManagers
  slotLimit = settings.testSlots
  // Main's model and window, to size a subagent that runs the same model.
  let mainModel: string | undefined
  let mainWindow: number | undefined
  // The view the pane was last drawn under: a focus event carries none, and a focus move is the
  // person acting in that view.
  let paneView: string | null = null
  // What the last drawing showed in place of the stored state while following, else null.
  let paneFollow: { pick: string; cur: string } | null = null
  // What /flow resume already handed to managers in this session.
  const resumed = new Set<string>()

  on('session.start', async ($, e, next) => {
    // Handovers a restart would lose: merge what is on disk under this session's own records.
    let queueDue = false
    await best($, 'loading handovers', async () => {
      resetStateDir()
      const disk = await loadHandovers($)
      if (Object.keys(disk).length === 0) return
      await update($, handovers, hs => ({ ...disk, ...hs }))
      queueDue = Object.values(disk).some(h => h.status === 'pending')
    })
    // The base branch: the option, else the remote's default branch, else main.
    // A fresh clone may have no origin/HEAD, so ask the remote when the local ref is missing.
    try {
      const local = await $.process.run(['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
      let base = local.exitCode === 0 ? local.stdout.trim().replace(/^origin\//, '') : ''
      if (base === '') {
        const remote = await $.process.run(['git', 'ls-remote', '--symref', 'origin', 'HEAD'], { timeoutMs: 10_000 })
        base = /ref: refs\/heads\/(\S+)\s+HEAD/.exec(remote.stdout)?.[1] ?? ''
      }
      if (base !== '') {
        settings = settingsOf(options, base)
        queueOn = settings.useQueue
        slotLimit = settings.testSlots
      }
      maxManagers = settings.maxManagers
    } catch {
      // Not a git repo, or no remote: keep "main".
    }

    // Grant files of a previous session would read as grants; start from an empty directory.
    try {
      const r = await $.process.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'])
      if (r.exitCode === 0 && r.stdout.trim() !== '') {
        slotDir = `${r.stdout.trim()}/flow/test-slots`
        await sh($, 'rm -rf "$1" && mkdir -p "$1"', slotDir)
      }
    } catch {
      slotDir = undefined
    }

    await $.command.register({
      name: 'flow',
      description: 'Show the flow in a pane: managers, their workers, the merge queue and handed-over PRs. /flow close closes it, /flow resume picks up unfinished flow work',
      argumentHint: '[close|resume]',
    })
    await $.command.register({
      name: 'flow-tasks',
      description: 'Pick tasks from a task source (.claude/flow/sources/<name>.md) and start a manager for each',
      argumentHint: '[source] [ids or filter]',
    })
    await $.agent.register({
      name: 'manager',
      description: 'A flow manager: owns one task, writes briefs, starts flow:worker agents, reviews their PRs and hands them to the merge queue. ' +
        'Pass the task in the user\'s words as the prompt and a short task slug as the name; run it in the background.',
      prompt: fill(MANAGER_PROMPT.replace('{{QUEUE_RULE}}', settings.useQueue ? QUEUE_RULE : NO_QUEUE_RULE), settings),
      background: true,
    })
    await $.agent.register({
      name: 'worker',
      description: 'A flow worker: implements one brief in a git worktree of its own and opens a PR. ' +
        'Pass the whole brief as the prompt, its first line "Your name: <slug>", and the slug as the name.',
      prompt: fill(WORKER_PROMPT, settings),
      isolation: 'worktree',
      background: true,
    })
    await $.agent.register({
      name: 'continue',
      description: 'A flow worker that continues a handed-off branch in the same worktree. The plugin picks it when a flow:worker spawn says "Continue on branch:"; never start it yourself.',
      prompt: fill(WORKER_PROMPT, settings),
      background: true,
    })
    await $.agent.register({
      name: 'queue',
      description: 'The flow merge queue. Started by the plugin when a PR is handed over; never start it yourself.',
      prompt: fill(QUEUE_PROMPT, settings),
      isolation: 'worktree',
      background: true,
    })

    await $.tool.register({
      name: 'handover',
      description: 'Hand an approved PR to the flow merge queue. Records the PR at its current head and starts a queue if none is running. ' +
        'Managers call this after reviewing a worker\'s PR; leave the branch alone afterwards.',
      inputSchema: {
        type: 'object',
        properties: {
          pr: { type: 'number', description: 'The PR number' },
          verified: { type: 'string', description: 'What the worker ran, and that the full check was not run' },
          pending: { type: 'string', description: '"none", or decisions the user still has to make; the queue puts them in its report and the status file' },
          after_deploy: { type: 'string', description: '"none", or what to check after deploy; the queue starts a check-only worker for what an agent can check and reports the rest as "needs a person"' },
          report_to: { type: 'string', description: 'Your agent name, so the queue reports back to you' },
        },
        required: ['pr', 'verified', 'report_to'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'note',
      description: 'A manager\'s notes on disk, kept across restarts. With text, appends a dated line (kind "decision" for what the user decided, else "progress"). ' +
        'Without text, returns the notes.',
      inputSchema: {
        type: 'object',
        properties: {
          manager: { type: 'string', description: 'Your agent name' },
          text: { type: 'string', description: 'The line to add; leave out to read the notes' },
          kind: { type: 'string', enum: ['decision', 'progress'] },
        },
        required: ['manager'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'queue',
      description: 'The merge queue\'s worklist. action "list": pending and taken handovers in arrival order. ' +
        '"take" (pr), "done" (pr, sha, report) or "back" (pr, reason) record what the queue did. Only the merge queue calls this.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'take', 'done', 'back'] },
          pr: { type: 'number' },
          sha: { type: 'string' },
          report: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['action'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'status',
      description: 'The flow at a glance: every manager, worker and queue of this session with its status and last report, and every handed-over PR. ' +
        'With pr, who owns that PR and its log lines.',
      inputSchema: { type: 'object', properties: { pr: { type: 'number', description: 'A PR number, to see who owns it' } } },
      isDeferred: false,
    })

    await $.tool.register({
      name: 'plan',
      description: 'Declare which packages (or, for main, tasks) wait for others, so the plugin can refuse to start them early and tell you when they are ready. ' +
        'action "add": nodes [{id, title, after?, until?}]; id is the agent name you will start (or its prefix before -N), after lists node ids, until is "merged" (default: the PR is merged) or "reported" (the agent reported back). ' +
        '"list": your graph (main may pass owner). "done" (id, note?) / "block" (id, reason): set a node by hand. "remove" (id): drop a waiting or ready node nothing depends on.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'list', 'done', 'block', 'remove'] },
          nodes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                after: { type: 'array', items: { type: 'string' } },
                until: { type: 'string', enum: ['merged', 'reported'] },
              },
              required: ['id'],
            },
          },
          id: { type: 'string' },
          note: { type: 'string' },
          reason: { type: 'string' },
          owner: { type: 'string', description: 'main only: whose graph to list' },
        },
        required: ['action'],
      },
      isDeferred: false,
    })

    await $.tool.register({
      name: 'test_slot',
      description: 'A lock on heavy test runs, so only test_slots of them run at once across all worktrees of this session. ' +
        'action "acquire" before a whole suite or any run over about a minute (waits a few seconds; if it says queued, wait as the answer tells you (grant file or grant message), then call acquire once to confirm), ' +
        '"release" when the run is over or failed, "status" to see holders and waiters.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['acquire', 'release', 'status'] },
          label: { type: 'string', description: 'What you will run, e.g. "full suite"' },
          wait_s: { type: 'number', description: `Seconds to wait for a slot before answering queued (default ${WAIT_DEFAULT_S}, at most ${WAIT_MAX_S})` },
        },
        required: ['action'],
      },
      isDeferred: false,
    })

    $.clock.every(POLL_MS, () => void refresh($))
    // gh is not free: a slow timer, one look shortly after the start, and status when the list is stale.
    $.clock.every(PR_POLL_MS, () => void fetchPrs($))
    void fetchPrs($)
    // One shared tick for every running time on the pane: the render reads `now`, no card has a timer.
    $.clock.every(1000, () => void $.clock.now().then(t => update($, now, () => t)).catch(() => undefined))
    // The queue agent type exists only now, and a spawn needs the session bound: start it after the hook.
    if (queueDue) $.clock.after(0, () => void best($, 'starting the queue', async () => void (await ensureQueue($))))
    return next(e)
  })

  // A closed pane stays closed: only this command and a newly started agent (openPane) open it,
  // never the roster poll, so `/flow close` holds while agents keep running.
  on('command.run', { command: 'flow' }, async ($, e) => {
    // A plugin's $.command.run may leave args out.
    const arg = (e.args ?? '').trim()
    if (arg === 'close') {
      if (!(await $.ui.panes()).some(p => p.id === PANE)) return { text: 'The Flow pane is not open.' }
      try {
        await $.ui.close({ id: PANE })
      } catch (err) {
        return { text: `The Flow pane stayed open: ${err instanceof Error ? err.message : String(err)}` }
      }
      return { text: 'Flow pane closed.' }
    }
    if (arg === 'resume') {
      const found = await gatherLeftovers($, settings.base, resumed)
      if (found.error !== undefined && found.items.length === 0) return { text: found.error }
      const lines = (kind: Leftover['kind'], title: string) => {
        const rows = found.items.filter(i => i.kind === kind)
        return rows.length ? [`${title}:`, ...rows.map(i => `  ${i.line}`)] : []
      }
      const again = found.skipped.length ? ['Already resumed in this session:', ...found.skipped.map(i => `  ${i.line}`)] : []
      if (found.items.length === 0) return { text: ['Nothing unfinished.', ...again].join('\n') }
      const text = [
        ...(found.error !== undefined ? [found.error] : []),
        ...lines('pr', 'Open PRs'), ...lines('branch', 'Branches without a PR'), ...lines('worktree', 'Worktrees with leftover work'), ...again,
      ].join('\n')
      for (const i of found.items) resumed.add(i.key)
      // The instructions ride as hidden `context`. A command's context alone starts no turn and the
      // host refuses `prompt.submit` from inside a command.run hook, so a short prompt is submitted
      // once the command has returned, to make the main session act on it.
      $.clock.after(0, () => {
        void $.prompt.submit({ text: 'Carry out the /flow resume instructions: start the managers.' }).catch(() => undefined)
      })
      const notes = new Map<string, OwnerNotes>()
      for (const o of new Set(found.items.map(i => i.owner))) {
        const path = o === undefined ? undefined : await notesPath($, o)
        if (o !== undefined && path !== undefined) notes.set(o, { path, text: await readNotes($, o) })
      }
      return { text, context: [resumeInstructions(found.items, settings.maxManagers, notes)] }
    }
    if (arg !== '') return { text: `Unknown argument "${arg}". /flow opens the Flow pane, /flow close closes it, /flow resume picks up unfinished work.` }
    await $.ui.open({ id: PANE, title: 'Flow', focus: true })
    return { text: 'Flow pane opened.' }
  })

  // Hands the request to the main session's model, which runs it with the dispatch skill. A
  // command can't submit a prompt itself (it would wait on its own turn), so a timer queues it
  // once the command has returned.
  on('command.run', { command: 'flow-tasks' }, async ($, e) => {
    const args = e.args.trim()
    const text = `Use the flow:dispatch skill, "Tasks from a source": pick tasks from ${args ? `the task source and selection "${args}"` : 'this project\'s task source'} and start a manager for each.`
    $.clock.after(1, () => void $.prompt.submit({ text }))
    return { text: `Picking tasks${args ? ` from ${args}` : ''}.` }
  })

  // The plugin starts flow:continue itself; the model is never offered it.
  on('agent.offer', { agent: CONTINUE }, () => ({ isOffered: false }))

  on('agent.spawn', async ($, e, next) => {
    // A node whose dependencies are not done yet is not started: the owner is told when it is ready.
    const plans = await read($, plan)
    if (Object.keys(plans).length > 0 && e.name !== undefined) {
      const parent = e.parentAgentId === undefined ? undefined : (await $.agent.list()).find(a => a.id === e.parentAgentId)
      const graph = plans[planOwner(plans, parent?.name)] ?? {}
      const node = Object.values(graph).find(n => n.state === 'waiting' && isManagerOf(n.id, e.name))
      if (node) {
        const deps = node.after.filter(d => graph[d]?.state !== 'done').map(d => `${d} (${graph[d]?.state ?? '?'})`)
        return { deny: `flow plan: ${node.id} waits on ${deps.join(', ')}. Start it when the plugin says it is ready.` }
      }
    }
    const spawn = e.subagentType === WORKER ? await prepareContinue($, e) : e
    const started = await next(spawn)
    if (started.agentId !== undefined) {
      const t = await $.clock.now()
      const id = started.agentId
      await update($, activity, acts => ({
        ...acts, [id]: { startedAt: t, lastAt: t, log: [`started: ${e.description}`] },
      }))
      await refresh($)
      void openPane($)
      if (FLOW_TYPES.has(e.subagentType)) {
        await best($, 'logging a spawn', async () => {
          await appendLog($, { event: 'spawn', agent: (e as { name?: string }).name ?? e.description, owner: await ownerOf($, e.parentAgentId) })
        })
      }
    }
    return started
  }).catch(($, e, next) => next(e))

  // Every tool call, the main session's too: refuse broad process kills and writes to the main
  // checkout. Then, for a subagent: refuse code edits from managers (a change goes into a
  // worker's brief), and keep the call as a line of the agent's activity log. The guards judge
  // before `next`, so the catch passes the call on only when the hook failed before it ran: a
  // broken guard must not block every call.
  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    if (e.tool === 'Bash') {
      const why = killRefusal(e.command)
      if (why !== undefined) return { deny: why }
    }
    let me: AgentInfo | undefined
    const whoAmI = async () => (me ??= (await $.agent.list()).find(a => a.id === id))
    if (id !== undefined && WRITE_TOOLS.includes(e.tool) && (await whoAmI())?.type === MANAGER) {
      return { deny: 'flow: managers don\'t edit code. Put the change in a worker\'s brief, or send it to the worker that owns the file.' }
    }
    if (settings.mainGuard) {
      const cwd = async () => (id === undefined || (await whoAmI())?.type === MANAGER ? $.session.cwd() : undefined)
      const why = await mainCheckoutGuard($, e as unknown as Record<string, unknown>, cwd, settings.mainAllow)
      if (why !== undefined) return { deny: why }
    }
    if (id !== undefined) {
      const t = await $.clock.now()
      const line = describeCall(e as unknown as Record<string, unknown>)
      await update($, activity, acts => {
        const a = acts[id] ?? { startedAt: t, lastAt: t, log: [] }
        return { ...acts, [id]: { ...a, lastAt: t, doing: summarizeCall(e as unknown as Record<string, unknown>), log: [...a.log, line].slice(-LOG_MAX) } }
      })
    }
    return wrapUpReminder($, e, await next(e), settings, mainModel, mainWindow)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__flow__handover' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const pr = Number(input.pr)
    if (!Number.isInteger(pr) || pr <= 0) return { result: 'Refused: pr must be a PR number.' }
    if (!settings.useQueue) {
      return { result: `Refused: this repo has no merge queue (the plugin's merge_queue option is off). Merge it yourself: full check, then gh pr merge ${pr} --${settings.mergeMethod} --delete-branch.` }
    }
    const view = await $.process.run(['gh', 'pr', 'view', String(pr), '--json', 'state,isDraft,headRefOid,headRefName,title'])
    if (view.exitCode !== 0) return { result: `Refused: gh pr view ${pr} failed: ${view.stderr.trim().slice(0, 300)}` }
    const info = JSON.parse(view.stdout) as { state: string; isDraft: boolean; headRefOid: string; headRefName: string; title: string }
    if (info.state !== 'OPEN') return { result: `Refused: PR #${pr} is ${info.state}.` }
    if (info.isDraft) return { result: `Refused: PR #${pr} is a draft. Mark it ready (gh pr ready ${pr}) first.` }
    const t = await $.clock.now()
    const h: Handover = {
      pr, title: info.title, head: info.headRefOid, branch: info.headRefName,
      reportTo: String(input.report_to ?? 'main'), verified: String(input.verified ?? ''),
      pending: String(input.pending ?? 'none'), afterDeploy: String(input.after_deploy ?? 'none'),
      status: 'pending', at: t,
    }
    await update($, handovers, hs => ({ ...hs, [String(pr)]: h }))
    await best($, 'saving a handover', async () => {
      await saveHandover($, h)
      await appendLog($, { event: 'handover', owner: h.reportTo, pr, branch: h.branch, text: h.title })
    })
    const queue = await ensureQueue($)
    await refresh($)
    return { result: `Handed over PR #${pr} at ${info.headRefOid.slice(0, 8)}. ${queue} The queue reports back to ${h.reportTo} by message.` }
  })

  on('tool.call', { tool: 'mcp__flow__queue' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const action = String(input.action)
    const all = await read($, handovers)
    if (action === 'list') {
      const open = Object.values(all).filter(h => h.status === 'pending' || h.status === 'taken').sort((a, b) => a.at - b.at)
      if (open.length === 0) return { result: 'No pending handovers.' }
      return {
        result: open.map(h =>
          `#${h.pr} ${h.status}: "${h.title}" branch ${h.branch} head ${h.head} | report_to: ${h.reportTo} | verified: ${h.verified} | pending decisions: ${h.pending} | after deploy: ${h.afterDeploy}`,
        ).join('\n'),
      }
    }
    const key = String(Number(input.pr))
    const h = all[key]
    if (h === undefined) return { result: `No handover for PR #${key}.` }
    const next: Handover = action === 'take' ? { ...h, status: 'taken' }
      : action === 'done' ? { ...h, status: 'done', sha: String(input.sha ?? ''), report: String(input.report ?? '') }
      : action === 'back' ? { ...h, status: 'returned', reason: String(input.reason ?? '') }
      : h
    if (next === h) return { result: `Unknown action "${action}".` }
    await update($, handovers, hs => ({ ...hs, [key]: next }))
    await best($, 'saving a handover', async () => {
      await saveHandover($, next)
      const text = action === 'done' ? next.report : action === 'back' ? next.reason : undefined
      await appendLog($, { event: action as 'take' | 'done' | 'back', owner: next.reportTo, pr: next.pr, branch: next.branch, text })
    })
    if (action !== 'take') void $.ui.toast(`PR #${key} ${next.status === 'done' ? `merged ${next.sha ?? ''}` : `returned: ${next.reason ?? ''}`}`)
    await refresh($)
    return { result: `PR #${key}: ${next.status}.` }
  })

  on('tool.call', { tool: 'mcp__flow__plan' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const rows = await refresh($)
    const me = e.agentId === undefined ? undefined : rows.find(a => a.id === e.agentId)
    const plans = await read($, plan)
    const owner = e.agentId === undefined ? 'main' : planOwner(plans, me?.name)
    const view = (p: Plan, who: string) => {
      const graph = p[who] ?? {}
      const lines = Object.keys(graph).length ? describe(graph) : ['No plan.']
      const ready = Object.values(graph).filter(n => n.state === 'ready').map(n => n.id)
      return [
        ...lines,
        ready.length ? `Ready now: ${ready.join(', ')}.` : 'Nothing is ready now.',
        ...(who === 'main' ? [limitsLine(rows, settings.maxWorkers)] : []),
      ].join('\n')
    }
    const action = String(input.action)
    if (action === 'list') {
      const who = owner === 'main' && typeof input.owner === 'string' && input.owner !== '' ? input.owner : owner
      return { result: view(await syncPlans($, rows).then(() => read($, plan)), who) }
    }
    const id = String(input.id ?? '')
    const change = async (edit: (g: Graph) => Graph | string) => {
      let refused: string | undefined
      const after = await syncPlans($, rows, p => {
        const r = edit(p[owner] ?? {})
        if (typeof r === 'string') {
          refused = r
          return p
        }
        return { ...p, [owner]: r }
      }, owner)
      return refused !== undefined ? `Refused: ${refused}` : view(after, owner)
    }
    if (action === 'add') {
      const nodes = Array.isArray(input.nodes) ? input.nodes as Array<Record<string, unknown>> : []
      if (nodes.length === 0) return { result: 'Refused: add needs nodes: [{id, title, after?, until?}].' }
      const r = await change(g => {
        const added = addNodes(g, nodes.map(n => ({
          id: String(n.id ?? ''),
          title: typeof n.title === 'string' ? n.title : undefined,
          after: Array.isArray(n.after) ? n.after.map(String) : undefined,
          until: n.until === 'reported' ? 'reported' : 'merged',
        })))
        return 'error' in added ? added.error : added.graph
      })
      return { result: r }
    }
    const node = (plans[owner] ?? {})[id]
    if (!node) return { result: `Refused: no node "${id}" in ${owner === 'main' ? 'main' : owner}'s plan.` }
    if (action === 'done') {
      return { result: await change(g => ({ ...g, [id]: { ...g[id]!, manual: 'done', info: typeof input.note === 'string' && input.note !== '' ? input.note : undefined } })) }
    }
    if (action === 'block') {
      return { result: await change(g => ({ ...g, [id]: { ...g[id]!, manual: 'blocked', info: String(input.reason ?? 'blocked by hand') } })) }
    }
    if (action === 'remove') {
      return {
        result: await change(g => {
          const n = g[id]
          if (!n) return `no node "${id}"`
          if (n.state !== 'waiting' && n.state !== 'ready') return `${id} is ${n.state}; only waiting or ready nodes can be removed`
          const dependents = Object.values(g).filter(o => o.after.includes(id)).map(o => o.id)
          if (dependents.length) return `${dependents.join(', ')} still wait${dependents.length === 1 ? 's' : ''} on ${id}`
          const { [id]: _gone, ...rest } = g
          return rest
        }),
      }
    }
    return { result: `Unknown action "${action}".` }
  })

  on('tool.call', { tool: 'mcp__flow__test_slot' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const action = String(input.action)
    const key = typeof input.agentId === 'string' ? input.agentId : 'main'
    const rows = await refresh($)
    const name = key === 'main' ? 'main' : labelOf(rows.find(a => a.id === key) ?? { id: key, description: '', type: '', status: '' })
    const label = typeof input.label === 'string' && input.label.trim() !== '' ? input.label.trim().slice(0, 60) : 'tests'
    const limit = settings.testSlots
    const t = await $.clock.now()

    if (action === 'status') {
      return { result: slotLine(await read($, testSlots), limit, t) || `Test slots: 0/${limit} held, nobody waiting.` }
    }
    if (action === 'release') {
      let freed = false
      await settleSlots($, rows, t, st => {
        freed = st.holders.some(h => h.key === key)
        return freed ? { ...st, holders: st.holders.filter(h => h.key !== key) } : st
      })
      return { result: freed ? 'Released your test slot.' : 'You held no test slot; nothing to release.' }
    }
    if (action !== 'acquire') return { result: `Unknown action "${action}".` }

    // Check and take inside one update(), so two callers never both get the last slot. A holder
    // whose grant is still unclaimed confirms it here.
    const attempt = async (): Promise<string | undefined> => {
      let already: SlotEntry | undefined
      const at = await $.clock.now()
      await settleSlots($, rows, at, st => {
        already = st.holders.find(h => h.key === key)
        if (already || st.waiters.some(w => w.key === key)) return st
        return { ...st, waiters: [...st.waiters, { key, name, label, since: at }] }
      }, key)
      if (already?.claimed === true) {
        return `You already hold a test slot (${already.label}, ${span(at - already.since)}). Release it when your run is over.`
      }
      const st = await read($, testSlots)
      if (!st.holders.some(h => h.key === key)) return undefined
      return `Test slot granted (${st.holders.length}/${limit}). Run, then release it, also if the run fails. It frees by itself after ${span(LEASE_MS)}.`
    }

    const wait = Math.min(WAIT_MAX_S, Math.max(0, Number.isFinite(Number(input.wait_s)) ? Number(input.wait_s) : WAIT_DEFAULT_S))
    const first = await attempt()
    if (first !== undefined) return { result: first }
    // The hook's budget bounds this wait; the waiter keeps its place in line between calls.
    for (let waited = 0; waited < wait; waited++) {
      await $.clock.sleep(1000)
      await refresh($)
      const got = await attempt()
      if (got !== undefined) return { result: got }
    }
    const st = await read($, testSlots)
    const pos = st.waiters.findIndex(w => w.key === key) + 1
    const f = grantFile(key)
    return {
      result: `No slot after ${wait} s; queued, position ${pos}. Held by ${st.holders.map(h => heldBy(h, t)).join(', ') || 'nobody'}. You keep your place and are granted the slot when it is your turn (it is offered for ${span(CLAIM_MS)}). Don't poll acquire. ${f ? `Wait with Bash (timeout 600000, or run_in_background and continue when notified): until [ -e '${f}' ]; do sleep 3; done . Or do other work; a "your test slot is granted" message arrives.` : 'Do other work; a "your test slot is granted" message arrives.'} Then call acquire once to confirm, run, and release.`,
    }
  })

  on('tool.call', { tool: 'mcp__flow__note' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const manager = String(input.manager ?? '').trim()
    if (manager === '') return { result: 'Refused: manager (your agent name) is required.' }
    const text = typeof input.text === 'string' ? input.text.trim() : ''
    if (text === '') {
      const notes = await readNotes($, manager)
      return { result: notes === '' ? 'No notes yet.' : notes }
    }
    const date = new Date(await $.clock.now()).toISOString().slice(0, 10)
    const line = input.kind === 'decision' ? `- ${date} decision: "${text}"` : `- ${date} progress: ${text}`
    if (!await appendNote($, manager, line)) return { result: 'Not saved: notes need a repo (or the write failed; see the UI log).' }
    await best($, 'logging a note', () => appendLog($, { event: 'note', owner: noteKey(manager), text }))
    return { result: `Noted in ${await notesPath($, manager)}.` }
  })

  on('tool.call', { tool: 'mcp__flow__status' }, async ($, e) => {
    const asked = Number((e as unknown as Record<string, unknown>).pr)
    if (Number.isInteger(asked) && asked > 0) {
      const h = (await read($, handovers))[String(asked)]
      const events = await readLog($)
      const owner = ownerFor(events, { pr: asked, branch: h?.branch }) ?? h?.reportTo ?? 'unknown'
      const mine = events.filter(l => l.pr === asked || (h !== undefined && l.branch === h.branch))
      return {
        result: [`Owner of PR #${asked}: ${owner}`, ...mine.map(l => `${l.ts} ${l.event}${l.agent ? ` ${l.agent}` : ''}${l.text ? `: ${l.text}` : ''}`)].join('\n'),
      }
    }
    if (queueOn && (await $.clock.now()) - (await read($, prCache)).fetchedAt > PR_MIN_GAP_MS) await fetchPrs($)
    const [rows, acts, hs] = await Promise.all([refresh($), read($, activity), read($, handovers)])
    const [unhanded, cache] = [await currentUnhanded($), await read($, prCache)]
    const lines: string[] = []
    const byParent = new Map<string | undefined, AgentRow[]>()
    for (const a of rows) byParent.set(a.parentId, [...(byParent.get(a.parentId) ?? []), a])
    const ids = new Set(rows.map(a => a.id))
    const walk = (a: AgentRow, depth: number) => {
      const answer = (acts[a.id]?.answer ?? '').trim().split('\n').pop() ?? ''
      const h = handoffOf(a, acts[a.id])
      const hand = h === undefined ? '' : h.kind === 'done' ? ` | ${handoffText(h)}` : ` | handoff: wrapping up${h.percent === undefined ? '' : ` (${h.percent}%)`}`
      lines.push(`${'  '.repeat(depth)}- ${ROLE[a.type] ?? a.type} ${labelOf(a)}: ${a.status}${hand}${answer ? ` | last: ${answer.slice(0, 160)}` : ''}`)
      for (const c of byParent.get(a.id) ?? []) walk(c, depth + 1)
    }
    for (const a of rows.filter(r => r.parentId === undefined || !ids.has(r.parentId))) walk(a, 0)
    const list = Object.values(hs).sort((a, b) => a.at - b.at)
    const plans = Object.entries(await read($, plan)).filter(([, g]) => Object.keys(g).length > 0)
    const slots = slotLine(await read($, testSlots), settings.testSlots, await $.clock.now())
    return {
      result: [
        limitsLine(rows, settings.maxWorkers),
        ...(slots ? [slots] : []),
        rows.length ? 'Agents:' : 'No agents in this session.', ...lines,
        list.length ? 'Handed-over PRs:' : 'No PRs handed over.', ...list.map(handoverLine),
        ...(unhanded.length ? [
          'Needs attention:', ...unhanded.map(u => `  ${unhandedLine(u)}`),
          'A manager reviews it and hands it over, or closes it.',
        ] : []),
        ...(queueOn && cache.error !== undefined ? [`Open PRs not checked: gh pr list failed: ${cache.error}`] : []),
        ...(plans.length ? ['Plans:', ...plans.flatMap(([who, g]) => [`${who}:`, ...describe(g).map(l => `  ${l}`)])] : []),
        `State: ${await stateDir($) ?? 'none (not a git repo)'}`,
      ].join('\n'),
    }
  })
  // Main can't be replaced like a worker: one warning per crossing, never an auto-compact.
  // Re-armed when usage drops back below the threshold (after a /compact).
  const mainWarn = { warned: false }

  // Context used by a subagent: the input side of its latest step. Observe only; the step passes untouched.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    try {
      const id = e.agentId
      if (id === undefined) {
        mainModel = e.model
      } else if (r?.usage) {
        const tokens = r.usage.input_tokens + r.usage.cache_creation_input_tokens + r.usage.cache_read_input_tokens
        // The API's id usually lacks `[1m]`; keep the engine's when it has it, or the window is guessed at 200k.
        const model = e.model.includes('[1m]') ? e.model : r.usage.model || e.model
        const t = await $.clock.now()
        await update($, activity, acts => {
          const a = acts[id] ?? { startedAt: t, lastAt: t, log: [] }
          return { ...acts, [id]: { ...a, usage: { tokens, model } } }
        })
        // Tell a worker or manager once when it reaches the threshold. Marked before it is sent, so a
        // send that fails (the agent already ended) is not retried every step. Below it again (the
        // agent compacted) the mark clears, so a later crossing tells it again.
        const window = windowOf(model, mainModel, mainWindow, tokens)
        const percent = Math.min(100, Math.round(tokens / window * 100))
        const past = tokens >= thresholdOf(settings, window)
        const was = (await read($, activity))[id]
        if (settings.handoff && !past && was?.handoffNotifiedAt !== undefined) {
          await update($, activity, acts => {
            const a = acts[id]
            if (a === undefined) return acts
            const { handoffNotifiedAt: _n, handoffPercent: _p, remindedPercent: _r, callsPastLimit: _k, ...rest } = a
            return { ...acts, [id]: rest }
          })
        }
        if (settings.handoff && past && was?.handoffNotifiedAt === undefined) {
          const me = (await $.agent.list()).find(a => a.id === id)
          if ((me && WORKERS.has(me.type)) || me?.type === MANAGER) {
            await update($, activity, acts => {
              const a = acts[id] ?? { startedAt: t, lastAt: t, log: [] }
              return { ...acts, [id]: { ...a, handoffNotifiedAt: t, handoffPercent: percent, remindedPercent: percent, callsPastLimit: 0, remindersSent: a.remindersSent ?? 0 } }
            })
            void $.ui.toast(`${ROLE[me.type]} ${labelOf(me)}: past ${limitLabel(settings, window)} context, handing off`)
            // For an agent between turns; one in a turn reads the reminder on its next tool call.
            await sendWrapUp($, me, percent, limitLabel(settings, window))
          }
        }
      }
      if (id === undefined) mainWindow = (await warnMain($, settings, mainWarn)) ?? mainWindow
    } catch {
      // The meter is cosmetic: never fail the agent's step over it.
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    if (id !== undefined) {
      const t = await $.clock.now()
      await update($, activity, acts => {
        const a = acts[id] ?? { startedAt: t, lastAt: t, log: [] }
        return { ...acts, [id]: { ...a, lastAt: t, answer: e.answer } }
      })
      // A queue that ended while PRs were still pending: start a fresh one for them.
      const rows = await refresh($)
      const me = rows.find(a => a.id === id)
      if (me !== undefined && FLOW_TYPES.has(me.type)) {
        await best($, 'logging a report', async () => {
          const last = e.answer.trim().split('\n').pop() ?? ''
          await appendLog($, { event: 'report', agent: me.name, owner: rows.find(a => a.id === me.parentId)?.name ?? 'main', text: last })
        })
      }
      // `HANDOFF: manager <name>` is a manager's own note, not a worker's branch.
      const handedOff = /^HANDOFF:\s*(?!manager\b)(\S+)\s*$/.exec(e.answer.trim().split('\n').pop() ?? '')
      if (me && WORKERS.has(me.type) && handedOff?.[1] !== undefined) {
        const owner = rows.find(a => a.id === me.parentId)?.name ?? 'main'
        await best($, 'recording a handoff', () => recordHandoff($, me, handedOff[1] as string, owner, settings.maxContinues))
      }
      if (me?.type === QUEUE) await ensureQueue($)
    }
    return next(e)
  })

  // The pane paints with theme keys, which the engine resolves; a theme switch only needs a redraw.
  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const r = await next(e)
    try { $.ui.invalidate('ui.render') } catch { /* pane closed */ }
    return r
  })

  // Arrows and Tab move the focus ring over the cards; the highlight follows it.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const r = await next(e)
    if (e.element !== undefined && (await read($, roster)).some(a => a.id === e.element)) {
      // Acting while following keeps what was shown, then the person's move applies on top.
      if (paneFollow !== null) {
        const f = paneFollow
        await update($, selected, () => f.pick)
        await update($, cursor, () => f.cur)
      }
      await update($, overrideView, () => paneView)
      await update($, cursor, () => e.element!)
    }
    return r
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    let [list, acts, pick, t, hs, cur, fold, unhanded] = await Promise.all([
      read($, roster), read($, activity), read($, selected), read($, now), read($, handovers),
      read($, cursor), read($, folded), currentUnhanded($),
    ])
    const shown = await read($, hinted)
    const override = await read($, overrideView)

    // The pane follows the transcript in view, derived here without writing: the viewed agent wins
    // until the person acts in the pane under that view. An id not in the roster is ignored.
    const viewId = (e.props as { view?: { agentId?: string } }).view?.agentId ?? null
    const following = viewId !== null && list.some(a => a.id === viewId) && viewId !== override
    if (following) {
      pick = viewId
      cur = viewId
    }
    paneFollow = following ? { pick: viewId!, cur: viewId! } : null
    // Handlers record which view they acted in, so a later view change follows again.
    paneView = viewId
    const acted = async () => {
      // Acting while following adopts what was shown, so the stored state does not jump back.
      if (following) {
        await update($, selected, () => viewId)
        await update($, cursor, () => viewId)
      }
      await update($, overrideView, () => viewId)
    }
    const rows = e.viewport?.rows ?? 24
    const warnOf = (window: number) => warnPercent(settings, window)
    // Free: no breakdown asked. Main's figures also size a subagent on the same model.
    const usage = await $.session.usage().then(u => u, () => undefined)
    const main = usage?.context
    if (main !== undefined) mainWindow = main.window

    const usageOf = (a: AgentRow): { percent: number; tokens: number; window: number } | undefined => {
      const u = acts[a.id]?.usage
      if (u === undefined) return undefined
      const window = windowOf(u.model, mainModel, mainWindow, u.tokens)
      return { percent: Math.round(u.tokens / window * 100), tokens: u.tokens, window }
    }
    // Theme keys only: the filled part is legible on any background, the empty cells are 'inactive'
    // rather than dim, and the colour turns at the warn and danger marks.
    const meter = (u: { percent: number; tokens: number; window: number } | undefined, dim: boolean, time: string) => {
      // Time and tokens sit dimmed together after the bar; the window figures are not repeated.
      const tail = [time, u === undefined ? '' : tokensDown(u.tokens)].filter(Boolean).join(' · ')
      return u === undefined
        ? <Text dimColor>context ?{tail ? `   ${tail}` : ''}</Text>
        : <Text dimColor={dim}>
          {cells(u.percent, warnOf(u.window)).map((c, i) => (
            <Text key={String(i)} dimColor={dim} color={c.kind === 'empty' ? 'inactive' : c.kind === 'mark' ? 'text' : meterColor(u.percent, warnOf(u.window)) ?? 'success'}>{c.ch}</Text>
          ))}
          <Text color={meterColor(u.percent, warnOf(u.window))} dimColor={dim}> {u.percent}%</Text>
          {limitTokens(settings, u.window) !== undefined && <Text dimColor> · {limitTokens(settings, u.window)}│</Text>}
          <Text dimColor>{tail ? `   ${tail}` : ''}</Text>
        </Text>
    }
    // Running time: to now while live, frozen at the end once it ended (the moment the roster saw
    // it end, else its last activity). No start on record, no time.
    const runTime = (act: Activity | undefined, isEnded: boolean): string =>
      act?.startedAt === undefined ? '' : elapsed((isEnded ? act.endedAt ?? act.lastAt : t) - act.startedAt)

    // One agent: a card (name, what it does, meter), or one compact row when the pane is short.
    // Only a top-level card has a border; deeper ones read as a tree by their indent.
    const open = async (id: string) => {
      await acted()
      await update($, cursor, () => id)
      await update($, selected, () => id)
      // No API switches the transcript, so say once how to get to it.
      if (!shown) {
        await update($, hinted, () => true)
        const a = list.find(x => x.id === id)
        void $.ui.toast(`To see its chat: ← then pick ${a === undefined ? 'it' : labelOf(a)}`)
      }
    }
    const card = (a: AgentRow, depth: number, full: boolean, bordered: boolean, hot = false, chev = '') => {
      const act = acts[a.id]
      const hand = handoffOf(a, act)
      const dim = ENDED.has(a.status) && hand?.kind !== 'done'
      const asks = asksQuestion(act?.answer) && !['running', 'pending'].includes(a.status)
      const doing = asks ? 'asks: ' + (act?.answer ?? '').trim().split('\n').pop() : act?.doing
      const u = usageOf(a)
      const under = list.filter(c => c.parentId === a.id).length
      const head = <Text>
        {chev}<Text color={COLOR[a.status]}>{GLYPH[a.status] ?? '?'}</Text> <Text bold inverse={hot}>{labelOf(a)}</Text>
        {under > 0 && <Text dimColor> (+{under})</Text>}
        <Text dimColor>  {ROLE[a.type] ?? a.type}</Text>
        {hand?.kind === 'wrapping' && <Text bold color="warning">  handoff</Text>}
      </Text>
      // The description shows only while there is nothing done to show; the detail view has it.
      const second = hand !== undefined && !asks
        ? <Text color={hand.kind === 'wrapping' ? 'warning' : undefined}>{handoffText(hand)}</Text>
        : doing !== undefined && doing !== ''
        ? <Text color={asks ? 'warning' : undefined} dimColor={!asks}>{doing.slice(0, 60)}</Text>
        : <Text dimColor>{a.description.slice(0, 60)}</Text>
      return (
        <Box key={`row-${a.id}`} paddingLeft={bordered ? depth * 2 : depth * 2 + 1}>
          {full ? (
            // A Button holds Text only, so the border is drawn around it.
            <Box flexDirection="column" borderStyle={bordered ? 'round' : undefined} borderDimColor={dim} paddingX={bordered ? 1 : 0}>
              <Button key={a.id} plain dimColor={dim} onPress={() => open(a.id)}>
                {head}{'\n'}{second}{'\n'}{meter(u, dim, runTime(act, dim))}
              </Button>
            </Box>
          ) : (
            <Button key={a.id} plain dimColor={dim} onPress={() => open(a.id)}>
              {head}{u !== undefined && <Text color={meterColor(u.percent, warnOf(u.window))}> {u.percent}%</Text>}
            </Button>
          )}
        </Box>
      )
    }
    const agent = list.find(a => a.id === pick)

    if (agent !== undefined) {
      const act = acts[agent.id]
      const answer = (act?.answer ?? '').trim()
      const children = list.filter(a => a.parentId === agent.id).sort((a, b) => rankOf(a, acts) - rankOf(b, acts))
      const fullChildren = children.length * CARD_ROWS <= rows - 15
      const room = Math.max(3, rows - 12 - (fullChildren ? children.length * (CARD_ROWS - 1) : 0))
      // The parent chain is the history: Back climbs one level, an orphan or top-level agent goes to the tree.
      const parent = list.find(a => a.id === agent.parentId)
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Button key="back" hotkey="b" onPress={async () => { await acted(); await update($, selected, () => parent?.id ?? null) }}>Back</Button>
            <Button key="msg" hotkey="m" onPress={() => $.prompt.fill({
              text: `Send a message to ${ROLE[agent.type] ?? 'agent'} "${labelOf(agent)}": `, mode: 'replace',
            })}>Message</Button>
          </Box>
          <Text bold color={COLOR[agent.status]}>
            {GLYPH[agent.status] ?? '?'} {labelOf(agent)} <Text dimColor>{ROLE[agent.type] ?? agent.type} · {agent.status}
            {act ? ` · ${runTime(act, ENDED.has(agent.status))} · last active ${ago(t - act.lastAt)} ago` : ''}{children.length ? ` · ${children.length} under it` : ''}</Text>
          </Text>
          <Text dimColor>{agent.description}</Text>
          {act?.handoffNotifiedAt !== undefined && <Text color="warning">
            Handoff: told {ago(t - act.handoffNotifiedAt)} ago{act.handoffPercent === undefined ? '' : ` at ${act.handoffPercent}%`}, {act.remindersSent ?? 0} reminders
          </Text>}
          {shown && <Text dimColor>To see its chat: ← then pick {labelOf(agent)}</Text>}
          {children.length > 0 && <Text bold>Under it</Text>}
          {children.map(c => card(c, 0, fullChildren, true))}
          <Text bold>Activity</Text>
          {(act?.log ?? []).length === 0 && <Text dimColor>Nothing seen yet.</Text>}
          {(act?.log ?? []).slice(-room).map(line => <Text wrap="truncate-end">{line}</Text>)}
          {answer !== '' && <Text bold color={asksQuestion(answer) ? 'warning' : undefined}>
            {asksQuestion(answer) ? 'Asks' : 'Last report'}
          </Text>}
          {answer !== '' && <Text>{answer.length > 1200 ? '…' + answer.slice(-1200) : answer}</Text>}
        </Box>
      )
    }

    // The tree: each agent under the one that started it, what needs a person first.
    const first = treeItems(list, fold, undefined, false, acts).items[0]?.a.id
    const prs = Object.values(hs).sort((a, b) => b.at - a.at)
    const live = list.filter(a => !ENDED.has(a.status)).length
    // Header, the PR lines and the hint row are fixed; the root and the agents share what is left.
    // Full cards if all fit, else the crowded tree (compact rows, folded but for the highlight's
    // path) in a window that follows the highlight.
    const prRows = prs.length > 0 ? 1 + Math.min(prs.length, 5) : 0
    const avail = rows - 1 - prRows - (list.length === 0 ? 1 : 0) - (list.length > 0 ? 1 : 0) - (unhanded.length > 0 ? 1 : 0)
    const wide = treeItems(list, fold, cur ?? first, false, acts)
    const fullTree = (wide.items.length + 1) * CARD_ROWS <= avail
    const { items, at } = fullTree ? wide : treeItems(list, fold, cur ?? first, true, acts)
    const rootFull = fullTree || avail >= CARD_ROWS + items.length
    const left = avail - (rootFull ? CARD_ROWS : 1)
    const cut = !fullTree && items.length > left
    const hotIdx = Math.max(0, items.findIndex(i => i.a.id === at))
    // Two rows of the window go to the "above" and "more" lines.
    const view = cut ? viewOf(items, hotIdx, Math.max(1, left - 2)) : { top: 0, rows: items }
    const below = items.length - view.top - view.rows.length
    const hotId = items[hotIdx]?.a.id

    // Keys read the state fresh, so rapid presses each count once.
    const step = (d: number) => async () => {
      if (items.length === 0) return
      await acted()
      const c = (await read($, cursor)) ?? hotId
      const i = Math.min(items.length - 1, Math.max(0, items.findIndex(x => x.a.id === c) + d))
      const id = items[i]!.a.id
      await update($, cursor, () => id)
      // Moves the focus ring too; it waits for the next drawing, so it is not awaited.
      void $.ui.focus({ requestId: PANE, key: id }).catch(() => undefined)
    }
    const hotItem = async () => {
      await acted()
      const c = (await read($, cursor)) ?? hotId
      return items.find(x => x.a.id === c) ?? items[hotIdx]
    }
    const mainTime = usage?.startedAt === undefined ? '' : elapsed(t - usage.startedAt)
    const mainU = main?.tokens === undefined ? undefined
      : { percent: main.percent ?? Math.round(main.tokens / main.window * 100), tokens: main.tokens, window: main.window }

    return (
      <Box flexDirection="column">
        <Text dimColor>{list.length} agents · {live} live{prs.length ? ` · ${prs.length} PRs handed over` : ''} · press one to see it</Text>
        {unhanded.length > 0 && (
          <Text color="warning" wrap="truncate-end">
            ⚠ {unhanded.length} PR{unhanded.length > 1 ? 's' : ''} nobody handed over: {unhanded.map(u => `#${u.pr}`).join(' ')}
          </Text>
        )}
        {rootFull ? (
          <Box flexDirection="column" borderStyle="round" paddingX={1}>
            <Text bold>{ROOT_GLYPH} main <Text dimColor> super manager</Text></Text>
            {meter(mainU, false, mainTime)}
          </Box>
        ) : (
          <Text bold>{ROOT_GLYPH} main <Text dimColor>· super manager</Text>
            {mainU !== undefined && <Text color={meterColor(mainU.percent, warnOf(mainU.window))}> {mainU.percent}%</Text>}
          </Text>
        )}
        {list.length === 0 && <Text dimColor>  Nothing running. Ask Claude to start managers or a worker, e.g. "start a manager for X".</Text>}
        {view.top > 0 && <Text dimColor>  ↑ {view.top} above</Text>}
        {view.rows.map(({ a, depth, kids, collapsed }) => card(
          a, depth + 1, fullTree, depth === 0, a.id === hotId, kids > 0 ? (collapsed ? '▸ ' : '▾ ') : '',
        ))}
        {below > 0 && <Text dimColor>  +{below} more</Text>}
        {list.length > 0 && (
          <Box flexDirection="row" gap={1}>
            <Button key="nav-next" plain dimColor hotkey="j" onPress={step(1)}>j next</Button>
            <Button key="nav-prev" plain dimColor hotkey="k" onPress={step(-1)}>k prev</Button>
            <Button key="nav-open" plain dimColor hotkey="o" onPress={async () => { const i = await hotItem(); if (i) await open(i.a.id) }}>o open</Button>
            <Button key="nav-fold" plain dimColor hotkey="c" onPress={async () => {
              await acted()
              const i = await hotItem()
              if (i && i.kids > 0) await update($, folded, f => ({ ...f, [i.a.id]: !i.collapsed }))
            }}>c fold</Button>
          </Box>
        )}
        {prs.length > 0 && <Text bold>  Merge queue</Text>}
        {prs.slice(0, 5).map(h => (
          <Text key={`pr-${h.pr}`} dimColor={h.status === 'done'} wrap="truncate-end">
            {'    '}{HANDOVER_GLYPH[h.status]} #{h.pr} {h.status}{h.status === 'returned' ? `: ${h.reason ?? ''}` : ''} <Text dimColor>{h.title}</Text>
          </Text>
        ))}
      </Box>
    )
  })
}
