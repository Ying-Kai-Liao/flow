import type { Activity, AgentRow, Handover } from '../types'
import { ENDED } from './deliver'
import { CONTINUE, isReviewer, MANAGER, QUEUE, REVIEWER, WORKER } from './core'
import { SESSION } from './sessions'
import { noteKey } from './state'
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
// Icons on the pane's status lines: single-column text glyphs (no emoji, which terminals draw two
// columns wide and in colour). The theme colours them where they are drawn.
export const ICON = {
  agents: '≡', inbox: '▤', checks: '☰', leftover: '⌫',
  ask: '?',
} as const
// The waiting "?" pulses bright and dim once a second. The phase comes from the clock (like
// hooks/shimmer.ts), so a redraw never restarts it.
export const askBright = (now: number): boolean => Math.floor(now / 1000) % 2 === 0
// Plan states, drawn like the agent statuses they turn into; a waiting node has no agent yet.
export const PLAN_GLYPH: Record<string, string> = { waiting: '○', ready: '◌', running: '●', done: '✓', blocked: '✗' }
export const PLAN_COLOR: Record<string, string | undefined> = { waiting: undefined, ready: 'warning', running: 'suggestion', done: 'success', blocked: 'error' }
export const HANDOVER_GLYPH: Record<Handover['status'], string> = {
  pending: '…', awaiting: '⏸', taken: '●', ready: '⇪', done: '✓', returned: '↩',
}

// `finished` marks the one row that stands for every finished manager (FINISHED_KEY): how many
// managers it holds and how many agents under them.
export type TreeItem = { a: AgentRow; depth: number; kids: number; collapsed: boolean; finished?: { managers: number; workers: number } }

// The fold key of the finished row in the pane's `folded` map; unset or true is collapsed.
export const FINISHED_KEY = '#finished'

// What still holds an ended agent open: handovers it is owed, the owners (names) of open inbox items,
// and whether its own plan graph has a node that is not done.
export type OpenWork = { handovers: Handover[]; owners: string[]; planOpen: (name: string) => boolean }

// The top-level managers that fold into the finished row: ended, nothing live under them, and no open work of their own (a handover not done, an open inbox item, a plan node not done).
// Work is matched by noteKey, as the inbox does; while a live agent shares that key (a restart as
// <name>-2) the work is its, so the old row still folds. A row with no name folds on status alone.
// A worker main started itself stays drawn: its report is what the person reads next.
// `keep` is an agent that must stay drawn (the transcript the pane follows): its top agent never folds.
export function finishedIds(list: AgentRow[], work: OpenWork, keep?: string | null): Set<string> {
  const ids = new Set(list.map(a => a.id))
  const under = (id: string, seen = new Set<string>()): AgentRow[] => list
    .filter(x => x.parentId === id && !seen.has(x.id) && (seen.add(x.id), true))
    .flatMap(x => [x, ...under(x.id, seen)])
  const live = new Set(list.filter(a => a.name !== undefined && !ENDED.has(a.status)).map(a => noteKey(a.name!)))
  const open = (name: string): boolean => {
    const key = noteKey(name)
    if (live.has(key)) return false
    return work.handovers.some(h => h.status !== 'done' && noteKey(h.reportTo ?? '') === key)
      || work.owners.some(o => noteKey(o ?? '') === key)
      || work.planOpen(name)
  }
  const out = new Set<string>()
  for (const a of list) {
    if (a.parentId !== undefined && ids.has(a.parentId)) continue
    if (a.type !== MANAGER || !ENDED.has(a.status)) continue
    const below = under(a.id)
    if (below.some(x => !ENDED.has(x.status))) continue
    if (a.name !== undefined && open(a.name)) continue
    if (keep != null && (a.id === keep || below.some(x => x.id === keep))) continue
    out.add(a.id)
  }
  return out
}

// Managers and the reviewer start collapsed; everything else has no default.
export const foldDefault = (a: AgentRow): boolean | undefined => (a.type === MANAGER || isReviewer(a.type) ? true : undefined)

// The rows of the tree in the order they are drawn and walked. A collapsed agent is one row with
// its children hidden: the person's choice wins, then the role's default, then `auto`, which folds
// every agent with children except the ones on the way to the highlight (a crowded tree).
// `at` is the highlight, moved up to the nearest row that is drawn.
// `finished` (from finishedIds) draws those top-level agents as one row after the others, collapsed
// unless `fold[FINISHED_KEY]` is false; expanded, they follow it one level in. A highlight hidden in
// the collapsed row moves to the row.
export function treeItems(
  list: AgentRow[], fold: Record<string, boolean>, cur: string | null | undefined, auto: boolean,
  acts: Record<string, Activity> = {}, finished: Set<string> = new Set(),
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
  const tops = kids(undefined)
  for (const a of tops.filter(x => !finished.has(x.id))) walk(a, 0)
  const done = tops.filter(x => finished.has(x.id))
  if (done.length > 0) {
    const all = (id: string, seen: Set<string>): number => list
      .filter(x => x.parentId === id && !seen.has(x.id) && (seen.add(x.id), true))
      .reduce((n, x) => n + 1 + all(x.id, seen), 0)
    const workers = done.reduce((n, a) => n + all(a.id, new Set([a.id])), 0)
    const collapsed = fold[FINISHED_KEY] !== false
    items.push({
      a: { id: FINISHED_KEY, description: '', type: 'finished', status: 'completed' },
      depth: 0, kids: done.length, collapsed, finished: { managers: done.length, workers },
    })
    if (!collapsed) for (const a of done) walk(a, 1)
  }
  const drawn = new Set(items.map(i => i.a.id))
  let at: string | undefined = cur ?? undefined
  while (at !== undefined && !drawn.has(at)) {
    if (finished.has(at)) { at = FINISHED_KEY; break }
    at = list.find(a => a.id === at)?.parentId
  }
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

// A model id as a short tag: the family, plus a [1m] suffix; anything unknown is passed through clipped.
export function shortModel(model: string | undefined): string | undefined {
  const m = model?.trim()
  if (m === undefined || m === '') return undefined
  const family = /opus|sonnet|haiku/i.exec(m)?.[0].toLowerCase()
  if (family === undefined) return m.length > 14 ? m.slice(0, 13) + '…' : m
  return /\[1m\]/i.test(m) ? `${family}[1m]` : family
}
