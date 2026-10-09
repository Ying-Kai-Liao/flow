import { expect } from 'claude-code/testing'
import { test } from './support'
import {
  addQuestions, answerMessage, askingNames, EMPTY_INBOX, fyiAsked, inboxHead, markAnswered, needsMessage, normalizeInbox,
  openAll, openFor, parseAsk, parseChoice, parseFyi, renderInbox,
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

test('renderInbox: empty text, grouped by owner with blocking first and the default marked', () => {
  expect(renderInbox(undefined, 0)).toBe('No open questions.')
  expect(renderInbox(EMPTY_INBOX, 0)).toBe('No open questions.')
  let inbox = store([ask('loose one', { options: ['A', 'B'], default: 'B' })], W, 'mgr', EMPTY_INBOX, 0)
  inbox = store([ask('other owner', { blocking: true })], { name: 'worker-2', id: 'a2', isManager: false }, 'mgr', inbox, 90_000)
  inbox = store([ask('must know', { blocking: true, context: 'because' })], W, 'mgr', inbox, 60_000)
  const text = renderInbox(inbox, 120_000)
  expect(text).toContain('Open questions: 3 (2 blocking)')
  expect(text.indexOf('must know')).toBeLessThan(text.indexOf('loose one'))
  expect(text.indexOf('worker-1:')).toBeLessThan(text.indexOf('worker-2:'))
  expect(text).toContain('b) B  (default)')
  expect(text).not.toContain('a) A  (default)')
  expect(text).toContain('context: because')
  expect(text).toContain('q3 BLOCKING')
  expect(text).toContain('q1 non-blocking')
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

// FYI items

const fyiOf = (decision: string, asker = W, addressee = 'mgr', base: Inbox = EMPTY_INBOX) =>
  addQuestions(base, asker, addressee, [fyiAsked({ decision, why: 'safer' })], 1000, 'fyi').inbox

test('parseFyi checks the batch whole and keeps the optional fields', () => {
  expect(parseFyi({ items: [{ decision: ' Use 30 s ', why: ' conservative ', alternative: '10 s', topic: 'timeout' }] }))
    .toEqual({ items: [{ decision: 'Use 30 s', why: 'conservative', alternative: '10 s', topic: 'timeout' }] })
  expect('error' in parseFyi({ items: [{ decision: 'a', why: 'b' }, { decision: 'c' }] })).toBe(true)
  expect('error' in parseFyi({ items: [] })).toBe(true)
})

test('an FYI is stored non-blocking with Keep as default, and an identical open one dedupes', () => {
  const a = fyiOf('Use 30 s')
  const q = a.items[0]!
  expect(q).toMatchObject({ id: 'q1', kind: 'fyi', blocking: false, options: ['Keep', 'Overturn'], default: 'Keep', question: 'Use 30 s', context: 'safer' })
  const again = addQuestions(a, W, 'mgr', [fyiAsked({ decision: ' use 30  s ', why: 'x' })], 2000, 'fyi')
  expect(again.added[0]!.fresh).toBe(false)
  expect(again.inbox.items.length).toBe(1)
  // a question with the same text is not an FYI duplicate
  expect(addQuestions(a, W, 'mgr', [ask('Use 30 s')], 2000).added[0]!.fresh).toBe(true)
})

test('old rows without kind read back as questions; kind fyi is kept', () => {
  const raw = { next: 3, items: [
    { id: 'q1', owner: 'w', addressee: 'm', question: 'Q', options: ['a', 'b'], default: 'a', blocking: false, askedAt: 1, state: 'open', delivered: false },
    { id: 'q2', kind: 'fyi', owner: 'w', addressee: 'm', question: 'D', options: ['Keep', 'Overturn'], default: 'Keep', blocking: false, askedAt: 1, state: 'open', delivered: false },
  ] }
  const n = normalizeInbox(raw)
  expect(n.items.map(x => x.kind)).toEqual([undefined, 'fyi'])
})

test('renderInbox puts FYIs in their own section after the questions; inboxHead counts them', () => {
  const base = store([ask('Which db?')])
  const box = fyiOf('Use 30 s', W, 'mgr', base)
  const text = renderInbox(box, 2000)
  expect(text.indexOf('Open questions: 1')).toBeLessThan(text.indexOf('FYI (decided'))
  expect(text).toContain('q2 worker-1')
  expect(text).toContain('Use 30 s - why: safer')
  const head = inboxHead(box, 2000)
  expect(head.filter(l => l.includes('FYI')).length).toBe(1)
  expect(head.some(l => l.includes('q2'))).toBe(false)
  const only = renderInbox(fyiOf('Use 30 s'), 2000)
  expect(only.startsWith('No open questions.')).toBe(true)
  expect(only).toContain('FYI (decided')
})

test('askingNames ignores FYIs', () => {
  expect(askingNames(fyiOf('Use 30 s'))).toEqual([])
})

test('an FYI is acked by Keep (no message) and overturned by anything else (message)', () => {
  const box = fyiOf('Use 30 s')
  const ack = markAnswered(box, 'q1', null, 'mgr', 5000)
  expect(ack.kind === 'ok' && needsMessage(ack.q, ack.isDefault)).toBe(false)
  const keep = markAnswered(box, 'q1', 'keep', 'mgr', 5000)
  expect(keep.kind === 'ok' && keep.isDefault).toBe(true)
  const over = markAnswered(box, 'q1', 'use 60 s', 'mgr', 5000)
  expect(over.kind).toBe('ok')
  if (over.kind !== 'ok') return
  expect(needsMessage(over.q, over.isDefault)).toBe(true)
  expect(answerMessage(over.q, over.answer, 'mgr', over.isDefault)).toBe(
    'flow: mgr overturned your FYI q1: you decided "Use 30 s". Instead: use 60 s. Change your work (on your branch / PR if it is still open) and say so in your report.')
  expect(markAnswered(over.inbox, 'q1', null, 'mgr', 6000).kind).toBe('answered')
})

test('main may answer any FYI but not another addressee\'s question', () => {
  const box = fyiOf('Use 30 s', W, 'mgr', store([ask('Which db?')]))
  expect(markAnswered(box, 'q2', null, 'main', 5000).kind).toBe('ok')
  expect(markAnswered(box, 'q1', null, 'main', 5000).kind).toBe('refused')
  expect(markAnswered(box, 'q2', null, 'other-mgr', 5000).kind).toBe('refused')
})
