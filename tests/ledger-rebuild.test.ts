import { expect } from 'claude-code/testing'
import { test } from './support'

import { costOf, priceOf, ZERO } from '../hooks/cost'
import * as lr from '../scripts/ledger-rebuild-core.mjs'

// Transcript lines the way Claude Code writes them: one line per content block, all with the message id.
type Block = 'text' | 'tool_use' | 'thinking'
const line = (id: string, model: string, usage: Record<string, unknown> | undefined, o: { block?: Block; at?: number; stop?: string | null } = {}) => JSON.stringify({
  type: 'assistant', timestamp: new Date(o.at ?? 1_000_000).toISOString(),
  message: { id, model, role: 'assistant', content: [{ type: o.block ?? 'text' }], stop_reason: o.stop ?? null, ...(usage ? { usage } : {}) },
})
const jsonl = (...ls: string[]) => `${ls.join('\n')}\n`
const u = (input: number, output: number, extra: Record<string, unknown> = {}) => ({ input_tokens: input, output_tokens: output, ...extra })
const sumOf = (m: Record<string, any>) => Object.values(m).reduce((n: number, b: any) => n + b.input + b.write5m + b.write1h + b.read + b.output, 0)

const summarize = (...texts: string[]) => lr.summarize(lr.repliesOf(texts))

test('the same message id on several lines counts once, with the last usage', () => {
  const s = summarize(jsonl(
    line('m1', 'claude-opus-5-5', u(10, 1), { block: 'thinking' }),
    line('m1', 'claude-opus-5-5', u(10, 50), { block: 'tool_use', stop: 'tool_use' }),
    line('m2', 'claude-opus-5-5', u(5, 5)),
  ))
  expect(s.models['claude-opus-5-5']).toEqual({ input: 15, write5m: 0, write1h: 0, read: 0, output: 55 })
})

test('the same id in two transcript files counts once', () => {
  const t = jsonl(line('m1', 'claude-opus-5-5', u(10, 1)))
  expect(summarize(t, t).models['claude-opus-5-5']!.input).toBe(10)
})

test('two models in one transcript keep separate buckets', () => {
  const s = summarize(jsonl(line('a', 'claude-opus-5-5', u(1, 1)), line('b', 'claude-haiku-4-5', u(2, 2))))
  expect(Object.keys(s.models).sort()).toEqual(['claude-haiku-4-5', 'claude-opus-5-5'])
  expect(s.models['claude-haiku-4-5']!.input).toBe(2)
})

test('cache writes split 5m/1h with the breakdown, else all are 5m', () => {
  const split = summarize(jsonl(line('a', 'claude-opus-5-5', u(0, 0, { cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 70 } }))))
  expect(split.models['claude-opus-5-5']).toMatchObject({ write5m: 30, write1h: 70 })
  const plain = summarize(jsonl(line('a', 'claude-opus-5-5', u(0, 0, { cache_creation_input_tokens: 100 }))))
  expect(plain.models['claude-opus-5-5']).toMatchObject({ write5m: 100, write1h: 0 })
})

test('a step over the long threshold also lands in the long bucket (haiku-5-5 only)', () => {
  const s = summarize(jsonl(
    line('a', 'claude-haiku-5-5', u(1000, 10, { cache_read_input_tokens: 100_000 })),
    line('b', 'claude-haiku-5-5', u(10, 10)),
    line('c', 'claude-opus-5-5', u(1000, 10, { cache_read_input_tokens: 200_000 })),
  ))
  expect(s.models['claude-haiku-5-5']!.input).toBe(1010)
  expect(s.models['claude-haiku-5-5']!.long).toEqual({ input: 1000, write5m: 0, write1h: 0, read: 100_000, output: 10 })
  expect(s.models['claude-opus-5-5']!.long).toBeUndefined()
})

test('steps with no usage, all-zero tokens or a synthetic model are skipped', () => {
  const s = summarize(jsonl(
    line('a', 'claude-opus-5-5', undefined),
    line('b', 'claude-opus-5-5', u(0, 0)),
    line('c', '<synthetic>', u(5, 5)),
    line('d', 'claude-opus-5-5', u(3, 4)),
    '{not json',
  ))
  expect(Object.keys(s.models)).toEqual(['claude-opus-5-5'])
  expect(sumOf(s.models)).toBe(7)
})

test('turns are replies that called no tool, once per id, whatever the lines say', () => {
  const s = summarize(jsonl(
    line('a', 'claude-opus-5-5', u(1, 1), { block: 'thinking' }),
    line('a', 'claude-opus-5-5', u(1, 1), { block: 'tool_use' }), // stop_reason null, but it called a tool
    line('b', 'claude-opus-5-5', u(1, 1), { block: 'text' }),
    line('b', 'claude-opus-5-5', u(1, 1), { block: 'text', stop: 'end_turn' }),
    line('c', 'claude-opus-5-5', u(1, 1), { stop: 'max_tokens' }),
    line('d', 'claude-opus-5-5', u(1, 1), { block: 'text', stop: 'tool_use' }),
  ))
  expect(s.turns).toBe(2)
})

// A stand-in for the discovery: main sessions by their text, subagent transcripts by agent id.
const found = (o: { sessions?: Record<number, string[]>; agents?: Record<string, string[]> }) => ({
  sessions: Object.entries(o.sessions ?? {}).flatMap(([first, texts]) => texts.map(t => ({ first: Number(first), replies: lr.repliesOf([t]) }))),
  agentTexts: (key: string) => o.agents?.[key],
})

const ENTRY = { role: 'worker', name: 'w1', manager: 'm1', branch: 'flow/w1', spawnModel: 'sonnet', size: 'normal', firstAt: 1000, lastAt: 9000, extra: { keep: true } }

test('rebuild replaces models and turns, keeps every other field and key order, flags a missing transcript untouched', () => {
  const stale = { input: 999, write5m: 0, write1h: 0, read: 0, output: 0 }
  const ledger = {
    aaa: { ...ENTRY, models: { 'claude-sonnet-5-5': stale, 'claude-opus-5-5': stale }, turns: 40 },
    bbb: { role: 'reviewer', name: 'r', models: { 'claude-opus-5-5': stale }, turns: 7 },
    ccc: { ...ENTRY, models: {} }, // no transcript, no turns field
  }
  const text = jsonl(line('m1', 'claude-sonnet-5-5', u(100, 10), { at: 2000 }), line('m1', 'claude-sonnet-5-5', u(100, 10), { at: 2000 }), line('m2', 'claude-sonnet-5-5', u(1, 1), { at: 3000, stop: 'end_turn' }))
  const { ledger: out, rows } = lr.rebuild(ledger, found({ agents: { aaa: [text] } }))
  expect(Object.keys(out)).toEqual(['aaa', 'bbb', 'ccc'])
  expect(Object.keys(out.aaa)).toEqual(Object.keys(ledger.aaa))
  expect(out.aaa).toEqual({ ...ENTRY, models: { 'claude-sonnet-5-5': { input: 101, write5m: 0, write1h: 0, read: 0, output: 11 } }, turns: 2 })
  expect(out.bbb).toBe(ledger.bbb) // kept as is
  expect(out.ccc).toBe(ledger.ccc)
  expect(rows.filter(r => r.flagged !== undefined).map(r => r.key)).toEqual(['bbb', 'ccc'])
})

test('an entry with no turns field stays without one; an empty entry with an empty transcript stays empty', () => {
  const { ledger } = lr.rebuild(
    { aaa: { ...ENTRY, models: {} }, bbb: { ...ENTRY, models: {}, turns: 3 } },
    found({ agents: { aaa: [jsonl(line('m1', 'claude-opus-5-5', u(1, 1), { stop: 'end_turn' }))], bbb: [jsonl('{}')] } }),
  )
  expect('turns' in ledger.aaa).toBe(false)
  expect(ledger.bbb.models).toEqual({})
  expect(ledger.bbb.turns).toBe(0)
})

test('one agent id in several files counts all of them, deduped by message id', () => {
  const one = jsonl(line('m1', 'claude-opus-5-5', u(10, 0)), line('m2', 'claude-opus-5-5', u(1, 0)))
  const two = jsonl(line('m2', 'claude-opus-5-5', u(1, 0)), line('m3', 'claude-opus-5-5', u(100, 0)))
  const { ledger } = lr.rebuild({ aaa: { ...ENTRY, models: {} } }, found({ agents: { aaa: [one, two] } }))
  expect(ledger.aaa.models['claude-opus-5-5'].input).toBe(111)
})

const T0 = Date.parse('2026-10-10T00:00:00Z')
const MAIN = { role: 'main', name: 'main', firstAt: T0 + 1000, lastAt: T0 + 9000, models: {}, turns: 9 }

test('main@<ms> maps to the nearest root session within a minute that has steps in the entry window', () => {
  const near = jsonl(line('n1', 'claude-opus-5-5', u(5, 0), { at: T0 + 120 }), line('n2', 'claude-opus-5-5', u(6, 0), { at: T0 + 5000 }))
  const far = jsonl(line('f1', 'claude-opus-5-5', u(1000, 0), { at: T0 + 600_000 }))
  const { ledger, rows } = lr.rebuild(
    { [`main@${T0}`]: MAIN, 'main@0': { ...MAIN }, [`main@${T0 + 3_600_000}`]: { ...MAIN } },
    found({ sessions: { [T0 + 120]: [near], [T0 + 600_000]: [far] } }),
  )
  expect(ledger[`main@${T0}`].models['claude-opus-5-5'].input).toBe(11)
  expect(ledger[`main@${T0}`].turns).toBe(2)
  expect(rows.filter(r => r.flagged !== undefined).map(r => r.key)).toEqual(['main@0', `main@${T0 + 3_600_000}`])
})

test('two main keys never share one session: the nearer takes it', () => {
  const only = jsonl(line('a', 'claude-opus-5-5', u(5, 0), { at: T0 + 2000 }))
  const { rows } = lr.rebuild({ [`main@${T0 - 30_000}`]: MAIN, [`main@${T0 + 100}`]: MAIN }, found({ sessions: { [T0]: [only] } }))
  expect(rows.map(r => r.flagged === undefined)).toEqual([false, true])
})

test('main@ with no steps in the window, or two different sessions starting together, is flagged', () => {
  const key = `main@${T0}`
  const a = jsonl(line('a1', 'claude-opus-5-5', u(5, 0), { at: T0 + 100 }))
  const late = { ...MAIN, firstAt: T0 + 50_000, lastAt: T0 + 90_000 }
  expect(lr.rebuild({ [key]: late }, found({ sessions: { [T0]: [a] } })).rows[0]!.flagged).toContain('window')
  const b = jsonl(line('b1', 'claude-opus-5-5', u(9, 0), { at: T0 + 100 }))
  expect(lr.rebuild({ [key]: MAIN }, found({ sessions: { [T0]: [a, b] } })).rows[0]!.flagged).toContain('ambiguous')
})

test('twin sessions that start together and share ids (a resumed copy) count once', () => {
  const a = line('a1', 'claude-opus-5-5', u(5, 0), { at: T0 + 2000 })
  const twins = [jsonl(a), jsonl(a, line('a2', 'claude-opus-5-5', u(6, 0), { at: T0 + 3000 }))]
  const { ledger } = lr.rebuild({ [`main@${T0}`]: MAIN }, found({ sessions: { [T0]: twins } }))
  expect(ledger[`main@${T0}`].models['claude-opus-5-5'].input).toBe(11)
})

test('a transcript that outlives firstAt..lastAt is counted whole and reported, times kept', () => {
  const text = jsonl(line('m1', 'claude-opus-5-5', u(1, 0), { at: 5000 }), line('m2', 'claude-opus-5-5', u(1, 0), { at: 99_000 }))
  const { ledger, rows } = lr.rebuild({ aaa: { ...ENTRY, models: {} } }, found({ agents: { aaa: [text] } }))
  expect(rows[0]!.outside).toBe(true)
  expect(ledger.aaa.firstAt).toBe(1000)
  expect(ledger.aaa.lastAt).toBe(9000)
  expect(ledger.aaa.models['claude-opus-5-5'].input).toBe(2)
})

test('rebuilding twice gives the same ledger', () => {
  const f = found({ agents: { aaa: [jsonl(line('m1', 'claude-opus-5-5', u(1, 2), { stop: 'end_turn' }))] } })
  const first = lr.rebuild({ aaa: { ...ENTRY, models: { 'claude-opus-5-5': { ...ZERO, input: 500 } }, turns: 9 } }, f).ledger
  expect(JSON.stringify(lr.rebuild(first, f).ledger)).toBe(JSON.stringify(first))
})

test('the report: factor distribution, growth list, flagged list, unknown models shown not zeroed', () => {
  const big = { ...ZERO, input: 4_000_000 } // $16 at opus-5-5
  const small = { ...ZERO, input: 1_000_000 } // $4
  const row = (key: string, role: string, before: any, after: any | undefined, flagged?: string) => ({ key, entry: { role, name: key, models: before }, ...(after ? { next: { role, name: key, models: after } } : {}), ...(flagged ? { flagged } : {}) })
  const text = lr.report([
    row('a', 'worker', { 'claude-opus-5-5': big }, { 'claude-opus-5-5': small }),
    row('b', 'worker', { 'claude-opus-5-5': small }, { 'claude-opus-5-5': big }),
    row('c', 'manager', { 'gpt-9': small }, { 'gpt-9': small }),
    row('d', 'manager', { 'claude-opus-5-5': big }, undefined, 'no transcript found'),
  ])
  expect(text).toContain('4x+: 1')
  expect(text).toContain('b worker/b: $4.00 -> $16.00')
  expect(text).toContain('d manager/d: no transcript found')
  expect(text).toContain('Models with no price')
  expect(text).toContain('gpt-9')
})

test('backup names are dated and never reuse a taken name', () => {
  const taken = new Set<string>()
  expect(lr.backupName('2026-10-12', n => taken.has(n))).toBe('ledger-pre-rebuild-2026-10-12.json')
  taken.add('ledger-pre-rebuild-2026-10-12.json')
  expect(lr.backupName('2026-10-12', n => taken.has(n))).toBe('ledger-pre-rebuild-2026-10-12-2.json')
  taken.add('ledger-pre-rebuild-2026-10-12-2.json')
  expect(lr.backupName('2026-10-12', n => taken.has(n))).toBe('ledger-pre-rebuild-2026-10-12-3.json')
})

test('the price table copy matches hooks/cost.ts for every id, alias and variant', () => {
  const ids = [...Object.keys(lr.PRICES), ...Object.keys(lr.FAMILIES), 'claude-opus-5-5[1m]', 'claude-sonnet-4-6-20260101', 'claude-haiku-4-5-latest', 'claude-opus-9-9', 'claude-opus-5-5-preview', 'claude-haiku-5-5-x', 'gpt-9', '<synthetic>']
  const buckets = [
    { ...ZERO, input: 1_000_000, write5m: 2_000_000, write1h: 3_000_000, read: 4_000_000, output: 5_000_000 },
    { input: 10, write5m: 20, write1h: 30, read: 40, output: 50, long: { input: 4, write5m: 5, write1h: 6, read: 7, output: 8 } },
  ]
  for (const id of ids) {
    expect(lr.priceOf(id) === undefined).toBe(priceOf(id) === undefined)
    for (const b of buckets) expect(lr.costOf(id, b)).toBe(costOf(id, b))
  }
  // Every id the plugin prices is in the copy.
  expect(ids.filter(id => priceOf(id) !== undefined).length).toBeGreaterThan(10)
})
