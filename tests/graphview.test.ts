import type { AgentInfo } from 'claude-code'
import { expect, mock } from 'claude-code/testing'
import { test } from './support'
import type { TestBody } from 'claude-code/testing'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const PANE = { component: 'Pane', props: { title: 'Flow' } as never, requestId: 'flow' } as const

const mgr = (id: string, status = 'running') =>
  ({ id, name: id, description: `d ${id}`, type: 'flow:manager', status }) as AgentInfo
const wrk = (id: string, parentId: string) =>
  ({ id, name: id, description: `d ${id}`, type: 'flow:worker', status: 'running', parentId }) as AgentInfo

// Manager "a" (running, with two workers) is planned first; "b" waits on it and has no agent.
async function setup($: Dollar, on: On, agents: AgentInfo[], nodes: unknown[]) {
  mock.clock(on, { now: 1_000_000 })
  const toasts: string[] = []
  on('agent.list', () => ({ value: agents }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: agents[0]!.id }))
  on('tool.call', () => ({ result: 'ok' }))
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 200_000, tokens: 1000, percent: 1 } } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => { toasts.push(e.text); return { value: undefined } })
  on('ui.focus', () => ({}))
  await $.agent.spawn({ prompt: 'brief', description: 'A task', subagentType: 'flow:manager' } as never)
  await $.tool.call({ tool: 'mcp__flow__plan', action: 'add', nodes } as never)
  return toasts
}

const mount = ($: Dollar, columns = 100, rows = 40) => $.ui.mount({
  plugin: 'flow', surface: 'terminal', ...PANE, viewport: { columns, rows },
} as never)

const hot = (ui: Awaited<ReturnType<typeof mount>>, text: RegExp) =>
  ui.find({ type: 'Text', text, inverse: true } as never)

const PLAN = [{ id: 'a', title: 'first' }, { id: 'b', title: 'second', after: ['a'] }]
const FLEET = [mgr('a'), wrk('a-w0', 'a'), wrk('a-w1', 'a')]

test('g toggles the graph and back', async ($, on) => {
  await setup($, on, FLEET, PLAN)
  const ui = await mount($)
  expect(await ui.find({ type: 'Text', text: /· graph$/ })).toBeUndefined()
  await ui.press({ key: 'toggle-view' })
  expect(await ui.find({ type: 'Text', text: /· graph$/ })).toBeDefined()
  await ui.press({ key: 'toggle-view' })
  expect(await ui.find({ type: 'Text', text: /· graph$/ })).toBeUndefined()
  await ui.unmount()
})

test('the top level shows a waiting node without an agent and a manager with a workers badge', async ($, on) => {
  await setup($, on, FLEET, PLAN)
  const ui = await mount($)
  await ui.press({ key: 'toggle-view' })
  expect(await ui.find({ type: 'Text', text: /○ b/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\+2 workers/ })).toBeDefined()
  await ui.unmount()
})

test('j and l move the highlight; o opens a running node and toasts for a waiting one', async ($, on) => {
  const toasts = await setup($, on, FLEET, PLAN)
  const ui = await mount($)
  await ui.press({ key: 'toggle-view' })
  expect(await hot(ui, /a/)).toBeDefined()
  await ui.press({ key: 'g-l' })
  await ui.press({ key: 'g-j' })
  await ui.press({ key: 'g-l' })
  expect(await hot(ui, /b/)).toBeDefined()
  await ui.press({ key: 'g-open' })
  expect(toasts.join('|')).toMatch(/is waiting/)
  await ui.press({ key: 'g-h' })
  expect(await hot(ui, /a/)).toBeDefined()
  await ui.press({ key: 'g-open' })
  expect(await ui.find({ type: 'Text', text: /a-w0/ })).toBeDefined()
  await ui.unmount()
})

test('a narrow pane falls back to the list with after:', async ($, on) => {
  await setup($, on, FLEET, PLAN)
  const ui = await mount($, 30)
  await ui.press({ key: 'toggle-view' })
  expect(await ui.find({ type: 'Text', text: /after:/ })).toBeDefined()
  await ui.unmount()
})

test('many nodes get a more line', async ($, on) => {
  const nodes = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, title: `t${i}`, ...(i > 0 ? { after: [`n${i - 1}`] } : {}) }))
  await setup($, on, FLEET, nodes)
  const ui = await mount($, 100, 12)
  await ui.press({ key: 'toggle-view' })
  expect(await ui.find({ type: 'Text', text: /more$/ })).toBeDefined()
  await ui.unmount()
})

test("a manager's detail view toggles to its workers' graph", async ($, on) => {
  await setup($, on, FLEET, PLAN)
  const ui = await mount($)
  await ui.press({ key: 'a' })
  await ui.press({ key: 'toggle-view' })
  expect(await ui.find({ type: 'Text', text: /a-w0/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'g-j' })).toBeDefined()
  await ui.press({ key: 'toggle-view' })
  expect(await ui.find({ type: 'Button', key: 'g-j' })).toBeUndefined()
  await ui.unmount()
})
