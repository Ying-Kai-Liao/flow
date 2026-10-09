// The plan graph, pure: no `$` calls, so it is tested on its own. Each owner ("main" or a
// manager's name) has a graph of nodes; an edge says "start B after A is done".
import type { DagNode, Handover } from '../types'

export type Graph = Record<string, DagNode>
export type Plan = Record<string, Graph>

export type AgentFact = { name?: string; status: string; answer?: string }
export type Facts = { agents: AgentFact[]; handovers: Handover[]; phrases?: string[]; asking?: string[] }

export type NodeInput = { id: string; title?: string; after?: string[]; until?: 'merged' | 'reported' }

export type Notice = {
  owner: string
  ready: DagNode[]
  blocked: DagNode[]
  // The finished dependencies behind the ready nodes, for the message.
  done: DagNode[]
  // Free manager slots; only set for owner "main".
  slots?: number
}

// An agent with an open blocking ask in the decision inbox.
const isAsking = (agent: AgentFact, facts: Facts): boolean => agent.name !== undefined && !!facts.asking?.includes(agent.name)

// A phrase directly after one of these ("不需要你決定") says the opposite.
const NEGATIONS = ['不', '不用', '不必', '無需', '毋需', '不需要', 'no ', 'not ', "don't ", 'no need to ']

// The last line ends in a question mark, or the last paragraph holds one of the configured phrases
// (for agents that write in a language where a question has no "?").
export function asksQuestion(answer: string | undefined, phrases: string[] = []): boolean {
  const text = (answer ?? '').trim()
  const last = text.split('\n').pop() ?? ''
  if (/[?？][*_`'")\s]*$/.test(last)) return true
  const paragraph = (text.split(/\n[ \t]*\n/).pop() ?? '').toLowerCase()
  return phrases.some(p => {
    const phrase = p.trim().toLowerCase()
    if (phrase === '') return false
    for (let i = paragraph.indexOf(phrase); i >= 0; i = paragraph.indexOf(phrase, i + 1)) {
      const before = paragraph.slice(0, i)
      if (!NEGATIONS.some(n => before.endsWith(n))) return true
    }
    return false
  })
}

const lastLine = (answer: string | undefined) => (answer ?? '').trim().split('\n').pop() ?? ''
const LIVE = new Set(['running', 'pending'])

// Cycle path through the graph as "a -> b -> a", or undefined. `after` points at dependencies,
// so the walk follows them; the path is printed in the order the dependencies run.
function findCycle(graph: Graph): string | undefined {
  const state: Record<string, 1 | 2> = {}
  const stack: string[] = []
  const visit = (id: string): string | undefined => {
    if (state[id] === 2) return undefined
    if (state[id] === 1) {
      const from = stack.indexOf(id)
      return [...stack.slice(from), id].reverse().join(' -> ')
    }
    state[id] = 1
    stack.push(id)
    for (const dep of graph[id]?.after ?? []) {
      const found = visit(dep)
      if (found) return found
    }
    stack.pop()
    state[id] = 2
    return undefined
  }
  for (const id of Object.keys(graph)) {
    const found = visit(id)
    if (found) return found
  }
  return undefined
}

// All or nothing: a refused call leaves the graph as it was.
export function addNodes(graph: Graph, nodes: NodeInput[]): { graph: Graph } | { error: string } {
  const next: Graph = { ...graph }
  const added: string[] = []
  for (const n of nodes) {
    if (!n.id || !n.id.trim()) return { error: 'a node needs an id' }
    if (next[n.id]) return { error: `duplicate id: ${n.id}` }
    next[n.id] = {
      id: n.id,
      title: n.title ?? n.id,
      after: [...new Set(n.after ?? [])],
      until: n.until ?? 'merged',
      state: 'waiting',
    }
    added.push(n.id)
  }
  for (const id of added) {
    for (const dep of next[id]?.after ?? []) {
      if (!next[dep]) return { error: `unknown dependency: ${id} comes after ${dep}, which is not in the plan` }
    }
  }
  const cycle = findCycle(next)
  if (cycle) return { error: `cycle: ${cycle}` }
  return { graph: next }
}

// The agent named `id`, or its handoff continuations `<id>-N`; the newest has the highest N.
export function agentFor<T extends { name?: string }>(id: string, agents: T[]): T | undefined {
  let best: T | undefined
  let bestN = -1
  for (const a of agents) {
    const m = a.name === id ? 1 : a.name?.startsWith(id + '-') && /^\d+$/.test(a.name.slice(id.length + 1)) ? Number(a.name.slice(id.length + 1)) : 0
    if (m && m > bestN) {
      best = a
      bestN = m
    }
  }
  return best
}

const ownsBranch = (h: Handover, id: string) => h.branch === `flow/${id}`
const reportsTo = (h: Handover, id: string) => h.reportTo === id || (h.reportTo.startsWith(id + '-') && /^\d+$/.test(h.reportTo.slice(id.length + 1)))

// The newest handover per branch.
function latestPerBranch(hs: Handover[]): Handover[] {
  const by: Record<string, Handover> = {}
  for (const h of hs) if (!by[h.branch] || h.at >= by[h.branch]!.at) by[h.branch] = h
  return Object.values(by)
}

type Verdict = { state: 'done' | 'blocked' | 'running'; info?: string } | undefined

function judge(owner: string, node: DagNode, facts: Facts): Verdict {
  const agent = agentFor(node.id, facts.agents)
  const live = agent && LIVE.has(agent.status)
  const failed = agent && (agent.status === 'failed' || agent.status === 'killed')

  if (node.until === 'reported') {
    if (!agent) return undefined
    if (agent.status === 'idle' || agent.status === 'completed') {
      const last = lastLine(agent.answer)
      if (last.startsWith('BLOCKED:')) return { state: 'blocked', info: last }
      if (!asksQuestion(agent.answer, facts.phrases) && !isAsking(agent, facts) && !last.startsWith('HANDOFF:')) return { state: 'done', info: 'reported' }
    }
    if (failed) return { state: 'blocked', info: `agent ${agent.status}` }
    return { state: 'running' }
  }

  if (owner !== 'main') {
    // A worker's package: its PR merged.
    const h = facts.handovers.filter(x => ownsBranch(x, node.id)).sort((a, b) => b.at - a.at)[0]
    if (h?.status === 'done') return { state: 'done', info: `merged ${h.sha ?? h.head.slice(0, 7)}` }
    if (h?.status === 'returned' && !live) return { state: 'blocked', info: `PR returned: ${h.reason ?? 'no reason given'}` }
    if (failed) return { state: 'blocked', info: `agent ${agent.status}` }
    return agent || h ? { state: 'running' } : undefined
  }

  // A manager's task: it finished cleanly and everything it handed over is merged.
  if (!agent) return undefined
  if (failed) return { state: 'blocked', info: `agent ${agent.status}` }
  if (agent.status !== 'completed') return { state: 'running' }
  const last = lastLine(agent.answer)
  if (last.startsWith('BLOCKED:')) return { state: 'blocked', info: last }
  if (asksQuestion(agent.answer, facts.phrases) || isAsking(agent, facts) || last.startsWith('HANDOFF:')) return { state: 'running' }
  const hs = latestPerBranch(facts.handovers.filter(x => reportsTo(x, node.id)))
  const returned = hs.find(x => x.status === 'returned')
  if (returned) return { state: 'blocked', info: `PR #${returned.pr} returned: ${returned.reason ?? 'no reason given'}` }
  if (hs.some(x => x.status !== 'done')) return { state: 'running' }
  return { state: 'done', info: hs.length ? `merged ${hs.map(x => x.sha ?? x.head.slice(0, 7)).join(', ')}` : 'completed' }
}

// One owner's graph against what the session shows now. Done is sticky; `manual` wins.
export function evaluate(owner: string, graph: Graph, facts: Facts): Graph {
  const out: Graph = {}
  const visit = (id: string): DagNode => {
    const seen = out[id]
    if (seen) return seen
    const prev = graph[id]
    if (!prev) throw new Error(`unknown node: ${id}`)
    // Marks the node while it is being worked out, so a (refused) cycle cannot recurse forever.
    out[id] = prev
    const deps = prev.after.map(visit)
    let state = prev.state
    let info = prev.info
    if (prev.state === 'done') {
      // sticky
    } else if (prev.manual) {
      state = prev.manual
      info = info ?? 'set by hand'
    } else {
      const v = judge(owner, prev, facts)
      if (v) {
        state = v.state
        info = v.info
      } else {
        state = deps.every(d => d.state === 'done') ? 'ready' : 'waiting'
        info = undefined
      }
    }
    const node: DagNode = { ...prev, state }
    if (info === undefined) delete node.info
    else node.info = info
    out[id] = node
    return node
  }
  for (const id of Object.keys(graph)) visit(id)
  return out
}

// One pass over every owner: evaluate, and say once what newly became ready or blocked.
export function settle(plan: Plan, facts: Facts, opts: { slots?: number } = {}): { plan: Plan; notices: Notice[] } {
  const next: Plan = {}
  const notices: Notice[] = []
  for (const [owner, graph] of Object.entries(plan)) {
    const evaluated = evaluate(owner, graph, facts)
    const ready: DagNode[] = []
    const blocked: DagNode[] = []
    const marked: Graph = {}
    for (const n of Object.values(evaluated)) {
      let m = n
      // A node that left a state may enter it again later and deserves a new notice.
      if (n.state === 'waiting' && n.readyNotified) m = { ...m, readyNotified: false }
      if (n.state !== 'blocked' && n.blockedNotified) m = { ...m, blockedNotified: false }
      if (n.state === 'ready' && !n.readyNotified) {
        m = { ...m, readyNotified: true }
        ready.push(m)
      }
      if (n.state === 'blocked' && !n.blockedNotified) {
        m = { ...m, blockedNotified: true }
        blocked.push(m)
      }
      marked[n.id] = m
    }
    next[owner] = marked
    if (!ready.length && !blocked.length) continue
    const doneIds = new Set(ready.flatMap(n => n.after))
    const done = Object.values(marked).filter(n => doneIds.has(n.id) && n.state === 'done')
    notices.push({ owner, ready, blocked, done, ...(owner === 'main' && opts.slots !== undefined ? { slots: opts.slots } : {}) })
  }
  return { plan: next, notices }
}

const label = (n: DagNode) => `${n.id} (${n.title})`

export function noticeText(notice: Notice, slots: number | undefined = notice.slots): string {
  const parts: string[] = []
  if (notice.done.length) parts.push(notice.done.map(n => `${n.id} is done${n.info ? ` (${n.info})` : ''}`).join('; ') + '.')
  if (notice.ready.length) {
    parts.push(`Ready to start: ${notice.ready.map(label).join(', ')}.`)
    const n = notice.ready.length
    if (notice.owner === 'main' && slots !== undefined) {
      const now = Math.max(0, Math.min(n, slots))
      parts.push(
        now === 0
          ? `No manager slot is free; start them as slots free up.`
          : now === n
            ? `Start ${n === 1 ? 'it' : 'them'} now; build each brief on the merged code (git fetch origin first).`
            : `Start ${now} now and let the other ${n - now} wait for a free manager slot; build each brief on the merged code (git fetch origin first).`,
      )
    } else {
      parts.push(`Start ${n === 1 ? 'it' : 'them'} now; build each brief on the merged code (git fetch origin first).`)
    }
  }
  if (notice.blocked.length) {
    parts.push(`Blocked: ${notice.blocked.map(n => `${n.id}${n.info ? ` (${n.info})` : ''}`).join(', ')}. Their dependents stay waiting until you fix or lift them.`)
  }
  return `flow plan: ${parts.join(' ')}`
}

// Depth per node: the longest path from a root (a node without dependencies is 0).
export function layers(graph: Graph): Record<string, number> {
  const depth: Record<string, number> = {}
  const visit = (id: string): number => {
    const known = depth[id]
    if (known !== undefined) return known
    depth[id] = 0
    const d = Math.max(-1, ...(graph[id]?.after ?? []).filter(d => graph[d]).map(visit)) + 1
    depth[id] = d
    return d
  }
  for (const id of Object.keys(graph)) visit(id)
  return depth
}

// One line per node, shallowest first: "- login-redirect: waiting | after: csv-export (running)".
export function describe(graph: Graph): string[] {
  const depth = layers(graph)
  return Object.values(graph)
    .sort((a, b) => (depth[a.id] ?? 0) - (depth[b.id] ?? 0))
    .map(n => {
      const after = n.after.length ? ` | after: ${n.after.map(d => `${d} (${graph[d]?.state ?? '?'})`).join(', ')}` : ''
      return `- ${n.id}: ${n.state}${n.info ? ` (${n.info})` : ''}${after}`
    })
}
