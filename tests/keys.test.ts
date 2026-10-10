import type { AgentInfo } from 'claude-code'
import { expect, mock } from 'claude-code/testing'
import { test } from './support'
import type { TestBody } from 'claude-code/testing'
import { treeItems, viewOf } from '../hooks/pane'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const PANE = { component: 'Pane', props: { title: 'Flow' } as never, requestId: 'flow' } as const

const row = (id: string, parentId?: string, status = 'running', type = parentId ? 'flow:worker' : 'flow:manager') =>
  ({ id, name: id, description: `d ${id}`, type, status, parentId }) as never

// m0..m(n-1), each with `kids` workers m0-w0...
function fleet(n: number, kids: number): AgentInfo[] {
  const out: AgentInfo[] = []
  for (let i = 0; i < n; i++) {
    out.push(row(`m${i}`))
    for (let j = 0; j < kids; j++) out.push(row(`m${i}-w${j}`, `m${i}`))
  }
  return out
}

async function setup($: Dollar, on: On, agents: AgentInfo[]) {
  mock.clock(on, { now: 1_000_000 })
  on('agent.list', () => ({ value: agents }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: agents[0]!.id }))
  on('tool.call', () => ({ result: 'ok' }))
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 200_000, tokens: 1000, percent: 1 } } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.focus', () => ({}))
  await $.agent.spawn({ prompt: 'brief', description: 'A task', subagentType: 'flow:manager' } as never)
}

// Managers start collapsed; `open` expands the first N so their workers are drawn.
const mount = async ($: Dollar, rows: number, open = 0) => {
  const ui = await $.ui.mount({
    plugin: 'flow', surface: 'terminal', ...PANE, viewport: { columns: 100, rows },
  } as never)
  for (let i = 0; i < open; i++) await ui.press({ key: `fold-m${i}` })
  return ui
}

const hot = (ui: Awaited<ReturnType<typeof mount>>, id: string) =>
  ui.find({ type: 'Text', text: new RegExp(`^${id}$`), inverse: true } as never)

test('treeItems folds all but the highlight path when crowded, and an explicit fold wins', () => {
  const list = [row('a', undefined, 'running', 'flow:worker'), row('a1', 'a'), row('b', undefined, 'running', 'flow:worker'), row('b1', 'b')] as unknown as Parameters<typeof treeItems>[0]
  expect(treeItems(list, {}, 'a1', false).items.map(i => i.a.id)).toEqual(['a', 'a1', 'b', 'b1'])
  const auto = treeItems(list, {}, 'a1', true)
  expect(auto.items.map(i => i.a.id)).toEqual(['a', 'a1', 'b'])
  expect(auto.items[2]!.collapsed).toBe(true)
  expect(treeItems(list, { a: true }, 'a1', true).at).toBe('a')
  expect(treeItems(list, { b: false }, 'a1', true).items.map(i => i.a.id)).toEqual(['a', 'a1', 'b', 'b1'])
  expect(treeItems(list, {}, 'gone', false).at).toBeUndefined()
})

test('treeItems starts managers and the queue collapsed, workers expanded, and a choice wins', () => {
  const list = [row('m'), row('w', 'm'), row('q', undefined, 'running', 'flow:queue'), row('s', undefined, 'running', 'flow:worker')] as unknown as Parameters<typeof treeItems>[0]
  const ids = (fold: Record<string, boolean>, cur?: string) => treeItems(list, fold, cur, false).items.map(i => i.a.id)
  expect(ids({})).toEqual(['m', 'q', 's'])
  expect(treeItems(list, {}, undefined, false).items.map(i => i.collapsed)).toEqual([true, true, false])
  expect(ids({ m: false })).toEqual(['m', 'w', 'q', 's'])
  const solo = treeItems(list, { s: true }, undefined, false).items
  expect(solo.find(i => i.a.id === 's')!.collapsed).toBe(true)
  // The highlight on a hidden worker moves up to its collapsed manager.
  expect(treeItems(list, {}, 'w', false).at).toBe('m')
})

test('viewOf centres the highlight and clamps at both ends', () => {
  const xs = Array.from({ length: 20 }, (_, i) => i)
  expect(viewOf(xs, 0, 5)).toEqual({ top: 0, rows: [0, 1, 2, 3, 4] })
  expect(viewOf(xs, 10, 5).rows).toEqual([8, 9, 10, 11, 12])
  expect(viewOf(xs, 19, 5).rows).toEqual([15, 16, 17, 18, 19])
  expect(viewOf(xs.slice(0, 3), 1, 5).rows).toEqual([0, 1, 2])
})

test('j and k move the highlight and clamp at both ends', async ($, on) => {
  await setup($, on, fleet(1, 2))
  const ui = await mount($, 40, 1)
  expect(await hot(ui, 'm0')).toBeDefined()
  await ui.press({ key: 'nav-prev' })
  expect(await hot(ui, 'm0')).toBeDefined()
  await ui.press({ key: 'nav-next' })
  expect(await hot(ui, 'm0-w0')).toBeDefined()
  await ui.press({ key: 'nav-next' })
  await ui.press({ key: 'nav-next' })
  expect(await hot(ui, 'm0-w1')).toBeDefined()
  await ui.press({ key: 'nav-prev' })
  expect(await hot(ui, 'm0-w0')).toBeDefined()
  await ui.unmount()
})

test('o opens the highlighted agent; b goes back; j does nothing in the detail view', async ($, on) => {
  await setup($, on, fleet(1, 2))
  const ui = await mount($, 40, 1)
  await ui.press({ key: 'nav-next' })
  await ui.press({ key: 'nav-open' })
  expect(await ui.find({ type: 'Text', text: /d m0-w0/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'nav-next' })).toBeUndefined()
  await ui.press({ key: 'back' })
  expect(await hot(ui, 'm0-w0')).toBeDefined()
  await ui.unmount()
})

test('clicking a card opens it and moves the highlight to it', async ($, on) => {
  await setup($, on, fleet(1, 2))
  const ui = await mount($, 40, 1)
  await ui.press({ key: 'm0-w1' })
  await ui.press({ key: 'back' })
  expect(await hot(ui, 'm0-w1')).toBeDefined()
  await ui.unmount()
})

test('c collapses and expands the highlighted card; managers start collapsed', async ($, on) => {
  await setup($, on, fleet(2, 2))
  const ui = await mount($, 60)
  expect(await ui.find({ type: 'Button', key: 'm0-w0' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'm1-w0' })).toBeUndefined()
  await ui.press({ key: 'nav-fold' })
  expect(await ui.find({ type: 'Button', key: 'm0-w0' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'm1-w0' })).toBeUndefined()
  await ui.press({ key: 'nav-fold' })
  expect(await ui.find({ type: 'Button', key: 'm0-w0' })).toBeUndefined()
  // j does not open a collapsed manager.
  await ui.press({ key: 'nav-next' })
  expect(await hot(ui, 'm1')).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'm1-w0' })).toBeUndefined()
  await ui.unmount()
})

test('scrolling keeps the highlight in view', async ($, on) => {
  await setup($, on, fleet(1, 12))
  const ui = await mount($, 9, 1)
  for (let i = 0; i < 9; i++) await ui.press({ key: 'nav-next' })
  expect(await hot(ui, 'm0-w8')).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /↑ \d+ above/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\+\d+ more/ })).toBeDefined()
  for (let i = 0; i < 20; i++) await ui.press({ key: 'nav-next' })
  expect(await hot(ui, 'm0-w11')).toBeDefined()
  await ui.unmount()
})

test('g is the graph toggle, not a navigation key', async ($, on) => {
  await setup($, on, fleet(2, 2))
  const ui = await mount($, 40)
  const keys = (await ui.findAll({ type: 'Button' })).map(b => (b.props as { hotkey?: string }).hotkey)
  expect(keys.filter(k => k === 'g').length).toBe(1)
  expect(keys).toContain('j')
  await ui.unmount()
})

test('20 managers with 60 workers render fast, three of them expanded, the highlight in view', async ($, on) => {
  await setup($, on, fleet(20, 3))
  for (let i = 0; i < 20; i++) {
    await $.tool.call({ tool: 'Edit', file_path: `src/f${i}.ts`, agentId: `m${i}-w0` } as never)
  }
  const ui = await mount($, 14, 3)
  const t0 = performance.now()
  expect(await ui.find({ type: 'Text', text: /80 agents/ })).toBeDefined()
  for (let i = 0; i < 25; i++) await ui.press({ key: 'nav-next' })
  const ms = performance.now() - t0
  ;(globalThis as { console?: { log(s: string): void } }).console?.log(`render+25 presses: ${ms.toFixed(0)}ms`)
  // The budget only guards against a slowdown of an order of magnitude, so a loaded
  // machine (a measured 750 ms) does not fail it.
  expect(ms).toBeLessThan(2500)
  expect(await ui.find({ type: 'Text', text: /super manager/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'nav-next' })).toBeDefined()
  // Managers stay as they were: m0..m2 open (12 rows), the rest one line each, so 25 presses
  // land on m16 and the window has scrolled past the top.
  expect(await hot(ui, 'm16')).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'm16-w0' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /↑ \d+ above/ })).toBeDefined()
  await ui.unmount()
})
