// This file is the wiring only: atoms, `on(...)` hooks, `$.tool.register` calls, and io builders whose
// closures spell out each `$.noun.event(...)` call. New logic goes into a module under hooks/, either
// pure or taking an io object of closures (see deliver.ts), because the engine refuses `$` across an
// import and wants atoms declared in this file.
import { atom, read, update } from 'claude-code'
import { lastLineAsks, REPORT_HINT } from './askcards'
import type { AgentInfo, AgentSpawnInput, EngineInterface, Register } from 'claude-code'

import type { Activity, AgentRow, Breaker, Ledger, Role, EnvChange, Handover, HandoffRecord, Leftovers, LogEvent, OpenPr, PrCache, Session, SlotEntry, TestSlots } from '../types'
import { grantFile, grantSlots, reapSlots } from './slots'
import type { Evidence } from './evidence'
import type { RunWork } from './mainff'
import { NO_FAILS, type TestFails } from './testfail'
import { leftoverLine } from './clean'
import { sweep as sweepTo } from './clean'
import type { CleanInputs, CleanIo, Kept, PrRow, Sweep } from './clean'
import { gatherLeftovers as gatherLeftoversTo } from './resume'
import type { Gathered, Leftover, ResumeIo } from './resume'
import { deliver as deliverTo, flushAgent as flushTo, holdForReviewer as holdTo, resetDelivery, ENDED, LIVE, type DeliverIo, type DeliverOptions } from './deliver'
import { addStep, addTurn, baseName, entriesOfBranch, setIdentity } from './cost'
import { changeLedger as changeLedgerTo, costLines as costLinesTo, loadLedger as loadLedgerTo, mainKey as mainKeyTo, withCost as withCostTo } from './cost-run'
import type { CostIo } from './cost-run'
import { countStep, countTurn, meterStep, type UsageIo } from './usage-run'
import { backNote } from './routing'
import { checkAttachments, CONTINUE_LINE, dispatch, fableDenied, FABLE_DENY, fileManagerSizeFyi, fileSizeFyi, FLOW_TYPES, prepareContinue, refusedLong, routeManager, routeWorker, withoutLong } from './spawn'
import { sizeWith } from './spawn'
import type { SizeJev } from './spawn'
import { decide, DECIDE_TIMEOUT_MS, sourceOf } from './decide'
import type { DecideIo, DecideSettings, FetchLike } from './decide'
import { adviceLine, adviceSuffix, handoffLean } from './decide-use'
import type { DecideUseSettings } from './decide-use'
import type { Routed, SpawnIo } from './spawn'
import { agentFor, asksQuestion, noticeText, settle } from './dag'
import type { AgentFact, Facts, Notice, Plan } from './dag'
import {
  answerMessage, askingNames, EMPTY_INBOX, isFyi, openAll, findItem, markAnswered, overridesManager, paneRows, needsMessage, normalizeInbox, notesOwner, endedOwners, foldedOf, FOLD_KEY, groupExpanded, hiddenByLink,
} from './inbox'
import type { PaneRow } from './inbox'
import {
  closeStale, denyText, dueRound, EMPTY_PREFLIGHT, gateOf, isLite, isSkip, markDelivered, normalizePreflight,
  recordSpawn, renderRound,
} from './preflight'
import type { Preflight } from './preflight'
import { deployToolAccess, EMPTY_LITE, isLiteName, normalizeLite, recordLite, releaseToolAccess, reviewerToolAccess, withLiteRules } from './lite'
import type { LiteState, ToolCaller } from './lite'
import {
  addChecks, anyMatch, dueForPrompt, EMPTY_CHECKS, normalizeChecks, paneChecksLine, parseNeeds,
  SKIP_NOTE, versionInSteps,
} from './checks'
import type { Check, Checks } from './checks'
import type { Inbox, Marked, Question } from './inbox'
import { addGuardTest, loadRules, offerSeedsOnce, standingTool, suggestGuardTests } from './standing-run'
import type { StandingIo } from './standing-run'
import { decideEvalTool } from './decide-eval-run'
import type { DecideEvalIo } from './decide-eval-run'
import { DEMO_TOOL, SETTINGS_TOOL } from './init-tools'
import { ANSWER_TOOL, ASK_TOOL, CHECK_TOOL, CLEAN_TOOL, DECIDE_EVAL_TOOL, DEPLOY_TOOL, FYI_TOOL, GUARD_TESTS_TOOL, HANDOVER_TOOL, MIGRATIONS_TOOL, NOTE_TOOL, PLAN_TOOL, PREFLIGHT_TOOL, PUSH_TOOL, RELEASE_TOOL, reviewerTool, SESSION_TOOL, STANDING_TOOL, STATUS_TOOL, TEST_SLOT_TOOL } from './tools'
import { detect as initDetect, firstRun, HINT as INIT_HINT, settingsTool, writeMarker } from './init'
import type { InitIo } from './init'
import { advance as demoAdvance, answer as demoAnswer, canAdvance, isLast as demoIsLast, startDemo, stepOf as demoStepOf } from './demo-replay'
import type { DemoState } from './demo-replay'
import { demoView } from './demo-view'
import { DEMO_AGENT, isDemoCommit, planCleanup, toInspect } from './demo-clean'
import { agentView, archiveView, batchCardView, card as cardTo, cardView, graphModeView, inboxView, managerGraphView, meter as meterTo, prCardView, treeView } from './pane-view'
import type { InboxCtx, PaneCtx, Usage } from './pane-view'
import { approvePr, detailsKey, detailsStale, fetchDetails, openerFor, platformOfUname, rejectPr, urlNote } from './prcard'
import type { DetailsCache } from './prcard'
import { describeCall, foldDefault, ROLE, shortModel, summarizeCall } from './pane'
import {
  fill, LITE_MARK, LITE_RULES, MANAGER_PROMPT, NO_REVIEWER_RULE, REVIEWER_PROMPT, REVIEWER_RULE, WORKER_PROMPT,
} from './prompts'
import type { Settings } from './prompts'
import { deployModeWarnings, deployTargetsOf, stateFileOf, targetsOf } from './prompts'
import { mergeLayers, renameOptions, settingsOf } from './settings'
import { releaseTool } from './release-run'
import type { ReleaseIo } from './release-run'
import { FORWARDED_RIDS, mainHasAnswer as mainHasAnswerTo, managerFinished as managerFinishedTo, needLines, normText, RELAY_DELAY_MS, resolveReportTo as resolveReportToTo, reviewerReport, reviewerSendGuard } from './reviewer-route'
import type { Forwarded, RouteIo } from './reviewer-route'
import { noteReviewerEnd, onReviewerAnswer as onReviewerAnswerTo, releaseHalt as releaseHaltTo, reviewerToolRun, startQueue } from './reviewer-run'
import { reconcileStale } from './stale-handovers'
import type { StaleIo } from './stale-handovers'
import type { BreakerIo, QueueIo, ReviewerIo } from './reviewer-run'
import { breakerLine, EMPTY_BREAKER, normalizeBreaker, REVIEWER_KIND } from './reviewer-breaker'
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
import { elapsed, tokensDown, LARGE_WINDOW, labelOf, limitLabel, thresholdOf, warnPercent, windowOf, wrapUpText } from './meter'
export { elapsed, tokensDown } from './meter'
import {
  allowed, allowList, flowActive, killRefusal, remoteDeleteRefusal, mainCheckoutRefusal, mainRelative, parseWorktrees, resolvePath, writeTargets,
} from './guards'
import type { WriteTarget } from './guards'
import { slotRefusal, suiteRun } from './testguard'
import { flowCatch, toolCatch } from './toolguard'
import {
  ago, claudeLimits, harnessesOf, runsOutIn, SESSION, sessionKey, sessionRow,
} from './sessions'
import type { HarnessSpec, Limit } from './sessions'
import { sessionTool as sessionToolTo, watchSessions as watchSessionsTo } from './session-run'
import type { Caller, Ran, SessionIo } from './session-run'
import { branchOwners, buildDigest, findWorktree, noteKey } from './state'
import { ADD_OPTION, guardReport, guardTestsFor, pathsFromStatus } from './guardtests'
import {
  EMPTY_PUSH, normalizePush,
  PUSH_KIND,
} from './pushgate'
import type { PushState } from './pushgate'
import { onPushAnswer as onPushAnswerTo, pushAct as pushActTo, pushLines, recordReady as recordReadyTo, settleBatch as settleBatchTo } from './pushgate-run'
import type { PushAct, PushIo } from './pushgate-run'
import {
  behindLines, EMPTY_DEPLOYS, ENV_KIND,
  normalizeDeploys,
  release,
} from './deploy'
import { cap, CONTINUE, DEFAULT_WORKER_MODEL, isReviewer, LIVE_STATUS, LOG_MAX, MANAGER, mirror, NOTES_MAX, PANE, POLL_MS, TEXT_MAX, WORKER, WORKERS } from './core'
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
// Managers started in lite mode (lite.ts), mirrored from <state dir>/lite.json.
const lite = atom({ plugin: 'flow', key: 'lite' } as const, EMPTY_LITE as LiteState)
const checks = atom({ plugin: 'flow', key: 'checks' } as const, EMPTY_CHECKS as Checks)
// Tokens spent per agent and model, mirrored (throttled) to <state dir>/ledger.json. Never forgets an ended agent.
const ledger = atom({ plugin: 'flow', key: 'ledger' } as const, {} as Ledger)
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
  activity: Record<string, Activity>, t: number, graceMs = GRACE_MS,
): Unhanded[] {
  const out: Unhanded[] = []
  for (const p of prs) {
    if (p.isDraft || !p.headRefName.startsWith('flow/')) continue
    const ho = handovers[String(p.number)]
    if (ho !== undefined && ho.status !== 'returned') continue
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
  return unhandedPrs(cache.prs, hs, rows, acts, t)
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
    net: decideIoOf($),
  }
}

function checksIoOf($: EngineInterface): ChecksIo {
  return {
    agents: () => $.agent.list(),
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
    open: () => $.ui.open({ id: PANE, title: 'Flow', focus: true }),
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
    demoStart: () => demoStart($),
    demoStop: () => demoStop($),
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
let demoGen = 0

const DEMO_DONE = 'Demo finished. /flow init settings sets your commands; /flow init demo live runs it for real (uses tokens).'

// One change to the running replay, in the pane's own order. Timers pass the generation they were set for.
function demoMove($: EngineInterface, fn: (s: DemoState, t: number) => DemoState, gen?: number): Promise<void> {
  return paneSerial(async () => {
    const cur = await read($, demo)
    if (cur === null || (gen !== undefined && cur.gen !== gen)) return
    const moved = fn(cur, await $.clock.now())
    if (moved === cur) return
    await update($, demo, () => moved)
    if (moved.step === cur.step) return
    if (demoIsLast(moved)) void $.ui.toast(DEMO_DONE)
    demoArm($, moved)
  })
}

function demoArm($: EngineInterface, s: DemoState): void {
  const ms = demoStepOf(s).autoMs
  if (ms === undefined) return
  $.clock.after(ms, () => void demoMove($, (cur, t) => (cur.step === s.step && canAdvance(cur) ? demoAdvance(cur, t) : cur), s.gen).catch(() => undefined))
}

async function demoStart($: EngineInterface): Promise<string> {
  if (await read($, demo) !== null) return 'The demo is already running in the Flow pane. /flow init demo stop ends it.'
  const s = startDemo(++demoGen, await $.clock.now())
  await update($, demo, () => s)
  await update($, inboxDraft, () => '')
  await update($, inboxNote, () => '')
  demoArm($, s)
  await $.ui.open({ id: PANE, title: 'Flow', focus: true })
  return 'Demo started in the Flow pane: a replay of one task with canned agents. No agents run, no tokens are used, nothing is written. m = next step, x = stop, or /flow init demo stop.'
}

async function demoStop($: EngineInterface): Promise<string> {
  if (await read($, demo) === null) return 'No demo is running.'
  await update($, demo, () => null)
  await update($, inboxDraft, () => '')
  await update($, inboxNote, () => '')
  return 'Demo stopped; the pane shows your real work again.'
}

// Removes what a real demo left: its worktree and branch, by the demo's own names only. Refused while a demo agent lives.
async function demoCleanup($: EngineInterface): Promise<string> {
  const live = (await $.agent.list()).filter(a => a.name !== undefined && DEMO_AGENT.test(a.name) && LIVE_STATUS.has(a.status))
  if (live.length > 0) return `Not cleaned: ${live.map(a => a.name).join(', ')} still running. Wait for it to end, then clean up.`
  const trees = await runCmd($, ['git', 'worktree', 'list', '--porcelain'])
  const refs = await runCmd($, ['git', 'for-each-ref', '--format=%(refname:short)', 'refs/heads/flow/'])
  // A worker's worktree whose branch is not named for the demo is the demo's only when its one commit is the demo file.
  const confirmed: string[] = []
  for (const w of toInspect(trees.stdout)) {
    const diff = await runCmd($, ['git', '-C', w.path, 'diff', '--name-status', 'HEAD~1', 'HEAD'])
    const status = await runCmd($, ['git', '-C', w.path, 'status', '--porcelain'])
    if (diff.exitCode === 0 && status.exitCode === 0 && isDemoCommit(diff.stdout, status.stdout)) confirmed.push(w.path)
  }
  const plan = planCleanup(trees.stdout, refs.stdout.split('\n').map(l => l.trim()).filter(l => l !== ''), confirmed)
  const out: string[] = plan.kept.map(k => `kept: ${k}`)
  for (const w of plan.worktrees) {
    const r = await runCmd($, ['git', 'worktree', 'remove', '--force', w.path])
    out.push(r.exitCode === 0 ? `removed worktree ${w.path}` : `could not remove worktree ${w.path}: ${r.stderr.trim()}`)
  }
  for (const b of plan.branches) {
    const r = await runCmd($, ['git', 'branch', '-D', b])
    out.push(r.exitCode === 0 ? `deleted branch ${b}` : `could not delete branch ${b}: ${r.stderr.trim()}`)
  }
  return out.length === 0 ? 'Nothing of the demo is left.' : out.join('\n')
}

async function demoTool($: EngineInterface, input: Record<string, unknown>, agentId: string | undefined): Promise<{ result: string }> {
  if (agentId !== undefined) return { result: 'Refused: only main runs the demo.' }
  const action = String(input.action ?? 'status')
  if (action === 'start') return { result: await demoStart($) }
  if (action === 'stop') return { result: await demoStop($) }
  if (action === 'cleanup') return { result: await demoCleanup($) }
  const agents = (await $.agent.list()).filter(a => a.name !== undefined && DEMO_AGENT.test(a.name)).map(a => `${a.name} (${a.status})`)
  return { result: `Replay: ${(await read($, demo)) === null ? 'not running' : 'running'}. Real demo agents: ${agents.join(', ') || 'none'}.` }
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
  }
}

// Settles every plan against the roster and handovers in one update, then tells each owner once (roster-run.ts).
function syncPlans($: EngineInterface, rows: AgentRow[], edit?: (p: Plan) => Plan, quietOwner?: string): Promise<Plan> {
  return syncPlansTo(rosterIoOf($), rows, edit, quietOwner)
}

// The roster as the board shows it: every agent of the session, with its role (roster-run.ts).
function refresh($: EngineInterface): Promise<AgentRow[]> { return refreshTo(rosterIoOf($)) }

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
  const me = (await $.agent.list()).find(a => a.id === agentId)
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
  const me = (await $.agent.list()).find(a => a.id === agentId)
  return me?.type === MANAGER && me.name !== undefined && isLiteName(await read($, lite), me.name) ? me.name : undefined
}

// Who is calling a reviewer-side tool: main, the reviewer, a lite manager or anyone else.
async function toolCallerOf($: EngineInterface, agentId: string | undefined): Promise<ToolCaller> {
  if (agentId === undefined) return { kind: 'main' }
  const me = (await $.agent.list()).find(a => a.id === agentId)
  // Only a manager or a worker is refused. An id the roster no longer lists (the host drops agents) is a reviewer's, as before.
  if (me === undefined || isReviewer(me.type)) return { kind: 'reviewer' }
  const name = await liteManagerOf($, agentId)
  if (name !== undefined) return { kind: 'lite', name }
  return me.type === MANAGER || WORKERS.has(me.type) ? { kind: 'other' } : { kind: 'reviewer' }
}

// A manager main just started joins the open round, or opens one with a timer for the wait. A lite one is skipped.
async function recordManager($: EngineInterface, name: string, prompt: string, liteMode: boolean): Promise<void> {
  const t = await $.clock.now()
  const opened = await withPreflight($, cur => {
    const changed = recordSpawn(cur, name, isSkip(prompt) || liteMode, t, mirror.preflightWaitMs)
    return { state: changed, out: changed.rounds.length > cur.rounds.length }
  })
  if (opened) $.clock.after(mirror.preflightWaitMs, () => void refresh($).catch(() => undefined))
}

const today = async ($: EngineInterface) => new Date(await $.clock.now()).toISOString().slice(0, 10)

function messagingIoOf($: EngineInterface): MessagingIo {
  return {
    inbox: () => read($, inbox),
    withInbox: fn => withInbox($, fn),
    now: () => $.clock.now(),
    today: () => today($),
    agents: () => $.agent.list(),
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
function ioOf($: EngineInterface): DeliverIo {
  return {
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
  }
}
const refusals = new Map<string, string>()
const deliver = ($: EngineInterface, id: string, text: string, opts?: DeliverOptions) => deliverTo(ioOf($), id, text, opts)
const flushAgent = ($: EngineInterface, id: string) => flushTo(ioOf($), id)
const holdForReviewer = ($: EngineInterface, id: string) => holdTo(ioOf($), id)
const toMain = ($: EngineInterface, text: string) => $.clock.after(0, () => void $.prompt.submit({ text }).catch(() => undefined))

function routeIoOf($: EngineInterface): RouteIo {
  return {
    agents: () => $.agent.list(),
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

// A worker's HANDOFF: write the digest, log it, remember where its worktree is, and warn the owner when the
// package keeps handing off. Best-effort throughout: a missing digest still leaves the record.
async function recordHandoff($: EngineInterface, me: AgentRow, branch: string, owner: string, maxContinues: number, decideSettings: DecideUseSettings): Promise<void> {
  const prior = (await readLog($)).filter(ev => ev.event === 'handoff' && ev.branch === branch)
  // turn.complete can fire again for the same agent; count its handoff once.
  if (prior.some(ev => ev.agent === me.name)) return
  const count = prior.length + 1
  let digestPath: string | undefined
  let note: string | undefined
  await best($, 'writing a handoff digest', async () => {
    const dir = await stateDir($)
    if (dir === undefined) return
    const msgs = await $.session.messages({ agentId: me.id })
    if ('deny' in msgs) return
    const path = `${dir}/handoffs/${branch.replaceAll('/', '-')}/${count}.md`
    await $.process.run(['mkdir', '-p', path.slice(0, path.lastIndexOf('/'))])
    note = buildDigest(msgs, branch, me.name ?? me.id)
    await $.fs.write(path, note)
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
  // decide_handoff: the provider's lean, advice only; max_continues is enforced the same either way.
  const lean = me.parentId === undefined ? undefined : await handoffLean(decideIoOf($), standingIoOf($), decideSettings, { branch, owner, note, count, maxContinues }).catch(() => undefined)
  const source = sourceOf(decideSettings)
  if (count > maxContinues && me.parentId !== undefined) {
    void $.ui.toast(`${branch} has handed off ${count} times: split it`)
    await deliver($, me.parentId, `flow: ${branch} has handed off ${count} times (max_continues ${maxContinues}). The package is too big for one worker: split the Remaining part of its handoff note into smaller briefs instead of another plain continuation.${lean === undefined ? '' : adviceSuffix(source, lean)}`, { urgent: true }).catch(() => undefined)
  } else if (lean !== undefined && me.parentId !== undefined) {
    const line = adviceLine(source, branch, lean)
    // Advice only: it waits for the manager's next turn (the handoff report itself wakes it).
    if (line !== undefined) await deliver($, me.parentId, line, { held: true }).catch(() => undefined)
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
    agents: () => $.agent.list(),
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
    spawn: input => $.agent.spawn(input),
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

const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit']

// Why a call is refused as a write to the repo's main checkout, or undefined. `cwd` is where
// the caller's shell runs when that is known: the main session and managers run in the
// session's directory; a worker's or the reviewer's worktree isn't known here, so their relative
// paths are let through and only absolute ones judged.
// The main session (and a non-flow subagent of it) is guarded only while flow has work in this
// repo: a flow worktree, or a live flow agent. `flowCaller` says the caller is itself a flow
// agent, which is guarded regardless.
async function mainCheckoutGuard($: EngineInterface, e: Record<string, unknown>, cwd: () => Promise<string | undefined>, allow: string[], flowCaller: () => Promise<boolean>): Promise<string | undefined> {
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
  // Judged lazily: only a write into the main checkout needs the activity signal.
  let active: boolean | undefined
  const guarded = async () => active ??= (await flowCaller()) || flowActive(co) ||
    (await $.agent.list()).some(a => (a.type === MANAGER || WORKERS.has(a.type) || isReviewer(a.type)) && (LIVE_STATUS.has(a.status) || a.status === 'idle'))
  for (const t of targets) {
    const rel = mainRelative(t.path, co)
    if (rel === undefined) continue
    if (!(await guarded())) return undefined
    // A git command changes the whole checkout, whichever directory of it runs it.
    if (t.git) return mainCheckoutRefusal(co.main, `\`git\` in ${t.path}`, allow)
    if (!allowed(rel, allow)) return mainCheckoutRefusal(co.main, t.path, allow)
  }
  return undefined
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

// The PR card's gh details, fetched when the card is opened (a render is pure, it cannot write): the entry
// is marked first so a second open does not start another call, and the result lands in the cache, which
// redraws the pane. Keyed by PR and head; a fresh entry is not fetched again.
function fetchPrDetails($: EngineInterface, pr: number): void {
  void (async () => {
    const ho = (await read($, handovers))[String(pr)]
    if (ho === undefined) return
    const key = detailsKey(ho)
    const t = await $.clock.now()
    if (!detailsStale((await read($, prDetails))[key], t)) return
    await update($, prDetails, c => ({ ...c, [key]: { ...c[key], fetchedAt: t, fetching: true as const } }))
    const fresh = await fetchDetails((argv, timeoutMs) => $.process.run(argv, { timeoutMs }), pr, await $.clock.now())
    await update($, prDetails, c => ({ ...c, [key]: fresh }))
  })().catch(() => undefined)
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

// The platform, asked once through `uname -s`: the engine has no platform field.
let platform: Promise<string> | undefined
function platformOf($: EngineInterface): Promise<string> {
  platform ??= runCmd($, ['uname', '-s'], 5_000).then(r => platformOfUname(r.exitCode === 0 ? r.stdout : undefined))
  return platform
}

// A second press within this long confirms restart or stop from the pane.
const ARM_MS = 5000

function sessionIoOf($: EngineInterface): SessionIo {
  return {
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
  }
}
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
  mirror.askCards = settings.askCards
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
    mirror.askCards = s.askCards
  }
  // Set once a `[1m]` model was refused for a sub-agent: later spawns go straight to the plain one.
  let noLong = false
  // Set once the host refused a flow:continue rewrite: later continuations start in a new worktree.
  let noContinue = false
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
      queueDue = Object.values(disk).some(ho => ho.status === 'pending')
    })
    // Reviewer worktrees left over from before a restart or reload.
    autoSweep($)
    await best($, 'loading the inbox', async () => {
      const dir = await stateDir($)
      if (dir === undefined) return
      const disk = normalizeInbox(await readJson($, `${dir}/inbox.json`))
      await update($, inbox, () => disk)
    })
    // A fresh session is a fresh attempt: the halt and the wait end, the failure history stays.
    await best($, 'loading the reviewer breaker', async () => {
      const dir = await stateDir($)
      if (dir === undefined) return
      const disk = normalizeBreaker(await readJson($, `${dir}/reviewer-breaker.json`))
      await update($, reviewerBreaker, () => disk)
      await releaseHaltTo(breakerIoOf($), 'flow')
    })
    await best($, 'loading checks', async () => {
      installed = await installedVersion($)
      const dir = await stateDir($)
      if (dir === undefined) return
      const disk = normalizeChecks(await readJson($, `${dir}/checks.json`))
      await update($, checks, () => disk)
      // Done handovers from before checks existed (or a session that died first) get theirs once.
      for (const ho of Object.values(await read($, handovers))) {
        // A PR that already has a check (any state) runs no git calls on a normal restart.
        if (ho.status === 'done' && !(await read($, checks)).items.some(c => c.pr === ho.pr)) await captureChecks($, ho, settings.verifyPaths, false)
      }
      // Once per installed version: a toast names the checks it now covers. Not a prompt: an update
      // must not start a turn in main; the checks stay in /flow checks, the inbox and the pane.
      const due = dueForPrompt(await read($, checks), installed)
      if (due.length === 0) return
      await withChecks($, cur => ({ checks: { ...cur, promptedVersion: installed }, out: undefined }))
      void $.ui.toast(`flow ${installed}: ${due.length} after-deploy check${due.length === 1 ? '' : 's'} can be done now. /flow checks lists them.`)
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
    await best($, 'loading lite managers', async () => {
      const dir = await stateDir($)
      if (dir === undefined) return
      const disk = normalizeLite(await readJson($, `${dir}/lite.json`))
      await update($, lite, () => disk)
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
      description: 'Show the flow in a pane: managers, their workers, the reviewer and handed-over PRs. /flow inbox lists the open questions and the decisions agents made (/flow inbox decisions lists them all, /flow inbox <id> shows one in full), /flow ok keeps every open decision (/flow ok <id|owner|topic> takes those, or the default of a question), /flow no <id> [what instead] undoes a decision, /flow answer <id> <choice> answers any question addressed to main, /flow status shows what the agents cost (estimates at API list prices), /flow checks lists the after-deploy checks that need a person (pass or fail them), /flow preflight shows the current pre-flight round, /flow close closes it, /flow lite <task> runs one task as just a manager and its workers (no pre-flight, no reviewer agent) to save tokens, /flow resume picks up unfinished flow work, /flow approve <pr> lets the reviewer merge a PR that awaits your approval, /flow reject <pr> [reason] (alias /flow drop) turns down a handover that awaits approval or is pending, /flow push starts the push of the batch the reviewer checked and saved (push_mode confirm; /flow push back <pr> sends one PR back, /flow push drop returns them all), /flow hold <target> [batch|released] keeps a deploy target from deploying and /flow release <target> lets it, /flow clean lists leftover worktrees and branches (--yes removes them)',
      argumentHint: '[inbox [all|archive [all]|<id>]|ok [<id|owner|topic>...]|no <id> [what instead]|answer <id> <choice>|checks|status|preflight|close|lite <task>|resume|approve <pr>|reject <pr> [reason]|push [back <pr>|drop]|clean]',
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
    // A replay left over from before a reload is gone with the atom's memory; this clears it explicitly.
    await update($, demo, () => null)
    // A new repo: one line pointing at /flow init, after the session has drawn.
    $.clock.after(3000, () => void best($, 'first-run hint', async () => { if (await firstRun(initIoOf($))) void $.ui.toast(INIT_HINT) }))
    return next(e)
  })

  // A closed pane stays closed: only this command and a newly started agent (openPane) open it,
  // never the roster poll, so `/flow close` holds while agents keep running.
  on('command.run', { command: 'flow' }, ($, e) => flowCommand(commandIoOf($), settings, installed, resumed, options, e.args, e.presentation?.columns))

  // Hands the request to the main session's model, which runs it with the dispatch skill. A
  // command can't submit a prompt itself (it would wait on its own turn), so a timer queues it
  // once the command has returned.
  on('command.run', { command: 'flow-tasks' }, async ($, e) => {
    const args = e.args.trim()
    const text = `Use the flow:dispatch skill, "Tasks from a source": pick tasks from ${args ? `the task source and selection "${args}"` : 'this project\'s task source'} and start a manager for each.`
    $.clock.after(1, () => void $.prompt.submit({ text }))
    return { text: `Picking tasks${args ? ` from ${args}` : ''}.` }
  })

  // The plugin starts flow:continue itself through a rewrite. The host checks a rewrite's type against the
  // offer as listed (a hook that is offered only while it dispatches is too late for that check, and the host
  // then replays the refusal to a second next), so the type stays offered; a model's own spawn of it is denied below.
  on('agent.offer', { agent: CONTINUE }, () => ({ isOffered: true }))

  on('agent.spawn', async ($, input, next) => {
    let e = input
    // Only the plugin's own rewrite below starts flow:continue: it needs the old worktree as cwd.
    if (e.subagentType === CONTINUE) return { deny: 'flow: flow:continue is started by the plugin only; spawn a flow:worker with "Continue on branch: <branch>" in the brief.' }
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
    // Lite mode: a `Mode: lite` line (or an earlier spawn of this manager's task) puts the LITE rules in front of the prompt.
    let liteMode = false
    if (e.subagentType === MANAGER) {
      liteMode = isLite(e.prompt) || isLiteName(await read($, lite), (e as { name?: string }).name ?? e.description)
      if (liteMode) e = { ...e, prompt: withLiteRules(e.prompt, fill(LITE_RULES, settings), LITE_MARK) }
    }
    if (await fableDenied(spawnIoOf($), e)) return { deny: FABLE_DENY }
    // Model routing: the brief's Size line (or a successor's escalation) picks the worker's model, over a model param.
    let routed: Routed | undefined
    if (e.subagentType === WORKER) {
      const r = await routeWorker(spawnIoOf($), e, { small: settings.workerModelSmall ?? 'haiku', normal: settings.workerModelNormal ?? 'sonnet', large: settings.workerModel }, jevOf($, settings))
      e = r.e
      routed = r.routed
    } else if (e.subagentType === MANAGER) {
      const r = await routeManager(spawnIoOf($), e, settings.managerModelSmall ?? 'sonnet', settings.managerModel, jevOf($, settings))
      e = r.e
      routed = r.routed
    } else if (e.subagentType === 'Explore' && e.model === undefined && e.parentAgentId !== undefined) {
      // Read-only exploring by a flow agent runs on the cheap model; main's own and an explicit model stay as they are.
      const parent = (await $.agent.list()).find(a => a.id === e.parentAgentId)
      if (parent !== undefined && FLOW_TYPES.has(parent.type)) e = { ...e, model: settings.exploreModel ?? 'haiku' }
    }
    // A flow agent on a [1m] model: if sub-agents refuse it, retry on the plain model once and
    // remember, so later spawns skip the failed try. A no-model spawn gets the registered model.
    const spawn = e.subagentType === WORKER ? await prepareContinue(spawnIoOf($), e, !noContinue) : e
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
      await best($, 'releasing a continuation claim', async () => { await update($, handoffs, hs => {
        const r = branch === undefined ? undefined : hs[branch]
        if (branch === undefined || r === undefined || r.takenBy !== name) return hs
        const { takenBy: _t, ...rest } = r
        return { ...hs, [branch]: rest }
      }) })
      // The host replays its refusal to a second next of this spawn, so no retry in this call: later
      // continuations skip the in-place rewrite, and the manager is told to spawn the brief again.
      noContinue = true
      await best($, 'logging a continuation fallback', async () => appendLog($, { event: 'continue', agent: name, owner: await ownerNameOf($, e.parentAgentId), branch, text: 'new worktree (flow:continue refused)' }))
      return { deny: `flow: the host refused the in-place continuation (flow:continue); spawn the same brief again and it starts as a plain flow:worker in a new worktree on ${branch}.` }
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
      if (liteMode) await best($, 'recording a lite manager', async () => { const at = await $.clock.now(); await withLite($, cur => ({ state: recordLite(cur, (e as { name?: string }).name ?? e.description, at), out: undefined })) })
      // A lite task files no size decisions: not for its manager, not for its workers. The routing itself still happens.
      const liteOwner = e.subagentType === WORKER && routed !== undefined && isLiteName(await read($, lite), (await $.agent.list()).find(a => a.id === e.parentAgentId)?.name)
      if (routed !== undefined && !liteMode && !liteOwner) {
        const r = routed
        if (e.subagentType === MANAGER) await best($, 'filing a manager-size decision', () => fileManagerSizeFyi(spawnIoOf($), options, (e as { name?: string }).name ?? e.description, id, r))
        else await best($, 'filing a worker-size decision', () => fileSizeFyi(spawnIoOf($), options, (e as { name?: string }).name ?? e.description, e.parentAgentId, r))
      }
      if (mirror.preflightOn && e.subagentType === MANAGER && e.parentAgentId === undefined) {
        await best($, 'recording a pre-flight', () => recordManager($, (e as { name?: string }).name ?? e.description, e.prompt, liteMode))
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
  // broken guard must not block every call. A failure beneath `next` (a flow tool's own hook throwing)
  // reaches this catch, not the tool hook's own, so a flow tool that did not finish is answered here too.
  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    if (e.tool === 'Bash') {
      const why = killRefusal(e.command)
      if (why !== undefined) return { deny: why }
      // A whole-suite run needs a held test slot. Slot state is read only when the command matches.
      const suite = suiteRun(e.command, settings.testSlotCommands ?? [])
      if (suite !== undefined) {
        const refused = slotRefusal(await read($, testSlots), await refresh($), id ?? 'main', settings.testSlots, await $.clock.now(), suite)
        if (refused !== undefined) return { deny: refused }
      }
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
      const flowCaller = async () => {
        const type = id === undefined ? undefined : (await whoAmI())?.type
        return type !== undefined && (type === MANAGER || WORKERS.has(type) || isReviewer(type))
      }
      const why = await mainCheckoutGuard($, e as unknown as Record<string, unknown>, cwd, settings.mainAllow, flowCaller)
      if (why !== undefined) return { deny: why }
    }
    if (e.tool === 'SendMessage') {
      const input = e as unknown as Record<string, unknown>
      const to = String(input.to ?? '')
      const text = String(input.message ?? input.text ?? '')
      if (id !== undefined && isReviewer((await whoAmI())?.type ?? '')) {
        let handled: string | undefined
        await best($, 'routing a reviewer message', async () => { handled = await reviewerSendGuard(routeIoOf($), id, to, text) })
        // A built-in tool's output must be an object; a string result is refused by the host as
        // "SendMessage output is not an object". deny carries the same "Not sent" text to the reviewer.
        if (handled !== undefined) return { deny: handled }
        if (to === 'main') {
          // Lines the guard already sent main need no second copy; anything new goes through.
          const lines = text.split('\n').map(normText).filter(l => l !== '')
          const sent = (await read($, forwarded)).lines[id] ?? []
          if (lines.length > 0 && lines.every(l => sent.includes(l) || (needLines(l).length > 0 && needLines(l).every(n => sent.includes(n))))) {
            return { deny: 'Not sent: main already has this report (the plugin forwarded it). Do not repeat it.' }
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
  }).catch((_$, e, next) => flowCatch(e, next))

  on('tool.call', { tool: 'mcp__flow__handover' }, ($, e) => handoverTool(handoverIoOf($, options), settings, e as unknown as Record<string, unknown>, e.agentId)).catch(toolCatch)

  // The reviewer's tools: main, the reviewer, and a lite manager for its own PRs. A manager or worker otherwise is refused.
  on('tool.call', { tool: 'mcp__flow__release' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const refused = releaseToolAccess(await toolCallerOf($, e.agentId), input, await read($, handovers))
    return refused !== undefined ? { result: refused } : releaseTool(releaseIoOf($), settings, input)
  }).catch(toolCatch)

  for (const tool of ['mcp__flow__reviewer', 'mcp__flow__queue'] as const) on('tool.call', { tool }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const refused = reviewerToolAccess(await toolCallerOf($, e.agentId), input, await read($, handovers))
    return refused !== undefined ? { result: refused } : reviewerToolRun(reviewerIoOf($, settings.base), settings, input, e.agentId)
  }).catch(toolCatch)

  on('tool.call', { tool: 'mcp__flow__plan' }, ($, e) => planTool(planIoOf($), settings, e as unknown as Record<string, unknown>, e.agentId)).catch(toolCatch)

  on('tool.call', { tool: 'mcp__flow__test_slot' }, ($, e) => testSlotTool(slotsIoOf($), settings, e as unknown as Record<string, unknown>)).catch(toolCatch)

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
  }).catch(toolCatch)

  on('tool.call', { tool: 'mcp__flow__ask' }, ($, e) => askTool(inboxIoOf($), options, e as unknown as Record<string, unknown>, e.agentId)).catch(toolCatch)
  on('tool.call', { tool: 'mcp__flow__fyi' }, ($, e) => fyiTool(inboxIoOf($), e as unknown as Record<string, unknown>, e.agentId, settings)).catch(toolCatch)
  on('tool.call', { tool: 'mcp__flow__preflight' }, ($, e) => preflightTool(inboxIoOf($), options, e as unknown as Record<string, unknown>, e.agentId)).catch(toolCatch)
  on('tool.call', { tool: 'mcp__flow__answer' }, ($, e) => answerTool(inboxIoOf($), options, e as unknown as Record<string, unknown>, e.agentId)).catch(toolCatch)
  on('tool.call', { tool: 'mcp__flow__standing' }, ($, e) => standingTool(standingIoOf($), options, e as unknown as Record<string, unknown>, e.agentId)).catch(toolCatch)
  on('tool.call', { tool: 'mcp__flow__check' }, ($, e) => checkTool(checksIoOf($), installed, e as unknown as Record<string, unknown>, e.agentId)).catch(toolCatch)

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
  }).catch(toolCatch)

  on('tool.call', { tool: 'mcp__flow__clean' }, async ($, e) => {
    const apply = (e as unknown as Record<string, unknown>).apply === true
    if (apply && settings.cleanup === 'off') {
      return { result: `Cleanup is off (the cleanup setting): a dry run instead, nothing removed. A person removes with /flow clean --yes.\n${await sweep($, settings.base, false)}` }
    }
    return { result: await sweep($, settings.base, apply) }
  }).catch(toolCatch)

  on('tool.call', { tool: 'mcp__flow__settings' }, ($, e) => settingsTool(initIoOf($), options, e as unknown as Record<string, unknown>, e.agentId)).catch(toolCatch)

  on('tool.call', { tool: 'mcp__flow__decide_eval' }, async ($, e) => ({ result: await decideEvalTool(decideEvalIoOf($), settings, e as unknown as Record<string, unknown>, e.agentId) })).catch(toolCatch)

  on('tool.call', { tool: 'mcp__flow__demo' }, ($, e) => demoTool($, e as unknown as Record<string, unknown>, e.agentId)).catch(toolCatch)

  on('tool.call', { tool: 'mcp__flow__migrations' },($, e) => migrationsTool(migrationsIoOf($), settings, e as unknown as Record<string, unknown>)).catch(toolCatch)

  on('tool.call', { tool: 'mcp__flow__session' }, async ($, e) => {
    const id = e.agentId
    const caller: Caller = id === undefined ? { id: 'main', name: 'main' } : { id, name: await ownerNameOf($, id) }
    return { result: await sessionTool($, e as unknown as Record<string, unknown>, caller, settings) }
  }).catch(toolCatch)

  on('tool.call', { tool: 'mcp__flow__deploy' }, async ($, e) => {
    const isMain = e.agentId === undefined
    const caller = isMain ? 'main' : await ownerNameOf($, e.agentId!)
    const refused = deployToolAccess(await toolCallerOf($, e.agentId), e as unknown as Record<string, unknown>, await read($, handovers))
    if (refused !== undefined) return { result: refused }
    return { result: await deployTool($, options, e as unknown as Record<string, unknown>, isMain, caller) }
  }).catch(toolCatch)

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
  }).catch(toolCatch)

  on('tool.call', { tool: 'mcp__flow__status' }, ($, e) => statusTool(statusIoOf($, options, settings.base), settings, e as unknown as Record<string, unknown>, e.agentId)).catch(toolCatch)
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
    // The agent is running now: texts held for it ride along.
    if (e.agentId !== undefined) await flushAgent($, e.agentId).catch(() => undefined)
    const r = yield* next(e)
    await meterStep(usageIoOf($, settings, mainWarn, mainHeld), settings, e, r)
    await countStep(usageIoOf($, settings, mainWarn, mainHeld), e, r)
    return r
  })

  // Every completed turn (interrupted or errored too: it still wrote the cache) counts once per agent.
  const countedTurns = new Set<string>()
  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    await countTurn(costIoOf($), countedTurns, id, (e as { turnId?: string }).turnId)
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
          if (!(await mainHasAnswer($, answer))) toMain($, `Report from manager ${me.name}:\n${answer}${mirror.askCards && lastLineAsks(answer) ? `\n${REPORT_HINT}` : ''}`)
        })().catch(() => undefined))
      }
      // `HANDOFF: manager <name>` is a manager's own note, not a worker's branch.
      const handedOff = /^HANDOFF:\s*(?!manager\b)(\S+)\s*$/.exec(e.answer.trim().split('\n').pop() ?? '')
      if (me && WORKERS.has(me.type) && handedOff?.[1] !== undefined) {
        const owner = rows.find(a => a.id === me.parentId)?.name ?? 'main'
        await best($, 'recording a handoff', () => recordHandoff($, me, handedOff[1] as string, owner, settings.maxContinues, settings))
      }
      // A reviewer that ends at once (no answer, an API error) must not be replaced at once: the breaker records
      // the end and decides when, or whether, the next one starts.
      if (me && isReviewer(me.type)) {
        await best($, 'recording the reviewer end', () => noteReviewerEnd(breakerIoOf($), { name: me.name ?? '', answer: e.answer, reason: e.reason, status: me.status }))
        await ensureQueue($)
      }
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
    const dm = await read($, demo)
    if (dm !== null) {
      const Input = ($.ui.resolve(e) as unknown as { Input?: Parameters<typeof demoView>[0]['Input'] }).Input
      return demoView({
        els: { Box, Text, Button }, Input, rows: e.viewport?.rows ?? 24, state: dm, now: await read($, now), draft: await read($, inboxDraft), note: await read($, inboxNote),
        io: {
          setDraft: v => update($, inboxDraft, () => v),
          setNote: v => update($, inboxNote, () => v),
          answer: (id, choice) => paneSerial(async () => {
            const cur = await read($, demo)
            if (cur === null) return 'The demo has ended.'
            const r = demoAnswer(cur, id, choice, await $.clock.now())
            await update($, demo, () => r.state)
            await update($, inboxDraft, () => '')
            if (r.state.step !== cur.step) { if (demoIsLast(r.state)) void $.ui.toast(DEMO_DONE); demoArm($, r.state) }
            return r.text
          }),
          toast: text => { void $.ui.toast(text) },
          focus: key => $.ui.focus({ requestId: PANE, key }).catch(() => undefined),
          advance: () => demoMove($, (s, t) => (canAdvance(s) ? demoAdvance(s, t) : s)),
          stop: async () => { void $.ui.toast(await demoStop($)) },
        },
      })
    }
    let [list, acts, pick, t, hs, cur, fold, unhanded, leftCounts] = await Promise.all([
      read($, roster), read($, activity), read($, selected), read($, now), read($, handovers),
      read($, cursor), read($, folded), currentUnhanded($), read($, leftovers),
    ])
    const leftover = leftoverLine(leftCounts)
    // The push item is drawn as the banner on top, not as a question.
    const boxNow = await read($, inbox)
    const openQs = openAll(boxNow).filter(q => !isFyi(q) && q.kind !== PUSH_KIND && !hiddenByLink(boxNow, q)).sort((a, b) => Number(b.blocking) - Number(a.blocking))
    const gate = (await read($, pushState)).batch
    const breakerNote = breakerLine(await read($, reviewerBreaker), t)
    const askers = askingNames(await read($, inbox))
    const fyiCount = openAll(await read($, inbox)).filter(isFyi).length
    // Rows in the tree: questions and approvals, not decisions; those fold into the one Inbox line.
    const openItems = [...openQs, ...foldedOf(await read($, inbox), await endedOwnersOf($)).shown.filter(q => q.kind !== PUSH_KIND && !isFyi(q)).reverse()]
    // The key row is drawn when any key in it works: the agents' keys, the reviewer's, or the inbox's.
    // The inbox key also opens the archive, so answered items keep it drawn.
    const anyOpen = (await read($, inbox)).items.length > 0
    const checksLine = paneChecksLine(await read($, checks), installed)
    // One inbox line (counts and the key) follows the listed questions.
    const inboxRows = Math.min(openItems.length, 5) + (openItems.length > 5 ? 1 : 0) + (openQs.length > 0 || fyiCount > 0 ? 1 : 0) + (checksLine === undefined ? 0 : 1) + (gate === undefined ? 0 : gate.state === 'ready' ? 2 : 1)
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
    const spent = await read($, ledger)
    const modelOf = (a: AgentRow) => a.type === SESSION ? sessionMap[a.name ?? '']?.harness : shortModel(spent[a.id]?.spawnModel)
    const columns = e.viewport?.columns ?? 80
    const card = (a: AgentRow, depth: number, full: boolean, bordered: boolean, hot = false, collapsed?: boolean) => cardTo({
      els: { Box, Text, Button }, list, acts, askers, decisionPhrases: settings.decisionPhrases, t, usageOf, warnOf, meter, runTime, toggleFold, open, columns, modelOf,
    }, a, depth, full, bordered, hot, collapsed)
    const agent = list.find(a => a.id === pick)

    const toggle = <Button key="toggle-view" plain dimColor hotkey="g" onPress={async () => {
      await acted()
      await update($, viewMode, m => (m === 'graph' ? 'tree' : 'graph'))
    }}>g {mode === 'graph' ? 'tree' : 'graph'}</Button>

    const toggleQueue = async () => {
      await acted()
      await update($, folded, f => ({ ...f, [MERGE_QUEUE_KEY]: f[MERGE_QUEUE_KEY] === false }))
    }
    const ctx: PaneCtx = {
      els: { Box, Text, Button }, list, acts, plans, rows, columns, modelOf, t, gfocus, shown, sessionMap, arm, armMs: ARM_MS,
      askers, decisionPhrases: settings.decisionPhrases, toggle, card, runTime, control, acted, open,
      back: async parentId => { await acted(); await update($, selected, () => parentId) },
      fill: text => $.prompt.fill({ text, mode: 'replace' }),
      toast: text => { void $.ui.toast(text) },
      readFocus: () => read($, graphFocus),
      setFocus: id => update($, graphFocus, () => id),
    }

    if (agent !== undefined && agent.type === MANAGER && mode === 'graph') return managerGraphView(ctx, agent, planOwner(plans, agent.name))
    if (agent !== undefined) return agentView(ctx, agent)

    if (mode === 'pr' || mode === 'batch') {
      const [shownPr, back, pickPr, note, draft, cache, sstate] = await Promise.all([read($, prShown), read($, prBack), read($, batchPick), read($, inboxNote), read($, inboxDraft), read($, prDetails), read($, pushState)])
      const leave = async () => {
        await update($, inboxNote, () => '')
        await update($, inboxDraft, () => '')
        await update($, batchPick, () => null)
        await update($, viewMode, () => mode === 'pr' ? back : 'tree')
      }
      const openPr = async (n: number, from: 'tree' | 'batch') => {
        fetchPrDetails($, n)
        await update($, prShown, () => n)
        await update($, prBack, () => from)
        await update($, inboxNote, () => '')
        await update($, inboxDraft, () => '')
        await update($, viewMode, () => 'pr')
      }
      const common = { acted, serial: paneSerial, toast: (text: string) => { void $.ui.toast(text) }, setNote: (v: string) => update($, inboxNote, () => v) }
      if (mode === 'batch') {
        return batchCardView({
          els: { Box, Text, Button }, rows, batch: sstate.batch, hs, note, pick: pickPr, now: t,
          io: { ...common, act: a => pushAct($, a, 'user'), openPr: n => openPr(n, 'batch'), setPick: n => update($, batchPick, () => n), leave },
        })
      }
      const ho = shownPr === null ? undefined : hs[String(shownPr)]
      const key = ho === undefined ? undefined : detailsKey(ho)
      const Input = ($.ui.resolve(e) as unknown as { Input?: InboxCtx['Input'] }).Input
      return prCardView({
        els: { Box, Text, Button }, Input, rows, pr: shownPr, ho, entry: key === undefined ? undefined : cache[key], mergeMode: settings.mergeMode, now: t, draft, note,
        io: {
          ...common, leave,
          approve: n => approvePr(commandIoOf($), n),
          reject: (n, why) => rejectPr(commandIoOf($), n, why),
          readDraft: () => read($, inboxDraft),
          setDraft: v => update($, inboxDraft, () => v),
          openUrl: async n => {
            const url = (await read($, prDetails))[detailsKey((await read($, handovers))[String(n)] ?? { pr: n, head: '' })]?.details?.url
            if (url === undefined) return 'No URL yet: the details have not loaded.'
            const opener = openerFor(await platformOf($))
            if (opener === undefined) return urlNote(url)
            const r = await $.process.run([opener, url], { timeoutMs: 5_000 }).catch(() => undefined)
            return r !== undefined && r.exitCode === 0 ? `Opened ${url}` : urlNote(url)
          },
        },
      })
    }
    if (mode === 'inbox' || mode === 'card' || mode === 'archive') {
      // Only some surfaces have an Input; without one the keys still answer.
      const Input = ($.ui.resolve(e) as unknown as { Input?: InboxCtx['Input'] }).Input
      const [ibox, icur, draft, note, from] = await Promise.all([read($, inbox), read($, inboxCursor), read($, inboxDraft), read($, inboxNote), read($, cardBack)])
      // The same rows a press reads, so what is drawn and what is pressed fold alike.
      const irows = (await paneInboxRows($)).rows
      const ictx: InboxCtx = {
        els: { Box, Text, Button }, Input, rows, columns, ibox, icur, draft, note, irows, list, now: t, from,
        io: {
          acted,
          rows: async () => (await paneInboxRows($)).rows,
          readInbox: () => read($, inbox),
          readCursor: () => read($, inboxCursor),
          setCursor: key => update($, inboxCursor, () => key),
          readDraft: () => read($, inboxDraft),
          setDraft: v => update($, inboxDraft, () => v),
          setNote: v => update($, inboxNote, () => v),
          answer: (id, choice) => answerQuestion($, id, choice, 'main', {}, true),
          serial: paneSerial,
          toast: text => { void $.ui.toast(text) },
          focus: key => $.ui.focus({ requestId: PANE, key }).catch(() => undefined),
          back: async () => {
            await acted()
            await update($, viewMode, () => 'tree')
          },
          open: async (id, origin) => {
            await update($, inboxCursor, () => id)
            await update($, cardBack, () => origin)
            await update($, inboxNote, () => '')
            await update($, viewMode, () => 'card')
          },
          leave: async to => {
            await update($, inboxNote, () => '')
            await update($, viewMode, () => to === 'tree' ? 'tree' : to)
          },
          toggleFold: async (key, firstKey) => {
            // Read fresh, so rapid presses each flip once.
            const was = groupExpanded(await read($, inboxFolds), key)
            await update($, inboxFolds, f => ({ ...f, [key]: !was }))
            // A folded-away highlight would move on the next press; park it on the card's row, and on opening go to its first item.
            await update($, inboxCursor, () => was ? key : firstKey)
          },
        },
      }
      if (mode === 'card') return cardView({ ...ictx, id: icur })
      if (mode === 'archive') return archiveView(ictx)
      return inboxView(ictx)
    }
    if (mode === 'graph') return graphModeView(ctx)
    const mainTime = usage?.startedAt === undefined ? '' : elapsed(t - usage.startedAt)
    const mainU = main?.tokens === undefined ? undefined
      : { percent: main.percent ?? Math.round(main.tokens / main.window * 100), tokens: main.tokens, window: main.window }

    return treeView({
      ...ctx, hs, fold, cur, unhanded, leftover, limits, openQs, openItems, fyiCount, anyOpen, checksLine, gate, breakerNote, inboxRows, deployLines, mainU, mainModel: shortModel(mainModel), mainTime,
      mergeQueueKey: MERGE_QUEUE_KEY, warnOf, meter, toggleFold, toggleQueue,
      readCursor: () => read($, cursor),
      setCursor: id => update($, cursor, () => id),
      focusRow: id => $.ui.focus({ requestId: PANE, key: id }).catch(() => undefined),
      openInbox: async () => {
        await acted()
        await update($, inboxCursor, () => null)
        await update($, viewMode, () => 'inbox')
      },
      openCard: async id => {
        await acted()
        await update($, inboxCursor, () => id)
        await update($, cardBack, () => 'tree')
        await update($, viewMode, () => 'card')
      },
      openPr: async n => {
        fetchPrDetails($, n)
        await acted()
        await update($, prShown, () => n)
        await update($, prBack, () => 'tree')
        await update($, inboxNote, () => '')
        await update($, inboxDraft, () => '')
        await update($, viewMode, () => 'pr')
      },
      openBatch: async () => {
        await acted()
        await update($, batchPick, () => null)
        await update($, inboxNote, () => '')
        await update($, viewMode, () => 'batch')
      },
    })
    })()
    } catch (err) {
      const { Text } = $.ui.resolve(e)
      return <Text>flow: pane failed to draw: {err instanceof Error ? err.message : String(err)}</Text>
    }
  })
}
