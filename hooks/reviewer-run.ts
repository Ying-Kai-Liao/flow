import type { AgentRow, Breaker, Check, Deploys, Handover, Inbox, LogEvent, Session } from '../types'
import { evidenceText } from './evidence'
import { deleteMergedBranch } from './branchdelete'
import { noteWork, serialFastForward } from './mainff'
import type { RunWork } from './mainff'
import { parseMode, takeDecision } from './mergemode'
import { reviewerNote } from './pushgate'
import type { PushState } from './pushgate'
import { envSummary, itemViewOf } from './deploy'
import { SKIP_NOTE } from './checks'
import { withFailed, withFlaky } from './testfail'
import { abandonRun, CAP_ERROR, clearHalt, decide, endRun, isRetry, normalizeBreaker, openHaltItem, REACH_MS, reachRun, REVIEWER_KIND, startRun, unreachableNotice } from './reviewer-breaker'
import type { RunEnd } from './reviewer-breaker'
import { isReviewer, mirror, REVIEWER } from './core'
import { LIVE } from './deliver'
import type { Ran } from './session-run'
import type { settingsOf } from './settings'

type Settings = ReturnType<typeof settingsOf>

// The reviewer's tools (mcp__flow__reviewer, and its old name mcp__flow__queue): the worklist of handed-over
// PRs and the reviewer's take/done/back/ready reports. The engine refuses `$` across an import, so
// register.tsx builds a ReviewerIo of closures over the calls this needs.
export type ReviewerIo = {
  // Marks handovers merged elsewhere done and frees ones a dead reviewer took.
  reconcile: () => Promise<void>
  run: (argv: string[]) => Promise<Ran>
  handovers: () => Promise<Record<string, Handover>>
  putHandover: (pr: string, h: Handover) => Promise<void>
  batch: () => Promise<PushState['batch']>
  deploys: () => Promise<Deploys>
  inbox: () => Promise<Inbox>
  // The flaky tests this reviewer run saw.
  flaky: (agentId: string) => Promise<string[] | undefined>
  noteRunWork: (agentId: string, f: (w: RunWork | undefined) => RunWork) => Promise<unknown>
  recordReady: (settings: Settings, input: Record<string, unknown>) => Promise<string>
  best: (what: string, fn: () => Promise<void>) => Promise<void>
  saveHandover: (h: Handover) => Promise<void>
  appendLog: (event: Omit<LogEvent, 'ts'>) => Promise<void>
  toast: (text: string) => void
  refresh: () => Promise<AgentRow[]>
  closeReturnedEnv: (h: Handover) => Promise<void>
  settleBatch: () => Promise<void>
  autoSweep: () => void
  withCost: (branch: string, report: string) => Promise<string>
  captureChecks: (h: Handover, verifyPaths: string[], live: boolean) => Promise<Check[]>
  suggestGuardTests: (input: Record<string, unknown>, pr: number, queueName: string, agentId: string | undefined, map: Settings['guardTests']) => Promise<string>
  sizeBackNote: (branch: string) => Promise<string | undefined>
}

export async function reviewerToolRun(io: ReviewerIo, settings: Settings, input: Record<string, unknown>, agentId: string | undefined): Promise<{ result: string }> {
  const action = String(input.action)
  if (action === 'list') await io.reconcile()
  const all = await io.handovers()
  // While a batch exists the reviewer sees it, not the pending handovers: they go in after the push run.
  const batch = await io.batch()
  if (action === 'list') {
    if (batch !== undefined) return { result: reviewerNote(batch) }
    const open = Object.values(all).filter(h => h.status === 'pending' || h.status === 'taken').sort((a, b) => a.at - b.at)
    if (open.length === 0) return { result: 'No pending handovers.' }
    const d = await io.deploys()
    const ib = await io.inbox()
    const envText = (h: Handover, dd: Deploys, inb: Inbox) => (h.env === undefined || h.env.length === 0 ? '' : ` | env: ${envSummary(h, t => dd.targets[t], itemViewOf(inb))}`)
    return {
      result: open.map(h =>
        `#${h.pr} ${h.status}: "${h.title}" branch ${h.branch} head ${h.head} | report_to: ${h.reportTo} | verified: ${h.verified} | evidence: ${evidenceText(h.evidence)} | pending decisions: ${h.pending} | after deploy: ${h.afterDeploy}${h.release === undefined ? '' : ` | release: ${h.release}`}${envText(h, d, ib)}`,
      ).join('\n'),
    }
  }
  if (agentId !== undefined) await io.noteRunWork(agentId, w => noteWork(w, action))
  if (action === 'ready') return { result: await io.recordReady(settings, input) }
  const key = String(Number(input.pr))
  const h = all[key]
  if (h === undefined) return { result: `No handover for PR #${key}.` }
  if (action === 'take' && batch !== undefined && (h.status === 'pending' || batch.state === 'ready')) {
    return { result: `Held: batch ${batch.id} ${batch.state === 'ready' ? 'awaits the user\'s /flow push' : 'is being pushed or rebuilt'}; PR #${key} waits behind it. Do not take it and do not send it back; end your run when your own work is done.` }
  }
  if (action === 'take') {
    // Re-check the labels: flow:confirm may have been added after the handover. If gh fails,
    // the stored mode and the setting still decide; never fail open.
    const view = await io.run(['gh', 'pr', 'view', key, '--json', 'labels,headRefOid'])
    let labels: string[] = []
    if (view.exitCode === 0) {
      try { labels = ((JSON.parse(view.stdout) as { labels?: { name: string }[] }).labels ?? []).map(l => l.name) } catch { labels = [] }
    }
    if (takeDecision({ labels, stored: h.mode, setting: parseMode(settings.mergeMode), head: h.head, approvedHead: h.approvedHead }) === 'hold') {
      const held: Handover = { ...h, status: 'awaiting' }
      await io.putHandover(key, held)
      await io.best('saving a handover', async () => {
        await io.saveHandover(held)
        await io.appendLog({ event: 'hold', owner: held.reportTo, pr: held.pr, branch: held.branch, text: 'awaits /flow approve' })
      })
      io.toast(`PR #${key} awaits your approval: /flow approve ${key}`)
      await io.refresh()
      return { result: `Held: PR #${key} awaits the user's approval (/flow approve ${key}). Do not merge it and do not send it back; go on to the next PR.` }
    }
  }
  const next: Handover = action === 'take' ? { ...h, status: 'taken' }
    : action === 'done' ? { ...h, status: 'done', sha: String(input.sha ?? ''), report: await io.withCost(h.branch, withFlaky(String(input.report ?? ''), agentId === undefined ? undefined : await io.flaky(agentId))) }
    : action === 'back' ? { ...h, status: 'returned', reason: withFailed(String(input.reason ?? ''), input.failed_tests) }
    : h
  if (next === h) return { result: `Unknown action "${action}".` }
  await io.putHandover(key, next)
  await io.best('saving a handover', async () => {
    await io.saveHandover(next)
    const text = action === 'done' ? next.report : action === 'back' ? next.reason : undefined
    await io.appendLog({ event: action as 'take' | 'done' | 'back', owner: next.reportTo, pr: next.pr, branch: next.branch, text })
  })
  if (action === 'back') await io.closeReturnedEnv(next)
  if (action === 'done' || action === 'back') await io.settleBatch()
  if (action !== 'take') io.toast(`PR #${key} ${next.status === 'done' ? `merged ${next.sha ?? ''}` : `returned: ${next.reason ?? ''}`}`)
  let verify = ''
  if (action === 'done') {
    // The push already happened; the isolated reviewer cannot touch the main checkout, so the plugin does.
    const line = await serialFastForward(io.run, settings.base)
    // Only now: the sweep's `git fetch --prune` racing our fetch for origin/<base> failed the fast-forward.
    io.autoSweep()
    if (agentId !== undefined) await io.noteRunWork(agentId, w => ({ ...(w ?? { touched: true, ready: false }), touched: true, line }))
    await io.best('logging the main checkout', () => io.appendLog({ event: 'main-ff', owner: next.reportTo, pr: next.pr, branch: next.branch, text: line }))
    verify = ` ${line}: copy this exact line into your final report; never run git against the main checkout yourself.`
    // Deleting the branch is the plugin's job, after it confirms the merge reached origin/<base>.
    const gone = await deleteMergedBranch(io.run, next.branch, settings.base)
    await io.best('logging the branch delete', () => io.appendLog({ event: 'branch-delete', owner: next.reportTo, pr: next.pr, branch: next.branch, text: gone }))
    verify += ` ${gone}.`
    await io.best('capturing checks', async () => {
      const added = await io.captureChecks(next, settings.verifyPaths, true)
      const scripted = added.filter(c => c.verifyCommand !== undefined)
      verify += scripted.map(c => ` Run \`${c.verifyCommand}\` in your worktree at the merged main now; on exit 0 call mcp__flow__check action pass id ${c.id} with a one-line note of the output tail; on failure call action fail with the failure tail as the note.`).join('')
      const skipped = added.filter(c => c.note !== undefined && c.verifyCommand === undefined)
      if (skipped.length) verify += ` Scripted verification is skipped for ${skipped.map(c => c.id).join(', ')} (${SKIP_NOTE.replace('scripted verification skipped: ', '')}); the check stays open for a person.`
    })
  }
  const rows = await io.refresh()
  const filed = action === 'back' ? await io.suggestGuardTests(input, next.pr, rows.find(a => a.id === agentId)?.name ?? 'reviewer', agentId, settings.guardTests) : ''
  const size = action === 'back' ? await io.sizeBackNote(next.branch) : undefined
  const sizeLine = size === undefined ? '' : `\nPut this line in your message to ${next.reportTo}: ${size}`
  return { result: `PR #${key}: ${next.status}.${verify}${filed}${sizeLine}` }
}

// What startQueue works through: the roster, the push batch, the handovers, the deploy targets and the
// reviewer-run counter, plus the one spawn.
export type QueueIo = {
  agents: () => Promise<{ id?: string; name?: string; type: string; status: string }[]>
  batch: () => Promise<PushState['batch']>
  handovers: () => Promise<Record<string, Handover>>
  deploys: () => Promise<Deploys>
  runs: () => Promise<number>
  setRuns: (n: number) => Promise<unknown>
  // `pending` is for a reviewer in a terminal: the handovers its first prompt already names count as told.
  // `terminal`: the reviewer started in a terminal session, not as an agent.
  spawn: (input: { subagentType: string; name: string; description: string; prompt: string; pending?: string[] }) => Promise<{ deny?: string; terminal?: boolean }>
  // The live reviewer running in a terminal, if any, and the way to type a line into it (a failure is the
  // refusal text). Absent when the plugin has no terminal sessions to offer.
  reviewerSession?: () => Promise<Session | undefined>
  nudge?: (s: Session, text: string, told: string[]) => Promise<string | undefined>
  // Replaces what a reviewer terminal counts as told (see toldKey).
  setTold?: (s: Session, told: string[]) => Promise<unknown>
  // Stops a reviewer terminal and removes its worktree (one whose flow tools never reached the plugin).
  stopReviewer?: (s: Session) => Promise<unknown>
  // Calls ensureQueue after ms, to look again at a reviewer terminal that has not reached the plugin yet.
  reach?: (ms: number) => void
  // Sends a message to a reviewer agent; a failure is the refusal text. Absent: agents are never messaged.
  tell?: (agentId: string, text: string) => Promise<string | undefined>
  breaker: BreakerIo
  // Calls ensureQueue again after ms (one timer at a time; the caller dedupes).
  wait: (ms: number) => void
  // reviewer_delay: how long a fresh handover on an idle queue waits so close handovers share a batch (0 = no wait),
  // whether that wait is running, and the one timer that ends it with a normal ensureQueue. Separate from `wait`, so
  // the breaker's backoff and the delay never swallow each other. Absent: no delay.
  // `until` and `setUntil` keep the wait's deadline (0: none) where a hook reload does not lose it, as it does the timer.
  delay?: { ms: () => number; running: () => boolean; start: (ms: number) => void; until?: () => Promise<number>; setUntil?: (t: number) => Promise<unknown> }
  // Where an agent reviewer spawned through this io would start: 'tool' inside the plugin's tool.call hook that starts
  // reviewers, 'other' anywhere else. Recorded on the run (Breaker.run.frame). Absent: a terminal reviewer.
  frame?: 'tool' | 'other'
  // Records that a reviewer should start, for the next tool call to carry out (a host leaves the tool calls of an agent
  // spawned from a timer unanswered). Present outside that hook in agent mode: startQueue then spawns nothing itself.
  want?: () => void
}

// Why startQueue runs: a fresh handover may wait for reviewer_delay; an approval joins a wait already running and
// otherwise starts at once; anything else (a reviewer that ended with work left, resume, a session start, the timer
// itself) starts as always.
export type QueueWhy = 'handover' | 'approval' | 'other'

// What the respawn circuit breaker (reviewer-breaker.ts) works through: its state file, the clock and the inbox.
export type BreakerIo = {
  stateDir: () => Promise<string | undefined>
  readJson: (path: string) => Promise<unknown>
  writeJson: (path: string, obj: unknown) => Promise<unknown>
  mkdir: (dir: string) => Promise<unknown>
  get: () => Promise<Breaker>
  set: (b: Breaker) => Promise<void>
  now: () => Promise<number>
  withInbox: <T>(fn: (cur: Inbox) => { inbox: Inbox; out: T }) => Promise<T>
  toast: (text: string) => void
  // A message to main (the unreachable-tools notice). Absent: the toast alone.
  tell?: (text: string) => void
}

// Breaker changes run one after another, like the push state's.
let breakerChain: Promise<unknown> = Promise.resolve()
export function withBreaker<T>(io: BreakerIo, fn: (cur: Breaker) => { breaker: Breaker; out: T }): Promise<T> {
  const run = async (): Promise<T> => {
    const dir = await io.stateDir()
    const cur = dir === undefined ? await io.get() : normalizeBreaker(await io.readJson(`${dir}/reviewer-breaker.json`))
    const { breaker: next, out } = fn(cur)
    if (next !== cur) {
      if (dir !== undefined) {
        await io.mkdir(dir)
        await io.writeJson(`${dir}/reviewer-breaker.json`, next)
      }
      await io.set(next)
    }
    return out
  }
  const result = breakerChain.then(run, run)
  breakerChain = result.catch(() => undefined)
  return result
}

// A reviewer ended. When it was the run the plugin started and it counts as a failure, the breaker records it; the
// third short run in a row halts the queue and puts one item in front of main.
export async function noteReviewerEnd(io: BreakerIo, e: Omit<RunEnd, 'now'>): Promise<void> {
  const now = await io.now()
  const { halted, notice } = await withBreaker(io, cur => {
    const r = endRun(cur, { ...e, now })
    // Once per unreachable streak: the first such end tells main, the retries after it do not.
    const tell = r.unreachable === true && cur.unreachableTold !== true
    const breaker = tell ? { ...r.breaker, unreachableTold: true } : r.breaker
    return { breaker, out: { halted: r.halted ? r.breaker.halt : undefined, notice: tell ? r.breaker.error : undefined } }
  })
  if (notice !== undefined && halted === undefined) {
    const text = unreachableNotice(e.name, notice)
    io.toast(`Reviewer ${e.name}: ${notice.split(' (')[0]}; starting a fresh one.`)
    io.tell?.(text)
  }
  if (halted === undefined) return
  await announceHalt(io, halted.error, now)
}

// A flow tool call from the reviewer run `name` reached the plugin (an agent's call, or a terminal's relayed one).
export async function noteReached(io: BreakerIo, name: string): Promise<void> {
  await withBreaker(io, cur => ({ breaker: reachRun(cur, name), out: undefined }))
}

// One inbox item for a halt, whatever caused it; an item still open is reused, and the breaker remembers its id.
async function announceHalt(io: BreakerIo, error: string, now: number): Promise<void> {
  const q = await io.withInbox(cur => {
    const open = cur.items.find(x => x.state === 'open' && x.kind === REVIEWER_KIND)
    if (open !== undefined) return { inbox: cur, out: open }
    const r = openHaltItem(cur, error, now)
    return { inbox: r.inbox, out: r.q }
  })
  await withBreaker(io, cur => (cur.halt === undefined || cur.halt.qid === q.id ? { breaker: cur, out: undefined } : { breaker: { ...cur, halt: { ...cur.halt, qid: q.id } }, out: undefined }))
  io.toast(`Reviewer halted: ${error}. ${q.id} in /flow inbox.`)
}

// Retry, /flow resume and a new session: the halt and the wait end, and its open item with them. Returns whether
// the queue was halted.
export async function releaseHalt(io: BreakerIo, by: string): Promise<boolean> {
  const was = await withBreaker(io, cur => ({ breaker: cur.halt === undefined && cur.endedAt === undefined ? cur : clearHalt(cur), out: cur.halt !== undefined }))
  const at = await io.now()
  await io.withInbox(cur => {
    const open = cur.items.filter(x => x.state === 'open' && x.kind === REVIEWER_KIND)
    if (open.length === 0) return { inbox: cur, out: undefined }
    const ids = new Set(open.map(x => x.id))
    return { inbox: { ...cur, items: cur.items.map(x => (ids.has(x.id) ? { ...x, state: 'answered' as const, answer: 'cleared', answeredBy: by, answeredAt: at, delivered: true } : x)) }, out: undefined }
  })
  return was
}

// The answer to the halt item: "retry" starts a reviewer if work is pending; anything else leaves the queue halted.
export async function onReviewerAnswer(io: BreakerIo, ensureQueue: () => Promise<string>, answer: string, by: string): Promise<string> {
  if (!isRetry(answer)) {
    // Still halted: a fresh item keeps the retry in front of main (like the push item's "not yet").
    const b = await currentBreaker(io)
    if (b.halt === undefined) return ''
    await announceHalt(io, b.halt.error, await io.now())
    return ' The queue stays halted; the item is asked again, and /flow resume or a new session also retries.'
  }
  await releaseHalt(io, by)
  return ` ${await ensureQueue()}`
}

// startQueue's line for a start it left to the reviewer-start tool.call hook; that hook puts what came of it in its place.
export const WANTED_LINE = 'A reviewer is starting.'

// Starts a reviewer unless one is live (register.tsx's ensureQueue serialises the calls).
// `reported`: the reviewer terminal of that name just wrote a report and waits; the handovers still pending are told
// to it again, since a PR typed in while it worked may have been missed.
export async function startQueue(io: QueueIo, why: QueueWhy = 'other', reported?: string): Promise<string> {
  const list = await io.agents()
  const live = list.filter(a => isReviewer(a.type) && LIVE.has(a.status))
  if (live.length > 0) {
    // A reviewer agent held on background work (`waiting`) does not come back to list on its own: it is told.
    // One still running a turn lists at its next step. One that cannot be messaged is replaced below.
    const held = io.tell === undefined || live.some(a => a.status !== 'waiting') ? undefined : live.find(a => a.id !== undefined)
    if (held === undefined) return 'The running reviewer picks it up at its next list.'
    const told = await tellAgent(io, held as { id: string; name?: string })
    if (told !== undefined) return told
    // Refused. A reviewer holding taken PRs may be merging: a second one would merge and push the base beside it, so
    // the PRs wait for its end, which starts the next reviewer. Main hears of it once per reviewer.
    if (Object.values(await io.handovers()).some(h => h.status === 'taken')) return heldBack(io, held as { id: string; name?: string })
  }
  // A batch (any state) holds the queue: pending handovers go in after the push run.
  const batch = await io.batch()
  const all = batch !== undefined ? [] : Object.values(await io.handovers())
  const pending = all.filter(h => h.status === 'pending')
  const pushDue = batch !== undefined && batch.state !== 'ready'
  const dueEntries = Object.entries((await io.deploys()).targets).filter(([name, t]) => t.due === true && mirror.deployInfos.some(i => i.name === name))
  const dueTargets = dueEntries.map(([name]) => name)
  // What makes a target due again is a new approval or a new deploy, so those are in the signature.
  const dueSig = dueEntries.map(([name, t]) => `${name}:${t.deployedAt ?? 0}:${t.approval?.at ?? 0}`).join(',')
  let session = io.reviewerSession === undefined ? undefined : await io.reviewerSession()
  let again: string[] = []
  if (session !== undefined && await unreached(io, session, reported)) session = undefined
  if (session !== undefined) {
    // Forget what is no longer true before any early return: a PR that went back to pending (approved, handed
    // over again) has another key and is typed again; a target or push run that was cleared can be due anew.
    if (dueTargets.length === 0) sigNudged.delete(`${session.name}|deploy`)
    if (!pushDue) sigNudged.delete(`${session.name}|push`)
    const keys = new Set(pending.map(toldKey))
    // After a report, each pending handover is told again once per session: a reviewer that cannot start a batch
    // (a dirty worktree, gh signed out) reports again, and must not be re-told the same PR every time.
    if (reported === session.name) {
      const done = retold.get(session.name) ?? []
      again = [...keys].filter(k => !done.includes(k))
      retold.set(session.name, [...done, ...again])
    }
    const kept = (session.nudged ?? []).filter(k => keys.has(k) && !again.includes(k))
    if (kept.length !== (session.nudged ?? []).length && io.setTold !== undefined) {
      await io.setTold(session, kept)
      session.nudged = kept
    }
  }
  if (pending.length === 0 && dueTargets.length === 0 && !pushDue) {
    return batch === undefined ? 'Nothing pending.' : `Batch ${batch.id} awaits the user's /flow push; new handovers wait behind it.`
  }
  const otherWork = dueTargets.length > 0 || pushDue
  if (session !== undefined && io.nudge !== undefined) {
    const held = await delayStart(io, why, all, otherWork, session)
    if (held !== undefined) return held
    return nudgeReviewer(io, session, pending, dueTargets, dueSig, pushDue ? batch : undefined, again)
  }
  // The respawn circuit breaker: a halted queue waits for main, and a start soon after a failed one waits its turn.
  const now = await io.breaker.now()
  const d = decide(await currentBreaker(io.breaker), now)
  if (d.kind === 'halt') return 'The reviewer is halted after repeated failed starts; handovers wait for the retry (see the inbox or /flow resume).'
  if (d.kind === 'cap') {
    await withBreaker(io.breaker, cur => (cur.halt !== undefined ? { breaker: cur, out: undefined } : { breaker: { ...cur, halt: { at: now, error: CAP_ERROR } }, out: undefined }))
    await announceHalt(io.breaker, CAP_ERROR, now)
    return `The reviewer is halted: ${CAP_ERROR}; handovers wait for the retry.`
  }
  if (d.kind === 'wait') {
    io.wait(d.ms)
    return `Backing off: the next reviewer starts in ${Math.ceil(d.ms / 1000)}s.`
  }
  // After the breaker's halt and backoff: a halted queue arms no delay, and a backoff already spaces the start.
  const held = await delayStart(io, why, all, otherWork, undefined)
  if (held !== undefined) return held
  // Only the tool.call hook spawns an agent: here the start is recorded, and that hook runs this whole decision again,
  // since a reviewer may be live or the queue empty by then.
  if (io.want !== undefined) {
    io.want()
    return WANTED_LINE
  }
  // A wait whose timer a reload lost is over now that a reviewer starts.
  if (io.delay?.until !== undefined && await io.delay.until() > 0) await io.delay.setUntil?.(0)
  const n = (await io.runs()) + 1
  await io.setRuns(n)
  // Recorded before the spawn: a reviewer that dies at once ends before spawn() resolves, and that end must find its run.
  await withBreaker(io.breaker, cur => ({ breaker: startRun(cur, `reviewer-${n}`, now, true, io.frame), out: undefined }))
  const started = await io.spawn({
    subagentType: REVIEWER,
    name: `reviewer-${n}`,
    description: 'reviewer',
    pending: pending.map(toldKey),
    prompt: `Pending handovers: ${batch !== undefined ? 'wait behind the batch' : pending.length === 0 ? 'none' : pending.map(h => `#${h.pr}`).join(', ')}.${dueTargets.length === 0 ? '' : ` Deploy-only work due: ${dueTargets.join(', ')}.`}${batch === undefined ? '' : batch.state === 'ready' ? ` Batch ${batch.id} awaits the user's push: leave it alone.` : ` ${batch.state === 'pushing' ? 'Push run' : 'Rebuild run'} for batch ${batch.id}: see "Push run" in your instructions.`} Start with mcp__flow__deploy action "list" and mcp__flow__reviewer action "list".`,
  })
  if (started.deny !== undefined) {
    await withBreaker(io.breaker, cur => ({ breaker: abandonRun(cur, `reviewer-${n}`, now), out: undefined }))
    return `Could not start a reviewer: ${started.deny}`
  }
  // The handovers its first prompt names are told: a reviewer agent held on its check is not messaged about them.
  agentTold.set(`reviewer-${n}`, pending.map(toldKey))
  // A terminal reviewer is looked at again once it should have called a flow tool, counted from when its terminal
  // started; an agent's end says it itself.
  if (started.terminal === true) {
    const at = await io.breaker.now()
    await withBreaker(io.breaker, cur => ({ breaker: cur.run?.name === `reviewer-${n}` ? { ...cur, run: { ...cur.run, reachFrom: at } } : cur, out: undefined }))
    io.reach?.(REACH_MS)
  }
  return `Started reviewer reviewer-${n}.`
}

// What a waiting reviewer agent was told, by agent name: the handover instances (toldKey), so each is sent once. Its
// spawn prompt's handovers are in it from the start.
const agentTold = new Map<string, string[]>()

// The handovers told again to a reviewer terminal after one of its reports, by session name.
const retold = new Map<string, string[]>()

// Waiting reviewer agents that refused a message while holding taken PRs and that main was told about, by agent id.
const heldBackTold = new Set<string>()

async function heldBack(io: QueueIo, a: { id: string; name?: string }): Promise<string> {
  const name = a.name ?? a.id
  const line = `The waiting reviewer ${name} cannot be messaged and holds taken PRs; pending handovers wait for its end, which starts the next reviewer.`
  if (!heldBackTold.has(a.id)) {
    heldBackTold.add(a.id)
    io.breaker.toast(`flow: ${line}`)
    io.breaker.tell?.(`flow: ${line} No second reviewer starts beside it, since only one may merge.`)
  }
  return line
}

// Tells a reviewer agent held on background work about the pending handovers it was not told yet. undefined: the
// message was refused, and a fresh reviewer starts instead.
async function tellAgent(io: QueueIo, a: { id: string; name?: string }): Promise<string | undefined> {
  const name = a.name ?? a.id
  const batch = await io.batch()
  const pending = batch !== undefined ? [] : Object.values(await io.handovers()).filter(h => h.status === 'pending')
  const keys = new Set(pending.map(toldKey))
  const told = (agentTold.get(name) ?? []).filter(k => keys.has(k))
  const fresh = pending.filter(h => !told.includes(toldKey(h)))
  if (pending.length === 0) return 'The running reviewer picks it up at its next list.'
  if (fresh.length === 0) return `The waiting reviewer ${name} has already been told.`
  const failed = await io.tell!(a.id, `Pending handovers: ${fresh.map(h => `#${h.pr}`).join(', ')}. Call mcp__flow__reviewer action "list" and work through them.`)
  if (failed !== undefined) return undefined
  agentTold.set(name, [...told, ...fresh.map(toldKey)])
  return `The waiting reviewer ${name} was told: ${fresh.map(h => `#${h.pr}`).join(', ')}.`
}

// A reviewer terminal of the run in flight that has not reached the plugin, though it reported or REACH_MS passed
// since its start: its tools are unreachable. It is stopped (its worktree removed) and its run ends as such, so the
// caller starts a fresh one.
async function unreached(io: QueueIo, s: Session, reported: string | undefined): Promise<boolean> {
  if (io.stopReviewer === undefined) return false
  const b = await currentBreaker(io.breaker)
  if (b.run?.name !== s.name || b.run.reached !== false) return false
  const now = await io.breaker.now()
  if (reported !== s.name && now - (b.run.reachFrom ?? b.run.startedAt) < REACH_MS) return false
  await io.stopReviewer(s)
  const answer = reported === s.name ? 'it reported without one flow tool call reaching the plugin' : `no flow tool call reached the plugin in ${REACH_MS / 1000}s`
  await noteReviewerEnd(io.breaker, { name: s.name, answer })
  return true
}

// reviewer_delay: the line to return when this start waits, or undefined to start now. A push or rebuild run and
// due deploys never wait; a terminal reviewer that was told work, or holds a taken or ready PR, is working and is
// told now. The breaker still decides after the wait: the timer runs ensureQueue as any other caller.
// A wait whose timer a hook reload cancelled is re-armed for what is left of it, or, past its deadline, starts now.
async function delayStart(io: QueueIo, why: QueueWhy, all: Handover[], otherWork: boolean, session: Session | undefined): Promise<string | undefined> {
  if (io.delay === undefined || why === 'other') return undefined
  const joins = 'The reviewer starts when the reviewer_delay wait ends; this joins that batch.'
  if (io.delay.running()) return joins
  // A terminal reviewer that was told work, or holds a taken or ready PR, is working: it is told now.
  const busy = session !== undefined && ((session.nudged ?? []).length > 0 || all.some(h => h.status === 'taken' || h.status === 'ready'))
  const until = io.delay.until === undefined ? 0 : await io.delay.until()
  if (until > 0) {
    if (busy) {
      await io.delay.setUntil?.(0)
      return undefined
    }
    const left = until - await io.breaker.now()
    if (left > 0) {
      io.delay.start(left)
      return joins
    }
    await io.delay.setUntil?.(0)
    return undefined
  }
  if (why !== 'handover' || otherWork) return undefined
  const ms = io.delay.ms()
  if (ms <= 0) return undefined
  if (busy) return undefined
  io.delay.start(ms)
  await io.delay.setUntil?.(await io.breaker.now() + ms)
  return `The reviewer starts in ${formatDelay(ms)} so close handovers share a batch.`
}

const formatDelay = (ms: number): string => (ms % 60_000 === 0 ? `${ms / 60_000}m` : `${Math.ceil(ms / 1000)}s`)

// One handover as it stands: a new hand-over or an approval of the same PR is a new instance, typed again.
export const toldKey = (h: Handover): string => `${h.pr}:${h.at}:${h.approvedHead ?? ''}`

// What a waiting reviewer terminal was last told about deploys and the push run (by session name and kind): a
// signature, so the same due work is typed once, and a reviewer that reports "awaiting approval" is not
// told again in a loop. Handovers are tracked in the session's own `nudged` list instead (persisted).
const sigNudged = new Map<string, string>()

// A reviewer already runs in a terminal: it is not started again, the new work is typed into it. Only work it
// was not told about goes in: a handover already in `nudged`, the same due deploys, the same push run.
// `again`: the handovers told again after its report, named as still pending.
async function nudgeReviewer(io: QueueIo, s: Session, pending: Handover[], dueTargets: string[], deploySig: string, push: NonNullable<PushState['batch']> | undefined, again: string[] = []): Promise<string> {
  const told = (s.nudged ?? []).filter(k => pending.some(h => toldKey(h) === k))
  const fresh = pending.filter(h => !told.includes(toldKey(h)))
  const added = fresh.filter(h => !again.includes(toldKey(h)))
  const still = fresh.filter(h => again.includes(toldKey(h)))
  const parts: string[] = []
  if (added.length > 0) parts.push(`new handover: ${added.map(h => `#${h.pr}`).join(', ')}`)
  if (still.length > 0) parts.push(`still pending: ${still.map(h => `#${h.pr}`).join(', ')}`)
  if (dueTargets.length > 0 && sigNudged.get(`${s.name}|deploy`) !== deploySig) parts.push(`deploy due: ${dueTargets.join(', ')}`)
  const pushSig = push === undefined ? '' : `${push.id}:${push.state}`
  if (push !== undefined && sigNudged.get(`${s.name}|push`) !== pushSig) parts.push(`push run due: batch ${push.id}`)
  const where = `The reviewer in ${s.host}`
  if (parts.length === 0) return `${where} has already been told.`
  const failed = await io.nudge!(s, parts.join('; '), [...told, ...fresh.map(toldKey)])
  if (failed !== undefined) return `Could not reach ${s.name} in ${s.host}: ${failed}`
  if (dueTargets.length > 0) sigNudged.set(`${s.name}|deploy`, deploySig)
  if (push !== undefined) sigNudged.set(`${s.name}|push`, pushSig)
  return `${where} picks it up.`
}

// The breaker as the disk has it (the atom when there is no state dir).
async function currentBreaker(io: BreakerIo): Promise<Breaker> {
  const dir = await io.stateDir()
  return dir === undefined ? io.get() : normalizeBreaker(await io.readJson(`${dir}/reviewer-breaker.json`))
}
