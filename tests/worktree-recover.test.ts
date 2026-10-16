import { expect, test } from 'claude-code/testing'
import type { AgentInfo } from 'claude-code'

import { settingsOf } from '../hooks/settings'
import { startSession } from '../hooks/startup-run'
import type { StartupIo } from '../hooks/startup-run'
import { beforeToolCall } from '../hooks/toolcall-run'
import type { ToolCallIo } from '../hooks/toolcall-run'

// #222: a resumed reviewer found its worktree gone and could not merge.

const MAIN = '/r'
const WT = (n: string) => `${MAIN}/.claude/worktrees/${n}`

// The SendMessage half of the tool.call hook, with a git that knows which directories exist.
function world(o: { agents: Partial<AgentInfo>[]; dirs?: string[]; listed?: string[]; addFails?: boolean }) {
  const dirs = new Set(o.dirs ?? [])
  const runs: string[][] = []
  const started: string[] = []
  const exec = async (argv: string[]) => {
    runs.push(argv)
    const cmd = argv.join(' ')
    if (cmd === 'git worktree list --porcelain') {
      return { exitCode: 0, stdout: [`worktree ${MAIN}\nHEAD abc\nbranch refs/heads/main`, ...(o.listed ?? []).map(p => `worktree ${p}\nHEAD abc\ndetached\nprunable gitdir file points to non-existent location`)].join('\n\n') + '\n' }
    }
    if (argv[0] === 'test') return { exitCode: dirs.has(argv[2]!) ? 0 : 1, stdout: '' }
    if (argv[1] === 'worktree' && argv[2] === 'add') {
      if (o.addFails) return { exitCode: 128, stdout: '', stderr: 'fatal: no origin/main' }
      dirs.add(argv[4]!)
    }
    return { exitCode: 0, stdout: '' }
  }
  const agents = o.agents.map(a => ({ description: '', type: 'flow:reviewer', status: 'completed', ...a }) as AgentInfo)
  const io = {
    settings: () => settingsOf({}, 'main'),
    exec,
    allAgents: async () => agents,
    agents: async () => agents,
    now: async () => 1,
    sessions: async () => ({}),
    seenAgents: async () => ({}),
    updateActivity: async () => undefined,
    explicitEffort: new Set<string>(),
    wokenByOthers: new Set<string>(),
    best: async (_what: string, fn: () => Promise<void>) => { await fn() },
    reviewerSendGuard: async () => undefined,
    alreadyForwarded: async () => false,
    deliverToSession: async () => 'delivered',
    holdForReviewer: () => undefined,
    startReviewer: async () => { started.push('reviewer') },
  } as unknown as ToolCallIo
  const send = (to: string) => beforeToolCall(io, { tool: 'SendMessage', to, message: 'go on' })
  return { io, runs, started, dirs, send }
}

const added = (runs: string[][]) => runs.filter(a => a[1] === 'worktree' && a[2] === 'add')

test('a message to an ended reviewer whose worktree is gone is refused, and a fresh reviewer is started', async () => {
  const w = world({ agents: [{ id: 'r1', name: 'reviewer-1', status: 'completed' }] })
  const r = await w.send('reviewer-1')
  expect(r).toMatchObject({ deny: expect.stringContaining(`Not sent: reviewer-1 has ended and its worktree ${WT('agent-r1')} is gone`) })
  expect(w.started).toEqual(['reviewer'])
  expect(added(w.runs)).toEqual([])

  // Twice: refused again, and the queue's start is as idempotent as ever (it starts none while one is live).
  expect(await w.send('r1')).toMatchObject({ deny: expect.stringContaining('Not sent') })
  expect(w.started.length).toBe(2)
})

test('a message to an ended reviewer whose worktree is still there goes through, as before', async () => {
  const w = world({ agents: [{ id: 'r1', name: 'reviewer-1', status: 'completed' }], dirs: [WT('agent-r1')] })
  expect(await w.send('reviewer-1')).toBeUndefined()
  expect(w.started).toEqual([])
})

test('a waiting reviewer whose worktree is gone gets it made again at the same path before the message', async () => {
  // Still listed by git (prunable): its path comes from the list, whatever the directory's name.
  const w = world({ agents: [{ id: 'r2', name: 'reviewer-2', status: 'waiting' }], listed: [WT('agent-r2')] })
  expect(await w.send('reviewer-2')).toBeUndefined()
  expect(added(w.runs)).toEqual([['git', 'worktree', 'add', '--detach', WT('agent-r2'), 'origin/main']])
  expect(w.runs.findIndex(a => a.join(' ') === 'git worktree prune')).toBeLessThan(w.runs.findIndex(a => a[2] === 'add'))
  expect(w.started).toEqual([])

  // A second message finds it there.
  w.runs.length = 0
  expect(await w.send('reviewer-2')).toBeUndefined()
  expect(added(w.runs)).toEqual([])
})

test('an idle reviewer whose worktree cannot be made again: the message is refused with git\'s reason', async () => {
  const w = world({ agents: [{ id: 'r3', name: 'reviewer-3', status: 'idle' }], addFails: true })
  expect(await w.send('reviewer-3')).toMatchObject({ deny: expect.stringContaining(`reviewer-3's worktree ${WT('agent-r3')} is gone and could not be made again (fatal: no origin/main)`) })
})

test('messages to managers, a pending reviewer and unknown names are not looked at', async () => {
  const w = world({ agents: [{ id: 'm1', name: 'm1', type: 'flow:manager', status: 'completed' }, { id: 'r4', name: 'reviewer-4', status: 'pending' }] })
  expect(await w.send('m1')).toBeUndefined()
  expect(await w.send('reviewer-4')).toBeUndefined()
  expect(await w.send('nobody')).toBeUndefined()
  expect(w.runs.some(a => a[0] === 'test' || a[2] === 'add')).toBe(false)
})

// The startup order: the sweep reads the sessions to know whose worktree is whose, so it runs only after
// they are loaded and adopted, and after the settings that say whether to sweep at all.
test('session start sweeps only after the sessions are loaded and adopted and the settings applied', async () => {
  const calls: string[] = []
  const io = {
    options: {}, pollMs: 1000, prPollMs: 1000, initHint: '',
    best: async (_what: string, fn: () => Promise<void>) => { await fn() },
    run: async () => ({ exitCode: 1, stdout: '' }),
    readState: async (file: string) => (file === 'sessions.json' ? { disk: {} } : undefined),
    loadHandovers: async () => ({}),
    handovers: async () => ({}),
    agents: async () => [],
    locate: async () => [],
    paths: () => [],
    detected: () => 'main',
    settings: () => settingsOf({}, 'main'),
    relaySessionCount: async () => 0,
    firstRun: async () => false,
  } as Record<string, unknown>
  const recorded = ['mergeSessions', 'adoptSessions', 'applySettings', 'autoSweep']
  const full = new Proxy(io, {
    get: (t, k: string) => k in t ? t[k] : recorded.includes(k) ? () => { calls.push(k) } : () => undefined,
  }) as unknown as StartupIo
  await startSession(full)
  expect(calls).toEqual(['mergeSessions', 'adoptSessions', 'applySettings', 'autoSweep'])
})
