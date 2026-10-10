import type { AgentInfo } from 'claude-code'
import { expect, mock } from 'claude-code/testing'
import { test } from './support'
import type { TestBody } from 'claude-code/testing'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const DIR = '/r/.git/flow'
const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const PANE = { component: 'Pane', props: { title: 'Flow' } as never, requestId: 'flow' } as const

// A manager "csv-export" (m1) with one worker (w1).
function world(on: On, agents?: AgentInfo[]) {
  mock.clock(on, { now: 1_000_000 })
  const roster: AgentInfo[] = agents ?? [
    { id: 'm1', name: 'csv-export', description: 'm', type: 'flow:manager', status: 'running' },
    { id: 'w1', name: 'csv-worker', description: 'w', type: 'flow:worker', status: 'running', parentId: 'm1' },
  ]
  const files = new Map<string, string>()
  const sent: { to: string; text: string }[] = []
  on('agent.list', () => ({ value: roster }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.focus', () => ({}))
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 200_000, tokens: 1000, percent: 1 } } }))
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
    return ok()
  })
  return { agents: roster, files, sent }
}

const ask = ($: Dollar, agentId: string, questions: unknown[]) => $.tool.call({ tool: 'mcp__flow__ask', from: 'x', questions, agentId } as never)
const fyi = ($: Dollar, agentId: string, items: unknown[]) => $.tool.call({ tool: 'mcp__flow__fyi', from: 'x', items, agentId } as never)
const cmd = ($: Dollar, args: string) => $.command.run({ command: 'flow', args } as never).then(r => r.text ?? '')
const stored = (files: Map<string, string>) => (JSON.parse(files.get(`${DIR}/inbox.json`) ?? '{"items":[]}') as { items: { id: string; state: string; answer?: string }[] }).items
const stateOf = (files: Map<string, string>, id: string) => stored(files).find(x => x.id === id)

const Q = { question: 'Which format?', options: ['csv', 'tsv', 'json'], default: 'csv', blocking: true, context: 'the export needs one' }
const SOFT = { question: 'Quote fields?', options: ['yes', 'no'], default: 'yes', blocking: false }
const F = (n: number, topic?: string) => ({ decision: `Decision ${n}`, why: 'conservative', ...(topic === undefined ? {} : { topic }) })

// Protected items, written as the plugin writes them; any inbox write afterwards loads them.
const protectedItems = (files: Map<string, string>) => {
  const base = { owner: 'reviewer-1', addressee: 'main', options: ['yes', 'no'], default: 'no', blocking: false, askedAt: 1_000_000, state: 'open', delivered: false }
  files.set(`${DIR}/inbox.json`, JSON.stringify({ next: 5, items: [
    { ...base, id: 'q1', question: 'Deploy demo?', kind: 'deploy', options: ['deploy', 'skip'], default: 'skip' },
    { ...base, id: 'q2', question: 'Set X', kind: 'env', env: { target: 'demo', name: 'X', role: 'change', pr: 1 } },
    { ...base, id: 'q3', question: 'Push batch?', kind: 'push', options: ['push', 'hold'], default: 'hold' },
    { ...base, id: 'q4', question: 'Add a guard?', options: ['Add it to my personal flow config', 'No'], guard: { glob: 'src/**', test: 't.test.ts' } },
  ] }))
}

type Ui = {
  press(a: { key: string }): Promise<unknown>
  find(a: object): Promise<unknown>
  input(a: object): Promise<unknown>
  unmount(): Promise<void>
}
const mount = ($: Dollar, rows = 40) => $.ui.mount({ plugin: 'flow', surface: 'terminal', ...PANE, viewport: { columns: 100, rows } } as never) as unknown as Promise<Ui>
const open = async (ui: Ui) => { await ui.press({ key: 'nav-inbox' }) }

test('the inbox view opens with i, lists blocking first with the addressee, moves with j/k and answers by digit and letter', async ($, on) => {
  const w = world(on)
  await ask($, 'w1', [SOFT, Q])
  await ask($, 'm1', [{ ...SOFT, question: 'Ship it?' }])
  await fyi($, 'w1', [F(1)])
  const ui = await mount($)
  expect(await ui.find({ text: /Inbox: 3 questions for you \(1 blocking\), 1 decision agents made\. Press i/ })).toBeDefined()
  await open(ui)
  expect(await ui.find({ text: /Inbox/ })).toBeDefined()
  // Blocking first; the worker's question is for its manager.
  expect(await ui.find({ text: /> q2 BLOCKING csv-worker, for csv-export: Which format/ })).toBeDefined()
  expect(await ui.find({ text: /a\) csv \(default\)/ })).toBeDefined()
  expect(await ui.find({ text: /why: the export needs one/ })).toBeDefined()
  await ui.press({ key: 'inbox-next' })
  expect(await ui.find({ text: /> q1 csv-worker, for csv-export: Quote fields/ })).toBeDefined()
  await ui.press({ key: 'inbox-prev' })
  expect(await ui.find({ text: /> q2 BLOCKING/ })).toBeDefined()
  // A letter answers q2 over the manager's head; the highlight moves on.
  await ui.press({ key: 'pick-b' })
  expect(stateOf(w.files, 'q2')?.answer).toBe('tsv')
  expect(await ui.find({ text: /> q1 / })).toBeDefined()
  // A digit answers the next one.
  await ui.press({ key: 'pick-2' })
  expect(stateOf(w.files, 'q1')?.answer).toBe('no')
  expect(w.sent.some(s => s.to === 'w1' && s.text.includes('the user answered q2'))).toBe(true)
  expect(w.sent.some(s => s.to === 'm1' && s.text.includes('the user answered q2, which csv-worker asked you: tsv. It is closed'))).toBe(true)
  await ui.press({ key: 'inbox-back' })
  expect(await ui.find({ text: /super manager/ })).toBeDefined()
  await ui.unmount()
})

test('y takes a default or keeps a decision; n undoes with the typed words', async ($, on) => {
  const w = world(on)
  await ask($, 'm1', [SOFT])
  await fyi($, 'w1', [F(1), F(2)])
  await ask($, 'm1', [{ ...SOFT, question: 'Third?' }])
  const ui = await mount($)
  await open(ui)
  await ui.press({ key: 'inbox-yes' })
  expect(stateOf(w.files, 'q1')?.answer).toBe('yes')
  await ui.press({ key: 'inbox-yes' })
  expect(stateOf(w.files, 'q2')?.answer).toBe('yes')
  // decisions follow the questions, newest first
  await ui.press({ key: 'inbox-yes' })
  expect(stateOf(w.files, 'd2')?.answer).toBe('Keep')
  expect(stateOf(w.files, 'd1')?.state).toBe('open')
  await ui.input({ key: 'inbox-answer', text: 'use 10 s', kind: 'change' })
  await ui.press({ key: 'inbox-no' })
  expect(stateOf(w.files, 'd1')?.answer).toBe('use 10 s')
  expect(w.sent.some(s => s.to === 'w1' && s.text.includes('undid your decision d1') && s.text.includes('use 10 s'))).toBe(true)
  await ui.unmount()
})

test('free text through the Input answers the highlighted question', async ($, on) => {
  const w = world(on)
  await ask($, 'w1', [Q])
  const ui = await mount($)
  await open(ui)
  await ui.press({ key: 'inbox-reply' })
  await ui.input({ key: 'inbox-answer', text: 'ndjson please' })
  expect(stateOf(w.files, 'q1')?.answer).toBe('ndjson please')
  expect(w.sent.some(s => s.to === 'w1' && s.text.includes('ndjson please'))).toBe(true)
  await ui.unmount()
})

test('w keeps every decision and leaves protected items open; a second w keeps nothing', async ($, on) => {
  const w = world(on)
  protectedItems(w.files)
  await fyi($, 'w1', [F(1), F(2)])
  const ui = await mount($)
  await open(ui)
  await ui.press({ key: 'inbox-all' })
  expect(stored(w.files).filter(x => x.state === 'open').map(x => x.id)).toEqual(['q1', 'q2', 'q3', 'q4'])
  expect(await ui.find({ text: /Kept 2 decisions/ })).toBeDefined()
  await ui.press({ key: 'inbox-all' })
  expect(await ui.find({ text: /No open decisions to keep/ })).toBeDefined()
  await ui.unmount()
})

test('y refuses a deploy, env, push and guard item, naming the explicit way; a digit answers it', async ($, on) => {
  const w = world(on)
  protectedItems(w.files)
  await fyi($, 'w1', [F(1)])
  const ui = await mount($)
  await open(ui)
  for (const id of ['q1', 'q2', 'q3', 'q4']) {
    await ui.press({ key: 'inbox-yes' })
    expect(await ui.find({ text: new RegExp(`${id} is .*y never answers it`) })).toBeDefined()
    expect(stateOf(w.files, id)?.state).toBe('open')
    await ui.press({ key: 'inbox-next' })
  }
  for (let i = 0; i < 4; i++) await ui.press({ key: 'inbox-prev' })
  await ui.press({ key: 'pick-2' })
  expect(stateOf(w.files, 'q1')?.answer).toBe('skip')
  await ui.unmount()
})

test('decisions are flat rows, newest first, with nothing folded; y keeps the highlighted one', async ($, on) => {
  const w = world(on)
  const fs = Array.from({ length: 7 }, (_, i) => F(i, 'worker-size'))
  await fyi($, 'm1', [...fs, F(100)])
  const ui = await mount($)
  await open(ui)
  expect(await ui.find({ text: /0 questions, 8 decisions/ })).toBeDefined()
  expect(await ui.find({ text: /> d8 csv-export: Decision 100/ })).toBeDefined()
  expect(await ui.find({ text: /d4 csv-export \[worker-size\]: Decision 3/ })).toBeDefined()
  expect(await ui.find({ key: 'inbox-expand' })).toBeUndefined()
  await ui.press({ key: 'inbox-yes' })
  expect(stored(w.files).filter(x => x.state === 'open').map(x => x.id)).toEqual(['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'])
  await ui.unmount()
})

test('a question answered meanwhile is not answered again by a press', async ($, on) => {
  const w = world(on)
  await ask($, 'm1', [SOFT])
  const ui = await mount($)
  await open(ui)
  await cmd($, 'answer q1 b')
  await ui.press({ key: 'inbox-yes' })
  expect(stateOf(w.files, 'q1')?.answer).toBe('no')
  await ui.unmount()
})

test('main answering a manager-addressed question with mcp__flow__answer is still refused', async ($, on) => {
  const w = world(on)
  await ask($, 'w1', [Q])
  const r = await $.tool.call({ tool: 'mcp__flow__answer', answers: [{ id: 'q1', choice: 'a' }] } as never)
  expect(String(r.result)).toContain('addressed to csv-export')
  expect(stateOf(w.files, 'q1')?.state).toBe('open')
})

test('with no agents but an open question the key row shows the inbox key only', async ($, on) => {
  const w = world(on, [])
  w.files.set(`${DIR}/inbox.json`, JSON.stringify({ next: 2, items: [{
    id: 'q1', owner: 'x', addressee: 'main', question: 'Ok?', options: ['yes', 'no'], default: 'yes', blocking: false, askedAt: 1_000_000, state: 'open', delivered: false,
  }] }))
  await ask($, 'w1', [SOFT]).catch(() => undefined)
  const ui = await mount($, 30)
  expect(await ui.find({ key: 'nav-inbox' })).toBeDefined()
  expect(await ui.find({ key: 'nav-next' })).toBeUndefined()
  await ui.unmount()
})

test('a highlight answered meanwhile answers nothing: the highlight moves and the note says so', async ($, on) => {
  const w = world(on)
  await ask($, 'm1', [SOFT, { ...SOFT, question: 'Other?' }])
  const ui = await mount($)
  await open(ui)
  await ui.press({ key: 'inbox-next' })
  await cmd($, 'answer q2 b')
  await ui.press({ key: 'inbox-yes' })
  expect(stateOf(w.files, 'q1')?.state).toBe('open')
  expect(await ui.find({ text: /q2 was answered meanwhile \(by main\); the highlight moved, press again/ })).toBeDefined()
  await ui.press({ key: 'inbox-yes' })
  expect(stateOf(w.files, 'q1')?.answer).toBe('yes')
  await ui.unmount()
})
