import type { EngineInterface } from 'claude-code'
import { advance as demoAdvance, canAdvance, isLast as demoIsLast, startDemo, stepOf as demoStepOf } from './demo-replay'
import type { DemoState } from './demo-replay'
import { DEMO_AGENT, isDemoCommit, planCleanup, toInspect } from './demo-clean'
import { DEMO_DONE } from './pane-run'
import { LIVE_STATUS } from './core'

// The demo replay's moves, start, stop, cleanup and the demo tool. The atoms and the io builder stay in
// register.tsx; this takes an io of closures (the engine refuses `$` across an import).
export type DemoIo = {
  get: () => Promise<DemoState | null>
  set: (fn: (cur: DemoState | null) => DemoState | null) => Promise<void>
  // Empties the inbox draft and note the replay would otherwise show.
  clearInbox: () => Promise<void>
  serial: <T>(fn: () => Promise<T>) => Promise<T>
  now: () => Promise<number>
  toast: (text: string) => void
  after: (ms: number, fn: () => void) => void
  openPane: () => Promise<unknown>
  listAgents: () => ReturnType<EngineInterface['agent']['list']>
  run: (argv: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>
}

// Each start gets a new generation, so a timer of an earlier run does nothing.
let demoGen = 0

// One change to the running replay, in the pane's own order. Timers pass the generation they were set for.
export function demoMove(io: DemoIo, fn: (s: DemoState, t: number) => DemoState, gen?: number): Promise<void> {
  return io.serial(async () => {
    const cur = await io.get()
    if (cur === null || (gen !== undefined && cur.gen !== gen)) return
    const moved = fn(cur, await io.now())
    if (moved === cur) return
    await io.set(() => moved)
    if (moved.step === cur.step) return
    if (demoIsLast(moved)) io.toast(DEMO_DONE)
    demoArm(io, moved)
  })
}

export function demoArm(io: DemoIo, s: DemoState): void {
  const ms = demoStepOf(s).autoMs
  if (ms === undefined) return
  io.after(ms, () => void demoMove(io, (cur, t) => (cur.step === s.step && canAdvance(cur) ? demoAdvance(cur, t) : cur), s.gen).catch(() => undefined))
}

export async function demoStart(io: DemoIo): Promise<string> {
  if (await io.get() !== null) return 'The demo is already running in the Flow pane. /flow init demo stop ends it.'
  const s = startDemo(++demoGen, await io.now())
  await io.set(() => s)
  await io.clearInbox()
  demoArm(io, s)
  await io.openPane()
  return 'Demo started in the Flow pane: a replay of one task with canned agents. No agents run, no tokens are used, nothing is written. m = next step, x = stop, or /flow init demo stop.'
}

export async function demoStop(io: DemoIo): Promise<string> {
  if (await io.get() === null) return 'No demo is running.'
  await io.set(() => null)
  await io.clearInbox()
  return 'Demo stopped; the pane shows your real work again.'
}

// Removes what a real demo left: its worktree and branch, by the demo's own names only. Refused while a demo agent lives.
export async function demoCleanup(io: DemoIo): Promise<string> {
  const live = (await io.listAgents()).filter(a => a.name !== undefined && DEMO_AGENT.test(a.name) && LIVE_STATUS.has(a.status))
  if (live.length > 0) return `Not cleaned: ${live.map(a => a.name).join(', ')} still running. Wait for it to end, then clean up.`
  const trees = await io.run(['git', 'worktree', 'list', '--porcelain'])
  const refs = await io.run(['git', 'for-each-ref', '--format=%(refname:short)', 'refs/heads/flow/'])
  // A worker's worktree whose branch is not named for the demo is the demo's only when its one commit is the demo file.
  const confirmed: string[] = []
  for (const w of toInspect(trees.stdout)) {
    const diff = await io.run(['git', '-C', w.path, 'diff', '--name-status', 'HEAD~1', 'HEAD'])
    const status = await io.run(['git', '-C', w.path, 'status', '--porcelain'])
    if (diff.exitCode === 0 && status.exitCode === 0 && isDemoCommit(diff.stdout, status.stdout)) confirmed.push(w.path)
  }
  const plan = planCleanup(trees.stdout, refs.stdout.split('\n').map(l => l.trim()).filter(l => l !== ''), confirmed)
  const out: string[] = plan.kept.map(k => `kept: ${k}`)
  for (const w of plan.worktrees) {
    const r = await io.run(['git', 'worktree', 'remove', '--force', w.path])
    out.push(r.exitCode === 0 ? `removed worktree ${w.path}` : `could not remove worktree ${w.path}: ${r.stderr.trim()}`)
  }
  for (const b of plan.branches) {
    const r = await io.run(['git', 'branch', '-D', b])
    out.push(r.exitCode === 0 ? `deleted branch ${b}` : `could not delete branch ${b}: ${r.stderr.trim()}`)
  }
  return out.length === 0 ? 'Nothing of the demo is left.' : out.join('\n')
}

export async function demoTool(io: DemoIo, input: Record<string, unknown>, agentId: string | undefined): Promise<{ result: string }> {
  if (agentId !== undefined) return { result: 'Refused: only main runs the demo.' }
  const action = String(input.action ?? 'status')
  if (action === 'start') return { result: await demoStart(io) }
  if (action === 'stop') return { result: await demoStop(io) }
  if (action === 'cleanup') return { result: await demoCleanup(io) }
  const agents = (await io.listAgents()).filter(a => a.name !== undefined && DEMO_AGENT.test(a.name)).map(a => `${a.name} (${a.status})`)
  return { result: `Replay: ${(await io.get()) === null ? 'not running' : 'running'}. Real demo agents: ${agents.join(', ') || 'none'}.` }
}
