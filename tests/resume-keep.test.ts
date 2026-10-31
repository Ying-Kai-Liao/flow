import type { AgentInfo, AgentSpawnInput } from 'claude-code'
import { expect, mock } from 'claude-code/testing'
import { test } from './support'
import type { TestBody } from 'claude-code/testing'
import { onSpawn } from '../hooks/spawn-run'
import type { SpawnHookIo } from '../hooks/spawn-run'
import { settingsOf } from '../hooks/settings'
import { DIGEST_HEADER } from '../hooks/sizefeedback'
import { LITE_MARK } from '../hooks/prompts'
import { EMPTY_PREFLIGHT } from '../hooks/preflight'
import type { Preflight } from '../hooks/preflight'
import type { Activity, Ledger } from '../types'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const DIR = '/r/.git/flow'
const MIN = 60_000
const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

// Main (no parent) starts managers. The host answers a spawn of a name already on the roster with that agent's id,
// as it does when main's message resumes it, except for a name in `fresh`: main's Agent call starts a new agent under
// it. Every spawn the host sees is recorded with its prompt and model.
function world(on: On) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const agents: AgentInfo[] = []
  const files = new Map<string, string>()
  const spawned: { name?: string; model?: string; prompt: string }[] = []
  const logs: string[] = []
  const fresh = new Set<string>()
  on('agent.list', () => ({ value: agents }))
  on('agent.spawn', (_, e) => {
    const input = e as unknown as { subagentType: string; name?: string; description: string; model?: string; prompt: string; parentAgentId?: string }
    spawned.push({ name: input.name, model: input.model, prompt: input.prompt })
    const known = agents.findLast(a => a.name === input.name && a.type === input.subagentType && a.parentId === input.parentAgentId)
    if (known !== undefined && !fresh.has(input.name ?? '')) { known.status = 'running'; return { model: input.model ?? 'none', agentId: known.id } }
    const id = `a${agents.length + 1}`
    agents.push({ id, name: input.name, description: input.description, type: input.subagentType, status: 'running', parentId: input.parentAgentId })
    return { model: input.model ?? 'none', agentId: id }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.send', () => ({ isDelivered: true as const }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('fs.read', (_, e) => {
    const t = files.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('process.run', (_, e) => {
    const a = e.argv
    if (a[0] === 'git' && a[1] === 'rev-parse') return ok('/r/.git\n')
    if (a[0] === 'sh' && a[2]?.includes('>>')) logs.push(a[4] ?? '')
    if (a[0] === 'mv') {
      const t = files.get(a[1] ?? '')
      if (t !== undefined) { files.set(a[2] ?? '', t); files.delete(a[1] ?? '') }
    }
    return ok()
  })
  return { clock, agents, files, spawned, logs, fresh }
}

const manager = ($: Dollar, name: string, prompt: string, extra: Record<string, unknown> = {}) =>
  $.agent.spawn({ prompt, description: name, name, subagentType: 'flow:manager', ...extra } as never).then(r => JSON.stringify(r))
const ledger = async (w: ReturnType<typeof world>) => {
  await w.clock.advance(3500)
  await w.clock.settle()
  return JSON.parse(w.files.get(`${DIR}/ledger.json`) ?? '{}') as Ledger
}
const sizeItems = (w: ReturnType<typeof world>) =>
  (JSON.parse(w.files.get(`${DIR}/inbox.json`) ?? '{"items":[]}') as { items: Array<{ topic?: string }> }).items.filter(q => q.topic === 'manager-size')
const spawnLines = (w: ReturnType<typeof world>) => w.logs.filter(l => (JSON.parse(l) as { event: string }).event === 'spawn')
// Five sized first workers: enough history for size_feedback to append its digest to a manager's prompt.
const history = (w: ReturnType<typeof world>) => w.files.set(`${DIR}/ledger.json`, JSON.stringify(Object.fromEntries(
  ['a', 'b', 'c', 'd', 'e'].map((x, i) => [`h${x}`, { role: 'worker', name: `old-${x}`, size: 'small', branch: `flow/old-${x}`, models: {}, firstAt: 900_000 + i, lastAt: 900_000 + i }]),
)))
const RESUME = 'Your worker csv-fix reported: PR #7 is up.'

test('main resuming its manager leaves the ledger row, the size decision and the log as they were', async ($, on) => {
  const w = world(on)
  history(w)
  await manager($, 'csv', 'Size: small — one exporter\nTask')
  const first = (await ledger(w)).a1!
  expect(first).toMatchObject({ role: 'manager', name: 'csv', size: 'small', spawnModel: 'sonnet', sizeFeedback: true })
  expect(sizeItems(w).length).toBe(1)
  expect(spawnLines(w).length).toBe(1)

  await w.clock.advance(5 * MIN)
  expect(await manager($, 'csv', RESUME)).toContain('"agentId":"a1"')
  // A resume whose message carries a Size line of its own is the same manager too.
  await manager($, 'csv', 'Size: large — main says it grew\nGo on.')
  expect(w.agents.length).toBe(1)
  const after = (await ledger(w)).a1!
  expect(after).toEqual({ ...first, lastAt: after.lastAt })
  expect(sizeItems(w).length).toBe(1)
  expect(spawnLines(w).length).toBe(1)
  // Main's message reaches the manager as main wrote it: no digest, no model routing.
  for (const s of w.spawned.slice(1)) expect(s.model).toBeUndefined()
  expect(w.spawned[1]!.prompt).toBe(RESUME)
  expect(w.spawned[0]!.prompt).toContain(DIGEST_HEADER)
})

test('a resume of an idle or completed manager is the same manager', async ($, on) => {
  const w = world(on)
  await manager($, 'csv', 'Size: normal\nTask')
  for (const status of ['idle', 'completed'] as const) {
    w.agents[0]!.status = status
    await manager($, 'csv', RESUME)
  }
  expect(spawnLines(w).length).toBe(1)
  expect(w.spawned.map(s => s.prompt)).toEqual(['Size: normal\nTask', RESUME, RESUME])
})

test('a lite manager resumed gets no LITE rules again and keeps its lite record', async ($, on) => {
  const w = world(on)
  await manager($, 'quick', 'Mode: lite\nTask')
  expect(w.spawned[0]!.prompt).toContain(LITE_MARK)
  const lite = w.files.get(`${DIR}/lite.json`)
  expect(lite).toContain('"quick"')
  await w.clock.advance(5 * MIN)
  await manager($, 'quick', RESUME)
  expect(w.spawned[1]!.prompt).toBe(RESUME)
  expect(w.files.get(`${DIR}/lite.json`)).toBe(lite)
})

test('a resume is never refused for its model, also with pre-flight off', { options: { preflight: 'off' } }, async ($, on) => {
  const w = world(on)
  await manager($, 'csv', 'Size: small\nTask')
  expect(await manager($, 'csv', RESUME, { model: 'claude-fable-5-1' })).toContain('"agentId":"a1"')
  // A new manager on Fable is still refused, and a new name gets its own bookkeeping.
  expect(await manager($, 'login', 'Task', { model: 'claude-fable-5-1' })).toContain('Fable')
  await manager($, 'login', 'Size: small\nTask')
  expect(spawnLines(w).length).toBe(2)
  expect(Object.values(await ledger(w)).filter(r => r.role === 'manager').map(r => r.name).sort()).toEqual(['csv', 'login'])
})

test('a new manager main starts under a listed name gets its own start, and a resume of it keeps that', async ($, on) => {
  const w = world(on)
  await manager($, 'csv', 'Size: small\nTask')
  const first = (await ledger(w)).a1!
  w.fresh.add('csv')
  expect(await manager($, 'csv', 'Size: large\nA new task')).toContain('"agentId":"a2"')
  const rows = await ledger(w)
  expect(rows.a1).toEqual(first)
  expect(rows.a2).toMatchObject({ role: 'manager', name: 'csv' })
  expect(spawnLines(w).map(l => JSON.parse(l))).toEqual([
    expect.objectContaining({ event: 'spawn', agent: 'csv', owner: 'main' }),
    expect.objectContaining({ event: 'spawn', agent: 'csv', owner: 'main' }),
  ])
  // Before the start nothing tells it from a resume: main's prompt goes through as written, with no routing.
  expect(w.spawned[1]).toEqual({ name: 'csv', model: undefined, prompt: 'Size: large\nA new task' })
  // Main messages the new one: a resume of a2, with no new line and its row as it was.
  w.fresh.delete('csv')
  const second = rows.a2!
  expect(await manager($, 'csv', RESUME)).toContain('"agentId":"a2"')
  expect((await ledger(w)).a2).toEqual({ ...second, lastAt: (await ledger(w)).a2!.lastAt })
  expect(spawnLines(w).length).toBe(2)
  // A second new manager under the name is a third start.
  w.fresh.add('csv')
  expect(await manager($, 'csv', 'Another task')).toContain('"agentId":"a3"')
  expect(spawnLines(w).length).toBe(3)
})

// The activity card and the plan gate, seen through the hook's own io: every write is recorded.
function fakeIo(agents: AgentInfo[], plans: Record<string, unknown> = {}, preflight: Preflight = EMPTY_PREFLIGHT, agentCalls = new Set<string>()) {
  const acts: Record<string, Activity> = { a1: { startedAt: 1, lastAt: 2, log: ['started: csv', 'Edit hooks/x.ts'] } }
  const writes: string[] = []
  const efforts: string[] = []
  const pf = { state: preflight }
  const settings = settingsOf({}, 'main')
  const spawnIo = new Proxy({}, {
    get: (_, k) => async () => {
      writes.push(`spawn.${String(k)}`)
      if (k === 'ledger') return {}
      if (k === 'readLog') return []
      if (k === 'agents') return agents
      return undefined
    },
  })
  const io = {
    spawn: spawnIo,
    relay: () => undefined,
    settings: () => settings,
    options: () => ({}),
    now: async () => 1000,
    agentList: async () => agents,
    plans: async () => plans,
    lite: async () => ({}),
    gate: async () => undefined,
    jev: () => undefined,
    effortEnv: async () => undefined,
    toast: () => undefined,
    best: async (_: string, fn: () => Promise<void>) => fn(),
    refresh: async () => undefined,
    openPane: async () => undefined,
    updateActivity: async (fn: (a: Record<string, Activity>) => Record<string, Activity>) => { Object.assign(acts, fn(acts)) },
    changeLedger: async () => { writes.push('ledger') },
    withLite: async () => { writes.push('lite') },
    withPreflight: async <T>(fn: (cur: Preflight) => { state: Preflight; out: T }) => { writes.push('preflight'); const r = fn(pf.state); pf.state = r.state; return r.out },
    withFamilies: async () => { writes.push('families') },
    after: () => undefined,
    sessions: async () => ({}),
    terminalSettings: () => undefined,
    startRoleSession: async () => { throw new Error('not in agent mode') },
    noLong: () => false,
    setNoLong: () => undefined,
    noContinue: () => false,
    setNoContinue: () => undefined,
    takeExplicit: () => false,
    takeAgentCall: (id: string) => agentCalls.delete(id),
    setEffort: (_: string, effort: string) => { efforts.push(effort) },
  } as unknown as SpawnHookIo
  return { io, acts, writes, efforts, pf, agentCalls }
}
const input = (name: string, prompt: string): AgentSpawnInput => ({ prompt, description: name, name, subagentType: 'flow:manager' } as never)

test('a resume keeps the activity card and effort, and passes the plan gate', async () => {
  const agents: AgentInfo[] = [{ id: 'a1', name: 'csv', description: 'csv', type: 'flow:manager', status: 'completed' }]
  const plans = { main: { csv: { id: 'csv', after: ['schema'], state: 'waiting' }, schema: { id: 'schema', after: [], state: 'running' } } }
  const f = fakeIo(agents, plans)
  const seen: AgentSpawnInput[] = []
  const r = await onSpawn(f.io, input('csv', RESUME), async ev => { seen.push(ev); return { agentId: 'a1' } })
  expect(r).toEqual({ agentId: 'a1' })
  expect(seen).toEqual([input('csv', RESUME)])
  expect(f.acts.a1).toEqual({ startedAt: 1, lastAt: 1000, log: ['started: csv', 'Edit hooks/x.ts'] })
  expect(f.efforts).toEqual([])
  expect(f.writes.filter(x => x !== 'preflight')).toEqual([])
})

test('a new manager still opens its card and is held by the plan gate', async () => {
  const agents: AgentInfo[] = [{ id: 'a1', name: 'csv', description: 'csv', type: 'flow:manager', status: 'running' }]
  const f = fakeIo(agents, { main: { login: { id: 'login', after: ['schema'], state: 'waiting' }, schema: { id: 'schema', after: [], state: 'running' } } })
  const next = async () => ({ agentId: 'a2' })
  expect(await onSpawn(f.io, input('login', 'Task'), next)).toMatchObject({ deny: expect.stringContaining('waits on schema') })
  expect(await onSpawn(f.io, input('export', 'Size: large\nTask'), next)).toEqual({ agentId: 'a2' })
  expect(f.acts.a2).toMatchObject({ startedAt: 1000, log: ['started: export'] })
  expect(f.writes).toContain('ledger')
  expect(f.writes).toContain('spawn.appendLog')
})

test('a new agent under a listed name gets its card, ledger row, family and spawn line, and keeps the filed pre-flight', async () => {
  const agents: AgentInfo[] = [{ id: 'a1', name: 'csv', description: 'csv', type: 'flow:manager', status: 'completed' }]
  const filed: Preflight = { next: 2, rounds: [], entries: { csv: { name: 'csv', phase: 'filed', round: 1, spawnedAt: 1, blocking: [], asked: [] } } } as never
  const f = fakeIo(agents, {}, filed)
  const seen: AgentSpawnInput[] = []
  expect(await onSpawn(f.io, input('csv', 'Size: large\nA new task'), async ev => { seen.push(ev); return { agentId: 'a2' } })).toEqual({ agentId: 'a2' })
  expect(seen).toEqual([input('csv', 'Size: large\nA new task')])
  expect(f.acts.a1).toEqual({ startedAt: 1, lastAt: 2, log: ['started: csv', 'Edit hooks/x.ts'] })
  expect(f.acts.a2).toMatchObject({ startedAt: 1000, lastAt: 1000, log: ['started: csv'] })
  expect(f.writes).toEqual(expect.arrayContaining(['families', 'ledger', 'preflight', 'spawn.appendLog']))
  expect(f.pf.state).toBe(filed)
})

// Main's Agent call as the host runs it: the tool.call hooks run first, the spawn under the same tool_use_id inside
// the call (the mock holds the call open until the spawn is done), then the call ends. A call with no spawn never spawns.
function agentCalls(on: On) {
  let opened = (_end: () => void): void => undefined
  on('tool.call', () => new Promise(done => opened(() => done({ result: 'ok' }))))
  let n = 0
  return async ($: Dollar, name: string, prompt: string, spawn = true) => {
    const id = `tu${++n}`
    const end = new Promise<() => void>(r => { opened = r })
    const call = $.tool.call({ tool: 'Agent', tool_use_id: id, name, prompt } as never)
    const finish = await end
    const r = spawn ? await manager($, name, prompt, { tool_use_id: id }) : ''
    finish()
    await call
    return { r, id }
  }
}

test('main\'s Agent call under a listed name is a new start: routing, digest, LITE rules, size decision, ledger size and spawn line', async ($, on) => {
  const w = world(on)
  const agentCall = agentCalls(on)
  history(w)
  // A large manager files no size decision (fileManagerSizeFyi), so the new start's is the first.
  await manager($, 'csv', 'Size: large\nTask')
  expect(sizeItems(w).length).toBe(0)
  w.fresh.add('csv')
  expect((await agentCall($, 'csv', 'Size: small — a new task\nTask')).r).toContain('a2')
  expect(w.spawned[1]!.model).toBe('sonnet')
  expect(w.spawned[1]!.prompt).toContain(DIGEST_HEADER)
  expect((await ledger(w)).a2).toMatchObject({ role: 'manager', name: 'csv', size: 'small', sizeFeedback: true })
  expect(sizeItems(w).length).toBe(1)
  expect(spawnLines(w).length).toBe(2)
  // A lite new start under the name gets the LITE rules, its row and line, and files no size decision.
  expect((await agentCall($, 'csv', 'Mode: lite\nSize: normal\nAnother task')).r).toContain('a3')
  expect(w.spawned[2]!.prompt).toContain(LITE_MARK)
  expect((await ledger(w)).a3).toMatchObject({ size: 'normal' })
  expect(sizeItems(w).length).toBe(1)
  expect(spawnLines(w).length).toBe(3)
})

test('a spawn with no Agent call behind it is a resume; an Agent call the host answers with the listed id keeps the bookkeeping', async ($, on) => {
  const w = world(on)
  const agentCall = agentCalls(on)
  await manager($, 'csv', 'Size: small\nTask')
  const first = (await ledger(w)).a1!
  expect(await manager($, 'csv', RESUME)).toContain('"agentId":"a1"')
  expect(w.spawned[1]).toEqual({ name: 'csv', model: undefined, prompt: RESUME })
  // The host resumed a1 for main's Agent call: no new row, decision or line.
  expect((await agentCall($, 'csv', 'Size: large\nGo on')).r).toContain('a1')
  expect(w.spawned[2]!.model).toBe('opus')
  expect((await ledger(w)).a1).toEqual({ ...first, lastAt: (await ledger(w)).a1!.lastAt })
  expect(spawnLines(w).length).toBe(1)
  expect(sizeItems(w).length).toBe(1)
})

test('an Agent call that never spawns leaves no id behind: a later spawn under it is a resume', async ($, on) => {
  const w = world(on)
  const agentCall = agentCalls(on)
  await manager($, 'csv', 'Size: small\nTask')
  const { id } = await agentCall($, 'csv', 'Size: large\nTask', false)
  w.fresh.add('csv')
  await manager($, 'csv', 'Size: large\nA new task', { tool_use_id: id })
  expect(w.spawned[1]).toEqual({ name: 'csv', model: undefined, prompt: 'Size: large\nA new task' })
})

test('the plan gate holds main\'s Agent call starting a waiting node under a listed name', async () => {
  const agents: AgentInfo[] = [{ id: 'a1', name: 'csv', description: 'csv', type: 'flow:manager', status: 'completed' }]
  const plans = { main: { csv: { id: 'csv', after: ['schema'], state: 'waiting' }, schema: { id: 'schema', after: [], state: 'running' } } }
  const f = fakeIo(agents, plans, EMPTY_PREFLIGHT, new Set(['tu1']))
  const seen: AgentSpawnInput[] = []
  const r = await onSpawn(f.io, { ...input('csv', 'Task'), tool_use_id: 'tu1' }, async ev => { seen.push(ev); return { agentId: 'a2' } })
  expect(r).toMatchObject({ deny: expect.stringContaining('waits on schema') })
  expect(seen).toEqual([])
  expect(f.agentCalls.size).toBe(0)
  // The same spawn with no Agent call is a resume, past the gate.
  expect(await onSpawn(f.io, { ...input('csv', RESUME), tool_use_id: 'tu2' }, async () => ({ agentId: 'a1' }))).toEqual({ agentId: 'a1' })
})

test('main\'s Agent call under a listed name answered with a new id records its pre-flight again', async () => {
  const agents: AgentInfo[] = [{ id: 'a1', name: 'csv', description: 'csv', type: 'flow:manager', status: 'completed' }]
  const filed: Preflight = { next: 2, rounds: [], entries: { csv: { name: 'csv', phase: 'filed', round: 1, spawnedAt: 1, blocking: [], asked: [] } } } as never
  const f = fakeIo(agents, {}, filed, new Set(['tu1']))
  expect(await onSpawn(f.io, { ...input('csv', 'Size: large\nA new task'), tool_use_id: 'tu1' }, async () => ({ agentId: 'a2' }))).toEqual({ agentId: 'a2' })
  expect(f.acts.a2).toMatchObject({ startedAt: 1000, log: ['started: csv'] })
  expect(f.writes).toEqual(expect.arrayContaining(['families', 'ledger', 'preflight', 'spawn.appendLog']))
  expect(f.pf.state).toBe(filed)
})
