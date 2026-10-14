import type { AgentInfo } from 'claude-code'
import type { Activity, AgentRow, Session, TestSlots } from '../types'
import type { AgentFact } from './dag'
import { isReviewer, LIVE_STATUS, LOG_MAX, MANAGER, WORKER, WORKERS } from './core'
import { allowed, flowActive, killRefusal, mainCheckoutRefusal, mainRelative, parseWorktrees, remoteDeleteRefusal, resolvePath, writeTargets } from './guards'
import type { WriteTarget } from './guards'
import { guardReport, guardTestsFor, pathsFromStatus } from './guardtests'
import { limitLabel, windowOf, wrapUpText } from './meter'
import { describeCall, ROLE, summarizeCall } from './pane'
import { sessionLive } from './sessions'
import { findWorktree } from './state'
import { slotRefusal, suiteRun, typecheckRefusal, typecheckRun, workerSuiteRefusal } from './testguard'
import type { settingsOf } from './settings'

type Settings = ReturnType<typeof settingsOf>
type Call = { agentId?: string } & Record<string, unknown>
type Out = { result: unknown } | { deny: string }

// The bodies of the generic tool.call hook (the guards before the tool, the delivery hooks on
// SendMessage, the activity line, the wrap-up reminder after it) and guard_tests' body.
// The registrations stay in register.tsx; this takes closures over the atoms, the roster and the state
// of register() (the engine refuses `$` across an import).

export const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit']

export type GuardIo = {
  exec: (argv: string[], timeoutMs: number) => Promise<{ exitCode: number; stdout: string }>
  // The roster with the role sessions.
  allAgents: () => Promise<AgentInfo[]>
}

export type ToolCallIo = GuardIo & {
  // Read live: the settings are replaced when they reload.
  settings: () => Settings
  now: () => Promise<number>
  sessionCwd: () => Promise<string | undefined>
  agents: () => Promise<AgentInfo[]>
  refresh: () => Promise<AgentRow[]>
  testSlots: () => Promise<TestSlots>
  typecheckSlots: () => Promise<TestSlots>
  sessions: () => Promise<Record<string, Session>>
  seenAgents: () => Promise<Record<string, AgentFact>>
  activity: () => Promise<Record<string, Activity>>
  updateActivity: (fn: (acts: Record<string, Activity>) => Record<string, Activity>) => Promise<void>
  // Agent spawns whose effort the caller set explicitly (read by agent.spawn).
  explicitEffort: Set<string>
  wokenByOthers: Set<string>
  best: (what: string, fn: () => Promise<void>) => Promise<void>
  // The reviewer-send guard's refusal text, if it handles the message.
  reviewerSendGuard: (id: string, to: string, text: string) => Promise<string | undefined>
  alreadyForwarded: (id: string, text: string) => Promise<boolean>
  deliverToSession: (fromId: string | undefined, target: Session, text: string) => Promise<string>
  holdForReviewer: (id: string) => void
  mainModel: () => string | undefined
  mainWindow: () => number | undefined
}

// Why a call is refused as a write to the repo's main checkout, or undefined. `cwd` is where
// the caller's shell runs when that is known: the main session and managers run in the
// session's directory; a worker's or the reviewer's worktree isn't known here, so their relative
// paths are let through and only absolute ones judged.
// The main session (and a non-flow subagent of it) is guarded only while flow has work in this
// repo: a flow worktree, or a live flow agent. `flowCaller` says the caller is itself a flow
// agent, which is guarded regardless.
export async function mainCheckoutGuard(io: GuardIo, e: Record<string, unknown>, cwd: () => Promise<string | undefined>, allow: string[], flowCaller: () => Promise<boolean>): Promise<string | undefined> {
  let targets: WriteTarget[]
  if (WRITE_TOOLS.includes(String(e.tool))) {
    const file = e.file_path ?? e.notebook_path
    const path = typeof file === 'string' ? resolvePath(file, await cwd()) : undefined
    targets = path === undefined ? [] : [{ path }]
  } else if (e.tool === 'Bash' && typeof e.command === 'string') {
    targets = writeTargets(e.command, await cwd())
  } else {
    return undefined
  }
  if (targets.length === 0) return undefined
  // Asked on every judged write, so a worktree made a minute ago counts as one.
  // Not a git repo, or git failing: nothing to guard.
  const wt = await io.exec(['git', 'worktree', 'list', '--porcelain'], 10_000).catch(() => undefined)
  const co = wt?.exitCode === 0 ? parseWorktrees(wt.stdout) : undefined
  if (co === undefined) return undefined
  // Judged lazily: only a write into the main checkout needs the activity signal.
  let active: boolean | undefined
  const guarded = async () => active ??= (await flowCaller()) || flowActive(co) ||
    (await io.allAgents()).some(a => (a.type === MANAGER || WORKERS.has(a.type) || isReviewer(a.type)) && (LIVE_STATUS.has(a.status) || a.status === 'idle'))
  for (const t of targets) {
    const rel = mainRelative(t.path, co)
    if (rel === undefined) continue
    if (!(await guarded())) return undefined
    // A git command changes the whole checkout, whichever directory of it runs it.
    if (t.git) return mainCheckoutRefusal(co.main, `\`git\` in ${t.path}`, allow)
    if (!allowed(rel, allow)) return mainCheckoutRefusal(co.main, t.path, allow)
  }
  return undefined
}

// Everything the generic tool.call hook does before the tool runs: a refusal as { deny }, or undefined
// to let the call through (to `next`, then afterToolCall).
export async function beforeToolCall(io: ToolCallIo, e: Call & { tool: string }): Promise<{ deny: string } | undefined> {
  const settings = io.settings()
  const id = e.agentId
  if (e.tool === 'Agent' && e.effort !== undefined && e.effort !== null) io.explicitEffort.add(e.tool_use_id as string)
  if (e.tool === 'Bash') {
    const command = e.command as string
    const why = killRefusal(command)
    if (why !== undefined) return { deny: why }
    // A whole-suite run needs a held test slot. Slot state is read only when the command matches.
    const suite = suiteRun(command, settings.testSlotCommands ?? [])
    if (suite !== undefined) {
      const rows = await io.refresh()
      const worker = id !== undefined && WORKERS.has(rows.find(a => a.id === id)?.type ?? '')
      const refused = workerSuiteRefusal(worker, suite) ?? slotRefusal(await io.testSlots(), rows, id ?? 'main', settings.testSlots, await io.now(), suite)
      if (refused !== undefined) return { deny: refused }
    }
    const typecheck = typecheckRun(command, settings.typecheckCommands ?? [])
    if (typecheck !== undefined) {
      const refused = typecheckRefusal(await io.typecheckSlots(), await io.testSlots(), await io.refresh(), id ?? 'main', (settings.typecheckSlots ?? 1), await io.now(), typecheck)
      if (refused !== undefined) return { deny: refused }
    }
    // Merged branches are deleted by the plugin on the reviewer's "done"; a subagent never deletes a remote ref.
    const del = id === undefined ? undefined : remoteDeleteRefusal(command)
    if (del !== undefined) return { deny: del }
  }
  let me: AgentInfo | undefined
  const whoAmI = async () => (me ??= (await io.agents()).find(a => a.id === id))
  if (id !== undefined && WRITE_TOOLS.includes(e.tool) && (await whoAmI())?.type === MANAGER) {
    return { deny: 'flow: managers don\'t edit code. Put the change in a worker\'s brief, or send it to the worker that owns the file.' }
  }
  if (settings.mainGuard) {
    const cwd = async () => (id === undefined || (await whoAmI())?.type === MANAGER ? io.sessionCwd() : undefined)
    const flowCaller = async () => {
      const type = id === undefined ? undefined : (await whoAmI())?.type
      return type !== undefined && (type === MANAGER || WORKERS.has(type) || isReviewer(type))
    }
    const why = await mainCheckoutGuard(io, e, cwd, settings.mainAllow, flowCaller)
    if (why !== undefined) return { deny: why }
  }
  if (e.tool === 'SendMessage') {
    const input = e
    const to = String(input.to ?? '')
    const text = String(input.message ?? input.text ?? '')
    // A worker session is not on the roster (a role session is, through agentsOf, so the guard below sees it).
    const named = (await io.sessions())[to.replace(/^session:/, '')]
    const inRoster = async () => (await io.agents()).some(a => a.name === to)
    if (named !== undefined && sessionLive(named) && named.role === undefined && !(await inRoster())) {
      return { deny: await io.deliverToSession(id, named, text) }
    }
    if (id !== undefined && isReviewer((await whoAmI())?.type ?? '')) {
      let handled: string | undefined
      await io.best('routing a reviewer message', async () => { handled = await io.reviewerSendGuard(id, to, text) })
      // A built-in tool's output must be an object; a string result is refused by the host as
      // "SendMessage output is not an object". deny carries the same "Not sent" text to the reviewer.
      if (handled !== undefined) return { deny: handled }
      // Lines the guard already sent main need no second copy; anything new goes through.
      if (to === 'main' && await io.alreadyForwarded(id, text)) {
        return { deny: 'Not sent: main already has this report (the plugin forwarded it). Do not repeat it.' }
      }
    }
    if (named !== undefined && sessionLive(named) && !(await inRoster())) return { deny: await io.deliverToSession(id, named, text) }
    await io.best('marking a wake-up', async () => {
      const listed = (await io.agents()).find(a => a.id === to || a.name === to)
      // A manager the host dropped from the roster is held by the id last seen for it.
      const seenId = listed === undefined ? (await io.seenAgents())[to]?.id : undefined
      const target = listed ?? (seenId === undefined ? undefined : { id: seenId, type: MANAGER, status: 'completed' })
      if (target === undefined || target.type !== MANAGER) return
      // The reviewer's message starts the manager's turn: what waited for it rides that turn (turn.step
      // flushes it) instead of waking the manager a second time just before. A timer covers a message that never lands.
      if (id !== undefined && isReviewer((await whoAmI())?.type ?? '')) io.holdForReviewer(target.id)
      if (id === undefined) io.wokenByOthers.delete(target.id)
      else if (target.status !== 'running') io.wokenByOthers.add(target.id)
    })
  }
  if (id !== undefined) {
    const t = await io.now()
    const line = describeCall(e)
    await io.updateActivity(acts => {
      const a = acts[id] ?? { startedAt: t, lastAt: t, log: [] }
      return { ...acts, [id]: { ...a, lastAt: t, doing: summarizeCall(e), log: [...a.log, line].slice(-LOG_MAX) } }
    })
  }
  return undefined
}

// An agent past the threshold reads the wrap-up after a tool result: on its first tool call
// past it, every 10th after, and when usage rises another 10 points. The result passes untouched.
export async function afterToolCall(io: ToolCallIo, e: { agentId?: string }, r: any): Promise<any> {
  const settings = io.settings()
  try {
    const id = e.agentId
    if (id === undefined || !settings.handoff || r.deny !== undefined) return r
    const a = (await io.activity())[id]
    if (a?.handoffNotifiedAt === undefined || a.usage === undefined) return r
    const window = a.usage.window ?? windowOf(a.usage.model, io.mainModel(), io.mainWindow(), a.usage.tokens, a.spawnWindow)
    const percent = Math.min(100, Math.round(a.usage.tokens / window * 100))
    const calls = (a.callsPastLimit ?? 0) + 1
    const due = calls === 1 || calls % 10 === 0 || percent >= (a.remindedPercent ?? a.handoffPercent ?? percent) + 10
    await io.updateActivity(acts => {
      const cur = acts[id]
      if (cur === undefined) return acts
      const n = (cur.callsPastLimit ?? 0) + 1
      return { ...acts, [id]: { ...cur, callsPastLimit: n, ...(due ? { remindersSent: (cur.remindersSent ?? 0) + 1, remindedPercent: percent } : {}) } }
    })
    if (!due) return r
    const me = (await io.agents()).find(x => x.id === id)
    return { ...r, context: [...(r.context ?? []), wrapUpText(ROLE[me?.type ?? WORKER] ?? 'worker', percent, limitLabel(settings, window))] }
  } catch {
    return r
  }
}

// --- guard_tests' body (its hook and runFlowTool's relayed case stay in register.tsx) ---------------------

// Its io is written as an object literal in the hook and in the case, holding only what it uses, each member a plain
// $.noun.method(...) or one call passing $. Note, clean, session, deploy and push had case bodies here too, reached
// through case-io closures that took `$` deeper than 0.6.84 did (the plugin directory flagged the note case's,
// 0.6.116 and 0.6.117); their bodies are written in their hooks and cases now, as 0.6.84 wrote them (plain-names check 13).
export type GuardTestsCaseIo = {
  // The terminal sessions on record, by name.
  sessions: () => Promise<Record<string, Session>>
  agents: () => Promise<AgentInfo[]>
  exec: (argv: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  cwd: () => Promise<string | undefined>
}

export async function guardTestsCase(io: GuardTestsCaseIo, base: string, map: Parameters<typeof guardTestsFor>[1], e: Call): Promise<Out> {
  const input = e
  if (Object.keys(map).length === 0) return { result: guardReport([], false) }
  let files: string[]
  if (Array.isArray(input.files)) files = input.files.filter((f): f is string => typeof f === 'string')
  else {
    // The caller's own worktree, else the session's directory.
    let dir: string | undefined
    // A relayed call (`session:<name>`) diffs that session's worktree; the lookup is here, not in register.tsx,
    // because the plugin directory flagged a `$` helper returning `s?.worktree` (MOD_CAPABILITY_USE_NOT_PLAIN).
    let mine: string | undefined
    if (e.agentId !== undefined && e.agentId.startsWith('session:')) {
      const all = await io.sessions()
      const named = all[e.agentId.slice('session:'.length)]
      if (named !== undefined) mine = named.worktree
    }
    if (mine !== undefined) dir = mine
    else if (e.agentId !== undefined) {
      const me = (await io.agents()).find(a => a.id === e.agentId)
      const wt = await io.exec(['git', 'worktree', 'list', '--porcelain']).catch(() => undefined)
      if (me !== undefined && wt?.exitCode === 0) dir = findWorktree(wt.stdout, me.id, `flow/${me.name ?? me.id}`)?.path
    }
    dir ??= await io.cwd().catch(() => undefined)
    const git = (...args: string[]) => io.exec(['git', ...(dir === undefined ? [] : ['-C', dir]), ...args])
    const diff = await git('diff', '--name-only', '--no-renames', `origin/${base}...HEAD`)
    if (diff.exitCode !== 0) return { result: `Could not work out your diff (git diff origin/${base}...HEAD failed: ${diff.stderr.trim().slice(0, 300)}). Call again with files: [...].` }
    const dirty = await git('status', '--porcelain', '--untracked-files=all')
    files = [...diff.stdout.split('\n').map(l => l.trim()).filter(Boolean), ...(dirty.exitCode === 0 ? pathsFromStatus(dirty.stdout) : [])]
  }
  return { result: guardReport(guardTestsFor(files, map), true) }
}
