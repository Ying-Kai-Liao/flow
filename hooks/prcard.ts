// The PR card of the Flow pane: what a handed-over PR is, and the two actions a person takes on one
// that awaits approval. The approve and reject functions are the ones /flow approve and /flow reject
// run (command.ts), so the pane and the command cannot drift. Pure rules plus a gh parser; the
// atoms and the process calls are in register.tsx, so the render never waits for gh.

import type { Handover, LogEvent } from '../types'
import { age, clip } from './inbox'
import { CONFIRM_LABEL, effectiveMode, parseMode } from './mergemode'
import type { MergeMode } from './mergemode'

// ---- approve and reject: one code path for the command and the pane ----

export type ApproveIo = {
  handovers: () => Promise<Record<string, Handover>>
  putHandover: (pr: string, h: Handover) => Promise<void>
  best: (what: string, fn: () => Promise<void>) => Promise<void>
  saveHandover: (h: Handover) => Promise<void>
  appendLog: (event: Omit<LogEvent, 'ts'>) => Promise<void>
  toast: (text: string) => void
  ensureQueue: () => Promise<string>
  refresh: () => Promise<unknown>
  closeReturnedEnv: (h: Handover) => Promise<void>
  settleBatch: () => Promise<void>
  tellManager: (name: string, text: string) => Promise<void>
}

export async function approvePr(io: ApproveIo, n: number): Promise<string> {
  const h = (await io.handovers())[String(n)]
  if (h === undefined) return `No handover for PR #${n}.`
  if (h.status !== 'awaiting') return `PR #${n} is ${h.status}, not awaiting approval.`
  const next: Handover = { ...h, status: 'pending', approvedHead: h.head }
  await io.putHandover(String(n), next)
  await io.best('saving a handover', async () => {
    await io.saveHandover(next)
    await io.appendLog({ event: 'approve', owner: next.reportTo, pr: n, branch: next.branch, text: next.title })
  })
  void io.toast(`PR #${n} approved at ${h.head.slice(0, 8)}`)
  const queue = await io.ensureQueue()
  await io.refresh()
  return `Approved PR #${n} at ${h.head.slice(0, 8)}. ${queue}`
}

// Turns a handover down; the GitHub PR and branch are left alone. `why` is the optional reason.
export async function rejectPr(io: ApproveIo, n: number, why: string): Promise<string> {
  const h0 = (await io.handovers())[String(n)]
  if (h0 === undefined) return `No handover for PR #${n}.`
  if (h0.status !== 'awaiting' && h0.status !== 'pending') {
    return `PR #${n} is ${h0.status}, not awaiting approval or pending.${h0.status === 'taken' || h0.status === 'ready' ? ' The reviewer owns it now.' : ''}`
  }
  // Re-read just before writing: the reviewer or the stale sweep may have moved it on.
  const h = (await io.handovers())[String(n)]
  if (h === undefined || (h.status !== 'awaiting' && h.status !== 'pending')) return `PR #${n} is ${h?.status ?? 'gone'}, not awaiting approval or pending.`
  const reason = `declined by the user${why === '' ? '' : `: ${why}`}`
  const next: Handover = { ...h, status: 'returned', reason }
  await io.putHandover(String(n), next)
  await io.best('saving a handover', async () => {
    await io.saveHandover(next)
    await io.appendLog({ event: 'back', owner: next.reportTo, pr: n, branch: next.branch, text: reason })
  })
  await io.closeReturnedEnv(next)
  await io.settleBatch()
  void io.toast(`PR #${n} returned: ${reason}`)
  await io.tellManager(next.reportTo, `flow: PR #${n} was declined by the user${why === '' ? '' : `: ${why}`}. Its GitHub PR and branch are untouched. Decide what to do with it, and hand it over again when it is ready.`)
  return `Rejected PR #${n} (${reason}). Its GitHub PR and branch are untouched.`
}

// ---- the gh details: fetched in the background, cached per PR and head ----

export type PrFile = { path: string; additions: number; deletions: number }
export type PrDetails = { url: string; additions: number; deletions: number; files: PrFile[]; labels: string[]; headRefOid?: string }
// `details` or `error`; neither while the first fetch runs.
export type DetailsEntry = { fetchedAt: number; details?: PrDetails; error?: string; fetching?: true }
export type DetailsCache = Record<string, DetailsEntry>

export const DETAILS_FIELDS = 'url,files,additions,deletions,labels,headRefOid'
// A loaded entry is fresh for this long (the head is part of the key, so a new head refetches at once);
// a failed one is retried sooner.
export const DETAILS_TTL_MS = 5 * 60_000
export const DETAILS_RETRY_MS = 30_000

export const detailsKey = (h: Pick<Handover, 'pr' | 'head'>): string => `${h.pr}@${h.head}`

export function detailsStale(e: DetailsEntry | undefined, now: number): boolean {
  if (e === undefined) return true
  // A fetch that never finished (the plugin reloaded under it) is tried again after a minute.
  if (e.fetching === true) return now - e.fetchedAt >= 60_000
  return now - e.fetchedAt >= (e.error === undefined ? DETAILS_TTL_MS : DETAILS_RETRY_MS)
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

// The parsed details, or the short reason the output is unusable.
export function parseDetails(stdout: string): PrDetails | { error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return { error: 'gh printed no JSON' }
  }
  const r = raw as Record<string, unknown> | null
  if (typeof r !== 'object' || r === null || typeof r.url !== 'string') return { error: 'unexpected gh output' }
  const files = (Array.isArray(r.files) ? r.files : []).filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null && typeof (f as { path?: unknown }).path === 'string')
    .map(f => ({ path: String(f.path), additions: num(f.additions), deletions: num(f.deletions) }))
  const labels = (Array.isArray(r.labels) ? r.labels : []).map(l => (typeof l === 'string' ? l : (l as { name?: unknown } | null)?.name)).filter((l): l is string => typeof l === 'string')
  return {
    url: r.url, additions: num(r.additions), deletions: num(r.deletions), files, labels,
    ...(typeof r.headRefOid === 'string' && r.headRefOid !== '' ? { headRefOid: r.headRefOid } : {}),
  }
}

type Run = (argv: string[], timeoutMs: number) => Promise<{ exitCode: number; stdout: string; stderr: string }>

// Never throws: a missing gh or a failure comes back as the entry's error.
export async function fetchDetails(run: Run, pr: number, now: number): Promise<DetailsEntry> {
  try {
    const r = await run(['gh', 'pr', 'view', String(pr), '--json', DETAILS_FIELDS], 20_000)
    if (r.exitCode !== 0) return { fetchedAt: now, error: clip(r.stderr.trim().split('\n')[0] || 'gh failed', 100) }
    const d = parseDetails(r.stdout)
    return 'error' in d ? { fetchedAt: now, error: d.error } : { fetchedAt: now, details: d }
  } catch (err) {
    return { fetchedAt: now, error: clip(err instanceof Error ? err.message : String(err), 100) }
  }
}

// ---- the card's content ----

// Why this PR waits for the person, in the words the card shows.
export function whyAwaits(h: Handover, setting: MergeMode, labels: string[] = []): string {
  if (h.mode === 'confirm') return 'the manager marked it risky (mode confirm)'
  if (labels.includes(CONFIRM_LABEL)) return `the PR carries the ${CONFIRM_LABEL} label`
  if (effectiveMode(labels, h.mode, setting) === 'confirm') return 'the merge_mode setting is confirm'
  return 'approval was asked for (no flow:* label or mode on record)'
}

export type CardRow = { text: string; tone?: 'warning' | 'success' | 'error'; dim?: boolean; bold?: boolean }

// The platform's opener for a URL; undefined where there is none.
export const openerFor = (platform: string): string | undefined => platform === 'darwin' ? 'open' : platform === 'linux' ? 'xdg-open' : platform === 'win32' ? 'explorer' : undefined

export function prCardRows(h: Handover, o: { entry: DetailsEntry | undefined; mergeMode: string; now: number }): CardRow[] {
  const rows: CardRow[] = []
  const d = o.entry?.details
  rows.push({ text: `#${h.pr} ${h.title}`, bold: true })
  rows.push({ text: `${h.status}${h.status === 'returned' && h.reason !== undefined ? `: ${h.reason}` : ''} · ${h.branch} · head ${h.head.slice(0, 8)}`, tone: h.status === 'awaiting' ? 'warning' : undefined })
  rows.push({ text: `handed over by ${h.reportTo}, ${age(o.now - h.at)} ago`, dim: true })
  if (h.status === 'awaiting') rows.push({ text: `awaits you because ${whyAwaits(h, parseMode(o.mergeMode), d?.labels)}`, tone: 'warning' })
  if (d?.headRefOid !== undefined && !d.headRefOid.startsWith(h.head) && !h.head.startsWith(d.headRefOid)) {
    rows.push({ text: `PR moved since handover: approving approves the stored head ${h.head.slice(0, 8)}, GitHub has ${d.headRefOid.slice(0, 8)}`, tone: 'warning' })
  }
  rows.push({ text: '' })
  rows.push({ text: `verified: ${h.verified === '' ? '(nothing said)' : h.verified}` })
  if (h.pending !== '' && h.pending !== 'none') rows.push({ text: `pending decisions: ${h.pending}` })
  rows.push({ text: `after deploy: ${h.afterDeploy === '' ? 'none' : h.afterDeploy}${h.verifyCommand === undefined ? '' : ` (verify: ${h.verifyCommand})`}` })
  if (h.evidence === undefined) rows.push({ text: 'no evidence stored (handed over before evidence was recorded)', dim: true })
  else {
    rows.push({ text: 'Ran:', bold: true }, ...h.evidence.ran.map(r => ({ text: `  - ${r}` })))
    rows.push({ text: `Exercised: ${h.evidence.exercised}` })
    rows.push({ text: 'Not verified:', bold: true }, ...h.evidence.notVerified.map(r => ({ text: `  - ${r}` })))
  }
  if (h.env !== undefined && h.env.length > 0) {
    rows.push({ text: 'env changes:', bold: true }, ...h.env.map(e => ({ text: `  - ${e.name} on ${e.target}${e.secret === true ? ' (secret, you set it)' : e.value === undefined ? '' : ` = ${e.value}`}: ${e.why}`, tone: 'warning' as const })))
  }
  rows.push({ text: '' })
  if (o.entry === undefined || (d === undefined && o.entry.error === undefined)) rows.push({ text: 'loading details…', dim: true })
  else if (d === undefined) rows.push({ text: `details unavailable: ${o.entry.error}`, dim: true })
  else {
    rows.push({ text: `${d.files.length} file${d.files.length === 1 ? '' : 's'} changed, +${d.additions} -${d.deletions}`, bold: true })
    rows.push(...d.files.map(f => ({ text: `  +${f.additions} -${f.deletions} ${f.path}` })))
    rows.push({ text: d.url, dim: true })
  }
  return rows
}

// What a press of Open on GitHub shows when no opener works.
export const urlNote = (url: string): string => `Open it yourself: ${url}`
