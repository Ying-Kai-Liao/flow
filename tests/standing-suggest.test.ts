import type { AgentInfo } from 'claude-code'
import { expect, mock } from 'claude-code/testing'
import { test } from './support'
import type { TestBody } from 'claude-code/testing'
import { addQuestions, EMPTY_INBOX, fyiAsked, markAnswered } from '../hooks/inbox'
import type { AskedQuestion, Inbox, Question } from '../hooks/inbox'
import { CONSERVATIVE, fyiRules, matchRule, normTopic, parseRules, ruleFromQuestion, sameRule, suggest, validateRule } from '../hooks/standing'
import type { Resolved } from '../hooks/standing'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const DIR = '/r/.git/flow'
const PERSONAL = `${DIR}/config.json`
const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const rules = (list: unknown[]): Resolved[] => parseRules(list, 'personal', 'f', [])

// ---- pure half ----

// A trimmed copy of the real inbox shape (/Users/Kath/Workspace/flow/.git/flow/inbox.json): only topics, kinds,
// states and answers; the texts are placeholders.
type Row = { id: string; kind?: string; topic?: string; owner: string; state: 'answered' | 'open'; answer?: string; answeredBy?: string; options?: string[] }
const row = (r: Row): Question => ({
  question: `text of ${r.id}`, options: ['Keep', 'Undo'], default: 'Keep', blocking: false, addressee: 'main', askedAt: 1, delivered: true, ...r,
}) as Question
const many = (n: number, mk: (i: number) => Row): Question[] => Array.from({ length: n }, (_, i) => row(mk(i)))
const FIXTURE: Inbox = {
  next: 9, items: [
    ...many(30, i => ({ id: `d${i + 1}`, kind: 'fyi', topic: 'worker-size', owner: 'a', state: 'answered' as const, answer: 'Keep', answeredBy: 'main' })),
    ...many(26, i => ({ id: `d${i + 40}`, kind: 'fyi', topic: 'manager-size', owner: 'b', state: 'answered' as const, answer: 'Keep', answeredBy: 'main' })),
    ...many(2, i => ({ id: `d${i + 80}`, kind: 'fyi', topic: 'jev-sizing', owner: 'b', state: 'answered' as const, answer: 'Keep', answeredBy: 'main' })),
    ...many(13, i => ({ id: `d${i + 90}`, kind: 'fyi', owner: 'c', state: 'open' as const })),
    ...many(3, i => ({ id: `q${i + 1}`, kind: 'deploy', owner: 'r', state: 'answered' as const, answer: 'deploy', answeredBy: 'main', options: ['deploy', 'hold'] })),
    ...many(3, i => ({ id: `q${i + 10}`, kind: 'env', owner: 'r', state: 'answered' as const, answer: 'done', answeredBy: 'main', options: ['done', 'skip'] })),
    ...many(2, i => ({ id: `q${i + 20}`, kind: 'push', owner: 'r', state: 'answered' as const, answer: 'push', answeredBy: 'user', options: ['push', 'wait'] })),
  ],
}

test('with the real inbox shape and no rules, suggest proposes worker-size and manager-size Keep as FYI rules and nothing hard', () => {
  const s = suggest(FIXTURE, [])
  expect(s.map(x => x.add)).toContain('mcp__flow__standing {"action":"add","topic":"worker-size","answer":"Keep","kinds":["fyi"]}')
  expect(s.map(x => x.add)).toContain('mcp__flow__standing {"action":"add","topic":"manager-size","answer":"Keep","kinds":["fyi"]}')
  // jev-sizing was kept only twice.
  expect(s.some(x => x.label.includes('jev'))).toBe(false)
  expect(s.every(x => x.fyi)).toBe(true)
  expect(s.some(x => /deploy|env|push/.test(x.add + x.key))).toBe(false)
  // A rule naming kind fyi covers the group; an ordinary rule on the topic does not (it never reaches decisions).
  const covered = suggest(FIXTURE, rules([{ topic: 'worker-size', answer: 'Keep', kinds: ['fyi'] }]))
  expect(covered.map(x => x.label)).toEqual(['decisions topic manager-size'])
  expect(suggest(FIXTURE, rules([{ topic: 'worker-size', answer: 'Keep' }])).length).toBe(2)
})

test('size decisions kept by default are not main\'s answers: they suggest no rule', () => {
  const box: Inbox = { next: 1, items: many(5, i => ({ id: `d${i + 1}`, kind: 'fyi', topic: 'worker-size', owner: 'a', state: 'answered' as const, answer: 'Keep', answeredBy: 'default' })) }
  expect(suggest(box, [])).toEqual([])
})

test('the built-in conservative rule does not count as covering a group main answered itself', () => {
  const asks = many(3, i => ({ id: `q${i + 1}`, topic: 'bump', owner: 'a', state: 'answered' as const, answer: 'minor', answeredBy: 'main', options: ['patch', 'minor'] }))
  const box: Inbox = { next: 4, items: asks.map(q => ({ ...q, kind: undefined, default: 'patch' })) }
  expect(suggest(box, [CONSERVATIVE]).map(x => x.answer)).toEqual(['minor'])
  expect(suggest(box, [...rules([{ topic: 'bump', answer: 'minor' }]), CONSERVATIVE])).toEqual([])
})

test('a group holding a deploy, env, guard, escalated or linked item is never suggested', () => {
  const kept = (extra: Record<string, unknown>) => ({ ...FIXTURE, items: [
    ...many(3, i => ({ id: `d${i + 1}`, kind: 'fyi', topic: 'x', owner: 'a', state: 'answered' as const, answer: 'Keep', answeredBy: 'main' })),
    { ...row({ id: 'd9', kind: 'fyi', topic: 'x', owner: 'a', state: 'open' }), ...extra },
  ] })
  expect(suggest(kept({}), []).length).toBe(1)
  for (const extra of [{ escalated: 's1' }, { forQ: 'q1' }, { viaQ: 'q2' }, { guard: { glob: '*', test: 't' } }, { env: { name: 'A', target: 't', role: 'r' } }]) {
    expect(suggest(kept(extra), [])).toEqual([])
  }
})

test('topics compare normalized: case, _ - space and one trailing s', () => {
  expect(normTopic('Worker_Sizes')).toBe(normTopic('worker size'))
  expect(normTopic('worker-size')).toBe('worker-size')
  expect(normTopic('class')).not.toBe(normTopic('clas'.concat('x')))
  const q = row({ id: 'd1', kind: 'fyi', topic: 'Worker Sizes', owner: 'a', state: 'open' })
  expect(matchRule(rules([{ topic: 'worker_size', answer: 'Keep', kinds: ['fyi'] }]), q)?.answer).toBe('Keep')
  expect(sameRule({ topic: 'Worker_Size', answer: 'Keep' }, { topic: 'worker-sizes', answer: 'keep' })).toBe(true)
  // Grouping uses the same form: three spellings are one group.
  const spelled = ['worker-size', 'Worker_Size', 'worker sizes'].map((topic, i) => row({ id: `d${i + 1}`, kind: 'fyi', topic, owner: 'a', state: 'answered', answer: 'Keep', answeredBy: 'main' }))
  expect(suggest({ next: 1, items: spelled }, []).length).toBe(1)
})

test('FYI rules: only a rule naming kind fyi reaches a decision, and a fyi rule never answers a question', () => {
  const fyiQ = row({ id: 'd1', kind: 'fyi', topic: 't', owner: 'a', state: 'open' })
  const ask = { ...row({ id: 'q1', topic: 't', owner: 'a', state: 'open' }), kind: undefined, options: ['Keep', 'Undo'] } as Question
  // fyiRules is what mcp__flow__fyi consults: an ordinary rule or a kinds ["ask"] rule is not in it.
  expect(matchRule(fyiRules(rules([{ topic: 't', answer: 'Keep' }])), fyiQ)).toBeUndefined()
  expect(matchRule(fyiRules(rules([{ topic: 't', answer: 'Keep', kinds: ['ask'] }])), fyiQ)).toBeUndefined()
  expect(matchRule(fyiRules(rules([{ topic: 't', answer: 'Keep', kinds: ['fyi'] }])), fyiQ)?.answer).toBe('Keep')
  expect(matchRule(rules([{ topic: 't', answer: 'Keep', kinds: ['fyi'] }]), ask)).toBeUndefined()
  expect(matchRule(rules([{ topic: 't', answer: 'Keep' }]), ask)?.answer).toBe('Keep')
  // Without kinds a rule is for questions only, whatever list it is passed in: it never undoes or keeps a decision.
  expect(matchRule(rules([{ topic: 't', answer: 'Undo' }]), fyiQ)).toBeUndefined()
  expect(matchRule(rules([{ match: '.', answer: 'default' }]), fyiQ)).toBeUndefined()
  expect(matchRule([CONSERVATIVE], fyiQ)).toBeUndefined()
  // An escalate rule still beats everything.
  expect(matchRule(fyiRules(rules([{ topic: 't', escalate: true }, { topic: 't', answer: 'Keep', kinds: ['fyi'] }])), fyiQ)).toBeUndefined()
  // Deploy, env, push and reviewer: never, also by a rule that names the kind (it is ignored).
  for (const kind of ['deploy', 'env', 'push', 'reviewer']) {
    const hard = { ...fyiQ, kind, options: ['Keep', 'Undo'] } as Question
    expect(matchRule(rules([{ topic: 't', answer: 'Keep', kinds: ['fyi'] }, { topic: 't', answer: 'Keep' }, { topic: 't', answer: 'Keep', kinds: [kind] }, CONSERVATIVE.rule]), hard)).toBeUndefined()
  }
  // A rule never undoes a decision.
  expect('error' in validateRule({ topic: 't', answer: 'Undo', kinds: ['fyi'] })).toBe(true)
  expect('error' in validateRule({ topic: 't', answer: 'Keep', kinds: ['fyi'] })).toBe(false)
})

test('a topic-less rule records the option set and matches only a question with the same set and text', () => {
  const asked = (question: string, options: string[]): AskedQuestion => ({ question, options, default: options[0]!, blocking: false })
  const made = addQuestions(EMPTY_INBOX, { name: 'w', isManager: false }, 'main', [asked('Use tabs?', ['yes', 'no'])], 1).added[0]!.q
  const rule = ruleFromQuestion(made, 'no', '2026-10-13')
  expect(rule.options).toEqual(['yes', 'no'])
  const rs = rules([rule])
  const same = (text: string, options: string[]) => addQuestions(EMPTY_INBOX, { name: 'w', isManager: false }, 'main', [asked(text, options)], 1).added[0]!.q
  expect(matchRule(rs, same(' use  TABS? ', ['no', 'yes']))?.answer).toBe('no')
  expect(matchRule(rs, same('Use tabs?', ['yes', 'no', 'maybe']))).toBeUndefined()
  expect(matchRule(rs, same('Use tabs? Really', ['yes', 'no']))).toBeUndefined()
  // Old rules without options keep matching by text alone.
  expect(matchRule(rules([{ match: '^Use tabs\\?$', answer: 'no' }]), same('Use tabs?', ['yes', 'no', 'maybe']))?.answer).toBe('no')
  expect(sameRule(rule, { ...rule, options: ['yes', 'no', 'maybe'] })).toBe(false)
})

test('a kept decision from the real flow: markAnswered by a rule can be undone like a main-kept one', () => {
  const added = addQuestions(EMPTY_INBOX, { name: 'w', isManager: false }, 'main', [fyiAsked({ decision: 'd', why: 'w', topic: 't' })], 1, 'fyi')
  const kept = markAnswered(added.inbox, 'd1', 'Keep', 'standing answer', 2, 's1')
  if (kept.kind !== 'ok') throw new Error('not kept')
  expect(kept.q.rule).toBe('s1')
  const undone = markAnswered(kept.inbox, 'd1', 'Undo', 'main', 3)
  expect(undone.kind).toBe('ok')
  if (undone.kind === 'ok') {
    expect(undone.answer).toBe('Undo')
    expect(undone.q.rule).toBeUndefined()
  }
  // Keep again changes nothing.
  expect(markAnswered(kept.inbox, 'd1', 'Keep', 'main', 3).kind).toBe('answered')
})

// ---- through the plugin ----

function world(on: On, files = new Map<string, string>()) {
  mock.clock(on, { now: 1_000_000 })
  const agents: AgentInfo[] = [
    { id: 'm1', name: 'csv-export', description: 'm', type: 'flow:manager', status: 'running' },
    { id: 'w1', name: 'csv-worker', description: 'w', type: 'flow:worker', status: 'running', parentId: 'm1' },
  ]
  const sent: { to: string; text: string }[] = []
  on('agent.list', () => ({ value: agents }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
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
  return { files, sent }
}

const call = ($: Dollar, tool: string, agentId: string | null, args: Record<string, unknown>) =>
  $.tool.call({ tool, ...args, ...(agentId === null ? {} : { agentId }) } as never).then(r => String(r.result))
const ask = ($: Dollar, agentId: string | null, questions: unknown[]) => call($, 'mcp__flow__ask', agentId, { from: 'x', questions })
const answer = ($: Dollar, agentId: string | null, args: Record<string, unknown>) => call($, 'mcp__flow__answer', agentId, args)
const standing = ($: Dollar, agentId: string | null, args: Record<string, unknown>) => call($, 'mcp__flow__standing', agentId, args)
const fyi = ($: Dollar, agentId: string | null, items: unknown[]) => call($, 'mcp__flow__fyi', agentId, { from: 'x', items })
const stored = (files: Map<string, string>) => (JSON.parse(files.get(`${DIR}/inbox.json`) ?? '{"items":[]}') as { items: Question[] }).items
const personalRules = (files: Map<string, string>) => (JSON.parse(files.get(PERSONAL) ?? '{}') as { standing_answers?: Array<Record<string, unknown>> }).standing_answers ?? []

const BUMP = (n: number) => ({ question: `Which bump ${n}?`, options: ['patch', 'minor'], default: 'patch', blocking: false, topic: 'Version_Bumps' })

test('the third same answer by main offers the rule once, with the exact add call, and writes nothing', async ($, on) => {
  const w = world(on)
  await ask($, 'm1', [BUMP(1), BUMP(2), BUMP(3), BUMP(4)])
  const one = await answer($, null, { answers: [{ id: 'q1', choice: 'minor' }, { id: 'q2', choice: 'minor' }] })
  expect(one).not.toContain('Standing answer?')
  const three = await answer($, null, { answers: [{ id: 'q3', choice: 'minor' }] })
  expect(three).toContain('Standing answer? topic Version_Bumps answered "minor" 3 times')
  expect(three).toContain('mcp__flow__standing {"action":"add","topic":"Version_Bumps","answer":"minor"}')
  expect(three.split('Standing answer?').length).toBe(2)
  expect(personalRules(w.files)).toEqual([])
  // Offered once: the fourth answer does not repeat it.
  expect(await answer($, null, { answers: [{ id: 'q4', choice: 'minor' }] })).not.toContain('Standing answer?')
  expect(personalRules(w.files)).toEqual([])
  expect(w.files.get(`${DIR}/suggest-offered.json`)).toContain('minor')
})

test('a dismissed suggestion is not offered again; a corrupt state file means nothing offered yet', async ($, on) => {
  const w = world(on)
  await ask($, 'm1', [BUMP(1), BUMP(2), BUMP(3)])
  await answer($, null, { answers: [{ id: 'q1', choice: 'minor' }, { id: 'q2', choice: 'minor' }] })
  expect(await standing($, 'w1', { action: 'dismiss', id: 'all' })).toContain('Refused')
  expect(await standing($, null, { action: 'dismiss', id: 'nope' })).toContain('no such open suggestion')
  expect(await standing($, null, { action: 'dismiss' })).toContain('needs the suggestion id')
  const list = await standing($, null, { action: 'list' })
  expect(list).toContain('Suggested')
  w.files.set(`${DIR}/suggest-offered.json`, '{not json')
  const third = await answer($, null, { answers: [{ id: 'q3', choice: 'minor' }] })
  expect(third).toContain('Standing answer?')
  const id = /"id":"([^"]+)"/.exec(third)![1]!
  expect(await standing($, null, { action: 'dismiss', id })).toContain('Dismissed 1')
  await ask($, 'm1', [BUMP(5)])
  expect(await answer($, null, { answers: [{ id: 'q4', choice: 'minor' }] })).not.toContain('Standing answer?')
  expect(personalRules(w.files)).toEqual([])
})

test('a suggestion already covered by a rule is not offered', async ($, on) => {
  const w = world(on)
  await standing($, null, { action: 'add', topic: 'version-bump', answer: 'minor' })
  await ask($, 'm1', [BUMP(1), BUMP(2), BUMP(3)])
  const r = await answer($, null, { answers: [{ id: 'q1', choice: 'minor' }, { id: 'q2', choice: 'minor' }, { id: 'q3', choice: 'minor' }] })
  expect(r).not.toContain('Standing answer?')
  expect(personalRules(w.files).length).toBe(1)
})

test('kept decisions: the third keep offers an fyi rule; once added, a fresh decision of that topic is kept by it', async ($, on) => {
  const w = world(on)
  const D = (n: number, topic = 'worker-size') => ({ decision: `Size call ${n}`, why: 'routine', topic })
  for (const n of [1, 2, 3]) await fyi($, 'w1', [D(n)])
  const one = await answer($, null, { answers: [{ id: 'd1', choice: 'Keep' }, { id: 'd2', choice: 'Keep' }] })
  expect(one).not.toContain('Standing answer?')
  const three = await answer($, null, { answers: [{ id: 'd3', choice: 'Keep' }] })
  expect(three).toContain('mcp__flow__standing {"action":"add","topic":"worker-size","answer":"Keep","kinds":["fyi"]}')
  expect(personalRules(w.files)).toEqual([])
  // The user's yes: main makes the call.
  expect(await standing($, null, { action: 'add', topic: 'worker-size', answer: 'Keep', kinds: ['fyi'] })).toContain('Rule s1 added')
  expect(personalRules(w.files)[0]).toMatchObject({ topic: 'worker-size', answer: 'Keep', kinds: ['fyi'] })
  w.sent.length = 0
  // A fresh decision with the topic spelled differently: kept by the rule, same result line, no message.
  const r = await fyi($, 'w1', [D(4, 'Worker_Sizes')])
  expect(r).toBe('Recorded d4. Carry on; you get a message only if it is undone.')
  const d4 = stored(w.files).find(i => i.id === 'd4')!
  expect(d4.state).toBe('answered')
  expect(d4.answer).toBe('Keep')
  expect(d4.answeredBy).toBe('standing answer')
  expect(d4.rule).toBe('s1')
  expect(w.sent).toEqual([])
  expect(w.files.get(`${DIR}/log.jsonl`)).toContain('d4 rule s1: Keep')
  // Another topic stays open; so does the same text asked as an ordinary question.
  await fyi($, 'w1', [D(5, 'other')])
  expect(stored(w.files).find(i => i.id === 'd5')!.state).toBe('open')
  // The user can still undo the rule-kept decision; the owner is told.
  expect(await answer($, null, { answers: [{ id: 'd4', choice: 'Undo' }] })).toContain('d4: Undo')
  const undone = stored(w.files).find(i => i.id === 'd4')!
  expect(undone.answer).toBe('Undo')
  expect(undone.rule).toBeUndefined()
  expect(w.sent.some(m => m.text.includes('undid your decision d4'))).toBe(true)
})

test('an ordinary rule never keeps a decision, and a fyi rule never answers a question', async ($, on) => {
  const w = world(on)
  await standing($, null, { action: 'add', topic: 'worker-size', answer: 'Keep' })
  await standing($, null, { action: 'add', topic: 'sized', answer: 'Keep', kinds: ['fyi'] })
  await fyi($, 'w1', [{ decision: 'one', why: 'x', topic: 'worker-size' }])
  expect(stored(w.files)[0]!.state).toBe('open')
  await ask($, 'm1', [{ question: 'Sized?', options: ['Keep', 'Undo'], default: 'Keep', blocking: false, topic: 'sized' }])
  expect(stored(w.files).find(i => i.id === 'q1')!.state).toBe('open')
  expect(await standing($, null, { action: 'add', topic: 'z', answer: 'Undo', kinds: ['fyi'] })).toContain('Refused')
})

test('an escalate rule keeps a decision open even with a fyi rule', async ($, on) => {
  const w = world(on)
  await standing($, null, { action: 'add', topic: 'worker-size', answer: 'Keep', kinds: ['fyi'] })
  await standing($, null, { action: 'add', topic: 'worker-size', escalate: true })
  await fyi($, 'w1', [{ decision: 'one', why: 'x', topic: 'worker-size' }])
  expect(stored(w.files)[0]!.state).toBe('open')
})

const cmd = ($: Dollar, args: string) => $.command.run({ command: 'flow', args } as never).then(r => r.text ?? '')
const status = ($: Dollar) => call($, 'mcp__flow__status', null, {})

test('/flow answer offers a suggestion the moment it reaches 3; the answer tool and status never repeat it', async ($, on) => {
  const w = world(on)
  await ask($, 'm1', [BUMP(1), BUMP(2), BUMP(3), BUMP(4)])
  expect(await cmd($, 'answer q1 minor')).not.toContain('Standing answer?')
  await cmd($, 'answer q2 minor')
  const third = await cmd($, 'answer q3 minor')
  expect(third).toContain('Standing answer? topic Version_Bumps answered "minor" 3 times')
  expect(third.split('Standing answer?').length).toBe(2)
  expect(await answer($, null, { answers: [{ id: 'q4', choice: 'minor' }] })).not.toContain('Standing answer?')
  expect(await status($)).not.toContain('Standing answer?')
  expect(personalRules(w.files)).toEqual([])
})

test('status offers a suggestion no answer result showed, once', async ($, on) => {
  const w = world(on)
  await ask($, 'm1', [BUMP(1), BUMP(2), BUMP(3)])
  await answer($, null, { answers: [{ id: 'q1', choice: 'minor' }, { id: 'q2', choice: 'minor' }, { id: 'q3', choice: 'minor' }] })
  // As if the answer had come from a path that shows nothing (the record lost): status is the fallback.
  w.files.delete(`${DIR}/suggest-offered.json`)
  expect(await status($)).toContain('Standing answer? topic Version_Bumps answered "minor" 3 times')
  expect(await status($)).not.toContain('Standing answer?')
})
