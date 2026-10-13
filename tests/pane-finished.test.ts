import type { AgentInfo } from 'claude-code'
import { expect, mock } from 'claude-code/testing'
import { test } from './support'
import type { Handover } from '../types'
import { FINISHED_KEY, finishedIds, treeItems } from '../hooks/pane'
import type { OpenWork } from '../hooks/pane'

const PANE = { component: 'Pane', props: { title: 'Flow' } as never, requestId: 'flow' } as const

type Row = Parameters<typeof treeItems>[0][number]
const row = (id: string, status: string, parentId?: string, name: string | undefined = id): Row => ({
  id, ...(name === undefined ? {} : { name }), description: id, status, ...(parentId === undefined ? {} : { parentId }),
  type: parentId === undefined ? 'flow:manager' : 'flow:worker',
})
const NONE: OpenWork = { handovers: [], owners: [], planOpen: () => false }
const ho = (reportTo: string, status: Handover['status']) => ({ pr: 1, reportTo, status } as Handover)

test('finishedIds folds ended top-level agents with no open work and keeps the rest', () => {
  const list = [
    row('live', 'running'), row('lw', 'running', 'live'),
    row('done', 'completed'), row('dw', 'killed', 'done'),
    row('busy', 'completed'), row('bw', 'running', 'busy'),
    row('pr', 'completed'), row('asks', 'failed'), row('plan', 'completed'),
    row('rev', 'completed'), row('anon', 'killed', undefined, undefined),
    row('solo-w', 'killed', 'gone'),
  ]
  list.find(a => a.id === 'rev')!.type = 'flow:queue'
  list.find(a => a.id === 'solo-w')!.type = 'flow:worker'
  const work: OpenWork = {
    handovers: [ho('pr', 'taken'), ho('done', 'done')],
    owners: ['asks'],
    planOpen: name => name === 'plan',
  }
  // An open handover, inbox item or plan node, a live worker, the reviewer, and a worker main
  // started itself keep a row drawn; a row with no name folds on status alone.
  expect([...finishedIds(list, work)].sort()).toEqual(['anon', 'done'])
  expect(finishedIds(list, NONE).has('pr')).toBe(true)
  // The agent the pane follows stays drawn, as does the top agent above it.
  expect(finishedIds(list, NONE, 'dw').has('done')).toBe(false)
})

test('a restarted manager owns the open work; the old row folds, matched by noteKey', () => {
  const list = [row('task', 'completed'), row('task-2', 'running')]
  expect([...finishedIds(list, { ...NONE, handovers: [ho('task-2', 'taken')], owners: ['task-2'] })]).toEqual(['task'])
  // With no live namesake, work filed under task-2 still holds an ended task.
  expect(finishedIds([row('task', 'completed')], { ...NONE, owners: ['task-2'] }).size).toBe(0)
})

test('treeItems draws one collapsed finished row last, and nests the managers under it when open', () => {
  const list = [row('done', 'completed'), row('dw', 'killed', 'done'), row('dw2', 'completed', 'done'), row('live', 'running'), row('old', 'completed')]
  const fin = finishedIds(list, NONE)
  const shut = treeItems(list, {}, 'dw', false, {}, fin)
  expect(shut.items.map(i => i.a.id)).toEqual(['live', FINISHED_KEY])
  expect(shut.items[1]).toMatchObject({ collapsed: true, finished: { managers: 2, workers: 2 } })
  // A highlight hidden in the folded row moves to the row.
  expect(shut.at).toBe(FINISHED_KEY)
  const open = treeItems(list, { [FINISHED_KEY]: false, done: false }, 'dw', false, {}, fin)
  expect(open.items.map(i => [i.a.id, i.depth])).toEqual([['live', 0], [FINISHED_KEY, 0], ['done', 1], ['dw', 2], ['dw2', 2], ['old', 1]])
  expect(open.at).toBe('dw')
  // The per-manager fold still works under the row.
  expect(treeItems(list, { [FINISHED_KEY]: false }, undefined, false, {}, fin).items.map(i => i.a.id)).toEqual(['live', FINISHED_KEY, 'done', 'old'])
  // Nothing finished, no row.
  expect(treeItems(list, {}, undefined, false, {}, new Set()).items.some(i => i.finished !== undefined)).toBe(false)
})

test('the pane folds finished managers into "▸ N finished"; f and a press toggle it', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('agent.list', () => ({ value: [
    { id: 'm1', name: 'live-task', description: 'm', type: 'flow:manager', status: 'running' },
    { id: 'm2', name: 'old-a', description: 'a', type: 'flow:manager', status: 'completed' },
    { id: 'w2', name: 'old-a-w', description: 'w', type: 'flow:worker', status: 'killed', parentId: 'm2' },
    { id: 'm3', name: 'old-b', description: 'b', type: 'flow:manager', status: 'completed' },
  ] as AgentInfo[] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  // A spawn makes the roster read the agent list.
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'm1' }))
  await $.agent.spawn({ prompt: 'brief', description: 'm', subagentType: 'flow:manager' } as never)
  const ui = await $.ui.mount({ plugin: 'flow', surface: 'terminal', ...PANE, viewport: { columns: 100, rows: 40 } } as never)
  expect(await ui.find({ type: 'Button', key: 'm1' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'm2' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'm3' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: FINISHED_KEY, text: /▸ 2 finished · 1 worker$/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'nav-finished', text: /f finished/ })).toBeDefined()
  await ui.press({ key: 'nav-finished' })
  expect(await ui.find({ type: 'Button', key: FINISHED_KEY, text: /▾ 2 finished/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'm2' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'm3' })).toBeDefined()
  // Each manager keeps its own fold: its worker shows on its chevron.
  expect(await ui.find({ type: 'Button', key: 'w2' })).toBeUndefined()
  await ui.press({ key: 'fold-m2' })
  expect(await ui.find({ type: 'Button', key: 'w2' })).toBeDefined()
  // j walks onto the drawn rows only; pressing the row folds it again.
  await ui.press({ key: FINISHED_KEY })
  expect(await ui.find({ type: 'Button', key: 'm2' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'nav-finished', text: /f finished/ })).toBeDefined()
  await ui.press({ key: 'nav-next' })
  await ui.press({ key: 'nav-next' })
  expect(await ui.find({ type: 'Button', key: 'nav-fold', text: /c expand/ })).toBeDefined()
  await ui.press({ key: 'nav-fold' })
  expect(await ui.find({ type: 'Button', key: 'm3' })).toBeDefined()
  await ui.unmount()
})

test('no finished row while every agent is live', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('agent.list', () => ({ value: [
    { id: 'm1', name: 'live-task', description: 'm', type: 'flow:manager', status: 'running' },
  ] as AgentInfo[] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  // A spawn makes the roster read the agent list.
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'm1' }))
  await $.agent.spawn({ prompt: 'brief', description: 'm', subagentType: 'flow:manager' } as never)
  const ui = await $.ui.mount({ plugin: 'flow', surface: 'terminal', ...PANE, viewport: { columns: 100, rows: 40 } } as never)
  expect(await ui.find({ type: 'Button', key: 'm1' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: FINISHED_KEY })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'nav-finished' })).toBeUndefined()
  await ui.unmount()
})
