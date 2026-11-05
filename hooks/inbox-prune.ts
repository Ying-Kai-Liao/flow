// Pruning: open inbox items that nothing can come of any more are closed as stale and recorded as pruned, never
// deleted. pruneCandidates is pure (it says what and why); the caller applies the list with applyPrunes inside an
// inbox write. The run half below takes closures (the engine refuses `$` across an import): register.tsx builds a
// PruneIo for status, the reviewer's list, /flow inbox, /flow prune and mcp__flow__answer prune.
import type { Handover, Inbox, LogEvent, Question } from '../types'
import { endedOwners, findItem, isFyi, KEEP, notesOwner } from './inbox'
import { baseName } from './cost'
import { noteKey } from './state'
import type { PrState, RecentPrs } from './stale-handovers'

// A pruned question's answer; a pruned decision is kept (KEEP).
export const PRUNED = 'Pruned'
// Who prunes: flow itself, or the person's /flow prune; main is "main".
export const AUTO_PRUNE = 'flow'
export const USER_PRUNE = 'the user'

export type PruneCandidate = { id: string; reason: string; pr?: number }

export type PruneFacts = {
  handovers: Record<string, Handover>
  // The recent merged and closed PRs on GitHub (stale-handovers' shared fetch).
  merged: ReadonlySet<number>
  closed: ReadonlySet<number>
  // noteKeys: agents that are over (endedOwners: a name never seen is not among them), and agents still running.
  ended: ReadonlySet<string>
  live: ReadonlySet<string>
}

// The items that have their own way to be closed: no prune, auto or explicit, takes them.
const OWN_COMMAND = new Set(['deploy', 'env', 'push', 'reviewer'])

// Why an explicit prune refuses an item, as a phrase; undefined when it may be pruned.
export function pruneRefusal(q: Question): string | undefined {
  if (q.kind === 'deploy') return `a deploy approval: answer it (/flow answer ${q.id} <choice>) or hold its target (/flow hold <target>)`
  if (q.kind === 'env') return `an env change: answer it with /flow answer ${q.id} <choice>`
  if (q.kind === 'push') return 'a push: /flow push drop returns the batch'
  if (q.kind === 'reviewer') return `a reviewer retry: answer it with /flow answer ${q.id} <choice>`
  return undefined
}

// Never pruned on its own: the kinds above, and an escalated question or either side of an escalation link (the
// answer to one closes the other).
const autoProtected = (q: Question): boolean =>
  (q.kind !== undefined && OWN_COMMAND.has(q.kind)) || q.escalated !== undefined || q.forQ !== undefined || q.viaQ !== undefined

// The PR an item is about: its own field, an env item's PR, or the "PR #N" a guard suggestion filed before the field
// opens with. Never a "#N" anywhere else in free text.
export function linkedPr(q: Question): number | undefined {
  if (q.pr !== undefined) return q.pr
  if (q.env?.pr !== undefined) return q.env.pr
  const m = q.guard === undefined ? null : /^PR #(\d+) /.exec(q.question)
  return m === null ? undefined : Number(m[1])
}

type Outcome = 'merged' | 'closed'

const outcomeOf = (pr: number, f: PruneFacts): Outcome | undefined =>
  f.handovers[String(pr)]?.status === 'done' || f.merged.has(pr) ? 'merged' : f.closed.has(pr) ? 'closed' : undefined

// A handover of the owner's: its branch, or a manager's PR that reports to it.
const relatedTo = (h: Handover, owner: string): boolean =>
  h.branch === `flow/${owner}` || noteKey(h.reportTo) === noteKey(owner) || baseName(h.reportTo) === baseName(owner)

// "PR #12 merged", "PRs #12, #14 merged, PR #15 closed".
function prsText(list: Array<{ pr: number; how: Outcome }>): string {
  const part = (how: Outcome) => {
    const prs = [...new Set(list.filter(x => x.how === how).map(x => x.pr))].sort((a, b) => a - b)
    return prs.length === 0 ? [] : [`${prs.length === 1 ? 'PR' : 'PRs'} ${prs.map(n => `#${n}`).join(', ')} ${how}`]
  }
  return [...part('merged'), ...part('closed')].join(', ')
}

// Whether pruneCandidates could find anything once GitHub answers (an open item that is linked, or whose owner is
// over, unaddressed to a live agent, with handovers): without one, the gh lookup is skipped.
export const mayPrune = (inbox: Inbox, f: Pick<PruneFacts, 'handovers' | 'ended' | 'live'>): boolean =>
  inbox.items.some(q => q.state === 'open' && !autoProtected(q) && (linkedPr(q) !== undefined ||
    (f.ended.has(noteKey(q.owner)) && !f.live.has(noteKey(q.addressee)) && Object.values(f.handovers).some(h => relatedTo(h, q.owner)))))

// The open items auto-prune closes, with the reason. A linked item (linkedPr) goes once its PR is merged or closed;
// one whose PR is open or unknown stays. An unlinked one goes once its owner is over, it is not addressed to an agent
// that still runs, and the owner has handovers, every one of them done or its PR merged or closed.
export function pruneCandidates(inbox: Inbox, f: PruneFacts): PruneCandidate[] {
  const out: PruneCandidate[] = []
  for (const q of inbox.items) {
    if (q.state !== 'open' || autoProtected(q)) continue
    const pr = linkedPr(q)
    if (pr !== undefined) {
      const how = outcomeOf(pr, f)
      if (how !== undefined) out.push({ id: q.id, reason: `PR #${pr} ${how}`, pr })
      continue
    }
    if (!f.ended.has(noteKey(q.owner)) || f.live.has(noteKey(q.addressee))) continue
    const related = Object.values(f.handovers).filter(h => relatedTo(h, q.owner))
    if (related.length === 0) continue
    const done = related.map(h => ({ pr: h.pr, how: outcomeOf(h.pr, f) }))
    if (done.some(x => x.how === undefined)) continue
    out.push({ id: q.id, reason: `owner ${q.owner} finished; ${prsText(done as Array<{ pr: number; how: Outcome }>)}` })
  }
  return out
}

// The candidates closed as pruned, each still open in this inbox (one answered meanwhile is skipped). Pass the inbox
// the write re-read. The answer is Keep for a decision and "Pruned" for a question; delivered, since nobody is told.
export function applyPrunes(inbox: Inbox, cands: PruneCandidate[], by: string, now: number): { inbox: Inbox; pruned: Array<{ q: Question; c: PruneCandidate }>; skipped: string[] } {
  const via: NonNullable<Question['via']> = by === AUTO_PRUNE ? 'flow' : by === 'main' ? 'main' : 'user'
  const done = new Map<string, Question>()
  const pruned: Array<{ q: Question; c: PruneCandidate }> = []
  const skipped: string[] = []
  for (const c of cands) {
    const q = findItem(inbox, c.id)
    if (q === undefined || q.state !== 'open' || done.has(q.id)) { skipped.push(c.id); continue }
    // Not a keep by the decision API or a rule: neither field survives.
    const { auto: _auto, rule: _rule, ...rest } = q
    const p: Question = {
      ...rest, state: 'answered', answer: isFyi(q) ? KEEP : PRUNED, answeredBy: by, answeredAt: now, via, delivered: true,
      pruned: { at: now, reason: c.reason, by },
    }
    done.set(q.id, p)
    pruned.push({ q: p, c })
  }
  if (done.size === 0) return { inbox, pruned, skipped }
  return { inbox: { ...inbox, items: inbox.items.map(x => done.get(x.id) ?? x) }, pruned, skipped }
}

// The named items as candidates for an explicit prune, and a line for each one that is refused, unknown or answered.
export function explicitCandidates(inbox: Inbox, ids: string[], reason: string): { cands: PruneCandidate[]; lines: string[] } {
  const cands: PruneCandidate[] = []
  const lines: string[] = []
  for (const raw of ids) {
    const id = raw.trim().toLowerCase()
    if (id === '') continue
    const q = findItem(inbox, id)
    if (q === undefined) { lines.push(`${id}: no such question or decision.`); continue }
    if (cands.some(c => c.id === q.id)) continue
    if (q.state !== 'open') { lines.push(`${q.id}: already ${q.pruned !== undefined ? `pruned (${q.pruned.reason})` : `answered ("${q.answer ?? ''}")`}; nothing to prune.`); continue }
    const why = pruneRefusal(q)
    if (why !== undefined) { lines.push(`${q.id}: not pruned, ${why}.`); continue }
    const pr = linkedPr(q)
    cands.push({ id: q.id, reason, ...(pr === undefined ? {} : { pr }) })
  }
  return { cands, lines }
}

// "q53 (PR #244 merged), d109 (owner x finished; PR #12 merged)".
export const prunedList = (items: Array<{ id: string; reason: string }>): string => items.map(x => `${x.id} (${x.reason})`).join(', ')

// --- The run half ---

export type PruneIo = {
  now: () => Promise<number>
  inbox: () => Promise<Inbox>
  // The inbox writer every other answer goes through: fn gets the file as it is now.
  withInbox: <T>(fn: (cur: Inbox) => { inbox: Inbox; out: T }) => Promise<T>
  handovers: () => Promise<Record<string, Handover>>
  // The roster and the facts kept for agents that left it, as the pane reads them.
  agents: () => Promise<Array<{ name?: string; status: string }>>
  seen: () => Promise<Record<string, { status: string }>>
  // stale-handovers' recentPrs: the throttled gh lookup reconcileStale uses.
  prs: () => Promise<RecentPrs>
  // stale-handovers' lookupPrs: single-PR states for PRs older than the recent lists (capped, cached for the gap).
  lookup: (prs: number[]) => Promise<Map<number, PrState>>
  appendLog: (event: Omit<LogEvent, 'ts'>) => Promise<void>
}

const OVER = new Set(['completed', 'failed', 'killed'])

// The facts auto-prune needs: 'none' when no item could be pruned (gh is not asked), undefined when gh failed, so
// nothing is pruned on a guess.
async function factsOf(io: PruneIo, box: Inbox): Promise<PruneFacts | 'none' | undefined> {
  const [handovers, rows, seen] = await Promise.all([io.handovers(), io.agents(), io.seen()])
  const local = { handovers, ended: endedOwners(rows, seen), live: new Set(rows.filter(a => a.name !== undefined && !OVER.has(a.status)).map(a => noteKey(a.name!))) }
  if (!mayPrune(box, local)) return 'none'
  const prs = await io.prs()
  if (prs.merged === undefined || prs.closed === undefined) return undefined
  const merged = new Set(prs.merged.keys())
  const closed = new Set(prs.closed)
  // A linked item's PR that neither the handovers nor the recent lists settle is asked on its own.
  const missing = box.items.filter(q => q.state === 'open' && !autoProtected(q)).map(linkedPr)
    .filter((pr): pr is number => pr !== undefined && handovers[String(pr)]?.status !== 'done' && !merged.has(pr) && !closed.has(pr))
  if (missing.length > 0) {
    for (const [pr, state] of await io.lookup(missing)) {
      if (state === 'MERGED') merged.add(pr)
      else if (state === 'CLOSED') closed.add(pr)
    }
  }
  return { ...local, merged, closed }
}

// What auto-prune would close now, without closing it; undefined when the PRs could not be checked.
export async function prunePreview(io: PruneIo): Promise<PruneCandidate[] | undefined> {
  try {
    const box = await io.inbox()
    const f = await factsOf(io, box)
    return f === 'none' ? [] : f === undefined ? undefined : pruneCandidates(box, f)
  } catch { return undefined }
}

async function logPruned(io: PruneIo, pruned: Array<{ q: Question; c: PruneCandidate }>): Promise<void> {
  for (const { q, c } of pruned) {
    await io.appendLog({ event: 'prune', owner: noteKey(notesOwner(q)), agent: q.owner, id: q.id, ...(c.pr === undefined ? {} : { pr: c.pr }), text: c.reason }).catch(() => undefined)
  }
}

// Closes what pruneCandidates finds, judged again on the inbox the write reads, so an answer given meanwhile is never
// overwritten. Never throws: on any failure nothing is pruned. by: AUTO_PRUNE, or who asked for it.
export async function autoPrune(io: PruneIo, by = AUTO_PRUNE): Promise<Question[] | undefined> {
  try {
    const f = await factsOf(io, await io.inbox())
    if (f === 'none') return []
    if (f === undefined) return undefined
    const now = await io.now()
    const pruned = await io.withInbox(cur => {
      const r = applyPrunes(cur, pruneCandidates(cur, f), by, now)
      return { inbox: r.inbox, out: r.pruned }
    })
    await logPruned(io, pruned)
    return pruned.map(p => p.q)
  } catch { return undefined }
}

// Prunes the named open items: one line per item, pruned or refused.
export async function pruneIds(io: PruneIo, ids: string[], by: string, reason: string): Promise<string[]> {
  const now = await io.now()
  const { pruned, lines } = await io.withInbox(cur => {
    const e = explicitCandidates(cur, ids, reason)
    const r = applyPrunes(cur, e.cands, by, now)
    return { inbox: r.inbox, out: { pruned: r.pruned, lines: e.lines } }
  })
  await logPruned(io, pruned)
  return [...(pruned.length === 0 ? [] : [`Pruned ${pruned.map(p => p.q.id).join(', ')} (${reason}); nobody is told.`]), ...lines]
}

// The result line of an auto-prune someone asked for (/flow prune yes, mcp__flow__answer prune without ids).
export const pruneResult = (pruned: Question[] | undefined): string =>
  pruned === undefined ? 'Could not check the PRs on GitHub (gh failed): nothing pruned.'
  : pruned.length === 0 ? 'Nothing to prune.'
  : `Pruned ${prunedList(pruned.map(q => ({ id: q.id, reason: q.pruned?.reason ?? '' })))}; nobody is told.`
