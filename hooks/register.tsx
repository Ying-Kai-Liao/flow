// This file is the wiring only: atoms, `on(...)` hooks, `$.tool.register` calls, and io builders whose
// closures spell out each `$.noun.event(...)` call. New logic goes into a module under hooks/, either
// pure or taking an io object of closures (deliver.ts; pane-run.tsx holds the pane's hook bodies this way).
// Which module holds each hook's body: docs/reference.md, "Where code goes".
// The engine's rules: `$` never crosses an import (no imported function taking `$`, no `$`-taking closure
// passed as an argument); a module may register its own hooks with an exported registerX(on, ctx) when
// everything its hooks call with `$` is in that same file; atoms are declared with literal refs in each
// file that uses them (the same key is the same state).
import { atom, read, update } from 'claude-code'
import { startSession } from './startup-run'
import type { StartupIo } from './startup-run'
import { parseMode } from './mergemode'
import type { AgentInfo, EngineInterface, Register } from 'claude-code'

import type { Activity, AgentRow, Breaker, Ledger, EnvChange, Handover, HandoffRecord, Leftovers, LogEvent, OpenPr, PrCache, Session, SlotEntry, TestSlots } from '../types'
import { grantFile, grantSlots, reapSlots } from './slots'
import { grantTypecheck, reapTypecheck, typecheckDir } from './typecheck-slots'
import type { Evidence } from './evidence'
import type { RunWork } from './mainff'
import { NO_FAILS, type TestFails } from './testfail'
import { sweep as sweepTo } from './clean'
import type { CleanInputs, CleanIo, Kept, PrRow, Sweep } from './clean'
import { gatherLeftovers as gatherLeftoversTo } from './resume'
import type { Gathered, Leftover, ResumeIo } from './resume'
import { deliver as deliverTo, flushAgent as flushTo, holdForReviewer as holdTo, resetDelivery, ENDED, type DeliverIo, type DeliverOptions } from './deliver'
import { addStep, addTurn, baseName, entriesOfBranch } from './cost'
import { changeLedger as changeLedgerTo, costLines as costLinesTo, loadLedger as loadLedgerTo, mainKey as mainKeyTo, withCost as withCostTo } from './cost-run'
import type { CostIo } from './cost-run'
import { countStep, countTurn, meterStep, type UsageIo } from './usage-run'
import { beforeStep, completeTurn } from './turn-run'
import type { TurnIo } from './turn-run'
import { backNote, effortFor } from './routing'
import { sizeWith } from './spawn'
import type { SizeJev } from './spawn'
import { decide, DECIDE_TIMEOUT_MS, sourceOf } from './decide'
import type { DecideIo, DecideSettings, FetchLike } from './decide'
import { handoffLean } from './decide-use'
import type { SpawnIo } from './spawn'
import { onSpawn } from './spawn-run'
import type { SpawnHookIo } from './spawn-run'
import { agentFor, asksQuestion, noticeText, settle } from './dag'
import type { AgentFact, Facts, Notice, Plan } from './dag'
import {
  answerMessage, EMPTY_INBOX, findItem, markAnswered, overridesManager, paneRows, needsMessage, normalizeInbox, notesOwner, endedOwners, FOLD_KEY, 
} from './inbox'
import type { PaneRow } from './inbox'
import {
  closeStale, denyText, dueRound, EMPTY_PREFLIGHT, gateOf, markDelivered, normalizePreflight, renderRound,
} from './preflight'
import type { Preflight } from './preflight'
import { EMPTY_LITE, isLiteName, normalizeLite } from './lite'
import type { LiteState, ToolCaller } from './lite'
import {
  addChecks, anyMatch, EMPTY_CHECKS, normalizeChecks, parseNeeds,
  SKIP_NOTE, versionInSteps,
} from './checks'
import type { Check, Checks } from './checks'
import type { Inbox, Marked, Question } from './inbox'
import { addGuardTest, dismissSuggestionIds, loadRules, offerSeedsOnce, paneSuggestions, standingTool, suggestGuardTests } from './standing-run'
import type { StandingIo } from './standing-run'
import { decideEvalTool } from './decide-eval-run'
import { sizeAbTool } from './size-ab'
import { armHidden, armsTool } from './bestof'
import type { ArmsIo } from './bestof'
import type { DecideEvalIo } from './decide-eval-run'
import { DEMO_TOOL, SETTINGS_TOOL } from './init-tools'
import { ANSWER_TOOL, ASK_TOOL, CHECK_TOOL, CLEAN_TOOL, DECIDE_EVAL_TOOL, DEPLOY_TOOL, FYI_TOOL, GUARD_TESTS_TOOL, HANDOVER_TOOL, MIGRATIONS_TOOL, NOTE_TOOL, PLAN_TOOL, PREFLIGHT_TOOL, PUSH_TOOL, RELEASE_TOOL, ARMS_TOOL, reviewerTool, SESSION_TOOL, SIZE_AB_TOOL, STANDING_TOOL, STATUS_TOOL, TEST_SLOT_TOOL } from './tools'
import { detect as initDetect, firstRun, HINT as INIT_HINT, settingsTool, writeMarker } from './init'
import type { InitIo } from './init'
import { demoArm, demoMove, demoStart, demoStop, demoTool } from './demo-run'
import type { DemoIo } from './demo-run'
import type { DemoState } from './demo-replay'
import { paneDraw, paneFocus } from './pane-run'
import type { PaneEvent, PaneIo } from './pane-run'
import { approvePr, platformOfUname, rejectPr } from './prcard'
import type { DetailsCache } from './prcard'
import { ROLE } from './pane'
import {
  fill, REVIEWER_PROMPT, REVIEWER_SESSION_RULES_AUTO,
  REVIEWER_SESSION_RULES_CONFIRM,
} from './prompts'
import type { Settings } from './prompts'
import { deployTargetsOf, stateFileOf, targetsOf } from './prompts'
import { renameOptions, settingsOf } from './settings'
import { releaseTool } from './release-run'
import type { ReleaseIo } from './release-run'
import { FORWARDED_RIDS, mainHasAnswer as mainHasAnswerTo, managerFinished as managerFinishedTo, RELAY_DELAY_MS, resolveReportTo as resolveReportToTo, reviewerReport, reviewerSendGuard } from './reviewer-route'
import type { Forwarded, RouteIo } from './reviewer-route'
import { noteReviewerEnd, onReviewerAnswer as onReviewerAnswerTo, releaseHalt as releaseHaltTo, reviewerToolRun, startQueue } from './reviewer-run'
import { reconcileStale } from './stale-handovers'
import type { StaleIo } from './stale-handovers'
import type { BreakerIo, QueueIo, ReviewerIo } from './reviewer-run'
import { EMPTY_BREAKER, REVIEWER_KIND } from './reviewer-breaker'
import { handoverTool } from './handover-run'
import type { HandoverIo } from './handover-run'
import { answerQuestionTo, noteText, paneInboxRowsTo, sizeBackNoteTo, tellMainTo, tellManagerTo, type MessagingIo } from './messaging-run'
import { askTool, answerTool, fyiTool, preflightTool } from './inbox-run'
import type { InboxIo } from './inbox-run'
import { checkTool } from './checks-run'
import type { ChecksIo } from './checks-run'
import { isManagerOf, liveManagers, planOwner, refreshTo, syncPlansTo } from './roster-run'
import type { RosterIo } from './roster-run'
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
import { elapsed, tokensDown, labelOf, thresholdOf, wrapUpText } from './meter'
export { elapsed, tokensDown } from './meter'
import { afterToolCall, beforeToolCall, cleanCase, deployCase, guardTestsCase, mainCheckoutGuard as mainCheckoutGuardTo, noteCase, pushCase, releaseCase, reviewerCase, sessionCase } from './toolcall-run'
import type { FlowToolsIo, GuardIo, ToolCallIo } from './toolcall-run'
import { flowCatch, toolCatch } from './toolguard'
import {
  ago, harnessesOf, roleAgents, roleHarnessOf, runsOutIn, sessionLive, sessionRow,
} from './sessions'
import type { HarnessSpec, Limit } from './sessions'
import { sendToSession, sessionTool as sessionToolTo, startRoleSession, watchSessions as watchSessionsTo } from './session-run'
import { relayCall } from './relay'
import type { MainIdentity, PumpIo, RelayIo } from './relay'
import { alreadyForwardedTo, deliverToSessionTo, pumpOnceTo, relayToolCallTo } from './relay-run'
import type { RelayExecIo, RelayMode, RelayRunIo } from './relay-run'
import { adoptSessionsTo, durableSessions, identityTo, myRoleSessionsTo, normalizeSessions, onRoleGoneTo, onRoleReportTo, ownsSessionTo, persistSessionsTo, roleState } from './role-session-run'
import type { RoleIo } from './role-session-run'

import type { Caller, Ran, SessionIo } from './session-run'
import { branchOwners, noteKey } from './state'
import { ADD_OPTION } from './guardtests'
import {
  EMPTY_PUSH,
} from './pushgate'
import type { PushState } from './pushgate'
import { onPushAnswer as onPushAnswerTo, pushAct as pushActTo, recordReady as recordReadyTo, settleBatch as settleBatchTo } from './pushgate-run'
import type { PushAct, PushIo } from './pushgate-run'
import {
  EMPTY_DEPLOYS, ENV_KIND,
  release,
} from './deploy'
import { cap, CONTINUE, DEFAULT_WORKER_MODEL, isReviewer, LOG_MAX, MANAGER, mirror, NOTES_MAX, PANE, POLL_MS, TEXT_MAX, WORKER, WORKERS } from './core'
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
// Managers started in lite mode (lite.ts), mirrored from <state dir>/lite.json.
const lite = atom({ plugin: 'flow', key: 'lite' } as const, EMPTY_LITE as LiteState)
const checks = atom({ plugin: 'flow', key: 'checks' } as const, EMPTY_CHECKS as Checks)
// Tokens spent per agent and model, mirrored (throttled) to <state dir>/ledger.json. Never forgets an ended agent.
const ledger = atom({ plugin: 'flow', key: 'ledger' } as const, {} as Ledger)
// Set once the disk history is merged into the ledger atom; the atom outlives a plugin reload, so this must too.
const ledgerLoaded = atom({ plugin: 'flow', key: 'ledgerLoaded' } as const, false)
// What this process counted since its last save, and the epoch of the file its base came from (see cost-run.ts).
const ledgerDelta = atom({ plugin: 'flow', key: 'ledgerDelta' } as const, {} as Ledger)
const ledgerEpoch = atom({ plugin: 'flow', key: 'ledgerEpoch' } as const, '')
const handoffs = atom({ plugin: 'flow', key: 'handoffs' } as const, {} as Record<string, HandoffRecord>)
const queueRuns = atom({ plugin: 'flow', key: 'queueRuns' } as const, 0)
// The reviewer respawn circuit breaker, mirrored from <state dir>/reviewer-breaker.json.
const reviewerBreaker = atom({ plugin: 'flow', key: 'reviewerBreaker' } as const, EMPTY_BREAKER as Breaker)
// The open PRs gh listed last, so the 3 s refresh never calls gh itself.
const prCache = atom({ plugin: 'flow', key: 'prCache' } as const, { prs: [], fetchedAt: 0 } as PrCache)
// The last dry cleanup sweep, refreshed with the PR list so a render never runs git.
const sessions = atom({ plugin: 'flow', key: 'sessions' } as const, {} as Record<string, Session>)
// What the reviewer routing already sent main, so a retried or repeated report reaches it once:
// Scoped to the sending reviewer run (its agent id), so a later run's different outcome is never swallowed.
// `keys` maps "reviewer|manager|PR numbers" to the needs-a-person / pending-decisions lines forwarded for it,
// `lines` is, per reviewer id, every line forwarded (normalized). Persisted: plugins reload mid-session.
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
  activity: Record<string, Activity>, t: number, graceMs = GRACE_MS, armPr?: (branch: string) => boolean,
): Unhanded[] {
  const out: Unhanded[] = []
  for (const p of prs) {
    if (p.isDraft || !p.headRefName.startsWith('flow/')) continue
    const ho = handovers[String(p.number)]
    if (ho !== undefined && ho.status !== 'returned') continue
    // A best-of-N arm waits for its pick: not forgotten while the group is open, never owed once it lost.
    if (armPr?.(p.headRefName) === true) continue
    const slug = p.headRefName.slice('flow/'.length)
    const mine = roster.filter(a => a.name === slug || (a.name?.startsWith(`${slug}-`) === true && /^\d+$/.test(a.name.slice(slug.length + 1))))
    if (mine.some(a => !ENDED.has(a.status))) continue
    const endedAt = Math.max(...mine.map(a => activity[a.id]?.endedAt ?? activity[a.id]?.lastAt ?? 0))
    if (mine.length > 0 && endedAt > 0 && t - endedAt < graceMs) continue
    const last = mine.length > 0 ? mine.reduce((x, y) => (activity[y.id]?.endedAt ?? 0) >= (activity[x.id]?.endedAt ?? 0) ? y : x) : undefined
    const note = ho !== undefined ? `returned: ${ho.reason ?? ''}`
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
  await loadLedger($)
  const l = await read($, ledger)
  // The log is read only once an arm exists: this runs on every pane tick.
  const armLog = Object.values(l).some(r => r.arm !== undefined) ? await readLog($) : []
  const armPr = armHidden(l, armLog, name => rows.some(a => a.name !== undefined && baseName(a.name) === baseName(name) && !ENDED.has(a.status)))
  return unhandedPrs(cache.prs, hs, rows, acts, t, undefined, armPr)
}
const plan = atom({ plugin: 'flow', key: 'plan' } as const, {} as Plan)
// The pane draws the agents as a tree of cards or as the dependency graph; the graph's highlight is a node id.
const viewMode = atom({ plugin: 'flow', key: 'viewMode' } as const, 'tree' as 'tree' | 'graph' | 'inbox' | 'card' | 'archive' | 'pr' | 'batch')
// The PR card (prcard.ts) and the batch card: the PR shown, where Back goes, the PR picked to send back, and the gh details by PR and head.
const prShown = atom({ plugin: 'flow', key: 'prShown' } as const, null as number | null)
const prBack = atom({ plugin: 'flow', key: 'prBack' } as const, 'tree' as 'tree' | 'batch')
const batchPick = atom({ plugin: 'flow', key: 'batchPick' } as const, null as number | null)
const prDetails = atom({ plugin: 'flow', key: 'prDetails' } as const, {} as DetailsCache)
// The inbox view: the highlighted row's key, the typed answer and the last result line.
const inboxCursor = atom({ plugin: 'flow', key: 'inboxCursor' } as const, null as string | null)
// The card view: the highlighted id is inboxCursor; Back returns to where the card was opened from.
const cardBack = atom({ plugin: 'flow', key: 'cardBack' } as const, 'inbox' as 'tree' | 'inbox' | 'archive')
// Which inbox cards are open, by fold key (grp:<owner>, fold): true is open; a key not here takes the card's default.
const inboxFolds = atom({ plugin: 'flow', key: 'inboxFolds' } as const, {} as Record<string, boolean>)
// Which inbox items are expanded into cards, by item id; a key not here is collapsed. Ids of items that left the list linger harmlessly.
const inboxOpen = atom({ plugin: 'flow', key: 'inboxOpen' } as const, {} as Record<string, boolean>)
const inboxDraft = atom({ plugin: 'flow', key: 'inboxDraft' } as const, '')
const inboxNote = atom({ plugin: 'flow', key: 'inboxNote' } as const, '')
const graphFocus = atom({ plugin: 'flow', key: 'graphFocus' } as const, null as string | null)
const testSlots = atom({ plugin: 'flow', key: 'testSlots' } as const, { holders: [], waiters: [] } as TestSlots)
// Its own key, so state persisted before this pool existed loads as empty.
const typecheckSlots = atom({ plugin: 'flow', key: 'typecheckSlots' } as const, { holders: [], waiters: [] } as TestSlots)

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
      : { ...g.state, holders: g.state.holders.map(holder => holder.key === me ? { ...holder, claimed: true } : holder) }
    granted = g.granted.filter(holder => holder.key !== me)
    const stay = new Set([...state.holders, ...state.waiters].map(e => e.key))
    left = [...st.holders, ...st.waiters].map(e => e.key).filter(k => !stay.has(k))
    return state
  })
  for (const n of notes) void $.ui.toast(n)
  await signalSlots($, granted, left)
}

const sh = ($: EngineInterface, script: string, ...args: string[]) =>
  $.process.run(['sh', '-c', script, 'sh', ...args], { timeoutMs: 5_000 }).catch(() => undefined)

async function signalSlots($: EngineInterface, granted: SlotEntry[], left: string[], kind: 'test' | 'typecheck' = 'test'): Promise<void> {
  const dir = kind === 'test' ? slotDir : typecheckDir(slotDir)
  for (const key of left) {
    const f = grantFile(dir, key)
    if (f) await sh($, 'rm -f "$1"', f)
  }
  for (const g of granted) {
    const f = grantFile(dir, g.key)
    if (f) await sh($, 'mkdir -p "$(dirname "$1")" && : > "$1"', f)
    if (g.key !== 'main') {
      await deliver($, g.key, kind === 'test' ? `flow: your test slot is granted (${g.label}). Call mcp__flow__test_slot acquire to confirm, run, then release.` : `flow: your typecheck slot is granted (${g.label}). Call mcp__flow__test_slot kind "typecheck" action "acquire" to confirm, run, then release.`, { onGone: () => undefined }).catch(() => undefined)
    }
  }
}

// settleSlots for the typecheck pool: the same steps, its own state, limit and lease.
async function settleTypecheck($: EngineInterface, rows: AgentRow[], t: number, pre: (s: TestSlots) => TestSlots = s => s, me?: string): Promise<void> {
  const notes: string[] = []
  let granted: SlotEntry[] = []
  let left: string[] = []
  await update($, typecheckSlots, st => {
    notes.length = 0
    const r = reapTypecheck(pre(st), rows, t)
    const g = grantTypecheck(r.state, heldSettings?.typecheckSlots ?? 1, t)
    notes.push(...r.notes, ...g.notes)
    const state = me === undefined ? g.state
      : { ...g.state, holders: g.state.holders.map(holder => holder.key === me ? { ...holder, claimed: true } : holder) }
    granted = g.granted.filter(holder => holder.key !== me)
    const stay = new Set([...state.holders, ...state.waiters].map(e => e.key))
    left = [...st.holders, ...st.waiters].map(e => e.key).filter(k => !stay.has(k))
    return state
  })
  for (const n of notes) void $.ui.toast(n)
  await signalSlots($, granted, left, 'typecheck')
}

// The last batch the release tool cut, so a retried push does not release twice.
let lastRelease: { key: string; version: string } | undefined

function releaseIoOf($: EngineInterface): ReleaseIo {
  return {
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
  }
}

function handoverIoOf($: EngineInterface, options: Record<string, unknown>): HandoverIo {
  return {
    run: argv => $.process.run(argv),
    now: () => $.clock.now(),
    handovers: () => read($, handovers),
    putHandover: async (pr, ho) => { await update($, handovers, hs => ({ ...hs, [pr]: ho })) },
    resolveReportTo: (given, callerId) => resolveReportTo($, given, callerId),
    openEnv: (ho, drafts, prev, at) => openHandoverEnv($, options, ho, drafts, prev, at),
    best: (what, fn) => best($, what, fn),
    saveHandover: ho => saveHandover($, ho),
    appendLog: event => appendLog($, event),
    toast: text => { void $.ui.toast(text) },
    refresh: () => refresh($),
    arms: async () => { await loadLedger($); return { ledger: await read($, ledger), log: await readLog($) } },
    ensureQueue: () => ensureQueue($),
    liteManager: agentId => liteManagerOf($, agentId),
  }
}

function planIoOf($: EngineInterface): PlanIo {
  return {
    refresh: () => refresh($),
    plans: () => read($, plan),
    planOwner: (plans, name) => planOwner(plans, name),
    limitsLine: (rows, workers) => limitsLine(rows, workers),
    syncPlans: (rows, edit, quietOwner) => syncPlans($, rows, edit, quietOwner),
  }
}

function inboxIoOf($: EngineInterface): InboxIo {
  return {
    standing: standingIoOf($),
    refresh: () => refresh($),
    deliver: (id, text, opts) => deliver($, id, text, opts),
    toast: text => { void $.ui.toast(text) },
    ownerNameOf: id => ownerNameOf($, id),
    answerQuestion: (wanted, choice, by, options, user) => answerQuestion($, wanted, choice, by, options, user),
    withPreflight: fn => withPreflight($, fn),
    preflightTick: rows => preflightTick($, rows),
    submitLater: text => { $.clock.after(0, () => void $.prompt.submit({ text }).catch(() => undefined)) },
    paneOpen: () => flowPaneOpen($),
    net: decideIoOf($),
  }
}

function checksIoOf($: EngineInterface): ChecksIo {
  return {
    agents: () => agentsOf($),
    checks: () => read($, checks),
    now: () => $.clock.now(),
    withChecks: fn => withChecks($, fn),
  }
}

function slotsIoOf($: EngineInterface): SlotsIo {
  return {
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
    typecheckSlots: () => read($, typecheckSlots),
    settleTypecheck: (rows, t, pre, me) => settleTypecheck($, rows, t, pre, me),
  }
}

function armsIoOf($: EngineInterface): ArmsIo {
  return {
    run: argv => $.process.run(argv),
    ledger: async () => { await loadLedger($); return read($, ledger) },
    log: () => readLog($),
    appendLog: event => appendLog($, event),
    callerName: async id => id === undefined ? undefined : (await agentsOf($)).find(a => a.id === id)?.name,
    liveNames: async () => (await agentsOf($)).filter(a => !ENDED.has(a.status) && a.name !== undefined).map(a => a.name!),
  }
}

function migrationsIoOf($: EngineInterface): MigrationsIo {
  return {
    runCmd: argv => runCmd($, argv),
  }
}

function statusIoOf($: EngineInterface, options: Record<string, unknown>, base: string): StatusIo {
  return {
    reconcile: () => reconcileStale(staleIoOf($, base)),
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
    typecheckSlots: () => read($, typecheckSlots),
    offerSeeds: () => offerSeedsOnce(standingIoOf($), options),
    pushState: () => read($, pushState),
    breaker: () => read($, reviewerBreaker),
    deploys: () => read($, deploys),
    behind: () => read($, behind),
    limitsLine: (rows, workers) => limitsLine(rows, workers),
    stateDir: () => stateDir($),
  }
}

function commandIoOf($: EngineInterface): CommandIo {
  return {
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
    endedOwners: () => endedOwnersOf($),
    panes: async () => [...(await $.ui.panes())],
    close: () => $.ui.close({ id: PANE }),
    home: () => paneHome($),
    open: () => $.ui.open({ id: PANE, title: 'Flow', focus: true, closeOnEscape: true }),
    gatherLeftovers: (base, resumed) => gatherLeftovers($, base, resumed),
    pushState: () => read($, pushState),
    after: (ms, fn) => { $.clock.after(ms, fn) },
    submit: text => $.prompt.submit({ text }),
    notesPath: owner => notesPath($, owner),
    readNotes: owner => readNotes($, owner),
    sweep: (base, apply, dryHint) => sweep($, base, apply, dryHint),
    putHandover: async (pr, ho) => { await update($, handovers, hs => ({ ...hs, [pr]: ho })) },
    best: (what, fn) => best($, what, fn),
    saveHandover: ho => saveHandover($, ho),
    appendLog: event => appendLog($, event),
    toast: text => { void $.ui.toast(text) },
    ensureQueue: () => ensureQueue($),
    releaseReviewerHalt: () => releaseHaltTo(breakerIoOf($), 'user'),
    refresh: () => refresh($),
    pushAct: (act, by) => pushAct($, act, by),
    holdTarget: (name, until, by, reason) => holdTarget($, name, until, by, reason),
    releaseTarget: name => releaseTarget($, name),
    refreshBehind: () => refreshBehind($),
    closeReturnedEnv: ho => closeReturnedEnv($, ho),
    settleBatch: () => settleBatch($),
    tellManager: (name, text) => tellManager($, name, text),
    initDetect: options => initDetect(initIoOf($), options),
    initMark: d => writeMarker(initIoOf($), d),
    demoStart: () => demoStart(demoIoOf($)),
    demoStop: () => demoStop(demoIoOf($)),
  }
}

function limitsLine(rows: AgentRow[], workers: number): string {
  return `Limits: managers ${liveManagers(rows).length}/${mirror.maxManagers}, workers per manager ${workers}`
}

// --- /flow init: the io detection works through, and the demo replay (demo-replay.ts) ---

function initIoOf($: EngineInterface): InitIo {
  return {
    readFile: path => readText($, path),
    exists: path => $.fs.exists(path).then(Boolean, () => false),
    writeFile: async (path, text) => {
      try {
        const tmp = `${path}.${Date.now()}.tmp`
        await $.fs.write(tmp, text)
        return (await $.process.run(['mv', tmp, path])).exitCode === 0
      } catch {
        return false
      }
    },
    mkdirp: dir => $.process.run(['mkdir', '-p', dir]),
    run: argv => runCmd($, argv, 15_000),
  }
}

// The replay's state is this atom alone: no agent, handover or inbox row of the real flow is touched, and a
// restart loses it. Each start gets a new generation, so a timer of an earlier run does nothing.
const demo = atom({ plugin: 'flow', key: 'demo' } as const, null as DemoState | null)

// The io the demo functions (demo-run.ts) work through; the entry points below stay `$`-taking wrappers.
function demoIoOf($: EngineInterface): DemoIo {
  return {
    get: () => read($, demo),
    set: fn => update($, demo, fn).then(() => undefined),
    clearInbox: async () => {
      await update($, inboxDraft, () => '')
      await update($, inboxNote, () => '')
    },
    serial: paneSerial,
    now: () => $.clock.now(),
    toast: text => { void $.ui.toast(text) },
    after: (ms, fn) => { $.clock.after(ms, fn) },
    openPane: () => $.ui.open({ id: PANE, title: 'Flow', focus: true, closeOnEscape: true }),
    listAgents: () => $.agent.list(),
    run: argv => runCmd($, argv),
  }
}

// The view the pane was last drawn under: a focus event carries none, and a focus move is the
// person acting in that view.
let paneView: string | null = null

// Home: the tree with nothing selected and every card, view and demo closed. The followed transcript is
// adopted as the ui.focus handler does, so the pane does not jump back to it. inboxDraft stays: an
// unsent draft survives.
async function paneHome($: EngineInterface): Promise<void> {
  await update($, overrideView, () => paneView)
  await update($, selected, () => null)
  await update($, graphFocus, () => null)
  await update($, viewMode, () => 'tree')
  await update($, inboxNote, () => '')
  await update($, inboxOpen, () => ({}))
  await update($, batchPick, () => null)
  await update($, prShown, () => null)
  if (await read($, demo) !== null) await demoStop(demoIoOf($))
}

function rosterIoOf($: EngineInterface): RosterIo {
  return {
    list: () => $.agent.list(),
    now: () => $.clock.now(),
    plan: () => read($, plan),
    updatePlan: fn => update($, plan, fn).then(() => undefined),
    activity: () => read($, activity),
    updateActivity: fn => update($, activity, fn).then(() => undefined),
    handovers: () => read($, handovers),
    seen: () => read($, seenAgents),
    setSeen: known => update($, seenAgents, () => known).then(() => undefined),
    log: () => readLog($),
    inbox: () => read($, inbox),
    roster: () => read($, roster),
    setRoster: rows => update($, roster, () => rows).then(() => undefined),
    setNow: t => update($, now, () => t).then(() => undefined),
    sessions: () => read($, sessions),
    testSlots: () => read($, testSlots),
    typecheckSlots: () => read($, typecheckSlots),
    toast: text => { void $.ui.toast(text) },
    status: line => $.ui.status(line),
    wakeMain: text => { $.clock.after(0, () => void $.prompt.submit({ text }).catch(() => undefined)) },
    autoSweep: () => autoSweep($),
    settleSlots: (rows, t) => settleSlots($, rows, t),
    unhanded: async () => (await currentUnhanded($)).length,
    preflightTick: rows => preflightTick($, rows),
    deliver: (id, text, opts) => deliver($, id, text, opts),
    tellMain: (name, text) => tellMain($, name, text),
    markResumable: id => { resumable.add(id) },
    decisionPhrases: () => mirror.decisionPhrases,
    maxManagers: () => mirror.maxManagers,
    slotLimit: () => mirror.slotLimit,
    typecheckLimit: () => heldSettings?.typecheckSlots ?? 1,
  }
}

// Settles every plan against the roster and handovers in one update, then tells each owner once (roster-run.ts).
function syncPlans($: EngineInterface, rows: AgentRow[], edit?: (p: Plan) => Plan, quietOwner?: string): Promise<Plan> {
  return syncPlansTo(rosterIoOf($), rows, edit, quietOwner)
}

// The roster as the board shows it: every agent of the session, with its role (roster-run.ts).
function refresh($: EngineInterface): Promise<AgentRow[]> { return refreshTo(rosterIoOf($)) }

async function openPane($: EngineInterface): Promise<void> {
  const r = await $.ui.open({ id: PANE, title: 'Flow', closeOnEscape: true })
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
function costIoOf($: EngineInterface): CostIo {
  return {
    stateDir: () => stateDir($),
    readJson: path => readJson($, path),
    writeJsonAtomic: (path, obj) => writeJsonAtomic($, path, obj),
    mkdirp: async dir => { await $.process.run(['mkdir', '-p', dir]) },
    now: () => $.clock.now(),
    after: (ms, fn) => { $.clock.after(ms, fn) },
    ledger: () => read($, ledger),
    updateLedger: async fn => { await update($, ledger, fn) },
    loaded: () => read($, ledgerLoaded),
    markLoaded: async () => { await update($, ledgerLoaded, () => true) },
    delta: () => read($, ledgerDelta),
    updateDelta: async fn => { await update($, ledgerDelta, fn) },
    epoch: () => read($, ledgerEpoch),
    setEpoch: async e => { await update($, ledgerEpoch, () => e) },
    startedAt: async () => (await $.session.usage().then(x => x, () => undefined))?.startedAt,
    liveIds: async () => (await read($, roster)).map(a => a.id),
    hasSessions: async () => Object.keys(await read($, sessions)).length > 0,
  }
}
function loadLedger($: EngineInterface): Promise<void> { return loadLedgerTo(costIoOf($)) }
function changeLedger($: EngineInterface, fn: (l: Ledger, now: number) => Ledger): Promise<void> { return changeLedgerTo(costIoOf($), fn) }
function mainKey($: EngineInterface): Promise<string> { return mainKeyTo(costIoOf($)) }
function costLines($: EngineInterface, prs: { pr: number; branch: string }[], keep?: (e: Ledger[string]) => boolean): Promise<string[]> {
  return costLinesTo(costIoOf($), prs, keep)
}

// Inbox changes run one after another: two answers at once must not each start from the same file.
let inboxChain: Promise<unknown> = Promise.resolve()

// Read the inbox from disk, let fn change it, write it back and set the atom. fn returns the new inbox (the
// same object when nothing changed) and whatever the caller wants back.
function withInbox<T>($: EngineInterface, fn: (cur: Inbox) => { inbox: Inbox; out: T }): Promise<T> {
  const run = async (): Promise<T> => {
    const dir = await stateDir($)
    const cur = dir === undefined ? await read($, inbox) : normalizeInbox(await readJson($, `${dir}/inbox.json`))
    const { inbox: changed, out } = fn(cur)
    if (changed !== cur) {
      if (dir !== undefined) {
        await $.process.run(['mkdir', '-p', dir])
        await writeJsonAtomic($, `${dir}/inbox.json`, changed)
      }
      await update($, inbox, () => changed)
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
    const { checks: changed, out } = fn(cur)
    if (changed !== cur) {
      if (dir !== undefined) {
        await $.process.run(['mkdir', '-p', dir])
        await writeJsonAtomic($, `${dir}/checks.json`, changed)
      }
      await update($, checks, () => changed)
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
async function captureChecks($: EngineInterface, ho: Handover, verifyPaths: string[], live: boolean): Promise<Check[]> {
  const needs = parseNeeds(ho.report)
  if (needs.length === 0) return []
  let command = live && ho.verifyCommand ? ho.verifyCommand : undefined
  let note: string | undefined
  if (command !== undefined && verifyPaths.length > 0) {
    // gh failing runs the command anyway: fail toward verifying.
    const r = await $.process.run(['gh', 'pr', 'view', String(ho.pr), '--json', 'files'])
    let files: string[] | undefined
    try { files = r.exitCode === 0 ? (JSON.parse(r.stdout) as { files: { path: string }[] }).files.map(f => f.path) : undefined } catch { files = undefined }
    if (files !== undefined && !anyMatch(verifyPaths, files)) { command = undefined; note = SKIP_NOTE }
  }
  const t = live ? await $.clock.now() : ho.at
  const items = await Promise.all(needs.map(async n => ({
    steps: n.steps, version: await versionAt($, ho.sha, n.steps),
    ...(n.pr === ho.pr && command !== undefined ? { verifyCommand: command } : {}), ...(n.pr === ho.pr && note !== undefined ? { note } : {}),
  })))
  return withChecks($, cur => {
    const r = addChecks(cur, ho.pr, ho.title, ho.sha, items, t)
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
    const changed = markDelivered(cur, d.round.id, t)
    return { state: changed, out: { ...d, state: changed } }
  })
  if (due === undefined) return
  const members = due.round.members.map(k => due.state.entries[k])
  // A round of skipped managers only has nothing to say.
  if (members.every(e => e === undefined || e.phase === 'skipped')) return
  const text = renderRound(due.state, await read($, inbox), due.round, ended, t, due.timedOut, mirror.askCards)
  $.clock.after(0, () => void $.prompt.submit({ text }).catch(() => undefined))
}

// Why this manager may not start workers yet, or undefined. Only a recorded manager is ever gated.
async function preflightGate($: EngineInterface, agentId: string | undefined): Promise<string | undefined> {
  if (!mirror.preflightOn || agentId === undefined) return undefined
  const me = (await agentsOf($)).find(a => a.id === agentId)
  if (me?.type !== MANAGER || me.name === undefined) return undefined
  const g = gateOf(await read($, preflight), await read($, inbox), me.name)
  return g === undefined ? undefined : denyText(g)
}

// Lite records change one after another, like pre-flight's. A lite manager must survive a plugin restart.
let liteChain: Promise<unknown> = Promise.resolve()

function withLite<T>($: EngineInterface, fn: (cur: LiteState) => { state: LiteState; out: T }): Promise<T> {
  const run = async (): Promise<T> => {
    const dir = await stateDir($)
    const cur = dir === undefined ? await read($, lite) : normalizeLite(await readJson($, `${dir}/lite.json`))
    const { state, out } = fn(cur)
    if (state !== cur) {
      if (dir !== undefined) {
        await $.process.run(['mkdir', '-p', dir])
        await writeJsonAtomic($, `${dir}/lite.json`, state)
      }
      await update($, lite, () => state)
    }
    return out
  }
  const result = liteChain.then(run, run)
  liteChain = result.catch(() => undefined)
  return result
}

// The lite manager an agent is (by its roster name), else undefined.
async function liteManagerOf($: EngineInterface, agentId: string | undefined): Promise<string | undefined> {
  if (agentId === undefined) return undefined
  const me = (await agentsOf($)).find(a => a.id === agentId)
  return me?.type === MANAGER && me.name !== undefined && isLiteName(await read($, lite), me.name) ? me.name : undefined
}

// Who is calling a reviewer-side tool: main, the reviewer, a lite manager or anyone else.
async function toolCallerOf($: EngineInterface, agentId: string | undefined): Promise<ToolCaller> {
  if (agentId === undefined) return { kind: 'main' }
  const me = (await agentsOf($)).find(a => a.id === agentId)
  // Only a manager or a worker is refused. An id the roster no longer lists (the host drops agents) is a reviewer's, as before.
  if (me === undefined || isReviewer(me.type)) return { kind: 'reviewer' }
  const name = await liteManagerOf($, agentId)
  if (name !== undefined) return { kind: 'lite', name }
  return me.type === MANAGER || WORKERS.has(me.type) ? { kind: 'other' } : { kind: 'reviewer' }
}

const today = async ($: EngineInterface) => new Date(await $.clock.now()).toISOString().slice(0, 10)

function messagingIoOf($: EngineInterface): MessagingIo {
  return {
    inbox: () => read($, inbox),
    withInbox: fn => withInbox($, fn),
    now: () => $.clock.now(),
    today: () => today($),
    agents: () => agentsOf($),
    seen: () => read($, seenAgents),
    deliver: (id, text, opts) => deliver($, id, text, opts),
    appendNote: (name, line) => appendNote($, name, line),
    best: (what, fn) => best($, what, fn),
    toMain: text => toMain($, text),
    markResumable: id => { resumable.add(id) },
    managerFinished: (ids, name, rows) => managerFinished($, ids, name, rows),
    addGuardTest: (options, glob, test) => addGuardTest(standingIoOf($), options, glob, test),
    onDeployAnswer: (q, answer) => onDeployAnswer($, q, answer),
    onEnvAnswer: (q, answer) => onEnvAnswer($, q, answer),
    onPushAnswer: (q, answer, by) => onPushAnswer($, q, answer, by),
    onReviewerAnswer: (answer, by) => onReviewerAnswer($, answer, by),
    loadLedger: () => loadLedger($),
    ledger: () => read($, ledger),
  }
}

// The one way a question gets answered (messaging-run.ts): marks it, tells the asker, notes the decision.
function answerQuestion($: EngineInterface, wanted: string, choice: string | null, by: string, options: Record<string, unknown>, user = false): Promise<string> {
  return answerQuestionTo(messagingIoOf($), wanted, choice, by, options, user)
}
async function paneInboxRows($: EngineInterface): Promise<{ rows: PaneRow[]; now: number }> { return paneInboxRowsTo(messagingIoOf($), await read($, inboxFolds)) }
async function endedOwnersOf($: EngineInterface): Promise<Set<string>> { return endedOwners(await read($, roster), await read($, seenAgents)) }

// Pane presses run one after another, so a second press sees the first one's answer and highlight.
let paneChain: Promise<unknown> = Promise.resolve()
const paneSerial = <T,>(fn: () => Promise<T>): Promise<T> => {
  const run = paneChain.then(fn, fn)
  paneChain = run.catch(() => undefined)
  return run
}

// ---- the deploy gate (deploy.ts, deploy-run.ts) ----

function deployIoOf($: EngineInterface): DeployIo {
  return {
    stateDir: () => stateDir($),
    readJson: path => readJson($, path),
    writeJson: (path, obj) => writeJsonAtomic($, path, obj),
    mkdir: dir => $.process.run(['mkdir', '-p', dir]),
    deploys: () => read($, deploys),
    setDeploys: async changed => { await update($, deploys, () => changed) },
    behind: () => read($, behind),
    setBehind: async changed => { await update($, behind, () => changed) },
    infos: () => mirror.deployInfos,
    base: () => mirror.cleanupBase,
    exec: (argv, timeoutMs) => $.process.run(argv, { timeoutMs }),
    now: () => $.clock.now(),
    handovers: () => read($, handovers),
    updateHandovers: async fn => { await update($, handovers, fn) },
    saveHandover: ho => saveHandover($, ho),
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
    toMain: text => toMain($, text),
    paneOpen: () => flowPaneOpen($),
  }
}

function refreshBehind($: EngineInterface): Promise<void> { return refreshBehindTo(deployIoOf($)) }
function onDeployAnswer($: EngineInterface, q: Question, answer: string): Promise<string> { return onDeployAnswerTo(deployIoOf($), q, answer) }
function onEnvAnswer($: EngineInterface, q: Question, answer: string): Promise<string> { return onEnvAnswerTo(deployIoOf($), q, answer) }
function holdTarget($: EngineInterface, name: string, until: Hold['until'], by: string, reason: string | undefined): Promise<string> {
  return holdTargetTo(deployIoOf($), name, until, by, reason)
}
function releaseTarget($: EngineInterface, name: string): Promise<string> { return releaseTargetTo(deployIoOf($), name) }
function deployTool($: EngineInterface, options: Record<string, unknown>, input: Record<string, unknown>, isMain: boolean, caller: string): Promise<string> {
  return deployToolTo(deployIoOf($), options, input, isMain, caller)
}
function openHandoverEnv(
  $: EngineInterface, options: Record<string, unknown>, ho: Handover, drafts: Draft[], prev: EnvChange[], at: number,
): Promise<string> { return openHandoverEnvTo(deployIoOf($), options, ho, drafts, prev, at) }
function closeReturnedEnv($: EngineInterface, ho: Handover): Promise<void> { return closeReturnedEnvTo(deployIoOf($), ho) }


// ---- the push gate (pushgate.ts) ----

function tellManager($: EngineInterface, name: string, text: string): Promise<void> { return tellManagerTo(messagingIoOf($), name, text) }
function tellMain($: EngineInterface, name: string, text: string): Promise<void> { return tellMainTo(messagingIoOf($), name, text) }
function sizeBackNote($: EngineInterface, branch: string): Promise<string | undefined> { return sizeBackNoteTo(messagingIoOf($), branch) }

function pushIoOf($: EngineInterface): PushIo {
  return {
    stateDir: () => stateDir($),
    readJson: path => readJson($, path),
    writeJson: (path, obj) => writeJsonAtomic($, path, obj),
    mkdir: dir => $.process.run(['mkdir', '-p', dir]),
    push: () => read($, pushState),
    setPush: async changed => { await update($, pushState, () => changed) },
    exec: (argv, timeoutMs) => $.process.run(argv, { timeoutMs }),
    now: () => $.clock.now(),
    handovers: () => read($, handovers),
    updateHandovers: async fn => { await update($, handovers, fn) },
    saveHandover: ho => saveHandover($, ho),
    appendLog: event => appendLog($, event),
    best: (what, fn) => best($, what, fn),
    withInbox: fn => withInbox($, fn),
    ensureQueue: () => ensureQueue($),
    closeReturnedEnv: ho => closeReturnedEnv($, ho),
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
  }
}

function recordReady($: EngineInterface, settings: Settings, input: Record<string, unknown>): Promise<string> { return recordReadyTo(pushIoOf($), settings, input) }
function settleBatch($: EngineInterface): Promise<void> { return settleBatchTo(pushIoOf($)) }
function pushAct($: EngineInterface, act: PushAct, by: string): Promise<string> { return pushActTo(pushIoOf($), act, by) }
function onPushAnswer($: EngineInterface, q: Question, answer: string, by: string): Promise<string> { return onPushAnswerTo(pushIoOf($), q, answer, by) }

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
async function saveHandover($: EngineInterface, ho: Handover): Promise<void> {
  const dir = await stateDir($)
  if (dir === undefined) return
  await writeJsonAtomic($, `${dir}/handovers/${ho.pr}.json`, { version: 1, ...ho })
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
    const ho = await readJson($, `${dir}/handovers/${name}`) as Handover | undefined
    if (typeof ho !== 'object' || ho === null || !Number.isInteger(ho.pr) || !STATUSES.has(ho.status)) continue
    if (ho.evidence !== undefined && !validEvidence(ho.evidence)) delete ho.evidence
    out[String(ho.pr)] = ho
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
  return (await agentsOf($)).find(a => a.id === id)?.name ?? 'main'
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
// The roster the host knows plus the role sessions (a manager or the reviewer running in a terminal):
// anything that resolves who a caller is, or whether an owner is alive, asks this. Session rows of
// every kind are added to the board separately (roster-run), which is why that one keeps the raw list.
async function agentsOf($: EngineInterface): Promise<AgentInfo[]> {
  return [...await $.agent.list(), ...roleAgents(await read($, sessions)) as AgentInfo[]]
}

// The session an id names (`session:<name>`), if there is one on record.
async function sessionOfId($: EngineInterface, id: string): Promise<Session | undefined> {
  return id.startsWith('session:') ? (await read($, sessions))[id.slice('session:'.length)] : undefined
}

// `from` is who the messages are from, named in a long message's file pointer (a session's terminal).
function ioOf($: EngineInterface, from = 'main'): DeliverIo {
  return {
    status: async id => {
      const ss = await sessionOfId($, id)
      if (ss !== undefined) return sessionRow(ss).status
      if (id.startsWith('session:')) return undefined
      const s = (await $.agent.list()).find(a => a.id === id)?.status
      return resumable.has(id) && (s === undefined || s === 'completed') ? 'idle' : s
    },
    send: async (id, text) => {
      const ss = await sessionOfId($, id)
      if (ss !== undefined) {
        // A terminal takes text by typing it in; a refused one is not a delivery.
        const r = await sendToSession(sessionIoOf($), ss, text, from)
        if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `could not type into ${ss.name}`)
        return
      }
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
    name: async id => (await sessionOfId($, id))?.name ?? (await $.agent.list()).find(a => a.id === id)?.name,
  }
}
const refusals = new Map<string, string>()
const deliver = ($: EngineInterface, id: string, text: string, opts?: DeliverOptions) => deliverTo(ioOf($), id, text, opts)
const flushAgent = ($: EngineInterface, id: string) => flushTo(ioOf($), id)
const holdForReviewer = ($: EngineInterface, id: string) => holdTo(ioOf($), id)
// isShown is the engine's own flag; an entry without it counts as shown.
const flowPaneOpen = async ($: EngineInterface) => (await $.ui.panes()).some(p => p.id === PANE && p.isShown !== false)
const toMain = ($: EngineInterface, text: string) => $.clock.after(0, () => void $.prompt.submit({ text }).catch(() => undefined))

function routeIoOf($: EngineInterface): RouteIo {
  return {
    agents: () => agentsOf($),
    activity: () => read($, activity),
    handovers: () => read($, handovers),
    plans: () => read($, plan),
    inbox: () => read($, inbox),
    seenAgents: () => read($, seenAgents),
    forwarded: () => read($, forwarded),
    updateForwarded: fn => update($, forwarded, fn),
    messages: () => $.session.messages(),
    planOwner: (plans, name) => planOwner(plans, name),
    isManagerOf: (owner, name) => isManagerOf(owner, name),
    appendNote: (name, line) => appendNote($, name, line),
    today: () => today($),
    toMain: text => void toMain($, text),
  }
}
const resolveReportTo = ($: EngineInterface, given: unknown, callerId: string | undefined) => resolveReportToTo(routeIoOf($), given, callerId)
const managerFinished = ($: EngineInterface, ids: string[], name: string, rows: { id: string; parentId?: string; status: string }[], report?: string) => managerFinishedTo(routeIoOf($), ids, name, rows, report)
const mainHasAnswer = ($: EngineInterface, answer: string) => mainHasAnswerTo(routeIoOf($), answer)

// Everything the spawn routing in spawn.ts needs from the engine and the plugin's state.
function spawnIoOf($: EngineInterface): SpawnIo {
  return {
    run: argv => $.process.run(argv),
    cwd: () => $.session.cwd(),
    agents: () => agentsOf($),
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

// What the agent.spawn hook (spawn-run.ts) needs from the engine and the plugin's atoms; the rest of its io is register()'s state.
type SpawnState = Pick<SpawnHookIo, 'relay' | 'settings' | 'options' | 'noLong' | 'setNoLong' | 'noContinue' | 'setNoContinue' | 'takeExplicit' | 'setEffort'>
function spawnHookIoOf($: EngineInterface, state: SpawnState): SpawnHookIo {
  return {
    ...state,
    spawn: spawnIoOf($),
    now: () => $.clock.now(),
    agentList: () => $.agent.list(),
    plans: () => read($, plan),
    lite: () => read($, lite),
    gate: agentId => preflightGate($, agentId),
    jev: () => jevOf($, state.settings()),
    effortEnv: () => $.env.get('CLAUDE_CODE_EFFORT_LEVEL').catch(() => undefined),
    toast: text => $.ui.toast(text),
    best: (what, fn) => best($, what, fn),
    refresh: () => refresh($),
    openPane: () => openPane($),
    updateActivity: fn => update($, activity, fn),
    changeLedger: fn => changeLedger($, fn),
    withLite: fn => withLite($, fn),
    withPreflight: fn => withPreflight($, fn),
    after: (ms, fn) => $.clock.after(ms, fn),
    sessions: () => read($, sessions),
    roleHarness: () => roleHarnessFor($, 'manager'),
    startRoleSession: (p, s) => startRoleSession(sessionIoOf($), p, s),
  }
}

// The decision API for sizing (decision_api jev or openai); undefined when off, so nothing touches the network.
function jevOf($: EngineInterface, settings: DecideSettings): SizeJev | undefined {
  if (settings.decisionApi === undefined || settings.decisionApi === 'off') return undefined
  const io = decideIoOf($)
  return sizeWith((text, q) => decide(io, settings, text, q, DECIDE_TIMEOUT_MS, settings.sizeMinConfidence ?? 0), sourceOf(settings))
}

// The engine's fetch and timer as the decision API takes them.
function decideIoOf($: EngineInterface): DecideIo {
  const fetch: FetchLike = (url, init) => $.http.fetch(url, { method: init.method, headers: init.headers, body: init.body })
    .then(r => ({ ok: r.ok, status: r.status, json: async () => JSON.parse(r.text) as unknown }))
  return { fetch, after: (ms: number, fn: () => void) => $.clock.after(ms, fn) }
}

function decideEvalIoOf($: EngineInterface): DecideEvalIo {
  return {
    stateDir: () => stateDir($),
    readFile: path => $.fs.read(path).then(String, () => undefined),
    writeFile: async (path, text) => { await $.fs.write(path, text) },
    decideIo: decideIoOf($),
    now: () => $.clock.now(),
  }
}

// Starts a reviewer unless one is live. The reviewer drains every pending handover, then ends;
// the next handover, or a reviewer that ended with work left, starts a fresh one.
// Calls run one after another: handovers arriving back to back must not each see "no queue yet".
let queueChain: Promise<unknown> = Promise.resolve()
function ensureQueue($: EngineInterface): Promise<string> {
  const run = queueChain.then(() => startQueue(queueIoOf($)))
  queueChain = run.catch(() => undefined)
  return run
}

// Reconciling stale handovers: the git and gh calls stay local to this closure set.
function staleIoOf($: EngineInterface, base: string): StaleIo {
  return {
    now: () => $.clock.now(),
    handovers: () => read($, handovers),
    agents: () => agentsOf($),
    isAncestor: async head => {
      // The head must resolve to itself first, so a runner that answers every git call with exit 0 proves nothing.
      const v = await runCmd($, ['git', 'rev-parse', '--verify', `${head}^{commit}`])
      if (v.exitCode !== 0 || head.length < 7 || !v.stdout.trim().startsWith(head)) return undefined
      const r = await runCmd($, ['git', 'merge-base', '--is-ancestor', head, `origin/${base}`])
      // A clear exit 0 with no output only: anything else (a mocked or odd runner) is unknown.
      if (r.exitCode === 0) return r.stdout.trim() === '' && r.stderr.trim() === '' ? true : undefined
      return r.exitCode === 1 ? false : undefined
    },
    mergedPrs: async () => {
      const r = await runCmd($, ['gh', 'pr', 'list', '--state', 'merged', '--limit', '50', '--json', 'number,mergeCommit'])
      if (r.exitCode !== 0) return undefined
      try {
        const list: unknown = JSON.parse(r.stdout)
        if (!Array.isArray(list)) return undefined
        return new Map((list as { number: number; mergeCommit?: { oid?: string } | null }[]).filter(p => typeof p?.number === 'number').map(p => [p.number, p.mergeCommit?.oid ?? '']))
      } catch { return undefined }
    },
    closedPrs: async () => {
      // gh's closed state excludes merged PRs.
      const r = await runCmd($, ['gh', 'pr', 'list', '--state', 'closed', '--limit', '50', '--json', 'number'])
      if (r.exitCode !== 0) return undefined
      try {
        const list: unknown = JSON.parse(r.stdout)
        if (!Array.isArray(list)) return undefined
        return new Set((list as { number: number }[]).filter(p => typeof p?.number === 'number').map(p => p.number))
      } catch { return undefined }
    },
    save: async ho => {
      await update($, handovers, hs => ({ ...hs, [String(ho.pr)]: ho }))
      await best($, 'saving a handover', async () => {
        await saveHandover($, ho)
        if (ho.status === 'done') await appendLog($, { event: 'done', owner: ho.reportTo, pr: ho.pr, branch: ho.branch, text: ho.report })
        if (ho.status === 'returned') await appendLog($, { event: 'back', owner: ho.reportTo, pr: ho.pr, branch: ho.branch, text: ho.reason })
      })
      if (ho.status === 'returned') await closeReturnedEnv($, ho)
    },
  }
}

function reviewerIoOf($: EngineInterface, base: string): ReviewerIo {
  return {
    reconcile: () => reconcileStale(staleIoOf($, base)),
    run: argv => $.process.run(argv),
    handovers: () => read($, handovers),
    putHandover: async (pr, ho) => { await update($, handovers, hs => ({ ...hs, [pr]: ho })) },
    batch: async () => (await read($, pushState)).batch,
    deploys: () => read($, deploys),
    inbox: () => read($, inbox),
    flaky: async id => (await read($, testFails)).flaky[id],
    noteRunWork: (id, f) => noteRunWork($, id, f),
    recordReady: (settings, input) => recordReady($, settings, input),
    best: (what, fn) => best($, what, fn),
    saveHandover: ho => saveHandover($, ho),
    appendLog: event => appendLog($, event),
    toast: text => { void $.ui.toast(text) },
    refresh: () => refresh($),
    closeReturnedEnv: ho => closeReturnedEnv($, ho),
    settleBatch: () => settleBatch($),
    autoSweep: () => autoSweep($),
    withCost: (branch, report) => withCost($, branch, report),
    captureChecks: (ho, verifyPaths, live) => captureChecks($, ho, verifyPaths, live),
    suggestGuardTests: (input, pr, queueName, agentId, map) => suggestGuardTests(standingIoOf($), input, pr, queueName, agentId, map),
    sizeBackNote: branch => sizeBackNote($, branch),
  }
}

function queueIoOf($: EngineInterface): QueueIo {
  return {
    agents: () => $.agent.list(),
    batch: async () => (await read($, pushState)).batch,
    handovers: () => read($, handovers),
    deploys: () => read($, deploys),
    runs: () => read($, queueRuns),
    setRuns: n => update($, queueRuns, () => n),
    spawn: input => spawnReviewer($, input),
    reviewerSession: async () => Object.values(await read($, sessions)).find(x => x.role === 'reviewer' && sessionLive(x)),
    setTold: (s, told) => sessionIoOf($).updateSessions(all => all[s.name] === undefined ? all : { ...all, [s.name]: { ...all[s.name]!, nudged: told } }),
    nudge: async (s, text, told) => {
      const r = await sendToSession(sessionIoOf($), s, text)
      if (r.exitCode !== 0) return r.stderr.trim() || `could not type into ${s.name}`
      await sessionIoOf($).updateSessions(all => all[s.name] === undefined ? all : { ...all, [s.name]: { ...all[s.name]!, nudged: told } })
      return undefined
    },
    breaker: breakerIoOf($),
    wait: ms => {
      // One timer at a time: several ends or handovers during a wait start at most one reviewer.
      if (breakerTimer) return
      breakerTimer = true
      $.clock.after(ms, () => {
        breakerTimer = false
        void best($, 'starting the reviewer', async () => void (await ensureQueue($)))
      })
    },
  }
}

let breakerTimer = false

// A reviewer's report to main: its whole answer, only for a run that did batch work, once main's transcript
// lacks it (the host may have delivered it already). The run's work record goes with it.
async function relayReviewerReport($: EngineInterface, id: string, name: string, answer: string): Promise<void> {
  const work = (await read($, reviewerWork))[id]
  await update($, reviewerWork, m => Object.fromEntries(Object.entries(m).filter(([k]) => k !== id)))
  const full = reviewerReport(answer, work)
  if (full === undefined) return
  $.clock.after(RELAY_DELAY_MS, () => void (async () => {
    if (!(await mainHasAnswer($, answer))) toMain($, `Report from reviewer ${name}:\n${full}`)
  })().catch(() => undefined))
}

// A reviewer run ended (agent or terminal): the breaker records it, which decides when the next one may start,
// and a queue with work left gets a fresh reviewer. A reviewer that ends at once must not be replaced at once.
async function reviewerEnded($: EngineInterface, name: string, end: { answer: string; reason?: string; status?: string }): Promise<void> {
  await best($, 'recording the reviewer end', () => noteReviewerEnd(breakerIoOf($), { name, ...end }))
  await ensureQueue($)
}

// A reviewer in a terminal reported. `ended`: its session is over (one batch in confirm mode, or it went away), so
// the run closes like an agent's end; otherwise it keeps waiting in its terminal, and leftover work is nudged to it.
async function reviewerRan($: EngineInterface, id: string, name: string, end: { answer: string; reason?: string; status?: string }, ended: boolean): Promise<void> {
  await relayReviewerReport($, id, name, end.answer)
  if (ended) await reviewerEnded($, name, end)
  else await ensureQueue($)
}

// The settings as last loaded, for the module-level code that starts terminal sessions (register()'s own copy
// is a closure variable).
let heldSettings: ReturnType<typeof settingsOf> | undefined

// A role harness that cannot run (unknown, or not claude) is said once per reason, then the agent runs as before.
const roleReasons = new Set<string>()
function roleHarnessFor($: EngineInterface, role: 'manager' | 'reviewer'): { harness: string; settings: ReturnType<typeof settingsOf> } | undefined {
  const s = heldSettings
  if (s === undefined) return undefined
  const picked = roleHarnessOf((role === 'manager' ? s.managerHarness : s.reviewerHarness) ?? 'agent', s.harnesses)
  if (picked.reason !== undefined && !roleReasons.has(`${role}:${picked.reason}`)) {
    roleReasons.add(`${role}:${picked.reason}`)
    void $.ui.toast(`flow: ${role}_harness: ${picked.reason}`)
  }
  return picked.harness === 'agent' ? undefined : { harness: picked.harness, settings: s }
}

// The reviewer: a terminal session when reviewer_harness names a claude harness, else the agent as always.
// A session that cannot start falls back to the agent (and says why) so the queue is not stuck on it.
async function spawnReviewer($: EngineInterface, input: { subagentType: string; name: string; description: string; prompt: string; pending?: string[] }): Promise<{ deny?: string }> {
  const { pending, ...agentInput } = input
  const route = roleHarnessFor($, 'reviewer')
  if (route === undefined) return $.agent.spawn(agentInput)
  const rules = parseMode(route.settings.mergeMode) === 'confirm' ? REVIEWER_SESSION_RULES_CONFIRM : REVIEWER_SESSION_RULES_AUTO
  const reviewerEffort = effortFor('reviewer', undefined, route.settings, await $.env.get('CLAUDE_CODE_EFFORT_LEVEL').catch(() => undefined))
  const r = await startRoleSession(sessionIoOf($), {
    role: 'reviewer', name: input.name, harness: route.harness, owner: { id: 'main', name: 'main' },
    ...(route.settings.reviewerModel !== undefined && { model: route.settings.reviewerModel }),
    ...(reviewerEffort !== undefined && { effort: reviewerEffort }),
    prompt: `${rules}${fill(REVIEWER_PROMPT, route.settings)}\n\n${input.prompt}`,
  }, route.settings)
  if (!r.ok) {
    void $.ui.toast(`flow: could not start the reviewer in a terminal (${r.text}); using an agent`)
    return $.agent.spawn(agentInput)
  }
  const told = pending ?? []
  if (told.length > 0) await sessionIoOf($).updateSessions(all => all[input.name] === undefined ? all : { ...all, [input.name]: { ...all[input.name]!, nudged: told } })
  return {}
}

function breakerIoOf($: EngineInterface): BreakerIo {
  return {
    stateDir: () => stateDir($),
    readJson: path => readJson($, path),
    writeJson: (path, obj) => writeJsonAtomic($, path, obj),
    mkdir: dir => $.process.run(['mkdir', '-p', dir]),
    get: () => read($, reviewerBreaker),
    set: async b => { await update($, reviewerBreaker, () => b) },
    now: () => $.clock.now(),
    withInbox: fn => withInbox($, fn),
    toast: text => { void $.ui.toast(text) },
  }
}

function onReviewerAnswer($: EngineInterface, answer: string, by: string): Promise<string> { return onReviewerAnswerTo(breakerIoOf($), () => ensureQueue($), answer, by) }

function guardIoOf($: EngineInterface): GuardIo {
  return { exec: (argv, timeoutMs) => $.process.run(argv, { timeoutMs }), allAgents: () => agentsOf($) }
}
function mainCheckoutGuard($: EngineInterface, e: Record<string, unknown>, cwd: () => Promise<string | undefined>, allow: string[], flowCaller: () => Promise<boolean>): Promise<string | undefined> {
  return mainCheckoutGuardTo(guardIoOf($), e, cwd, allow, flowCaller)
}

// The reviewer's report with the PR's workers' cost appended, once.
function withCost($: EngineInterface, branch: string, report: string): Promise<string> { return withCostTo(costIoOf($), branch, report) }

// --- Cleanup: leftover worktrees and local branches of finished work ---------------------------

function cleanIoOf($: EngineInterface): CleanIo {
  return {
    exec: (argv, timeoutMs) => $.process.run(argv, { timeoutMs }),
    agents: () => $.agent.list(),
    cwd: () => $.session.cwd(),
    handoffs: async () => Object.values(await read($, handoffs)),
    sessions: async () => Object.values(await read($, sessions)),
    log: () => readLog($),
    append: event => appendLog($, event),
    setLeftovers: async counts => { await update($, leftovers, () => counts) },
  }
}

function resumeIoOf($: EngineInterface): ResumeIo {
  return {
    exec: (argv, timeoutMs) => $.process.run(argv, { timeoutMs }),
    agents: () => $.agent.list(),
    sessions: async () => Object.values(await read($, sessions)),
    log: () => readLog($),
    loadHandovers: () => loadHandovers($),
    saveHandover: ho => saveHandover($, ho),
    best: (what, fn) => best($, what, fn),
    mergeHandovers: async all => { await update($, handovers, cur => ({ ...all, ...cur })) },
  }
}

function sweep($: EngineInterface, base: string, apply: boolean, dryHint?: string, started?: () => void): Promise<string> {
  return sweepTo(cleanIoOf($), base, apply, dryHint, started)
}
function gatherLeftovers($: EngineInterface, base: string, resumed: Set<string>): Promise<Gathered> { return gatherLeftoversTo(resumeIoOf($), base, resumed) }

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

// The usage module's io: closures over the activity atom, the roster and the wrap-up senders.
function usageIoOf($: EngineInterface, settings: ReturnType<typeof settingsOf>, mainWarn: { warned: boolean }, held: Pick<UsageIo, 'mainModel' | 'setMainModel' | 'mainWindow' | 'setMainWindow'>): UsageIo {
  return {
    ...held,
    cost: costIoOf($),
    now: () => $.clock.now(),
    activity: () => read($, activity),
    updateActivity: async fn => { await update($, activity, fn) },
    agents: () => $.agent.list(),
    toast: text => { void $.ui.toast(text) },
    sendWrapUp: (me, percent, limit) => sendWrapUp($, me, percent, limit),
    warnMain: () => warnMain($, settings, mainWarn),
  }
}

// The turn hooks' bodies live in turn-run.ts; this builds their io over register()'s state.
function turnIoOf($: EngineInterface, settings: ReturnType<typeof settingsOf>, held: Pick<TurnIo, 'agentEffort' | 'effortSeen'>): TurnIo {
  return {
    now: () => $.clock.now(),
    flushAgent: id => flushAgent($, id),
    activity: () => read($, activity),
    updateActivity: async fn => { await update($, activity, fn) },
    ...held,
    refresh: () => refresh($),
    best: (what, fn) => best($, what, fn),
    appendLog: (event, max) => appendLog($, event, max),
    readLog: () => readLog($),
    reviewerWork: async id => (await read($, reviewerWork))[id],
    relayReviewerReport: (id, name, answer) => relayReviewerReport($, id, name, answer),
    reviewerEnded: (name, end) => reviewerEnded($, name, end),
    wokenByOthers,
    mainHasAnswer: answer => mainHasAnswer($, answer),
    toMain: text => toMain($, text),
    after: (ms, fn) => $.clock.after(ms, fn),
    stateDir: () => stateDir($),
    messages: agentId => $.session.messages({ agentId }),
    run: argv => $.process.run(argv),
    mkdirp: async dir => { await $.process.run(['mkdir', '-p', dir]) },
    write: async (path, text) => { await $.fs.write(path, text) },
    setHandoff: async (branch, record) => { await update($, handoffs, hs => ({ ...hs, [branch]: record })) },
    lean: ask => handoffLean(decideIoOf($), standingIoOf($), settings, ask),
    toast: text => { void $.ui.toast(text) },
    deliver: (id, text, opts) => deliver($, id, text, opts),
    maxContinues: () => settings.maxContinues,
    decideSettings: () => settings,
    askCards: () => mirror.askCards,
  }
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

// The session.start hook (startup-run.ts): what it reads and writes of register()'s state comes in `held`,
// everything else is closures over `$`, the atoms and the module state here.
type StartupHeld = Pick<StartupIo, 'settings' | 'applySettings' | 'paths' | 'setPaths' | 'detected' | 'setDetected' | 'seen' | 'setSeen' | 'checking' | 'setChecking' | 'installed' | 'setInstalled'>
function startupIoOf($: EngineInterface, options: Record<string, unknown>, held: StartupHeld): StartupIo {
  return {
    ...held,
    options,
    pollMs: POLL_MS,
    prPollMs: PR_POLL_MS,
    initHint: INIT_HINT,
    best: (what, fn) => best($, what, fn),
    run: (argv, opts) => $.process.run(argv, opts),
    toast: text => { void $.ui.toast(text) },
    every: (ms, fn) => { $.clock.every(ms, fn) },
    after: (ms, fn) => { $.clock.after(ms, fn) },
    now: () => $.clock.now(),
    relayMode: () => relayModeOf($),
    setRelay: r => { relay = r },
    locate: () => locate($),
    readText: path => readText($, path),
    mtime: async path => (await $.fs.stat(path)).mtimeMs,
    registerAgent: spec => $.agent.register(spec),
    registerCommand: spec => $.command.register(spec),
    registerTools: () => registerTools($),
    resetDelivery: () => resetDelivery(text => toMain($, text)),
    resetStateDir,
    readState: async file => {
      const dir = await stateDir($)
      if (dir === undefined) return undefined
      return { disk: await readJson($, `${dir}/${file}`) }
    },
    loadHandovers: () => loadHandovers($),
    mergeHandovers: async disk => { await update($, handovers, hs => ({ ...disk, ...hs })) },
    autoSweep: () => autoSweep($),
    setInbox: async disk => { await update($, inbox, () => disk) },
    setBreaker: async disk => { await update($, reviewerBreaker, () => disk) },
    releaseHalt: async () => { await releaseHaltTo(breakerIoOf($), 'flow') },
    installedVersion: () => installedVersion($),
    handovers: () => read($, handovers),
    checks: () => read($, checks),
    setChecks: async disk => { await update($, checks, () => disk) },
    captureChecks: (ho, verifyPaths) => captureChecks($, ho, verifyPaths, false),
    markPrompted: async version => { await withChecks($, cur => ({ checks: { ...cur, promptedVersion: version }, out: undefined })) },
    setDeploys: async disk => { await update($, deploys, () => disk) },
    deployKnown: name => mirror.deployInfos.some(i => i.name === name),
    refreshBehind: () => void refreshBehind($),
    setPush: async disk => { await update($, pushState, () => disk) },
    setLite: async disk => { await update($, lite, () => disk) },
    mergeSessions: async raw => {
      const disk = normalizeSessions(raw, await $.clock.now())
      await update($, sessions, cur => ({ ...disk, ...cur }))
    },
    snapshotSessions: async () => { roleState.saved = JSON.stringify(durableSessions(await read($, sessions))) },
    adoptSessions: () => adoptSessions($),
    setPreflight: async disk => { await update($, preflight, () => disk) },
    agents: () => agentsOf($),
    closePreflight: async (live, t) => { await withPreflight($, cur => { return { state: closeStale(cur, live, t), out: undefined } }) },
    setSlotDir: dir => { slotDir = dir },
    sh: (script, arg) => sh($, script, arg),
    roleSessionCount: async () => (await myRoleSessions($)).length,
    pump: () => void pumpOnce($, { settings: held.settings(), options, installed: held.installed() }),
    refresh: () => void refresh($),
    watchSessions: () => void watchSessions($),
    fetchPrs: () => void fetchPrs($),
    refreshLeftovers: () => refreshLeftovers($),
    tickNow: async () => { await $.clock.now().then(t => update($, now, () => t)) },
    startReviewer: async () => void (await ensureQueue($)),
    clearDemo: async () => { await update($, demo, () => null) },
    firstRun: () => firstRun(initIoOf($)),
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

// The platform, asked once through `uname -s`: the engine has no platform field.
let platform: Promise<string> | undefined
function platformOf($: EngineInterface): Promise<string> {
  platform ??= runCmd($, ['uname', '-s'], 5_000).then(r => platformOfUname(r.exitCode === 0 ? r.stdout : undefined))
  return platform
}

function sessionIoOf($: EngineInterface): SessionIo {
  return {
    run: (argv, timeoutMs) => runCmd($, argv, timeoutMs),
    now: () => $.clock.now(),
    after: (ms, fn) => void $.clock.after(ms, fn),
    stat: path => $.fs.stat(path),
    read: path => $.fs.read(path),
    write: (path, text) => $.fs.write(path, text),
    sessions: () => read($, sessions),
    updateSessions: async fn => {
      await update($, sessions, fn)
      await persistSessions($)
    },
    updateActivity: fn => update($, activity, fn),
    setLimits: limits => update($, harnessLimits, () => limits),
    gate: agentId => preflightGate($, agentId),
    agents: () => $.agent.list(),
    stateDir: () => stateDir($),
    log: event => appendLog($, event),
    warn: (what, err) => warn($, what, err),
    refresh: () => refresh($),
    openPane: () => openPane($),
    identity: () => identityOf($),
    owns: s => ownsSession($, s),
    submit: text => $.prompt.submit({ text }),
    deliver: (id, text) => deliver($, id, text),
    logMax: LOG_MAX,
    effortEnv: () => $.env.get('CLAUDE_CODE_EFFORT_LEVEL'),
    onRoleReport: (s, report) => onRoleReport($, s, report),
    onRoleGone: (s, tail) => onRoleGone($, s, tail),
  }
}

function onRoleReport($: EngineInterface, s: Session, report: string): Promise<void> { return onRoleReportTo(roleIoOf($), s, report) }
function onRoleGone($: EngineInterface, s: Session, tail: string): Promise<void> { return onRoleGoneTo(roleIoOf($), s, tail) }
function persistSessions($: EngineInterface): Promise<void> { return persistSessionsTo(roleIoOf($)) }

const watchSessions = ($: EngineInterface) => watchSessionsTo(sessionIoOf($))

// --- Who owns a role session (role-session-run.ts) ---
function identityOf($: EngineInterface): Promise<MainIdentity | undefined> { return identityTo(roleIoOf($)) }
function ownsSession($: EngineInterface, s: Session): Promise<boolean> { return ownsSessionTo(roleIoOf($), s) }
function adoptSessions($: EngineInterface): Promise<void> { return adoptSessionsTo(roleIoOf($)) }
function myRoleSessions($: EngineInterface, ended = false): Promise<Session[]> { return myRoleSessionsTo(roleIoOf($), ended) }

// The io of the terminal role sessions' ownership, sessions file and reports (bodies in role-session-run.ts).
function roleIoOf($: EngineInterface): RoleIo {
  return {
    run: (argv, timeoutMs) => runCmd($, argv, timeoutMs),
    now: () => $.clock.now(),
    sessionId: () => $.session.id(),
    sessions: () => read($, sessions),
    updateSessions: fn => update($, sessions, fn),
    stateDir: () => stateDir($),
    readJson: path => readJson($, path),
    writeJson: (path, obj) => writeJsonAtomic($, path, obj),
    mkdirp: dir => $.process.run(['mkdir', '-p', dir]),
    best: (what, fn) => best($, what, fn),
    warn: (what, err) => warn($, what, err),
    toMain: text => toMain($, text),
    refresh: () => refresh($),
    askCards: () => mirror.askCards,
    heldMergeMode: () => heldSettings?.mergeMode,
    heldSettings: () => heldSettings !== undefined,
    batchReady: async () => (await read($, pushState)).batch?.state === 'ready',
    stopTerminal: async name => void await sessionToolTo(sessionIoOf($), { action: 'stop', name, remove_worktree: true }, { id: 'main', name: 'main' }, heldSettings!),
    reviewerRan: (id, name, end, ended) => reviewerRan($, id, name, end, ended),
    relayReviewerReport: (id, name, answer) => relayReviewerReport($, id, name, answer),
    reviewerEnded: (name, end) => reviewerEnded($, name, end),
  }
}

// --- The disk relay (relay.ts) ---
// A terminal-started claude loads its own copy of this plugin; FLOW_ROLE / FLOW_NAME / FLOW_RELAY tell
// that copy what it is (RelayMode, relay-run.ts). Set at session.start; undefined in a normal session (main, or an Agent-tool subagent).
let relay: RelayMode | undefined

// The files and processes the relay needs, both for the client in the terminal's copy and for main's pump.
function relayIoOf($: EngineInterface): RelayIo {
  return {
    list: async dir => (await $.fs.list(dir)).map(f => f.name),
    read: async path => String(await $.fs.read(path)),
    write: (path, text) => $.fs.write(path, text),
    // mv is rename(2) inside one directory: only one of two racing claimers wins.
    rename: async (from, to) => (await runCmd($, ['mv', from, to], 10_000)).exitCode === 0,
    remove: path => runCmd($, ['rm', '-f', path], 10_000),
    mtime: async path => (await $.fs.stat(path)).mtimeMs,
    now: () => $.clock.now(),
    // The host kills a process after ten minutes at most, which is the wait loop's own limit: a kill there is the
    // same "no answer", so it reads as the loop's exit 4.
    run: async (argv, timeoutMs) => {
      const t0 = await $.clock.now()
      const r = await runCmd($, argv, Math.min(timeoutMs ?? 60_000, 600_000))
      // Only a run that really ran out its time; an sh that failed to start stays the failure it is.
      const ranOut = (await $.clock.now()) - t0 >= 599_000
      return (timeoutMs ?? 0) > 600_000 && r.exitCode === 127 && ranOut ? { ...r, exitCode: 4 } : r
    },
  }
}

// Main's pump io: the relay directories of the role sessions it knows; an ended one is listed dead,
// so a call it left behind is refused instead of waiting for a pickup.
function pumpIoOf($: EngineInterface): PumpIo {
  return {
    ...relayIoOf($),
    dirs: async () => (await myRoleSessions($, true))
      .filter(s => s.relayDir !== undefined)
      .map(s => ({ name: s.name, dir: s.relayDir!, live: sessionLive(s) })),
  }
}

async function relayModeOf($: EngineInterface): Promise<RelayMode | undefined> {
  const role = await $.env.get('FLOW_ROLE').catch(() => undefined)
  if (role !== 'worker' && role !== 'manager' && role !== 'reviewer') return undefined
  const name = await $.env.get('FLOW_NAME').catch(() => undefined)
  const dir = await $.env.get('FLOW_RELAY').catch(() => undefined)
  return { role, name: name ?? '', dir: dir === undefined || dir === '' ? undefined : dir }
}

// A flow tool as main runs it: the tool's own fields and the caller's agent id (a session's is `session:<name>`).
type FlowCall = { agentId?: string } & Record<string, unknown>
type FlowOut = { result: unknown } | { deny: string }

function deliverToSession($: EngineInterface, fromId: string | undefined, target: Session, text: string): Promise<string> { return deliverToSessionTo(relayRunIoOf($), fromId, target, text) }
const sessionTool = ($: EngineInterface, input: Record<string, unknown>, caller: Caller, s: ReturnType<typeof settingsOf>) =>
  sessionToolTo(sessionIoOf($), input, caller, s)


// The tools the model sees. A relay copy registers the same specs: the calls go to main (tool.call below).
async function registerTools($: EngineInterface): Promise<void> {
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
  for (const name of ['reviewer', 'queue']) await $.tool.register(reviewerTool(name, name === 'queue'))
  await $.tool.register(PUSH_TOOL)
  await $.tool.register(STATUS_TOOL)

  await $.tool.register(DEPLOY_TOOL)

  await $.tool.register(CLEAN_TOOL)
  await $.tool.register(MIGRATIONS_TOOL)

  await $.tool.register(PLAN_TOOL)

  await $.tool.register(TEST_SLOT_TOOL)

  await $.tool.register(GUARD_TESTS_TOOL)

  await $.tool.register(SESSION_TOOL)
  await $.tool.register(SETTINGS_TOOL)
  await $.tool.register(DEMO_TOOL)
  await $.tool.register(DECIDE_EVAL_TOOL)
  await $.tool.register(SIZE_AB_TOOL)
  await $.tool.register(ARMS_TOOL)
}


function alreadyForwarded($: EngineInterface, rid: string, text: string): Promise<boolean> { return alreadyForwardedTo(relayRunIoOf($), rid, text) }
function pumpOnce($: EngineInterface, c: FlowCtx): Promise<void> { return pumpOnceTo(relayExecIoOf($, c)) }

// The io of the relay's client and of main's pump (bodies in relay-run.ts).
function relayRunIoOf($: EngineInterface): RelayRunIo {
  return {
    relay: () => relay!,
    call: (dir, req) => relayCall(relayIoOf($), dir, req),
    agents: () => $.agent.list(),
    sessionCwd: () => $.session.cwd(),
    mainGuard: (e, cwd, allow) => mainCheckoutGuard($, e, cwd, allow, async () => true),
    now: () => $.clock.now(),
    best: (what, fn) => best($, what, fn),
    sessions: () => read($, sessions),
    seenAgents: () => read($, seenAgents),
    forwarded: () => read($, forwarded),
    toMain: text => toMain($, text),
    ownerName: id => ownerNameOf($, id),
    routeGuard: (key, to, text) => reviewerSendGuard(routeIoOf($), key, to, text),
    deliverTerminal: (from, key, text) => deliverTo(ioOf($, from), key, text),
    deliver: (id, text) => deliver($, id, text),
    warn: (what, err) => warn($, what, err),
    myRoleSessions: () => myRoleSessions($),
    pumpIo: pumpIoOf($),
  }
}

function relayExecIoOf($: EngineInterface, c: FlowCtx): RelayExecIo {
  return {
    ...relayRunIoOf($),
    updateActivity: fn => update($, activity, fn),
    testSlots: () => read($, testSlots),
    typecheckSlots: () => read($, typecheckSlots),
    refresh: () => refresh($),
    slotLimits: () => ({ test: c.settings.testSlots, typecheck: c.settings.typecheckSlots ?? 1 }),
    flowTools: FLOW_TOOLS,
    runFlow: async (tool, input) => {
      const out = await runFlowTool($, tool, input, c)
      return out!
    },
  }
}


type FlowCtx = { settings: ReturnType<typeof settingsOf>; options: Record<string, unknown>; installed: string | undefined }
const FLOW_TOOLS = [
  'mcp__flow__handover',
  'mcp__flow__release',
  'mcp__flow__reviewer',
  'mcp__flow__queue',
  'mcp__flow__plan',
  'mcp__flow__test_slot',
  'mcp__flow__guard_tests',
  'mcp__flow__ask',
  'mcp__flow__fyi',
  'mcp__flow__preflight',
  'mcp__flow__answer',
  'mcp__flow__standing',
  'mcp__flow__check',
  'mcp__flow__note',
  'mcp__flow__clean',
  'mcp__flow__settings',
  'mcp__flow__decide_eval',
  'mcp__flow__size_ab_report',
  'mcp__flow__arms',
  'mcp__flow__demo',
  'mcp__flow__migrations',
  'mcp__flow__session',
  'mcp__flow__deploy',
  'mcp__flow__push',
  'mcp__flow__status',
] as const

// The io of the multi-line flow tool cases (bodies in toolcall-run.ts), over one call's context.
function flowToolsIoOf($: EngineInterface, c: FlowCtx, e: FlowCall): FlowToolsIo {
  const { settings, options } = c
  return {
    agents: () => $.agent.list(),
    exec: argv => $.process.run(argv),
    cwd: () => $.session.cwd(),
    now: () => $.clock.now(),
    sessionWorktree: async id => (await sessionOfId($, id))?.worktree,
    toolCaller: agentId => toolCallerOf($, agentId),
    handovers: () => read($, handovers),
    ownerName: id => ownerNameOf($, id),
    release: async () => releaseTool(releaseIoOf($), settings, e),
    reviewer: async () => reviewerToolRun(reviewerIoOf($, settings.base), settings, e, e.agentId),
    readNotes: manager => readNotes($, manager),
    appendNote: (manager, line) => appendNote($, manager, line),
    notesPath: manager => notesPath($, manager),
    logNote: (owner, text) => best($, 'logging a note', () => appendLog($, { event: 'note', owner, text })),
    sweep: (base, apply) => sweep($, base, apply),
    pushState: () => read($, pushState),
    pushAct: act => pushAct($, act, 'main'),
    sessionTool: caller => sessionTool($, e, caller, settings),
    deployTool: (isMain, caller) => deployTool($, options, e, isMain, caller),
  }
}

// The generic tool.call hook's io (bodies in toolcall-run.ts). The settings and main's model are read live
// through `held`: register() reassigns them.
function toolCallIoOf($: EngineInterface, held: Pick<ToolCallIo, 'settings' | 'explicitEffort' | 'mainModel' | 'mainWindow'>): ToolCallIo {
  return {
    ...held,
    ...guardIoOf($),
    now: () => $.clock.now(),
    sessionCwd: () => $.session.cwd(),
    agents: () => $.agent.list(),
    refresh: () => refresh($),
    testSlots: () => read($, testSlots),
    typecheckSlots: () => read($, typecheckSlots),
    sessions: () => read($, sessions),
    seenAgents: () => read($, seenAgents),
    activity: () => read($, activity),
    updateActivity: async fn => { await update($, activity, fn) },
    wokenByOthers,
    best: (what, fn) => best($, what, fn),
    reviewerSendGuard: (id, to, text) => reviewerSendGuard(routeIoOf($), id, to, text),
    alreadyForwarded: (id, text) => alreadyForwarded($, id, text),
    deliverToSession: (fromId, target, text) => deliverToSession($, fromId, target, text),
    holdForReviewer: id => holdForReviewer($, id),
  }
}

// Runs a flow tool for `e.agentId` (a hook's caller, or `session:<name>` for a relayed call). A function with
// a switch, not a table of closures: the plugin directory only lets `$` into functions declared at the top of the file.
async function runFlowTool($: EngineInterface, tool: string, e: FlowCall, c: FlowCtx): Promise<FlowOut | undefined> {
  const { settings, options, installed } = c
  switch (tool) {
    case 'mcp__flow__handover': return handoverTool(handoverIoOf($, options), settings, e, e.agentId)

    // The reviewer's tools: main, the reviewer, and a lite manager for its own PRs. A manager or worker otherwise is refused.
    case 'mcp__flow__release': return releaseCase(flowToolsIoOf($, c, e), e)

    case 'mcp__flow__reviewer':
    case 'mcp__flow__queue': return reviewerCase(flowToolsIoOf($, c, e), e)

    case 'mcp__flow__plan': return planTool(planIoOf($), settings, e, e.agentId)

    case 'mcp__flow__test_slot': return testSlotTool(slotsIoOf($), settings, e)

    case 'mcp__flow__guard_tests': return guardTestsCase(flowToolsIoOf($, c, e), settings.base, settings.guardTests, e)

    case 'mcp__flow__ask': return askTool(inboxIoOf($), options, e, e.agentId)
    case 'mcp__flow__fyi': return fyiTool(inboxIoOf($), e, e.agentId, settings, options)
    case 'mcp__flow__preflight': return preflightTool(inboxIoOf($), options, e, e.agentId)
    case 'mcp__flow__answer': return answerTool(inboxIoOf($), options, e, e.agentId)
    case 'mcp__flow__standing': return standingTool(standingIoOf($), options, e, e.agentId)
    case 'mcp__flow__check': return checkTool(checksIoOf($), installed, e, e.agentId)

    case 'mcp__flow__note': return noteCase(flowToolsIoOf($, c, e), e)

    case 'mcp__flow__clean': return cleanCase(flowToolsIoOf($, c, e), settings, e)

    case 'mcp__flow__settings': return settingsTool(initIoOf($), options, e, e.agentId)

    case 'mcp__flow__decide_eval': return ({ result: await decideEvalTool(decideEvalIoOf($), settings, e, e.agentId) })

    case 'mcp__flow__size_ab_report': return ({ result: await sizeAbTool({ stateDir: () => stateDir($), readFile: path => $.fs.read(path).then(String, () => undefined) }, e.agentId) })

    case 'mcp__flow__arms': return armsTool(armsIoOf($), e, e.agentId)

    case 'mcp__flow__demo': return demoTool(demoIoOf($), e, e.agentId)

    case 'mcp__flow__migrations': return migrationsTool(migrationsIoOf($), settings, e)

    case 'mcp__flow__session': return sessionCase(flowToolsIoOf($, c, e), e)

    case 'mcp__flow__deploy': return deployCase(flowToolsIoOf($, c, e), e)

    case 'mcp__flow__push': return pushCase(flowToolsIoOf($, c, e), e)

    case 'mcp__flow__status': return statusTool(statusIoOf($, options, settings.base), settings, e, e.agentId)
    default: return undefined
  }
}

type PaneLets = Pick<PaneIo, 'settings' | 'installed' | 'mainModel' | 'mainWindow' | 'setMainWindow' | 'paneFollow' | 'setPaneFollow'>

// What the pane (pane-run.tsx) draws and acts with, built from one event's `$`: a read closure per atom, the
// setters, the engine calls and the `$`-taking helpers of this file. The lets of register() come in as `lets`.
function paneIoOf($: EngineInterface, e: PaneEvent, lets: PaneLets, options: Record<string, unknown>): PaneIo {
  return {
    read: {
      roster: () => read($, roster),
      activity: () => read($, activity),
      selected: () => read($, selected),
      cursor: () => read($, cursor),
      folded: () => read($, folded),
      overrideView: () => read($, overrideView),
      hinted: () => read($, hinted),
      now: () => read($, now),
      handovers: () => read($, handovers),
      inbox: () => read($, inbox),
      checks: () => read($, checks),
      ledger: () => read($, ledger),
      leftovers: () => read($, leftovers),
      sessions: () => read($, sessions),
      harnessLimits: () => read($, harnessLimits),
      armed: () => read($, armed),
      deploys: () => read($, deploys),
      behind: () => read($, behind),
      pushState: () => read($, pushState),
      reviewerBreaker: () => read($, reviewerBreaker),
      plan: () => read($, plan),
      viewMode: () => read($, viewMode),
      prShown: () => read($, prShown),
      prBack: () => read($, prBack),
      batchPick: () => read($, batchPick),
      prDetails: () => read($, prDetails),
      inboxCursor: () => read($, inboxCursor),
      cardBack: () => read($, cardBack),
      inboxFolds: () => read($, inboxFolds),
      inboxOpen: () => read($, inboxOpen),
      inboxDraft: () => read($, inboxDraft),
      inboxNote: () => read($, inboxNote),
      graphFocus: () => read($, graphFocus),
      demo: () => read($, demo),
    },
    set: {
      selected: fn => update($, selected, fn),
      cursor: fn => update($, cursor, fn),
      folded: fn => update($, folded, fn),
      overrideView: fn => update($, overrideView, fn),
      hinted: fn => update($, hinted, fn),
      armed: fn => update($, armed, fn),
      viewMode: fn => update($, viewMode, fn),
      prShown: fn => update($, prShown, fn),
      prBack: fn => update($, prBack, fn),
      batchPick: fn => update($, batchPick, fn),
      prDetails: fn => update($, prDetails, fn),
      inboxCursor: fn => update($, inboxCursor, fn),
      cardBack: fn => update($, cardBack, fn),
      inboxFolds: fn => update($, inboxFolds, fn),
      inboxOpen: fn => update($, inboxOpen, fn),
      inboxDraft: fn => update($, inboxDraft, fn),
      inboxNote: fn => update($, inboxNote, fn),
      graphFocus: fn => update($, graphFocus, fn),
      demo: fn => update($, demo, fn),
    },
    resolve: () => $.ui.resolve(e as never),
    now: () => $.clock.now(),
    usage: () => $.session.usage().then(u => u, () => undefined),
    toast: text => { void $.ui.toast(text) },
    invalidate: () => { try { $.ui.invalidate('ui.render') } catch { /* pane closed */ } },
    after: (ms, fn) => { $.clock.after(ms, fn) },
    focus: key => $.ui.focus({ requestId: PANE, key }).catch(() => undefined),
    fill: text => $.prompt.fill({ text, mode: 'replace' }),
    runProcess: (argv, timeoutMs) => $.process.run(argv, { timeoutMs }),
    serial: paneSerial,
    ...lets,
    paneView: () => paneView,
    setPaneView: v => { paneView = v },
    unhanded: () => currentUnhanded($),
    endedOwners: () => endedOwnersOf($),
    demoArm: s => demoArm(demoIoOf($), s),
    demoMove: fn => demoMove(demoIoOf($), fn),
    demoStop: () => demoStop(demoIoOf($)),
    pushAct: (act, by) => pushAct($, act, by),
    approve: n => approvePr(commandIoOf($), n),
    reject: (n, why) => rejectPr(commandIoOf($), n, why),
    platform: () => platformOf($),
    paneInboxRows: () => paneInboxRows($),
    suggestions: () => paneSuggestions(standingIoOf($), options),
    dismiss: async ids => { await dismissSuggestionIds(standingIoOf($), options, ids) },
    answer: (id, choice) => answerQuestion($, id, choice, 'main', {}, true),
    sessionTool: input => sessionTool($, input, { id: 'main', name: 'main' }, lets.settings()),
  }
}

export const register: Register = (on, options) => {
  let settings = settingsOf(renameOptions(options), 'main')
  heldSettings = settings
  mirror.queueOn = settings.useReviewer
  mirror.cleanupMode = settings.cleanup
  mirror.cleanupBase = settings.base
  mirror.deployInfos = infosOf(settings)
  mirror.maxManagers = settings.maxManagers
  mirror.slotLimit = settings.testSlots
  mirror.decisionPhrases = settings.decisionPhrases
  mirror.preflightOn = settings.preflight
  mirror.preflightWaitMs = settings.preflightWait * 60_000
  mirror.askCards = settings.askCards
  // Settings reloads: the files' paths and mtimes, the detected base branch, whether a check runs.
  let paths: string[] = []
  let seen = ''
  let detected = 'main'
  let checking = false
  // Everything that mirrors the settings in a module-level variable is refreshed together.
  const apply = (s: typeof settings) => {
    settings = s
    heldSettings = s
    mirror.queueOn = s.useReviewer
    mirror.cleanupMode = s.cleanup
    mirror.cleanupBase = s.base
    mirror.deployInfos = infosOf(s)
    mirror.maxManagers = s.maxManagers
    mirror.slotLimit = s.testSlots
    mirror.decisionPhrases = s.decisionPhrases
    mirror.preflightOn = s.preflight
    mirror.preflightWaitMs = s.preflightWait * 60_000
    mirror.askCards = s.askCards
  }
  // Set once a `[1m]` model was refused for a sub-agent: later spawns go straight to the plain one.
  let noLong = false
  // Set once the host refused a flow:continue rewrite: later continuations start in a new worktree.
  let noContinue = false
  // Reasoning effort per flow-started agent (agent.spawn decides, turn.step applies: the spawn input has no effort
  // field). The activity row keeps it across a plugin reload; effortSeen marks agents already looked up there.
  const agentEffort = new Map<string, string>()
  const effortSeen = new Set<string>()
  // Agent tool calls that named an `effort` themselves (by tool_use_id): an explicit effort wins over flow's.
  const explicitEffort = new Set<string>()
  // Main's model and window, to size a subagent that runs the same model.
  let mainModel: string | undefined
  let mainWindow: number | undefined
  // What the last drawing showed in place of the stored state while following, else null.
  let paneFollow: { pick: string; cur: string } | null = null
  // What /flow resume already handed to managers in this session.
  const resumed = new Set<string>()
  // The version this plugin was installed as, read at session.start.
  let installed: string | undefined

  on('session.start', async ($, e, next) => {
    await startSession(startupIoOf($, options, {
      settings: () => settings,
      applySettings: apply,
      paths: () => paths, setPaths: p => { paths = p },
      detected: () => detected, setDetected: d => { detected = d },
      seen: () => seen, setSeen: x => { seen = x },
      checking: () => checking, setChecking: busy => { checking = busy },
      installed: () => installed, setInstalled: v => { installed = v },
    }))
    return next(e)
  })

  // A closed pane stays closed: only this command and a newly started agent (openPane) open it,
  // never the roster poll, so `/flow close` holds while agents keep running.
  on('command.run', { command: 'flow' }, ($, e) => relay !== undefined ? { text: 'Run /flow in the main Claude Code session; this one only forwards its flow tools.' } : flowCommand(commandIoOf($), settings, installed, resumed, options, e.args, e.presentation?.columns))

  // Hands the request to the main session's model, which runs it with the dispatch skill. A
  // command can't submit a prompt itself (it would wait on its own turn), so a timer queues it
  // once the command has returned.
  on('command.run', { command: 'flow-tasks' }, async ($, e) => {
    if (relay !== undefined) return { text: 'Run /flow-tasks in the main Claude Code session.' }
    const args = e.args.trim()
    const text = `Use the flow:dispatch skill, "Tasks from a source": pick tasks from ${args ? `the task source and selection "${args}"` : 'this project\'s task source'} and start a manager for each.`
    $.clock.after(1, () => void $.prompt.submit({ text }))
    return { text: `Picking tasks${args ? ` from ${args}` : ''}.` }
  })

  // The plugin starts flow:continue itself through a rewrite. The host checks a rewrite's type against the
  // offer as listed (a hook that is offered only while it dispatches is too late for that check, and the host
  // then replays the refusal to a second next), so the type stays offered; a model's own spawn of it is denied below.
  on('agent.offer', { agent: CONTINUE }, () => ({ isOffered: true }))

  // The state the agent.spawn hook (spawn-run.ts) reads and writes; it stays single here and is handed through the io.
  const spawnState: SpawnState = {
    relay: () => relay,
    settings: () => settings,
    options: () => options,
    noLong: () => noLong,
    setNoLong: () => { noLong = true },
    noContinue: () => noContinue,
    setNoContinue: () => { noContinue = true },
    takeExplicit: id => explicitEffort.delete(id),
    setEffort: (id, effort) => { agentEffort.set(id, effort) },
  }
  on('agent.spawn', ($, input, next) => onSpawn(spawnHookIoOf($, spawnState), input, next)).catch(($, e, next) => next(e))

  // Every tool call, the main session's too: refuse broad process kills and writes to the main
  // checkout. Then, for a subagent: refuse code edits from managers (a change goes into a
  // worker's brief), and keep the call as a line of the agent's activity log. The guards judge
  // before `next`, so the catch passes the call on only when the hook failed before it ran: a
  // broken guard must not block every call. A failure beneath `next` (a flow tool's own hook throwing)
  // reaches this catch, not the tool hook's own, so a flow tool that did not finish is answered here too.
  const toolCallHeld = { settings: () => settings, explicitEffort, mainModel: () => mainModel, mainWindow: () => mainWindow }
  on('tool.call', async ($, e, next) => {
    if (relay !== undefined) return (await relayToolCallTo(relayRunIoOf($), settings, e)) ?? next(e)
    const io = toolCallIoOf($, toolCallHeld)
    const refused = await beforeToolCall(io, e)
    if (refused !== undefined) return refused
    return afterToolCall(io, e, await next(e))
  }).catch((_$, e, next) => flowCatch(e, next))

  // In a relay copy nothing here may run: the generic hook above answers every flow tool through main,
  // and a call that got this far must not touch the copy's (empty) state.
  for (const tool of FLOW_TOOLS) {
    on('tool.call', { tool: tool as never }, async ($, e) => {
      if (relay !== undefined) return { result: `flow relay: ${tool.replace('mcp__flow__', '')} did not reach the main session; try again.` }
      const out = await runFlowTool($, tool, e as unknown as FlowCall, { settings, options, installed })
      return out!
    }).catch(toolCatch)
  }

  // Main can't be replaced like a worker: one warning per crossing, never an auto-compact.
  // Re-armed when usage drops back below the threshold (after a /compact).
  const mainWarn = { warned: false }

  // Context used by a subagent: the input side of its latest step. Observe only; the step passes untouched.
  // Main's model and window live in this closure; the usage module reads and sets them through these.
  const mainHeld = {
    mainModel: () => mainModel,
    setMainModel: (m: string | undefined) => { mainModel = m },
    mainWindow: () => mainWindow,
    setMainWindow: (w: number) => { mainWindow = w },
  }
  on('turn.step', async function* ($, e, next) {
    if (relay !== undefined) return yield* next(e)
    const step = await beforeStep(turnIoOf($, settings, { agentEffort, effortSeen }), e)
    const r = yield* next(step)
    await meterStep(usageIoOf($, settings, mainWarn, mainHeld), settings, e, r)
    await countStep(usageIoOf($, settings, mainWarn, mainHeld), e, r)
    return r
  })

  // Every completed turn (interrupted or errored too: it still wrote the cache) counts once per agent.
  const countedTurns = new Set<string>()
  on('turn.complete', async ($, e, next) => {
    if (relay !== undefined) return next(e)
    await countTurn(costIoOf($), countedTurns, e.agentId, (e as { turnId?: string }).turnId)
    await completeTurn(turnIoOf($, settings, { agentEffort, effortSeen }), e)
    return next(e)
  })

  // The pane paints with theme keys, which the engine resolves; a theme switch only needs a redraw.
  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const r = await next(e)
    try { $.ui.invalidate('ui.render') } catch { /* pane closed */ }
    return r
  })

  const paneLets: PaneLets = {
    settings: () => settings,
    installed: () => installed,
    mainModel: () => mainModel,
    mainWindow: () => mainWindow,
    setMainWindow: w => { mainWindow = w },
    paneFollow: () => paneFollow,
    setPaneFollow: f => { paneFollow = f },
  }
  // Arrows and Tab move the focus ring over the cards; the highlight follows it (pane-run.tsx).
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const r = await next(e)
    await paneFocus(paneIoOf($, {}, paneLets, options), e.element)
    return r
  })

  // Esc in the pane goes home from any sub-view. closeOnEscape makes the engine raise ui.close
  // (origin person) for it; answering without next keeps the pane open, so Esc never closes it.
  // inboxDraft stays: an unsent draft survives. A focused field keeps its own Esc (it only blurs).
  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind !== 'person') return next(e)
    await paneHome($)
    return { value: undefined }
  })

  // The pane draws in pane-run.tsx.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => paneDraw(paneIoOf($, e, paneLets, options), e))
}
