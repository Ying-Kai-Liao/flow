import type { AgentInfo } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PANE = { component: 'Pane', props: { title: 'Flow' } as never, requestId: 'flow' } as const

const PR = { state: 'OPEN', isDraft: false, headRefOid: 'abc1234def5678', headRefName: 'flow/csv', title: 'Export orders as CSV' }

test('a handed-over PR starts one merge queue, which works through it', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const agents: AgentInfo[] = [
    { id: 'm1', name: 'csv-export', description: 'csv export', type: 'flow-board:manager', status: 'running' },
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

  const first = await $.tool.call({ tool: 'mcp__flow-board__flow_handover', pr: 7, verified: 'npm test', report_to: 'csv-export', agentId: 'm1' } as never)
  expect(String(first.result)).toContain('Started merge queue')
  expect(spawned).toEqual(['flow-board:queue'])

  // A second handover while the queue runs doesn't start another.
  const second = await $.tool.call({ tool: 'mcp__flow-board__flow_handover', pr: 8, verified: 'npm test', report_to: 'csv-export', agentId: 'm1' } as never)
  expect(String(second.result)).toContain('running merge queue')
  expect(spawned.length).toBe(1)

  const list = await $.tool.call({ tool: 'mcp__flow-board__flow_queue', action: 'list', agentId: 'q1' } as never)
  expect(String(list.result)).toContain('#7 pending')
  expect(String(list.result)).toContain('report_to: csv-export')

  await $.tool.call({ tool: 'mcp__flow-board__flow_queue', action: 'done', pr: 7, sha: 'abc1234', report: 'full check: 12 passed', agentId: 'q1' } as never)
  await $.tool.call({ tool: 'mcp__flow-board__flow_queue', action: 'back', pr: 8, reason: 'head moved', agentId: 'q1' } as never)
  const after = await $.tool.call({ tool: 'mcp__flow-board__flow_queue', action: 'list', agentId: 'q1' } as never)
  expect(String(after.result)).toBe('No pending handovers.')

  const status = await $.tool.call({ tool: 'mcp__flow-board__flow_status' } as never)
  expect(String(status.result)).toContain('#7 done')
  expect(String(status.result)).toContain('returned: head moved')
})

test('a draft PR is refused', async ($, on) => {
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify({ ...PR, isDraft: true }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  const r = await $.tool.call({ tool: 'mcp__flow-board__flow_handover', pr: 9, verified: 'x', report_to: 'm' } as never)
  expect(String(r.result)).toContain('is a draft')
})

test('managers cannot edit code; workers can', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('agent.list', () => ({ value: [
    { id: 'm1', name: 'csv-export', description: 'm', type: 'flow-board:manager', status: 'running' },
    { id: 'w1', name: 'csv', description: 'w', type: 'flow-board:worker', status: 'running', parentId: 'm1' },
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
    { id: 'm1', name: 'csv-export', description: 'm', type: 'flow-board:manager', status: 'running' },
    { id: 'w1', name: 'csv', description: 'w', type: 'flow-board:worker', status: 'running', parentId: 'm1' },
  ] as AgentInfo[] }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'w1' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  await $.agent.spawn({ prompt: 'brief', description: 'csv', subagentType: 'flow-board:worker' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'flow-board', surface, ...PANE })
    expect(await ui.find({ text: /manager csv-export/ })).toBeDefined()
    expect(await ui.find({ text: /worker csv/ })).toBeDefined()
    await ui.press({ key: 'm1' })
    expect(await ui.find({ type: 'Text', text: /1 under it/ })).toBeDefined()
    await ui.press({ key: 'back' })
    await ui.unmount()
  }
})
