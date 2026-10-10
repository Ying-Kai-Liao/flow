import { noteKey } from './state'
import { renderTable } from './table'
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
  topic?: string
  guard?: { glob: string; test: string }
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
  context: f.alternative === undefined ? f.why : `${f.why} (otherwise: ${f.alternative})`,
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
  if (q.state === 'answered') return { kind: 'answered', q }
  // Main may also answer any decision: the user overrides what a manager has not looked at.
  if (rule === undefined && !user && !isAddressee(q, by) && !(isFyi(q) && by === 'main')) return { kind: 'refused', q }
  const answer = choice === null ? q.default : parseChoice(q.options, choice).text
  if (answer === '') return { kind: 'empty', q }
  // Answering with the default's text counts as the default, however it was typed.
  const isDefault = answer === q.default
  const done: Question = {
    ...q, state: 'answered', answer, answeredBy: by, answeredAt: now, delivered: rule !== undefined,
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
export const needsMessage = (q: Question, isDefault: boolean): boolean => q.guard === undefined && q.kind !== 'deploy' && q.kind !== 'env' && q.kind !== 'push' && (q.blocking || !isDefault)

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
const questionsOf = (inbox: Inbox | undefined): Question[] => openAll(inbox ?? EMPTY_INBOX).filter(q => !isFyi(q))
const fyisOf = (inbox: Inbox | undefined): Question[] => openAll(inbox ?? EMPTY_INBOX).filter(isFyi).sort((a, b) => a.askedAt - b.askedAt)

// Blocking questions first, then oldest first.
function ordered(items: Question[]): Question[] {
  return [...items].sort((a, b) => Number(b.blocking) - Number(a.blocking) || a.askedAt - b.askedAt)
}

const age = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000))
  return m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`
}

const DAY = 86_400_000

// The questions a standing answer answered in the last 24 h, newest first, at most 10.
export const recentAuto = (inbox: Inbox | undefined, now: number): Question[] =>
  (inbox?.items ?? []).filter(q => q.state === 'answered' && q.rule !== undefined && now - (q.answeredAt ?? 0) <= DAY)
    .sort((a, b) => (b.answeredAt ?? 0) - (a.answeredAt ?? 0)).slice(0, 10)

// --- The person's view (/flow inbox) and the commands behind it (/flow ok, no, answer). ---
// Everything that decides what is grouped, collapsed or refused is a pure function here, so the Flow pane can reuse it.

// The user may answer any open question; one addressed to a manager is answered over the manager's head, and the manager is told.
export const overridesManager = (q: Question): boolean => !isFyi(q) && !isAddressee(q, 'main')

// Deploy, env and push items and a guard_tests suggestion change something outside the chat: a bulk
// `/flow ok` never answers them; the person names the choice with `/flow answer`.
export const needsExplicitAnswer = (q: Question): boolean => q.kind === 'deploy' || q.kind === 'env' || q.kind === 'push' || q.guard !== undefined

// One line's worth of text: whitespace folded, cut at max with "...".
export function clip(text: string, max = 100): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 3)).trimEnd()}...`
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

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
  q.kind === 'deploy' ? 'NEEDS YOU: DEPLOY APPROVAL' : q.kind === 'push' ? 'NEEDS YOU: PUSH' : q.kind === 'env' ? `NEEDS YOU:${envLabel(q)}` : q.guard !== undefined ? 'NEEDS YOU: GUARD TEST' : '',
  q.escalated !== undefined ? `ESCALATED (rule ${q.escalated}), for main` : '',
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
  // The question's or decision's id.
  key: string
  ids: string[]
  q: Question
}

// Questions (blocking first, then oldest), then every open decision, newest first. Nothing is folded away.
export function paneRows(inbox: Inbox | undefined): PaneRow[] {
  return [...ordered(questionsOf(inbox)), ...[...fyisOf(inbox)].reverse()].map(q => ({ key: q.id, ids: [q.id], q }))
}

// A row's one line in the pane's list.
export function paneRowText(r: PaneRow): string {
  const q = r.q
  if (isFyi(q)) return `${q.id} ${q.owner}${q.topic ? ` [${q.topic}]` : ''}: ${clip(q.question, 80)}`
  const tags = tagsOf(q)
  return `${q.id}${tags === '' ? '' : ` ${tags}`} ${isAddressee(q, 'main') ? q.owner : `${q.owner}, for ${q.addressee}`}: ${q.guard !== undefined ? q.question : clip(q.question, 80)}`
}

// Why `y`, `w` and a group keep refuse an item, and the explicit way. undefined: the item may be answered by default.
export function protectedWhy(q: Question): string | undefined {
  if (!needsExplicitAnswer(q)) return undefined
  const what = q.kind === 'deploy' ? 'a deploy approval' : q.kind === 'push' ? 'a push' : q.kind === 'env' ? 'an env change' : 'a guard test suggestion'
  return `${q.id} is ${what}: y never answers it. Press its digit or letter, or r and type your answer.`
}

export const DECISIONS_SHOWN = 15

// The decisions as one flat table, newest first: id, from, headline, age. The full text and the why are in /flow inbox <id>.
export function decisionRows(decisions: Question[], now: number, all: boolean, width = 100): string[] {
  const newest = [...decisions].reverse()
  const shown = all ? newest : newest.slice(0, DECISIONS_SHOWN)
  const table = renderTable(
    [{ header: 'id' }, { header: 'from', max: 16, drop: 1 }, { header: 'decision', flex: true, min: 20 }, { header: 'age', align: 'right' }],
    shown.map(q => [q.id, q.owner, q.question, age(now - q.askedAt)]),
    width,
    { indent: 2 },
  )
  return newest.length > shown.length ? [...table, `  +${newest.length - shown.length} more: /flow inbox decisions`] : table
}

// /flow inbox: a summary line, the questions (blocking first), the decisions as a flat table, then what a standing answer did.
// opts.all: every decision, not just the newest few.
export function renderInbox(inbox: Inbox | undefined, now: number, opts: { all?: boolean; width?: number } = {}): string {
  const open = ordered(questionsOf(inbox))
  const decisions = fyisOf(inbox)
  const auto = recentAuto(inbox, now)
  const autoLines = auto.length === 0 ? [] : [
    '',
    `Auto-answered (last 24 h, ${auto.length} shown; to revoke a rule, ask main to remove it):`,
    ...auto.map(q => `  ${q.id} ${q.owner}: ${clip(q.question)} -> ${clip(q.answer ?? '', 60)} (rule ${q.rule ?? '?'})`),
  ]
  if (open.length === 0 && decisions.length === 0) return ['No open questions.', ...autoLines].join('\n')
  const lines = [summary(inbox)]
  if (open.length > 0) {
    lines.push('', 'Questions')
    for (const q of open) lines.push(...questionLines(q, now))
  }
  if (decisions.length > 0) {
    lines.push('', 'Decisions agents made (keep or undo)', ...decisionRows(decisions, now, opts.all === true, opts.width))
  }
  const cmds = [
    ...(decisions.length > 0 ? ['Keep all: /flow ok. Keep some: /flow ok d10 d11 or /flow ok <owner or topic>. Undo: /flow no d12 <what instead>.'] : []),
    ...(open.length > 0 ? ['Answer a question: /flow answer q1 <letter or your own words>; its default: /flow ok q1 (not for NEEDS YOU items).'] : []),
  ]
  lines.push('', ...cmds)
  return [...lines, ...autoLines].join('\n')
}

// /flow inbox <id>: one item in full, answered or not.
export function renderItem(inbox: Inbox | undefined, id: string, now: number): string {
  const q = findItem(inbox, id)
  if (q === undefined) return `${id}: no such question or decision.`
  const kind = isFyi(q) ? 'decision' : q.kind === 'deploy' ? 'deploy approval' : q.kind === 'push' ? 'push' : q.kind === 'env' ? 'env change' : 'question'
  const tags = tagsOf(q)
  const lines = [
    `${q.id} ${kind}${tags === '' ? '' : ` ${tags}`}${isFyi(q) && q.topic ? ` [${q.topic}]` : ''} (from ${q.owner}, for ${q.addressee}, ${age(now - q.askedAt)} ago)${q.alias === undefined ? '' : ` (earlier id ${q.alias})`}`,
    q.question,
    ...(q.context ? ['', `why: ${q.context}`] : []),
    '',
    ...optionLines(q, '  '),
  ]
  if (q.state === 'answered') lines.push('', `Answered: ${q.answer ?? ''} (by ${q.answeredBy ?? '?'})`)
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
  const fyiLine = fyi === 0 ? [] : [`Inbox: ${plural(fyi, 'decision')} (made by agents, non-blocking; /flow inbox lists them, mcp__flow__answer defaults true keeps them).`]
  if (open.length === 0) return [...fyiLine, ...autoLine]
  const blocking = open.filter(q => q.blocking).length
  return [
    `Inbox: ${open.length} open${blocking ? `, ${blocking} blocking` : ''} (/flow inbox shows them with options):`,
    ...open.map(q => `  ${q.id} ${q.blocking ? 'BLOCKING ' : ''}${q.owner}: ${q.question.slice(0, 140)}`),
    ...fyiLine,
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
