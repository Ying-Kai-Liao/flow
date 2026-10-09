import { noteKey } from './state'
import { EMPTY_INBOX, parseAsk, renderInbox } from './inbox'
import type { AskedQuestion, Inbox, Question } from './inbox'

// The pure half of pre-flight: a manager looks over its task before any worker starts and files
// acceptance criteria, what already shipped, its dependencies and its questions with
// mcp__flow__preflight. The plugin refuses its worker spawns until it has filed (and until its
// blocking questions are answered), and gives main one combined round of everything filed. The disk
// and messaging half is in register.tsx.

export type Filing = {
  summary: string
  workers?: number
  criteria: string[]
  shipped: Array<{ what: string; ref: string }>
  depends: Array<{ on: string; why: string }>
}

export type Entry = {
  // The manager's latest agent name (a successor is `<name>-2`); the entry is keyed by noteKey.
  name: string
  phase: 'recon' | 'filed' | 'skipped'
  // The round it was spawned into (0: none, e.g. it filed without having been recorded at spawn).
  round: number
  spawnedAt: number
  filedAt?: number
  filing?: Filing
  // Ids of the blocking questions of the filing: it is released when none of them is open.
  blocking: string[]
  // Ids of all the questions of the filing.
  asked: string[]
}

export type Round = {
  id: number
  openedAt: number
  members: string[]
  delivered: boolean
  deliveredAt?: number
  // The members the delivered message covered; a later filing is sent on its own.
  reported: string[]
}

export type Preflight = { next: number; entries: Record<string, Entry>; rounds: Round[] }

export const EMPTY_PREFLIGHT: Preflight = { next: 1, entries: {}, rounds: [] }

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

export const SKIP_LINE = /^\s*Pre-flight:\s*skip\b/im
export const isSkip = (prompt: string): boolean => SKIP_LINE.test(prompt)

// The filing checked whole: one bad field refuses the call and nothing is recorded.
export function parseFiling(input: unknown): { filing: Filing; questions: AskedQuestion[] } | { error: string } {
  const r = (input ?? {}) as Record<string, unknown>
  const summary = str(r.summary)
  if (summary === '') return { error: 'summary is required: one line on what you will do.' }
  if (!Array.isArray(r.criteria) || r.criteria.length === 0 || r.criteria.some(c => str(c) === '')) {
    return { error: 'criteria must be a non-empty list of acceptance criteria (strings).' }
  }
  const shipped: Filing['shipped'] = []
  for (const [i, s] of (Array.isArray(r.shipped) ? r.shipped : r.shipped === undefined ? [] : [null]).entries()) {
    const o = s as Record<string, unknown> | null
    if (typeof o !== 'object' || o === null || str(o.what) === '') return { error: `shipped[${i}] needs what (and ref: a PR, commit or branch).` }
    shipped.push({ what: str(o.what), ref: str(o.ref) })
  }
  const depends: Filing['depends'] = []
  for (const [i, d] of (Array.isArray(r.depends) ? r.depends : r.depends === undefined ? [] : [null]).entries()) {
    const o = d as Record<string, unknown> | null
    if (typeof o !== 'object' || o === null || str(o.on) === '') return { error: `depends[${i}] needs on (the task or manager) and why.` }
    depends.push({ on: str(o.on), why: str(o.why) })
  }
  const workers = typeof r.workers === 'number' && Number.isFinite(r.workers) && r.workers >= 0 ? Math.round(r.workers) : undefined
  let questions: AskedQuestion[] = []
  if (r.questions !== undefined && !(Array.isArray(r.questions) && r.questions.length === 0)) {
    const p = parseAsk({ questions: r.questions })
    if ('error' in p) return { error: p.error }
    questions = p.questions
  }
  return {
    filing: { summary, ...(workers !== undefined ? { workers } : {}), criteria: (r.criteria as string[]).map(c => c.trim()), shipped, depends },
    questions,
  }
}

const isOpen = (inbox: Inbox, id: string) => inbox.items.some(q => q.id === id && q.state === 'open')

export const openBlocking = (e: Entry, inbox: Inbox): string[] => e.blocking.filter(id => isOpen(inbox, id))

export type Gate = { kind: 'unfiled' } | { kind: 'blocking'; ids: string[] }

// May this manager start workers? Absent from the record: yes (old data never blocks).
export function gateOf(state: Preflight, inbox: Inbox, name: string): Gate | undefined {
  const e = state.entries[noteKey(name)]
  if (e === undefined || e.phase === 'skipped') return undefined
  if (e.phase === 'recon') return { kind: 'unfiled' }
  const ids = openBlocking(e, inbox)
  return ids.length > 0 ? { kind: 'blocking', ids } : undefined
}

export const FILE_HELP = 'call mcp__flow__preflight with from (your agent name), summary (one line: what you will do), criteria (acceptance criteria, a list), ' +
  'shipped ([{what, ref}]: work already shipped, duplicated or running; may be empty), depends ([{on, why}]: other tasks it depends on; may be empty) ' +
  'and optionally questions (the same shape as mcp__flow__ask)'

export function denyText(g: Gate): string {
  return g.kind === 'unfiled'
    ? `flow pre-flight: you may not start workers before your pre-flight is filed. Look over the task first (Explore or general-purpose agents, git log, open PRs are fine), then ${FILE_HELP}. Then start workers.`
    : `flow pre-flight: your blocking question(s) ${g.ids.join(', ')} are still open. End your turn: main answers once for all managers and the answer arrives by message. Then start workers.`
}

export type Phase = 'recon' | 'waiting on answers' | 'released' | 'skipped'

export function phaseOf(state: Preflight, inbox: Inbox, name: string): Phase | undefined {
  const e = state.entries[noteKey(name)]
  if (e === undefined) return undefined
  if (e.phase === 'skipped') return 'skipped'
  if (e.phase === 'recon') return 'recon'
  return openBlocking(e, inbox).length > 0 ? 'waiting on answers' : 'released'
}

// A manager main spawns: recorded in the open round, or in a new one. A successor of a recorded
// manager inherits its record. Returns the same object when nothing changes.
export function recordSpawn(state: Preflight, name: string, skip: boolean, now: number, waitMs: number): Preflight {
  const key = noteKey(name)
  const old = state.entries[key]
  if (old !== undefined && /-\d+$/.test(name)) return { ...state, entries: { ...state.entries, [key]: { ...old, name } } }
  let rounds = state.rounds
  let next = state.next
  // A round already past its wait (left over from a session that ended) is closed unsent: joining it
  // would deliver at once and lose the combined round.
  const stale = rounds.find(r => !r.delivered && now - r.openedAt >= waitMs)
  if (stale !== undefined) rounds = rounds.map(r => (r === stale ? closed(state, r, now) : r))
  let open = rounds.find(r => !r.delivered)
  if (open === undefined) {
    open = { id: next++, openedAt: now, members: [], delivered: false, reported: [] }
    rounds = [...rounds, open]
  }
  const round = open
  const entry: Entry = { name, phase: skip ? 'skipped' : 'recon', round: round.id, spawnedAt: now, blocking: [], asked: [] }
  return {
    next,
    entries: { ...state.entries, [key]: entry },
    rounds: rounds.map(r => (r === round ? { ...r, members: [...new Set([...r.members, key])] } : r)),
  }
}

// The filing replaces any earlier one of the same manager.
export function recordFiling(state: Preflight, name: string, filing: Filing, ids: { asked: string[]; blocking: string[] }, now: number): Preflight {
  const key = noteKey(name)
  const old = state.entries[key]
  const entry: Entry = {
    name, phase: 'filed', round: old?.round ?? 0, spawnedAt: old?.spawnedAt ?? now, filedAt: now, filing,
    blocking: ids.blocking, asked: ids.asked,
  }
  return { ...state, entries: { ...state.entries, [key]: entry } }
}

export const latestRound = (state: Preflight): Round | undefined => state.rounds[state.rounds.length - 1]

const settled = (e: Entry | undefined, ended: ReadonlySet<string>, key: string) =>
  e === undefined || e.phase !== 'recon' || ended.has(key)

// A round that is open and due: everyone filed, skipped or ended, or the wait is over.
export function dueRound(state: Preflight, ended: ReadonlySet<string>, now: number, waitMs: number): { round: Round; timedOut: boolean } | undefined {
  const round = state.rounds.find(r => !r.delivered)
  if (round === undefined) return undefined
  const done = round.members.every(k => settled(state.entries[k], ended, k))
  const late = now - round.openedAt >= waitMs
  if (!done && !late) return undefined
  return { round, timedOut: !done }
}

const closed = (state: Preflight, r: Round, now: number): Round =>
  ({ ...r, delivered: true, deliveredAt: now, reported: r.members.filter(k => state.entries[k]?.phase !== 'recon') })

// On load: an undelivered round with no member among the live managers belongs to a dead session; it
// is closed without sending. Same object when nothing is stale.
export function closeStale(state: Preflight, liveNames: string[], now: number): Preflight {
  const live = new Set(liveNames.map(noteKey))
  const dead = state.rounds.filter(r => !r.delivered && !r.members.some(k => live.has(k)))
  if (dead.length === 0) return state
  return { ...state, rounds: state.rounds.map(r => (dead.includes(r) ? closed(state, r, now) : r)) }
}

// Marks the round delivered; the members it covers are the ones settled now.
export function markDelivered(state: Preflight, roundId: number, now: number): Preflight {
  return {
    ...state,
    rounds: state.rounds.map(r => (r.id === roundId ? { ...r, delivered: true, deliveredAt: now, reported: r.members.filter(k => state.entries[k]?.phase !== 'recon') } : r)),
  }
}

// A filing whose round was already delivered without it: it goes to main on its own, once.
export function followUp(state: Preflight, name: string): { state: Preflight; send: boolean } {
  const key = noteKey(name)
  const e = state.entries[key]
  const round = e === undefined ? undefined : state.rounds.find(r => r.id === e.round)
  if (e === undefined || round === undefined || !round.delivered || round.reported.includes(key)) return { state, send: false }
  return { state: { ...state, rounds: state.rounds.map(r => (r === round ? { ...r, reported: [...r.reported, key] } : r)) }, send: true }
}

const openOf = (inbox: Inbox, e: Entry, key: string): Question[] =>
  inbox.items.filter(q => q.state === 'open' && noteKey(q.owner) === key && (q.addressee === 'main' || e.asked.includes(q.id)))

const list = (xs: string[]) => xs.join('; ')

function entryLines(key: string, e: Entry, inbox: Inbox, ended: ReadonlySet<string>): string[] {
  const head = `- ${e.name}`
  if (e.phase === 'skipped') return [`${head}: skipped (Pre-flight: skip)`]
  if (e.phase === 'recon') return [`${head}: ${ended.has(key) ? 'ended without pre-flight' : 'still in recon, no pre-flight yet'}`]
  const f = e.filing!
  const qs = openOf(inbox, e, key)
  return [
    `${head}: ${f.summary}${f.workers !== undefined ? ` (about ${f.workers} worker${f.workers === 1 ? '' : 's'})` : ''}`,
    `    criteria: ${list(f.criteria)}`,
    ...(f.shipped.length > 0 ? [`    already shipped: ${list(f.shipped.map(s => `${s.what}${s.ref ? ` (${s.ref})` : ''}`))}`] : []),
    ...(f.depends.length > 0 ? [`    depends on: ${list(f.depends.map(d => `${d.on}${d.why ? ` (${d.why})` : ''}`))}`] : []),
    ...(qs.length > 0 ? [`    questions: ${qs.map(q => q.id).join(', ')}`] : []),
  ]
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// The one message to main for a round.
export function renderRound(
  state: Preflight, inbox: Inbox, round: Round, ended: ReadonlySet<string>, now: number, timedOut: boolean,
): string {
  const entries = round.members.flatMap(k => (state.entries[k] === undefined ? [] : [[k, state.entries[k]!] as const]))
  const filed = entries.filter(([, e]) => e.phase === 'filed')
  const shipped = filed.filter(([, e]) => e.filing!.shipped.length > 0).length
  const deps = filed.filter(([, e]) => e.filing!.depends.length > 0).length
  const open = entries.flatMap(([k, e]) => openOf(inbox, e, k))
  const blocking = open.filter(q => q.blocking).length
  const lines = [
    `Pre-flight: ${plural(entries.length, 'task')}, ${shipped} already shipped, ${deps} depend on others, ${plural(open.length, 'question')}${blocking > 0 ? ` (${blocking} blocking)` : ''}`,
  ]
  const waiting = entries.filter(([, e]) => e.phase === 'recon').map(([, e]) => e.name)
  if (timedOut && waiting.length > 0) lines.push(`Timed out waiting for: ${waiting.join(', ')}. Their pre-flight follows as a separate message when filed.`)
  for (const [k, e] of entries) lines.push(...entryLines(k, e, inbox, ended))
  if (open.length > 0) {
    const ids = new Set(open.map(q => q.id))
    lines.push('', renderInbox({ ...inbox, items: inbox.items.filter(q => ids.has(q.id)) }, now))
  }
  lines.push('', open.length > 0
    ? 'Show this to the user, then answer with mcp__flow__answer (answers [{id, choice}], or defaults: true for the recommended ones). Managers with no blocking question can start workers already.'
    : 'Show this to the user. There are no questions: the managers start their workers by themselves.')
  return lines.join('\n')
}

// A filing that came after its round went out.
export function renderFollowUp(state: Preflight, inbox: Inbox, name: string, now: number): string {
  const key = noteKey(name)
  const e = state.entries[key]
  if (e === undefined || e.filing === undefined) return `Pre-flight: ${name} filed.`
  const qs = openOf(inbox, e, key)
  const blocking = qs.filter(q => q.blocking).length
  return [
    `Pre-flight (late): ${name} filed after the round went out${qs.length > 0 ? `, ${plural(qs.length, 'question')}${blocking > 0 ? ` (${blocking} blocking)` : ''}` : ''}`,
    ...entryLines(key, e, inbox, new Set()),
    ...(qs.length > 0 ? ['', renderInbox({ ...inbox, items: qs }, now), '', 'Show this to the user and answer with mcp__flow__answer (or defaults: true).'] : ['', 'Show this to the user.']),
  ].join('\n')
}

// /flow preflight: the current (open) or latest round.
export function renderStatus(state: Preflight | undefined, inbox: Inbox | undefined, ended: ReadonlySet<string>, now: number, waitMs: number): string {
  const s = state ?? EMPTY_PREFLIGHT
  const round = s.rounds.find(r => !r.delivered) ?? latestRound(s)
  if (round === undefined) return 'No pre-flight round yet.'
  const i = inbox ?? EMPTY_INBOX
  const members = round.members.map(k => s.entries[k]).filter((e): e is Entry => e !== undefined)
  const filed = members.filter(e => e.phase !== 'recon').length
  const head = round.delivered
    ? `Round ${round.id}: delivered to main (${filed} of ${members.length} had filed).`
    : `Round ${round.id}: open, ${filed} of ${members.length} filed; goes to main when all have, or ${Math.max(0, Math.ceil((round.openedAt + waitMs - now) / 60_000))} min from now.`
  return [head, '', renderRound(s, i, round, ended, now, !round.delivered && filed < members.length)].join('\n')
}

// A stored record read back from disk; anything malformed is dropped.
export function normalizePreflight(raw: unknown): Preflight {
  const r = raw as { next?: unknown; entries?: unknown; rounds?: unknown } | null
  const entries: Record<string, Entry> = {}
  if (typeof r?.entries === 'object' && r.entries !== null) {
    for (const [k, v] of Object.entries(r.entries as Record<string, unknown>)) {
      const e = v as Partial<Entry> | null
      if (typeof e !== 'object' || e === null || typeof e.name !== 'string' || !['recon', 'filed', 'skipped'].includes(String(e.phase))) continue
      if (e.phase === 'filed' && typeof e.filing !== 'object') continue
      entries[k] = { blocking: [], asked: [], round: 0, spawnedAt: 0, ...e } as Entry
    }
  }
  const rounds = (Array.isArray(r?.rounds) ? r.rounds : []).filter((x): x is Round =>
    typeof x === 'object' && x !== null && typeof (x as Round).id === 'number' && Array.isArray((x as Round).members))
    .map(x => ({ ...x, reported: Array.isArray(x.reported) ? x.reported : [] }))
  const top = Math.max(0, ...rounds.map(x => x.id))
  return { next: Math.max(top + 1, typeof r?.next === 'number' ? r.next : 1), entries, rounds }
}
