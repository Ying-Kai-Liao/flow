import { atom, read, update } from 'claude-code'
import type { AgentInfo, AgentSpawnInput, EngineInterface, Register } from 'claude-code'

import type { Activity, AgentRow, Handover, HandoffRecord, Leftovers, LogEvent, OpenPr, PrCache, Session, SlotEntry, TestSlots } from '../types'
import { checkEvidence, evidenceRefusal, evidenceSummary, evidenceText, type Evidence } from './evidence'
import { ancestryQueries, containedCandidates, dirtyFiles, isLive, leftoverLine, parsePorcelain, selectCleanup, sweepText, waitingPaths } from './clean'
import type { CleanInputs, Kept, PrRow, Sweep } from './clean'
import { addNodes, agentFor, asksQuestion, describe, noticeText, settle } from './dag'
import type { Facts, Graph, Notice, Plan } from './dag'
import {
  addQuestions, answerMessage, askingNames, EMPTY_INBOX, inboxHead, openAll, renderInbox, markAnswered, needsMessage, normalizeInbox, notesOwner, openFor, parseAsk, parseChoice,
} from './inbox'
import {
  closeStale, denyText, dueRound, EMPTY_PREFLIGHT, followUp, FILE_HELP, gateOf, isSkip, markDelivered, normalizePreflight, parseFiling, phaseOf,
  recordFiling, recordSpawn, renderFollowUp, renderRound, renderStatus,
} from './preflight'
import type { Preflight } from './preflight'
import type { Inbox, Question } from './inbox'
import { AUTO, matchRule, nextRuleId, removeRule, renderRules, ruleFromQuestion, sameRule, suggest, validateRule } from './standing'
import type { Resolved, Rule } from './standing'
import { graphNodes, layoutGraph, moveFocus } from './graph'
import type { GNode, Seg } from './graph'
import {
  fill, MANAGER_PROMPT, NO_QUEUE_RULE, QUEUE_PROMPT, QUEUE_RULE, SESSION_PROMPT, WORKER_PROMPT,
} from './prompts'
import type { Settings } from './prompts'
import { deployTargetsOf, stateFileOf } from './prompts'
import { isFable, mergeLayers } from './settings'
import {
  allowed, allowList, killRefusal, mainCheckoutRefusal, mainRelative, parseWorktrees, resolvePath, writeTargets,
} from './guards'
import type { WriteTarget } from './guards'
import {
  claudeLimits, claudeProjectDir, codexLimits, codexRemaining, commandFor, findHandle, findWorktreePath, goneMessage, harnessesOf,
  idleMessage, keysOf, NAME_RULE, parseClaudeTranscript, parseCodexRollout, percentOf, pickHost, programOf, reportMessage, runsOutIn,
  screenHash, SESSION, sessionKey, sessionLine, sessionRow, tmuxName,
} from './sessions'
import type { Digest, HarnessSpec, Limit } from './sessions'
import { buildDigest, findWorktree, noteKey, ownerFor } from './state'
import { autoRefused, effectiveMode, labelSpec, parseMode, takeDecision } from './mergemode'

// The orca-flow pattern inside one Claude Code session. The main session is the super manager
// (the `dispatch` skill); it starts `flow:manager` agents, which start
// `flow:worker` agents in worktrees of their own and hand approved PRs to the
// `flow:queue` agent through this plugin's tools. The pane in main shows the tree.

const PANE = 'flow'
const POLL_MS = 3000
// The 1M-window Sonnet: workers read whole diffs and long briefs. Refused for sub-agents, it falls back to plain sonnet.
const DEFAULT_WORKER_MODEL = 'sonnet[1m]'
const LOG_MAX = 40
const MANAGER = 'flow:manager'
const WORKER = 'flow:worker'
// A worker continued in its predecessor's worktree: the plugin rewrites a spawn to it, the model never picks it.
const CONTINUE = 'flow:continue'
const WORKERS = new Set([WORKER, CONTINUE, SESSION])
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
const ROLE: Record<string, string> = { [MANAGER]: 'manager', [WORKER]: 'worker', [CONTINUE]: 'worker', [SESSION]: 'worker', [QUEUE]: 'queue' }
const ROOT_GLYPH = '◆'
// Plan states, drawn like the agent statuses they turn into; a waiting node has no agent yet.
const PLAN_GLYPH: Record<string, string> = { waiting: '○', ready: '◌', running: '●', done: '✓', blocked: '✗' }
const PLAN_COLOR: Record<string, string | undefined> = { waiting: undefined, ready: 'warning', running: 'suggestion', done: 'success', blocked: 'error' }
const HANDOVER_GLYPH: Record<Handover['status'], string> = {
  pending: '…', awaiting: '⏸', taken: '●', done: '✓', returned: '↩',
}

const roster = atom({ plugin: 'flow', key: 'roster' } as const, [] as AgentRow[])
const activity = atom({ plugin: 'flow', key: 'activity' } as const, {} as Record<string, Activity>)
const selected = atom({ plugin: 'flow', key: 'selected' } as const, null as string | null)
// The highlighted card of the tree (an agent id), and the collapse the person chose per card: true
// is one row with its children hidden, false is expanded even when the tree is crowded. Absent =
// the role's default (managers and the queue collapsed), else automatic. MERGE_QUEUE_KEY is the
// Merge queue section's entry.
const cursor = atom({ plugin: 'flow', key: 'cursor' } as const, null as string | null)
const MERGE_QUEUE_KEY = '#merge-queue'
const folded = atom({ plugin: 'flow', key: 'folded' } as const, {} as Record<string, boolean>)
// Following the chat view: the view (an agent id, null for main) in which the person last acted in
// the pane. While the view differs from it, the pane shows the viewed agent; written by handlers only.
const overrideView = atom({ plugin: 'flow', key: 'overrideView' } as const, undefined as string | null | undefined)
// Set once the first card click has told the person how to see that agent's chat.
const hinted = atom({ plugin: 'flow', key: 'hinted' } as const, false)
const now = atom({ plugin: 'flow', key: 'now' } as const, 0)
const handovers = atom({ plugin: 'flow', key: 'handovers' } as const, {} as Record<string, Handover>)
// The decision inbox, mirrored from <state dir>/inbox.json.
const inbox = atom({ plugin: 'flow', key: 'inbox' } as const, EMPTY_INBOX as Inbox)
// Pre-flight records, mirrored from <state dir>/preflight.json.
const preflight = atom({ plugin: 'flow', key: 'preflight' } as const, EMPTY_PREFLIGHT as Preflight)
const handoffs = atom({ plugin: 'flow', key: 'handoffs' } as const, {} as Record<string, HandoffRecord>)
const queueRuns = atom({ plugin: 'flow', key: 'queueRuns' } as const, 0)
// The open PRs gh listed last, so the 3 s refresh never calls gh itself.
const prCache = atom({ plugin: 'flow', key: 'prCache' } as const, { prs: [], fetchedAt: 0 } as PrCache)
// The last dry cleanup sweep, refreshed with the PR list so a render never runs git.
const sessions = atom({ plugin: 'flow', key: 'sessions' } as const, {} as Record<string, Session>)
const harnessLimits = atom({ plugin: 'flow', key: 'harnessLimits' } as const, [] as Limit[])
const armed = atom({ plugin: 'flow', key: 'armed' } as const, null as { key: string; at: number } | null)
const leftovers = atom({ plugin: 'flow', key: 'leftovers' } as const, { worktrees: 0, branches: 0, needsLook: 0 } as Leftovers)

const PR_POLL_MS = 5 * 60_000
const PR_MIN_GAP_MS = 60_000
// A worker that just ended: its manager is probably reviewing the PR.
const GRACE_MS = 20 * 60_000
// Set by register(); refresh() and the pane flag nothing when there is no merge queue.
let queueOn = true
// The cleanup setting and the base it sweeps against; set by register() like queueOn.
let cleanupMode: 'auto' | 'off' = 'auto'
let cleanupBase = 'main'

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
// The pane draws the agents as a tree of cards or as the dependency graph; the graph's highlight is a node id.
const viewMode = atom({ plugin: 'flow', key: 'viewMode' } as const, 'tree' as 'tree' | 'graph')
const graphFocus = atom({ plugin: 'flow', key: 'graphFocus' } as const, null as string | null)
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
// The decision_phrases setting, for the question check in refresh() and syncPlans().
let decisionPhrases: string[] = []
// Pre-flight setting and round wait (ms); set by register() like the others.
let preflightOn = true
let preflightWaitMs = 10 * 60_000

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

// Managers and the merge queue start collapsed; everything else has no default.
export const foldDefault = (a: AgentRow): boolean | undefined => (a.type === MANAGER || a.type === QUEUE ? true : undefined)

// The rows of the tree in the order they are drawn and walked. A collapsed agent is one row with
// its children hidden: the person's choice wins, then the role's default, then `auto`, which folds
// every agent with children except the ones on the way to the highlight (a crowded tree).
// `at` is the highlight, moved up to the nearest row that is drawn.
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
    const collapsed = fold[a.id] ?? foldDefault(a) ?? (under.length > 0 && auto && !path.has(a.id))
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

// A plan node with an agent is drawn by the agent's status; one without has only its plan state.
const planState = (n: GNode): boolean => n.agentId === undefined && n.state in PLAN_GLYPH
const nodeGlyph = (n: GNode): string => (planState(n) ? PLAN_GLYPH[n.state] ?? '?' : GLYPH[n.state] ?? PLAN_GLYPH[n.state] ?? '?')
const nodeColor = (n: GNode): string | undefined => (planState(n) ? PLAN_COLOR[n.state] : COLOR[n.state] ?? PLAN_COLOR[n.state])

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
// `spawned` is the window the agent was started with (see the agent.spawn hook); it wins over the guess.
function windowOf(model: string, mainModel: string | undefined, mainWindow: number | undefined, tokens = 0, spawned?: number): number {
  const window = spawned !== undefined ? spawned : mainWindow !== undefined && mainModel !== undefined && modelKey(model) === modelKey(mainModel) ? mainWindow
    : model.includes('[1m]') ? LARGE_WINDOW : DEFAULT_WINDOW
  return tokens > window ? Math.max(window, LARGE_WINDOW) : window
}

type WarnSettings = { contextWarn: number; contextWarn1m: number; contextWarnTokens: number }

// The percent in force: a 1M window has its own, so the 200k percent never applies to it.
function windowPercent(s: WarnSettings, window: number): number {
  return window >= LARGE_WINDOW ? s.contextWarn1m : s.contextWarn
}

// The trigger: the percent of the window, capped by the token setting when that is set.
function thresholdOf(s: WarnSettings, window: number): number {
  const byPercent = Math.round(window * windowPercent(s, window) / 100)
  return s.contextWarnTokens > 0 ? Math.min(s.contextWarnTokens, byPercent) : byPercent
}

// The same threshold as a percent of the window, for the meter's marker and colour.
function warnPercent(s: WarnSettings, window: number): number {
  return Math.min(100, Math.max(1, Math.round(thresholdOf(s, window) / window * 100)))
}

// What the threshold is called in a message: "40%" or "100k tokens".
function limitLabel(s: WarnSettings, window: number): string {
  return s.contextWarnTokens > 0 && s.contextWarnTokens < Math.round(window * windowPercent(s, window) / 100)
    ? `${tokensLabel(s.contextWarnTokens)} tokens` : `${windowPercent(s, window)}%`
}

// The threshold in tokens for the meter, only when the token limit is the one in force.
function limitTokens(s: WarnSettings, window: number): string | undefined {
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

// `options` is the merged settings (settings.ts): a value of the wrong type has already been dropped.
function settingsOf(options: Record<string, unknown>, base: string): Settings & { contextWarn: number; contextWarn1m: number; contextWarnTokens: number; handoff: boolean; maxManagers: number; maxContinues: number; preflight: boolean; preflightWait: number; cleanup: 'auto' | 'off'; harnesses: Record<string, HarnessSpec>; minQuota: number } & Guards {
  const str = (k: string, d: string) => (typeof options[k] === 'string' && options[k] !== '' ? String(options[k]) : d)
  const num = (k: string, d: number) => (typeof options[k] === 'number' ? Number(options[k]) : d)
  const strs = (k: string) => (Array.isArray(options[k]) ? (options[k] as unknown[]).filter((x): x is string => typeof x === 'string') : [])
  // Sub-agents don't run on Fable, whatever the source says.
  const model = (k: string, d: string) => { const m = str(k, d); return isFable(m) ? d : m }
  const harnesses = harnessesOf(options.harnesses)
  return {
    contextWarn: Math.min(100, Math.max(1, Math.round(num('context_warn_percent', 40)))),
    contextWarn1m: Math.min(100, Math.max(1, Math.round(num('context_warn_percent_1m', 35)))),
    contextWarnTokens: Math.max(0, Math.round(num('context_warn_tokens', 0))),
    handoff: options.handoff !== false,
    mainGuard: options.main_checkout_guard !== false,
    mainAllow: allowList(typeof options.main_checkout_allow === 'string' ? options.main_checkout_allow : '.claude/'),
    maxContinues: Math.max(0, Math.round(num('max_continues', 2))),
    preflight: str('preflight', 'on') !== 'off',
    preflightWait: Math.max(1, num('preflight_wait', 10)),
    cleanup: str('cleanup', 'auto') === 'off' ? 'off' : 'auto',
    base: str('base_branch', base),
    testCommand: str('test_command', ''),
    fullCheck: str('full_check_command', ''),
    deployCommand: str('deploy_command', ''),
    deployTargets: deployTargetsOf(options.deploy_targets),
    stateFile: stateFileOf(options.state_file),
    mergeMethod: str('merge_method', 'squash'),
    mergeMode: str('merge_mode', 'auto'),
    useQueue: options.merge_queue !== false,
    maxWorkers: num('max_workers', 3),
    maxManagers: Math.max(1, Math.round(num('max_managers', 20))),
    testSlots: Math.max(1, Math.floor(num('test_slots', 1))),
    workerModel: model('worker_model', DEFAULT_WORKER_MODEL),
    managerModel: model('manager_model', 'opus'),
    queueModel: model('queue_model', 'opus'),
    language: str('language', 'English'),
    bigFiles: strs('big_files'),
    bigFileLines: num('big_file_lines', 1500),
    migrationsDir: str('migrations_dir', ''),
    decisionPhrases: strs('decision_phrases'),
    workerChecks: strs('worker_checks'),
    alwaysTests: strs('always_tests'),
    workerHarness: str('worker_harness', 'agent'),
    sessionHost: ['orca', 'tmux'].includes(str('session_host', 'auto')) ? str('session_host', 'auto') : 'auto',
    harnesses,
    harnessNames: Object.keys(harnesses),
    minQuota: Math.min(100, Math.max(0, Math.round(num('min_quota', 10)))),
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
    phrases: decisionPhrases,
    asking: askingNames(await read($, inbox)),
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
  // Workers in other harnesses stand in the tree like agents, under the manager that started them.
  rows.push(...Object.values(await read($, sessions)).map(sessionRow))
  const was = new Map(before.map(a => [a.id, a.status]))
  const ended: string[] = []
  const askers = askingNames(await read($, inbox))
  for (const a of rows) {
    const prev = was.get(a.id)
    if (prev === undefined || prev === a.status || ENDED.has(prev)) continue
    if (ENDED.has(a.status) && acts[a.id] !== undefined) ended.push(a.id)
    // The queue's worktree (detached at the base) goes once the queue is gone.
    if (ENDED.has(a.status) && a.type === QUEUE) autoSweep($)
    if (ENDED.has(a.status) || a.status === 'idle') {
      const asks = asksQuestion(acts[a.id]?.answer, decisionPhrases) || askers.includes(a.name ?? '')
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
  const awaiting = hs.filter(h => h.status === 'awaiting').length
  const parts = [
    count(MANAGER) && `${count(MANAGER)} managers`,
    count(WORKER) && `${count(WORKER)} workers`,
    queued && `queue: ${queued} PR${queued > 1 ? 's' : ''}`,
    awaiting && `${awaiting} awaiting approval`,
  ].filter(Boolean)
  const unhanded = (await currentUnhanded($)).length
  if (unhanded) parts.push(`${unhanded} unhanded`)
  const slots = await read($, testSlots)
  const slotPart = slots.holders.length || slots.waiters.length ? ` · tests ${slots.holders.length}/${slotLimit}` : ''
  $.ui.status(rows.length === 0 && hs.length === 0 && !unhanded ? undefined
    : `flow: ${parts.length ? parts.join(' · ') : `${live.length} live`}${slotPart} · /flow`)
  await syncPlans($, rows).catch(() => undefined)
  await preflightTick($, rows).catch(() => undefined)
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

// Inbox changes run one after another: two answers at once must not each start from the same file.
let inboxChain: Promise<unknown> = Promise.resolve()

// Read the inbox from disk, let fn change it, write it back and set the atom. fn returns the new inbox (the
// same object when nothing changed) and whatever the caller wants back.
function withInbox<T>($: EngineInterface, fn: (cur: Inbox) => { inbox: Inbox; out: T }): Promise<T> {
  const run = async (): Promise<T> => {
    const dir = await stateDir($)
    const cur = dir === undefined ? await read($, inbox) : normalizeInbox(await readJson($, `${dir}/inbox.json`))
    const { inbox: next, out } = fn(cur)
    if (next !== cur) {
      if (dir !== undefined) {
        await $.process.run(['mkdir', '-p', dir])
        await writeJsonAtomic($, `${dir}/inbox.json`, next)
      }
      await update($, inbox, () => next)
    }
    return out
  }
  const result = inboxChain.then(run, run)
  inboxChain = result.catch(() => undefined)
  return result
}

// Pre-flight changes run one after another, like the inbox's.
let preflightChain: Promise<unknown> = Promise.resolve()

function withPreflight<T>($: EngineInterface, fn: (cur: Preflight) => { state: Preflight; out: T }): Promise<T> {
  const run = async (): Promise<T> => {
    const dir = await stateDir($)
    const cur = dir === undefined ? await read($, preflight) : normalizePreflight(await readJson($, `${dir}/preflight.json`))
    const { state, out } = fn(cur)
    if (state !== cur) {
      if (dir !== undefined) {
        await $.process.run(['mkdir', '-p', dir])
        await writeJsonAtomic($, `${dir}/preflight.json`, state)
      }
      await update($, preflight, () => state)
    }
    return out
  }
  const result = preflightChain.then(run, run)
  preflightChain = result.catch(() => undefined)
  return result
}

// Managers that ended with no live manager of the same notes key (a successor is the same manager).
function endedManagers(rows: AgentRow[]): Set<string> {
  const live = new Set(liveManagers(rows).map(a => noteKey(a.name ?? '')))
  return new Set(rows.filter(a => a.type === MANAGER && ENDED.has(a.status) && !live.has(noteKey(a.name ?? ''))).map(a => noteKey(a.name ?? '')))
}

// Sends the round to main once it is due: everyone filed, skipped or ended, or the wait is over. The
// delivered flag is written inside the update, so two callers deliver it once.
async function preflightTick($: EngineInterface, rows: AgentRow[]): Promise<void> {
  if (!(await read($, preflight)).rounds.some(r => !r.delivered)) return
  const t = await $.clock.now()
  const ended = endedManagers(rows)
  const due = await withPreflight($, cur => {
    const d = dueRound(cur, ended, t, preflightWaitMs)
    if (d === undefined) return { state: cur, out: undefined }
    const next = markDelivered(cur, d.round.id, t)
    return { state: next, out: { ...d, state: next } }
  })
  if (due === undefined) return
  const members = due.round.members.map(k => due.state.entries[k])
  // A round of skipped managers only has nothing to say.
  if (members.every(e => e === undefined || e.phase === 'skipped')) return
  const text = renderRound(due.state, await read($, inbox), due.round, ended, t, due.timedOut)
  $.clock.after(0, () => void $.prompt.submit({ text }).catch(() => undefined))
}

// Why this manager may not start workers yet, or undefined. Only a recorded manager is ever gated.
async function preflightGate($: EngineInterface, agentId: string | undefined): Promise<string | undefined> {
  if (!preflightOn || agentId === undefined) return undefined
  const me = (await $.agent.list()).find(a => a.id === agentId)
  if (me?.type !== MANAGER || me.name === undefined) return undefined
  const g = gateOf(await read($, preflight), await read($, inbox), me.name)
  return g === undefined ? undefined : denyText(g)
}

// A manager main just started joins the open round, or opens one with a timer for the wait.
async function recordManager($: EngineInterface, name: string, prompt: string): Promise<void> {
  const t = await $.clock.now()
  const opened = await withPreflight($, cur => {
    const next = recordSpawn(cur, name, isSkip(prompt), t, preflightWaitMs)
    return { state: next, out: next.rounds.length > cur.rounds.length }
  })
  if (opened) $.clock.after(preflightWaitMs, () => void refresh($).catch(() => undefined))
}

const today = async ($: EngineInterface) => new Date(await $.clock.now()).toISOString().slice(0, 10)

// The one way a question gets answered: marks it, tells the asker when that is needed, notes the decision.
// choice null takes the question's default. Returns one result line.
async function answerQuestion($: EngineInterface, id: string, choice: string | null, by: string): Promise<string> {
  const at = await $.clock.now()
  const marked = await withInbox($, cur => {
    const m = markAnswered(cur, id, choice, by, at)
    return { inbox: m.kind === 'ok' ? m.inbox : cur, out: m }
  })
  if (marked.kind === 'unknown') return `${id}: no such question.`
  if (marked.kind === 'answered') return `${id}: already answered ("${marked.q.answer ?? ''}" by ${marked.q.answeredBy ?? '?'}).`
  if (marked.kind === 'refused') return `${id}: refused, it is addressed to ${marked.q.addressee}, not ${by}.`
  if (marked.kind === 'empty') return `${id}: refused, the choice is empty.`
  const { q, answer, isDefault } = marked
  let delivered = true
  let hint = ''
  if (needsMessage(q, isDefault)) {
    const asker = q.askerId === undefined ? undefined : (await $.agent.list()).find(a => a.id === q.askerId)
    delivered = false
    if (asker !== undefined && (LIVE.has(asker.status) || asker.status === 'idle')) {
      delivered = await $.session.send({ to: { agentId: asker.id }, text: answerMessage(q, answer, by, isDefault) })
        .then(() => true, () => false)
    }
    if (!delivered) hint = `; ${q.owner} is gone: main should relay it to ${noteKey(q.owner)}-2`
  }
  await withInbox($, cur => ({
    inbox: { ...cur, items: cur.items.map(x => (x.id === id ? { ...x, delivered } : x)) }, out: undefined,
  }))
  await appendNote($, notesOwner(q), `- ${await today($)} decision: "${q.id} ${q.question}: ${answer}"`)
  return `${id}: ${answer}${isDefault ? ' (default)' : ''}, ${delivered ? 'delivered' : 'undelivered'}${hint}.`
}

// Standing answers (standing.ts): the rules of both settings files, read fresh so a rule made a moment ago
// applies to the next ask. A bad rule is dropped by mergeLayers; the others stand.
async function loadRules($: EngineInterface, options: Record<string, unknown>): Promise<{ rules: Resolved[]; paths: string[] }> {
  const paths = await locate($)
  const layers = await Promise.all(paths.map(async path => ({ path, text: path === '' ? undefined : await $.fs.read(path).then(String, () => undefined) })))
  const raw = mergeLayers(options, layers).raw.standing_answers
  return { rules: Array.isArray(raw) ? raw as Resolved[] : [], paths }
}

// Rule file changes run one after another: two `always` answers at once must not lose a rule.
let rulesChain: Promise<unknown> = Promise.resolve()
function inRulesChain<T>(fn: () => Promise<T>): Promise<T> {
  const result = rulesChain.then(fn, fn)
  rulesChain = result.catch(() => undefined)
  return result
}

// Read-modify-write one settings file's standing_answers, keeping every other key. fn gets the raw list and
// returns the new one (undefined: no change). A file that is not a JSON object is never rewritten.
async function editRuleFile<T>($: EngineInterface, path: string, fn: (list: unknown[]) => Promise<{ list?: unknown[]; out: T }>): Promise<{ out: T } | { error: string }> {
  let obj: Record<string, unknown> = {}
  const text = await $.fs.read(path).then(String, () => undefined)
  if (text !== undefined && text.trim() !== '') {
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      return { error: `${path} is not valid JSON; fix it first, flow does not rewrite it.` }
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return { error: `${path} is not a JSON object; flow does not rewrite it.` }
    obj = data as Record<string, unknown>
  }
  let list: unknown = obj.standing_answers
  if (typeof list === 'string') {
    try { list = JSON.parse(list) } catch { return { error: `${path}: "standing_answers" is not valid JSON; fix it first.` } }
  }
  if (list === undefined || list === null) list = []
  if (!Array.isArray(list)) return { error: `${path}: "standing_answers" is not a list; fix it first.` }
  const r = await fn(list)
  if (r.list !== undefined) {
    await $.process.run(['mkdir', '-p', path.replace(/\/[^/]*$/, '')])
    if (!await writeJsonAtomic($, path, { ...obj, standing_answers: r.list })) return { error: `could not write ${path}.` }
  }
  return { out: r.out }
}

type RuleAdd = { kind: 'added' | 'exists'; id: string } | { kind: 'error'; msg: string }

// Adds a rule to the personal file with a new short id (s1, s2, ..., unique across both files and the inbox).
function addRule($: EngineInterface, options: Record<string, unknown>, rule: Rule): Promise<RuleAdd> {
  return inRulesChain(async (): Promise<RuleAdd> => {
    const { rules, paths } = await loadRules($, options)
    const path = paths[1] ?? ''
    if (path === '') return { kind: 'error', msg: 'rules need a repo for the personal file.' }
    const dup = rules.find(r => sameRule(r.rule, rule))
    if (dup !== undefined) return { kind: 'exists', id: dup.rid }
    const used = [...rules.map(r => r.rid), ...(await read($, inbox)).items.flatMap(q => (q.rule === undefined ? [] : [q.rule]))]
    const id = nextRuleId(used)
    const r = await editRuleFile($, path, async list => ({ list: [...list, { id, ...rule }], out: id }))
    return 'error' in r ? { kind: 'error', msg: r.error } : { kind: 'added', id }
  })
}

// Removes a rule from whichever file holds it. A /config rule cannot be removed from here.
function dropRule($: EngineInterface, options: Record<string, unknown>, rid: string): Promise<string> {
  return inRulesChain(async () => {
    const { rules, paths } = await loadRules($, options)
    const hit = rules.find(r => r.rid === rid)
    if (hit === undefined) return `${rid}: no such rule. mcp__flow__standing {"action":"list"} shows them.`
    if (hit.source === 'config') return `${rid}: set in /config, remove it there.`
    const path = (hit.source === 'repo' ? paths[0] : paths[1]) ?? ''
    const r = await editRuleFile($, path, async list => {
      const res = removeRule(list, hit.source, rid)
      return res.removed ? { list: res.list, out: true } : { out: false }
    })
    if ('error' in r) return `${rid}: not removed, ${r.error}`
    if (!r.out) return `${rid}: not found in ${path}.`
    return `${rid}: removed from ${path}${hit.source === 'repo' ? ' (a committed file: the change shows in git status)' : ''}.`
  })
}

// An `always` answer: after answering, the answer becomes a rule in the personal file. Only main makes rules.
async function alwaysRule(
  $: EngineInterface, options: Record<string, unknown>, id: string, choice: string, isMain: boolean, before: Question | undefined,
): Promise<string> {
  if (!isMain) return `${id}: no rule made, only main makes standing answers (the answer itself stands).`
  if (before === undefined) return `${id}: no rule made, no such question.`
  if (before.state !== 'open') return `${id}: no rule made, it was already answered.`
  const q = (await read($, inbox)).items.find(x => x.id === id)
  if (q === undefined || q.state !== 'answered' || q.answeredBy !== 'main') return `${id}: no rule made, the answer was not recorded.`
  if (parseChoice(q.options, choice).free) return `${id}: no rule made, a free-text answer cannot be a rule; pick one of the options.`
  const rule = ruleFromQuestion(q, q.answer ?? '', await today($))
  const r = await addRule($, options, rule)
  if (r.kind === 'error') return `${id}: answered, but no rule made: ${r.msg}`
  const what = rule.topic !== undefined ? `topic ${rule.topic}` : 'this exact question'
  if (r.kind === 'exists') return `${id}: rule ${r.id} already says "${rule.answer}" for ${what}; no duplicate added.`
  return `${id}: rule ${r.id} added: ${what} -> "${rule.answer}"${rule.blocking ? ' (also blocking)' : ''}. Revoke with mcp__flow__standing {"action":"remove","id":"${r.id}"}.`
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

const STATUSES = new Set(['pending', 'awaiting', 'taken', 'done', 'returned'])

const isStrs = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string')
const validEvidence = (e: unknown): boolean => typeof e === 'object' && e !== null && isStrs((e as Evidence).ran) && typeof (e as Evidence).exercised === 'string' && isStrs((e as Evidence).notVerified)

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
    if (h.evidence !== undefined && !validEvidence(h.evidence)) delete h.evidence
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
async function ownerNameOf($: EngineInterface, id: string | undefined): Promise<string> {
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
    const owner = await ownerNameOf($, e.parentAgentId)
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
        (old.agentId !== '' ? a.id === old.agentId : a.name === old.agent) && isLive(a.status))
      const status = await gitOut($, ['-C', path, 'status', '--porcelain'])
      const clean = status !== undefined && dirtyFiles(status).length === 0
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

// How many rewritten flow:continue spawns are in the host's hands: the agent.offer hook offers the type then.
let continuing = 0
// Dispatches a spawn; a flow:continue one counts while it runs and a refusal comes back as a deny.
async function dispatch<R>(next: (ev: AgentSpawnInput) => Promise<R>, ev: AgentSpawnInput): Promise<R | { deny: string }> {
  if (ev.subagentType !== CONTINUE) return next(ev)
  continuing++
  try {
    return await next(ev)
  } catch (err) {
    return { deny: String((err as Error).message) }
  } finally {
    continuing--
  }
}

const FABLE_DENY = "flow: sub-agents don't run on Fable; use sonnet or opus (set worker_model / manager_model / queue_model)."

// Fable is refused for a flow agent and for anything a flow agent starts.
async function fableDenied($: EngineInterface, e: { model?: string; subagentType: string; parentAgentId?: string }): Promise<boolean> {
  if (!isFable(e.model)) return false
  if (FLOW_TYPES.has(e.subagentType)) return true
  if (e.parentAgentId === undefined) return false
  const parent = (await $.agent.list()).find(a => a.id === e.parentAgentId)
  return parent !== undefined && FLOW_TYPES.has(parent.type)
}

// A refusal of a long-context model: a deny, or an error that names the model or its context.
function refusedLong(r: unknown): boolean {
  const text = r instanceof Error ? r.message : typeof r === 'object' && r !== null && 'deny' in r ? String((r as { deny: unknown }).deny) : ''
  return /model|1m|context/i.test(text)
}
const withoutLong = (model: string): string => model.replace('[1m]', '')

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
    : h.status === 'returned' ? ` returned: ${h.reason ?? ''}`
    : h.status === 'awaiting' ? ` awaiting the user's approval: /flow approve ${h.pr}` : ''
  return `#${h.pr} ${h.status} (${h.branch} @ ${h.head.slice(0, 8)}, from ${h.reportTo})${tail} — ${h.title} [${evidenceSummary(h.evidence)}]`
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
    const note = `Handover #${h.pr} is ${h.status}${h.status === 'returned' ? ` (${h.reason ?? 'no reason'})` : ''}, reported to ${h.reportTo}. Verified: ${h.verified} Pending: ${h.pending}` +
      (h.status === 'awaiting' ? ` It awaits the user's /flow approve ${h.pr}; do not restart work on it.` : '')
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
  for (const s of Object.values(await read($, sessions))) if (s.status === 'running' || s.status === 'reported') owners.add(s.branch)
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
    for (const { path, branch } of parsePorcelain(wt.stdout)) {
      if (!path.includes('/.claude/worktrees/')) continue
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

// --- Cleanup: leftover worktrees and local branches of finished work ---------------------------

type CleanGathered = { inputs?: CleanInputs; notes: string[]; error?: string }

// Everything selectCleanup needs, read once: one fetch, one gh call, then local git.
async function gatherClean($: EngineInterface, base: string): Promise<CleanGathered> {
  const run = async (argv: string[]) => {
    try {
      return await $.process.run(argv, { timeoutMs: 60_000 })
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
  const hs = Object.values(await read($, handoffs))
  const continued = (await readLog($)).filter(l => l.event === 'continue')
  const cwdOf = new Map(hs.filter(h => h.takenBy !== undefined && h.worktree !== undefined).map(h => [h.takenBy!, h.worktree!]))
  const waiting = waitingPaths(hs, continued, prs)
  const roster = (await $.agent.list()).map(a => ({
    id: a.id, live: isLive(a.status), ...(a.name !== undefined && { name: a.name }),
    ...(a.name !== undefined && cwdOf.has(a.name) && { cwd: cwdOf.get(a.name) }),
  }))
  // The main session may itself run in a linked worktree: never pull the floor from under it.
  const here = await $.session.cwd().catch(() => undefined)
  if (here) roster.push({ id: 'main', live: true, name: 'the main session', cwd: here })
  // A worker in another harness lives in its worktree until it is stopped or its terminal is gone.
  for (const s of Object.values(await read($, sessions))) {
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
  // Only trusted with a roster that lists agents at all; an unreadable pid means no lock is broken.
  if (roster.some(a => a.id !== 'main')) {
    const ppid = Number((await run(['sh', '-c', 'echo $PPID'])).stdout.trim())
    if (Number.isInteger(ppid) && ppid > 1) {
      partial.ownPid = ppid
      // A fresh agent's worktree is locked before the roster lists it; only an old lock is judged.
      // Unknown age (no admin dir, no lock file) counts as young.
      const oldLocks = new Set<string>()
      for (const w of worktrees.slice(1)) {
        if (w.locked === undefined || !/\bpid (\d+)\b/.test(w.locked) || !w.locked.includes(`pid ${ppid}`)) continue
        const dir = await run(['git', '-C', w.path, 'rev-parse', '--absolute-git-dir'])
        if (dir.exitCode !== 0) continue
        const old = await run(['find', `${dir.stdout.trim()}/locked`, '-mmin', '+10'])
        if (old.exitCode === 0 && old.stdout.trim() !== '') oldLocks.add(w.path)
      }
      partial.oldLocks = oldLocks
    }
  }
  const ancestry = new Set<string>()
  for (const q of ancestryQueries(partial)) {
    const [a, b] = q.split(' ')
    if ((await run(['git', 'merge-base', '--is-ancestor', a!, b!])).exitCode === 0) ancestry.add(q)
  }
  return { inputs: { ...partial, ancestry }, notes }
}

// One sweep at a time: the queue's `done`, a queue ending and /flow clean may meet.
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
async function sweep($: EngineInterface, base: string, apply: boolean, dryHint?: string, started?: () => void): Promise<string> {
  return exclusive(async () => {
    started?.()
    const g = await gatherClean($, base)
    if (g.inputs === undefined) return [...g.notes, g.error ?? 'Cleanup failed.'].join('\n')
    const s = selectCleanup(g.inputs)
    const note = g.notes.join('\n') || undefined
    if (!apply) {
      await update($, leftovers, () => leftoverCounts(s))
      return sweepText(s, { applied: false, ...(note && { note }), ...(dryHint && { dryHint }) })
    }
    const git = async (argv: string[]) => {
      try {
        return await $.process.run(['git', ...argv], { timeoutMs: 60_000 })
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
        const isLink = await $.process.run(['test', '-L', at], { timeoutMs: 10_000 }).then(r => r.exitCode === 0, () => false)
        if (isLink) await $.process.run(['rm', '-f', '--', at], { timeoutMs: 10_000 }).catch(() => undefined)
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
    await update($, leftovers, () => leftoverCounts(s, failed, true))
    if (removed.worktrees.length || removed.branches.length) {
      await appendLog($, {
        event: 'clean', owner: 'main',
        text: `removed ${[...removed.worktrees.map(p => `worktree ${p.split('/').pop()}`), ...removed.branches.map(b => `branch ${b}`)].join(', ')}`
          + s.dropped.filter(d => (d.kind === 'worktree' ? removed.worktrees : removed.branches).includes(d.name))
            .map(d => `; dropped unpushed in ${d.kind} ${d.name.split('/').pop()}: ${d.commits.join(' | ')}`).join(''),
      })
    }
    return sweepText(s, { applied: true, removed, failed, ...(note && { note }) })
  })
}

// The automatic sweep (cleanup "auto"): in the background, at most one waiting behind a running
// sweep, failures to the log only.
let autoQueued = false
function autoSweep($: EngineInterface): void {
  if (cleanupMode !== 'auto' || autoQueued) return
  autoQueued = true
  void sweep($, cleanupBase, true, undefined, () => { autoQueued = false })
    .catch(err => warn($, 'cleaning up', err))
}

// The dry sweep behind the pane's leftover line, on the PR list's cadence.
function refreshLeftovers($: EngineInterface): void {
  void sweep($, cleanupBase, false).catch(err => warn($, 'looking for leftovers', err))
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
    const window = a.usage.window ?? windowOf(a.usage.model, mainModel, mainWindow, a.usage.tokens, a.spawnWindow)
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

// The two settings files this session could read, whether or not they exist yet.
async function locate($: EngineInterface): Promise<string[]> {
  const git = async (...args: string[]) => {
    try {
      const r = await $.process.run(['git', 'rev-parse', ...args])
      return r.exitCode === 0 ? r.stdout.trim() : ''
    } catch {
      return ''
    }
  }
  const [top, common] = await Promise.all([git('--show-toplevel'), git('--path-format=absolute', '--git-common-dir')])
  return [top === '' ? '' : `${top}/.claude/flow.json`, common === '' ? '' : `${common}/flow/config.json`]
}

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    if (path === '' || !(await $.fs.exists(path))) return undefined
    return String(await $.fs.read(path))
  } catch {
    return undefined
  }
}

// Cheap change check for the roster poll: both files' mtimes, "-" for a missing one.
async function signature($: EngineInterface, paths: string[]): Promise<string> {
  const parts = await Promise.all(paths.map(async p => {
    try {
      if (p === '') return '-'
      return String((await $.fs.stat(p)).mtimeMs)
    } catch {
      return '-'
    }
  }))
  return parts.join('|')
}

type Merged = { settings: ReturnType<typeof settingsOf>; seen: string }

// Layer /config under the settings files. The caller assigns the result (register's `apply`),
// since the hooks compiler only follows `$` into top-level functions.
async function loadSettings($: EngineInterface, options: Record<string, unknown>, paths: string[], base: string): Promise<Merged> {
  const seen = await signature($, paths)
  const layers = await Promise.all(paths.map(async path => ({ path, text: await readText($, path) })))
  const loaded = mergeLayers(options, layers)
  if (loaded.warnings.length > 0) void $.ui.toast(`flow settings:\n${loaded.warnings.join('\n')}`)
  return { settings: settingsOf(loaded.raw, base), seen }
}

// The agent definitions carry the settings' prompts and models; a re-registered name is
// replaced from the next turn, so agents already running keep what they started with.
async function registerAgents($: EngineInterface, settings: ReturnType<typeof settingsOf>) {
  await $.agent.register({
    name: 'manager',
    description: 'A flow manager: owns one task, writes briefs, starts flow:worker agents, reviews their PRs and hands them to the merge queue. ' +
      'Pass the task in the user\'s words as the prompt and a short task slug as the name; run it in the background.',
    prompt: fill(MANAGER_PROMPT.replace('{{QUEUE_RULE}}', settings.useQueue ? QUEUE_RULE : NO_QUEUE_RULE), settings),
    model: settings.managerModel,
    background: true,
  })
  await $.agent.register({
    name: 'worker',
    description: 'A flow worker: implements one brief in a git worktree of its own and opens a PR. ' +
      'Pass the whole brief as the prompt, its first line "Your name: <slug>", and the slug as the name.',
    prompt: fill(WORKER_PROMPT, settings),
    model: settings.workerModel,
    isolation: 'worktree',
    background: true,
  })
  await $.agent.register({
    name: 'continue',
    description: 'A flow worker that continues a handed-off branch in the same worktree. The plugin picks it when a flow:worker spawn says "Continue on branch:"; never start it yourself.',
    prompt: fill(WORKER_PROMPT, settings),
    model: settings.workerModel,
    background: true,
  })
  await $.agent.register({
    name: 'queue',
    description: 'The flow merge queue. Started by the plugin when a PR is handed over; never start it yourself.',
    prompt: fill(QUEUE_PROMPT, settings),
    model: settings.queueModel,
    isolation: 'worktree',
    background: true,
  })
}

// Re-read the settings when a file's mtime changed (the roster poll calls this): undefined when
// nothing changed or the reload failed, which never stops the roster refresh.
async function recheck($: EngineInterface, options: Record<string, unknown>, paths: string[], base: string, seen: string): Promise<Merged | undefined> {
  try {
    if ((await signature($, paths)) === seen) return undefined
    const merged = await loadSettings($, options, paths, base)
    await registerAgents($, merged.settings)
    return merged
  } catch {
    return undefined
  }
}

// Workers in other harnesses (sessions.ts): started in an Orca terminal or a tmux session, watched
// through the report file they write. A command that can't start is an exit code here, never a throw.
type Ran = { exitCode: number; stdout: string; stderr: string }

async function runCmd($: EngineInterface, argv: string[], timeoutMs = 60_000): Promise<Ran> {
  try {
    return await $.process.run(argv, { timeoutMs })
  } catch (err) {
    return { exitCode: 127, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
  }
}

const why = (r: Ran): string => (r.stderr.trim() || r.stdout.trim()).split('\n')[0]?.slice(0, 300) || `exit ${r.exitCode}`

// A terminal is checked this often; the report file on every poll.
const ALIVE_MS = 30_000
// A screen is looked at this often, and a running harness whose screen has not changed for
// IDLE_MS (and wrote no new report) is told to its manager as idle.
const LOOK_MS = 10_000
const IDLE_MS = 90_000
// A harness whose own log says its turn ended is idle this long after, when no report came:
// time for it to write the report file as its turn's last step.
const TURN_GRACE_MS = 15_000
// Quota readings for the pane are refreshed this often.
const LIMITS_MS = 60_000
// A second press within this long confirms restart or stop from the pane.
const ARM_MS = 5000
// A report file younger than this may still be being written: it waits for the next poll.
const SETTLE_MS = 2000
const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash', 'ksh', 'tcsh', 'nu'])

type Caller = { id: string; name: string }

async function startSession($: EngineInterface, input: Record<string, unknown>, caller: Caller, s: ReturnType<typeof settingsOf>): Promise<string> {
  const gated = await preflightGate($, caller.id === 'main' ? undefined : caller.id)
  if (gated !== undefined) return `Refused: ${gated}`
  const name = String(input.name ?? '').trim()
  if (!NAME_RULE.test(name)) return 'Refused: name must be letters, digits, "-" or "_" (it becomes the branch flow/<name>).'
  const brief = String(input.brief ?? '').trim()
  if (brief === '') return 'Refused: brief is empty.'
  const old = (await read($, sessions))[name]
  if (old !== undefined && !['exited', 'stopped'].includes(old.status)) return `Refused: session ${name} is already running (${old.harness} in ${old.host}).`
  if ((await $.agent.list()).some(a => a.name === name && !ENDED.has(a.status))) return `Refused: an agent named ${name} is running; pick another name.`
  const harness = String(input.harness ?? (s.workerHarness === 'agent' ? '' : s.workerHarness)).trim()
  const custom = String(input.command ?? '').trim()
  const spec: HarnessSpec | undefined = harness === 'command' ? (custom ? { start: custom } : undefined) : s.harnesses[harness]
  if (harness === 'command' && spec === undefined) return 'Refused: harness "command" needs command, the command line that starts it ({prompt} or {prompt_file} where the prompt goes).'
  if (spec === undefined) return `Refused: unknown harness "${harness}". Known: ${Object.keys(s.harnesses).join(', ')}; or harness "command" with command.`
  const template = spec.start

  // Installed? Homebrew's prefixes are added: a GUI-started engine often lacks them on PATH.
  const program = spec.program ?? programOf(template)
  if (program !== undefined) {
    const found = await runCmd($, ['sh', '-c', 'PATH="$PATH:/opt/homebrew/bin:/usr/local/bin" command -v "$1"', 'sh', program], 10_000)
    if (found.exitCode !== 0) return `Refused: ${program} is not installed (not on PATH). Start this worker as a flow:worker agent instead, or pick another harness.`
  }
  if (spec.quota !== undefined && s.minQuota > 0) {
    const left = await quotaLeft($, spec.quota)
    if (left !== undefined && left < s.minQuota) {
      return `Refused: ${harness} has ${left}% of its quota left, below min_quota (${s.minQuota}%). Start this worker as a flow:worker agent instead, or with another harness.`
    }
  }

  const dir = await stateDir($)
  const wl = await runCmd($, ['git', 'worktree', 'list', '--porcelain'])
  const main = /^worktree (.+)$/m.exec(wl.stdout)?.[1]
  if (dir === undefined || main === undefined) return 'Refused: not in a git repo.'
  const choice = String(input.host ?? s.sessionHost)
  const orcaUp = choice !== 'tmux' && await runCmd($, ['orca', 'status'], 10_000).then(r => r.exitCode === 0 && /runtimeReachable:\s*true/.test(r.stdout))
  const tmuxUp = choice !== 'orca' && !orcaUp && (await runCmd($, ['tmux', '-V'], 10_000)).exitCode === 0
  const host = pickHost(choice, orcaUp, tmuxUp)
  if (typeof host !== 'string') return `Refused: ${host.error}`

  const branch = `flow/${name}`
  await runCmd($, ['git', 'fetch', 'origin', s.base], 120_000)
  let worktree: string
  if (host === 'tmux') {
    worktree = `${main}/.claude/worktrees/${name}`
    const r = await runCmd($, ['git', 'worktree', 'add', '-b', branch, worktree, `origin/${s.base}`], 120_000)
    if (r.exitCode !== 0) return `Could not create the worktree: ${why(r)}`
  } else {
    const r = await runCmd($, ['orca', 'worktree', 'create', '--repo', `path:${main}`, '--name', name, '--base-branch', `origin/${s.base}`, '--json'], 180_000)
    const path = r.exitCode === 0 ? findWorktreePath(r.stdout) : undefined
    if (path === undefined) return `Could not create an Orca worktree: ${why(r)}`
    worktree = path
    const m = await runCmd($, ['git', '-C', worktree, 'branch', '-m', branch])
    if (m.exitCode !== 0) return `Created the Orca worktree ${worktree}, but could not name its branch ${branch}: ${why(m)}. Nothing was started in it.`
  }

  const sdir = `${dir}/sessions/${name}`
  const promptFile = `${sdir}/prompt.md`
  const reportFile = `${sdir}/report.md`
  // A report left by an earlier session of this name would read as this one's.
  await runCmd($, ['rm', '-f', reportFile])
  const prompt = fill(SESSION_PROMPT, s)
    .replaceAll('{{HARNESS}}', harness === 'command' ? 'a coding agent' : harness)
    .replaceAll('{{OWNER}}', caller.name).replaceAll('{{NAME}}', name)
    .replaceAll('{{BRANCH}}', branch).replaceAll('{{REPORT}}', reportFile)
  await $.fs.write(promptFile, `${prompt}${brief}\n`)
  const line = commandFor(template, promptFile)

  let handle: string
  if (host === 'tmux') {
    handle = tmuxName(name)
    const r = await runCmd($, ['tmux', 'new-session', '-d', '-s', handle, '-c', worktree])
    if (r.exitCode !== 0) return `The worktree ${worktree} is ready, but tmux could not start: ${why(r)}`
    // A tmux server started from here inherits this session's environment; a nested claude refuses to run under it.
    await runCmd($, ['tmux', 'send-keys', '-t', handle, '-l', `unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT; ${line}`])
    await runCmd($, ['tmux', 'send-keys', '-t', handle, 'Enter'])
  } else {
    const r = await runCmd($, ['orca', 'terminal', 'create', '--worktree', `path:${worktree}`, '--title', name, '--command', line, '--json'])
    const h = r.exitCode === 0 ? findHandle(r.stdout) : undefined
    if (h === undefined) return `The worktree ${worktree} is ready, but the Orca terminal could not start: ${why(r)}`
    handle = h
  }

  const t = await $.clock.now()
  const session: Session = {
    name, harness, host, handle, worktree, branch, promptFile, reportFile, start: template,
    ...(spec.resume !== undefined && { resume: spec.resume }),
    ...(spec.digest !== undefined && { digestKind: spec.digest }),
    owner: caller.id, ownerName: caller.name, status: 'running', startedAt: t,
  }
  await update($, sessions, all => ({ ...all, [name]: session }))
  await update($, activity, acts => ({ ...acts, [sessionKey(name)]: { startedAt: t, lastAt: t, log: [`started ${harness} in ${host}`] } }))
  await appendLog($, { event: 'spawn', agent: name, owner: caller.name, branch })
  await refresh($)
  void openPane($)
  return `Started ${name}: ${harness} in ${host} (${host === 'tmux' ? `tmux attach -t ${handle}` : handle}), worktree ${worktree}, branch ${branch}. ` +
    'Its report comes to you as a "flow session:" message: end your turn while you wait.'
}

// The newest lines with Codex rate limits, newest file first.
async function codexRateLines($: EngineInterface): Promise<string[]> {
  const r = await runCmd($, ['sh', '-c',
    'ls -t "$HOME"/.codex/sessions/*/*/*/rollout-*.jsonl 2>/dev/null | head -5 | while read -r f; do grep -h \'"rate_limits":{\' "$f" | tail -1; done'], 10_000)
  return r.stdout.split('\n')
}

async function codexLimitsNow($: EngineInterface): Promise<Limit[]> {
  const t = await $.clock.now()
  for (const line of await codexRateLines($)) {
    const limits = codexLimits(line, t)
    if (limits !== undefined) return limits
  }
  return []
}

// The harness's own log for this session: the newest file written since it started, in its worktree.
async function findDigestFile($: EngineInterface, s: Session): Promise<string | undefined> {
  const script = s.digestKind === 'codex-rollout'
    ? 'fs=$(find "$HOME/.codex/sessions" -name "rollout-*.jsonl" -newer "$1" 2>/dev/null | while read -r f; do head -c 20000 "$f" | grep -q -F "\\"cwd\\":\\"$2\\"" && echo "$f"; done); [ -n "$fs" ] && ls -t $fs | head -1'
    : 'fs=$(find "$HOME/.claude/projects/$2" -maxdepth 1 -name "*.jsonl" -newer "$1" 2>/dev/null); [ -n "$fs" ] && ls -t $fs | head -1'
  const arg = s.digestKind === 'codex-rollout' ? s.worktree : claudeProjectDir(s.worktree)
  const r = await runCmd($, ['sh', '-c', script, 'sh', s.promptFile, arg], 10_000)
  const file = r.stdout.trim().split('\n')[0]
  return file === undefined || file === '' ? undefined : file
}

// Reads the tail of the harness's log when it moved, and mirrors it on the card: the newest
// action as what it is doing, new actions in its activity, its context fill on the meter.
async function refreshDigest($: EngineInterface, s: Session, t: number): Promise<Digest | undefined> {
  if (s.digestKind === undefined) return undefined
  const file = (await findDigestFile($, s)) ?? s.digestFile
  if (file === undefined) return undefined
  const st = await $.fs.stat(file).catch(() => undefined)
  if (st === undefined) return s.digest
  if (file === s.digestFile && st.mtimeMs === s.digestSeen) return s.digest
  const r = await runCmd($, ['tail', '-c', '65536', file], 10_000)
  if (r.exitCode !== 0) return s.digest
  const d = s.digestKind === 'codex-rollout' ? parseCodexRollout(r.stdout) : parseClaudeTranscript(r.stdout)
  await update($, sessions, all => ({ ...all, [s.name]: { ...all[s.name]!, digestFile: file, digestSeen: st.mtimeMs, digest: d } }))
  const before = s.digest?.actions ?? []
  const fresh = d.actions.filter(a => !before.includes(a))
  const key = sessionKey(s.name)
  await update($, activity, acts => {
    const a = acts[key] ?? { startedAt: t, lastAt: t, log: [] }
    return {
      ...acts,
      [key]: {
        ...a, lastAt: d.at ?? a.lastAt, log: [...a.log, ...fresh].slice(-LOG_MAX),
        ...(d.actions.length > 0 && { doing: d.actions[d.actions.length - 1] }),
        ...(d.tokens !== undefined && { usage: { tokens: d.tokens, model: s.harness, ...(d.window !== undefined && { window: d.window }) } }),
      },
    }
  })
  return d
}

// The share of a harness's quota left: "codex-logs" reads Codex's own rate-limit logs, anything
// else is a shell command that prints a percent. Undefined when it can't tell, which never blocks.
async function quotaLeft($: EngineInterface, how: string): Promise<number | undefined> {
  if (how === 'codex-logs') return codexQuotaLeft($)
  const r = await runCmd($, ['sh', '-c', how], 20_000)
  return r.exitCode === 0 ? percentOf(r.stdout) : undefined
}

// The newest Codex rate-limit reading, from the five newest rollout files; undefined when there is
// none or it is too old to say anything.
async function codexQuotaLeft($: EngineInterface): Promise<number | undefined> {
  const t = await $.clock.now()
  for (const line of await codexRateLines($)) {
    const left = codexRemaining(line, t)
    if (left !== undefined) return left
  }
  return undefined
}

// Whether the harness is still there: the terminal exists, and in tmux it is not back at its shell.
async function sessionAlive($: EngineInterface, s: Session): Promise<boolean> {
  if (s.host === 'orca') {
    // A closed terminal still shows, with connected false and why it exited.
    const r = await runCmd($, ['orca', 'terminal', 'show', '--terminal', s.handle, '--json'], 10_000)
    return r.exitCode === 0 && !/"ok":\s*false|"connected":\s*false|"exitCause"/.test(r.stdout)
  }
  const r = await runCmd($, ['tmux', 'display-message', '-p', '-t', s.handle, '#{pane_current_command}'], 10_000)
  return r.exitCode === 0 && !SHELLS.has(r.stdout.trim().replace(/^-/, ''))
}

async function sessionTail($: EngineInterface, s: Session, lines: number): Promise<Ran> {
  return s.host === 'tmux'
    ? runCmd($, ['tmux', 'capture-pane', '-p', '-J', '-t', s.handle, '-S', `-${lines}`], 10_000)
    : runCmd($, ['orca', 'terminal', 'read', '--terminal', s.handle, '--limit', String(lines)], 10_000)
}

// What the terminal shows now (the rendered screen, not the scrollback).
async function sessionScreen($: EngineInterface, s: Session): Promise<string | undefined> {
  const r = s.host === 'tmux'
    ? await runCmd($, ['tmux', 'capture-pane', '-p', '-t', s.handle], 10_000)
    : await runCmd($, ['orca', 'terminal', 'read', '--terminal', s.handle, '--screen'], 10_000)
  return r.exitCode === 0 ? r.stdout : undefined
}

// Types a line into the terminal and submits it: a paste in tmux keeps a multi-line message whole in a TUI.
async function typeInto($: EngineInterface, s: Session, text: string): Promise<Ran> {
  if (s.host === 'orca') return runCmd($, ['orca', 'terminal', 'send', '--terminal', s.handle, '--text', text, '--enter', '--json'])
  let r = await runCmd($, ['tmux', 'set-buffer', '-b', `flow-${s.name}`, '--', text])
  if (r.exitCode === 0) r = await runCmd($, ['tmux', 'paste-buffer', '-d', '-p', '-b', `flow-${s.name}`, '-t', s.handle])
  if (r.exitCode === 0) r = await runCmd($, ['tmux', 'send-keys', '-t', s.handle, 'Enter'])
  return r
}

async function tellOwner($: EngineInterface, s: Session, text: string): Promise<void> {
  if (s.owner === 'main') $.clock.after(0, () => void $.prompt.submit({ text }).catch(() => undefined))
  else await $.session.send({ to: { agentId: s.owner }, text }).catch(() => undefined)
}

async function noteSession($: EngineInterface, name: string, t: number, line: string, answer?: string): Promise<void> {
  const key = sessionKey(name)
  await update($, activity, acts => {
    const a = acts[key] ?? { startedAt: t, lastAt: t, log: [] }
    return { ...acts, [key]: { ...a, lastAt: t, log: [...a.log, line].slice(-LOG_MAX), ...(answer !== undefined && { answer }) } }
  })
}

// One poll: a settled, newer report file goes to the owner; a terminal that went away is told once.
let watching = false
let limitsAt = -Infinity
async function watchSessions($: EngineInterface): Promise<void> {
  if (watching) return
  watching = true
  try {
    const t = await $.clock.now()
    if (t - limitsAt >= LIMITS_MS) {
      limitsAt = t
      const limits = await codexLimitsNow($)
      await update($, harnessLimits, () => limits)
    }
    for (const s of Object.values(await read($, sessions))) {
      if (s.status === 'stopped' || s.status === 'exited') continue
      const st = await $.fs.stat(s.reportFile).catch(() => undefined)
      if (st !== undefined && st.mtimeMs > (s.reportAt ?? 0) && t - st.mtimeMs >= SETTLE_MS) {
        const report = String(await $.fs.read(s.reportFile).catch(() => '')).trim()
        if (report !== '') {
          await update($, sessions, all => ({ ...all, [s.name]: { ...all[s.name]!, status: 'reported' as const, reportAt: st.mtimeMs } }))
          await noteSession($, s.name, t, 'reported', report)
          await appendLog($, { event: 'report', agent: s.name, owner: s.ownerName, text: report.split('\n').pop() ?? '' })
          await tellOwner($, s, reportMessage(s, report))
          continue
        }
      }
      // A running harness whose screen stopped changing is told once as idle; a change wakes it again.
      // Idle is told once per quiet spell: the harness's own log says its turn ended, or (for any
      // harness) its screen stopped changing; either way with no report written since.
      if ((s.status === 'running' || s.status === 'idle') && t - (s.lookedAt ?? s.startedAt) >= LOOK_MS) {
        const [screen, digest] = await Promise.all([sessionScreen($, s), refreshDigest($, s, t)])
        if (screen !== undefined) {
          const hash = screenHash(screen)
          const changed = hash !== s.screen
          const since = changed ? t : s.screenAt ?? t
          const reported = s.reportAt ?? 0
          const ended = digest?.turnDone
          const why = ended !== undefined && t - ended >= TURN_GRACE_MS && reported < ended
            ? { key: `turn:${ended}`, text: `ended its turn ${ago(t - ended)} ago` }
            : !changed && t - since >= IDLE_MS && reported < since
            ? { key: `quiet:${since}`, text: `has shown nothing new for ${ago(t - since)}` }
            : undefined
          const idle = why !== undefined && s.status === 'running' && why.key !== s.idleKey
          const status = changed && s.status === 'idle' ? 'running' as const : idle ? 'idle' as const : s.status
          const text = screen.split('\n').slice(-40).join('\n')
          await update($, sessions, all => ({
            ...all,
            [s.name]: { ...all[s.name]!, screen: hash, screenAt: since, lookedAt: t, status, screenText: text, ...(idle && { idleKey: why!.key }) },
          }))
          if (idle) {
            await noteSession($, s.name, t, 'idle')
            await tellOwner($, s, idleMessage(s, why!.text, text, digest?.lastWords))
          }
        }
      }
      if (t - (s.checkedAt ?? s.startedAt) < ALIVE_MS) continue
      const alive = await sessionAlive($, s)
      await update($, sessions, all => ({ ...all, [s.name]: { ...all[s.name]!, checkedAt: t, ...(!alive && { status: 'exited' as const }) } }))
      if (!alive) {
        const tail = await sessionTail($, s, 30)
        await noteSession($, s.name, t, 'ended')
        await tellOwner($, s, goneMessage(s, tail.exitCode === 0 ? tail.stdout.slice(-3000) : ''))
      }
    }
  } catch (err) {
    await warn($, 'watching sessions', err)
  } finally {
    watching = false
  }
}

async function sessionTool($: EngineInterface, input: Record<string, unknown>, caller: Caller, s: ReturnType<typeof settingsOf>): Promise<string> {
  const action = String(input.action ?? '')
  if (action === 'start') return startSession($, input, caller, s)
  const all = await read($, sessions)
  if (action === 'list') {
    const list = Object.values(all).sort((a, b) => a.startedAt - b.startedAt)
    return list.length === 0 ? 'No sessions.' : list.map(x => `${sessionLine(x)}, owner ${x.ownerName}`).join('\n')
  }
  const name = String(input.name ?? '')
  const ss = all[name]
  if (ss === undefined) return `No session named "${name}". action "list" shows them.`
  const t = await $.clock.now()
  if (action === 'read') {
    const lines = Math.min(1000, Math.max(10, Math.round(Number(input.lines) || 80)))
    const r = await sessionTail($, ss, lines)
    if (r.exitCode !== 0) return `Could not read ${name}'s terminal: ${why(r)}`
    return r.stdout.length > 12_000 ? `…${r.stdout.slice(-12_000)}` : r.stdout || '(empty)'
  }
  if (action === 'send') {
    const text = String(input.text ?? '').trim()
    if (text === '') return 'Refused: text is empty.'
    if (ss.status === 'stopped' || ss.status === 'exited') return `Refused: ${name} has ${ss.status}. Start a new session to go on.`
    const r = await typeInto($, ss, text)
    if (r.exitCode !== 0) return `Could not send to ${name}: ${why(r)}`
    await update($, sessions, x => ({ ...x, [name]: { ...x[name]!, status: 'running' as const } }))
    await noteSession($, name, t, `message: ${text.replace(/\s+/g, ' ').slice(0, 80)}`)
    return `Sent to ${name}. Its next report comes to you as a "flow session:" message.`
  }
  if (action === 'keys') {
    const keys = String(input.keys ?? '').trim()
    if (keys === '') return 'Refused: keys is empty. Named keys: enter, escape, interrupt, tab, up, down, left, right, backspace, space; any other word is typed as it is.'
    if (ss.status === 'stopped' || ss.status === 'exited') return `Refused: ${name} has ${ss.status}.`
    const k = keysOf(keys)
    const r = ss.host === 'tmux'
      ? await runCmd($, ['tmux', 'send-keys', '-t', ss.handle, ...k.tmux])
      : await runCmd($, ['orca', 'terminal', 'send', '--terminal', ss.handle, '--text', k.raw, '--json'])
    if (r.exitCode !== 0) return `Could not press keys in ${name}: ${why(r)}`
    await update($, sessions, x => ({ ...x, [name]: { ...x[name]!, status: 'running' as const } }))
    await noteSession($, name, t, `keys: ${keys}`)
    return `Pressed ${keys} in ${name}. "read" shows what it did.`
  }
  if (action === 'restart') {
    // In the same terminal: the harness is stopped if it still runs, then its resume line (or its
    // start line with the same prompt) is typed into the shell left behind.
    const line = ss.resume !== undefined ? ss.resume : commandFor(ss.start, ss.promptFile)
    if (ss.host === 'tmux') {
      const alive = await runCmd($, ['tmux', 'has-session', '-t', ss.handle], 10_000)
      if (alive.exitCode !== 0) return `Refused: ${name}'s tmux session is gone. Start a new session (a new name) to go on.`
      // A fresh shell in the same pane, whatever the old harness was doing: no harness's own quit keys needed.
      const fresh = await runCmd($, ['tmux', 'respawn-pane', '-k', '-t', ss.handle, '-c', ss.worktree], 10_000)
      if (fresh.exitCode !== 0) return `Could not restart ${name}: ${why(fresh)}`
      await runCmd($, ['tmux', 'send-keys', '-t', ss.handle, '-l', `unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT; ${line}`])
      await runCmd($, ['tmux', 'send-keys', '-t', ss.handle, 'Enter'])
    } else {
      const r = await runCmd($, ['orca', 'terminal', 'create', '--worktree', `path:${ss.worktree}`, '--title', name, '--command', line, '--json'])
      const h = r.exitCode === 0 ? findHandle(r.stdout) : undefined
      if (h === undefined) return `Could not open a new Orca terminal for ${name}: ${why(r)}`
      await runCmd($, ['orca', 'terminal', 'close', '--terminal', ss.handle, '--json'])
      await update($, sessions, x => ({ ...x, [name]: { ...x[name]!, handle: h } }))
    }
    await update($, sessions, x => ({ ...x, [name]: { ...x[name]!, status: 'running' as const, checkedAt: t, lookedAt: t } }))
    await noteSession($, name, t, ss.resume !== undefined ? 'restarted (resumed)' : 'restarted (fresh)')
    return `Restarted ${name} with ${ss.resume !== undefined ? 'its resume line' : 'its start line and the same prompt'}: ${line}. ` +
      'Tell it what to do next with action "send" once "read" shows it is up.'
  }
  if (action === 'stop') {
    const r = ss.host === 'tmux'
      ? await runCmd($, ['tmux', 'kill-session', '-t', ss.handle])
      : await runCmd($, ['orca', 'terminal', 'close', '--terminal', ss.handle, '--json'])
    const closed = r.exitCode === 0 ? 'Terminal closed.' : `The terminal did not close (${why(r)}); it may be gone already.`
    await update($, sessions, x => ({ ...x, [name]: { ...x[name]!, status: 'stopped' as const } }))
    await noteSession($, name, t, 'stopped')
    if (input.remove_worktree !== true) return `Stopped ${name}. ${closed} The worktree ${ss.worktree} stays.`
    // Removed only when nothing in it would be lost: no changes, and HEAD on a remote branch.
    const dirty = (await runCmd($, ['git', '-C', ss.worktree, 'status', '--porcelain'])).stdout.trim() !== ''
    const pushed = (await runCmd($, ['git', '-C', ss.worktree, 'branch', '-r', '--contains', 'HEAD'])).stdout.trim() !== ''
    if (dirty || !pushed) return `Stopped ${name}. ${closed} Kept the worktree ${ss.worktree}: ${dirty ? 'it has uncommitted changes' : 'its commits are not pushed'}.`
    const rm = ss.host === 'tmux'
      ? await runCmd($, ['git', 'worktree', 'remove', ss.worktree])
      : await runCmd($, ['orca', 'worktree', 'rm', '--worktree', `path:${ss.worktree}`, '--json'], 120_000)
    return `Stopped ${name}. ${closed} ${rm.exitCode === 0 ? `Removed the worktree ${ss.worktree}.` : `Kept the worktree ${ss.worktree}: ${why(rm)}`}`
  }
  return `Unknown action "${action}".`
}

export const register: Register = (on, options) => {
  let settings = settingsOf(options, 'main')
  queueOn = settings.useQueue
  cleanupMode = settings.cleanup
  cleanupBase = settings.base
  maxManagers = settings.maxManagers
  slotLimit = settings.testSlots
  decisionPhrases = settings.decisionPhrases
  preflightOn = settings.preflight
  preflightWaitMs = settings.preflightWait * 60_000
  // Settings reloads: the files' paths and mtimes, the detected base branch, whether a check runs.
  let paths: string[] = []
  let seen = ''
  let detected = 'main'
  let checking = false
  // Everything that mirrors the settings in a module-level variable is refreshed together.
  const apply = (s: typeof settings) => {
    settings = s
    queueOn = s.useQueue
    cleanupMode = s.cleanup
    cleanupBase = s.base
    maxManagers = s.maxManagers
    slotLimit = s.testSlots
    decisionPhrases = s.decisionPhrases
    preflightOn = s.preflight
    preflightWaitMs = s.preflightWait * 60_000
  }
  // Set once a `[1m]` model was refused for a sub-agent: later spawns go straight to the plain one.
  let noLong = false
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
    await best($, 'loading the inbox', async () => {
      const dir = await stateDir($)
      if (dir === undefined) return
      const disk = normalizeInbox(await readJson($, `${dir}/inbox.json`))
      await update($, inbox, () => disk)
    })
    await best($, 'loading pre-flight', async () => {
      const dir = await stateDir($)
      if (dir === undefined) return
      const disk = normalizePreflight(await readJson($, `${dir}/preflight.json`))
      await update($, preflight, () => disk)
      // A round left undelivered by a session that ended is not sent now.
      const live = (await $.agent.list()).filter(a => a.type === MANAGER && !ENDED.has(a.status) && a.name !== undefined).map(a => a.name!)
      const t = await $.clock.now()
      await withPreflight($, cur => { return { state: closeStale(cur, live, t), out: undefined } })
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
      if (base !== '') detected = base
    } catch {
      // Not a git repo, or no remote: keep "main".
    }
    paths = await locate($)
    try {
      const merged = await loadSettings($, options, paths, detected)
      seen = merged.seen
      apply(merged.settings)
    } catch {
      // Keep the settings from /config alone.
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
      description: 'Show the flow in a pane: managers, their workers, the merge queue and handed-over PRs. /flow inbox lists the open questions to answer, /flow preflight shows the current pre-flight round, /flow close closes it, /flow resume picks up unfinished flow work, /flow approve <pr> lets the merge queue merge a PR that awaits your approval, /flow clean lists leftover worktrees and branches (--yes removes them)',
      argumentHint: '[inbox|preflight|close|resume|approve <pr>|clean]',
    })
    await $.command.register({
      name: 'flow-tasks',
      description: 'Pick tasks from a task source (.claude/flow/sources/<name>.md) and start a manager for each',
      argumentHint: '[source] [ids or filter]',
    })
    await registerAgents($, settings)

    await $.tool.register({
      name: 'handover',
      description: 'Hand an approved PR to the flow merge queue. Records the PR at its current head and starts a queue if none is running. ' +
        'Managers call this after reviewing a worker\'s PR; leave the branch alone afterwards. ' +
        'Refused unless the PR description has a ## Verification section (Ran, Exercised, Not verified); the refusal shows the format.',
      inputSchema: {
        type: 'object',
        properties: {
          pr: { type: 'number', description: 'The PR number' },
          verified: { type: 'string', description: 'Optional: your own one-line summary of the review. The proof itself is read from the PR\'s ## Verification section.' },
          pending: { type: 'string', description: '"none", or decisions the user still has to make; the queue puts them in its report and the status file' },
          after_deploy: { type: 'string', description: '"none", or what to check after deploy; the queue starts a check-only worker for what an agent can check and reports the rest as "needs a person"' },
          report_to: { type: 'string', description: 'Your agent name, so the queue reports back to you' },
          mode: { type: 'string', enum: ['auto', 'confirm'], description: '"confirm" for a risky PR: it waits for the user\'s /flow approve before the queue merges it. "auto" only marks it safe to merge directly and is refused when the merge_mode setting is confirm. Omit to use the setting.' },
        },
        required: ['pr', 'report_to'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'ask',
      description: 'Ask a structured question (a batch) instead of asking in prose. A worker\'s questions go to its manager, a manager\'s to main. ' +
        'Give options and the default you recommend. Non-blocking: go ahead on the default now and say in your report that you assumed it; you get a message if the answer differs. ' +
        'Blocking: end your turn; the answer arrives by message. Main cannot ask. ' +
        'Give a recurring kind of question a short stable kebab-case topic (e.g. version-bump, test-approach): the user can answer a topic once, and a standing answer then answers it for you at once (the result line says so).',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Your agent name' },
          questions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                question: { type: 'string' },
                options: { type: 'array', items: { type: 'string' }, description: 'The choices, at least two' },
                default: { type: 'string', description: 'The option you recommend (its text or its 1-based number)' },
                blocking: { type: 'boolean', description: 'true when you cannot go on without the answer' },
                context: { type: 'string', description: 'What the answerer needs to know' },
                topic: { type: 'string', description: 'For a question of a recurring kind: a short, stable kebab-case label (e.g. version-bump, test-approach), the same every time you ask it. The user can answer such a topic once as a standing answer.' },
              },
              required: ['question', 'options', 'default', 'blocking'],
            },
          },
        },
        required: ['from', 'questions'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'preflight',
      description: 'Managers only. File your pre-flight after looking over your task (read the code, the history and open PRs; no workers yet): the plugin refuses your worker starts until you have, ' +
        'and, if you ask blocking questions, until they are answered. Main gets one combined round from all managers started together. ' +
        'questions are stored in the decision inbox for main, like mcp__flow__ask but without a toast. Filing again replaces your earlier filing.',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Your agent name' },
          summary: { type: 'string', description: 'One line: what you will do' },
          workers: { type: 'number', description: 'Estimate of how many workers you will start' },
          criteria: { type: 'array', items: { type: 'string' }, description: 'Acceptance criteria, at least one' },
          shipped: {
            type: 'array', description: 'Work already shipped, duplicated or already running; empty when none',
            items: { type: 'object', properties: { what: { type: 'string' }, ref: { type: 'string', description: 'PR, commit or branch' } }, required: ['what', 'ref'] },
          },
          depends: {
            type: 'array', description: 'Other tasks or managers this one depends on; empty when none',
            items: { type: 'object', properties: { on: { type: 'string' }, why: { type: 'string' } }, required: ['on', 'why'] },
          },
          questions: {
            type: 'array', description: 'Optional, same shape as mcp__flow__ask',
            items: {
              type: 'object',
              properties: {
                question: { type: 'string' },
                options: { type: 'array', items: { type: 'string' }, description: 'The choices, at least two' },
                default: { type: 'string', description: 'The option you recommend (its text or its 1-based number)' },
                blocking: { type: 'boolean', description: 'true when you cannot start without the answer' },
                context: { type: 'string' },
                topic: { type: 'string' },
              },
              required: ['question', 'options', 'default', 'blocking'],
            },
          },
        },
        required: ['from', 'summary', 'criteria', 'shipped', 'depends'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'answer',
      description: 'Answer questions addressed to you in the decision inbox: a manager answers its workers\' asks, main answers the managers\'. ' +
        'answers: [{id, choice}] (choice is an option\'s letter, number or text, or free text). defaults: true takes every default of your open questions, or only those in ids.',
      inputSchema: {
        type: 'object',
        properties: {
          answers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' }, choice: { type: 'string' },
                always: { type: 'boolean', description: 'Main only: also make this answer a standing rule, so the same kind of question is answered at once from now on' },
              },
              required: ['id', 'choice'],
            },
          },
          defaults: { type: 'boolean', description: 'Answer with the defaults' },
          ids: { type: 'array', items: { type: 'string' }, description: 'With defaults: only these question ids' },
        },
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'standing',
      description: 'Main only. Standing answers: rules that answer a recurring decision-inbox question at once. action "list": the rules (id, file, match, answer, how often used) and suggestions ' +
        '(questions you answered the same way 3 or more times). "add": topic or match (a case-insensitive regex on the question text), answer, optional blocking (default false: blocking questions are left to you) and from (asker name). ' +
        '"remove": id. Rules without an id are named by file and position: personal:1, repo:2.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'add', 'remove'] },
          topic: { type: 'string' },
          match: { type: 'string' },
          answer: { type: 'string', description: 'An option of the question: its text, letter or number' },
          blocking: { type: 'boolean' },
          from: { type: 'string' },
          id: { type: 'string' },
        },
        required: ['action'],
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
      name: 'clean',
      description: 'Leftover worktrees under .claude/worktrees/ and local branches of finished work. Without apply, a dry run: what would be removed and what is kept and why. ' +
        'With apply true, removes only clean work that is on the base or in a merged PR (or pushed with its PR closed); uncommitted, unpushed, locked and live work is never touched.',
      inputSchema: { type: 'object', properties: { apply: { type: 'boolean', description: 'Remove the safe candidates (default false: dry run)' } } },
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

    await $.tool.register({
      name: 'session',
      description: 'Workers outside this session: another harness (codex, gemini, opencode, claude, or your own command line) in an Orca terminal or a tmux session the user can watch. ' +
        'action "start" (name, brief, harness, host?, command?) makes a worktree on flow/<name> from the base and starts the harness with the worker rules and the brief; its report comes back to you as a "flow session:" message. ' +
        'The same controls work for every harness: "send" (name, text) types a message and submits it, "keys" (name, keys) presses keys ("1", "y enter", "escape", "interrupt", "down enter"), ' +
        '"read" (name, lines?) shows the end of its terminal, "restart" (name) starts it again in its worktree (resuming its conversation where the harness can), "list" all sessions, "stop" (name, remove_worktree?) closes it. ' +
        'A harness that goes quiet without a report is told to you as idle.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'send', 'keys', 'read', 'restart', 'list', 'stop'] },
          name: { type: 'string', description: 'The worker name, as for an agent worker: <your name>-<package-slug>' },
          brief: { type: 'string', description: 'start: the whole brief, its first line "Your name: <name>"' },
          harness: { type: 'string', description: 'start: claude, codex, gemini, opencode, a name from the harnesses setting, or "command". Default: the worker_harness setting' },
          command: { type: 'string', description: 'start with harness "command": the command line; {prompt} is the prompt as one shell word, {prompt_file} its path' },
          host: { type: 'string', enum: ['orca', 'tmux'], description: 'start: where it runs. Default: the session_host setting (Orca when it runs, else tmux)' },
          text: { type: 'string', description: 'send: what to type into its terminal' },
          keys: { type: 'string', description: 'keys: space-separated; enter, escape, interrupt (Ctrl-C), tab, up, down, left, right, backspace, space by name, any other word typed as it is' },
          lines: { type: 'number', description: 'read: how many lines from the end (default 80)' },
          remove_worktree: { type: 'boolean', description: 'stop: also remove the worktree, only if it is clean and pushed' },
        },
        required: ['action'],
      },
      isDeferred: false,
    })

    $.clock.every(POLL_MS, () => {
      void refresh($)
      void watchSessions($)
      if (checking) return
      checking = true
      void recheck($, options, paths, detected, seen).then(m => {
        if (m !== undefined) { seen = m.seen; apply(m.settings) }
      }).finally(() => { checking = false })
    })
    // gh is not free: a slow timer, one look shortly after the start, and status when the list is stale.
    $.clock.every(PR_POLL_MS, () => { void fetchPrs($); refreshLeftovers($) })
    void fetchPrs($)
    refreshLeftovers($)
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
    if (arg === 'inbox') return { text: renderInbox(await read($, inbox), await $.clock.now()) }
    if (arg === 'preflight') {
      return { text: renderStatus(await read($, preflight), await read($, inbox), endedManagers(await read($, roster)), await $.clock.now(), preflightWaitMs) }
    }
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
    const words = arg.split(/\s+/)
    if (words[0] === 'clean' && words.slice(1).every(w => w === '--yes')) {
      // A person's command: --yes removes whatever the cleanup setting says.
      return { text: await sweep($, settings.base, words.length > 1, 'Run /flow clean --yes to remove them.') }
    }
    if (words[0] === 'approve') {
      // Only a person's command approves; no tool does.
      const n = Number(words[1])
      if (words.length !== 2 || !Number.isInteger(n) || n <= 0) return { text: 'Usage: /flow approve <pr>' }
      const h = (await read($, handovers))[String(n)]
      if (h === undefined) return { text: `No handover for PR #${n}.` }
      if (h.status !== 'awaiting') return { text: `PR #${n} is ${h.status}, not awaiting approval.` }
      const next: Handover = { ...h, status: 'pending', approvedHead: h.head }
      await update($, handovers, hs => ({ ...hs, [String(n)]: next }))
      await best($, 'saving a handover', async () => {
        await saveHandover($, next)
        await appendLog($, { event: 'approve', owner: next.reportTo, pr: n, branch: next.branch, text: next.title })
      })
      void $.ui.toast(`PR #${n} approved at ${h.head.slice(0, 8)}`)
      const queue = await ensureQueue($)
      await refresh($)
      return { text: `Approved PR #${n} at ${h.head.slice(0, 8)}. ${queue}` }
    }
    if (arg !== '') return { text: `Unknown argument "${arg}". /flow opens the Flow pane, /flow inbox lists the open questions, /flow preflight shows the pre-flight round, /flow close closes it, /flow resume picks up unfinished work, /flow approve <pr> lets the merge queue merge a PR that awaits your approval, /flow clean lists leftover worktrees and branches (/flow clean --yes removes them).` }
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

  // The plugin starts flow:continue itself; the model is never offered it. It is offered only while
  // the spawn hook below dispatches its own rewrite, since the host checks the offer for a rewrite too.
  on('agent.offer', { agent: CONTINUE }, () => ({ isOffered: continuing > 0 }))

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
    // A manager may not start workers before its pre-flight is filed (and its blocking questions answered).
    if (e.subagentType === WORKER) {
      const gated = await preflightGate($, e.parentAgentId)
      if (gated !== undefined) return { deny: gated }
    }
    if (await fableDenied($, e)) return { deny: FABLE_DENY }
    // A flow agent on a [1m] model: if sub-agents refuse it, retry on the plain model once and
    // remember, so later spawns skip the failed try. A no-model spawn gets the registered model.
    const spawn = e.subagentType === WORKER ? await prepareContinue($, e) : e
    const role = ROLE[spawn.subagentType]
    const wanted = role === undefined ? undefined : (spawn.model ?? (settings as Record<string, unknown>)[`${role}Model`])
    const long = typeof wanted === 'string' && wanted.includes('[1m]') ? wanted : undefined
    // One try, with the [1m] retry; a fallback try below goes through it too.
    const go = async (t: AgentSpawnInput) => {
      let ev = long !== undefined && noLong ? { ...t, model: withoutLong(long) } : t
      let started: Awaited<ReturnType<typeof next>> | { deny: string }
      try {
        started = await dispatch(next, ev)
      } catch (err) {
        if (long === undefined || noLong || !refusedLong(err)) throw err
        started = { deny: String((err as Error).message) }
      }
      if (long !== undefined && !noLong && refusedLong(started)) {
        noLong = true
        ev = { ...t, model: withoutLong(long) }
        void $.ui.toast(`flow: ${long} was refused for sub-agents; using ${ev.model}`)
        started = await dispatch(next, ev)
      }
      return { ev, started }
    }
    let { ev, started } = await go(spawn)
    // The host refused our flow:continue rewrite: never fail the spawn for it. Start a plain worker in a
    // new worktree and give the claimed worktree back.
    if (spawn.subagentType === CONTINUE && !('agentId' in started && started.agentId !== undefined)) {
      const name = (e as { name?: string }).name ?? e.description
      const branch = CONTINUE_LINE.exec(e.prompt)?.[1]
      const path = spawn.cwd
      await best($, 'releasing a continuation claim', async () => { await update($, handoffs, hs => {
        const r = branch === undefined ? undefined : hs[branch]
        if (branch === undefined || r === undefined || r.takenBy !== name) return hs
        const { takenBy: _t, ...rest } = r
        return { ...hs, [branch]: rest }
      }) })
      const { cwd: _c, ...plain } = ev
      const note = `The previous worker's worktree ${path} is kept, and ${branch} may be checked out there: if \`git checkout -B\` fails, work on a local branch and push \`HEAD:${branch}\`.`
      ev = { ...plain, subagentType: WORKER, prompt: ev.prompt.replace(/\n\nYou continue in the same worktree [^\n]*/, `\n\n${note}`) }
      await best($, 'logging a continuation fallback', async () => appendLog($, { event: 'continue', agent: name, owner: await ownerNameOf($, e.parentAgentId), branch, text: 'new worktree (flow:continue refused)' }))
      ;({ ev, started } = await go(ev))
    }
    if ('agentId' in started && started.agentId !== undefined) {
      const t = await $.clock.now()
      const id = started.agentId
      // Recorded only for a `[1m]` model finally used (after the refused-[1m] fallback). A plain
      // model leaves it unset: its window may be the main session's, which windowOf borrows.
      const used = ev.model ?? wanted
      const spawnWindow = typeof used === 'string' && used.includes('[1m]') ? LARGE_WINDOW : undefined
      await update($, activity, acts => ({
        ...acts, [id]: { startedAt: t, lastAt: t, log: [`started: ${e.description}`], ...(spawnWindow !== undefined && { spawnWindow }) },
      }))
      await refresh($)
      void openPane($)
      if (preflightOn && e.subagentType === MANAGER && e.parentAgentId === undefined) {
        await best($, 'recording a pre-flight', () => recordManager($, (e as { name?: string }).name ?? e.description, e.prompt))
      }
      if (FLOW_TYPES.has(e.subagentType)) {
        await best($, 'logging a spawn', async () => {
          await appendLog($, { event: 'spawn', agent: (e as { name?: string }).name ?? e.description, owner: await ownerNameOf($, e.parentAgentId) })
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
    const setMode = parseMode(settings.mergeMode)
    const asked = input.mode === 'confirm' || input.mode === 'auto' ? input.mode : undefined
    if (autoRefused(asked, setMode)) {
      return { result: 'Refused: the merge_mode setting is confirm, so a manager cannot mark a PR auto. Only the user lowers it, by adding the flow:auto label to the PR by hand.' }
    }
    const view = await $.process.run(['gh', 'pr', 'view', String(pr), '--json', 'state,isDraft,headRefOid,headRefName,title,body,labels'])
    if (view.exitCode !== 0) return { result: `Refused: gh pr view ${pr} failed: ${view.stderr.trim().slice(0, 300)}` }
    const info = JSON.parse(view.stdout) as { state: string; isDraft: boolean; headRefOid: string; headRefName: string; title: string; body?: string; labels?: { name: string }[] }
    if (info.state !== 'OPEN') return { result: `Refused: PR #${pr} is ${info.state}.` }
    if (info.isDraft) return { result: `Refused: PR #${pr} is a draft. Mark it ready (gh pr ready ${pr}) first.` }
    const checked = checkEvidence(info.body ?? '', [...settings.workerChecks, ...settings.alwaysTests])
    if ('problems' in checked) return { result: evidenceRefusal(pr, checked.problems) }
    const t = await $.clock.now()
    const h: Handover = {
      pr, title: info.title, head: info.headRefOid, branch: info.headRefName,
      reportTo: String(input.report_to ?? 'main'), verified: String(input.verified ?? ''),
      pending: String(input.pending ?? 'none'), afterDeploy: String(input.after_deploy ?? 'none'),
      evidence: checked.evidence, status: 'pending', at: t, ...(asked !== undefined ? { mode: asked } : {}),
    }
    // A labelling failure is reported, not fatal: the stored mode still gates the queue.
    let labelNote = ''
    const labels = (info.labels ?? []).map(l => l.name)
    if (asked !== undefined) {
      const spec = labelSpec(asked)
      const made = await $.process.run(['gh', 'label', 'create', spec.name, '--force', '--color', spec.color, '--description', spec.description])
      const added = made.exitCode === 0 ? await $.process.run(['gh', 'pr', 'edit', String(pr), '--add-label', spec.name]) : made
      if (added.exitCode === 0) labels.push(spec.name)
      else labelNote = ` Could not add the ${spec.name} label (${added.stderr.trim().slice(0, 200)}); the mode is stored anyway.`
    }
    const hold = effectiveMode(labels, h.mode, setMode) === 'confirm'
    if (hold) h.status = 'awaiting'
    await update($, handovers, hs => ({ ...hs, [String(pr)]: h }))
    await best($, 'saving a handover', async () => {
      await saveHandover($, h)
      await appendLog($, { event: 'handover', owner: h.reportTo, pr, branch: h.branch, text: h.title })
    })
    if (hold) {
      void $.ui.toast(`PR #${pr} awaits your approval: /flow approve ${pr}`)
      await refresh($)
      return { result: `Handed over PR #${pr} at ${info.headRefOid.slice(0, 8)}, but it awaits the user's approval: the queue will not merge it until the user runs /flow approve ${pr}. Tell the user so in your report.${labelNote}` }
    }
    const queue = await ensureQueue($)
    await refresh($)
    return { result: `Handed over PR #${pr} at ${info.headRefOid.slice(0, 8)}. ${queue} The queue reports back to ${h.reportTo} by message.${labelNote}` }
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
          `#${h.pr} ${h.status}: "${h.title}" branch ${h.branch} head ${h.head} | report_to: ${h.reportTo} | verified: ${h.verified} | evidence: ${evidenceText(h.evidence)} | pending decisions: ${h.pending} | after deploy: ${h.afterDeploy}`,
        ).join('\n'),
      }
    }
    const key = String(Number(input.pr))
    const h = all[key]
    if (h === undefined) return { result: `No handover for PR #${key}.` }
    if (action === 'take') {
      // Re-check the labels: flow:confirm may have been added after the handover. If gh fails,
      // the stored mode and the setting still decide; never fail open.
      const view = await $.process.run(['gh', 'pr', 'view', key, '--json', 'labels,headRefOid'])
      let labels: string[] = []
      if (view.exitCode === 0) {
        try { labels = ((JSON.parse(view.stdout) as { labels?: { name: string }[] }).labels ?? []).map(l => l.name) } catch { labels = [] }
      }
      if (takeDecision({ labels, stored: h.mode, setting: parseMode(settings.mergeMode), head: h.head, approvedHead: h.approvedHead }) === 'hold') {
        const held: Handover = { ...h, status: 'awaiting' }
        await update($, handovers, hs => ({ ...hs, [key]: held }))
        await best($, 'saving a handover', async () => {
          await saveHandover($, held)
          await appendLog($, { event: 'hold', owner: held.reportTo, pr: held.pr, branch: held.branch, text: 'awaits /flow approve' })
        })
        void $.ui.toast(`PR #${key} awaits your approval: /flow approve ${key}`)
        await refresh($)
        return { result: `Held: PR #${key} awaits the user's approval (/flow approve ${key}). Do not merge it and do not send it back; go on to the next PR.` }
      }
    }
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
    if (action === 'done') autoSweep($)
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

  on('tool.call', { tool: 'mcp__flow__ask' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    if (e.agentId === undefined) return { result: 'Refused: main cannot ask; decide, or ask the user in the chat.' }
    const parsed = parseAsk(input)
    if ('error' in parsed) return { result: `Refused, nothing recorded: ${parsed.error}` }
    const rows = await refresh($)
    const me = rows.find(a => a.id === e.agentId)
    const name = me?.name ?? (String(input.from ?? '').trim() || 'unknown')
    const parent = me?.parentId === undefined ? undefined : rows.find(a => a.id === me.parentId)
    const addressee = parent !== undefined && parent.type === MANAGER && parent.name !== undefined ? parent.name : 'main'
    const at = await $.clock.now()
    // Standing answers hook: rules are read fresh. A fresh question that one matches is stored, then marked
    // answered in the same write (so it has an id and history); the result line tells the asker.
    const { rules } = await loadRules($, options)
    const { added, auto } = await withInbox($, cur => {
      const r = addQuestions(cur, { name, id: e.agentId, isManager: me?.type === MANAGER }, addressee, parsed.questions, at)
      let next = r.added.some(a => a.fresh) ? r.inbox : cur
      const hits = new Map<string, { answer: string; rid: string }>()
      for (const { q, fresh } of r.added) {
        const m = fresh ? matchRule(rules, q) : undefined
        if (m === undefined) continue
        const marked = markAnswered(next, q.id, m.answer, AUTO, at, m.rule.rid)
        if (marked.kind !== 'ok') continue
        next = marked.inbox
        hits.set(q.id, { answer: marked.answer, rid: m.rule.rid })
      }
      const done = r.added.map(a => ({ ...a, q: next.items.find(x => x.id === a.q.id) ?? a.q }))
      return { inbox: next, out: { added: done, auto: hits } }
    })
    const date = await today($)
    for (const { q, fresh } of added) {
      const hit = auto.get(q.id)
      if (hit !== undefined) {
        await appendNote($, notesOwner(q), `- ${date} decision: "${q.id} ${q.question}: ${hit.answer}" (standing answer ${hit.rid})`)
        await best($, 'logging an auto-answer', () => appendLog($, { event: 'auto-answer', owner: noteKey(notesOwner(q)), agent: name, text: `${q.id} rule ${hit.rid}: ${hit.answer}` }))
        continue
      }
      const owner = notesOwner(q)
      if (fresh && !q.blocking && owner !== 'main') {
        await appendNote($, owner, `- ${date} progress: assumed ${q.default} for ${q.id}: ${q.question}`)
      }
    }
    const fresh = added.filter(a => a.fresh && !auto.has(a.q.id)).map(a => a.q)
    if (addressee !== 'main' && fresh.length > 0 && parent !== undefined) {
      const lines = fresh.map(q =>
        `${name} asks ${q.id} (${q.blocking ? 'blocking' : 'non-blocking'}): ${q.question} - options ` +
        `${q.options.map((o, i) => `${String.fromCharCode(97 + i)}) ${o}`).join(' ')} (default: ${q.default})`)
      await $.session.send({ to: { agentId: parent.id }, text: `${lines.join('\n')}\nAnswer with mcp__flow__answer.` }).catch(() => undefined)
    } else if (addressee === 'main' && fresh.some(q => q.blocking)) {
      void $.ui.toast(`${name} asks: ${fresh.length} question(s) in /flow inbox`)
    }
    return {
      result: added.map(({ q, fresh: isNew }) => {
        if (!isNew) return `${q.id}: already asked as ${q.id}.`
        const hit = auto.get(q.id)
        if (hit !== undefined) return `${q.id}: answered by standing answer ${hit.rid}: ${hit.answer}. Carry on from it.`
        return q.blocking
          ? `${q.id}: end your turn now; the answer arrives by message.`
          : `${q.id}: proceed on the default (${q.default}), say in your report/PR that you assumed it; you'll get a message if the answer differs.`
      }).join('\n'),
    }
  })

  on('tool.call', { tool: 'mcp__flow__preflight' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    if (e.agentId === undefined) return { result: 'Refused: main does not file a pre-flight; it answers the managers\' questions in the round it receives.' }
    const rows = await refresh($)
    const me = rows.find(a => a.id === e.agentId)
    if (me?.type !== MANAGER) return { result: 'Refused: only managers file a pre-flight. A worker asks its manager with mcp__flow__ask.' }
    const parsed = parseFiling(input)
    if ('error' in parsed) return { result: `Refused, nothing recorded: ${parsed.error} To file: ${FILE_HELP}.` }
    const name = me.name ?? (String(input.from ?? '').trim() || 'unknown')
    const at = await $.clock.now()
    const added = parsed.questions.length === 0 ? [] : await withInbox($, cur => {
      const r = addQuestions(cur, { name, id: e.agentId, isManager: true }, 'main', parsed.questions, at)
      return { inbox: r.added.some(a => a.fresh) ? r.inbox : cur, out: r.added }
    })
    const ids = { asked: added.map(a => a.q.id), blocking: added.filter(a => a.q.blocking).map(a => a.q.id) }
    const late = await withPreflight($, cur => {
      const f = followUp(recordFiling(cur, name, parsed.filing, ids, at), name)
      return { state: f.state, out: f.send ? f.state : undefined }
    })
    if (late !== undefined) {
      const text = renderFollowUp(late, await read($, inbox), name, at)
      $.clock.after(0, () => void $.prompt.submit({ text }).catch(() => undefined))
    }
    await preflightTick($, rows)
    return {
      result: ids.blocking.length === 0
        ? `Pre-flight filed. Start your workers now.${ids.asked.length > 0 ? ` Your non-blocking question(s) ${ids.asked.join(', ')} are with main: go on the defaults, say so in your PRs; you get a message if an answer differs.` : ''}`
        : `Pre-flight filed with blocking question(s) ${ids.blocking.join(', ')}. End your turn now: main answers once for all managers and the answers arrive by message. Then start workers.`,
    }
  })

  on('tool.call', { tool: 'mcp__flow__answer' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const by = e.agentId === undefined ? 'main' : await ownerNameOf($, e.agentId)
    const todo = new Map<string, string | null>()
    const lines: string[] = []
    const always = new Set<string>()
    const answers = Array.isArray(input.answers) ? input.answers as Array<{ id?: unknown; choice?: unknown; always?: unknown }> : []
    for (const a of answers) {
      const id = String(a?.id ?? '').trim()
      if (id === '' || typeof a?.choice !== 'string') {
        lines.push(`${id || '(no id)'}: refused, each answer needs an id and a choice.`)
      } else if (!todo.has(id)) {
        todo.set(id, a.choice)
        if (a.always === true) always.add(id)
      }
    }
    if (input.defaults === true) {
      const ids = Array.isArray(input.ids) ? input.ids.map(String) : undefined
      const open = openFor(await read($, inbox), by).map(q => q.id)
      for (const id of ids ?? open) if (!todo.has(id)) todo.set(id, null)
      if (ids === undefined && open.length === 0 && todo.size === 0) lines.push('No open questions for you.')
    }
    if (todo.size === 0 && lines.length === 0) lines.push('Nothing to answer: pass answers, or defaults: true.')
    for (const [id, choice] of todo) {
      const before = always.has(id) ? (await read($, inbox)).items.find(x => x.id === id) : undefined
      lines.push(await answerQuestion($, id, choice, by))
      if (always.has(id) && choice !== null) lines.push(await alwaysRule($, options, id, choice, e.agentId === undefined, before))
    }
    return { result: lines.join('\n') }
  })

  on('tool.call', { tool: 'mcp__flow__standing' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    if (e.agentId !== undefined) return { result: 'Refused: only main makes or removes standing answers. Ask main in the chat, or answer with the question\'s default.' }
    const action = String(input.action ?? 'list')
    if (action === 'list') {
      const { rules } = await loadRules($, options)
      const box = await read($, inbox)
      return { result: renderRules(rules, box, suggest(box, rules)) }
    }
    if (action === 'add') {
      const v = validateRule({
        topic: input.topic, match: input.match, answer: input.answer, blocking: input.blocking, from: input.from,
        note: `added ${await today($)} by hand`,
      })
      if ('error' in v) return { result: `Refused: ${v.error}.` }
      const r = await addRule($, options, v.rule)
      if (r.kind === 'error') return { result: `Not added: ${r.msg}` }
      if (r.kind === 'exists') return { result: `Rule ${r.id} already says that; nothing added.` }
      return { result: `Rule ${r.id} added to the personal file. Revoke with mcp__flow__standing {"action":"remove","id":"${r.id}"}.` }
    }
    if (action === 'remove') {
      const id = String(input.id ?? '').trim()
      if (id === '') return { result: 'Refused: remove needs the rule id (see action "list").' }
      return { result: await dropRule($, options, id) }
    }
    return { result: 'Unknown action: use list, add or remove.' }
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

  on('tool.call', { tool: 'mcp__flow__clean' }, async ($, e) => {
    const apply = (e as unknown as Record<string, unknown>).apply === true
    if (apply && settings.cleanup === 'off') {
      return { result: `Cleanup is off (the cleanup setting): a dry run instead, nothing removed. A person removes with /flow clean --yes.\n${await sweep($, settings.base, false)}` }
    }
    return { result: await sweep($, settings.base, apply) }
  })

  on('tool.call', { tool: 'mcp__flow__session' }, async ($, e) => {
    const id = e.agentId
    const caller: Caller = id === undefined ? { id: 'main', name: 'main' } : { id, name: await ownerNameOf($, id) }
    return { result: await sessionTool($, e as unknown as Record<string, unknown>, caller, settings) }
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
    const leftover = leftoverLine(await read($, leftovers))
    const lines: string[] = []
    const byParent = new Map<string | undefined, AgentRow[]>()
    for (const a of rows) byParent.set(a.parentId, [...(byParent.get(a.parentId) ?? []), a])
    const ids = new Set(rows.map(a => a.id))
    const pre = await read($, preflight)
    const inb = await read($, inbox)
    const walk = (a: AgentRow, depth: number) => {
      const phase = a.type === MANAGER && a.name !== undefined ? phaseOf(pre, inb, a.name) : undefined
      const answer = (acts[a.id]?.answer ?? '').trim().split('\n').pop() ?? ''
      const h = handoffOf(a, acts[a.id])
      const hand = h === undefined ? '' : h.kind === 'done' ? ` | ${handoffText(h)}` : ` | handoff: wrapping up${h.percent === undefined ? '' : ` (${h.percent}%)`}`
      lines.push(`${'  '.repeat(depth)}- ${ROLE[a.type] ?? a.type} ${labelOf(a)}: ${a.status}${hand}${phase ? ` | pre-flight: ${phase}` : ''}${answer ? ` | last: ${answer.slice(0, 160)}` : ''}`)
      for (const c of byParent.get(a.id) ?? []) walk(c, depth + 1)
    }
    for (const a of rows.filter(r => r.parentId === undefined || !ids.has(r.parentId))) walk(a, 0)
    const list = Object.values(hs).sort((a, b) => a.at - b.at)
    const plans = Object.entries(await read($, plan)).filter(([, g]) => Object.keys(g).length > 0)
    const slots = slotLine(await read($, testSlots), settings.testSlots, await $.clock.now())
    return {
      result: [
        ...inboxHead(await read($, inbox), await $.clock.now()),
        limitsLine(rows, settings.maxWorkers),
        ...(slots ? [slots] : []),
        rows.length ? 'Agents:' : 'No agents in this session.', ...lines,
        list.length ? 'Handed-over PRs:' : 'No PRs handed over.', ...list.map(handoverLine),
        ...(unhanded.length ? [
          'Needs attention:', ...unhanded.map(u => `  ${unhandedLine(u)}`),
          'A manager reviews it and hands it over, or closes it.',
        ] : []),
        ...(list.some(h => h.status === 'awaiting') ? [
          'Needs the user:', ...list.filter(h => h.status === 'awaiting').map(h => `  #${h.pr} awaits approval: /flow approve ${h.pr} — ${h.title}`),
        ] : []),
        ...(queueOn && cache.error !== undefined ? [`Open PRs not checked: gh pr list failed: ${cache.error}`] : []),
        ...(leftover ? [leftover] : []),
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
        const spawned = (await read($, activity))[id]?.spawnWindow
        const window = windowOf(model, mainModel, mainWindow, tokens, spawned)
        await update($, activity, acts => {
          const a = acts[id] ?? { startedAt: t, lastAt: t, log: [] }
          return { ...acts, [id]: { ...a, usage: { tokens, model, ...(spawned !== undefined && { window }) } } }
        })
        // Tell a worker or manager once when it reaches the threshold. Marked before it is sent, so a
        // send that fails (the agent already ended) is not retried every step. Below it again (the
        // agent compacted) the mark clears, so a later crossing tells it again.
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
    // A throw while building the tree would leave the pane blank with no hint why; draw one line instead.
    // The body below is wrapped as is (not re-indented) to keep the diff to this fix.
    try {
    return await (async () => {
    const { Box, Text, Button } = $.ui.resolve(e)
    let [list, acts, pick, t, hs, cur, fold, unhanded, leftCounts] = await Promise.all([
      read($, roster), read($, activity), read($, selected), read($, now), read($, handovers),
      read($, cursor), read($, folded), currentUnhanded($), read($, leftovers),
    ])
    const leftover = leftoverLine(leftCounts)
    const openQs = openAll(await read($, inbox)).sort((a, b) => Number(b.blocking) - Number(a.blocking))
    const askers = askingNames(await read($, inbox))
    const inboxRows = openQs.length === 0 ? 0 : 1 + Math.min(openQs.length, 5) + (openQs.length > 5 ? 1 : 0)
    const shown = await read($, hinted)
    const override = await read($, overrideView)
    const [mode, gfocus, plans] = await Promise.all([read($, viewMode), read($, graphFocus), read($, plan)])
    const [sessionMap, hLimits, arm] = await Promise.all([read($, sessions), read($, harnessLimits), read($, armed)])

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
      const window = u.window ?? windowOf(u.model, mainModel, mainWindow, u.tokens)
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

    // Quota left per window, for Claude (this session's account) and the harnesses flow can read:
    // the share left as a bar that turns at 40% and 20%, the reset, and when the pace runs it out.
    const limits = [...claudeLimits(usage?.rateLimits ?? []), ...hLimits]
    const limitLine = (l: Limit) => {
      const left = Math.max(0, Math.min(100, Math.round(100 - l.used)))
      const tone = left <= 20 ? 'error' : left <= 40 ? 'warning' : 'success'
      const filled = left > 0 ? Math.max(1, Math.round(left / 100 * METER_CELLS)) : 0
      const out = runsOutIn(l, t)
      return (
        <Text key={`lim-${l.tool}-${l.label}`} wrap="truncate-end">
          <Text dimColor>{`${l.tool} ${l.label}`.padEnd(12)}</Text>
          <Text color={tone}>{'█'.repeat(filled)}</Text><Text color="inactive">{'░'.repeat(METER_CELLS - filled)}</Text>
          <Text color={tone}> {left}% left</Text>
          {l.resetsAt !== undefined && l.resetsAt > t && <Text dimColor> · resets in {elapsed(l.resetsAt - t)}</Text>}
          {out !== undefined && <Text color={out < 3600_000 ? 'error' : 'warning'}> · empty in {elapsed(out)} at this pace</Text>}
        </Text>
      )
    }

    // A control on a session worker, run here without a model turn. Restart and stop take a second
    // press within ARM_MS, so a stray key never kills a worker.
    const control = (name: string, input: Record<string, unknown>, confirm?: string) => async () => {
      await acted()
      if (confirm !== undefined) {
        const key = `${name}:${String(input.action)}`
        const now2 = await $.clock.now()
        const was = await read($, armed)
        if (was?.key !== key || now2 - was.at > ARM_MS) {
          await update($, armed, () => ({ key, at: now2 }))
          return
        }
        await update($, armed, () => null)
      }
      const result = await sessionTool($, { name, ...input }, { id: 'main', name: 'main' }, settings)
      void $.ui.toast(result.length > 200 ? `${result.slice(0, 199)}…` : result)
    }

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
    // Flips a card from what is drawn now; the choice is read fresh so rapid presses each count once.
    const toggleFold = async (a: AgentRow, shown: boolean) => {
      await acted()
      await update($, folded, f => ({ ...f, [a.id]: !(f[a.id] ?? foldDefault(a) ?? shown) }))
    }
    const asksOf = (x: AgentRow) => asksQuestion(acts[x.id]?.answer, settings.decisionPhrases) && !['running', 'pending'].includes(x.status)
    // `collapsed` undefined draws no chevron (the detail view's cards).
    const card = (a: AgentRow, depth: number, full: boolean, bordered: boolean, hot = false, collapsed?: boolean) => {
      const act = acts[a.id]
      const hand = handoffOf(a, act)
      const dim = ENDED.has(a.status) && hand?.kind !== 'done'
      const asks = (asksQuestion(act?.answer, settings.decisionPhrases) || askers.includes(a.name ?? '')) && !['running', 'pending'].includes(a.status)
      const doing = asks ? 'asks: ' + (act?.answer ?? '').trim().split('\n').pop() : act?.doing
      const u = usageOf(a)
      const under = list.filter(c => c.parentId === a.id).length
      // What a collapsed card hides that needs a person.
      const hidden = (id: string): AgentRow[] => list.filter(c => c.parentId === id).flatMap(c => [c, ...hidden(c.id)])
      const below = collapsed ? hidden(a.id) : []
      const nAsk = below.filter(asksOf).length
      const nHand = below.filter(c => handoffOf(c, acts[c.id])?.kind === 'wrapping').length
      const head = <Text>
        <Text color={COLOR[a.status]}>{GLYPH[a.status] ?? '?'}</Text> <Text bold inverse={hot}>{labelOf(a)}</Text>
        {under > 0 && <Text dimColor> (+{under})</Text>}
        <Text dimColor>  {ROLE[a.type] ?? a.type}</Text>
        {hand?.kind === 'wrapping' && <Text bold color="warning">  handoff</Text>}
        {collapsed && asks && <Text color="warning"> asks</Text>}
        {nAsk > 0 && <Text color="warning"> · {nAsk} asks</Text>}
        {nHand > 0 && <Text color="warning"> · {nHand} handoff</Text>}
      </Text>
      // The description shows only while there is nothing done to show; the detail view has it.
      const second = hand !== undefined && !asks
        ? <Text color={hand.kind === 'wrapping' ? 'warning' : undefined}>{handoffText(hand)}</Text>
        : doing !== undefined && doing !== ''
        ? <Text color={asks ? 'warning' : undefined} dimColor={!asks}>{doing.slice(0, 60)}</Text>
        : <Text dimColor>{a.description.slice(0, 60)}</Text>
      return (
        <Box key={`row-${a.id}`} paddingLeft={bordered ? depth * 2 : depth * 2 + 1}>
          {collapsed !== undefined && (
            <Button key={`fold-${a.id}`} plain dimColor={dim} onPress={() => toggleFold(a, collapsed)}>{collapsed ? '▸ ' : '▾ '}</Button>
          )}
          {full && !collapsed ? (
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

    const toggle = <Button key="toggle-view" plain dimColor hotkey="g" onPress={async () => {
      await acted()
      await update($, viewMode, m => (m === 'graph' ? 'tree' : 'graph'))
    }}>g {mode === 'graph' ? 'tree' : 'graph'}</Button>

    // The graph of one level: the plan's nodes (waiting ones have no agent yet) and the agents the
    // plan does not know. `spare` is the rows the rest of the pane takes.
    const graphView = (owner: string, level: AgentRow[], spare: number) => {
      const children = Object.fromEntries(level.map(a => [a.id, list.filter(c => c.parentId === a.id).length]))
      const raw = graphNodes(plans[owner], level, { children })
      // The glyph is part of the label so the layout counts its columns.
      const nodes: GNode[] = raw.map(n => ({ ...n, label: `${nodeGlyph(n)} ${n.label}` }))
      const layout = layoutGraph(nodes, Math.max(10, (e.viewport?.columns ?? 80) - 2))
      const hot = gfocus !== null && layout.order.includes(gfocus) ? gfocus : layout.order[0]
      const byId = Object.fromEntries(nodes.map(n => [n.id, n]))
      const press = (key: 'h' | 'j' | 'k' | 'l') => async () => {
        await acted()
        const c = await read($, graphFocus)
        const next = moveFocus(layout, nodes, c !== null && layout.order.includes(c) ? c : hot, key)
        if (next !== undefined) await update($, graphFocus, () => next)
      }
      const openNode = async (id: string | undefined) => {
        const n = id === undefined ? undefined : byId[id]
        if (n === undefined) return
        await acted()
        if (n.agentId !== undefined) return open(n.agentId)
        const waiting = n.after.filter(d => byId[d] !== undefined && byId[d]!.state !== 'done').map(d => raw.find(r => r.id === d)?.label ?? d)
        void $.ui.toast(`${raw.find(r => r.id === id)?.label ?? id} is ${n.state}${waiting.length ? `, waiting on ${waiting.join(', ')}` : ''}`)
      }
      const hint = (
        <Box flexDirection="row" gap={1}>
          <Button key="g-h" plain dimColor hotkey="h" onPress={press('h')}>h</Button>
          <Button key="g-j" plain dimColor hotkey="j" onPress={press('j')}>j</Button>
          <Button key="g-k" plain dimColor hotkey="k" onPress={press('k')}>k</Button>
          <Button key="g-l" plain dimColor hotkey="l" onPress={press('l')}>l</Button>
          <Text dimColor>move ·</Text>
          <Button key="g-open" plain dimColor hotkey="o" onPress={() => openNode(hot)}>o open</Button>
          <Text dimColor>·</Text>
          {toggle}
        </Box>
      )
      if (nodes.length === 0) {
        return <Box flexDirection="column"><Text dimColor>No plan yet. Managers declare one with mcp__flow__plan.</Text>{hint}</Box>
      }
      const seg = (s: Seg, i: number) => {
        if (s.node === undefined) return <Text key={`s${i}`} dimColor={s.dim}>{s.text}</Text>
        const n = byId[s.node]!
        const dim = n.state === 'done' || n.state === 'completed' || (n.agentId === undefined && n.state === 'waiting')
        return (
          <Button key={`n-${s.node}`} plain dimColor={dim} onPress={() => openNode(s.node)}>
            <Text color={nodeColor(n)} inverse={s.node === hot} bold={s.node === hot}>{s.text}</Text>
          </Button>
        )
      }
      const line = (l: number) => <Box key={`l${l}`} flexDirection="row">{layout.lines[l]!.map(seg)}</Box>
      const hotLine = hot === undefined ? 0 : layout.at[hot] ?? 0
      const size = Math.max(0, rows - spare)
      if (size < 4) return <Box flexDirection="column">{line(hotLine)}{hint}</Box>
      const clipped = layout.lines.length > size
      const win = clipped ? viewOf(layout.lines.map((_, i) => i), hotLine, size - 2) : { top: 0, rows: layout.lines.map((_, i) => i) }
      const below = layout.lines.length - win.top - win.rows.length
      return (
        <Box flexDirection="column">
          {win.top > 0 && <Text dimColor>↑ {win.top} more</Text>}
          {win.rows.map(line)}
          {below > 0 && <Text dimColor>↓ {below} more</Text>}
          {hint}
        </Box>
      )
    }

    if (agent !== undefined && agent.type === MANAGER && mode === 'graph') {
      const parent = list.find(a => a.id === agent.parentId)
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Button key="back" hotkey="b" onPress={async () => { await acted(); await update($, selected, () => parent?.id ?? null) }}>Back</Button>
          </Box>
          <Text bold color={COLOR[agent.status]}>{GLYPH[agent.status] ?? '?'} {labelOf(agent)} <Text dimColor>{ROLE[agent.type]} · {agent.status}</Text></Text>
          {graphView(planOwner(plans, agent.name), list.filter(a => a.parentId === agent.id), 5)}
        </Box>
      )
    }

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
            {agent.type === MANAGER && toggle}
            <Button key="msg" hotkey="m" onPress={() => $.prompt.fill({
              text: agent.type === SESSION
                ? `Send to session "${labelOf(agent)}" with mcp__flow__session action "send": `
                : `Send a message to ${ROLE[agent.type] ?? 'agent'} "${labelOf(agent)}": `,
              mode: 'replace',
            })}>Message</Button>
          </Box>
          <Text bold color={COLOR[agent.status]}>
            {GLYPH[agent.status] ?? '?'} {labelOf(agent)} <Text dimColor>{ROLE[agent.type] ?? agent.type} · {agent.status}
            {act ? ` · ${runTime(act, ENDED.has(agent.status))} · last active ${ago(t - act.lastAt)} ago` : ''}{children.length ? ` · ${children.length} under it` : ''}</Text>
          </Text>
          <Text dimColor>{agent.description}</Text>
          {agent.type === SESSION && sessionMap[agent.name ?? ''] !== undefined && (() => {
            const ss = sessionMap[agent.name ?? '']!
            const name = ss.name
            const live = ss.status !== 'exited' && ss.status !== 'stopped'
            const armedFor = arm !== null && t - arm.at <= ARM_MS && arm.key.startsWith(`${name}:`) ? arm.key.slice(name.length + 1) : undefined
            const key = (k: string, label: string, keys: string) => (
              <Button key={`key-${k}`} plain hotkey={k} onPress={control(name, { action: 'keys', keys })}>{label}</Button>
            )
            const dg = ss.digest
            return (
              <Box flexDirection="column">
                <Text dimColor wrap="truncate-end">
                  {ss.host === 'tmux' ? `tmux attach -t ${ss.handle}` : `orca ${ss.handle}`} · {ss.worktree} · {ss.branch}
                </Text>
                {live && (
                  <Box flexDirection="row" gap={1}>
                    <Text dimColor>keys</Text>
                    {key('1', '1', '1')}{key('2', '2', '2')}{key('3', '3', '3')}{key('y', 'y', 'y')}{key('n', 'n', 'n')}
                    {key('e', 'e ⏎', 'enter')}{key('z', 'z esc', 'escape')}{key('i', 'i ^C', 'interrupt')}
                  </Box>
                )}
                <Box flexDirection="row" gap={1}>
                  <Text dimColor>do</Text>
                  <Button key="ctl-restart" plain hotkey="r" onPress={control(name, { action: 'restart' }, 'restart')}>
                    {armedFor === 'restart' ? 'r again to restart' : 'r restart'}
                  </Button>
                  {live && <Button key="ctl-stop" plain hotkey="x" onPress={control(name, { action: 'stop' }, 'stop')}>
                    {armedFor === 'stop' ? 'x again to stop' : 'x stop'}
                  </Button>}
                </Box>
                {armedFor !== undefined && <Text color="warning">Press {armedFor === 'restart' ? 'r' : 'x'} again within {ARM_MS / 1000}s to {armedFor} {name}.</Text>}
                {dg !== undefined && dg.actions.length > 0 && <Text wrap="truncate-end"><Text dimColor>did    </Text>{dg.actions.join(' → ')}</Text>}
                {dg?.at !== undefined && <Text dimColor>active {ago(t - dg.at)} ago{dg.turnDone !== undefined ? ' · turn ended' : ''}</Text>}
                {dg?.lastWords !== undefined && <Text wrap="truncate-end"><Text dimColor>said   </Text>{dg.lastWords.replace(/\s+/g, ' ').slice(-160)}</Text>}
                {ss.screenText !== undefined && ss.screenText.trim() !== '' && <Text bold>Screen</Text>}
                {ss.screenText !== undefined && ss.screenText.trim() !== '' && (
                  ss.screenText.trimEnd().split('\n').slice(-Math.max(3, Math.min(12, rows - 22))).map((l, i) => (
                    <Text key={`scr-${i}`} dimColor wrap="truncate-end">{l || ' '}</Text>
                  ))
                )}
              </Box>
            )
          })()}
          {act?.handoffNotifiedAt !== undefined && <Text color="warning">
            Handoff: told {ago(t - act.handoffNotifiedAt)} ago{act.handoffPercent === undefined ? '' : ` at ${act.handoffPercent}%`}, {act.remindersSent ?? 0} reminders
          </Text>}
          {shown && <Text dimColor>To see its chat: ← then pick {labelOf(agent)}</Text>}
          {children.length > 0 && <Text bold>Under it</Text>}
          {children.map(c => card(c, 0, fullChildren, true))}
          <Text bold>Activity</Text>
          {(act?.log ?? []).length === 0 && <Text dimColor>Nothing seen yet.</Text>}
          {(act?.log ?? []).slice(-room).map(line => <Text wrap="truncate-end">{line}</Text>)}
          {answer !== '' && <Text bold color={asksQuestion(answer, settings.decisionPhrases) || askers.includes(agent.name ?? '') ? 'warning' : undefined}>
            {asksQuestion(answer, settings.decisionPhrases) || askers.includes(agent.name ?? '') ? 'Asks' : 'Last report'}
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
    const queueOpen = fold[MERGE_QUEUE_KEY] === false
    const prRows = prs.length > 0 ? 1 + (queueOpen ? Math.min(prs.length, 5) : 0) : 0
    const usageRows = rows >= 20 ? Math.min(4, limits.length) : 0
    const avail = rows - 1 - prRows - usageRows - (list.length === 0 ? 1 : 0) - (list.length > 0 ? 1 : 0) - (unhanded.length > 0 ? 1 : 0) - (leftover ? 1 : 0) - inboxRows
    const wide = treeItems(list, fold, cur ?? first, false, acts)
    const fullTree = CARD_ROWS + wide.items.reduce((n, i) => n + (i.collapsed ? 1 : CARD_ROWS), 0) <= avail
    const { items, at } = fullTree ? wide : treeItems(list, fold, cur ?? first, true, acts)
    const rootFull = fullTree || avail >= CARD_ROWS + items.length
    const left = avail - (rootFull ? CARD_ROWS : 1)
    const cut = !fullTree && items.length > left
    const hotIdx = Math.max(0, items.findIndex(i => i.a.id === at))
    // Two rows of the window go to the "above" and "more" lines.
    const view = cut ? viewOf(items, hotIdx, Math.max(1, left - 2)) : { top: 0, rows: items }
    const below = items.length - view.top - view.rows.length
    const hotId = items[hotIdx]?.a.id
    const countOf = (s: Handover['status']) => prs.filter(p => p.status === s).length
    const returned = countOf('returned')
    const awaiting = countOf('awaiting')
    const queueSummary = (['pending', 'taken', 'done'] as const).map(s => `${countOf(s)} ${s}`).join(' · ')
    const toggleQueue = async () => {
      await acted()
      await update($, folded, f => ({ ...f, [MERGE_QUEUE_KEY]: f[MERGE_QUEUE_KEY] === false }))
    }

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
    if (mode === 'graph') {
      const ids = new Set(list.map(a => a.id))
      return (
        <Box flexDirection="column">
          <Text dimColor>{list.length} agents · {live} live · graph</Text>
          {graphView('main', list.filter(a => a.parentId === undefined || !ids.has(a.parentId)), 3)}
        </Box>
      )
    }
    const mainTime = usage?.startedAt === undefined ? '' : elapsed(t - usage.startedAt)
    const mainU = main?.tokens === undefined ? undefined
      : { percent: main.percent ?? Math.round(main.tokens / main.window * 100), tokens: main.tokens, window: main.window }

    return (
      <Box flexDirection="column">
        <Text dimColor>{list.length} agents · {live} live{prs.length ? ` · ${prs.length} PRs handed over` : ''} · press one to see it</Text>
        {openQs.slice(0, 5).map(q => (
          <Text color={q.blocking ? 'warning' : undefined} wrap="truncate-end">{q.id} {q.owner}: {q.question}</Text>
        ))}
        {openQs.length > 5 && <Text dimColor>and {openQs.length - 5} more</Text>}
        {openQs.length > 0 && <Text dimColor>/flow inbox to read, answer in the chat</Text>}
        {unhanded.length > 0 && (
          <Text color="warning" wrap="truncate-end">
            ⚠ {unhanded.length} PR{unhanded.length > 1 ? 's' : ''} nobody handed over: {unhanded.map(u => `#${u.pr}`).join(' ')}
          </Text>
        )}
        {leftover && <Text dimColor wrap="truncate-end">{leftover}</Text>}
        {rootFull ? (
          <Box flexDirection="column" borderStyle="round" paddingX={1}>
            <Text bold>{ROOT_GLYPH} main <Text dimColor> super manager</Text></Text>
            {meter(mainU, false, mainTime)}
            {limits.slice(0, usageRows).map(limitLine)}
          </Box>
        ) : (
          <Text bold>{ROOT_GLYPH} main <Text dimColor>· super manager</Text>
            {mainU !== undefined && <Text color={meterColor(mainU.percent, warnOf(mainU.window))}> {mainU.percent}%</Text>}
          </Text>
        )}
        {!rootFull && limits.slice(0, usageRows).map(limitLine)}
        {list.length === 0 && <Text dimColor>  Nothing running. Ask Claude to start managers or a worker, e.g. "start a manager for X".</Text>}
        {view.top > 0 && <Text dimColor>  ↑ {view.top} above</Text>}
        {view.rows.map(({ a, depth, kids, collapsed }) => card(
          a, depth + 1, fullTree, depth === 0, a.id === hotId, collapsed,
        ))}
        {below > 0 && <Text dimColor>  +{below} more</Text>}
        {list.length > 0 && (
          <Box flexDirection="row" gap={1}>
            <Button key="nav-next" plain dimColor hotkey="j" onPress={step(1)}>j next</Button>
            <Button key="nav-prev" plain dimColor hotkey="k" onPress={step(-1)}>k prev</Button>
            <Button key="nav-open" plain dimColor hotkey="o" onPress={async () => { const i = await hotItem(); if (i) await open(i.a.id) }}>o open</Button>
            <Button key="nav-fold" plain dimColor hotkey="c" onPress={async () => {
              const i = await hotItem()
              if (i) await toggleFold(i.a, i.collapsed)
            }}>{items[hotIdx]?.collapsed ? 'c expand' : 'c collapse'}</Button>
            {prs.length > 0 && <Button key="nav-queue" plain dimColor hotkey="q" onPress={toggleQueue}>q queue</Button>}
            {toggle}
          </Box>
        )}
        {prs.length > 0 && (
          <Box flexDirection="row">
            <Button key={`fold-${MERGE_QUEUE_KEY}`} plain dimColor onPress={toggleQueue}>{queueOpen ? '  ▾ ' : '  ▸ '}</Button>
            <Text bold>Merge queue</Text>
            {!queueOpen && <Text dimColor>  {queueSummary}</Text>}
            {!queueOpen && awaiting > 0 && <Text color="warning"> · {awaiting} awaiting approval</Text>}
            {!queueOpen && returned > 0 && <Text color="warning"> · {returned} returned</Text>}
          </Box>
        )}
        {queueOpen && prs.slice(0, 5).map(ho => (
          <Text key={`pr-${ho.pr}`} dimColor={ho.status === 'done'} color={ho.status === 'awaiting' ? 'warning' : undefined} wrap="truncate-end">
            {'    '}{HANDOVER_GLYPH[ho.status]} #{ho.pr} {ho.status === 'awaiting' ? `awaiting your approval: /flow approve ${ho.pr}` : ho.status}{ho.status === 'returned' ? `: ${ho.reason ?? ''}` : ''} <Text dimColor>{ho.title}</Text>
          </Text>
        ))}
      </Box>
    )
    })()
    } catch (err) {
      const { Text } = $.ui.resolve(e)
      return <Text>flow: pane failed to draw: {err instanceof Error ? err.message : String(err)}</Text>
    }
  })
}
