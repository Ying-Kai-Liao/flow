// Best-of-N (setting best_of_n): a manager may start 2-3 competing workers ("arms") on one brief. Arms are agent
// workers named `<pkg>-a`, `<pkg>-b`, `<pkg>-c` (a letter, never a number: a trailing -<digits> means successor
// everywhere), each with an `Arm: <letter> of <N>` line in the brief. The manager picks the winner with the arms
// tool; only the winner's PR can be handed over. This file is the pure part: parsing, the spawn check, the
// ledger tag, the pick and the report. The tool's IO is a closure (ArmsIo) built in register.tsx.
import type { Ledger, LedgerEntry, LogEvent } from '../types'
import { baseName, money, totalOf } from './cost'
import { generation } from './routing'
import { mergedBranches } from './size-ab'

export type Arm = NonNullable<LedgerEntry['arm']>
export const ARM_LETTERS = ['a', 'b', 'c']

const ARM_LINE = /^Arm:\s*([a-c])\s+of\s+(\d+)\s*$/im

// The brief's `Arm: b of 3` line. Anything else (another letter, a missing count) is no arm line.
export function parseArm(prompt: string): { id: string; of: number } | undefined {
  const m = ARM_LINE.exec(prompt)
  return m === null ? undefined : { id: m[1]!.toLowerCase(), of: Number(m[2]) }
}

// `csv-export-b` -> group csv-export, letter b. A successor (`csv-export-b-2`) is not an arm name: it stays in its arm.
export function armName(name: string): { group: string; id: string } | undefined {
  const m = /^(.+)-([a-c])$/.exec(name)
  return m === null ? undefined : { group: m[1]!, id: m[2]! }
}

export type SpawnFacts = {
  name: string
  prompt: string
  bestOfN: 'off' | 'brief' | 'auto'
  arms: number
  parentIsManager: boolean
  // Names of the parent's workers that are live now.
  liveSiblings: string[]
  maxWorkers: number
}

// The refusal for an arm spawn that breaks the protocol; undefined for a spawn that is no arm or is fine.
export function armSpawnRefusal(f: SpawnFacts): string | undefined {
  const arm = parseArm(f.prompt)
  if (arm === undefined) return undefined
  if (f.bestOfN === 'off') return 'flow: best_of_n is off, so the brief\'s "Arm:" line is refused. Remove the line to start one worker, or ask the user to set best_of_n to brief or auto.'
  if (!f.parentIsManager) return 'flow: only a manager starts best-of-N arms. Start a plain worker (no "Arm:" line) instead.'
  if (arm.of < 2) return `flow: an arm line needs at least 2 arms ("Arm: ${arm.id} of ${arm.of}"). For one worker leave the "Arm:" line out.`
  if (arm.of > f.arms) return `flow: "Arm: ${arm.id} of ${arm.of}" asks for ${arm.of} arms but best_of_n_arms allows ${f.arms}. Start at most ${f.arms}, each "of ${f.arms}" or fewer.`
  if (ARM_LETTERS.indexOf(arm.id) >= arm.of) return `flow: arm ${arm.id} does not exist in a best-of-${arm.of}: the letters are ${ARM_LETTERS.slice(0, arm.of).join(', ')}.`
  // A successor (`<pkg>-a-2`) is named after its arm; the arm itself `<pkg>-a`.
  const own = generation(f.name) >= 2 ? baseName(f.name) : f.name
  const named = armName(own)
  if (named === undefined || named.id !== arm.id) return `flow: arm ${arm.id} must be named "<package>-${arm.id}" (a letter suffix, never a number; got "${f.name}").`
  if (f.liveSiblings.length + 1 > f.maxWorkers) return `flow: starting ${f.name} would put ${f.liveSiblings.length + 1} workers of yours at work and max_workers is ${f.maxWorkers}. Arms count against it: start fewer arms, or wait for a worker to finish.`
  return undefined
}

// The ledger tag for a spawn: an arm from its brief and name, or the successor of an arm (it stays in the arm).
export function armOfSpawn(name: string, prompt: string, ledger: Ledger): Arm | undefined {
  const arm = parseArm(prompt)
  const own = generation(name) >= 2 ? baseName(name) : name
  const named = armName(own)
  if (arm !== undefined && named !== undefined && named.id === arm.id) return { group: named.group, id: arm.id, of: arm.of }
  if (generation(name) < 2) return undefined
  return Object.values(ledger).find(r => r.role === 'worker' && r.arm !== undefined && r.name === own)?.arm
}

// --- groups ---

type ArmRows = { id: string; rows: LedgerEntry[]; branches: string[] }
export type Group = { group: string; manager?: string; of: number; arms: ArmRows[] }

export function groupsOf(ledger: Ledger): Group[] {
  const out = new Map<string, Group>()
  for (const r of Object.values(ledger)) {
    if (r.role !== 'worker' || r.arm === undefined) continue
    const g = out.get(r.arm.group) ?? { group: r.arm.group, of: r.arm.of, arms: [] }
    if (g.manager === undefined && r.manager !== undefined) g.manager = r.manager
    let a = g.arms.find(x => x.id === r.arm!.id)
    if (a === undefined) { a = { id: r.arm.id, rows: [], branches: [] }; g.arms.push(a) }
    a.rows.push(r)
    if (r.branch !== undefined && !a.branches.includes(r.branch)) a.branches.push(r.branch)
    out.set(r.arm.group, g)
  }
  for (const g of out.values()) g.arms.sort((x, y) => x.id.localeCompare(y.id))
  return [...out.values()]
}

// An arm's branch is flow/<pkg>-<letter>; a successor continues on it, or on a numbered sibling of it.
const onBranch = (arm: string, branch: string): boolean => branch === arm || (branch.startsWith(`${arm}-`) && /^\d+$/.test(branch.slice(arm.length + 1)))
const armOfBranch = (g: Group, branch: string): ArmRows | undefined => g.arms.find(a => a.branches.some(b => onBranch(b, branch)))
const groupOfBranch = (ledger: Ledger, branch: string): { g: Group; arm: ArmRows } | undefined => {
  for (const g of groupsOf(ledger)) { const arm = armOfBranch(g, branch); if (arm !== undefined) return { g, arm } }
  return undefined
}

export type ArmPick = { pr: number; branch: string; reason: string }
export function pickOf(log: globalThis.Pick<LogEvent, 'event' | 'id' | 'pr' | 'branch' | 'text'>[], group: string): ArmPick | undefined {
  const e = [...log].reverse().find(l => l.event === 'arm-pick' && l.id === group)
  return e === undefined || e.pr === undefined || e.branch === undefined ? undefined : { pr: e.pr, branch: e.branch, reason: e.text ?? '' }
}

const armCost = (a: ArmRows) => totalOf(a.rows)
const armNameOfRows = (g: Group, a: ArmRows) => `${g.group}-${a.id}`
// Whether a live agent is this arm: the arm itself or its -N successor.
const isArmAgent = (name: string, armName: string): boolean => name === armName || (name.startsWith(`${armName}-`) && /^\d+$/.test(name.slice(armName.length + 1)))

// --- the handover gate and the unhanded filter ---

// Handover of an arm's PR is refused until the manager picked it as the winner.
export function armHandoverRefusal(branch: string, ledger: Ledger, log: LogEvent[]): string | undefined {
  const hit = groupOfBranch(ledger, branch)
  if (hit === undefined) return undefined
  const pick = pickOf(log, hit.g.group)
  if (pick === undefined) return `Refused: ${branch} is arm ${hit.arm.id} of best-of-${hit.g.of} group ${hit.g.group}, and no winner is picked. Review the arms' PRs, call mcp__flow__arms action "pick" (group "${hit.g.group}", pr, reason), then hand over only the winner.`
  if (!onBranch(pick.branch, branch) && !onBranch(branch, pick.branch)) return `Refused: ${branch} lost group ${hit.g.group} to ${pick.branch} (PR #${pick.pr}). Only the picked winner is handed over.`
  return undefined
}

// Branches the "PR nobody handed over" list leaves out: an arm of a group still being decided, or a picked loser.
export function armHidden(ledger: Ledger, log: globalThis.Pick<LogEvent, 'event' | 'id' | 'pr' | 'branch' | 'text'>[], isLiveName: (name: string) => boolean): (branch: string) => boolean {
  return branch => {
    const hit = groupOfBranch(ledger, branch)
    if (hit === undefined) return false
    const pick = pickOf(log, hit.g.group)
    if (pick !== undefined) return !(onBranch(pick.branch, branch) || onBranch(branch, pick.branch))
    return hit.g.arms.some(a => a.rows.some(r => isLiveName(r.name)))
  }
}

// --- the arms tool ---

export type Ran = { exitCode: number; stdout: string; stderr: string }
export type ArmsIo = {
  run: (argv: string[]) => Promise<Ran>
  ledger: () => Promise<Ledger>
  log: () => Promise<LogEvent[]>
  appendLog: (event: Omit<LogEvent, 'ts'>) => Promise<void>
  // The caller's name; undefined for the main session.
  callerName: (agentId: string | undefined) => Promise<string | undefined>
  // Names of the agents that are live now.
  liveNames: () => Promise<string[]>
}

const costLine = (g: Group, picked: ArmPick | undefined, merged: Set<string>): string[] => {
  const lines: string[] = []
  let total = 0
  let unknown = false
  let winner: { usd: number } | undefined
  for (const a of g.arms) {
    const t = armCost(a)
    total += t.usd
    unknown ||= t.unknown
    const won = picked !== undefined && a.branches.some(b => onBranch(b, picked.branch))
    if (won) winner = t
    const state = picked === undefined ? 'pending' : won ? (a.branches.some(b => merged.has(b)) ? 'won (merged)' : 'won (not merged)') : 'lost'
    lines.push(`  arm ${a.id}: ${state}, ${money(t.usd, t.unknown)}`)
  }
  const overhead = winner === undefined ? '' : `, winner ${money(winner.usd, unknown)}, overhead ${money(total - winner.usd, unknown)}`
  lines.push(`  group total ${money(total, unknown)}${overhead}`)
  return lines
}

export function armsReport(ledger: Ledger, log: LogEvent[], manager: string | undefined): string {
  const merged = mergedBranches(log)
  const groups = groupsOf(ledger).filter(g => manager === undefined || g.manager === manager)
  if (groups.length === 0) return 'No best-of-N arms recorded.'
  const out = ['Best-of-N arms ($ at hooks/cost.ts list prices; overhead = the group\'s cost beyond the winner):']
  for (const g of groups) {
    const p = pickOf(log, g.group)
    out.push(`group ${g.group}${g.manager === undefined ? '' : ` (manager ${g.manager})`}, ${g.of} arms: ${p === undefined ? 'no winner picked yet' : `winner ${p.branch} (PR #${p.pr})`}`, ...costLine(g, p, merged))
  }
  return out.join('\n')
}

export async function armsTool(io: ArmsIo, input: Record<string, unknown>, agentId: string | undefined): Promise<{ result: string }> {
  const caller = await io.callerName(agentId)
  if (agentId !== undefined && caller === undefined) return { result: 'Refused: the arms tool is for the manager that started the arms, or main.' }
  const ledger = await io.ledger()
  const log = await io.log()
  if (input.action === 'report') return { result: armsReport(ledger, log, agentId === undefined ? undefined : caller) }
  if (input.action !== 'pick') return { result: 'Refused: action must be "pick" or "report".' }
  const group = typeof input.group === 'string' ? input.group.trim() : ''
  const pr = Number(input.pr)
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (group === '' || !Number.isInteger(pr) || pr <= 0 || reason === '') return { result: 'Refused: pick needs group (the package name without the arm letter), pr (the winner\'s PR number) and reason.' }
  const g = groupsOf(ledger).find(x => x.group === group)
  if (g === undefined) return { result: `Refused: no arms recorded for group "${group}". The group is the package name without the arm letter (csv-export for csv-export-a).` }
  if (agentId !== undefined && g.manager !== caller) return { result: `Refused: group ${group} belongs to manager ${g.manager ?? '?'}; only it (or main) picks.` }
  const view = await io.run(['gh', 'pr', 'view', String(pr), '--json', 'headRefName,state'])
  if (view.exitCode !== 0) return { result: `Refused: gh pr view ${pr} failed: ${view.stderr.trim().slice(0, 300)}` }
  const info = JSON.parse(view.stdout) as { headRefName: string; state: string }
  const win = armOfBranch(g, info.headRefName)
  if (win === undefined) return { result: `Refused: PR #${pr} is on ${info.headRefName}, which is no arm of group ${group} (arms: ${g.arms.map(a => a.branches.join('/')).join(', ')}).` }
  const prior = pickOf(log, group)
  if (prior !== undefined && prior.pr !== pr) return { result: `Refused: group ${group} was already picked: PR #${prior.pr} (${prior.branch}). A pick is final; hand over that PR.` }
  if (prior === undefined && info.state !== 'OPEN') return { result: `Refused: PR #${pr} is ${info.state}; the winner must be open.` }
  const loserBranches = g.arms.filter(a => a !== win).flatMap(a => a.branches)
  const list = await io.run(['gh', 'pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,headRefName'])
  if (list.exitCode !== 0) return { result: `Refused: gh pr list failed, so the other arms' PRs cannot be closed: ${list.stderr.trim().slice(0, 300)}` }
  const open = (JSON.parse(list.stdout || '[]') as { number: number; headRefName: string }[]).filter(p => loserBranches.some(b => onBranch(b, p.headRefName)))
  if (prior === undefined) await io.appendLog({ event: 'arm-pick', owner: caller ?? 'main', id: group, pr, branch: info.headRefName, text: reason })
  const closed: number[] = []
  const failed: string[] = []
  for (const p of open) {
    const r = await io.run(['gh', 'pr', 'close', String(p.number), '--comment', `Closed: arm ${win.id} (PR #${pr}) won best-of-${g.of} group ${group}. Reason: ${reason}`])
    if (r.exitCode === 0) closed.push(p.number)
    else failed.push(`#${p.number} (${r.stderr.trim().slice(0, 120)})`)
  }
  const lost = new Set(log.filter(l => l.event === 'arm-lost' && l.id === group).map(l => l.branch))
  for (const b of loserBranches) if (!lost.has(b)) await io.appendLog({ event: 'arm-lost', owner: caller ?? 'main', id: group, branch: b, pr, text: `lost to PR #${pr}` })
  const live = await io.liveNames()
  const running = g.arms.filter(a => a !== win).map(a => armNameOfRows(g, a)).flatMap(n => live.filter(l => isArmAgent(l, n)))
  const lines = [
    `${prior === undefined ? 'Picked' : 'Already picked'} arm ${win.id} (PR #${pr}) for group ${group}. ${closed.length > 0 ? `Closed the other arms' PRs: ${closed.map(n => `#${n}`).join(', ')}.` : 'No other arm PR was open.'} Remote branches are kept.`,
    ...(failed.length > 0 ? [`Could not close: ${failed.join(', ')}. Close them by hand (gh pr close).`] : []),
    ...(running.length > 0 ? [`Still running: ${running.join(', ')}. Stop each with TaskStop (the plugin cannot), then call mcp__flow__clean.`] : ['No losing arm is running. Hand over only the winner, then call mcp__flow__clean.']),
    'Cost per arm so far:',
    ...costLine(g, { pr, branch: info.headRefName, reason }, mergedBranches(log)),
  ]
  return { result: lines.join('\n') }
}
