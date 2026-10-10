import type { Activity, AgentRow, Handover, Ledger, LogEvent, Leftovers, OpenPr, PrCache, TestSlots } from '../types'
import type { Settings } from './prompts'
import { phaseOf } from './preflight'
import type { Preflight } from './preflight'
import { describe } from './dag'
import type { Plan } from './dag'
import { inboxHead } from './inbox'
import type { Inbox } from './inbox'
import { leftoverLine } from './clean'
import { behindLines } from './deploy'
import type { Deploys } from './deploy'
import { renderBatch } from './pushgate'
import type { PushState } from './pushgate'
import { baseName, prCost, reportSuffix } from './cost'
import { evidenceSummary } from './evidence'
import { handoffOf, handoffText, ROLE } from './pane'
import { labelOf } from './meter'
import { ownerFor } from './state'
import { slotLine } from './slots'
import { MANAGER, mirror, WORKERS } from './core'

// The status tool, scoped by caller. The engine refuses `$` across an import, so register.tsx builds a
// StatusIo of closures over the calls this needs.
export type Unhanded = { pr: number; title: string; branch: string; note: string }

export type StatusIo = {
  now: () => Promise<number>
  handovers: () => Promise<Record<string, Handover>>
  readLog: () => Promise<LogEvent[]>
  prCache: () => Promise<PrCache>
  fetchPrs: () => Promise<void>
  refresh: () => Promise<AgentRow[]>
  activity: () => Promise<Record<string, Activity>>
  unhanded: () => Promise<Unhanded[]>
  leftovers: () => Promise<Leftovers>
  costLines: (prs: { pr: number; branch: string }[], keep?: (e: Ledger[string]) => boolean) => Promise<string[]>
  ledger: () => Promise<Ledger>
  preflight: () => Promise<Preflight>
  inbox: () => Promise<Inbox>
  plans: () => Promise<Plan>
  slots: () => Promise<TestSlots>
  offerSeeds: () => Promise<string[]>
  pushState: () => Promise<PushState>
  deploys: () => Promise<Deploys>
  behind: () => Promise<Record<string, number>>
  limitsLine: (rows: AgentRow[], workers: number) => string
  stateDir: () => Promise<string | undefined>
}

const PR_MIN_GAP_MS = 60_000

// How many finished handovers status lists; the rest only count, `pr:<n>` gives any one in full.
const FINISHED_SHOWN = 5
const FINISHED_REPORT_MAX = 120

// Open handovers in order, then the newest finished ones, and how many finished were left out.
export function cappedHandovers(list: Handover[]): { shown: Handover[]; hidden: number } {
  const finished = list.filter(h => h.status === 'done').sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
  const keep = new Set(finished.slice(0, FINISHED_SHOWN))
  return { shown: list.filter(h => h.status !== 'done' || keep.has(h)), hidden: Math.max(0, finished.length - FINISHED_SHOWN) }
}

const clipLine = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// reportMax clips only the reviewer's report, so the title and evidence of a finished line stay.
function handoverLine(h: Handover, reportMax?: number): string {
  const tail = h.status === 'done' ? ` ${h.sha ?? ''} ${reportMax === undefined ? h.report ?? '' : clipLine(h.report ?? '', reportMax)}`
    : h.status === 'returned' ? ` returned: ${h.reason ?? ''}`
    : h.status === 'awaiting' ? ` awaiting the user's approval: /flow approve ${h.pr}`
    : h.status === 'ready' ? ' ready in a batch that awaits the user: /flow push' : ''
  return `#${h.pr} ${h.status} (${h.branch} @ ${h.head.slice(0, 8)}, from ${h.reportTo})${tail} — ${h.title} [${evidenceSummary(h.evidence)}]`
}

const unhandedLine = (u: Unhanded): string => `#${u.pr} ${u.title} (${u.branch}) — ${u.note}`

export async function statusTool(io: StatusIo, settings: Settings, input: Record<string, unknown>, agentId: string | undefined): Promise<{ result: string }> {
    const asked = Number(input.pr)
    if (Number.isInteger(asked) && asked > 0) {
      const h = (await io.handovers())[String(asked)]
      const events = await io.readLog()
      const owner = ownerFor(events, { pr: asked, branch: h?.branch }) ?? h?.reportTo ?? 'unknown'
      const mine = events.filter(l => l.pr === asked || (h !== undefined && l.branch === h.branch))
      return {
        result: [...(h === undefined ? [] : [handoverLine(h)]), `Owner of PR #${asked}: ${owner}`, ...mine.map(l => `${l.ts} ${l.event}${l.agent ? ` ${l.agent}` : ''}${l.text ? `: ${l.text}` : ''}`)].join('\n'),
      }
    }
    if (mirror.queueOn && (await io.now()) - (await io.prCache()).fetchedAt > PR_MIN_GAP_MS) await io.fetchPrs()
    const [allRows, acts, allHs] = await Promise.all([io.refresh(), io.activity(), io.handovers()])
    // What the caller needs, so the result it keeps in its context stays small: a manager sees its own
    // subtree and PRs, a worker itself and its manager. Main, the reviewer (it works the whole queue) and
    // an unknown caller see everything.
    const me = agentId === undefined ? undefined : allRows.find(r => r.id === agentId)
    const scope: 'all' | 'manager' | 'worker' = me === undefined ? 'all' : me.type === MANAGER ? 'manager' : WORKERS.has(me.type) ? 'worker' : 'all'
    const mine = new Set<string>(me === undefined ? [] : [me.id])
    // A successor (x-2) has no parent link to x's workers: seed with every manager of the same base name.
    if (scope === 'manager') for (const r of allRows) if (r.type === MANAGER && r.name !== undefined && baseName(r.name) === baseName(me?.name ?? '')) mine.add(r.id)
    if (scope === 'manager') for (let grew = true; grew;) { grew = false; for (const r of allRows) if (r.parentId !== undefined && mine.has(r.parentId) && !mine.has(r.id)) { mine.add(r.id); grew = true } }
    if (scope === 'worker' && me?.parentId !== undefined) mine.add(me.parentId)
    const rows = scope === 'all' ? allRows : allRows.filter(r => mine.has(r.id))
    const myBase = baseName(me?.name ?? '')
    const hs = scope === 'all' ? allHs : scope === 'manager' ? Object.fromEntries(Object.entries(allHs).filter(([, h]) => baseName(h.reportTo) === myBase)) : {}
    const [unhanded, cache] = scope === 'all' ? [await io.unhanded(), await io.prCache()] : [[], await io.prCache()]
    const leftover = scope === 'all' ? leftoverLine(await io.leftovers()) : ''
    const costs = scope === 'worker' ? [] : await io.costLines(Object.values(hs), scope === 'manager'
      ? en => (en.role === 'manager' ? baseName(en.name) : en.role === 'worker' && en.manager !== undefined ? baseName(en.manager) : undefined) === myBase
      : undefined)
    const led = await io.ledger()
    const lines: string[] = []
    const byParent = new Map<string | undefined, AgentRow[]>()
    for (const a of rows) byParent.set(a.parentId, [...(byParent.get(a.parentId) ?? []), a])
    const ids = new Set(rows.map(a => a.id))
    const pre = await io.preflight()
    const inb = await io.inbox()
    const walk = (a: AgentRow, depth: number) => {
      const phase = a.type === MANAGER && a.name !== undefined ? phaseOf(pre, inb, a.name) : undefined
      const answer = (acts[a.id]?.answer ?? '').trim().split('\n').pop() ?? ''
      const h = handoffOf(a, acts[a.id])
      const hand = h === undefined ? '' : h.kind === 'done' ? ` | ${handoffText(h)}` : ` | handoff: wrapping up${h.percent === undefined ? '' : ` (${h.percent}%)`}`
      lines.push(`${'  '.repeat(depth)}- ${ROLE[a.type] ?? a.type} ${labelOf(a)}: ${a.status}${hand}${phase ? ` | pre-flight: ${phase}` : ''}${answer ? ` | last: ${answer.slice(0, 160)}` : ''}`)
      for (const c of byParent.get(a.id) ?? []) walk(c, depth + 1)
    }
    for (const a of rows.filter(r => r.parentId === undefined || !ids.has(r.parentId))) walk(a, 0)
    const list = Object.values(hs).sort((a, b) => a.at - b.at)
    const { shown, hidden } = cappedHandovers(list)
    const plans = scope === 'worker' ? [] : Object.entries(await io.plans()).filter(([who, g]) => Object.keys(g).length > 0 && (scope === 'all' || baseName(who) === myBase))
    const slots = scope === 'worker' ? '' : slotLine(await io.slots(), settings.testSlots, await io.now())
    const seeds = agentId === undefined ? await io.offerSeeds() : []
    const gate = scope === 'all' ? (await io.pushState()).batch : undefined
    const batchLines = gate?.state === 'ready' ? renderBatch(gate) : []
    const pushing = gate !== undefined && gate.state !== 'ready' ? renderBatch(gate) : []
    return {
      result: [
        ...(scope === 'all' ? [
          ...inboxHead(await io.inbox(), await io.now()),
          ...seeds,
          ...behindLines(mirror.deployInfos, await io.deploys(), await io.behind()).map(l => `Deploy: ${l}`),
        ] : []),
        ...(scope === 'worker' ? [] : [io.limitsLine(allRows, settings.maxWorkers)]),
        ...(slots ? [slots] : []),
        rows.length ? 'Agents:' : 'No agents in this session.', ...lines,
        ...(scope === 'worker' ? [] : [
          list.length ? 'Handed-over PRs:' : 'No PRs handed over.',
          ...shown.map(h => `${handoverLine(h, FINISHED_REPORT_MAX)}${h.report?.includes('| cost:') ? '' : reportSuffix(prCost(led, h.branch))}`),
          ...(hidden > 0 ? [`+${hidden} earlier finished PRs (mcp__flow__status pr:<n> for one)`] : []),
        ]),
        ...(unhanded.length ? [
          'Needs attention:', ...unhanded.map(u => `  ${unhandedLine(u)}`),
          'A manager reviews it and hands it over, or closes it.',
        ] : []),
        ...(list.some(h => h.status === 'awaiting') || batchLines.length > 0 ? [
          'Needs the user:',
          ...batchLines.map(l => `  ${l}`),
          ...list.filter(h => h.status === 'awaiting').map(h => `  #${h.pr} awaits approval: /flow approve ${h.pr} — ${h.title}`),
        ] : []),
        ...(pushing.length > 0 ? ['Push gate:', ...pushing.map(l => `  ${l}`)] : []),
        ...(scope === 'all' && mirror.queueOn && cache.error !== undefined ? [`Open PRs not checked: gh pr list failed: ${cache.error}`] : []),
        ...(leftover ? [leftover] : []),
        ...(plans.length ? ['Plans:', ...plans.flatMap(([who, g]) => [`${who}:`, ...describe(g).map(l => `  ${l}`)])] : []),
        ...costs,
        ...(scope === 'all' ? [`State: ${await io.stateDir() ?? 'none (not a git repo)'}`] : []),
      ].join('\n'),
    }
}
