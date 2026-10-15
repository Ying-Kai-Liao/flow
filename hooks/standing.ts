import { noteKey } from './state'
import { parseChoice } from './inbox'
import type { Inbox, Question } from './inbox'

// Standing answers: rules that answer a recurring decision-inbox question the way the user once decided.
// Pure half: parse and validate the rules, match a question, suggest new rules, render the list. The
// disk half (reading both settings files, writing the personal one) is in register.tsx.
// SEEDS are a few common rules offered once when no rules exist; they are suggestions, never applied unasked.
// CONSERVATIVE is the one built-in rule: on unless conservative_default is false, it takes a non-blocking
// ordinary question's own default. It comes last, so every rule of your own wins over it.
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
//   kinds    the kinds of inbox item it may answer ("ask" for an ordinary question, "fyi" for a recorded
//            decision (answered "Keep")). Absent: ordinary questions only. A decision is answered only by a rule
//            that names "fyi". A deploy approval, an env item, a push and a reviewer retry always wait for the
//            user: a rule naming one of those kinds is refused, and one already in a settings file is ignored.
//   options  the option set of the question the rule was made from (a topic-less rule): a question matches
//            only if its options are the same set, besides its text matching `match`.
// Topics compare normalized (any case, `_`/space/`-` alike, one trailing "s" ignored).
// A rule without an id gets a derived one from its file and 1-based position in that file's list:
// `personal:1`, `repo:2`, `config:1`. Positions count every entry, valid or not, so they stay stable.

export type Rule = { id?: string; topic?: string; match?: string; answer?: string; escalate?: boolean; blocking?: boolean; from?: string; note?: string; kinds?: string[]; options?: string[] }
export type Source = 'personal' | 'repo' | 'config' | 'builtin'
// ignored: why the rule never applies (it names a kind only the user answers); standing list shows it.
export type Resolved = { rid: string; source: Source; pos: number; rule: Rule; re?: RegExp; ignored?: string }

export const AUTO = 'standing answer'
// The answer word that takes the question's own default.
export const DEFAULT_WORD = 'default'

// The kinds no rule may name: each item of these is the user's call every time.
export const USER_ONLY_KINDS = ['deploy', 'env', 'push', 'reviewer']
const USER_ONLY = 'a deploy approval, an env change, a push or a reviewer retry always waits for the user'

const norm = (s: string) => s.trim().replace(/\s+/g, ' ')
const lower = (s: string) => norm(s).toLowerCase()
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
// A topic as compared: "Worker_Sizes", "worker size" and "worker-size" are one topic.
export const normTopic = (s: string): string => lower(s).replace(/[\s_-]+/g, '-').replace(/s$/, '')
export const optionSet = (o: string[]): string => JSON.stringify([...new Set(o.map(lower))].sort())

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
  const kinds = Array.isArray(r.kinds) ? r.kinds.map(text).filter(k => k !== '') : typeof r.kinds === 'string' && text(r.kinds) !== '' ? [text(r.kinds)] : undefined
  if (r.kinds !== undefined && (kinds === undefined || kinds.length === 0)) return { error: 'kinds must be a list of kind names' }
  if (kinds?.some(k => USER_ONLY_KINDS.includes(k.toLowerCase())) === true) return { error: `kinds may not name ${USER_ONLY_KINDS.join(', ')}: ${USER_ONLY}` }
  const options = Array.isArray(r.options) ? r.options.map(text).filter(o => o !== '') : undefined
  if (r.options !== undefined && (options === undefined || options.length === 0)) return { error: 'options must be a list of option texts' }
  // A rule never undoes a decision: for kind "fyi" the only answer is Keep.
  if (kinds?.includes('fyi') === true && !['keep', DEFAULT_WORD].includes(answer.toLowerCase()) && !escalate) return { error: 'a rule for kind fyi can only answer "Keep"' }
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
    ...(kinds !== undefined ? { kinds } : {}),
    ...(options !== undefined ? { options } : {}),
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
    // A rule written before such kinds were refused stays listed, so the list can say why it does nothing.
    const old = 'error' in v ? userOnlyRule(raw) : undefined
    if (old !== undefined) {
      warnings.push(`${label}: standing_answers[${i}] ignored: ${USER_ONLY}`)
      out.push({ ...old, rid: old.rule.id ?? `${source}:${i + 1}`, source, pos: i + 1, ignored: USER_ONLY })
      continue
    }
    if ('error' in v) {
      warnings.push(`${label}: standing_answers[${i}] dropped: ${v.error}`)
      continue
    }
    out.push({ rid: v.rule.id ?? `${source}:${i + 1}`, source, pos: i + 1, rule: v.rule, ...(v.re !== undefined ? { re: v.re } : {}) })
  }
  return out
}

// A rule that is valid but for naming a user-only kind: as validated without those kinds.
function userOnlyRule(raw: unknown): { rule: Rule; re?: RegExp } | undefined {
  const kinds = (raw as { kinds?: unknown } | null)?.kinds
  const list = Array.isArray(kinds) ? kinds.map(text) : typeof kinds === 'string' ? [text(kinds)] : []
  if (!list.some(k => USER_ONLY_KINDS.includes(k.toLowerCase()))) return undefined
  const rest = list.filter(k => k !== '' && !USER_ONLY_KINDS.includes(k.toLowerCase()))
  const v = validateRule({ ...(raw as Record<string, unknown>), kinds: rest.length > 0 ? rest : undefined })
  return 'error' in v ? undefined : { rule: { ...v.rule, kinds: list.filter(k => k !== '') }, ...(v.re !== undefined ? { re: v.re } : {}) }
}

export type Askable = Pick<Question, 'question' | 'options' | 'blocking' | 'owner' | 'default' | 'kind'> &
  Partial<Pick<Question, 'guard' | 'escalated' | 'forQ' | 'viaQ'>> & { topic?: string }

// Topic, match and asker filters of a rule against a question. An ignored rule applies to nothing.
function applies(r: Resolved, q: Askable): boolean {
  const { rule } = r
  if (r.ignored !== undefined) return false
  if (rule.topic !== undefined && (q.topic === undefined || normTopic(q.topic) !== normTopic(rule.topic))) return false
  if (r.re !== undefined && !r.re.test(norm(q.question))) return false
  if (rule.options !== undefined && optionSet(rule.options) !== optionSet(q.options)) return false
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
    // A deploy approval, an env change, a push or a reviewer retry is the user's call, whatever the rule says.
    const kind = q.kind === undefined || q.kind === 'question' ? 'ask' : q.kind
    if (USER_ONLY_KINDS.includes(kind)) continue
    // No kinds means ordinary questions only: a decision is reached only by a rule naming "fyi".
    if (!(rule.kinds ?? ['ask']).includes(kind)) continue
    // The built-in rule never settles a guard suggestion or a question linked to another.
    if (r.source === 'builtin' && (q.guard !== undefined || q.escalated !== undefined || q.forQ !== undefined || q.viaQ !== undefined)) continue
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

// The rules that may act on a decision an agent recorded (mcp__flow__fyi): those naming kind "fyi", and the
// escalate rules, which still hold everything. An ordinary rule (no kinds) does not reach them there.
export const fyiRules = (rules: Resolved[]): Resolved[] => rules.filter(r => r.rule.escalate === true || r.rule.kinds?.includes('fyi') === true)

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The rule an `always` answer makes: by the question's topic, else by its exact text and option set.
export function ruleFromQuestion(q: Question, answer: string, date: string): Rule {
  return {
    ...(q.topic !== undefined && q.topic !== '' ? { topic: q.topic } : { match: `^${escapeRe(norm(q.question))}$`, options: q.options }),
    ...(q.kind === 'fyi' ? { kinds: ['fyi'] } : {}),
    answer,
    ...(q.blocking ? { blocking: true } : {}),
    note: `added ${date} from ${q.id}`,
  }
}

// The same rule already exists: same topic or match, same asker filter, same answer.
export function sameRule(a: Rule, b: Rule): boolean {
  const eq = (x?: string, y?: string) => (x === undefined ? '' : lower(x)) === (y === undefined ? '' : lower(y))
  const topic = (x?: string) => (x === undefined ? '' : normTopic(x))
  const opts = (x?: string[]) => (x === undefined ? '' : optionSet(x))
  const kinds = (x?: string[]) => (x === undefined ? '' : [...x].sort().join(','))
  return topic(a.topic) === topic(b.topic) && opts(a.options) === opts(b.options) && kinds(a.kinds) === kinds(b.kinds) && norm(a.match ?? '') === norm(b.match ?? '') && eq(a.from, b.from) && eq(a.answer, b.answer) &&
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

export type Suggestion = { key: string; id: string; fyi: boolean; label: string; answer: string; times: number; add: string }

const SUGGEST_AT = 3

// Anything a rule must never settle: a deploy, env, push or reviewer item, a guard suggestion, an escalation,
// or a question linked to another. A group holding one is never suggested.
const hardItem = (q: Question): boolean =>
  (q.kind !== undefined && q.kind !== 'question' && q.kind !== 'fyi') || q.guard !== undefined || q.env !== undefined ||
  q.escalated !== undefined || q.forQ !== undefined || q.viaQ !== undefined

// Topics (or, without one, identical question texts) main answered SUGGEST_AT times or more with the same
// answer, that no rule covers yet. Decisions (FYIs) main kept make a rule with kinds ["fyi"].
export function suggest(inbox: Inbox, rules: Resolved[]): Suggestion[] {
  const groups = new Map<string, Question[]>()
  const tainted = new Set<string>()
  const keyOf = (q: Question) => `${q.kind === 'fyi' ? 'fyi' : 'ask'}:${q.topic !== undefined && q.topic !== '' ? `topic:${normTopic(q.topic)}` : `text:${lower(q.question)}`}`
  for (const q of inbox.items) {
    if (hardItem(q)) tainted.add(keyOf(q))
    if (q.state !== 'answered' || q.answeredBy !== 'main' || q.answer === undefined) continue
    groups.set(keyOf(q), [...(groups.get(keyOf(q)) ?? []), q])
  }
  const own = rules.filter(r => r.source !== 'builtin')
  const out: Suggestion[] = []
  for (const [key, items] of groups) {
    if (tainted.has(key)) continue
    const byAnswer = new Map<string, Question[]>()
    for (const q of items) byAnswer.set(lower(q.answer!), [...(byAnswer.get(lower(q.answer!)) ?? []), q])
    for (const same of byAnswer.values()) {
      if (same.length < SUGGEST_AT) continue
      const last = same[same.length - 1]!
      // The built-in rule does not count as covering: a rule of your own wins over it.
      if (same.some(q => matchRule(q.kind === 'fyi' ? fyiRules(own) : own, q) !== undefined)) continue
      const fyi = last.kind === 'fyi'
      const rule = ruleFromQuestion(last, last.answer!, '')
      const body: Record<string, unknown> = {
        action: 'add', ...(rule.topic !== undefined ? { topic: rule.topic } : { match: rule.match, options: rule.options }),
        answer: rule.answer, ...(fyi ? { kinds: ['fyi'] } : {}),
      }
      if (same.every(q => q.blocking)) body.blocking = true
      out.push({
        key, id: `${key}|${lower(last.answer!)}`, fyi, answer: last.answer!, times: same.length,
        label: `${fyi ? 'decisions ' : ''}${rule.topic !== undefined ? `topic ${rule.topic}` : `"${cap(norm(last.question), 80)}"`}`,
        add: `mcp__flow__standing ${JSON.stringify(body)}`,
      })
    }
  }
  return out
}

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

const SOURCE_NAME: Record<Source, string> = { personal: 'personal file', repo: 'repo file (committed)', config: '/config', builtin: 'built-in' }

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
]

// The built-in rule, on by default: a non-blocking ordinary question takes its own default, which the asker
// already went on, so it only keeps the inbox quiet. Never a blocking one, a decision, a user-only kind, a guard
// suggestion, an escalation or a linked question (matchRule). Off: conservative_default false.
export const CONSERVATIVE_ID = 'conservative'
export const CONSERVATIVE_OFF = 'mcp__flow__settings {"action":"write","layer":"personal","values":{"conservative_default":false}}'
export const CONSERVATIVE: Resolved = {
  rid: CONSERVATIVE_ID, source: 'builtin', pos: 1, rule: { id: CONSERVATIVE_ID, match: '.', answer: DEFAULT_WORD, note: `on by default; turn off: ${CONSERVATIVE_OFF}` }, re: /./i,
}
// It is in the rules unless the merged settings say conservative_default false.
export const withBuiltin = (rules: Resolved[], settings: Record<string, unknown>): Resolved[] =>
  settings.conservative_default === false ? rules : [...rules, CONSERVATIVE]

export const seedIds = (): string[] => SEEDS.map(s => s.id)

// The seeds worth offering: none once a rule of your own exists. Rules that are only accepted seeds do not
// count as your own, so a partly accepted set still shows the rest.
export function seedsToOffer(rules: Resolved[]): Seed[] {
  if (rules.some(r => r.source !== 'builtin' && !SEEDS.some(s => sameRule(s.rule, r.rule)))) return []
  return SEEDS.filter(s => !rules.some(r => sameRule(s.rule, r.rule)))
}

export function renderSeeds(seeds: Seed[]): string[] {
  if (seeds.length === 0) return []
  return [
    'Suggested starting rules (not applied):',
    ...seeds.map(s => `  ${s.label}: mcp__flow__standing {"action":"add","seed":"${s.id}"}`),
    `Several at once: mcp__flow__standing {"action":"add","seeds":${JSON.stringify(seeds.map(s => s.id))}}. Nothing is applied until you add it. (Load mcp__flow__standing with ToolSearch first.)`,
  ]
}

export function renderRules(rules: Resolved[], inbox: Inbox, suggestions: Suggestion[], seeds: Seed[] = []): string {
  const lines: string[] = []
  if (rules.length === 0) lines.push('No standing answers.')
  else {
    lines.push(`Standing answers (${rules.length}; first match wins; active unless marked IGNORED):`)
    for (const r of rules) {
      const times = inbox.items.filter(q => q.rule === r.rid).length
      lines.push(`  ${r.rid} [${SOURCE_NAME[r.source]}] ${describeRule(r)} -> ${outcome(r.rule)}, answered ${times}x${r.rule.note ? ` (${r.rule.note})` : ''}${r.ignored === undefined ? '' : ` IGNORED: names kinds ${(r.rule.kinds ?? []).join(', ')}; ${r.ignored}. Remove it.`}`)
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
