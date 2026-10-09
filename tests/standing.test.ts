import type { AgentInfo } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import { addQuestions, EMPTY_INBOX, inboxHead, markAnswered, renderInbox } from '../hooks/inbox'
import type { AskedQuestion, Inbox, Question } from '../hooks/inbox'
import { mergeLayers } from '../hooks/settings'
import { escalation, matchRule, nextRuleId, parseRules, removeRule, renderRules, ruleFromQuestion, sameRule, SEEDS, seedsToOffer, suggest, validateRule } from '../hooks/standing'
import type { Resolved } from '../hooks/standing'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const DIR = '/r/.git/flow'
const PERSONAL = `${DIR}/config.json`
const REPO = '/r/.git/.claude/flow.json'
const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

// ---- pure half ----

const asked = (question: string, extra: Partial<AskedQuestion> = {}): AskedQuestion => ({
  question, options: ['patch', 'minor'], default: 'patch', blocking: false, ...extra,
})
const W = { name: 'csv-worker', id: 'w1', isManager: false }
function q(question: string, extra: Partial<AskedQuestion> = {}, owner = W): Question {
  return addQuestions(EMPTY_INBOX, owner, 'csv-export', [asked(question, extra)], 1000).added[0]!.q
}
const rules = (list: unknown[], source: 'personal' | 'repo' = 'personal'): Resolved[] => parseRules(list, source, 'f', [])

test('validateRule needs a topic or a match, an answer and a valid regex', () => {
  expect(validateRule({ answer: 'a' })).toEqual({ error: 'needs a topic or a match' })
  expect(validateRule({ topic: 't' })).toEqual({ error: 'needs an answer' })
  expect('error' in validateRule({ match: '(', answer: 'a' })).toBe(true)
  expect('error' in validateRule({ topic: 't', answer: 'a', blocking: 'yes' })).toBe(true)
  expect(validateRule('x')).toEqual({ error: 'not an object' })
  const v = validateRule({ id: ' s1 ', topic: ' version-bump ', answer: ' patch ', blocking: true, from: 'foo', note: 'n' })
  expect('rule' in v && v.rule).toEqual({ id: 's1', topic: 'version-bump', answer: 'patch', blocking: true, from: 'foo', note: 'n' })
})

test('parseRules drops bad rules with a warning, derives ids by position, accepts a JSON string', () => {
  const warnings: string[] = []
  const out = parseRules([{ topic: 'a', answer: 'x' }, { answer: 'y' }, { id: 'k', match: 'z', answer: 'y' }], 'repo', 'flow.json', warnings)
  expect(out.map(r => r.rid)).toEqual(['repo:1', 'k'])
  expect(warnings.length).toBe(1)
  expect(warnings[0]).toContain('standing_answers[1] dropped')
  expect(parseRules('[{"topic":"a","answer":"x"}]', 'config', '/config', []).map(r => r.rid)).toEqual(['config:1'])
  const bad: string[] = []
  expect(parseRules('{nope', 'config', '/config', bad)).toEqual([])
  expect(bad.length).toBe(1)
})

test('mergeLayers: personal rules come before the repo\'s and both apply; a bad rule does not break other keys', () => {
  const warn = mergeLayers({}, [
    { path: REPO, text: JSON.stringify({ language: 'German', standing_answers: [{ topic: 'a', answer: 'x' }, { nope: 1 }] }) },
    { path: PERSONAL, text: JSON.stringify({ standing_answers: [{ topic: 'a', answer: 'y' }], big_files: ['x'] }) },
  ])
  const r = warn.raw.standing_answers as Resolved[]
  expect(r.map(x => `${x.source}:${x.rule.answer}`)).toEqual(['personal:y', 'repo:x'])
  expect(warn.raw.language).toBe('German')
  expect(warn.warnings.some(w => w.includes('standing_answers[1] dropped'))).toBe(true)
  const none = mergeLayers({}, [{ path: REPO, text: '{}' }])
  expect('standing_answers' in none.raw).toBe(false)
  const cfg = mergeLayers({ standing_answers: '[{"topic":"a","answer":"z"}]' }, [])
  expect((cfg.raw.standing_answers as Resolved[]).map(x => x.rid)).toEqual(['config:1'])
})

test('matchRule: topic, match, both, from, blocking guard, answer must fit the options, first rule wins', () => {
  const byTopic = rules([{ topic: 'Version-Bump', answer: 'patch' }])
  expect(matchRule(byTopic, q('Bump?', { topic: 'version-bump ' }))?.answer).toBe('patch')
  expect(matchRule(byTopic, q('Bump?'))).toBeUndefined()
  expect(matchRule(byTopic, q('Bump?', { topic: 'other' }))).toBeUndefined()

  const byMatch = rules([{ match: '^bump\\b', answer: '2' }])
  expect(matchRule(byMatch, q('Bump   the version?'))?.answer).toBe('minor')
  expect(matchRule(byMatch, q('Should we bump?'))).toBeUndefined()

  const both = rules([{ topic: 't', match: 'x', answer: 'a' }])
  expect(matchRule(both, q('has x', { topic: 't' }))?.answer).toBe('patch')
  expect(matchRule(both, q('no', { topic: 't' }))).toBeUndefined()

  const from = rules([{ topic: 't', from: 'csv-worker', answer: 'patch' }])
  expect(matchRule(from, q('a', { topic: 't' }, { ...W, name: 'csv-worker-2' }))).toBeDefined()
  expect(matchRule(from, q('a', { topic: 't' }, { ...W, name: 'other' }))).toBeUndefined()

  const soft = rules([{ topic: 't', answer: 'patch' }])
  expect(matchRule(soft, q('a', { topic: 't', blocking: true }))).toBeUndefined()
  const hard = rules([{ topic: 't', answer: 'patch', blocking: true }])
  expect(matchRule(hard, q('a', { topic: 't', blocking: true }))).toBeDefined()

  // An answer that is free text for this question does not apply; the next rule gets its turn.
  const fit = rules([{ topic: 't', answer: 'major' }, { topic: 't', answer: 'minor' }])
  expect(matchRule(fit, q('a', { topic: 't' }))?.rule.rid).toBe('personal:2')
  const first = rules([{ topic: 't', answer: 'patch' }, { topic: 't', answer: 'minor' }])
  expect(matchRule(first, q('a', { topic: 't' }))?.rule.rid).toBe('personal:1')
})

test('ruleFromQuestion: topic when given, else an anchored escaped exact match; blocking carried; no from', () => {
  const a = ruleFromQuestion(q('Bump?', { topic: 'version-bump', blocking: true }), 'patch', '2026-10-10')
  expect(a).toEqual({ topic: 'version-bump', answer: 'patch', blocking: true, note: 'added 2026-10-10 from q1' })
  const b = ruleFromQuestion(q('Use  a.b (x)?\nplease'), 'patch', 'd')
  expect(b.match).toBe('^Use a\\.b \\(x\\)\\? please$')
  expect(b.topic).toBeUndefined()
  expect(b.blocking).toBeUndefined()
  const re = validateRule({ ...b })
  expect('re' in re && re.re?.test('use a.b (x)? please')).toBe(true)
})

test('sameRule, nextRuleId and removeRule', () => {
  expect(sameRule({ topic: 'A', answer: 'x' }, { topic: 'a', answer: 'X' })).toBe(true)
  expect(sameRule({ topic: 'a', answer: 'x' }, { topic: 'a', answer: 'x', blocking: true })).toBe(false)
  expect(nextRuleId([])).toBe('s1')
  expect(nextRuleId(['s1', 'repo:2', 's4'])).toBe('s5')
  const list = [{ id: 's1', topic: 'a', answer: 'x' }, { topic: 'b', answer: 'y' }]
  expect(removeRule(list, 'repo', 'repo:2')).toEqual({ list: [list[0]], removed: true })
  expect(removeRule(list, 'repo', 's1').list).toEqual([list[1]])
  expect(removeRule(list, 'repo', 'zz').removed).toBe(false)
})

test('suggest: the same answer 3 times by main with no rule; ready add call; covered or mixed ones are left out', () => {
  const answeredAll = (): Inbox => {
    let b: Inbox = EMPTY_INBOX
    for (let i = 0; i < 3; i++) {
      b = addQuestions(b, W, 'main', [asked('Bump?', { topic: 'version-bump' })], 1000 + i).inbox
      const m = markAnswered(b, `q${i + 1}`, 'minor', 'main', 2000 + i)
      if (m.kind === 'ok') b = m.inbox
    }
    return b
  }
  const full = answeredAll()
  const s = suggest(full, [])
  expect(s.length).toBe(1)
  expect(s[0]!.times).toBe(3)
  expect(s[0]!.add).toBe('mcp__flow__standing {"action":"add","topic":"version-bump","answer":"minor"}')
  expect(suggest(full, rules([{ topic: 'version-bump', answer: 'minor' }]))).toEqual([])
  // Two answers the same and one different: no suggestion.
  const mixed: Inbox = { ...full, items: full.items.map((x, i) => (i === 0 ? { ...x, answer: 'patch' } : x)) }
  expect(suggest(mixed, [])).toEqual([])
  // Without a topic, identical texts count and the call uses an anchored match.
  const plain: Inbox = { ...full, items: full.items.map(x => { const { topic: _t, ...rest } = x; return rest }) }
  expect(suggest(plain, [])[0]!.add).toContain('"match":"^Bump\\\\?$"')
})

test('the inbox view: Auto-answered section within 24 h, head count line, old inboxes without rule unchanged', () => {
  const first = addQuestions(EMPTY_INBOX, W, 'csv-export', [asked('Bump?', { topic: 't' })], 1000)
  const m = markAnswered(first.inbox, 'q1', 'patch', 'standing answer', 5000, 's1')
  if (m.kind !== 'ok') throw new Error('not marked')
  expect(m.q.rule).toBe('s1')
  expect(m.q.delivered).toBe(true)
  const text = renderInbox(m.inbox, 6000)
  expect(text).toContain('No open questions.')
  expect(text).toContain('Auto-answered')
  expect(text).toContain('q1 csv-worker: Bump? -> patch (rule s1)')
  expect(text).toContain('mcp__flow__standing remove')
  expect(renderInbox(m.inbox, 5000 + 25 * 3_600_000)).toBe('No open questions.')
  expect(inboxHead(m.inbox, 6000)[0]).toContain('1 auto-answered')
  expect(inboxHead(first.inbox, 6000)[0]).toContain('1 open')
})

// ---- through the plugin ----

function world(on: On, files = new Map<string, string>()) {
  mock.clock(on, { now: 1_000_000 })
  const agents: AgentInfo[] = [
    { id: 'm1', name: 'csv-export', description: 'm', type: 'flow:manager', status: 'running' },
    { id: 'w1', name: 'csv-worker', description: 'w', type: 'flow:worker', status: 'running', parentId: 'm1' },
  ]
  const sent: { to: string; text: string }[] = []
  const toasts: string[] = []
  on('agent.list', () => ({ value: agents }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', (_, e) => { toasts.push(String((e as { text?: string }).text)); return { value: undefined } })
  on('session.send', (_, e) => {
    const raw = (e as unknown as { to: string | { agentId: string } }).to
    sent.push({ to: typeof raw === 'string' ? raw : raw.agentId, text: e.text })
    return { isDelivered: true as const }
  })
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('fs.read', (_, e) => {
    const t = files.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('process.run', (_, e) => {
    const a = e.argv
    if (a[0] === 'git' && a[1] === 'rev-parse') return ok('/r/.git\n')
    if (a[0] === 'mv') {
      const t = files.get(a[1] ?? '')
      if (t !== undefined) { files.set(a[2] ?? '', t); files.delete(a[1] ?? '') }
    }
    if (a[0] === 'sh' && a[1] === '-c') files.set(String(a[5]), `${files.get(String(a[5])) ?? ''}${String(a[4])}\n`)
    return ok()
  })
  return { agents, files, sent, toasts }
}

const call = ($: Dollar, tool: string, agentId: string | null, args: Record<string, unknown>) =>
  $.tool.call({ tool, ...args, ...(agentId === null ? {} : { agentId }) } as never).then(r => String(r.result))
const ask = ($: Dollar, agentId: string | null, questions: unknown[]) => call($, 'mcp__flow__ask', agentId, { from: 'x', questions })
const answer = ($: Dollar, agentId: string | null, args: Record<string, unknown>) => call($, 'mcp__flow__answer', agentId, args)
const standing = ($: Dollar, agentId: string | null, args: Record<string, unknown>) => call($, 'mcp__flow__standing', agentId, args)
const inbox = ($: Dollar) => $.command.run({ command: 'flow', args: 'inbox' } as never).then(r => r.text ?? '')
const notes = (files: Map<string, string>) => files.get(`${DIR}/managers/csv-export/notes.md`) ?? ''
const stored = (files: Map<string, string>) => (JSON.parse(files.get(`${DIR}/inbox.json`) ?? '{"items":[]}') as { items: Question[] }).items

const BUMP = { question: 'Which bump?', options: ['patch', 'minor'], default: 'patch', blocking: false, topic: 'version-bump' }
const BLOCK = { question: 'Which format?', options: ['csv', 'tsv'], default: 'csv', blocking: true, topic: 'format' }
const personalRules = (files: Map<string, string>) => (JSON.parse(files.get(PERSONAL) ?? '{}') as { standing_answers?: Array<Record<string, unknown>> }).standing_answers ?? []

test('a repo-file rule answers a fresh ask at once: stored and answered, no message, note and log', async ($, on) => {
  const w = world(on, new Map([[REPO, JSON.stringify({ standing_answers: [{ id: 'r1', topic: 'version-bump', answer: 'minor' }] })]]))
  const r = await ask($, 'w1', [BUMP])
  expect(r).toBe('q1: answered by standing answer r1: minor. Carry on from it.')
  expect(w.sent).toEqual([])
  expect(w.toasts).toEqual([])
  const item = stored(w.files)[0]!
  expect(item.state).toBe('answered')
  expect(item.answer).toBe('minor')
  expect(item.answeredBy).toBe('standing answer')
  expect(item.rule).toBe('r1')
  expect(notes(w.files)).toContain('decision: "q1 Which bump?: minor"')
  expect(notes(w.files)).not.toContain('assumed')
  const log = w.files.get(`${DIR}/log.jsonl`) ?? ''
  expect(log).toContain('"event":"auto-answer"')
  expect(log).toContain('q1 rule r1: minor')
  const view = await inbox($)
  expect(view).toContain('Auto-answered')
  expect(view).toContain('q1 csv-worker: Which bump? -> minor (rule r1)')
})

test('a batch mixes auto-answered and open questions: only the open ones reach the manager; blocking needs blocking: true', async ($, on) => {
  const w = world(on, new Map([[REPO, JSON.stringify({ standing_answers: [{ id: 'r1', topic: 'version-bump', answer: 'minor' }, { topic: 'format', answer: 'tsv' }] })]]))
  const r = await ask($, 'w1', [BUMP, BLOCK])
  expect(r).toContain('q1: answered by standing answer r1')
  expect(r).toContain('q2: end your turn now')
  expect(w.sent.length).toBe(1)
  expect(w.sent[0]!.text).toContain('q2 (blocking)')
  expect(w.sent[0]!.text).not.toContain('q1')
  // The open blocking one still counts as asking, the auto-answered one does not.
  expect(stored(w.files).map(i => i.state)).toEqual(['answered', 'open'])
})

test('a blocking rule answers a blocking question; a rule whose answer is not an option leaves it in the inbox', async ($, on) => {
  const w = world(on, new Map([[REPO, JSON.stringify({ standing_answers: [{ topic: 'format', answer: 'json', blocking: true }, { topic: 'format', answer: 'b', blocking: true }] })]]))
  const r = await ask($, 'w1', [BLOCK])
  expect(r).toContain('q1: answered by standing answer repo:2: tsv')
  expect(w.sent).toEqual([])
})

test('a rule whose answer is not an option of the question leaves it in the inbox', async ($, on) => {
  const w = world(on, new Map([[REPO, JSON.stringify({ standing_answers: [{ topic: 'format', answer: 'json', blocking: true }] })]]))
  expect(await ask($, 'w1', [BLOCK])).toContain('end your turn now')
  expect(w.sent.length).toBe(1)
})

test('a duplicate ask is not re-answered', async ($, on) => {
  const w = world(on)
  await ask($, 'w1', [BUMP])
  await standing($, null, { action: 'add', topic: 'version-bump', answer: 'minor' })
  const again = await ask($, 'w1', [BUMP])
  expect(again).toContain('already asked as q1')
  expect(stored(w.files)[0]!.state).toBe('open')
})

test('always:true by main answers, writes the personal file keeping other keys, and the next ask is auto-answered', async ($, on) => {
  const w = world(on, new Map([[PERSONAL, JSON.stringify({ language: 'German', standing_answers: [{ id: 's7', topic: 'zzz', answer: 'a' }] })]]))
  await ask($, 'm1', [BUMP])
  const r = await answer($, null, { answers: [{ id: 'q1', choice: 'b', always: true }] })
  expect(r).toContain('q1: minor')
  expect(r).toContain('rule s8 added: topic version-bump -> "minor"')
  expect(r).toContain('"action":"remove","id":"s8"')
  const file = JSON.parse(w.files.get(PERSONAL)!) as { language: string; standing_answers: Array<Record<string, unknown>> }
  expect(file.language).toBe('German')
  expect(file.standing_answers.length).toBe(2)
  expect(file.standing_answers[0]!.id).toBe('s7')
  expect(file.standing_answers[1]).toMatchObject({ id: 's8', topic: 'version-bump', answer: 'minor' })
  expect(file.standing_answers[1]!.blocking).toBeUndefined()
  expect(file.standing_answers[1]!.from).toBeUndefined()
  expect(String(file.standing_answers[1]!.note)).toContain('from q1')
  // The very next ask, with no roster poll in between.
  const next = await ask($, 'm1', [{ ...BUMP, question: 'Bump again?' }])
  expect(next).toContain('answered by standing answer s8: minor')
})

test('always on a topicless question makes an anchored exact match; a blocking one makes a blocking rule', async ($, on) => {
  const w = world(on)
  await ask($, 'm1', [{ question: 'Use tabs (y/n)?', options: ['yes', 'no'], default: 'yes', blocking: true }])
  await answer($, null, { answers: [{ id: 'q1', choice: 'no', always: true }] })
  expect(personalRules(w.files)[0]).toMatchObject({ id: 's1', match: '^Use tabs \\(y/n\\)\\?$', answer: 'no', blocking: true })
  expect(await ask($, 'w1', [{ question: ' use  tabs (y/n)? ', options: ['yes', 'no'], default: 'yes', blocking: true }])).toContain('answered by standing answer s1: no')
})

test('always: a manager gets the answer but no rule; free text and an answered question make no rule; the same rule is not added twice', async ($, on) => {
  const w = world(on)
  await ask($, 'w1', [BUMP])
  const m = await answer($, 'm1', { answers: [{ id: 'q1', choice: 'minor', always: true }] })
  expect(m).toContain('q1: minor')
  expect(m).toContain('only main makes standing answers')
  expect(personalRules(w.files)).toEqual([])

  await ask($, 'm1', [{ ...BUMP, question: 'B2' }])
  const free = await answer($, null, { answers: [{ id: 'q2', choice: 'something else', always: true }] })
  expect(free).toContain('free-text answer cannot be a rule')
  expect(personalRules(w.files)).toEqual([])

  const again = await answer($, null, { answers: [{ id: 'q2', choice: 'minor', always: true }] })
  expect(again).toContain('already answered')
  expect(again).toContain('no rule made')

  await ask($, 'm1', [{ ...BUMP, question: 'B3' }])
  expect(await answer($, null, { answers: [{ id: 'q3', choice: 'minor', always: true }] })).toContain('rule s1 added')
  await ask($, 'm1', [{ ...BUMP, question: 'B4', topic: 'other' }])
  const other = await answer($, null, { answers: [{ id: 'q4', choice: 'minor', always: true }] })
  expect(other).toContain('rule s2 added')
  expect(personalRules(w.files).length).toBe(2)
})

test('two always answers at once keep both rules', async ($, on) => {
  const w = world(on)
  await ask($, 'm1', [{ ...BUMP, topic: 'a' }, { ...BUMP, question: 'Second?', topic: 'b' }])
  const [x, y] = await Promise.all([
    answer($, null, { answers: [{ id: 'q1', choice: 'patch', always: true }] }),
    answer($, null, { answers: [{ id: 'q2', choice: 'minor', always: true }] }),
  ])
  expect(x + y).toContain('added')
  expect(personalRules(w.files).map(r => r.topic).sort()).toEqual(['a', 'b'])
  expect(new Set(personalRules(w.files).map(r => r.id)).size).toBe(2)
})

test('an invalid personal config.json is never rewritten', async ($, on) => {
  const w = world(on, new Map([[PERSONAL, '{oops']]))
  await ask($, 'm1', [BUMP])
  const r = await answer($, null, { answers: [{ id: 'q1', choice: 'patch', always: true }] })
  expect(r).toContain('no rule made')
  expect(r).toContain('not valid JSON')
  expect(w.files.get(PERSONAL)).toBe('{oops')
})

test('standing: refused for agents; list shows rules with counts and suggestions; add, remove (personal and repo)', async ($, on) => {
  const w = world(on, new Map([[REPO, JSON.stringify({ language: 'x', standing_answers: [{ topic: 'format', answer: 'csv' }] })]]))
  expect(await standing($, 'm1', { action: 'list' })).toContain('only main')
  expect(await standing($, 'w1', { action: 'add', topic: 'a', answer: 'b' })).toContain('only main')

  expect(await standing($, null, { action: 'add', answer: 'x' })).toContain('needs a topic or a match')
  expect(await standing($, null, { action: 'add', match: '(', answer: 'x' })).toContain('invalid match regex')
  const added = await standing($, null, { action: 'add', topic: 'version-bump', answer: 'minor' })
  expect(added).toContain('Rule s1 added')
  expect(await standing($, null, { action: 'add', topic: 'version-bump', answer: 'minor' })).toContain('Rule s1 already')

  await ask($, 'w1', [BUMP])
  const list = await standing($, null, { action: 'list' })
  expect(list).toContain('s1 [personal file] topic version-bump -> "minor", answered 1x')
  expect(list).toContain('repo:1 [repo file (committed)] topic format -> "csv"')
  expect(list.indexOf('s1 [')).toBeLessThan(list.indexOf('repo:1 ['))

  // Suggestions: three manual answers to the same kind of question.
  for (const n of [1, 2, 3]) {
    await ask($, 'm1', [{ question: `Squash ${n}?`, options: ['yes', 'no'], default: 'yes', blocking: false, topic: 'squash' }])
    await answer($, null, { answers: [{ id: `q${n + 1}`, choice: 'no' }] })
  }
  const sug = await standing($, null, { action: 'list' })
  expect(sug).toContain('Suggested')
  expect(sug).toContain('mcp__flow__standing {"action":"add","topic":"squash","answer":"no"}')

  expect(await standing($, null, { action: 'remove', id: 'zz' })).toContain('no such rule')
  expect(await standing($, null, { action: 'remove', id: 's1' })).toContain('removed from')
  expect(personalRules(w.files)).toEqual([])
  const rm = await standing($, null, { action: 'remove', id: 'repo:1' })
  expect(rm).toContain('committed file')
  const repo = JSON.parse(w.files.get(REPO)!) as { language: string; standing_answers: unknown[] }
  expect(repo.language).toBe('x')
  expect(repo.standing_answers).toEqual([])
})

test('status shows the auto-answered count line', async ($, on) => {
  world(on, new Map([[REPO, JSON.stringify({ standing_answers: [{ topic: 'version-bump', answer: 'minor' }] })]]))
  await ask($, 'w1', [BUMP])
  const out = String((await $.tool.call({ tool: 'mcp__flow__status' } as never)).result)
  expect(out.startsWith('Inbox: 1 auto-answered')).toBe(true)
})

// ---- escalate, "default" and seeds ----

test('validateRule: escalate takes no answer; "default" is normalised; old rules read back unchanged', () => {
  const e = validateRule({ topic: 't', escalate: true })
  expect('rule' in e && e.rule).toEqual({ topic: 't', escalate: true })
  expect(validateRule({ topic: 't', escalate: true, answer: 'x' })).toEqual({ error: 'an escalate rule takes no answer' })
  expect('error' in validateRule({ topic: 't', escalate: 'yes' })).toBe(true)
  expect(validateRule({ topic: 't' })).toEqual({ error: 'needs an answer' })
  expect(validateRule({ topic: 't', escalate: false })).toEqual({ error: 'needs an answer' })
  const d = validateRule({ match: '.', answer: ' Default ' })
  expect('rule' in d && d.rule.answer).toBe('default')
  const warnings: string[] = []
  expect(parseRules([{ topic: 'a', escalate: true, answer: 'x' }], 'repo', 'f', warnings)).toEqual([])
  expect(warnings[0]).toContain('an escalate rule takes no answer')
})

test('matchRule: escalate beats every rule; "default" answers non-blocking questions only', () => {
  const bump = q('Which bump?', { topic: 'version-bump' })
  const blocking = q('Which bump?', { topic: 'version-bump', blocking: true })
  const def = rules([{ match: '.', answer: 'default', blocking: true }])
  expect(matchRule(def, bump)?.answer).toBe('patch')
  expect(matchRule(def, blocking)).toBeUndefined()
  const esc = rules([{ topic: 'version-bump', answer: 'minor' }, { topic: 'version-bump', escalate: true }])
  expect(matchRule(esc, bump)).toBeUndefined()
  expect(escalation(esc, blocking)?.rid).toBe('personal:2')
  expect(escalation(esc, q('Other?', { topic: 'x' }))).toBeUndefined()
  expect(matchRule(rules([{ topic: 'x', answer: 'minor' }]), bump)).toBeUndefined()
})

test('sameRule tells escalate from answer; renderRules describes the new forms', () => {
  expect(sameRule({ topic: 't', escalate: true }, { topic: 't', escalate: true })).toBe(true)
  expect(sameRule({ topic: 't', escalate: true }, { topic: 't', answer: 'a' })).toBe(false)
  const out = renderRules(rules([{ topic: 't', escalate: true }, { match: '.', answer: 'default' }]), EMPTY_INBOX, [])
  expect(out).toContain('ESCALATE')
  expect(out).toContain('"default" (the question\'s own default')
})

test('seeds: offered with no rules, partly accepted ones filtered, hidden once a rule of your own exists', () => {
  expect(SEEDS.map(s => s.id)).toEqual(['tracker', 'prod-env', 'conservative'])
  expect(seedsToOffer([]).length).toBe(3)
  const text = renderRules([], EMPTY_INBOX, [], seedsToOffer([]))
  expect(text).toContain('No standing answers.')
  expect(text).toContain('Suggested starting rules (not applied):')
  expect(text).toContain('mcp__flow__standing {"action":"add","seed":"tracker"}')
  expect(seedsToOffer(rules([SEEDS[0]!.rule])).map(s => s.id)).toEqual(['prod-env', 'conservative'])
  expect(seedsToOffer(rules(SEEDS.map(s => s.rule)))).toEqual([])
  expect(seedsToOffer(rules([SEEDS[0]!.rule, { topic: 'format', answer: 'csv' }]))).toEqual([])
})

const statusText = ($: Dollar) => $.tool.call({ tool: 'mcp__flow__status' } as never).then(r => String(r.result))

test('standing list shows the seeds with no rules; add by seed, twice, several, unknown', async ($, on) => {
  const w = world(on)
  expect(await standing($, null, { action: 'list' })).toContain('Suggested starting rules (not applied)')
  expect(personalRules(w.files)).toEqual([])
  expect(await standing($, null, { action: 'add', seed: 'nope' })).toContain('ids are tracker, prod-env, conservative')
  expect(personalRules(w.files)).toEqual([])
  expect(await standing($, null, { action: 'add', seed: 'tracker' })).toContain('tracker: rule s1 added')
  expect(personalRules(w.files)[0]).toMatchObject({ id: 's1', topic: 'external-tracker', escalate: true })
  expect(String(personalRules(w.files)[0]!.note)).toMatch(/^seed tracker, added \d{4}-\d\d-\d\d$/)
  const again = await standing($, null, { action: 'add', seeds: ['tracker', 'conservative'] })
  expect(again).toContain('tracker: already there as rule s1')
  expect(again).toContain('conservative: rule s2 added')
  expect(personalRules(w.files).length).toBe(2)
  const after = await standing($, null, { action: 'list' })
  expect(after).toContain('ESCALATE')
  expect(after).toContain('"seed":"prod-env"')
  expect(after).not.toContain('"seed":"tracker"')
  expect(await standing($, 'm1', { action: 'add', seed: 'tracker' })).toContain('only main')
})

test('status offers the seeds once, then never again; never when a rule exists', async ($, on) => {
  const w = world(on)
  expect(await statusText($)).toContain('Suggested starting rules (not applied)')
  expect(w.files.has(`${DIR}/seeds-offered.json`)).toBe(true)
  expect(await statusText($)).not.toContain('Suggested starting rules')
  expect(await standing($, null, { action: 'list' })).toContain('Suggested starting rules')
})

test('status shows no seeds when a rule already exists', async ($, on) => {
  const w = world(on, new Map([[REPO, JSON.stringify({ standing_answers: [{ topic: 'format', answer: 'csv' }] })]]))
  expect(await statusText($)).not.toContain('Suggested starting rules')
  expect(w.files.has(`${DIR}/seeds-offered.json`)).toBe(false)
})

test('an escalate rule forces blocking, flags the question, tells the manager, and refuses a manager\'s answer', async ($, on) => {
  const w = world(on)
  await standing($, null, { action: 'add', seeds: ['tracker', 'conservative'] })
  const TRACK = { question: 'Comment on the card?', options: ['yes', 'no'], default: 'no', blocking: false, topic: 'external-tracker' }
  expect(await ask($, 'w1', [TRACK])).toContain('end your turn now')
  const item = stored(w.files)[0]!
  expect(item.state).toBe('open')
  expect(item.blocking).toBe(true)
  expect(item.escalated).toBe('s1')
  expect(w.sent[0]!.text).toContain('standing rule (s1) makes this the user\'s decision')
  expect(await answer($, 'm1', { answers: [{ id: 'q1', choice: 'yes' }] })).toContain('refused, standing rule s1 makes this the user\'s decision')
  expect(await answer($, 'm1', { defaults: true })).toContain('refused, standing rule s1')
  expect(stored(w.files)[0]!.state).toBe('open')
  // A manager's own question goes to main, blocking.
  expect(await ask($, 'm1', [{ ...TRACK, question: 'Close the card?' }])).toContain('q2: end your turn now')
  expect(stored(w.files)[1]!.addressee).toBe('main')
  expect(w.toasts.length).toBe(1)
  expect(await answer($, null, { answers: [{ id: 'q2', choice: 'no' }] })).toContain('q2: no')
  expect(stored(w.files)[1]!.answeredBy).toBe('main')
})

test('the conservative seed ("default") auto-answers a non-blocking ask and leaves a blocking one', async ($, on) => {
  const w = world(on)
  await standing($, null, { action: 'add', seed: 'conservative' })
  expect(await ask($, 'w1', [BUMP])).toBe('q1: answered by standing answer s1: patch. Carry on from it.')
  expect(await ask($, 'w1', [BLOCK])).toContain('q2: end your turn now')
  expect(stored(w.files).map(i => i.state)).toEqual(['answered', 'open'])
})
