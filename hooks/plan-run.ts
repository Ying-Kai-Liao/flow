import type { AgentRow } from '../types'
import type { Settings } from './prompts'
import { addNodes, describe } from './dag'
import type { Graph, Plan } from './dag'

// The plan tool: each owner's task graph. The engine refuses `$` across an import, so register.tsx builds
// a PlanIo of closures over the calls this needs.
export type PlanIo = {
  refresh: () => Promise<AgentRow[]>
  plans: () => Promise<Plan>
  planOwner: (plans: Plan, name: string | undefined) => string
  limitsLine: (rows: AgentRow[], workers: number) => string
  syncPlans: (rows: AgentRow[], edit?: (p: Plan) => Plan, quietOwner?: string) => Promise<Plan>
}

export async function planTool(io: PlanIo, settings: Settings, input: Record<string, unknown>, agentId: string | undefined): Promise<{ result: string }> {
    const rows = await io.refresh()
    const me = agentId === undefined ? undefined : rows.find(a => a.id === agentId)
    const plans = await io.plans()
    const owner = agentId === undefined ? 'main' : io.planOwner(plans, me?.name)
    const view = (p: Plan, who: string) => {
      const graph = p[who] ?? {}
      const lines = Object.keys(graph).length ? describe(graph) : ['No plan.']
      const ready = Object.values(graph).filter(n => n.state === 'ready').map(n => n.id)
      return [
        ...lines,
        ready.length ? `Ready now: ${ready.join(', ')}.` : 'Nothing is ready now.',
        ...(who === 'main' ? [io.limitsLine(rows, settings.maxWorkers)] : []),
      ].join('\n')
    }
    const action = String(input.action)
    if (action === 'list') {
      const who = owner === 'main' && typeof input.owner === 'string' && input.owner !== '' ? input.owner : owner
      return { result: view(await io.syncPlans(rows).then(() => io.plans()), who) }
    }
    const id = String(input.id ?? '')
    const change = async (edit: (g: Graph) => Graph | string) => {
      let refused: string | undefined
      const after = await io.syncPlans(rows, p => {
        const r = edit(p[owner] ?? {})
        if (typeof r === 'string') {
          refused = r
          return p
        }
        return { ...p, [owner]: r }
      }, owner)
      return refused !== undefined ? `Refused: ${refused}` : view(after, owner)
    }
    if (action === 'add') {
      const nodes = Array.isArray(input.nodes) ? input.nodes as Array<Record<string, unknown>> : []
      if (nodes.length === 0) return { result: 'Refused: add needs nodes: [{id, title, after?, until?}].' }
      const r = await change(g => {
        const added = addNodes(g, nodes.map(n => ({
          id: String(n.id ?? ''),
          title: typeof n.title === 'string' ? n.title : undefined,
          after: Array.isArray(n.after) ? n.after.map(String) : undefined,
          until: n.until === 'reported' ? 'reported' : 'merged',
        })))
        return 'error' in added ? added.error : added.graph
      })
      return { result: r }
    }
    const node = (plans[owner] ?? {})[id]
    if (!node) return { result: `Refused: no node "${id}" in ${owner === 'main' ? 'main' : owner}'s plan.` }
    if (action === 'done') {
      return { result: await change(g => ({ ...g, [id]: { ...g[id]!, manual: 'done', info: typeof input.note === 'string' && input.note !== '' ? input.note : undefined } })) }
    }
    if (action === 'block') {
      return { result: await change(g => ({ ...g, [id]: { ...g[id]!, manual: 'blocked', info: String(input.reason ?? 'blocked by hand') } })) }
    }
    if (action === 'remove') {
      return {
        result: await change(g => {
          const n = g[id]
          if (!n) return `no node "${id}"`
          if (n.state !== 'waiting' && n.state !== 'ready') return `${id} is ${n.state}; only waiting or ready nodes can be removed`
          const dependents = Object.values(g).filter(o => o.after.includes(id)).map(o => o.id)
          if (dependents.length) return `${dependents.join(', ')} still wait${dependents.length === 1 ? 's' : ''} on ${id}`
          const { [id]: _gone, ...rest } = g
          return rest
        }),
      }
    }
    return { result: `Unknown action "${action}".` }
}
