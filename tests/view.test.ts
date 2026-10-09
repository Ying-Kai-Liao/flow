import type { AgentInfo } from 'claude-code'
import { expect, mock } from 'claude-code/testing'
import { test } from './support'
import type { TestBody } from 'claude-code/testing'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const row = (id: string, parentId?: string) =>
  ({ id, name: id, description: `d ${id}`, type: parentId ? 'flow:worker' : 'flow:manager', status: 'running', parentId }) as never

const agents = [row('m0'), row('m0-w0', 'm0'), row('m1')] as AgentInfo[]

async function setup($: Dollar, on: On, toasts: string[] = []) {
  mock.clock(on, { now: 1_000_000 })
  on('agent.list', () => ({ value: agents }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'm0' }))
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 200_000, tokens: 1000, percent: 1 } } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_: unknown, e: unknown) => { toasts.push(JSON.stringify(e)); return { value: undefined } })
  on('ui.focus', () => ({}))
  await $.agent.spawn({ prompt: 'brief', description: 'A task', subagentType: 'flow:manager' } as never)
}

// A view change is a new render with a new `view` prop; the state atoms live on in $.
const mount = ($: Dollar, agentId?: string) => $.ui.mount({
  plugin: 'flow', surface: 'terminal', component: 'Pane', requestId: 'flow',
  props: { title: 'Flow', view: agentId === undefined ? {} : { agentId } } as never,
  viewport: { columns: 100, rows: 40 },
} as never)

test('following an agent in the roster opens it', async ($, on) => {
  await setup($, on)
  const ui = await mount($, 'm0-w0')
  expect(await ui.find({ type: 'Button', key: 'back' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /d m0-w0/ })).toBeDefined()
  await ui.unmount()
})

test('returning to main restores the earlier selection', async ($, on) => {
  await setup($, on)
  const a = await mount($)
  await a.press({ key: 'm1' })
  await a.unmount()
  const b = await mount($, 'm0-w0')
  expect(await b.find({ type: 'Text', text: /d m0-w0/ })).toBeDefined()
  await b.unmount()
  const c = await mount($)
  expect(await c.find({ type: 'Text', text: /d m1/ })).toBeDefined()
  await c.unmount()
})

test('restoring from nothing selected returns to the tree', async ($, on) => {
  await setup($, on)
  const a = await mount($, 'm0')
  await a.unmount()
  const b = await mount($)
  expect(await b.find({ type: 'Button', key: 'back' })).toBeUndefined()
  await b.unmount()
})

test('a person who moved after following keeps their place on return', async ($, on) => {
  await setup($, on)
  const c = await mount($, 'm0')
  await c.press({ key: 'back' })
  await c.press({ key: 'm1' })
  await c.unmount()
  const d = await mount($)
  expect(await d.find({ type: 'Text', text: /d m1/ })).toBeDefined()
  await d.unmount()
})

test('an agent id that is not in the roster is ignored', async ($, on) => {
  await setup($, on)
  const ui = await mount($, 'ghost')
  expect(await ui.find({ type: 'Button', key: 'back' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /3 agents/ })).toBeDefined()
  await ui.unmount()
})

test('the first card click toasts how to see its chat, once; the detail view then keeps the line', async ($, on) => {
  const toasts: string[] = []
  await setup($, on, toasts)
  const ui = await mount($)
  await ui.press({ key: 'm0' })
  expect(toasts.filter(t => /To see its chat/.test(t))).toHaveLength(1)
  expect(await ui.find({ type: 'Text', text: /To see its chat: ← then pick m0/ })).toBeDefined()
  await ui.press({ key: 'back' })
  await ui.press({ key: 'm1' })
  expect(toasts.filter(t => /To see its chat/.test(t))).toHaveLength(1)
  await ui.unmount()
})

test('acting while following wins until the view changes', async ($, on) => {
  await setup($, on)
  const a = await mount($, 'm0')
  await a.press({ key: 'back' })
  expect(await a.find({ type: 'Button', key: 'back' })).toBeUndefined()
  await a.unmount()
  // Same view, new draw: the person's choice still stands.
  const b = await mount($, 'm0')
  expect(await b.find({ type: 'Button', key: 'back' })).toBeUndefined()
  await b.unmount()
  // Another agent in view follows again.
  const c = await mount($, 'm1')
  expect(await c.find({ type: 'Text', text: /d m1/ })).toBeDefined()
  await c.unmount()
})
