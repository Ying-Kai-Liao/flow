import type { AgentInfo } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const DIR = '/r/.git/flow'
const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const MIN = 60_000

// Main (no agent id) starts managers a1, a2, ..; a manager's id is its agent id.
function world(on: On) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const agents: AgentInfo[] = []
  const files = new Map<string, string>()
  const sent: { to: string; text: string }[] = []
  const submitted: string[] = []
  const spawned: string[] = []
  on('agent.list', () => ({ value: agents }))
  on('agent.spawn', (_, e) => {
    const input = e as unknown as { subagentType: string; name?: string; description: string; parentAgentId?: string }
    spawned.push(`${input.subagentType}:${input.name ?? input.description}`)
    const id = `a${agents.length + 1}`
    agents.push({ id, name: input.name, description: input.description, type: input.subagentType, status: 'running', parentId: input.parentAgentId })
    return { model: 'sonnet', agentId: id }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.send', (_, e) => {
    const raw = (e as unknown as { to: string | { agentId: string } }).to
    sent.push({ to: typeof raw === 'string' ? raw : raw.agentId, text: e.text })
    return { isDelivered: true as const }
  })
  on('prompt.submit', (_, e) => { submitted.push(e.text); return { text: e.text } })
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('fs.read', (_, e) => {
    const t = files.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('process.run', (_, e) => {
    const a = e.argv
    if (a[0] === 'git' && a[1] === 'rev-parse') return ok('/r/.git\n')
    if (a[0] === 'mv') {
      const t = files.get(a[1] ?? '')
      if (t !== undefined) { files.set(a[2] ?? '', t); files.delete(a[1] ?? '') }
    }
    return ok()
  })
  return { clock, agents, files, sent, submitted, spawned }
}

const manager = ($: Dollar, name: string, prompt = 'Task') =>
  $.agent.spawn({ prompt, description: name, name, subagentType: 'flow:manager' } as never)
const spawnAs = ($: Dollar, parent: string, subagentType: string, name: string, prompt = 'brief') =>
  $.agent.spawn({ prompt, description: name, name, subagentType, parentAgentId: parent } as never).then(r => JSON.stringify(r))
const worker = ($: Dollar, parent: string, name = 'w', prompt?: string) => spawnAs($, parent, 'flow:worker', name, prompt)
const file = ($: Dollar, agentId: string | null, over: Record<string, unknown> = {}) =>
  $.tool.call({
    tool: 'mcp__flow__preflight', from: 'x', summary: 'do it', criteria: ['works'], shipped: [], depends: [],
    ...over, ...(agentId === null ? {} : { agentId }),
  } as never).then(r => String(r.result))
const answer = ($: Dollar, args: Record<string, unknown>) =>
  $.tool.call({ tool: 'mcp__flow__answer', ...args } as never).then(r => String(r.result))
const BLOCK = { question: 'Which format?', options: ['csv', 'tsv'], default: 'csv', blocking: true }
const SOFT = { question: 'Quote fields?', options: ['yes', 'no'], default: 'yes', blocking: false }

test('a worker spawn is refused before filing, allowed after filing without blocking questions', async ($, on) => {
  const w = world(on)
  await manager($, 'csv')
  const denied = await worker($, 'a1')
  expect(denied).toContain('mcp__flow__preflight')
  expect(w.spawned).toEqual(['flow:manager:csv'])
  // A "Continue on branch:" worker is gated too.
  expect(await worker($, 'a1', 'w2', 'Continue on branch: flow/x\nbrief')).toContain('mcp__flow__preflight')

  expect(await file($, 'a1')).toContain('Start your workers now')
  expect(await worker($, 'a1')).not.toContain('pre-flight')
  expect(w.spawned).toContain('flow:worker:w')
})

test('recon helpers (Explore, general-purpose) are never refused', async ($, on) => {
  const w = world(on)
  await manager($, 'csv')
  expect(await spawnAs($, 'a1', 'Explore', 'look')).not.toContain('pre-flight')
  expect(await spawnAs($, 'a1', 'general-purpose', 'look2')).not.toContain('pre-flight')
  expect(w.spawned).toEqual(['flow:manager:csv', 'Explore:look', 'general-purpose:look2'])
})

test('a blocking question holds the manager until answered, by choice or by defaults', async ($, on) => {
  world(on)
  await manager($, 'csv')
  await manager($, 'login')
  const r = await file($, 'a1', { questions: [BLOCK, SOFT] })
  expect(r).toContain('q1')
  expect(r).toContain('End your turn')
  const denied = await worker($, 'a1')
  expect(denied).toContain('q1')
  expect(denied).toContain('still open')

  // The non-blocking one does not hold; answering the blocking one releases it.
  expect(await answer($, { answers: [{ id: 'q1', choice: 'b' }] })).toContain('q1: tsv')
  expect(await worker($, 'a1')).not.toContain('pre-flight')

  await file($, 'a2', { questions: [{ ...BLOCK, question: 'Other?' }] })
  expect(await worker($, 'a2')).toContain('still open')
  await answer($, { defaults: true, ids: ['q3'] })
  expect(await worker($, 'a2')).not.toContain('pre-flight')
})

test('filing again replaces the record and does not duplicate questions', async ($, on) => {
  const w = world(on)
  await manager($, 'csv')
  await file($, 'a1', { questions: [BLOCK] })
  expect(await file($, 'a1', { questions: [BLOCK], summary: 'new plan' })).toContain('q1')
  const inbox = JSON.parse(w.files.get(`${DIR}/inbox.json`) ?? '{}') as { items: unknown[] }
  expect(inbox.items.length).toBe(1)
  const state = JSON.parse(w.files.get(`${DIR}/preflight.json`) ?? '{}') as { entries: Record<string, { filing: { summary: string } }> }
  expect(state.entries['csv']!.filing.summary).toBe('new plan')
})

test('Pre-flight: skip exempts a manager, and an unrecorded manager is never gated', async ($, on) => {
  const w = world(on)
  await manager($, 'small', 'Pre-flight: skip\nrename a variable')
  expect(await worker($, 'a1')).not.toContain('pre-flight')

  // A manager that exists but was never recorded (started before the upgrade).
  w.agents.push({ id: 'old', name: 'old-manager', description: 'o', type: 'flow:manager', status: 'running' })
  expect(await worker($, 'old', 'ow')).not.toContain('pre-flight')
})

test('the setting off exempts a manager', { options: { preflight: 'off' } }, async ($, on) => {
  const w = world(on)
  await manager($, 'csv')
  expect(await worker($, 'a1')).not.toContain('pre-flight')
  expect(w.files.has(`${DIR}/preflight.json`)).toBe(false)
})

test('a successor inherits the filed record', async ($, on) => {
  const w = world(on)
  await manager($, 'csv')
  await file($, 'a1')
  w.agents[0]!.status = 'completed'
  await manager($, 'csv-2')
  expect(await worker($, 'a2', 'w')).not.toContain('pre-flight')
})

test('only managers file; main and workers are refused with a message', async ($, on) => {
  world(on)
  await manager($, 'csv')
  await file($, 'a1')
  await worker($, 'a1')
  expect(await file($, null)).toContain('Refused')
  expect(await file($, 'a2')).toContain('only managers')
  expect(await file($, 'a1', { criteria: [] })).toContain('Refused, nothing recorded')
})

test('the round goes to main once, when every member has filed', async ($, on) => {
  const w = world(on)
  await manager($, 'csv')
  await manager($, 'login')
  await file($, 'a1', { questions: [BLOCK], shipped: [{ what: 'half', ref: '#4' }] })
  await w.clock.advance(5)
  expect(w.submitted).toEqual([])
  await file($, 'a2', { depends: [{ on: 'csv', why: 'schema' }] })
  await w.clock.advance(5)
  expect(w.submitted.length).toBe(1)
  expect(w.submitted[0]!.split('\n')[0]).toBe('Pre-flight: 2 tasks, 1 already shipped, 1 depend on others, 1 question (1 blocking)')
  expect(w.submitted[0]).toContain('mcp__flow__answer')
  // A re-filing and the passing time deliver nothing more.
  await file($, 'a2')
  await w.clock.advance(10)
  expect(w.submitted.length).toBe(1)
  const view = await $.command.run({ command: 'flow', args: 'preflight' } as never)
  expect(view.text).toContain('delivered to main')
  const status = String((await $.tool.call({ tool: 'mcp__flow__status' } as never)).result)
  expect(status).toContain('pre-flight: waiting on answers')
  expect(status).toContain('pre-flight: released')
})

test('the round goes out after the wait without the managers still in recon; a late filing follows alone', async ($, on) => {
  const w = world(on)
  await manager($, 'csv')
  await manager($, 'login')
  await file($, 'a1')
  await w.clock.advance(5)
  expect(w.submitted).toEqual([])
  await w.clock.advance(10 * MIN)
  expect(w.submitted.length).toBe(1)
  expect(w.submitted[0]).toContain('Timed out waiting for: login')
  expect(w.submitted[0]).toContain('- login: still in recon')

  await file($, 'a2', { questions: [SOFT] })
  await w.clock.advance(5)
  expect(w.submitted.length).toBe(2)
  expect(w.submitted[1]).toContain('Pre-flight (late): login')
})

test('a round of only skipped managers sends nothing; a manager that ended counts as done', async ($, on) => {
  const w = world(on)
  await manager($, 's1', 'Pre-flight: skip')
  await manager($, 's2', 'Pre-flight: skip')
  await w.clock.advance(11 * MIN)
  expect(w.submitted).toEqual([])

  await manager($, 'csv')
  await manager($, 'login')
  await file($, 'a3')
  w.agents[3]!.status = 'failed'
  await $.tool.call({ tool: 'mcp__flow__status' } as never)
  await w.clock.advance(5)
  expect(w.submitted.length).toBe(1)
  expect(w.submitted[0]).toContain('login: ended without pre-flight')
})

test('mcp__flow__session start by a gated manager is refused', async ($, on) => {
  world(on)
  await manager($, 'csv')
  const r = String((await $.tool.call({ tool: 'mcp__flow__session', agentId: 'a1', action: 'start', name: 'x', brief: 'b' } as never)).result)
  expect(r).toContain('Refused')
  expect(r).toContain('mcp__flow__preflight')
})
