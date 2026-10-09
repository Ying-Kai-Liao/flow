import { expect } from 'claude-code/testing'
import { test } from './support'
import type { DagNode, Handover } from '../types'
import { addNodes, agentFor, asksQuestion, describe, evaluate, layers, noticeText, settle } from '../hooks/dag'
import { branchOwners } from '../hooks/state'
import type { LogEvent } from '../types'
import type { AgentFact, Facts, Graph, Plan } from '../hooks/dag'

const EMPTY: Facts = { agents: [], handovers: [] }

function build(nodes: Array<{ id: string; after?: string[]; until?: 'merged' | 'reported' }>, base: Graph = {}): Graph {
  const r = addNodes(base, nodes)
  if ('error' in r) throw new Error(r.error)
  return r.graph
}

const handover = (branch: string, status: Handover['status'], at: number, extra: Partial<Handover> = {}): Handover => ({
  pr: 1, title: 't', head: 'abc1234def', branch, reportTo: 'm', verified: '', pending: '', afterDeploy: '', status, at, ...extra,
})

const stateOf = (g: Graph, id: string) => g[id]!.state

test('addNodes refuses cycles and names the path', async () => {
  const self = addNodes({}, [{ id: 'a', after: ['a'] }])
  expect(self).toEqual({ error: 'cycle: a -> a' })
  const two = addNodes({}, [{ id: 'a', after: ['b'] }, { id: 'b', after: ['a'] }])
  expect(two).toEqual({ error: 'cycle: a -> b -> a' })
  const three = addNodes({}, [{ id: 'a', after: ['c'] }, { id: 'b', after: ['a'] }, { id: 'c', after: ['b'] }])
  expect('error' in three && three.error).toBe('cycle: a -> b -> c -> a')
})

test('an agent with an open blocking ask is not reported and stays running', async () => {
  const g = build([{ id: 'w', until: 'reported' }])
  const agents: AgentFact[] = [{ name: 'w', status: 'idle', answer: 'All done.' }]
  expect(stateOf(evaluate('m', g, { ...EMPTY, agents }), 'w')).toBe('done')
  expect(stateOf(evaluate('m', g, { ...EMPTY, agents, asking: ['w'] }), 'w')).toBe('running')
  expect(stateOf(evaluate('m', g, { ...EMPTY, agents, asking: ['other'] }), 'w')).toBe('done')
})

test('a diamond is not a cycle', async () => {
  const g = build([{ id: 'a' }, { id: 'b', after: ['a'] }, { id: 'c', after: ['a'] }, { id: 'd', after: ['b', 'c'] }])
  expect(Object.keys(g)).toEqual(['a', 'b', 'c', 'd'])
  expect(layers(g)).toEqual({ a: 0, b: 1, c: 1, d: 2 })
})

test('addNodes refuses unknown dependencies and duplicates, atomically', async () => {
  const base = build([{ id: 'a' }])
  const unknown = addNodes(base, [{ id: 'b', after: ['a'] }, { id: 'c', after: ['nope'] }])
  expect('error' in unknown && unknown.error).toContain('nope')
  const dupe = addNodes(base, [{ id: 'a' }])
  expect('error' in dupe && dupe.error).toContain('duplicate id: a')
  const dupeInCall = addNodes(base, [{ id: 'x' }, { id: 'x' }])
  expect('error' in dupeInCall && dupeInCall.error).toContain('duplicate id: x')
  // The input graph is untouched by a refused call.
  expect(Object.keys(base)).toEqual(['a'])
  // A dependency within the same call is fine, whatever the order.
  const ok = addNodes(base, [{ id: 'c', after: ['b'] }, { id: 'b', after: ['a'] }])
  expect('graph' in ok && Object.keys(ok.graph)).toEqual(['a', 'c', 'b'])
  expect('graph' in ok && ok.graph.b!.until).toBe('merged')
})

test('agentFor picks the newest continuation', async () => {
  const agents: AgentFact[] = [{ name: 'csv', status: 'completed' }, { name: 'csv-2', status: 'running' }, { name: 'csv-10', status: 'running' }, { name: 'csv-export', status: 'running' }]
  expect(agentFor('csv', agents)?.name).toBe('csv-10')
  expect(agentFor('nope', agents)).toBeUndefined()
})

test('a worker node waits for its dependency, then is ready, running, done', async () => {
  const g = build([{ id: 'a' }, { id: 'b', after: ['a'] }])
  const first = evaluate('m', g, EMPTY)
  expect([stateOf(first, 'a'), stateOf(first, 'b')]).toEqual(['ready', 'waiting'])

  const running = evaluate('m', first, { agents: [{ name: 'a', status: 'running' }], handovers: [] })
  expect([stateOf(running, 'a'), stateOf(running, 'b')]).toEqual(['running', 'waiting'])

  const merged = evaluate('m', running, { agents: [{ name: 'a', status: 'completed' }], handovers: [handover('flow/a', 'done', 5, { sha: 'abc123' })] })
  expect([stateOf(merged, 'a'), stateOf(merged, 'b')]).toEqual(['done', 'ready'])
  expect(merged.a!.info).toBe('merged abc123')

  // Done is sticky, even when the facts disappear.
  expect(stateOf(evaluate('m', merged, EMPTY), 'a')).toBe('done')
})

test('a returned PR blocks, a continuation lifts it, the latest handover decides', async () => {
  const g = build([{ id: 'a' }, { id: 'b', after: ['a'] }])
  const returned = handover('flow/a', 'returned', 5, { reason: 'check failed' })
  const done = { agents: [{ name: 'a', status: 'completed' }], handovers: [returned] }
  const blocked = evaluate('m', g, done)
  expect(stateOf(blocked, 'a')).toBe('blocked')
  expect(blocked.a!.info).toBe('PR returned: check failed')
  expect(stateOf(blocked, 'b')).toBe('waiting')

  const lifted = evaluate('m', blocked, { agents: [...done.agents, { name: 'a-2', status: 'running' }], handovers: [returned] })
  expect(stateOf(lifted, 'a')).toBe('running')

  const again = evaluate('m', blocked, { agents: done.agents, handovers: [returned, handover('flow/a', 'done', 9, { sha: 'f00' })] })
  expect(stateOf(again, 'a')).toBe('done')
  // Order in the list does not matter, `at` does.
  const older = evaluate('m', g, { agents: done.agents, handovers: [handover('flow/a', 'done', 3), returned] })
  expect(stateOf(older, 'a')).toBe('blocked')
})

test('a failed or killed agent blocks, unless a newer continuation is live', async () => {
  const g = build([{ id: 'a' }])
  expect(stateOf(evaluate('m', g, { agents: [{ name: 'a', status: 'failed' }], handovers: [] }), 'a')).toBe('blocked')
  expect(stateOf(evaluate('m', g, { agents: [{ name: 'a', status: 'killed' }], handovers: [] }), 'a')).toBe('blocked')
  expect(stateOf(evaluate('m', g, { agents: [{ name: 'a', status: 'killed' }, { name: 'a-2', status: 'running' }], handovers: [] }), 'a')).toBe('running')
})

test('a manager node is done when it finished cleanly and its PRs are merged', async () => {
  const g = build([{ id: 'csv' }, { id: 'login', after: ['csv'] }])
  const finished = (answer: string, status = 'completed'): AgentFact[] => [{ name: 'csv', status, answer }]
  const ev = (agents: AgentFact[], handovers: Handover[] = []) => evaluate('main', g, { agents, handovers })

  expect(stateOf(ev([{ name: 'csv', status: 'running' }]), 'csv')).toBe('running')
  expect(stateOf(ev(finished('All merged.')), 'csv')).toBe('done')
  expect(ev(finished('All merged.')).csv!.info).toBe('completed')
  expect(stateOf(ev(finished('All merged.')), 'login')).toBe('ready')

  expect(stateOf(ev(finished('Shall I go on?')), 'csv')).toBe('running')
  expect(stateOf(ev(finished('context\nHANDOFF: feature/x')), 'csv')).toBe('running')
  expect(stateOf(ev(finished('BLOCKED: no access')), 'csv')).toBe('blocked')
  expect(stateOf(ev(finished('x', 'failed')), 'csv')).toBe('blocked')

  const pending = handover('flow/p1', 'pending', 1, { reportTo: 'csv' })
  expect(stateOf(ev(finished('ok'), [pending]), 'csv')).toBe('running')
  const merged = handover('flow/p1', 'done', 2, { reportTo: 'csv-2', sha: 'abc' })
  expect(ev(finished('ok'), [pending, merged]).csv!.info).toBe('merged abc')
  expect(stateOf(ev(finished('ok'), [pending, merged]), 'csv')).toBe('done')
  expect(stateOf(ev(finished('ok'), [merged, handover('flow/p2', 'returned', 3, { reportTo: 'csv' })]), 'csv')).toBe('blocked')
  // Handovers for other managers do not count.
  expect(stateOf(ev(finished('ok'), [handover('flow/z', 'pending', 1, { reportTo: 'csv-export' })]), 'csv')).toBe('done')
})

test('until reported: idle with a plain answer is done, a question is not', async () => {
  const g = build([{ id: 'scout', until: 'reported' }, { id: 'build', after: ['scout'] }])
  const ev = (agent: AgentFact) => evaluate('m', g, { agents: [agent], handovers: [] })
  expect(stateOf(ev({ name: 'scout', status: 'idle', answer: 'Found it.' }), 'scout')).toBe('done')
  expect(stateOf(ev({ name: 'scout', status: 'completed', answer: 'Found it.' }), 'scout')).toBe('done')
  expect(stateOf(ev({ name: 'scout', status: 'idle', answer: 'Found it.' }), 'build')).toBe('ready')
  expect(stateOf(ev({ name: 'scout', status: 'idle', answer: 'Which one?' }), 'scout')).toBe('running')
  expect(stateOf(ev({ name: 'scout', status: 'idle', answer: 'BLOCKED: x' }), 'scout')).toBe('blocked')
  expect(stateOf(ev({ name: 'scout', status: 'completed', answer: 'HANDOFF: x' }), 'scout')).toBe('running')
  expect(stateOf(ev({ name: 'scout', status: 'running' }), 'scout')).toBe('running')
})

test('asksQuestion: configured phrases count in the last paragraph unless negated', async () => {
  const P = ['需要你決定', 'Please Confirm']
  expect(asksQuestion('做完了。\n\n這需要你決定。', P)).toBe(true)
  expect(asksQuestion('做完了。\n\nplease confirm the plan', P)).toBe(true)
  expect(asksQuestion('這需要你決定。\n\n全部完成。', P)).toBe(false)
  expect(asksQuestion('不需要你決定。', P)).toBe(false)
  expect(asksQuestion('There is no need to please confirm', P)).toBe(false)
  expect(asksQuestion('不需要你決定，但這需要你決定', P)).toBe(true)
  expect(asksQuestion('這需要你決定。')).toBe(false)
  expect(asksQuestion('這需要你決定。', [])).toBe(false)
  expect(asksQuestion('Which one?')).toBe(true)
  expect(asksQuestion('Which one?', P)).toBe(true)
  expect(asksQuestion(undefined, P)).toBe(false)
  expect(asksQuestion('', P)).toBe(false)
  expect(asksQuestion('anything', [''])).toBe(false)
})

test('the DAG treats a report ending in a configured phrase as asking', async () => {
  const g = build([{ id: 'scout', until: 'reported' }])
  const agent: AgentFact = { name: 'scout', status: 'idle', answer: '完成了方案。\n\n需要你決定。' }
  expect(stateOf(evaluate('m', g, { agents: [agent], handovers: [] }), 'scout')).toBe('done')
  expect(stateOf(evaluate('m', g, { agents: [agent], handovers: [], phrases: ['需要你決定'] }), 'scout')).toBe('running')
})

test('manual wins over the facts', async () => {
  const g = build([{ id: 'a' }, { id: 'b', after: ['a'] }])
  g.a = { ...g.a!, manual: 'done' }
  const ev = evaluate('m', g, { agents: [{ name: 'a', status: 'failed' }], handovers: [] })
  expect([stateOf(ev, 'a'), stateOf(ev, 'b')]).toEqual(['done', 'ready'])
  g.a = { ...g.a!, manual: 'blocked' }
  expect(stateOf(evaluate('m', g, EMPTY), 'a')).toBe('blocked')
})

test('settle sends one notice per owner for 15 nodes ready at once, and none on a repeat', async () => {
  const roots = build([{ id: 'base' }])
  const many = build(Array.from({ length: 15 }, (_, i) => ({ id: `t${i}`, after: ['base'] })), roots)
  const plan: Plan = { main: many, mgr: build([{ id: 'x' }]) }
  const facts: Facts = { agents: [{ name: 'base', status: 'completed', answer: 'ok' }], handovers: [] }

  const first = settle(plan, facts, { slots: 3 })
  const main = first.notices.find(n => n.owner === 'main')!
  expect(first.notices.length).toBe(2)
  expect(main.ready.length).toBe(15)
  expect(main.done.map(n => n.id)).toEqual(['base'])
  const text = noticeText(main)
  expect(text).toContain('flow plan: base is done (completed).')
  expect(text).toContain('Start 3 now and let the other 12 wait for a free manager slot')
  expect(first.plan.main!.t0!.readyNotified).toBe(true)

  const second = settle(first.plan, facts, { slots: 3 })
  expect(second.notices).toEqual([])
  expect(second.plan).toEqual(first.plan)
})

test('settle notices blocked nodes once, and again after they recover and fail anew', async () => {
  const plan: Plan = { m: build([{ id: 'a' }]) }
  const failed: Facts = { agents: [{ name: 'a', status: 'failed' }], handovers: [] }
  const first = settle(plan, failed)
  expect(first.notices[0]!.blocked.map(n => n.id)).toEqual(['a'])
  expect(noticeText(first.notices[0]!)).toContain('Blocked: a (agent failed)')
  expect(settle(first.plan, failed).notices).toEqual([])
  const live = settle(first.plan, { agents: [{ name: 'a', status: 'failed' }, { name: 'a-2', status: 'running' }], handovers: [] })
  expect(live.notices).toEqual([])
  const again = settle(live.plan, failed)
  expect(again.notices[0]!.blocked.map(n => n.id)).toEqual(['a'])
})

test('noticeText for a single ready node and no free slot', async () => {
  const node: DagNode = { id: 'login', title: 'Fix the login redirect', after: [], until: 'merged', state: 'ready' }
  expect(noticeText({ owner: 'm', ready: [node], blocked: [], done: [] })).toBe(
    'flow plan: Ready to start: login (Fix the login redirect). Start it now; build each brief on the merged code (git fetch origin first).',
  )
  expect(noticeText({ owner: 'main', ready: [node], blocked: [], done: [] }, 0)).toContain('No manager slot is free')
})

test('layers and describe on a diamond', async () => {
  const g = build([{ id: 'd', after: ['b', 'c'] }, { id: 'b', after: ['a'] }, { id: 'c', after: ['a'] }, { id: 'a' }])
  expect(layers(g)).toEqual({ a: 0, b: 1, c: 1, d: 2 })
  const ev = evaluate('m', g, { agents: [{ name: 'a', status: 'running' }], handovers: [] })
  expect(describe(ev)).toEqual([
    '- a: running',
    '- b: waiting | after: a (running)',
    '- c: waiting | after: a (running)',
    '- d: waiting | after: b (waiting), c (waiting)',
  ])
})

test('an idle manager is done once its report is final, its handovers merged, no live workers and no planned work', async () => {
  const g = build([{ id: 'ev' }, { id: 'next', after: ['ev'] }])
  const merged = handover('flow/ev-worker', 'done', 5, { reportTo: 'ev' })
  const ev = (agent: AgentFact, hs: Handover[]) => evaluate('main', g, { agents: [agent], handovers: hs })
  const idle = { name: 'ev', status: 'idle', answer: 'Nothing else waits on you.' }
  expect(stateOf(ev(idle, [merged]), 'ev')).toBe('done')
  expect(stateOf(ev(idle, [merged]), 'next')).toBe('ready')
  // An investigation that never opened a PR finishes too.
  expect(stateOf(ev(idle, []), 'ev')).toBe('done')
  expect(stateOf(ev({ ...idle, answer: 'Which one?' }, []), 'ev')).toBe('running')
  expect(stateOf(ev({ ...idle, answer: 'HANDOFF: flow/x' }, []), 'ev')).toBe('running')
  expect(stateOf(ev({ ...idle, answer: 'BLOCKED: x' }, []), 'ev')).toBe('blocked')
  // Work still planned in the manager's own graph keeps it running.
  const own = build([{ id: 'w1' }])
  const open = settle({ main: g, ev: own }, { agents: [idle], handovers: [] }).plan
  expect(open['main']!['ev']!.state).toBe('running')
  const closed = settle({ main: g, ev: { w1: { ...own['w1']!, state: 'done' } } }, { agents: [idle], handovers: [] }).plan
  expect(closed['main']!['ev']!.state).toBe('done')
  expect(stateOf(ev({ ...idle, children: 1 }, [merged]), 'ev')).toBe('running')
  expect(stateOf(ev(idle, [{ ...merged, status: 'pending' }]), 'ev')).toBe('running')
})

test('a handover with a wrong report_to still counts for the manager that started the worker', async () => {
  const g = build([{ id: 'ask-inbox' }])
  const events = [
    { ts: 't', event: 'spawn', agent: 'ask-inbox', owner: 'main' },
    { ts: 't', event: 'spawn', agent: 'decision-inbox-ask-tool', owner: 'ask-inbox' },
    { ts: 't', event: 'continue', agent: 'decision-inbox-ask-tool-2', owner: 'ask-inbox', branch: 'flow/decision-inbox-ask-tool' },
    { ts: 't', event: 'handover', owner: 'decision-inbox', pr: 33, branch: 'flow/decision-inbox-ask-tool' },
  ] as LogEvent[]
  const owners = branchOwners(events)
  expect(owners['flow/decision-inbox-ask-tool']).toBe('ask-inbox')
  const h = handover('flow/decision-inbox-ask-tool', 'pending', 5, { reportTo: 'decision-inbox' })
  const agent = { name: 'ask-inbox', status: 'completed', answer: 'Done.' }
  const facts = { agents: [agent], handovers: [h], owners }
  expect(stateOf(evaluate('main', g, facts), 'ask-inbox')).toBe('running')
  expect(stateOf(evaluate('main', g, { ...facts, handovers: [{ ...h, status: 'done' }] }), 'ask-inbox')).toBe('done')
})

test('with two rows of one name the live one decides', async () => {
  const rows = [{ name: 'm', status: 'completed' }, { name: 'm', status: 'running' }]
  expect(agentFor('m', rows)?.status).toBe('running')
})

test('an idle manager is not done while a worker reported after the manager last acted', async () => {
  const g = build([{ id: 'ev' }])
  const idle = { name: 'ev', status: 'idle', answer: "I'm waiting for its report.", at: 100 }
  const stateWith = (a: AgentFact) => stateOf(evaluate('main', g, { agents: [a], handovers: [] }), 'ev')
  // The worker ended at 150, the manager has not been resumed with its notification yet.
  expect(stateWith({ ...idle, childAt: 150 })).toBe('running')
  // The manager acted after its last worker reported.
  expect(stateWith({ ...idle, childAt: 90 })).toBe('done')
})
