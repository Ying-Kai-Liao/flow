import type { AgentInfo } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const AGENTS: AgentInfo[] = [
  { id: 'm1', name: 'task', description: 'A task', type: 'flow:manager', status: 'running' },
  { id: 'w1', name: 'task-csv', description: 'csv', type: 'flow:worker', status: 'running', parentId: 'm1' },
  { id: 'q1', name: 'merge-queue-1', description: 'queue', type: 'flow:queue', status: 'running' },
]

// A subagent step that used `tokens` of a 200k window (sonnet).
// Returns a setter, since a test registers its hooks once.
function usageMock(on: On, tokens: number): (n: number) => void {
  let used = tokens
  on('turn.step', async function* () {
    return {
      turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { model: 'sonnet', input_tokens: used, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    } as never
  })
  return n => { used = n }
}

const step = async ($: Dollar, agentId?: string) => {
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'sonnet', messageCount: 1, agentId } as never)
  for await (const chunk of stream) void chunk
  return stream.result
}

function notices(on: On, delivered = true) {
  const sent: { to: string; text: string }[] = []
  const toasts: string[] = []
  on('session.send', (_, e) => { sent.push({ to: e.to, text: e.text }); return delivered ? { isDelivered: true as const } : { isDelivered: false as const, reason: 'ended' } })
  on('ui.toast', (_, e) => { toasts.push(String((e as { text?: string }).text ?? JSON.stringify(e))); return { value: undefined } })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  return { sent, toasts }
}

test('a worker past the threshold gets one handoff notice, however many steps follow', async ($, on) => {
  mock.clock(on, { now: 1 })
  on('agent.list', () => ({ value: AGENTS }))
  usageMock(on, 90_000)
  const { sent, toasts } = notices(on)

  await step($, 'w1')
  await step($, 'w1')
  expect(sent.length).toBe(1)
  expect(sent[0]?.text).toMatch(/45%.*40%.*Handoff section/)
  expect(toasts.some(t => t.includes('worker task-csv: past 40% context, handing off'))).toBe(true)

  // A manager is told too, once, and on its own.
  await step($, 'm1')
  expect(sent.length).toBe(2)
})

test('no notice below the threshold, for the queue or main, or with handoff off', async ($, on) => {
  mock.clock(on, { now: 1 })
  on('agent.list', () => ({ value: AGENTS }))
  const use = usageMock(on, 60_000)
  const { sent } = notices(on)
  await step($, 'w1')
  expect(sent).toEqual([])

  use(150_000)
  await step($, 'q1')
  await step($)
  expect(sent).toEqual([])
})

test('handoff off keeps the meter and sends nothing', { options: { handoff: false } }, async ($, on) => {
  mock.clock(on, { now: 1 })
  on('agent.list', () => ({ value: AGENTS }))
  usageMock(on, 150_000)
  const { sent } = notices(on)
  await step($, 'w1')
  expect(sent).toEqual([])
})

test('a failing send never fails the step', async ($, on) => {
  mock.clock(on, { now: 1 })
  on('agent.list', () => ({ value: AGENTS }))
  usageMock(on, 150_000)
  const { sent } = notices(on, false)
  await step($, 'w1')
  expect(sent.length).toBe(1)
})

// What git and gh answer to `/flow resume`.
type Repo = { prs?: unknown[]; all?: unknown[]; refs?: string[]; worktrees?: string; dirty?: string[]; agents?: AgentInfo[]; fail?: string }

function repo(on: On, start: Repo): { submitted: string[]; set: (o: Repo) => void } {
  let o = start
  on('agent.list', () => ({ value: o.agents ?? [] }))
  const submitted: string[] = []
  on('prompt.submit', (_, e) => { submitted.push(e.text); return { text: e.text } })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    const a = e.argv
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: exitCode ? 'boom' : '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (o.fail !== undefined && a.join(' ').startsWith(o.fail)) return out('', 1)
    if (a[0] === 'git' && a[1] === 'fetch') return out('')
    if (a[0] === 'gh') return out(JSON.stringify(a.includes('open') ? o.prs ?? [] : o.all ?? []))
    if (a[1] === 'for-each-ref') return out((o.refs ?? []).join('\n'))
    if (a[1] === 'worktree') return out(o.worktrees ?? '')
    if (a[1] === '-C' && a[3] === 'status') return out(o.dirty?.includes(a[2] ?? '') ? ' M a.ts\n' : '')
    if (a[1] === '-C' && a[3] === 'rev-parse') return out('', 1)
    if (a[1] === '-C' && a[3] === 'log') return out('')
    return out('')
  })
  return { submitted, set: next => { o = next } }
}

const PR = { number: 12, title: 'Export CSV', headRefName: 'flow/csv', isDraft: true, url: 'https://x/pull/12', body: 'x\n## Handoff\nDone: a' }
const WT = 'worktree /r/.claude/worktrees/agent-1\nHEAD abc\nbranch refs/heads/worktree-agent-1\n\nworktree /r\nHEAD def\nbranch refs/heads/main\n\nworktree /r/.claude/worktrees/q\nHEAD 111\ndetached\n'

test('/flow resume lists PRs, branches without a PR and dirty worktrees, and skips merged and live ones', async ($, on) => {
  const clock = mock.clock(on, { now: 1 })
  const { submitted } = repo(on, {
    prs: [PR, { ...PR, number: 13, headRefName: 'feature/other' }],
    all: [{ headRefName: 'flow/csv', state: 'OPEN' }, { headRefName: 'flow/done', state: 'MERGED' }],
    refs: ['origin/flow/csv', 'origin/flow/done', 'origin/flow/orphan', 'origin/flow/task-csv'],
    worktrees: WT,
    dirty: ['/r/.claude/worktrees/agent-1'],
    agents: AGENTS,
  })
  const r = await $.command.run({ command: 'flow', args: 'resume' } as never)
  const text = r.text ?? ''
  expect(text).toContain('Open PRs:')
  expect(text).toContain('#12 flow/csv (draft): Export CSV')
  expect(text).not.toContain('feature/other')
  expect(text).toContain('flow/orphan (pushed, no PR)')
  expect(text).not.toContain('flow/done')
  expect(text).not.toContain('flow/task-csv')
  expect(text).toContain('/r/.claude/worktrees/agent-1 on worktree-agent-1: uncommitted changes')
  expect(text).not.toContain('worktrees/q')
  // The instructions ride as hidden context; a prompt follows the command to start the turn.
  expect(r.context?.[0]).toContain('resume-<slug>')
  expect(r.context?.[0]).toContain('## Handoff')
  await clock.advance(1)
  expect(submitted.length).toBe(1)
})

test('/flow resume says nothing unfinished, and a second run calls the first run resumed', async ($, on) => {
  const clock = mock.clock(on, { now: 1 })
  const { submitted, set } = repo(on, {})
  expect((await $.command.run({ command: 'flow', args: 'resume' } as never)).text).toBe('Nothing unfinished.')
  expect(submitted).toEqual([])

  set({ prs: [PR], all: [{ headRefName: 'flow/csv', state: 'OPEN' }] })
  const first = await $.command.run({ command: 'flow', args: 'resume' } as never)
  expect(first.text).toContain('#12 flow/csv')
  expect(first.context?.length).toBe(1)
  const second = await $.command.run({ command: 'flow', args: 'resume' } as never)
  expect(second.text).toContain('Nothing unfinished.')
  expect(second.text).toContain('Already resumed in this session:')
  expect(second.context).toBeUndefined()
  await clock.advance(1)
  expect(submitted.length).toBe(1)
})

test('/flow resume reports a failing git or gh in one line', async ($, on) => {
  mock.clock(on, { now: 1 })
  repo(on, { fail: 'gh pr list' })
  const r = await $.command.run({ command: 'flow', args: 'resume' } as never)
  expect(r.text).toMatch(/^Cannot look for unfinished work: gh pr list failed/)
})

test('/flow close and the unknown-argument line still work', async ($, on) => {
  mock.clock(on, { now: 1 })
  on('ui.panes', () => ({ value: [] }))
  expect((await $.command.run({ command: 'flow', args: 'close' } as never)).text).toBe('The Flow pane is not open.')
  expect((await $.command.run({ command: 'flow', args: 'shut' } as never)).text).toContain('Unknown argument "shut"')
})
