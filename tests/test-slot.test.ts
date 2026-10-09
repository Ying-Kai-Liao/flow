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
  // c cannot jump the line when the slot frees.
  expect(await call($, 'release', 'a')).toContain('Released')
  expect(await call($, 'acquire', 'c')).toContain('position 2')
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
  const e = (key: string, since: number) => ({ key, name: key, label: 'x', since, lastAt: since })
  const rows = [{ id: 'a', description: '', type: '', status: 'idle' }, { id: 'b', description: '', type: '', status: 'running' }]
  const t = 10_000_000
  const kept = reapSlots({ holders: [e('a', t), e('main', t)], waiters: [] }, rows, t)
  expect(kept.notes).toEqual([])
  expect(kept.state.holders.length).toBe(2)
  expect(reapSlots({ holders: [e('gone', t)], waiters: [e('b', t - 4 * 60_000)] }, rows, t).state)
    .toEqual({ holders: [], waiters: [] })
  const late = reapSlots({ holders: [e('b', t - 46 * 60_000)], waiters: [] }, rows, t)
  expect(late.state.holders).toEqual([])
  expect(late.notes[0]).toContain('lease')
})
