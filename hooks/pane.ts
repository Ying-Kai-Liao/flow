import type { Activity, AgentRow, Handover } from '../types'
import { ENDED } from './deliver'
import { CONTINUE, isReviewer, MANAGER, QUEUE, REVIEWER, WORKER } from './core'
import { SESSION } from './sessions'
import type { GNode } from './graph'

// Display order: what may need a person first, finished agents last.
export const ORDER = ['waiting', 'idle', 'running', 'pending', 'failed', 'killed', 'completed']
export const GLYPH: Record<string, string> = {
  pending: '○', running: '●', waiting: '◐', idle: '◌', completed: '✓', failed: '✗', killed: '■',
}
export const COLOR: Record<string, string> = {
  running: 'suggestion', waiting: 'warning', idle: 'warning', completed: 'success', failed: 'error', killed: 'error',
}
export const ROLE: Record<string, string> = { [MANAGER]: 'manager', [WORKER]: 'worker', [CONTINUE]: 'worker', [SESSION]: 'worker', [REVIEWER]: 'reviewer', [QUEUE]: 'reviewer' }
export const ROOT_GLYPH = '◆'
// Plan states, drawn like the agent statuses they turn into; a waiting node has no agent yet.
export const PLAN_GLYPH: Record<string, string> = { waiting: '○', ready: '◌', running: '●', done: '✓', blocked: '✗' }
export const PLAN_COLOR: Record<string, string | undefined> = { waiting: undefined, ready: 'warning', running: 'suggestion', done: 'success', blocked: 'error' }
export const HANDOVER_GLYPH: Record<Handover['status'], string> = {
  pending: '…', awaiting: '⏸', taken: '●', ready: '⇪', done: '✓', returned: '↩',
}

export type TreeItem = { a: AgentRow; depth: number; kids: number; collapsed: boolean }

// Managers and the reviewer start collapsed; everything else has no default.
export const foldDefault = (a: AgentRow): boolean | undefined => (a.type === MANAGER || isReviewer(a.type) ? true : undefined)

// The rows of the tree in the order they are drawn and walked. A collapsed agent is one row with
// its children hidden: the person's choice wins, then the role's default, then `auto`, which folds
// every agent with children except the ones on the way to the highlight (a crowded tree).
// `at` is the highlight, moved up to the nearest row that is drawn.
export function treeItems(
  list: AgentRow[], fold: Record<string, boolean>, cur: string | null | undefined, auto: boolean,
  acts: Record<string, Activity> = {},
): { items: TreeItem[]; at: string | undefined } {
  const ids = new Set(list.map(a => a.id))
  const kids = (id: string | undefined) => list
    .filter(a => (id === undefined ? a.parentId === undefined || !ids.has(a.parentId) : a.parentId === id))
    .sort((a, b) => rankOf(a, acts) - rankOf(b, acts))
  const path = new Set<string>()
  for (let a = list.find(x => x.id === cur); a !== undefined && !path.has(a.id); a = list.find(x => x.id === a!.parentId)) path.add(a.id)
  const items: TreeItem[] = []
  const walk = (a: AgentRow, depth: number) => {
    const under = kids(a.id)
    const collapsed = fold[a.id] ?? foldDefault(a) ?? (under.length > 0 && auto && !path.has(a.id))
    items.push({ a, depth, kids: under.length, collapsed })
    if (!collapsed) for (const c of under) walk(c, depth + 1)
  }
  for (const a of kids(undefined)) walk(a, 0)
  const drawn = new Set(items.map(i => i.a.id))
  let at: string | undefined = cur ?? undefined
  while (at !== undefined && !drawn.has(at)) at = list.find(a => a.id === at)?.parentId
  return { items, at }
}

// The window of rows to draw: all of them, or `size` rows with the highlight in the middle.
export function viewOf<T>(items: T[], at: number, size: number): { top: number; rows: T[] } {
  if (items.length <= size) return { top: 0, rows: items }
  const top = Math.min(Math.max(0, at - Math.floor(size / 2)), items.length - size)
  return { top, rows: items.slice(top, top + size) }
}

// A plan node with an agent is drawn by the agent's status; one without has only its plan state.
export const planState = (n: GNode): boolean => n.agentId === undefined && n.state in PLAN_GLYPH
export const nodeGlyph = (n: GNode): string => (planState(n) ? PLAN_GLYPH[n.state] ?? '?' : GLYPH[n.state] ?? PLAN_GLYPH[n.state] ?? '?')
export const nodeColor = (n: GNode): string | undefined => (planState(n) ? PLAN_COLOR[n.state] : COLOR[n.state] ?? PLAN_COLOR[n.state])

// One line for a tool call: the tool and its most telling argument.
export function describeCall(e: Record<string, unknown>): string {
  const tool = String(e.tool ?? '?').replace(/^mcp__flow__/, '')
  const arg = [e.file_path, e.command, e.pattern, e.path, e.url, e.description, e.action, e.prompt]
    .find(v => typeof v === 'string' && v.length > 0) as string | undefined
  // A command is its first line, cut at a heredoc: its body is code, not news.
  const text = arg === undefined ? '' : (e.command === arg ? arg.split('\n')[0]!.replace(/<<.*$/, '') : arg)
  const short = text === '' ? '' : ' ' + text.replace(/\s+/g, ' ').trim().slice(0, 90)
  return tool + short
}

export const base = (path: unknown): string => String(path ?? '').split('/').pop() ?? ''

// What a call is, in a few plain words for a card: never a command's body or a prompt.
export function summarizeCall(e: Record<string, unknown>): string {
  const tool = String(e.tool ?? '?').replace(/^mcp__flow__/, '')
  const file = base(e.file_path)
  switch (tool) {
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return file ? `editing ${file}` : 'editing'
    case 'Write': return file ? `writing ${file}` : 'writing'
    case 'Read': return file ? `reading ${file}` : 'reading'
    case 'Grep': case 'Glob': return 'searching'
    case 'Agent': {
      const role = String(e.subagent_type ?? e.subagentType ?? '').replace(/^flow:/, '')
      const name = String(e.name ?? '')
      return ['started', role === 'manager' || role === 'worker' ? role : 'agent', name].filter(Boolean).join(' ')
    }
    case 'Bash': {
      const cmd = String(e.command ?? '').split('\n')[0]!.trim()
      // git and gh first: a commit message may say "test".
      if (/^git\s+\S+/.test(cmd)) return 'git ' + cmd.split(/\s+/)[1]
      if (/^gh\s+pr\b/.test(cmd)) return 'gh pr ' + (cmd.split(/\s+/)[2] ?? '')
      if (/\b(tsc|test|vitest|jest|pytest)\b/.test(cmd)) return 'running tests'
      return 'running a command'
    }
    default: return tool
  }
}


export function rank(status: string): number {
  const i = ORDER.indexOf(status)
  return i === -1 ? ORDER.length : i
}

// An agent told to wrap up sorts with what needs a person, ahead of plain running.
export function rankOf(a: AgentRow, acts: Record<string, Activity>): number {
  return handoffOf(a, acts[a.id])?.kind === 'wrapping' ? Math.min(rank(a.status), rank('idle')) : rank(a.status)
}

// Where an agent is in its handoff: told to wrap up and still live, or ended (idle counts) on a
// report whose last line is `HANDOFF: <branch>` (a manager's is `HANDOFF: manager <name>`).
// Old rows without the fields give undefined.
export function handoffOf(a: AgentRow, act: Activity | undefined):
  { kind: 'wrapping'; percent?: number; reminders: number } | { kind: 'done'; to: string } | undefined {
  if (act === undefined) return undefined
  if (ENDED.has(a.status) || a.status === 'idle') {
    const last = (act.answer ?? '').trim().split('\n').pop()?.trim() ?? ''
    if (last.startsWith('HANDOFF:')) return { kind: 'done', to: last.slice('HANDOFF:'.length).trim() }
  }
  if (!ENDED.has(a.status) && act.handoffNotifiedAt !== undefined) {
    return { kind: 'wrapping', percent: act.handoffPercent, reminders: act.remindersSent ?? 0 }
  }
  return undefined
}

export function handoffText(h: NonNullable<ReturnType<typeof handoffOf>>): string {
  return h.kind === 'done'
    ? `handed off${h.to ? ` → ${h.to}` : ''}`
    : `wrapping up${h.percent === undefined ? '' : ` (told at ${h.percent}%)`}${h.reminders > 1 ? ` · ${h.reminders} reminders` : ''}`
}
