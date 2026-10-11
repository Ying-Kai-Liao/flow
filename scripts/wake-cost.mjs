#!/usr/bin/env node
// What manager wake-ups cost, and what the delivery rules in hooks/deliver.ts would have saved.
//
//   node scripts/wake-cost.mjs [projectDir] [--md] [--json]
//
// Reads ~/.claude/projects/<project>/<session>/subagents/agent-*.jsonl of agents whose .meta.json says
// agentType flow:manager. A wake is a user entry that begins a turn of an idle manager: its text starts
// "Another Claude session sent a message", "The coordinator sent a message" or "[SYSTEM NOTIFICATION",
// and the entry before it is an assistant turn that ended (no tool call pending). The cost of the wake
// is the cache_creation_input_tokens of the assistant entry that follows. No dependencies.
//
// The "after" column replays the same wakes against the rules: a wake whose category is HELD does not
// start a turn; it is delivered with the next wake that does, or by itself at the hold cap. Keep
// HELD, HOLD_CAP_MS and PRICES in step with hooks/deliver.ts and hooks/cost.ts (the price table is
// copied: the engine's TypeScript cannot be imported from a plain node script).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const flags = new Set(args.filter(a => a.startsWith('--')))
const show = args.find(a => a.startsWith('--show='))?.slice(7)
const projectArg = args.find(a => !a.startsWith('--'))
const project = projectArg ?? path.join(os.homedir(), '.claude/projects', process.cwd().replace(/[/.]/g, '-').replace(/-\.claude-worktrees-.*$/, ''))

const HOLD_CAP_MS = 600_000 // hooks/deliver.ts
const CACHE_TTL_MS = 300_000
// Categories the new rules hold (informational: the manager needs no action until its next real turn).
const HELD = new Set(['nonblocking-ask', 'user-override-relay', 'linked-escalation-copy', 'handoff-advice'])

// USD per million tokens: cache write 5m, 1h, cache read (hooks/cost.ts, first-party list prices).
const PRICES = {
  'claude-opus-5-5': { w5: 5, w1: 8, read: 0.2 },
  'claude-opus': { w5: 6.25, w1: 10, read: 0.5 },
  'claude-sonnet': { w5: 2.5, w1: 4, read: 0.2 },
  'claude-haiku': { w5: 0.125, w1: 0.2, read: 0.01 },
}
const priceOf = model => {
  const m = String(model ?? '').toLowerCase()
  if (m.includes('opus-5-5')) return PRICES['claude-opus-5-5']
  if (m.includes('opus')) return PRICES['claude-opus']
  if (m.includes('sonnet')) return PRICES['claude-sonnet']
  if (m.includes('haiku')) return PRICES['claude-haiku']
  return PRICES['claude-opus']
}

const textOf = e => {
  const c = e.message?.content
  if (typeof c === 'string') return c
  return Array.isArray(c) ? c.filter(x => x.type === 'text').map(x => x.text).join('') : ''
}

// What a wake carries, by category. actionable: the manager has to do something about it now.
export function classify(text) {
  const body = text.replace(/^[\s\S]*?(?=<task-notification>|<agent-message|were working:\n)/, '')
  if (text.startsWith('[SYSTEM NOTIFICATION')) {
    return /<summary>Agent "/.test(text) ? 'worker-report' : 'background-task'
  }
  if (text.startsWith('Another Claude session')) {
    const from = /<agent-message from="([^"]+)"/.exec(text)?.[1] ?? ''
    return /reviewer|queue/.test(from) ? 'reviewer-report' : 'peer-message'
  }
  const t = body.replace(/^were working:\n/, '')
  if (/^flow plan:/.test(t)) return 'plan-notice'
  if (/WRAP UP/.test(t)) return 'wrap-up'
  if (/has handed off \d+ times/.test(t)) return 'split-notice'
  if (/^flow: .* advises splitting/.test(t)) return 'handoff-advice'
  if (/asks q\d+ \(blocking\)/.test(t)) return 'blocking-ask'
  if (/asks q\d+ \(non-blocking\)/.test(t)) return 'nonblocking-ask'
  if (/^flow: the user answered q\d+, which .* asked you/.test(t)) return 'user-override-relay'
  if (/^flow: main answered q\d+, which your worker/.test(t)) return 'linked-escalation-copy'
  if (/answered q\d+ \(.*\) itself/.test(t)) return 'linked-escalation-copy'
  if (/^flow session:/.test(t)) return /reports:/.test(t) ? 'session-report' : 'session-idle'
  if (/test slot is granted/.test(t)) return 'slot-grant'
  if (/^flow: .*(answer|Answer)|^flow: main answered|Question: "/.test(t)) return 'answer'
  return 'main-instruction'
}

// The message itself, without the host's framing.
const body = text => text.replace(/\s+/g, ' ').replace(/^.*?(<agent-message[^>]*>|<summary>|were working: )/, '$1')

function managers(root) {
  const out = []
  if (!fs.existsSync(root)) return out
  for (const s of fs.readdirSync(root)) {
    const d = path.join(root, s, 'subagents')
    if (!fs.existsSync(d)) continue
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.meta.json')) continue
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'))
        const file = path.join(d, f.replace('.meta.json', '.jsonl'))
        if (meta.agentType === 'flow:manager' && fs.existsSync(file)) out.push({ session: s, name: meta.name ?? f, file })
      } catch { /* a half-written meta file */ }
    }
  }
  return out
}

function wakesOf(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').flatMap(x => { try { return [JSON.parse(x)] } catch { return [] } })
  const wakes = []
  let prev // the last assistant entry before the current position
  let prevAssistantAt
  for (let i = 0; i < lines.length; i++) {
    const e = lines[i]
    if (e.type === 'assistant') {
      prev = e
      prevAssistantAt = Date.parse(e.timestamp)
      continue
    }
    if (e.type !== 'user' || i === 0) continue
    if (Array.isArray(e.message?.content) && e.message.content.some(x => x.type === 'tool_result')) { prev = undefined; continue }
    const text = textOf(e)
    if (!/^(Another Claude session sent a message|The coordinator sent a message|\[SYSTEM NOTIFICATION)/.test(text)) continue
    // Idle: the turn before ended (last assistant entry has no tool call pending, nothing since but attachments).
    const ended = prev !== undefined && !(Array.isArray(prev.message?.content) && prev.message.content.some(x => x.type === 'tool_use'))
    if (!ended) continue
    const next = lines.slice(i + 1).find(x => x.type === 'assistant' && x.message?.usage)
    const u = next?.message?.usage ?? {}
    const at = Date.parse(e.timestamp)
    const tokens5 = u.cache_creation?.ephemeral_5m_input_tokens ?? (u.cache_creation?.ephemeral_1h_input_tokens === undefined ? u.cache_creation_input_tokens ?? 0 : 0)
    const tokens1 = u.cache_creation?.ephemeral_1h_input_tokens ?? 0
    const p = priceOf(next?.message?.model)
    wakes.push({
      at, gapMs: prevAssistantAt === undefined ? undefined : at - prevAssistantAt,
      category: classify(text), head: body(text).slice(0, 160), text: body(text).slice(0, 300),
      write: tokens5 + tokens1, usd: (tokens5 * p.w5 + tokens1 * p.w1) / 1e6,
      // The same tokens read from a cache that lived an hour, or written at the 1h price.
      usdIf1h: (at - (prevAssistantAt ?? 0) <= 3_600_000 && prevAssistantAt !== undefined && at - prevAssistantAt > CACHE_TTL_MS ? (tokens5 + tokens1) * p.read : (tokens5 + tokens1) * p.w1) / 1e6,
    })
    prev = undefined
  }
  return wakes
}

// The same wakes under the new rules: held ones fold into the next wake that starts a turn, or fire
// once at the cap (the first held wake's cost stands for that turn).
export function replay(wakes) {
  const sorted = [...wakes].sort((a, b) => a.at - b.at)
  const kept = []
  let group
  const flushCap = upTo => {
    if (group !== undefined && group.first.at + HOLD_CAP_MS <= upTo) { kept.push(group.first); group = undefined }
  }
  for (const w of sorted) {
    flushCap(w.at)
    if (HELD.has(w.category)) {
      group ??= { first: w }
    } else {
      group = undefined // delivered with this wake
      kept.push(w)
    }
  }
  flushCap(Infinity)
  return kept
}

const sum = (list, k) => list.reduce((n, w) => n + w[k], 0)
const root = project
const all = []
const perManager = []
for (const m of managers(root)) {
  const wakes = wakesOf(m.file)
  if (wakes.length === 0) continue
  perManager.push({ ...m, n: wakes.length })
  for (const w of wakes) all.push({ ...w, manager: `${m.session.slice(0, 8)}/${m.name}` })
}

// Replay per manager.
const byMgr = new Map()
for (const w of all) byMgr.set(w.manager, [...(byMgr.get(w.manager) ?? []), w])
const after = [...byMgr.values()].flatMap(replay)

if (show !== undefined) for (const w of all.filter(x => x.category === show)) console.log(`${new Date(w.at).toISOString()} ${w.manager}: ${w.head}`)
const cats = {}
for (const w of all) {
  const c = (cats[w.category] ??= { n: 0, cold: 0, write: 0, usd: 0, held: HELD.has(w.category) })
  c.n++
  if (w.gapMs !== undefined && w.gapMs > CACHE_TTL_MS) c.cold++
  c.write += w.write
  c.usd += w.usd
}
// Repeats: the same text woke the same manager more than once.
const seen = new Map()
let repeats = 0
for (const w of all) {
  const k = `${w.manager}|${w.text}`
  if (seen.has(k)) repeats++
  seen.set(k, true)
}
// Wakes that came within a minute of the previous wake of the same manager (a longer window would merge them).
let close = 0
for (const list of byMgr.values()) {
  const s = [...list].sort((a, b) => a.at - b.at)
  for (let i = 1; i < s.length; i++) if (s[i].at - s[i - 1].at < 60_000) close++
}

const result = {
  managers: perManager.length, sessions: new Set(perManager.map(m => m.session)).size,
  wakes: all.length, cold: all.filter(w => w.gapMs !== undefined && w.gapMs > CACHE_TTL_MS).length,
  writeTokens: sum(all, 'write'), usd: sum(all, 'usd'),
  heldNow: all.filter(w => HELD.has(w.category)).length,
  after: { wakes: after.length, writeTokens: sum(after, 'write'), usd: sum(after, 'usd') },
  coldUsd: sum(all.filter(w => w.gapMs !== undefined && w.gapMs > CACHE_TTL_MS), 'usd'), usdIf1h: sum(all, 'usdIf1h'),
  repeats, closeWithin60s: close, categories: cats,
}

if (flags.has('--json')) {
  console.log(JSON.stringify(result, null, 2))
} else {
  const f = n => n.toFixed(2)
  console.log(`n = ${result.wakes} manager wake turns, ${result.managers} managers in ${result.sessions} sessions (${project})`)
  console.log(`cold (cache expired, gap > 5 min): ${result.cold}; cache-write ${result.writeTokens} tokens; est. $${f(result.usd)}`)
  console.log(`of which cold wakes: $${f(result.coldUsd)}; the same wakes with a 1h cache TTL (wake turns only): $${f(result.usdIf1h)}`)
  console.log(`repeated identical texts to one manager: ${repeats}; wakes within 60s of the previous one: ${close}`)
  console.log('\ncategory                  held  wakes  cold  cache-write tokens   est. $')
  for (const [k, c] of Object.entries(cats).sort((a, b) => b[1].usd - a[1].usd)) {
    console.log(`${k.padEnd(25)} ${c.held ? 'yes ' : 'no  '} ${String(c.n).padStart(5)} ${String(c.cold).padStart(5)} ${String(c.write).padStart(19)} ${f(c.usd).padStart(8)}`)
  }
  console.log(`\nafter the rules (held ones folded into the next turn or fired once at the ${HOLD_CAP_MS / 60000} min cap): ${after.length} wakes, ${result.after.writeTokens} tokens, est. $${f(result.after.usd)}`)
  if (flags.has('--md')) {
    console.log(`\n\`\`\`mermaid\nxychart-beta\n    title "Estimated manager wake-up cache-write cost, USD (n=${result.wakes} wakes, ${result.managers} managers, ${result.sessions} sessions)"\n    x-axis ["before", "new rules", "1h cache TTL"]\n    y-axis "USD (estimate)" 0 --> ${Math.ceil(result.usd * 1.1)}\n    bar [${f(result.usd)}, ${f(result.after.usd)}, ${f(result.usdIf1h)}]\n\`\`\``)
  }
}
