import { expect } from 'claude-code/testing'
import { test } from './support'

import type { DecideIo, FetchLike } from '../hooks/decide'
import { decide } from '../hooks/decide'
import { conflictData, handoffData, inboxData, loadDatasets, parseLog, reportText, runEval, testDataFromTranscripts, unitCosts } from '../hooks/decide-eval'
import type { Ask, LogLine, TranscriptEvent } from '../hooks/decide-eval'
import { decideEvalTool } from '../hooks/decide-eval-run'
import { parseJev } from '../hooks/jev'
import { INBOX_ROUTINE_QUESTION } from '../hooks/decide-questions'

const item = (id: string, over: Record<string, unknown>) => ({ id, owner: 'w', question: `q ${id}`, options: ['Keep', 'Overturn'], state: 'answered', ...over })

test('inbox data: answered fyi items are labelled, empty answers skipped, other questions are the guard set', () => {
  const d = inboxData([
    item('d1', { kind: 'fyi', answer: 'Keep' }),
    item('d2', { kind: 'fyi', answer: 'Overturn' }),
    item('d3', { kind: 'fyi', answer: '' }),
    item('d4', { kind: 'fyi', state: 'open' }),
    item('q1', { blocking: true, answer: 'x' }),
  ])
  expect(d.records.map(r => [r.id, r.label])).toEqual([['d1', 'keep'], ['d2', 'undo']])
  expect(d.guard?.map(r => [r.id, r.label])).toEqual([['q1', 'ask_main']])
  expect(d.notes[0]).toContain('skipped (empty answer): 1')
})

test('conflict data: a changelog-only report is trivial, source or a sub-agent is not; the baseline uses the files', () => {
  const log: LogLine[] = [
    { event: 'done', pr: 1, text: 'kept both sides in CHANGELOG.md | released' },
    { event: 'done', pr: 2, text: 'kept both sides in hooks/register.tsx (imports) | x' },
    { event: 'done', pr: 3, text: 'kept both sides in CHANGELOG.md (sub-agent resolved) | x' },
  ]
  const d = conflictData(log)
  expect(d.records.map(r => r.label)).toEqual(['trivial', 'needs_agent', 'needs_agent'])
  expect(d.records.map(r => r.baseline)).toEqual(['trivial', 'needs_agent', 'trivial'])
})

test('conflict data from a transcript: files, hunks and whether a conflict agent followed', () => {
  const evs: TranscriptEvent[] = [
    { t: 'result', id: 'a', text: 'Auto-merging CHANGELOG.md\nCONFLICT (content): Merge conflict in CHANGELOG.md\nAutomatic merge failed' },
    { t: 'result', id: 'b', text: '<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> branch' },
    { t: 'agent', model: 'opus', type: '', prompt: 'resolve the conflict' },
  ]
  const d = conflictData([], [evs])
  expect(d.records.length).toBe(1)
  expect(d.records[0]?.text).toContain('- CHANGELOG.md')
  expect(d.records[0]?.text).toContain('<<<<<<< HEAD')
  expect(d.records[0]?.label).toBe('needs_agent')
})

test('test failures from transcripts: a same-size passing rerun with no edit is flaky, an edit first is real', () => {
  const fail = (id: string) => ({ t: 'result' as const, id, text: '(fail) a test [1ms]\n 5 pass\n 1 fail\nRan 600 tests across 5 files.' })
  const pass: TranscriptEvent = { t: 'result', id: 'p', text: ' 6 pass\n 0 fail\nRan 600 tests across 5 files.' }
  const flaky = testDataFromTranscripts([[fail('1'), pass]])
  const real = testDataFromTranscripts([[fail('1'), { t: 'edit' }, pass]])
  expect(flaky.map(r => r.label)).toEqual(['flaky'])
  expect(real.map(r => r.label)).toEqual(['real'])
})

test('handoff data: a <name>-N successor continues, another name splits; a missing note is skipped', async () => {
  const log: LogLine[] = [
    { ts: '2026-01-01T00:00:00Z', event: 'handoff', agent: 'a', owner: 'm', branch: 'flow/a', text: '/n/1.md' },
    { ts: '2026-01-01T00:01:00Z', event: 'continue', agent: 'a-2', owner: 'm', branch: 'flow/a' },
    { ts: '2026-01-01T00:02:00Z', event: 'handoff', agent: 'a-2', owner: 'm', branch: 'flow/a', text: '/n/2.md' },
    { ts: '2026-01-01T00:03:00Z', event: 'continue', agent: 'a-tests', owner: 'm', branch: 'flow/a' },
    { ts: '2026-01-01T00:04:00Z', event: 'handoff', agent: 'b', owner: 'm', branch: 'flow/b', text: '/n/gone.md' },
  ]
  const d = await handoffData(log, 2, async p => (p.endsWith('gone.md') ? undefined : `note ${p}`))
  expect(d.records.map(r => r.label)).toEqual(['continue', 'split'])
  expect(d.records[1]?.text).toContain('so far on this branch: 2')
})

const ledger = { m: { role: 'main', turns: 2, models: { 'claude-opus-5-5': { input: 1_000_000, write5m: 0, write1h: 0, read: 0, output: 0 } } } }

test('unit cost: the ledger average of a turn at list prices', () => {
  const u = unitCosts(ledger)
  expect(u.inbox.usd).toBe(2)
  expect(u.inbox.tokens).toBe(500_000)
  expect(u.test.usd).toBe(0)
})

test('runEval: thresholds split answered from fell through, agreement counts matches, the guard counts wrong answers', async () => {
  const ask: Ask = async text => (text.includes('q d1') ? { answer: 'keep', confidence: 0.95 } : text.includes('q d2') ? { answer: 'keep', confidence: 0.6 } : text.includes('q q1') ? { answer: 'keep', confidence: 0.9 } : { note: 'jev unavailable: timeout' })
  const ds = inboxData([item('d1', { kind: 'fyi', answer: 'Keep' }), item('d2', { kind: 'fyi', answer: 'Overturn' }), item('d3', { kind: 'fyi', answer: 'Keep' }), item('q1', { blocking: true, answer: 'x' })])
  const [r] = await runEval(ask, [ds], unitCosts(ledger), { features: ['inbox'] })
  expect(r?.rows.map(x => [x.threshold, x.answered, x.agree])).toEqual([[0.5, 2, 1], [0.7, 1, 1], [0.8, 1, 1], [0.9, 1, 1]])
  expect(r?.rows[0]?.fellThrough).toBe(1)
  expect(r?.histogram['0.9-1.0']).toBe(1)
  expect(r?.histogram.error).toBe(1)
  expect(r?.errors).toEqual(['jev unavailable: timeout'])
  expect(r?.mustNotAutoAnswer?.map(x => x.wronglyAnswered)).toEqual([1, 1, 1, 1])
  expect(reportText({ provider: 'jev', at: 'now', features: r ? [r] : [] })).toContain('== inbox')
})

const jevFetch = (confidence: number): FetchLike => async (_url, init) => {
  const id = Object.keys((JSON.parse(init.body) as { questions: object }).questions)[0]!
  return { ok: true, status: 200, json: async () => ({ answers: { [id]: { choice: 'keep', confidence } } }) }
}
const io = (f: FetchLike): DecideIo => ({ fetch: f, after: () => ({ cancel: () => undefined }) })

test('minConfidence: a lower floor keeps the raw confidence, the default floor still falls through', async () => {
  const s = { decisionApi: 'jev' as const, jevApiKey: 'k' }
  expect(await decide(io(jevFetch(0.3)), s, 't', INBOX_ROUTINE_QUESTION)).toEqual({ note: 'jev unavailable: low confidence 0.30' })
  expect(await decide(io(jevFetch(0.3)), s, 't', INBOX_ROUTINE_QUESTION, undefined, 0)).toEqual({ answer: 'keep', confidence: 0.3 })
  expect(parseJev({ answers: { inbox_routine: { choice: 'keep', confidence: 0.3 } } }, INBOX_ROUTINE_QUESTION, 0)).toEqual({ answer: 'keep', confidence: 0.3 })
})

const files: Record<string, string> = {
  '/s/inbox.json': JSON.stringify({ items: [item('d1', { kind: 'fyi', answer: 'Keep' })] }),
  '/s/log.jsonl': [{ event: 'tests-failed', owner: 'o', text: 'full plugin tests: failed: a, b' }, { event: 'flaky', owner: 'o', text: 'full plugin tests: flaky: a, b' }].map(x => JSON.stringify(x)).join('\n'),
  '/s/ledger.json': JSON.stringify(ledger),
}
const toolIo = (f: FetchLike, written: Record<string, string> = {}) => ({
  stateDir: async () => '/s',
  readFile: async (p: string) => files[p],
  writeFile: async (p: string, t: string) => { written[p] = t },
  decideIo: io(f),
  now: async () => 0,
})
const settings = { decisionApi: 'jev' as const, jevApiKey: 'sk-secret', maxContinues: 2 }

test('decide_eval: main only, refused when decision_api is off, dry run makes no call, a run writes no text and no key', async () => {
  let calls = 0
  const f: FetchLike = async (u, i) => { calls++; return jevFetch(0.9)(u, i) }
  expect(await decideEvalTool(toolIo(f), settings, {}, 'agent1')).toContain('only main')
  expect(await decideEvalTool(toolIo(f), { ...settings, decisionApi: 'off' as never }, {}, undefined)).toContain('decision_api is off')
  const dry = await decideEvalTool(toolIo(f), { ...settings, decisionApi: 'off' as never }, { dry_run: true }, undefined)
  expect(dry).toContain('inbox: 1 records')
  expect(calls).toBe(0)
  const written: Record<string, string> = {}
  const out = await decideEvalTool(toolIo(f, written), settings, { features: ['inbox', 'test'] }, undefined)
  expect(out).toContain('== inbox')
  expect(out).toContain('== test')
  expect(out).not.toContain('sk-secret')
  const json = written['/s/decide-eval.json'] ?? ''
  expect(json).toContain('"d1"')
  expect(json).not.toContain('sk-secret')
  expect(json).not.toContain('Question:')
  expect(calls).toBe(2)
})

test('loadDatasets and parseLog tolerate missing and torn files', async () => {
  expect(parseLog('{"event":"a"}\nnot json\n').length).toBe(1)
  const { datasets } = await loadDatasets({ read: async () => undefined, readAbs: async () => undefined, maxContinues: 2 })
  expect(datasets.map(d => d.records.length)).toEqual([0, 0, 0, 0])
})
