import { expect, test } from 'claude-code/testing'
import type { DagNode } from '../types'
import { graphNodes, layoutGraph, moveFocus } from '../hooks/graph'
import type { GNode, Layout } from '../hooks/graph'

const gn = (id: string, after: string[] = [], extra: Partial<GNode> = {}): GNode => ({ id, label: id, state: 'waiting', after, ...extra })
const diamond = () => [gn('a'), gn('b', ['a']), gn('c', ['a']), gn('d', ['b', 'c'])]
const text = (l: Layout) => l.lines.map(line => line.map(s => s.text).join(''))
// Column where a node's own segment starts on its line.
const colOf = (l: Layout, id: string) => {
  let col = 0
  for (const s of l.lines[l.at[id] ?? -1] ?? []) {
    if (s.node === id) return col
    col += s.text.length
  }
  return -1
}

test('a diamond lays out in layers, one spot per node, with its edges', async () => {
  const l = layoutGraph(diamond(), 80)
  expect(l.mode).toBe('layers')
  const spots = new Set(['a', 'b', 'c', 'd'].map(id => `${l.at[id]}:${colOf(l, id)}`))
  expect(spots.size).toBe(4)
  expect(l.at.b).not.toBe(l.at.c)
  expect(colOf(l, 'a')).toBeLessThan(colOf(l, 'b'))
  expect(colOf(l, 'b')).toBeLessThan(colOf(l, 'd'))
  expect(l.order).toEqual(['a', 'b', 'c', 'd'])
  const t = text(l)
  expect(t.join('\n')).toMatch(/→/)
  expect(t.join('\n')).toMatch(/[┌┐└┘├┤┬┴│]/)
  expect(t.some(x => x.includes('after:'))).toBe(false)
  for (const line of t) expect(line.length).toBeLessThanOrEqual(80)
})

test('a skip edge is told in words, the neighbouring edges stay drawn', async () => {
  const l = layoutGraph([gn('a'), gn('b', ['a']), gn('c', ['a', 'b'])], 80)
  expect(l.mode).toBe('layers')
  const t = text(l)
  expect(t.some(x => x.trimStart().startsWith('after: a'))).toBe(true)
  expect(t[l.at.b ?? -1]).toMatch(/b.*→.*c/)
})

test('20 managers in layers fit width 100; width 30 falls back to a list', async () => {
  const nodes: GNode[] = []
  for (let i = 0; i < 20; i++) nodes.push(gn(`manager-${i}`))
  for (let i = 0; i < 20; i++) nodes.push(gn(`next-${i}`, [`manager-${i}`]))
  for (let i = 0; i < 5; i++) nodes.push(gn(`last-${i}`, [`next-${i}`, `next-${i + 5}`]))
  const l = layoutGraph(nodes, 100)
  expect(l.mode).toBe('layers')
  for (const line of text(l)) expect(line.length).toBeLessThanOrEqual(100)
  expect(Object.keys(l.at).length).toBe(45)
  expect(l.order.length).toBe(45)
  const narrow = layoutGraph(nodes, 30)
  expect(narrow.mode).toBe('list')
  const t = text(narrow)
  expect(t.some(x => x.includes('after: manager-0'))).toBe(true)
  expect(t.some(x => x.startsWith('── 1'))).toBe(true)
  expect(narrow.lines[narrow.at['next-0'] ?? -1]?.[0]?.node).toBe('next-0')
})

test('labels are cut with an ellipsis to the column', async () => {
  const long = 'a-very-long-manager-name-that-does-not-fit'
  const l = layoutGraph([gn(long), gn('x', [long]), gn('y', ['x']), gn('z', ['y'])], 60)
  expect(l.mode).toBe('layers')
  const t = text(l).join('\n')
  expect(t).toContain('…')
  expect(t).not.toContain(long)
  for (const line of text(l)) expect(line.length).toBeLessThanOrEqual(60)
})

test('empty graph, unknown dependency and a cycle do not break the layout', async () => {
  expect(layoutGraph([], 80).lines).toEqual([])
  const l = layoutGraph([gn('a', ['gone'])], 80)
  expect(l.order).toEqual(['a'])
  const cyc = layoutGraph([gn('a', ['b']), gn('b', ['a'])], 80)
  expect([...cyc.order].sort()).toEqual(['a', 'b'])
})

test('graphNodes: plan nodes, their agents, and agents outside the plan', async () => {
  const graph: Record<string, DagNode> = {
    a: { id: 'a', title: 'a', after: [], until: 'merged', state: 'running' },
    b: { id: 'b', title: 'b', after: ['a'], until: 'merged', state: 'waiting' },
  }
  const agents = [
    { id: 'u1', name: 'a', status: 'completed' },
    { id: 'u2', name: 'a-2', status: 'running' },
    { id: 'u3', name: 'extra', status: 'running' },
  ]
  const nodes = graphNodes(graph, agents, { children: { u2: 5, u3: 2 } })
  const by = Object.fromEntries(nodes.map(n => [n.id, n]))
  expect(by.b?.agentId).toBeUndefined()
  expect(by.b?.after).toEqual(['a'])
  expect(by.a?.agentId).toBe('u2')
  expect(by.a?.badge).toBe('+5 workers')
  expect(by.u3).toMatchObject({ label: 'extra', state: 'running', after: [], agentId: 'u3', badge: '+2 workers' })
  expect(by.u1).toBeUndefined()
  expect(graphNodes(undefined, agents.slice(2)).length).toBe(1)
})

test('a badge is shown next to the label', async () => {
  const l = layoutGraph([gn('mgr', [], { badge: '+5 workers' })], 80)
  expect(text(l)[0]).toBe('mgr +5 workers')
})

test('moveFocus walks the diamond with h/j/k/l', async () => {
  const nodes = diamond()
  const l = layoutGraph(nodes, 80)
  expect(moveFocus(l, nodes, undefined, 'j')).toBe('a')
  expect(moveFocus(l, nodes, 'b', 'j')).toBe('c')
  expect(moveFocus(l, nodes, 'c', 'k')).toBe('b')
  expect(moveFocus(l, nodes, 'a', 'k')).toBe('d')
  expect(moveFocus(l, nodes, 'd', 'j')).toBe('a')
  expect(moveFocus(l, nodes, 'd', 'h')).toBe('b')
  expect(moveFocus(l, nodes, 'a', 'l')).toBe('b')
  expect(moveFocus(l, nodes, 'd', 'l')).toBe('d')
  expect(moveFocus(l, nodes, 'a', 'h')).toBe('a')
  const list = layoutGraph(nodes, 30)
  expect(list.mode).toBe('list')
  expect(moveFocus(list, nodes, 'a', 'j')).toBe('b')
  expect(moveFocus(list, nodes, 'c', 'h')).toBe('a')
})
