// The opt-in A/B of Jev sizing (setting size_ab "daily"): which arm a day belongs to, and the report over ledger rows
// tagged with `sizeArm`. The report is read-only and makes no network call (the tool and scripts/size-ab.mjs share it).
import type { Ledger, LedgerEntry, LogEvent } from '../types'
import { baseName, costOf } from './cost'
import { generation } from './routing'

export type SizeArm = 'jev' | 'off'
export const MIN_PACKAGES = 20

// Local epoch day (days since 1970-01-01 in the local calendar), so the 31st and the 1st do not repeat an arm.
// Even epoch day -> arm "jev" (sizes through the decision API), odd -> arm "off" (the Size line alone).
// Only with the decision API on jev: the A/B compares Jev against no Jev, so any other provider has no arm.
export function sizeArmOf(sizeAb: 'off' | 'daily' | undefined, decisionApi: string | undefined, nowMs: number): SizeArm | undefined {
  if (sizeAb !== 'daily' || decisionApi !== 'jev') return undefined
  const day = Math.floor((nowMs - new Date(nowMs).getTimezoneOffset() * 60_000) / 86_400_000)
  return day % 2 === 0 ? 'jev' : 'off'
}

// The sizing function a spawn uses: the off arm gets none, so the decision API is not called (the Size line alone).
export const sizerFor = <T,>(arm: SizeArm | undefined, make: () => T | undefined): T | undefined => (arm === 'off' ? undefined : make())

type Row = Pick<LedgerEntry, 'role' | 'name' | 'manager' | 'branch' | 'spawnModel' | 'models'> & { sizeArm?: string; arm?: LedgerEntry['arm'] }
export type ArmStats = { packages: number; merged: number; usd: number; usdPerMerged?: number; rerun: number; models: Record<string, number> }
export type RoleReport = Record<SizeArm, ArmStats>
export type AbReport = { worker: RoleReport; manager: RoleReport }

const isArm = (v: unknown): v is SizeArm => v === 'jev' || v === 'off'
const usdOf = (r: Row): number => Object.entries(r.models ?? {}).reduce((n, [m, b]) => n + (costOf(m, b) ?? 0), 0)

// Branches of merged pull requests: the reviewer's `done` log event carries the merged PR's branch.
export const mergedBranches = (log: Pick<LogEvent, 'event' | 'branch'>[]): Set<string> =>
  new Set(log.filter(l => l.event === 'done' && l.branch !== undefined).map(l => l.branch!))

// The package a row belongs to: its base name with the -N successors; the arms of a best-of-N group (hooks/bestof.ts)
// are one package (the group), so a group has one first attempt and its arms are not counted as reruns.
const packageOf = (r: Row): string => r.arm !== undefined ? r.arm.group : baseName(r.name)

// A package is a base name with its -N successors, per role, attributed to the arm of its FIRST spawn (lowest
// generation); a package whose first spawn has no arm predates the A/B and is left out. Merged: a worker package has a
// merged branch among its own rows; a manager package has a merged branch among its workers' (rows whose manager is it).
// A manager package's $ is the manager's own rows, its workers are counted in the worker report.
export function sizeAbReport(ledger: Ledger | Record<string, Row>, merged: Set<string>): AbReport {
  const rows = Object.values(ledger as Record<string, Row>).filter(r => typeof r.name === 'string' && (r.role === 'worker' || r.role === 'manager'))
  const empty = (): ArmStats => ({ packages: 0, merged: 0, usd: 0, rerun: 0, models: {} })
  const out: AbReport = { worker: { jev: empty(), off: empty() }, manager: { jev: empty(), off: empty() } }
  for (const role of ['worker', 'manager'] as const) {
    const byBase = new Map<string, Row[]>()
    for (const r of rows.filter(x => x.role === role)) byBase.set(packageOf(r), [...(byBase.get(packageOf(r)) ?? []), r])
    for (const [base, pkg] of byBase) {
      const first = pkg.reduce((a, b) => (generation(b.name) < generation(a.name) ? b : a))
      if (!isArm(first.sizeArm)) continue
      const s = out[role][first.sizeArm]
      s.packages++
      s.usd += pkg.reduce((n, r) => n + usdOf(r), 0)
      if (pkg.some(r => generation(r.name) > 1)) s.rerun++
      for (const r of pkg) if (r.spawnModel !== undefined) s.models[r.spawnModel] = (s.models[r.spawnModel] ?? 0) + 1
      const branches = role === 'worker' ? pkg.map(r => r.branch) : rows.filter(w => w.role === 'worker' && w.manager !== undefined && baseName(w.manager) === base).map(w => w.branch)
      if (branches.some(b => b !== undefined && merged.has(b))) s.merged++
    }
    for (const arm of ['jev', 'off'] as const) { const s = out[role][arm]; if (s.merged > 0) s.usdPerMerged = s.usd / s.merged }
  }
  return out
}

export function formatSizeAb(r: AbReport): string {
  const lines = [
    'Size A/B: arm jev = sized through the decision API (even local epoch day), arm off = the Size line alone (odd day).',
    'A package is a base name with its -N successors, attributed to the arm of its first spawn. Merged = a `done` event in log.jsonl for one of its branches (a manager: any of its workers\' branches). $ is at hooks/cost.ts list prices; a manager package counts the manager\'s own rows only.',
  ]
  const small: string[] = []
  for (const role of ['worker', 'manager'] as const) {
    lines.push('', `${role}s:`)
    for (const arm of ['jev', 'off'] as const) {
      const s = r[role][arm]
      const mix = Object.entries(s.models).sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} ${n}`).join(', ') || 'none'
      lines.push(`  ${arm}: ${s.packages} packages, ${s.merged} merged, ${s.usdPerMerged === undefined ? 'no $ per merged PR' : `$${s.usdPerMerged.toFixed(2)} per merged PR`} ($${s.usd.toFixed(2)} total), ${s.rerun} needed a -N successor${s.packages > 0 ? ` (${Math.round(100 * s.rerun / s.packages)}%)` : ''}; models: ${mix}`)
    }
    if (r[role].jev.packages < MIN_PACKAGES || r[role].off.packages < MIN_PACKAGES) small.push(role)
  }
  if (small.length > 0) lines.push('', `Too small to conclude (${small.join(' and ')}: fewer than ${MIN_PACKAGES} packages in an arm).`)
  return lines.join('\n')
}

export type SizeAbIo = { stateDir: () => Promise<string | undefined>; readFile: (path: string) => Promise<string | undefined> }

// The main-only size_ab_report tool: reads ledger.json and log.jsonl of the state dir, writes nothing.
export async function sizeAbTool(io: SizeAbIo, agentId: string | undefined): Promise<string> {
  if (agentId !== undefined) return 'Refused: only main runs size_ab_report.'
  const dir = await io.stateDir()
  if (dir === undefined) return 'Refused: not in a git repo, so there is no flow state to read.'
  return reportFrom(await io.readFile(`${dir}/ledger.json`), await io.readFile(`${dir}/log.jsonl`))
}

// The report text from the raw files; shared with scripts/size-ab.mjs.
export function reportFrom(ledgerText: string | undefined, logText: string | undefined): string {
  let ledger: Record<string, Row> = {}
  try { const j = JSON.parse(ledgerText ?? '') as unknown; if (typeof j === 'object' && j !== null) ledger = j as Record<string, Row> } catch { /* none */ }
  const log: LogEvent[] = []
  for (const line of (logText ?? '').split('\n')) { try { const e = JSON.parse(line) as LogEvent; if (typeof e === 'object' && e !== null) log.push(e) } catch { /* torn line */ } }
  return formatSizeAb(sizeAbReport(ledger, mergedBranches(log)))
}
