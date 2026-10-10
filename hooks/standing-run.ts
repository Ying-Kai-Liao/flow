// Standing answers and guard-test rules, moved out of register.tsx: the rule files, the auto-answer check
// and the rule edits. Everything that touches the engine goes through StandingIo, built by standingIoOf in
// register.tsx (the engine refuses `$` across an import).
import type { LogEvent } from '../types'
import { mergeLayers } from './settings'
import { AUTO, escalation, matchRule, nextRuleId, removeRule, renderSeeds, ruleFromQuestion, sameRule, seedsToOffer } from './standing'
import type { Resolved, Rule } from './standing'
import { addMapping, parseGuardTests, suggestionQuestion, suggestionsFor } from './guardtests'
import type { GuardMap } from './guardtests'
import { addQuestions, markAnswered, notesOwner, parseChoice } from './inbox'
import type { Inbox, Question } from './inbox'
import { noteKey } from './state'
import { ENV_KIND } from './deploy'
import { PUSH_KIND } from './pushgate'

export type StandingIo = {
  locate: () => Promise<string[]>
  readFile: (path: string) => Promise<string | undefined>
  mkdirp: (dir: string) => Promise<unknown>
  writeJson: (path: string, obj: unknown) => Promise<boolean>
  readJson: (path: string) => Promise<unknown>
  stateDir: () => Promise<string | undefined>
  run: (argv: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  now: () => Promise<number>
  today: () => Promise<string>
  inbox: () => Promise<Inbox>
  withInbox: <T>(fn: (cur: Inbox) => { inbox: Inbox; out: T }) => Promise<T>
  appendNote: (name: string, line: string) => Promise<boolean>
  appendLog: (event: Omit<LogEvent, 'ts'>) => Promise<void>
  best: (what: string, fn: () => Promise<void>) => Promise<void>
}

// Standing answers (standing.ts): the rules of both settings files, read fresh so a rule made a moment ago
// applies to the next ask. A bad rule is dropped by mergeLayers; the others stand.
export async function loadRules(io: StandingIo, options: Record<string, unknown>): Promise<{ rules: Resolved[]; paths: string[] }> {
  const paths = await io.locate()
  const layers = await Promise.all(paths.map(async path => ({ path, text: path === '' ? undefined : await io.readFile(path) })))
  const raw = mergeLayers(options, layers).raw.standing_answers
  return { rules: Array.isArray(raw) ? raw as Resolved[] : [], paths }
}

export type AutoHits = Map<string, { answer: string; rid: string }>

// The standing-answer check shared by ask and pre-flight: a fresh question that a rule matches is marked
// answered in the same write, so it has an id and history. Returns the inbox, the stored questions as they
// are now, and which ones a rule answered.
export function autoAnswer(cur: Inbox, r: ReturnType<typeof addQuestions>, rules: Resolved[], at: number, escalate = false) {
  let next = r.added.some(a => a.fresh) ? r.inbox : cur
  // An escalate rule holds the question for the user: blocking, flagged, never auto-answered.
  if (escalate) {
    for (const { q, fresh } of r.added) {
      const esc = fresh ? escalation(rules, q) : undefined
      if (esc !== undefined) next = { ...next, items: next.items.map(x => (x.id === q.id ? { ...x, blocking: true, escalated: esc.rid, addressee: 'main' } : x)) }
    }
  }
  const hits: AutoHits = new Map()
  for (const { q, fresh } of r.added) {
    const m = fresh ? matchRule(rules, next.items.find(x => x.id === q.id) ?? q) : undefined
    if (m === undefined) continue
    const marked = markAnswered(next, q.id, m.answer, AUTO, at, m.rule.rid)
    if (marked.kind !== 'ok') continue
    next = marked.inbox
    hits.set(q.id, { answer: marked.answer, rid: m.rule.rid })
  }
  const added = r.added.map(a => ({ ...a, q: next.items.find(x => x.id === a.q.id) ?? a.q }))
  return { inbox: next, added, hits }
}

// The decision note and auto-answer log event for each question a rule answered.
export async function recordAutoAnswers(io: StandingIo, added: Array<{ q: Question }>, hits: AutoHits, agent: string): Promise<void> {
  const date = await io.today()
  for (const { q } of added) {
    const hit = hits.get(q.id)
    if (hit === undefined) continue
    await io.appendNote(notesOwner(q), `- ${date} decision: "${q.id} ${q.question}: ${hit.answer}" (standing answer ${hit.rid})`)
    await io.best('logging an auto-answer', () => io.appendLog({ event: 'auto-answer', owner: noteKey(notesOwner(q)), agent, text: `${q.id} rule ${hit.rid}: ${hit.answer}` }))
  }
}

// Rule file changes run one after another: two `always` answers at once must not lose a rule.
let rulesChain: Promise<unknown> = Promise.resolve()
function inRulesChain<T>(fn: () => Promise<T>): Promise<T> {
  const result = rulesChain.then(fn, fn)
  rulesChain = result.catch(() => undefined)
  return result
}

// Read-modify-write one settings file's standing_answers, keeping every other key. fn gets the raw list and
// returns the new one (undefined: no change). A file that is not a JSON object is never rewritten.
async function editRuleFile<T>(io: StandingIo, path: string, fn: (list: unknown[]) => Promise<{ list?: unknown[]; out: T }>): Promise<{ out: T } | { error: string }> {
  let obj: Record<string, unknown> = {}
  const text = await io.readFile(path)
  if (text !== undefined && text.trim() !== '') {
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      return { error: `${path} is not valid JSON; fix it first, flow does not rewrite it.` }
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return { error: `${path} is not a JSON object; flow does not rewrite it.` }
    obj = data as Record<string, unknown>
  }
  let list: unknown = obj.standing_answers
  if (typeof list === 'string') {
    try { list = JSON.parse(list) } catch { return { error: `${path}: "standing_answers" is not valid JSON; fix it first.` } }
  }
  if (list === undefined || list === null) list = []
  if (!Array.isArray(list)) return { error: `${path}: "standing_answers" is not a list; fix it first.` }
  const r = await fn(list)
  if (r.list !== undefined) {
    await io.mkdirp(path.replace(/\/[^/]*$/, ''))
    if (!await io.writeJson(path, { ...obj, standing_answers: r.list })) return { error: `could not write ${path}.` }
  }
  return { out: r.out }
}

export type RuleAdd = { kind: 'added' | 'exists'; id: string } | { kind: 'error'; msg: string }

// Adds a rule to the personal file with a new short id (s1, s2, ..., unique across both files and the inbox).
export function addRule(io: StandingIo, options: Record<string, unknown>, rule: Rule): Promise<RuleAdd> {
  return inRulesChain(async (): Promise<RuleAdd> => {
    const { rules, paths } = await loadRules(io, options)
    const path = paths[1] ?? ''
    if (path === '') return { kind: 'error', msg: 'rules need a repo for the personal file.' }
    const dup = rules.find(r => sameRule(r.rule, rule))
    if (dup !== undefined) return { kind: 'exists', id: dup.rid }
    const used = [...rules.map(r => r.rid), ...(await io.inbox()).items.flatMap(q => (q.rule === undefined ? [] : [q.rule]))]
    const id = nextRuleId(used)
    const r = await editRuleFile(io, path, async list => ({ list: [...list, { id, ...rule }], out: id }))
    return 'error' in r ? { kind: 'error', msg: r.error } : { kind: 'added', id }
  })
}

// Adds a suggested guard mapping to the personal file (never the committed one), keeping every other key and the
// mapping already there. The text tells main to copy it to .claude/flow.json to share it.
export function addGuardTest(io: StandingIo, options: Record<string, unknown>, glob: string, test: string): Promise<string> {
  return inRulesChain(async () => {
    const path = (await io.locate())[1] ?? ''
    if (path === '') return 'No mapping written: guard mappings need a repo for the personal file.'
    let obj: Record<string, unknown> = {}
    const text = await io.readFile(path)
    if (text !== undefined && text.trim() !== '') {
      try { obj = JSON.parse(text) as Record<string, unknown> } catch { return `No mapping written: ${path} is not valid JSON; fix it first, flow does not rewrite it.` }
      if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return `No mapping written: ${path} is not a JSON object; flow does not rewrite it.`
    }
    const had = obj.guard_tests === undefined ? {} : parseGuardTests(obj.guard_tests)
    if (had === undefined) return `No mapping written: "guard_tests" in ${path} is not an object of globs to test lists; fix it first.`
    const next = addMapping(had, glob, test)
    if ((had[glob] ?? []).includes(test)) return `Already in ${path}: ${JSON.stringify({ [glob]: [test] })}.`
    await io.mkdirp(path.replace(/\/[^/]*$/, ''))
    if (!await io.writeJson(path, { ...obj, guard_tests: next })) return `No mapping written: could not write ${path}.`
    return `Added ${JSON.stringify({ [glob]: [test] })} to ${path} (personal, uncommitted). To share it with the team, copy it into .claude/flow.json under "guard_tests" and commit.`
  })
}

// A PR sent back for failing tests: for each failed test no guard mapping already requires for the PR's files, one
// non-blocking question to main suggests a mapping. Best effort: the send-back itself is already recorded.
export async function suggestGuardTests(io: StandingIo, input: Record<string, unknown>, pr: number, queueName: string, agentId: string | undefined, map: GuardMap): Promise<string> {
  const failed = Array.isArray(input.failed_tests) ? input.failed_tests.filter((t): t is string => typeof t === 'string' && t.trim() !== '') : []
  if (failed.length === 0) return ''
  const diff = await io.run(['gh', 'pr', 'diff', String(pr), '--name-only']).catch(() => undefined)
  if (diff === undefined || diff.exitCode !== 0) return ` No guard suggestion: gh pr diff ${pr} failed${diff === undefined ? '' : `: ${diff.stderr.trim().slice(0, 200)}`}.`
  const files = diff.stdout.split('\n').map(l => l.trim()).filter(Boolean)
  const sugg = suggestionsFor(files, failed, map)
  if (sugg.length === 0) return ''
  const at = await io.now()
  const filed = await io.withInbox(cur => {
    const open = (g: { glob: string; test: string }) => cur.items.some(x => x.state === 'open' && x.guard?.glob === g.glob && x.guard.test === g.test)
    const asked = sugg.filter(x => !open(x)).map(x => suggestionQuestion(pr, x))
    if (asked.length === 0) return { inbox: cur, out: [] as string[] }
    const r = addQuestions(cur, { name: queueName, id: agentId, isManager: false }, 'main', asked, at)
    return { inbox: r.inbox, out: r.added.filter(a => a.fresh).map(a => a.q.id) }
  })
  return filed.length === 0 ? '' : ` Asked main whether to add a guard mapping (${filed.join(', ')}).`
}

// Removes a rule from whichever file holds it. A /config rule cannot be removed from here.
export function dropRule(io: StandingIo, options: Record<string, unknown>, rid: string): Promise<string> {
  return inRulesChain(async () => {
    const { rules, paths } = await loadRules(io, options)
    const hit = rules.find(r => r.rid === rid)
    if (hit === undefined) return `${rid}: no such rule. mcp__flow__standing {"action":"list"} shows them.`
    if (hit.source === 'config') return `${rid}: set in /config, remove it there.`
    const path = (hit.source === 'repo' ? paths[0] : paths[1]) ?? ''
    const r = await editRuleFile(io, path, async list => {
      const res = removeRule(list, hit.source, rid)
      return res.removed ? { list: res.list, out: true } : { out: false }
    })
    if ('error' in r) return `${rid}: not removed, ${r.error}`
    if (!r.out) return `${rid}: not found in ${path}.`
    return `${rid}: removed from ${path}${hit.source === 'repo' ? ' (a committed file: the change shows in git status)' : ''}.`
  })
}

// The suggested starting rules, for main's first status call when no rule exists anywhere. The flag is
// written before returning; two calls at once may both show it, none may miss it.
export async function offerSeedsOnce(io: StandingIo, options: Record<string, unknown>): Promise<string[]> {
  const dir = await io.stateDir()
  if (dir === undefined) return []
  const flag = `${dir}/seeds-offered.json`
  if (await io.readJson(flag) !== undefined) return []
  const { rules } = await loadRules(io, options)
  const offer = rules.length === 0 ? seedsToOffer(rules) : []
  if (offer.length === 0) return []
  await io.mkdirp(dir)
  await io.writeJson(flag, { offeredAt: await io.now() })
  return renderSeeds(offer)
}

// An `always` answer: after answering, the answer becomes a rule in the personal file. Only main makes rules.
export async function alwaysRule(
  io: StandingIo, options: Record<string, unknown>, id: string, choice: string, isMain: boolean, before: Question | undefined,
): Promise<string> {
  if (!isMain) return `${id}: no rule made, only main makes standing answers (the answer itself stands).`
  if (before === undefined) return `${id}: no rule made, no such question.`
  if (before.state !== 'open') return `${id}: no rule made, it was already answered.`
  const q = (await io.inbox()).items.find(x => x.id === id)
  if (q === undefined || q.state !== 'answered' || q.answeredBy !== 'main') return `${id}: no rule made, the answer was not recorded.`
  if (q.kind === 'deploy') return `${id}: no rule made, a deploy approval is the user's call every time.`
  if (q.kind === ENV_KIND) return `${id}: no rule made, an env change is the user's call every time.`
  if (q.kind === PUSH_KIND) return `${id}: no rule made, pushing a batch is the user's call every time.`
  if (parseChoice(q.options, choice).free) return `${id}: no rule made, a free-text answer cannot be a rule; pick one of the options.`
  const rule = ruleFromQuestion(q, q.answer ?? '', await io.today())
  const r = await addRule(io, options, rule)
  if (r.kind === 'error') return `${id}: answered, but no rule made: ${r.msg}`
  const what = rule.topic !== undefined ? `topic ${rule.topic}` : 'this exact question'
  if (r.kind === 'exists') return `${id}: rule ${r.id} already says "${rule.answer}" for ${what}; no duplicate added.`
  return `${id}: rule ${r.id} added: ${what} -> "${rule.answer}"${rule.blocking ? ' (also blocking)' : ''}. Revoke with mcp__flow__standing {"action":"remove","id":"${r.id}"}.`
}
