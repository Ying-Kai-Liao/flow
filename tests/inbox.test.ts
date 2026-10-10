import { expect } from 'claude-code/testing'
import { test } from './support'
import {
  addQuestions, answerMessage, askingNames, EMPTY_INBOX, fyiAsked, inboxHead, markAnswered, needsMessage, normalizeInbox,
  openAll, openFor, parseAsk, parseChoice, parseFyi, renderInbox, renderItem, expandOk, stillOpen, clip, isStaleFyi, overridesManager, needsExplicitAnswer, paneRows, paneRowText, protectedWhy,
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
  expect(text).toContain('why: because')
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
  expect(text.indexOf('Questions')).toBeLessThan(text.indexOf('FYIs (decided'))
  expect(text).toContain('1 question, 1 FYI.')
  expect(text).toContain('q2 (0 min): Use 30 s')
  expect(text).toContain('why: safer')
  const head = inboxHead(box, 2000)
  expect(head.filter(l => l.includes('FYI')).length).toBe(1)
  expect(head.some(l => l.includes('q2'))).toBe(false)
  const only = renderInbox(fyiOf('Use 30 s'), 2000)
  expect(only.startsWith('1 FYI.')).toBe(true)
  expect(only).toContain('FYIs (decided')
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
  expect(text.split('\n')[0]).toBe('2 questions (1 blocking), 1 FYI.')
  expect(text.indexOf('q2 BLOCKING')).toBeLessThan(text.indexOf('q1 '))
  expect(text).toContain(`${'L'.repeat(97)}...`)
  expect(text).not.toContain('L'.repeat(98))
  expect(text).toContain('      a) Yes (default)')
  expect(text).toContain('      why: because')
  expect(text.indexOf('Questions')).toBeLessThan(text.indexOf('FYIs'))
  expect(text).toContain('/flow ok q10 q11')
  expect(text).toContain('/flow no q12 <what instead>')
  expect(text).toContain('/flow answer <id>')
  expect(text).not.toContain('mcp__flow__')
})

test('renderInbox: push is NEEDS YOU; a question for a manager shows "for" and says answering overrides it', () => {
  const base = addQuestions(EMPTY_INBOX, { name: 'flow', isManager: true }, 'main', [ask('Push?', { blocking: true })], 0).inbox
  const box: Inbox = { ...base, items: [{ ...base.items[0]!, kind: 'push' }] }
  expect(renderInbox(box, 1000)).toContain('q1 BLOCKING NEEDS YOU: PUSH')
  const mine = addQuestions(EMPTY_INBOX, W, 'mgr', [ask('Hm?')], 0).inbox
  const t = renderInbox(mine, 1000)
  expect(t).toContain('for mgr')
  expect(t).toContain('overrides the manager')
  expect(renderItem(mine, 'q1', 1000)).toContain('answering it overrides mgr')
})

test('renderInbox: three FYIs of one topic collapse within an owner; two do not; owners stay separate', () => {
  let box = fyis(EMPTY_INBOX, 'mgr-a', ['a1 text', 'a2 text', 'a3 text'], 'worker-size', 0)
  box = fyis(box, 'mgr-b', ['b1 text', 'b2 text'], 'worker-size', 0)
  const text = renderInbox(box, 1000)
  expect(text).toContain('worker-size x3 (q1 q2 q3): a1 text; a2 text; a3 text')
  expect(text).toContain('/flow ok worker-size')
  expect(text).toContain('q4 [worker-size] (0 min): b1 text')
  expect(text.indexOf('mgr-a:')).toBeLessThan(text.indexOf('mgr-b:'))
})

test('renderInbox: FYIs older than 2 h or of an owner that is not live collapse per owner unless all', () => {
  let box = fyis(EMPTY_INBOX, 'mgr-a', ['old one', 'old two'], undefined, 0)
  box = fyis(box, 'mgr-a', ['fresh'], undefined, 3 * H)
  box = fyis(box, 'mgr-gone', ['fresh but gone'], undefined, 3 * H)
  const now = 3 * H + 60_000
  const text = renderInbox(box, now, { live: ['mgr-a'] })
  expect(text).toContain('Older: 2 FYIs (q1 q2)')
  expect(text).toContain('Older: 1 FYI (q4)')
  expect(text).toContain('q3 (1 min): fresh')
  expect(text).not.toContain('old one')
  const all = renderInbox(box, now, { live: ['mgr-a'], all: true })
  expect(all).toContain('old one')
  expect(all).toContain('fresh but gone')
  expect(all).not.toContain('Older:')
  // without a live list only age counts; a manager's continuation counts as live
  expect(renderInbox(box, now)).toContain('fresh but gone')
  expect(isStaleFyi(box.items[2]!, now, ['mgr-a-2'])).toBe(false)
  expect(isStaleFyi(box.items[3]!, now, ['mgr-a-2'])).toBe(true)
})

test('renderItem prints one item in full; unknown ids and answered items are said plainly', () => {
  const box = addQuestions(EMPTY_INBOX, { name: 'mgr-a', isManager: true }, 'main', [ask('L'.repeat(300), { context: 'C'.repeat(300) })], 0).inbox
  const full = renderItem(box, 'q1', 1000)
  expect(full).toContain('L'.repeat(300))
  expect(full).toContain('C'.repeat(300))
  expect(full).toContain('/flow answer q1')
  expect(renderItem(box, 'q9', 0)).toBe('q9: no such question.')
  const m = markAnswered(box, 'q1', 'b', 'main', 5)
  expect(m.kind === 'ok' && renderItem(m.inbox, 'q1', 1000)).toContain('Answered: No (by main)')
})

test('expandOk: no words is every open FYI; ids pass; owner and topic expand to FYIs; protected items are refused', () => {
  let box = fyis(EMPTY_INBOX, 'mgr-a', ['one', 'two'], 'naming', 0)
  box = fyis(box, 'mgr-b', ['three'], undefined, 0)
  box = addQuestions(box, { name: 'mgr-b', isManager: true }, 'main', [ask('Q?')], 0).inbox
  const withPush: Inbox = { ...box, items: [...box.items, { ...box.items[3]!, id: 'q9', kind: 'push' }] }
  expect(expandOk(withPush, []).ids).toEqual(['q1', 'q2', 'q3'])
  expect(expandOk(withPush, ['q4', 'q4', 'Q4']).ids).toEqual(['q4'])
  expect(expandOk(withPush, ['naming']).ids).toEqual(['q1', 'q2'])
  expect(expandOk(withPush, ['mgr-b']).ids).toEqual(['q3'])
  expect(expandOk(withPush, ['q9'])).toEqual({ ids: [], lines: ['q9: answer it explicitly: /flow answer q9 <choice>'] })
  expect(expandOk(withPush, ['nope']).lines[0]).toContain('no open FYIs')
  expect(expandOk(EMPTY_INBOX, []).lines).toEqual(['No open FYIs to keep.'])
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

test('paneRows: questions blocking first, then FYIs by owner with 3+ of a topic folded and stale ones in an older row', () => {
  let box = store([ask('soft'), ask('hard', { blocking: true })])
  box = fyis(box, 'mgr-a', ['a1', 'a2', 'a3', 'a4'], 'worker-size', 10_440_000)
  box = fyis(box, 'mgr-b', ['b1', 'b2'], 'worker-size', 10_440_000)
  box = fyis(box, 'mgr-c', ['c1'], undefined, 0)
  const rows = paneRows(box, 3 * 3_600_000, { live: ['mgr-a', 'mgr-b'] })
  expect(rows.map(r => r.key)).toEqual(['q2', 'q1', 'o:mgr-c', 'g:mgr-a:worker-size', 'q7', 'q8'])
  expect(rows[3]!.ids).toEqual(['q3', 'q4', 'q5', 'q6'])
  expect(paneRowText(rows[0]!)).toContain('q2 BLOCKING worker-1, for mgr: hard')
  expect(paneRowText(rows[3]!)).toBe('worker-size x4 (mgr-a): q3 q4 q5 q6')
  const open = paneRows(box, 3 * 3_600_000, { live: ['mgr-a', 'mgr-b'], open: ['g:mgr-a:worker-size', 'o:mgr-c'] })
  expect(open.map(r => r.key)).toEqual(['q2', 'q1', 'o:mgr-c', 'q9', 'g:mgr-a:worker-size', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8'])
})

test('protectedWhy names the explicit way for deploy, env, push and guard items only', () => {
  const q = store([ask('x')]).items[0]!
  expect(protectedWhy(q)).toBeUndefined()
  for (const kind of ['deploy', 'env', 'push'] as const) expect(protectedWhy({ ...q, kind })).toContain('y never answers it')
  expect(protectedWhy({ ...q, guard: { glob: 'a', test: 'b' } })).toContain('guard test')
})
