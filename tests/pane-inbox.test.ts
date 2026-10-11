import type { AgentInfo } from 'claude-code'
import { expect, mock } from 'claude-code/testing'
import { test } from './support'
import { askBright } from '../hooks/pane'
import type { TestBody } from 'claude-code/testing'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

// Every glyph on the pane is one column, so a line's width is its length in characters.
const cols = (s: string): number => [...s].length

const DIR = '/r/.git/flow'
const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const PANE = { component: 'Pane', props: { title: 'Flow' } as never, requestId: 'flow' } as const

// A manager "csv-export" (m1) with one worker (w1).
function world(on: On, agents?: AgentInfo[]) {
  const clock = mock.clock(on, { now: 1_000_000 })
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
  return { agents: roster, files, sent, clock }
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
  drawn(): Promise<unknown>
  input(a: object): Promise<unknown>
  unmount(): Promise<void>
}
const mount = ($: Dollar, rows = 40, columns = 100) => $.ui.mount({ plugin: 'flow', surface: 'terminal', ...PANE, viewport: { columns, rows } } as never) as unknown as Promise<Ui>
const open = async (ui: Ui) => { await ui.press({ key: 'nav-inbox' }) }
// Whole drawn lines, for text that is made of several styled pieces.
const has = async (ui: Ui, re: RegExp) => linesOf((await ui.drawn()) as El).some(l => re.test(l))

test('the inbox view opens with i, lists blocking first with the addressee, moves with j/k and answers by digit and letter', async ($, on) => {
  const w = world(on)
  await ask($, 'w1', [SOFT, Q])
  await ask($, 'm1', [{ ...SOFT, question: 'Ship it?' }])
  await fyi($, 'w1', [F(1)])
  const ui = await mount($)
  expect(await ui.find({ text: /▤ \? 3 questions \(1 blocking\) · 1 decision · i/ })).toBeDefined()
  await open(ui)
  expect(await ui.find({ text: /Inbox/ })).toBeDefined()
  // Blocking first; the worker's question is for its manager.
  expect(await has(ui, /> q2 BLOCKING Which format\?, for csv-export/)).toBe(true)
  expect(await ui.find({ text: /a\) csv \(default\)/ })).toBeDefined()
  expect(await ui.find({ text: /why: the export needs one/ })).toBeDefined()
  await ui.press({ key: 'inbox-next' })
  expect(await has(ui, /> q1 Quote fields\?, for csv-export/)).toBe(true)
  await ui.press({ key: 'inbox-prev' })
  expect(await has(ui, /> q2 BLOCKING/)).toBe(true)
  // A letter answers q2 over the manager's head; the highlight moves on.
  await ui.press({ key: 'pick-b' })
  expect(stateOf(w.files, 'q2')?.answer).toBe('tsv')
  expect(await has(ui, /> q1 /)).toBe(true)
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

test('routine decisions fold into one group row that y keeps whole; pressing the row lists them', async ($, on) => {
  const w = world(on)
  const fs = Array.from({ length: 7 }, (_, i) => F(i, 'worker-size'))
  await fyi($, 'm1', [...fs, F(100)])
  const ui = await mount($)
  await open(ui)
  expect(await ui.find({ text: /> +d8 Decision 100/ })).toBeDefined()
  expect(await ui.find({ text: /▸ routine · 7 \(worker-size\)/ })).toBeDefined()
  expect(await ui.find({ text: /d4 Decision 3/ })).toBeUndefined()
  // y keeps the important one only; the highlight then sits on the group, and y keeps all of it
  await ui.press({ key: 'inbox-yes' })
  expect(stored(w.files).filter(x => x.state === 'open').length).toBe(7)
  // pressing the card opens it and moves to its first item; c folds it again and parks on the card
  await ui.press({ key: 'row-fold' })
  expect(await ui.find({ text: /d4 Decision 3/ })).toBeDefined()
  expect(await ui.find({ text: /> +d7 Decision 6/ })).toBeDefined()
  await ui.press({ key: 'inbox-fold' })
  expect(await ui.find({ text: /d4 Decision 3/ })).toBeUndefined()
  await ui.press({ key: 'inbox-yes' })
  expect(stored(w.files).filter(x => x.state === 'open').length).toBe(0)
  await ui.unmount()
})

test('w keeps folded decisions too, and a finished owner folds its decisions', async ($, on) => {
  const w = world(on)
  await fyi($, 'w1', [F(1, 'worker-size'), F(2)])
  w.agents[1]!.status = 'completed'
  const ui = await mount($)
  await open(ui)
  expect(await ui.find({ text: /▸ routine · 2 \(worker-size, finished agents\)/ })).toBeDefined()
  await ui.press({ key: 'inbox-all' })
  expect(stored(w.files).filter(x => x.state === 'open').length).toBe(0)
  await ui.unmount()
})

test('pressing a row opens its large card: tags, who, agent status, every option a button; an option answers and the next card opens', async ($, on) => {
  const w = world(on)
  await ask($, 'w1', [Q, SOFT])
  const ui = await mount($)
  await open(ui)
  await ui.press({ key: 'row-q1' })
  expect(await ui.find({ text: /q1 · csv-worker · / })).toBeDefined()
  expect(await ui.find({ text: /^question/ })).toBeDefined()
  expect(await ui.find({ text: /BLOCKING/ })).toBeDefined()
  expect(await ui.find({ text: /from csv-worker, for csv-export/ })).toBeDefined()
  expect(await ui.find({ text: /csv-worker is running/ })).toBeDefined()
  expect(await ui.find({ text: /answering it overrides csv-export/ })).toBeDefined()
  expect(await ui.find({ text: /why: the export needs one/ })).toBeDefined()
  expect(await ui.find({ text: /1\) csv \(default\)/ })).toBeDefined()
  await ui.press({ key: 'card-opt-1' })
  expect(stateOf(w.files, 'q1')?.answer).toBe('tsv')
  // the next open item's card
  expect(await ui.find({ text: /q2 · csv-worker · / })).toBeDefined()
  await ui.input({ key: 'card-answer', text: 'maybe', kind: 'change' })
  await ui.press({ key: 'card-yes' })
  expect(stateOf(w.files, 'q2')?.answer).toBe('yes')
  // none left: back to the list
  expect(await ui.find({ text: /Nothing open/ })).toBeDefined()
  await ui.unmount()
})

// The Box that holds the answer Input, found in the drawn tree. A flexGrow child in that Box would push the answer row to the pane bottom.
const answerBox = (e: El): { children?: El[]; props?: { flexGrow?: number } } | undefined => {
  if (typeof e === 'string' || !e) return undefined
  const kids = e.children ?? []
  if (kids.some(c => typeof c === 'object' && c && c.props?.label === 'answer ')) return e as never
  for (const c of kids) { const hit = answerBox(c); if (hit) return hit }
  return undefined
}
const growing = (box: { children?: El[] } | undefined) => (box?.children ?? []).some(c => typeof c === 'object' && c && c.props?.flexGrow === 1)

test('the answer row sits right under the content of the inbox and of a question card, not at the pane bottom', async ($, on) => {
  world(on)
  await ask($, 'w1', [Q])
  const ui = await mount($, 40, 100)
  await open(ui)
  expect(answerBox((await ui.drawn()) as El)).toBeDefined()
  expect(growing(answerBox((await ui.drawn()) as El))).toBe(false)
  await ui.press({ key: 'row-q1' })
  expect(answerBox((await ui.drawn()) as El)).toBeDefined()
  expect(growing(answerBox((await ui.drawn()) as El))).toBe(false)
  expect(await has(ui, /y default/)).toBe(true)
  await ui.unmount()
})

test('a card answers free text through its Input; a decision card undoes with the typed words', async ($, on) => {
  const w = world(on)
  await ask($, 'm1', [SOFT])
  await fyi($, 'w1', [F(1)])
  const ui = await mount($)
  await open(ui)
  await ui.press({ key: 'row-d1' })
  await ui.input({ key: 'card-answer', text: 'use 10 s' })
  expect(stateOf(w.files, 'd1')?.answer).toBe('use 10 s')
  expect(w.sent.some(s => s.to === 'w1' && s.text.includes('undid your decision d1'))).toBe(true)
  await ui.unmount()
})

test('a card for an item answered meanwhile shows the answer and answers nothing again', async ($, on) => {
  const w = world(on)
  await ask($, 'm1', [SOFT])
  const ui = await mount($)
  await open(ui)
  await ui.press({ key: 'row-q1' })
  await cmd($, 'answer q1 b')
  // drawn again, the card is read-only: the answer, no buttons
  expect(await ui.find({ text: /Answered: no \(by main/ })).toBeDefined()
  expect(await ui.find({ key: 'card-opt-0' })).toBeUndefined()
  expect(stateOf(w.files, 'q1')?.answer).toBe('no')
  await ui.unmount()
})

test('a protected card: y never answers it, an option press does', async ($, on) => {
  const w = world(on)
  protectedItems(w.files)
  await fyi($, 'w1', [F(1)])
  const ui = await mount($)
  await open(ui)
  await ui.press({ key: 'row-q1' })
  await ui.press({ key: 'card-yes' })
  expect(stateOf(w.files, 'q1')?.state).toBe('open')
  expect(await ui.find({ text: /q1 is a deploy approval: y never answers it/ })).toBeDefined()
  await ui.press({ key: 'card-opt-1' })
  expect(stateOf(w.files, 'q1')?.answer).toBe('skip')
  await ui.unmount()
})

test('the tree lines are buttons that open the card; Back returns to the tree; decisions fold into the Inbox line', async ($, on) => {
  const w = world(on)
  await ask($, 'w1', [Q])
  await fyi($, 'm1', [F(1), F(2, 'worker-size')])
  const ui = await mount($)
  // Decisions get no tree rows; they fold into the one Inbox line.
  expect(await ui.find({ text: /d1 decision/ })).toBeUndefined()
  expect(await ui.find({ text: /▤ \? 1 question \(1 blocking\) · 2 decisions · i/ })).toBeDefined()
  await ui.press({ key: 'open-q1' })
  expect(await ui.find({ text: /q1 · csv-worker · / })).toBeDefined()
  expect(await ui.find({ text: /^question/ })).toBeDefined()
  await ui.press({ key: 'card-back' })
  expect(await ui.find({ text: /super manager/ })).toBeDefined()
  expect(stateOf(w.files, 'q1')?.state).toBe('open')
  await ui.unmount()
})

test('a tree with only decisions shows just the Inbox line, singular and plural', async ($, on) => {
  world(on)
  await fyi($, 'm1', [F(1)])
  const ui = await mount($)
  expect(await has(ui, /▤ 1 decision · i/)).toBe(true)
  expect(await ui.find({ text: /question/ })).toBeUndefined()
  expect(await ui.find({ text: /d1 decision/ })).toBeUndefined()
  await ui.unmount()
})

test('the decision preview shows text, why and instead could, with no option lines; a card shows Keep and Undo only', async ($, on) => {
  const w = world(on)
  await fyi($, 'w1', [{ decision: 'Use 5 s timeout', why: 'slow CI', alternative: 'poll instead' }])
  const ui = await mount($)
  await open(ui)
  expect(await ui.find({ text: /Use 5 s timeout/ })).toBeDefined()
  expect(await ui.find({ text: /why: slow CI/ })).toBeDefined()
  expect(await ui.find({ text: /instead could: poll instead/ })).toBeDefined()
  expect(await ui.find({ text: /a\) / })).toBeUndefined()
  await ui.press({ key: 'row-d1' })
  expect(await ui.find({ text: /d1 · csv-worker · \d+ \w+/ })).toBeDefined()
  expect(await ui.find({ text: /^decision$/ })).toBeDefined()
  expect(await ui.find({ text: /y Keep/ })).toBeDefined()
  expect(await ui.find({ text: /n Undo/ })).toBeDefined()
  expect(await ui.find({ key: 'card-opt-0' })).toBeUndefined()
  expect(await ui.find({ key: 'card-pick-a' })).toBeUndefined()
  await ui.press({ key: 'card-yes' })
  expect(stateOf(w.files, 'd1')?.state).toBe('answered')
  await ui.unmount()
})

test('answered decisions read Kept or Undone in the archive; old decisions without alternative render', async ($, on) => {
  world(on)
  await fyi($, 'w1', [F(1), F(2)])
  await cmd($, 'ok d1')
  await cmd($, 'no d2 use polling')
  const out = await cmd($, 'inbox archive')
  expect(out).toMatch(/d1 Kept/)
  expect(out).toMatch(/d2 Undone: use polling/)
})

test('the archive lists answered items; an archived card is read-only', async ($, on) => {
  const w = world(on)
  await ask($, 'm1', [SOFT])
  await cmd($, 'answer q1 b')
  const ui = await mount($)
  await open(ui)
  await ui.press({ key: 'inbox-archive' })
  expect(await ui.find({ text: /q1 no \(by main, 0 min ago\): Quote fields/ })).toBeDefined()
  await ui.press({ key: 'arch-q1' })
  expect(await ui.find({ text: /Answered: no \(by main/ })).toBeDefined()
  expect(await ui.find({ key: 'card-opt-0' })).toBeUndefined()
  await ui.press({ key: 'card-back' })
  expect(await ui.find({ text: /Archive/ })).toBeDefined()
  await ui.unmount()
  expect(w.files.size).toBeGreaterThan(0)
})

test('/flow inbox archive lists answered items; archive all lifts the cap', async ($, on) => {
  world(on)
  await ask($, 'm1', [SOFT])
  expect(await cmd($, 'inbox archive')).toContain('empty')
  await cmd($, 'answer q1 b')
  expect(await cmd($, 'inbox archive')).toMatch(/Archive: 1 answered item[\s\S]*q1 no \(by main/)
  expect(await cmd($, 'inbox archive all')).toContain('q1 no')
  expect(await cmd($, 'inbox')).toContain('/flow inbox archive')
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

// What the pane draws, as lines of text: a column stacks its children, a row sets them side by side with its gap
// (a child of several lines beside the next one), a border adds its two columns and rows.
type El = string | { type?: string; props?: { flexDirection?: string; flexGrow?: number; gap?: number; label?: string; borderStyle?: string; paddingX?: number; width?: number; wrap?: string }; children?: El[] } | null | undefined | false
const plain = (e: El): string => (typeof e === 'string' ? e : e ? (e.children === undefined && e.props?.label !== undefined ? e.props.label : (e.children ?? []).map(plain).join('')) : '')
const padCols = (l: string, w: number) => l + ' '.repeat(Math.max(0, w - cols(l)))
const linesOf = (e: El): string[] => {
  if (typeof e === 'string') return [e]
  if (!e) return []
  const kids = (e.children ?? []).filter(Boolean)
  // A truncating Text is cut at the pane's 60 columns, as the terminal does.
  if (e.type === 'Text') return plain(e).split('\n').map(l => (e.props?.wrap === 'truncate-end' && cols(l) > 60 ? [...l].slice(0, 59).join('') + '…' : l))
  // A Button with a plain string child carries it as its label.
  if (e.children === undefined && e.props?.label !== undefined) return [e.props.label]
  let lines: string[]
  if (e.props?.flexDirection === 'row') {
    const cols_ = kids.map(linesOf).filter(c => c.length > 0)
    const widths = cols_.map(c => Math.max(...c.map(cols)))
    lines = Array.from({ length: Math.max(0, ...cols_.map(c => c.length)) }, (_, i) => cols_.map((c, k) => padCols(c[i] ?? '', widths[k]!)).join(' '.repeat(e.props!.gap ?? 0)).trimEnd())
  } else lines = kids.flatMap(linesOf)
  if (e.props?.borderStyle === undefined) return lines
  const pad = ' '.repeat(e.props.paddingX ?? 0)
  // A set width is the whole box, border included: the box does not shrink to its content.
  const w = Math.max(e.props.width === undefined ? 0 : e.props.width - 2, Math.max(0, ...lines.map(cols)) + 2 * pad.length)
  return [`╭${'─'.repeat(w)}╮`, ...lines.map(l => `│${pad}${padCols(l, w - 2 * pad.length)}${pad}│`), `╰${'─'.repeat(w)}╯`]
}

// The 60-column inbox: three managers with decisions and a question, and five routine sizing calls.
async function cardsWorld($: Dollar, on: On) {
  const agents: AgentInfo[] = [
    { id: 'm1', name: 'ctx-init-tip', description: 'm', type: 'flow:manager', status: 'running' },
    { id: 'm2', name: 'plain-capability-use', description: 'm', type: 'flow:manager', status: 'running' },
    { id: 'm3', name: 'quiet-update-notice', description: 'm', type: 'flow:manager', status: 'running' },
  ]
  world(on, agents)
  await fyi($, 'm1', [
    { decision: 'Show the context-trim tip once per session, not on every init, because repeating it trains people to ignore it', why: 'noisy otherwise', topic: 'tip-frequency' },
    { decision: 'Word the tip as a question', why: 'softer', topic: 'tip-wording' },
  ])
  await fyi($, 'm2', [
    { decision: 'Call it a capability in the docs, not a permission, since that is what users search for', why: 'search terms', topic: 'docs-wording' },
    { decision: 'Name the capability in plain words in the docs and in every error message the plugin prints', why: 'readers', topic: 'plain-names' },
    { decision: 'Keep the old flag name as an alias for one release', why: 'no breakage', topic: 'flag-alias' },
  ])
  await fyi($, 'm3', [{ decision: 'Say "update available" once, quietly', why: 'less nagging', topic: 'update-notice' }])
  await fyi($, 'm1', Array.from({ length: 3 }, (_, i) => F(10 + i, 'manager-size')))
  await fyi($, 'm2', Array.from({ length: 2 }, (_, i) => F(20 + i, 'worker-size')))
  await ask($, 'm1', [{ question: 'Should the tip also show in the status line?', options: ['yes', 'no'], default: 'no', blocking: false }])
}

const rendered = async (ui: Ui) => linesOf((await ui.drawn()) as El)
const shape = (lines: string[], rows: number) => {
  expect(lines.length).toBeLessThanOrEqual(rows)
  for (const l of lines) expect(cols(l)).toBeLessThanOrEqual(60)
  expect(lines.some(l => /j next/.test(l) && /k prev/.test(l))).toBe(true)
  expect(lines.some(l => /y (keep|default)/.test(l) && /n undo/.test(l) && /i back/.test(l))).toBe(true)
}

test('at 60 columns by 30 rows each owner is a card: a chevron, a round border, one clipped line per item; the routine card is collapsed', async ($, on) => {
  await cardsWorld($, on)
  const ui = await mount($, 30, 60)
  await open(ui)
  const lines = await rendered(ui)
  shape(lines, 30)
  // every open card is the pane's full width, the short one included
  const tops = lines.filter(l => /▾ ╭/.test(l))
  expect(tops).toHaveLength(3)
  for (const l of tops) expect(cols(l)).toBe(60)
  // a question row: the id, BLOCKING when it blocks, the text; no owner prefix
  expect(lines.some(l => /ctx-init-tip: /.test(l) && /q1/.test(l))).toBe(false)
  expect(lines.some(l => /^ +│ +> q1 Should the tip also show in the status line\? +│$/.test(l))).toBe(true)
  expect(lines.some(l => /▾ ╭/.test(l))).toBe(true)
  expect(lines.some(l => /│ ctx-init-tip · 2 decisions · asks +│/.test(l))).toBe(true)
  expect(lines.some(l => /> q1 Should the tip/.test(l))).toBe(true)
  expect(lines.some((l, i) => /▾ ╭/.test(l) && /quiet-update-notice/.test(lines[i + 1]!))).toBe(true)
  expect(lines.some(l => /^▸ routine · 5 \((manager-size, worker-size|worker-size, manager-size)\)$/.test(l))).toBe(true)
  expect(lines.some(l => /c collapse/.test(l))).toBe(true)
  // the card closes with c, then the highlight sits on its one line
  await ui.press({ key: 'inbox-fold' })
  expect(await ui.find({ text: /^ctx-init-tip$/ })).toBeDefined()
  await ui.unmount()
})

test('at 60 columns by 30 rows a card collapsed by its chevron is one line without a border, and j/k step over it', async ($, on) => {
  await cardsWorld($, on)
  const ui = await mount($, 30, 60)
  await open(ui)
  await ui.press({ key: 'fold-grp:plain-capability-use' })
  const lines = await rendered(ui)
  shape(lines, 30)
  expect(lines.some(l => /^▸ plain-capability-use · 3 decisions$/.test(l))).toBe(true)
  expect(lines.some(l => /Name the capability/.test(l))).toBe(false)
  // the cursor went to the card's line; k steps to the card above, j twice over it to the routine card
  await ui.press({ key: 'inbox-prev' })
  expect(await ui.find({ text: /> +d6 Say "update available"/ })).toBeDefined()
  await ui.press({ key: 'inbox-next' })
  await ui.press({ key: 'inbox-next' })
  expect(await ui.find({ text: /routine · 5/ })).toBeDefined()
  await ui.unmount()
})

test('at 60 columns by 20 rows the cards that do not fit are drawn collapsed but the hot one, and the keys stay', async ($, on) => {
  await cardsWorld($, on)
  const ui = await mount($, 20, 60)
  await open(ui)
  const lines = await rendered(ui)
  shape(lines, 20)
  expect(lines.some(l => /^▸ plain-capability-use · 3 decisions$/.test(l))).toBe(true)
  expect(lines.some(l => /^▸ quiet-update-notice · 1 decision$/.test(l))).toBe(true)
  expect(lines.some(l => /> q1 /.test(l))).toBe(true)
  // moving down opens the next card as the hot one and folds the first
  for (let i = 0; i < 3; i++) await ui.press({ key: 'inbox-next' })
  expect(await ui.find({ text: /^▸ ctx-init-tip · 2 decisions · asks$/ })).toBeDefined()
  expect(await ui.find({ text: /> +d6 / })).toBeDefined()
  await ui.unmount()
})

test('with only a folded group the hot row shows its hint in the nav row; the keys row is drawn on a short pane', async ($, on) => {
  world(on)
  await fyi($, 'm1', Array.from({ length: 3 }, (_, i) => F(i, 'worker-size')))
  const ui = await mount($, 20, 60)
  await open(ui)
  const lines = linesOf((await ui.drawn()) as El)
  expect(lines.length).toBeLessThanOrEqual(20)
  expect(lines.some(l => /j next/.test(l) && /c expand · y keeps all 3/.test(l))).toBe(true)
  expect(lines.some(l => /y keep/.test(l) && /i back/.test(l))).toBe(true)
  await ui.unmount()
})

// The tree's top lines at 60 columns, as drawn until the main card.
const topOf = (lines: string[]) => lines.slice(0, lines.findIndex(l => /^╭/.test(l)))

test('the tree\'s top lines carry icons, fit 60 columns counting characters, and the footer stays', async ($, on) => {
  await cardsWorld($, on)
  const ui = await mount($, 30, 60)
  const lines = await rendered(ui)
  const top = topOf(lines)
  expect(top[0]).toMatch(/^≡ 3 agents · 3 live/)
  expect(top.some(l => /^▤ \? 1 question · 11 decisions · i$/.test(l))).toBe(true)
  for (const l of lines) expect(cols(l)).toBeLessThanOrEqual(60)
  expect(lines.some(l => /i inbox/.test(l))).toBe(true)
  expect(cols('▤ ?')).toBe(3)
  await ui.unmount()
})

test('the inbox icon is warning-coloured text with something open', async ($, on) => {
  world(on)
  const ui = await mount($, 30, 60)
  await ui.unmount()
  await fyi($, 'm1', [F(1)])
  const only = await mount($, 30, 60)
  await open(only)
  const lines = await rendered(only)
  expect(lines[0]).toMatch(/^▤ Inbox 0 questions, 1 decision$/)
  expect(lines[0]).not.toMatch(/\?/)
  await only.unmount()
})

test('an empty inbox shows the dim inbox glyph and no question mark', async ($, on) => {
  world(on)
  await fyi($, 'm1', [F(1)])
  await cmd($, 'ok')
  const ui = await mount($, 30, 60)
  await open(ui)
  const lines = await rendered(ui)
  expect(lines[0]).toMatch(/^▤ Inbox Nothing open\.$/)
  await ui.unmount()
})

test('the question mark pulses from the clock: two phases differ, and a waiting question is the only reason for it', async ($, on) => {
  expect(askBright(1_000_000)).toBe(true)
  expect(askBright(1_001_000)).toBe(false)
  // the same second is the same frame, so a redraw does not restart it
  expect(askBright(1_000_000)).toBe(askBright(1_000_999))
  const w = world(on)
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'w1' }))
  await $.agent.spawn({ prompt: 'b', description: 'x', subagentType: 'flow:worker' } as never)
  await ask($, 'm1', [SOFT])
  await w.clock.settle()
  const ui = await mount($, 30, 60)
  const mark = async () => JSON.stringify(await ui.find({ text: /^\?$/ }))
  const a = await mark()
  expect(a).toContain('warning')
  await w.clock.advance(1000)
  await $.tool.call({ tool: 'mcp__flow__status' } as never)
  const b = await mark()
  expect(b).not.toEqual(a)
  await w.clock.advance(1000)
  await $.tool.call({ tool: 'mcp__flow__status' } as never)
  expect(await mark()).toEqual(a)
  await ui.unmount()
})

test('with no question waiting (decisions only) there is no question mark and the line does not change', async ($, on) => {
  const w = world(on)
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'w1' }))
  await $.agent.spawn({ prompt: 'b', description: 'x', subagentType: 'flow:worker' } as never)
  await fyi($, 'm1', [F(1)])
  await w.clock.settle()
  const ui = await mount($, 30, 60)
  expect(await ui.find({ text: /^\?$/ })).toBeUndefined()
  const line = async () => (await rendered(ui)).filter(l => /decision/.test(l))
  const a = await line()
  await w.clock.advance(1000)
  await $.tool.call({ tool: 'mcp__flow__status' } as never)
  expect(a).toEqual(['▤ 1 decision · i'])
  expect(await line()).toEqual(a)
  await ui.unmount()
})

// The render helper stacked a Box that names no direction, which put the chevron above the agent. Ink
// defaults to a row, so on screen it was a helper artifact; naming the row keeps both in agreement.
test('a collapsed agent\'s chevron and its title share one line', async ($, on) => {
  await cardsWorld($, on)
  const ui = await mount($, 30, 60)
  const lines = await rendered(ui)
  expect(lines.some(l => /^▸ ● ctx-init-tip  manager$/.test(l))).toBe(true)
  expect(lines.some(l => /^▸ *$/.test(l))).toBe(false)
  await ui.unmount()
})
