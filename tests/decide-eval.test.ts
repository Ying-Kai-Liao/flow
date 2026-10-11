import { expect } from 'claude-code/testing'
import { test } from './support'

import type { DecideIo, FetchLike } from '../hooks/decide'
import { decide } from '../hooks/decide'
import { conflictData, exportJson, formatRoute, formatSizeSplit, handoffData, inboxData, loadDatasets, managerCounterfactual, parseExport, parseLog, recordedSize, reportText, routeBaselines, routeData, runEval, sizeBaselines, sizeData, sizeSplit, testDataFromTranscripts, unitCosts } from '../hooks/decide-eval'
import type { Ask, EvalRecord, LogLine, SizeMeta, TranscriptEvent } from '../hooks/decide-eval'
import { decideEvalTool } from '../hooks/decide-eval-run'
import { costOf } from '../hooks/cost'
import { parseJev } from '../hooks/jev'
import { INBOX_ROUTINE_QUESTION, ROUTE_QUESTION } from '../hooks/decide-questions'

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

test('decide_eval works on the OpenRouter route', async () => {
  const urls: string[] = []
  const f: FetchLike = async (u, i) => { urls.push(u); return jevFetch(0.9)(u, i) }
  const out = await decideEvalTool(toolIo(f), { decisionApi: 'jev' as const, openrouterApiKey: 'or-secret', maxContinues: 2 }, { features: ['inbox'] }, undefined)
  expect(out).toContain('== inbox')
  expect(out).not.toContain('or-secret')
  expect(urls.length > 0 && urls.every(u => u === 'https://openrouter.ai/api/v1/systemone')).toBe(true)
})

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

test('decide_eval loads decide-eval-data.json when present and says so; parseExport rejects junk', async () => {
  expect(parseExport('nope')).toBeUndefined()
  expect(parseExport(JSON.stringify({ at: 'x', datasets: [{ key: 'bogus', records: [] }], units: {} }))).toBeUndefined()
  const data = exportJson([{ key: 'test', records: [{ id: 'tf-1', text: 'z'.repeat(50), label: 'real' }], notes: [] }], unitCosts(ledger), '1970-01-01T00:00:00.000Z', 10)
  expect(JSON.parse(data).datasets[0].records[0].text.length).toBe(10)
  const all: Record<string, string> = { ...files, '/s/decide-eval-data.json': data }
  let calls = 0
  const f: FetchLike = async (u, i) => { calls++; return jevFetch(0.9)(u, i) }
  const out = await decideEvalTool({ ...toolIo(f), readFile: async p => all[p] }, settings, { features: ['test'] }, undefined)
  expect(out).toContain('Source: decide-eval-data.json (export from 1970-01-01T00:00:00.000Z')
  expect(out).toContain('== test  (n=1;')
  expect(calls).toBe(1)
})

test('loadDatasets and parseLog tolerate missing and torn files', async () => {
  expect(parseLog('{"event":"a"}\nnot json\n').length).toBe(1)
  const { datasets } = await loadDatasets({ read: async () => undefined, readAbs: async () => undefined, maxContinues: 2 })
  expect(datasets.map(d => d.records.length)).toEqual([0, 0, 0, 0, 0, 0])
})

// ---- size ----
const tok = (n: number) => ({ 'claude-sonnet-5-5': { input: n, write5m: 0, write1h: 0, read: 0, output: 0 } })
const brief = (name: string, size?: string) => `Your name: ${name}\n${size ? `Size: ${size} - why\n` : ''}do the thing`
const agentEv = (name: string, type: string, size?: string): TranscriptEvent => ({ t: 'agent', model: 'sonnet', type, prompt: brief(name, size) })
const pr = (state: string, ...lines: number[]) => ({ state, files: [...lines.map((n, i) => ({ path: `hooks/f${i}.ts`, additions: n, deletions: 0 })), { path: 'CHANGELOG.md', additions: 500, deletions: 0 }] })
const w = (name: string, spawnModel: string, extra: Record<string, unknown> = {}) => ({ role: 'worker', name, manager: 'mgr', branch: `flow/${name}`, spawnModel, models: tok(1_000_000), ...extra })
const sizeSrc = () => ({
  log: [{ event: 'spawn', agent: 'big', text: 'size large -> sonnet[1m]' }, { event: 'handoff', agent: 'hand', branch: 'flow/hand' }, { event: 'handoff', agent: 'bigho', branch: 'flow/bigho' }] as LogLine[],
  ledger: {
    a: w('ok1', 'sonnet'), b: w('hand', 'sonnet'), c: w('twice', 'sonnet'), d: w('twice-2', 'sonnet[1m]'), e: w('big', 'sonnet[1m]'),
    f: w('bigho', 'sonnet[1m]'), g: w('noprompt', 'sonnet'), h: w('nopr', 'sonnet'), i: w('undone', 'haiku'), j: { role: 'manager', name: 'mgr', spawnModel: 'opus', models: tok(2_000_000) },
  },
  inbox: [item('d9', { kind: 'fyi', topic: 'worker-size', question: 'undone runs small -> haiku (jev 0.81): x', answer: 'Overturn' }), item('d8', { kind: 'fyi', topic: 'worker-size', question: 'ok1 runs normal -> sonnet (jev 0.70): x', answer: 'Keep' })],
  transcripts: [['ok1', 'hand', 'twice', 'big', 'bigho', 'nopr', 'undone'].map(n => agentEv(n, 'flow:worker', 'normal')), [agentEv('mgr', 'flow:manager', 'large'), agentEv('reviewer-1', 'flow:reviewer'), agentEv('x', 'general-purpose')]],
  prs: { 'flow/ok1': pr('MERGED', 300), 'flow/hand': pr('MERGED', 300), 'flow/twice': pr('MERGED', 10), 'flow/twice-2': pr('MERGED', 50), 'flow/big': pr('MERGED', 40, 20), 'flow/bigho': pr('MERGED', 500), 'flow/undone': pr('MERGED', 200) },
})

test('size data: under by successor, handoff or undone decision; a large worker is over when trivial; no prompt or PR is skipped', () => {
  const d = sizeData(sizeSrc())
  const by = Object.fromEntries(d.records.map(r => [r.id, r]))
  expect(Object.fromEntries(d.records.map(r => [r.id, r.label]))).toEqual({ 'w-ok1': 'ok', 'w-hand': 'under', 'w-twice': 'under', 'w-big': 'over', 'w-bigho': 'ok', 'w-undone': 'under', 'm-mgr': 'ok' })
  expect(by['w-hand']?.size?.right).toBe('large')
  expect(by['w-big']?.size).toMatchObject({ used: 'large', right: 'normal', lines: 60 })
  // a handoff of a worker that already ran large is context exhaustion, not under-sizing
  expect(by['w-bigho']?.size?.used).toBe('large')
  expect(by['w-twice']?.size?.rerunUsd).toBeGreaterThan(0)
  expect(by['w-ok1']?.size?.recorded).toEqual({ size: 'normal', confidence: 0.7 })
  expect(by['w-undone']?.size?.recorded).toEqual({ size: 'small', confidence: 0.81 })
  expect(d.notes[0]).toContain('labelable with a recoverable prompt: 7')
  expect(d.notes[0]).toContain('"no prompt":1')
  expect(d.notes[0]).toContain('"no merged PR":1')
})

test('recordedSize reads the decision-API tag; an unavailable one is not an answer', () => {
  expect(recordedSize('x runs normal -> sonnet (jev 0.76): r')).toMatchObject({ name: 'x', size: 'normal', confidence: 0.76, answered: true })
  expect(recordedSize('x runs small -> haiku (jev unavailable: low confidence 0.38): r')?.answered).toBe(false)
  expect(recordedSize('x runs small -> haiku: r')?.answered).toBe(false)
  expect(recordedSize('not a size decision')).toBeUndefined()
})

test('size scoring: Size line and always-normal need no key; Jev falls back to the Size line below its threshold; the rerun is priced in', async () => {
  const d = sizeData(sizeSrc())
  const base = sizeBaselines(d.records).rows
  const asRun = base.find(r => r.sizer === 'as run')!
  expect(asRun.n).toBe(7)
  expect(asRun.under).toBe(3)
  expect(asRun.over).toBe(1)
  expect(asRun.usd).toBe(asRun.actualUsd)
  const ask: Ask = async text => (text.includes('Your name: hand') ? { answer: 'large', confidence: 0.9 } : text.includes('Your name: big\n') ? { answer: 'normal', confidence: 0.6 } : { note: 'jev unavailable: timeout' })
  const [r] = await runEval(ask, [d], unitCosts(ledger), { features: ['size'] })
  const rows = r!.size!.rows
  const jev = rows.find(x => x.sizer === 'jev (answered only)')!
  expect(jev.n).toBe(2)
  expect(jev.fellThrough).toBe(5)
  // at 0.8 only 'hand' (large, 0.9) is Jev's; 'big' at 0.6 is its Size line (normal) so it stays under the right normal? no: it agrees
  const at8 = rows.find(x => x.sizer === 'jev >= 0.8, else Size line')!
  expect(at8.n).toBe(7)
  expect(at8.fellThrough).toBe(6)
  expect(r!.labels).toEqual({ ok: 3, under: 3, over: 1 })
  expect(JSON.stringify(r)).not.toContain('do the thing')
})

test('decide_eval size: dry run says labelable of total and the key-free sizers; the export carries the metadata', async () => {
  const data = exportJson([sizeData(sizeSrc())], unitCosts(ledger), '1970-01-01T00:00:00.000Z', 4000)
  expect(parseExport(data)?.datasets[0]?.records[0]?.size?.role).toBe('worker')
  const all: Record<string, string> = { ...files, '/s/decide-eval-data.json': data }
  const out = await decideEvalTool({ ...toolIo(jevFetch(0.9)), readFile: async p => all[p] }, { ...settings, decisionApi: 'off' as never }, { dry_run: true, features: ['size'] }, undefined)
  expect(out).toContain('size: 7 records')
  expect(out).toContain('labelable with a recoverable prompt: 7')
  expect(out).toContain('always normal')
})

// ---- route ----
const mgrPrompt = (name: string, extra = '') => `Your name: ${name}\n${extra}do the thing`
const mgr = (name: string) => ({ role: 'manager', name, models: tok(1_000_000) })
const wk = (name: string, manager: string) => ({ role: 'worker', name, manager, branch: `flow/${name}`, models: tok(1_000_000) })
const mdPr = { state: 'MERGED', files: [{ path: 'docs/a.md', additions: 1, deletions: 0 }] }
const codePr = { state: 'MERGED', files: [{ path: 'hooks/a.ts', additions: 1, deletions: 0 }] }
const mgrEv = (n: string, extra = ''): TranscriptEvent => ({ t: 'agent', model: 'opus', type: 'flow:manager', prompt: mgrPrompt(n, extra) })
const routeSrc = () => ({
  ledger: {
    ...Object.fromEntries(['d', 'one', 'two', 'ask', 'back', 'plan', 'succ', 'succ-2', 'mig', 'conf', 'lite', 'docs', 'nopr'].map(n => [`m-${n}`, mgr(n)])),
    w1: wk('d-a', 'd'), w2: wk('one-a', 'one'), w3: wk('two-a', 'two'), w4: wk('two-b', 'two'), w5: wk('ask-a', 'ask'), w6: wk('back-a', 'back'), w7: wk('plan-a', 'plan'),
    w8: wk('succ-a', 'succ'), w9: wk('mig-a', 'mig'), w10: wk('conf-a', 'conf'), w11: wk('lite-a', 'lite'), w12: wk('docs-a', 'docs'), w13: wk('nopr-a', 'nopr'), w14: wk('one-a-2', 'one'),
  },
  inbox: [item('q9', { owner: 'ask', blocking: true })],
  transcripts: [
    [{ t: 'owner', name: 'plan' }, { t: 'flow', tool: 'plan', owner: 'plan', ids: ['plan-a'] }] as TranscriptEvent[],
    ...['d', 'one', 'two', 'ask', 'back', 'plan', 'succ', 'conf', 'nopr'].map(n => [mgrEv(n)]),
    [mgrEv('mig', 'add a migration\n')], [mgrEv('docs', 'Size: small - docs\n')], [mgrEv('lite', 'Mode: lite\n')],
  ],
  prs: { 'flow/d-a': codePr, 'flow/one-a': codePr, 'flow/one-a-2': codePr, 'flow/two-a': codePr, 'flow/two-b': codePr, 'flow/ask-a': codePr, 'flow/back-a': codePr, 'flow/plan-a': codePr, 'flow/succ-a': codePr, 'flow/mig-a': codePr, 'flow/conf-a': codePr, 'flow/lite-a': codePr, 'flow/docs-a': mdPr, 'flow/nopr-a': { state: 'OPEN', files: [] } } as Record<string, { state: string; files: { path: string; additions: number; deletions: number }[] }>,
})
const routeLog: LogLine[] = [{ event: 'back', owner: 'back', pr: 1, branch: 'flow/back-a' }, { event: 'approve', owner: 'conf', pr: 2, branch: 'flow/conf-a' }]
const routed = (src = routeSrc()) => { const d = routeData({ ...src, log: routeLog, lite: { lite: { name: 'lite', at: 0 } } }); return { d, by: Object.fromEntries(d.records.map(r => [r.id, r.label])) } }

test('route label: one worker with every direct condition is direct; each disqualifier makes it manager+1; two workers is manager+n', () => {
  const { by } = routed()
  expect(by['r-d']).toBe('direct')
  expect(by['r-two']).toBe('manager+n')
  // a -N worker successor counts as a second worker
  expect(by['r-one']).toBe('manager+n')
  // a blocking inbox question, a back event, a plan node and a successor manager each disqualify
  expect(by['r-ask']).toBe('manager+1')
  expect(by['r-back']).toBe('manager+1')
  expect(by['r-plan']).toBe('manager+1')
  expect(by['r-succ']).toBe('manager+1')
})

test('route: no merged PR is unlabelable; the hard rule removes migration prompts, confirm-mode tasks and risky files, and counts them', () => {
  const { d, by } = routed()
  expect(by['r-nopr']).toBeUndefined()
  expect(by['r-mig']).toBeUndefined()
  expect(by['r-conf']).toBeUndefined()
  expect(d.notes[0]).toContain('"no merged PR":1')
  expect(d.notes[0]).toContain('excluded by the hard rule: 2 {"prompt":1,"files":0,"confirm":1}')
  const src = routeSrc()
  src.prs['flow/d-a'] = { state: 'MERGED', files: [{ path: '.github/workflows/ci.yml', additions: 1, deletions: 0 }] }
  const r = routed(src)
  expect(r.by['r-d']).toBeUndefined()
  expect(r.d.notes[0]).toContain('"files":1')
})

test('route scoring: agreement, under- and over-shaped are separate; main maps lite to direct; a wrong direct costs more than as run', () => {
  const { d } = routed()
  const rows = Object.fromEntries(routeBaselines(d.records).rows.map(r => [r.router, r]))
  const n = d.records.length
  expect(rows['always direct']).toMatchObject({ n, agree: 3, under: n - 3, over: 0 })
  expect(rows['always manager+n']).toMatchObject({ agree: 2, under: 0, over: n - 2 })
  const main = rows['main (lite = direct)']!
  expect(main.agree + main.under + main.over).toBe(n)
  expect(main.agree).toBe(7)
  expect(main.usd).toBe(main.actualUsd)
  expect(main.over).toBe(2)
  expect(Math.abs(rows['always manager+n']!.usd - rows['always manager+n']!.actualUsd)).toBeLessThan(0.0001)
  expect(rows['always direct']!.usd).toBeGreaterThan(rows['always direct']!.actualUsd)
})

test('route replay: Jev answers score live, an error falls back to manager+1; the report holds no prompt text', async () => {
  const { d } = routed()
  const ask: Ask = async text => (text.includes('Your name: d\n') ? { answer: 'direct', confidence: 0.9 } : { note: 'jev unavailable: timeout' })
  const [r] = await runEval(ask, [d], unitCosts(ledger), { features: ['route'] })
  const jev = r!.route!.rows.find(x => x.router === 'jev (answered only)')!
  expect(jev).toMatchObject({ n: 1, agree: 1, fellThrough: d.records.length - 1 })
  expect(r!.route!.rows.find(x => x.router === 'jev, else manager+1')!.n).toBe(d.records.length)
  expect(JSON.stringify(r)).not.toContain('do the thing')
  expect(reportText({ provider: 'jev', at: 'now', features: [r!] })).toContain('under-shaped')
})

test('route: the collapsed table counts needless-manager and wrongly-direct apart, and the answer keys with a plus sign parse', () => {
  const { d } = routed()
  const rows = Object.fromEntries(routeBaselines(d.records).rows.map(r => [r.router, r]))
  expect(rows['always direct']).toMatchObject({ agree2: 3, needless: 0, wronglyDirect: d.records.length - 3 })
  expect(rows['always manager+1']).toMatchObject({ agree2: d.records.length - 3, needless: 3, wronglyDirect: 0 })
  expect(rows['main (lite = direct)']!.usd2).toBe(rows['main (lite = direct)']!.actualUsd)
  expect(formatRoute(routeBaselines(d.records))).toContain('direct vs any manager')
  for (const choice of ['direct', 'manager+1', 'manager+n']) {
    expect(parseJev({ answers: { route: { choice, confidence: 0.9 } } }, ROUTE_QUESTION)).toEqual({ answer: choice, confidence: 0.9 })
  }
  expect(parseJev({ answers: { route: { choice: 'manager', confidence: 0.9 } } }, ROUTE_QUESTION)).toEqual({ note: 'jev unavailable: unknown choice' })
})

// Hand-built size records: tokens are 1M output so the prices are easy to read.
const mrec = (role: SizeMeta['role'], used: SizeMeta['used'], right: SizeMeta['right'], brief?: SizeMeta['used']): EvalRecord => ({
  id: `${role}-${used}-${right}`, text: 't', label: 'x',
  size: { role, used, right, ...(brief !== undefined ? { brief } : {}), tokens: { input: 0, write5m: 0, write1h: 0, read: 0, output: 1_000_000 } },
})

test('size split groups by role and model run on, with agreement, under rate and as-run cost', () => {
  const rows = sizeSplit([mrec('manager', 'small', 'large'), mrec('manager', 'small', 'small'), mrec('manager', 'large', 'large', 'small'), mrec('worker', 'normal', 'normal')])
  expect(rows.find(r => r.role === 'manager' && r.model === 'sonnet')).toMatchObject({ n: 2, agreeRun: 1, under: 1 })
  expect(rows.find(r => r.role === 'manager' && r.model === 'opus')).toMatchObject({ n: 1, agreeRun: 1, agreeLine: 0, under: 0 })
  expect(rows.find(r => r.role === 'worker' && r.model === 'sonnet')?.n).toBe(1)
})

test('manager counterfactual: opus-run tokens at sonnet plus the sonnet-run under rate as opus reruns', () => {
  const cf = managerCounterfactual([mrec('manager', 'small', 'large'), mrec('manager', 'small', 'small'), mrec('manager', 'large', 'large'), mrec('manager', 'large', 'small')])
  expect(cf).toMatchObject({ n: 2, smallN: 2, underRate: 0.5 })
  const out = { input: 0, write5m: 0, write1h: 0, read: 0, output: 1_000_000 }
  expect(cf.currentUsd.toFixed(6)).toBe((2 * costOf('opus', out)!).toFixed(6))
  expect(cf.counterfactualUsd.toFixed(6)).toBe((2 * (costOf('sonnet', out)! + 0.5 * costOf('opus', out)!)).toFixed(6))
})

test('size split prints "no data", not NaN, for an empty role', () => {
  const out = formatSizeSplit(sizeSplit([]), managerCounterfactual([]))
  expect(out).toContain('worker: no data')
  expect(out).toContain('manager: no data')
  expect(out).toContain('normal managers on sonnet: no data')
  expect(out).not.toContain('NaN')
})
