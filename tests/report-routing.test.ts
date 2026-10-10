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
  const mainMsgs: { role: string; text: string }[] = []
  const gitCalls: string[][] = []
  const logs: string[] = []
  on('agent.list', () => ({ value: agents }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'q1' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => { prompts.push(e.text); return { text: e.text } })
  on('session.messages', () => ({ value: mainMsgs as never }))
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
    if (e.argv[0] === 'git' && e.argv[1] === 'worktree') return ok('worktree /main\nHEAD abc\nbranch refs/heads/main\n')
    if (e.argv[0] === 'git' && e.argv[1] === '-C') {
      gitCalls.push([...e.argv])
      if (e.argv.includes('--short')) return ok('abc1234\n')
      if (e.argv.includes('--show-current')) return ok('main\n')
      return ok()
    }
    if (e.argv[0] === 'sh' && e.argv[1] === '-c') logs.push(String(e.argv[4]))
    if (e.argv[0] === 'gh') return ok(JSON.stringify(PR))
    return ok()
  })
  return { agents, files, prompts, mainMsgs, gitCalls, logs, flush: async () => { await clock.advance(1); await clock.settle() }, flushLong: async () => { await clock.advance(5000); await clock.settle() } }
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
  await w.flushLong()
  expect(w.prompts.filter(p => p.includes('All done. PR #7 merged.')).length).toBe(1)
  await $.turn.complete({ turnId: 't2', agentId: 'm1', answer: 'Again' } as never)
  await w.flushLong()
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

test('an idle child with older activity does not keep an idle manager from finishing', async ($, on) => {
  const w = world(on)
  w.agents[0]!.status = 'idle'
  w.agents[1]!.status = 'idle'
  await handover($, 'm1')
  await queueDone($, 7)
  expect(await send($, 'q1', 'csv-export', 'PR #7 merged')).toContain('Not sent')
})

test('a child active after the manager wakes it', async ($, on) => {
  const w = world(on)
  w.agents[0]!.status = 'idle'
  w.agents[1]!.status = 'idle'
  await handover($, 'm1')
  await queueDone($, 7)
  // The manager's last activity is older than its worker's.
  await $.turn.complete({ turnId: 't', agentId: 'm1', answer: 'waiting' } as never)
  await w.flush()
  await $.turn.complete({ turnId: 't2', agentId: 'w1', answer: 'PR: x' } as never)
  expect(await send($, 'q1', 'csv-export', 'PR #7 merged')).toBe('sent')
})

test('a woken manager\'s answer already in main\'s transcript is not relayed again', async ($, on) => {
  const w = world(on)
  w.agents[0]!.status = 'idle'
  await handover($, 'm1', { pr: 8 })
  await send($, 'q1', 'csv-export', 'PR #7 merged')
  w.mainMsgs.push({ role: 'user', text: '<task-notification>\nAll done.   PR #7 merged.\n</task-notification>' })
  await $.turn.complete({ turnId: 't', agentId: 'm1', answer: 'All done. PR #7 merged.' } as never)
  await w.flushLong()
  expect(w.prompts.some(p => p.includes('Report from manager'))).toBe(false)
})

const REPORT = 'full check: 3 passed | after_deploy: none | pending decisions: none'

test('two reviewer sends about the same absent manager and PR reach main once', async ($, on) => {
  const w = world(on)
  w.agents[0]!.status = 'completed'
  expect(await send($, 'q1', 'csv-export', `PR #7 merged. ${REPORT}`)).toContain('Not sent')
  const second = await send($, 'q1', 'csv-export', `PR #7 merged abc. ${REPORT}`)
  expect(second).toContain('already forwarded')
  await w.flush()
  expect(w.prompts.length).toBe(1)
  expect(notes(w.files).match(/reviewer report/g)?.length).toBe(1)
})

test('a later send for the same key forwards only its new needs-a-person line', async ($, on) => {
  const w = world(on)
  w.agents[0]!.status = 'completed'
  await send($, 'q1', 'csv-export', 'PR #7 merged')
  await send($, 'q1', 'csv-export', 'PR #7 merged\nneeds a person: PR #7: look at the pane')
  await send($, 'q1', 'csv-export', 'PR #7 merged again\nneeds a person: PR #7: look at the pane')
  await send($, 'q1', 'csv-export', 'PR #9 merged')
  await w.flush()
  expect(w.prompts.length).toBe(3)
  expect(w.prompts[1]).toContain('needs a person: PR #7: look at the pane')
  expect(w.prompts[1]).not.toContain('merged')
})

test('a reviewer send to main that repeats forwarded lines is dropped; new text goes through', async ($, on) => {
  const w = world(on)
  w.agents[0]!.status = 'completed'
  await send($, 'q1', 'csv-export', 'PR #7 merged\nneeds a person: PR #7: look at the pane')
  expect(await send($, 'q1', 'main', 'needs a person: PR #7: look at the pane')).toContain('already has')
  expect(await send($, 'q1', 'main', 'needs a person: PR #7: look at the pane\nPR #8 waits')).toBe('sent')
})

test('the same manager and PR from two different reviewer runs is forwarded both times', async ($, on) => {
  const w = world(on)
  w.agents[0]!.status = 'completed'
  w.agents.push({ id: 'q2', name: 'merge-queue-2', description: 'q', type: 'flow:queue', status: 'running' })
  await send($, 'q1', 'csv-export', 'PR #7 sent back: tests fail')
  expect(await send($, 'q2', 'csv-export', 'PR #7 merged')).toContain('Not sent')
  expect(await send($, 'q2', 'main', 'PR #7 sent back: tests fail')).toBe('sent')
  await w.flush()
  expect(w.prompts.length).toBe(2)
  expect(w.prompts[1]).toContain('PR #7 merged')
})

const queue = ($: Dollar, extra: Record<string, unknown>) => $.tool.call({ tool: 'mcp__flow__queue', agentId: 'q1', ...extra } as never).then(r => String(r.result))
const finalReport = 'PR #7 merged abc1234. full check: 3 passed\nafter_deploy: none\npending decisions: none'

test('"done" fast-forwards the main checkout, returns the line and logs a main-ff event', async ($, on) => {
  const w = world(on)
  await handover($, 'm1')
  await queue($, { action: 'take', pr: 7 })
  const r = await queue($, { action: 'done', pr: 7, sha: 'abc1234', report: 'merged' })
  expect(r).toContain('main checkout fast-forwarded to abc1234')
  expect(w.gitCalls.some(c => c.includes('pull') && c.includes('--ff-only'))).toBe(true)
  const log = w.logs.join('\n')
  expect(log).toContain('"event":"main-ff"')
})

test('a reviewer that did batch work has its whole final report relayed to main once, with the line', async ($, on) => {
  const w = world(on)
  await handover($, 'm1')
  await queue($, { action: 'take', pr: 7 })
  await queue($, { action: 'done', pr: 7, sha: 'abc1234', report: 'merged' })
  await w.flush()
  const before = w.prompts.length
  await $.turn.complete({ turnId: 't', agentId: 'q1', answer: finalReport } as never)
  await w.flushLong()
  const relayed = w.prompts.slice(before).filter(p => p.includes('Report from reviewer merge-queue-1'))
  expect(relayed.length).toBe(1)
  expect(relayed[0]).toContain('pending decisions: none')
  expect(relayed[0]).toContain('main checkout fast-forwarded to abc1234')
})

test('a reviewer run with no batch work relays nothing', async ($, on) => {
  const w = world(on)
  await $.turn.complete({ turnId: 't', agentId: 'q1', answer: 'No pending handovers.' } as never)
  await w.flushLong()
  expect(w.prompts.some(p => p.includes('Report from reviewer'))).toBe(false)
})

test('the per-PR "Report for" relay is not doubled by the full report relay', async ($, on) => {
  const w = world(on)
  w.agents[0]!.status = 'completed'
  await send($, 'q1', 'csv-export', 'PR #7 merged')
  await $.turn.complete({ turnId: 't', agentId: 'q1', answer: 'Nothing else.' } as never)
  await w.flushLong()
  expect(w.prompts.filter(p => p.includes('Report for csv-export')).length).toBe(1)
})

test('a done line, then a reworded lone needs-a-person line for the same PR, reaches main once', async ($, on) => {
  const w = world(on)
  w.agents[0]!.status = 'completed'
  await send($, 'q1', 'csv-export', `PR #7 merged at abc1234 | ${REPORT.replace('after_deploy: none', 'after_deploy: needs a person: PR #7: look at the pane')}`)
  const second = await send($, 'q1', 'csv-export', 'needs a person: PR #7: after reload, look at the pane in the browser')
  expect(second).toContain('already forwarded')
  // Another PR's line still goes through.
  expect(await send($, 'q1', 'csv-export', 'needs a person: PR #8: look')).toContain('Not sent')
  await w.flush()
  expect(w.prompts.filter(p => p.includes('Report for csv-export')).length).toBe(2)
  expect(w.prompts.filter(p => p.includes('PR #7: after reload')).length).toBe(0)
})

test('the whole multi-paragraph final report is logged and relayed from persisted run work', async ($, on) => {
  const w = world(on)
  await handover($, 'm1')
  await queue($, { action: 'take', pr: 7 })
  await queue($, { action: 'done', pr: 7, sha: 'abc1234', report: 'merged' })
  await w.flush()
  const answer = 'Merged PR #7.\n\nDeploy: none.\n\nNo more pending handovers.'
  await $.turn.complete({ turnId: 't', agentId: 'q1', answer } as never)
  await w.flushLong()
  expect(w.logs.some(l => l.includes('"event":"report"') && l.includes('Deploy: none.'))).toBe(true)
  expect(w.prompts.some(p => p.includes('Report from reviewer') && p.includes('Deploy: none.'))).toBe(true)
})

test('a pending-decisions line for a PR is not swallowed by an earlier needs-a-person line for it', async ($, on) => {
  const w = world(on)
  w.agents[0]!.status = 'completed'
  await send($, 'q1', 'csv-export', 'needs a person: PR #7: look at the pane')
  const second = await send($, 'q1', 'csv-export', 'pending decisions: PR #7: pick a name')
  expect(second).not.toContain('already forwarded')
  await w.flush()
  expect(w.prompts.filter(p => p.includes('Report for csv-export')).length).toBe(2)
  expect(w.prompts.some(p => /pending decisions: PR #7: pick a name/i.test(p))).toBe(true)
})
