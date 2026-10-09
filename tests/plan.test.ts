import type { AgentInfo } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const run = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const pr = (branch: string) => JSON.stringify({ state: 'OPEN', isDraft: false, headRefOid: 'abc1234def5678', headRefName: branch, title: `PR ${branch}`, body: '## Verification\nRan:\n- `bun test`: pass\nExercised: ran it\nNot verified:\n- full check' })

type Sent = { to: string; text: string }

// A session with a manager "csv-export" (m1) and whatever else the test pushes onto `agents`.
function session(on: Parameters<TestBody>[1], branch = 'flow/csv') {
  const clock = mock.clock(on, { now: 1_000_000 })
  const agents: AgentInfo[] = [
    { id: 'm1', name: 'csv-export', description: 'm', type: 'flow:manager', status: 'running' },
  ]
  const sent: Sent[] = []
  const submitted: string[] = []
  const spawned: string[] = []
  on('agent.list', () => ({ value: agents }))
  on('agent.spawn', ($, e) => {
    const input = e as unknown as { subagent_type?: string; subagentType?: string; name?: string; description: string }
    const type = input.subagent_type ?? input.subagentType ?? ''
    spawned.push(type)
    const id = `a${spawned.length}`
    agents.push({ id, name: input.name, description: input.description, type, status: 'running', parentId: (e as { parentAgentId?: string }).parentAgentId })
    return { model: 'sonnet', agentId: id }
  })
  on('session.send', (_$, e) => {
    const raw = (e as unknown as { to: string | { agentId: string } }).to
    const to = typeof raw === 'string' ? raw : raw.agentId
    sent.push({ to, text: e.text })
    return { isDelivered: true }
  })
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('process.run', () => run(pr(branch)))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  return { clock, agents, sent, submitted, spawned }
}

const plan = ($: any, args: Record<string, unknown>, agentId: string | null = 'm1') =>
  $.tool.call({ tool: 'mcp__flow__plan', ...(agentId === null ? {} : { agentId }), ...args } as never).then((r: any) => String(r.result))

test('add, list, done by hand and remove; cycles and unknown dependencies are refused', async ($, on) => {
  session(on)
  const added = await plan($, { action: 'add', nodes: [{ id: 'csv', title: 'export' }, { id: 'login', title: 'redirect', after: ['csv'] }] })
  expect(added).toContain('- csv: ready')
  expect(added).toContain('- login: waiting | after: csv (ready)')

  expect(await plan($, { action: 'add', nodes: [{ id: 'x', after: ['nope'] }] })).toContain('unknown dependency')
  expect(await plan($, { action: 'add', nodes: [{ id: 'csv' }] })).toContain('duplicate')
  // A cycle needs an edge back: a node that comes after login and that csv would follow cannot be added, but a self loop is one.
  expect(await plan($, { action: 'add', nodes: [{ id: 'loop', after: ['loop'] }] })).toContain('cycle')

  expect(await plan($, { action: 'remove', id: 'csv' })).toContain('login still waits on csv')
  expect(await plan($, { action: 'list' })).toContain('- login: waiting')

  const done = await plan($, { action: 'done', id: 'csv', note: 'shipped elsewhere' })
  expect(done).toContain('- csv: done (shipped elsewhere)')
  expect(done).toContain('- login: ready')

  expect(await plan($, { action: 'remove', id: 'login' })).not.toContain('login')
})

test('spawn is refused for a waiting node and allowed for a ready one', async ($, on) => {
  const s = session(on)
  await plan($, { action: 'add', nodes: [{ id: 'csv' }, { id: 'login', after: ['csv'] }] })

  const refused = await $.agent.spawn({ prompt: 'b', description: 'login', name: 'login', subagentType: 'flow:worker', parentAgentId: 'm1' } as never)
  expect(JSON.stringify(refused)).toMatch(/waits on csv/)
  expect(s.spawned).toEqual([])

  await $.agent.spawn({ prompt: 'b', description: 'csv', name: 'csv', subagentType: 'flow:worker', parentAgentId: 'm1' } as never)
  expect(s.spawned).toEqual(['flow:worker'])
  expect(await plan($, { action: 'list' })).toContain('- csv: running')
})

test('a merged worker PR wakes the manager exactly once with the newly ready node', async ($, on) => {
  const s = session(on)
  await plan($, { action: 'add', nodes: [{ id: 'csv' }, { id: 'login', title: 'redirect', after: ['csv'] }] })
  s.agents.push({ id: 'w1', name: 'csv', description: 'w', type: 'flow:worker', status: 'running', parentId: 'm1' })

  await $.tool.call({ tool: 'mcp__flow__handover', pr: 7, verified: 'x', report_to: 'csv-export', agentId: 'm1' } as never)
  const q = s.agents.find(a => a.type === 'flow:queue')!
  expect(s.sent).toEqual([])

  await $.tool.call({ tool: 'mcp__flow__queue', action: 'done', pr: 7, sha: 'abc1234', report: 'ok', agentId: q.id } as never)
  expect(s.sent.length).toBe(1)
  expect(s.sent[0]!.to).toBe('m1')
  expect(s.sent[0]!.text).toContain('login')
  expect(s.sent[0]!.text).toContain('Ready to start')

  // Polls and refreshes afterwards say nothing more.
  await s.clock.advance(10_000)
  await $.tool.call({ tool: 'mcp__flow__status' } as never)
  expect(s.sent.length).toBe(1)
})

test('main is woken once when a manager node completes, and once for 15 ready nodes', async ($, on) => {
  const s = session(on)
  s.agents.length = 0
  s.agents.push({ id: 'a', name: 'alpha', description: 'a', type: 'flow:manager', status: 'running' })
  await plan($, { action: 'add', nodes: [{ id: 'alpha' }, { id: 'beta', title: 'second', after: ['alpha'] }] }, null)
  await s.clock.advance(10)
  expect(s.submitted).toEqual([])

  s.agents[0]!.status = 'completed'
  await $.tool.call({ tool: 'mcp__flow__status' } as never)
  await s.clock.advance(10)
  await $.tool.call({ tool: 'mcp__flow__status' } as never)
  await s.clock.advance(10)
  expect(s.submitted.length).toBe(1)
  expect(s.submitted[0]).toContain('beta')

  // 15 tasks wait on one running manager; its end makes them all ready in one pass.
  s.agents.push({ id: 'g', name: 'gamma', description: 'g', type: 'flow:manager', status: 'running' })
  await plan($, { action: 'add', nodes: [{ id: 'gamma' }] }, null)
  const nodes = Array.from({ length: 15 }, (_, i) => ({ id: `n${i}`, after: ['gamma'] }))
  await plan($, { action: 'add', nodes }, null)
  s.agents[1]!.status = 'completed'
  await $.tool.call({ tool: 'mcp__flow__status' } as never)
  await s.clock.advance(10)
  await $.tool.call({ tool: 'mcp__flow__status' } as never)
  await s.clock.advance(10)
  expect(s.submitted.length).toBe(2)
  expect(s.submitted[1]).toContain('n14')
})

test('status shows the manager limit and the plans', async ($, on) => {
  const s = session(on)
  await plan($, { action: 'add', nodes: [{ id: 'csv' }, { id: 'login', after: ['csv'] }] })
  const r = String((await $.tool.call({ tool: 'mcp__flow__status' } as never)).result)
  expect(r).toContain('Limits: managers 1/20')
  expect(r).toContain('Plans:')
  expect(r).toContain('csv-export:')
  expect(r).toContain('- login: waiting')
  void s
})

test('15 handovers back to back start one queue; a queue that ended with work left is restarted once', async ($, on) => {
  const s = session(on)
  await Promise.all(Array.from({ length: 15 }, (_, i) =>
    $.tool.call({ tool: 'mcp__flow__handover', pr: 100 + i, verified: 'x', report_to: 'csv-export', agentId: 'm1' } as never)))
  expect(s.spawned.filter(t => t === 'flow:queue').length).toBe(1)

  const q = s.agents.find(a => a.type === 'flow:queue')!
  q.status = 'completed'
  await s.clock.advance(5_000)
  await Promise.all([
    $.tool.call({ tool: 'mcp__flow__handover', pr: 200, verified: 'x', report_to: 'csv-export', agentId: 'm1' } as never),
    $.tool.call({ tool: 'mcp__flow__handover', pr: 201, verified: 'x', report_to: 'csv-export', agentId: 'm1' } as never),
  ])
  expect(s.spawned.filter(t => t === 'flow:queue').length).toBe(2)
})

test('a manager the host drops from its list keeps its last state and never reads as ready', async ($, on) => {
  const s = session(on)
  s.agents.length = 0
  s.agents.push({ id: 'a', name: 'alpha', description: 'a', type: 'flow:manager', status: 'running' })
  await plan($, { action: 'add', nodes: [{ id: 'alpha' }, { id: 'beta', after: ['alpha'] }] }, null)
  await s.clock.advance(10)
  s.agents.length = 0
  const listed = await plan($, { action: 'list' }, null)
  expect(listed).toContain('- alpha: running')
  expect(listed).toContain('- beta: waiting')
  await s.clock.advance(10)
  expect(s.submitted).toEqual([])
})
