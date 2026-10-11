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
  // Saves the handover, mirrors it and appends the log event.
  save: (h: Handover) => Promise<void>
}

const MIN_GAP_MS = 60_000
let lastFetchAt = -Infinity
let lastMerged: Map<number, string> | undefined

export const resetStaleThrottle = (): void => { lastFetchAt = -Infinity; lastMerged = undefined }

// Pending/taken handovers whose PR was merged by someone else become done; a taken one whose reviewer
// died goes back to pending. Never throws: on a gh or git failure the records stay as they are.
// `except` is the caller: a reviewer asking for its worklist is alive but did not take the old records.
export async function reconcileStale(io: StaleIo, except: string | undefined): Promise<void> {
  try {
    const open = Object.values(await io.handovers()).filter(h => h.status === 'pending' || h.status === 'taken')
    if (open.length === 0) return
    const merged = new Map<number, string>()
    const rest: Handover[] = []
    for (const h of open) {
      if (await io.isAncestor(h.head) === true) merged.set(h.pr, h.head.slice(0, 8))
      else rest.push(h)
    }
    if (rest.length > 0) {
      const now = await io.now()
      if (now - lastFetchAt > MIN_GAP_MS) {
        lastFetchAt = now
        lastMerged = await io.mergedPrs()
      }
      for (const h of rest) {
        const sha = lastMerged?.get(h.pr)
        if (sha !== undefined) merged.set(h.pr, sha === '' ? h.head.slice(0, 8) : sha.slice(0, 8))
      }
    }
    let reviewerAlive: boolean | undefined
    for (const h of open) {
      // Re-read: a concurrent call or the reviewer may have moved it on.
      const cur = (await io.handovers())[String(h.pr)]
      if (cur === undefined || (cur.status !== 'pending' && cur.status !== 'taken')) continue
      const sha = merged.get(h.pr)
      if (sha !== undefined) {
        await io.save({ ...cur, status: 'done', sha, report: `merged elsewhere (${sha})` })
      } else if (cur.status === 'taken') {
        reviewerAlive ??= (await io.agents()).some(a => isReviewer(a.type) && a.id !== except && (LIVE.has(a.status) || a.status === 'idle'))
        if (!reviewerAlive) await io.save({ ...cur, status: 'pending' })
      }
    }
  } catch { /* leave the records untouched */ }
}
