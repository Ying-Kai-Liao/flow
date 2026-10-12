// The pure part of scripts/ledger-rebuild.mjs: prices, token arithmetic, transcript parsing, the match of
// ledger entries to transcripts and the report. No imports, so tests can load it (the plugin test
// sandbox cannot import node modules); the file system lives in ledger-rebuild.mjs.
//
// Keep PRICES, FAMILIES, priceOf, stepTokens and the long-bucket rule in step with hooks/cost.ts (the
// engine's TypeScript cannot be imported from a plain node script); tests/ledger-rebuild.test.ts
// fails when the price table drifts.

// ---- prices (copy of hooks/cost.ts) ----

function rates(input, output, read = input * 0.1) {
  return { input, write5m: input * 1.25, write1h: input * 2, read, output }
}

export const PRICES = {
  'claude-opus-5-5': { rates: rates(4, 20, 0.2) },
  'claude-opus-5': { rates: rates(5, 25) },
  'claude-opus-4-8': { rates: rates(5, 25) },
  'claude-opus-4-7': { rates: rates(5, 25) },
  'claude-opus-4-6': { rates: rates(5, 25) },
  'claude-sonnet-5-5': { rates: rates(2, 10, 0.2) },
  'claude-sonnet-5': { rates: rates(2, 10, 0.2) },
  'claude-sonnet-4-6': { rates: rates(3, 15) },
  'claude-haiku-5-5': { rates: rates(0.1, 0.5), long: { over: 100_000, rates: rates(0.5, 2.5) } },
  'claude-haiku-4-5': { rates: rates(1, 5) },
  'claude-fable-5-1': { rates: rates(10, 50, 0.25) },
  'claude-fable-5': { rates: rates(10, 50) },
}

export const FAMILIES = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
  fable: 'claude-fable-5-1',
}

export const normalizeModel = model => String(model).toLowerCase().replace(/\[1m\]/g, '').replace(/-latest$/, '').replace(/-\d{8}$/, '')

export function priceOf(model) {
  const key = normalizeModel(model)
  if (PRICES[key]) return PRICES[key]
  const known = Object.keys(PRICES).filter(k => key.startsWith(`${k}-`)).sort((a, b) => b.length - a.length)[0]
  if (known) return PRICES[known]
  const family = Object.keys(FAMILIES).find(f => key.includes(f))
  return family === undefined ? undefined : PRICES[FAMILIES[family]]
}

// ---- token arithmetic (copy of hooks/cost.ts) ----

export const ZERO = { input: 0, write5m: 0, write1h: 0, read: 0, output: 0 }
const KINDS = Object.keys(ZERO)
const add = (a, b) => ({ input: a.input + b.input, write5m: a.write5m + b.write5m, write1h: a.write1h + b.write1h, read: a.read + b.read, output: a.output + b.output })
export const allTokens = t => t.input + t.write5m + t.write1h + t.read + t.output
const prompt = t => t.input + t.write5m + t.write1h + t.read
const dollars = (t, r) => (t.input * r.input + t.write5m * r.write5m + t.write1h * r.write1h + t.read * r.read + t.output * r.output) / 1_000_000

export function costOf(model, b) {
  const p = priceOf(model)
  if (p === undefined) return undefined
  if (p.long === undefined || b.long === undefined) return dollars(b, p.rates)
  const base = {}
  for (const k of KINDS) base[k] = b[k] - b.long[k]
  return dollars(base, p.rates) + dollars(b.long, p.long.rates)
}

const num = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

export function stepTokens(usage) {
  if (typeof usage !== 'object' || usage === null) return undefined
  const bd = typeof usage.cache_creation === 'object' && usage.cache_creation !== null ? usage.cache_creation : undefined
  const total = num(usage.cache_creation_input_tokens)
  const write1h = bd === undefined ? 0 : num(bd.ephemeral_1h_input_tokens)
  const write5m = bd !== undefined && bd.ephemeral_5m_input_tokens !== undefined ? num(bd.ephemeral_5m_input_tokens) : Math.max(0, total - write1h)
  return { input: num(usage.input_tokens), write5m, write1h, read: num(usage.cache_read_input_tokens), output: num(usage.output_tokens) }
}

// models with one step added, as addStep does (the long bucket exists once a model has had a long step).
function addToModels(models, model, t) {
  const b = models[model] ?? { ...ZERO }
  const over = priceOf(model)?.long?.over
  const long = over !== undefined && prompt(t) > over
  models[model] = { ...add(b, t), ...(long || b.long ? { long: add(b.long ?? ZERO, long ? t : ZERO) } : {}) }
}

// ---- transcripts ----

export function parseLines(text) {
  return text.split('\n').flatMap(l => { try { const e = JSON.parse(l); return typeof e === 'object' && e !== null ? [e] : [] } catch { return [] } })
}

// Assistant replies by message id across any number of transcript texts: Claude Code writes one line
// per content block with the same id, so an id counts once (the last line's usage wins). stop_reason is
// null on most of those lines, so whether the reply ended its turn is read from all of them: it did not
// when any line has stop_reason tool_use or a tool_use block. An entry with no id counts as it stands.
export function repliesOf(texts) {
  const byId = new Map()
  let anon = 0
  for (const text of texts) {
    for (const e of parseLines(text)) {
      if (e.type !== 'assistant' || typeof e.message !== 'object' || e.message === null) continue
      const m = e.message
      const id = typeof m.id === 'string' ? m.id : `anon-${anon++}`
      const calls = m.stop_reason === 'tool_use' || (Array.isArray(m.content) && m.content.some(c => c?.type === 'tool_use'))
      byId.set(id, { id, model: m.model, usage: m.usage, toolUse: calls || byId.get(id)?.toolUse === true, at: Date.parse(e.timestamp) })
    }
  }
  return [...byId.values()]
}

// What a transcript set says an agent used: models like the ledger's, turns (replies that called no tool,
// so the agent went idle after them), and the span of its steps.
export function summarize(replies) {
  const models = {}
  let turns = 0
  let first, last
  for (const r of replies) {
    if (!r.toolUse) turns++
    const t = stepTokens(r.usage)
    if (t === undefined || allTokens(t) === 0 || typeof r.model !== 'string' || r.model === '' || r.model.startsWith('<')) continue
    addToModels(models, r.model, t)
    if (Number.isFinite(r.at)) { first = Math.min(first ?? Infinity, r.at); last = Math.max(last ?? -Infinity, r.at) }
  }
  return { models, turns, first, last }
}

export const MAIN_TOLERANCE_MS = 60_000

// The main session(s) behind a `main@<startedAt>` key. The entry's key time is when the plugin
// started, a moment before the session's first entry. The nearest root session within the tolerance
// wins, once: a session another key is nearer to is not shared. Sessions that start at the same
// instant (a resumed copy) count together when one's replies are contained in the other's; any other
// tie is ambiguous. The session must also have steps inside the entry's firstAt..lastAt window.
export function matchMain(key, entry, sessions, taken = new Set()) {
  const started = Number(key.slice(5))
  if (!Number.isFinite(started) || started <= 0) return { reason: 'main session start unknown' }
  const near = sessions
    .filter(s => s.first !== undefined && !taken.has(s) && Math.abs(s.first - started) <= MAIN_TOLERANCE_MS)
    .sort((a, b) => Math.abs(a.first - started) - Math.abs(b.first - started))
  if (near.length === 0) return { reason: 'no main transcript starts within a minute of the key' }
  const best = near[0]
  const twins = near.filter(s => s.first === best.first)
  const ids = s => new Set(s.replies.map(r => r.id))
  const biggest = twins.reduce((a, b) => (ids(b).size > ids(a).size ? b : a))
  const bigIds = ids(biggest)
  if (!twins.every(s => [...ids(s)].every(i => bigIds.has(i)))) return { reason: 'ambiguous: several different transcripts start at the same time' }
  const replies = biggest.replies
  const inWindow = replies.some(r => Number.isFinite(r.at) && r.at >= (entry.firstAt ?? 0) && r.at <= (entry.lastAt ?? Infinity) && stepTokens(r.usage) !== undefined)
  if (!inWindow) return { reason: 'the nearest main transcript has no steps in the entry\'s time window' }
  return { sessions: twins, replies }
}

// ---- rebuild ----

// The ledger with every matchable entry recomputed. Returns the new ledger and a row per entry.
export function rebuild(ledger, found) {
  const out = {}
  const rows = []
  const taken = new Set()
  // Main keys nearest to their session claim it first.
  const mains = Object.keys(ledger).filter(k => k.startsWith('main@'))
  const matched = new Map()
  const pairs = []
  for (const k of mains) {
    const started = Number(k.slice(5))
    for (const s of found.sessions) if (s.first !== undefined && Math.abs(s.first - started) <= MAIN_TOLERANCE_MS) pairs.push({ k, s, d: Math.abs(s.first - started) })
  }
  pairs.sort((a, b) => a.d - b.d)
  for (const { k, s } of pairs) {
    if (matched.has(k) || taken.has(s)) continue
    const m = matchMain(k, ledger[k], found.sessions, taken)
    matched.set(k, m)
    for (const t of m.sessions ?? []) taken.add(t)
  }
  for (const [key, entry] of Object.entries(ledger)) {
    let replies, reason
    if (key.startsWith('main@')) {
      const m = matched.get(key) ?? { reason: Number(key.slice(5)) > 0 ? 'no main transcript starts within a minute of the key, or a nearer key took it' : 'main session start unknown' }
      replies = m.replies
      reason = m.reason
    } else {
      const texts = found.agentTexts(key)
      if (texts === undefined) reason = 'no transcript found'
      else replies = repliesOf(texts)
    }
    if (replies === undefined) {
      out[key] = entry
      rows.push({ key, entry, flagged: reason })
      continue
    }
    const s = summarize(replies)
    // Same key order as the entry has: replace models and turns in place.
    const next = { ...entry, models: s.models }
    if (entry.turns !== undefined) next.turns = s.turns
    out[key] = next
    const outside = entry.firstAt !== undefined && entry.lastAt !== undefined && s.first !== undefined && (s.first < entry.firstAt - 1000 || s.last > entry.lastAt + 1000)
    rows.push({ key, entry, next, outside, summary: s })
  }
  return { ledger: out, rows }
}

// ---- report ----

export const tokensOf = models => Object.values(models ?? {}).reduce((n, b) => n + allTokens(b), 0)

// $ of a models map: the sum over priced models, and the ids of unpriced ones.
export function usdOf(models) {
  let usd = 0
  const unknown = []
  for (const [m, b] of Object.entries(models ?? {})) {
    const c = costOf(m, b)
    if (c === undefined) unknown.push(m)
    else usd += c
  }
  return { usd, unknown }
}

export function quantile(sorted, q) {
  if (sorted.length === 0) return NaN
  const i = (sorted.length - 1) * q
  const lo = Math.floor(i)
  return sorted[lo] + (sorted[Math.ceil(i)] - sorted[lo]) * (i - lo)
}

export function bucketOf(f) {
  if (f < 1.5) return '~1x'
  if (f < 2) return '1.5-2x'
  if (f < 4) return '2-4x'
  return '4x+'
}

export function report(rows) {
  const lines = []
  const money = n => `$${n.toFixed(2)}`
  const fmt = n => Math.round(n).toLocaleString('en-US')
  const roles = new Map()
  const unknownModels = new Set()
  const factors = []
  const grew = []
  const flagged = []
  let outside = 0
  const bump = (role, k, v) => { const r = roles.get(role) ?? { n: 0, before: 0, after: 0, usdBefore: 0, usdAfter: 0 }; r[k] += v; roles.set(role, r) }
  for (const row of rows) {
    const role = row.entry.role ?? 'other'
    const before = usdOf(row.entry.models)
    const after = usdOf((row.next ?? row.entry).models)
    for (const m of [...before.unknown, ...after.unknown]) unknownModels.add(m)
    bump(role, 'n', 1)
    bump(role, 'before', tokensOf(row.entry.models))
    bump(role, 'after', tokensOf((row.next ?? row.entry).models))
    bump(role, 'usdBefore', before.usd)
    bump(role, 'usdAfter', after.usd)
    if (row.flagged !== undefined) { flagged.push(row); continue }
    if (row.outside) outside++
    if (before.unknown.length === 0 && after.unknown.length === 0 && before.usd > 0 && after.usd > 0) {
      factors.push(before.usd / after.usd)
      if (after.usd > before.usd * 1.0001) grew.push({ row, before: before.usd, after: after.usd })
    }
  }
  lines.push('role        entries   tokens before      tokens after   $ before    $ after')
  const tot = { n: 0, before: 0, after: 0, usdBefore: 0, usdAfter: 0 }
  for (const [role, r] of [...roles].sort((a, b) => b[1].usdBefore - a[1].usdBefore)) {
    lines.push(`${role.padEnd(10)} ${String(r.n).padStart(7)} ${fmt(r.before).padStart(15)} ${fmt(r.after).padStart(17)} ${money(r.usdBefore).padStart(10)} ${money(r.usdAfter).padStart(10)}`)
    for (const k of Object.keys(tot)) tot[k] += r[k]
  }
  lines.push(`${'total'.padEnd(10)} ${String(tot.n).padStart(7)} ${fmt(tot.before).padStart(15)} ${fmt(tot.after).padStart(17)} ${money(tot.usdBefore).padStart(10)} ${money(tot.usdAfter).padStart(10)}`)
  if (unknownModels.size > 0) lines.push(`\nModels with no price (their $ is left out of every sum, shown as ?): ${[...unknownModels].join(', ')}`)
  const sorted = [...factors].sort((a, b) => a - b)
  lines.push(`\nInflation factor (old $ / new $) over ${sorted.length} entries with a transcript:`)
  if (sorted.length > 0) {
    const f = n => `${n.toFixed(2)}x`
    lines.push(`  min ${f(sorted[0])}  p25 ${f(quantile(sorted, 0.25))}  median ${f(quantile(sorted, 0.5))}  p75 ${f(quantile(sorted, 0.75))}  max ${f(sorted.at(-1))}`)
    const counts = {}
    for (const x of sorted) counts[bucketOf(x)] = (counts[bucketOf(x)] ?? 0) + 1
    lines.push(`  ~1x (<1.5): ${counts['~1x'] ?? 0}   1.5-2x: ${counts['1.5-2x'] ?? 0}   2-4x: ${counts['2-4x'] ?? 0}   4x+: ${counts['4x+'] ?? 0}`)
  }
  lines.push(`\nEntries where the new total is higher than the old (the ledger missed steps): ${grew.length}`)
  for (const g of grew) lines.push(`  ${g.row.key} ${g.row.entry.role}/${g.row.entry.name}: ${money(g.before)} -> ${money(g.after)}`)
  lines.push(`\nEntries whose transcript has steps outside firstAt..lastAt (counted whole, times kept): ${outside}`)
  lines.push(`\nFlagged, no usable transcript (kept as they are): ${flagged.length}`)
  for (const r of flagged) lines.push(`  ${r.key} ${r.entry.role}/${r.entry.name}: ${r.flagged}`)
  return lines.join('\n')
}

// ledger-pre-rebuild-<date>.json next to the ledger; an existing name gets -2, -3 (never overwritten).
// ledger-pre-rebuild-<date>.json; a name in use gets -2, -3 (a backup is never overwritten).
export function backupName(date, exists) {
  let name = `ledger-pre-rebuild-${date}.json`
  for (let n = 2; exists(name); n++) name = `ledger-pre-rebuild-${date}-${n}.json`
  return name
}
