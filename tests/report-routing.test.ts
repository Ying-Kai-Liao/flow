import type { AgentInfo } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const DIR = '/r/.git/flow'
const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const PR = { state: 'OPEN', isDraft: false, headRefOid: 'abc1234def5678', headRefName: 'flow/csv', title: 'Export', body: '## Verification\nRan:\n- `bun test`: pass\nExercised: ran it\nNot verified:\n- full check' }

// A manager csv-export (m1) with a worker csv-worker (w1) and a queue (q1); `agents` is editable.
function world(on: On) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const agents: AgentInfo[] = [
    { id: 'm1', name: 'csv-export', description: 'm', type: 'flow:manager', status: 'running' },
    { id: 'w1', name: 'csv-worker', description: 'w', type: 'flow:worker', status: 'running', parentId: 'm1' },
    { id: 'q1', name: 'merge-queue-1', description: 'q', type: 'flow:queue', status: 'running' },
  ]
  const files = new Map<string, string>()
  const prompts: string[] = []
  on('agent.list', () => ({ value: agents }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'q1' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => { prompts.push(e.text); return { text: e.text } })
  on('turn.complete', (_, e) => ({ text: e.answer }) as never)
  on('tool.call', () => ({ result: 'sent' }) as never)
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('fs.read', (_, e) => {
    const t = files.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('process.run', (_, e) => {
    if (e.argv[0] === 'git' && e.argv[1] === 'rev-parse') return ok('/r/.git\n')
    if (e.argv[0] === 'gh') return ok(JSON.stringify(PR))
    return ok()
  })
  return { agents, files, prompts, flush: async () => { await clock.advance(1); await clock.settle() } }
}

const handover = ($: Dollar, agentId: string | undefined, extra: Record<string, unknown> = {}) =>
  $.tool.call({ tool: 'mcp__flow__handover', pr: 7, ...extra, ...(agentId === undefined ? {} : { agentId }) } as never).then(r => String(r.result))
const list = ($: Dollar) => $.tool.call({ tool: 'mcp__flow__queue', action: 'list', agentId: 'q1' } as never).then(r => String(r.result))
const send = ($: Dollar, agentId: string | undefined, to: string, message: string) =>
  $.tool.call({ tool: 'SendMessage', to, message, ...(agentId === undefined ? {} : { agentId }) } as never).then(r => String(r.result))
const notes = (files: Map<string, string>) => files.get(`${DIR}/managers/csv-export/notes.md`) ?? ''

test('report_to defaults to the caller: a manager by name, main for the main session', async ($, on) => {
  world(on)
  expect(await handover($, 'm1')).toContain('reports back to csv-export')
  expect(await list($)).toContain('report_to: csv-export')
  expect(await handover($, undefined)).toContain('reports back to main')
})

test('a report_to naming no agent is refused with the caller\'s name, and nothing is recorded', async ($, on) => {
  world(on)
  const r = await handover($, 'm1', { report_to: 'decision-inbox' })
  expect(r).toMatch(/^Refused:/)
  expect(r).toContain('"csv-export"')
  expect(await list($)).toBe('No pending handovers.')
})

test('the caller\'s own worker as report_to is corrected to the caller, with a note', async ($, on) => {
  world(on)
  const r = await handover($, 'm1', { report_to: 'csv-worker' })
  expect(r).toContain('reports back to csv-export')
  expect(r).toContain('is your own worker')
  expect(await list($)).toContain('report_to: csv-export')
})

test('a name that exists but has ended is accepted', async ($, on) => {
  const w = world(on)
  w.agents.push({ id: 'm2', name: 'old-mgr', description: 'm', type: 'flow:manager', status: 'completed' })
  expect(await handover($, 'm1', { report_to: 'old-mgr' })).toContain('reports back to old-mgr')
})

test('the queue\'s message to an ended manager becomes a note plus a report to main; it is not sent', async ($, on) => {
  const w = world(on)
  w.agents[0]!.status = 'completed'
  const r = await send($, 'q1', 'csv-export', 'PR #7 merged abc1234')
  expect(r).toContain('Not sent')
  expect(notes(w.files)).toContain('PR #7 merged abc1234')
  await w.flush()
  expect(w.prompts.some(p => p.includes('PR #7 merged abc1234') && p.includes('csv-export'))).toBe(true)
})

test('an unknown name from the queue goes to main only; a live manager is messaged as usual', async ($, on) => {
  const w = world(on)
  expect(await send($, 'q1', 'decision-inbox', 'PR #7 merged')).toContain('Not sent')
  await w.flush()
  expect(w.prompts.length).toBe(1)
  expect(await send($, 'q1', 'csv-export', 'PR #8 merged')).toBe('sent')
  await w.flush()
  expect(w.prompts.length).toBe(1)
})

test('a manager the queue woke has its turn-end report forwarded to main, once', async ($, on) => {
  const w = world(on)
  w.agents[0]!.status = 'idle'
  await handover($, 'm1', { pr: 8 })
  await send($, 'q1', 'csv-export', 'PR #7 merged')
  await $.turn.complete({ turnId: 't', agentId: 'm1', answer: 'All done. PR #7 merged.' } as never)
  await w.flush()
  expect(w.prompts.filter(p => p.includes('All done. PR #7 merged.')).length).toBe(1)
  await $.turn.complete({ turnId: 't2', agentId: 'm1', answer: 'Again' } as never)
  await w.flush()
  expect(w.prompts.some(p => p.includes('Again'))).toBe(false)
})

test('a manager main woke is not forwarded, even after a queue message while it was idle', async ($, on) => {
  const w = world(on)
  w.agents[0]!.status = 'idle'
  await handover($, 'm1', { pr: 8 })
  await send($, 'q1', 'csv-export', 'PR #7 merged')
  await send($, undefined, 'csv-export', 'carry on')
  await $.turn.complete({ turnId: 't', agentId: 'm1', answer: 'Finished.' } as never)
  await w.flush()
  expect(w.prompts.some(p => p.includes('Finished.'))).toBe(false)
})

test('a message to a running manager joins its turn and marks nothing', async ($, on) => {
  const w = world(on)
  await send($, 'q1', 'csv-export', 'PR #7 merged')
  await $.turn.complete({ turnId: 't', agentId: 'm1', answer: 'Done.' } as never)
  await w.flush()
  expect(w.prompts.some(p => p.includes('Done.'))).toBe(false)
})

const queueDone = ($: Dollar, pr: number) =>
  $.tool.call({ tool: 'mcp__flow__queue', action: 'done', pr, sha: 'abc', report: 'ok', agentId: 'q1' } as never)

test('an idle manager whose last PR just merged is finished: noted, sent to main, not woken', async ($, on) => {
  const w = world(on)
  w.agents[0]!.status = 'idle'
  w.agents[1]!.status = 'completed'
  await handover($, 'm1')
  await queueDone($, 7)
  const r = await send($, 'q1', 'csv-export', 'PR #7 merged')
  expect(r).toContain('Not sent')
  expect(notes(w.files)).toContain('PR #7 merged')
  await w.flush()
  expect(w.prompts.some(p => p.includes('finished; not woken') && p.includes('PR #7 merged'))).toBe(true)
})

test('an idle manager with another open handover is woken', async ($, on) => {
  const w = world(on)
  w.agents[0]!.status = 'idle'
  w.agents[1]!.status = 'completed'
  await handover($, 'm1')
  await handover($, 'm1', { pr: 8 })
  await queueDone($, 7)
  expect(await send($, 'q1', 'csv-export', 'PR #7 merged')).toBe('sent')
})

test('an idle manager with planned nodes is woken', async ($, on) => {
  const w = world(on)
  w.agents[0]!.status = 'idle'
  w.agents[1]!.status = 'completed'
  await handover($, 'm1')
  await queueDone($, 7)
  await $.tool.call({ tool: 'mcp__flow__plan', action: 'add', nodes: [{ id: 'later', title: 'later' }], agentId: 'm1' } as never)
  expect(await send($, 'q1', 'csv-export', 'PR #7 merged')).toBe('sent')
})

test('a returned PR wakes an idle manager', async ($, on) => {
  const w = world(on)
  w.agents[0]!.status = 'idle'
  w.agents[1]!.status = 'completed'
  await handover($, 'm1')
  await $.tool.call({ tool: 'mcp__flow__queue', action: 'back', pr: 7, reason: 'head moved', agentId: 'q1' } as never)
  expect(await send($, 'q1', 'csv-export', 'PR #7 returned: head moved')).toBe('sent')
})

test('an idle manager with a live child is woken', async ($, on) => {
  const w = world(on)
  w.agents[0]!.status = 'idle'
  await handover($, 'm1')
  await queueDone($, 7)
  expect(await send($, 'q1', 'csv-export', 'PR #7 merged')).toBe('sent')
  expect(w.agents[1]!.parentId).toBe('m1')
})
