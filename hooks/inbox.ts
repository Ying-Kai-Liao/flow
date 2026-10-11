import { noteKey } from './state'
import { DEFAULT_WIDTH, renderTable } from './table'
import type { Inbox, Question } from '../types'

export type { Inbox, Question }

// The pure half of the decision inbox: agents ask structured questions with mcp__flow__ask, the
// addressee answers with mcp__flow__answer. The disk and messaging half is answerQuestion() in
// register.tsx. Standing answers (standing.ts) answer fresh questions in the ask handler through
// markAnswered's rule parameter.

export const EMPTY_INBOX: Inbox = { next: 1, items: [] }

export type AskedQuestion = {
  question: string
  options: string[]
  default: string
  blocking: boolean
  context?: string
  alternative?: string
  topic?: string
  guard?: { glob: string; test: string }
  // The worker's open question this one escalates to main (validated by the ask handler).
  forQ?: string
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

// The default as one of the options: its text (any case), or a 1-based index (a number or "2").
export function resolveDefault(options: string[], def: unknown): string | undefined {
  if (typeof def === 'string') {
    const hit = options.find(o => o.toLowerCase() === def.trim().toLowerCase())
    if (hit !== undefined) return hit
  }
  const n = typeof def === 'number' ? def : typeof def === 'string' && /^\d+$/.test(def.trim()) ? Number(def) : NaN
  return Number.isInteger(n) && n >= 1 && n <= options.length ? options[n - 1] : undefined
}

// The batch checked whole: one bad question refuses the call and nothing is recorded.
export function parseAsk(input: unknown): { questions: AskedQuestion[] } | { error: string } {
  const raw = (input as { questions?: unknown } | null)?.questions
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'questions must be a non-empty list.' }
  const out: AskedQuestion[] = []
  for (const [i, r] of raw.entries()) {
    const at = `questions[${i}]`
    if (typeof r !== 'object' || r === null) return { error: `${at} must be an object.` }
    const q = r as Record<string, unknown>
    const question = str(q.question)
    if (question === '') return { error: `${at}.question is required.` }
    if (!Array.isArray(q.options) || q.options.some(o => str(o) === '')) return { error: `${at}.options must be a list of option texts.` }
    const options = [...new Set((q.options as string[]).map(o => o.trim()))]
    if (options.length < 2) return { error: `${at}.options needs at least 2 different options.` }
    const def = resolveDefault(options, q.default)
    if (def === undefined) return { error: `${at}.default must be one of the options (its text, or its number 1..${options.length}).` }
    if (typeof q.blocking !== 'boolean') return { error: `${at}.blocking must be true or false.` }
    out.push({
      question, options, default: def, blocking: q.blocking,
      ...(str(q.context) !== '' ? { context: str(q.context) } : {}),
      ...(str(q.topic) !== '' ? { topic: str(q.topic) } : {}),
      ...(str(q.for) !== '' ? { forQ: str(q.for).toLowerCase() } : {}),
    })
  }
  return { questions: out }
}

export const KEEP = 'Keep'
export const OVERTURN = 'Undo'
export const isFyi = (q: Question): boolean => q.kind === 'fyi'

// An item by its id, or by the question id a decision had before it got its d-id.
export const findItem = (inbox: Inbox | undefined, id: string): Question | undefined => {
  const w = id.trim().toLowerCase()
  const items = (inbox ?? EMPTY_INBOX).items
  return items.find(x => x.id === w) ?? items.find(x => x.alias === w)
}

// How an env item reads in the inbox views.
export const envLabel = (q: Question): string =>
  q.env?.role === 'secret' ? ' SECRET' : q.env?.role === 'login' ? ' DO YOURSELF' : q.env?.role === 'apply' ? ' APPLY YOURSELF' : ' ENV CHANGE'

export type AskedFyi = { decision: string; why: string; alternative?: string; topic?: string }

// A decision batch checked whole, like parseAsk: one bad item refuses the call and nothing is recorded.
export function parseFyi(input: unknown): { items: AskedFyi[] } | { error: string } {
  const raw = (input as { items?: unknown } | null)?.items
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'items must be a non-empty list.' }
  const out: AskedFyi[] = []
  for (const [i, r] of raw.entries()) {
    const at = `items[${i}]`
    if (typeof r !== 'object' || r === null) return { error: `${at} must be an object.` }
    const f = r as Record<string, unknown>
    const decision = str(f.decision)
    if (decision === '') return { error: `${at}.decision is required.` }
    const why = str(f.why)
    if (why === '') return { error: `${at}.why is required.` }
    out.push({
      decision, why,
      ...(str(f.alternative) !== '' ? { alternative: str(f.alternative) } : {}),
      ...(str(f.topic) !== '' ? { topic: str(f.topic) } : {}),
    })
  }
  return { items: out }
}

// A decision as a stored question: the decision is the text, the why the context; Keep is the default.
export const fyiAsked = (f: AskedFyi): AskedQuestion => ({
  question: f.decision, options: [KEEP, OVERTURN], default: KEEP, blocking: false,
  context: f.why,
  ...(f.alternative !== undefined ? { alternative: f.alternative } : {}),
  ...(f.topic !== undefined ? { topic: f.topic } : {}),
})

const same = (a: string, b: string) => a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase()

export type Asker = { name: string; id?: string; isManager: boolean }

// Stores the batch. The same owner asking the same open question again gets the existing id back.
export function addQuestions(
  inbox: Inbox, asker: Asker, addressee: string, asked: AskedQuestion[], now: number, kind?: 'fyi',
): { inbox: Inbox; added: Array<{ q: Question; fresh: boolean }> } {
  let next = inbox.next
  let nextD = inbox.nextD ?? 1
  const items = [...inbox.items]
  const added: Array<{ q: Question; fresh: boolean }> = []
  for (const a of asked) {
    const dup = items.find(x => x.state === 'open' && x.owner === asker.name && isFyi(x) === (kind === 'fyi') && same(x.question, a.question))
    if (dup !== undefined) {
      added.push({ q: dup, fresh: false })
      continue
    }
    const q: Question = {
      id: kind === 'fyi' ? `d${nextD++}` : `q${next++}`, owner: asker.name, addressee, ...a, askedAt: now, state: 'open', delivered: false,
      ...(kind === 'fyi' ? { kind } : {}),
      ...(asker.id !== undefined ? { askerId: asker.id } : {}), askerIsManager: asker.isManager,
    }
    items.push(q)
    added.push({ q, fresh: true })
  }
  return { inbox: { ...inbox, next, ...(nextD > 1 ? { nextD } : {}), items }, added }
}

// Whose notes carry the lines about this question.
export const notesOwner = (q: Question): string => (q.askerIsManager ? q.owner : q.addressee)

// Same person, counting a manager's continuation (`name-2`).
export const isAddressee = (q: Question, by: string): boolean => by === q.addressee || noteKey(by) === noteKey(q.addressee)

export type Choice = { text: string; free: boolean }

// An option by its text, its letter (a, b, ..), or its number (1, 2, ..); anything else is free text.
export function parseChoice(options: string[], choice: string): Choice {
  const c = choice.trim()
  const byText = options.find(o => o.toLowerCase() === c.toLowerCase())
  if (byText !== undefined) return { text: byText, free: false }
  const letter = /^([a-z])[).:]?$/i.exec(c)
  if (letter) {
    const i = letter[1]!.toLowerCase().charCodeAt(0) - 97
    if (i < options.length) return { text: options[i]!, free: false }
  }
  const num = /^(\d+)[).:]?$/.exec(c)
  if (num) {
    const i = Number(num[1]) - 1
    if (i >= 0 && i < options.length) return { text: options[i]!, free: false }
  }
  return { text: c, free: true }
}

export type Marked =
  | { kind: 'ok'; inbox: Inbox; q: Question; answer: string; isDefault: boolean }
  | { kind: 'unknown' }
  | { kind: 'empty'; q: Question }
  | { kind: 'answered'; q: Question }
  | { kind: 'refused'; q: Question }

// Marks one question answered. choice null takes the question's default.
// A standing answer rule id as the last argument answers for the rule: no addressee check, and nothing is
// left to deliver (the ask result tells the asker).
// user: the person answering through the pane or /flow commands, who may answer any open question, also one addressed to a manager.
export function markAnswered(inbox: Inbox, wanted: string, choice: string | null, by: string, now: number, rule?: string, user = false): Marked {
  const q = findItem(inbox, wanted)
  const id = q?.id ?? wanted
  if (q === undefined) return { kind: 'unknown' }
  // A decision the decision API kept stays undoable: any answer but Keep takes it back. Keep itself changes nothing.
  const retake = q.state === 'answered' && q.auto !== undefined && isFyi(q) && choice !== null && parseChoice(q.options, choice).text !== KEEP
  if (q.state === 'answered' && !retake) return { kind: 'answered', q }
  // Main may also answer any decision: the user overrides what a manager has not looked at.
  if (rule === undefined && !user && !isAddressee(q, by) && !(isFyi(q) && by === 'main') && !(q.viaQ !== undefined && by === 'main')) return { kind: 'refused', q }
  const answer = choice === null ? q.default : parseChoice(q.options, choice).text
  if (answer === '') return { kind: 'empty', q }
  // Answering with the default's text counts as the default, however it was typed.
  const isDefault = answer === q.default
  const { auto: _kept, ...rest } = q
  const done: Question = {
    ...rest, state: 'answered', answer, answeredBy: by, answeredAt: now, delivered: rule !== undefined,
    ...(rule !== undefined ? { rule } : {}),
  }
  return { kind: 'ok', inbox: { ...inbox, items: inbox.items.map(x => (x.id === id ? done : x)) }, q: done, answer, isDefault }
}

export const openFor = (inbox: Inbox, who: string): Question[] =>
  inbox.items.filter(x => x.state === 'open' && (x.addressee === who || noteKey(x.addressee) === noteKey(who)))

export const openAll = (inbox: Inbox): Question[] => inbox.items.filter(x => x.state === 'open')

// The agents with an open blocking ask: they count as asking.
export const askingNames = (inbox: Inbox | undefined): string[] =>
  (inbox?.items ?? []).filter(x => x.state === 'open' && x.blocking && !isFyi(x)).map(x => x.owner)

// A non-blocking question answered with its default needs no message: the asker already went on it.
// A guard_tests suggestion is main's alone to decide: the reviewer that filed it is not told.
export const needsMessage = (q: Question, isDefault: boolean): boolean => q.guard === undefined && q.kind !== 'deploy' && q.kind !== 'env' && q.kind !== 'push' && q.kind !== 'reviewer' && (q.blocking || !isDefault)

// What the asker is told when its question is answered.
export function answerMessage(q: Question, answer: string, by: string, isDefault: boolean): string {
  if (isFyi(q)) {
    const instead = answer === OVERTURN || answer === 'Overturn' ? 'undo it' : answer
    return `flow: ${by} undid your decision ${q.id}: you decided "${q.question}". Instead: ${instead}. Change your work (on your branch / PR if it is still open) and say so in your report.`
  }
  const head = `flow: ${by} answered ${q.id}. Question: "${q.question}" Answer: ${answer}.`
  if (q.blocking) return `${head} Carry on from this answer.`
  return isDefault
    ? `${head} That is your default; nothing changes.`
    : `${head} You went on with the default "${q.default}": change your work to the answer, and say so in your report.`
}

// Questions only; decisions have their own section.
// A worker's question escalated through its manager's (viaQ) is one item with the manager's question: it is
// hidden while that one is open, and both close together.
export const hiddenByLink = (inbox: Inbox | undefined, q: Question): boolean => {
  if (q.viaQ === undefined) return false
  const via = findItem(inbox, q.viaQ)
  return via !== undefined && via.state === 'open'
}
const questionsOf = (inbox: Inbox | undefined): Question[] => openAll(inbox ?? EMPTY_INBOX).filter(q => !isFyi(q) && !hiddenByLink(inbox, q))
const fyisOf = (inbox: Inbox | undefined): Question[] => openAll(inbox ?? EMPTY_INBOX).filter(isFyi).sort((a, b) => a.askedAt - b.askedAt)

// Blocking questions first, then oldest first.
function ordered(items: Question[]): Question[] {
  return [...items].sort((a, b) => Number(b.blocking) - Number(a.blocking) || a.askedAt - b.askedAt)
}

export const age = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000))
  return m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`
}

const DAY = 86_400_000

// The questions a standing answer answered in the last 24 h, newest first, at most 10.
export const recentAuto = (inbox: Inbox | undefined, now: number): Question[] =>
  (inbox?.items ?? []).filter(q => q.state === 'answered' && q.rule !== undefined && now - (q.answeredAt ?? 0) <= DAY)
    .sort((a, b) => (b.answeredAt ?? 0) - (a.answeredAt ?? 0)).slice(0, 10)

// The decisions the decision API kept in the last 24 h and nobody has answered since, newest first.
export const recentKept = (inbox: Inbox | undefined, now: number): Question[] =>
  (inbox?.items ?? []).filter(q => q.state === 'answered' && q.auto !== undefined && now - (q.answeredAt ?? 0) <= DAY)
    .sort((a, b) => (b.answeredAt ?? 0) - (a.answeredAt ?? 0))

// --- The person's view (/flow inbox) and the commands behind it (/flow ok, no, answer). ---
// Everything that decides what is grouped, collapsed or refused is a pure function here, so the Flow pane can reuse it.

// The user may answer any open question; one addressed to a manager is answered over the manager's head, and the manager is told.
export const overridesManager = (q: Question): boolean => !isFyi(q) && !isAddressee(q, 'main')

// Deploy, env and push items and a guard_tests suggestion change something outside the chat: a bulk
// `/flow ok` never answers them; the person names the choice with `/flow answer`.
export const needsExplicitAnswer = (q: Question): boolean => q.kind === 'deploy' || q.kind === 'env' || q.kind === 'push' || q.kind === 'reviewer' || q.guard !== undefined

// One line's worth of text: whitespace folded, cut at max with "...".
export function clip(text: string, max = 100): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 3)).trimEnd()}...`
}

// Exactly one line of at most `width` columns: whitespace folded, cut with a single "…".
export function fit(text: string, width: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  const w = Math.max(1, width)
  return t.length <= w ? t : `${t.slice(0, w - 1).trimEnd()}…`
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// "2 questions (1 blocking), 9 decisions." for what is open.
function summary(inbox: Inbox | undefined): string {
  const qs = questionsOf(inbox)
  const f = fyisOf(inbox).length
  const blocking = qs.filter(q => q.blocking).length
  const parts = [
    ...(qs.length > 0 ? [`${plural(qs.length, 'question')}${blocking > 0 ? ` (${blocking} blocking)` : ''}`] : []),
    ...(f > 0 ? [plural(f, 'decision')] : []),
  ]
  return parts.length === 0 ? 'Nothing open.' : `${parts.join(', ')}.`
}

// What is left after a command: one line.
export const stillOpen = (inbox: Inbox | undefined): string => {
  const s = summary(inbox)
  return s === 'Nothing open.' ? 'Nothing is left open.' : `Still open: ${s} (/flow inbox lists them)`
}

// The words after `/flow ok`: which ids to keep or take the default of, and the lines for words that name nothing to answer.
// No words: every open decision. A qN or dN (also the old question id of a decision) is passed on as it is (the answer step
// reports unknown or answered ids), except an item that needs an explicit answer. Any other word is an owner or a topic and
// expands to that owner's or topic's open decisions.
export function expandOk(inbox: Inbox | undefined, words: string[]): { ids: string[]; lines: string[] } {
  const box = inbox ?? EMPTY_INBOX
  const ids: string[] = []
  const lines: string[] = []
  const add = (id: string) => { if (!ids.includes(id)) ids.push(id) }
  if (words.length === 0) {
    for (const q of fyisOf(box)) add(q.id)
    if (ids.length === 0) lines.push('No open decisions to keep.')
    return { ids, lines }
  }
  for (const w of words) {
    if (/^[qd]\d+$/i.test(w)) {
      const q = findItem(box, w)
      if (q !== undefined && q.state === 'open' && needsExplicitAnswer(q)) lines.push(`${q.id}: answer it explicitly: /flow answer ${q.id} <choice>`)
      else add(q?.id ?? w.toLowerCase())
      continue
    }
    const key = noteKey(w)
    const hits = fyisOf(box).filter(q => noteKey(q.owner) === key || (q.topic !== undefined && q.topic.toLowerCase() === w.toLowerCase()))
    if (hits.length === 0) lines.push(`${w}: no open decisions for that owner or topic.`)
    for (const q of hits) add(q.id)
  }
  return { ids, lines }
}

export const tagsOf = (q: Question): string => [
  q.blocking ? 'BLOCKING' : '',
  q.kind === 'deploy' ? 'NEEDS YOU: DEPLOY APPROVAL' : q.kind === 'push' ? 'NEEDS YOU: PUSH' : q.kind === 'reviewer' ? 'NEEDS YOU: REVIEWER' : q.kind === 'env' ? `NEEDS YOU:${envLabel(q)}` : q.guard !== undefined ? 'NEEDS YOU: GUARD TEST' : '',
  q.viaQ !== undefined ? `ESCALATED ${q.escalated ?? `via ${q.viaQ}`}` : q.escalated !== undefined ? `ESCALATED (rule ${q.escalated}), for main` : '',
  q.topic && !isFyi(q) ? `[${q.topic}]` : '',
].filter(x => x !== '').join(' ')

const optionLines = (q: Question, pad: string): string[] =>
  q.options.map((opt, i) => `${pad}${String.fromCharCode(97 + i)}) ${opt}${opt === q.default ? ' (default)' : ''}`)

// Options on one line: "a) Keep (default)  b) Undo".
const optionsLine = (q: Question): string => q.options.map((opt, i) => `${String.fromCharCode(97 + i)}) ${opt}${opt === q.default ? ' (default)' : ''}`).join('  ')

function questionLines(q: Question, now: number): string[] {
  const tags = tagsOf(q)
  const who = isAddressee(q, 'main') ? q.owner : `${q.owner}, for ${q.addressee}`
  return [
    `  ${q.id}${tags === '' ? '' : ` ${tags}`} (${who}, ${age(now - q.askedAt)}): ${q.guard !== undefined ? q.question : clip(q.question)}`,
    `      ${clip(optionsLine(q), 110)}`,
  ]
}

// --- The pane's inbox view: the same order as renderInbox, as rows a person moves over. ---

export type PaneRow = {
  // The question's or decision's id; the group's fold key (grp:<owner>, FOLD_KEY) for a collapsed group's row.
  key: string
  ids: string[]
  // Absent on a collapsed group's row.
  q?: Question
  // The card the row belongs to: on a collapsed group's single row, and on every item row of an expanded one.
  group?: PaneGroup
}

// An owner's decisions and questions drawn as one card; the routine decisions are one such card too.
export type PaneGroup = {
  // grp:<owner>, or FOLD_KEY for the routine card; the key of its fold state.
  key: string
  owner: string
  // How many decisions it holds (the questions are not counted) and whether any question is among its items.
  count: number
  asks: boolean
  blocking: boolean
  labels: string[]
  routine: boolean
  expanded: boolean
  // The first item row: where the highlight goes when the card opens.
  firstKey: string
}

export const FOLD_KEY = 'fold'

// Decisions that are routine by their topic: sizing calls nobody needs to weigh one by one.
export const ROUTINE_TOPICS = ['worker-size', 'manager-size']
const isRoutine = (q: Question): boolean => q.topic !== undefined && ROUTINE_TOPICS.includes(q.topic.toLowerCase())

// The names (as noteKeys) of agents that are over: no live roster row, and an ended row or a remembered
// fact says they finished. A name never seen is not counted, so a decision of an unknown owner stays visible.
export function endedOwners(rows: Array<{ name?: string; status: string }>, seen: Record<string, { status: string }>): Set<string> {
  const over = new Set(['completed', 'failed', 'killed'])
  const live = new Set(rows.filter(a => a.name !== undefined && !over.has(a.status)).map(a => noteKey(a.name!)))
  const out = new Set<string>()
  for (const a of rows) if (a.name !== undefined && over.has(a.status) && !live.has(noteKey(a.name))) out.add(noteKey(a.name))
  for (const [name, fact] of Object.entries(seen)) if (over.has(fact.status) && !live.has(noteKey(name))) out.add(noteKey(name))
  return out
}

// What the inbox list folds into one row: open decisions that are routine (by topic) or whose owner is over.
// Protected items (deploy, env, push, reviewer, guard) are never folded. ended: noteKeys from endedOwners.
export function foldedOf(inbox: Inbox | undefined, ended: Set<string> | undefined): { folded: Question[]; shown: Question[]; labels: string[] } {
  const folded: Question[] = []
  const shown: Question[] = []
  const labels: string[] = []
  for (const q of fyisOf(inbox)) {
    const finished = ended?.has(noteKey(q.owner)) === true
    if (needsExplicitAnswer(q) || (!isRoutine(q) && !finished)) { shown.push(q); continue }
    folded.push(q)
    const l = isRoutine(q) ? q.topic!.toLowerCase() : 'finished agents'
    if (!labels.includes(l)) labels.push(l)
  }
  labels.sort((a, b) => Number(a === 'finished agents') - Number(b === 'finished agents') || a.localeCompare(b))
  return { folded, shown, labels }
}

// Whether a card shows its items: its entry in the fold map, else open for an owner and closed for the routine card.
export const groupExpanded = (folds: Record<string, boolean>, key: string): boolean => folds[key] ?? key !== FOLD_KEY

export const groupKey = (owner: string): string => `grp:${owner}`

// The inbox as cards, one per owner in the order the owners first appear (blocking questions first, then
// the open decisions, newest first), the routine card last. An expanded card lists its questions, then its
// decisions; a collapsed one is a single row. Folded decisions stay open and undoable.
export function paneRows(inbox: Inbox | undefined, ended?: Set<string>, folds: Record<string, boolean> = {}): PaneRow[] {
  const { folded, shown, labels } = foldedOf(inbox, ended)
  const flat = [...ordered(questionsOf(inbox)), ...[...shown].reverse()]
  const owners: string[] = []
  for (const q of flat) if (!owners.includes(q.owner)) owners.push(q.owner)
  const rows: PaneRow[] = []
  const card = (items: Question[], info: Pick<PaneGroup, 'key' | 'owner' | 'labels' | 'routine'>) => {
    const decisions = items.filter(isFyi)
    const group: PaneGroup = {
      ...info, count: decisions.length, asks: items.some(q => !isFyi(q)), blocking: items.some(q => !isFyi(q) && q.blocking),
      expanded: groupExpanded(folds, info.key), firstKey: items[0]!.id,
    }
    if (group.expanded) rows.push(...items.map(q => ({ key: q.id, ids: [q.id], q, group })))
    else rows.push({ key: group.key, ids: decisions.map(q => q.id), group })
  }
  for (const owner of owners) {
    const own = flat.filter(q => q.owner === owner)
    card([...own.filter(q => !isFyi(q)), ...own.filter(isFyi)], { key: groupKey(owner), owner, labels: [], routine: false })
  }
  if (folded.length > 0) card([...folded].reverse(), { key: FOLD_KEY, owner: 'routine', labels, routine: true })
  return rows
}

// "12 routine decisions (worker-size, finished agents)".
export const foldText = (count: number, labels: string[]): string => `${plural(count, 'routine decision')} (${labels.join(', ')})`

// A card's title line: "ctx-init-tip · 2 decisions · asks", "routine · 5 (manager-size, worker-size)".
export const groupTitle = (g: PaneGroup): string => g.routine
  ? `routine · ${g.count} (${g.labels.join(', ')})`
  : [g.owner, ...(g.count > 0 ? [plural(g.count, 'decision')] : []), ...(g.asks ? ['asks'] : [])].join(' · ')

// A row's one line in the pane's list.
export function paneRowText(r: PaneRow): string {
  if (r.q === undefined) return `${r.group!.expanded ? '▾' : '▸'} ${groupTitle(r.group!)}`
  const q = r.q!
  if (isFyi(q)) return `${q.id} ${q.owner}${q.topic ? ` [${q.topic}]` : ''}: ${clip(q.question, 80)}`
  const tags = tagsOf(q)
  return `${q.id}${tags === '' ? '' : ` ${tags}`} ${isAddressee(q, 'main') ? q.owner : `${q.owner}, for ${q.addressee}`}: ${q.guard !== undefined ? q.question : clip(q.question, 80)}`
}

// What y and c do on a collapsed card's row; the pane's key line shows it while that row is hot.
export const groupHint = (g: PaneGroup): string => g.count > 0 ? `y keeps all ${g.count} · c expands` : 'c expands to answer its questions'

// Why `y`, `w` and a group keep refuse an item, and the explicit way. undefined: the item may be answered by default.
export function protectedWhy(q: Question): string | undefined {
  if (!needsExplicitAnswer(q)) return undefined
  const what = q.kind === 'deploy' ? 'a deploy approval' : q.kind === 'push' ? 'a push' : q.kind === 'reviewer' ? 'a reviewer retry' : q.kind === 'env' ? 'an env change' : 'a guard test suggestion'
  return `${q.id} is ${what}: y never answers it. Press its digit or letter, or r and type your answer.`
}

export const DECISIONS_SHOWN = 15

// The decisions as one flat table, newest first: id, from, headline, age. The full text and the why are in /flow inbox <id>.
export function decisionRows(decisions: Question[], now: number, all: boolean, width = DEFAULT_WIDTH): string[] {
  const newest = [...decisions].reverse()
  return renderTable(
    [{ header: 'id' }, { header: 'from', max: 16, drop: 1 }, { header: 'decision', flex: true, min: 20 }, { header: 'age', align: 'right' }],
    newest.map(q => [q.id, q.owner, q.question, age(now - q.askedAt)]),
    width,
    { limit: all ? undefined : DECISIONS_SHOWN, more: m => `+${m} more: /flow inbox decisions` },
  )
}

// /flow inbox: a summary line, the questions (blocking first), the decisions as a flat table, then what a standing answer did.
// opts.all: every decision, not just the newest few.
// Routine decisions and those of finished agents (opts.ended) are one line, unless opts.all lists everything.
export function renderInbox(inbox: Inbox | undefined, now: number, opts: { all?: boolean; width?: number; ended?: Set<string> } = {}): string {
  const open = ordered(questionsOf(inbox))
  const allDecisions = fyisOf(inbox)
  const fold = foldedOf(inbox, opts.ended)
  const decisions = opts.all === true ? allDecisions : fold.shown
  const auto = recentAuto(inbox, now)
  const autoLines = auto.length === 0 ? [] : [
    '',
    `Auto-answered (last 24 h, ${auto.length} shown; to revoke a rule, ask main to remove it):`,
    ...auto.map(q => `  ${q.id} ${q.owner}: ${clip(q.question)} -> ${clip(q.answer ?? '', 60)} (rule ${q.rule ?? '?'})`),
  ]
  const kept = recentKept(inbox, now)
  const keptLines = kept.length === 0 ? [] : [
    '',
    `Kept by the decision API (last 24 h, ${kept.length}; undo: /flow no <id> <what instead>):`,
    ...kept.slice(0, 10).map(q => `  ${q.id} ${q.owner}: ${clip(q.question)} -> kept by ${autoWho(q)}`),
  ]
  const archived = archiveOf(inbox).length
  const archiveLine = archived === 0 ? [] : [`Archive: ${plural(archived, 'answered item')} (/flow inbox archive).`]
  if (open.length === 0 && allDecisions.length === 0) return ['No open questions.', ...archiveLine, ...autoLines, ...keptLines].join('\n')
  const lines = [summary(inbox)]
  if (open.length > 0) {
    lines.push('', 'Questions')
    for (const q of open) lines.push(...questionLines(q, now))
  }
  if (decisions.length > 0) {
    lines.push('', 'Decisions agents made (keep or undo)', ...decisionRows(decisions, now, opts.all === true, opts.width))
  }
  if (opts.all !== true && fold.folded.length > 0) {
    lines.push('', `${foldText(fold.folded.length, fold.labels)} folded: /flow ok keeps them with the rest, /flow inbox decisions lists them.`)
  }
  const cmds = [
    ...(allDecisions.length > 0 ? ['Keep all: /flow ok. Keep some: /flow ok d10 d11 or /flow ok <owner or topic>. Undo: /flow no d12 <what instead>.'] : []),
    ...(open.length > 0 ? ['Answer a question: /flow answer q1 <letter or your own words>; its default: /flow ok q1 (not for NEEDS YOU items).'] : []),
  ]
  lines.push('', ...cmds, ...archiveLine)
  return [...lines, ...autoLines, ...keptLines].join('\n')
}

// The archive: answered questions and kept or undone decisions, newest answer first.
export const archiveOf = (inbox: Inbox | undefined): Question[] =>
  (inbox?.items ?? []).filter(q => q.state === 'answered').sort((a, b) => (b.answeredAt ?? 0) - (a.answeredAt ?? 0))

export const ARCHIVE_SHOWN = 50

export const archiveWho = (q: Question): string => (q.rule !== undefined ? `standing answer ${q.rule}` : q.auto !== undefined ? autoWho(q) : q.answeredBy ?? '?')
// "jev (0.93)": the decision API that kept it and how sure it was.
export const autoWho = (q: Question): string => `${q.auto?.by ?? '?'} (${(q.auto?.confidence ?? 0).toFixed(2)})`

// One archived item as a line: id, answer, who and when, then the question.
// A decision's answer read as a statement: Keep (or its default) is kept, anything else is what to do instead.
export const decisionOutcome = (q: Question): string => {
  const a = (q.answer ?? '').trim()
  if (a === '' || a.toLowerCase() === KEEP.toLowerCase() || a === q.default) return q.auto !== undefined ? `Kept by ${autoWho(q)}` : 'Kept'
  return a.toLowerCase() === OVERTURN.toLowerCase() ? 'Undone' : `Undone: ${a}`
}
export const decisionOutcomeText = (q: Question, now: number): string =>
  q.auto !== undefined ? `${decisionOutcome(q)}${q.answeredAt === undefined ? '' : ` (${age(now - q.answeredAt)} ago)`}` :
  `${decisionOutcome(q)} (by ${archiveWho(q)}${q.answeredAt === undefined ? '' : `, ${age(now - q.answeredAt)} ago`})`

export const archiveRowText = (q: Question, now: number): string =>
  isFyi(q) && q.auto !== undefined ? `${q.id} ${clip(decisionOutcome(q), 40)} (${age(now - (q.answeredAt ?? q.askedAt))} ago): ${clip(q.question, 80)}` :
  isFyi(q) ? `${q.id} ${clip(decisionOutcome(q), 40)} (by ${archiveWho(q)}, ${age(now - (q.answeredAt ?? q.askedAt))} ago): ${clip(q.question, 80)}` :
  `${q.id} ${clip(q.answer ?? '', 40)} (by ${archiveWho(q)}, ${age(now - (q.answeredAt ?? q.askedAt))} ago): ${clip(q.question, 80)}`

// /flow inbox archive: the newest answered items; all: every one.
export function renderArchive(inbox: Inbox | undefined, now: number, all = false): string {
  const items = archiveOf(inbox)
  if (items.length === 0) return 'The archive is empty: nothing has been answered yet.'
  const shown = all ? items : items.slice(0, ARCHIVE_SHOWN)
  return [
    `Archive: ${plural(items.length, 'answered item')}, newest first.`,
    ...shown.map(q => `  ${archiveRowText(q, now)}`),
    ...(shown.length < items.length ? [`+${items.length - shown.length} older: /flow inbox archive all`] : []),
    'One in full: /flow inbox <id>.',
  ].join('\n')
}

// /flow inbox <id>: one item in full, answered or not.
export function renderItem(inbox: Inbox | undefined, id: string, now: number): string {
  const q = findItem(inbox, id)
  if (q === undefined) return `${id}: no such question or decision.`
  const kind = isFyi(q) ? 'decision' : q.kind === 'deploy' ? 'deploy approval' : q.kind === 'push' ? 'push' : q.kind === 'reviewer' ? 'reviewer retry' : q.kind === 'env' ? 'env change' : 'question'
  const tags = tagsOf(q)
  const lines = [
    `${q.id} ${kind}${tags === '' ? '' : ` ${tags}`}${isFyi(q) && q.topic ? ` [${q.topic}]` : ''} (from ${q.owner}, for ${q.addressee}, ${age(now - q.askedAt)} ago)${q.alias === undefined ? '' : ` (earlier id ${q.alias})`}`,
    q.question,
    ...(q.context ? ['', `why: ${q.context}`] : []),
    ...(q.alternative ? [`instead could: ${q.alternative}`] : []),
    '',
    ...optionLines(q, '  '),
  ]
  if (q.state === 'answered') lines.push('', `Answered: ${q.answer ?? ''} (by ${archiveWho(q)}${q.answeredAt === undefined ? '' : `, ${age(now - q.answeredAt)} ago`})`)
  else {
    lines.push('', isFyi(q) ? `Keep: /flow ok ${q.id}. Undo: /flow no ${q.id} <what instead>.` : `Answer: /flow answer ${q.id} <letter or your own words>${needsExplicitAnswer(q) ? '' : `, or /flow ok ${q.id} for the default`}.`)
    if (overridesManager(q)) lines.push(`It is for ${q.addressee}; answering it overrides ${q.addressee}, who is told.`)
  }
  return lines.join('\n')
}

// The head of mcp__flow__status: a count and one line per open question, blocking first.
export function inboxHead(inbox: Inbox | undefined, now = Date.now()): string[] {
  const open = ordered(questionsOf(inbox))
  const fyi = fyisOf(inbox).length
  const auto = recentAuto(inbox, now).length
  const autoLine = auto === 0 ? [] : [`Inbox: ${auto} auto-answered by standing answers in the last 24 h (/flow inbox).`]
  const kept = recentKept(inbox, now)
  const keptBy = [...new Set(kept.map(q => q.auto?.by ?? '?'))].join(', ')
  const keptLine = kept.length === 0 ? [] : [`Inbox: ${plural(kept.length, 'decision')} kept by ${keptBy} (undo with mcp__flow__answer).`]
  const fyiLine = fyi === 0 ? [] : [`Inbox: ${plural(fyi, 'decision')} (made by agents, non-blocking; /flow inbox lists them, mcp__flow__answer defaults true keeps them).`]
  if (open.length === 0) return [...fyiLine, ...keptLine, ...autoLine]
  const blocking = open.filter(q => q.blocking).length
  return [
    `Inbox: ${open.length} open${blocking ? `, ${blocking} blocking` : ''} (/flow inbox shows them with options):`,
    ...open.map(q => `  ${q.id} ${q.blocking ? 'BLOCKING ' : ''}${q.owner}: ${q.question.slice(0, 140)}`),
    ...fyiLine,
    ...keptLine,
    ...autoLine,
  ]
}

// A stored inbox read back from disk; anything malformed is dropped.
// Decisions filed before they had their own ids sit under q-ids: each gets a d-id and keeps the q-id as its alias.
// The numbers follow askedAt, then the old id, so every read of the same file gives the same ids, and they continue
// after the highest d-id already in use. Neither counter ever hands out a number an id or an alias already holds.
export function normalizeInbox(raw: unknown): Inbox {
  const r = raw as { next?: unknown; nextD?: unknown; items?: unknown } | null
  let items = (Array.isArray(r?.items) ? r.items : []).filter((x): x is Question =>
    typeof x === 'object' && x !== null && typeof (x as Question).id === 'string' && typeof (x as Question).question === 'string' &&
    Array.isArray((x as Question).options) && ((x as Question).state === 'open' || (x as Question).state === 'answered'))
  const num = (id: string | undefined, re: RegExp) => Number(re.exec(id ?? '')?.[1] ?? 0)
  const topD = Math.max(0, ...items.map(x => num(x.id, /^d(\d+)$/)))
  let nextD = Math.max(topD + 1, typeof r?.nextD === 'number' ? r.nextD : 1)
  const old = items.filter(x => isFyi(x) && /^q\d+$/.test(x.id)).sort((a, b) => a.askedAt - b.askedAt || num(a.id, /^q(\d+)$/) - num(b.id, /^q(\d+)$/))
  if (old.length > 0) {
    const moved = new Map(old.map(x => [x, { ...x, id: `d${nextD++}`, alias: x.id }]))
    items = items.map(x => moved.get(x) ?? x)
  }
  const top = Math.max(0, ...items.map(x => Math.max(num(x.id, /^q(\d+)$/), num(x.alias, /^q(\d+)$/))))
  return {
    next: Math.max(top + 1, typeof r?.next === 'number' ? r.next : 1),
    ...(nextD > 1 ? { nextD } : {}),
    items,
  }
}

// The ask's `for` links: each must name an open question addressed to this manager that is not escalated yet.
// An error text refuses the whole batch.
export function checkEscalations(inbox: Inbox, name: string, isManager: boolean, asked: AskedQuestion[]): string | undefined {
  for (const a of asked) {
    if (a.forQ === undefined) continue
    if (!isManager) return `for: only a manager escalates a worker's question (${a.forQ}).`
    const w = findItem(inbox, a.forQ)
    if (w === undefined || w.state !== 'open' || isFyi(w) || !isAddressee(w, name)) return `for: ${a.forQ} is not an open question addressed to ${name}.`
    if (w.escalated !== undefined || w.viaQ !== undefined) return `for: ${a.forQ} is already escalated to main (${w.escalated ?? w.viaQ}).`
  }
  return undefined
}

// Marks the worker's question escalated by the manager's new one (fresh ones only).
export function linkEscalations(inbox: Inbox, added: Array<{ q: Question; fresh: boolean }>): Inbox {
  let items = inbox.items
  for (const { q, fresh } of added) {
    if (!fresh || q.forQ === undefined) continue
    const wid = findItem(inbox, q.forQ)?.id
    items = items.map(x => (x.id === wid ? { ...x, escalated: `via ${q.id}`, viaQ: q.id } : x))
  }
  return { ...inbox, items }
}
