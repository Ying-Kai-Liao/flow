// The cost meter's pure part: one price table, the ledger arithmetic and the text of the report.
//
// Prices are ESTIMATES at Anthropic first-party API list prices, taken 2026-10-10. Subscription
// plans are billed differently, so read the dollars as "what this would cost at list price".
// To update: edit PRICES below (USD per million tokens) and nothing else; the ledger keeps tokens,
// not dollars, so a changed table reprices history.

import { localDate } from './release'
import type { Bucket, Ledger, LedgerEntry, Role, Tokens } from '../types'

export type Rates = { input: number; write5m: number; write1h: number; read: number; output: number }

// Cache write 5m = 1.25x input, 1h = 2x input, cache read = 0.1x input, unless a model lists its own read price.
function rates(input: number, output: number, read = input * 0.1): Rates {
  return { input, write5m: input * 1.25, write1h: input * 2, read, output }
}

type Price = { rates: Rates; long?: { over: number; rates: Rates } }

const PRICES: Record<string, Price> = {
  'claude-opus-5-5': { rates: rates(4, 20, 0.2) },
  'claude-opus-5': { rates: rates(5, 25) },
  'claude-opus-4-8': { rates: rates(5, 25) },
  'claude-opus-4-7': { rates: rates(5, 25) },
  'claude-opus-4-6': { rates: rates(5, 25) },
  'claude-sonnet-5-5': { rates: rates(2, 10, 0.2) },
  'claude-sonnet-5': { rates: rates(2, 10, 0.2) },
  'claude-sonnet-4-6': { rates: rates(3, 15) },
  // Prompts over 100K tokens (input + cache write + cache read of one step) cost more.
  'claude-haiku-5-5': { rates: rates(0.1, 0.5), long: { over: 100_000, rates: rates(0.5, 2.5) } },
  'claude-haiku-4-5': { rates: rates(1, 5) },
  'claude-fable-5-1': { rates: rates(10, 50, 0.25) },
  'claude-fable-5': { rates: rates(10, 50) },
}

// An alias, or a version not in the table, is priced as the newest of its family.
const FAMILIES: Record<string, string> = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
  fable: 'claude-fable-5-1',
}

// The same normalisation as modelKey in register.tsx: `[1m]`, a date suffix and `-latest` do not change the price.
export function normalizeModel(model: string): string {
  return model.toLowerCase().replace(/\[1m\]/g, '').replace(/-latest$/, '').replace(/-\d{8}$/, '')
}

// The price of a model id: the exact id, else the longest known id it extends, else its family, else undefined.
export function priceOf(model: string): Price | undefined {
  const key = normalizeModel(model)
  const exact = PRICES[key]
  if (exact) return exact
  const known = Object.keys(PRICES).filter(k => key.startsWith(`${k}-`)).sort((a, b) => b.length - a.length)[0]
  if (known) return PRICES[known]
  const family = Object.keys(FAMILIES).find(f => key.includes(f))
  return family === undefined ? undefined : PRICES[FAMILIES[family]!]
}

export const ZERO: Tokens = { input: 0, write5m: 0, write1h: 0, read: 0, output: 0 }

const add = (a: Tokens, b: Tokens): Tokens => ({
  input: a.input + b.input, write5m: a.write5m + b.write5m, write1h: a.write1h + b.write1h, read: a.read + b.read, output: a.output + b.output,
})
const sum = (list: Tokens[]): Tokens => list.reduce(add, ZERO)
const all = (t: Tokens): number => t.input + t.write5m + t.write1h + t.read + t.output
const prompt = (t: Tokens): number => t.input + t.write5m + t.write1h + t.read

const dollars = (t: Tokens, r: Rates): number =>
  (t.input * r.input + t.write5m * r.write5m + t.write1h * r.write1h + t.read * r.read + t.output * r.output) / 1_000_000

// The USD estimate of a bucket, or undefined when the model has no price (shown as "?", never as 0).
export function costOf(model: string, b: Bucket): number | undefined {
  const p = priceOf(model)
  if (p === undefined) return undefined
  if (p.long === undefined || b.long === undefined) return dollars(b, p.rates)
  const base: Tokens = {
    input: b.input - b.long.input, write5m: b.write5m - b.long.write5m, write1h: b.write1h - b.long.write1h,
    read: b.read - b.long.read, output: b.output - b.long.output,
  }
  return dollars(base, p.rates) + dollars(b.long, p.long.rates)
}

// cache read / everything the prompts carried; undefined before any prompt.
export function hitRate(t: Tokens): number | undefined {
  return prompt(t) === 0 ? undefined : t.read / prompt(t)
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

// One step's usage as tokens; the cache write splits 5m/1h when the usage carries the breakdown, else all is 5m.
export function stepTokens(usage: unknown): Tokens | undefined {
  if (typeof usage !== 'object' || usage === null) return undefined
  const u = usage as Record<string, unknown>
  const bd = typeof u.cache_creation === 'object' && u.cache_creation !== null ? u.cache_creation as Record<string, unknown> : undefined
  const total = num(u.cache_creation_input_tokens)
  const write1h = bd === undefined ? 0 : num(bd.ephemeral_1h_input_tokens)
  const write5m = bd !== undefined && bd.ephemeral_5m_input_tokens !== undefined ? num(bd.ephemeral_5m_input_tokens) : Math.max(0, total - write1h)
  return { input: num(u.input_tokens), write5m, write1h, read: num(u.cache_read_input_tokens), output: num(u.output_tokens) }
}

export type Identity = Partial<Omit<LedgerEntry, 'models' | 'firstAt' | 'lastAt'>>

const definedOnly = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>

// The ledger with one step added (a new object; the old one is untouched). A step with no tokens at all is skipped.
export function addStep(ledger: Ledger, key: string, model: string, usage: unknown, who: Identity | undefined, now: number): Ledger {
  const t = stepTokens(usage)
  if (t === undefined || all(t) === 0) return ledger
  const isMain = key.startsWith('main@')
  const cur: LedgerEntry = ledger[key] ?? { role: isMain ? 'main' : 'other', name: isMain ? 'main' : key, models: {} }
  const entry: LedgerEntry = { ...cur, ...(who ? definedOnly(who) : {}), firstAt: cur.firstAt ?? now, lastAt: now }
  const b: Bucket = entry.models[model] ?? { ...ZERO }
  const over = priceOf(model)?.long?.over
  const long = over !== undefined && prompt(t) > over
  const next: Bucket = { ...add(b, t), ...(long || b.long ? { long: add(b.long ?? ZERO, long ? t : ZERO) } : {}) }
  return { ...ledger, [key]: { ...entry, models: { ...entry.models, [model]: next } } }
}

// Identity recorded at spawn (or filled from the roster): sets the fields, keeps the tokens.
export function setIdentity(ledger: Ledger, key: string, who: Identity & { role: Role; name: string }, now: number): Ledger {
  const cur = ledger[key]
  return { ...ledger, [key]: { models: {}, ...cur, ...definedOnly(who), firstAt: cur?.firstAt ?? now, lastAt: now } as LedgerEntry }
}

// What came off disk: anything that is not a ledger entry is dropped.
export function normalizeLedger(raw: unknown): Ledger {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Ledger = {}
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'object' || v === null) continue
    const e = v as Record<string, unknown>
    if (typeof e.name !== 'string' || typeof e.models !== 'object' || e.models === null) continue
    out[k] = { ...(e as unknown as LedgerEntry), role: (['manager', 'worker', 'reviewer', 'main'] as const).find(r => r === e.role) ?? 'other' }
  }
  return out
}

// Both ledgers' tokens added (the file's history plus what this run counted before it was loaded).
export function mergeLedgers(a: Ledger, b: Ledger): Ledger {
  const out: Ledger = { ...a }
  for (const [k, e] of Object.entries(b)) {
    const o = out[k]
    if (o === undefined) { out[k] = e; continue }
    const models = { ...o.models }
    for (const [m, bk] of Object.entries(e.models)) {
      const x = models[m]
      models[m] = x === undefined ? bk : { ...add(x, bk), ...(x.long || bk.long ? { long: add(x.long ?? ZERO, bk.long ?? ZERO) } : {}) }
    }
    out[k] = {
      ...e, ...o, models,
      ...(o.firstAt !== undefined || e.firstAt !== undefined ? { firstAt: Math.min(o.firstAt ?? Infinity, e.firstAt ?? Infinity) } : {}),
      ...(o.lastAt !== undefined || e.lastAt !== undefined ? { lastAt: Math.max(o.lastAt ?? 0, e.lastAt ?? 0) } : {}),
    }
  }
  return out
}

// The ledger file stays bounded: an entry not counted for 90 days goes, and so does one with no `lastAt`.
export const KEEP_MS = 90 * 24 * 3600 * 1000
export function pruneLedger(ledger: Ledger, now: number): Ledger {
  const kept = Object.entries(ledger).filter(([, e]) => e.lastAt !== undefined && e.lastAt >= now - KEEP_MS)
  return kept.length === Object.keys(ledger).length ? ledger : Object.fromEntries(kept)
}

// --- Totals ---

export type Total = { tokens: Tokens; usd: number; unknown: boolean }

export function totalOf(entries: LedgerEntry[]): Total {
  let usd = 0
  let unknown = false
  const parts: Tokens[] = []
  for (const e of entries) {
    for (const [m, b] of Object.entries(e.models)) {
      parts.push(b)
      const c = costOf(m, b)
      if (c === undefined) unknown = true
      else usd += c
    }
  }
  return { tokens: sum(parts), usd, unknown }
}

// A name without its successor suffix: `csv-export-2` is a successor of `csv-export`.
export const baseName = (name: string): string => name.replace(/-\d+$/, '')

// --- Text ---

export function humanTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0).replace(/\.0$/, '')}k`
  return `${(n / 1_000_000).toFixed(n < 100_000_000 ? 1 : 0).replace(/\.0$/, '')}M`
}

export function money(usd: number, unknown = false): string {
  const s = usd < 0.1 && usd > 0 ? usd.toFixed(3) : usd.toFixed(2)
  return unknown ? (usd > 0 ? `~$${s}+?` : '~$?') : `~$${s}`
}

const percent = (t: Tokens): string => {
  const h = hitRate(t)
  return h === undefined ? '-' : `${Math.round(h * 100)}%`
}

const tokenText = (t: Tokens): string =>
  `${humanTokens(t.input)} in / ${humanTokens(t.write5m + t.write1h)} cache write / ${humanTokens(t.read)} cache read / ${humanTokens(t.output)} out, hit ${percent(t)}`

export const totalText = (t: Total): string => `${money(t.usd, t.unknown)} (tokens ${tokenText(t.tokens)})`

// Appended to a reviewer's done report: the PR's workers' cost. Empty when they spent nothing.
export function reportSuffix(t: Total): string {
  if (all(t.tokens) === 0) return ''
  return ` | cost: ${money(t.usd, t.unknown)} (tokens ${humanTokens(prompt(t.tokens))} in, ${humanTokens(t.tokens.output)} out, hit ${percent(t.tokens)})`
}

// The workers of a PR: those on its branch (a `-2` successor continues on the same branch).
export const entriesOfBranch = (ledger: Ledger, branch: string): LedgerEntry[] =>
  Object.values(ledger).filter(e => e.role === 'worker' && e.branch === branch)

export const prCost = (ledger: Ledger, branch: string): Total => totalOf(entriesOfBranch(ledger, branch))

// The block of `status`: one line per agent that took steps, then manager, PR, reviewer, main and session totals.
// `scope`: this session started at `start` and has `live` agent ids in its roster. An entry is this
// session's when its agent is live or was counted since the start; the older ones only reach the all-time line.
export function costBlock(ledger: Ledger, prs: { pr: number; branch: string }[], otherSessions: boolean, scope: { start: number; live: Set<string> }): string[] {
  const counted = Object.entries(ledger).filter(([, e]) => Object.keys(e.models).length > 0)
  if (counted.length === 0) return []
  const here = counted.filter(([k, e]) => scope.live.has(k) || (e.lastAt ?? 0) >= scope.start)
  const entries = here.map(([, e]) => e)
  const lines = ['Cost (estimates at API list prices):']
  const order: Record<Role, number> = { main: 0, manager: 1, worker: 2, reviewer: 3, other: 4 }
  for (const e of [...entries].sort((a, b) => order[a.role] - order[b.role] || a.name.localeCompare(b.name))) {
    lines.push(`  ${e.role} ${e.name} [${Object.keys(e.models).join(', ')}]: ${totalText(totalOf([e]))}`)
  }
  const ownerOf = (e: LedgerEntry): string | undefined => e.role === 'manager' ? baseName(e.name) : e.role === 'worker' && e.manager !== undefined ? baseName(e.manager) : undefined
  for (const m of [...new Set(entries.map(ownerOf).filter((x): x is string => x !== undefined))].sort()) {
    lines.push(`  manager ${m} total (with its workers): ${totalText(totalOf(entries.filter(e => ownerOf(e) === m)))}`)
  }
  for (const p of [...prs].sort((a, b) => a.pr - b.pr)) {
    const mine = entriesOfBranch(ledger, p.branch).filter(e => entries.includes(e) && Object.keys(e.models).length > 0)
    if (mine.length > 0) lines.push(`  PR #${p.pr} (${p.branch}) workers: ${totalText(totalOf(mine))}`)
  }
  const rev = entries.filter(e => e.role === 'reviewer')
  if (rev.length > 0) lines.push(`  reviewer total: ${totalText(totalOf(rev))}`)
  const main = entries.filter(e => e.role === 'main')
  if (main.length > 0) lines.push(`  main total: ${totalText(totalOf(main))}`)
  // Only once model routing has put a size on some entry; the rest is "unsized" (main, managers, the reviewer, older workers).
  if (entries.some(e => e.size !== undefined)) {
    const part = (label: string, of: LedgerEntry[]) => of.length === 0 ? [] : [`${label} ${money(totalOf(of).usd, totalOf(of).unknown)}`]
    const by = [...['small', 'normal', 'large'].flatMap(s => part(s, entries.filter(e => e.size === s))), ...part('unsized', entries.filter(e => e.size === undefined))]
    lines.push(`  by size: ${by.join(', ')}`)
  }
  lines.push(`  session total: ${totalText(totalOf(entries))}`)
  const first = Math.min(...counted.map(([, e]) => e.firstAt ?? Infinity))
  lines.push(`  All time${Number.isFinite(first) ? ` (since ${localDate(first)})` : ''}: ${totalText(totalOf(counted.map(([, e]) => e)))}`)
  if (otherSessions) lines.push('  Workers run in other harness sessions are not counted.')
  return lines
}
