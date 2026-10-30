import type { EngineInterface } from 'claude-code'
import type { Breaker, Handover } from '../types'
import { MANAGER } from './core'
import { ENDED } from './deliver'
import { dueForPrompt, normalizeChecks } from './checks'
import type { Checks } from './checks'
import { normalizeDeploys } from './deploy'
import type { Deploys } from './deploy'
import { normalizeInbox } from './inbox'
import type { Inbox } from './inbox'
import { normalizeFamilies } from './state'
import type { Families } from './state'
import { normalizeLite } from './lite'
import type { LiteState } from './lite'
import { normalizePreflight } from './preflight'
import type { Preflight } from './preflight'
import { deployModeWarnings, fill, MANAGER_PROMPT, NO_REVIEWER_RULE, REVIEWER_PROMPT, REVIEWER_RULE, WORKER_PROMPT } from './prompts'
import { normalizePush } from './pushgate'
import type { PushState } from './pushgate'
import { normalizeBreaker } from './reviewer-breaker'
import { mergeLayers, settingsOf } from './settings'

// The body of the session.start hook and the settings loading it and its recheck timer use. The registration
// and the state of register() stay in register.tsx; this takes closures over them (the engine refuses `$`
// across an import).
type Settings = ReturnType<typeof settingsOf>
export type Merged = { settings: Settings; seen: string }
type AgentSpec = Parameters<EngineInterface['agent']['register']>[0]
type CommandSpec = Parameters<EngineInterface['command']['register']>[0]
export type StartupRelay = { role: 'worker' | 'manager' | 'reviewer'; name: string; dir: string | undefined }

export type StartupIo = {
  options: Record<string, unknown>
  pollMs: number
  prPollMs: number
  initHint: string
  best: (what: string, fn: () => Promise<void>) => Promise<void>
  run: (argv: string[], opts?: { timeoutMs?: number }) => Promise<{ exitCode: number; stdout: string }>
  toast: (text: string) => void
  every: (ms: number, fn: () => void) => void
  after: (ms: number, fn: () => void) => void
  now: () => Promise<number>
  // What this process is, from FLOW_ROLE; setRelay keeps it for the other hooks.
  relayMode: () => Promise<StartupRelay | undefined>
  setRelay: (r: StartupRelay | undefined) => void
  // The settings reload state and the one place that applies it.
  settings: () => Settings
  applySettings: (s: Settings) => void
  paths: () => string[]
  setPaths: (p: string[]) => void
  detected: () => string
  setDetected: (base: string) => void
  seen: () => string
  setSeen: (s: string) => void
  checking: () => boolean
  setChecking: (on: boolean) => void
  locate: () => Promise<string[]>
  readText: (path: string) => Promise<string | undefined>
  mtime: (path: string) => Promise<number>
  registerAgent: (spec: AgentSpec) => Promise<unknown>
  registerCommand: (spec: CommandSpec) => Promise<unknown>
  registerTools: () => Promise<void>
  // A claude worker's copy: the worker's tools only.
  registerWorkerTools: () => Promise<void>
  // The state loaders.
  resetDelivery: () => void
  resetStateDir: () => void
  readState: (file: string) => Promise<{ disk: unknown } | undefined>
  loadHandovers: () => Promise<Record<string, Handover>>
  mergeHandovers: (disk: Record<string, Handover>) => Promise<void>
  autoSweep: () => void
  setInbox: (disk: Inbox) => Promise<void>
  setBreaker: (disk: Breaker) => Promise<void>
  releaseHalt: () => Promise<void>
  installedVersion: () => Promise<string | undefined>
  installed: () => string | undefined
  setInstalled: (v: string | undefined) => void
  handovers: () => Promise<Record<string, Handover>>
  checks: () => Promise<Checks>
  setChecks: (disk: Checks) => Promise<void>
  captureChecks: (ho: Handover, verifyPaths: string[]) => Promise<unknown>
  markPrompted: (version: string | undefined) => Promise<void>
  setDeploys: (disk: Deploys) => Promise<void>
  deployKnown: (name: string) => boolean
  refreshBehind: () => void
  setPush: (disk: PushState) => Promise<void>
  setLite: (disk: LiteState) => Promise<void>
  setFamilies: (disk: Families) => Promise<void>
  mergeSessions: (raw: unknown) => Promise<void>
  snapshotSessions: () => Promise<void>
  adoptSessions: () => Promise<void>
  setPreflight: (disk: Preflight) => Promise<void>
  agents: () => Promise<{ type: string; status: string; name?: string }[]>
  closePreflight: (live: string[], t: number) => Promise<void>
  setSlotDir: (dir: string | undefined) => void
  sh: (script: string, arg: string) => Promise<unknown>
  // The timers and what they call.
  relaySessionCount: () => Promise<number>
  pump: () => void
  refresh: () => void
  watchSessions: () => void
  fetchPrs: () => void
  refreshLeftovers: () => void
  tickNow: () => Promise<void>
  startReviewer: () => Promise<void>
  clearDemo: () => Promise<void>
  firstRun: () => Promise<boolean>
}

// Cheap change check for the roster poll: both files' mtimes, "-" for a missing one.
async function signature(io: StartupIo, paths: string[]): Promise<string> {
  const parts = await Promise.all(paths.map(async p => {
    try {
      if (p === '') return '-'
      return String(await io.mtime(p))
    } catch {
      return '-'
    }
  }))
  return parts.join('|')
}

// Layer /config under the settings files. The caller assigns the result (register's `apply`).
async function loadSettings(io: StartupIo, paths: string[], base: string): Promise<Merged> {
  const seen = await signature(io, paths)
  const layers = await Promise.all(paths.map(async path => ({ path, text: await io.readText(path) })))
  const loaded = mergeLayers(io.options, layers)
  const warnings = [...loaded.warnings, ...deployModeWarnings(loaded.raw.deploy_targets)]
  if (warnings.length > 0) io.toast(`flow settings:\n${warnings.join('\n')}`)
  return { settings: settingsOf(loaded.raw, base), seen }
}

// The agent definitions carry the settings' prompts and models; a re-registered name is
// replaced from the next turn, so agents already running keep what they started with.
async function registerAgents(io: StartupIo, settings: Settings) {
  await io.registerAgent({
    name: 'manager',
    description: 'A flow manager: owns one task, writes briefs, starts flow:worker agents, reviews their PRs and hands them to the reviewer. ' +
      'Pass the task in the user\'s words as the prompt and a short task slug as the name; run it in the background.',
    prompt: fill(MANAGER_PROMPT.replace('{{REVIEWER_RULE}}', settings.useReviewer ? REVIEWER_RULE : NO_REVIEWER_RULE), settings),
    model: settings.managerModel,
    background: true,
  })
  await io.registerAgent({
    name: 'worker',
    description: 'A flow worker: implements one brief in a git worktree of its own and opens a PR. ' +
      'Pass the whole brief as the prompt, its first line "Your name: <slug>", and the slug as the name.',
    prompt: fill(WORKER_PROMPT, settings),
    model: settings.workerModel,
    isolation: 'worktree',
    background: true,
  })
  await io.registerAgent({
    name: 'continue',
    description: 'A flow worker that continues a handed-off branch in the same worktree. The plugin picks it when a flow:worker spawn says "Continue on branch:"; never start it yourself.',
    prompt: fill(WORKER_PROMPT, settings),
    model: settings.workerModel,
    background: true,
  })
  await io.registerAgent({
    name: 'reviewer',
    description: 'The flow reviewer. Started by the plugin when a PR is handed over; never start it yourself.',
    prompt: fill(REVIEWER_PROMPT, settings),
    model: settings.reviewerModel,
    isolation: 'worktree',
    background: true,
  })
  // The old agent type name, kept so a spawn or a resume under flow:queue still works.
  await io.registerAgent({
    name: 'queue',
    description: 'The old name of flow:reviewer. Never start it; the plugin starts flow:reviewer.',
    prompt: fill(REVIEWER_PROMPT, settings),
    model: settings.reviewerModel,
    isolation: 'worktree',
    background: true,
  })
}

// Re-read the settings when a file's mtime changed (the roster poll calls this): undefined when
// nothing changed or the reload failed, which never stops the roster refresh.
async function recheck(io: StartupIo): Promise<Merged | undefined> {
  try {
    if ((await signature(io, io.paths())) === io.seen()) return undefined
    const merged = await loadSettings(io, io.paths(), io.detected())
    await registerAgents(io, merged.settings)
    return merged
  } catch {
    return undefined
  }
}

// One state file: the loader runs only when there is a state dir; a failure is a warning, never a throw.
// The blocks differ too much in what they do with the file to be one table, so each keeps its own body.
async function loadState(io: StartupIo, what: string, file: string, apply: (disk: unknown) => Promise<void>): Promise<void> {
  await io.best(what, async () => {
    const got = await io.readState(file)
    if (got === undefined) return
    await apply(got.disk)
  })
}

// The body of the session.start hook, up to the `next(e)` that stays in register.tsx.
export async function startSession(io: StartupIo): Promise<void> {
  // First of all, what this process is: a terminal-started worker without a relay dir (started before workers
  // had one) is passive (no tools, no state, no timers: its copy must not wipe main's test-slot grants); a
  // manager, the reviewer or a worker with one relays to main.
  const relay = await io.relayMode()
  io.setRelay(relay)
  if (relay?.role === 'worker' && relay.dir === undefined) return
  if (relay !== undefined) {
    // A terminal claude's own copy: it holds no state and runs no timers. It reads the settings for its
    // local guards, shows the tools (a worker only its own) and the /flow stub, and forwards every flow tool
    // call to main (tool.call).
    try {
      const local = await io.run(['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
      if (local.exitCode === 0 && local.stdout.trim() !== '') io.setDetected(local.stdout.trim().replace(/^origin\//, ''))
    } catch {
      // Not a git repo, or no remote: keep "main".
    }
    io.setPaths(await io.locate())
    try {
      io.applySettings((await loadSettings(io, io.paths(), io.detected())).settings)
    } catch {
      // Keep the settings from /config alone.
    }
    await io.registerCommand({
      name: 'flow',
      description: 'The flow pane and commands live in the main Claude Code session: run /flow there. This session\'s mcp__flow__* tools are forwarded to it.',
    })
    await io.registerCommand({
      name: 'flow-tasks',
      description: 'Runs in the main Claude Code session: run /flow-tasks there.',
    })
    await (relay.role === 'worker' ? io.registerWorkerTools() : io.registerTools())
    return
  }
  io.resetDelivery()
  // Handovers a restart would lose: merge what is on disk under this session's own records.
  let queueDue = false
  await io.best('loading handovers', async () => {
    io.resetStateDir()
    const disk = await io.loadHandovers()
    if (Object.keys(disk).length === 0) return
    await io.mergeHandovers(disk)
    queueDue = Object.values(disk).some(ho => ho.status === 'pending')
  })
  // Manager families first: the inbox, lite and pre-flight records below are keyed by noteKey.
  await loadState(io, 'loading manager families', 'families.json', raw => io.setFamilies(normalizeFamilies(raw)))
  await loadState(io, 'loading the inbox', 'inbox.json', raw => io.setInbox(normalizeInbox(raw)))
  // A fresh session is a fresh attempt: the halt and the wait end, the failure history stays.
  await loadState(io, 'loading the reviewer breaker', 'reviewer-breaker.json', async raw => {
    await io.setBreaker(normalizeBreaker(raw))
    await io.releaseHalt()
  })
  await io.best('loading checks', async () => {
    io.setInstalled(await io.installedVersion())
    const got = await io.readState('checks.json')
    if (got === undefined) return
    await io.setChecks(normalizeChecks(got.disk))
    // Done handovers from before checks existed (or a session that died first) get theirs once.
    for (const ho of Object.values(await io.handovers())) {
      // A PR that already has a check (any state) runs no git calls on a normal restart.
      if (ho.status === 'done' && !(await io.checks()).items.some(c => c.pr === ho.pr)) await io.captureChecks(ho, io.settings().verifyPaths)
    }
    // Once per installed version: a toast names the checks it now covers. Not a prompt: an update
    // must not start a turn in main; the checks stay in /flow checks, the inbox and the pane.
    const installed = io.installed()
    const due = dueForPrompt(await io.checks(), installed)
    if (due.length === 0) return
    await io.markPrompted(installed)
    io.toast(`flow ${installed}: ${due.length} after-deploy check${due.length === 1 ? '' : 's'} can be done now. /flow checks lists them.`)
  })
  await loadState(io, 'loading deploy gates', 'deploys.json', async raw => {
    const disk = normalizeDeploys(raw)
    await io.setDeploys(disk)
    queueDue = queueDue || Object.entries(disk.targets).some(([name, t]) => t.due === true && io.deployKnown(name))
    io.refreshBehind()
  })
  await loadState(io, 'loading the push gate', 'push.json', async raw => {
    const disk = normalizePush(raw)
    await io.setPush(disk)
    // A released or rebuilding batch left by a session that ended gets its reviewer.
    queueDue = queueDue || (disk.batch !== undefined && disk.batch.state !== 'ready')
  })
  await loadState(io, 'loading lite managers', 'lite.json', raw => io.setLite(normalizeLite(raw)))
  // Terminal sessions from before a restart: their relay directories are pumped again.
  await loadState(io, 'loading sessions', 'sessions.json', async raw => {
    await io.mergeSessions(raw)
    await io.snapshotSessions()
    await io.adoptSessions()
  })
  await loadState(io, 'loading pre-flight', 'preflight.json', async raw => {
    await io.setPreflight(normalizePreflight(raw))
    // A round left undelivered by a session that ended is not sent now.
    const live = (await io.agents()).filter(a => a.type === MANAGER && !(ENDED as Set<string>).has(a.status) && a.name !== undefined).map(a => a.name!)
    await io.closePreflight(live, await io.now())
  })
  // The base branch: the option, else the remote's default branch, else main.
  // A fresh clone may have no origin/HEAD, so ask the remote when the local ref is missing.
  try {
    const local = await io.run(['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    let base = local.exitCode === 0 ? local.stdout.trim().replace(/^origin\//, '') : ''
    if (base === '') {
      const remote = await io.run(['git', 'ls-remote', '--symref', 'origin', 'HEAD'], { timeoutMs: 10_000 })
      base = /ref: refs\/heads\/(\S+)\s+HEAD/.exec(remote.stdout)?.[1] ?? ''
    }
    if (base !== '') io.setDetected(base)
  } catch {
    // Not a git repo, or no remote: keep "main".
  }
  io.setPaths(await io.locate())
  try {
    const merged = await loadSettings(io, io.paths(), io.detected())
    io.setSeen(merged.seen)
    io.applySettings(merged.settings)
  } catch {
    // Keep the settings from /config alone.
  }
  // Reviewer worktrees left over from before a restart or reload. Only now: the sessions loaded and
  // adopted above are what keeps a terminal reviewer's or worker's worktree from the sweep (swept
  // before, a resumed reviewer found its worktree gone, #222), and the settings say whether to sweep.
  io.autoSweep()

  // Grant files of a previous session would read as grants; start from an empty directory.
  try {
    const r = await io.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'])
    if (r.exitCode === 0 && r.stdout.trim() !== '') {
      const slotDir = `${r.stdout.trim()}/flow/test-slots`
      io.setSlotDir(slotDir)
      await io.sh('rm -rf "$1" && mkdir -p "$1"', slotDir)
    }
  } catch {
    io.setSlotDir(undefined)
  }

  await io.registerCommand({
    name: 'flow',
    description: 'Show the flow in a pane: managers, their workers, the reviewer and handed-over PRs. /flow inbox lists the open questions and the decisions agents made (/flow inbox decisions lists them all, /flow inbox <id> shows one in full), /flow ok keeps every open decision (/flow ok <id|owner|topic> takes those, or the default of a question), /flow no <id> [what instead] undoes a decision, /flow answer <id> <choice> answers any question addressed to main, /flow status shows what the agents cost (estimates at API list prices), /flow checks lists the after-deploy checks that need a person (pass or fail them), /flow preflight shows the current pre-flight round, /flow close closes it, /flow lite <task> runs one task as just a manager and its workers (no pre-flight, no reviewer agent) to save tokens, /flow resume picks up unfinished flow work, /flow approve <pr> lets the reviewer merge a PR that awaits your approval, /flow reject <pr> [reason] (alias /flow drop) turns down a handover that awaits approval or is pending, /flow push starts the push of the batch the reviewer checked and saved (push_mode confirm; /flow push back <pr> sends one PR back, /flow push drop returns them all), /flow hold <target> [batch|released] keeps a deploy target from deploying and /flow release <target> lets it, /flow clean lists leftover worktrees and branches (--yes removes them)',
    argumentHint: '[inbox [all|archive [all]|<id>]|ok [<id|owner|topic>...]|no <id> [what instead]|answer <id> <choice>|checks|status|preflight|close|lite <task>|resume|approve <pr>|reject <pr> [reason]|push [back <pr>|drop]|clean]',
  })
  await io.registerCommand({
    name: 'flow-tasks',
    description: 'Pick tasks from a task source (.claude/flow/sources/<name>.md) and start a manager for each',
    argumentHint: '[source] [ids or filter]',
  })
  await registerAgents(io, io.settings())

  await io.registerTools()

  // Calls the terminal managers, the reviewer and claude workers left in their relay directories (see pumpOnce).
  // The fast timer exists only while such a session does: armed here for sessions a restart brought back, and by the
  // roster poll below for ones started since. It never goes away; pumpOnce does nothing without a live one.
  let pumpArmed = false
  const armPump = async () => {
    if (pumpArmed || (await io.relaySessionCount()) === 0) return
    pumpArmed = true
    io.every(500, () => io.pump())
  }
  await armPump()
  io.every(io.pollMs, () => {
    void io.adoptSessions().then(armPump).catch(() => undefined)
    io.refresh()
    io.watchSessions()
    if (io.checking()) return
    io.setChecking(true)
    void recheck(io).then(m => {
      if (m !== undefined) { io.setSeen(m.seen); io.applySettings(m.settings) }
    }).finally(() => { io.setChecking(false) })
  })
  // gh is not free: a slow timer, one look shortly after the start, and status when the list is stale.
  io.every(io.prPollMs, () => { io.fetchPrs(); io.refreshBehind(); io.refreshLeftovers() })
  io.fetchPrs()
  io.refreshLeftovers()
  // One shared tick for every running time on the pane: the render reads `now`, no card has a timer.
  io.every(1000, () => void io.tickNow().catch(() => undefined))
  // The reviewer agent type exists only now, and a spawn needs the session bound: start it after the hook.
  if (queueDue) io.after(0, () => void io.best('starting the reviewer', io.startReviewer))
  // A replay left over from before a reload is gone with the atom's memory; this clears it explicitly.
  await io.clearDemo()
  // A new repo: one line pointing at /flow init, after the session has drawn.
  io.after(3000, () => void io.best('first-run hint', async () => { if (await io.firstRun()) io.toast(io.initHint) }))
}
