import type { AgentInfo } from 'claude-code'
import { expect, mock } from 'claude-code/testing'
import { test } from './support'
import type { TestBody } from 'claude-code/testing'

const PANE = { component: 'Pane', props: { title: 'Flow' } as never, requestId: 'flow' } as const

const PR = { state: 'OPEN', isDraft: false, headRefOid: 'abc1234def5678', headRefName: 'flow/csv', title: 'Export orders as CSV', body: '## Verification\nRan:\n- `bun test`: pass\nExercised: ran it\nNot verified:\n- full check' }

test('a handed-over PR starts one reviewer, which works through it', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const agents: AgentInfo[] = [
    { id: 'm1', name: 'csv-export', description: 'csv export', type: 'flow:manager', status: 'running' },
  ]
  const spawned: string[] = []
  on('agent.list', () => ({ value: agents }))
  on('agent.spawn', ($, e) => {
    // The kit hands the spawn on as the Agent tool's input.
    const input = e as unknown as { subagent_type?: string; subagentType?: string; name?: string; description: string }
    const type = input.subagent_type ?? input.subagentType ?? ''
    spawned.push(type)
    agents.push({ id: 'q1', name: input.name, description: input.description, type, status: 'running' })
    return { model: 'sonnet', agentId: 'q1' }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(PR), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))

  const first = await $.tool.call({ tool: 'mcp__flow__handover', pr: 7, verified: 'npm test', report_to: 'csv-export', agentId: 'm1' } as never)
  expect(String(first.result)).toContain('Started reviewer')
  expect(spawned).toEqual(['flow:reviewer'])

  // A second handover while the queue runs doesn't start another.
  const second = await $.tool.call({ tool: 'mcp__flow__handover', pr: 8, verified: 'npm test', report_to: 'csv-export', agentId: 'm1' } as never)
  expect(String(second.result)).toContain('running reviewer')
  expect(spawned.length).toBe(1)

  const list = await $.tool.call({ tool: 'mcp__flow__queue', action: 'list', agentId: 'q1' } as never)
  expect(String(list.result)).toContain('#7 pending')
  expect(String(list.result)).toContain('report_to: csv-export')

  await $.tool.call({ tool: 'mcp__flow__queue', action: 'done', pr: 7, sha: 'abc1234', report: 'full check: 12 passed', agentId: 'q1' } as never)
  await $.tool.call({ tool: 'mcp__flow__queue', action: 'back', pr: 8, reason: 'head moved', agentId: 'q1' } as never)
  const after = await $.tool.call({ tool: 'mcp__flow__queue', action: 'list', agentId: 'q1' } as never)
  expect(String(after.result)).toBe('No pending handovers.')

  const status = await $.tool.call({ tool: 'mcp__flow__status' } as never)
  expect(String(status.result)).toContain('#7 done')
  expect(String(status.result)).toContain('returned: head moved')
})

// A mocked gh that serves `body` and a world with a manager; returns what was spawned.
function handoverWorld(on: Parameters<TestBody>[1], body: string) {
  mock.clock(on, { now: 1_000_000 })
  const agents: AgentInfo[] = [{ id: 'm1', name: 'csv-export', description: 'csv export', type: 'flow:manager', status: 'running' }]
  const spawned: string[] = []
  on('agent.list', () => ({ value: agents }))
  on('agent.spawn', ($, e) => {
    const input = e as unknown as { subagent_type?: string; subagentType?: string; name?: string; description: string }
    const type = input.subagent_type ?? input.subagentType ?? ''
    spawned.push(type)
    agents.push({ id: 'q1', name: input.name, description: input.description, type, status: 'running' })
    return { model: 'sonnet', agentId: 'q1' }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify({ ...PR, body }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  return spawned
}

const handover = ($: Parameters<TestBody>[0]) =>
  $.tool.call({ tool: 'mcp__flow__handover', pr: 7, report_to: 'csv-export', agentId: 'm1' } as never)
const queueList = ($: Parameters<TestBody>[0]) =>
  $.tool.call({ tool: 'mcp__flow__queue', action: 'list', agentId: 'q1' } as never)

test('a PR without a Verification section is refused: nothing recorded, no queue started', async ($, on) => {
  const spawned = handoverWorld(on, 'Just a summary, no proof.')
  const r = await handover($)
  expect(String(r.result)).toMatch(/^Refused:/)
  expect(String(r.result)).toContain('no `## Verification` section')
  expect(spawned).toEqual([])
  expect(String((await queueList($)).result)).toBe('No pending handovers.')
})

test('a Ran list missing a required worker check is refused by name', { options: { worker_checks: ['tsc -p .'] } }, async ($, on) => {
  const spawned = handoverWorld(on, PR.body)
  const r = await handover($)
  expect(String(r.result)).toMatch(/^Refused:/)
  expect(String(r.result)).toContain('required command `tsc -p .` does not appear under `Ran:`')
  expect(spawned).toEqual([])
})

test('an accepted handover carries its evidence to the queue list', async ($, on) => {
  const spawned = handoverWorld(on, PR.body)
  const r = await handover($)
  expect(String(r.result)).toContain('Started reviewer')
  expect(spawned).toEqual(['flow:reviewer'])
  const list = String((await queueList($)).result)
  expect(list).toContain('evidence: ran: `bun test`: pass')
  expect(list).toContain('exercised: ran it')
  expect(list).toContain('not verified: full check')
})

test('a draft PR is refused', async ($, on) => {
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify({ ...PR, isDraft: true }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  const r = await $.tool.call({ tool: 'mcp__flow__handover', pr: 9, verified: 'x', report_to: 'm' } as never)
  expect(String(r.result)).toContain('is a draft')
})

test('managers cannot edit code; workers can', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('agent.list', () => ({ value: [
    { id: 'm1', name: 'csv-export', description: 'm', type: 'flow:manager', status: 'running' },
    { id: 'w1', name: 'csv', description: 'w', type: 'flow:worker', status: 'running', parentId: 'm1' },
  ] as AgentInfo[] }))
  on('tool.call', () => ({ result: 'edited' }))

  const byManager = await $.tool.call({ tool: 'Edit', file_path: 'a.ts', old_string: 'a', new_string: 'b', agentId: 'm1' } as never)
  expect(JSON.stringify(byManager)).toContain("managers don't edit code")

  const byWorker = await $.tool.call({ tool: 'Edit', file_path: 'a.ts', old_string: 'a', new_string: 'b', agentId: 'w1' } as never)
  expect(byWorker.result).toBe('edited')
})

test('the pane draws workers under their manager, and the queue', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('agent.list', () => ({ value: [
    { id: 'm1', name: 'csv-export', description: 'm', type: 'flow:manager', status: 'running' },
    { id: 'w1', name: 'csv', description: 'w', type: 'flow:worker', status: 'running', parentId: 'm1' },
  ] as AgentInfo[] }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'w1' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  await $.agent.spawn({ prompt: 'brief', description: 'csv', subagentType: 'flow:worker' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'flow', surface, ...PANE })
    expect(await ui.find({ text: /csv-export/ })).toBeDefined()
    // The fold choice outlives a mount: open the manager only if its worker is still hidden.
    if (!await ui.find({ text: /worker/ })) await ui.press({ key: 'fold-m1' })
    expect(await ui.find({ text: /worker/ })).toBeDefined()
    await ui.press({ key: 'm1' })
    expect(await ui.find({ type: 'Text', text: /1 under it/ })).toBeDefined()
    await ui.press({ key: 'back' })
    await ui.unmount()
  }
})

test('/flow-tasks hands the source and selection to the super manager', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const sent: string[] = []
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  const r = await $.command.run({ command: 'flow-tasks', args: 'issues 12 14' } as never)
  expect(JSON.stringify(r)).toContain('Picking tasks from issues 12 14')
  await clock.advance(5)
  expect(sent.length).toBe(1)
  expect(sent[0]).toContain('flow:dispatch')
  expect(sent[0]).toContain('"issues 12 14"')
})

test('a live reviewer started under the old flow:queue type is not doubled, and both tool names work', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const agents: AgentInfo[] = [
    { id: 'm1', name: 'csv-export', description: 'csv export', type: 'flow:manager', status: 'running' },
    { id: 'q1', name: 'merge-queue-1', description: 'merge queue', type: 'flow:queue', status: 'running' },
  ]
  const spawned: string[] = []
  on('agent.list', () => ({ value: agents }))
  on('agent.spawn', ($, e) => {
    spawned.push((e as unknown as { subagentType?: string }).subagentType ?? '')
    return { model: 'sonnet', agentId: 'q2' }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(PR), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))

  const r = await $.tool.call({ tool: 'mcp__flow__handover', pr: 7, verified: 'npm test', report_to: 'csv-export', agentId: 'm1' } as never)
  expect(String(r.result)).toContain('running reviewer')
  expect(spawned).toEqual([])
  for (const tool of ['mcp__flow__reviewer', 'mcp__flow__queue']) {
    const list = await $.tool.call({ tool, action: 'list', agentId: 'q1' } as never)
    expect(String(list.result)).toContain('#7 pending')
  }
})
