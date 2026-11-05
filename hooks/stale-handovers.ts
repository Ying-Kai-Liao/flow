import type { Handover } from '../types'
import { LIVE } from './deliver'
import { isReviewer } from './core'

// Closures over the calls this needs: the engine refuses `$` across an import.
export type StaleIo = {
  now: () => Promise<number>
  handovers: () => Promise<Record<string, Handover>>
  agents: () => Promise<{ id: string; type: string; status: string }[]>
  // true/false from `git merge-base --is-ancestor <head> origin/<base>`; undefined when git failed.
  isAncestor: (head: string) => Promise<boolean | undefined>
  // PR number -> merge commit ('' when unknown) for the recent merged PRs; undefined when gh failed.
  mergedPrs: () => Promise<Map<number, string> | undefined>
  // PR numbers closed without a merge on GitHub (gh's closed state); undefined when gh failed.
  closedPrs: () => Promise<Set<number> | undefined>
  // One PR's state from `gh pr view <n> --json state`, for a PR older than the lists above; undefined when gh failed.
  prState: (pr: number) => Promise<PrState | undefined>
  // Saves the handover, mirrors it and appends the log event.
  save: (h: Handover) => Promise<void>
  // Saves a returned handover just marked pruned and logs a prune event: no `back` event, no env close (it was
  // returned already).
  savePruned: (h: Handover) => Promise<void>
}

export type RecentPrs = { merged?: Map<number, string>; closed?: Set<number> }
export type PrState = 'MERGED' | 'CLOSED' | 'OPEN'

const MIN_GAP_MS = 60_000
let lastFetchAt = -Infinity
let lastFetch: Promise<RecentPrs> | undefined

// The most single-PR lookups one pass makes; the rest wait for a later pass.
export const MAX_LOOKUPS = 10
// Single-PR answers, each kept for the gap: a known state is not asked again inside it. A failure is not kept.
const lookedUp = new Map<number, { at: number; state: PrState }>()

export const resetStaleThrottle = (): void => { lastFetchAt = -Infinity; lastFetch = undefined; lookedUp.clear() }

// The states of PRs the recent lists do not hold (older than their 50), each asked on its own: an answer from inside
// the gap is reused, at most MAX_LOOKUPS are asked per call, and a failed or thrown lookup is left out (unknown, so
// it prunes nothing).
export async function lookupPrs(io: Pick<StaleIo, 'now' | 'prState'>, prs: number[]): Promise<Map<number, PrState>> {
  const out = new Map<number, PrState>()
  const now = await io.now()
  let asked = 0
  for (const pr of [...new Set(prs)]) {
    const known = lookedUp.get(pr)
    if (known !== undefined && now - known.at <= MIN_GAP_MS) { out.set(pr, known.state); continue }
    if (asked >= MAX_LOOKUPS) continue
    asked++
    const state = await io.prState(pr).catch(() => undefined)
    if (state === undefined) continue
    lookedUp.set(pr, { at: now, state })
    out.set(pr, state)
  }
  return out
}

// The recent merged and closed PRs on GitHub, fetched at most once a minute for every caller (reconcileStale and
// the inbox prune share it); a caller inside the gap gets the last answer, or awaits the one in flight. A failed
// lookup is undefined until the next fetch.
export function recentPrs(io: Pick<StaleIo, 'now' | 'mergedPrs' | 'closedPrs'>): Promise<RecentPrs> {
  return io.now().then(now => {
    if (lastFetch !== undefined && now - lastFetchAt <= MIN_GAP_MS) return lastFetch
    lastFetchAt = now
    const none = (): undefined => undefined
    const run = Promise.all([io.mergedPrs().catch(none), io.closedPrs().catch(none)]).then(([merged, closed]) => ({ merged, closed }))
    lastFetch = run
    return run
  })
}

// Pending/awaiting/taken handovers whose PR was merged by someone else become done, and those whose PR was closed on GitHub become returned; a taken one whose reviewer
// died goes back to pending. A returned one whose PR is closed or merged on GitHub is marked pruned (one still open may yet be fixed).
// Never throws: on a gh or git failure the records stay as they are.
// A taken record is freed only when no reviewer is live at all: the caller may be mid-work on its own.
export async function reconcileStale(io: StaleIo): Promise<void> {
  try {
    const all = Object.values(await io.handovers())
    const open = all.filter(h => h.status === 'pending' || h.status === 'taken' || h.status === 'awaiting')
    const returned = all.filter(h => h.status === 'returned' && h.pruned === undefined)
    if (open.length === 0 && returned.length === 0) return
    const merged = new Map<number, string>()
    const rest: Handover[] = []
    for (const h of open) {
      if (await io.isAncestor(h.head) === true) merged.set(h.pr, h.head.slice(0, 8))
      else rest.push(h)
    }
    const prs: RecentPrs = rest.length > 0 || returned.length > 0 ? await recentPrs(io) : {}
    for (const h of rest) {
      const sha = prs.merged?.get(h.pr)
      if (sha !== undefined) merged.set(h.pr, sha === '' ? h.head.slice(0, 8) : sha.slice(0, 8))
    }
    let reviewerAlive: boolean | undefined
    for (const h of open) {
      // Re-read: a concurrent call or the reviewer may have moved it on.
      const cur = (await io.handovers())[String(h.pr)]
      if (cur === undefined || (cur.status !== 'pending' && cur.status !== 'taken' && cur.status !== 'awaiting')) continue
      const sha = merged.get(h.pr)
      if (sha !== undefined) {
        await io.save({ ...cur, status: 'done', sha, report: `merged elsewhere (${sha})` })
      } else if (prs.closed?.has(h.pr) === true) {
        await io.save({ ...cur, status: 'returned', reason: 'PR closed on GitHub' })
      } else if (cur.status === 'taken') {
        reviewerAlive ??= (await io.agents()).some(a => isReviewer(a.type) && (LIVE.has(a.status) || a.status === 'idle'))
        if (!reviewerAlive) await io.save({ ...cur, status: 'pending' })
      }
    }
    // A returned PR the recent lists do not hold is looked up on its own (only when the lists themselves were read).
    const known = (pr: number) => prs.merged?.has(pr) === true || prs.closed?.has(pr) === true
    const older = prs.merged === undefined || prs.closed === undefined ? new Map<number, PrState>()
      : await lookupPrs(io, returned.filter(h => !known(h.pr)).map(h => h.pr))
    for (const h of returned) {
      const one = older.get(h.pr)
      const how = prs.merged?.has(h.pr) === true || one === 'MERGED' ? 'merged' : prs.closed?.has(h.pr) === true || one === 'CLOSED' ? 'closed' : undefined
      if (how === undefined) continue
      const cur = (await io.handovers())[String(h.pr)]
      if (cur === undefined || cur.status !== 'returned' || cur.pruned !== undefined) continue
      await io.savePruned({ ...cur, pruned: { at: await io.now(), reason: `${how} on GitHub` } })
    }
  } catch { /* leave the records untouched */ }
}
