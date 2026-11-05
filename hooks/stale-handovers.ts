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
  // Saves the handover, mirrors it and appends the log event.
  save: (h: Handover) => Promise<void>
  // Saves a returned handover just marked pruned and logs a prune event: no `back` event, no env close (it was
  // returned already).
  savePruned: (h: Handover) => Promise<void>
}

export type RecentPrs = { merged?: Map<number, string>; closed?: Set<number> }

const MIN_GAP_MS = 60_000
let lastFetchAt = -Infinity
let lastFetch: Promise<RecentPrs> | undefined

export const resetStaleThrottle = (): void => { lastFetchAt = -Infinity; lastFetch = undefined }

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
    for (const h of returned) {
      const how = prs.merged?.has(h.pr) === true ? 'merged' : prs.closed?.has(h.pr) === true ? 'closed' : undefined
      if (how === undefined) continue
      const cur = (await io.handovers())[String(h.pr)]
      if (cur === undefined || cur.status !== 'returned' || cur.pruned !== undefined) continue
      await io.savePruned({ ...cur, pruned: { at: await io.now(), reason: `${how} on GitHub` } })
    }
  } catch { /* leave the records untouched */ }
}
