import { expect, test } from 'claude-code/testing'
import type { Activity, Session } from '../types'

import { sendToSession, sessionTool, startRoleSession, watchSessions, withClaudeFlags } from '../hooks/session-run'
import type { Ran, SessionIo, SessionSettings } from '../hooks/session-run'
import { harnessesOf } from '../hooks/sessions'
import { settingsOf } from '../hooks/settings'

// Role sessions driven straight through the io (the engine is not needed): every command recorded.
function world(o: { orca?: boolean; orcaTerminalInMain?: boolean; screen?: string; sessions?: Record<string, Session> } = {}) {
  const files = new Map<string, string>()
  const mtimes = new Map<string, number>()
  const runs: string[][] = []
  const told: string[] = []
  const roleReports: { name: string; report: string }[] = []
  const roleGone: string[] = []
  let sessions: Record<string, Session> = o.sessions ?? {}
  let now = 1_000_000
  let alive = true
  const run = async (argv: string[]): Promise<Ran> => {
    runs.push(argv)
    const cmd = argv.join(' ')
    const out = (stdout: string, exitCode = 0): Ran => ({ exitCode, stdout, stderr: '' })
    if (cmd === 'git worktree list --porcelain') return out('worktree /r\nHEAD abc\nbranch refs/heads/main\n')
    if (cmd === 'orca status') return o.orca ? out('runtimeReachable: true\n') : out('', 1)
    if (cmd.startsWith('orca terminal create')) {
      if (argv.includes('path:/r') && o.orcaTerminalInMain === false) return out('', 1)
      return out(JSON.stringify({ result: { terminal: { handle: 'term_abc' } } }))
    }
    if (cmd.startsWith('orca worktree create')) return out(JSON.stringify({ result: { worktree: { path: '/o/mgr-m1' } } }))
    if (cmd.startsWith('tmux -V')) return out('tmux 3.4')
    if (argv[0] === 'sh' && cmd.includes('command -v')) return out('/bin/x\n')
    if (cmd.startsWith('tmux capture-pane') || cmd.startsWith('orca terminal read')) return out(o.screen ?? 'working')
    if (cmd.startsWith('tmux display-message')) return out(alive ? 'claude\n' : 'zsh\n')
    if (cmd.startsWith('orca terminal show')) return out(JSON.stringify({ connected: alive }))
    return out('')
  }
  const io: SessionIo = {
    run,
    now: async () => now,
    after: (_ms, fn) => fn(),
    stat: async p => {
      if (!files.has(p)) throw new Error('ENOENT')
      return { mtimeMs: mtimes.get(p) ?? 1 }
    },
    readFile: async p => files.get(p) ?? '',
    write: async (p, t) => { files.set(p, t) },
    sessions: async () => sessions,
    updateSessions: async fn => { sessions = fn(sessions) },
    updateActivity: async (fn: (a: Record<string, Activity>) => Record<string, Activity>) => { fn({}) },
    setLimits: async () => undefined,
    gate: async () => undefined,
    agents: async () => [],
    stateDir: async () => '/r/.git/flow',
    log: async () => undefined,
    warn: async (what, err) => { throw new Error(`${what}: ${String(err)}`) },
    refresh: async () => undefined,
    openPane: async () => undefined,
    submit: async t => { told.push(t) },
    deliver: async (_id, t) => { told.push(t) },
    logMax: 40,
  }
  return { io, files, mtimes, runs, told, roleReports, roleGone, sessions: () => sessions, tick: (ms: number) => { now += ms }, kill: () => { alive = false } }
}

const SETTINGS: SessionSettings = { ...settingsOf({ mode: 'tmux' }, 'main'), harnesses: harnessesOf(undefined) }
const ORCA: SessionSettings = { ...SETTINGS, mode: 'orca' }

const OWNER = { id: 'main', name: 'main' }

test('a manager session runs in the main checkout, no new worktree, with its relay environment', async () => {
  const w = world()
  const r = await startRoleSession(w.io, { role: 'manager', name: 'm1', prompt: 'You are a flow manager. Report to {{REPORT}}. Task.', model: 'opus', owner: OWNER }, SETTINGS)
  expect(r.ok).toBe(true)
  expect(w.runs).toContainEqual(['tmux', 'new-session', '-d', '-s', 'flow-m1', '-c', '/r'])
  expect(w.runs.some(a => a[0] === 'git' && a[1] === 'worktree' && a[2] === 'add')).toBe(false)
  const typed = w.runs.find(a => a[0] === 'tmux' && a.includes('-l'))!.at(-1)!
  expect(typed).toContain("FLOW_ROLE=manager FLOW_NAME='m1' FLOW_RELAY='/r/.git/flow/sessions/m1/relay' claude --model 'opus' --permission-mode bypassPermissions")
  expect(w.files.get('/r/.git/flow/sessions/m1/prompt.md')).toContain('Report to /r/.git/flow/sessions/m1/report.md.')
  const s = w.sessions().m1!
  expect(s).toMatchObject({ role: 'manager', relayDir: '/r/.git/flow/sessions/m1/relay', worktree: '/r', owner: 'main' })
  expect(w.runs).toContainEqual(['mkdir', '-p', '/r/.git/flow/sessions/m1/relay'])
})

test('a manager in Orca tries a terminal in the main checkout, and falls back to a detached Orca worktree', async () => {
  const w = world({ orca: true })
  await startRoleSession(w.io, { role: 'manager', name: 'm1', prompt: 'p', owner: OWNER }, ORCA)
  const first = w.runs.filter(a => a.join(' ').startsWith('orca terminal create'))
  expect(first.length).toBe(1)
  expect(first[0]).toContain('path:/r')

  const f = world({ orca: true, orcaTerminalInMain: false })
  const r = await startRoleSession(f.io, { role: 'manager', name: 'm1', prompt: 'p', owner: OWNER }, ORCA)
  expect(r.ok).toBe(true)
  expect(f.runs).toContainEqual(['orca', 'worktree', 'create', '--repo', 'path:/r', '--name', 'mgr-m1', '--base-branch', 'origin/main', '--json'])
  expect(f.runs).toContainEqual(['git', '-C', '/o/mgr-m1', 'checkout', '--detach'])
  const create = f.runs.filter(a => a.join(' ').startsWith('orca terminal create')).at(-1)!
  expect(create).toContain('path:/o/mgr-m1')
  expect(create[create.indexOf('--command') + 1]).toMatch(/^cd '\/r' && FLOW_ROLE=manager /)
  expect(f.sessions().m1).toMatchObject({ worktree: '/r', hostWorktree: '/o/mgr-m1' })
})

test('the reviewer gets a detached worktree of its own', async () => {
  const w = world()
  const r = await startRoleSession(w.io, { role: 'reviewer', name: 'rev', prompt: 'p', owner: OWNER }, SETTINGS)
  expect(r.ok).toBe(true)
  expect(w.runs).toContainEqual(['git', 'worktree', 'add', '--detach', '/r/.claude/worktrees/rev', 'origin/main'])
  expect(w.sessions().rev).toMatchObject({ role: 'reviewer', worktree: '/r/.claude/worktrees/rev' })

  const o = world({ orca: true })
  await startRoleSession(o.io, { role: 'reviewer', name: 'rev', prompt: 'p', owner: OWNER }, ORCA)
  expect(o.runs).toContainEqual(['orca', 'worktree', 'create', '--repo', 'path:/r', '--name', 'rev', '--base-branch', 'origin/main', '--json'])
  expect(o.runs).toContainEqual(['git', '-C', '/o/mgr-m1', 'checkout', '--detach'])
})

test('agent mode starts no role session; a terminal mode starts claude whatever worker_harness is', async () => {
  const w = world()
  const agent = { ...SETTINGS, mode: 'agent' }
  const r = await startRoleSession(w.io, { role: 'manager', name: 'm1', prompt: 'p', owner: OWNER }, agent)
  expect(r).toMatchObject({ ok: false, text: expect.stringContaining('agent mode') })
  expect(w.runs.some(a => a[0] === 'tmux' && a[1] === 'new-session')).toBe(false)
  const c = await startRoleSession(w.io, { role: 'manager', name: 'm2', prompt: 'p', owner: OWNER }, { ...SETTINGS, workerHarness: 'codex' })
  expect(c.ok && c.session.harness).toBe('claude')
})

test('agent mode refuses a session start; other actions keep working', async () => {
  const w = world()
  const agent = { ...SETTINGS, mode: 'agent' }
  expect(await sessionTool(w.io, { action: 'start', name: 'w1', harness: 'codex', brief: 'x' }, { id: 'm1', name: 'csv' }, agent)).toBe('Refused: flow runs in agent mode; terminal workers need mode orca or tmux.')
  expect(await sessionTool(w.io, { action: 'list' }, { id: 'm1', name: 'csv' }, agent)).not.toContain('Refused')
})

test('a host that is down refuses the start: no fallback to the other host', async () => {
  const w = world()
  const orca = await sessionTool(w.io, { action: 'start', name: 'w1', harness: 'claude', brief: 'x' }, { id: 'm1', name: 'csv' }, ORCA)
  expect(orca).toContain('mode orca, but Orca is not reachable')
  expect(w.runs.some(a => a[0] === 'tmux' && a[1] === 'new-session')).toBe(false)
  const o = world({ orca: true })
  const tmuxDown = (await sessionTool({ ...o.io, run: async a => a.join(' ') === 'tmux -V' ? { exitCode: 127, stdout: '', stderr: '' } : o.io.run(a) }, { action: 'start', name: 'w1', harness: 'claude', brief: 'x' }, { id: 'm1', name: 'csv' }, SETTINGS))
  expect(tmuxDown).toContain('mode tmux, but tmux is not installed')
  expect(o.runs.some(a => a[0] === 'orca' && a[1] === 'terminal')).toBe(false)
})

test('a worker session gets the worker marker in front of its command line', async () => {
  const w = world()
  await sessionTool(w.io, { action: 'start', name: 'w1', harness: 'codex', brief: 'do it' }, { id: 'm1', name: 'csv' }, SETTINGS)
  const typed = w.runs.find(a => a[0] === 'tmux' && a.includes('-l'))!.at(-1)!
  expect(typed).toContain("unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT; FLOW_ROLE=worker FLOW_NAME='w1' codex ")
  expect(w.sessions().w1!.role).toBeUndefined()
})

test('a worker started by a role session defaults to claude, or to worker_harness when that is set', async () => {
  const base = world()
  await startRoleSession(base.io, { role: 'manager', name: 'm1', prompt: 'p', owner: OWNER }, SETTINGS)
  const a = await sessionTool(base.io, { action: 'start', name: 'w1', brief: 'x' }, { id: 'session:m1', name: 'm1' }, SETTINGS)
  expect(a).toContain('Started w1: claude in tmux')
  const b = await sessionTool(base.io, { action: 'start', name: 'w2', brief: 'x' }, { id: 'session:m1', name: 'm1' }, { ...SETTINGS, workerHarness: 'codex' })
  expect(b).toContain('Started w2: codex in tmux')
  // Any caller: claude in a terminal mode.
  expect(await sessionTool(base.io, { action: 'start', name: 'w3', brief: 'x' }, { id: 'm9', name: 'm9' }, SETTINGS)).toContain('Started w3: claude in tmux')
})

test('sendToSession: one short line is typed, anything else goes through a file', async () => {
  const w = world()
  await startRoleSession(w.io, { role: 'manager', name: 'm1', prompt: 'p', owner: OWNER }, SETTINGS)
  const s = w.sessions().m1!
  w.runs.length = 0
  await sendToSession(w.io, s, 'new handover: #4', 'reviewer')
  expect(w.runs).toContainEqual(['tmux', 'set-buffer', '-b', 'flow-m1', '--', 'new handover: #4'])
  expect(w.runs.length).toBe(3)

  w.runs.length = 0
  await sendToSession(w.io, s, 'first line\nsecond line', 'csv')
  const file = '/r/.git/flow/sessions/m1/messages/1000000.md'
  expect(w.files.get(file)).toBe('first line\nsecond line\n')
  expect(w.runs).toContainEqual(['tmux', 'set-buffer', '-b', 'flow-m1', '--', `flow: new message (from csv), read ${file} and act on it`])

  w.runs.length = 0
  await sendToSession(w.io, s, 'x'.repeat(800), 'csv')
  expect(w.runs.find(a => a[1] === 'set-buffer')!.at(-1)).toContain('read /r/.git/flow/sessions/m1/messages/')
})

test('a role session report goes to onRoleReport instead of its owner; a worker report still goes to the owner', async () => {
  const w = world()
  await startRoleSession(w.io, { role: 'manager', name: 'm1', prompt: 'p', owner: OWNER }, SETTINGS)
  await sessionTool(w.io, { action: 'start', name: 'w1', harness: 'codex', brief: 'x' }, { id: 'session:m1', name: 'm1' }, SETTINGS)
  w.files.set('/r/.git/flow/sessions/m1/report.md', 'All merged.')
  w.files.set('/r/.git/flow/sessions/w1/report.md', 'PR opened.')
  w.tick(10_000)
  const io = { ...w.io, onRoleReport: async (s: Session, report: string) => void w.roleReports.push({ name: s.name, report }) }
  await watchSessions(io)
  expect(w.roleReports).toEqual([{ name: 'm1', report: 'All merged.' }])
  expect(w.told.join('\n')).not.toContain('All merged.')
  expect(w.told.join('\n')).toContain('PR opened.')
  expect(w.sessions().m1!.status).toBe('reported')

  // Without the callback a role report falls back to its owner.
  const w2 = world()
  await startRoleSession(w2.io, { role: 'manager', name: 'm1', prompt: 'p', owner: OWNER }, SETTINGS)
  w2.files.set('/r/.git/flow/sessions/m1/report.md', 'Done.')
  w2.tick(10_000)
  await watchSessions(w2.io)
  expect(w2.told.join('\n')).toContain('Done.')
})

test('a role session that goes quiet moves to idle without telling anyone; one that ends goes to onRoleGone', async () => {
  const w = world()
  await startRoleSession(w.io, { role: 'reviewer', name: 'rev', prompt: 'p', owner: OWNER }, SETTINGS)
  const io = { ...w.io, onRoleGone: async (s: Session, tail: string) => void w.roleGone.push(`${s.name}:${tail.trim()}`) }
  w.tick(11_000)
  await watchSessions(io)
  w.tick(100_000)
  await watchSessions(io)
  expect(w.sessions().rev!.status).toBe('idle')
  expect(w.told).toEqual([])

  w.kill()
  w.tick(40_000)
  await watchSessions(io)
  expect(w.sessions().rev!.status).toBe('exited')
  expect(w.roleGone).toEqual(['rev:working'])
  expect(w.told).toEqual([])
})

const CL = 'claude --permission-mode bypassPermissions'

test('claude flags: effort next to model, effort alone, none', () => {
  expect(withClaudeFlags('claude', CL, { effort: 'low' })).toBe("claude --effort 'low' --permission-mode bypassPermissions")
  expect(withClaudeFlags('claude', CL, { model: 'opus', effort: 'xhigh' })).toBe("claude --model 'opus' --effort 'xhigh' --permission-mode bypassPermissions")
  expect(withClaudeFlags('claude', CL, { model: 'opus' })).toBe("claude --model 'opus' --permission-mode bypassPermissions")
  expect(withClaudeFlags('claude', CL, {})).toBe(CL)
})

test('claude flags: inherit, empty and unknown levels pass nothing', () => {
  for (const e of ['inherit', '', 'ultra', 'low; rm -rf /']) expect(withClaudeFlags('claude', CL, { effort: e })).toBe(CL)
})

test('claude flags: other harnesses and non-claude lines are untouched', () => {
  expect(withClaudeFlags('codex', 'codex exec', { effort: 'high', model: 'x' })).toBe('codex exec')
  expect(withClaudeFlags('claude', 'sh -c claude', { effort: 'high' })).toBe('sh -c claude')
})

test('a manager session starts claude with --effort, and a restart keeps it', async () => {
  const w = world()
  await startRoleSession(w.io, { role: 'manager', name: 'm1', prompt: 'p', effort: 'high', owner: OWNER }, SETTINGS)
  const typed = w.runs.find(a => a[0] === 'tmux' && a.includes('-l'))!.at(-1)!
  expect(typed).toContain("claude --effort 'high' --permission-mode")
  expect(w.sessions().m1!.start).toContain("--effort 'high'")
})
