// Pushed suggestions of standing rules: when main has answered a topic (or, without one, an exact text) the
// same way 3+ times and no rule covers it, the answer result and the Flow pane offer the rule. Nothing is
// ever added here: the rule exists only once main calls mcp__flow__standing add. Each (group, answer) is
// offered once; a dismissed one is not offered or shown again. The record is a small file in the state dir.
import type { StandingIo } from './standing-run'
import { suggest } from './standing'
import type { Resolved, Suggestion } from './standing'

type Seen = Record<string, { at: number; dismissed?: boolean }>

const fileOf = (dir: string) => `${dir}/suggest-offered.json`

// A missing or corrupt file means nothing has been offered yet.
async function readSeen(io: StandingIo, dir: string): Promise<Seen> {
  const raw = await io.readJson(fileOf(dir)).catch(() => undefined)
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Seen = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'object' && v !== null && typeof (v as { at?: unknown }).at === 'number') out[k] = v as Seen[string]
  }
  return out
}

async function writeSeen(io: StandingIo, dir: string, seen: Seen): Promise<void> {
  await io.mkdirp(dir)
  await io.writeJson(fileOf(dir), seen)
}

// The callers read the rules fresh (loadRules in standing-run.ts) and pass them in.
const current = async (io: StandingIo, rules: Resolved[]): Promise<Suggestion[]> => suggest(await io.inbox(), rules)

// What the pane shows: the suggestions still open (no rule covers them) that were not dismissed.
export async function pendingSuggestions(io: StandingIo, rules: Resolved[]): Promise<Suggestion[]> {
  const dir = await io.stateDir()
  const seen = dir === undefined ? {} : await readSeen(io, dir)
  return (await current(io, rules)).filter(s => seen[s.id]?.dismissed !== true)
}

export const dismissCall = (id: string): string => `mcp__flow__standing ${JSON.stringify({ action: 'dismiss', id })}`

export const suggestionLine = (s: Suggestion): string =>
  `Standing answer? ${s.label} answered "${s.answer}" ${s.times} times: ${s.add} (adds a rule; nothing is added until you call it). Not now: ${dismissCall(s.id)}`

// The pane's row: shorter, it has no tool call (main adds the rule when the user says so).
export const paneText = (s: Suggestion): string => `rule? ${s.label} answered "${s.answer}" ${s.times}x: tell main to add it as a standing answer`

// The suggestions not offered before, as one line each, recorded as offered so they come once.
export async function offerNewSuggestions(io: StandingIo, rules: Resolved[]): Promise<string[]> {
  const dir = await io.stateDir()
  if (dir === undefined) return []
  const seen = await readSeen(io, dir)
  const fresh = (await current(io, rules)).filter(s => seen[s.id] === undefined)
  if (fresh.length === 0) return []
  const at = await io.now()
  for (const s of fresh) seen[s.id] = { at }
  await writeSeen(io, dir, seen)
  return fresh.map(suggestionLine)
}

// Dismisses one open suggestion by its id, or every open one with "all". Returns the ids dismissed.
export async function dismissSuggestions(io: StandingIo, rules: Resolved[], id: string): Promise<string[]> {
  const dir = await io.stateDir()
  if (dir === undefined) return []
  const seen = await readSeen(io, dir)
  const ids = (await current(io, rules)).map(s => s.id).filter(i => id === 'all' || i === id)
  const at = await io.now()
  for (const i of ids) seen[i] = { at: seen[i]?.at ?? at, dismissed: true }
  if (ids.length > 0) await writeSeen(io, dir, seen)
  return ids
}
