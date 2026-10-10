import type { AgentRow } from '../types'
import type { WarnSettings } from './settings'

// Pure meter and label helpers for the agent rows: no engine, no atoms.

// Running time as the native subagent row has it: 12s, 1m 43s, 1h 5m.
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

// "↓ 84.0k tokens": the context the agent has taken in, one decimal like the native row.
export function tokensDown(n: number): string {
  return `↓ ${n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n} tokens`
}

export function labelOf(a: AgentRow): string {
  return a.name ?? a.description ?? a.id.slice(0, 8)
}

export const DEFAULT_WINDOW = 200_000
export const METER_CELLS = 12
export const CARD_ROWS = 5
export const DANGER_PERCENT = 90

export const LARGE_WINDOW = 1_000_000

// The model id with what differs between the spellings of one model dropped: `[1m]`, a date suffix, `-latest`.
// `e.model` is the id the engine resolved (it may carry `[1m]`); `usage.model` is the id the API reports.
export function modelKey(model: string): string {
  return model.toLowerCase().replace(/\[1m\]/g, '').replace(/-latest$/, '').replace(/-\d{8}$/, '')
}

// A subagent reports no window of its own: borrow the main session's when it runs the same model
// (compared by modelKey), else 200k, or 1M for a `[1m]` model id. Tokens past the assumed window
// prove the window is the 1M one, so a guess is never shown past 100%.
// `spawned` is the window the agent was started with (see the agent.spawn hook); it wins over the guess.
export function windowOf(model: string, mainModel: string | undefined, mainWindow: number | undefined, tokens = 0, spawned?: number): number {
  const window = spawned !== undefined ? spawned : mainWindow !== undefined && mainModel !== undefined && modelKey(model) === modelKey(mainModel) ? mainWindow
    : model.includes('[1m]') ? LARGE_WINDOW : DEFAULT_WINDOW
  return tokens > window ? Math.max(window, LARGE_WINDOW) : window
}


// The percent in force: a 1M window has its own, so the 200k percent never applies to it.
export function windowPercent(s: WarnSettings, window: number): number {
  return window >= LARGE_WINDOW ? s.contextWarn1m : s.contextWarn
}

// The trigger: the percent of the window, capped by the token setting when that is set.
export function thresholdOf(s: WarnSettings, window: number): number {
  const byPercent = Math.round(window * windowPercent(s, window) / 100)
  return s.contextWarnTokens > 0 ? Math.min(s.contextWarnTokens, byPercent) : byPercent
}

// The same threshold as a percent of the window, for the meter's marker and colour.
export function warnPercent(s: WarnSettings, window: number): number {
  return Math.min(100, Math.max(1, Math.round(thresholdOf(s, window) / window * 100)))
}

// What the threshold is called in a message: "40%" or "100k tokens".
export function limitLabel(s: WarnSettings, window: number): string {
  return s.contextWarnTokens > 0 && s.contextWarnTokens < Math.round(window * windowPercent(s, window) / 100)
    ? `${tokensLabel(s.contextWarnTokens)} tokens` : `${windowPercent(s, window)}%`
}

// The threshold in tokens for the meter, only when the token limit is the one in force.
export function limitTokens(s: WarnSettings, window: number): string | undefined {
  return limitLabel(s, window).endsWith('tokens') ? tokensLabel(s.contextWarnTokens) : undefined
}

// The line an agent past the threshold reads. A manager keeps going until its workers are done.
export function wrapUpText(role: string, percent: number, limit: string): string {
  const handoff = 'follow the Handoff section of your instructions now: commit WIP, push, update the draft PR\'s ## Handoff note, end with HANDOFF: <branch>.'
  return role === 'manager'
    ? `flow: WRAP UP: your context is at ${percent}% (past the ${limit} limit). Start no new work; once none of your workers is running, ${handoff}`
    : `flow: WRAP UP: your context is at ${percent}% (past the ${limit} limit). Stop new work, ${handoff}`
}

export function tokensLabel(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

// The bar with a marker cell at the warn threshold, so how close an agent is stays readable.
export function cells(percent: number, warn: number): { ch: string; kind: 'mark' | 'fill' | 'empty' }[] {
  const filled = Math.round(Math.min(100, percent) / 100 * METER_CELLS)
  const mark = Math.min(METER_CELLS - 1, Math.floor(warn / 100 * METER_CELLS))
  return Array.from({ length: METER_CELLS }, (_, i) =>
    i === mark ? { ch: '│', kind: 'mark' } : i < filled ? { ch: '█', kind: 'fill' } : { ch: '░', kind: 'empty' })
}

export function meterColor(percent: number, warn: number): string | undefined {
  return percent >= DANGER_PERCENT && percent >= warn ? 'error' : percent >= warn ? 'warning' : undefined
}
