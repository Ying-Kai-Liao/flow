import { expect } from 'claude-code/testing'
import { test } from './support'
import type { AgentRow } from '../types'
import type { Plan } from '../hooks/dag'
import { isManagerOf, liveManagers, planOwner } from '../hooks/roster-run'

const row = (id: string, type: string, status: string, name?: string): AgentRow => ({ id, type, status, description: '', ...(name && { name }) })

test('isManagerOf matches the owner and its numeric continuations only', async () => {
  expect(isManagerOf('mgr', 'mgr')).toBe(true)
  expect(isManagerOf('mgr', 'mgr-2')).toBe(true)
  expect(isManagerOf('mgr', 'mgr-12')).toBe(true)
  expect(isManagerOf('mgr', 'mgr-x')).toBe(false)
  expect(isManagerOf('mgr', 'mgr-')).toBe(false)
  expect(isManagerOf('mgr', 'mgr-2-b')).toBe(false)
  expect(isManagerOf('mgr', 'mgrs')).toBe(false)
  expect(isManagerOf('mgr', 'other-mgr')).toBe(false)
  expect(isManagerOf('mgr', undefined)).toBe(false)
})

test('planOwner: main has none, a name with a plan owns it, a continuation maps to its manager', async () => {
  const plans: Plan = { mgr: {}, 'a-b': {} }
  expect(planOwner(plans, undefined)).toBe('main')
  expect(planOwner(plans, 'mgr')).toBe('mgr')
  expect(planOwner(plans, 'mgr-3')).toBe('mgr')
  // a name with a plan wins over stripping its suffix
  expect(planOwner({ ...plans, 'mgr-3': {} }, 'mgr-3')).toBe('mgr-3')
  // no plan under either name: the agent's own name
  expect(planOwner(plans, 'nobody')).toBe('nobody')
  expect(planOwner(plans, 'nobody-2')).toBe('nobody-2')
  expect(planOwner({}, 'mgr-2')).toBe('mgr-2')
  // only a trailing -N is stripped
  expect(planOwner(plans, 'a-b-4')).toBe('a-b')
})

test('liveManagers keeps managers that have not ended and drops workers and ended managers', async () => {
  const rows = [
    row('1', 'flow:manager', 'running', 'm1'),
    row('2', 'flow:manager', 'idle', 'm2'),
    row('3', 'flow:manager', 'pending'),
    row('4', 'flow:manager', 'completed', 'm4'),
    row('5', 'flow:manager', 'failed', 'm5'),
    row('6', 'flow:manager', 'killed', 'm6'),
    row('7', 'flow:worker', 'running', 'w'),
    row('8', 'flow:reviewer', 'running'),
  ]
  expect(liveManagers(rows).map(a => a.id)).toEqual(['1', '2', '3'])
  expect(liveManagers([])).toEqual([])
})
