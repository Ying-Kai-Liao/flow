import type { Handover } from '../types'
import { noteKey } from './state'

// Lite mode, the pure half: one task run as just a manager and its workers. A manager spawned with a
// `Mode: lite` line (preflight.ts isLite) is recorded here, gets the LITE rules block (prompts.ts), skips
// pre-flight and size decisions and merges its own PR instead of handing it
// to a reviewer agent. The disk half is in register.tsx.

export type LiteState = Record<string, { name: string; at: number }>

export const EMPTY_LITE: LiteState = {}

// Keyed by noteKey, so a successor (`x-2`) of a lite manager is lite too.
export const isLiteName = (state: LiteState, name: string | undefined): boolean =>
  name !== undefined && state[noteKey(name)] !== undefined

// The same object when the manager is already recorded.
export function recordLite(state: LiteState, name: string, at: number): LiteState {
  return isLiteName(state, name) ? state : { ...state, [noteKey(name)]: { name, at } }
}

// A stored record read back from disk; anything malformed is dropped.
export function normalizeLite(raw: unknown): LiteState {
  const out: LiteState = {}
  if (typeof raw !== 'object' || raw === null) return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const e = v as { name?: unknown; at?: unknown } | null
    if (typeof e === 'object' && e !== null && typeof e.name === 'string') out[k] = { name: e.name, at: typeof e.at === 'number' ? e.at : 0 }
  }
  return out
}

// The rules go in front of the manager's prompt once, however often the spawn is rewritten.
export const withLiteRules = (prompt: string, rules: string, mark: string): string =>
  prompt.includes(mark) ? prompt : `${rules}\n\n${prompt}`

export const LITE_USAGE = 'Usage: /flow lite <task>. Runs one task as just a manager and its workers (no pre-flight, no reviewer agent) to save tokens.'

// What /flow lite submits to main: commands cannot start agents themselves.
export function liteStartPrompt(task: string): string {
  return [
    'Start one flow:manager for the task below, in lite mode. Give it a short name slug of your own choosing and run it in the background.',
    'Its prompt is the task in the user\'s words, with the line "Mode: lite" on a line of its own. Add no other mode line and no "Size:" line unless the task is clearly a large one (then "Size: large"). Start nothing else for this task.',
    '',
    'Task:',
    task,
  ].join('\n')
}

// Who is calling a tool that used to belong to the reviewer alone.
export type ToolCaller = { kind: 'main' } | { kind: 'reviewer' } | { kind: 'lite'; name: string } | { kind: 'other' }

const prsOf = (input: Record<string, unknown>): number[] =>
  (Array.isArray(input.prs) ? input.prs : [input.pr]).map(Number).filter(n => Number.isInteger(n) && n > 0)

// The PRs a lite manager may act on: its own, recorded by the handover tool.
export const ownsLitePr = (h: Handover | undefined, name: string): boolean =>
  h !== undefined && h.lite === true && noteKey(h.reportTo) === noteKey(name)

const OTHER = (tool: string, why = 'it belongs to the reviewer') => `Refused: ${tool} is not for you; ${why}. Hand your PR over with mcp__flow__handover.`

// mcp__flow__reviewer / mcp__flow__queue. A lite manager may record a ready batch ("ready") or finish ("done") its own PR.
export function reviewerToolAccess(caller: ToolCaller, input: Record<string, unknown>, handovers: Record<string, Handover>): string | undefined {
  const action = String(input.action ?? '')
  if (action === 'list' || caller.kind === 'main' || caller.kind === 'reviewer') return undefined
  if (caller.kind === 'other') return OTHER('mcp__flow__reviewer')
  if (action !== 'ready' && action !== 'done') return 'Refused: a lite manager uses the reviewer tool only for "ready" and "done" on its own PR; "take" and "back" belong to the reviewer.'
  const prs = prsOf(input)
  if (prs.length === 0 || prs.some(n => !ownsLitePr(handovers[String(n)], caller.name))) {
    return 'Refused: a lite manager may only act on the PRs it handed over itself in lite mode.'
  }
  return undefined
}

// mcp__flow__release (cut and publish): the lite manager's own PRs only.
export function releaseToolAccess(caller: ToolCaller, input: Record<string, unknown>, handovers: Record<string, Handover>): string | undefined {
  if (caller.kind === 'main' || caller.kind === 'reviewer') return undefined
  if (caller.kind === 'other') return OTHER('mcp__flow__release')
  const own = Object.values(handovers).filter(h => ownsLitePr(h, caller.name))
  if (input.action === 'publish') return own.length === 0 ? 'Refused: publish only follows the release of a PR you handed over in lite mode.' : undefined
  const prs = prsOf(input)
  if (prs.length === 0 || prs.some(n => !ownsLitePr(handovers[String(n)], caller.name))) {
    return 'Refused: a lite manager may release only the PRs it handed over itself in lite mode.'
  }
  return undefined
}

// mcp__flow__deploy: gate, deployed and env-applied for a lite manager that has a PR of its own. list is read-only
// and hold/release stay main's (deployTool checks those itself).
export function deployToolAccess(caller: ToolCaller, input: Record<string, unknown>, handovers: Record<string, Handover>): string | undefined {
  const action = String(input.action ?? 'list')
  if (action === 'list' || action === 'hold' || action === 'release') return undefined
  if (caller.kind === 'main' || caller.kind === 'reviewer') return undefined
  if (caller.kind === 'other') return OTHER('mcp__flow__deploy')
  if (!Object.values(handovers).some(h => ownsLitePr(h, caller.name))) return 'Refused: a lite manager gates a deploy only for a PR it handed over itself in lite mode.'
  return undefined
}
