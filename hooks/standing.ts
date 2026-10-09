import { noteKey } from './state'
import { parseChoice } from './inbox'
import type { Inbox, Question } from './inbox'

// Standing answers: rules that answer a recurring decision-inbox question the way the user once decided.
// Pure half: parse and validate the rules, match a question, suggest new rules, render the list. The
// disk half (reading both settings files, writing the personal one) is in register.tsx.
// SEEDS are a few common rules offered once when no rules exist; they are suggestions, never applied unasked.
//
// A rule: { id?, topic?, match?, answer, blocking?, from?, note? } or { id?, topic?, match?, escalate: true, from?, note? }.
//   topic    equals the question's topic (trimmed, any case)
//   match    a case-insensitive regular expression tested on the question text (whitespace collapsed)
//   both     given: both must match. A rule needs at least one of them.
//   answer   must resolve to one of the question's options (text, letter or number), else the rule is skipped
//   blocking a blocking question is answered only by a rule with blocking: true
//   answer "default" (the literal word) answers a matching NON-blocking question with its own default; a
//            blocking question is never answered by it, whatever `blocking` says
//   escalate true, with no answer: a matching question is never auto-answered by any rule, whatever the order
//            of the rules, and is recorded blocking and flagged `escalated: <rule id>`, so only main answers it.
//            A rule with both `escalate` and an `answer` is invalid (dropped with a warning).
//   from     the asker's name (a manager's continuation `foo-2` counts as `foo`)
// A rule without an id gets a derived one from its file and 1-based position in that file's list:
// `personal:1`, `repo:2`, `config:1`. Positions count every entry, valid or not, so they stay stable.

export type Rule = { id?: string; topic?: string; match?: string; answer?: string; escalate?: boolean; blocking?: boolean; from?: string; note?: string }
export type Source = 'personal' | 'repo' | 'config'
export type Resolved = { rid: string; source: Source; pos: number; rule: Rule; re?: RegExp }

export const AUTO = 'standing answer'
// The answer word that takes the question's own default.
export const DEFAULT_WORD = 'default'

const norm = (s: string) => s.trim().replace(/\s+/g, ' ')
const lower = (s: string) => norm(s).toLowerCase()
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

export function validateRule(raw: unknown): { rule: Rule; re?: RegExp } | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { error: 'not an object' }
  const r = raw as Record<string, unknown>
  const topic = text(r.topic)
  const match = text(r.match)
  const answer = text(r.answer).toLowerCase() === DEFAULT_WORD ? DEFAULT_WORD : text(r.answer)
  if (topic === '' && match === '') return { error: 'needs a topic or a match' }
  if (r.escalate !== undefined && typeof r.escalate !== 'boolean') return { error: 'escalate must be true or false' }
  const escalate = r.escalate === true
  if (escalate && answer !== '') return { error: 'an escalate rule takes no answer' }
  if (!escalate && answer === '') return { error: 'needs an answer' }
  if (r.blocking !== undefined && typeof r.blocking !== 'boolean') return { error: 'blocking must be true or false' }
  let re: RegExp | undefined
  if (match !== '') {
    try {
      re = new RegExp(match, 'i')
    } catch (err) {
      return { error: `invalid match regex (${err instanceof Error ? err.message : String(err)})` }
    }
  }
  const rule: Rule = {
    ...(text(r.id) !== '' ? { id: text(r.id) } : {}),
    ...(topic !== '' ? { topic } : {}),
    ...(match !== '' ? { match } : {}),
    ...(escalate ? { escalate: true } : { answer }),
    ...(r.blocking === true ? { blocking: true } : {}),
    ...(text(r.from) !== '' ? { from: text(r.from) } : {}),
    ...(text(r.note) !== '' ? { note: text(r.note) } : {}),
  }
  return { rule, ...(re !== undefined ? { re } : {}) }
}

// One layer's value (a list, or a JSON string of one as /config carries it) into resolved rules.
// A bad rule is dropped with a warning; the others stand.
export function parseRules(value: unknown, source: Source, label: string, warnings: string[]): Resolved[] {
  let list: unknown = value
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value)
    } catch {
      warnings.push(`${label}: "standing_answers" is not valid JSON; ignored`)
      return []
    }
  }
  if (list === null || list === undefined) return []
  if (!Array.isArray(list)) {
    warnings.push(`${label}: "standing_answers" should be a list of rules; ignored`)
    return []
  }
  const out: Resolved[] = []
  for (const [i, raw] of list.entries()) {
    const v = validateRule(raw)
    if ('error' in v) {
      warnings.push(`${label}: standing_answers[${i}] dropped: ${v.error}`)
      continue
    }
    out.push({ rid: v.rule.id ?? `${source}:${i + 1}`, source, pos: i + 1, rule: v.rule, ...(v.re !== undefined ? { re: v.re } : {}) })
  }
  return out
}

export type Askable = Pick<Question, 'question' | 'options' | 'blocking' | 'owner' | 'default'> & { topic?: string }

// Topic, match and asker filters of a rule against a question.
function applies(r: Resolved, q: Askable): boolean {
  const { rule } = r
  if (rule.topic !== undefined && (q.topic === undefined || lower(q.topic) !== lower(rule.topic))) return false
  if (r.re !== undefined && !r.re.test(norm(q.question))) return false
  return rule.from === undefined || noteKey(rule.from) === noteKey(q.owner)
}

// The escalate rule that holds this question for the user, if any. It beats every other rule.
export function escalation(rules: Resolved[], q: Askable): Resolved | undefined {
  return rules.find(r => r.rule.escalate === true && applies(r, q))
}

// The first rule that applies to the question, and the option it answers with. A rule whose answer is not
// one of the question's options does not apply; the next rule gets its turn.
export function matchRule(rules: Resolved[], q: Askable): { rule: Resolved; answer: string } | undefined {
  if (escalation(rules, q) !== undefined) return undefined
  for (const r of rules) {
    const { rule } = r
    if (rule.escalate === true || !applies(r, q)) continue
    if (rule.answer === DEFAULT_WORD) {
      if (q.blocking) continue
      return { rule: r, answer: q.default }
    }
    if (q.blocking && rule.blocking !== true) continue
    const c = parseChoice(q.options, rule.answer ?? '')
    if (c.free) continue
    return { rule: r, answer: c.text }
  }
  return undefined
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The rule an `always` answer makes: by the question's topic, else by its exact text.
export function ruleFromQuestion(q: Question, answer: string, date: string): Rule {
  return {
    ...(q.topic !== undefined && q.topic !== '' ? { topic: q.topic } : { match: `^${escapeRe(norm(q.question))}$` }),
    answer,
    ...(q.blocking ? { blocking: true } : {}),
    note: `added ${date} from ${q.id}`,
  }
}

// The same rule already exists: same topic or match, same asker filter, same answer.
export function sameRule(a: Rule, b: Rule): boolean {
  const eq = (x?: string, y?: string) => (x === undefined ? '' : lower(x)) === (y === undefined ? '' : lower(y))
  return eq(a.topic, b.topic) && norm(a.match ?? '') === norm(b.match ?? '') && eq(a.from, b.from) && eq(a.answer, b.answer) &&
    (a.escalate === true) === (b.escalate === true) && (a.blocking === true) === (b.blocking === true)
}

// A new short id, unique among the ids in use (rules of both files and ids recorded in the inbox).
export function nextRuleId(used: string[]): string {
  const top = Math.max(0, ...used.map(u => Number(/^s(\d+)$/.exec(u)?.[1] ?? 0)))
  return `s${top + 1}`
}

// Removes the rule with this id (given or derived) from one file's raw list. Entries are kept as they are.
export function removeRule(list: unknown[], source: Source, rid: string): { list: unknown[]; removed: boolean } {
  const at = list.findIndex((raw, i) => {
    const id = typeof raw === 'object' && raw !== null ? text((raw as Record<string, unknown>).id) : ''
    return (id !== '' ? id : `${source}:${i + 1}`) === rid
  })
  return at < 0 ? { list, removed: false } : { list: list.filter((_, i) => i !== at), removed: true }
}

export type Suggestion = { key: string; label: string; answer: string; times: number; add: string }

const SUGGEST_AT = 3

// Topics (or, without one, identical question texts) main answered SUGGEST_AT times or more with the same
// answer, that no rule covers yet.
export function suggest(inbox: Inbox, rules: Resolved[]): Suggestion[] {
  const groups = new Map<string, Question[]>()
  for (const q of inbox.items) {
    if (q.state !== 'answered' || q.answeredBy !== 'main' || q.answer === undefined) continue
    const key = q.topic !== undefined && q.topic !== '' ? `topic:${lower(q.topic)}` : `text:${lower(q.question)}`
    groups.set(key, [...(groups.get(key) ?? []), q])
  }
  const out: Suggestion[] = []
  for (const [key, items] of groups) {
    const byAnswer = new Map<string, Question[]>()
    for (const q of items) byAnswer.set(lower(q.answer!), [...(byAnswer.get(lower(q.answer!)) ?? []), q])
    for (const same of byAnswer.values()) {
      if (same.length < SUGGEST_AT) continue
      const last = same[same.length - 1]!
      if (same.some(q => matchRule(rules, q) !== undefined)) continue
      const rule = ruleFromQuestion(last, last.answer!, '')
      const body: Record<string, unknown> = { action: 'add', ...(rule.topic !== undefined ? { topic: rule.topic } : { match: rule.match }), answer: rule.answer }
      if (same.every(q => q.blocking)) body.blocking = true
      out.push({
        key, answer: last.answer!, times: same.length,
        label: rule.topic !== undefined ? `topic ${rule.topic}` : `"${cap(norm(last.question), 80)}"`,
        add: `mcp__flow__standing ${JSON.stringify(body)}`,
      })
    }
  }
  return out
}

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

const SOURCE_NAME: Record<Source, string> = { personal: 'personal file', repo: 'repo file (committed)', config: '/config' }

export function describeRule(r: Resolved): string {
  const parts = [
    r.rule.topic !== undefined ? `topic ${r.rule.topic}` : '',
    r.rule.match !== undefined ? `match /${r.rule.match}/i` : '',
    r.rule.from !== undefined ? `from ${r.rule.from}` : '',
  ].filter(Boolean)
  return parts.join(', ')
}

// What a rule does, for the list.
const outcome = (rule: Rule): string =>
  rule.escalate === true ? 'ESCALATE (never auto-answered; always blocking, only you answer)'
    : rule.answer === DEFAULT_WORD ? '"default" (the question\'s own default; non-blocking questions only)'
      : `"${rule.answer}"${rule.blocking ? ' (also blocking questions)' : ''}`

export type Seed = { id: string; label: string; rule: Rule; why: string }

// Common rules offered once, never applied unasked. Accepted with mcp__flow__standing {action: "add", seed: id}.
export const SEEDS: Seed[] = [
  {
    id: 'tracker', label: 'Never write to an external task tracker without my yes; report in the terminal',
    rule: { topic: 'external-tracker', escalate: true },
    why: 'A comment, status move or close in a tracker is seen by others and is hard to take back.',
  },
  {
    id: 'prod-env', label: 'Production environment changes always ask me',
    rule: { topic: 'prod-env-change', escalate: true },
    why: 'A changed production variable or secret affects live users at once.',
  },
  {
    id: 'conservative', label: 'Reversible choices: pick the conservative option, mark it, don\'t block',
    rule: { match: '.', answer: DEFAULT_WORD },
    why: 'Workers recommend a default for every question; this takes it for non-blocking ones and you only see what is blocking.',
  },
]

export const seedIds = (): string[] => SEEDS.map(s => s.id)

// The seeds worth offering: none once a rule of your own exists. Rules that are only accepted seeds do not
// count as your own, so a partly accepted set still shows the rest.
export function seedsToOffer(rules: Resolved[]): Seed[] {
  if (rules.some(r => !SEEDS.some(s => sameRule(s.rule, r.rule)))) return []
  return SEEDS.filter(s => !rules.some(r => sameRule(s.rule, r.rule)))
}

export function renderSeeds(seeds: Seed[]): string[] {
  if (seeds.length === 0) return []
  return [
    'Suggested starting rules (not applied):',
    ...seeds.map(s => `  ${s.label}: mcp__flow__standing {"action":"add","seed":"${s.id}"}`),
    `Several at once: mcp__flow__standing {"action":"add","seeds":${JSON.stringify(seeds.map(s => s.id))}}. Nothing is applied until you add it.`,
  ]
}

export function renderRules(rules: Resolved[], inbox: Inbox, suggestions: Suggestion[], seeds: Seed[] = []): string {
  const lines: string[] = []
  if (rules.length === 0) lines.push('No standing answers.')
  else {
    lines.push(`Standing answers (${rules.length}; first match wins):`)
    for (const r of rules) {
      const times = inbox.items.filter(q => q.rule === r.rid).length
      lines.push(`  ${r.rid} [${SOURCE_NAME[r.source]}] ${describeRule(r)} -> ${outcome(r.rule)}, answered ${times}x${r.rule.note ? ` (${r.rule.note})` : ''}`)
    }
    lines.push('Remove with mcp__flow__standing {"action":"remove","id":"<id>"}.')
  }
  if (suggestions.length > 0) {
    lines.push('Suggested (answered the same way 3 or more times, no rule yet):')
    for (const s of suggestions) lines.push(`  ${s.label}: "${s.answer}" x${s.times}: ${s.add}`)
  }
  lines.push(...renderSeeds(seeds))
  return lines.join('\n')
}
