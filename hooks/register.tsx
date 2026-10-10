import { atom, read, update } from 'claude-code'
import type { AgentInfo, AgentSpawnInput, EngineInterface, Register } from 'claude-code'

import type { Activity, AgentRow, Ledger, Role, EnvChange, Handover, HandoffRecord, Leftovers, LogEvent, OpenPr, PrCache, Session, SlotEntry, TestSlots } from '../types'
import { absolutePath, parseAttachments, rewriteAttachments } from './attachments'
import { checkEvidence, evidenceRefusal, evidenceSummary, evidenceText, type Evidence } from './evidence'
import { noteWork, runLine, serialFastForward, type RunWork } from './mainff'
import { ancestorPids, ancestryQueries, containedCandidates, dirtyFiles, isLive, leftoverLine, parsePorcelain, selectCleanup, sweepText, waitingPaths } from './clean'
import type { CleanInputs, Kept, PrRow, Sweep } from './clean'
import { deliver as deliverTo, flushAgent as flushTo, holdForReviewer as holdTo, resetDelivery, ENDED, LIVE, type DeliverIo, type DeliverOptions } from './deliver'
import { addStep, addTurn, baseName, costBlock, entriesOfBranch, mergeLedgers, normalizeLedger, pruneLedger, prCost, reportSuffix, setIdentity } from './cost'
import { backNote, effectiveSize, floorFrom, generation, isSuccessorName, modelFor, parseSize } from './routing'
import type { Size, SizeModels } from './routing'
import { analyze, cleanDir, findRefs, render, UNSET_TEXT } from './migrations'
import type { PrInput } from './migrations'
import { addNodes, agentFor, asksQuestion, describe, noticeText, settle } from './dag'
import type { AgentFact, Facts, Graph, Notice, Plan } from './dag'
import {
  addQuestions, answerMessage, askingNames, EMPTY_INBOX, fyiAsked, inboxHead, isFyi, parseFyi, openAll, renderInbox, renderItem, expandOk, stillOpen, markAnswered, OVERTURN, needsMessage, normalizeInbox, notesOwner, openFor, parseAsk, parseChoice,
} from './inbox'
import {
  closeStale, denyText, dueRound, EMPTY_PREFLIGHT, followUp, FILE_HELP, gateOf, isSkip, markDelivered, normalizePreflight, parseFiling, phaseOf,
  recordFiling, recordSpawn, renderFollowUp, renderRound, renderStatus,
} from './preflight'
import type { Preflight } from './preflight'
import {
  addChecks, anyMatch, closeChecks, dueForPrompt, EMPTY_CHECKS, inboxChecksSection, markStarted, normalizeChecks, paneChecksLine, parseNeeds, renderChecks,
  resumeChecksLines, SKIP_NOTE, versionInSteps,
} from './checks'
import type { Check, Checks } from './checks'
import type { Inbox, Marked, Question } from './inbox'
import { AUTO, escalation, matchRule, nextRuleId, removeRule, renderRules, renderSeeds, ruleFromQuestion, sameRule, SEEDS, seedIds, seedsToOffer, suggest, validateRule } from './standing'
import type { Resolved, Rule } from './standing'
import { graphNodes, layoutGraph, moveFocus } from './graph'
import type { GNode, Seg } from './graph'
import {
  fill, MANAGER_PROMPT, NO_REVIEWER_RULE, REVIEWER_PROMPT, REVIEWER_RULE, SESSION_PROMPT, WORKER_PROMPT,
} from './prompts'
import type { Settings } from './prompts'
import { deployModeWarnings, deployTargetsOf, stateFileOf, targetsOf } from './prompts'
import { isFable, mergeLayers, renameOptions } from './settings'
import { bumpVersion, changelogSection, cutChangelog, highestBump, isBump, labelBump, localDate, readVersion, setVersion } from './release'
import type { Bump } from './release'
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
import { branchOwners, buildDigest, findWorktree, noteKey, ownerFor } from './state'
import { ADD_OPTION, addMapping, guardReport, guardTestsFor, parseGuardTests, pathsFromStatus, suggestionQuestion, suggestionsFor } from './guardtests'
import type { GuardMap } from './guardtests'
import { autoRefused, effectiveMode, labelSpec, parseMode, takeDecision } from './mergemode'
import {
  batchId, closePushItem, DROPPED_REASON, dropStep, EMPTY_PUSH, itemOf, newBatch, normalizePush, openPushItem, parsePushMode, parseVerdict,
  PUSH_KIND, recordable, refOf, releaseStep, renderBatch, reviewerNote, sendBackStep, SENT_BACK_REASON, settlePrs,
} from './pushgate'
import type { PushState, ReadyBatch } from './pushgate'
import {
  applyAnswer, applyViewOf, approvalContext, behindLines, closeEnvItems, declinedEntries, decideEnv, decideGate, EMPTY_DEPLOYS, ENV_KIND, envCommandFor, envListLine,
  envSummary, isApprove, normalizeDeploys, openApplyItem, openApprovalItem, reopenItem, openDeployIds, openEnvItems, parseEnvInput, pendingEnv, recordDeployed,
  release, renderList, retargetItem, unknownTarget, itemViewOf, withApproval, withEnvDone, withHold,
} from './deploy'
import type { Deploys, DeployMode, Draft, EnvInput, Hold, TargetInfo, TargetState } from './deploy'

// The orca-flow pattern inside one Claude Code session. The main session is the super manager
// (the `dispatch` skill); it starts `flow:manager` agents, which start
// `flow:worker` agents in worktrees of their own and hand approved PRs to the
// `flow:reviewer` agent through this plugin's tools. The pane in main shows the tree.

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
const REVIEWER = 'flow:reviewer'
// The reviewer's old agent type: a reviewer started by an older version still runs under it.
const QUEUE = 'flow:queue'
const isReviewer = (type: string): boolean => type === REVIEWER || type === QUEUE
const LIVE_STATUS = new Set(['running', 'pending'])
// Display order: what may need a person first, finished agents last.
const ORDER = ['waiting', 'idle', 'running', 'pending', 'failed', 'killed', 'completed']
const GLYPH: Record<string, string> = {
  pending: '○', running: '●', waiting: '◐', idle: '◌', completed: '✓', failed: '✗', killed: '■',
}
const COLOR: Record<string, string> = {
  running: 'suggestion', waiting: 'warning', idle: 'warning', completed: 'success', failed: 'error', killed: 'error',
}
const ROLE: Record<string, string> = { [MANAGER]: 'manager', [WORKER]: 'worker', [CONTINUE]: 'worker', [SESSION]: 'worker', [REVIEWER]: 'reviewer', [QUEUE]: 'reviewer' }
const ROOT_GLYPH = '◆'
// Plan states, drawn like the agent statuses they turn into; a waiting node has no agent yet.
const PLAN_GLYPH: Record<string, string> = { waiting: '○', ready: '◌', running: '●', done: '✓', blocked: '✗' }
const PLAN_COLOR: Record<string, string | undefined> = { waiting: undefined, ready: 'warning', running: 'suggestion', done: 'success', blocked: 'error' }
const HANDOVER_GLYPH: Record<Handover['status'], string> = {
  pending: '…', awaiting: '⏸', taken: '●', ready: '⇪', done: '✓', returned: '↩',
}

const roster = atom({ plugin: 'flow', key: 'roster' } as const, [] as AgentRow[])
const activity = atom({ plugin: 'flow', key: 'activity' } as const, {} as Record<string, Activity>)
const selected = atom({ plugin: 'flow', key: 'selected' } as const, null as string | null)
// The highlighted card of the tree (an agent id), and the collapse the person chose per card: true
// is one row with its children hidden, false is expanded even when the tree is crowded. Absent =
// the role's default (managers and the reviewer collapsed), else automatic. MERGE_QUEUE_KEY is the
// Reviewer section's entry.
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
// The last status and answer seen per agent name, so an agent the host drops from its list keeps its
// last known state instead of reading as never started.
const seenAgents = atom({ plugin: 'flow', key: 'seen-agents' } as const, {} as Record<string, AgentFact>)
const inbox = atom({ plugin: 'flow', key: 'inbox' } as const, EMPTY_INBOX as Inbox)
// Pre-flight records, mirrored from <state dir>/preflight.json.
const preflight = atom({ plugin: 'flow', key: 'preflight' } as const, EMPTY_PREFLIGHT as Preflight)
const checks = atom({ plugin: 'flow', key: 'checks' } as const, EMPTY_CHECKS as Checks)
// Tokens spent per agent and model, mirrored (throttled) to <state dir>/ledger.json. Never forgets an ended agent.
const ledger = atom({ plugin: 'flow', key: 'ledger' } as const, {} as Ledger)
const handoffs = atom({ plugin: 'flow', key: 'handoffs' } as const, {} as Record<string, HandoffRecord>)
const queueRuns = atom({ plugin: 'flow', key: 'queueRuns' } as const, 0)
// The open PRs gh listed last, so the 3 s refresh never calls gh itself.
const prCache = atom({ plugin: 'flow', key: 'prCache' } as const, { prs: [], fetchedAt: 0 } as PrCache)
// The last dry cleanup sweep, refreshed with the PR list so a render never runs git.
const sessions = atom({ plugin: 'flow', key: 'sessions' } as const, {} as Record<string, Session>)
// What the reviewer routing already sent main, so a retried or repeated report reaches it once:
// Scoped to the sending reviewer run (its agent id), so a later run's different outcome is never swallowed.
// `keys` maps "reviewer|manager|PR numbers" to the needs-a-person / pending-decisions lines forwarded for it,
// `lines` is, per reviewer id, every line forwarded (normalized). Persisted: plugins reload mid-session.
type Forwarded = { keys: Record<string, string[]>; lines: Record<string, string[]> }
const forwarded = atom({ plugin: 'flow', key: 'forwarded' } as const, { keys: {}, lines: {} } as Forwarded)
const harnessLimits = atom({ plugin: 'flow', key: 'harnessLimits' } as const, [] as Limit[])
const armed = atom({ plugin: 'flow', key: 'armed' } as const, null as { key: string; at: number } | null)
const leftovers = atom({ plugin: 'flow', key: 'leftovers' } as const, { worktrees: 0, branches: 0, needsLook: 0 } as Leftovers)
// Deploy gates, mirrored from <state dir>/deploys.json.
const deploys = atom({ plugin: 'flow', key: 'deploys' } as const, EMPTY_DEPLOYS as Deploys)
// Commits each target is behind the base, from git off the 3 s refresh path (refreshBehind).
const behind = atom({ plugin: 'flow', key: 'behind' } as const, {} as Record<string, number>)
// The ready batch awaiting the user's push, mirrored from <state dir>/push.json.
const pushState = atom({ plugin: 'flow', key: 'push' } as const, EMPTY_PUSH as PushState)

const PR_POLL_MS = 5 * 60_000
const PR_MIN_GAP_MS = 60_000
// A worker that just ended: its manager is probably reviewing the PR.
const GRACE_MS = 20 * 60_000
// Set by register(); refresh() and the pane flag nothing when there is no reviewer.
let queueOn = true
// The cleanup setting and the base it sweeps against; set by register() like queueOn.
let cleanupMode: 'auto' | 'off' = 'auto'
let cleanupBase = 'main'
// The deploy targets and their modes; set by register() like queueOn.
let deployInfos: TargetInfo[] = []
const infosOf = (s: Parameters<typeof targetsOf>[0]): TargetInfo[] => targetsOf(s).map(t => ({ name: t.name, mode: t.mode, ...(t.envCommand !== undefined ? { envCommand: t.envCommand } : {}) }))

export type Unhanded = { pr: number; title: string; branch: string; note: string }

// Open flow/* PRs that nobody handed to the reviewer and nobody is working on any more.
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
      await deliver($, g.key, `flow: your test slot is granted (${g.label}). Call mcp__flow__test_slot acquire to confirm, run, then release.`, { onGone: () => undefined }).catch(() => undefined)
    }
  }
}

function slotLine(state: TestSlots, limit: number, t: number): string {
  if (state.holders.length === 0 && state.waiters.length === 0) return ''
  const held = state.holders.length ? `held by ${state.holders.map(h => heldBy(h, t)).join(', ')}` : 'free'
  return `Test slots: ${state.holders.length}/${limit} ${held}${state.waiters.length ? ` · ${state.waiters.length} waiting` : ''}`
}

export type TreeItem = { a: AgentRow; depth: number; kids: number; collapsed: boolean }

// Managers and the reviewer start collapsed; everything else has no default.
export const foldDefault = (a: AgentRow): boolean | undefined => (a.type === MANAGER || isReviewer(a.type) ? true : undefined)

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
function settingsOf(options: Record<string, unknown>, base: string): Settings & { contextWarn: number; contextWarn1m: number; contextWarnTokens: number; handoff: boolean; maxManagers: number; maxContinues: number; preflight: boolean; preflightWait: number; verifyPaths: string[]; cleanup: 'auto' | 'off'; harnesses: Record<string, HarnessSpec>; minQuota: number; guardTests: GuardMap } & Guards {
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
    verifyPaths: strs('verify_paths'),
    cleanup: str('cleanup', 'auto') === 'off' ? 'off' : 'auto',
    base: str('base_branch', base),
    testCommand: str('test_command', ''),
    fullCheck: str('full_check_command', ''),
    deployCommand: str('deploy_command', ''),
    deployTargets: deployTargetsOf(options.deploy_targets),
    stateFile: stateFileOf(options.state_file),
    mergeMethod: str('merge_method', 'squash'),
    mergeMode: str('merge_mode', 'auto'),
    pushMode: parsePushMode(options.push_mode),
    useReviewer: options.reviewer !== false,
    maxWorkers: num('max_workers', 3),
    maxManagers: Math.max(1, Math.round(num('max_managers', 20))),
    testSlots: Math.max(1, Math.floor(num('test_slots', 1))),
    workerModel: model('worker_model', DEFAULT_WORKER_MODEL),
    workerModelSmall: model('worker_model_small', 'haiku'),
    workerModelNormal: model('worker_model_normal', 'sonnet'),
    exploreModel: model('explore_model', 'haiku'),
    conflictModel: model('conflict_model', 'opus'),
    managerModel: model('manager_model', 'opus'),
    reviewerModel: model('reviewer_model', 'sonnet'),
    language: str('language', 'English'),
    bigFiles: strs('big_files'),
    bigFileLines: num('big_file_lines', 1500),
    migrationsDir: str('migrations_dir', ''),
    decisionPhrases: strs('decision_phrases'),
    workerChecks: strs('worker_checks'),
    alwaysTests: strs('always_tests'),
    flakyTests: strs('flaky_tests'),
    release: str('release', 'off') === 'on',
    releaseGithub: str('release_github', 'off') === 'on',
    releaseFiles: strs('release_files'),
    changelogFile: str('changelog_file', 'CHANGELOG.md'),
    guardTests: parseGuardTests(options.guard_tests) ?? {},
    workerHarness: str('worker_harness', 'agent'),
    sessionHost: ['orca', 'tmux'].includes(str('session_host', 'auto')) ? str('session_host', 'auto') : 'auto',
    harnesses,
    harnessNames: Object.keys(harnesses),
    minQuota: Math.min(100, Math.max(0, Math.round(num('min_quota', 10)))),
  }
}

// The last batch the release tool cut, so a retried push does not release twice.
let lastRelease: { key: string; version: string } | undefined

// Tag the release commit, push the tag and create the GitHub Release. Every step is idempotent and retried, and
// a failure is a returned line, never a throw: the release commit is already pushed and the batch stays done.
const PUBLISH_ATTEMPTS = 4
async function publishRelease($: EngineInterface, settings: Settings, dir: string, wanted: string | undefined): Promise<string> {
  if (!settings.release) return 'Refused: the release setting is off, so nothing is published.'
  if (!settings.releaseGithub) return 'Refused: the release_github setting is off, so nothing is published.'
  if (!dir.startsWith('/')) return 'Refused: dir must be the absolute path of your worktree.'
  let version = wanted
  if (version === undefined) {
    let last = lastRelease
    if (last === undefined) {
      const stateD = await stateDir($)
      const disk = stateD === undefined ? undefined : await readJson($, `${stateD}/release.json`) as { key?: string; version?: string } | undefined
      if (typeof disk?.version === 'string') last = { key: String(disk.key ?? ''), version: disk.version }
    }
    version = last?.version
  }
  if (version === undefined) return 'Refused: no version to publish; pass version or cut a release first.'
  const tag = `v${version}`
  const git = (...a: string[]) => $.process.run(['git', '-C', dir, ...a])
  const tail = (r: { stderr: string; stdout: string }) => (r.stderr.trim() || r.stdout.trim()).split('\n').slice(-3).join(' ').slice(0, 300)
  const run = async (step: string, argv: string[]): Promise<{ ok: true } | { ok: false; line: string }> => {
    let last = ''
    for (let i = 0; i < PUBLISH_ATTEMPTS; i++) {
      if (i > 0) await $.clock.sleep(2000 * 2 ** (i - 1))
      try {
        const r = await $.process.run(argv, { cwd: dir })
        if (r.exitCode === 0) return { ok: true }
        last = tail(r)
      } catch (err) { last = err instanceof Error ? err.message : String(err) }
    }
    return { ok: false, line: `Not published: ${step} failed: ${last}. The release commit is pushed; report this, the batch stays done.` }
  }
  try {
    // The release commit may sit below a merge commit (a rejected push is fetched, merged and pushed again).
    const log = await git('log', '--first-parent', '-n', '50', '--format=%H %s')
    if (log.exitCode !== 0) return `Not published: could not read the log of ${dir}: ${tail(log)}. The release commit is pushed; report this, the batch stays done.`
    const sha = log.stdout.split('\n').find(l => l.slice(41) === `Release ${version}`)?.slice(0, 40)
    if (sha === undefined) return `Refused: no commit "Release ${version}" in the last 50 first-parent commits of ${dir}. Publish only after the release commit is in HEAD.`
    const anc = await git('merge-base', '--is-ancestor', sha, 'HEAD')
    if (anc.exitCode !== 0) return `Refused: the commit "Release ${version}" is not an ancestor of HEAD in ${dir}.`
    const existing = await git('rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`)
    if (existing.exitCode === 0 && existing.stdout.trim() !== sha) return `Not published: tag ${tag} already exists at ${existing.stdout.trim().slice(0, 8)}, not at the release commit ${sha.slice(0, 8)}; it was not moved. The release commit is pushed; report this, the batch stays done.`
    if (existing.exitCode !== 0) {
      const t = await git('tag', '-a', tag, '-m', `Release ${version}`, sha)
      if (t.exitCode !== 0) return `Not published: tagging failed: ${tail(t)}. The release commit is pushed; report this, the batch stays done.`
    }
    const pushed = await run('pushing the tag', ['git', '-C', dir, 'push', 'origin', tag])
    if (!pushed.ok) return pushed.line
    const view = await $.process.run(['gh', 'release', 'view', tag], { cwd: dir })
    if (view.exitCode === 0) return `Published ${tag}: tag pushed, GitHub Release already existed.`
    const logName = settings.changelogFile || 'CHANGELOG.md'
    const section = await $.fs.exists(`${dir}/${logName}`) ? changelogSection(await $.fs.read(`${dir}/${logName}`), version) : undefined
    const stateD = await stateDir($)
    const notes = `${stateD ?? '/tmp'}/release-notes-${tag}.md`
    await $.fs.write(notes, section !== undefined && section !== '' ? section + '\n' : `Release ${version}\n`)
    const made = await run('gh release create', ['gh', 'release', 'create', tag, '--title', tag, '--notes-file', notes, '--verify-tag'])
    if (!made.ok) return made.line
    const url = await $.process.run(['gh', 'release', 'view', tag, '--json', 'url', '--jq', '.url'], { cwd: dir })
    return `Published ${tag}: tag pushed, GitHub Release created${url.exitCode === 0 && url.stdout.trim() !== '' ? ' ' + url.stdout.trim() : ''}.${section === undefined || section === '' ? ` The changelog has no ${version} section, so the notes are "Release ${version}".` : ''}`
  } catch (err) {
    return `Not published: ${err instanceof Error ? err.message : String(err)}. The release commit is pushed; report this, the batch stays done.`
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
  const agents: AgentFact[] = rows.map(a => ({
    name: a.name, status: a.status, answer: acts[a.id]?.answer,
    children: rows.filter(c => c.parentId === a.id && LIVE_STATUS.has(c.status)).length,
    at: acts[a.id]?.lastAt,
    childAt: Math.max(0, ...rows.filter(c => c.parentId === a.id).map(c => acts[c.id]?.lastAt ?? 0)),
  }))
  const known = { ...(await read($, seenAgents)) }
  const present = new Set(rows.map(a => a.name))
  for (const a of agents) if (a.name !== undefined) known[a.name] = a
  for (const [name, a] of Object.entries(known)) if (!present.has(name)) agents.push(a)
  if (JSON.stringify(known) !== JSON.stringify(await read($, seenAgents))) await update($, seenAgents, () => known)
  const owners = branchOwners(await readLog($))
  const facts: Facts = {
    agents, owners,
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
      if (agent) await deliver($, agent.id, text).catch(() => undefined)
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
    // The reviewer's worktree (detached at the base) goes once the reviewer is gone, also when
    // its ending was not seen as a transition (a reload left the roster record empty).
    if (ENDED.has(a.status) && isReviewer(a.type) && (prev === undefined || (prev !== a.status && !ENDED.has(prev)))) autoSweep($)
    if (prev === undefined || prev === a.status || ENDED.has(prev)) continue
    if (ENDED.has(a.status) && acts[a.id] !== undefined) ended.push(a.id)
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
    queued && `reviewer: ${queued} PR${queued > 1 ? 's' : ''}`,
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

// --- Cost ledger ---
// Loaded from disk once, before the first change, so what this run counts is added to the history.
let ledgerLoad: Promise<void> | undefined
let ledgerSaveDue = false

function loadLedger($: EngineInterface): Promise<void> {
  ledgerLoad ??= (async () => {
    try {
      const dir = await stateDir($)
      if (dir === undefined) return
      const disk = normalizeLedger(await readJson($, `${dir}/ledger.json`))
      const now = await $.clock.now()
      await update($, ledger, cur => pruneLedger(mergeLedgers(disk, cur), now))
    } catch {
      // No history: count from here.
    }
  })()
  return ledgerLoad
}

async function saveLedger($: EngineInterface): Promise<void> {
  try {
    const dir = await stateDir($)
    if (dir === undefined) return
    await $.process.run(['mkdir', '-p', dir])
    await writeJsonAtomic($, `${dir}/ledger.json`, pruneLedger(await read($, ledger), await $.clock.now()))
  } catch {
    // The meter is best-effort.
  }
}

// Every step changes the ledger; the file is written at most every few seconds.
async function changeLedger($: EngineInterface, fn: (l: Ledger, now: number) => Ledger): Promise<void> {
  await loadLedger($)
  const now = await $.clock.now()
  await update($, ledger, l => fn(l, now))
  if (ledgerSaveDue) return
  ledgerSaveDue = true
  $.clock.after(3000, () => { ledgerSaveDue = false; void saveLedger($) })
}

// Main's entry is per session: the ledger outlives the session, and its steps must not merge with an earlier one's.
async function mainKey($: EngineInterface): Promise<string> {
  const u = await $.session.usage().then(x => x, () => undefined)
  return `main@${u?.startedAt ?? 0}`
}

// The cost block of status, or nothing before the first counted step.
async function costLines($: EngineInterface, prs: { pr: number; branch: string }[], keep?: (e: Ledger[string]) => boolean): Promise<string[]> {
  try {
    await loadLedger($)
    const start = (await $.session.usage().then(x => x, () => undefined))?.startedAt ?? 0
    const live = new Set((await read($, roster)).map(a => a.id))
    const all = await read($, ledger)
    const led = keep === undefined ? all : Object.fromEntries(Object.entries(all).filter(([, e]) => keep(e)))
    return costBlock(led, prs, Object.keys(await read($, sessions)).length > 0, { start, live })
  } catch {
    return []
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

// Check changes run one after another, like the inbox's.
let checksChain: Promise<unknown> = Promise.resolve()

function withChecks<T>($: EngineInterface, fn: (cur: Checks) => { checks: Checks; out: T }): Promise<T> {
  const run = async (): Promise<T> => {
    const dir = await stateDir($)
    const cur = dir === undefined ? await read($, checks) : normalizeChecks(await readJson($, `${dir}/checks.json`))
    const { checks: next, out } = fn(cur)
    if (next !== cur) {
      if (dir !== undefined) {
        await $.process.run(['mkdir', '-p', dir])
        await writeJsonAtomic($, `${dir}/checks.json`, next)
      }
      await update($, checks, () => next)
    }
    return out
  }
  const result = checksChain.then(run, run)
  checksChain = result.catch(() => undefined)
  return result
}

// The version the running plugin was installed as: its plugin.json next to the module. Undefined when unreadable.
async function installedVersion($: EngineInterface): Promise<string | undefined> {
  try {
    const v = (JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }).version
    return typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v) ? v : undefined
  } catch {
    return undefined
  }
}

// The version a PR's merge needs installed: plugin.json at the merged sha, else one named in the steps.
async function versionAt($: EngineInterface, sha: string | undefined, steps: string): Promise<string | undefined> {
  if (sha) {
    try {
      const r = await $.process.run(['git', 'show', `${sha}:.claude-plugin/plugin.json`])
      const v = r.exitCode === 0 ? (JSON.parse(r.stdout) as { version?: unknown }).version : undefined
      if (typeof v === 'string' && v !== '') return v
    } catch { /* not a plugin repo, or the sha is unknown */ }
  }
  return versionInSteps(steps)
}

// Adds a check for each needs-a-person line in a done PR's report (the same PR and steps never twice). Live: the
// handover's verify_command rides along, unless verify_paths says no changed file warrants it. Returns the new ones.
async function captureChecks($: EngineInterface, h: Handover, verifyPaths: string[], live: boolean): Promise<Check[]> {
  const needs = parseNeeds(h.report)
  if (needs.length === 0) return []
  let command = live && h.verifyCommand ? h.verifyCommand : undefined
  let note: string | undefined
  if (command !== undefined && verifyPaths.length > 0) {
    // gh failing runs the command anyway: fail toward verifying.
    const r = await $.process.run(['gh', 'pr', 'view', String(h.pr), '--json', 'files'])
    let files: string[] | undefined
    try { files = r.exitCode === 0 ? (JSON.parse(r.stdout) as { files: { path: string }[] }).files.map(f => f.path) : undefined } catch { files = undefined }
    if (files !== undefined && !anyMatch(verifyPaths, files)) { command = undefined; note = SKIP_NOTE }
  }
  const t = live ? await $.clock.now() : h.at
  const items = await Promise.all(needs.map(async n => ({
    steps: n.steps, version: await versionAt($, h.sha, n.steps),
    ...(n.pr === h.pr && command !== undefined ? { verifyCommand: command } : {}), ...(n.pr === h.pr && note !== undefined ? { note } : {}),
  })))
  return withChecks($, cur => {
    const r = addChecks(cur, h.pr, h.title, h.sha, items, t)
    return { checks: r.checks, out: r.added }
  })
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
async function answerQuestion($: EngineInterface, id: string, choice: string | null, by: string, options: Record<string, unknown>): Promise<string> {
  const at = await $.clock.now()
  const marked = await withInbox($, (cur): { inbox: Inbox; out: Marked | { kind: 'escalated'; q: Question } } => {
    // A standing rule made this the user's decision: only main answers it.
    const held = cur.items.find(x => x.id === id)
    if (held !== undefined && held.state === 'open' && held.escalated !== undefined && by !== 'main') return { inbox: cur, out: { kind: 'escalated', q: held } }
    const m = markAnswered(cur, id, choice, by, at)
    return { inbox: m.kind === 'ok' ? m.inbox : cur, out: m }
  })
  if (marked.kind === 'escalated') return `${id}: refused, standing rule ${marked.q.escalated} makes this the user's decision. It is in main's inbox as ${id}; main answers it directly and the asker gets the answer. Don't answer or re-ask it.`
  if (marked.kind === 'unknown') return `${id}: no such question.`
  if (marked.kind === 'answered') return `${id}: already answered ("${marked.q.answer ?? ''}" by ${marked.q.answeredBy ?? '?'}).`
  if (marked.kind === 'refused') return `${id}: refused, it is addressed to ${marked.q.addressee}, not ${by}.`
  if (marked.kind === 'empty') return `${id}: refused, the choice is empty.`
  const { q, answer, isDefault } = marked
  const deployNote = q.kind === 'deploy' ? await onDeployAnswer($, q, answer) : q.kind === ENV_KIND ? await onEnvAnswer($, q, answer) : q.kind === PUSH_KIND ? await onPushAnswer($, q, answer, by) : ''
  let delivered = true
  let hint = ''
  if (needsMessage(q, isDefault)) {
    const asker = q.askerId === undefined ? undefined : (await $.agent.list()).find(a => a.id === q.askerId)
    delivered = false
    const alive = (a: AgentInfo | undefined): a is AgentInfo => a !== undefined && (LIVE.has(a.status) || a.status === 'idle')
    if (alive(asker)) {
      delivered = await deliver($, asker.id, answerMessage(q, answer, by, isDefault), { urgent: q.blocking === true, onGone: () => undefined }).catch(() => false)
    } else if (isFyi(q) && q.addressee !== 'main') {
      // A finished owner cannot act on an overturn: its manager (the notes owner) gets it, naming the owner.
      const mgr = (await $.agent.list()).find(a => a.type === MANAGER && a.name !== undefined && noteKey(a.name) === noteKey(q.addressee) && alive(a))
      if (mgr !== undefined) {
        delivered = await deliver($, mgr.id, `${answerMessage(q, answer, by, isDefault)} (This was ${q.owner}'s FYI; ${q.owner} is no longer running, so act on it yourself or with a new worker.)`, { urgent: q.blocking === true, onGone: () => undefined }).catch(() => false)
      }
    }
    if (!delivered) hint = `; ${q.owner} is gone: main should relay it to ${noteKey(q.owner)}-2`
  }
  await withInbox($, cur => ({
    inbox: { ...cur, items: cur.items.map(x => (x.id === id ? { ...x, delivered } : x)) }, out: undefined,
  }))
  if (!(isFyi(q) && isDefault)) await appendNote($, notesOwner(q), `- ${await today($)} decision: "${q.id} ${noteText(q)}: ${isFyi(q) ? `overturned, ${answer}` : answer}"`)
  const guard = q.guard !== undefined && answer === ADD_OPTION ? ` ${await addGuardTest($, options, q.guard.glob, q.guard.test)}` : ''
  return `${id}: ${answer}${isDefault ? ' (default)' : ''}, ${delivered ? 'delivered' : 'undelivered'}${hint}.${guard}${deployNote}`
}

// The question as a notes line: an env change names the variable, never its value.
const noteText = (q: Question): string => (q.env === undefined ? q.question : `env ${q.env.name} on ${q.env.target} (${q.env.role})`)

// Deploy gate changes run one after another, like the inbox's.
let deploysChain: Promise<unknown> = Promise.resolve()

// Read deploys.json, let fn change it, write it back atomically and set the atom. fn returns the new state
// (the same object when nothing changed) and whatever the caller wants back.
function withDeploys<T>($: EngineInterface, fn: (cur: Deploys) => { deploys: Deploys; out: T }): Promise<T> {
  const run = async (): Promise<T> => {
    const dir = await stateDir($)
    const cur = dir === undefined ? await read($, deploys) : normalizeDeploys(await readJson($, `${dir}/deploys.json`))
    const { deploys: next, out } = fn(cur)
    if (next !== cur) {
      if (dir !== undefined) {
        await $.process.run(['mkdir', '-p', dir])
        await writeJsonAtomic($, `${dir}/deploys.json`, next)
      }
      await update($, deploys, () => next)
    }
    return out
  }
  const result = deploysChain.then(run, run)
  deploysChain = result.catch(() => undefined)
  return result
}

const setTarget = (d: Deploys, name: string, ts: TargetState): Deploys => ({ targets: { ...d.targets, [name]: ts } })

// Commits behind the base for each target with a recorded deploy. One git call per target, never from a render.
let behindRun: Promise<void> | undefined
function refreshBehind($: EngineInterface): Promise<void> {
  behindRun ??= (async () => {
    const d = await read($, deploys)
    const out: Record<string, number> = {}
    for (const t of deployInfos) {
      const sha = d.targets[t.name]?.deployedSha
      if (sha === undefined) continue
      const r = await $.process.run(['git', 'rev-list', '--count', `${sha}..origin/${cleanupBase}`], { timeoutMs: 10_000 }).catch(() => undefined)
      const n = r !== undefined && r.exitCode === 0 ? Number(r.stdout.trim()) : NaN
      if (Number.isInteger(n)) out[t.name] = n
    }
    await update($, behind, () => out)
  })().catch(() => undefined).finally(() => { behindRun = undefined })
  return behindRun
}

// The commits an approval would ship: one line each, at most 15.
async function commitsSince($: EngineInterface, last: string | undefined, sha: string): Promise<string[]> {
  if (last === undefined) return []
  const r = await $.process.run(['git', 'log', '--oneline', '-15', `${last}..${sha}`], { timeoutMs: 10_000 }).catch(() => undefined)
  return r !== undefined && r.exitCode === 0 ? r.stdout.split('\n').map(l => l.trim()).filter(Boolean) : []
}

// The user's answer to a deploy approval item: record it on its target, and start a deploy-only run for "deploy".
async function onDeployAnswer($: EngineInterface, q: Question, answer: string): Promise<string> {
  const name = await withDeploys($, cur => {
    const hit = Object.entries(cur.targets).find(([, ts]) => ts.approval?.qid === q.id)
    if (hit === undefined) return { deploys: cur, out: undefined }
    return { deploys: setTarget(cur, hit[0], applyAnswer(hit[1], answer)), out: hit[0] }
  })
  if (name === undefined) return ''
  if (!isApprove(answer)) return ` ${name} stays behind; the next batch asks again.`
  return ` ${name} approved. ${await ensureQueue($)}`
}

// The user's answer to an env item. An applied `apply` item records the change as done by the user. A
// positive answer that leaves a target with nothing open, on an auto target, starts a deploy-only run (the
// gate then applies what is approved); a negative one holds the target until main releases it.
async function onEnvAnswer($: EngineInterface, q: Question, answer: string): Promise<string> {
  const e = q.env
  if (e === undefined) return ''
  const yes = e.role === 'change' ? answer.trim().toLowerCase() === 'yes' : answer.trim().toLowerCase() === 'done'
  const at = await $.clock.now()
  const info = deployInfos.find(t => t.name === e.target)
  const hs = Object.values(await read($, handovers))
  const waiting = pendingEnv(hs, e.target, (await read($, deploys)).targets[e.target]).length > 0
  if (e.role === 'apply' && yes) {
    await withDeploys($, cur => ({ deploys: setTarget(cur, e.target, withEnvDone(cur.targets[e.target], [{ pr: e.pr, name: e.name, how: 'user', at }])), out: undefined }))
  }
  if (!yes) {
    return e.role === 'change'
      ? ` ${e.target} is held by this: the gate skips it until main runs release on ${e.target}, which drops the declined change.`
      : ` Not yet: ${e.target} keeps waiting; the next gate opens a fresh item for it.`
  }
  const ib = await read($, inbox)
  const stillOpen = ib.items.some(x => x.state === 'open' && x.kind === ENV_KIND && x.env?.target === e.target)
  if (!waiting || stillOpen || info === undefined || info.mode !== 'auto') return ''
  await withDeploys($, cur => ({ deploys: setTarget(cur, e.target, { ...(cur.targets[e.target] ?? {}), due: true }), out: undefined }))
  return ` ${e.target} has its env answers. ${await ensureQueue($)}`
}

// A person's (or main's) hold on a target.
async function holdTarget($: EngineInterface, name: string, until: Hold['until'], by: string, reason: string | undefined): Promise<string> {
  const bad = unknownTarget(deployInfos, name)
  if (bad !== undefined) return bad
  const at = await $.clock.now()
  await withDeploys($, cur => {
    const hold: Hold = { until, by, at, ...(reason ? { reason } : {}) }
    return { deploys: setTarget(cur, name, withHold(cur.targets[name], hold)), out: undefined }
  })
  return until === 'batch'
    ? `${name} held for the next batch: the reviewer's next gate call for it answers Held and the hold ends. Release earlier with release.`
    : `${name} held until released: the reviewer skips it every batch. Release with release (/flow release ${name}).`
}

async function releaseTarget($: EngineInterface, name: string): Promise<string> {
  const info = deployInfos.find(t => t.name === name)
  const bad = unknownTarget(deployInfos, name)
  if (bad !== undefined || info === undefined) return bad ?? ''
  const hs = Object.values(await read($, handovers))
  const ib = await read($, inbox)
  const at = await $.clock.now()
  // Releasing also drops the env changes the user declined: they are recorded as dropped and stop holding the target.
  const r = await withDeploys($, cur => {
    const released = release(cur.targets[name], info.mode)
    const pending = pendingEnv(hs, name, released.state)
    const dropped = declinedEntries({ pending, item: itemViewOf(ib) })
    if (!released.had && dropped.length === 0) return { deploys: cur, out: { had: false, dropped } }
    const state = withEnvDone(released.state, dropped.map(d => ({ pr: d.pr, name: d.change.name, how: 'dropped' as const, at })))
    return { deploys: setTarget(cur, name, dropped.length > 0 && info.mode === 'auto' ? { ...state, due: true } : state), out: { had: released.had, dropped } }
  })
  if (!r.had && r.dropped.length === 0) return `${name} has no hold.`
  if (r.dropped.length > 0) {
    const qids = r.dropped.flatMap(d => [d.change.qid, ...(d.change.loginQid === undefined ? [] : [d.change.loginQid])])
    await withInbox($, cur => ({ inbox: closeEnvItems(cur, qids, 'dropped: released without it', at), out: undefined }))
  }
  const dropNote = r.dropped.length === 0 ? '' : ` Dropped the declined env changes: ${[...new Set(r.dropped.map(d => d.change.name))].join(', ')}.`
  if (info.mode === 'confirm') return `${name} released.${dropNote} It is a confirm target: the next gate still asks for approval.`
  return `${name} released.${dropNote} ${await ensureQueue($)}`
}

// ---- the push gate (pushgate.ts) ----

// Push state changes run one after another, like the inbox's.
let pushChain: Promise<unknown> = Promise.resolve()

// Read push.json, let fn change it, write it back atomically and set the atom. fn returns the new state (the same
// object when nothing changed) and whatever the caller wants back.
function withPush<T>($: EngineInterface, fn: (cur: PushState) => { push: PushState; out: T }): Promise<T> {
  const run = async (): Promise<T> => {
    const dir = await stateDir($)
    const cur = dir === undefined ? await read($, pushState) : normalizePush(await readJson($, `${dir}/push.json`))
    const { push: next, out } = fn(cur)
    if (next !== cur) {
      if (dir !== undefined) {
        await $.process.run(['mkdir', '-p', dir])
        await writeJsonAtomic($, `${dir}/push.json`, next)
      }
      await update($, pushState, () => next)
    }
    return out
  }
  const result = pushChain.then(run, run)
  pushChain = result.catch(() => undefined)
  return result
}

// The commit a local ref points at, or undefined.
async function refSha($: EngineInterface, ref: string): Promise<string | undefined> {
  const r = await $.process.run(['git', 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { timeoutMs: 10_000 }).catch(() => undefined)
  return r !== undefined && r.exitCode === 0 && r.stdout.trim() !== '' ? r.stdout.trim() : undefined
}

// The batch's ref is deleted once the batch is pushed, dropped or rebuilt. Best effort: a stray ref is harmless.
async function dropRef($: EngineInterface, ref: string): Promise<void> {
  await $.process.run(['git', 'update-ref', '-d', ref], { timeoutMs: 10_000 }).catch(() => undefined)
}

// A message for the manager that owns a PR: sent when it is alive, else noted for it and sent to main.
async function tellManager($: EngineInterface, name: string, text: string): Promise<void> {
  const live = (await $.agent.list()).find(a => a.name === name && (LIVE.has(a.status) || a.status === 'idle'))
  // Urgent: tellManager carries push-gate send-backs and report fallbacks, which the manager acts on now.
  // A failed send has already gone through onGone.
  if (live !== undefined) await deliver($, live.id, text, { urgent: true, onGone: t => tellMain($, name, t) }).catch(() => undefined)
  else await tellMain($, name, text)
}

async function tellMain($: EngineInterface, name: string, text: string): Promise<void> {
  await best($, 'noting a report', async () => void (await appendNote($, name, `- ${await today($)} ${text}`)))
  toMain($, `${text} (${name} is not running; relay it or start a manager.)`)
}

// The line a returned PR's message carries when its worker ran below large (routing.ts backNote).
async function sizeBackNote($: EngineInterface, branch: string): Promise<string | undefined> {
  try {
    await loadLedger($)
    return backNote(entriesOfBranch(await read($, ledger), branch), branch)
  } catch {
    return undefined
  }
}

// The user's push, send-back or drop returns a PR the way the reviewer's "back" does.
async function returnPr($: EngineInterface, h: Handover, reason: string): Promise<void> {
  const next: Handover = { ...h, status: 'returned', reason }
  await update($, handovers, hs => ({ ...hs, [String(h.pr)]: next }))
  await best($, 'saving a handover', async () => {
    await saveHandover($, next)
    await appendLog($, { event: 'back', owner: next.reportTo, pr: next.pr, branch: next.branch, text: reason })
  })
  await closeReturnedEnv($, next)
  const size = await sizeBackNote($, next.branch)
  await tellManager($, next.reportTo, `flow: PR #${next.pr} was returned: ${reason}. Decide what to do with it, and hand it over again when it is ready.${size === undefined ? '' : ` ${size}`}`)
}

const closeBatchItem = ($: EngineInterface, qid: string | undefined, answer: string, by: string, at: number) =>
  withInbox($, cur => ({ inbox: closePushItem(cur, qid, answer, by, at), out: undefined }))

// The reviewer records a checked batch (push_mode confirm): its head is under refs/flow/push/<id>, the PRs become
// "ready", the user is asked.
async function recordReady($: EngineInterface, settings: Settings, input: Record<string, unknown>): Promise<string> {
  if (parsePushMode(settings.pushMode) !== 'confirm') return 'Refused: push_mode is auto, so there is no push gate. Push the batch yourself (step 4).'
  const prs = Array.isArray(input.prs) ? [...new Set(input.prs.map(Number))].filter(n => Number.isInteger(n) && n > 0) : []
  if (prs.length === 0) return 'Refused: prs must list the PR numbers of the batch.'
  const full = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{40}$/i.test(v.trim()) ? v.trim().toLowerCase() : undefined
  const sha = full(input.sha)
  const baseSha = full(input.base_sha)
  if (sha === undefined) return 'Refused: sha must be the full 40-character sha of the batch head (git rev-parse HEAD).'
  if (baseSha === undefined) return 'Refused: base_sha must be the full 40-character sha of origin/<base> you built the batch on.'
  const check = typeof input.check === 'string' ? input.check.trim() : ''
  if (check === '') return 'Refused: check must say, in one line, what the full check gave ("N tests passed" or "none configured").'
  const version = typeof input.version === 'string' ? input.version.trim().replace(/^v/, '') : undefined
  const id = batchId(sha)
  const at = await $.clock.now()
  const hs = await read($, handovers)
  for (const n of prs) {
    const h = hs[String(n)]
    if (h === undefined) return `Refused: no handover for PR #${n}.`
    if (!recordable(h.status)) return `Refused: PR #${n} is ${h.status}; a batch holds PRs you took ("take") or that are already ready.`
  }
  const have = await refSha($, refOf(id))
  if (have !== sha) {
    return `Refused: ${refOf(id)} ${have === undefined ? 'does not exist' : `points at ${have}, not ${sha}`}. Run \`git update-ref ${refOf(id)} HEAD\` in your worktree on the batch head, then call ready again.`
  }
  const items = prs.map(n => itemOf(hs[String(n)]!))
  const batch = newBatch({ sha, baseSha, check, ...(version !== undefined && version !== '' ? { version } : {}), items, now: at })
  type Decided = { kind: 'same' } | { kind: 'awaits'; id: string } | { kind: 'new'; old: ReadyBatch | undefined }
  const decided = await withPush<Decided>($, cur => {
    if (cur.batch?.state === 'ready') {
      return { push: cur, out: cur.batch.sha === sha ? { kind: 'same' as const } : { kind: 'awaits' as const, id: cur.batch.id } }
    }
    return { push: { batch }, out: { kind: 'new' as const, old: cur.batch } }
  })
  if (decided.kind === 'same') return `Batch ${id} is already recorded and awaits the user's /flow push. End your run.`
  if (decided.kind === 'awaits') return `Refused: batch ${decided.id} already awaits the user's /flow push; there is only one ready batch at a time. Leave your PRs alone and end your run.`
  if (decided.old !== undefined && decided.old.ref !== batch.ref) await dropRef($, decided.old.ref)
  const q = await withInbox($, cur => {
    const r = openPushItem(cur, batch, at)
    return { inbox: r.inbox, out: r.q }
  })
  await withPush($, cur => (cur.batch?.id === id ? { push: { batch: { ...cur.batch, qid: q.id } }, out: undefined } : { push: cur, out: undefined }))
  for (const n of prs) {
    const h = (await read($, handovers))[String(n)]!
    const next: Handover = { ...h, status: 'ready' }
    await update($, handovers, all => ({ ...all, [String(n)]: next }))
    await best($, 'saving a handover', async () => {
      await saveHandover($, next)
      await appendLog($, { event: 'ready', owner: next.reportTo, pr: next.pr, branch: next.branch, text: `batch ${id} awaits /flow push` })
    })
  }
  void $.ui.toast(`Batch ${id} ready to push (${prs.map(n => `#${n}`).join(' ')}): /flow push`)
  return `Recorded batch ${id}: ${prs.map(n => `#${n}`).join(', ')} are ready and wait for the user's /flow push (inbox ${q.id}). Do not push, delete branches, publish or deploy. End your run now with your report: batch ${id} ready, awaits /flow push.`
}

// After a PR is done or sent back, a batch with none of its PRs left is finished: its ref goes.
async function settleBatch($: EngineInterface): Promise<void> {
  const hs = await read($, handovers)
  const ended = await withPush<ReadyBatch | undefined>($, cur => {
    const b = settlePrs(cur.batch, pr => hs[String(pr)]?.status)
    if (b === cur.batch) return { push: cur, out: undefined }
    return { push: b === undefined ? {} : { batch: b }, out: b === undefined ? cur.batch : undefined }
  })
  if (ended === undefined) return
  await dropRef($, ended.ref)
  await closeBatchItem($, ended.qid, 'finished', 'flow', await $.clock.now())
}

// The user's push, send-back and drop (the command, the tool main calls and the answer to the inbox item all land here).
type PushAct = { kind: 'push' } | { kind: 'back'; pr: number } | { kind: 'drop' }
async function pushAct($: EngineInterface, act: PushAct, by: string): Promise<string> {
  const at = await $.clock.now()
  type Out = { why: string } | { before: ReadyBatch; after?: ReadyBatch | undefined }
  const out = await withPush<Out>($, cur => {
    const s = act.kind === 'push' ? releaseStep(cur.batch, at) : act.kind === 'back' ? sendBackStep(cur.batch, act.pr) : dropStep(cur.batch)
    if (s.kind === 'refused') return { push: cur, out: { why: s.why } }
    const before = cur.batch!
    if (act.kind === 'drop') return { push: {}, out: { before } }
    return { push: s.batch === undefined ? {} : { batch: s.batch }, out: { before, after: s.batch } }
  })
  if ('why' in out) return out.why
  const { before, after } = out
  const said = act.kind === 'push' ? 'push' : act.kind === 'drop' ? 'drop' : `send back #${act.pr}`
  await closeBatchItem($, before.qid, said, by, at)
  await best($, 'logging the push decision', () => appendLog($, { event: 'push', owner: 'main', text: `${by}: ${said} (batch ${before.id})` }))
  const hs = await read($, handovers)
  if (act.kind === 'push') {
    const queue = await ensureQueue($)
    return `Batch ${before.id} released (${before.prs.map(n => `#${n}`).join(', ')}). A reviewer pushes it, deletes the merged branches, deploys and marks the PRs done. ${queue}`
  }
  if (act.kind === 'back') {
    const h = hs[String(act.pr)]
    if (h !== undefined) await returnPr($, h, SENT_BACK_REASON)
    if (after === undefined) {
      await dropRef($, before.ref)
      return `PR #${act.pr} sent back. It was the last PR of batch ${before.id}: the batch is gone.`
    }
    const queue = await ensureQueue($)
    return `PR #${act.pr} sent back. The rest of batch ${before.id} (${after.prs.map(n => `#${n}`).join(', ')}) is rebuilt and re-checked, then you are asked again. ${queue}`
  }
  for (const n of before.prs) {
    const h = hs[String(n)]
    if (h !== undefined) await returnPr($, h, DROPPED_REASON)
  }
  await dropRef($, before.ref)
  // A dropped batch may be handed over again as it was: its release is not "already cut" any more.
  const key = [...before.prs].sort((a, b) => a - b).join(',')
  if (lastRelease?.key === key) {
    lastRelease = undefined
    const dir = await stateDir($)
    if (dir !== undefined) await writeJsonAtomic($, `${dir}/release.json`, {})
  }
  return `Batch ${before.id} dropped: ${before.prs.map(n => `#${n}`).join(', ')} went back to their managers, the ref ${before.ref} is deleted.`
}

// The answer to the push item: "push", "send back #n", "drop"; "not yet" or anything else reopens a fresh item.
async function onPushAnswer($: EngineInterface, q: Question, answer: string, by: string): Promise<string> {
  const v = parseVerdict(answer)
  if (v.kind === 'push') return ` ${await pushAct($, { kind: 'push' }, by)}`
  if (v.kind === 'back') return ` ${await pushAct($, { kind: 'back', pr: v.pr }, by)}`
  if (v.kind === 'drop') return ` ${await pushAct($, { kind: 'drop' }, by)}`
  const at = await $.clock.now()
  const batch = (await read($, pushState)).batch
  if (batch === undefined || batch.state !== 'ready' || batch.qid !== q.id) return ''
  const fresh = await withInbox($, cur => {
    const r = openPushItem(cur, batch, at)
    return { inbox: r.inbox, out: r.q }
  })
  await withPush($, cur => (cur.batch?.id === batch.id ? { push: { batch: { ...cur.batch, qid: fresh.id } }, out: undefined } : { push: cur, out: undefined }))
  return v.kind === 'later'
    ? ` Batch ${batch.id} stays ready; ${fresh.id} asks again.`
    : ` "${answer}" is not push, send back #<pr>, drop or not yet; batch ${batch.id} stays ready and ${fresh.id} asks again.`
}

// The lines that tell the user a batch awaits them (status, resume).
const pushLines = (s: PushState): string[] => (s.batch === undefined ? [] : renderBatch(s.batch))

// mcp__flow__deploy. The gate is the one place that decides whether a target deploys in this batch.
async function deployTool($: EngineInterface, options: Record<string, unknown>, input: Record<string, unknown>, isMain: boolean, caller: string): Promise<string> {
  const action = String(input.action ?? 'list')
  const target = typeof input.target === 'string' ? input.target.trim() : ''
  const sha = typeof input.sha === 'string' ? input.sha.trim() : ''
  if (action === 'list') {
    await refreshBehind($)
    const d = await withDeploys($, cur => ({ deploys: cur, out: cur }))
    const hs = Object.values(await read($, handovers))
    const ib = await read($, inbox)
    const envLines: Record<string, string> = {}
    for (const t of deployInfos) envLines[t.name] = envListLine(pendingEnv(hs, t.name, d.targets[t.name]), d.targets[t.name], itemViewOf(ib))
    return renderList(deployInfos, d, await read($, behind), envLines)
  }
  if (action !== 'gate' && action !== 'deployed' && action !== 'hold' && action !== 'release' && action !== 'env-applied') return 'Unknown action: use gate, deployed, env-applied, hold, release or list.'
  if ((action === 'hold' || action === 'release') && !isMain) return 'Refused: only main holds or releases a target, on the user\'s word. Ask main.'
  const info = deployInfos.find(t => t.name === target)
  if (info === undefined) return `Refused: ${unknownTarget(deployInfos, target)}`
  if (action === 'hold') {
    const until = input.until === 'released' ? 'released' : input.until === 'batch' ? 'batch' : undefined
    if (until === undefined) return 'Refused: hold needs until: "batch" or "released".'
    return holdTarget($, target, until, caller, typeof input.reason === 'string' ? input.reason.trim() : undefined)
  }
  if (action === 'release') return releaseTarget($, target)
  if (action === 'env-applied') return envApplied($, info, Array.isArray(input.names) ? input.names.map(String) : [])
  if (sha === '') return 'Refused: sha is required (the short sha just pushed).'
  const at = await $.clock.now()
  if (action === 'deployed') {
    if (typeof input.ok !== 'boolean') return 'Refused: deployed needs ok true or false.'
    await withDeploys($, cur => ({ deploys: setTarget(cur, target, recordDeployed(cur.targets[target], sha, input.ok === true, at)), out: undefined }))
    await refreshBehind($)
    return input.ok === true ? `${target}: recorded as deployed at ${sha}.` : `${target}: failure noted; the last good deploy stays recorded.`
  }
  return runGate($, options, info, sha, at, false)
}

// What the gate needs to know about a target's env changes now: the pending ones and the user's answers.
function envInputFor(info: TargetInfo, ts: TargetState | undefined, hs: Handover[], ib: Inbox): EnvInput | undefined {
  const pending = pendingEnv(hs, info.name, ts)
  if (pending.length === 0) return undefined
  return { pending, item: itemViewOf(ib), applyItem: applyViewOf(ib), hasCommand: info.envCommand !== undefined }
}

const skipText = (target: string) => `Skip ${target} for this batch and go on with the next target.`

// One pass of the gate; `again` is set on the second pass, after a standing rule approved the fresh item.
async function runGate($: EngineInterface, options: Record<string, unknown>, info: TargetInfo, sha: string, at: number, again: boolean): Promise<string> {
  const target = info.name
  const hs = Object.values(await read($, handovers))
  const ib = await read($, inbox)
  const open = openDeployIds(ib)
  const decided = await withDeploys($, cur => {
    const env = envInputFor(info, cur.targets[target], hs, ib)
    const r = decideGate(cur.targets[target], info.mode, sha, qid => open.has(qid), env, at)
    return { deploys: r.state === cur.targets[target] ? cur : setTarget(cur, target, r.state), out: r }
  })
  const gate = decided.gate
  if (gate.kind === 'go') return 'Go'
  if (gate.kind === 'goEnv') {
    const lines = gate.apply.map(e => `- ${e.change.name}: ${envCommandFor(info.envCommand ?? '', e.change.name, e.change.value ?? '')}`)
    return `Go, first apply env:\n${lines.join('\n')}\nRun each command in order from the repo root; a non-zero exit fails ${target} (call deployed with ok false and stop). Then call action "env-applied" with target "${target}" and names [${gate.apply.map(e => `"${e.change.name}"`).join(', ')}], then run the target's steps.`
  }
  if (gate.kind === 'held') return `Held: ${gate.why}. ${skipText(target)}`
  if (gate.kind === 'envHeld') return `Held: ${gate.why}. It stays held until main runs release on ${target} (that drops the declined changes). ${skipText(target)}`
  if (gate.kind === 'envAwaits') return `Awaits env: ${gate.qids.join(', ')}. ${skipText(target)}`
  if (gate.kind === 'envAsk') {
    const qids: string[] = [...gate.open]
    const moved: Array<{ pr: number; name: string; field: 'qid' | 'loginQid'; qid: string }> = []
    await withInbox($, cur => {
      let next = cur
      for (const e of gate.entries) {
        const r = openApplyItem(next, e, at)
        next = r.inbox
        qids.push(r.q.id)
      }
      // An item answered "not yet" is replaced by a fresh copy, so the change keeps one open item.
      for (const re of gate.reopen) {
        const old = next.items.find(x => x.id === re.entry.change[re.field])
        if (old === undefined) continue
        const r = reopenItem(next, old, at)
        next = r.inbox
        qids.push(r.q.id)
        moved.push({ pr: re.entry.pr, name: re.entry.change.name, field: re.field, qid: r.q.id })
      }
      return { inbox: next, out: undefined }
    })
    for (const pr of new Set(moved.map(m => m.pr))) {
      const h = (await read($, handovers))[String(pr)]
      if (h?.env === undefined) continue
      const next: Handover = { ...h, env: h.env.map(c => {
        const mine = moved.filter(x => x.pr === pr && x.name === c.name && c.target === target)
        return mine.length === 0 ? c : { ...c, ...Object.fromEntries(mine.map(m => [m.field, m.qid])) }
      }) }
      await update($, handovers, hs => ({ ...hs, [String(pr)]: next }))
      await best($, 'saving a handover', () => saveHandover($, next))
    }
    void $.ui.toast(`Env on ${target} awaits you: /flow inbox (${qids.join(', ')})`)
    return `Awaits env: ${qids.join(', ')}. ${skipText(target)}`
  }
  const last = (await read($, deploys)).targets[target]?.deployedSha
  const context = approvalContext(target, sha, last, await commitsSince($, last, sha))
  if (gate.kind === 'awaits') {
    await withInbox($, cur => ({ inbox: retargetItem(cur, gate.qid, target, sha, context), out: undefined }))
    return `Awaits approval: ${gate.qid}. ${skipText(target)}`
  }
  const q = await withInbox($, cur => {
    const r = openApprovalItem(cur, target, sha, context, at)
    return { inbox: r.inbox, out: r.q }
  })
  await withDeploys($, cur => ({ deploys: setTarget(cur, target, withApproval(cur.targets[target], q.id, sha, at)), out: undefined }))
  // A standing rule answers the fresh item only if it names the deploy kind (matchRule skips it otherwise).
  const { rules } = await loadRules($, options)
  const m = matchRule(rules, q)
  if (m !== undefined) {
    const marked = await withInbox($, cur => {
      const r = markAnswered(cur, q.id, m.answer, AUTO, at, m.rule.rid)
      return { inbox: r.kind === 'ok' ? r.inbox : cur, out: r }
    })
    if (marked.kind === 'ok') {
      await withDeploys($, cur => ({ deploys: setTarget(cur, target, applyAnswer(cur.targets[target], marked.answer)), out: undefined }))
      await appendNote($, notesOwner(marked.q), `- ${await today($)} decision: "${q.id} ${q.question}: ${marked.answer}" (standing answer ${m.rule.rid})`)
      await best($, 'logging an auto-answer', () => appendLog($, { event: 'auto-answer', owner: 'main', text: `${q.id} rule ${m.rule.rid}: ${marked.answer}` }))
      // Approved: the gate runs once more, so the env commands (if any) come with the Go.
      if (isApprove(marked.answer) && !again) return runGate($, options, info, sha, at, true)
      if (isApprove(marked.answer)) return 'Go'
      return `Held: standing answer ${m.rule.rid} said "${marked.answer}". ${skipText(target)}`
    }
  }
  void $.ui.toast(`Deploy ${target} awaits your approval: /flow inbox (${q.id})`)
  return `Awaits approval: ${q.id}. ${skipText(target)}`
}

// env-applied: the reviewer ran the env commands the gate named. Records those changes for the target; asking
// twice changes nothing more. Only changes the user approved (and that the gate named) are recorded.
async function envApplied($: EngineInterface, info: TargetInfo, names: string[]): Promise<string> {
  if (names.length === 0) return 'Refused: env-applied needs names, the variables whose commands you ran.'
  const at = await $.clock.now()
  const hs = Object.values(await read($, handovers))
  const ib = await read($, inbox)
  const notes: string[] = []
  await withDeploys($, cur => {
    const ts = cur.targets[info.name]
    const pending = pendingEnv(hs, info.name, ts)
    const d = decideEnv({ pending, item: itemViewOf(ib), applyItem: applyViewOf(ib), hasCommand: info.envCommand !== undefined })
    const ready = d.kind === 'clear' ? d.apply : []
    const add = []
    for (const n of names) {
      const hit = ready.find(e => e.change.name === n)
      if (hit !== undefined) add.push({ pr: hit.pr, name: n, how: 'command' as const, at })
      else if ((ts?.envDone ?? []).some(x => x.name === n)) notes.push(`${n}: already recorded`)
      else notes.push(`${n}: not recorded, it is not approved and ready (the gate names what to apply)`)
    }
    const next = withEnvDone(ts, add)
    notes.push(...add.map(a => `${a.name}: recorded as applied by command`))
    return { deploys: next === ts ? cur : setTarget(cur, info.name, next), out: undefined }
  })
  return `${info.name}: ${notes.join('; ')}. Now run the target's steps.`
}

// The inbox items for a handover's env changes. A handover sent again reuses the earlier items by target and
// name and closes the ones it no longer lists. A standing rule answers an item only if it names the env kind.
// Returns the text for the handover result; the values never go to the log or a toast.
async function openHandoverEnv(
  $: EngineInterface, options: Record<string, unknown>, h: Handover, drafts: Draft[],
  prev: EnvChange[], at: number,
): Promise<string> {
  if (drafts.length === 0 && prev.length === 0) return ''
  const changes: EnvChange[] = []
  const fresh: Question[] = []
  await withInbox($, cur => {
    let next = cur
    for (const d of drafts) {
      const r = openEnvItems(next, h.pr, d, prev.find(p => p.target === d.target && p.name === d.name), at)
      next = r.inbox
      changes.push(r.change)
      fresh.push(...r.fresh)
    }
    const kept = new Set(changes.flatMap(c => [c.qid, ...(c.loginQid === undefined ? [] : [c.loginQid])]))
    const gone = prev.flatMap(p => [p.qid, ...(p.loginQid === undefined ? [] : [p.loginQid])]).filter(q => !kept.has(q))
    return { inbox: gone.length === 0 ? next : closeEnvItems(next, gone, 'dropped: the PR was handed over again without it', at), out: undefined }
  })
  if (changes.length > 0) h.env = changes
  else delete h.env
  if (fresh.length > 0) {
    const { rules } = await loadRules($, options)
    for (const q of fresh) {
      const m = matchRule(rules, q)
      if (m === undefined) continue
      const marked = await withInbox($, cur => {
        const r = markAnswered(cur, q.id, m.answer, AUTO, at, m.rule.rid)
        return { inbox: r.kind === 'ok' ? r.inbox : cur, out: r }
      })
      if (marked.kind !== 'ok') continue
      await onEnvAnswer($, marked.q, marked.answer)
      await appendNote($, notesOwner(marked.q), `- ${await today($)} decision: "${q.id} ${noteText(marked.q)}: ${marked.answer}" (standing answer ${m.rule.rid})`)
      await best($, 'logging an auto-answer', () => appendLog($, { event: 'auto-answer', owner: 'main', text: `${q.id} rule ${m.rule.rid}: ${marked.answer}` }))
    }
    const ib = await read($, inbox)
    const stillOpen = fresh.filter(q => ib.items.find(x => x.id === q.id)?.state === 'open')
    if (stillOpen.length > 0) void $.ui.toast(`PR #${h.pr} has ${stillOpen.length} env item${stillOpen.length === 1 ? '' : 's'} for you: /flow inbox`)
  }
  if (changes.length === 0) return ''
  const ib = await read($, inbox)
  const open = changes.flatMap(c => [c.loginQid, c.qid]).filter((q): q is string => q !== undefined && ib.items.find(x => x.id === q)?.state === 'open')
  return ` Env changes for the user (${changes.map(c => `${c.name} on ${c.target}${c.secret === true ? ', secret' : ''}`).join('; ')}): ${open.length === 0 ? 'all answered' : `inbox ${open.join(', ')}`}. Those targets do not deploy until they are answered.`
}

// A returned PR's env changes are dropped: their open items are closed by "flow" with a note.
async function closeReturnedEnv($: EngineInterface, h: Handover): Promise<void> {
  if (h.env === undefined || h.env.length === 0) return
  const at = await $.clock.now()
  await best($, 'closing env items', () => withInbox($, cur => {
    const qids = [
      ...h.env!.flatMap(c => [c.qid, ...(c.loginQid === undefined ? [] : [c.loginQid])]),
      ...cur.items.filter(x => x.env?.role === 'apply' && x.env.pr === h.pr).map(x => x.id),
    ]
    return { inbox: closeEnvItems(cur, qids, 'dropped: the PR was returned', at), out: undefined }
  }))
}

// Standing answers (standing.ts): the rules of both settings files, read fresh so a rule made a moment ago
// applies to the next ask. A bad rule is dropped by mergeLayers; the others stand.
async function loadRules($: EngineInterface, options: Record<string, unknown>): Promise<{ rules: Resolved[]; paths: string[] }> {
  const paths = await locate($)
  const layers = await Promise.all(paths.map(async path => ({ path, text: path === '' ? undefined : await $.fs.read(path).then(String, () => undefined) })))
  const raw = mergeLayers(options, layers).raw.standing_answers
  return { rules: Array.isArray(raw) ? raw as Resolved[] : [], paths }
}

type AutoHits = Map<string, { answer: string; rid: string }>

// The standing-answer check shared by ask and pre-flight: a fresh question that a rule matches is marked
// answered in the same write, so it has an id and history. Returns the inbox, the stored questions as they
// are now, and which ones a rule answered.
function autoAnswer(cur: Inbox, r: ReturnType<typeof addQuestions>, rules: Resolved[], at: number, escalate = false) {
  let next = r.added.some(a => a.fresh) ? r.inbox : cur
  // An escalate rule holds the question for the user: blocking, flagged, never auto-answered.
  if (escalate) {
    for (const { q, fresh } of r.added) {
      const esc = fresh ? escalation(rules, q) : undefined
      if (esc !== undefined) next = { ...next, items: next.items.map(x => (x.id === q.id ? { ...x, blocking: true, escalated: esc.rid, addressee: 'main' } : x)) }
    }
  }
  const hits: AutoHits = new Map()
  for (const { q, fresh } of r.added) {
    const m = fresh ? matchRule(rules, next.items.find(x => x.id === q.id) ?? q) : undefined
    if (m === undefined) continue
    const marked = markAnswered(next, q.id, m.answer, AUTO, at, m.rule.rid)
    if (marked.kind !== 'ok') continue
    next = marked.inbox
    hits.set(q.id, { answer: marked.answer, rid: m.rule.rid })
  }
  const added = r.added.map(a => ({ ...a, q: next.items.find(x => x.id === a.q.id) ?? a.q }))
  return { inbox: next, added, hits }
}

// The decision note and auto-answer log event for each question a rule answered.
async function recordAutoAnswers($: EngineInterface, added: Array<{ q: Question }>, hits: AutoHits, agent: string): Promise<void> {
  const date = await today($)
  for (const { q } of added) {
    const hit = hits.get(q.id)
    if (hit === undefined) continue
    await appendNote($, notesOwner(q), `- ${date} decision: "${q.id} ${q.question}: ${hit.answer}" (standing answer ${hit.rid})`)
    await best($, 'logging an auto-answer', () => appendLog($, { event: 'auto-answer', owner: noteKey(notesOwner(q)), agent, text: `${q.id} rule ${hit.rid}: ${hit.answer}` }))
  }
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

// Adds a suggested guard mapping to the personal file (never the committed one), keeping every other key and the
// mapping already there. The text tells main to copy it to .claude/flow.json to share it.
function addGuardTest($: EngineInterface, options: Record<string, unknown>, glob: string, test: string): Promise<string> {
  return inRulesChain(async () => {
    const path = (await locate($))[1] ?? ''
    if (path === '') return 'No mapping written: guard mappings need a repo for the personal file.'
    let obj: Record<string, unknown> = {}
    const text = await $.fs.read(path).then(String, () => undefined)
    if (text !== undefined && text.trim() !== '') {
      try { obj = JSON.parse(text) as Record<string, unknown> } catch { return `No mapping written: ${path} is not valid JSON; fix it first, flow does not rewrite it.` }
      if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return `No mapping written: ${path} is not a JSON object; flow does not rewrite it.`
    }
    const had = obj.guard_tests === undefined ? {} : parseGuardTests(obj.guard_tests)
    if (had === undefined) return `No mapping written: "guard_tests" in ${path} is not an object of globs to test lists; fix it first.`
    const next = addMapping(had, glob, test)
    if ((had[glob] ?? []).includes(test)) return `Already in ${path}: ${JSON.stringify({ [glob]: [test] })}.`
    await $.process.run(['mkdir', '-p', path.replace(/\/[^/]*$/, '')])
    if (!await writeJsonAtomic($, path, { ...obj, guard_tests: next })) return `No mapping written: could not write ${path}.`
    return `Added ${JSON.stringify({ [glob]: [test] })} to ${path} (personal, uncommitted). To share it with the team, copy it into .claude/flow.json under "guard_tests" and commit.`
  })
}

// A PR sent back for failing tests: for each failed test no guard mapping already requires for the PR's files, one
// non-blocking question to main suggests a mapping. Best effort: the send-back itself is already recorded.
async function suggestGuardTests($: EngineInterface, input: Record<string, unknown>, pr: number, queueName: string, agentId: string | undefined, map: GuardMap): Promise<string> {
  const failed = Array.isArray(input.failed_tests) ? input.failed_tests.filter((t): t is string => typeof t === 'string' && t.trim() !== '') : []
  if (failed.length === 0) return ''
  const diff = await $.process.run(['gh', 'pr', 'diff', String(pr), '--name-only']).catch(() => undefined)
  if (diff === undefined || diff.exitCode !== 0) return ` No guard suggestion: gh pr diff ${pr} failed${diff === undefined ? '' : `: ${diff.stderr.trim().slice(0, 200)}`}.`
  const files = diff.stdout.split('\n').map(l => l.trim()).filter(Boolean)
  const sugg = suggestionsFor(files, failed, map)
  if (sugg.length === 0) return ''
  const at = await $.clock.now()
  const filed = await withInbox($, cur => {
    const open = (g: { glob: string; test: string }) => cur.items.some(x => x.state === 'open' && x.guard?.glob === g.glob && x.guard.test === g.test)
    const asked = sugg.filter(x => !open(x)).map(x => suggestionQuestion(pr, x))
    if (asked.length === 0) return { inbox: cur, out: [] as string[] }
    const r = addQuestions(cur, { name: queueName, id: agentId, isManager: false }, 'main', asked, at)
    return { inbox: r.inbox, out: r.added.filter(a => a.fresh).map(a => a.q.id) }
  })
  return filed.length === 0 ? '' : ` Asked main whether to add a guard mapping (${filed.join(', ')}).`
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

// The suggested starting rules, for main's first status call when no rule exists anywhere. The flag is
// written before returning; two calls at once may both show it, none may miss it.
async function offerSeedsOnce($: EngineInterface, options: Record<string, unknown>): Promise<string[]> {
  const dir = await stateDir($)
  if (dir === undefined) return []
  const flag = `${dir}/seeds-offered.json`
  if (await readJson($, flag) !== undefined) return []
  const { rules } = await loadRules($, options)
  const offer = rules.length === 0 ? seedsToOffer(rules) : []
  if (offer.length === 0) return []
  await $.process.run(['mkdir', '-p', dir])
  await writeJsonAtomic($, flag, { offeredAt: await $.clock.now() })
  return renderSeeds(offer)
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
  if (q.kind === 'deploy') return `${id}: no rule made, a deploy approval is the user's call every time.`
  if (q.kind === ENV_KIND) return `${id}: no rule made, an env change is the user's call every time.`
  if (q.kind === PUSH_KIND) return `${id}: no rule made, pushing a batch is the user's call every time.`
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
async function appendLog($: EngineInterface, event: Omit<LogEvent, 'ts'>, max = TEXT_MAX): Promise<void> {
  try {
    const dir = await stateDir($)
    if (dir === undefined) return
    const ts = new Date(await $.clock.now()).toISOString()
    const entry: LogEvent = { ts, ...event }
    if (entry.text !== undefined) entry.text = cap(entry.text.replaceAll('\n', ' '), max)
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

const STATUSES = new Set(['pending', 'awaiting', 'taken', 'ready', 'done', 'returned'])

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

// Managers a non-main agent woke (reviewer, worker): the host sends such a turn's final answer back to
// whoever woke it, so the plugin forwards it to main at turn end. Main's own SendMessage clears the mark.
const wokenByOthers = new Set<string>()

// What each reviewer run did with the queue (agent id), for the main-checkout line of its report.
const reviewerWork = new Map<string, RunWork>()

// `$` stays in this file: deliver.ts gets the three calls it needs.
const ioOf = ($: EngineInterface): DeliverIo => ({
  status: async id => (await $.agent.list()).find(a => a.id === id)?.status,
  send: async (id, text) => {
    const r = await $.session.send({ to: { agentId: id }, text })
    // A refused send is not a delivery: deliver() runs the fallback. The reason is kept for the caller that logs it.
    if (r?.isDelivered === false) {
      refusals.set(id, r.reason ?? 'unknown')
      throw new Error(r.reason ?? 'not delivered')
    }
    refusals.delete(id)
  },
  after: (ms, fn) => void $.clock.after(ms, fn),
  name: async id => (await $.agent.list()).find(a => a.id === id)?.name,
})
const refusals = new Map<string, string>()
const deliver = ($: EngineInterface, id: string, text: string, opts?: DeliverOptions) => deliverTo(ioOf($), id, text, opts)
const flushAgent = ($: EngineInterface, id: string) => flushTo(ioOf($), id)
const holdForReviewer = ($: EngineInterface, id: string) => holdTo(ioOf($), id)
const toMain = ($: EngineInterface, text: string) => $.clock.after(0, () => void $.prompt.submit({ text }).catch(() => undefined))

// A reviewer's whole final answer plus the main-checkout line when it left it out; undefined for a run
// that did no batch work.
function reviewerReport(answer: string, work: RunWork | undefined): string | undefined {
  const line = runLine(work)
  const text = answer.trim()
  if (line === undefined || text === '') return undefined
  return /main checkout (fast-forwarded|not updated)/.test(text) ? text : `${text}\n${line}`
}

const normText = (t: string): string => t.replace(/\s+/g, ' ').trim()
const RELAY_DELAY_MS = 3000
const FORWARDED_MAX = 400
const FORWARDED_RIDS = 10

// The host may already hand a woken manager's answer to main as a task notification. Main's transcript
// shows whether it did; when it cannot be read, say "not there" so the report is relayed, never lost.
async function mainHasAnswer($: EngineInterface, answer: string): Promise<boolean> {
  try {
    const msgs = await $.session.messages()
    if ('deny' in msgs) return false
    const snippet = normText(answer).slice(0, 80)
    return snippet !== '' && msgs.slice(-60).some(m => m.role === 'user' && normText(m.text).includes(snippet))
  } catch {
    return false
  }
}

// The lines of a report that need main's eye: "needs a person: ..." and "pending decisions: ...",
// each cut at the next " | " field, so a whole done line and a lone line compare equal.
const needLines = (text: string): string[] =>
  [...text.matchAll(/(needs a person:[^|\n]*|pending decisions:[^\n]*)/gi)].map(m => normText(m[1] ?? '')).filter(l => l !== '')

// Where a handover's report goes. Absent -> the caller's own name. A name no agent carries is refused,
// naming the caller; the caller's own worker is corrected to the caller. An ended agent that exists is
// accepted: the reviewer routing (reviewerSendGuard) handles it.
async function resolveReportTo($: EngineInterface, given: unknown, callerId: string | undefined): Promise<{ name: string; note?: string } | { refuse: string }> {
  const rows = await $.agent.list()
  const me = callerId === undefined ? 'main' : (rows.find(a => a.id === callerId)?.name ?? 'main')
  const asked = typeof given === 'string' ? given.trim() : ''
  if (asked === '' || asked === me || asked === 'main') return { name: asked === '' ? me : asked }
  const hits = rows.filter(a => a.name === asked || isManagerOf(asked, a.name))
  if (hits.length === 0) {
    return { refuse: `Refused: report_to "${asked}" matches no agent of this session. Your own name is "${me}"; pass that, or leave report_to out and it defaults to it.` }
  }
  if (callerId !== undefined && hits.every(a => a.parentId === callerId && WORKERS.has(a.type))) {
    return { name: me, note: ` report_to "${asked}" is your own worker, so the report goes to you ("${me}") instead.` }
  }
  return { name: asked }
}

async function managerFinished($: EngineInterface, ids: string[], name: string, rows: { id: string; parentId?: string; status: string }[]): Promise<boolean> {
  // A child is live only while running or pending: workers sit 'idle' after their final report. A child
  // active more recently than the manager may have reported without the manager hearing it yet.
  const acts = await read($, activity)
  const mineAt = Math.max(0, ...ids.map(i => acts[i]?.lastAt ?? 0))
  const kids = rows.filter(a => a.parentId !== undefined && ids.includes(a.parentId))
  if (kids.some(a => a.status === 'running' || a.status === 'pending' || (acts[a.id]?.lastAt ?? 0) > mineAt)) return false
  const open = new Set(['pending', 'awaiting', 'taken', 'returned'])
  if (Object.values(await read($, handovers)).some(h => open.has(h.status) && isManagerOf(name.replace(/-\d+$/, ''), h.reportTo))) return false
  const plans = await read($, plan)
  if (Object.values(plans[planOwner(plans, name)] ?? {}).some(n => n.state === 'waiting' || n.state === 'ready' || n.state === 'running')) return false
  if ((await read($, inbox)).items.some(q => q.state === 'open' && q.blocking && isManagerOf(name.replace(/-\d+$/, ''), q.owner))) return false
  return true
}

// The reviewer's SendMessage to a manager that has ended would resume it just to say "noted", and its
// final answer would go back to the reviewer. Instead the report is noted for that manager and sent to
// main. Returns the tool result when it handled the call; undefined passes the call on.
async function reviewerSendGuard($: EngineInterface, rid: string, to: string, text: string): Promise<string | undefined> {
  if (to === '' || to === 'main' || to === '*') return undefined
  const rows = await $.agent.list()
  const hits = rows.filter(a => a.id === to || a.name === to)
  if (hits.length > 0 && !hits.some(a => a.type === MANAGER)) return undefined
  const name = hits[0]?.name ?? to
  const idle = hits.length > 0 && !hits.some(a => a.status !== 'idle' && !ENDED.has(a.status))
  // A host leaves a manager that finished its work 'idle', not completed. It counts as finished only
  // when nothing is left for it: no live child, no other open or returned handover, no open plan
  // node, no open blocking ask. Otherwise the message wakes it as today.
  if (hits.length > 0 && !hits.every(a => ENDED.has(a.status))) {
    if (!idle || !(await managerFinished($, hits.map(a => a.id), name, rows))) return undefined
  }
  // One outcome reaches main once: key on the manager and the PRs the text names (the text itself when
  // it names none). A repeat forwards only needs-a-person / pending-decisions lines not sent before.
  const prs = [...new Set([...text.matchAll(/#(\d+)/g)].map(m => m[1]))].sort().join(',')
  const key = `${rid}|${name}|${prs !== '' ? prs : normText(text)}`
  const seen = await read($, forwarded)
  const before = seen.keys[key]
  const needs = needLines(text)
  const fresh = before === undefined ? undefined : needs.filter(l => !before.includes(l))
  const status = hits.length > 0 ? 'has finished' : 'matches no agent'
  if (fresh !== undefined && fresh.length === 0) {
    return `Not sent: ${name} ${status}. This report was already forwarded to main, with ${name}'s note: do not message ${name} again and do not repeat it to main.`
  }
  const body = fresh === undefined ? text : fresh.join('\n')
  let noted = false
  if (hits.length > 0) {
    noted = await appendNote($, name, `- ${await today($)} progress: reviewer report: ${normText(body)}`)
  }
  await update($, forwarded, f => ({
    keys: { ...Object.fromEntries(Object.entries(f.keys).slice(-FORWARDED_MAX)), [key]: [...(f.keys[key] ?? []), ...(fresh ?? needs)] },
    lines: Object.fromEntries(Object.entries({ ...f.lines, [rid]: [...(f.lines[rid] ?? []), ...body.split('\n').map(normText).filter(l => l !== ''), ...(fresh ?? needs)].slice(-FORWARDED_MAX) }).slice(-FORWARDED_RIDS)),
  }))
  toMain($, `Report for ${hits.length > 0 ? `${name} (finished${hits.every(a => ENDED.has(a.status)) ? '' : '; not woken'})` : `${name} (no such agent)`}, from the reviewer:\n${body}`)
  return `Not sent: ${name} ${status}, so messaging it would only wake it. The plugin ${noted ? `noted the report for ${name} and ` : ''}sent ${fresh === undefined ? 'it' : 'the new lines'} to main. Do not message ${name} again, and do not repeat this report to main.`
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
    await deliver($, me.parentId, `flow: ${branch} has handed off ${count} times (max_continues ${maxContinues}). The package is too big for one worker: split the Remaining part of its handoff note into smaller briefs instead of another plain continuation.`, { urgent: true }).catch(() => undefined)
  }
}

const FLOW_TYPES = new Set(['flow:manager', 'flow:worker', CONTINUE, REVIEWER, QUEUE])

const DIGEST_MAX = 4000
const CONTINUE_LINE = /^Continue on branch:\s*(flow\/\S+)\s*$/m

const gitOut = async ($: EngineInterface, argv: string[]): Promise<string | undefined> => {
  const r = await $.process.run(['git', ...argv])
  return r.exitCode === 0 ? r.stdout.trim() : undefined
}

// The brief's attachments, checked: each must be a readable file. Returns the prompt with the paths made
// absolute, or the denial naming every bad path. A prompt without the section is returned as it was.
async function checkAttachments($: EngineInterface, prompt: string): Promise<{ prompt: string } | { deny: string }> {
  const items = parseAttachments(prompt)
  if (items.length === 0) return { prompt }
  const cwd = (await $.session.cwd().catch(() => undefined)) ?? ''
  const home = items.some(i => i.path.startsWith('~'))
    ? (await $.process.run(['sh', '-c', 'printf %s "$HOME"'])).stdout.trim()
    : ''
  const ok = async (flag: string, path: string) => (await $.process.run(['test', flag, path])).exitCode === 0
  const bad: string[] = []
  const seen = new Set<string>()
  for (const { path } of items) {
    const abs = absolutePath(path, cwd, home)
    if (seen.has(abs)) continue
    seen.add(abs)
    if (await ok('-d', abs)) bad.push(`${abs} (a directory: list the files in it)`)
    else if (!(await ok('-f', abs))) bad.push(`${abs} (does not exist)`)
    else if (!(await ok('-r', abs))) bad.push(`${abs} (not readable)`)
  }
  if (bad.length > 0) {
    return { deny: `flow: the brief's Attachments must be readable files. Fix or drop:\n${bad.map(b => `- ${b}`).join('\n')}` }
  }
  return { prompt: rewriteAttachments(prompt, items, p => absolutePath(p, cwd, home)) }
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

// Model routing: a worker brief's `Size:` line picks the model; a successor (`x-2`, or a brief that continues a
// branch) runs at least one size up from the largest size recorded for its predecessors. No size and no
// escalation leaves the spawn as the manager wrote it.
type Routed = { size: Size; reason: string; model: string; escalated: boolean }

async function routeWorker($: EngineInterface, e: AgentSpawnInput, models: SizeModels): Promise<{ e: AgentSpawnInput; routed?: Routed }> {
  const declared = parseSize(e.prompt)
  const name = (e as { name?: string }).name ?? e.description
  const branch = CONTINUE_LINE.exec(e.prompt)?.[1]
  let floor: Size | undefined
  if (isSuccessorName(name) || branch !== undefined) {
    await loadLedger($)
    const gen = generation(name)
    const before = Object.values(await read($, ledger)).filter(x => x.role === 'worker' && x.name !== name
      && ((baseName(x.name) === baseName(name) && generation(x.name) < gen) || (branch !== undefined && x.branch === branch)))
    floor = floorFrom(before.map(x => x.size))
  }
  const size = effectiveSize(declared?.size, floor)
  if (size === undefined) return { e }
  const model = modelFor(size, models)
  return { e: { ...e, model }, routed: { size, reason: declared?.reason ?? '', model, escalated: declared === undefined || declared.size !== size } }
}

// The downgrade FYI: below large the user can overturn the manager's size. Filed by the plugin, owned by the
// spawning manager and addressed to main like the manager's own FYI; a standing rule can ack or overturn it.
// An FYI for the same worker is never filed twice.
async function fileSizeFyi($: EngineInterface, options: Record<string, unknown>, name: string, parentId: string | undefined, routed: Routed): Promise<void> {
  if (routed.size === 'large' || parentId === undefined) return
  const parent = (await $.agent.list()).find(a => a.id === parentId)
  if (parent === undefined || parent.type !== MANAGER || parent.name === undefined) return
  const owner = parent.name
  const decision = `${name} runs ${routed.size} -> ${routed.model}${routed.escalated ? ' (one size up after an earlier worker on this package)' : ''}: ${routed.reason === '' ? 'no reason given' : routed.reason}`
  const at = await $.clock.now()
  const { rules } = await loadRules($, options)
  const { added, auto } = await withInbox($, cur => {
    if (cur.items.some(x => x.owner === owner && isFyi(x) && x.topic === 'worker-size' && x.question.startsWith(`${name} runs `))) {
      return { inbox: cur, out: { added: [] as Array<{ q: Question }>, auto: new Map() as AutoHits } }
    }
    const asked = fyiAsked({ decision, why: 'The plugin routes the worker model by the size on its brief; below large a harder package may need a rerun. Overturn to restart it at the size you choose.', topic: 'worker-size' })
    const r = autoAnswer(cur, addQuestions(cur, { name: owner, id: parentId, isManager: true }, 'main', [asked], at, 'fyi'), rules, at)
    return { inbox: r.inbox, out: { added: r.added, auto: r.hits } }
  })
  await recordAutoAnswers($, added, auto, owner)
}

const FABLE_DENY = "flow: sub-agents don't run on Fable; use sonnet or opus (set worker_model / manager_model / reviewer_model)."

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

// Starts a reviewer unless one is live. The reviewer drains every pending handover, then ends;
// the next handover, or a reviewer that ended with work left, starts a fresh one.
// Calls run one after another: handovers arriving back to back must not each see "no queue yet".
let queueChain: Promise<unknown> = Promise.resolve()
function ensureQueue($: EngineInterface): Promise<string> {
  const run = queueChain.then(() => startQueue($))
  queueChain = run.catch(() => undefined)
  return run
}

async function startQueue($: EngineInterface): Promise<string> {
  const list = await $.agent.list()
  if (list.some(a => isReviewer(a.type) && LIVE.has(a.status))) {
    return 'The running reviewer picks it up at its next list.'
  }
  // A batch (any state) holds the queue: pending handovers go in after the push run.
  const batch = (await read($, pushState)).batch
  const pending = batch !== undefined ? [] : Object.values(await read($, handovers)).filter(h => h.status === 'pending')
  const pushDue = batch !== undefined && batch.state !== 'ready'
  const dueTargets = Object.entries((await read($, deploys)).targets).filter(([name, t]) => t.due === true && deployInfos.some(i => i.name === name)).map(([name]) => name)
  if (pending.length === 0 && dueTargets.length === 0 && !pushDue) {
    return batch === undefined ? 'Nothing pending.' : `Batch ${batch.id} awaits the user's /flow push; new handovers wait behind it.`
  }
  const n = (await read($, queueRuns)) + 1
  await update($, queueRuns, () => n)
  const started = await $.agent.spawn({
    subagentType: REVIEWER,
    name: `reviewer-${n}`,
    description: 'reviewer',
    prompt: `Pending handovers: ${batch !== undefined ? 'wait behind the batch' : pending.length === 0 ? 'none' : pending.map(h => `#${h.pr}`).join(', ')}.${dueTargets.length === 0 ? '' : ` Deploy-only work due: ${dueTargets.join(', ')}.`}${batch === undefined ? '' : batch.state === 'ready' ? ` Batch ${batch.id} awaits the user's push: leave it alone.` : ` ${batch.state === 'pushing' ? 'Push run' : 'Rebuild run'} for batch ${batch.id}: see "Push run" in your instructions.`} Start with mcp__flow__deploy action "list" and mcp__flow__reviewer action "list".`,
  })
  if (started.deny !== undefined) return `Could not start a reviewer: ${started.deny}`
  return `Started reviewer reviewer-${n}.`
}

const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit']

// Why a call is refused as a write to the repo's main checkout, or undefined. `cwd` is where
// the caller's shell runs when that is known: the main session and managers run in the
// session's directory; a worker's or the reviewer's worktree isn't known here, so their relative
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

// The reviewer's report with the PR's workers' cost appended, once.
async function withCost($: EngineInterface, branch: string, report: string): Promise<string> {
  if (report.includes('| cost:')) return report
  try {
    await loadLedger($)
    return `${report}${reportSuffix(prCost(await read($, ledger), branch))}`
  } catch {
    return report
  }
}

// How many finished handovers status lists; the rest only count, `pr:<n>` gives any one in full.
const FINISHED_SHOWN = 5
const FINISHED_REPORT_MAX = 120

// Open handovers in order, then the newest finished ones, and how many finished were left out.
export function cappedHandovers(list: Handover[]): { shown: Handover[]; hidden: number } {
  const finished = list.filter(h => h.status === 'done').sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
  const keep = new Set(finished.slice(0, FINISHED_SHOWN))
  return { shown: list.filter(h => h.status !== 'done' || keep.has(h)), hidden: Math.max(0, finished.length - FINISHED_SHOWN) }
}

const clipLine = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// reportMax clips only the reviewer's report, so the title and evidence of a finished line stay.
function handoverLine(h: Handover, reportMax?: number): string {
  const tail = h.status === 'done' ? ` ${h.sha ?? ''} ${reportMax === undefined ? h.report ?? '' : clipLine(h.report ?? '', reportMax)}`
    : h.status === 'returned' ? ` returned: ${h.reason ?? ''}`
    : h.status === 'awaiting' ? ` awaiting the user's approval: /flow approve ${h.pr}`
    : h.status === 'ready' ? ' ready in a batch that awaits the user: /flow push' : ''
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
      (h.status === 'awaiting' ? ` It awaits the user's /flow approve ${h.pr}; do not restart work on it.` : '') +
      (h.status === 'ready' ? ' It is in a batch the reviewer built and checked, which awaits the user\'s /flow push; do not restart work on it.' : '')
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
  // A worktree path ends in agent-<agentId>: that covers a worker that has not renamed its branch, and the reviewer.
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
  // A wrap-up for an agent that is gone is only logged, not sent on to main.
  const sent = await deliver($, me.id, text, { urgent: true, onGone: () => undefined }).catch(() => false)
  // A refused send is re-queued by deliver() and reads as sent there; the refusal is recorded by the io.
  if (!sent || refusals.has(me.id)) $.ui.log(`flow: wrap-up for ${me.name ?? me.id} not delivered: ${refusals.get(me.id) ?? 'unknown'}`)
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
  if (!(await $.agent.list()).some(a => a.type === MANAGER || a.type === WORKER || isReviewer(a.type))) return main.window
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
  const warnings = [...loaded.warnings, ...deployModeWarnings(loaded.raw.deploy_targets)]
  if (warnings.length > 0) void $.ui.toast(`flow settings:\n${warnings.join('\n')}`)
  return { settings: settingsOf(loaded.raw, base), seen }
}

// The agent definitions carry the settings' prompts and models; a re-registered name is
// replaced from the next turn, so agents already running keep what they started with.
async function registerAgents($: EngineInterface, settings: ReturnType<typeof settingsOf>) {
  await $.agent.register({
    name: 'manager',
    description: 'A flow manager: owns one task, writes briefs, starts flow:worker agents, reviews their PRs and hands them to the reviewer. ' +
      'Pass the task in the user\'s words as the prompt and a short task slug as the name; run it in the background.',
    prompt: fill(MANAGER_PROMPT.replace('{{REVIEWER_RULE}}', settings.useReviewer ? REVIEWER_RULE : NO_REVIEWER_RULE), settings),
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
    name: 'reviewer',
    description: 'The flow reviewer. Started by the plugin when a PR is handed over; never start it yourself.',
    prompt: fill(REVIEWER_PROMPT, settings),
    model: settings.reviewerModel,
    isolation: 'worktree',
    background: true,
  })
  // The old agent type name, kept so a spawn or a resume under flow:queue still works.
  await $.agent.register({
    name: 'queue',
    description: 'The old name of flow:reviewer. Never start it; the plugin starts flow:reviewer.',
    prompt: fill(REVIEWER_PROMPT, settings),
    model: settings.reviewerModel,
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
  else await deliver($, s.owner, text).catch(() => undefined)
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
  let settings = settingsOf(renameOptions(options), 'main')
  queueOn = settings.useReviewer
  cleanupMode = settings.cleanup
  cleanupBase = settings.base
  deployInfos = infosOf(settings)
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
    queueOn = s.useReviewer
    cleanupMode = s.cleanup
    cleanupBase = s.base
    deployInfos = infosOf(s)
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
  // The version this plugin was installed as, read at session.start.
  let installed: string | undefined

  on('session.start', async ($, e, next) => {
    resetDelivery(text => toMain($, text))
    // Handovers a restart would lose: merge what is on disk under this session's own records.
    let queueDue = false
    await best($, 'loading handovers', async () => {
      resetStateDir()
      const disk = await loadHandovers($)
      if (Object.keys(disk).length === 0) return
      await update($, handovers, hs => ({ ...disk, ...hs }))
      queueDue = Object.values(disk).some(h => h.status === 'pending')
    })
    // Reviewer worktrees left over from before a restart or reload.
    autoSweep($)
    await best($, 'loading the inbox', async () => {
      const dir = await stateDir($)
      if (dir === undefined) return
      const disk = normalizeInbox(await readJson($, `${dir}/inbox.json`))
      await update($, inbox, () => disk)
    })
    await best($, 'loading checks', async () => {
      installed = await installedVersion($)
      const dir = await stateDir($)
      if (dir === undefined) return
      const disk = normalizeChecks(await readJson($, `${dir}/checks.json`))
      await update($, checks, () => disk)
      // Done handovers from before checks existed (or a session that died first) get theirs once.
      for (const h of Object.values(await read($, handovers))) {
        // A PR that already has a check (any state) runs no git calls on a normal restart.
        if (h.status === 'done' && !(await read($, checks)).items.some(c => c.pr === h.pr)) await captureChecks($, h, settings.verifyPaths, false)
      }
      // Once per installed version: the checks it now covers go to main as a prompt.
      const due = dueForPrompt(await read($, checks), installed)
      if (due.length === 0) return
      await withChecks($, cur => ({ checks: { ...cur, promptedVersion: installed }, out: undefined }))
      const text = `Flow ${installed} is installed. These after-deploy checks need a person and can be done now; tell the user, do not start managers for them:\n` +
        due.map(c => `${c.id} PR #${c.pr} ${c.title}: ${c.steps}`).join('\n') + '\nThe user closes them with /flow checks pass <id...> or /flow checks fail <id> <note>; or you do with mcp__flow__check.'
      $.clock.after(0, () => void $.prompt.submit({ text }).catch(() => undefined))
    })
    await best($, 'loading deploy gates', async () => {
      const dir = await stateDir($)
      if (dir === undefined) return
      const disk = normalizeDeploys(await readJson($, `${dir}/deploys.json`))
      await update($, deploys, () => disk)
      queueDue = queueDue || Object.entries(disk.targets).some(([name, t]) => t.due === true && deployInfos.some(i => i.name === name))
      void refreshBehind($)
    })
    await best($, 'loading the push gate', async () => {
      const dir = await stateDir($)
      if (dir === undefined) return
      const disk = normalizePush(await readJson($, `${dir}/push.json`))
      await update($, pushState, () => disk)
      // A released or rebuilding batch left by a session that ended gets its reviewer.
      queueDue = queueDue || (disk.batch !== undefined && disk.batch.state !== 'ready')
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
      description: 'Show the flow in a pane: managers, their workers, the reviewer and handed-over PRs. /flow inbox lists the open questions and FYIs (/flow inbox all adds the older FYIs, /flow inbox <id> shows one in full), /flow ok keeps every open FYI (/flow ok <id|owner|topic> takes those, or the default of a question), /flow no <id> [what instead] overturns an FYI, /flow answer <id> <choice> answers any question addressed to main, /flow status shows what the agents cost (estimates at API list prices), /flow checks lists the after-deploy checks that need a person (pass or fail them), /flow preflight shows the current pre-flight round, /flow close closes it, /flow resume picks up unfinished flow work, /flow approve <pr> lets the reviewer merge a PR that awaits your approval, /flow push starts the push of the batch the reviewer checked and saved (push_mode confirm; /flow push back <pr> sends one PR back, /flow push drop returns them all), /flow hold <target> [batch|released] keeps a deploy target from deploying and /flow release <target> lets it, /flow clean lists leftover worktrees and branches (--yes removes them)',
      argumentHint: '[inbox [all|<id>]|ok [<id|owner|topic>...]|no <id> [what instead]|answer <id> <choice>|checks|status|preflight|close|resume|approve <pr>|push [back <pr>|drop]|clean]',
    })
    await $.command.register({
      name: 'flow-tasks',
      description: 'Pick tasks from a task source (.claude/flow/sources/<name>.md) and start a manager for each',
      argumentHint: '[source] [ids or filter]',
    })
    await registerAgents($, settings)

    await $.tool.register({
      name: 'handover',
      description: 'Hand an approved PR to the flow reviewer. Records the PR at its current head and starts a reviewer if none is running. ' +
        'Managers call this after reviewing a worker\'s PR; leave the branch alone afterwards. ' +
        'Refused unless the PR description has a ## Verification section (Ran, Exercised, Not verified); the refusal shows the format.',
      inputSchema: {
        type: 'object',
        properties: {
          pr: { type: 'number', description: 'The PR number' },
          verified: { type: 'string', description: 'Optional: your own one-line summary of the review. The proof itself is read from the PR\'s ## Verification section.' },
          pending: { type: 'string', description: '"none", or decisions the user still has to make; the reviewer puts them in its report and the status file' },
          after_deploy: { type: 'string', description: '"none", or what to check after deploy; the reviewer starts a check-only worker for what an agent can check and reports the rest as "needs a person"' },
          verify_command: { type: 'string', description: 'Optional: a shell command that verifies the change after deploy. When the after_deploy check needs a person, the reviewer runs this command at the merged main and closes the check itself (pass on exit 0, fail otherwise).' },
          report_to: { type: 'string', description: 'Optional. Your own agent name (the default), so the reviewer reports back to you. A name that matches no agent is refused; your own worker\'s name is corrected to yours.' },
          release: { type: 'string', enum: ['patch', 'minor', 'major'], description: 'How far the release at merge bumps the version for this PR (only when the release setting is on). "minor" for a new feature users see; omit for patch; "major" only when the task asks for it. The batch gets the highest of its PRs.' },
          env: {
            type: 'array',
            description: 'Optional: env or secret changes the PR needs on a deploy target. Each goes to the user\'s inbox and the target does not deploy until they are answered. A secret has no value here: "secret: true" means the user sets it themselves. Never put a secret value anywhere, in this field or in the PR text.',
            items: {
              type: 'object',
              properties: {
                target: { type: 'string', description: 'A deploy target name from the deploy_targets setting' },
                name: { type: 'string', description: 'The env variable name' },
                value: { type: 'string', description: 'The new value, for a change that is not secret (the user sees it and says yes or no). Not together with secret.' },
                secret: { type: 'boolean', description: 'true: the user sets it themselves and answers done. Not together with value.' },
                why: { type: 'string', description: 'Why the change is needed' },
                login: { type: 'string', description: 'Optional: a step the user must do themselves first, e.g. log in to the cloud CLI. It becomes its own inbox item the change waits for.' },
              },
              required: ['target', 'name', 'why'],
            },
          },
          mode: { type: 'string', enum: ['auto', 'confirm'], description: '"confirm" for a risky PR: it waits for the user\'s /flow approve before the reviewer merges it. "auto" only marks it safe to merge directly and is refused when the merge_mode setting is confirm. Omit to use the setting.' },
        },
        required: ['pr'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'release',
      description: 'Release at merge (the release setting must be on). The reviewer calls this once per batch, after the full check and before the push: it moves the changelog\'s ## [Unreleased] lines into a new version section, bumps the version in the release files (patch, or the highest of the PRs\' handover release field and flow:minor / flow:major labels) and returns the commit command. It does not commit or push. A second call for the same PRs is refused as already released. With action "publish" (release_github on, after the release commit is pushed) it tags v<version>, pushes the tag and creates the GitHub Release from the changelog section; failures come back as a "Not published" line and never throw.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['cut', 'publish'], description: '"cut" (default): cut the changelog and bump the version. "publish": tag, push the tag and create the GitHub Release for the release commit at HEAD of dir.' },
          dir: { type: 'string', description: 'The reviewer\'s worktree, absolute' },
          prs: { type: 'array', items: { type: 'number' }, description: 'cut: the PR numbers merged in this batch' },
          version: { type: 'string', description: 'publish: the version to publish; default the version of the last cut' },
          recut: { type: 'boolean', description: 'cut: true when rebuilding a batch the user released after the base moved (push_mode confirm): the same PRs are cut again against the new base' },
        },
        required: ['dir'],
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
      name: 'fyi',
      description: 'Record a decision you took yourself on a reversible choice (a threshold, wording, a name, a default, styling within the existing design) as a non-blocking FYI: "I decided X because Y; say if wrong". ' +
        'A worker\'s FYIs go to its manager, a manager\'s to main. Never stop for it: carry on. You get a message only if it is overturned; then change your work. ' +
        'Irreversible or product-defining choices (what customers pay for, who receives data, deleting data) are asks, not FYIs. Main cannot call it.',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Your agent name' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                decision: { type: 'string', description: 'What you decided' },
                why: { type: 'string', description: 'Why that is the conservative choice' },
                alternative: { type: 'string', description: 'Optional: what you would otherwise have done' },
                topic: { type: 'string', description: 'Optional short kebab-case label' },
              },
              required: ['decision', 'why'],
            },
          },
        },
        required: ['from', 'items'],
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
        'FYIs (mcp__flow__fyi) are answered the same way: the choice Keep, or defaults: true, acknowledges; any other choice or free text overturns and messages the owner. Main may answer any FYI. ' +
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
        '"remove": id. Rules without an id are named by file and position: personal:1, repo:2. ' +
        'Instead of an answer, escalate: true makes matching questions blocking and the user\'s alone; answer "default" takes the question\'s own default (non-blocking only). ' +
        '"list" with no rules also offers a few suggested starting rules (not applied); accept with "add" and seed (an id) or seeds (ids).',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'add', 'remove'] },
          topic: { type: 'string' },
          match: { type: 'string' },
          answer: { type: 'string', description: 'An option of the question: its text, letter or number' },
          blocking: { type: 'boolean' },
          escalate: { type: 'boolean', description: 'Instead of an answer: matching questions are never auto-answered, are blocking and only you answer them' },
          from: { type: 'string' },
          id: { type: 'string' },
          seed: { type: 'string', description: `With add: a suggested starting rule by id (${seedIds().join(', ')})` },
          seeds: { type: 'array', items: { type: 'string' }, description: 'With add: several suggested starting rules by id' },
        },
        required: ['action'],
      },
      isDeferred: true,
    })
    await $.tool.register({
      name: 'check',
      description: 'Main only (the reviewer may close checks that carry a verify command). Person checks: the after-deploy checks that need a person, kept across restarts. ' +
        'action "list": the open checks grouped by the plugin version they need, and the open follow-ups. "pass": id or ids. "fail": id and a note (required); it creates a follow-up for you to start a manager on. ' +
        '"started": id of a failed check and manager (the follow-up has a manager now).',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'pass', 'fail', 'started'] },
          id: { type: 'string' },
          ids: { type: 'array', items: { type: 'string' } },
          note: { type: 'string', description: 'fail: what went wrong (required). pass: optional one-line output tail.' },
          manager: { type: 'string', description: 'started: the manager that took the follow-up' },
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
    // 'queue' is the tool's old name: prompts of a reviewer started by an older version still call it.
    for (const name of ['reviewer', 'queue']) await $.tool.register({
      name,
      description: (name === 'queue' ? '(The old name of the reviewer tool; use reviewer.) ' : '') + 'The reviewer\'s worklist. action "list": pending and taken handovers in arrival order. ' +
        '"take" (pr), "done" (pr, sha, report) or "back" (pr, reason) record what the reviewer did. ' +
        'With push_mode confirm, "ready" (prs, sha, base_sha, check, version?) records the checked batch under refs/flow/push/<id> for the user\'s /flow push instead of pushing it. Only the reviewer calls this.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'take', 'done', 'back', 'ready'] },
          pr: { type: 'number' },
          prs: { type: 'array', items: { type: 'number' }, description: 'ready: the PR numbers of the batch' },
          base_sha: { type: 'string', description: 'ready: the full sha of origin/<base> the batch was built on' },
          check: { type: 'string', description: 'ready: one line, the full check result' },
          version: { type: 'string', description: 'ready: the released version, if the batch was released' },
          sha: { type: 'string' },
          report: { type: 'string' },
          reason: { type: 'string' },
          failed_tests: { type: 'array', items: { type: 'string' }, description: 'back: the test files or commands that failed, so main is asked whether workers should run them (guard_tests)' },
        },
        required: ['action'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'push',
      description: 'Main only, on the user\'s word: release the batch the reviewer built, checked and saved because push_mode is confirm. ' +
        'action "list": the ready batch. "push": release it (a reviewer pushes it, deploys and marks the PRs done). "send-back" (pr): return one PR of the batch; the rest is rebuilt, re-checked and asked again. ' +
        '"drop": discard the batch and return every PR. Managers, workers and the reviewer are refused. The user can also run /flow push, or answer the push item in /flow inbox.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'push', 'send-back', 'drop'] },
          pr: { type: 'number', description: 'send-back: the PR number' },
        },
        required: ['action'],
      },
      isDeferred: true,
    })
    await $.tool.register({
      name: 'status',
      description: 'The flow at a glance: managers, workers and reviewer with their status and last report, and handed-over PRs. ' +
        'Scoped by caller: a manager sees its own subtree and PRs, a worker itself and its manager, main and the reviewer everything. ' +
        'Only the newest 5 finished PRs are listed. With pr, that PR in full: its handover line, owner and log lines.',
      inputSchema: { type: 'object', properties: { pr: { type: 'number', description: 'A PR number, to see who owns it' } } },
      isDeferred: false,
    })

    await $.tool.register({
      name: 'deploy',
      description: 'Per-target deploy gates. The reviewer calls action "gate" (target, sha) before each deploy target and gets exactly one of "Go", "Held: <why>" or "Awaits approval: <qid>"; on the last two it skips that target for this batch and goes on. ' +
        'A confirm target opens one inbox item for the user; only the user\'s "deploy" answer lets that sha through. The reviewer calls "deployed" (target, sha, ok) after each target. ' +
        'Main only, on the user\'s word: "hold" (target, until "batch" or "released", reason?) and "release" (target; it also drops env changes the user declined); "demo only, hold production" is a hold on production. "list" shows every target with mode, hold, last deployed sha, how far behind, any approval and pending env changes. ' +
        'Env changes a handed-over PR declared come first in the gate: "Awaits env: <qids>" (the user has not answered; skip the target), "Held: env change NAME declined" (skip it until main releases it), or "Go, first apply env:" with one exact command per change: run each (a non-zero exit fails the target), call "env-applied" (target, names), then deploy.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['gate', 'deployed', 'env-applied', 'hold', 'release', 'list'] },
          names: { type: 'array', items: { type: 'string' }, description: 'env-applied: the env variable names whose commands you ran' },
          target: { type: 'string', description: 'A deploy target name from the deploy_targets setting' },
          sha: { type: 'string', description: 'gate, deployed: the short sha the batch deploys' },
          ok: { type: 'boolean', description: 'deployed: true when every step of the target passed' },
          until: { type: 'string', enum: ['batch', 'released'], description: 'hold: just the next batch, or until released' },
          reason: { type: 'string', description: 'hold: why' },
        },
        required: ['action'],
      },
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
      name: 'migrations',
      description: 'Read-only. Reports migration-number clashes and the next free number, for the migrations_dir setting. ' +
        'Shows the highest number on the base and at ref, and for each PR the migrations it adds: ok, clash (same number as another migration on the base, at ref or in an earlier PR of the list) or at-or-below (not above the base\'s highest). ' +
        'For each non-ok one: the next free number (highest + 1, no gap filling), the git mv to run, and where the PR\'s own files mention the old number. Fetches only; changes nothing.',
      inputSchema: {
        type: 'object',
        properties: {
          prs: { type: 'array', items: { type: 'number' }, description: 'PR numbers in merge order (optional)' },
          ref: { type: 'string', description: 'The batch being built in your cwd (default HEAD)' },
        },
      },
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
      name: 'guard_tests',
      description: 'The repo-wide tests the guard_tests setting requires for your diff. Call it before gh pr create with no arguments: it works out your changed files itself ' +
        '(origin/<base>...HEAD plus uncommitted and untracked changes in your worktree). Run each test it lists under mcp__flow__test_slot and list each under `Ran:` in the PR\'s ## Verification section; handover refuses otherwise.',
      inputSchema: {
        type: 'object',
        properties: { files: { type: 'array', items: { type: 'string' }, description: 'Optional: use these repo-relative paths instead of your diff' } },
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
    $.clock.every(PR_POLL_MS, () => { void fetchPrs($); void refreshBehind($); refreshLeftovers($) })
    void fetchPrs($)
    refreshLeftovers($)
    // One shared tick for every running time on the pane: the render reads `now`, no card has a timer.
    $.clock.every(1000, () => void $.clock.now().then(t => update($, now, () => t)).catch(() => undefined))
    // The reviewer agent type exists only now, and a spawn needs the session bound: start it after the hook.
    if (queueDue) $.clock.after(0, () => void best($, 'starting the reviewer', async () => void (await ensureQueue($))))
    return next(e)
  })

  // A closed pane stays closed: only this command and a newly started agent (openPane) open it,
  // never the roster poll, so `/flow close` holds while agents keep running.
  on('command.run', { command: 'flow' }, async ($, e) => {
    // A plugin's $.command.run may leave args out.
    const arg = (e.args ?? '').trim()
    if (arg === 'inbox' || arg.startsWith('inbox ')) {
      const w = arg.split(/\s+/).slice(1)
      const box = await read($, inbox)
      const now = await $.clock.now()
      if (w.length === 1 && /^q\d+$/i.test(w[0]!)) return { text: renderItem(box, w[0]!, now) }
      if (w.length > 1 || (w.length === 1 && w[0] !== 'all')) return { text: 'Usage: /flow inbox, /flow inbox all (also the older FYIs), /flow inbox <id> (one item in full)' }
      const live = (await $.agent.list()).filter(a => a.name !== undefined && (LIVE.has(a.status) || a.status === 'idle')).map(a => a.name!)
      const sec = inboxChecksSection(await read($, checks), installed)
      return { text: [renderInbox(box, now, { live, all: w.length === 1 }), ...sec].join('\n') }
    }
    if (/^(ok|no|answer)(\s|$)/.test(arg)) {
      const [verb = ''] = arg.split(/\s+/)
      const rest = arg.slice(verb.length).trim()
      const lines: string[] = []
      if (verb === 'ok') {
        const { ids, lines: refused } = expandOk(await read($, inbox), rest === '' ? [] : rest.split(/\s+/))
        lines.push(...refused)
        for (const id of ids) lines.push(await answerQuestion($, id, null, 'main', options))
      } else if (verb === 'no') {
        const m = /^(\S+)(?:\s+([\s\S]+))?$/.exec(rest)
        const q = m === null ? undefined : (await read($, inbox)).items.find(x => x.id === m[1]!.toLowerCase())
        if (m === null) return { text: 'Usage: /flow no <id> [what to do instead]' }
        if (q !== undefined && !isFyi(q)) lines.push(`${q.id}: not an FYI; answer a question with /flow answer ${q.id} <choice>.`)
        else lines.push(await answerQuestion($, m[1]!.toLowerCase(), m[2] ?? OVERTURN, 'main', options))
      } else {
        const m = /^(\S+)\s+([\s\S]+)$/.exec(rest)
        if (m === null) return { text: 'Usage: /flow answer <id> <option letter, number or your own words>' }
        lines.push(await answerQuestion($, m[1]!.toLowerCase(), m[2]!, 'main', options))
      }
      lines.push(stillOpen(await read($, inbox)))
      return { text: lines.join('\n') }
    }
    if (arg === 'checks' || arg.startsWith('checks ')) {
      const w = arg.split(/\s+/).slice(1)
      if (w.length === 0) return { text: renderChecks(await read($, checks), installed) }
      const t = await $.clock.now()
      if (w[0] === 'pass' && w.length > 1) {
        return { text: await withChecks($, cur => {
          const r = closeChecks(cur, w.slice(1), 'pass', 'user', undefined, t)
          return 'error' in r ? { checks: cur, out: `Not closed: ${r.error}` } : { checks: r.checks, out: r.text }
        }) }
      }
      if (w[0] === 'fail' && w.length > 1) {
        return { text: await withChecks($, cur => {
          const r = closeChecks(cur, [w[1]!], 'fail', 'user', w.slice(2).join(' '), t)
          return 'error' in r ? { checks: cur, out: `Not closed: ${r.error}` } : { checks: r.checks, out: `${w[1]} failed; main starts a manager on the follow-up (/flow resume lists it).` }
        }) }
      }
      return { text: 'Usage: /flow checks, /flow checks pass <id...>, /flow checks fail <id> <note>' }
    }
    if (arg === 'status') {
      const lines = await costLines($, Object.values(await read($, handovers)))
      return { text: lines.length > 0 ? lines.join('\n') : 'No agent steps counted yet.' }
    }
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
      // A batch the user has not pushed yet comes first; no manager is started for it.
      const batchLines = pushLines(await read($, pushState))
      const waiting = batchLines.length === 0 ? [] : ['Needs you (a checked batch awaits your push; no manager is started for it):', ...batchLines]
      if (found.error !== undefined && found.items.length === 0) return { text: [...waiting, found.error].join('\n') }
      const lines = (kind: Leftover['kind'], title: string) => {
        const rows = found.items.filter(i => i.kind === kind)
        return rows.length ? [`${title}:`, ...rows.map(i => `  ${i.line}`)] : []
      }
      const again = found.skipped.length ? ['Already resumed in this session:', ...found.skipped.map(i => `  ${i.line}`)] : []
      const checkLines = resumeChecksLines(await read($, checks), installed)
      if (found.items.length === 0) return { text: [...waiting, ...(checkLines.length || waiting.length ? [] : ['Nothing unfinished.']), ...checkLines, ...again].join('\n') }
      const text = [
        ...waiting,
        ...checkLines,
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
    if (words[0] === 'push') {
      // Only a person's command releases a ready batch (or main, on the user's word, with the push tool).
      const usage = 'Usage: /flow push (push the ready batch), /flow push back <pr> (send one PR back), /flow push drop (return them all)'
      if (words.length === 1) return { text: await pushAct($, { kind: 'push' }, 'user') }
      if (words[1] === 'drop' && words.length === 2) return { text: await pushAct($, { kind: 'drop' }, 'user') }
      const n = Number((words[2] ?? '').replace(/^#/, ''))
      if (words[1] === 'back' && words.length === 3 && Number.isInteger(n) && n > 0) return { text: await pushAct($, { kind: 'back', pr: n }, 'user') }
      return { text: usage }
    }
    if (words[0] === 'hold' || words[0] === 'release') {
      // A person's command, the same as the deploy tool is for main.
      const [, name, until] = words
      if (name === undefined || words.length > (words[0] === 'hold' ? 3 : 2) || (until !== undefined && until !== 'batch' && until !== 'released')) {
        return { text: words[0] === 'hold' ? 'Usage: /flow hold <target> [batch|released] (default released)' : 'Usage: /flow release <target>' }
      }
      const text = words[0] === 'hold' ? await holdTarget($, name, until === 'batch' ? 'batch' : 'released', 'user', undefined) : await releaseTarget($, name)
      await refreshBehind($)
      return { text }
    }
    if (arg !== '') return { text: `Unknown argument "${arg}". /flow opens the Flow pane, /flow inbox lists the open questions and FYIs, /flow ok keeps FYIs, /flow no <id> overturns one, /flow answer <id> <choice> answers a question, /flow checks lists the after-deploy checks that need a person, /flow preflight shows the pre-flight round, /flow close closes it, /flow resume picks up unfinished work, /flow approve <pr> lets the reviewer merge a PR that awaits your approval, /flow push starts the push of the batch the reviewer checked (/flow push back <pr> sends one PR back, /flow push drop returns them all), /flow hold <target> [batch|released] keeps a deploy target from deploying and /flow release <target> lets it, /flow clean lists leftover worktrees and branches (/flow clean --yes removes them).` }
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

  on('agent.spawn', async ($, input, next) => {
    let e = input
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
    // Attachments: every listed file must exist, and a relative path becomes absolute here, since the
    // worker runs in another worktree. Before the continue rewrite and the retries, which carry this prompt.
    if (e.subagentType === WORKER || e.subagentType === CONTINUE || e.subagentType === MANAGER) {
      const checked = await checkAttachments($, e.prompt)
      if ('deny' in checked) return { deny: checked.deny }
      if (checked.prompt !== e.prompt) e = { ...e, prompt: checked.prompt }
    }
    if (await fableDenied($, e)) return { deny: FABLE_DENY }
    // Model routing: the brief's Size line (or a successor's escalation) picks the worker's model, over a model param.
    let routed: Routed | undefined
    if (e.subagentType === WORKER) {
      const r = await routeWorker($, e, { small: settings.workerModelSmall ?? 'haiku', normal: settings.workerModelNormal ?? 'sonnet', large: settings.workerModel })
      e = r.e
      routed = r.routed
    } else if (e.subagentType === 'Explore' && e.model === undefined && e.parentAgentId !== undefined) {
      // Read-only exploring by a flow agent runs on the cheap model; main's own and an explicit model stay as they are.
      const parent = (await $.agent.list()).find(a => a.id === e.parentAgentId)
      if (parent !== undefined && FLOW_TYPES.has(parent.type)) e = { ...e, model: settings.exploreModel ?? 'haiku' }
    }
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
      await best($, 'recording an agent in the cost ledger', async () => {
        const name = (e as { name?: string }).name ?? e.description
        const role = (ROLE[e.subagentType] ?? 'other') as Role
        const parent = e.parentAgentId === undefined ? undefined : (await $.agent.list()).find(a => a.id === e.parentAgentId)
        await changeLedger($, (l, now) => setIdentity(l, id, {
          role, name,
          ...(role === 'worker' && parent?.name !== undefined && { manager: parent.name }),
          ...(role === 'worker' && { branch: CONTINUE_LINE.exec(e.prompt)?.[1] ?? `flow/${name}` }),
          ...(typeof used === 'string' && { spawnModel: used }),
          ...(routed !== undefined && { size: routed.size }),
        }, now))
      })
      if (routed !== undefined) {
        const r = routed
        await best($, 'filing a worker-size FYI', () => fileSizeFyi($, options, (e as { name?: string }).name ?? e.description, e.parentAgentId, r))
      }
      if (preflightOn && e.subagentType === MANAGER && e.parentAgentId === undefined) {
        await best($, 'recording a pre-flight', () => recordManager($, (e as { name?: string }).name ?? e.description, e.prompt))
      }
      if (FLOW_TYPES.has(e.subagentType)) {
        await best($, 'logging a spawn', async () => {
          await appendLog($, {
            event: 'spawn', agent: (e as { name?: string }).name ?? e.description, owner: await ownerNameOf($, e.parentAgentId),
            ...(routed !== undefined && { text: `size ${routed.size} -> ${ev.model ?? routed.model}${routed.escalated ? ' (escalated)' : ''}` }),
          })
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
    if (e.tool === 'SendMessage') {
      const input = e as unknown as Record<string, unknown>
      const to = String(input.to ?? '')
      const text = String(input.message ?? input.text ?? '')
      if (id !== undefined && isReviewer((await whoAmI())?.type ?? '')) {
        let handled: string | undefined
        await best($, 'routing a reviewer message', async () => { handled = await reviewerSendGuard($, id, to, text) })
        if (handled !== undefined) return { result: handled }
        if (to === 'main') {
          // Lines the guard already sent main need no second copy; anything new goes through.
          const lines = text.split('\n').map(normText).filter(l => l !== '')
          const sent = (await read($, forwarded)).lines[id] ?? []
          if (lines.length > 0 && lines.every(l => sent.includes(l) || (needLines(l).length > 0 && needLines(l).every(n => sent.includes(n))))) {
            return { result: 'Not sent: main already has this report (the plugin forwarded it). Do not repeat it.' }
          }
        }
      }
      await best($, 'marking a wake-up', async () => {
        const target = (await $.agent.list()).find(a => a.id === to || a.name === to)
        if (target === undefined || target.type !== MANAGER) return
        // The reviewer's message starts the manager's turn: what waited for it rides that turn (turn.step
        // flushes it) instead of waking the manager a second time just before. A timer covers a message that never lands.
        if (id !== undefined && isReviewer((await whoAmI())?.type ?? '')) holdForReviewer($, target.id)
        if (id === undefined) wokenByOthers.delete(target.id)
        else if (target.status !== 'running') wokenByOthers.add(target.id)
      })
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
    if (!settings.useReviewer) {
      return { result: `Refused: this repo has no reviewer (the plugin's reviewer option is off). Merge it yourself: full check, then gh pr merge ${pr} --${settings.mergeMethod} --delete-branch.` }
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
    if ((await read($, handovers))[String(pr)]?.status === 'ready') {
      return { result: `Refused: PR #${pr} is in a batch that awaits the user's /flow push. Leave it alone; if the user sends it back you hear so.` }
    }
    const dest = await resolveReportTo($, input.report_to, e.agentId)
    if ('refuse' in dest) return { result: dest.refuse }
    const envParsed = parseEnvInput(input.env, deployInfos)
    if ('error' in envParsed) return { result: `Refused: ${envParsed.error}` }
    // Guard tests: from the PR's changed files (`gh pr diff` has no file-count cap). Never fail open, never block for good.
    let guard: ReturnType<typeof guardTestsFor> = []
    if (Object.keys(settings.guardTests).length > 0) {
      const diff = await $.process.run(['gh', 'pr', 'diff', String(pr), '--name-only'])
      if (diff.exitCode !== 0) return { result: `Refused: gh pr diff ${pr} --name-only failed, so the guard tests cannot be checked: ${diff.stderr.trim().slice(0, 300)}` }
      guard = guardTestsFor(diff.stdout.split('\n').map(l => l.trim()).filter(Boolean), settings.guardTests)
    }
    const checked = checkEvidence(info.body ?? '', [...settings.workerChecks, ...settings.alwaysTests], guard)
    if ('problems' in checked) return { result: evidenceRefusal(pr, checked.problems) }
    const t = await $.clock.now()
    const h: Handover = {
      pr, title: info.title, head: info.headRefOid, branch: info.headRefName,
      reportTo: dest.name, verified: String(input.verified ?? ''),
      pending: String(input.pending ?? 'none'), afterDeploy: String(input.after_deploy ?? 'none'),
      ...(typeof input.verify_command === 'string' && input.verify_command.trim() !== '' ? { verifyCommand: input.verify_command.trim() } : {}),
      evidence: checked.evidence, status: 'pending', at: t, ...(asked !== undefined ? { mode: asked } : {}),
      ...(isBump(input.release) ? { release: input.release } : {}),
    }
    // A labelling failure is reported, not fatal: the stored mode still gates the reviewer.
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
    const envNote = await openHandoverEnv($, options, h, envParsed.drafts, (await read($, handovers))[String(pr)]?.env ?? [], t)
    await update($, handovers, hs => ({ ...hs, [String(pr)]: h }))
    await best($, 'saving a handover', async () => {
      await saveHandover($, h)
      await appendLog($, { event: 'handover', owner: h.reportTo, pr, branch: h.branch, text: h.title })
    })
    if (hold) {
      void $.ui.toast(`PR #${pr} awaits your approval: /flow approve ${pr}`)
      await refresh($)
      return { result: `Handed over PR #${pr} at ${info.headRefOid.slice(0, 8)}, but it awaits the user's approval: the reviewer will not merge it until the user runs /flow approve ${pr}. Tell the user so in your report.${labelNote}${envNote}` }
    }
    const queue = await ensureQueue($)
    await refresh($)
    return { result: `Handed over PR #${pr} at ${info.headRefOid.slice(0, 8)}. ${queue} The reviewer reports back to ${h.reportTo} by message.${dest.note ?? ''}${labelNote}${envNote}` }
  })

  on('tool.call', { tool: 'mcp__flow__release' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    if (!settings.release) return { result: 'Refused: the release setting is off, so nothing is released. Skip the release step.' }
    const dir = String(input.dir ?? '').replace(/\/+$/, '')
    if (input.action === 'publish') return { result: await publishRelease($, settings, dir, typeof input.version === 'string' ? input.version.replace(/^v/, '') : undefined) }
    const prs = Array.isArray(input.prs) ? input.prs.map(Number).filter(n => Number.isInteger(n) && n > 0) : []
    if (!dir.startsWith('/')) return { result: 'Refused: dir must be the absolute path of your worktree.' }
    if (prs.length === 0) return { result: 'Refused: prs must list the PR numbers merged in this batch.' }
    const key = [...new Set(prs)].sort((a, b) => a - b).join(',')
    const stateD = await stateDir($)
    let last = lastRelease
    if (last === undefined && stateD !== undefined) {
      const disk = await readJson($, `${stateD}/release.json`) as { key?: string; version?: string } | undefined
      if (typeof disk?.key === 'string' && typeof disk.version === 'string') last = { key: disk.key, version: disk.version }
    }
    // A batch the user released that went stale (the base moved) is built and released again: that re-cut is allowed.
    const open = (await read($, pushState)).batch
    const recut = input.recut === true && open !== undefined && open.state !== 'ready'
    if (last?.key === key && !recut) return { result: `Refused: already released ${last.version} for PRs ${key.replaceAll(',', ', ')}. The release commit is in your worktree; go on to the push.` }
    let files = settings.releaseFiles ?? []
    if (files.length === 0 && await $.fs.exists(`${dir}/package.json`)) files = ['package.json']
    if (files.length === 0) return { result: 'Refused: no version file. Set release_files (repo-relative JSON or TOML files) in .claude/flow.json, or add a package.json at the repo root; a release without a version is meaningless.' }
    const logName = settings.changelogFile || 'CHANGELOG.md'
    if (!(await $.fs.exists(`${dir}/${logName}`))) return { result: `Refused: the changelog ${logName} does not exist in ${dir}; create it or set changelog_file.` }
    const all = await read($, handovers)
    const asked: (Bump | undefined)[] = []
    const titles: string[] = []
    let ghNote = ''
    for (const pr of prs) {
      const h = all[String(pr)]
      asked.push(h?.release)
      titles.push(`- ${h?.title ?? 'PR'} (#${pr})`)
      const v = await $.process.run(['gh', 'pr', 'view', String(pr), '--json', 'labels'])
      let names: string[] | undefined
      if (v.exitCode === 0) {
        try { names = ((JSON.parse(v.stdout) as { labels?: { name: string }[] }).labels ?? []).map(l => l.name) } catch { names = undefined }
      }
      if (names === undefined) ghNote = ' gh could not read some PR labels; those PRs counted by their handover release field only.'
      else asked.push(labelBump(names))
    }
    const kind = highestBump(asked)
    try {
      const texts = await Promise.all(files.map(f => $.fs.read(`${dir}/${f}`)))
      const next = bumpVersion(readVersion(texts[0]!, files[0]!), kind)
      const date = localDate(await $.clock.now())
      const log = cutChangelog(await $.fs.read(`${dir}/${logName}`), next, date, titles)
      const updated = files.map((f, i) => setVersion(texts[i]!, f, next))
      for (const [i, f] of files.entries()) await $.fs.write(`${dir}/${f}`, updated[i]!)
      await $.fs.write(`${dir}/${logName}`, log)
      lastRelease = { key, version: next }
      if (stateD !== undefined) await writeJsonAtomic($, `${stateD}/release.json`, lastRelease)
      return { result: `Released ${next} (${kind} bump from ${readVersion(texts[0]!, files[0]!)}). Changed: ${[...files, logName].join(', ')}.${ghNote} Now run: git -C ${dir} commit -am "Release ${next}" (add your attribution lines), then push as usual.` }
    } catch (err) {
      return { result: `Refused: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  for (const tool of ['mcp__flow__reviewer', 'mcp__flow__queue'] as const) on('tool.call', { tool }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const action = String(input.action)
    const all = await read($, handovers)
    // While a batch exists the reviewer sees it, not the pending handovers: they go in after the push run.
    const batch = (await read($, pushState)).batch
    if (action === 'list') {
      if (batch !== undefined) return { result: reviewerNote(batch) }
      const open = Object.values(all).filter(h => h.status === 'pending' || h.status === 'taken').sort((a, b) => a.at - b.at)
      if (open.length === 0) return { result: 'No pending handovers.' }
      const d = await read($, deploys)
      const ib = await read($, inbox)
      const envText = (h: Handover, dd: Deploys, inb: Inbox) => (h.env === undefined || h.env.length === 0 ? '' : ` | env: ${envSummary(h, t => dd.targets[t], itemViewOf(inb))}`)
      return {
        result: open.map(h =>
          `#${h.pr} ${h.status}: "${h.title}" branch ${h.branch} head ${h.head} | report_to: ${h.reportTo} | verified: ${h.verified} | evidence: ${evidenceText(h.evidence)} | pending decisions: ${h.pending} | after deploy: ${h.afterDeploy}${h.release === undefined ? '' : ` | release: ${h.release}`}${envText(h, d, ib)}`,
        ).join('\n'),
      }
    }
    if (e.agentId !== undefined) reviewerWork.set(e.agentId, noteWork(reviewerWork.get(e.agentId), action))
    if (action === 'ready') return { result: await recordReady($, settings, input) }
    const key = String(Number(input.pr))
    const h = all[key]
    if (h === undefined) return { result: `No handover for PR #${key}.` }
    if (action === 'take' && batch !== undefined && (h.status === 'pending' || batch.state === 'ready')) {
      return { result: `Held: batch ${batch.id} ${batch.state === 'ready' ? 'awaits the user\'s /flow push' : 'is being pushed or rebuilt'}; PR #${key} waits behind it. Do not take it and do not send it back; end your run when your own work is done.` }
    }
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
      : action === 'done' ? { ...h, status: 'done', sha: String(input.sha ?? ''), report: await withCost($, h.branch, String(input.report ?? '')) }
      : action === 'back' ? { ...h, status: 'returned', reason: String(input.reason ?? '') }
      : h
    if (next === h) return { result: `Unknown action "${action}".` }
    await update($, handovers, hs => ({ ...hs, [key]: next }))
    await best($, 'saving a handover', async () => {
      await saveHandover($, next)
      const text = action === 'done' ? next.report : action === 'back' ? next.reason : undefined
      await appendLog($, { event: action as 'take' | 'done' | 'back', owner: next.reportTo, pr: next.pr, branch: next.branch, text })
    })
    if (action === 'back') await closeReturnedEnv($, next)
    if (action === 'done' || action === 'back') await settleBatch($)
    if (action !== 'take') void $.ui.toast(`PR #${key} ${next.status === 'done' ? `merged ${next.sha ?? ''}` : `returned: ${next.reason ?? ''}`}`)
    if (action === 'done') autoSweep($)
    let verify = ''
    if (action === 'done') {
      // The push already happened; the isolated reviewer cannot touch the main checkout, so the plugin does.
      const line = await serialFastForward(argv => $.process.run(argv), settings.base)
      if (e.agentId !== undefined) reviewerWork.set(e.agentId, { ...(reviewerWork.get(e.agentId) ?? { touched: true, ready: false }), touched: true, line })
      await best($, 'logging the main checkout', () => appendLog($, { event: 'main-ff', owner: next.reportTo, pr: next.pr, branch: next.branch, text: line }))
      verify = ` ${line}: copy this exact line into your final report; never run git against the main checkout yourself.`
      await best($, 'capturing checks', async () => {
        const added = await captureChecks($, next, settings.verifyPaths, true)
        const scripted = added.filter(c => c.verifyCommand !== undefined)
        verify += scripted.map(c => ` Run \`${c.verifyCommand}\` in your worktree at the merged main now; on exit 0 call mcp__flow__check action pass id ${c.id} with a one-line note of the output tail; on failure call action fail with the failure tail as the note.`).join('')
        const skipped = added.filter(c => c.note !== undefined && c.verifyCommand === undefined)
        if (skipped.length) verify += ` Scripted verification is skipped for ${skipped.map(c => c.id).join(', ')} (${SKIP_NOTE.replace('scripted verification skipped: ', '')}); the check stays open for a person.`
      })
    }
    const rows = await refresh($)
    const filed = action === 'back' ? await suggestGuardTests($, input, next.pr, rows.find(a => a.id === e.agentId)?.name ?? 'reviewer', e.agentId, settings.guardTests) : ''
    const size = action === 'back' ? await sizeBackNote($, next.branch) : undefined
    const sizeLine = size === undefined ? '' : `\nPut this line in your message to ${next.reportTo}: ${size}`
    return { result: `PR #${key}: ${next.status}.${verify}${filed}${sizeLine}` }
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

  on('tool.call', { tool: 'mcp__flow__guard_tests' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const map = settings.guardTests
    if (Object.keys(map).length === 0) return { result: guardReport([], false) }
    let files: string[]
    if (Array.isArray(input.files)) files = input.files.filter((f): f is string => typeof f === 'string')
    else {
      // The caller's own worktree, else the session's directory.
      let dir: string | undefined
      if (e.agentId !== undefined) {
        const me = (await $.agent.list()).find(a => a.id === e.agentId)
        const wt = await $.process.run(['git', 'worktree', 'list', '--porcelain']).catch(() => undefined)
        if (me !== undefined && wt?.exitCode === 0) dir = findWorktree(wt.stdout, me.id, `flow/${me.name ?? me.id}`)?.path
      }
      dir ??= await $.session.cwd().catch(() => undefined)
      const git = (...args: string[]) => $.process.run(['git', ...(dir === undefined ? [] : ['-C', dir]), ...args])
      const diff = await git('diff', '--name-only', '--no-renames', `origin/${settings.base}...HEAD`)
      if (diff.exitCode !== 0) return { result: `Could not work out your diff (git diff origin/${settings.base}...HEAD failed: ${diff.stderr.trim().slice(0, 300)}). Call again with files: [...].` }
      const dirty = await git('status', '--porcelain', '--untracked-files=all')
      files = [...diff.stdout.split('\n').map(l => l.trim()).filter(Boolean), ...(dirty.exitCode === 0 ? pathsFromStatus(dirty.stdout) : [])]
    }
    return { result: guardReport(guardTestsFor(files, map), true) }
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
      const r = autoAnswer(cur, addQuestions(cur, { name, id: e.agentId, isManager: me?.type === MANAGER }, addressee, parsed.questions, at), rules, at, true)
      return { inbox: r.inbox, out: { added: r.added, auto: r.hits } }
    })
    await recordAutoAnswers($, added, auto, name)
    const date = await today($)
    for (const { q, fresh } of added) {
      const owner = notesOwner(q)
      if (fresh && !auto.has(q.id) && !q.blocking && owner !== 'main') {
        await appendNote($, owner, `- ${date} progress: assumed ${q.default} for ${q.id}: ${q.question}`)
      }
    }
    const fresh = added.filter(a => a.fresh && !auto.has(a.q.id)).map(a => a.q)
    if (addressee !== 'main' && fresh.length > 0 && parent !== undefined) {
      const lines = fresh.map(q =>
        `${name} asks ${q.id} (${q.blocking ? 'blocking' : 'non-blocking'}): ${q.question} - options ` +
        `${q.options.map((o, i) => `${String.fromCharCode(97 + i)}) ${o}`).join(' ')} (default: ${q.default})` +
        (q.escalated !== undefined ? ` - a standing rule (${q.escalated}) makes this the user's decision; it is in main's inbox as ${q.id}, main answers it directly and the worker gets the answer; don't answer or re-ask it.` : ''))
      await deliver($, parent.id, `${lines.join('\n')}\nAnswer with mcp__flow__answer.`, { held: !fresh.some(q => q.blocking), urgent: fresh.some(q => q.blocking) }).catch(() => undefined)
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

  on('tool.call', { tool: 'mcp__flow__fyi' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    if (e.agentId === undefined) return { result: 'Refused: main cannot record an FYI; just decide.' }
    const parsed = parseFyi(input)
    if ('error' in parsed) return { result: `Refused, nothing recorded: ${parsed.error}` }
    const rows = await refresh($)
    const me = rows.find(a => a.id === e.agentId)
    const name = me?.name ?? (String(input.from ?? '').trim() || 'unknown')
    const parent = me?.parentId === undefined ? undefined : rows.find(a => a.id === me.parentId)
    const addressee = parent !== undefined && parent.type === MANAGER && parent.name !== undefined ? parent.name : 'main'
    const at = await $.clock.now()
    const added = await withInbox($, cur => {
      const r = addQuestions(cur, { name, id: e.agentId, isManager: me?.type === MANAGER }, addressee, parsed.items.map(fyiAsked), at, 'fyi')
      return { inbox: r.added.some(a => a.fresh) ? r.inbox : cur, out: r.added }
    })
    // Quiet by design: a log line, no message or toast.
    await best($, 'logging an FYI', () => appendLog($, { event: 'fyi', owner: noteKey(name), agent: name, text: added.map(a => a.q.id).join(' ') }))
    return { result: `Recorded ${added.map(a => a.q.id).join(', ')}. Carry on; you get a message only if it is overturned.` }
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
    // Same standing-answer check as ask: a fresh question a rule matches is answered at once, so it is not
    // open, never gates the manager and stays out of the round.
    const { rules } = await loadRules($, options)
    // A filing is often sent again whole, and an answered question no longer dedupes in addQuestions: one
    // already answered for this manager (by a rule or by main) is reported again, not stored again, so it
    // neither re-gates the manager nor asks the user twice.
    const norm = (t: string) => t.trim().replace(/\s+/g, ' ').toLowerCase()
    const { added, auto, earlier } = parsed.questions.length === 0 ? { added: [], auto: new Map() as AutoHits, earlier: [] as string[] } : await withInbox($, cur => {
      const before = (text: string) => cur.items.find(x => x.owner === name && x.state === 'answered' && norm(x.question) === norm(text))
      const fresh = parsed.questions.filter(a => before(a.question) === undefined)
      const earlier = parsed.questions.flatMap(a => { const x = before(a.question); return x === undefined ? [] : [`${x.id} already answered${x.answeredBy === AUTO ? ` by standing answer ${x.rule ?? '?'}` : ''}: ${x.answer ?? ''}`] })
      const r = autoAnswer(cur, addQuestions(cur, { name, id: e.agentId, isManager: true }, 'main', fresh, at), rules, at)
      return { inbox: r.inbox, out: { added: r.added, auto: r.hits, earlier } }
    })
    await recordAutoAnswers($, added, auto, name)
    const kept = added.filter(a => !auto.has(a.q.id))
    const ids = { asked: kept.map(a => a.q.id), blocking: kept.filter(a => a.q.blocking).map(a => a.q.id) }
    const answered = [...earlier, ...added.filter(a => auto.has(a.q.id)).map(a => `${a.q.id} by standing answer ${auto.get(a.q.id)!.rid}: ${auto.get(a.q.id)!.answer}`)]
    const answeredLine = answered.length > 0 ? ` Answered, carry on from them: ${answered.join('; ')}.` : ''
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
        ? `Pre-flight filed. Start your workers now.${answeredLine}${ids.asked.length > 0 ? ` Your non-blocking question(s) ${ids.asked.join(', ')} are with main: go on the defaults, say so in your PRs; you get a message if an answer differs.` : ''}`
        : `Pre-flight filed with blocking question(s) ${ids.blocking.join(', ')}. End your turn now: main answers once for all managers and the answers arrive by message. Then start workers.${answeredLine}`,
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
      lines.push(await answerQuestion($, id, choice, by, options))
      if (always.has(id) && choice !== null && before !== undefined && !isFyi(before)) lines.push(await alwaysRule($, options, id, choice, e.agentId === undefined, before))
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
      return { result: renderRules(rules, box, suggest(box, rules), seedsToOffer(rules)) }
    }
    if (action === 'add' && (input.seed !== undefined || input.seeds !== undefined)) {
      const want = [...new Set([...(typeof input.seed === 'string' ? [input.seed] : []), ...(Array.isArray(input.seeds) ? input.seeds.map(String) : [])].map(s => s.trim()))]
      const bad = want.filter(id => !SEEDS.some(s => s.id === id))
      if (bad.length > 0 || want.length === 0) return { result: `Refused: unknown seed ${bad.map(b => `"${b}"`).join(', ') || '(none given)'}. The ids are ${seedIds().join(', ')}; nothing added.` }
      const date = await today($)
      const out: string[] = []
      for (const id of want) {
        const seed = SEEDS.find(s => s.id === id)!
        const r = await addRule($, options, { ...seed.rule, note: `seed ${id}, added ${date}` })
        out.push(r.kind === 'error' ? `${id}: not added: ${r.msg}`
          : r.kind === 'exists' ? `${id}: already there as rule ${r.id}; nothing added.`
            : `${id}: rule ${r.id} added to the personal file. Revoke with mcp__flow__standing {"action":"remove","id":"${r.id}"}.`)
      }
      return { result: out.join('\n') }
    }
    if (action === 'add') {
      const v = validateRule({
        topic: input.topic, match: input.match, answer: input.answer, escalate: input.escalate, blocking: input.blocking, from: input.from,
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

  on('tool.call', { tool: 'mcp__flow__check' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const me = e.agentId === undefined ? undefined : (await $.agent.list()).find(a => a.id === e.agentId)
    const isMain = e.agentId === undefined
    if (!isMain && !(me && isReviewer(me.type))) return { result: 'Refused: only main closes person checks. Tell main in your report.' }
    const action = String(input.action ?? 'list')
    if (action === 'list') return { result: renderChecks(await read($, checks), installed) }
    const t = await $.clock.now()
    if (action === 'pass' || action === 'fail') {
      const ids = Array.isArray(input.ids) ? input.ids.map(String) : typeof input.id === 'string' ? [input.id] : []
      const by = isMain ? 'main' : (me?.name ?? 'reviewer')
      const note = typeof input.note === 'string' ? input.note : undefined
      return { result: await withChecks($, cur => {
        const r = closeChecks(cur, ids, action, by, note, t, !isMain)
        return 'error' in r ? { checks: cur, out: `Refused: ${r.error}` } : { checks: r.checks, out: r.text }
      }) }
    }
    if (action === 'started') {
      if (!isMain) return { result: 'Refused: only main marks a follow-up started.' }
      return { result: await withChecks($, cur => {
        const r = markStarted(cur, String(input.id ?? ''), String(input.manager ?? ''))
        return 'error' in r ? { checks: cur, out: `Refused: ${r.error}` } : { checks: r.checks, out: r.text }
      }) }
    }
    return { result: 'Unknown action: use list, pass, fail or started.' }
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

  on('tool.call', { tool: 'mcp__flow__migrations' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const dir = cleanDir(settings.migrationsDir)
    if (dir === '') return { result: UNSET_TEXT }
    const ref = typeof input.ref === 'string' && input.ref.trim() !== '' ? input.ref.trim() : 'HEAD'
    const prs = Array.isArray(input.prs) ? input.prs.filter((n): n is number => Number.isInteger(n)) : []
    const base = settings.base
    const git = (...argv: string[]) => runCmd($, ['git', ...argv])
    const lines = async (...argv: string[]) => {
      const r = await git(...argv)
      return r.exitCode === 0 ? r.stdout.split('\n').filter(l => l !== '') : []
    }
    const fetched = await git('fetch', 'origin', base)
    if (fetched.exitCode !== 0) return { result: `Cannot read the base: git fetch origin ${base} failed: ${fetched.stderr.trim().split('\n')[0]?.slice(0, 200) ?? ''}` }
    const baseRef = `origin/${base}`
    // A dir missing on the base or at ref (a new repo) lists nothing: numbering starts from the PR's own.
    const baseFiles = await lines('ls-tree', '-r', '--name-only', baseRef, '--', dir)
    const refFiles = await lines('ls-tree', '-r', '--name-only', ref, '--', dir)

    const heads = new Map<number, string>()
    const inputs: PrInput[] = []
    for (const pr of prs) {
      const fail = (error: string) => inputs.push({ pr, added: [], error })
      const view = await runCmd($, ['gh', 'pr', 'view', String(pr), '--json', 'headRefOid'])
      const head = view.exitCode === 0 ? (JSON.parse(view.stdout || '{}') as { headRefOid?: string }).headRefOid : undefined
      if (head === undefined || head === '') { fail(`gh pr view failed: ${view.stderr.trim().split('\n')[0]?.slice(0, 200) || 'no head'}`); continue }
      const pull = await git('fetch', 'origin', `pull/${pr}/head`)
      if (pull.exitCode !== 0) { fail(`head ${head.slice(0, 9)} not fetchable: ${pull.stderr.trim().split('\n')[0]?.slice(0, 200) ?? ''}`); continue }
      heads.set(pr, head)
      inputs.push({ pr, added: await lines('diff', '--name-only', '--diff-filter=A', `${baseRef}...${head}`, '--', dir) })
    }

    const report = analyze({ dir, baseFiles, refFiles, prs: inputs })
    // Only a flagged migration needs the PR's own files read for mentions of its old number.
    for (const p of report.prs) {
      const head = heads.get(p.pr)
      if (head === undefined || p.migrations.every(m => m.status === 'ok')) continue
      const files: Array<{ path: string; text: string }> = []
      for (const path of (await lines('diff', '--name-only', '--diff-filter=AM', `${baseRef}...${head}`)).slice(0, 300)) {
        const shown = await git('show', `${head}:${path}`)
        if (shown.exitCode === 0) files.push({ path, text: shown.stdout })
      }
      for (const m of p.migrations) if (m.status !== 'ok') m.refs = findRefs(m, files)
    }
    return { result: render(report) }
  })

  on('tool.call', { tool: 'mcp__flow__session' }, async ($, e) => {
    const id = e.agentId
    const caller: Caller = id === undefined ? { id: 'main', name: 'main' } : { id, name: await ownerNameOf($, id) }
    return { result: await sessionTool($, e as unknown as Record<string, unknown>, caller, settings) }
  })

  on('tool.call', { tool: 'mcp__flow__deploy' }, async ($, e) => {
    const isMain = e.agentId === undefined
    const caller = isMain ? 'main' : await ownerNameOf($, e.agentId!)
    return { result: await deployTool($, options, e as unknown as Record<string, unknown>, isMain, caller) }
  })

  on('tool.call', { tool: 'mcp__flow__push' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    if (e.agentId !== undefined) return { result: 'Refused: only main releases a ready batch, on the user\'s word (or the user, with /flow push). Managers, workers and the reviewer cannot push it.' }
    const action = String(input.action ?? 'list')
    if (action === 'list') {
      const lines = pushLines(await read($, pushState))
      return { result: lines.length === 0 ? 'Nothing ready to push.' : lines.join('\n') }
    }
    if (action === 'push') return { result: await pushAct($, { kind: 'push' }, 'main') }
    if (action === 'drop') return { result: await pushAct($, { kind: 'drop' }, 'main') }
    if (action === 'send-back') {
      const pr = Number(input.pr)
      if (!Number.isInteger(pr) || pr <= 0) return { result: 'Refused: send-back needs pr, a PR number of the batch.' }
      return { result: await pushAct($, { kind: 'back', pr }, 'main') }
    }
    return { result: 'Unknown action: use list, push, send-back or drop.' }
  })

  on('tool.call', { tool: 'mcp__flow__status' }, async ($, e) => {
    const asked = Number((e as unknown as Record<string, unknown>).pr)
    if (Number.isInteger(asked) && asked > 0) {
      const h = (await read($, handovers))[String(asked)]
      const events = await readLog($)
      const owner = ownerFor(events, { pr: asked, branch: h?.branch }) ?? h?.reportTo ?? 'unknown'
      const mine = events.filter(l => l.pr === asked || (h !== undefined && l.branch === h.branch))
      return {
        result: [...(h === undefined ? [] : [handoverLine(h)]), `Owner of PR #${asked}: ${owner}`, ...mine.map(l => `${l.ts} ${l.event}${l.agent ? ` ${l.agent}` : ''}${l.text ? `: ${l.text}` : ''}`)].join('\n'),
      }
    }
    if (queueOn && (await $.clock.now()) - (await read($, prCache)).fetchedAt > PR_MIN_GAP_MS) await fetchPrs($)
    const [allRows, acts, allHs] = await Promise.all([refresh($), read($, activity), read($, handovers)])
    // What the caller needs, so the result it keeps in its context stays small: a manager sees its own
    // subtree and PRs, a worker itself and its manager. Main, the reviewer (it works the whole queue) and
    // an unknown caller see everything.
    const me = e.agentId === undefined ? undefined : allRows.find(r => r.id === e.agentId)
    const scope: 'all' | 'manager' | 'worker' = me === undefined ? 'all' : me.type === MANAGER ? 'manager' : WORKERS.has(me.type) ? 'worker' : 'all'
    const mine = new Set<string>(me === undefined ? [] : [me.id])
    // A successor (x-2) has no parent link to x's workers: seed with every manager of the same base name.
    if (scope === 'manager') for (const r of allRows) if (r.type === MANAGER && r.name !== undefined && baseName(r.name) === baseName(me?.name ?? '')) mine.add(r.id)
    if (scope === 'manager') for (let grew = true; grew;) { grew = false; for (const r of allRows) if (r.parentId !== undefined && mine.has(r.parentId) && !mine.has(r.id)) { mine.add(r.id); grew = true } }
    if (scope === 'worker' && me?.parentId !== undefined) mine.add(me.parentId)
    const rows = scope === 'all' ? allRows : allRows.filter(r => mine.has(r.id))
    const myBase = baseName(me?.name ?? '')
    const hs = scope === 'all' ? allHs : scope === 'manager' ? Object.fromEntries(Object.entries(allHs).filter(([, h]) => baseName(h.reportTo) === myBase)) : {}
    const [unhanded, cache] = scope === 'all' ? [await currentUnhanded($), await read($, prCache)] : [[], await read($, prCache)]
    const leftover = scope === 'all' ? leftoverLine(await read($, leftovers)) : ''
    const costs = scope === 'worker' ? [] : await costLines($, Object.values(hs), scope === 'manager'
      ? en => (en.role === 'manager' ? baseName(en.name) : en.role === 'worker' && en.manager !== undefined ? baseName(en.manager) : undefined) === myBase
      : undefined)
    const led = await read($, ledger)
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
    const { shown, hidden } = cappedHandovers(list)
    const plans = scope === 'worker' ? [] : Object.entries(await read($, plan)).filter(([who, g]) => Object.keys(g).length > 0 && (scope === 'all' || baseName(who) === myBase))
    const slots = scope === 'worker' ? '' : slotLine(await read($, testSlots), settings.testSlots, await $.clock.now())
    const seeds = e.agentId === undefined ? await offerSeedsOnce($, options) : []
    const gate = scope === 'all' ? (await read($, pushState)).batch : undefined
    const batchLines = gate?.state === 'ready' ? renderBatch(gate) : []
    const pushing = gate !== undefined && gate.state !== 'ready' ? renderBatch(gate) : []
    return {
      result: [
        ...(scope === 'all' ? [
          ...inboxHead(await read($, inbox), await $.clock.now()),
          ...seeds,
          ...behindLines(deployInfos, await read($, deploys), await read($, behind)).map(l => `Deploy: ${l}`),
        ] : []),
        ...(scope === 'worker' ? [] : [limitsLine(allRows, settings.maxWorkers)]),
        ...(slots ? [slots] : []),
        rows.length ? 'Agents:' : 'No agents in this session.', ...lines,
        ...(scope === 'worker' ? [] : [
          list.length ? 'Handed-over PRs:' : 'No PRs handed over.',
          ...shown.map(h => `${handoverLine(h, FINISHED_REPORT_MAX)}${h.report?.includes('| cost:') ? '' : reportSuffix(prCost(led, h.branch))}`),
          ...(hidden > 0 ? [`+${hidden} earlier finished PRs (mcp__flow__status pr:<n> for one)`] : []),
        ]),
        ...(unhanded.length ? [
          'Needs attention:', ...unhanded.map(u => `  ${unhandedLine(u)}`),
          'A manager reviews it and hands it over, or closes it.',
        ] : []),
        ...(list.some(h => h.status === 'awaiting') || batchLines.length > 0 ? [
          'Needs the user:',
          ...batchLines.map(l => `  ${l}`),
          ...list.filter(h => h.status === 'awaiting').map(h => `  #${h.pr} awaits approval: /flow approve ${h.pr} — ${h.title}`),
        ] : []),
        ...(pushing.length > 0 ? ['Push gate:', ...pushing.map(l => `  ${l}`)] : []),
        ...(scope === 'all' && queueOn && cache.error !== undefined ? [`Open PRs not checked: gh pr list failed: ${cache.error}`] : []),
        ...(leftover ? [leftover] : []),
        ...(plans.length ? ['Plans:', ...plans.flatMap(([who, g]) => [`${who}:`, ...describe(g).map(l => `  ${l}`)])] : []),
        ...costs,
        ...(scope === 'all' ? [`State: ${await stateDir($) ?? 'none (not a git repo)'}`] : []),
      ].join('\n'),
    }
  })
  // Main can't be replaced like a worker: one warning per crossing, never an auto-compact.
  // Re-armed when usage drops back below the threshold (after a /compact).
  const mainWarn = { warned: false }

  // Context used by a subagent: the input side of its latest step. Observe only; the step passes untouched.
  on('turn.step', async function* ($, e, next) {
    // The agent is running now: texts held for it ride along.
    if (e.agentId !== undefined) await flushAgent($, e.agentId).catch(() => undefined)
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
    try {
      if (r?.usage) {
        const key = e.agentId ?? await mainKey($)
        const model = r.usage.model || e.model
        await loadLedger($)
        // A step that arrives before its spawn was seen takes its identity from the roster.
        let who: { role: Role; name: string; manager?: string; branch?: string } | undefined
        if (e.agentId !== undefined && (await read($, ledger))[key] === undefined) {
          const all = await $.agent.list()
          const me = all.find(a => a.id === e.agentId)
          if (me) {
            const role = (ROLE[me.type] ?? 'other') as Role
            const parent = all.find(a => a.id === me.parentId)
            const name = labelOf(me)
            who = { role, name, ...(role === 'worker' && parent?.name !== undefined && { manager: parent.name }), ...(role === 'worker' && { branch: `flow/${name}` }) }
          }
        }
        await changeLedger($, (l, now) => addStep(l, key, model, r.usage, who, now))
      }
    } catch {
      // The ledger is best-effort: the step passes untouched.
    }
    return r
  })

  // Every completed turn (interrupted or errored too: it still wrote the cache) counts once per agent.
  const countedTurns = new Set<string>()
  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    try {
      const turnId = (e as { turnId?: string }).turnId
      const key = id ?? await mainKey($)
      const once = turnId === undefined || !countedTurns.has(`${key}:${turnId}`)
      if (turnId !== undefined) countedTurns.add(`${key}:${turnId}`)
      if (once) {
        await loadLedger($)
        await changeLedger($, (l, now) => addTurn(l, key, now))
      }
    } catch {
      // The ledger is best-effort: the turn passes untouched.
    }
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
          const full = isReviewer(me.type) ? reviewerReport(e.answer, reviewerWork.get(id)) : undefined
          await appendLog($, { event: 'report', agent: me.name, owner: rows.find(a => a.id === me.parentId)?.name ?? 'main', text: full ?? last }, full === undefined ? TEXT_MAX : 4000)
        })
      }
      // No host notification reaches main for a reviewer the plugin spawned: relay its whole report,
      // only for runs that did batch work.
      if (me !== undefined && isReviewer(me.type)) {
        const work = reviewerWork.get(id)
        reviewerWork.delete(id)
        const full = reviewerReport(e.answer, work)
        if (full !== undefined) {
          $.clock.after(RELAY_DELAY_MS, () => void (async () => {
            if (!(await mainHasAnswer($, e.answer))) toMain($, `Report from reviewer ${me.name}:\n${full}`)
          })().catch(() => undefined))
        }
      }
      // A manager someone other than main woke: the host returned its answer to that agent, so main
      // gets it here (once; main's own wake-ups never set the mark).
      if (me?.type === MANAGER && wokenByOthers.delete(id) && e.answer.trim() !== '') {
        const answer = e.answer.trim()
        // The host may deliver the answer to main itself (a task notification): give it a moment to land,
        // then relay only when main's transcript lacks it.
        $.clock.after(RELAY_DELAY_MS, () => void (async () => {
          if (!(await mainHasAnswer($, answer))) toMain($, `Report from manager ${me.name}:\n${answer}`)
        })().catch(() => undefined))
      }
      // `HANDOFF: manager <name>` is a manager's own note, not a worker's branch.
      const handedOff = /^HANDOFF:\s*(?!manager\b)(\S+)\s*$/.exec(e.answer.trim().split('\n').pop() ?? '')
      if (me && WORKERS.has(me.type) && handedOff?.[1] !== undefined) {
        const owner = rows.find(a => a.id === me.parentId)?.name ?? 'main'
        await best($, 'recording a handoff', () => recordHandoff($, me, handedOff[1] as string, owner, settings.maxContinues))
      }
      if (me && isReviewer(me.type)) await ensureQueue($)
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
    // The push item is drawn as the banner on top, not as a question.
    const openQs = openAll(await read($, inbox)).filter(q => !isFyi(q) && q.kind !== PUSH_KIND).sort((a, b) => Number(b.blocking) - Number(a.blocking))
    const gate = (await read($, pushState)).batch
    const askers = askingNames(await read($, inbox))
    const fyiCount = openAll(await read($, inbox)).filter(isFyi).length
    const checksLine = paneChecksLine(await read($, checks), installed)
    const inboxRows = (openQs.length === 0 ? 0 : 1 + Math.min(openQs.length, 5) + (openQs.length > 5 ? 1 : 0)) + (fyiCount > 0 ? 1 : 0) + (checksLine === undefined ? 0 : 1) + (gate === undefined ? 0 : gate.state === 'ready' ? 2 : 1)
    const deployLines = behindLines(deployInfos, await read($, deploys), await read($, behind)).slice(0, 3)
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
    const prs = Object.values(hs).sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    const live = list.filter(a => !ENDED.has(a.status)).length
    // Header, the PR lines and the hint row are fixed; the root and the agents share what is left.
    // Full cards if all fit, else the crowded tree (compact rows, folded but for the highlight's
    // path) in a window that follows the highlight.
    const queueOpen = fold[MERGE_QUEUE_KEY] === false
    const prRows = prs.length > 0 ? 1 + (queueOpen ? Math.min(prs.length, 5) : 0) : 0
    const usageRows = rows >= 20 ? Math.min(4, limits.length) : 0
    const avail = rows - 1 - prRows - usageRows - (list.length === 0 ? 1 : 0) - (list.length > 0 ? 1 : 0) - (unhanded.length > 0 ? 1 : 0) - (leftover ? 1 : 0) - inboxRows - deployLines.length
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
    const queueSummary = (['pending', 'taken', 'done'] as const).map(s => `${countOf(s)} ${s}`).join(' · ')  + (countOf('ready') > 0 ? ` · ${countOf('ready')} ready to push` : '')
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
        {gate !== undefined && gate.state === 'ready' && (
          <Text color="warning" bold wrap="truncate-end">⇪ Batch {gate.id} ready to push: {gate.prs.map(n => `#${n}`).join(' ')}{gate.version === undefined ? '' : ` (${gate.version})`} · check: {gate.check}</Text>
        )}
        {gate !== undefined && gate.state === 'ready' && <Text color="warning" wrap="truncate-end">  /flow push · /flow push back {'<pr>'} · /flow push drop</Text>}
        {gate !== undefined && gate.state !== 'ready' && (
          <Text color="suggestion" wrap="truncate-end">⇪ Batch {gate.id} {gate.state === 'pushing' ? 'released, a reviewer is pushing it' : `is being rebuilt${gate.reason === undefined ? '' : ` (${gate.reason})`}`}: {gate.prs.map(n => `#${n}`).join(' ')}</Text>
        )}
        <Text dimColor>{list.length} agents · {live} live{prs.length ? ` · ${prs.length} PRs handed over` : ''} · press one to see it</Text>
        {openQs.slice(0, 5).map(q => (
          <Text color={q.blocking ? 'warning' : undefined} wrap="truncate-end">{q.id} {q.owner}: {q.question}</Text>
        ))}
        {openQs.length > 5 && <Text dimColor>and {openQs.length - 5} more</Text>}
        {openQs.length > 0 && <Text dimColor>/flow inbox to read, answer in the chat</Text>}
        {fyiCount > 0 && <Text dimColor>{fyiCount} FYI (decided by agents; /flow inbox)</Text>}
        {checksLine !== undefined && <Text dimColor wrap="truncate-end">{checksLine}</Text>}
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
        {prs.length > 0 && (
          <Box flexDirection="row">
            <Button key={`fold-${MERGE_QUEUE_KEY}`} plain dimColor onPress={toggleQueue}>{queueOpen ? '  ▾ ' : '  ▸ '}</Button>
            <Text bold>Reviewer</Text>
            {!queueOpen && <Text dimColor>  {queueSummary}</Text>}
            {!queueOpen && awaiting > 0 && <Text color="warning"> · {awaiting} awaiting approval</Text>}
            {!queueOpen && returned > 0 && <Text color="warning"> · {returned} returned</Text>}
          </Box>
        )}
        {queueOpen && prs.slice(0, 5).map(ho => (
          <Text key={`pr-${ho.pr}`} dimColor={ho.status === 'done'} color={ho.status === 'awaiting' || ho.status === 'ready' ? 'warning' : undefined} wrap="truncate-end">
            {'    '}{HANDOVER_GLYPH[ho.status]} #{ho.pr} {ho.status === 'awaiting' ? `awaiting your approval: /flow approve ${ho.pr}` : ho.status === 'ready' ? 'ready, awaiting your push: /flow push' : ho.status}{ho.status === 'returned' ? `: ${ho.reason ?? ''}` : ''} <Text dimColor>{ho.title}</Text>
          </Text>
        ))}
        {deployLines.map(l => <Text key={`deploy-${l}`} dimColor wrap="truncate-end">{'  '}⏸ {l}</Text>)}
        {list.length > 0 && (
          <Box flexDirection="row" gap={1}>
            <Button key="nav-next" plain dimColor hotkey="j" onPress={step(1)}>j next</Button>
            <Button key="nav-prev" plain dimColor hotkey="k" onPress={step(-1)}>k prev</Button>
            <Button key="nav-open" plain dimColor hotkey="o" onPress={async () => { const i = await hotItem(); if (i) await open(i.a.id) }}>o open</Button>
            <Button key="nav-fold" plain dimColor hotkey="c" onPress={async () => {
              const i = await hotItem()
              if (i) await toggleFold(i.a, i.collapsed)
            }}>{items[hotIdx]?.collapsed ? 'c expand' : 'c collapse'}</Button>
            {prs.length > 0 && <Button key="nav-queue" plain dimColor hotkey="q" onPress={toggleQueue}>q reviewer</Button>}
            {toggle}
          </Box>
        )}
      </Box>
    )
    })()
    } catch (err) {
      const { Text } = $.ui.resolve(e)
      return <Text>flow: pane failed to draw: {err instanceof Error ? err.message : String(err)}</Text>
    }
  })
}
