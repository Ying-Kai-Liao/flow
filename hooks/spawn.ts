// Spawn routing, moved out of register.tsx: the attachment check, the continue rewrite, the worker and manager
// model routing with their size decisions, the Fable refusal and the [1m] helpers. Everything that touches the
// engine goes through SpawnIo, built by spawnIoOf in register.tsx (the engine refuses `$` across an import).
import type { AgentInfo, AgentSpawnInput } from 'claude-code'
import type { HandoffRecord, LogEvent, Ledger } from '../types'
import { absolutePath, parseAttachments, rewriteAttachments } from './attachments'
import { dirtyFiles, isLive } from './clean'
import { baseName } from './cost'
import { addQuestions, fyiAsked, isFyi } from './inbox'
import type { Question } from './inbox'
import { effectiveSize, floorFrom, generation, isSuccessorName, managerDecision, managerModelFor, MANAGER_FYI_WHY, modelFor, parseSize } from './routing'
import type { Size, SizeModels } from './routing'
import { isFable } from './settings'
import { autoAnswer, loadRules, recordAutoAnswers } from './standing-run'
import type { AutoHits, StandingIo } from './standing-run'
import { findWorktree } from './state'
import { CONTINUE, MANAGER, QUEUE, REVIEWER } from './core'

export type SpawnIo = {
  run: (argv: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  cwd: () => Promise<string>
  agents: () => Promise<AgentInfo[]>
  readFile: (path: string) => Promise<string>
  handoffs: () => Promise<Record<string, HandoffRecord>>
  updateHandoffs: (fn: (hs: Record<string, HandoffRecord>) => Record<string, HandoffRecord>) => Promise<unknown>
  ownerName: (id: string | undefined) => Promise<string>
  readLog: () => Promise<LogEvent[]>
  appendLog: (event: Omit<LogEvent, 'ts'>) => Promise<void>
  warn: (what: string, err: unknown) => Promise<void>
  loadLedger: () => Promise<void>
  ledger: () => Promise<Ledger>
  standing: StandingIo
}

export const FLOW_TYPES = new Set(['flow:manager', 'flow:worker', CONTINUE, REVIEWER, QUEUE])

const DIGEST_MAX = 4000
export const CONTINUE_LINE = /^Continue on branch:\s*(flow\/\S+)\s*$/m

const gitOut = async (io: SpawnIo, argv: string[]): Promise<string | undefined> => {
  const r = await io.run(['git', ...argv])
  return r.exitCode === 0 ? r.stdout.trim() : undefined
}

// The brief's attachments, checked: each must be a readable file. Returns the prompt with the paths made
// absolute, or the denial naming every bad path. A prompt without the section is returned as it was.
export async function checkAttachments(io: SpawnIo, prompt: string): Promise<{ prompt: string } | { deny: string }> {
  const items = parseAttachments(prompt)
  if (items.length === 0) return { prompt }
  const cwd = (await io.cwd().catch(() => undefined)) ?? ''
  const home = items.some(i => i.path.startsWith('~'))
    ? (await io.run(['sh', '-c', 'printf %s "$HOME"'])).stdout.trim()
    : ''
  const ok = async (flag: string, path: string) => (await io.run(['test', flag, path])).exitCode === 0
  const bad: string[] = []
  const seen = new Set<string>()
  for (const { path } of items) {
    const abs = absolutePath(path, cwd, home)
    if (seen.has(abs)) continue
    seen.add(abs)
    if (await ok('-d', abs)) bad.push(`${abs} (a directory: list the files in it)`)
    else if (!(await ok('-f', abs))) bad.push(`${abs} (does not exist)`)
    else if (!(await ok('-r', abs))) bad.push(`${abs} (not readable)`)
  }
  if (bad.length > 0) {
    return { deny: `flow: the brief's Attachments must be readable files. Fix or drop:\n${bad.map(b => `- ${b}`).join('\n')}` }
  }
  return { prompt: rewriteAttachments(prompt, items, p => absolutePath(p, cwd, home)) }
}

// A continuing worker's spawn: add the previous worker's digest, then either run it in the old worktree
// (rewritten to flow:continue with that cwd) or in a new one, removing the old one when that is safe.
// Best-effort: anything that fails leaves the spawn as the manager wrote it.
export async function prepareContinue(io: SpawnIo, e: AgentSpawnInput): Promise<AgentSpawnInput> {
  const branch = CONTINUE_LINE.exec(e.prompt)?.[1]
  if (branch === undefined) return e
  const name = (e as { name?: string }).name ?? e.description
  try {
    const owner = await io.ownerName(e.parentAgentId)
    let rec = (await io.handoffs())[branch]
    if (rec === undefined) {
      const ev = (await io.readLog()).filter(l => l.event === 'handoff' && l.branch === branch).pop()
      if (ev !== undefined) {
        const wl = await gitOut(io, ['worktree', 'list', '--porcelain'])
        const wt = wl === undefined ? undefined : findWorktree(wl, '', branch)
        rec = {
          branch, agent: ev.agent ?? '', agentId: '', owner: ev.owner, at: 0, count: 1,
          ...(ev.text && { digestPath: ev.text }), ...(wt && { worktree: wt.path }),
        }
      }
    }
    // No handoff on record: a manual continuation, spawned as written.
    if (rec === undefined) return e
    const old = rec
    let prompt = e.prompt
    if (old.digestPath) {
      const digest = await io.readFile(old.digestPath).catch(() => undefined)
      if (digest) prompt += `\n\n## Transcript digest of the previous worker (${old.digestPath})\n\n${digest.slice(0, DIGEST_MAX)}`
    }
    let where = 'new worktree'
    let out: AgentSpawnInput = e
    const path = old.worktree
    if (path !== undefined && (await io.run(['test', '-d', path])).exitCode === 0) {
      const live = (await io.agents()).some(a =>
        (old.agentId !== '' ? a.id === old.agentId : a.name === old.agent) && isLive(a.status))
      const status = await gitOut(io, ['-C', path, 'status', '--porcelain'])
      const clean = status !== undefined && dirtyFiles(status).length === 0
      await io.run(['git', 'fetch', 'origin', branch])
      const pushed = await gitOut(io, ['rev-parse', `origin/${branch}`])
      const head = clean ? await gitOut(io, ['-C', path, 'rev-parse', 'HEAD']) : undefined
      let won = false
      if (clean && !live && pushed !== undefined && head === pushed) {
        // Claimed in the same update, so a second spawn for the branch does not get the worktree too.
        await io.updateHandoffs(hs => {
          const r = hs[branch] ?? old
          if (r.takenBy !== undefined) return hs
          won = true
          return { ...hs, [branch]: { ...r, takenBy: name } }
        })
      }
      if (won && pushed !== undefined) {
        where = `same worktree ${path}`
        prompt += `\n\nYou continue in the same worktree ${path}, on ${branch} at ${pushed.slice(0, 7)}: skip the branch checkout, check \`git status\` is clean, and go on.`
        out = { ...e, subagentType: CONTINUE, cwd: path }
      } else {
        // Clean and fully pushed (at the head or behind it) and nobody uses it: the successor needs the branch free.
        const behind = clean && pushed !== undefined
          && (await io.run(['git', '-C', path, 'merge-base', '--is-ancestor', 'HEAD', `origin/${branch}`])).exitCode === 0
        const removable = behind && !live && old.takenBy === undefined
        if (!(removable && (await gitOut(io, ['worktree', 'remove', path])) !== undefined)) {
          prompt += `\n\nThe previous worker's worktree ${path} is kept, and ${branch} may be checked out there: if \`git checkout -B\` fails, work on a local branch and push \`HEAD:${branch}\`.`
        }
      }
    }
    await io.appendLog({ event: 'continue', agent: name, owner, branch, text: where })
    return { ...out, prompt }
  } catch (err) {
    await io.warn('preparing a continuation', err)
    return e
  }
}

// How many rewritten flow:continue spawns are in the host's hands: the agent.offer hook offers the type then.
let continuing = 0
export const continuingCount = (): number => continuing
// Dispatches a spawn; a flow:continue one counts while it runs and a refusal comes back as a deny.
export async function dispatch<R>(next: (ev: AgentSpawnInput) => Promise<R>, ev: AgentSpawnInput): Promise<R | { deny: string }> {
  if (ev.subagentType !== CONTINUE) return next(ev)
  continuing++
  try {
    return await next(ev)
  } catch (err) {
    return { deny: String((err as Error).message) }
  } finally {
    continuing--
  }
}

// Model routing: a worker brief's `Size:` line picks the model; a successor (`x-2`, or a brief that continues a
// branch) runs at least one size up from the largest size recorded for its predecessors. No size and no
// escalation leaves the spawn as the manager wrote it.
export type Routed = { size: Size; reason: string; model: string; escalated: boolean }

export async function routeWorker(io: SpawnIo, e: AgentSpawnInput, models: SizeModels): Promise<{ e: AgentSpawnInput; routed?: Routed }> {
  const declared = parseSize(e.prompt)
  const name = (e as { name?: string }).name ?? e.description
  const branch = CONTINUE_LINE.exec(e.prompt)?.[1]
  let floor: Size | undefined
  if (isSuccessorName(name) || branch !== undefined) {
    await io.loadLedger()
    const gen = generation(name)
    const before = Object.values(await io.ledger()).filter(x => x.role === 'worker' && x.name !== name
      && ((baseName(x.name) === baseName(name) && generation(x.name) < gen) || (branch !== undefined && x.branch === branch)))
    floor = floorFrom(before.map(x => x.size))
  }
  const size = effectiveSize(declared?.size, floor)
  if (size === undefined) return { e }
  const model = modelFor(size, models)
  return { e: { ...e, model }, routed: { size, reason: declared?.reason ?? '', model, escalated: declared === undefined || declared.size !== size } }
}

// The downgrade decision: below large the user can undo the manager's size. Filed by the plugin, owned by the
// spawning manager and addressed to main like the manager's own decisions; a standing rule can keep or undo it.
// A decision for the same worker is never filed twice.
export async function fileSizeFyi(io: SpawnIo, options: Record<string, unknown>, name: string, parentId: string | undefined, routed: Routed): Promise<void> {
  if (routed.size === 'large' || parentId === undefined) return
  const parent = (await io.agents()).find(a => a.id === parentId)
  if (parent === undefined || parent.type !== MANAGER || parent.name === undefined) return
  const owner = parent.name
  const decision = `${name} runs ${routed.size} -> ${routed.model}${routed.escalated ? ' (one size up after an earlier worker on this package)' : ''}: ${routed.reason === '' ? 'no reason given' : routed.reason}`
  const at = await io.standing.now()
  const { rules } = await loadRules(io.standing, options)
  const { added, auto } = await io.standing.withInbox(cur => {
    if (cur.items.some(x => x.owner === owner && isFyi(x) && x.topic === 'worker-size' && x.question.startsWith(`${name} runs `))) {
      return { inbox: cur, out: { added: [] as Array<{ q: Question }>, auto: new Map() as AutoHits } }
    }
    const asked = fyiAsked({ decision, why: 'The plugin routes the worker model by the size on its brief; below large a harder package may need a rerun. Undo it to restart the worker at the size you choose.', topic: 'worker-size' })
    const r = autoAnswer(cur, addQuestions(cur, { name: owner, id: parentId, isManager: true }, 'main', [asked], at, 'fyi'), rules, at)
    return { inbox: r.inbox, out: { added: r.added, auto: r.hits } }
  })
  await recordAutoAnswers(io.standing, added, auto, owner)
}

// A manager's model by the Size line main put on its prompt; a successor (`x-2`) runs one size up from the largest
// size recorded for its predecessors. No size and no floor leaves the spawn alone.
export async function routeManager(io: SpawnIo, e: AgentSpawnInput, small: string, base: string): Promise<{ e: AgentSpawnInput; routed?: Routed }> {
  const declared = parseSize(e.prompt)
  const name = (e as { name?: string }).name ?? e.description
  let floor: Size | undefined
  if (isSuccessorName(name)) {
    await io.loadLedger()
    const gen = generation(name)
    const before = Object.values(await io.ledger()).filter(x => x.role === 'manager' && baseName(x.name) === baseName(name) && generation(x.name) < gen)
    floor = floorFrom(before.map(x => x.size))
  }
  const size = effectiveSize(declared?.size, floor)
  if (size === undefined) return { e }
  const model = managerModelFor(size, small, base)
  return { e: { ...e, model }, routed: { size, reason: declared?.reason ?? '', model, escalated: declared === undefined || declared.size !== size } }
}

// The manager's own downgrade decision: owned by the manager (so an overturn messages it), addressed to main.
// Filed once per manager name.
export async function fileManagerSizeFyi(io: SpawnIo, options: Record<string, unknown>, name: string, id: string, routed: Routed): Promise<void> {
  if (routed.size === 'large') return
  const at = await io.standing.now()
  const { rules } = await loadRules(io.standing, options)
  const { added, auto } = await io.standing.withInbox(cur => {
    if (cur.items.some(x => x.owner === name && isFyi(x) && x.topic === 'manager-size' && x.question.startsWith(`${name} runs `))) {
      return { inbox: cur, out: { added: [] as Array<{ q: Question }>, auto: new Map() as AutoHits } }
    }
    const asked = fyiAsked({ decision: managerDecision(name, routed.size, routed.model, routed.reason, routed.escalated), why: MANAGER_FYI_WHY.replace('<name>', name), topic: 'manager-size' })
    const r = autoAnswer(cur, addQuestions(cur, { name, id, isManager: true }, 'main', [asked], at, 'fyi'), rules, at)
    return { inbox: r.inbox, out: { added: r.added, auto: r.hits } }
  })
  await recordAutoAnswers(io.standing, added, auto, name)
}

export const FABLE_DENY = "flow: sub-agents don't run on Fable; use sonnet or opus (set worker_model / manager_model / reviewer_model)."

// Fable is refused for a flow agent and for anything a flow agent starts.
export async function fableDenied(io: SpawnIo, e: { model?: string; subagentType: string; parentAgentId?: string }): Promise<boolean> {
  if (!isFable(e.model)) return false
  if (FLOW_TYPES.has(e.subagentType)) return true
  if (e.parentAgentId === undefined) return false
  const parent = (await io.agents()).find(a => a.id === e.parentAgentId)
  return parent !== undefined && FLOW_TYPES.has(parent.type)
}

// A refusal of a long-context model: a deny, or an error that names the model or its context.
export function refusedLong(r: unknown): boolean {
  const text = r instanceof Error ? r.message : typeof r === 'object' && r !== null && 'deny' in r ? String((r as { deny: unknown }).deny) : ''
  return /model|1m|context/i.test(text)
}
export const withoutLong = (model: string): string => model.replace('[1m]', '')
