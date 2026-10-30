import { expect } from 'claude-code/testing'
import { test } from './support'
import { addQuestions, EMPTY_INBOX, markAnswered } from '../hooks/inbox'
import type { Inbox } from '../hooks/inbox'
import {
  closeStale, deliverRound, denyText, doneManagers, dueRound, EMPTY_PREFLIGHT, followUp, gateOf, isSkip, markDelivered, normalizePreflight, onRoster, parseFiling, phaseOf,
  recordFiling, recordSpawn, renderFollowUp, renderRound, renderStatus,
} from '../hooks/preflight'
import type { Preflight } from '../hooks/preflight'
import { mergeLayers } from '../hooks/settings'
import { sessionRow } from '../hooks/sessions'
import { cardsNotice, cardsOn, CARDS_TEXT, lastLineAsks } from '../hooks/askcards'

const OK = { summary: 'export csv', criteria: ['a file downloads'], shipped: [], depends: [] }
const NONE = new Set<string>()
const MIN = 60_000

const filed = (s: Preflight, name: string, f: unknown = OK, ids = { asked: [] as string[], blocking: [] as string[] }, t = 5) => {
  const p = parseFiling(f)
  if (!('filing' in p)) throw new Error(`bad filing: ${p.error}`)
  return recordFiling(s, name, p.filing, ids, t)
}

test('parseFiling accepts a minimal filing and questions of the ask shape', () => {
  const r = parseFiling({ ...OK, workers: 2.4, shipped: [{ what: 'done already', ref: '#3' }], depends: [{ on: 'login', why: 'needs session' }],
    questions: [{ question: 'Q?', options: ['a', 'b'], default: 'a', blocking: true }] })
  expect('filing' in r && r.filing.workers).toBe(2)
  expect('filing' in r && r.filing.shipped).toEqual([{ what: 'done already', ref: '#3' }])
  expect('questions' in r && r.questions.length).toBe(1)
})

test('parseFiling refuses an empty summary, no criteria, bad entries and bad questions', () => {
  expect('error' in parseFiling({ ...OK, summary: ' ' })).toBe(true)
  expect('error' in parseFiling({ ...OK, criteria: [] })).toBe(true)
  expect('error' in parseFiling({ ...OK, criteria: ['x', ''] })).toBe(true)
  expect('error' in parseFiling({ ...OK, shipped: [{ ref: '#1' }] })).toBe(true)
  expect('error' in parseFiling({ ...OK, depends: ['login'] })).toBe(true)
  expect('error' in parseFiling({ ...OK, questions: [{ question: 'Q', options: ['a'], default: 'a', blocking: true }] })).toBe(true)
  expect('error' in parseFiling(null)).toBe(true)
})

test('the skip marker is a line of its own, any case', () => {
  expect(isSkip('Your name: x\nPre-flight: skip\nTask')).toBe(true)
  expect(isSkip('pre-flight: SKIP')).toBe(true)
  expect(isSkip('Do not skip Pre-flight: skipping is bad')).toBe(false)
})

test('gate: recon refuses, filed releases, an open blocking question refuses, answering releases', () => {
  let s = recordSpawn(EMPTY_PREFLIGHT, 'csv', false, 1, 10 * MIN)
  expect(gateOf(s, EMPTY_INBOX, 'csv')).toEqual({ kind: 'unfiled' })
  expect(phaseOf(s, EMPTY_INBOX, 'csv')).toBe('recon')

  const inbox: Inbox = addQuestions(EMPTY_INBOX, { name: 'csv', isManager: true }, 'main',
    [{ question: 'Q?', options: ['a', 'b'], default: 'a', blocking: true }], 2).inbox
  s = filed(s, 'csv', OK, { asked: ['q1'], blocking: ['q1'] })
  expect(gateOf(s, inbox, 'csv')).toEqual({ kind: 'blocking', ids: ['q1'] })
  expect(phaseOf(s, inbox, 'csv')).toBe('waiting on answers')
  expect(denyText(gateOf(s, inbox, 'csv')!)).toContain('q1')

  const m = markAnswered(inbox, 'q1', null, 'main', 3)
  expect(m.kind).toBe('ok')
  const after = m.kind === 'ok' ? m.inbox : inbox
  expect(gateOf(s, after, 'csv')).toBeUndefined()
  expect(phaseOf(s, after, 'csv')).toBe('released')
})

test('gate: unrecorded and skipped managers are never gated; the deny text names the tool', () => {
  expect(gateOf(EMPTY_PREFLIGHT, EMPTY_INBOX, 'old-manager')).toBeUndefined()
  const s = recordSpawn(EMPTY_PREFLIGHT, 'small', true, 1, 10 * MIN)
  expect(gateOf(s, EMPTY_INBOX, 'small')).toBeUndefined()
  expect(phaseOf(s, EMPTY_INBOX, 'small')).toBe('skipped')
  expect(denyText({ kind: 'unfiled' })).toContain('mcp__flow__preflight')
  expect(denyText({ kind: 'unfiled' })).toContain('criteria')
})

test('a successor inherits its predecessor; a fresh spawn of the same slug starts over', () => {
  let s = filed(recordSpawn(EMPTY_PREFLIGHT, 'csv', false, 1, 10 * MIN), 'csv')
  s = recordSpawn(s, 'csv-2', false, 9, 10 * MIN)
  expect(gateOf(s, EMPTY_INBOX, 'csv-2')).toBeUndefined()
  expect(s.entries['csv']!.name).toBe('csv-2')
  s = recordSpawn(s, 'csv', false, 10, 10 * MIN)
  expect(gateOf(s, EMPTY_INBOX, 'csv')).toEqual({ kind: 'unfiled' })
})

test('the same manager spawned again keeps its filed or skipped record and joins no round (#238)', () => {
  const s = markDelivered(filed(recordSpawn(EMPTY_PREFLIGHT, 'csv', false, 1, 10 * MIN), 'csv'), 1, 6)
  expect(recordSpawn(s, 'csv', false, 9, 10 * MIN, true)).toBe(s)
  expect(gateOf(recordSpawn(s, 'csv', false, 9, 10 * MIN, true), EMPTY_INBOX, 'csv')).toBeUndefined()
  const lite = recordSpawn(EMPTY_PREFLIGHT, 'small', true, 1, 10 * MIN)
  expect(recordSpawn(lite, 'small', false, 9, 10 * MIN, true)).toBe(lite)
  // Still in recon: it goes in the open round as before (#222).
  const recon = recordSpawn(markDelivered(recordSpawn(EMPTY_PREFLIGHT, 'login', false, 1, 10 * MIN), 1, 2), 'login', false, 9, 10 * MIN, true)
  expect(recon.rounds.map(r => r.members)).toEqual([['login'], ['login']])
  // Not on the roster: a new manager of that name starts over.
  expect(recordSpawn(s, 'csv', false, 9, 10 * MIN).entries['csv']!.phase).toBe('recon')
})

test('onRoster: the same name of a type under the same owner, whatever its status', () => {
  const rows = [
    { id: 'a1', name: 'csv', description: '', type: 'flow:manager', status: 'completed' },
    { id: 'a2', name: 'w', description: '', type: 'flow:worker', status: 'idle', parentId: 'a1' },
  ]
  expect(onRoster(rows, 'csv', ['flow:manager'], undefined)).toBe(true)
  expect(onRoster(rows, 'csv-2', ['flow:manager'], undefined)).toBe(false)
  expect(onRoster(rows, 'w', ['flow:worker'], 'a1')).toBe(true)
  expect(onRoster(rows, 'w', ['flow:worker'], 'a9')).toBe(false)
  expect(onRoster(rows, 'w', ['flow:manager'], 'a1')).toBe(false)
})

test('rounds: managers join the open round; a delivered round is followed by a new one', () => {
  let s = recordSpawn(EMPTY_PREFLIGHT, 'a', false, 1, 10 * MIN)
  s = recordSpawn(s, 'b', false, 2, 10 * MIN)
  expect(s.rounds.length).toBe(1)
  expect(s.rounds[0]!.members).toEqual(['a', 'b'])
  s = markDelivered(s, 1, 3)
  s = recordSpawn(s, 'c', false, 4, 10 * MIN)
  expect(s.rounds.map(r => r.members)).toEqual([['a', 'b'], ['c']])
})

test('dueRound: waits for everyone, counts ended managers, times out', () => {
  let s = recordSpawn(recordSpawn(EMPTY_PREFLIGHT, 'a', false, 0, 10 * MIN), 'b', false, 0, 10 * MIN)
  expect(dueRound(s, NONE, 1, 10 * MIN)).toBeUndefined()
  s = filed(s, 'a')
  expect(dueRound(s, NONE, 1, 10 * MIN)).toBeUndefined()
  expect(dueRound(s, new Set(['b']), 1, 10 * MIN)?.timedOut).toBe(false)
  expect(dueRound(s, NONE, 10 * MIN, 10 * MIN)?.timedOut).toBe(true)
  s = filed(s, 'b')
  expect(dueRound(s, NONE, 1, 10 * MIN)?.timedOut).toBe(false)
  expect(dueRound(markDelivered(s, 1, 2), NONE, 99 * MIN, MIN)).toBeUndefined()
})

test('renderRound: counts line, per-manager facts, numbered questions, closing instruction', () => {
  let inbox: Inbox = EMPTY_INBOX
  const ask = (name: string, blocking: boolean) => {
    inbox = addQuestions(inbox, { name, isManager: true }, 'main', [{ question: `${name} Q?`, options: ['a', 'b'], default: 'a', blocking }], 2).inbox
  }
  ask('a', true)
  ask('b', false)
  let s = recordSpawn(recordSpawn(recordSpawn(EMPTY_PREFLIGHT, 'a', false, 0, 10 * MIN), 'b', false, 0, 10 * MIN), 'c', false, 0, 10 * MIN)
  s = filed(s, 'a', { ...OK, summary: 'do a', workers: 1 }, { asked: ['q1'], blocking: ['q1'] })
  s = filed(s, 'b', { ...OK, summary: 'do b', shipped: [{ what: 'half done', ref: '#9' }], depends: [{ on: 'a', why: 'schema' }] }, { asked: ['q2'], blocking: [] })
  const text = renderRound(s, inbox, s.rounds[0]!, NONE, 5, true)
  const lines = text.split('\n')
  expect(lines[0]).toBe('Pre-flight: 3 tasks, 1 already shipped, 1 depend on others, 2 questions (1 blocking)')
  expect(text).toContain('Timed out waiting for: c')
  expect(text).toContain('- a: do a (about 1 worker)')
  expect(text).toContain('already shipped: half done (#9)')
  expect(text).toContain('depends on: a (schema)')
  expect(text).toContain('- c: still in recon')
  expect(text).toContain('q1 BLOCKING')
  expect(text).toContain('q2 (b, 0 min): b Q?')
  expect(lines[lines.length - 1]).toContain('mcp__flow__answer')
})

test('followUp is sent once for a filing after its round was delivered', () => {
  let s = recordSpawn(recordSpawn(EMPTY_PREFLIGHT, 'a', false, 0, 10 * MIN), 'b', false, 0, 10 * MIN)
  s = markDelivered(filed(s, 'a'), 1, 9)
  expect(s.rounds[0]!.reported).toEqual(['a'])
  s = filed(s, 'b')
  const f = followUp(s, 'b')
  expect(f.send).toBe(true)
  expect(followUp(f.state, 'b').send).toBe(false)
  expect(followUp(s, 'a').send).toBe(false)
  expect(renderFollowUp(f.state, EMPTY_INBOX, 'b', 5)).toContain('Pre-flight (late): b filed')
})

test('renderStatus describes the open or latest round; normalizePreflight drops junk', () => {
  expect(renderStatus(undefined, undefined, NONE, 0, MIN)).toBe('No pre-flight round yet.')
  const s = filed(recordSpawn(recordSpawn(EMPTY_PREFLIGHT, 'a', false, 0, 10 * MIN), 'b', false, 0, 10 * MIN), 'a')
  expect(renderStatus(s, EMPTY_INBOX, NONE, 0, 10 * MIN)).toContain('Round 1: open, 1 of 2 filed')
  expect(normalizePreflight({ entries: { x: { name: 'x', phase: 'bogus' }, y: { name: 'y', phase: 'recon' } }, rounds: [{ id: 'z' }, { id: 4, members: [] }] }))
    .toEqual({ next: 5, entries: { y: { name: 'y', phase: 'recon', blocking: [], asked: [], round: 0, spawnedAt: 0 } }, rounds: [{ id: 4, members: [], reported: [] }] })
})

test('settings: preflight takes on or off, another value warns and is ignored', () => {
  const r = mergeLayers({}, [{ path: '/repo/flow.json', text: JSON.stringify({ preflight: 'maybe', preflight_wait: 5 }) }])
  expect(r.raw['preflight']).toBeUndefined()
  expect(r.raw['preflight_wait']).toBe(5)
  expect(r.warnings.join('\n')).toContain('"preflight" is "maybe"')
  expect(mergeLayers({}, [{ path: '/repo/flow.json', text: JSON.stringify({ preflight: 'off' }) }]).raw['preflight']).toBe('off')
})

test('recordSpawn closes an open round past its wait unsent and opens a new one', () => {
  let s = filed(recordSpawn(EMPTY_PREFLIGHT, 'old', false, 0, 10 * MIN), 'old')
  s = recordSpawn(s, 'ghost', false, 1, 10 * MIN)
  s = recordSpawn(s, 'fresh', false, 11 * MIN, 10 * MIN)
  expect(s.rounds.map(r => [r.delivered, r.members])).toEqual([[true, ['old', 'ghost']], [false, ['fresh']]])
  expect(s.rounds[0]!.reported).toEqual(['old'])
  expect(dueRound(s, NONE, 12 * MIN, 10 * MIN)).toBeUndefined()
})

test('closeStale closes undelivered rounds with no live member, keeps the rest', () => {
  const s = recordSpawn(recordSpawn(EMPTY_PREFLIGHT, 'a', false, 0, 10 * MIN), 'b', false, 0, 10 * MIN)
  expect(closeStale(s, ['a-2'], 5)).toBe(s)
  const c = closeStale(s, [], 5)
  expect(c.rounds[0]!.delivered).toBe(true)
  expect(dueRound(c, NONE, 99 * MIN, MIN)).toBeUndefined()
})

test('ask_cards: round and late-filing texts carry the card instruction only with cards on and a blocking question open', () => {
  let inbox: Inbox = EMPTY_INBOX
  const ask = (name: string, blocking: boolean) => {
    inbox = addQuestions(inbox, { name, isManager: true }, 'main', [{ question: `${name} Q?`, options: ['a', 'b'], default: 'a', blocking }], 2).inbox
  }
  ask('a', true)
  ask('b', false)
  const roundOf = (names: string[], blockingIds: Record<string, string[]>) => {
    let s = names.reduce((acc, n) => recordSpawn(acc, n, false, 0, 10 * MIN), EMPTY_PREFLIGHT)
    for (const n of names) s = filed(s, n, OK, { asked: [n === 'a' ? 'q1' : 'q2'], blocking: blockingIds[n] ?? [] })
    return s
  }
  const mixed = roundOf(['a', 'b'], { a: ['q1'] })
  const off = renderRound(mixed, inbox, mixed.rounds[0]!, NONE, 5, false)
  const on = renderRound(mixed, inbox, mixed.rounds[0]!, NONE, 5, false, true)
  expect(off).not.toContain('AskUserQuestion')
  expect(on.startsWith(off)).toBe(true)
  expect(on).toContain(CARDS_TEXT)
  // A round with only non-blocking questions is the same text either way.
  const soft = roundOf(['b'], {})
  expect(renderRound(soft, inbox, soft.rounds[0]!, NONE, 5, false, true)).toBe(renderRound(soft, inbox, soft.rounds[0]!, NONE, 5, false))
  // Late filing.
  let late = markDelivered(roundOf(['b'], {}), 1, 9)
  late = filed(late, 'a', OK, { asked: ['q1'], blocking: ['q1'] })
  const f0 = renderFollowUp(late, inbox, 'a', 5)
  const f1 = renderFollowUp(late, inbox, 'a', 5, true)
  expect(f0).not.toContain('AskUserQuestion')
  expect(f1.startsWith(f0)).toBe(true)
  expect(f1).toContain(CARDS_TEXT)
  const lateSoft = filed(markDelivered(roundOf(['a'], { a: ['q1'] }), 1, 9), 'b', OK, { asked: ['q2'], blocking: [] })
  expect(renderFollowUp(lateSoft, inbox, 'b', 5, true)).toBe(renderFollowUp(lateSoft, inbox, 'b', 5))
})

test('askcards helper: the instruction covers every rule; the report hint fires on a question last line only', () => {
  for (const part of ['AskUserQuestion', 'at most 4', '12 chars', '(Recommended)', 'more than 4 options', 'ONE mcp__flow__answer', 'quoted', 'Never answer env/deploy', 'how many remain', 'Non-blocking']) expect(CARDS_TEXT).toContain(part)
  expect(cardsOn({})).toBe(true)
  expect(cardsOn({ ask_cards: 'on' })).toBe(true)
  expect(cardsOn({ ask_cards: 'off' })).toBe(false)
  expect(cardsNotice('Deploy x awaits', ['q1', 'q2'])).toBe(`Deploy x awaits (q1, q2). ${CARDS_TEXT}`)
  expect(lastLineAsks('done\nShip it?\n')).toBe(true)
  expect(lastLineAsks('Ship it?\ndone')).toBe(false)
  expect(lastLineAsks('')).toBe(false)
})

// #222: managers past pre-flight without filing, and rounds that would tell main nothing new.
const row = (name: string, status: string, id = name) => ({ id, name, description: '', type: 'flow:manager', status })
const ho = (reportTo: string, at: number) => ({ pr: 1, title: 't', head: 'h', branch: 'b', reportTo, verified: '', pending: '', afterDeploy: '', status: 'pending' as const, at })

test('doneManagers: an ended agent or session, a reported session, a handover since spawn; a live successor is not', () => {
  let s = EMPTY_PREFLIGHT
  for (const n of ['a', 'b', 'c', 'd', 'e', 'f']) s = recordSpawn(s, n, false, 10, 10 * MIN)
  const rows = [
    row('a', 'completed'), row('a-2', 'running'),
    row('b', 'completed', 'session:b'),
    sessionRow({ name: 'c', role: 'manager', status: 'reported', harness: 'claude', host: 'orca', owner: 'main' } as never),
    row('d', 'running'),
    row('e', 'running'),
    row('f', 'running'),
  ]
  const done = doneManagers(s, rows, [ho('d', 20), ho('e-2', 11), ho('f', 5)])
  expect([...done.entries()].sort()).toEqual([['b', 'ended'], ['c', 'finished'], ['d', 'handed over a PR'], ['e', 'handed over a PR']])
})

test('a done manager is settled: not timed out for, listed by why, and the round is due at once', () => {
  let s = recordSpawn(recordSpawn(recordSpawn(EMPTY_PREFLIGHT, 'a', false, 0, 10 * MIN), 'b', false, 0, 10 * MIN), 'c', false, 0, 10 * MIN)
  s = filed(s, 'a')
  const done = new Map([['b', 'handed over a PR'], ['c', 'finished']])
  expect(dueRound(s, done, 1, 10 * MIN)?.timedOut).toBe(false)
  const text = renderRound(s, EMPTY_INBOX, s.rounds[0]!, done, 1, false)
  expect(text).toContain('- b: handed over a PR without pre-flight')
  expect(text).toContain('- c: finished without pre-flight')
  expect(text).not.toContain('still in recon')
  // Timed out with one manager in recon and one done: only the recon one is waited for.
  const late = recordSpawn(recordSpawn(EMPTY_PREFLIGHT, 'x', false, 0, 10 * MIN), 'y', false, 0, 10 * MIN)
  const t = renderRound(late, EMPTY_INBOX, late.rounds[0]!, new Map([['y', 'ended']]), 10 * MIN, true)
  expect(t).toContain('Timed out waiting for: x.')
  expect(t).toContain('- y: ended without pre-flight')
})

test('answered questions are left out of a round and of a late follow-up', () => {
  let inbox: Inbox = addQuestions(EMPTY_INBOX, { name: 'a', isManager: true }, 'main',
    [{ question: 'A?', options: ['x', 'y'], default: 'x', blocking: true }, { question: 'B?', options: ['x', 'y'], default: 'x', blocking: false }], 2).inbox
  const m = markAnswered(inbox, 'q1', null, 'main', 3)
  if (m.kind !== 'ok') throw new Error('not answered')
  inbox = m.inbox
  let s = filed(recordSpawn(EMPTY_PREFLIGHT, 'a', false, 0, 10 * MIN), 'a', OK, { asked: ['q1', 'q2'], blocking: ['q1'] })
  // The inbox footer's usage example always says q1: look for the question itself.
  const text = renderRound(s, inbox, s.rounds[0]!, NONE, 5, false)
  expect(text).not.toContain('A?')
  expect(text).toContain('questions: q2\n')
  expect(text).toContain('B?')
  s = recordSpawn(markDelivered(recordSpawn(EMPTY_PREFLIGHT, 'b', false, 0, 10 * MIN), 1, 1), 'z', false, 2, 10 * MIN)
  s = filed(markDelivered(s, 2, 3), 'a', OK, { asked: ['q1', 'q2'], blocking: ['q1'] })
  const late = renderFollowUp(s, inbox, 'a', 5)
  expect(late).not.toContain('A?')
  expect(late).toContain('questions: q2\n')
  expect(late).toContain('B?')
})

test('deliverRound: a round telling main nothing new is closed unsent; a change or a new question is sent', () => {
  // Round 1 times out with login in recon; login is spawned again and its round times out the same.
  let s = filed(recordSpawn(recordSpawn(EMPTY_PREFLIGHT, 'csv', false, 0, 10 * MIN), 'login', false, 0, 10 * MIN), 'csv')
  const r1 = deliverRound(s, EMPTY_INBOX, NONE, 10 * MIN, 10 * MIN)
  expect(r1.send?.timedOut).toBe(true)
  s = recordSpawn(r1.state, 'login', false, 11 * MIN, 10 * MIN)
  const r2 = deliverRound(s, EMPTY_INBOX, NONE, 21 * MIN, 10 * MIN)
  expect(r2.send).toBeUndefined()
  expect(r2.state.rounds[1]!.delivered).toBe(true)
  // Done since: that is news.
  s = recordSpawn(r2.state, 'login', false, 22 * MIN, 10 * MIN)
  expect(deliverRound(s, EMPTY_INBOX, new Set(['login']), 22 * MIN, 10 * MIN).send).toBeDefined()
  // The same filing with a new open question is news too.
  let q = filed(recordSpawn(EMPTY_PREFLIGHT, 'a', false, 0, 10 * MIN), 'a')
  const d1 = deliverRound(q, EMPTY_INBOX, NONE, 1, 10 * MIN)
  expect(d1.send).toBeDefined()
  q = filed(recordSpawn(d1.state, 'a', false, 2, 10 * MIN), 'a')
  expect(deliverRound(q, EMPTY_INBOX, NONE, 3, 10 * MIN).send).toBeUndefined()
  const inbox = addQuestions(EMPTY_INBOX, { name: 'a', isManager: true }, 'main', [{ question: 'Q?', options: ['x', 'y'], default: 'x', blocking: false }], 2).inbox
  q = filed(recordSpawn(q, 'a', false, 4, 10 * MIN), 'a', OK, { asked: ['q1'], blocking: [] })
  expect(deliverRound(q, inbox, NONE, 5, 10 * MIN).send).toBeDefined()
  // Skipped managers only: closed, nothing sent.
  const sk = deliverRound(recordSpawn(EMPTY_PREFLIGHT, 's', true, 0, 10 * MIN), EMPTY_INBOX, NONE, 1, 10 * MIN)
  expect(sk.send).toBeUndefined()
  expect(sk.state.rounds[0]!.delivered).toBe(true)
})

test('a late filing main was already told of is not sent again', () => {
  // a filed and was reported; a fresh spawn of a lands in a round closed unsent (left by a session that
  // ended), then it files the same plan again.
  let s = filed(recordSpawn(EMPTY_PREFLIGHT, 'a', false, 0, 10 * MIN), 'a')
  s = deliverRound(s, EMPTY_INBOX, NONE, 1, 10 * MIN).state
  s = closeStale(recordSpawn(s, 'a', false, 2, 10 * MIN), [], 3)
  const again = followUp(filed(s, 'a'), 'a', EMPTY_INBOX)
  expect(again.send).toBe(false)
  expect(again.state.rounds[1]!.reported).toEqual(['a'])
  // A different filing is news.
  expect(followUp(filed(s, 'a', { ...OK, summary: 'export tsv' }), 'a', EMPTY_INBOX).send).toBe(true)
})

test('normalizePreflight: a record from before said loads without it and keeps the stored one', () => {
  const old = { next: 2, entries: { a: { name: 'a', phase: 'recon', round: 1, spawnedAt: 0, blocking: [], asked: [] } }, rounds: [{ id: 1, openedAt: 0, members: ['a'], delivered: false, reported: [] }] }
  const n = normalizePreflight(old)
  expect('said' in n).toBe(false)
  expect(deliverRound(n, EMPTY_INBOX, NONE, 10 * MIN, 10 * MIN).send?.timedOut).toBe(true)
  expect(normalizePreflight({ ...old, said: { a: 'x', b: 3 } }).said).toEqual({ a: 'x' })
})
