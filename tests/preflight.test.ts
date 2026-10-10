import { expect } from 'claude-code/testing'
import { test } from './support'
import { addQuestions, EMPTY_INBOX, markAnswered } from '../hooks/inbox'
import type { Inbox } from '../hooks/inbox'
import {
  closeStale, denyText, dueRound, EMPTY_PREFLIGHT, followUp, gateOf, isSkip, markDelivered, normalizePreflight, parseFiling, phaseOf,
  recordFiling, recordSpawn, renderFollowUp, renderRound, renderStatus,
} from '../hooks/preflight'
import type { Preflight } from '../hooks/preflight'
import { mergeLayers } from '../hooks/settings'

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
