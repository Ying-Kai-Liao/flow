import type { AgentInfo } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
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

type Git = { dirty?: boolean; head?: string; pushed?: string; ancestor?: boolean }
function world(on: On, o: { deny?: boolean; agents?: AgentInfo[]; git?: Git; spawned?: Record<string, unknown>[]; removed?: string[] } = {}) {
  const files = new Map<string, string>()
  const sent: { to: unknown; text: string }[] = []
  const toasts: string[] = []
  on('agent.list', () => ({ value: o.agents ?? AGENTS }))
  on('agent.spawn', (_, e) => { o.spawned?.push(e as unknown as Record<string, unknown>); return { model: 'sonnet', agentId: 'n1' } })
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
