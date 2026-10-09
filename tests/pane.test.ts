import type { AgentInfo } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import { elapsed, summarizeCall, tokensDown } from '../hooks/register'

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
  on('session.send', () => ({ isDelivered: true as const }))
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
    // The card shows a short summary; the raw call is in the detail view's log.
    expect(await ui.find({ text: /editing login\.ts/ })).toBeDefined()
    expect(await ui.find({ text: /Edit src\/login\.ts/ })).toBeUndefined()
    expect(await ui.find({ text: /MAIN-ONLY/ })).toBeUndefined()

    await ui.press({ key: 'w1' })
    expect(await ui.find({ text: /Edit src\/login\.ts/ })).toBeDefined()
    await ui.press({ key: 'back' })

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
  const ui = await mount($, 40)
  expect(await ui.find({ type: 'Text', text: /42%.*↓ 84\.0k tokens/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /manager/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /A task/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\(\+2\)/ })).toBeDefined()
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
  expect(await before.find({ type: 'Text', text: /\d+%.*↓/ })).toBeUndefined()
  expect(await before.find({ type: 'Text', text: /context \?/ })).toBeDefined()
  await before.unmount()

  await step($, 'w1')
  const ui = await mount($)
  expect(await ui.find({ type: 'Text', text: /42%.*↓ 84\.0k tokens/ })).toBeDefined()
  await ui.unmount()
})

test('the meter marks the threshold (default 40) and goes warning-coloured at or past it', async ($, on) => {
  await setup($, on, 84_000)
  const ui = await mount($)
  // 12 cells: the marker sits at cell 4 (40%), 42% fills 5 cells.
  const meter = await ui.find({ type: 'Text', text: /█{4}│░{7} 42%/ })
  expect(meter).toBeDefined()
  expect(JSON.stringify(meter)).toContain('"warning"')
  await ui.unmount()
})

test('a configured threshold moves the marker and the colour', { options: { context_warn_percent: 60 } }, async ($, on) => {
  await setup($, on, 84_000)
  const ui = await mount($)
  const meter = await ui.find({ type: 'Text', text: /█{5}░{2}│░{4} 42%/ })
  expect(meter).toBeDefined()
  expect(JSON.stringify(meter)).not.toContain('warning')
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

// The engine's pane record, as a test answers `ui.open`, `ui.close` and `ui.panes` beneath the plugin.
function paneHost(on: On): { isOpen: () => boolean; opens: () => number } {
  let open = false
  let opens = 0
  on('ui.open', () => { open = true; opens++; return { value: { isPlaced: true } } })
  on('ui.close', () => { open = false; return { value: undefined } })
  on('ui.panes', () => ({ value: open ? [{ id: 'flow', title: 'Flow', isShown: true, isFocused: false, isPlaced: true }] : [] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  return { isOpen: () => open, opens: () => opens }
}

test('/flow opens the pane and /flow close closes it', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('agent.list', () => ({ value: [] }))
  const host = paneHost(on)

  expect((await $.command.run({ command: 'flow', args: 'close' } as never)).text).toBe('The Flow pane is not open.')

  expect((await $.command.run({ command: 'flow' } as never)).text).toBe('Flow pane opened.')
  expect(host.isOpen()).toBe(true)

  expect((await $.command.run({ command: 'flow', args: ' close ' } as never)).text).toBe('Flow pane closed.')
  expect(host.isOpen()).toBe(false)

  expect((await $.command.run({ command: 'flow', args: 'shut' } as never)).text).toContain('Unknown argument "shut"')
  expect(host.isOpen()).toBe(false)
})

test('a closed pane stays closed while agents run, until a new agent starts', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const agents: AgentInfo[] = [
    { id: 'm1', name: 'task', description: 'A task', type: 'flow:manager', status: 'running' },
  ]
  on('agent.list', () => ({ value: agents }))
  on('agent.spawn', ($, e) => {
    const id = e.description === 'A task' ? 'm1' : 'w1'
    if (id === 'w1') agents.push({ id, name: 'fix', description: 'Fix it', type: 'flow:worker', status: 'running', parentId: 'm1' })
    return { model: 'sonnet', agentId: id }
  })
  const host = paneHost(on)

  await $.agent.spawn({ prompt: 'brief', description: 'A task', subagentType: 'flow:manager' } as never)
  await clock.settle()
  expect(host.isOpen()).toBe(true)

  await $.command.run({ command: 'flow', args: 'close' } as never)
  const opensBefore = host.opens()
  // Roster refreshes: the poll and a status call.
  await clock.advance(10_000)
  await $.tool.call({ tool: 'mcp__flow__status' } as never)
  expect(host.isOpen()).toBe(false)
  expect(host.opens()).toBe(opensBefore)

  await $.agent.spawn({ prompt: 'brief', description: 'Fix it', subagentType: 'flow:worker' } as never)
  await clock.settle()
  expect(host.isOpen()).toBe(true)
})

const RAW = /"(yellow|red|green|cyan|gray|white)"/

test('the pane paints with theme keys, in a light and a dark theme', async ($, on) => {
  on('config.set', (_, e) => ({ value: e.value }))
  await setup($, on, 190_000)
  for (const theme of ['light', 'dark']) {
    await $.config.set({ key: 'theme', value: theme } as never)
    const ui = await mount($)
    const meter = JSON.stringify(await ui.find({ type: 'Text', text: /95%.*↓ 190\.0k tokens/ }))
    expect(meter).toContain('"error"')
    const running = JSON.stringify(await ui.find({ type: 'Text', text: '●' }))
    expect(running).toContain('"suggestion"')
    const done = JSON.stringify(await ui.find({ type: 'Text', text: '✓' }))
    expect(done).toContain('"success"')
    for (const j of [meter, running, done]) expect(j).not.toMatch(RAW)
    await ui.unmount()
  }
})

test('a theme change redraws the pane and leaves the value alone', async ($, on) => {
  on('config.set', (_, e) => ({ value: e.value }))
  await setup($, on, 84_000)
  const ui = await mount($)
  await $.config.set({ key: 'theme', value: 'light' } as never)
  expect(await ui.find({ type: 'Text', text: /42%.*↓ 84\.0k tokens/ })).toBeDefined()
  await ui.unmount()
  await $.config.set({ key: 'theme', value: 'dark' } as never)
})

test('summarizeCall gives a short human line and never code', () => {
  const heredoc = summarizeCall({ tool: 'Bash', command: "cat > a.ts <<'EOF'\nconst secret = 1\nEOF" })
  expect(heredoc).toBe('running a command')
  expect(heredoc).not.toContain('secret')
  expect(summarizeCall({ tool: 'Bash', command: 'bun test tests/' })).toBe('running tests')
  expect(summarizeCall({ tool: 'Bash', command: 'tsc -p .' })).toBe('running tests')
  expect(summarizeCall({ tool: 'Bash', command: 'git push -u origin HEAD' })).toBe('git push')
  expect(summarizeCall({ tool: 'Bash', command: 'git commit -m "add test"' })).toBe('git commit')
  expect(summarizeCall({ tool: 'Bash', command: 'gh pr create --base main' })).toBe('gh pr create')
  expect(summarizeCall({ tool: 'Edit', file_path: '/a/b/src/login.ts' })).toBe('editing login.ts')
  expect(summarizeCall({ tool: 'Write', file_path: 'x/new.md' })).toBe('writing new.md')
  expect(summarizeCall({ tool: 'Read', file_path: 'README.md' })).toBe('reading README.md')
  expect(summarizeCall({ tool: 'Grep', pattern: 'foo' })).toBe('searching')
  expect(summarizeCall({ tool: 'Agent', subagent_type: 'flow:worker', name: 'csv', prompt: 'long brief' })).toBe('started worker csv')
  expect(summarizeCall({ tool: 'WebFetch', url: 'https://x.y' })).toBe('WebFetch')
})

test('cards have no brackets, and the description shows only while there is no activity', async ($, on) => {
  on('tool.call', () => ({ result: 'ok' }))
  await setup($, on, 84_000)
  const ui = await mount($, 40)
  expect(await ui.find({ type: 'Text', text: /Fix the login bug/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\[.*\]/ })).toBeUndefined()
  await ui.unmount()

  await $.tool.call({ tool: 'Bash', command: "cat > a.ts <<'EOF'\nsecret code\nEOF", agentId: 'w1' } as never)
  const busy = await mount($, 40)
  expect(await busy.find({ type: 'Text', text: /running a command/ })).toBeDefined()
  expect(await busy.find({ type: 'Text', text: /secret code/ })).toBeUndefined()
  expect(await busy.find({ type: 'Text', text: /Fix the login bug/ })).toBeUndefined()
  expect(await busy.find({ type: 'Text', text: /\[.*\]/ })).toBeUndefined()
  // The detail view keeps the description.
  await busy.press({ key: 'w1' })
  expect(await busy.find({ type: 'Text', text: /Fix the login bug/ })).toBeDefined()
  await busy.unmount()
})

test('elapsed time reads 12s, 1m 43s, 1h 5m, and tokens one decimal', () => {
  expect(elapsed(12_000)).toBe('12s')
  expect(elapsed(103_000)).toBe('1m 43s')
  expect(elapsed(3_900_000)).toBe('1h 5m')
  expect(tokensDown(84_000)).toBe('↓ 84.0k tokens')
})

test('a card shows (+N) after the name, and elapsed time with tokens in the meter', async ($, on) => {
  await setup($, on, 84_000)
  const ui = await mount($, 40)
  expect(await ui.find({ type: 'Text', text: /\(\+2\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /42%.*\d+s · ↓ 84\.0k tokens/ })).toBeDefined()
  await ui.unmount()
})

test('time ticks for a live agent and is frozen for an ended one', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const agents: AgentInfo[] = [
    { id: 'w1', name: 'live', description: 'Live', type: 'flow:worker', status: 'running' },
  ]
  on('agent.list', () => ({ value: agents }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'w1' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('turn.step', async function* () {
    return { turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: { model: 'sonnet', input_tokens: 1000, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never
  })
  await $.agent.spawn({ prompt: 'brief', description: 'Live', subagentType: 'flow:worker' } as never)
  await step($, 'w1')
  const ui = await mount($, 40)
  const time = async () => /(\d+[smh](?: \d+[smh])?) · ↓ 1\.0k tokens/.exec(JSON.stringify(await ui.find({ type: 'Text', text: /↓ 1\.0k tokens/ })))?.[1]
  const first = await time()
  expect(first).toBeDefined()
  await clock.advance(5_000)
  await $.tool.call({ tool: 'mcp__flow__status' } as never)
  const later = await time()
  expect(later).not.toBe(first)
  agents[0]!.status = 'completed'
  await clock.advance(10_000)
  await $.tool.call({ tool: 'mcp__flow__status' } as never)
  const ended = await time()
  await clock.advance(30_000)
  await $.tool.call({ tool: 'mcp__flow__status' } as never)
  expect(await time()).toBe(ended)
  await ui.unmount()
})

test('usage unknown shows context ? and no tokens', async ($, on) => {
  await setup($, on)
  const ui = await mount($, 40)
  expect(await ui.find({ type: 'Text', text: /context \?/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /tokens/ })).toBeUndefined()
  await ui.unmount()
})

// An agent past its threshold is told to wrap up by its next turn.step (84k of 200k is past 40%).
const wrapUp = async ($: Dollar, on: On) => {
  await step($, 'w1')
}
const finish = ($: Dollar, answer: string) =>
  $.turn.complete({ answer, agentId: 'w1', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)
const statusText = async ($: Dollar) => String((await $.tool.call({ tool: 'mcp__flow__status' } as never)).result)

test('a live agent told to wrap up shows a handoff badge and "wrapping up (told at N%)"', async ($, on) => {
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.send', () => ({ isDelivered: true as const }))
  await setup($, on, 84_000)
  const ui = await mount($, 40)
  expect(await ui.find({ type: 'Text', text: /wrapping up/ })).toBeUndefined()
  await ui.unmount()
  await wrapUp($, on)
  const ui2 = await mount($, 40)
  expect(await ui2.find({ type: 'Text', text: /handoff/ })).toBeDefined()
  expect(await ui2.find({ type: 'Text', text: /wrapping up \(told at \d+%\)/ })).toBeDefined()
  await ui2.press({ key: 'w1' })
  expect(await ui2.find({ type: 'Text', text: /Handoff: told .* ago at \d+%, \d+ reminders/ })).toBeDefined()
  await ui2.unmount()
})

test('a completed agent whose report ends with HANDOFF shows "handed off", others do not', async ($, on) => {
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.send', () => ({ isDelivered: true as const }))
  await setup($, on, 84_000)
  await finish($, 'All done.')
  const plain = await mount($, 40)
  expect(await plain.find({ type: 'Text', text: /handed off|wrapping up/ })).toBeUndefined()
  await plain.unmount()
  expect(await statusText($)).not.toMatch(/handoff|handed off/)
  await wrapUp($, on)
  expect(await statusText($)).toMatch(/fix-login.*\| handoff: wrapping up \(\d+%\)/)
  TREE[1]!.status = 'completed'
  try {
    await finish($, 'Stopped early.\nHANDOFF: flow/fix-login')
    const ui = await mount($, 40)
    expect(await ui.find({ type: 'Text', text: /handed off → flow\/fix-login/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /wrapping up/ })).toBeUndefined()
    await ui.unmount()
    expect(await statusText($)).toMatch(/fix-login.*\| handed off → flow\/fix-login/)
  } finally { TREE[1]!.status = 'running' }
})

// The Merge queue rows are JSX inside a map over the handovers; a parameter there named `h`
// once shadowed the JSX factory and blanked the whole pane, but only while a handover existed.
test('the pane draws a Merge queue row for every handover status', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const titles: Record<string, string> = { '7': 'Export CSV', '8': 'Fix login', '9': 'Update docs', '10': 'Bump deps' }
  on('agent.list', () => ({ value: [
    { id: 'm1', name: 'csv-export', description: 'm', type: 'flow:manager', status: 'running' },
    { id: 'q1', name: 'queue', description: 'q', type: 'flow:queue', status: 'running' },
  ] as AgentInfo[] }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'q1' }))
  on('process.run', (_, e) => {
    const pr = e.argv[3] ?? ''
    const view = { state: 'OPEN', isDraft: false, headRefOid: 'abc1234def5678', headRefName: `flow/p${pr}`, title: titles[pr], body: '## Verification\nRan:\n- `bun test`: pass\nExercised: ran it\nNot verified:\n- full check' }
    return { value: { exitCode: 0, stdout: JSON.stringify(view), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))

  for (const pr of [7, 8, 9, 10]) {
    await $.tool.call({ tool: 'mcp__flow__handover', pr, verified: 'x', report_to: 'csv-export', agentId: 'm1' } as never)
  }
  await $.tool.call({ tool: 'mcp__flow__queue', action: 'take', pr: 8, agentId: 'q1' } as never)
  await $.tool.call({ tool: 'mcp__flow__queue', action: 'done', pr: 9, sha: 'abc1234', report: 'ok', agentId: 'q1' } as never)
  await $.tool.call({ tool: 'mcp__flow__queue', action: 'back', pr: 10, reason: 'head moved', agentId: 'q1' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'flow', surface, ...PANE })
    expect(await ui.find({ text: /failed to draw/ })).toBeUndefined()
    expect(await ui.find({ text: /Merge queue/ })).toBeDefined()
    expect(await ui.find({ text: /#7 pending/ })).toBeDefined()
    expect(await ui.find({ text: /#8 taken/ })).toBeDefined()
    expect(await ui.find({ text: /#9 done/ })).toBeDefined()
    expect(await ui.find({ text: /#10 returned: head moved/ })).toBeDefined()
    expect(await ui.find({ text: /Export CSV/ })).toBeDefined()
    await ui.unmount()
  }
})
