import type { AgentInfo } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { reapSlots } from '../hooks/register'

const agents = (...ids: string[]): AgentInfo[] =>
  ids.map(id => ({ id, name: id, description: id, type: 'flow:worker', status: 'running' }) as AgentInfo)

function world(on: any, list: AgentInfo[], now = 1_000_000) {
  const clock = mock.clock(on, { now })
  on('agent.list', () => ({ value: list }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  return clock
}

const call = ($: any, action: string, agentId?: string, extra: object = {}) =>
  $.tool.call({ tool: 'mcp__flow__test_slot', action, agentId, wait_s: 0, ...extra } as never).then((r: any) => String(r.result))

test('a slot is granted up to the limit; the next caller queues in order', async ($, on) => {
  world(on, agents('a', 'b', 'c'))
  expect(await call($, 'acquire', 'a', { label: 'full suite' })).toContain('granted')
  expect(await call($, 'acquire', 'b')).toContain('position 1')
  expect(await call($, 'acquire', 'c')).toContain('position 2')
  // The slot goes to b at once; c cannot jump the line.
  expect(await call($, 'release', 'a')).toContain('Released')
  expect(await call($, 'acquire', 'c')).toContain('position 1')
  expect(await call($, 'acquire', 'b')).toContain('granted')
  const status = await call($, 'status', 'a')
  expect(status).toContain('1/1 held by b')
  expect(status).toContain('1 waiting')
})

test('double acquire keeps one slot; release without a slot is harmless', async ($, on) => {
  world(on, agents('a'))
  await call($, 'acquire', 'a')
  expect(await call($, 'acquire', 'a')).toContain('already hold')
  expect(await call($, 'release', 'a')).toContain('Released')
  expect(await call($, 'release', 'a')).toContain('nothing to release')
})

test('the main session can hold a slot', async ($, on) => {
  world(on, [])
  expect(await call($, 'acquire', undefined)).toContain('granted')
  expect(await call($, 'status', undefined)).toContain('held by main')
})

test('a waiter gets the slot when it frees while acquire waits', async ($, on) => {
  const clock = world(on, agents('a', 'b'))
  await call($, 'acquire', 'a')
  const pending = call($, 'acquire', 'b', { wait_s: 3 })
  await clock.advance(1000)
  await call($, 'release', 'a')
  await clock.advance(1000)
  expect(await pending).toContain('granted')
})

test('acquire times out with who holds the slot', async ($, on) => {
  const clock = world(on, agents('a', 'b'))
  await call($, 'acquire', 'a', { label: 'full suite' })
  const pending = call($, 'acquire', 'b', { wait_s: 2 })
  await clock.advance(1000)
  await clock.advance(1000)
  const r = await pending
  expect(r).toContain('No slot after 2 s')
  expect(r).toContain('a (full suite')
})

test('an ended holder or waiter is dropped on refresh', async ($, on) => {
  const list = agents('a', 'b', 'c')
  world(on, list)
  await call($, 'acquire', 'a')
  await call($, 'acquire', 'b')
  list[0]!.status = 'completed'
  list[1]!.status = 'killed'
  expect(await call($, 'acquire', 'c')).toContain('granted')
})

test('reapSlots: idle keeps a slot, a missing agent loses it, the lease expires', () => {
  const e = (key: string, since: number) => ({ key, name: key, label: 'x', since })
  const rows = [{ id: 'a', description: '', type: '', status: 'idle' }, { id: 'b', description: '', type: '', status: 'running' }]
  const t = 10_000_000
  const kept = reapSlots({ holders: [e('a', t), e('main', t)], waiters: [] }, rows, t)
  expect(kept.notes).toEqual([])
  expect(kept.state.holders.length).toBe(2)
  expect(reapSlots({ holders: [e('gone', t)], waiters: [e('gone', t)] }, rows, t).state)
    .toEqual({ holders: [], waiters: [] })
  const late = reapSlots({ holders: [e('b', t - 46 * 60_000)], waiters: [] }, rows, t)
  expect(late.state.holders).toEqual([])
  expect(late.notes[0]).toContain('lease')
})

function signals(on: any) {
  const sent: { to: any; text: string }[] = []
  const runs: string[][] = []
  on('session.send', (_: any, e: any) => { sent.push({ to: e.to, text: e.text }); return { isDelivered: true as const } })
  on('process.run', (_: any, e: any) => {
    runs.push(e.argv)
    return { value: { exitCode: 0, stdout: '/repo/.git\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { sent, runs }
}

test('release grants the head waiter at once and sends the message', async ($, on) => {
  world(on, agents('a', 'b'))
  const { sent } = signals(on)
  await call($, 'acquire', 'a')
  await call($, 'acquire', 'b')
  await call($, 'release', 'a')
  expect(sent.length).toBe(1)
  expect(sent[0]!.to).toBe('b')
  expect(sent[0]!.text).toContain('your test slot is granted')
  expect(await call($, 'status', 'b')).toContain('held by b')
  expect(await call($, 'acquire', 'b')).toContain('granted')
})

test('an ended holder is reaped and the head waiter is granted', async ($, on) => {
  const list = agents('a', 'b')
  world(on, list)
  const { sent } = signals(on)
  await call($, 'acquire', 'a')
  await call($, 'acquire', 'b')
  list[0]!.status = 'killed'
  await call($, 'status', 'b')
  expect(sent.map(s => s.to)).toEqual(['b'])
})

test('a grant not confirmed within the claim window passes to the next waiter', async ($, on) => {
  const list = agents('a', 'b', 'c')
  const clock = world(on, list)
  const { sent } = signals(on)
  await call($, 'acquire', 'a')
  await call($, 'acquire', 'b')
  await call($, 'acquire', 'c')
  await call($, 'release', 'a')
  await clock.advance(3 * 60_000)
  await call($, 'status', 'c')
  expect(sent.map(s => s.to)).toEqual(['b', 'c'])
  expect(await call($, 'acquire', 'c')).toContain('granted')
  // b was dropped from the line; asking again queues it behind c.
  expect(await call($, 'acquire', 'b')).toContain('position 1')
})

test('the queued answer names the grant file and the until-loop', async ($, on) => {
  world(on, agents('a', 'b'))
  const { runs } = signals(on)
  for (const k of ['command.register', 'agent.register', 'tool.register']) on(k as 'tool.register', () => ({ value: undefined }) as never)
  on('session.start', () => ({ cwd: '/repo' }))
  await $.session.start({ cwd: '/repo' } as never)
  await call($, 'acquire', 'a')
  const r = await call($, 'acquire', 'b')
  expect(runs.some(a => a.join(' ').includes('rm -rf'))).toBe(true)
  expect(r).toContain("until [ -e '/repo/.git/flow/test-slots/b.granted' ]; do sleep 3; done")
  expect(r).not.toContain('acquire again')
  await call($, 'release', 'a')
  expect(runs.some(a => a.includes('/repo/.git/flow/test-slots/b.granted') && a.join(' ').includes(': >'))).toBe(true)
  await call($, 'release', 'b')
  expect(runs.some(a => a.join(' ').includes('rm -f'))).toBe(true)
})
