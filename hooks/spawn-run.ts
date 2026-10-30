// The agent.spawn hook's body, moved out of register.tsx: the checks (plan, pre-flight, attachments, Fable, arm),
// the model and effort routing, the [1m] retry, the continue fallback and the bookkeeping after a started agent.
// The routing pieces live in spawn.ts; this is the hook-side code. It reaches the engine only through SpawnHookIo,
// built in the agent.spawn hook in register.tsx (the engine refuses `$` across an import); the mutable state
// (noLong, noContinue, the effort maps) stays single in register.tsx behind these getters and setters.
import type { AgentInfo, AgentSpawnInput } from 'claude-code'
import type { Activity, Ledger, Role, Session } from '../types'
import { armOfSpawn, checkAndReserve, groupUsed, parseArm } from './bestof'
import { baseName, setIdentity } from './cost'
import { CONTINUE, isReviewer, MANAGER, mirror, WORKER } from './core'
import { LIVE } from './deliver'
import { isManagerOf, planOwner } from './roster-run'
import type { Plan } from './dag'
import { isLiteName, recordLite, withLiteRules } from './lite'
import type { LiteState } from './lite'
import { isLite, isSkip, onRoster, recordSpawn } from './preflight'
import type { Preflight } from './preflight'
import { fill, LITE_MARK, LITE_RULES, MANAGER_PROMPT, MANAGER_SESSION_RULES, NO_REVIEWER_RULE, REVIEWER_RULE } from './prompts'
import { effortFor, generation } from './routing'
import type { EffortRole } from './routing'
import { ROLE } from './pane'
import { sessionKey, sessionLive } from './sessions'
import { recordFamily } from './state'
import type { Families } from './state'
import { sizeArmOf, sizerFor } from './size-ab'
import type { SizeArm } from './size-ab'
import type { RoleStart, SessionSettings } from './session-run'
import {
  checkAttachments, CONTINUE_LINE, dispatch, fableDenied, FABLE_DENY, fileManagerSizeFyi, fileSizeFyi, FLOW_TYPES, prepareContinue,
  refusedLong, routeManager, routeWorker, withSizeFeedback, withoutLong,
} from './spawn'
import type { Routed, SizeJev, SpawnIo } from './spawn'
import { LARGE_WINDOW } from './meter'
import type { settingsOf } from './settings'

type Settings = ReturnType<typeof settingsOf>

export type SpawnHookIo = {
  spawn: SpawnIo
  // Engine reads and writes the hook needs, one closure each (register.tsx owns the atoms).
  relay: () => { role: 'worker' | 'manager' | 'reviewer'; name: string; dir: string | undefined } | undefined
  settings: () => Settings
  options: () => Record<string, unknown>
  now: () => Promise<number>
  agentList: () => Promise<AgentInfo[]>
  plans: () => Promise<Plan>
  lite: () => Promise<LiteState>
  // The refusal text of the pre-flight gate; undefined when the manager may start workers.
  gate: (agentId: string | undefined) => Promise<string | undefined>
  jev: () => SizeJev | undefined
  // CLAUDE_CODE_EFFORT_LEVEL of main's environment; a failed read is unset.
  effortEnv: () => Promise<string | undefined>
  toast: (text: string) => unknown
  best: (what: string, fn: () => Promise<void>) => Promise<void>
  refresh: () => Promise<unknown>
  openPane: () => Promise<unknown>
  updateActivity: (fn: (acts: Record<string, Activity>) => Record<string, Activity>) => Promise<unknown>
  changeLedger: (fn: (l: Ledger, now: number) => Ledger) => Promise<void>
  withLite: <T>(fn: (cur: LiteState) => { state: LiteState; out: T }) => Promise<T>
  withPreflight: <T>(fn: (cur: Preflight) => { state: Preflight; out: T }) => Promise<T>
  withFamilies: (fn: (cur: Families) => Families) => Promise<void>
  after: (ms: number, fn: () => void) => void
  sessions: () => Promise<Record<string, Session>>
  // The settings when flow runs in a terminal mode (orca or tmux), undefined in agent mode, and the start of a terminal session.
  terminalSettings: () => Settings | undefined
  startRoleSession: (p: RoleStart, s: SessionSettings) => ReturnType<typeof import('./session-run').startRoleSession>
  // State that register() keeps single: the [1m] and in-place continue refusals, and the effort maps turn.step also reads.
  noLong: () => boolean
  setNoLong: () => void
  noContinue: () => boolean
  setNoContinue: () => void
  takeExplicit: (toolUseId: string) => boolean
  setEffort: (agentId: string, effort: string) => void
}

// The arm-spawn refusal (hooks/bestof.ts) for a worker spawn, or a reservation of its slot under max_workers. The roster
// read is the only await between the count and the reservation. A spawn with no Arm line is never checked.
async function armSpawnCheck(io: SpawnHookIo, e: AgentSpawnInput, settings: Settings): Promise<{ deny: string } | { release: () => void }> {
  const arm = parseArm(e.prompt)
  if (arm === undefined) return { release: () => undefined }
  const name = (e as { name?: string }).name ?? e.description
  await io.spawn.loadLedger()
  const [l, log, now, rows] = await Promise.all([io.spawn.ledger(), io.spawn.readLog(), io.now(), io.spawn.agents()])
  const parent = e.parentAgentId === undefined ? undefined : rows.find(a => a.id === e.parentAgentId)
  const group = /^(.+)-[a-c](-\d+)?$/.exec(name)?.[1]
  return checkAndReserve({
    name, prompt: e.prompt, bestOfN: settings.bestOfN, arms: settings.bestOfNArms,
    parentIsManager: parent?.type === MANAGER, maxWorkers: settings.maxWorkers,
    // Working now: an idle worker (turn over) and the spawn's own predecessors (a HANDOFF arm a before a-2) do not count.
    liveSiblings: rows.filter(a => a.parentId === e.parentAgentId && (a.type === WORKER || a.type === CONTINUE) && LIVE.has(a.status) && (a.name === undefined || baseName(a.name) !== baseName(name))).map(a => a.name ?? a.id),
    groupUsed: group !== undefined && groupUsed(l, log, group, arm.id),
  }, e.parentAgentId, now)
}

// main's flow:manager spawn as a terminal session (mode orca or tmux), after the model routing. Undefined: the
// agent starts as usual (agent mode); a terminal that cannot start is a refusal, not an agent. The bookkeeping an in-process manager gets (pre-flight record, lite record, size
// decision) is done here; the session's own start logs the spawn and opens its activity card.
async function startManagerSession(io: SpawnHookIo, e: AgentSpawnInput, ctx: { routed: Routed | undefined; liteMode: boolean }): Promise<{ deny: string } | undefined> {
  const settings = io.terminalSettings()
  if (settings === undefined) return undefined
  const name = (e as { name?: string }).name ?? e.description
  // The same manager asked for twice: it is running, so the answer is the same success, not a second manager.
  const live = (await io.sessions())[name]
  if (live !== undefined && live.role === 'manager' && sessionLive(live)) {
    return { deny: `flow: manager ${name} already runs in ${live.host} (${live.handle}) as a terminal session. This is not an error: do not spawn it again. Its reports arrive as messages from it.` }
  }
  const model = e.model ?? settings.managerModel
  // A terminal manager has no Agent tool, so it cannot start arms: no best-of-N text for it.
  const rules = fill(MANAGER_PROMPT.replace('{{REVIEWER_RULE}}', settings.useReviewer ? REVIEWER_RULE : NO_REVIEWER_RULE), { ...settings, bestOfN: 'off' })
  const managerEffort = effortFor('manager', undefined, settings, await io.effortEnv())
  const r = await io.startRoleSession({
    role: 'manager', name, owner: { id: 'main', name: 'main' },
    ...(typeof model === 'string' && { model }),
    ...(managerEffort !== undefined && { effort: managerEffort }),
    prompt: `${MANAGER_SESSION_RULES}${rules}\n\n${e.prompt}`,
  }, settings)
  if (!r.ok) {
    void io.toast(`flow: could not start manager ${name} in a terminal (${r.text})`)
    return { deny: `flow: could not start manager ${name} in a terminal: ${r.text}` }
  }
  const id = sessionKey(name)
  if (mirror.preflightOn) await io.best('recording a pre-flight', () => recordManager(io, name, e.prompt, ctx.liteMode))
  await io.best('recording an agent in the cost ledger', () => io.changeLedger((l, now) => setIdentity(l, id, {
    role: 'manager', name,
    ...(typeof model === 'string' && { spawnModel: model }),
    ...(ctx.routed !== undefined && { size: ctx.routed.size }),
  }, now)))
  if (ctx.liteMode) await io.best('recording a lite manager', async () => { const at = await io.now(); await io.withLite(cur => ({ state: recordLite(cur, name, at), out: undefined })) })
  if (ctx.routed !== undefined && !ctx.liteMode) {
    const routed = ctx.routed
    await io.best('filing a manager-size decision', () => fileManagerSizeFyi(io.spawn, io.options(), name, id, routed))
  }
  return { deny: `flow: started manager ${name} in ${r.session.host} (${r.session.handle}); it runs as a terminal session. This is not an error: do not spawn it again. Its reports arrive as messages from it.` }
}

// A manager main just started joins the open round, or opens one with a timer for the wait. A lite one is skipped;
// one already on the roster (again: main's message resumed it) keeps what it filed.
async function recordManager(io: SpawnHookIo, name: string, prompt: string, liteMode: boolean, again = false): Promise<void> {
  const t = await io.now()
  const opened = await io.withPreflight(cur => {
    const changed = recordSpawn(cur, name, isSkip(prompt) || liteMode, t, mirror.preflightWaitMs, again)
    return { state: changed, out: changed.rounds.length > cur.rounds.length }
  })
  if (opened) io.after(mirror.preflightWaitMs, () => void io.refresh().catch(() => undefined))
}

// What the roster, the terminal sessions and the cost ledger say about a manager name, for its family.
async function recordFamilyOf(io: SpawnHookIo, name: string): Promise<void> {
  const rows = (await io.agentList()).filter(a => a.type === MANAGER && a.name !== undefined)
  const sessions = await io.sessions()
  const session = (n: string) => (sessions[n]?.role === 'manager' ? sessions[n] : undefined)
  await io.spawn.loadLedger()
  const ledger = Object.values(await io.spawn.ledger())
  const listed = (n: string) => rows.some(a => a.name === n) || session(n) !== undefined
  await io.withFamilies(cur => recordFamily(cur, name, {
    listed,
    seen: n => listed(n) || ledger.some(x => x.role === 'manager' && x.name === n),
  }))
}

// What a started agent leaves behind: its activity card and effort, its cost-ledger row, a lite record, a size
// decision, a manager's pre-flight and the spawn log line.
type Start = {
  used: unknown
  model: string | undefined
  targetEffort: string | undefined
  routed: Routed | undefined
  sizeFed: boolean
  sizeArm: SizeArm | undefined
  arm: ReturnType<typeof armOfSpawn>
  liteMode: boolean
  again: boolean
}
async function recordStart(io: SpawnHookIo, e: AgentSpawnInput, id: string, s: Start): Promise<void> {
  const { used, model, targetEffort, routed, sizeFed, sizeArm, arm, liteMode, again } = s
  const t = await io.now()
  // Recorded only for a `[1m]` model finally used (after the refused-[1m] fallback). A plain
  // model leaves it unset: its window may be the main session's, which windowOf borrows.
  const spawnWindow = typeof used === 'string' && used.includes('[1m]') ? LARGE_WINDOW : undefined
  await io.updateActivity(acts => ({
    ...acts, [id]: { startedAt: t, lastAt: t, log: [`started: ${e.description}`], ...(spawnWindow !== undefined && { spawnWindow }), ...(targetEffort !== undefined && { effort: targetEffort }) },
  }))
  if (targetEffort !== undefined) io.setEffort(id, targetEffort)
  await io.refresh()
  void io.openPane()
  await io.best('recording an agent in the cost ledger', async () => {
    const name = (e as { name?: string }).name ?? e.description
    const role = (ROLE[e.subagentType] ?? 'other') as Role
    const parent = e.parentAgentId === undefined ? undefined : (await io.agentList()).find(a => a.id === e.parentAgentId)
    await io.changeLedger((l, now) => setIdentity(l, id, {
      role, name,
      ...(role === 'worker' && parent?.name !== undefined && { manager: parent.name }),
      ...(role === 'worker' && { branch: CONTINUE_LINE.exec(e.prompt)?.[1] ?? `flow/${name}` }),
      ...(typeof used === 'string' && { spawnModel: used }),
      ...(routed !== undefined && { size: routed.size }),
      ...(sizeFed && { sizeFeedback: true }),
      ...(sizeArm !== undefined && { sizeArm }),
      ...(arm !== undefined && { arm }),
      ...(targetEffort !== undefined && { effort: targetEffort }),
    }, now))
  })
  if (liteMode) await io.best('recording a lite manager', async () => { const at = await io.now(); await io.withLite(cur => ({ state: recordLite(cur, (e as { name?: string }).name ?? e.description, at), out: undefined })) })
  // A lite task files no size decisions: not for its manager, not for its workers. The routing itself still happens.
  const liteOwner = e.subagentType === WORKER && routed !== undefined && isLiteName(await io.lite(), (await io.agentList()).find(a => a.id === e.parentAgentId)?.name)
  if (routed !== undefined && !liteMode && !liteOwner) {
    const r = routed
    if (e.subagentType === MANAGER) await io.best('filing a manager-size decision', () => fileManagerSizeFyi(io.spawn, io.options(), (e as { name?: string }).name ?? e.description, id, r))
    else await io.best('filing a worker-size decision', () => fileSizeFyi(io.spawn, io.options(), (e as { name?: string }).name ?? e.description, e.parentAgentId, r))
  }
  if (mirror.preflightOn && e.subagentType === MANAGER && e.parentAgentId === undefined) {
    await io.best('recording a pre-flight', () => recordManager(io, (e as { name?: string }).name ?? e.description, e.prompt, liteMode, again))
  }
  if (FLOW_TYPES.has(e.subagentType)) {
    await io.best('logging a spawn', async () => {
      await io.spawn.appendLog({
        event: 'spawn', agent: (e as { name?: string }).name ?? e.description, owner: await io.spawn.ownerName(e.parentAgentId),
        ...(routed !== undefined && { text: `size ${routed.size} -> ${model ?? routed.model}${routed.escalated ? ' (escalated)' : ''}` }),
      })
    })
  }
}

// Main's manager already on the roster: main's message resumes it (#239), or main starts a new manager under that
// name. The input tells the two apart by nothing before the start, only the answer does: the listed agent's own id
// is a resume. So main's message goes through as main wrote it, past the plan gate and the checks, with no routing,
// LITE rules or size digest: a resume (the common case) never gets them again, and a new manager under a listed name
// goes without them. A resume keeps its start's bookkeeping: the activity card only moves its lastAt; the ledger
// row, size decision, spawn log line, lite record, effort and family are left alone. A new id gets the bookkeeping of
// any start. Either way the pre-flight keeps what the name filed (recordSpawn's again).
async function resumeManager<R extends { agentId?: string }>(io: SpawnHookIo, e: AgentSpawnInput, name: string, listed: string[], next: (ev: AgentSpawnInput) => Promise<R>): Promise<R> {
  const started = await next(e)
  const id = started.agentId
  if (id === undefined) return started
  const liteMode = isLite(e.prompt) || isLiteName(await io.lite(), name)
  if (!listed.includes(id)) {
    await io.best('recording a manager family', () => recordFamilyOf(io, name))
    const wantEffort = io.takeExplicit(e.tool_use_id) ? undefined : effortFor('manager', undefined, io.settings(), undefined)
    const targetEffort = wantEffort === undefined ? undefined : effortFor('manager', undefined, io.settings(), await io.effortEnv())
    const used = e.model ?? io.settings().managerModel
    await recordStart(io, e, id, { used, model: e.model, targetEffort, routed: undefined, sizeFed: false, sizeArm: undefined, arm: undefined, liteMode, again: true })
    return started
  }
  const t = await io.now()
  await io.updateActivity(acts => (acts[id] === undefined ? acts : { ...acts, [id]: { ...acts[id], lastAt: t } }))
  await io.refresh()
  if (mirror.preflightOn) await io.best('recording a pre-flight', () => recordManager(io, name, e.prompt, liteMode, true))
  return started
}

export async function onSpawn<R extends { agentId?: string }>(io: SpawnHookIo, input: AgentSpawnInput, next: (ev: AgentSpawnInput) => Promise<R>): Promise<R | { deny: string }> {
  // A terminal session's own subagents (Explore and the like) are plain. Its workers are sessions.
  const relay = io.relay()
  if (relay !== undefined) {
    if (relay.role !== 'worker' && String(input.subagentType ?? '').startsWith('flow:')) {
      return { deny: 'flow: start workers with mcp__flow__session action start (this session runs in a terminal and has no flow:* agent types).' }
    }
    return next(input)
  }
  let e = input
  // Only the plugin's own rewrite below starts flow:continue: it needs the old worktree as cwd.
  if (e.subagentType === CONTINUE) return { deny: 'flow: flow:continue is started by the plugin only; spawn a flow:worker with "Continue on branch: <branch>" in the brief.' }
  // Main's manager already on the roster (see resumeManager). Read before the start: after it, the roster lists this
  // spawn too. Before the family too, so a resume writes no families.json: a name keeps the family of its first start.
  if (e.subagentType === MANAGER && e.parentAgentId === undefined) {
    const name = (e as { name?: string }).name ?? e.description
    const listed = (await io.agentList()).filter(a => a.name === name && a.type === MANAGER && a.parentId === undefined).map(a => a.id)
    if (listed.length > 0) return resumeManager(io, e, name, listed, next)
  }
  // A node whose dependencies are not done yet is not started: the owner is told when it is ready.
  const plans = await io.plans()
  if (Object.keys(plans).length > 0 && e.name !== undefined) {
    const parent = e.parentAgentId === undefined ? undefined : (await io.agentList()).find(a => a.id === e.parentAgentId)
    const graph = plans[planOwner(plans, parent?.name)] ?? {}
    const node = Object.values(graph).find(n => n.state === 'waiting' && isManagerOf(n.id, e.name))
    if (node) {
      const deps = node.after.filter(d => graph[d]?.state !== 'done').map(d => `${d} (${graph[d]?.state ?? '?'})`)
      return { deny: `flow plan: ${node.id} waits on ${deps.join(', ')}. Start it when the plugin says it is ready.` }
    }
  }
  // A manager may not start workers before its pre-flight is filed (and its blocking questions answered).
  // A worker already on its roster is resumed by a message: the manager was past the gate when it started it.
  if (e.subagentType === WORKER) {
    const gated = await io.gate(e.parentAgentId)
    if (gated !== undefined && !onRoster(await io.agentList(), (e as { name?: string }).name ?? e.description, [WORKER, CONTINUE], e.parentAgentId)) return { deny: gated }
  }
  // Attachments: every listed file must exist, and a relative path becomes absolute here, since the
  // worker runs in another worktree. Before the continue rewrite and the retries, which carry this prompt.
  if (e.subagentType === WORKER || e.subagentType === CONTINUE || e.subagentType === MANAGER) {
    const checked = await checkAttachments(io.spawn, e.prompt)
    if ('deny' in checked) return { deny: checked.deny }
    if (checked.prompt !== e.prompt) e = { ...e, prompt: checked.prompt }
  }
  // A manager's family (state.ts recordFamily) is fixed before anything reads its notes key: lite, pre-flight, routing.
  if (e.subagentType === MANAGER) await io.best('recording a manager family', () => recordFamilyOf(io, (e as { name?: string }).name ?? e.description))
  // Lite mode: a `Mode: lite` line (or an earlier spawn of this manager's task) puts the LITE rules in front of the prompt.
  let liteMode = false
  if (e.subagentType === MANAGER) {
    liteMode = isLite(e.prompt) || isLiteName(await io.lite(), (e as { name?: string }).name ?? e.description)
    if (liteMode) e = { ...e, prompt: withLiteRules(e.prompt, fill(LITE_RULES, io.settings()), LITE_MARK) }
  }
  if (await fableDenied(io.spawn, e)) return { deny: FABLE_DENY }
  // Best-of-N: an arm spawn is checked against best_of_n, the manager's live workers and max_workers.
  // The slot it reserves is given back when the spawn returns or fails (and expires on its own).
  let arm: ReturnType<typeof armOfSpawn>
  let releaseArm = (): void => undefined
  if (e.subagentType === WORKER) {
    const checked = await armSpawnCheck(io, e, io.settings())
    if ('deny' in checked) return { deny: checked.deny }
    releaseArm = checked.release
    const name = (e as { name?: string }).name ?? e.description
    if (parseArm(e.prompt) !== undefined || generation(name) >= 2) {
      await io.spawn.loadLedger()
      arm = armOfSpawn(name, e.prompt, await io.spawn.ledger())
    }
  }
  // Model routing: the brief's Size line (or a successor's escalation) picks the worker's model, over a model param.
  let routed: Routed | undefined
  let effortRole: EffortRole | undefined
  let sizeFed = false
  // size_ab daily: the day's arm (only with decision_api jev); the off arm asks the decision API nothing.
  let sizeArm: SizeArm | undefined
  if (e.subagentType === WORKER || e.subagentType === MANAGER) sizeArm = sizeArmOf(io.settings().sizeAb, io.settings().decisionApi, await io.now())
  const sizer = sizerFor(sizeArm, () => io.jev())
  if (e.subagentType === WORKER) {
    const r = await routeWorker(io.spawn, e, { small: io.settings().workerModelSmall ?? 'haiku', normal: io.settings().workerModelNormal ?? 'sonnet', large: io.settings().workerModel }, sizer)
    e = r.e
    routed = r.routed
    effortRole = 'worker'
  } else if (e.subagentType === MANAGER) {
    const r = await routeManager(io.spawn, e, io.settings().managerModelSmall ?? 'sonnet', io.settings().managerModelNormal ?? io.settings().managerModel, io.settings().managerModel, sizer)
    e = r.e
    routed = r.routed
    effortRole = 'manager'
    if (io.settings().sizeFeedback) { const f = await withSizeFeedback(io.spawn, e); e = f.e; sizeFed = f.fed }
  } else if (e.subagentType === 'Explore' && e.model === undefined && e.parentAgentId !== undefined) {
    // Read-only exploring by a flow agent runs on the cheap model; main's own and an explicit model stay as they are.
    const parent = (await io.agentList()).find(a => a.id === e.parentAgentId)
    if (parent !== undefined && FLOW_TYPES.has(parent.type)) {
      e = { ...e, model: io.settings().exploreModel ?? 'haiku' }
      effortRole = 'explore'
    }
  } else if (isReviewer(e.subagentType)) {
    effortRole = 'reviewer'
  }
  const explicit = io.takeExplicit(e.tool_use_id)
  // The env is read only when there is an effort to apply; a failed read counts as unset.
  const wantEffort = effortRole === undefined || explicit ? undefined : effortFor(effortRole, routed?.size, io.settings(), undefined)
  const targetEffort = wantEffort === undefined ? undefined : effortFor(effortRole!, routed?.size, io.settings(), await io.effortEnv())
  // mode orca/tmux: main's manager runs as a claude in a terminal. The Agent tool is answered with a refusal that
  // says it started, or why it did not: a failed start is a refusal, never an agent.
  if (e.subagentType === MANAGER && e.parentAgentId === undefined) {
    const started = await startManagerSession(io, e, { routed, liteMode })
    if (started !== undefined) return started
  }
  // A flow agent on a [1m] model: if sub-agents refuse it, retry on the plain model once and
  // remember, so later spawns skip the failed try. A no-model spawn gets the registered model.
  const spawn = e.subagentType === WORKER ? await prepareContinue(io.spawn, e, !io.noContinue()) : e
  const role = ROLE[spawn.subagentType]
  const wanted = role === undefined ? undefined : (spawn.model ?? (io.settings() as Record<string, unknown>)[`${role}Model`])
  const long = typeof wanted === 'string' && wanted.includes('[1m]') ? wanted : undefined
  // One try, with the [1m] retry; a fallback try below goes through it too.
  const go = async (t: AgentSpawnInput) => {
    let ev = long !== undefined && io.noLong() ? { ...t, model: withoutLong(long) } : t
    let started: R | { deny: string }
    try {
      started = await dispatch(next, ev)
    } catch (err) {
      if (long === undefined || io.noLong() || !refusedLong(err)) throw err
      started = { deny: String((err as Error).message) }
    }
    if (long !== undefined && !io.noLong() && refusedLong(started)) {
      io.setNoLong()
      ev = { ...t, model: withoutLong(long) }
      void io.toast(`flow: ${long} was refused for sub-agents; using ${ev.model}`)
      started = await dispatch(next, ev)
    }
    return { ev, started }
  }
  let tried: Awaited<ReturnType<typeof go>>
  try { tried = await go(spawn) } finally { releaseArm() }
  let { ev, started } = tried
  // The host refused our flow:continue rewrite: never fail the spawn for it. Start a plain worker in a
  // new worktree and give the claimed worktree back.
  if (spawn.subagentType === CONTINUE && !('agentId' in started && started.agentId !== undefined)) {
    const name = (e as { name?: string }).name ?? e.description
    const branch = CONTINUE_LINE.exec(e.prompt)?.[1]
    await io.best('releasing a continuation claim', async () => { await io.spawn.updateHandoffs(hs => {
      const r = branch === undefined ? undefined : hs[branch]
      if (branch === undefined || r === undefined || r.takenBy !== name) return hs
      const { takenBy: _t, ...rest } = r
      return { ...hs, [branch]: rest }
    }) })
    // The host replays its refusal to a second next of this spawn, so no retry in this call: later
    // continuations skip the in-place rewrite, and the manager is told to spawn the brief again.
    io.setNoContinue()
    await io.best('logging a continuation fallback', async () => io.spawn.appendLog({ event: 'continue', agent: name, owner: await io.spawn.ownerName(e.parentAgentId), branch, text: 'new worktree (flow:continue refused)' }))
    return { deny: `flow: the host refused the in-place continuation (flow:continue); spawn the same brief again and it starts as a plain flow:worker in a new worktree on ${branch}.` }
  }
  if ('agentId' in started && started.agentId !== undefined) {
    await recordStart(io, e, started.agentId, { used: ev.model ?? wanted, model: ev.model, targetEffort, routed, sizeFed, sizeArm, arm, liteMode, again: false })
  }
  return started
}
