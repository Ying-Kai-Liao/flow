import type { AgentInfo } from 'claude-code'
import { expect, mock } from 'claude-code/testing'
import { test } from './support'
import type { TestBody } from 'claude-code/testing'
import { findWorktree } from '../hooks/state'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const DIR = '/r/.git/flow'
const AGENTS: AgentInfo[] = [
  { id: 'm1', name: 'csv-export', description: 'm', type: 'flow:manager', status: 'running' },
  { id: 'w1', name: 'csv-worker', description: 'w', type: 'flow:worker', status: 'running', parentId: 'm1' },
  { id: 'w2', name: 'csv-worker-2', description: 'w', type: 'flow:worker', status: 'running', parentId: 'm1' },
  { id: 'w3', name: 'csv-worker-3', description: 'w', type: 'flow:worker', status: 'running', parentId: 'm1' },
]
const WORKTREES = [
  'worktree /r', 'HEAD 1111111', 'branch refs/heads/main', '',
  'worktree /r/.claude/worktrees/agent-w1', 'HEAD abc1234', 'branch refs/heads/flow/csv', '',
].join('\n')

const bash = (command: string, isError?: true) => ({ tool: 'Bash', tool_use_id: 'x', input: { command }, ...(isError && { isError }) })
const TRANSCRIPT = [
  { role: 'user', text: 'brief', toolUses: [] },
  { role: 'assistant', text: 'working', toolUses: [
    { tool: 'Edit', tool_use_id: 'a', input: { file_path: '/r/a.ts' } },
    { tool: 'Write', tool_use_id: 'b', input: { file_path: '/r/b.ts' } },
    { tool: 'Edit', tool_use_id: 'c', input: { file_path: '/r/a.ts' } },
    bash('npm test', true),
    bash('git commit -m "x"'),
    bash('git push -u origin HEAD'),
  ] },
  { role: 'assistant', text: 'Handoff note\nHANDOFF: flow/csv', toolUses: [] },
]

// The test body's $, which can raise agent.offer; the mocked host calls it as the engine would.
let host: Dollar | undefined

type Git = { dirty?: boolean; head?: string; pushed?: string; ancestor?: boolean }
function world(on: On, o: { deny?: boolean; agents?: AgentInfo[]; git?: Git; spawned?: Record<string, unknown>[]; removed?: string[]; refuseContinue?: boolean } = {}) {
  const files = new Map<string, string>()
  const sent: { to: unknown; text: string }[] = []
  const toasts: string[] = []
  host = undefined
  on('agent.offer', () => ({ isOffered: true }))
  on('agent.list', () => ({ value: o.agents ?? AGENTS }))
  // The host: a spawn of a type needs it to be offered (as for a rewrite), so flow:continue only dispatches
  // while the plugin offers it.
  on('agent.spawn', async (_, e) => {
    const offered = host === undefined ? { isOffered: true } : await host.agent.offer({ agent: e.subagentType, description: '', source: 'plugin', provider: { plugin: 'flow', tier: 'user' } } as never)
    if (!offered.isOffered || (o.refuseContinue && e.subagentType === 'flow:continue')) {
      throw new Error(`a hook's subagentType '${e.subagentType}' names no agent this call can dispatch`)
    }
    o.spawned?.push(e as unknown as Record<string, unknown>)
    return { model: 'sonnet', agentId: 'n1' }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', (_, e) => { toasts.push(String((e as { text?: string }).text)); return { value: undefined } })
  on('session.send', (_, e) => { sent.push({ to: e.to, text: e.text }); return { isDelivered: true as const } })
  on('session.messages', () => ({ value: (o.deny ? { deny: 'no' } : TRANSCRIPT) as never }))
  on('turn.complete', (_, e) => ({ text: e.answer }) as never)
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('fs.read', (_, e) => {
    const t = files.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('process.run', (_, e) => {
    const a = e.argv
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const g = o.git ?? {}
    const fail = { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (a[0] === 'test') return out('')
    if (a[0] === 'git' && a[1] === '-C' && a[3] === 'status') return out(g.dirty ? ' M a.ts\n' : '')
    if (a[0] === 'git' && a[1] === '-C' && a[3] === 'rev-parse') return out(`${g.head ?? 'aaaaaaa1'}\n`)
    if (a[0] === 'git' && a[1] === '-C' && a[3] === 'merge-base') return g.ancestor ? out('') : fail
    if (a[0] === 'git' && a[1] === 'rev-parse' && a[2]?.startsWith('origin/')) return out(`${g.pushed ?? 'aaaaaaa1'}\n`)
    if (a[0] === 'git' && a[1] === 'worktree' && a[2] === 'remove') { o.removed?.push(a[3] ?? ''); return out('') }
    if (a[0] === 'git' && a[1] === 'rev-parse') return out('/r/.git\n')
    if (a[0] === 'git' && a[1] === 'worktree') return out(WORKTREES)
    if (a[0] === 'mv') {
      const t = files.get(a[1] ?? '')
      if (t !== undefined) { files.set(a[2] ?? '', t); files.delete(a[1] ?? '') }
      return out('')
    }
    if (a[0] === 'sh') {
      const p = a[5] ?? ''
      files.set(p, `${files.get(p) ?? ''}${a[4]}\n`)
      return out('')
    }
    return out('')
  })
  return { files, sent, toasts }
}

const logOf = (files: Map<string, string>) =>
  (files.get(`${DIR}/log.jsonl`) ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>)

const finish = ($: Dollar, agentId: string, answer = 'done\nHANDOFF: flow/csv') =>
  $.turn.complete({ turnId: 't', agentId, answer } as never)

test('a worker handoff writes a numbered digest, logs it and records the worktree', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const { files, sent } = world(on)

  await finish($, 'w1')

  const digest = files.get(`${DIR}/handoffs/flow-csv/1.md`) ?? ''
  expect(digest).toContain('- /r/a.ts')
  expect(digest.match(/\/r\/a\.ts/g)).toHaveLength(1)
  expect(digest).toContain('- [failed] npm test')
  expect(digest).toContain('- git push -u origin HEAD')
  expect(digest).toContain('6 tool calls')
  expect(digest).toContain('Handoff note')
  expect(logOf(files).find(l => l.event === 'handoff')).toMatchObject({
    agent: 'csv-worker', owner: 'csv-export', branch: 'flow/csv', text: `${DIR}/handoffs/flow-csv/1.md`,
  })
  expect(sent).toHaveLength(0)
})

test('the record finds the worktree by agent id, else by branch', () => {
  expect(findWorktree(WORKTREES, 'w1', 'flow/other')).toEqual({ path: '/r/.claude/worktrees/agent-w1', head: 'abc1234' })
  expect(findWorktree(WORKTREES, 'zz', 'flow/csv')).toEqual({ path: '/r/.claude/worktrees/agent-w1', head: 'abc1234' })
  expect(findWorktree(WORKTREES, 'zz', 'flow/none')).toBeUndefined()
})

test('the third handoff of a branch tells the manager to split; the first two do not', async ($, on) => {
  mock.clock(on, { now: 1 })
  const { files, sent, toasts } = world(on)

  await finish($, 'w1')
  await finish($, 'w1') // a repeat report of the same agent counts once
  await finish($, 'w2')
  expect(sent).toHaveLength(0)
  await finish($, 'w3')

  expect(files.has(`${DIR}/handoffs/flow-csv/3.md`)).toBe(true)
  expect(logOf(files).filter(l => l.event === 'handoff')).toHaveLength(3)
  expect(sent).toHaveLength(1)
  expect(sent[0]?.to).toBe('m1')
  expect(sent[0]?.text).toContain('flow/csv has handed off 3 times (max_continues 2)')
  expect(toasts.some(t => t.includes('handed off 3 times'))).toBe(true)
})

test('a denied transcript still logs the handoff, without a digest', async ($, on) => {
  mock.clock(on, { now: 1 })
  const { files } = world(on, { deny: true })

  await finish($, 'w1')

  expect([...files.keys()].some(k => k.includes('/handoffs/'))).toBe(false)
  const ev = logOf(files).find(l => l.event === 'handoff')
  expect(ev).toMatchObject({ agent: 'csv-worker', branch: 'flow/csv' })
  expect(ev?.text).toBeUndefined()
})

test('a manager handoff is not a worker handoff', async ($, on) => {
  mock.clock(on, { now: 1 })
  const { files } = world(on)

  await finish($, 'w1', 'note\nHANDOFF: manager csv-export')

  expect(logOf(files).some(l => l.event === 'handoff')).toBe(false)
})

// Continuations: the spawn hook rewrites a worker that continues a handed-off branch.
const DONE: AgentInfo[] = AGENTS.map(a => a.id === 'w1' ? { ...a, status: 'completed' as const } : a)
const BRIEF = 'Your name: csv-worker-2\nContinue on branch: flow/csv\nGo on.'
const spawnIt = ($: Dollar, over: Record<string, unknown> = {}) =>
  ((host = $), $).agent.spawn({ subagentType: 'flow:worker', name: 'csv-worker-2', description: 'w', prompt: BRIEF, parentAgentId: 'm1', ...over } as never)

test('a continuation of a clean, pushed worktree runs in place with the digest', async ($, on) => {
  mock.clock(on, { now: 1 })
  const spawned: Record<string, unknown>[] = []
  const { files } = world(on, { agents: DONE, spawned })
  await finish($, 'w1')

  await spawnIt($)

  expect(spawned).toHaveLength(1)
  expect(spawned[0]).toMatchObject({ subagentType: 'flow:continue', cwd: '/r/.claude/worktrees/agent-w1' })
  const prompt = String(spawned[0]?.prompt)
  expect(prompt).toContain('You continue in the same worktree /r/.claude/worktrees/agent-w1')
  expect(prompt).toContain('Transcript digest of the previous worker')
  expect(prompt).toContain('- git push -u origin HEAD')
  expect(logOf(files).find(l => l.event === 'continue')).toMatchObject({
    agent: 'csv-worker-2', owner: 'csv-export', branch: 'flow/csv', text: 'same worktree /r/.claude/worktrees/agent-w1',
  })
})

test('a refused flow:continue falls back to a plain worker in a new worktree and frees the claim', async ($, on) => {
  mock.clock(on, { now: 1 })
  const spawned: Record<string, unknown>[] = []
  const opts = { agents: DONE, spawned, refuseContinue: true }
  world(on, opts)
  await finish($, 'w1')

  await spawnIt($)

  expect(spawned).toHaveLength(1)
  expect(spawned[0]).toMatchObject({ subagentType: 'flow:worker' })
  expect(spawned[0]?.cwd).toBeUndefined()
  const prompt = String(spawned[0]?.prompt)
  expect(prompt).toContain('is kept')
  expect(prompt).not.toContain('You continue in the same worktree')
  expect(prompt).toContain('Transcript digest of the previous worker')
  // The claim was given back: once the host accepts flow:continue, the next spawn gets the worktree.
  opts.refuseContinue = false
  await spawnIt($, { name: 'csv-worker-3' })
  expect(spawned[1]).toMatchObject({ subagentType: 'flow:continue', cwd: '/r/.claude/worktrees/agent-w1' })
})

test('flow:continue is not offered outside a spawn', async ($, on) => {
  world(on)
  const r = await $.agent.offer({ agent: 'flow:continue', description: '', source: 'plugin', provider: { plugin: 'flow', tier: 'user' } } as never)
  expect(r.isOffered).toBe(false)
})

test('only the first of two spawns for a branch gets the worktree', async ($, on) => {
  mock.clock(on, { now: 1 })
  const spawned: Record<string, unknown>[] = []
  world(on, { agents: DONE, spawned })
  await finish($, 'w1')

  await spawnIt($)
  await spawnIt($, { name: 'csv-worker-3' })

  expect(spawned[0]).toMatchObject({ subagentType: 'flow:continue' })
  expect(spawned[1]).toMatchObject({ subagentType: 'flow:worker' })
  expect(spawned[1]?.cwd).toBeUndefined()
  expect(String(spawned[1]?.prompt)).toContain('is kept')
})

test('a dirty worktree falls back to a new one', async ($, on) => {
  mock.clock(on, { now: 1 })
  const spawned: Record<string, unknown>[] = []
  world(on, { agents: DONE, git: { dirty: true }, spawned })
  await finish($, 'w1')
  await spawnIt($)
  expect(spawned[0]).toMatchObject({ subagentType: 'flow:worker' })
  expect(spawned[0]?.cwd).toBeUndefined()
  expect(String(spawned[0]?.prompt)).toContain('Transcript digest')
})

test('a worktree behind origin falls back to a new one', async ($, on) => {
  mock.clock(on, { now: 1 })
  const spawned: Record<string, unknown>[] = []
  world(on, { agents: DONE, git: { head: 'bbbbbbb2' }, spawned })
  await finish($, 'w1')
  await spawnIt($)
  expect(spawned[0]).toMatchObject({ subagentType: 'flow:worker' })
  expect(spawned[0]?.cwd).toBeUndefined()
})

test('a worktree whose old agent is still live falls back to a new one', async ($, on) => {
  mock.clock(on, { now: 1 })
  const spawned: Record<string, unknown>[] = []
  const removed: string[] = []
  world(on, { agents: AGENTS, git: { head: 'bbbbbbb2', ancestor: true }, spawned, removed })
  await finish($, 'w1')
  await spawnIt($)
  expect(spawned[0]).toMatchObject({ subagentType: 'flow:worker' })
  expect(spawned[0]?.cwd).toBeUndefined()
  expect(removed).toEqual([])
})

test('the old worktree is removed when clean, behind and an ancestor', async ($, on) => {
  mock.clock(on, { now: 1 })
  const removed: string[] = []
  const spawned: Record<string, unknown>[] = []
  world(on, { agents: DONE, git: { head: 'bbbbbbb2', ancestor: true }, removed, spawned })
  await finish($, 'w1')
  await spawnIt($)
  expect(removed).toEqual(['/r/.claude/worktrees/agent-w1'])
  expect(spawned[0]).toMatchObject({ subagentType: 'flow:worker' })
  expect(String(spawned[0]?.prompt)).not.toContain('is kept')
})

test('a dirty old worktree is never removed', async ($, on) => {
  mock.clock(on, { now: 1 })
  const removed: string[] = []
  world(on, { agents: DONE, git: { dirty: true, ancestor: true }, removed })
  await finish($, 'w1')
  await spawnIt($)
  expect(removed).toEqual([])
})

test('spawns without Continue on branch, and other agent types, are unchanged', async ($, on) => {
  mock.clock(on, { now: 1 })
  const spawned: Record<string, unknown>[] = []
  const { files } = world(on, { agents: DONE, spawned })
  await finish($, 'w1')

  await spawnIt($, { prompt: 'Your name: new\nDo a thing.' })
  await spawnIt($, { subagentType: 'flow:manager' })

  expect(spawned[0]).toMatchObject({ subagentType: 'flow:worker', prompt: 'Your name: new\nDo a thing.' })
  expect(spawned[1]).toMatchObject({ subagentType: 'flow:manager', prompt: BRIEF })
  expect(logOf(files).some(l => l.event === 'continue')).toBe(false)
})

test('a continuation with no handoff on record is a plain spawn', async ($, on) => {
  mock.clock(on, { now: 1 })
  const spawned: Record<string, unknown>[] = []
  const { files } = world(on, { agents: DONE, spawned })

  await spawnIt($)

  expect(spawned[0]).toMatchObject({ subagentType: 'flow:worker', prompt: BRIEF })
  expect(logOf(files).some(l => l.event === 'continue')).toBe(false)
})
