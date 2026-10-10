import type { Activity, Handover } from '../types'
import { ENDED } from './deliver'
import { waitsOnReport } from './dag'
import type { AgentFact, Plan } from './dag'
import type { Inbox } from './inbox'
import { runLine } from './mainff'
import type { RunWork } from './mainff'
import { MANAGER, WORKERS } from './core'

// Reviewer report routing: where a reviewer's (or manager's) final report goes, and when a SendMessage to
// a manager that has finished is turned into a note plus a message to main. The engine refuses `$` across
// an import, so register.tsx builds a RouteIo of closures over the calls this needs.
export type Forwarded = { keys: Record<string, string[]>; lines: Record<string, string[]> }
type Row = { id: string; name?: string; type: string; status: string; parentId?: string }

export type RouteIo = {
  agents: () => Promise<Row[]>
  activity: () => Promise<Record<string, Activity>>
  handovers: () => Promise<Record<string, Handover>>
  plans: () => Promise<Plan>
  inbox: () => Promise<Inbox>
  seenAgents: () => Promise<Record<string, AgentFact>>
  forwarded: () => Promise<Forwarded>
  updateForwarded: (fn: (f: Forwarded) => Forwarded) => Promise<unknown>
  // Main's transcript; { deny } when it cannot be read.
  messages: () => Promise<{ deny: unknown } | { role: string; text: string }[]>
  planOwner: (plans: Plan, name: string | undefined) => string
  isManagerOf: (owner: string, name: string | undefined) => boolean
  appendNote: (name: string, line: string) => Promise<boolean>
  today: () => Promise<string>
  toMain: (text: string) => void
}

export const RELAY_DELAY_MS = 3000
export const FORWARDED_MAX = 400
export const FORWARDED_RIDS = 10

export const normText = (t: string): string => t.replace(/\s+/g, ' ').trim()

// A reviewer's whole final answer plus the main-checkout line when it left it out; undefined for a run
// that did no batch work.
export function reviewerReport(answer: string, work: RunWork | undefined): string | undefined {
  const line = runLine(work)
  const text = answer.trim()
  if (line === undefined || text === '') return undefined
  return /main checkout (fast-forwarded|not updated)/.test(text) ? text : `${text}\n${line}`
}

// The host may already hand a woken manager's answer to main as a task notification. Main's transcript
// shows whether it did; when it cannot be read, say "not there" so the report is relayed, never lost.
export async function mainHasAnswer(io: RouteIo, answer: string): Promise<boolean> {
  try {
    const msgs = await io.messages()
    if ('deny' in msgs) return false
    const snippet = normText(answer).slice(0, 80)
    return snippet !== '' && msgs.slice(-60).some(m => m.role === 'user' && normText(m.text).includes(snippet))
  } catch {
    return false
  }
}

// The lines of a report that need main's eye: "needs a person: ..." and "pending decisions: ...",
// each cut at the next " | " field, so a whole done line and a lone line compare equal.
export const needLines = (text: string): string[] =>
  [...text.matchAll(/(needs a person:[^|\n]*|pending decisions:[^\n]*)/gi)].map(m => normText(m[1] ?? '')).filter(l => l !== '')

// A needs line's identity for dedupe: for "needs a person" its PR number when it names one, so a reworded
// repeat for the same PR matches. Any other line (pending decisions) keeps its text, so a pending-decisions
// line is never swallowed by a needs-a-person line for the same PR. Old persisted entries are plain
// normalized lines and map the same way.
export const needToken = (line: string): string => {
  const m = /^needs a person:.*?PR\s*#(\d+)/i.exec(line)
  return m ? `needs:pr:${m[1]}` : line
}

// Where a handover's report goes. Absent -> the caller's own name. A name no agent carries is refused,
// naming the caller; the caller's own worker is corrected to the caller. An ended agent that exists is
// accepted: the reviewer routing (reviewerSendGuard) handles it.
export async function resolveReportTo(io: RouteIo, given: unknown, callerId: string | undefined): Promise<{ name: string; note?: string } | { refuse: string }> {
  const rows = await io.agents()
  const me = callerId === undefined ? 'main' : (rows.find(a => a.id === callerId)?.name ?? 'main')
  const asked = typeof given === 'string' ? given.trim() : ''
  if (asked === '' || asked === me || asked === 'main') return { name: asked === '' ? me : asked }
  const hits = rows.filter(a => a.name === asked || io.isManagerOf(asked, a.name))
  if (hits.length === 0) {
    return { refuse: `Refused: report_to "${asked}" matches no agent of this session. Your own name is "${me}"; pass that, or leave report_to out and it defaults to it.` }
  }
  if (callerId !== undefined && hits.every(a => a.parentId === callerId && WORKERS.has(a.type))) {
    return { name: me, note: ` report_to "${asked}" is your own worker, so the report goes to you ("${me}") instead.` }
  }
  return { name: asked }
}

export async function managerFinished(io: RouteIo, ids: string[], name: string, rows: { id: string; parentId?: string; status: string }[], report?: string): Promise<boolean> {
  // A child is live only while running or pending: workers sit 'idle' after their final report. A child
  // active more recently than the manager may have reported without the manager hearing it yet.
  const acts = await io.activity()
  const mineAt = Math.max(0, ...ids.map(i => acts[i]?.lastAt ?? 0))
  const kids = rows.filter(a => a.parentId !== undefined && ids.includes(a.parentId))
  if (kids.some(a => a.status === 'running' || a.status === 'pending' || (acts[a.id]?.lastAt ?? 0) > mineAt)) return false
  const open = new Set(['pending', 'awaiting', 'taken', 'returned'])
  if (Object.values(await io.handovers()).some(h => open.has(h.status) && io.isManagerOf(name.replace(/-\d+$/, ''), h.reportTo))) return false
  const plans = await io.plans()
  if (Object.values(plans[io.planOwner(plans, name)] ?? {}).some(n => n.state === 'waiting' || n.state === 'ready' || n.state === 'running')) return false
  if ((await io.inbox()).items.some(q => q.state === 'open' && q.blocking && io.isManagerOf(name.replace(/-\d+$/, ''), q.owner))) return false
  // Its last answer says it waits for this very report (a follow-up after the merge): wake it.
  if (report !== undefined) {
    const stamp = (i: string) => acts[i]?.endedAt ?? acts[i]?.lastAt ?? 0
    const newest = ids.reduce((best, i) => stamp(i) >= stamp(best) ? i : best, ids[0]!)
    const answer = acts[newest]?.answer ?? (await io.seenAgents())[name]?.answer
    const own = Object.values(await io.handovers()).filter(h => io.isManagerOf(name.replace(/-\d+$/, ''), h.reportTo)).map(h => h.pr)
    if (waitsOnReport(answer, report, own)) return false
  }
  return true
}

// The reviewer's SendMessage to a manager that has ended would resume it just to say "noted", and its
// final answer would go back to the reviewer. Instead the report is noted for that manager and sent to
// main. Returns the tool result when it handled the call; undefined passes the call on.
export async function reviewerSendGuard(io: RouteIo, rid: string, to: string, text: string): Promise<string | undefined> {
  if (to === '' || to === 'main' || to === '*') return undefined
  const rows = await io.agents()
  const hits = rows.filter(a => a.id === to || a.name === to)
  if (hits.length > 0 && !hits.some(a => a.type === MANAGER)) return undefined
  const name = hits[0]?.name ?? to
  // A manager that ended its turn to wait for a merge is 'completed' or dropped from the roster. With work
  // left (a plan node, a handover, a live worker, a blocking ask) the report wakes it: the call goes through.
  if (hits.every(a => a.status === 'completed')) {
    const seen = hits.length === 0 ? (await io.seenAgents())[name] : undefined
    if (seen?.status !== 'failed' && seen?.status !== 'killed') {
      const ids = hits.length > 0 ? hits.map(a => a.id) : seen?.id !== undefined ? [seen.id] : []
      // Live workers are left out: a worker's own report resumes its manager, and the old routing sent a
      // report for an ended manager to main whatever its workers were doing.
      if (ids.length > 0 && !(await managerFinished(io, ids, name, [], text))) return undefined
    }
  }
  const idle = hits.length > 0 && !hits.some(a => a.status !== 'idle' && !ENDED.has(a.status))
  // A host leaves a manager that finished its work 'idle', not completed. It counts as finished only
  // when nothing is left for it: no live child, no other open or returned handover, no open plan
  // node, no open blocking ask. Otherwise the message wakes it as today.
  if (hits.length > 0 && !hits.every(a => ENDED.has(a.status))) {
    if (!idle || !(await managerFinished(io, hits.map(a => a.id), name, rows, text))) return undefined
  }
  // One outcome reaches main once: key on the manager and the PRs the text names (the text itself when
  // it names none). A repeat forwards only needs-a-person / pending-decisions lines not sent before.
  const prs = [...new Set([...text.matchAll(/#(\d+)/g)].map(m => m[1]))].sort().join(',')
  const key = `${rid}|${name}|${prs !== '' ? prs : normText(text)}`
  const seen = await io.forwarded()
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
    noted = await io.appendNote(name, `- ${await io.today()} progress: reviewer report: ${normText(body)}`)
  }
  await io.updateForwarded(f => ({
    keys: { ...Object.fromEntries(Object.entries(f.keys).slice(-FORWARDED_MAX)), [key]: [...(f.keys[key] ?? []), ...(fresh ?? needs)] },
    lines: Object.fromEntries(Object.entries({ ...f.lines, [rid]: [...(f.lines[rid] ?? []), ...body.split('\n').map(normText).filter(l => l !== ''), ...(fresh ?? needs)].slice(-FORWARDED_MAX) }).slice(-FORWARDED_RIDS)),
  }))
  io.toMain(`Report for ${hits.length > 0 ? `${name} (finished${hits.every(a => ENDED.has(a.status)) ? '' : '; not woken'})` : `${name} (no such agent)`}, from the reviewer:\n${body}`)
  return `Not sent: ${name} ${status}, so messaging it would only wake it. The plugin ${noted ? `noted the report for ${name} and ` : ''}sent ${fresh === undefined ? 'it' : 'the new lines'} to main. Do not message ${name} again, and do not repeat this report to main.`
}
