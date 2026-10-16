import type { AgentInfo } from 'claude-code'
import { expect, mock } from 'claude-code/testing'
import { inboxTest as test } from './support'
import { askBright } from '../hooks/pane'
import { strWidth } from '../hooks/markdown'
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
// Expands an item's card, then opens its full-screen card (o).
const openCard = async (ui: Ui, id: string) => { await ui.press({ key: `item-${id}` }); await ui.press({ key: 'inbox-open' }) }
// Whole drawn lines, for text that is made of several styled pieces.
const has = async (ui: Ui, re: RegExp) => linesOf((await ui.drawn()) as El).some(l => re.test(l))

test('the inbox view opens with i, lists blocking first with the addressee, moves with j/k and answers by digit and letter', async ($, on) => {
  const w = world(on)
  await ask($, 'w1', [SOFT, Q])
  await ask($, 'm1', [{ ...SOFT, question: 'Ship it?' }])
  await fyi($, 'w1', [F(1)])
  const ui = await mount($)
  expect(await ui.find({ text: /▤ \? 3 questions \(1 blocking\) · 1 decision/ })).toBeDefined()
  await open(ui)
  expect(await ui.find({ text: /Inbox/ })).toBeDefined()
  // Blocking first; the worker's question is for its manager.
  expect(await has(ui, /▸ q2 BLOCKING Which format\?/)).toBe(true)
  expect(await has(ui, /▸ q1 Quote fields\?/)).toBe(true)
  // Collapsed by default: no options or why until the item is opened.
  expect(await ui.find({ text: /why: the export needs one/ })).toBeUndefined()
  await ui.press({ key: 'item-q2' })
  expect(await has(ui, /1\/a csv \(default\)/)).toBe(true)
  expect(await ui.find({ text: /why: the export needs one/ })).toBeDefined()
  await ui.press({ key: 'inbox-next' })
  await ui.press({ key: 'inbox-prev' })
  // A letter answers q2 over the manager's head; the highlight moves on to q1, which stays collapsed.
  await ui.press({ key: 'pick-b' })
  expect(stateOf(w.files, 'q2')?.answer).toBe('tsv')
  expect(await has(ui, /▸ q1 /)).toBe(true)
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
  expect(await has(ui, /▸ d8 Decision 100/)).toBe(true)
  expect(await ui.find({ text: /▸ routine · 7 \(worker-size\)/ })).toBeDefined()
  expect(await ui.find({ text: /d4 Decision 3/ })).toBeUndefined()
  // y keeps the important one only; the highlight then sits on the group, and y keeps all of it
  await ui.press({ key: 'inbox-yes' })
  expect(stored(w.files).filter(x => x.state === 'open').length).toBe(7)
  // pressing the card opens it and moves to its first item; c folds it again and parks on the card
  await ui.press({ key: 'row-fold' })
  expect(await has(ui, /▸ d4 Decision 3/)).toBe(true)
  // its decisions are collapsed item cards
  expect(await ui.find({ text: /why: conservative/ })).toBeUndefined()
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
  await openCard(ui, 'q1')
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

// The pane's footer is a sticky bottom block: the root column holds a clipped content box (overflow hidden) and a
// footer box that never shrinks. The terminal gives the footer its rows and cuts the content to what is left; this
// does the same on the drawn tree, so a test sees the lines that are on screen.
type Node = Exclude<El, string | null | undefined | false>
const boxesOf = (root: El): Node[] => (typeof root === 'object' && root ? root.children ?? [] : []).filter((c): c is Node => typeof c === 'object' && !!c)
const visible = (root: El, rows: number): { lines: string[]; footer: string[]; content: string[] } => {
  const kids = boxesOf(root)
  const content = kids.filter(c => c.props?.overflow === 'hidden').flatMap(linesOf)
  const footer = kids.filter(c => c.props?.flexShrink === 0).flatMap(linesOf)
  return { lines: [...content.slice(0, Math.max(0, rows - footer.length)), ...footer], footer, content }
}
const longText = 'word '.repeat(30)
// A large card as the terminal shows it: the header box (first) gives up rows when the pane is short, the body box
// keeps its set height, the options and the footer their lines.
const cardScreen = (root: El, rows: number): string[] => {
  const [head, ...rest] = boxesOf(root)
  const tail = rest.flatMap(b => (b.props?.height === undefined ? linesOf(b) : linesOf(b).slice(0, b.props.height)))
  return [...linesOf(head).slice(0, Math.max(0, rows - tail.length)), ...tail]
}
// The body rows of the large card now drawn (the box with a set height), its position line left out.
const cardBody = async (ui: Ui) => {
  const box = boxesOf((await ui.drawn()) as El).find(b => b.props?.height !== undefined)!
  return linesOf(box).filter(l => !/lines \d+-\d+ of \d+/.test(l))
}
const position = async (ui: Ui) => linesOf((await ui.drawn()) as El).find(l => /lines \d+-\d+ of \d+/.test(l))
// A wheel move or a page key over the pane, as the engine raises ui.scroll for it.
const wheel = ($: Dollar, by: number, bodyRows = 24) => ($.ui as unknown as { scroll: (e: object) => Promise<unknown> }).scroll({ component: 'Pane', requestId: 'flow', offset: 0, by, bodyRows, contentRows: bodyRows, origin: { kind: 'person' } })

test('the inbox and a question card pin the answer input and hotkeys to the pane bottom, whatever the content length', async ($, on) => {
  world(on)
  await ask($, 'w1', [{ ...Q, question: 'Line one?\n' + Array.from({ length: 30 }, (_, i) => `detail ${i}`).join('\n'), context: Array.from({ length: 20 }, (_, i) => `ctx ${i}`).join('\n') }, ...Array.from({ length: 12 }, (_, i) => ({ ...SOFT, question: `Soft ${i}?` }))])
  const ui = await mount($, 12, 100)
  await open(ui)
  let v = visible((await ui.drawn()) as El, 12)
  expect(v.footer.some(l => /answer /.test(l)) && v.footer.some(l => /y default/.test(l)) && v.footer.some(l => /r reply/.test(l))).toBe(true)
  expect(v.lines.length).toBeLessThanOrEqual(12)
  expect(v.lines.slice(-v.footer.length)).toEqual(v.footer)
  await openCard(ui, 'q1')
  // The card's body scrolls in what the header and the footer leave: the footer is whole and the body says where it is.
  const lines = cardScreen((await ui.drawn()) as El, 12)
  expect(lines.length).toBeLessThanOrEqual(12)
  expect(lines.some(l => /answer /.test(l)) && lines.some(l => /y default/.test(l)) && lines.some(l => /r reply/.test(l))).toBe(true)
  expect(lines.some(l => /^lines 1-\d+ of 5\d · ↓ \d+ below$/.test(l))).toBe(true)
  await ui.unmount()
})

test('a short card keeps its footer in a box at the bottom, not right after the content', async ($, on) => {
  world(on)
  await ask($, 'w1', [Q])
  const ui = await mount($, 40, 100)
  await ui.press({ key: 'nav-inbox' })
  await openCard(ui, 'q1')
  const root = (await ui.drawn()) as { props?: { height?: number } }
  expect(root.props?.height).toBe(40)
  const boxes = boxesOf(root as El)
  // The header clips when the pane is short; the body, the options and the footer never shrink, the footer last.
  expect(boxes[0]!.props).toMatchObject({ flexShrink: 1, overflow: 'hidden' })
  expect(boxes[1]!.props).toMatchObject({ flexShrink: 0, overflow: 'hidden' })
  expect(boxes[boxes.length - 1]!.props).toMatchObject({ flexShrink: 0 })
  expect(plain(boxes[boxes.length - 1]!)).toMatch(/y default/)
  // A body that fits neither scrolls nor says where it is.
  expect(await ui.find({ type: 'Button', key: 'card-down' })).toBeUndefined()
  expect(await has(ui, /lines \d+-\d+ of/)).toBe(false)
  await ui.unmount()
})

test('many inbox rows in a short pane still show the footer within the pane height', async ($, on) => {
  world(on)
  await ask($, 'w1', Array.from({ length: 25 }, (_, i) => ({ ...SOFT, question: `Soft ${i} ${longText}` })))
  const ui = await mount($, 12, 100)
  await open(ui)
  const v = visible((await ui.drawn()) as El, 12)
  expect(v.footer.some(l => /y default/.test(l))).toBe(true)
  expect(v.lines.length).toBeLessThanOrEqual(12)
  await ui.unmount()
})

test('a card answers free text through its Input; a decision card undoes with the typed words', async ($, on) => {
  const w = world(on)
  await ask($, 'm1', [SOFT])
  await fyi($, 'w1', [F(1)])
  const ui = await mount($)
  await open(ui)
  await openCard(ui, 'd1')
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
  await openCard(ui, 'q1')
  await cmd($, 'answer q1 b')
  // drawn again, the card is read-only: the answer, no buttons
  expect(await ui.find({ text: /Answered: no \(by the user/ })).toBeDefined()
  expect(await ui.find({ key: 'card-opt-0' })).toBeUndefined()
  expect(stateOf(w.files, 'q1')?.answer).toBe('no')
  await ui.unmount()
})

test('an answered env card takes another option (the gate follows the latest answer); one closed by flow stays read-only', async ($, on) => {
  const w = world(on)
  const base = { owner: 'env', addressee: 'main', options: ['yes', 'no'], default: 'no', blocking: true, askedAt: 1_000_000, kind: 'env', delivered: true, state: 'answered', answeredBy: 'main', answeredAt: 1_000_000 }
  w.files.set(`${DIR}/inbox.json`, JSON.stringify({ next: 3, items: [
    { ...base, id: 'q1', question: 'Set X=1 on demo?', answer: 'no', env: { target: 'demo', name: 'X', role: 'change', pr: 1 } },
    { ...base, id: 'q2', question: 'Set Y=1 on demo?', answer: 'dropped: the PR was returned', answeredBy: 'flow', env: { target: 'demo', name: 'Y', role: 'change', pr: 1 } },
  ] }))
  await fyi($, 'w1', [F(1)])
  const ui = await mount($)
  await open(ui)
  await ui.press({ key: 'inbox-archive' })
  await ui.press({ key: 'arch-q2' })
  expect(await ui.find({ text: /Nothing more to answer\./ })).toBeDefined()
  expect(await ui.find({ key: 'card-opt-0' })).toBeUndefined()
  await ui.press({ key: 'card-back' })
  await ui.press({ key: 'arch-q1' })
  expect(await ui.find({ text: /Answered: no \(by main.*Press another option to change it\./ })).toBeDefined()
  await ui.press({ key: 'card-opt-0' })
  expect(stateOf(w.files, 'q1')).toMatchObject({ state: 'answered', answer: 'yes' })
  await ui.unmount()
})

test('a protected card: y never answers it, an option press does', async ($, on) => {
  const w = world(on)
  protectedItems(w.files)
  await fyi($, 'w1', [F(1)])
  const ui = await mount($)
  await open(ui)
  await openCard(ui, 'q1')
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
  expect(await ui.find({ text: /▤ \? 1 question \(1 blocking\) · 2 decisions/ })).toBeDefined()
  await ui.press({ key: 'fold-#questions' })
  await ui.press({ key: 'open-q1' })
  expect(await ui.find({ text: /q1 · csv-worker · / })).toBeDefined()
  expect(await ui.find({ text: /^question/ })).toBeDefined()
  await ui.press({ key: 'card-back' })
  expect(await ui.find({ text: /super manager/ })).toBeDefined()
  expect(stateOf(w.files, 'q1')?.state).toBe('open')
  await ui.unmount()
})

test('the questions fold into one row, collapsed by default; pressing it or a lists them, capped, and folds them again', async ($, on) => {
  world(on)
  await ask($, 'w1', [Q, SOFT, { ...SOFT, question: 'Second soft?' }, { ...SOFT, question: 'Third soft?' }, { ...SOFT, question: 'Fourth soft?' }])
  const ui = await mount($, 12)
  expect(await ui.find({ text: /▸ ▤ \? 5 questions \(1 blocking\)/ })).toBeDefined()
  expect(await ui.find({ key: 'open-q1' })).toBeUndefined()
  expect(await ui.find({ key: 'nav-questions' })).toBeDefined()
  await ui.press({ key: 'fold-#questions' })
  expect(await ui.find({ text: /▾ ▤ \? 5 questions/ })).toBeDefined()
  expect(await ui.find({ key: 'open-q1' })).toBeDefined()
  // A third of 12 rows is 4: the row, 2 items and the "and N more" line.
  expect(await ui.find({ key: 'open-q3' })).toBeUndefined()
  expect(await ui.find({ text: /and 3 more/ })).toBeDefined()
  await ui.press({ key: 'nav-questions' })
  expect(await ui.find({ key: 'open-q1' })).toBeUndefined()
  expect(await ui.find({ text: /▸ ▤ \? 5 questions/ })).toBeDefined()
  await ui.unmount()
})

test('a tree with only decisions shows just the Inbox line, singular and plural', async ($, on) => {
  world(on)
  await fyi($, 'm1', [F(1)])
  const ui = await mount($)
  expect(await has(ui, /▤ 1 decision/)).toBe(true)
  expect(await ui.find({ text: /question/ })).toBeUndefined()
  expect(await ui.find({ text: /d1 decision/ })).toBeUndefined()
  await ui.unmount()
})

test('an expanded decision shows text, why, instead could and Keep/Undo buttons, no option lines; the o card shows Keep and Undo only', async ($, on) => {
  const w = world(on)
  await fyi($, 'w1', [{ decision: 'Use 5 s timeout', why: 'slow CI', alternative: 'poll instead' }])
  const ui = await mount($)
  await open(ui)
  // collapsed by default: one line, none of the detail
  expect(await has(ui, /▸ d1 Use 5 s timeout/)).toBe(true)
  expect(await ui.find({ text: /why: slow CI/ })).toBeUndefined()
  await ui.press({ key: 'item-d1' })
  expect(await ui.find({ text: /Use 5 s timeout/ })).toBeDefined()
  expect(await ui.find({ text: /why: slow CI/ })).toBeDefined()
  expect(await ui.find({ text: /instead could: poll instead/ })).toBeDefined()
  expect(await ui.find({ text: /y Keep/ })).toBeDefined()
  expect(await ui.find({ text: /n Undo/ })).toBeDefined()
  expect(await ui.find({ text: /a\) / })).toBeUndefined()
  await ui.press({ key: 'inbox-open' })
  expect(await ui.find({ text: /d1 · csv-worker · \d+ \w+/ })).toBeDefined()
  expect(await ui.find({ text: /^decision$/ })).toBeDefined()
  expect(await ui.find({ key: 'card-opt-0' })).toBeUndefined()
  expect(await ui.find({ key: 'card-pick-a' })).toBeUndefined()
  await ui.press({ key: 'card-yes' })
  expect(stateOf(w.files, 'd1')?.state).toBe('answered')
  await ui.unmount()
})

test('an item expands on its row and stays expanded; the inline buttons answer their own item and the next one stays collapsed', async ($, on) => {
  const w = world(on)
  await ask($, 'm1', [SOFT])
  await fyi($, 'w1', [F(1), F(2)])
  const ui = await mount($, 30, 60)
  await open(ui)
  const lines = async () => rendered(ui)
  expect((await lines()).some(l => /╭/.test(l))).toBe(false)
  // the owner of the decisions is a plain header, not a card
  expect((await lines()).some(l => /^▾ csv-worker · 2$/.test(l))).toBe(true)
  expect((await lines()).some(l => /^▾ csv-export · 1 asks$/.test(l))).toBe(true)
  await ui.press({ key: 'item-d2' })
  expect((await lines()).some(l => /d2 · /.test(l))).toBe(true)
  // moving away and back leaves it expanded
  await ui.press({ key: 'inbox-prev' })
  await ui.press({ key: 'inbox-next' })
  expect((await lines()).some(l => /╭/.test(l))).toBe(true)
  // the inline Keep answers d2 and not the highlight's item; d1 is next and collapsed
  await ui.press({ key: 'keep-d2' })
  expect(stateOf(w.files, 'd2')?.answer).toBe('Keep')
  expect(stateOf(w.files, 'd1')?.state).toBe('open')
  const after = await lines()
  expect(after.some(l => /╭/.test(l))).toBe(false)
  expect(after.some(l => /▸ d1 Decision 1/.test(l))).toBe(true)
  // the keys now act on d1
  await ui.press({ key: 'inbox-yes' })
  expect(stateOf(w.files, 'd1')?.answer).toBe('Keep')
  await ui.unmount()
})

test('an inline Undo uses the typed words; an expanded question lists its options as buttons that answer it', async ($, on) => {
  const w = world(on)
  await ask($, 'm1', [SOFT])
  await fyi($, 'w1', [F(1)])
  const ui = await mount($, 30, 60)
  await open(ui)
  await ui.press({ key: 'item-q1' })
  expect(await has(ui, /1\/a yes \(default\)/)).toBe(true)
  expect(await has(ui, /2\/b no/)).toBe(true)
  expect(await has(ui, /r reply/)).toBe(true)
  await ui.press({ key: 'item-d1' })
  await ui.input({ key: 'inbox-answer', text: 'use 10 s', kind: 'change' })
  await ui.press({ key: 'undo-d1' })
  expect(stateOf(w.files, 'd1')?.answer).toBe('use 10 s')
  // the option button answers q1 itself
  await ui.press({ key: 'opt-q1-1' })
  expect(stateOf(w.files, 'q1')?.answer).toBe('no')
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
  expect(await ui.find({ text: /q1 no \(by the user, 0 min ago\): Quote fields/ })).toBeDefined()
  await ui.press({ key: 'arch-q1' })
  expect(await ui.find({ text: /Answered: no \(by the user/ })).toBeDefined()
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
  expect(await cmd($, 'inbox archive')).toMatch(/Archive: 1 answered item[\s\S]*q1 no \(by the user/)
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
  expect(await ui.find({ text: /q2 was answered meanwhile \(by the user\); the highlight moved, press again/ })).toBeDefined()
  await ui.press({ key: 'inbox-yes' })
  expect(stateOf(w.files, 'q1')?.answer).toBe('yes')
  await ui.unmount()
})

// What the pane draws, as lines of text: a column stacks its children, a row sets them side by side with its gap
// (a child of several lines beside the next one), a border adds its two columns and rows.
type El = string | { type?: string; props?: { flexDirection?: string; flexGrow?: number; flexShrink?: number; overflow?: string; gap?: number; label?: string; borderStyle?: string; paddingX?: number; width?: number; height?: number; wrap?: string }; children?: El[] } | null | undefined | false
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
  const w = world(on, agents)
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
  return w
}

const rendered = async (ui: Ui) => linesOf((await ui.drawn()) as El)
const shape = (lines: string[], rows: number) => {
  expect(lines.length).toBeLessThanOrEqual(rows)
  for (const l of lines) expect(cols(l)).toBeLessThanOrEqual(60)
  expect(lines.some(l => /j next/.test(l) && /k prev/.test(l))).toBe(true)
  expect(lines.some(l => /y (keep|default)/.test(l) && /n undo/.test(l) && /i back/.test(l))).toBe(true)
}

test('at 60 columns by 30 rows each owner is a plain header and each item a collapsed line; the routine group is collapsed', async ($, on) => {
  await cardsWorld($, on)
  const ui = await mount($, 30, 60)
  await open(ui)
  const lines = await rendered(ui)
  shape(lines, 30)
  // nothing is bordered until an item is opened
  expect(lines.some(l => /[╭╮╰╯]/.test(l))).toBe(false)
  expect(lines.some(l => /^▾ ctx-init-tip · 3 asks$/.test(l))).toBe(true)
  expect(lines.some(l => /^▾ plain-capability-use · 3$/.test(l))).toBe(true)
  expect(lines.some(l => /^▾ quiet-update-notice · 1$/.test(l))).toBe(true)
  expect(lines.some(l => /^ *▸ q1 Should the tip also show in the status line\?$/.test(l))).toBe(true)
  // long text is clipped to one line
  expect(lines.some(l => /▸ d1 Show the context-trim tip once per session.*…$/.test(l))).toBe(true)
  expect(lines.some(l => /^▸ routine · 5 \((manager-size, worker-size|worker-size, manager-size)\)$/.test(l))).toBe(true)
  expect(lines.some(l => /c collapse/.test(l) && /o open/.test(l))).toBe(true)
  await ui.unmount()
})

test('at 60 columns by 30 rows an opened decision and an opened question are round cards with inline buttons; no line is wider than 60', async ($, on) => {
  await cardsWorld($, on)
  const ui = await mount($, 30, 60)
  await open(ui)
  // (the render helper does not wrap text, so a short decision stands in for the wide one)
  await ui.press({ key: 'item-d2' })
  let lines = await rendered(ui)
  shape(lines, 30)
  expect(lines.some(l => /▾ ╭/.test(l))).toBe(true)
  expect(lines.some(l => /│ d2 · \d+ \w+ ago \[tip-wording\] +│/.test(l))).toBe(true)
  expect(lines.some(l => /│ why: softer +│/.test(l))).toBe(true)
  expect(lines.some(l => /│ y Keep +n Undo +│/.test(l))).toBe(true)
  await ui.press({ key: 'item-q1' })
  lines = await rendered(ui)
  shape(lines, 30)
  expect(lines.filter(l => /▾ ╭/.test(l))).toHaveLength(2)
  expect(lines.some(l => /│ 1\/a yes +│/.test(l))).toBe(true)
  expect(lines.some(l => /│ 2\/b no \(default\) +│/.test(l))).toBe(true)
  expect(lines.some(l => /│ r reply +│/.test(l))).toBe(true)
  await ui.unmount()
})

test('at 60 columns by 30 rows an owner collapsed by its chevron is one line, and j/k step over its items', async ($, on) => {
  const w = await cardsWorld($, on)
  const ui = await mount($, 30, 60)
  await open(ui)
  await ui.press({ key: 'fold-grp:plain-capability-use' })
  const lines = await rendered(ui)
  shape(lines, 30)
  expect(lines.some(l => /^▸ plain-capability-use · 3$/.test(l))).toBe(true)
  expect(lines.some(l => /Name the capability/.test(l))).toBe(false)
  // the cursor went to the owner's line; k steps to the item above, j twice to the routine group
  await ui.press({ key: 'inbox-prev' })
  await ui.press({ key: 'inbox-yes' })
  expect(stored(w.files).some(x => x.id === 'd6' && x.state === 'answered')).toBe(true)
  await ui.unmount()
})

test('at 60 columns by 14 rows expanded cards are windowed around the hot item and the footer is still drawn', async ($, on) => {
  await cardsWorld($, on)
  const ui = await mount($, 14, 60)
  await open(ui)
  await ui.press({ key: 'item-q1' })
  await ui.press({ key: 'inbox-next' })
  await ui.press({ key: 'inbox-toggle' })
  const lines = await rendered(ui)
  shape(lines, 14)
  expect(lines.some(l => /▾ ╭/.test(l))).toBe(true)
  expect(lines.some(l => /↓ \d+ more/.test(l))).toBe(true)
  await ui.unmount()
  // a collapsed list that cannot fit is windowed too
  const shortUi = await mount($, 9, 60)
  // an opened card taller than the pane is cut by the content box; the footer is its own box and stays
  const v = visible((await shortUi.drawn()) as El, 9)
  expect(v.lines.length).toBeLessThanOrEqual(9)
  expect(v.footer.some(l => /j next/.test(l)) && v.footer.some(l => /i back/.test(l))).toBe(true)
  await shortUi.unmount()
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
  expect(top.some(l => /^▸ ▤ \? 1 question · 11 decisions$/.test(l))).toBe(true)
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
  expect(a).toEqual(['▤ 1 decision'])
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

// ---- Esc goes home (the pane's ui.close handler and /flow home run the same reset) ----

const count = (lines: string[], re: RegExp) => lines.filter(l => re.test(l)).length
const isHome = async (ui: Ui) => (await ui.find({ text: /press an agent to open it/ })) !== undefined

test('Esc-home from the inbox, the large card, the archive and an expanded card lands on the tree; on home it does nothing', async ($, on) => {
  world(on)
  await ask($, 'w1', [Q, SOFT])
  const ui = await mount($)
  expect(await isHome(ui)).toBe(true)
  await cmd($, 'home')
  expect(await isHome(ui)).toBe(true)
  await open(ui)
  expect(await isHome(ui)).toBe(false)
  await cmd($, 'home')
  expect(await isHome(ui)).toBe(true)
  // An expanded card, then the large card on top of it.
  await open(ui)
  await ui.press({ key: 'item-q1' })
  await ui.press({ key: 'inbox-open' })
  expect(await ui.find({ key: 'card-back' })).toBeDefined()
  await cmd($, 'home')
  expect(await isHome(ui)).toBe(true)
  await open(ui)
  // The expansion was cleared: the why is folded away again.
  expect(await ui.find({ text: /why: the export needs one/ })).toBeUndefined()
  await ui.press({ key: 'inbox-archive' })
  expect(await ui.find({ key: 'arch-back' })).toBeDefined()
  await cmd($, 'home')
  expect(await isHome(ui)).toBe(true)
  await ui.unmount()
})

test('Esc-home keeps an unsent draft', async ($, on) => {
  world(on)
  await ask($, 'w1', [Q])
  const ui = await mount($)
  await open(ui)
  await ui.input({ key: 'inbox-answer', text: 'half a thought', kind: 'change' })
  await cmd($, 'home')
  expect(await isHome(ui)).toBe(true)
  await open(ui)
  expect(JSON.stringify(await ui.find({ key: 'inbox-answer' }))).toContain('half a thought')
  await ui.unmount()
})

test('every sub-view draws "esc home", and its hint row exactly once', async ($, on) => {
  world(on)
  await ask($, 'w1', [Q, SOFT])
  await fyi($, 'w1', [F(1)])
  const ui = await mount($)
  // Home has no esc hint; its key row and the inbox hint each appear once.
  let lines = await rendered(ui)
  expect(count(lines, /j next/)).toBe(1)
  expect(count(lines, /i inbox/)).toBe(1)
  expect(count(lines, /· i$/)).toBe(0)
  expect(count(lines, /esc home/)).toBe(0)
  await ui.press({ key: 'nav-fold' })
  lines = await rendered(ui)
  expect(count(lines, /j next/)).toBe(1)
  await open(ui)
  lines = await rendered(ui)
  expect(count(lines, /j next/)).toBe(1)
  expect(count(lines, /y default/)).toBe(1)
  expect(count(lines, /esc home/)).toBe(1)
  await ui.press({ key: 'item-q1' })
  await ui.press({ key: 'inbox-open' })
  lines = await rendered(ui)
  expect(count(lines, /j next/)).toBe(1)
  expect(count(lines, /y default/)).toBe(1)
  expect(count(lines, /esc home/)).toBe(1)
  await ui.press({ key: 'card-back' })
  await ui.press({ key: 'inbox-archive' })
  lines = await rendered(ui)
  expect(count(lines, /j next/)).toBe(1)
  expect(count(lines, /esc home/)).toBe(1)
  await ui.unmount()
})

// ---- markdown in the free text ----

const MD_Q = {
  question: 'Which **format** should `export.csv` use?\n\n- keep `snake_case` names\n- drop the `hooks/foo_bar.ts` path',
  options: ['csv', 'tsv'], default: 'csv', blocking: true,
  context: '## Why\nThe *downstream* job reads it, see [the spec](https://example.com/spec).\n\n| col | meaning |\n| --- | --- |\n| id | row id |',
}
const noMarks = (lines: string[]) => {
  const t = lines.join('\n')
  expect(t).not.toMatch(/\*\*|`|## |\]\(/)
}

for (const columns of [60, 100]) {
  test(`at ${columns} columns a question's markdown shows in the collapsed row, the opened item and the full card`, async ($, on) => {
    const w = world(on)
    await ask($, 'w1', [MD_Q])
    const ui = await mount($, 40, columns)
    await open(ui)
    let lines = await rendered(ui)
    // The collapsed row is one line: markers gone, the text kept.
    expect(lines.some(l => /▸ q1 BLOCKING Which format should export\.csv use\?/.test(l))).toBe(true)
    noMarks(lines)
    await ui.press({ key: 'item-q1' })
    lines = await rendered(ui)
    noMarks(lines)
    for (const l of lines) expect(cols(l)).toBeLessThanOrEqual(columns)
    expect(lines.some(l => /Which format should export\.csv use\?/.test(l))).toBe(true)
    expect(lines.some(l => /why: Why/.test(l))).toBe(true)
    await ui.press({ key: 'inbox-open' })
    lines = await rendered(ui)
    noMarks(lines)
    expect(lines.some(l => /^Which format should export\.csv use\?$/.test(l))).toBe(true)
    expect(lines.some(l => /^• keep snake_case names$/.test(l))).toBe(true)
    expect(lines.some(l => /^• drop the hooks\/foo_bar\.ts path$/.test(l))).toBe(true)
    expect(lines.some(l => /^why: Why$/.test(l))).toBe(true)
    expect(lines.some(l => /The downstream job reads it, see the spec/.test(l))).toBe(true)
    expect(lines.some(l => /^col +│ meaning$/.test(l))).toBe(true)
    expect(lines.some(l => /^id +│ row id$/.test(l))).toBe(true)
    // The options stay plain buttons, and nothing was answered by looking.
    expect(lines.some(l => /\(https:\/\/example\.com\/spec\)\./.test(l))).toBe(true)
    expect(await ui.find({ type: 'Button', key: 'card-opt-0' })).toBeDefined()
    expect(stateOf(w.files, 'q1')?.state).toBe('open')
    await ui.unmount()
  })
}

test('a decision with markdown in its text, why and alternative reads cleanly in the card and the archive', async ($, on) => {
  const w = world(on)
  await fyi($, 'w1', [{ decision: 'Use **ndjson** for `export`', why: 'streams', alternative: 'a `csv` with a header *row*' }])
  const ui = await mount($, 40, 60)
  await open(ui)
  await openCard(ui, 'd1')
  let lines = await rendered(ui)
  noMarks(lines)
  expect(lines.some(l => /^Use ndjson for export$/.test(l))).toBe(true)
  expect(lines.some(l => /^instead could: a csv with a header row$/.test(l))).toBe(true)
  await ui.press({ key: 'card-yes' })
  expect(stateOf(w.files, 'd1')?.state).not.toBe('open')
  await ui.press({ key: 'inbox-archive' })
  lines = await rendered(ui)
  noMarks(lines)
  expect(lines.some(l => /d1 .*Use ndjson for export/.test(l))).toBe(true)
  await ui.unmount()
})

test('a long markdown question in a short pane scrolls its body with m and u, clamped at both ends; the options and the footer stay', async ($, on) => {
  world(on)
  await ask($, 'w1', [{ ...Q, question: Array.from({ length: 30 }, (_, i) => `- point ${i} of a long **list**`).join('\n') }])
  const ui = await mount($, 24, 60)
  await open(ui)
  await openCard(ui, 'q1')
  const pinned = async () => {
    expect(await ui.find({ type: 'Button', key: 'card-opt-0' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'card-opt-2' })).toBeDefined()
    expect(await has(ui, /^y default/)).toBe(true)
    expect(await has(ui, /^Back esc home k prev j next u up m more$/)).toBe(true)
    expect(await has(ui, /more lines/)).toBe(false)
    expect(cardScreen((await ui.drawn()) as El, 24).length).toBeLessThanOrEqual(24)
  }
  expect((await cardBody(ui))[0]).toBe('• point 0 of a long list')
  expect(await position(ui)).toMatch(/^lines 1-\d+ of 31 · ↓ \d+ below$/)
  await pinned()
  // u at the top does nothing.
  await ui.press({ key: 'card-up' })
  expect((await cardBody(ui))[0]).toBe('• point 0 of a long list')
  const seen = new Set<string>()
  for (let i = 0; i < 10; i++) {
    for (const l of await cardBody(ui)) seen.add(l)
    await ui.press({ key: 'card-down' })
    await pinned()
  }
  for (let i = 0; i < 30; i++) expect(seen.has(`• point ${i} of a long list`)).toBe(true)
  // Clamped at the end: the last line is the last body row and another m changes nothing.
  const end = await position(ui)
  expect(end).toMatch(/^↑ \d+ above · lines \d+-31 of 31$/)
  expect((await cardBody(ui)).slice(-2)).toEqual(['• point 29 of a long list', 'why: the export needs one'])
  await ui.press({ key: 'card-down' })
  expect(await position(ui)).toBe(end)
  // A taller pane (the same card drawn again at 34 rows) clamps the offset: the end stays at the end, more of the body above it.
  await ui.unmount()
  const tall = await mount($, 34, 60)
  expect(await position(tall)).toMatch(/^↑ \d+ above · lines \d+-31 of 31$/)
  expect(Number(/↑ (\d+)/.exec((await position(tall))!)![1])).toBeLessThan(Number(/↑ (\d+)/.exec(end!)![1]))
  expect((await cardBody(tall)).at(-1)).toBe('why: the export needs one')
  for (let i = 0; i < 10; i++) await tall.press({ key: 'card-up' })
  expect((await cardBody(tall))[0]).toBe('• point 0 of a long list')
  await tall.unmount()
})

test('the wheel and the page keys (ui.scroll) move an open card body by e.by, a page key by the card page; elsewhere the engine scrolls', async ($, on) => {
  world(on)
  const engine: number[] = []
  on('ui.scroll', (_, e) => { engine.push((e as { by: number }).by); return {} })
  await ask($, 'w1', [{ ...Q, question: Array.from({ length: 30 }, (_, i) => `- point ${i}`).join('\n') }])
  const ui = await mount($, 24, 60)
  // The tree: the pane's own scroll, untouched.
  await wheel($, 2)
  expect(engine).toEqual([2])
  await open(ui)
  await openCard(ui, 'q1')
  expect(await wheel($, 3)).toEqual({})
  expect((await cardBody(ui))[0]).toBe('• point 3')
  // Ticks summed in flight move as far; past the top clamps.
  await wheel($, -10)
  expect((await cardBody(ui))[0]).toBe('• point 0')
  // A page key moves by the body's own rows less one, not the pane's.
  const rows = (await cardBody(ui)).length
  await wheel($, 24)
  expect((await cardBody(ui))[0]).toBe(`• point ${rows - 1}`)
  for (let i = 0; i < 8; i++) await wheel($, 5)
  expect((await cardBody(ui)).at(-1)).toBe('why: the export needs one')
  expect(engine).toEqual([2])
  // The draft in the answer Input keeps its text while the body moves.
  await ui.input({ key: 'card-answer', text: 'half typed', kind: 'change' })
  await wheel($, -3)
  expect((await ui.find({ key: 'card-answer' }) as { props?: { value?: string } } | undefined)?.props?.value).toBe('half typed')
  await ui.unmount()
})

test('the scroll offset starts at the top on the next card (j), back on the first (k) and after Esc home', async ($, on) => {
  world(on)
  const long = (tag: string) => Array.from({ length: 30 }, (_, i) => `- ${tag} ${i}`).join('\n')
  await ask($, 'w1', [{ ...Q, question: long('first') }, { ...SOFT, question: long('second') }])
  const ui = await mount($, 24, 60)
  await open(ui)
  await openCard(ui, 'q1')
  await ui.press({ key: 'card-down' })
  expect((await cardBody(ui))[0]).not.toBe('• first 0')
  await ui.press({ key: 'card-next' })
  expect((await cardBody(ui))[0]).toBe('• second 0')
  await ui.press({ key: 'card-down' })
  await ui.press({ key: 'card-prev' })
  expect((await cardBody(ui))[0]).toBe('• first 0')
  await ui.press({ key: 'card-down' })
  await cmd($, 'home')
  await open(ui)
  await openCard(ui, 'q1')
  expect((await cardBody(ui))[0]).toBe('• first 0')
  await ui.unmount()
})

for (const rows of [12, 13, 14]) {
  test(`at ${rows} rows a long CJK question with a why is readable to its last line by scrolling, the buttons always shown`, async ($, on) => {
    world(on)
    const question = Array.from({ length: 12 }, (_, i) => `第${i}段 ${'这是一个很长的测试问题文本'.repeat(3)} テスト end${i}`).join('\n\n')
    const context = '```\n┌──────┐\n│ 框图 │\n└──────┘\n```\nwhy ends here 结束'
    await ask($, 'w1', [{ ...Q, question, context, options: ['选项 A', 'option B', 'option C'], default: 'option B' }])
    const ui = await mount($, rows, 60)
    await open(ui)
    await openCard(ui, 'q1')
    const seen: string[] = []
    for (let i = 0; i < 80; i++) {
      const screen = cardScreen((await ui.drawn()) as El, rows)
      expect(screen.length).toBeLessThanOrEqual(rows)
      expect(screen.some(l => /^Back esc home/.test(l))).toBe(true)
      for (const k of [0, 1, 2]) expect(await ui.find({ type: 'Button', key: `card-opt-${k}` })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'card-yes' })).toBeDefined()
      const body = await cardBody(ui)
      for (const l of body) expect(strWidth(l)).toBeLessThanOrEqual(60)
      seen.push(...body)
      if (!/below/.test((await position(ui)) ?? '')) break
      await ui.press({ key: 'card-down' })
    }
    const all = seen.join('\n')
    for (let i = 0; i < 12; i++) expect(all).toContain(`end${i}`)
    expect(all).toContain('┌──────┐')
    expect(all).toContain('why ends here 结束')
    await ui.unmount()
  })
}

test('three decisions kept the same way show a rule hint row in the inbox; s hides it for good and no rule is written', async ($, on) => {
  const w = world(on)
  await fyi($, 'w1', [F(1, 'tone'), F(2, 'tone'), F(3, 'tone'), F(4, 'other')])
  for (const id of ['d1', 'd2', 'd3']) await $.tool.call({ tool: 'mcp__flow__answer', answers: [{ id, choice: 'Keep' }] } as never)
  await fyi($, 'w1', [F(5, 'tone')])
  const ui = await mount($)
  await open(ui)
  expect(await has(ui, /^\+ rule\? decisions topic tone answered "Keep" 3x/)).toBe(true)
  expect(await ui.find({ text: /s hide rule hint/ })).toBeDefined()
  await ui.press({ key: 'inbox-sugg' })
  expect(await has(ui, /rule\?/)).toBe(false)
  expect(await ui.find({ text: /s hide rule hint/ })).toBeUndefined()
  expect(w.files.get(`${DIR}/suggest-offered.json`)).toMatch(/"dismissed": true/)
  expect(w.files.has('/r/.git/flow/config.json')).toBe(false)
  await ui.unmount()
})

test('a duplicate question group is one row with its count and askers; a pick answers every member', async ($, on) => {
  const w = world(on, [
    { id: 'm1', name: 'csv-export', description: 'm', type: 'flow:manager', status: 'running' },
    { id: 'm2', name: 'pdf-export', description: 'm', type: 'flow:manager', status: 'running' },
  ])
  const dup = { ...Q, topic: 'format' }
  await ask($, 'm1', [dup])
  await ask($, 'm2', [dup])
  const ui = await mount($)
  await open(ui)
  expect(await has(ui, /▸ q1 x2 BLOCKING /)).toBe(true)
  expect(await has(ui, /q2/)).toBe(false)
  await ui.press({ key: 'item-q1' })
  expect(await has(ui, /x2 \(answers all\): csv-export, pdf-export/)).toBe(true)
  await ui.press({ key: 'pick-b' })
  expect(stored(w.files).map(x => `${x.id}:${x.state}:${x.answer}`)).toEqual(['q1:answered:tsv', 'q2:answered:tsv'])
  await ui.unmount()
})
