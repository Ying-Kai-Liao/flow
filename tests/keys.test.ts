import type { AgentInfo } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import { treeItems, viewOf } from '../hooks/register'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const PANE = { component: 'Pane', props: { title: 'Flow' } as never, requestId: 'flow' } as const

const row = (id: string, parentId?: string, status = 'running') =>
  ({ id, name: id, description: `d ${id}`, type: parentId ? 'flow:worker' : 'flow:manager', status, parentId }) as never

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

const mount = ($: Dollar, rows: number) => $.ui.mount({
  plugin: 'flow', surface: 'terminal', ...PANE, viewport: { columns: 100, rows },
} as never)

const hot = (ui: Awaited<ReturnType<typeof mount>>, id: string) =>
  ui.find({ type: 'Text', text: new RegExp(`^${id}$`), inverse: true } as never)

test('treeItems folds all but the highlight path when crowded, and an explicit fold wins', () => {
  const list = [row('a'), row('a1', 'a'), row('b'), row('b1', 'b')] as unknown as Parameters<typeof treeItems>[0]
  expect(treeItems(list, {}, 'a1', false).items.map(i => i.a.id)).toEqual(['a', 'a1', 'b', 'b1'])
  const auto = treeItems(list, {}, 'a1', true)
  expect(auto.items.map(i => i.a.id)).toEqual(['a', 'a1', 'b'])
  expect(auto.items[2]!.collapsed).toBe(true)
  expect(treeItems(list, { a: true }, 'a1', true).at).toBe('a')
  expect(treeItems(list, { b: false }, 'a1', true).items.map(i => i.a.id)).toEqual(['a', 'a1', 'b', 'b1'])
  expect(treeItems(list, {}, 'gone', false).at).toBeUndefined()
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
  const ui = await mount($, 40)
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
  const ui = await mount($, 40)
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
  const ui = await mount($, 40)
  await ui.press({ key: 'm0-w1' })
  await ui.press({ key: 'back' })
  expect(await hot(ui, 'm0-w1')).toBeDefined()
  await ui.unmount()
})

test('c folds and unfolds the highlighted manager', async ($, on) => {
  await setup($, on, fleet(2, 2))
  const ui = await mount($, 60)
  expect(await ui.find({ type: 'Button', key: 'm0-w0' })).toBeDefined()
  await ui.press({ key: 'nav-fold' })
  expect(await ui.find({ type: 'Button', key: 'm0-w0' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'm1-w0' })).toBeDefined()
  await ui.press({ key: 'nav-fold' })
  expect(await ui.find({ type: 'Button', key: 'm0-w0' })).toBeDefined()
  await ui.unmount()
})

test('scrolling keeps the highlight in view', async ($, on) => {
  await setup($, on, fleet(1, 12))
  const ui = await mount($, 9)
  for (let i = 0; i < 9; i++) await ui.press({ key: 'nav-next' })
  expect(await hot(ui, 'm0-w8')).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /↑ \d+ above/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\+\d+ more/ })).toBeDefined()
  for (let i = 0; i < 20; i++) await ui.press({ key: 'nav-next' })
  expect(await hot(ui, 'm0-w11')).toBeDefined()
  await ui.unmount()
})

test('no g hotkey anywhere in the tree', async ($, on) => {
  await setup($, on, fleet(2, 2))
  const ui = await mount($, 40)
  const keys = (await ui.findAll({ type: 'Button' })).map(b => (b.props as { hotkey?: string }).hotkey)
  expect(keys).not.toContain('g')
  expect(keys).toContain('j')
  await ui.unmount()
})

test('20 managers with 60 workers render fast, with the highlight in view', async ($, on) => {
  await setup($, on, fleet(20, 3))
  for (let i = 0; i < 20; i++) {
    await $.tool.call({ tool: 'Edit', file_path: `src/f${i}.ts`, agentId: `m${i}-w0` } as never)
  }
  const ui = await mount($, 30)
  const t0 = performance.now()
  expect(await ui.find({ type: 'Text', text: /80 agents/ })).toBeDefined()
  for (let i = 0; i < 25; i++) await ui.press({ key: 'nav-next' })
  const ms = performance.now() - t0
  ;(globalThis as { console?: { log(s: string): void } }).console?.log(`render+25 presses: ${ms.toFixed(0)}ms`)
  expect(ms).toBeLessThan(500)
  expect(await ui.find({ type: 'Text', text: /super manager/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'nav-next' })).toBeDefined()
  // Twenty presses end on the last manager, folded to one line; the window scrolled to it.
  expect(await hot(ui, 'm19')).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'm19-w0' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /↑ \d+ above/ })).toBeDefined()
  await ui.unmount()
})
