import { expect } from 'claude-code/testing'
import { timedTest as test } from './support'

import type { Activity, AgentRow, Ledger } from '../types'
import { forgetLedgerLoad } from '../hooks/cost-run'
import type { CostIo } from '../hooks/cost-run'
import { countStep, countTurn, meterStep } from '../hooks/usage-run'
import type { UsageIo } from '../hooks/usage-run'

const SETTINGS = { contextWarn: 40, contextWarn1m: 20, contextWarnTokens: 0, handoff: true }
const USAGE = { model: 'claude-sonnet-4-6', input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 30 }

function costIo(): CostIo & { view: () => Ledger } {
  let view: Ledger = {}
  let delta: Ledger = {}
  let epoch = ''
  let loaded = false
  return {
    stateDir: async () => undefined, readJson: async () => undefined, writeJsonAtomic: async () => true,
    mkdirp: async () => {}, now: async () => 5000, after: () => {},
    ledger: async () => view, updateLedger: async fn => { view = fn(view) },
    delta: async () => delta, updateDelta: async fn => { delta = fn(delta) },
    epoch: async () => epoch, setEpoch: async e => { epoch = e },
    loaded: async () => loaded, markLoaded: async () => { loaded = true },
    startedAt: async () => 77, liveIds: async () => [], hasSessions: async () => false,
    view: () => view,
  }
}

function usageIo(agents: AgentRow[] = [], acts: Record<string, Activity> = {}) {
  const cost = costIo()
  const calls = { toasts: [] as string[], wrapUps: [] as [string, number, string][], mainModel: undefined as string | undefined, mainWindow: undefined as number | undefined, warned: 0 }
  let activity = acts
  const io: UsageIo = {
    cost, now: async () => 9000, activity: async () => activity,
    updateActivity: async fn => { activity = fn(activity) },
    agents: async () => agents, toast: t => { calls.toasts.push(t) },
    sendWrapUp: async (me, percent, limit) => { calls.wrapUps.push([me.id, percent, limit]) },
    warnMain: async () => { calls.warned++; return 1_000_000 },
    mainModel: () => calls.mainModel, setMainModel: m => { calls.mainModel = m },
    mainWindow: () => calls.mainWindow, setMainWindow: w => { calls.mainWindow = w },
  }
  return { io, cost, calls, activity: () => activity }
}

const worker = (id: string, name: string, parentId?: string): AgentRow => ({ id, name, description: '', type: 'flow:worker', status: 'running', ...(parentId && { parentId }) }) as AgentRow

test('countStep adds a step\'s tokens to the agent\'s ledger row', async () => {
  forgetLedgerLoad()
  const { io, cost } = usageIo()
  await countStep(io, { agentId: 'w1', model: 'sonnet' }, { usage: USAGE })
  const m = cost.view().w1?.models['claude-sonnet-4-6']
  expect([m?.input, m?.output, m?.read]).toEqual([100, 20, 50])
  expect(m?.write5m).toBe(30)
})

test('countStep counts the main agent under its session key and falls back to the engine\'s model', async () => {
  forgetLedgerLoad()
  const { io, cost } = usageIo()
  await countStep(io, { model: 'engine-model' }, { usage: { ...USAGE, model: undefined } })
  const row = cost.view()['main@77']
  expect(row?.role).toBe('main')
  expect(row?.models['engine-model']?.input).toBe(100)
})

test('countStep takes a late agent\'s identity from the roster', async () => {
  forgetLedgerLoad()
  const { io, cost } = usageIo([worker('m1', 'boss'), worker('w1', 'fix-it', 'm1')])
  await countStep(io, { agentId: 'w1', model: 'sonnet' }, { usage: USAGE })
  expect(cost.view().w1).toMatchObject({ role: 'worker', name: 'fix-it', manager: 'boss', branch: 'flow/fix-it' })
})

test('countStep ignores a step with no usage or with zero tokens', async () => {
  forgetLedgerLoad()
  const { io, cost } = usageIo()
  await countStep(io, { agentId: 'w1', model: 'sonnet' }, undefined)
  await countStep(io, { agentId: 'w1', model: 'sonnet' }, {})
  await countStep(io, { agentId: 'w1', model: 'sonnet' }, { usage: { input_tokens: 0 } })
  expect(cost.view()).toEqual({})
})

test('countStep never fails the step when the ledger throws', async () => {
  forgetLedgerLoad()
  const { io, cost } = usageIo()
  cost.updateLedger = async () => { throw new Error('boom') }
  await countStep(io, { agentId: 'w1', model: 'sonnet' }, { usage: USAGE })
})

test('countTurn counts a turn once per agent and turn id', async () => {
  forgetLedgerLoad()
  const io = costIo()
  const counted = new Set<string>()
  await countTurn(io, counted, 'w1', 't1')
  await countTurn(io, counted, 'w1', 't1')
  expect(io.view().w1?.turns).toBe(1)
  await countTurn(io, counted, 'w1', 't2')
  await countTurn(io, counted, 'w2', 't1')
  expect(io.view().w1?.turns).toBe(2)
  expect(io.view().w2?.turns).toBe(1)
})

test('countTurn always counts a turn without an id, and counts main under its session key', async () => {
  forgetLedgerLoad()
  const io = costIo()
  const counted = new Set<string>()
  await countTurn(io, counted, undefined, undefined)
  await countTurn(io, counted, undefined, undefined)
  expect(io.view()['main@77']?.turns).toBe(2)
  expect(counted.size).toBe(0)
})

test('meterStep records an agent\'s context from the input side of its usage', async () => {
  const { io, activity } = usageIo([], {})
  await meterStep(io, SETTINGS, { agentId: 'w1', model: 'sonnet' }, { usage: USAGE })
  expect(activity().w1?.usage).toMatchObject({ tokens: 180, model: 'claude-sonnet-4-6' })
})

test('meterStep keeps the engine\'s [1m] model, and a spawn window wins', async () => {
  const { io, activity } = usageIo([], { w1: { startedAt: 1, lastAt: 1, log: [], spawnWindow: 500_000 } as Activity })
  await meterStep(io, SETTINGS, { agentId: 'w1', model: 'opus[1m]' }, { usage: USAGE })
  expect(activity().w1?.usage).toMatchObject({ tokens: 180, model: 'opus[1m]', window: 500_000 })
})

test('meterStep on the main agent records its model and window, and touches no activity', async () => {
  const { io, calls, activity } = usageIo()
  await meterStep(io, SETTINGS, { model: 'opus' }, { usage: USAGE })
  expect(calls.mainModel).toBe('opus')
  expect(calls.mainWindow).toBe(1_000_000)
  expect(activity()).toEqual({})
})

test('meterStep skips a step with no usage', async () => {
  const { io, activity } = usageIo()
  await meterStep(io, SETTINGS, { agentId: 'w1', model: 'sonnet' }, undefined)
  expect(activity()).toEqual({})
})

test('meterStep tells a worker once when it passes the threshold, and again after it compacts', async () => {
  const big = { usage: { ...USAGE, input_tokens: 100_000 } }
  const { io, calls, activity } = usageIo([worker('w1', 'fix-it')], {})
  await meterStep(io, SETTINGS, { agentId: 'w1', model: 'sonnet' }, big)
  expect(calls.wrapUps).toEqual([['w1', 50, '40%']])
  expect(calls.toasts[0]).toContain('handing off')
  expect(activity().w1?.handoffNotifiedAt).toBe(9000)
  await meterStep(io, SETTINGS, { agentId: 'w1', model: 'sonnet' }, big)
  expect(calls.wrapUps.length).toBe(1)
  await meterStep(io, SETTINGS, { agentId: 'w1', model: 'sonnet' }, { usage: USAGE })
  expect(activity().w1?.handoffNotifiedAt).toBeUndefined()
  await meterStep(io, SETTINGS, { agentId: 'w1', model: 'sonnet' }, big)
  expect(calls.wrapUps.length).toBe(2)
})

test('meterStep does not send the wrap-up with handoff off, or to a reviewer', async () => {
  const big = { usage: { ...USAGE, input_tokens: 100_000 } }
  const off = usageIo([worker('w1', 'a')])
  await meterStep(off.io, { ...SETTINGS, handoff: false }, { agentId: 'w1', model: 'sonnet' }, big)
  expect(off.calls.wrapUps).toEqual([])
  const rev = usageIo([{ ...worker('r1', 'r'), type: 'flow:reviewer' } as AgentRow])
  await meterStep(rev.io, SETTINGS, { agentId: 'r1', model: 'sonnet' }, big)
  expect(rev.calls.wrapUps).toEqual([])
})

test('meterStep never fails the step when the activity atom throws', async () => {
  const { io } = usageIo()
  io.activity = async () => { throw new Error('boom') }
  await meterStep(io, SETTINGS, { agentId: 'w1', model: 'sonnet' }, { usage: USAGE })
})
