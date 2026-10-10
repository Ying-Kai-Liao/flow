import { expect } from 'claude-code/testing'
import { test } from './support'
import {
  addQuestions, answerMessage, askingNames, EMPTY_INBOX, fyiAsked, inboxHead, markAnswered, needsMessage, normalizeInbox,
  openAll, openFor, parseAsk, parseChoice, parseFyi, renderInbox, renderItem, expandOk, stillOpen, clip, findItem, DECISIONS_SHOWN, overridesManager, needsExplicitAnswer, paneRows, paneRowText, protectedWhy,
} from '../hooks/inbox'
import type { AskedQuestion, Inbox } from '../hooks/inbox'

const ask = (question: string, extra: Partial<AskedQuestion> = {}): AskedQuestion => ({
  question, options: ['Yes', 'No'], default: 'Yes', blocking: false, ...extra,
})
const W = { name: 'worker-1', id: 'a1', isManager: false }

function store(asked: AskedQuestion[], asker = W, addressee = 'mgr', base: Inbox = EMPTY_INBOX, now = 1000): Inbox {
  return addQuestions(base, asker, addressee, asked, now).inbox
}

test('parseAsk accepts a batch and a single question', () => {
  const r = parseAsk({ questions: [
    { question: ' Use A? ', options: ['A', 'B'], default: 'b', blocking: true, context: ' why ', topic: 'db' },
    { question: 'Ship?', options: ['yes', 'no'], default: 'yes', blocking: false },
  ] })
  expect(r).toEqual({ questions: [
    { question: 'Use A?', options: ['A', 'B'], default: 'B', blocking: true, context: 'why', topic: 'db' },
    { question: 'Ship?', options: ['yes', 'no'], default: 'yes', blocking: false },
  ] })
  const one = parseAsk({ questions: [{ question: 'Q', options: ['x', 'y'], default: 'x', blocking: false }] })
  expect('questions' in one && one.questions.length).toBe(1)
})

test('parseAsk refuses fewer than 2 options and a default that is not one', () => {
  expect('error' in parseAsk({ questions: [{ question: 'Q', options: ['x'], default: 'x', blocking: false }] })).toBe(true)
  expect('error' in parseAsk({ questions: [{ question: 'Q', options: ['x', 'x'], default: 'x', blocking: false }] })).toBe(true)
  expect('error' in parseAsk({ questions: [{ question: 'Q', options: ['x', 'y'], default: 'z', blocking: false }] })).toBe(true)
  expect('error' in parseAsk({ questions: [{ question: 'Q', options: ['x', 'y'], default: 3, blocking: false }] })).toBe(true)
})

test('parseAsk takes the default as a 1-based index', () => {
  for (const def of [2, '2']) {
    const r = parseAsk({ questions: [{ question: 'Q', options: ['x', 'y'], default: def, blocking: false }] })
    expect('questions' in r && r.questions[0]!.default).toBe('y')
  }
})

test('parseAsk: a missing field is an error and nothing is returned, even when others are fine', () => {
  const good = { question: 'Q', options: ['x', 'y'], default: 'x', blocking: false }
  for (const bad of [{ ...good, question: '' }, { ...good, options: undefined }, { ...good, default: undefined }, { ...good, blocking: undefined }, 'str']) {
    const r = parseAsk({ questions: [good, bad] })
    expect('error' in r).toBe(true)
    expect('questions' in r).toBe(false)
  }
  expect('error' in parseAsk({ questions: [] })).toBe(true)
  expect('error' in parseAsk(null)).toBe(true)
})

test('addQuestions numbers ids across calls and stores the addressee', () => {
  const a = addQuestions(EMPTY_INBOX, W, 'mgr', [ask('one'), ask('two')], 5)
  expect(a.added.map(x => x.q.id)).toEqual(['q1', 'q2'])
  expect(a.added.every(x => x.fresh)).toBe(true)
  expect(a.added[0]!.q.addressee).toBe('mgr')
  expect(a.added[0]!.q.askerId).toBe('a1')
  expect(a.added[0]!.q.state).toBe('open')
  const b = addQuestions(a.inbox, W, 'mgr', [ask('three')], 6)
  expect(b.added[0]!.q.id).toBe('q3')
  expect(b.inbox.items.length).toBe(3)
})

test('addQuestions dedupes an open question from the same owner, not once answered', () => {
  const a = addQuestions(EMPTY_INBOX, W, 'mgr', [ask('Use  A?')], 1)
  const b = addQuestions(a.inbox, W, 'mgr', [ask(' use a? ')], 2)
  expect(b.added[0]!.fresh).toBe(false)
  expect(b.added[0]!.q.id).toBe('q1')
  expect(b.inbox.items.length).toBe(1)
  // another owner is not a duplicate
  const other = addQuestions(a.inbox, { name: 'worker-2', isManager: false }, 'mgr', [ask('Use A?')], 2)
  expect(other.added[0]!.q.id).toBe('q2')
  const m = markAnswered(a.inbox, 'q1', null, 'mgr', 3)
  if (m.kind !== 'ok') throw new Error('expected ok')
  const c = addQuestions(m.inbox, W, 'mgr', [ask('Use A?')], 4)
  expect(c.added[0]!.fresh).toBe(true)
  expect(c.added[0]!.q.id).toBe('q2')
})

test('parseChoice reads option text, letter, number, else free text', () => {
  const o = ['Alpha', 'Beta', 'Gamma']
  expect(parseChoice(o, 'beta')).toEqual({ text: 'Beta', free: false })
  expect(parseChoice(o, 'b')).toEqual({ text: 'Beta', free: false })
  expect(parseChoice(o, 'C)')).toEqual({ text: 'Gamma', free: false })
  expect(parseChoice(o, '2')).toEqual({ text: 'Beta', free: false })
  expect(parseChoice(o, '4')).toEqual({ text: '4', free: true })
  expect(parseChoice(o, 'z')).toEqual({ text: 'z', free: true })
  expect(parseChoice(o, ' do neither ')).toEqual({ text: 'do neither', free: true })
})

test('markAnswered: null takes the default, a choice is parsed', () => {
  const inbox = store([ask('Q', { options: ['A', 'B'], default: 'A' })])
  const d = markAnswered(inbox, 'q1', null, 'mgr', 9)
  expect(d.kind === 'ok' && d.answer).toBe('A')
  expect(d.kind === 'ok' && d.isDefault).toBe(true)
  const c = markAnswered(inbox, 'q1', 'b', 'mgr', 9)
  if (c.kind !== 'ok') throw new Error('expected ok')
  expect(c.answer).toBe('B')
  expect(c.isDefault).toBe(false)
  expect(c.q.state).toBe('answered')
  expect(c.q.answeredBy).toBe('mgr')
  expect(c.q.answeredAt).toBe(9)
  expect(c.q.delivered).toBe(false)
  expect(c.inbox.items[0]!.state).toBe('answered')
  expect(inbox.items[0]!.state).toBe('open')
  const typed = markAnswered(inbox, 'q1', 'a', 'mgr', 9)
  expect(typed.kind === 'ok' && typed.isDefault).toBe(true)
})

test('markAnswered refuses a non-addressee, a second answer and an unknown id', () => {
  const inbox = store([ask('Q')])
  expect(markAnswered(inbox, 'q1', null, 'other', 1).kind).toBe('refused')
  expect(markAnswered(inbox, 'q9', null, 'mgr', 1).kind).toBe('unknown')
  const m = markAnswered(inbox, 'q1', 'No', 'mgr', 1)
  if (m.kind !== 'ok') throw new Error('expected ok')
  const again = markAnswered(m.inbox, 'q1', 'Yes', 'mgr', 2)
  expect(again.kind).toBe('answered')
  expect(again.kind === 'answered' && again.q.answer).toBe('No')
})

test('a manager continuation may answer for the manager', () => {
  const inbox = store([ask('Q')], W, 'mgr')
  expect(markAnswered(inbox, 'q1', null, 'mgr-2', 1).kind).toBe('ok')
})

test('openFor and openAll list only open questions', () => {
  let inbox = store([ask('one'), ask('two')], W, 'mgr')
  inbox = store([ask('three')], { name: 'mgr', id: 'm', isManager: true }, 'main', inbox)
  const m = markAnswered(inbox, 'q1', null, 'mgr', 1)
  if (m.kind !== 'ok') throw new Error('expected ok')
  expect(openAll(m.inbox).map(q => q.id)).toEqual(['q2', 'q3'])
  expect(openFor(m.inbox, 'mgr').map(q => q.id)).toEqual(['q2'])
  expect(openFor(m.inbox, 'mgr-2').map(q => q.id)).toEqual(['q2'])
  expect(openFor(m.inbox, 'main').map(q => q.id)).toEqual(['q3'])
})

test('askingNames lists owners of open blocking questions only', () => {
  expect(askingNames(undefined)).toEqual([])
  let inbox = store([ask('a', { blocking: true }), ask('b')], W)
  inbox = store([ask('c', { blocking: true })], { name: 'worker-2', id: 'a2', isManager: false }, 'mgr', inbox)
  expect(askingNames(inbox)).toEqual(['worker-1', 'worker-2'])
  const m = markAnswered(inbox, 'q3', null, 'mgr', 1)
  if (m.kind !== 'ok') throw new Error('expected ok')
  expect(askingNames(m.inbox)).toEqual(['worker-1'])
})

test('needsMessage: only a non-blocking default answer needs none', () => {
  const inbox = store([ask('a', { blocking: true }), ask('b')])
  const [a, b] = inbox.items
  expect(needsMessage(a!, true)).toBe(true)
  expect(needsMessage(b!, true)).toBe(false)
  expect(needsMessage(b!, false)).toBe(true)
})

test('answerMessage carries the question and the answer', () => {
  const inbox = store([ask('Use A?', { blocking: true }), ask('Ship it?')])
  const [blocking, loose] = inbox.items
  const m1 = answerMessage(blocking!, 'No', 'mgr', false)
  expect(m1).toContain('Use A?')
  expect(m1).toContain('Answer: No')
  expect(m1).toContain('q1')
  const m2 = answerMessage(loose!, 'No', 'mgr', false)
  expect(m2).toContain('Ship it?')
  expect(m2).toContain('Answer: No')
  expect(m2).toContain('default "Yes"')
  expect(answerMessage(loose!, 'Yes', 'mgr', true)).toContain('nothing changes')
})

test('renderInbox: empty text, blocking first and the default marked', () => {
  expect(renderInbox(undefined, 0)).toBe('No open questions.')
  expect(renderInbox(EMPTY_INBOX, 0)).toBe('No open questions.')
  let inbox = store([ask('loose one', { options: ['A', 'B'], default: 'B' })], W, 'mgr', EMPTY_INBOX, 0)
  inbox = store([ask('other owner', { blocking: true })], { name: 'worker-2', id: 'a2', isManager: false }, 'mgr', inbox, 90_000)
  inbox = store([ask('must know', { blocking: true, context: 'because' })], W, 'mgr', inbox, 60_000)
  const text = renderInbox(inbox, 120_000)
  expect(text.startsWith('3 questions (2 blocking).')).toBe(true)
  expect(text.indexOf('must know')).toBeLessThan(text.indexOf('loose one'))
  expect(text.indexOf('other owner')).toBeLessThan(text.indexOf('loose one'))
  expect(text).toContain('b) B (default)')
  expect(text).not.toContain('a) A (default)')
  expect(text).toContain('q3 BLOCKING')
  expect(text).toContain('q1 (worker-1, for mgr, 2 min): loose one')
  expect(text).not.toContain('mcp__flow__')
})

test('inboxHead: nothing when empty, else a count and a line each, blocking first', () => {
  expect(inboxHead(undefined)).toEqual([])
  const inbox = store([ask('loose'), ask('hard', { blocking: true })])
  const head = inboxHead(inbox)
  expect(head[0]).toContain('2 open, 1 blocking')
  expect(head[1]).toContain('q2 BLOCKING worker-1: hard')
  expect(head[2]).toContain('q1 worker-1: loose')
})

test('normalizeInbox turns garbage into an empty inbox and keeps ids moving', () => {
  for (const g of [null, undefined, 5, 'x', {}, { items: 'no' }, { items: [null, 1, {}, { id: 'q1' }] }]) {
    expect(normalizeInbox(g)).toEqual({ next: 1, items: [] })
  }
  const inbox = store([ask('a'), ask('b')])
  expect(normalizeInbox(JSON.parse(JSON.stringify(inbox)))).toEqual(inbox)
  expect(normalizeInbox({ next: 1, items: inbox.items }).next).toBe(3)
})

// Decisions (stored as kind 'fyi')

const fyiOf = (decision: string, asker = W, addressee = 'mgr', base: Inbox = EMPTY_INBOX) =>
  addQuestions(base, asker, addressee, [fyiAsked({ decision, why: 'safer' })], 1000, 'fyi').inbox

test('parseFyi checks the batch whole and keeps the optional fields', () => {
  expect(parseFyi({ items: [{ decision: ' Use 30 s ', why: ' conservative ', alternative: '10 s', topic: 'timeout' }] }))
    .toEqual({ items: [{ decision: 'Use 30 s', why: 'conservative', alternative: '10 s', topic: 'timeout' }] })
  expect('error' in parseFyi({ items: [{ decision: 'a', why: 'b' }, { decision: 'c' }] })).toBe(true)
  expect('error' in parseFyi({ items: [] })).toBe(true)
})

test('a decision is stored non-blocking with Keep as default, gets a d-id, and an identical open one dedupes', () => {
  const a = fyiOf('Use 30 s')
  const q = a.items[0]!
  expect(q).toMatchObject({ id: 'd1', kind: 'fyi', blocking: false, options: ['Keep', 'Undo'], default: 'Keep', question: 'Use 30 s', context: 'safer' })
  const again = addQuestions(a, W, 'mgr', [fyiAsked({ decision: ' use 30  s ', why: 'x' })], 2000, 'fyi')
  expect(again.added[0]!.fresh).toBe(false)
  expect(again.inbox.items.length).toBe(1)
  // a question with the same text is not a decision duplicate, and it takes a q-id from its own counter
  const q1 = addQuestions(a, W, 'mgr', [ask('Use 30 s')], 2000)
  expect(q1.added[0]!.fresh).toBe(true)
  expect(q1.added[0]!.q.id).toBe('q1')
  expect(q1.inbox).toMatchObject({ next: 2, nextD: 2 })
})

test('old rows without kind read back as questions; kind fyi is kept', () => {
  const raw = { next: 3, items: [
    { id: 'q1', owner: 'w', addressee: 'm', question: 'Q', options: ['a', 'b'], default: 'a', blocking: false, askedAt: 1, state: 'open', delivered: false },
    { id: 'd1', kind: 'fyi', owner: 'w', addressee: 'm', question: 'D', options: ['Keep', 'Undo'], default: 'Keep', blocking: false, askedAt: 1, state: 'open', delivered: false },
  ] }
  const n = normalizeInbox(raw)
  expect(n.items.map(x => x.kind)).toEqual([undefined, 'fyi'])
})

// A decision stored before decisions had their own ids: a q-id, no nextD.
const stored = (id: string, askedAt: number, extra: Record<string, unknown> = {}) =>
  ({ id, kind: 'fyi', owner: 'w', addressee: 'm', question: `D ${id}`, options: ['Keep', 'Overturn'], default: 'Keep', blocking: false, askedAt, state: 'open', delivered: false, ...extra })
const oldQ = (id: string) => ({ id, owner: 'w', addressee: 'm', question: `Q ${id}`, options: ['a', 'b'], default: 'a', blocking: false, askedAt: 1, state: 'open', delivered: false })

test('migration: stored decisions under q-ids get stable d-ids in askedAt order and keep the q-id as alias; idempotent', () => {
  const raw = { next: 12, items: [oldQ('q1'), stored('q10', 500), stored('q4', 500), stored('q5', 100, { state: 'answered', answer: 'Keep' }), oldQ('q11')] }
  const n = normalizeInbox(raw)
  expect(n.items.map(x => x.id)).toEqual(['q1', 'd3', 'd2', 'd1', 'q11'])
  expect(n.items.map(x => x.alias)).toEqual([undefined, 'q10', 'q4', 'q5', undefined])
  expect(n.nextD).toBe(4)
  expect(n.next).toBe(12)
  // the same input always gives the same ids, and the migrated result is a fixed point
  expect(normalizeInbox(JSON.parse(JSON.stringify(raw)))).toEqual(n)
  expect(normalizeInbox(JSON.parse(JSON.stringify(n)))).toEqual(n)
})

test('migration: the q counter stays above aliases, new decisions continue after the migrated d-ids', () => {
  const n = normalizeInbox({ next: 2, items: [stored('q9', 1)] })
  expect(n.next).toBe(10)
  const added = addQuestions(n, W, 'mgr', [fyiAsked({ decision: 'new', why: 'w' })], 5, 'fyi')
  expect(added.added[0]!.q.id).toBe('d2')
  const q = addQuestions(added.inbox, W, 'mgr', [ask('A question?')], 6)
  expect(q.added[0]!.q.id).toBe('q10')
})

test('findItem and markAnswered accept the d-id and the old q-id of a migrated decision', () => {
  const box = normalizeInbox({ next: 12, items: [stored('q10', 1, { addressee: 'mgr' })] })
  expect(findItem(box, 'D1')?.id).toBe('d1')
  expect(findItem(box, 'q10')?.id).toBe('d1')
  expect(findItem(box, 'q11')).toBeUndefined()
  const m = markAnswered(box, 'q10', null, 'mgr', 5)
  expect(m.kind === 'ok' && m.q.id).toBe('d1')
  expect(m.kind === 'ok' && m.inbox.items[0]!.state).toBe('answered')
  // answered ones are found by the old id too
  expect(renderItem(m.kind === 'ok' ? m.inbox : box, 'q10', 1000)).toContain('Answered: Keep')
  expect(renderItem(box, 'q10', 1000)).toContain('d1 decision')
  expect(renderItem(box, 'q10', 1000)).toContain('earlier id q10')
})

test('renderInbox puts decisions in their own section after the questions; inboxHead counts them', () => {
  const base = store([ask('Which db?')])
  const box = fyiOf('Use 30 s', W, 'mgr', base)
  const text = renderInbox(box, 2000)
  expect(text.indexOf('Questions')).toBeLessThan(text.indexOf('Decisions agents made (keep or undo)'))
  expect(text).toContain('1 question, 1 decision.')
  expect(text).toMatch(/d1 +worker-1 +Use 30 s +0 min/)
  expect(text).not.toContain('why: safer')
  expect(text).not.toMatch(/FYI/i)
  const head = inboxHead(box, 2000)
  expect(head.filter(l => l.includes('decision')).length).toBe(1)
  expect(head.some(l => l.includes('d1'))).toBe(false)
  const only = renderInbox(fyiOf('Use 30 s'), 2000)
  expect(only.startsWith('1 decision.')).toBe(true)
  expect(only).toContain('Decisions agents made')
})

test('askingNames ignores decisions', () => {
  expect(askingNames(fyiOf('Use 30 s'))).toEqual([])
})

test('a decision is kept by Keep (no message) and undone by anything else (message)', () => {
  const box = fyiOf('Use 30 s')
  const ack = markAnswered(box, 'd1', null, 'mgr', 5000)
  expect(ack.kind === 'ok' && needsMessage(ack.q, ack.isDefault)).toBe(false)
  const keep = markAnswered(box, 'd1', 'keep', 'mgr', 5000)
  expect(keep.kind === 'ok' && keep.isDefault).toBe(true)
  const over = markAnswered(box, 'd1', 'use 60 s', 'mgr', 5000)
  expect(over.kind).toBe('ok')
  if (over.kind !== 'ok') return
  expect(needsMessage(over.q, over.isDefault)).toBe(true)
  expect(answerMessage(over.q, over.answer, 'mgr', over.isDefault)).toBe(
    'flow: mgr undid your decision d1: you decided "Use 30 s". Instead: use 60 s. Change your work (on your branch / PR if it is still open) and say so in your report.')
  expect(markAnswered(over.inbox, 'd1', null, 'mgr', 6000).kind).toBe('answered')
})

test('main may answer any decision but not another addressee\'s question', () => {
  const box = fyiOf('Use 30 s', W, 'mgr', store([ask('Which db?')]))
  expect(markAnswered(box, 'd1', null, 'main', 5000).kind).toBe('ok')
  expect(markAnswered(box, 'q1', null, 'main', 5000).kind).toBe('refused')
  expect(markAnswered(box, 'd1', null, 'other-mgr', 5000).kind).toBe('refused')
})

// ---- the person's view ----

const H = 3_600_000
const fyis = (box: Inbox, owner: string, texts: string[], topic?: string, now = 0, addressee = 'main'): Inbox =>
  addQuestions(box, { name: owner, id: owner, isManager: true }, addressee,
    texts.map(t => fyiAsked({ decision: t, why: `because ${t}`, ...(topic ? { topic } : {}) })), now, 'fyi').inbox

test('clip folds whitespace and cuts with an ellipsis', () => {
  expect(clip('a   b\nc')).toBe('a b c')
  const c = clip('x'.repeat(300))
  expect(c.length).toBe(100)
  expect(c.endsWith('...')).toBe(true)
})

test('renderInbox: summary first, blocking questions first, long headline clipped, options and why on their own lines', () => {
  let box = addQuestions(EMPTY_INBOX, { name: 'mgr-a', isManager: true }, 'main', [ask('soft one')], 0).inbox
  box = addQuestions(box, { name: 'mgr-b', isManager: true }, 'main', [ask('L'.repeat(300), { blocking: true, context: 'because', options: ['Yes', 'No'] })], 60_000).inbox
  box = fyis(box, 'mgr-a', ['kept'], undefined, 0)
  const text = renderInbox(box, 120_000)
  expect(text.split('\n')[0]).toBe('2 questions (1 blocking), 1 decision.')
  expect(text.indexOf('q2 BLOCKING')).toBeLessThan(text.indexOf('q1 '))
  expect(text).toContain(`${'L'.repeat(97)}...`)
  expect(text).not.toContain('L'.repeat(98))
  expect(text).toContain('      a) Yes (default) b) No')
  expect(text).not.toContain('why:')
  expect(text.indexOf('Questions')).toBeLessThan(text.indexOf('Decisions'))
  expect(text).toContain('/flow ok d10 d11')
  expect(text).toContain('/flow no d12 <what instead>')
  expect(text).toContain('/flow answer q1')
  expect(text).not.toContain('mcp__flow__')
})

test('renderInbox: push is NEEDS YOU; a question for a manager shows "for"; the item view says answering overrides it', () => {
  const base = addQuestions(EMPTY_INBOX, { name: 'flow', isManager: true }, 'main', [ask('Push?', { blocking: true })], 0).inbox
  const box: Inbox = { ...base, items: [{ ...base.items[0]!, kind: 'push' }] }
  expect(renderInbox(box, 1000)).toContain('q1 BLOCKING NEEDS YOU: PUSH')
  const mine = addQuestions(EMPTY_INBOX, W, 'mgr', [ask('Hm?')], 0).inbox
  const t = renderInbox(mine, 1000)
  expect(t).toContain('for mgr')
  expect(renderItem(mine, 'q1', 1000)).toContain('answering it overrides mgr')
})

test('renderInbox: decisions are one flat table, newest first, nothing grouped or collapsed', () => {
  let box = fyis(EMPTY_INBOX, 'mgr-a', ['a1 text', 'a2 text', 'a3 text'], 'worker-size', 0)
  box = fyis(box, 'mgr-b', ['b1 text', 'b2 text'], 'worker-size', 5 * H)
  const text = renderInbox(box, 6 * H)
  const lines = text.split('\n')
  const at = lines.findIndex(l => l.includes('Decisions agents made'))
  expect(lines[at + 1]).toMatch(/^id +from +decision +age$/)
  expect(lines.slice(at + 2, at + 7).map(l => l.trim().split(/\s+/)[0])).toEqual(['d5', 'd4', 'd3', 'd2', 'd1'])
  expect(text).toMatch(/d5 +mgr-b +b2 text +1 h/)
  expect(text).toMatch(/d1 +mgr-a +a1 text +6 h/)
  expect(text).not.toMatch(/Older|x3|\+\d+ more|mgr-a:/)
})

test('renderInbox: a long list shows the newest 15 and a +M more line; all (decisions) lists every row; rows never wrap', () => {
  let box = EMPTY_INBOX
  for (let i = 1; i <= 20; i++) box = fyis(box, 'mgr-a', [`decision number ${i} ${'x'.repeat(200)}`], undefined, i * 1000)
  const text = renderInbox(box, 60_000, { width: 80 })
  const rows = text.split('\n').filter(l => /^d\d+ /.test(l))
  expect(rows.length).toBe(DECISIONS_SHOWN)
  expect(rows[0]).toContain('d20')
  expect(text).toContain('+5 more: /flow inbox decisions')
  for (const l of text.split('\n')) expect(l.length).toBeLessThanOrEqual(130)
  for (const l of rows) { expect(l.length).toBeLessThanOrEqual(80); expect(l).toContain('…') }
  const all = renderInbox(box, 60_000, { all: true, width: 80 })
  expect(all.split('\n').filter(l => /^d\d+ /.test(l)).length).toBe(20)
  expect(all).not.toContain('more:')
})

test('renderItem prints one item in full; unknown ids and answered items are said plainly', () => {
  const box = addQuestions(EMPTY_INBOX, { name: 'mgr-a', isManager: true }, 'main', [ask('L'.repeat(300), { context: 'C'.repeat(300) })], 0).inbox
  const full = renderItem(box, 'q1', 1000)
  expect(full).toContain('L'.repeat(300))
  expect(full).toContain('C'.repeat(300))
  expect(full).toContain('/flow answer q1')
  expect(renderItem(box, 'q9', 0)).toBe('q9: no such question or decision.')
  const m = markAnswered(box, 'q1', 'b', 'main', 5)
  expect(m.kind === 'ok' && renderItem(m.inbox, 'q1', 1000)).toContain('Answered: No (by main)')
})

test('expandOk: no words is every open decision; ids pass; owner and topic expand to decisions; protected items are refused', () => {
  let box = fyis(EMPTY_INBOX, 'mgr-a', ['one', 'two'], 'naming', 0)
  box = fyis(box, 'mgr-b', ['three'], undefined, 0)
  box = addQuestions(box, { name: 'mgr-b', isManager: true }, 'main', [ask('Q?')], 0).inbox
  const withPush: Inbox = { ...box, items: [...box.items, { ...box.items[3]!, id: 'q9', kind: 'push' }] }
  expect(expandOk(withPush, []).ids).toEqual(['d1', 'd2', 'd3'])
  expect(expandOk(withPush, ['q1', 'q1', 'Q1']).ids).toEqual(['q1'])
  expect(expandOk(withPush, ['d2', 'D3']).ids).toEqual(['d2', 'd3'])
  expect(expandOk(withPush, ['naming']).ids).toEqual(['d1', 'd2'])
  expect(expandOk(withPush, ['mgr-b']).ids).toEqual(['d3'])
  expect(expandOk(withPush, ['q9'])).toEqual({ ids: [], lines: ['q9: answer it explicitly: /flow answer q9 <choice>'] })
  expect(expandOk(withPush, ['nope']).lines[0]).toContain('no open decisions')
  expect(expandOk(EMPTY_INBOX, []).lines).toEqual(['No open decisions to keep.'])
  // the old q-id of a migrated decision resolves to the d-id
  const migrated = normalizeInbox({ next: 12, items: [stored('q10', 1), stored('q11', 2)] })
  expect(expandOk(migrated, ['q11', 'q10']).ids).toEqual(['d2', 'd1'])
})

test('predicates: the user may answer anything, over a manager when it is addressed to one; deploy, env, push and guard need an explicit answer', () => {
  const box = addQuestions(EMPTY_INBOX, W, 'mgr', [ask('x')], 0).inbox
  const q = box.items[0]!
  expect(overridesManager(q)).toBe(true)
  expect(overridesManager({ ...q, addressee: 'main' })).toBe(false)
  expect(overridesManager({ ...q, kind: 'fyi' })).toBe(false)
  expect(['deploy', 'env', 'push'].map(kind => needsExplicitAnswer({ ...q, kind: kind as 'push' }))).toEqual([true, true, true])
  expect(needsExplicitAnswer({ ...q, guard: { glob: 'a', test: 'b' } })).toBe(true)
  expect(needsExplicitAnswer(q)).toBe(false)
  expect(stillOpen(box)).toContain('Still open: 1 question')
  expect(stillOpen(EMPTY_INBOX)).toBe('Nothing is left open.')
})

test('paneRows: questions blocking first, then every decision newest first, one flat row each', () => {
  let box = store([ask('soft'), ask('hard', { blocking: true })])
  box = fyis(box, 'mgr-a', ['a1', 'a2', 'a3', 'a4'], 'worker-size', 10_440_000)
  box = fyis(box, 'mgr-c', ['c1'], undefined, 0)
  const rows = paneRows(box)
  expect(rows.map(r => r.key)).toEqual(['q2', 'q1', 'd4', 'd3', 'd2', 'd1', 'd5'])
  expect(paneRowText(rows[0]!)).toContain('q2 BLOCKING worker-1, for mgr: hard')
  expect(paneRowText(rows[2]!)).toBe('d4 mgr-a [worker-size]: a4')
})

test('protectedWhy names the explicit way for deploy, env, push and guard items only', () => {
  const q = store([ask('x')]).items[0]!
  expect(protectedWhy(q)).toBeUndefined()
  for (const kind of ['deploy', 'env', 'push'] as const) expect(protectedWhy({ ...q, kind })).toContain('y never answers it')
  expect(protectedWhy({ ...q, guard: { glob: 'a', test: 'b' } })).toContain('guard test')
})
