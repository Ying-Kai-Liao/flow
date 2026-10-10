import { expect, mock } from 'claude-code/testing'
import { test } from './support'
import { shimmerParts } from '../hooks/shimmer'

const join = (label: string, now: number) => shimmerParts(label, now).map(p => p.text).join('')
const lit = (label: string, now: number) => shimmerParts(label, now).filter(p => p.lit).map(p => p.text).join('')

test('shimmerParts always spells the label and sweeps one step per second', () => {
  for (let s = 0; s < 20; s++) expect(join('fix-login', s * 1000)).toBe('fix-login')
  expect(lit('fix-login', 0)).toBe('f')
  expect(lit('fix-login', 1000)).toBe('fi')
  expect(lit('fix-login', 2000)).toBe('ix')
  // The same second gives the same parts, so a redraw never restarts the sweep.
  expect(shimmerParts('fix-login', 2000)).toEqual(shimmerParts('fix-login', 2999))
  // It leaves the label for a few ticks (nothing lit), then starts again.
  expect(lit('ab', 3000)).toBe('')
  expect(lit('ab', 6000)).toBe('a')
  expect(shimmerParts('', 1000)).toEqual([])
})

test('only a running agent has its name drawn with the accent, and it moves with the clock', async ($, on) => {
  const clock = mock.clock(on, { now: 1_003_000 })
  on('agent.list', () => ({ value: [
    { id: 'w1', name: 'fix-login', description: 'Fix', type: 'flow:worker', status: 'running' },
    { id: 'w2', name: 'docs', description: 'Docs', type: 'flow:worker', status: 'completed' },
    { id: 'w3', name: 'later', description: 'Later', type: 'flow:worker', status: 'pending' },
  ] }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'w1' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  await $.agent.spawn({ prompt: 'b', description: 'Fix', subagentType: 'flow:worker' } as never)
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'flow', surface: 'terminal', component: 'Pane', props: { title: 'Flow' } as never, requestId: 'flow' } as never)
  const card = async (key: string) => JSON.stringify(await ui.find({ type: 'Button', key }))
  // The accent on the name: the lit stretch only, apart from the glyph's own color.
  const lit = (j: string) => [...j.matchAll(/"color":"suggestion"\},"children":\["([^"]+)"\]/g)].map(m => m[1]).filter(t => t !== '●').join('')
  const before = lit(await card('w1'))
  expect('fix-login').toContain(before)
  expect(before).not.toBe('')
  expect(lit(await card('w2'))).toBe('')
  expect(lit(await card('w3'))).toBe('')
  await clock.advance(3_000)
  await $.tool.call({ tool: 'mcp__flow__status' } as never)
  const after = lit(await card('w1'))
  expect(after).not.toBe(before)
  expect('fix-login').toContain(after)
  await ui.unmount()
})
