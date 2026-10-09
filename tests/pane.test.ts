import type { AgentInfo } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PANE = { component: 'Pane', props: { title: 'Flow' } as never, requestId: 'flow' } as const

const AGENTS: AgentInfo[] = [
  { id: 'w1', name: 'fix-login', description: 'Fix the login bug', type: 'flow:worker', status: 'running' },
  { id: 'w2', name: 'docs', description: 'Update docs', type: 'flow:worker', status: 'completed' },
]

test('the pane lists workers, shows what one did, and goes back', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('agent.list', () => ({ value: AGENTS }))
  on('agent.spawn', ($, e) => ({ model: 'sonnet', agentId: e.description === 'Update docs' ? 'w2' : 'w1' }))
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))

  await $.agent.spawn({ prompt: 'brief 1', description: 'Fix the login bug', subagentType: 'flow:worker' } as never)
  await $.agent.spawn({ prompt: 'brief 2', description: 'Update docs', subagentType: 'flow:worker' } as never)
  await $.tool.call({ tool: 'Edit', file_path: 'src/login.ts', agentId: 'w1' } as never)
  await $.tool.call({ tool: 'Read', file_path: 'MAIN-ONLY.md' } as never)
  await $.turn.complete({ answer: 'Done. PR #7 is open.', agentId: 'w2', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'flow', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /2 agents · 1 live/ })).toBeDefined()
    expect(await ui.find({ text: /Edit src\/login\.ts/ })).toBeDefined()
    expect(await ui.find({ text: /MAIN-ONLY/ })).toBeUndefined()

    await ui.press({ key: 'w2' })
    expect(await ui.find({ type: 'Text', text: /PR #7 is open/ })).toBeDefined()

    await ui.press({ key: 'back' })
    expect(await ui.find({ type: 'Text', text: /2 agents · 1 live/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the pane roots the tree at the main session and walks children and back', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('agent.list', () => ({ value: [
    { id: 'm1', name: 'task', description: 'A task', type: 'flow:manager', status: 'running' },
    { id: 'w1', name: 'fix-login', description: 'Fix it', type: 'flow:worker', status: 'completed', parentId: 'm1' },
  ] as AgentInfo[] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'm1' }))

  await $.agent.spawn({ prompt: 'brief', description: 'A task', subagentType: 'flow:manager' } as never)
  const ui = await $.ui.mount({ plugin: 'flow', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /main.*super manager/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'm1' })).toBeDefined()

  await ui.press({ key: 'm1' })
  expect(await ui.find({ type: 'Text', text: /Under it/ })).toBeDefined()
  await ui.press({ key: 'w1' })
  expect(await ui.find({ type: 'Text', text: /Fix it/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Under it/ })).toBeUndefined()

  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Text', text: /Under it/ })).toBeDefined()
  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Text', text: /super manager/ })).toBeDefined()
  await ui.unmount()
})

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const TREE: AgentInfo[] = [
  { id: 'm1', name: 'task', description: 'A task', type: 'flow:manager', status: 'running' },
  { id: 'w1', name: 'fix-login', description: 'Fix the login bug', type: 'flow:worker', status: 'running', parentId: 'm1' },
  { id: 'w2', name: 'docs', description: 'Update docs', type: 'flow:worker', status: 'completed', parentId: 'm1' },
]

// Main's context: `tokens` of a 200k window, or unknown. A subagent step uses 84k (60k + 24k cached).
async function setup($: Dollar, on: On, tokens?: number) {
  mock.clock(on, { now: 1_000_000 })
  on('agent.list', () => ({ value: TREE }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'w1' }))
  on('session.usage', () => ({ value: {
    startedAt: 0, rateLimits: [],
    context: { window: 200_000, tokens, percent: tokens === undefined ? undefined : Math.round(tokens / 2000) },
  } }))
  on('turn.step', async function* () {
    return {
      turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { model: 'sonnet', input_tokens: 60_000, output_tokens: 5, cache_read_input_tokens: 24_000, cache_creation_input_tokens: 0 },
    } as never
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  await $.agent.spawn({ prompt: 'brief', description: 'A task', subagentType: 'flow:manager' } as never)
}

const mount = ($: Dollar, rows?: number) => $.ui.mount({
  plugin: 'flow', surface: 'terminal', ...PANE, ...(rows === undefined ? {} : { viewport: { columns: 100, rows } }),
} as never)

// A streaming event: read the stream to its end, as the engine does, so the hooks over it see the result.
const step = async ($: Dollar, agentId?: string) => {
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'sonnet', messageCount: 1, agentId } as never)
  for await (const chunk of stream) void chunk
  return stream.result
}

test('cards show role, name and a second line, the main meter, and a card opens its agent', async ($, on) => {
  await setup($, on, 84_000)
  const ui = await mount($)
  expect(await ui.find({ type: 'Text', text: /42% · 84k\/200k/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /manager task/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /A task.*2 under it/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Fix the login bug/ })).toBeDefined()
  await ui.press({ key: 'm1' })
  expect(await ui.find({ type: 'Text', text: /Under it/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Update docs/ })).toBeDefined()
  await ui.press({ key: 'w2' })
  expect(await ui.find({ type: 'Text', text: /Under it/ })).toBeUndefined()
  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Text', text: /Under it/ })).toBeDefined()
  await ui.unmount()
})

test('a subagent meter comes from its turn.step; unknown usage shows no number', async ($, on) => {
  await setup($, on)
  const before = await mount($)
  expect(await before.find({ type: 'Text', text: /\d+% ·/ })).toBeUndefined()
  expect(await before.find({ type: 'Text', text: /context \?/ })).toBeDefined()
  await before.unmount()

  await step($, 'w1')
  const ui = await mount($)
  expect(await ui.find({ type: 'Text', text: /42% · 84k\/200k/ })).toBeDefined()
  await ui.unmount()
})

test('the meter marks the threshold (default 40) and goes yellow at or past it', async ($, on) => {
  await setup($, on, 84_000)
  const ui = await mount($)
  // 12 cells: the marker sits at cell 4 (40%), 42% fills 5 cells.
  const meter = await ui.find({ type: 'Text', text: /█{4}│░{7} 42%/ })
  expect(meter).toBeDefined()
  expect(JSON.stringify(meter)).toContain('yellow')
  await ui.unmount()
})

test('a configured threshold moves the marker and the colour', { options: { context_warn_percent: 60 } }, async ($, on) => {
  await setup($, on, 84_000)
  const ui = await mount($)
  const meter = await ui.find({ type: 'Text', text: /█{5}░{2}│░{4} 42%/ })
  expect(meter).toBeDefined()
  expect(JSON.stringify(meter)).not.toContain('yellow')
  await ui.unmount()
})

test('a short viewport gives compact rows, then "+N more", keeping the header and the root', async ($, on) => {
  await setup($, on, 84_000)
  const roomy = await mount($, 12)
  expect(await roomy.find({ type: 'Button', key: 'w2' })).toBeDefined()
  expect(await roomy.find({ type: 'Text', text: /\+\d+ more/ })).toBeUndefined()
  await roomy.unmount()

  const tiny = await mount($, 4)
  expect(await tiny.find({ type: 'Text', text: /3 agents/ })).toBeDefined()
  expect(await tiny.find({ type: 'Text', text: /super manager/ })).toBeDefined()
  expect(await tiny.find({ type: 'Text', text: /\+\d+ more/ })).toBeDefined()
  await tiny.unmount()
})
