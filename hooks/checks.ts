// The pure half of person checks: an after-deploy check that needs a person becomes a durable item the
// user closes as passed or failed. Captured from the reviewer's `needs a person: PR #<n>: <steps>` report
// line; kept in <state dir>/checks.json (the disk half is withChecks() in register.tsx). Separate from the
// decision inbox's questions (inbox.ts), shown alongside them.

import type { Check, Checks, FollowUp } from '../types'
import { renderTable, truncate } from './table'
import type { Column, Row } from './table'

export type { Check, Checks, FollowUp }

export const EMPTY_CHECKS: Checks = { next: 1, items: [] }

export type Needed = { pr: number; steps: string }

const MARK = /needs a person: PR #(\d+): ([^\n]*?)(?= \| |\n|$)/g

// The needs-a-person lines of a reviewer report; steps end at the next " | " or the end of the line.
export function parseNeeds(report: string | undefined): Needed[] {
  const out: Needed[] = []
  for (const m of (report ?? '').matchAll(MARK)) {
    const steps = (m[2] ?? '').trim()
    if (steps !== '') out.push({ pr: Number(m[1]), steps })
  }
  return out
}

export const normSteps = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim()

// A version mentioned in the steps: "install 0.3.31" first, else any X.Y.Z.
export function versionInSteps(steps: string): string | undefined {
  return /\binstall(?:ed|ing)?\s+(?:plugin\s+)?v?(\d+\.\d+\.\d+)/i.exec(steps)?.[1] ?? /\bv?(\d+\.\d+\.\d+)\b/.exec(steps)?.[1]
}

const parts = (v: string): number[] => v.replace(/^v/, '').split('.').map(p => Number.parseInt(p, 10) || 0)

// Negative when a is older than b; numeric per dot-separated part.
export function compareVersions(a: string, b: string): number {
  const x = parts(a)
  const y = parts(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

// A path glob as a regex: ** crosses directories, * stays in one, ? is one character.
function globRe(g: string): RegExp {
  let s = ''
  for (let i = 0; i < g.length; i++) {
    const ch = g[i]!
    if (ch === '*' && g[i + 1] === '*') { s += '.*'; i++; if (g[i + 1] === '/') i++ }
    else if (ch === '*') s += '[^/]*'
    else if (ch === '?') s += '[^/]'
    else s += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${s}$`)
}

// Whether any changed file matches any glob.
export const anyMatch = (globs: string[], files: string[]): boolean => {
  const res = globs.map(globRe)
  return files.some(f => res.some(r => r.test(f)))
}

export const SKIP_NOTE = 'scripted verification skipped: no changed file matches verify_paths'

export type NewCheck = { steps: string; version?: string; verifyCommand?: string; note?: string }

// Adds a check for each item unless the same PR and steps (normalised) already have one, of any state.
export function addChecks(cur: Checks, pr: number, title: string, sha: string | undefined, items: NewCheck[], now: number): { checks: Checks; added: Check[] } {
  const added: Check[] = []
  let next = cur.next
  const seen = new Set(cur.items.map(c => `${c.pr}|${normSteps(c.steps)}`))
  for (const it of items) {
    const key = `${pr}|${normSteps(it.steps)}`
    if (seen.has(key)) continue
    seen.add(key)
    added.push({
      id: `c${next++}`, kind: 'check', pr, title, steps: it.steps, ...(it.version !== undefined ? { version: it.version } : {}),
      ...(sha ? { sha } : {}), ...(it.verifyCommand ? { verifyCommand: it.verifyCommand } : {}), ...(it.note ? { note: it.note } : {}),
      createdAt: now, state: 'open',
    })
  }
  return added.length === 0 ? { checks: cur, added } : { checks: { ...cur, next, items: [...cur.items, ...added] }, added }
}

export const openChecks = (c: Checks): Check[] => c.items.filter(x => x.state === 'open')
export const openFollowUps = (c: Checks): Check[] => c.items.filter(x => x.state === 'failed' && x.followUp?.state === 'open')

export type Groups = { install: { version: string; items: Check[] }[]; ready: Check[]; none: Check[]; unknown: Check[] }

// Open checks by what they need: a newer version than installed (one group per version, ascending), the
// installed version or older, no version at all. With the installed version unknown, a versioned check is "unknown".
export function groupOpen(c: Checks, installed: string | undefined): Groups {
  const g: Groups = { install: [], ready: [], none: [], unknown: [] }
  const byVersion = new Map<string, Check[]>()
  for (const x of openChecks(c)) {
    if (x.version === undefined) g.none.push(x)
    else if (installed === undefined) g.unknown.push(x)
    else if (compareVersions(x.version, installed) <= 0) g.ready.push(x)
    else byVersion.set(x.version, [...(byVersion.get(x.version) ?? []), x])
  }
  g.install = [...byVersion.entries()].sort((a, b) => compareVersions(a[0], b[0])).map(([version, items]) => ({ version, items }))
  return g
}

const line = (c: Check) =>
  `  ${c.id} PR #${c.pr} ${c.title}: ${c.steps}${c.verifyCommand ? ` (scripted: ${c.verifyCommand})` : ''}${c.note ? ` [${c.note}]` : ''}`

function groupLines(g: Groups, installed: string | undefined): string[] {
  const out: string[] = []
  for (const x of g.install) out.push(`Needs install of ${x.version} and a restart:`, ...x.items.map(line))
  if (g.ready.length) out.push(`Ready on the installed version ${installed ?? '?'}:`, ...g.ready.map(line))
  if (g.unknown.length) out.push('Version unknown (the installed version could not be read):', ...g.unknown.map(line))
  if (g.none.length) out.push('No version:', ...g.none.map(line))
  return out
}

const followUpLine = (c: Check) => `  ${c.id} PR #${c.pr} ${c.title}: failed (${c.note ?? ''}). Start a manager on the follow-up with the PR, the steps (${c.steps}) and the note, then mcp__flow__check {"action":"started","id":"${c.id}","manager":"<name>"}.`

const FOLLOW = 'Open follow-ups from failed checks:'

// mcp__flow__check list and the agent-facing text: every step in full, and how main closes a check.
export function renderChecksForAgents(c: Checks, installed: string | undefined): string {
  const open = openChecks(c)
  const fu = openFollowUps(c)
  if (open.length === 0 && fu.length === 0) return 'No open checks.'
  return [
    ...(open.length ? [`Open checks: ${open.length}. Close with mcp__flow__check (pass / fail / skip) or /flow checks pass <id...> | fail <id> <note> | skip <id...> <why>.`, ...groupLines(groupOpen(c, installed), installed)] : ['No open checks.']),
    ...(fu.length ? [FOLLOW, ...fu.map(followUpLine)] : []),
  ].join('\n')
}

// The "Checks" section of /flow inbox: the count and the same short grouping, or nothing when none are open.
export function inboxChecksSection(c: Checks, installed: string | undefined): string[] {
  const open = openChecks(c)
  const fu = openFollowUps(c)
  if (open.length === 0 && fu.length === 0) return []
  const g = groupOpen(c, installed)
  const bits = [
    ...g.install.map(x => `${x.items.length} need install of ${x.version}`),
    ...(g.ready.length ? [`${g.ready.length} ready`] : []), ...(g.unknown.length ? [`${g.unknown.length} version unknown`] : []),
    ...(g.none.length ? [`${g.none.length} no version`] : []),
  ]
  return [`Checks: ${open.length} open${bits.length ? ` (${bits.join(', ')})` : ''}${fu.length ? `, ${fu.length} follow-up${fu.length > 1 ? 's' : ''}` : ''}. /flow checks lists them.`]
}

// The one-line count on the Flow pane, or undefined when there is nothing open.
export function paneChecksLine(c: Checks, installed: string | undefined): string | undefined {
  const open = openChecks(c)
  const fu = openFollowUps(c)
  if (open.length === 0 && fu.length === 0) return undefined
  const g = groupOpen(c, installed)
  const need = g.install.reduce((n, x) => n + x.items.length, 0)
  const vers = g.install.map(x => x.version).join(', ')
  const waits = need ? ` (${need} wait for ${vers} to be installed)` : ''
  const parts = [
    ...(open.length ? [`${open.length} check${open.length === 1 ? '' : 's'} to try by hand${waits}`] : []),
    ...(fu.length ? [`${fu.length} failed check${fu.length === 1 ? '' : 's'} to hand to a manager`] : []),
  ]
  return `${parts.join(', ')}. /flow checks lists them`
}

// The /flow resume section: open checks are mentioned only; follow-ups are work for main to start.
export function resumeChecksLines(c: Checks, installed: string | undefined): string[] {
  const open = openChecks(c)
  const fu = openFollowUps(c)
  return [
    ...(open.length ? ['Open checks (for the user, nothing to start):', ...groupLines(groupOpen(c, installed), installed)] : []),
    ...(fu.length ? ['Open follow-ups from failed checks (start a manager on each):', ...fu.map(followUpLine)] : []),
  ]
}

// The open checks the installed version now covers, if it differs from the version main was last prompted for.
export function dueForPrompt(c: Checks, installed: string | undefined): Check[] {
  if (installed === undefined || c.promptedVersion === installed) return []
  return openChecks(c).filter(x => x.version !== undefined && compareVersions(x.version, installed) <= 0)
}

export const CHECKS_USAGE = 'Usage: /flow checks, /flow checks <id>, /flow checks pass <id...>, /flow checks fail <id> <what you saw>, /flow checks skip <id> <why>'

// A short age: minutes, hours or days.
const ago = (ms: number): string => {
  const m = Math.max(0, Math.round(ms / 60_000))
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`
}

const byId = (a: Check, b: Check) => Number(a.id.slice(1)) - Number(b.id.slice(1))

const COLS: Column[] = [
  { header: 'id' }, { header: 'PR' }, { header: 'title', flex: true },
  { header: 'needs', max: 14, drop: 2 }, { header: 'age', max: 4, drop: 1 },
]

const titleOf = (c: Check) => c.title === '' ? `PR #${c.pr}` : c.title

// The person view of /flow checks: one table, one row per open check, grouped by what it needs, then the open
// follow-ups of failed checks. Full steps are in the detail view, so rows never wrap.
export function renderChecksTable(c: Checks, installed: string | undefined, width: number, now: number, footer = true): string {
  const open = openChecks(c)
  const fu = openFollowUps(c)
  if (open.length === 0 && fu.length === 0) return 'No open checks.'
  const g = groupOpen(c, installed)
  const row = (x: Check, needs: string): string[] => [x.id, `#${x.pr}`, titleOf(x), needs, ago(now - x.createdAt)]
  const rows: Row[] = []
  const tryNow = [...g.ready, ...g.none].sort(byId)
  if (tryNow.length) rows.push('Try now', ...tryNow.map(x => row(x, 'ready')))
  for (const x of g.install) rows.push(`Needs install of ${x.version}`, ...x.items.map(i => row(i, `install ${x.version}`)))
  if (g.unknown.length) rows.push('Version unknown', ...g.unknown.map(x => row(x, '?')))
  if (fu.length) rows.push('Failed, follow-up open', ...fu.map(x => [x.id, `#${x.pr}`, `failed: ${x.note ?? ''} · ${titleOf(x)}`, '', ago(now - (x.closedAt ?? x.createdAt))]))
  const out = [`Checks: ${open.length} open${fu.length ? `, ${fu.length} failed with a follow-up` : ''}`, '', ...renderTable(COLS, rows, width)]
  if (footer) {
    const first = (open[0] ?? fu[0])!.id
    const ready = tryNow.map(x => x.id)
    // Only failed checks left: pass, fail and skip on them are refused, so show the detail command alone.
    const parts = open.length === 0 ? [`Details: /flow checks ${first}`] : [
      `Pass: /flow checks pass ${(ready.length ? ready.slice(0, 2) : [first]).join(' ')}`, `Fail: /flow checks fail ${first} <what you saw>`,
      `Skip: /flow checks skip ${first} <why>`, `Details: /flow checks ${first}`,
    ]
    const one = parts.join(' · ')
    out.push('', ...(one.length <= width ? [one] : parts.map(x => truncate(x, width))))
  }
  return out.join('\n')
}

// One check in full, for /flow checks <id>.
export function renderCheckDetail(c: Checks, id: string, installed: string | undefined, now: number): string {
  const x = c.items.find(i => i.id === id)
  if (x === undefined) return `${id}: no such check.`
  const state = x.state === 'failed' && x.followUp ? `failed (follow-up ${x.followUp.state === 'started' ? `started by ${x.followUp.manager ?? '?'}` : 'open'})` : x.state
  const needs = x.version === undefined ? 'no version' : x.version + (installed === undefined ? '' : compareVersions(x.version, installed) <= 0 ? ' (installed)' : ' (not installed yet)')
  const lines = [
    `${x.id}: PR #${x.pr}${x.title ? ` ${x.title}` : ''}`,
    `State: ${state}`, `Version: ${needs}`, `Age: ${ago(now - x.createdAt)}`, `Steps: ${x.steps}`,
    ...(x.verifyCommand ? [`Verify command: ${x.verifyCommand}`] : []),
    ...(x.note ? [`Note: ${x.note}`] : []),
    ...(x.closedAt !== undefined ? [`Closed: ${x.state} by ${x.closedBy ?? '?'}, ${ago(now - x.closedAt)} ago`] : []),
  ]
  if (x.state === 'open') lines.push(`Pass: /flow checks pass ${x.id}`, `Fail: /flow checks fail ${x.id} <what you saw>`, `Skip: /flow checks skip ${x.id} <why>`)
  return lines.join('\n')
}

export type CloseResult = { checks: Checks; text: string; failed?: Check[] }

// Closes checks as passed or failed. A closed or unknown id is refused with its state, and nothing is closed
// when any id is refused. `scriptedOnly` (the reviewer) may close only checks that carry a command.
export function closeChecks(
  cur: Checks, ids: string[], how: 'pass' | 'fail' | 'skip', by: string, note: string | undefined, now: number, scriptedOnly = false,
): CloseResult | { error: string } {
  if (ids.length === 0) return { error: 'needs an id (see action "list").' }
  if (how === 'fail' && (note === undefined || note.trim() === '')) return { error: 'a failed check needs a note: what went wrong.' }
  if (how === 'skip' && (note === undefined || note.trim() === '')) return { error: 'a skipped check needs a reason: why it no longer applies.' }
  if (how === 'skip' && scriptedOnly) return { error: 'only main skips a check.' }
  if (how === 'fail' && ids.length > 1) return { error: 'fail one check at a time, each with its own note.' }
  const bad: string[] = []
  for (const id of ids) {
    const c = cur.items.find(x => x.id === id)
    if (c === undefined) bad.push(`${id}: no such check`)
    else if (c.state !== 'open') bad.push(`${id}: already ${c.state}`)
    else if (scriptedOnly && !c.verifyCommand) bad.push(`${id}: has no verify command, only main closes it`)
  }
  if (bad.length) return { error: bad.join('; ') + '.' }
  const hit = new Set(ids)
  const items = cur.items.map(c => !hit.has(c.id) ? c : how === 'skip'
    ? { ...c, state: 'skipped' as const, closedAt: now, closedBy: by, note: note!.trim() }
    : how === 'pass'
    ? { ...c, state: 'passed' as const, closedAt: now, closedBy: by, ...(note?.trim() ? { note: note.trim() } : {}) }
    : { ...c, state: 'failed' as const, closedAt: now, closedBy: by, note: note!.trim(), followUp: { state: 'open' as const } })
  const checks = { ...cur, items }
  const closed = items.filter(c => hit.has(c.id))
  return how === 'skip' ? { checks, text: `Skipped: ${ids.join(', ')}.` } : how === 'pass'
    ? { checks, text: `Passed: ${ids.join(', ')}.` }
    : { checks, failed: closed, text: `${ids[0]} failed. Start a manager on the follow-up: PR #${closed[0]!.pr} (${closed[0]!.title}), steps: ${closed[0]!.steps}. Note: ${closed[0]!.note}. Then call mcp__flow__check {"action":"started","id":"${ids[0]}","manager":"<name>"}.` }
}

// Marks a failed check's follow-up as started by a manager.
export function markStarted(cur: Checks, id: string, manager: string): { checks: Checks; text: string } | { error: string } {
  const c = cur.items.find(x => x.id === id)
  if (c === undefined) return { error: `${id}: no such check.` }
  if (c.state !== 'failed' || c.followUp === undefined) return { error: `${id}: is ${c.state}; only a failed check has a follow-up.` }
  if (c.followUp.state === 'started') return { error: `${id}: follow-up already started by ${c.followUp.manager ?? '?'}.` }
  if (manager.trim() === '') return { error: 'started needs the manager name.' }
  return { checks: { ...cur, items: cur.items.map(x => x.id === id ? { ...x, followUp: { state: 'started' as const, manager: manager.trim() } } : x) }, text: `${id}: follow-up started by ${manager.trim()}.` }
}

// A stored file read back; anything malformed is dropped, unknown fields are not kept.
export function normalizeChecks(raw: unknown): Checks {
  const r = raw as { next?: unknown; items?: unknown; promptedVersion?: unknown } | null
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
  const items: Check[] = []
  for (const x of Array.isArray(r?.items) ? r.items : []) {
    const o = x as Record<string, unknown> | null
    if (typeof o !== 'object' || o === null || typeof o.id !== 'string' || typeof o.pr !== 'number' || typeof o.steps !== 'string') continue
    if (o.state !== 'open' && o.state !== 'passed' && o.state !== 'failed' && o.state !== 'skipped') continue
    const fu = o.followUp as { state?: unknown; manager?: unknown } | undefined
    items.push({
      id: o.id, kind: 'check', pr: o.pr, title: str(o.title) ?? '', steps: o.steps,
      ...(str(o.version) !== undefined ? { version: str(o.version) } : {}), ...(str(o.sha) !== undefined ? { sha: str(o.sha) } : {}),
      ...(str(o.verifyCommand) ? { verifyCommand: str(o.verifyCommand) } : {}),
      createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0, state: o.state,
      ...(typeof o.closedAt === 'number' ? { closedAt: o.closedAt } : {}), ...(str(o.closedBy) !== undefined ? { closedBy: str(o.closedBy) } : {}),
      ...(str(o.note) !== undefined ? { note: str(o.note) } : {}),
      ...(o.state === 'failed' ? { followUp: { state: fu?.state === 'started' ? 'started' as const : 'open' as const, ...(str(fu?.manager) !== undefined ? { manager: str(fu?.manager) } : {}) } } : {}),
    })
  }
  const top = Math.max(0, ...items.map(x => Number(/^c(\d+)$/.exec(x.id)?.[1] ?? 0)))
  return { next: Math.max(top + 1, typeof r?.next === 'number' ? r.next : 1), items, ...(typeof r?.promptedVersion === 'string' ? { promptedVersion: r.promptedVersion } : {}) }
}
