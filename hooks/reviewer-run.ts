import type { AgentRow, Check, Deploys, Handover, Inbox, LogEvent } from '../types'
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
import { isReviewer, mirror, REVIEWER } from './core'
import { LIVE } from './deliver'
import type { Ran } from './session-run'
import type { settingsOf } from './settings'

type Settings = ReturnType<typeof settingsOf>

// The reviewer's tools (mcp__flow__reviewer, and its old name mcp__flow__queue): the worklist of handed-over
// PRs and the reviewer's take/done/back/ready reports. The engine refuses `$` across an import, so
// register.tsx builds a ReviewerIo of closures over the calls this needs.
export type ReviewerIo = {
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
  if (action === 'done') io.autoSweep()
  let verify = ''
  if (action === 'done') {
    // The push already happened; the isolated reviewer cannot touch the main checkout, so the plugin does.
    const line = await serialFastForward(io.run, settings.base)
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
  agents: () => Promise<{ type: string; status: string }[]>
  batch: () => Promise<PushState['batch']>
  handovers: () => Promise<Record<string, Handover>>
  deploys: () => Promise<Deploys>
  runs: () => Promise<number>
  setRuns: (n: number) => Promise<unknown>
  spawn: (input: { subagentType: string; name: string; description: string; prompt: string }) => Promise<{ deny?: string }>
}

// Starts a reviewer unless one is live (register.tsx's ensureQueue serialises the calls).
export async function startQueue(io: QueueIo): Promise<string> {
  const list = await io.agents()
  if (list.some(a => isReviewer(a.type) && LIVE.has(a.status))) {
    return 'The running reviewer picks it up at its next list.'
  }
  // A batch (any state) holds the queue: pending handovers go in after the push run.
  const batch = await io.batch()
  const pending = batch !== undefined ? [] : Object.values(await io.handovers()).filter(h => h.status === 'pending')
  const pushDue = batch !== undefined && batch.state !== 'ready'
  const dueTargets = Object.entries((await io.deploys()).targets).filter(([name, t]) => t.due === true && mirror.deployInfos.some(i => i.name === name)).map(([name]) => name)
  if (pending.length === 0 && dueTargets.length === 0 && !pushDue) {
    return batch === undefined ? 'Nothing pending.' : `Batch ${batch.id} awaits the user's /flow push; new handovers wait behind it.`
  }
  const n = (await io.runs()) + 1
  await io.setRuns(n)
  const started = await io.spawn({
    subagentType: REVIEWER,
    name: `reviewer-${n}`,
    description: 'reviewer',
    prompt: `Pending handovers: ${batch !== undefined ? 'wait behind the batch' : pending.length === 0 ? 'none' : pending.map(h => `#${h.pr}`).join(', ')}.${dueTargets.length === 0 ? '' : ` Deploy-only work due: ${dueTargets.join(', ')}.`}${batch === undefined ? '' : batch.state === 'ready' ? ` Batch ${batch.id} awaits the user's push: leave it alone.` : ` ${batch.state === 'pushing' ? 'Push run' : 'Rebuild run'} for batch ${batch.id}: see "Push run" in your instructions.`} Start with mcp__flow__deploy action "list" and mcp__flow__reviewer action "list".`,
  })
  if (started.deny !== undefined) return `Could not start a reviewer: ${started.deny}`
  return `Started reviewer reviewer-${n}.`
}
