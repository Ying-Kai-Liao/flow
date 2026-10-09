import { noteKey } from './state'
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

const same = (a: string, b: string) => a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase()

export type Asker = { name: string; id?: string; isManager: boolean }

// Stores the batch. The same owner asking the same open question again gets the existing id back.
export function addQuestions(
  inbox: Inbox, asker: Asker, addressee: string, asked: AskedQuestion[], now: number,
): { inbox: Inbox; added: Array<{ q: Question; fresh: boolean }> } {
  let next = inbox.next
  const items = [...inbox.items]
  const added: Array<{ q: Question; fresh: boolean }> = []
  for (const a of asked) {
    const dup = items.find(x => x.state === 'open' && x.owner === asker.name && same(x.question, a.question))
    if (dup !== undefined) {
      added.push({ q: dup, fresh: false })
      continue
    }
    const q: Question = {
      id: `q${next++}`, owner: asker.name, addressee, ...a, askedAt: now, state: 'open', delivered: false,
      ...(asker.id !== undefined ? { askerId: asker.id } : {}), askerIsManager: asker.isManager,
    }
    items.push(q)
    added.push({ q, fresh: true })
  }
  return { inbox: { next, items }, added }
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
export function markAnswered(inbox: Inbox, id: string, choice: string | null, by: string, now: number, rule?: string): Marked {
  const q = inbox.items.find(x => x.id === id)
  if (q === undefined) return { kind: 'unknown' }
  if (q.state === 'answered') return { kind: 'answered', q }
  if (rule === undefined && !isAddressee(q, by)) return { kind: 'refused', q }
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
  (inbox?.items ?? []).filter(x => x.state === 'open' && x.blocking).map(x => x.owner)

// A non-blocking question answered with its default needs no message: the asker already went on it.
// A guard_tests suggestion is main's alone to decide: the queue that filed it is not told.
export const needsMessage = (q: Question, isDefault: boolean): boolean => q.guard === undefined && (q.blocking || !isDefault)

// What the asker is told when its question is answered.
export function answerMessage(q: Question, answer: string, by: string, isDefault: boolean): string {
  const head = `flow: ${by} answered ${q.id}. Question: "${q.question}" Answer: ${answer}.`
  if (q.blocking) return `${head} Carry on from this answer.`
  return isDefault
    ? `${head} That is your default; nothing changes.`
    : `${head} You went on with the default "${q.default}": change your work to the answer, and say so in your report.`
}

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

// /flow inbox: the open questions grouped by owner, blocking first, ready to answer.
export function renderInbox(inbox: Inbox | undefined, now: number): string {
  const open = ordered(openAll(inbox ?? EMPTY_INBOX))
  const auto = recentAuto(inbox, now)
  const autoLines = auto.length === 0 ? [] : [
    `Auto-answered (last 24 h, ${auto.length} shown; revoke with mcp__flow__standing remove <id>):`,
    ...auto.map(q => `  ${q.id} ${q.owner}: ${q.question} -> ${q.answer ?? ''} (rule ${q.rule ?? '?'})`),
  ]
  if (open.length === 0) return autoLines.length === 0 ? 'No open questions.' : ['No open questions.', ...autoLines].join('\n')
  const owners = [...new Set(open.map(q => q.owner))]
  const blocking = open.filter(q => q.blocking).length
  const lines = [`Open questions: ${open.length}${blocking ? ` (${blocking} blocking)` : ''}. Answer with mcp__flow__answer: answers [{id, choice}] (option text, letter or number), or defaults true for the recommended ones.`]
  for (const o of owners) {
    lines.push(`${o}:`)
    for (const q of open.filter(x => x.owner === o)) {
      lines.push(`  ${q.id} ${q.blocking ? 'BLOCKING' : 'non-blocking'}${q.topic ? ` [${q.topic}]` : ''} (${age(now - q.askedAt)}, for ${q.addressee}): ${q.question}`)
      q.options.forEach((opt, i) => lines.push(`      ${String.fromCharCode(97 + i)}) ${opt}${opt === q.default ? '  (default)' : ''}`))
      if (q.context) lines.push(`      context: ${q.context}`)
    }
  }
  return [...lines, ...autoLines].join('\n')
}

// The head of mcp__flow__status: a count and one line per open question, blocking first.
export function inboxHead(inbox: Inbox | undefined, now = Date.now()): string[] {
  const open = ordered(openAll(inbox ?? EMPTY_INBOX))
  const auto = recentAuto(inbox, now).length
  const autoLine = auto === 0 ? [] : [`Inbox: ${auto} auto-answered by standing answers in the last 24 h (/flow inbox).`]
  if (open.length === 0) return autoLine
  const blocking = open.filter(q => q.blocking).length
  return [
    `Inbox: ${open.length} open${blocking ? `, ${blocking} blocking` : ''} (/flow inbox shows them with options):`,
    ...open.map(q => `  ${q.id} ${q.blocking ? 'BLOCKING ' : ''}${q.owner}: ${q.question.slice(0, 140)}`),
    ...autoLine,
  ]
}

// A stored inbox read back from disk; anything malformed is dropped.
export function normalizeInbox(raw: unknown): Inbox {
  const r = raw as { next?: unknown; items?: unknown } | null
  const items = (Array.isArray(r?.items) ? r.items : []).filter((x): x is Question =>
    typeof x === 'object' && x !== null && typeof (x as Question).id === 'string' && typeof (x as Question).question === 'string' &&
    Array.isArray((x as Question).options) && ((x as Question).state === 'open' || (x as Question).state === 'answered'))
  const top = Math.max(0, ...items.map(x => Number(/^q(\d+)$/.exec(x.id)?.[1] ?? 0)))
  return { next: Math.max(top + 1, typeof r?.next === 'number' ? r.next : 1), items }
}
