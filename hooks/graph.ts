// The graph view's layout, pure: no `$` calls, so it is tested on its own. A level (the managers
// of the session, or the workers of one manager) becomes text lines; the Pane colors the
// segments that carry a `node` by that node's state and moves a focus over them.
import type { DagNode } from '../types'
import { agentFor, layers } from './dag'
import type { Graph } from './dag'

export type GNode = {
  id: string
  label: string
  // A DagState, or an agent status for an agent that is not in the plan.
  state: string
  after: string[]
  agentId?: string
  badge?: string
}

export type Seg = { text: string; node?: string; dim?: boolean }
export type Layout = { mode: 'layers' | 'list'; lines: Seg[][]; at: Record<string, number>; order: string[] }

type AgentLike = { id: string; name?: string; status: string; type?: string }

// Columns are joined by this many characters: stub, trunk, arrow.
const GAP = 3
const MIN_WIDTH = 40
const MIN_COL = 10

// The nodes of one level: the plan's nodes, then the agents of that level the plan does not know.
// `children` counts the collapsed workers behind an agent id.
export function graphNodes(graph: Graph | undefined, agents: AgentLike[], opts: { children?: Record<string, number> } = {}): GNode[] {
  const plan = graph ?? {}
  const badgeOf = (agentId: string | undefined) => {
    const n = agentId ? opts.children?.[agentId] : undefined
    return n ? `+${n} workers` : undefined
  }
  const out: GNode[] = []
  for (const n of Object.values(plan)) {
    const agent = n.state === 'waiting' || n.state === 'ready' ? undefined : agentFor(n.id, agents.map(a => ({ ...a, name: a.name ?? a.id })))
    const found = agent && agents.find(a => a.id === agent.id)
    out.push({ id: n.id, label: n.id, state: n.state, after: [...n.after], ...(found ? { agentId: found.id } : {}), ...(badgeOf(found?.id) ? { badge: badgeOf(found?.id) } : {}) })
  }
  const taken = new Set(out.map(n => n.id))
  // An agent belongs to the plan when it is a node's agent or one of its handoff continuations.
  const inPlan = (name: string) => !!plan[name] || !!plan[name.replace(/-\d+$/, '')]
  for (const a of agents) {
    const name = a.name ?? a.id
    if (inPlan(name) || taken.has(a.id)) continue
    taken.add(a.id)
    out.push({ id: a.id, label: name, state: a.status, after: [], agentId: a.id, ...(badgeOf(a.id) ? { badge: badgeOf(a.id) } : {}) })
  }
  return out
}

const trunc = (s: string, n: number) => (s.length <= n ? s : n <= 1 ? '…'.slice(0, Math.max(n, 0)) : s.slice(0, n - 1) + '…')

// Box characters by which sides are connected.
const U = 1
const D = 2
const L = 4
const R = 8
const BOX: Record<number, string> = {
  [U]: '╵', [D]: '╷', [L]: '╴', [R]: '╶',
  [U | D]: '│', [L | R]: '─', [D | R]: '┌', [D | L]: '┐', [U | R]: '└', [U | L]: '┘',
  [U | D | R]: '├', [U | D | L]: '┤', [L | R | D]: '┬', [L | R | U]: '┴', [U | D | L | R]: '┼',
}

export function layoutGraph(nodes: GNode[], width: number): Layout {
  const seen = new Set<string>()
  const uniq = nodes.filter(n => !seen.has(n.id) && !!seen.add(n.id))
  // A dependency that is not in this level counts as no dependency: the node is a root.
  const deps: Record<string, string[]> = {}
  const g: Graph = {}
  for (const n of uniq) {
    deps[n.id] = n.after.filter(d => seen.has(d) && d !== n.id)
    g[n.id] = { id: n.id, title: n.label, after: deps[n.id], until: 'merged', state: 'waiting' } as unknown as DagNode
  }
  if (!uniq.length) return { mode: 'layers', lines: [], at: {}, order: [] }
  const depth = layers(g)
  const count = Math.max(...Object.values(depth)) + 1
  const byLayer: GNode[][] = Array.from({ length: count }, () => [])
  for (const n of uniq) byLayer[depth[n.id] ?? 0]?.push(n)
  const avail = Math.floor((width - GAP * (count - 1)) / count)
  if (width < MIN_WIDTH || avail < MIN_COL) return listLayout(byLayer, deps, uniq)
  return layerLayout(byLayer, deps, depth, avail, width)
}

function listLayout(byLayer: GNode[][], deps: Record<string, string[]>, all: GNode[]): Layout {
  const byId = Object.fromEntries(all.map(n => [n.id, n]))
  const lines: Seg[][] = []
  const at: Record<string, number> = {}
  const order: string[] = []
  byLayer.forEach((level, d) => {
    lines.push([{ text: `── ${d} ──`, dim: true }])
    for (const n of level) {
      at[n.id] = lines.length
      order.push(n.id)
      const line: Seg[] = [{ text: n.label, node: n.id }]
      if (n.badge) line.push({ text: ` ${n.badge}`, dim: true })
      const after = deps[n.id] ?? []
      if (after.length) line.push({ text: `  after: ${after.map(x => byId[x]?.label ?? x).join(', ')}`, dim: true })
      lines.push(line)
    }
  })
  return { mode: 'list', lines, at, order }
}

function layerLayout(byLayer: GNode[][], deps: Record<string, string[]>, depth: Record<string, number>, avail: number, width: number): Layout {
  const all = byLayer.flat()
  const byId = Object.fromEntries(all.map(n => [n.id, n]))
  const count = byLayer.length

  // Column widths: as wide as the longest label of the layer, never wider than the share of the pane.
  const full = (n: GNode) => n.label.length + (n.badge ? 1 + n.badge.length : 0)
  const colw = byLayer.map(level => Math.min(avail, Math.max(...level.map(full))))
  const colx: number[] = []
  colw.reduce((x, w, i) => ((colx[i] = x), x + w + GAP), 0)
  // Every id here comes from `all`, so the fallbacks only satisfy the index checks.
  const depthOf = (id: string) => depth[id] ?? 0
  const colwOf = (id: string) => colw[depthOf(id)] ?? 0
  const colxOf = (layer: number) => colx[layer] ?? 0

  // Rows: a node sits on the row of its highest dependency when that is free, so a chain is a
  // straight line; a layer's nodes never share a row.
  const row: Record<string, number> = {}
  byLayer.forEach(level => {
    const want = level.map((n, i) => {
      const ds = deps[n.id] ?? []
      return { n, i, w: ds.length ? Math.min(...ds.map(d => row[d] ?? 0)) : 0 }
    })
    want.sort((a, b) => a.w - b.w || a.i - b.i)
    let last = -1
    for (const { n, w } of want) row[n.id] = last = Math.max(w, last + 1)
  })
  const rowOf = (id: string) => row[id] ?? 0
  const rows = Math.max(...all.map(n => rowOf(n.id))) + 1

  // Edges between neighbouring layers share a trunk in the gap. Two edges may share it only when
  // they meet at one node (a fan-out or fan-in) or their row ranges do not touch; any other edge
  // is left out and named in an `after:` note under its node.
  const drawn: Array<Array<{ p: string; c: string; lo: number; hi: number }>> = Array.from({ length: count }, () => [])
  const rejected: Record<string, string[]> = {}
  const candidates: Array<{ p: string; c: string; gap: number }> = []
  for (const n of all) {
    for (const d of deps[n.id] ?? []) {
      if (depthOf(d) === depthOf(n.id) - 1) candidates.push({ p: d, c: n.id, gap: depthOf(d) })
      else (rejected[n.id] ??= []).push(d)
    }
  }
  const span = (e: { p: string; c: string }): [number, number] => [Math.min(rowOf(e.p), rowOf(e.c)), Math.max(rowOf(e.p), rowOf(e.c))]
  // Straight and short edges first: they are the ones that stay legible.
  candidates.sort((a, b) => Math.abs(rowOf(a.p) - rowOf(a.c)) - Math.abs(rowOf(b.p) - rowOf(b.c)))
  for (const e of candidates) {
    const [lo, hi] = span(e)
    const edges = drawn[e.gap] ?? []
    const clash = edges.some(o => o.p !== e.p && o.c !== e.c && o.lo <= hi && lo <= o.hi)
    if (clash) (rejected[e.c] ??= []).push(e.p)
    else edges.push({ p: e.p, c: e.c, lo, hi })
  }

  // One line per row, plus a note line under a row when one of its nodes has a rejected edge.
  const noted = new Set<number>()
  for (const id of Object.keys(rejected)) noted.add(rowOf(id))
  const rowLine: number[] = []
  let total = 0
  for (let r = 0; r < rows; r++) {
    rowLine[r] = total
    total += noted.has(r) ? 2 : 1
  }

  type Item = { col: number; text: string; node?: string; dim?: boolean }
  const items: Item[][] = Array.from({ length: total }, () => [])
  const masks: Array<Record<number, number>> = Array.from({ length: total }, () => ({}))
  const arrows: Array<Set<number>> = Array.from({ length: total }, () => new Set())
  const lineOf = (id: string) => rowLine[rowOf(id)] ?? 0
  const add = (line: number, col: number, m: number) => {
    const mask = masks[line]
    if (mask) mask[col] = (mask[col] ?? 0) | m
  }

  const fitted: Record<string, { label: string; badge?: string }> = {}
  for (const n of all) {
    const w = colwOf(n.id)
    const room = n.badge ? w - 1 - n.badge.length : w
    const fit = n.badge && room >= 2 ? { label: trunc(n.label, room), badge: n.badge } : { label: trunc(n.label, w) }
    fitted[n.id] = fit
    const its = items[lineOf(n.id)]
    its?.push({ col: colxOf(depthOf(n.id)), text: fit.label, node: n.id })
    if (fit.badge) its?.push({ col: colxOf(depthOf(n.id)) + fit.label.length + 1, text: fit.badge, dim: true })
  }
  const usedBy = (id: string) => {
    const f = fitted[id]
    return f ? f.label.length + (f.badge ? 1 + f.badge.length : 0) : 0
  }

  drawn.forEach((edges, gap) => {
    const x0 = colxOf(gap) + (colw[gap] ?? 0)
    for (const e of edges) {
      const lp = lineOf(e.p)
      const lc = lineOf(e.c)
      const used = usedBy(e.p)
      // Bridge the blank between a short label and the gap.
      for (let x = colxOf(gap) + used + 1; x < x0; x++) add(lp, x, L | R)
      add(lp, x0, L | R)
      add(lc, x0 + 2, L | R)
      arrows[lc]?.add(x0 + 2)
      if (lp === lc) {
        add(lp, x0 + 1, L | R)
        continue
      }
      const down = lc > lp
      add(lp, x0 + 1, L | (down ? D : U))
      add(lc, x0 + 1, R | (down ? U : D))
      for (let l = Math.min(lp, lc) + 1; l < Math.max(lp, lc); l++) add(l, x0 + 1, U | D)
    }
  })

  for (const id of Object.keys(rejected)) {
    const line = lineOf(id) + 1
    const text = `after: ${(rejected[id] ?? []).map(d => byId[d]?.label ?? d).join(', ')}`
    items[line]?.push({ col: colxOf(depthOf(id)), text, dim: true })
  }

  const lines: Seg[][] = items.map((its, line) => {
    const mask = masks[line] ?? {}
    // A note may run on into the gaps and the next column until something else is there.
    its.sort((a, b) => a.col - b.col)
    its.forEach((it, i) => {
      if (it.node || !it.text.startsWith('after: ')) return
      const owner = Object.keys(rejected).find(id => lineOf(id) + 1 === line && colxOf(depthOf(id)) === it.col) ?? ''
      const home = colwOf(owner)
      const limit = (its[i + 1]?.col ?? Infinity) - 1
      let end = Math.min(it.col + it.text.length, limit, width)
      for (let x = it.col + home; x < end; x++) {
        if (mask[x]) {
          end = x - 1
          break
        }
      }
      it.text = trunc(it.text, Math.max(end - it.col, 1))
    })
    for (const x of Object.keys(mask)) {
      const col = Number(x)
      const ch = arrows[line]?.has(col) ? '→' : BOX[mask[col] ?? 0] ?? '┼'
      its.push({ col, text: ch, dim: true })
    }
    its.sort((a, b) => a.col - b.col)
    const segs: Seg[] = []
    let cursor = 0
    for (const it of its) {
      if (it.col > cursor) segs.push({ text: ' '.repeat(it.col - cursor) })
      const last = segs[segs.length - 1]
      // Edge characters of one run become one segment.
      if (it.dim && !it.node && it.col === cursor && last?.dim && !last.node && /^[─│┌┐└┘├┤┬┴┼╵╷╴╶→]+$/.test(it.text + last.text)) last.text += it.text
      else segs.push({ text: it.text, ...(it.node ? { node: it.node } : {}), ...(it.dim ? { dim: true } : {}) })
      cursor = it.col + it.text.length
    }
    return segs
  })

  const at: Record<string, number> = {}
  const order: string[] = []
  byLayer.forEach(level => {
    for (const n of [...level].sort((a, b) => rowOf(a.id) - rowOf(b.id))) {
      at[n.id] = lineOf(n.id)
      order.push(n.id)
    }
  })
  return { mode: 'layers', lines, at, order }
}

// Where the focus goes. j/k walk `order` (layer by layer, wrapping at the ends); h goes to the
// first dependency, l to the first dependent; a key with nowhere to go keeps the focus.
export function moveFocus(layout: Layout, nodes: GNode[], cur: string | undefined, key: 'h' | 'j' | 'k' | 'l'): string | undefined {
  const { order } = layout
  if (!order.length) return undefined
  if (cur === undefined || !order.includes(cur)) return order[0]
  const byId = Object.fromEntries(nodes.map(n => [n.id, n]))
  const i = order.indexOf(cur)
  if (key === 'j') return order[(i + 1) % order.length]
  if (key === 'k') return order[(i - 1 + order.length) % order.length]
  if (key === 'h') return (byId[cur]?.after ?? []).find(d => order.includes(d)) ?? cur
  return order.find(id => byId[id]?.after.includes(cur)) ?? cur
}
