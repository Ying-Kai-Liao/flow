// This file is the wiring only: atoms, `on(...)` hooks, `$.tool.register` calls, and io builders whose
// closures spell out each `$.noun.event(...)` call. New logic goes into a module under hooks/, either
// pure or taking an io object of closures (see deliver.ts), because the engine refuses `$` across an
// import and wants atoms declared in this file.
import { atom, read, update } from 'claude-code'
import type { AgentInfo, AgentSpawnInput, EngineInterface, Register } from 'claude-code'

import type { Activity, AgentRow, Ledger, Role, EnvChange, Handover, HandoffRecord, Leftovers, LogEvent, OpenPr, PrCache, Session, SlotEntry, TestSlots } from '../types'
import { grantFile, grantSlots, reapSlots } from './slots'
import { evidenceText, type Evidence } from './evidence'
import { noteWork, runLine, serialFastForward, type RunWork } from './mainff'
import { deleteMergedBranch } from './branchdelete'
import { NO_FAILS, withFailed, withFlaky, type TestFails } from './testfail'
import { leftoverLine } from './clean'
import { sweep as sweepTo } from './clean'
import type { CleanInputs, CleanIo, Kept, PrRow, Sweep } from './clean'
import { gatherLeftovers as gatherLeftoversTo } from './resume'
import type { Gathered, Leftover, ResumeIo } from './resume'
import { deliver as deliverTo, flushAgent as flushTo, holdForReviewer as holdTo, resetDelivery, ENDED, LIVE, type DeliverIo, type DeliverOptions } from './deliver'
import { addStep, addTurn, baseName, entriesOfBranch, setIdentity } from './cost'
import { changeLedger as changeLedgerTo, costLines as costLinesTo, loadLedger as loadLedgerTo, mainKey as mainKeyTo, withCost as withCostTo } from './cost-run'
import type { CostIo } from './cost-run'
import { backNote } from './routing'
import { checkAttachments, CONTINUE_LINE, continuingCount, dispatch, fableDenied, FABLE_DENY, fileManagerSizeFyi, fileSizeFyi, FLOW_TYPES, prepareContinue, refusedLong, routeManager, routeWorker, withoutLong } from './spawn'
import type { Routed, SpawnIo } from './spawn'
import { agentFor, asksQuestion, noticeText, settle, waitsOnReport } from './dag'
import type { AgentFact, Facts, Notice, Plan } from './dag'
import {
  answerMessage, askingNames, EMPTY_INBOX, isFyi, openAll, findItem, markAnswered, overridesManager, clip, paneRows, paneRowText, protectedWhy, tagsOf, OVERTURN, needsMessage, normalizeInbox, notesOwner,
} from './inbox'
import type { PaneRow } from './inbox'
import {
  closeStale, denyText, dueRound, EMPTY_PREFLIGHT, gateOf, isSkip, markDelivered, normalizePreflight,
  recordSpawn, renderRound,
} from './preflight'
import type { Preflight } from './preflight'
import {
  addChecks, anyMatch, dueForPrompt, EMPTY_CHECKS, normalizeChecks, paneChecksLine, parseNeeds, renderChecksTable,
  SKIP_NOTE, versionInSteps,
} from './checks'
import type { Check, Checks } from './checks'
import { termWidth } from './table'
import type { Inbox, Marked, Question } from './inbox'
import { addGuardTest, loadRules, offerSeedsOnce, standingTool, suggestGuardTests } from './standing-run'
import type { StandingIo } from './standing-run'
import { ANSWER_TOOL, ASK_TOOL, CHECK_TOOL, CLEAN_TOOL, DEPLOY_TOOL, FYI_TOOL, GUARD_TESTS_TOOL, HANDOVER_TOOL, MIGRATIONS_TOOL, NOTE_TOOL, PLAN_TOOL, PREFLIGHT_TOOL, PUSH_TOOL, RELEASE_TOOL, reviewerTool, SESSION_TOOL, STANDING_TOOL, STATUS_TOOL, TEST_SLOT_TOOL } from './tools'
import { graphNodes, layoutGraph, moveFocus } from './graph'
import { shimmerParts } from './shimmer'
import { card as cardTo, limitLine as limitLineTo, meter as meterTo } from './pane-view'
import type { Usage } from './pane-view'
import { COLOR, describeCall, foldDefault, GLYPH, HANDOVER_GLYPH, nodeColor, nodeGlyph, rankOf, ROLE, ROOT_GLYPH, summarizeCall, treeItems, viewOf } from './pane'
import type { GNode, Seg } from './graph'
import {
  fill, MANAGER_PROMPT, NO_REVIEWER_RULE, REVIEWER_PROMPT, REVIEWER_RULE, WORKER_PROMPT,
} from './prompts'
import type { Settings } from './prompts'
import { deployModeWarnings, deployTargetsOf, stateFileOf, targetsOf } from './prompts'
import { mergeLayers, renameOptions, settingsOf } from './settings'
import { releaseTool } from './release-run'
import type { ReleaseIo } from './release-run'
import { handoverTool } from './handover-run'
import type { HandoverIo } from './handover-run'
import { askTool, answerTool, fyiTool, preflightTool } from './inbox-run'
import type { InboxIo } from './inbox-run'
import { checkTool } from './checks-run'
import type { ChecksIo } from './checks-run'
import { planTool } from './plan-run'
import type { PlanIo } from './plan-run'
import { testSlotTool } from './slots-run'
import type { SlotsIo } from './slots-run'
import { migrationsTool } from './migrations-run'
import type { MigrationsIo } from './migrations-run'
import { statusTool } from './status-run'
import type { StatusIo, Unhanded } from './status-run'
import { flowCommand } from './command'
import type { CommandIo } from './command'
import { CARD_ROWS, elapsed, tokensDown, LARGE_WINDOW, METER_CELLS, cells, labelOf, limitLabel, limitTokens, meterColor, thresholdOf, warnPercent, windowOf, wrapUpText } from './meter'
export { elapsed, tokensDown } from './meter'
import {
  allowed, allowList, killRefusal, remoteDeleteRefusal, mainCheckoutRefusal, mainRelative, parseWorktrees, resolvePath, writeTargets,
} from './guards'
import type { WriteTarget } from './guards'
import {
  ago, claudeLimits, harnessesOf, runsOutIn, SESSION, sessionKey, sessionRow,
} from './sessions'
import type { HarnessSpec, Limit } from './sessions'
import { sessionTool as sessionToolTo, watchSessions as watchSessionsTo } from './session-run'
import type { Caller, Ran, SessionIo } from './session-run'
import { branchOwners, buildDigest, findWorktree, noteKey } from './state'
import { ADD_OPTION, guardReport, guardTestsFor, pathsFromStatus } from './guardtests'
import { parseMode, takeDecision } from './mergemode'
import {
  EMPTY_PUSH, normalizePush,
  PUSH_KIND, reviewerNote,
} from './pushgate'
import type { PushState } from './pushgate'
import { onPushAnswer as onPushAnswerTo, pushAct as pushActTo, pushLines, recordReady as recordReadyTo, settleBatch as settleBatchTo } from './pushgate-run'
import type { PushAct, PushIo } from './pushgate-run'
import {
  behindLines, EMPTY_DEPLOYS, ENV_KIND,
  envSummary, normalizeDeploys,
  release, itemViewOf,
} from './deploy'
import { cap, CONTINUE, DEFAULT_WORKER_MODEL, isReviewer, LIVE_STATUS, LOG_MAX, MANAGER, mirror, NOTES_MAX, PANE, POLL_MS, REVIEWER, TEXT_MAX, WORKER, WORKERS } from './core'
import type { Deploys, Draft, Hold, TargetInfo } from './deploy'
import {
  closeReturnedEnv as closeReturnedEnvTo, deployTool as deployToolTo, holdTarget as holdTargetTo, onDeployAnswer as onDeployAnswerTo, onEnvAnswer as onEnvAnswerTo,
  openHandoverEnv as openHandoverEnvTo, refreshBehind as refreshBehindTo, releaseTarget as releaseTargetTo,
} from './deploy-run'
import type { DeployIo } from './deploy-run'

// The orca-flow pattern inside one Claude Code session. The main session is the super manager
// (the `dispatch` skill); it starts `flow:manager` agents, which start
// `flow:worker` agents in worktrees of their own and hand approved PRs to the
// `flow:reviewer` agent through this plugin's tools. The pane in main shows the tree.


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
// A worker that just ended: its manager is probably reviewing the PR.
const GRACE_MS = 20 * 60_000
const infosOf = (s: Parameters<typeof targetsOf>[0]): TargetInfo[] => targetsOf(s).map(t => ({ name: t.name, mode: t.mode, ...(t.envCommand !== undefined ? { envCommand: t.envCommand } : {}) }))


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

async function currentUnhanded($: EngineInterface): Promise<Unhanded[]> {
  if (!mirror.queueOn) return []
  const [cache, hs, rows, acts, t] = await Promise.all([
    read($, prCache), read($, handovers), read($, roster), read($, activity), $.clock.now(),
  ])
  return unhandedPrs(cache.prs, hs, rows, acts, t)
}
const plan = atom({ plugin: 'flow', key: 'plan' } as const, {} as Plan)
// The pane draws the agents as a tree of cards or as the dependency graph; the graph's highlight is a node id.
const viewMode = atom({ plugin: 'flow', key: 'viewMode' } as const, 'tree' as 'tree' | 'graph' | 'inbox')
// The inbox view: the highlighted row's key, the expanded groups, the typed answer and the last result line.
const inboxCursor = atom({ plugin: 'flow', key: 'inboxCursor' } as const, null as string | null)
const inboxDraft = atom({ plugin: 'flow', key: 'inboxDraft' } as const, '')
const inboxNote = atom({ plugin: 'flow', key: 'inboxNote' } as const, '')
const graphFocus = atom({ plugin: 'flow', key: 'graphFocus' } as const, null as string | null)
const testSlots = atom({ plugin: 'flow', key: 'testSlots' } as const, { holders: [], waiters: [] } as TestSlots)

// <git-common-dir>/flow/test-slots, set at session start; undefined when not in a git repo.
let slotDir: string | undefined

// Applies `pre`, reaps, grants, and signals: a grant file and a message per new holder, the files
// of everyone who left the line removed. Every slot change goes through here, inside one update().
async function settleSlots($: EngineInterface, rows: AgentRow[], t: number, pre: (s: TestSlots) => TestSlots = s => s, me?: string): Promise<void> {
  const notes: string[] = []
  let granted: SlotEntry[] = []
  let left: string[] = []
  await update($, testSlots, st => {
    notes.length = 0
    const r = reapSlots(pre(st), rows, t)
    const g = grantSlots(r.state, mirror.slotLimit, t)
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
    const f = grantFile(slotDir, key)
    if (f) await sh($, 'rm -f "$1"', f)
  }
  for (const g of granted) {
    const f = grantFile(slotDir, g.key)
    if (f) await sh($, 'mkdir -p "$(dirname "$1")" && : > "$1"', f)
    if (g.key !== 'main') {
      await deliver($, g.key, `flow: your test slot is granted (${g.label}). Call mcp__flow__test_slot acquire to confirm, run, then release.`, { onGone: () => undefined }).catch(() => undefined)
    }
  }
}

// The last batch the release tool cut, so a retried push does not release twice.
let lastRelease: { key: string; version: string } | undefined

const releaseIoOf = ($: EngineInterface): ReleaseIo => ({
  exec: (argv, cwd) => cwd === undefined ? $.process.run(argv) : $.process.run(argv, { cwd }),
  sleep: ms => $.clock.sleep(ms),
  now: () => $.clock.now(),
  exists: path => $.fs.exists(path),
  read: path => $.fs.read(path),
  write: async (path, text) => { await $.fs.write(path, text) },
  stateDir: () => stateDir($),
  readJson: path => readJson($, path),
  writeJsonAtomic: (path, obj) => writeJsonAtomic($, path, obj),
  getLast: () => lastRelease,
  setLast: last => { lastRelease = last },
  handovers: () => read($, handovers),
  batch: async () => (await read($, pushState)).batch,
})

const handoverIoOf = ($: EngineInterface, options: Record<string, unknown>): HandoverIo => ({
  run: argv => $.process.run(argv),
  now: () => $.clock.now(),
  handovers: () => read($, handovers),
  putHandover: async (pr, h) => { await update($, handovers, hs => ({ ...hs, [pr]: h })) },
  resolveReportTo: (given, callerId) => resolveReportTo($, given, callerId),
  openEnv: (h, drafts, prev, at) => openHandoverEnv($, options, h, drafts, prev, at),
  best: (what, fn) => best($, what, fn),
  saveHandover: h => saveHandover($, h),
  appendLog: event => appendLog($, event),
  toast: text => { void $.ui.toast(text) },
  refresh: () => refresh($),
  ensureQueue: () => ensureQueue($),
})

const planIoOf = ($: EngineInterface): PlanIo => ({
  refresh: () => refresh($),
  plans: () => read($, plan),
  planOwner: (plans, name) => planOwner(plans, name),
  limitsLine: (rows, workers) => limitsLine(rows, workers),
  syncPlans: (rows, edit, quietOwner) => syncPlans($, rows, edit, quietOwner),
})

const inboxIoOf = ($: EngineInterface): InboxIo => ({
  standing: standingIoOf($),
  refresh: () => refresh($),
  deliver: (id, text, opts) => deliver($, id, text, opts),
  toast: text => { void $.ui.toast(text) },
  ownerNameOf: id => ownerNameOf($, id),
  answerQuestion: (wanted, choice, by, options, user) => answerQuestion($, wanted, choice, by, options, user),
  withPreflight: fn => withPreflight($, fn),
  preflightTick: rows => preflightTick($, rows),
  submitLater: text => { $.clock.after(0, () => void $.prompt.submit({ text }).catch(() => undefined)) },
})

const checksIoOf = ($: EngineInterface): ChecksIo => ({
  agents: () => $.agent.list(),
  checks: () => read($, checks),
  now: () => $.clock.now(),
  withChecks: fn => withChecks($, fn),
})

const slotsIoOf = ($: EngineInterface): SlotsIo => ({
  refresh: () => refresh($),
  now: () => $.clock.now(),
  sleep: ms => $.clock.sleep(ms),
  slots: () => read($, testSlots),
  settleSlots: (rows, t, pre, me) => settleSlots($, rows, t, pre, me),
  best: (what, fn) => best($, what, fn),
  testFails: () => read($, testFails),
  setTestFails: async state => { await update($, testFails, () => state) },
  appendLog: event => appendLog($, event),
  slotDir: () => slotDir,
})

const migrationsIoOf = ($: EngineInterface): MigrationsIo => ({
  runCmd: argv => runCmd($, argv),
})

const statusIoOf = ($: EngineInterface, options: Record<string, unknown>): StatusIo => ({
  now: () => $.clock.now(),
  handovers: () => read($, handovers),
  readLog: () => readLog($),
  prCache: () => read($, prCache),
  fetchPrs: () => fetchPrs($),
  refresh: () => refresh($),
  activity: () => read($, activity),
  unhanded: () => currentUnhanded($),
  leftovers: () => read($, leftovers),
  costLines: (prs, keep) => costLines($, prs, keep),
  ledger: () => read($, ledger),
  preflight: () => read($, preflight),
  inbox: () => read($, inbox),
  plans: () => read($, plan),
  slots: () => read($, testSlots),
  offerSeeds: () => offerSeedsOnce(standingIoOf($), options),
  pushState: () => read($, pushState),
  deploys: () => read($, deploys),
  behind: () => read($, behind),
  limitsLine: (rows, workers) => limitsLine(rows, workers),
  stateDir: () => stateDir($),
})

const commandIoOf = ($: EngineInterface): CommandIo => ({
  now: () => $.clock.now(),
  inbox: () => read($, inbox),
  checks: () => read($, checks),
  answerQuestion: (wanted, choice, by, options, user) => answerQuestion($, wanted, choice, by, options, user),
  withChecks: fn => withChecks($, fn),
  costLines: prs => costLines($, prs),
  handovers: () => read($, handovers),
  preflight: () => read($, preflight),
  roster: () => read($, roster),
  endedManagers: rows => endedManagers(rows),
  panes: async () => [...(await $.ui.panes())],
  close: () => $.ui.close({ id: PANE }),
  open: () => $.ui.open({ id: PANE, title: 'Flow', focus: true }),
  gatherLeftovers: (base, resumed) => gatherLeftovers($, base, resumed),
  pushState: () => read($, pushState),
  after: (ms, fn) => { $.clock.after(ms, fn) },
  submit: text => $.prompt.submit({ text }),
  notesPath: owner => notesPath($, owner),
  readNotes: owner => readNotes($, owner),
  sweep: (base, apply, dryHint) => sweep($, base, apply, dryHint),
  putHandover: async (pr, h) => { await update($, handovers, hs => ({ ...hs, [pr]: h })) },
  best: (what, fn) => best($, what, fn),
  saveHandover: h => saveHandover($, h),
  appendLog: event => appendLog($, event),
  toast: text => { void $.ui.toast(text) },
  ensureQueue: () => ensureQueue($),
  refresh: () => refresh($),
  pushAct: (act, by) => pushAct($, act, by),
  holdTarget: (name, until, by, reason) => holdTarget($, name, until, by, reason),
  releaseTarget: name => releaseTarget($, name),
  refreshBehind: () => refreshBehind($),
})

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
    id: a.id, name: a.name, status: a.status, answer: acts[a.id]?.answer,
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
    phrases: mirror.decisionPhrases,
    asking: askingNames(await read($, inbox)),
  }
  const slots = Math.max(0, mirror.maxManagers - liveManagers(rows).length)
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
      else {
        // The owner ended its turn to wait (the host reports it completed or drops it): a ready node means it
        // has work left, so the notice wakes it. Only a manager that cannot be resumed sends it to main.
        const gone = agentFor(n.owner, agents.filter(a => a.status !== 'failed' && a.status !== 'killed'))
        if (gone?.id !== undefined) {
          resumable.add(gone.id)
          await deliver($, gone.id, text, { onGone: t => tellMain($, n.owner, t) }).catch(() => undefined)
        } else if (agentFor(n.owner, agents) !== undefined) await tellMain($, n.owner, text)
      }
    }
  }
  return result
}

function limitsLine(rows: AgentRow[], workers: number): string {
  return `Limits: managers ${liveManagers(rows).length}/${mirror.maxManagers}, workers per manager ${workers}`
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
      const asks = asksQuestion(acts[a.id]?.answer, mirror.decisionPhrases) || askers.includes(a.name ?? '')
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
  const slotPart = slots.holders.length || slots.waiters.length ? ` · tests ${slots.holders.length}/${mirror.slotLimit}` : ''
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
const costIoOf = ($: EngineInterface): CostIo => ({
  stateDir: () => stateDir($),
  readJson: path => readJson($, path),
  writeJsonAtomic: (path, obj) => writeJsonAtomic($, path, obj),
  mkdirp: async dir => { await $.process.run(['mkdir', '-p', dir]) },
  now: () => $.clock.now(),
  after: (ms, fn) => { $.clock.after(ms, fn) },
  ledger: () => read($, ledger),
  updateLedger: async fn => { await update($, ledger, fn) },
  startedAt: async () => (await $.session.usage().then(x => x, () => undefined))?.startedAt,
  liveIds: async () => (await read($, roster)).map(a => a.id),
  hasSessions: async () => Object.keys(await read($, sessions)).length > 0,
})
const loadLedger = ($: EngineInterface): Promise<void> => loadLedgerTo(costIoOf($))
const changeLedger = ($: EngineInterface, fn: (l: Ledger, now: number) => Ledger): Promise<void> => changeLedgerTo(costIoOf($), fn)
const mainKey = ($: EngineInterface): Promise<string> => mainKeyTo(costIoOf($))
const costLines = ($: EngineInterface, prs: { pr: number; branch: string }[], keep?: (e: Ledger[string]) => boolean): Promise<string[]> =>
  costLinesTo(costIoOf($), prs, keep)

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
    const d = dueRound(cur, ended, t, mirror.preflightWaitMs)
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
  if (!mirror.preflightOn || agentId === undefined) return undefined
  const me = (await $.agent.list()).find(a => a.id === agentId)
  if (me?.type !== MANAGER || me.name === undefined) return undefined
  const g = gateOf(await read($, preflight), await read($, inbox), me.name)
  return g === undefined ? undefined : denyText(g)
}

// A manager main just started joins the open round, or opens one with a timer for the wait.
async function recordManager($: EngineInterface, name: string, prompt: string): Promise<void> {
  const t = await $.clock.now()
  const opened = await withPreflight($, cur => {
    const next = recordSpawn(cur, name, isSkip(prompt), t, mirror.preflightWaitMs)
    return { state: next, out: next.rounds.length > cur.rounds.length }
  })
  if (opened) $.clock.after(mirror.preflightWaitMs, () => void refresh($).catch(() => undefined))
}

const today = async ($: EngineInterface) => new Date(await $.clock.now()).toISOString().slice(0, 10)

// The one way a question gets answered: marks it, tells the asker when that is needed, notes the decision.
// choice null takes the question's default. Returns one result line.
// user: the person answering from the pane or a /flow command, who may answer any question, a manager's included.
async function answerQuestion($: EngineInterface, wanted: string, choice: string | null, by: string, options: Record<string, unknown>, user = false): Promise<string> {
  const at = await $.clock.now()
  // A decision filed before decisions had d-ids is also found by its old q-id.
  const id = findItem(await read($, inbox), wanted)?.id ?? wanted.trim().toLowerCase()
  const marked = await withInbox($, (cur): { inbox: Inbox; out: Marked | { kind: 'escalated'; q: Question } } => {
    // A standing rule made this the user's decision: only main answers it.
    const held = cur.items.find(x => x.id === id)
    if (held !== undefined && held.state === 'open' && held.escalated !== undefined && by !== 'main') return { inbox: cur, out: { kind: 'escalated', q: held } }
    const m = markAnswered(cur, id, choice, by, at, undefined, user)
    return { inbox: m.kind === 'ok' ? m.inbox : cur, out: m }
  })
  if (marked.kind === 'escalated') return `${id}: refused, standing rule ${marked.q.escalated} makes this the user's decision. It is in main's inbox as ${id}; main answers it directly and the asker gets the answer. Don't answer or re-ask it.`
  if (marked.kind === 'unknown') return `${id}: no such question.`
  if (marked.kind === 'answered') return `${id}: already answered ("${marked.q.answer ?? ''}" by ${marked.q.answeredBy ?? '?'}).`
  if (marked.kind === 'refused') return `${id}: refused, it is addressed to ${marked.q.addressee}, not ${by}.`
  if (marked.kind === 'empty') return `${id}: refused, the choice is empty.`
  const { q, answer, isDefault } = marked
  // The user over a manager's head: the asker hears "the user", and the manager learns the question is closed.
  const over = user && overridesManager(q)
  const who = over ? 'the user' : by
  const deployNote = q.kind === 'deploy' ? await onDeployAnswer($, q, answer) : q.kind === ENV_KIND ? await onEnvAnswer($, q, answer) : q.kind === PUSH_KIND ? await onPushAnswer($, q, answer, by) : ''
  let delivered = true
  let hint = ''
  if (needsMessage(q, isDefault)) {
    const asker = q.askerId === undefined ? undefined : (await $.agent.list()).find(a => a.id === q.askerId)
    delivered = false
    const alive = (a: AgentInfo | undefined): a is AgentInfo => a !== undefined && (LIVE.has(a.status) || a.status === 'idle')
    if (alive(asker)) {
      delivered = await deliver($, asker.id, answerMessage(q, answer, who, isDefault), { urgent: q.blocking === true, onGone: () => undefined }).catch(() => false)
    } else if (isFyi(q) && q.addressee !== 'main') {
      // A finished owner cannot act on an undo: its manager (the notes owner) gets it, naming the owner.
      const mgr = (await $.agent.list()).find(a => a.type === MANAGER && a.name !== undefined && noteKey(a.name) === noteKey(q.addressee) && alive(a))
      if (mgr !== undefined) {
        delivered = await deliver($, mgr.id, `${answerMessage(q, answer, by, isDefault)} (This was ${q.owner}'s decision; ${q.owner} is no longer running, so act on it yourself or with a new worker.)`, { urgent: q.blocking === true, onGone: () => undefined }).catch(() => false)
      }
    }
    if (!delivered) hint = `; ${q.owner} is gone: main should relay it to ${noteKey(q.owner)}-2`
  }
  await withInbox($, cur => ({
    inbox: { ...cur, items: cur.items.map(x => (x.id === id ? { ...x, delivered } : x)) }, out: undefined,
  }))
  if (over) {
    const mgr = (await $.agent.list()).find(a => a.type === MANAGER && a.name !== undefined && noteKey(a.name) === noteKey(q.addressee) && (LIVE.has(a.status) || a.status === 'idle'))
    if (mgr !== undefined) {
      await deliver($, mgr.id, `flow: the user answered ${q.id}, which ${q.owner} asked you: ${answer}. It is closed; don't answer it.`, { urgent: false, onGone: () => undefined }).catch(() => false)
    }
  }
  if (!(isFyi(q) && isDefault)) await appendNote($, notesOwner(q), `- ${await today($)} decision: "${q.id} ${noteText(q)}: ${isFyi(q) ? `undone, ${answer}` : answer}"`)
  const guard = q.guard !== undefined && answer === ADD_OPTION ? ` ${await addGuardTest(standingIoOf($), options, q.guard.glob, q.guard.test)}` : ''
  return `${id}: ${answer}${isDefault ? ' (default)' : ''}, ${delivered ? 'delivered' : 'undelivered'}${hint}.${guard}${deployNote}`
}

// The pane's inbox rows, read fresh.
async function paneInboxRows($: EngineInterface): Promise<{ rows: PaneRow[]; now: number }> {
  const [box, now] = await Promise.all([read($, inbox), $.clock.now()])
  return { rows: paneRows(box), now }
}

// Pane presses run one after another, so a second press sees the first one's answer and highlight.
let paneChain: Promise<unknown> = Promise.resolve()
const paneSerial = <T,>(fn: () => Promise<T>): Promise<T> => {
  const run = paneChain.then(fn, fn)
  paneChain = run.catch(() => undefined)
  return run
}

// The question as a notes line: an env change names the variable, never its value.
const noteText = (q: Question): string => (q.env === undefined ? q.question : `env ${q.env.name} on ${q.env.target} (${q.env.role})`)

// ---- the deploy gate (deploy.ts, deploy-run.ts) ----

const deployIoOf = ($: EngineInterface): DeployIo => ({
  stateDir: () => stateDir($),
  readJson: path => readJson($, path),
  writeJson: (path, obj) => writeJsonAtomic($, path, obj),
  mkdir: dir => $.process.run(['mkdir', '-p', dir]),
  deploys: () => read($, deploys),
  setDeploys: async next => { await update($, deploys, () => next) },
  behind: () => read($, behind),
  setBehind: async next => { await update($, behind, () => next) },
  infos: () => mirror.deployInfos,
  base: () => mirror.cleanupBase,
  exec: (argv, timeoutMs) => $.process.run(argv, { timeoutMs }),
  now: () => $.clock.now(),
  handovers: () => read($, handovers),
  updateHandovers: async fn => { await update($, handovers, fn) },
  saveHandover: h => saveHandover($, h),
  inbox: () => read($, inbox),
  withInbox: fn => withInbox($, fn),
  ensureQueue: () => ensureQueue($),
  loadRules: options => loadRules(standingIoOf($), options),
  appendNote: (name, line) => appendNote($, name, line),
  appendLog: event => appendLog($, event),
  today: () => today($),
  noteText,
  best: (what, fn) => best($, what, fn),
  toast: text => { void $.ui.toast(text) },
})

const refreshBehind = ($: EngineInterface): Promise<void> => refreshBehindTo(deployIoOf($))
const onDeployAnswer = ($: EngineInterface, q: Question, answer: string): Promise<string> => onDeployAnswerTo(deployIoOf($), q, answer)
const onEnvAnswer = ($: EngineInterface, q: Question, answer: string): Promise<string> => onEnvAnswerTo(deployIoOf($), q, answer)
const holdTarget = ($: EngineInterface, name: string, until: Hold['until'], by: string, reason: string | undefined): Promise<string> =>
  holdTargetTo(deployIoOf($), name, until, by, reason)
const releaseTarget = ($: EngineInterface, name: string): Promise<string> => releaseTargetTo(deployIoOf($), name)
const deployTool = ($: EngineInterface, options: Record<string, unknown>, input: Record<string, unknown>, isMain: boolean, caller: string): Promise<string> =>
  deployToolTo(deployIoOf($), options, input, isMain, caller)
const openHandoverEnv = (
  $: EngineInterface, options: Record<string, unknown>, h: Handover, drafts: Draft[], prev: EnvChange[], at: number,
): Promise<string> => openHandoverEnvTo(deployIoOf($), options, h, drafts, prev, at)
const closeReturnedEnv = ($: EngineInterface, h: Handover): Promise<void> => closeReturnedEnvTo(deployIoOf($), h)


// ---- the push gate (pushgate.ts) ----

// A message for the manager that owns a PR: sent when it is alive, else noted for it and sent to main.
async function tellManager($: EngineInterface, name: string, text: string): Promise<void> {
  const live = (await $.agent.list()).find(a => a.name === name && (LIVE.has(a.status) || a.status === 'idle'))
  // Urgent: tellManager carries push-gate send-backs and report fallbacks, which the manager acts on now.
  // A failed send has already gone through onGone.
  if (live !== undefined) await deliver($, live.id, text, { urgent: true, onGone: t => tellMain($, name, t) }).catch(() => undefined)
  else {
    const wake = await wakeTarget($, name)
    if (wake !== undefined) {
      resumable.add(wake)
      await deliver($, wake, text, { urgent: true, onGone: t => tellMain($, name, t) }).catch(() => undefined)
    } else await tellMain($, name, text)
  }
}

// A manager that ended its turn (completed, or dropped from the roster) but still has work: its id, so a
// message resumes it. Undefined when it is finished, was killed or failed, or its id is not known.
async function wakeTarget($: EngineInterface, name: string): Promise<string | undefined> {
  const rows = await $.agent.list()
  const row = rows.find(a => a.name === name && a.type === MANAGER)
  const seen = row === undefined ? (await read($, seenAgents))[name] : undefined
  const id = row === undefined ? seen?.id : row.status === 'completed' ? row.id : undefined
  if (id === undefined || seen?.status === 'failed' || seen?.status === 'killed') return undefined
  return (await managerFinished($, [id], name, rows)) ? undefined : id
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


const pushIoOf = ($: EngineInterface): PushIo => ({
  stateDir: () => stateDir($),
  readJson: path => readJson($, path),
  writeJson: (path, obj) => writeJsonAtomic($, path, obj),
  mkdir: dir => $.process.run(['mkdir', '-p', dir]),
  push: () => read($, pushState),
  setPush: async next => { await update($, pushState, () => next) },
  exec: (argv, timeoutMs) => $.process.run(argv, { timeoutMs }),
  now: () => $.clock.now(),
  handovers: () => read($, handovers),
  updateHandovers: async fn => { await update($, handovers, fn) },
  saveHandover: h => saveHandover($, h),
  appendLog: event => appendLog($, event),
  best: (what, fn) => best($, what, fn),
  withInbox: fn => withInbox($, fn),
  ensureQueue: () => ensureQueue($),
  closeReturnedEnv: h => closeReturnedEnv($, h),
  sizeBackNote: branch => sizeBackNote($, branch),
  tellManager: (name, text) => tellManager($, name, text),
  dropRelease: async key => {
    if (lastRelease?.key === key) {
      lastRelease = undefined
      const dir = await stateDir($)
      if (dir !== undefined) await writeJsonAtomic($, `${dir}/release.json`, {})
    }
  },
  toast: text => { void $.ui.toast(text) },
})

const recordReady = ($: EngineInterface, settings: Settings, input: Record<string, unknown>): Promise<string> => recordReadyTo(pushIoOf($), settings, input)
const settleBatch = ($: EngineInterface): Promise<void> => settleBatchTo(pushIoOf($))
const pushAct = ($: EngineInterface, act: PushAct, by: string): Promise<string> => pushActTo(pushIoOf($), act, by)
const onPushAnswer = ($: EngineInterface, q: Question, answer: string, by: string): Promise<string> => onPushAnswerTo(pushIoOf($), q, answer, by)

// The io closures standing-run.ts works through: each one spells its `$.noun.event(...)` call.
function standingIoOf($: EngineInterface): StandingIo {
  return {
    locate: () => locate($),
    readFile: path => $.fs.read(path).then(String, () => undefined),
    mkdirp: dir => $.process.run(['mkdir', '-p', dir]),
    writeJson: (path, obj) => writeJsonAtomic($, path, obj),
    readJson: path => readJson($, path),
    stateDir: () => stateDir($),
    run: argv => $.process.run(argv),
    now: () => $.clock.now(),
    today: () => today($),
    inbox: () => read($, inbox),
    withInbox: fn => withInbox($, fn),
    appendNote: (name, line) => appendNote($, name, line),
    appendLog: event => appendLog($, event),
    best: (what, fn) => best($, what, fn),
  }
}


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
// Persisted (like `forwarded`): a plugin reload mid-run must not lose the work, or the final report is cut.
const reviewerWork = atom({ plugin: 'flow', key: 'reviewerWork' } as const, {} as Record<string, RunWork>)
// Failing tests per agent and test_slot label, and the flaky ones a run saw (see testfail.ts).
const testFails = atom({ plugin: 'flow', key: 'testFails' } as const, NO_FAILS as TestFails)
const noteRunWork = ($: EngineInterface, id: string, f: (w: RunWork | undefined) => RunWork) =>
  update($, reviewerWork, m => ({ ...Object.fromEntries(Object.entries(m).slice(-FORWARDED_RIDS)), [id]: f(m[id]) }))

// `$` stays in this file: deliver.ts gets the three calls it needs.
// Managers that ended their turn to wait for a merge and have work left: a send resumes them, so they
// count as idle (messages batch in the window) instead of gone.
const resumable = new Set<string>()
const ioOf = ($: EngineInterface): DeliverIo => ({
  status: async id => {
    const s = (await $.agent.list()).find(a => a.id === id)?.status
    return resumable.has(id) && (s === undefined || s === 'completed') ? 'idle' : s
  },
  send: async (id, text) => {
    resumable.delete(id)
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

// A needs line's identity for dedupe: for "needs a person" its PR number when it names one, so a reworded
// repeat for the same PR matches. Any other line (pending decisions) keeps its text, so a pending-decisions
// line is never swallowed by a needs-a-person line for the same PR. Old persisted entries are plain
// normalized lines and map the same way.
const needToken = (line: string): string => {
  const m = /^needs a person:.*?PR\s*#(\d+)/i.exec(line)
  return m ? `needs:pr:${m[1]}` : line
}

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

async function managerFinished($: EngineInterface, ids: string[], name: string, rows: { id: string; parentId?: string; status: string }[], report?: string): Promise<boolean> {
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
  // Its last answer says it waits for this very report (a follow-up after the merge): wake it.
  if (report !== undefined) {
    const stamp = (i: string) => acts[i]?.endedAt ?? acts[i]?.lastAt ?? 0
    const newest = ids.reduce((best, i) => stamp(i) >= stamp(best) ? i : best, ids[0]!)
    const answer = acts[newest]?.answer ?? (await read($, seenAgents))[name]?.answer
    const own = Object.values(await read($, handovers)).filter(h => isManagerOf(name.replace(/-\d+$/, ''), h.reportTo)).map(h => h.pr)
    if (waitsOnReport(answer, report, own)) return false
  }
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
  // A manager that ended its turn to wait for a merge is 'completed' or dropped from the roster. With work
  // left (a plan node, a handover, a live worker, a blocking ask) the report wakes it: the call goes through.
  if (hits.every(a => a.status === 'completed')) {
    const seen = hits.length === 0 ? (await read($, seenAgents))[name] : undefined
    if (seen?.status !== 'failed' && seen?.status !== 'killed') {
      const ids = hits.length > 0 ? hits.map(a => a.id) : seen?.id !== undefined ? [seen.id] : []
      // Live workers are left out: a worker's own report resumes its manager, and the old routing sent a
      // report for an ended manager to main whatever its workers were doing.
      if (ids.length > 0 && !(await managerFinished($, ids, name, [], text))) return undefined
    }
  }
  const idle = hits.length > 0 && !hits.some(a => a.status !== 'idle' && !ENDED.has(a.status))
  // A host leaves a manager that finished its work 'idle', not completed. It counts as finished only
  // when nothing is left for it: no live child, no other open or returned handover, no open plan
  // node, no open blocking ask. Otherwise the message wakes it as today.
  if (hits.length > 0 && !hits.every(a => ENDED.has(a.status))) {
    if (!idle || !(await managerFinished($, hits.map(a => a.id), name, rows, text))) return undefined
  }
  // One outcome reaches main once: key on the manager and the PRs the text names (the text itself when
  // it names none). A repeat forwards only needs-a-person / pending-decisions lines not sent before.
  const prs = [...new Set([...text.matchAll(/#(\d+)/g)].map(m => m[1]))].sort().join(',')
  const key = `${rid}|${name}|${prs !== '' ? prs : normText(text)}`
  const seen = await read($, forwarded)
  const before = seen.keys[key]
  const needs = needLines(text)
  // Needs lines already forwarded for this run and manager, under any PR-set key: a reworded repeat of the
  // same PR's line is not new.
  const sentTokens = new Set(Object.entries(seen.keys).filter(([k]) => k.startsWith(`${rid}|${name}|`)).flatMap(([, v]) => v.map(needToken)))
  const unseen = needs.filter(l => !sentTokens.has(needToken(l)))
  const fresh = before === undefined && unseen.length === needs.length ? undefined : unseen
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


// Everything the spawn routing in spawn.ts needs from the engine and the plugin's state.
function spawnIoOf($: EngineInterface): SpawnIo {
  return {
    run: argv => $.process.run(argv),
    cwd: () => $.session.cwd(),
    agents: () => $.agent.list(),
    readFile: path => $.fs.read(path),
    handoffs: () => read($, handoffs),
    updateHandoffs: fn => update($, handoffs, fn),
    ownerName: id => ownerNameOf($, id),
    readLog: () => readLog($),
    appendLog: event => appendLog($, event),
    warn: (what, err) => warn($, what, err),
    loadLedger: () => loadLedger($),
    ledger: () => read($, ledger),
    standing: standingIoOf($),
  }
}

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
  const dueTargets = Object.entries((await read($, deploys)).targets).filter(([name, t]) => t.due === true && mirror.deployInfos.some(i => i.name === name)).map(([name]) => name)
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
const withCost = ($: EngineInterface, branch: string, report: string): Promise<string> => withCostTo(costIoOf($), branch, report)

// --- Cleanup: leftover worktrees and local branches of finished work ---------------------------

const cleanIoOf = ($: EngineInterface): CleanIo => ({
  exec: (argv, timeoutMs) => $.process.run(argv, { timeoutMs }),
  agents: () => $.agent.list(),
  cwd: () => $.session.cwd(),
  handoffs: async () => Object.values(await read($, handoffs)),
  sessions: async () => Object.values(await read($, sessions)),
  log: () => readLog($),
  append: event => appendLog($, event),
  setLeftovers: async counts => { await update($, leftovers, () => counts) },
})

const resumeIoOf = ($: EngineInterface): ResumeIo => ({
  exec: (argv, timeoutMs) => $.process.run(argv, { timeoutMs }),
  agents: () => $.agent.list(),
  sessions: async () => Object.values(await read($, sessions)),
  log: () => readLog($),
  loadHandovers: () => loadHandovers($),
  saveHandover: h => saveHandover($, h),
  best: (what, fn) => best($, what, fn),
  mergeHandovers: async all => { await update($, handovers, cur => ({ ...all, ...cur })) },
})

const sweep = ($: EngineInterface, base: string, apply: boolean, dryHint?: string, started?: () => void): Promise<string> =>
  sweepTo(cleanIoOf($), base, apply, dryHint, started)
const gatherLeftovers = ($: EngineInterface, base: string, resumed: Set<string>): Promise<Gathered> => gatherLeftoversTo(resumeIoOf($), base, resumed)

// The automatic sweep (cleanup "auto"): in the background, at most one waiting behind a running
// sweep, failures to the log only.
let autoQueued = false
function autoSweep($: EngineInterface): void {
  if (mirror.cleanupMode !== 'auto' || autoQueued) return
  autoQueued = true
  void sweep($, mirror.cleanupBase, true, undefined, () => { autoQueued = false })
    .catch(err => warn($, 'cleaning up', err))
}

// The dry sweep behind the pane's leftover line, on the PR list's cadence.
function refreshLeftovers($: EngineInterface): void {
  void sweep($, mirror.cleanupBase, false).catch(err => warn($, 'looking for leftovers', err))
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
// Workers in other harnesses (sessions.ts, session-run.ts): started in an Orca terminal or a tmux
// session, watched through the report file they write. A command that can't start is an exit code
// here, never a throw.
async function runCmd($: EngineInterface, argv: string[], timeoutMs = 60_000): Promise<Ran> {
  try {
    return await $.process.run(argv, { timeoutMs })
  } catch (err) {
    return { exitCode: 127, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
  }
}

// A second press within this long confirms restart or stop from the pane.
const ARM_MS = 5000

const sessionIoOf = ($: EngineInterface): SessionIo => ({
  run: (argv, timeoutMs) => runCmd($, argv, timeoutMs),
  now: () => $.clock.now(),
  after: (ms, fn) => void $.clock.after(ms, fn),
  stat: path => $.fs.stat(path),
  read: path => $.fs.read(path),
  write: (path, text) => $.fs.write(path, text),
  sessions: () => read($, sessions),
  updateSessions: fn => update($, sessions, fn),
  updateActivity: fn => update($, activity, fn),
  setLimits: limits => update($, harnessLimits, () => limits),
  gate: agentId => preflightGate($, agentId),
  agents: () => $.agent.list(),
  stateDir: () => stateDir($),
  log: event => appendLog($, event),
  warn: (what, err) => warn($, what, err),
  refresh: () => refresh($),
  openPane: () => openPane($),
  submit: text => $.prompt.submit({ text }),
  deliver: (id, text) => deliver($, id, text),
  logMax: LOG_MAX,
})
const watchSessions = ($: EngineInterface) => watchSessionsTo(sessionIoOf($))
const sessionTool = ($: EngineInterface, input: Record<string, unknown>, caller: Caller, s: ReturnType<typeof settingsOf>) =>
  sessionToolTo(sessionIoOf($), input, caller, s)


export const register: Register = (on, options) => {
  let settings = settingsOf(renameOptions(options), 'main')
  mirror.queueOn = settings.useReviewer
  mirror.cleanupMode = settings.cleanup
  mirror.cleanupBase = settings.base
  mirror.deployInfos = infosOf(settings)
  mirror.maxManagers = settings.maxManagers
  mirror.slotLimit = settings.testSlots
  mirror.decisionPhrases = settings.decisionPhrases
  mirror.preflightOn = settings.preflight
  mirror.preflightWaitMs = settings.preflightWait * 60_000
  // Settings reloads: the files' paths and mtimes, the detected base branch, whether a check runs.
  let paths: string[] = []
  let seen = ''
  let detected = 'main'
  let checking = false
  // Everything that mirrors the settings in a module-level variable is refreshed together.
  const apply = (s: typeof settings) => {
    settings = s
    mirror.queueOn = s.useReviewer
    mirror.cleanupMode = s.cleanup
    mirror.cleanupBase = s.base
    mirror.deployInfos = infosOf(s)
    mirror.maxManagers = s.maxManagers
    mirror.slotLimit = s.testSlots
    mirror.decisionPhrases = s.decisionPhrases
    mirror.preflightOn = s.preflight
    mirror.preflightWaitMs = s.preflightWait * 60_000
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
      const text = `Flow ${installed} is installed. ${due.length} after-deploy check${due.length === 1 ? '' : 's'} can be done now; tell the user, do not start managers for them:\n` +
        renderChecksTable({ next: 0, items: due }, installed, termWidth(), await $.clock.now(), false) +
        '\nThe user closes them with /flow checks pass <id...>, fail <id> <what you saw> or skip <id...> <why>; /flow checks <id> shows the steps.'
      $.clock.after(0, () => void $.prompt.submit({ text }).catch(() => undefined))
    })
    await best($, 'loading deploy gates', async () => {
      const dir = await stateDir($)
      if (dir === undefined) return
      const disk = normalizeDeploys(await readJson($, `${dir}/deploys.json`))
      await update($, deploys, () => disk)
      queueDue = queueDue || Object.entries(disk.targets).some(([name, t]) => t.due === true && mirror.deployInfos.some(i => i.name === name))
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
      description: 'Show the flow in a pane: managers, their workers, the reviewer and handed-over PRs. /flow inbox lists the open questions and the decisions agents made (/flow inbox decisions lists them all, /flow inbox <id> shows one in full), /flow ok keeps every open decision (/flow ok <id|owner|topic> takes those, or the default of a question), /flow no <id> [what instead] undoes a decision, /flow answer <id> <choice> answers any question addressed to main, /flow status shows what the agents cost (estimates at API list prices), /flow checks lists the after-deploy checks that need a person (pass or fail them), /flow preflight shows the current pre-flight round, /flow close closes it, /flow resume picks up unfinished flow work, /flow approve <pr> lets the reviewer merge a PR that awaits your approval, /flow push starts the push of the batch the reviewer checked and saved (push_mode confirm; /flow push back <pr> sends one PR back, /flow push drop returns them all), /flow hold <target> [batch|released] keeps a deploy target from deploying and /flow release <target> lets it, /flow clean lists leftover worktrees and branches (--yes removes them)',
      argumentHint: '[inbox [all|<id>]|ok [<id|owner|topic>...]|no <id> [what instead]|answer <id> <choice>|checks|status|preflight|close|resume|approve <pr>|push [back <pr>|drop]|clean]',
    })
    await $.command.register({
      name: 'flow-tasks',
      description: 'Pick tasks from a task source (.claude/flow/sources/<name>.md) and start a manager for each',
      argumentHint: '[source] [ids or filter]',
    })
    await registerAgents($, settings)

    await $.tool.register(HANDOVER_TOOL)
    await $.tool.register(RELEASE_TOOL)
    await $.tool.register(ASK_TOOL)
    await $.tool.register(FYI_TOOL)
    await $.tool.register(PREFLIGHT_TOOL)
    await $.tool.register(ANSWER_TOOL)
    await $.tool.register(STANDING_TOOL)
    await $.tool.register(CHECK_TOOL)
    await $.tool.register(NOTE_TOOL)
    // 'queue' is the tool's old name: prompts of a reviewer started by an older version still call it.
    for (const name of ['reviewer', 'queue']) await $.tool.register(reviewerTool(name))
    await $.tool.register(PUSH_TOOL)
    await $.tool.register(STATUS_TOOL)

    await $.tool.register(DEPLOY_TOOL)

    await $.tool.register(CLEAN_TOOL)
    await $.tool.register(MIGRATIONS_TOOL)

    await $.tool.register(PLAN_TOOL)

    await $.tool.register(TEST_SLOT_TOOL)

    await $.tool.register(GUARD_TESTS_TOOL)

    await $.tool.register(SESSION_TOOL)

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
  on('command.run', { command: 'flow' }, ($, e) => flowCommand(commandIoOf($), settings, installed, resumed, options, e.args))

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
  on('agent.offer', { agent: CONTINUE }, () => ({ isOffered: continuingCount() > 0 }))

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
      const checked = await checkAttachments(spawnIoOf($), e.prompt)
      if ('deny' in checked) return { deny: checked.deny }
      if (checked.prompt !== e.prompt) e = { ...e, prompt: checked.prompt }
    }
    if (await fableDenied(spawnIoOf($), e)) return { deny: FABLE_DENY }
    // Model routing: the brief's Size line (or a successor's escalation) picks the worker's model, over a model param.
    let routed: Routed | undefined
    if (e.subagentType === WORKER) {
      const r = await routeWorker(spawnIoOf($), e, { small: settings.workerModelSmall ?? 'haiku', normal: settings.workerModelNormal ?? 'sonnet', large: settings.workerModel })
      e = r.e
      routed = r.routed
    } else if (e.subagentType === MANAGER) {
      const r = await routeManager(spawnIoOf($), e, settings.managerModelSmall ?? 'sonnet', settings.managerModel)
      e = r.e
      routed = r.routed
    } else if (e.subagentType === 'Explore' && e.model === undefined && e.parentAgentId !== undefined) {
      // Read-only exploring by a flow agent runs on the cheap model; main's own and an explicit model stay as they are.
      const parent = (await $.agent.list()).find(a => a.id === e.parentAgentId)
      if (parent !== undefined && FLOW_TYPES.has(parent.type)) e = { ...e, model: settings.exploreModel ?? 'haiku' }
    }
    // A flow agent on a [1m] model: if sub-agents refuse it, retry on the plain model once and
    // remember, so later spawns skip the failed try. A no-model spawn gets the registered model.
    const spawn = e.subagentType === WORKER ? await prepareContinue(spawnIoOf($), e) : e
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
        if (e.subagentType === MANAGER) await best($, 'filing a manager-size decision', () => fileManagerSizeFyi(spawnIoOf($), options, (e as { name?: string }).name ?? e.description, id, r))
        else await best($, 'filing a worker-size decision', () => fileSizeFyi(spawnIoOf($), options, (e as { name?: string }).name ?? e.description, e.parentAgentId, r))
      }
      if (mirror.preflightOn && e.subagentType === MANAGER && e.parentAgentId === undefined) {
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
      // Merged branches are deleted by the plugin on the reviewer's "done"; a subagent never deletes a remote ref.
      const del = id === undefined ? undefined : remoteDeleteRefusal(e.command)
      if (del !== undefined) return { deny: del }
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
        const listed = (await $.agent.list()).find(a => a.id === to || a.name === to)
        // A manager the host dropped from the roster is held by the id last seen for it.
        const seenId = listed === undefined ? (await read($, seenAgents))[to]?.id : undefined
        const target = listed ?? (seenId === undefined ? undefined : { id: seenId, type: MANAGER, status: 'completed' })
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

  on('tool.call', { tool: 'mcp__flow__handover' }, ($, e) => handoverTool(handoverIoOf($, options), settings, e as unknown as Record<string, unknown>, e.agentId))

  on('tool.call', { tool: 'mcp__flow__release' }, ($, e) => releaseTool(releaseIoOf($), settings, e as unknown as Record<string, unknown>))

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
    if (e.agentId !== undefined) await noteRunWork($, e.agentId, w => noteWork(w, action))
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
      : action === 'done' ? { ...h, status: 'done', sha: String(input.sha ?? ''), report: await withCost($, h.branch, withFlaky(String(input.report ?? ''), e.agentId === undefined ? undefined : (await read($, testFails)).flaky[e.agentId])) }
      : action === 'back' ? { ...h, status: 'returned', reason: withFailed(String(input.reason ?? ''), input.failed_tests) }
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
      if (e.agentId !== undefined) await noteRunWork($, e.agentId, w => ({ ...(w ?? { touched: true, ready: false }), touched: true, line }))
      await best($, 'logging the main checkout', () => appendLog($, { event: 'main-ff', owner: next.reportTo, pr: next.pr, branch: next.branch, text: line }))
      verify = ` ${line}: copy this exact line into your final report; never run git against the main checkout yourself.`
      // Deleting the branch is the plugin's job, after it confirms the merge reached origin/<base>.
      const gone = await deleteMergedBranch(argv => $.process.run(argv), next.branch, settings.base)
      await best($, 'logging the branch delete', () => appendLog($, { event: 'branch-delete', owner: next.reportTo, pr: next.pr, branch: next.branch, text: gone }))
      verify += ` ${gone}.`
      await best($, 'capturing checks', async () => {
        const added = await captureChecks($, next, settings.verifyPaths, true)
        const scripted = added.filter(c => c.verifyCommand !== undefined)
        verify += scripted.map(c => ` Run \`${c.verifyCommand}\` in your worktree at the merged main now; on exit 0 call mcp__flow__check action pass id ${c.id} with a one-line note of the output tail; on failure call action fail with the failure tail as the note.`).join('')
        const skipped = added.filter(c => c.note !== undefined && c.verifyCommand === undefined)
        if (skipped.length) verify += ` Scripted verification is skipped for ${skipped.map(c => c.id).join(', ')} (${SKIP_NOTE.replace('scripted verification skipped: ', '')}); the check stays open for a person.`
      })
    }
    const rows = await refresh($)
    const filed = action === 'back' ? await suggestGuardTests(standingIoOf($), input, next.pr, rows.find(a => a.id === e.agentId)?.name ?? 'reviewer', e.agentId, settings.guardTests) : ''
    const size = action === 'back' ? await sizeBackNote($, next.branch) : undefined
    const sizeLine = size === undefined ? '' : `\nPut this line in your message to ${next.reportTo}: ${size}`
    return { result: `PR #${key}: ${next.status}.${verify}${filed}${sizeLine}` }
  })

  on('tool.call', { tool: 'mcp__flow__plan' }, ($, e) => planTool(planIoOf($), settings, e as unknown as Record<string, unknown>, e.agentId))

  on('tool.call', { tool: 'mcp__flow__test_slot' }, ($, e) => testSlotTool(slotsIoOf($), settings, e as unknown as Record<string, unknown>))

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

  on('tool.call', { tool: 'mcp__flow__ask' }, ($, e) => askTool(inboxIoOf($), options, e as unknown as Record<string, unknown>, e.agentId))
  on('tool.call', { tool: 'mcp__flow__fyi' }, ($, e) => fyiTool(inboxIoOf($), e as unknown as Record<string, unknown>, e.agentId))
  on('tool.call', { tool: 'mcp__flow__preflight' }, ($, e) => preflightTool(inboxIoOf($), options, e as unknown as Record<string, unknown>, e.agentId))
  on('tool.call', { tool: 'mcp__flow__answer' }, ($, e) => answerTool(inboxIoOf($), options, e as unknown as Record<string, unknown>, e.agentId))
  on('tool.call', { tool: 'mcp__flow__standing' }, ($, e) => standingTool(standingIoOf($), options, e as unknown as Record<string, unknown>, e.agentId))
  on('tool.call', { tool: 'mcp__flow__check' }, ($, e) => checkTool(checksIoOf($), installed, e as unknown as Record<string, unknown>, e.agentId))

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

  on('tool.call', { tool: 'mcp__flow__migrations' }, ($, e) => migrationsTool(migrationsIoOf($), settings, e as unknown as Record<string, unknown>))

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

  on('tool.call', { tool: 'mcp__flow__status' }, ($, e) => statusTool(statusIoOf($, options), settings, e as unknown as Record<string, unknown>, e.agentId))
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
      const runWork = me !== undefined && isReviewer(me.type) ? (await read($, reviewerWork))[id] : undefined
      if (me !== undefined && FLOW_TYPES.has(me.type)) {
        await best($, 'logging a report', async () => {
          const last = e.answer.trim().split('\n').pop() ?? ''
          const full = isReviewer(me.type) ? reviewerReport(e.answer, runWork) : undefined
          await appendLog($, { event: 'report', agent: me.name, owner: rows.find(a => a.id === me.parentId)?.name ?? 'main', text: full ?? last }, full === undefined ? TEXT_MAX : 4000)
        })
      }
      // No host notification reaches main for a reviewer the plugin spawned: relay its whole report,
      // only for runs that did batch work.
      if (me !== undefined && isReviewer(me.type)) {
        const work = runWork
        await update($, reviewerWork, m => Object.fromEntries(Object.entries(m).filter(([k]) => k !== id)))
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
    // The key row is drawn when any key in it works: the agents' keys, the reviewer's, or the inbox's.
    const anyOpen = openAll(await read($, inbox)).length > 0
    const checksLine = paneChecksLine(await read($, checks), installed)
    // One inbox line (counts and the key) follows the listed questions.
    const inboxRows = Math.min(openQs.length, 5) + (openQs.length > 5 ? 1 : 0) + (openQs.length > 0 || fyiCount > 0 ? 1 : 0) + (checksLine === undefined ? 0 : 1) + (gate === undefined ? 0 : gate.state === 'ready' ? 2 : 1)
    const deployLines = behindLines(mirror.deployInfos, await read($, deploys), await read($, behind)).slice(0, 3)
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

    const usageOf = (a: AgentRow): Usage | undefined => {
      const u = acts[a.id]?.usage
      if (u === undefined) return undefined
      const window = u.window ?? windowOf(u.model, mainModel, mainWindow, u.tokens)
      return { percent: Math.round(u.tokens / window * 100), tokens: u.tokens, window }
    }
    const meter = (u: Usage | undefined, dim: boolean, time: string) => meterTo({ Box, Text, Button }, settings, warnOf, u, dim, time)
    // Running time: to now while live, frozen at the end once it ended (the moment the roster saw
    // it end, else its last activity). No start on record, no time.
    const runTime = (act: Activity | undefined, isEnded: boolean): string =>
      act?.startedAt === undefined ? '' : elapsed((isEnded ? act.endedAt ?? act.lastAt : t) - act.startedAt)

    // Quota left per window, for Claude (this session's account) and the harnesses flow can read:
    // the share left as a bar that turns at 40% and 20%, the reset, and when the pace runs it out.
    const limits = [...claudeLimits(usage?.rateLimits ?? []), ...hLimits]
    const limitLine = (l: Limit) => limitLineTo({ Box, Text, Button }, t, l)

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
    const card = (a: AgentRow, depth: number, full: boolean, bordered: boolean, hot = false, collapsed?: boolean) => cardTo({
      els: { Box, Text, Button }, list, acts, askers, decisionPhrases: settings.decisionPhrases, t, usageOf, warnOf, meter, runTime, toggleFold, open,
    }, a, depth, full, bordered, hot, collapsed)
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
    const avail = rows - 1 - prRows - usageRows - (list.length === 0 ? 1 : 0) - (list.length > 0 || anyOpen || Object.keys(hs).length > 0 ? 1 : 0) - (unhanded.length > 0 ? 1 : 0) - (leftover ? 1 : 0) - inboxRows - deployLines.length
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
    if (mode === 'inbox') {
      // Only some surfaces have an Input; without one the keys still answer.
      const Input = ($.ui.resolve(e) as unknown as { Input?: (p: { key: string; label: string; placeholder: string; value: string; onInput: (v: string) => void; onSubmit: (v: string) => void }) => null }).Input
      const [ibox, icur, draft, note] = await Promise.all([read($, inbox), read($, inboxCursor), read($, inboxDraft), read($, inboxNote)])
      // The same rows a press reads, so what is drawn and what is pressed fold alike.
      const irows = (await paneInboxRows($)).rows
      const ihot = Math.max(0, irows.findIndex(r => r.key === icur))
      const hotRow = irows[ihot]
      const hq = hotRow?.q
      const detail = hq !== undefined ? 2 + hq.options.length + (hq.context ? 1 : 0) : 1
      const size = Math.max(2, rows - 1 - detail - 4 - 2)
      const win = viewOf(irows, ihot, size)
      const iBelow = irows.length - win.top - win.rows.length
      // Every press reads the inbox fresh (never the row drawn), so it acts on what is open now.
      // strict: a highlight that is no longer in the list (answered meanwhile, or folded away) answers nothing;
      // the highlight moves to the first row and the person presses again.
      const here = async (strict = true) => {
        await acted()
        const { rows: fresh } = await paneInboxRows($)
        const c = await read($, inboxCursor)
        const at = fresh.findIndex(r => r.key === c)
        if (strict && c !== null && at < 0) {
          const was = (await read($, inbox)).items.find(x => x.id === c)
          const by = was?.state === 'answered' ? ` (by ${was.answeredBy ?? '?'})` : ''
          await update($, inboxCursor, () => fresh[0]?.key ?? null)
          await update($, inboxNote, () => `${c} ${was?.state === 'answered' ? 'was answered meanwhile' : 'moved out of the list'}${by}; the highlight moved, press again.`)
          return undefined
        }
        const i = Math.max(0, at)
        return { fresh, i, row: fresh[i] }
      }
      // After an answer the highlight goes to the next row (else the one before), and the result is shown.
      const done = async (lines: string[], fresh: PaneRow[], i: number) => {
        const next = fresh[i + 1] ?? fresh[i - 1]
        await update($, inboxCursor, () => next?.key ?? null)
        const text = lines.join(' ')
        await update($, inboxNote, () => text)
        void $.ui.toast(clip(text, 120))
      }
      const say = (text: string) => update($, inboxNote, () => text)
      const answerRow = (id: string, choice: string | null) => answerQuestion($, id, choice, 'main', {}, true)
      const pickOption = (n: number) => () => paneSerial(async () => {
        const h = await here()
        if (h === undefined) return
        const { fresh, i, row } = h
        if (row?.q === undefined) return say('Move to a question or a decision first.')
        if (n >= row.q.options.length) return
        await done([await answerRow(row.q.id, row.q.options[n]!)], fresh, i)
      })
      const takeDefault = () => paneSerial(async () => {
        const h = await here()
        if (h === undefined) return
        const { fresh, i, row } = h
        if (row === undefined) return
        const lines: string[] = []
        let refused = 0
        for (const id of row.ids) {
          const q = (await read($, inbox)).items.find(x => x.id === id)
          const why = q === undefined ? undefined : protectedWhy(q)
          if (why !== undefined) { lines.push(why); refused++; continue }
          lines.push(await answerRow(id, null))
        }
        // A refusal leaves the highlight where it is.
        if (refused === lines.length) return say(lines.join(' '))
        await done(lines, fresh, i)
      })
      const keepAll = () => paneSerial(async () => {
        const h = await here(false)
        if (h === undefined) return
        const { fresh, i } = h
        const open = (await read($, inbox)).items.filter(x => x.state === 'open' && isFyi(x) && protectedWhy(x) === undefined)
        if (open.length === 0) return say('No open decisions to keep.')
        const lines: string[] = []
        for (const q of open) lines.push(await answerRow(q.id, null))
        const kept = lines.filter(l => l.includes(': Keep (default)')).length
        await done([`Kept ${kept} decision${kept === 1 ? '' : 's'}.`, ...lines.filter(l => !l.includes(': Keep (default)'))], fresh, i)
      })
      const undo = () => paneSerial(async () => {
        const h = await here()
        if (h === undefined) return
        const { fresh, i, row } = h
        if (row?.q === undefined || !isFyi(row.q)) return say('n undoes one decision: move to it first.')
        const text = (await read($, inboxDraft)).trim()
        await update($, inboxDraft, () => '')
        await done([await answerRow(row.q.id, text === '' ? OVERTURN : text)], fresh, i)
      })
      const reply = () => paneSerial(async () => {
        await acted()
        await say('Type your answer and press Enter.')
        void $.ui.focus({ requestId: PANE, key: 'inbox-answer' }).catch(() => undefined)
      })
      const submit = (value: string) => void paneSerial(async () => {
        const text = value.trim()
        if (text === '') return
        const h = await here()
        if (h === undefined) return
        const { fresh, i, row } = h
        if (row?.q === undefined) return say('Move to a question or a decision first.')
        await update($, inboxDraft, () => '')
        await done([await answerRow(row.q.id, text)], fresh, i)
      })
      const move = (d: number) => () => paneSerial(async () => {
        const h = await here(false)
        if (h === undefined) return
        const { fresh, i } = h
        const to = fresh[Math.min(fresh.length - 1, Math.max(0, i + d))]
        if (to !== undefined) await update($, inboxCursor, () => to.key)
      })
      const back = async () => {
        await acted()
        await update($, viewMode, () => 'tree')
      }
      const nOpts = hq?.options.length ?? 0
      const nQ = ibox.items.filter(x => x.state === 'open' && !isFyi(x)).length
      const nF = ibox.items.filter(x => x.state === 'open' && isFyi(x)).length
      return (
        <Box flexDirection="column" height={rows}>
          <Text bold>Inbox <Text dimColor>{irows.length === 0 ? 'Nothing open.' : `${nQ} question${nQ === 1 ? '' : 's'}, ${nF} decision${nF === 1 ? '' : 's'}`}</Text></Text>
          {win.top > 0 && <Text dimColor>  ↑ {win.top} above</Text>}
          {win.rows.map(r => (
            <Button key={`row-${r.key}`} plain onPress={() => void paneSerial(async () => { await acted(); await update($, inboxCursor, () => r.key) })}>
              <Text inverse={r.key === hotRow?.key} color={r.q.blocking ? 'warning' : undefined} wrap="truncate-end">{r.key === hotRow?.key ? '> ' : '  '}{paneRowText(r)}</Text>
            </Button>
          ))}
          {iBelow > 0 && <Text dimColor>  ↓ {iBelow} more</Text>}
          {hq !== undefined && (
            <Box flexDirection="column">
              <Text bold>{hq.id} {isFyi(hq) ? 'decision' : 'question'} {tagsOf(hq)}</Text>
              <Text>{hq.question}</Text>
              {hq.options.map((o, k) => <Text key={`opt-${k}`}>  {String.fromCharCode(97 + k)}) {o}{o === hq.default ? ' (default)' : ''}</Text>)}
              {hq.context && <Text dimColor>why: {clip(hq.context, 200)}</Text>}
            </Box>
          )}
          {hotRow === undefined && <Text dimColor>Nothing to answer.</Text>}
          {note !== '' && <Text color="suggestion" wrap="truncate-end">{note}</Text>}
          <Box flexGrow={1} />
          {Input !== undefined && <Input key="inbox-answer" label="answer " placeholder="your own words (r), or what instead (n)" value={draft} onInput={(v: string) => void update($, inboxDraft, () => v)} onSubmit={submit} />}
          <Box flexDirection="row" gap={1}>
            {Array.from({ length: Math.min(nOpts, 8) }, (_, k) => (
              <Button key={`pick-${String.fromCharCode(97 + k)}`} plain dimColor hotkey={String.fromCharCode(97 + k)} onPress={pickOption(k)}>{String.fromCharCode(97 + k)}</Button>
            ))}
            {Array.from({ length: Math.min(nOpts, 9) }, (_, k) => (
              <Button key={`pick-${k + 1}`} plain dimColor hotkey={String(k + 1)} onPress={pickOption(k)}>{k + 1}</Button>
            ))}
            {nOpts > 0 && <Text dimColor>pick</Text>}
          </Box>
          <Box flexDirection="row" gap={1}>
            <Button key="inbox-next" plain dimColor hotkey="j" onPress={move(1)}>j next</Button>
            <Button key="inbox-prev" plain dimColor hotkey="k" onPress={move(-1)}>k prev</Button>
            <Button key="inbox-yes" plain dimColor hotkey="y" onPress={takeDefault}>y default/keep</Button>
            <Button key="inbox-all" plain dimColor hotkey="w" onPress={keepAll}>w keep all decisions</Button>
            <Button key="inbox-no" plain dimColor hotkey="n" onPress={undo}>n undo</Button>
            <Button key="inbox-reply" plain dimColor hotkey="r" onPress={reply}>r reply</Button>
            <Button key="inbox-back" plain dimColor hotkey="i" onPress={back}>i back</Button>
          </Box>
        </Box>
      )
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
      <Box flexDirection="column" height={rows}>
        {gate !== undefined && gate.state === 'ready' && (
          <Text color="warning" bold wrap="truncate-end">⇪ Batch {gate.id} ready to push: {gate.prs.map(n => `#${n}`).join(' ')}{gate.version === undefined ? '' : ` (${gate.version})`} · check: {gate.check}</Text>
        )}
        {gate !== undefined && gate.state === 'ready' && <Text color="warning" wrap="truncate-end">  /flow push · /flow push back {'<pr>'} · /flow push drop</Text>}
        {gate !== undefined && gate.state !== 'ready' && (
          <Text color="suggestion" wrap="truncate-end">⇪ Batch {gate.id} {gate.state === 'pushing' ? 'released, a reviewer is pushing it' : `is being rebuilt${gate.reason === undefined ? '' : ` (${gate.reason})`}`}: {gate.prs.map(n => `#${n}`).join(' ')}</Text>
        )}
        <Text dimColor>{list.length} agents · {live} live{prs.length ? ` · ${prs.length} PR${prs.length === 1 ? '' : 's'} with the reviewer` : ''}{list.length > 0 ? ' · press an agent to open it' : ''}</Text>
        {openQs.slice(0, 5).map(q => (
          <Text color={q.blocking ? 'warning' : undefined} wrap="truncate-end">{q.id} {q.owner}: {q.question}</Text>
        ))}
        {openQs.length > 5 && <Text dimColor>and {openQs.length - 5} more</Text>}
        {(openQs.length > 0 || fyiCount > 0) && (
          <Text dimColor wrap="truncate-end">
            Inbox: {[
              ...(openQs.length > 0 ? [`${openQs.length} question${openQs.length === 1 ? '' : 's'} for you${openQs.some(q => q.blocking) ? ` (${openQs.filter(q => q.blocking).length} blocking)` : ''}`] : []),
              ...(fyiCount > 0 ? [`${fyiCount} decision${fyiCount === 1 ? '' : 's'} agents made`] : []),
            ].join(', ')}. Press i to answer or keep them.
          </Text>
        )}
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
        {(list.length > 0 || anyOpen || prs.length > 0) && <Box flexGrow={1} />}
        {(list.length > 0 || anyOpen || prs.length > 0) && (
          <Box flexDirection="row" gap={1}>
            {list.length > 0 && <Button key="nav-next" plain dimColor hotkey="j" onPress={step(1)}>j next</Button>}
            {list.length > 0 && <Button key="nav-prev" plain dimColor hotkey="k" onPress={step(-1)}>k prev</Button>}
            {list.length > 0 && <Button key="nav-open" plain dimColor hotkey="o" onPress={async () => { const i = await hotItem(); if (i) await open(i.a.id) }}>o open</Button>}
            {list.length > 0 && <Button key="nav-fold" plain dimColor hotkey="c" onPress={async () => {
              const i = await hotItem()
              if (i) await toggleFold(i.a, i.collapsed)
            }}>{items[hotIdx]?.collapsed ? 'c expand' : 'c collapse'}</Button>}
            {prs.length > 0 && <Button key="nav-queue" plain dimColor hotkey="q" onPress={toggleQueue}>q reviewer</Button>}
            {anyOpen && <Button key="nav-inbox" plain dimColor hotkey="i" onPress={async () => {
              await acted()
              await update($, inboxCursor, () => null)
              await update($, viewMode, () => 'inbox')
            }}>i inbox</Button>}
            {list.length > 0 && toggle}
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
