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

const step = async ($: Dollar, agentId?: string, model = 'sonnet') => {
  const stream = $.turn.step({ turnId: 't', index: 0, model, messageCount: 1, agentId } as never)
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
type Repo = { prs?: unknown[]; all?: unknown[]; refs?: string[]; worktrees?: string; dirty?: string[]; agents?: AgentInfo[]; fail?: string; heads?: Record<string, string>; ahead?: boolean }

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
    if (a[1] === '-C' && a[3] === 'rev-parse' && a[4] === 'HEAD') return out(o.heads?.[a[2] ?? ''] ?? 'ffff')
    if (a[1] === '-C' && a[3] === 'rev-parse') return out('', 1)
    if (a[1] === '-C' && a[3] === 'log') return out(o.ahead ? 'abc commit\n' : '')
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

const WT2 = 'worktree /r/.claude/worktrees/agent-w1\nHEAD aaa\nbranch refs/heads/worktree-agent-w1\n\nworktree /r/.claude/worktrees/agent-old\nHEAD bbb\nbranch refs/heads/flow/squashed\n\nworktree /r/.claude/worktrees/agent-old2\nHEAD ccc\nbranch refs/heads/worktree-agent-old2\n\nworktree /r/.claude/worktrees/agent-left\nHEAD ddd\nbranch refs/heads/worktree-agent-left\n'

test('/flow resume skips a live agent\'s worktree and squash-merged ones', async ($, on) => {
  mock.clock(on, { now: 1 })
  repo(on, {
    worktrees: WT2,
    ahead: true,
    agents: [{ id: 'w1', name: 'task-csv', description: 'csv', type: 'flow:worker', status: 'running' }],
    // agent-old's branch is merged; agent-old2's head is a merged PR's head.
    all: [{ headRefName: 'flow/squashed', headRefOid: 'x1', state: 'MERGED' }, { headRefName: 'flow/other', headRefOid: 'h2', state: 'MERGED' }],
    heads: { '/r/.claude/worktrees/agent-old2': 'h2', '/r/.claude/worktrees/agent-left': 'h9' },
  })
  const text = (await $.command.run({ command: 'flow', args: 'resume' } as never)).text ?? ''
  expect(text).not.toContain('agent-w1')
  expect(text).not.toContain('agent-old')
  expect(text).toContain('agent-left')
})

// A subagent tool call; the reminder rides on the result's context.
const call = async ($: Dollar, agentId: string) => {
  const r = await $.tool.call({ tool: 'Read', file_path: '/x', agentId } as never)
  return ((r as { context?: string[] }).context ?? []).filter(c => c.includes('WRAP UP'))
}

function toolEnd(on: On) {
  on('tool.call', () => ({ result: 'ok' }) as never)
}

test('a 1M model hands off at 350k tokens, not at 300k; a 200k model at 80k', async ($, on) => {
  mock.clock(on, { now: 1 })
  on('agent.list', () => ({ value: AGENTS }))
  const use = usageMock(on, 300_000)
  const { sent } = notices(on)
  // 300k proves a 1M window: 30%, below both limits.
  await step($, 'w1')
  expect(sent).toEqual([])
  use(400_000)
  await step($, 'w1')
  expect(sent.length).toBe(1)
  expect(sent[0]?.text).toMatch(/past the 35% limit/)
})

test('a 200k model is told at 80k even with the token limit far above it', async ($, on) => {
  mock.clock(on, { now: 1 })
  on('agent.list', () => ({ value: AGENTS }))
  const use = usageMock(on, 79_000)
  const { sent } = notices(on)
  await step($, 'w1')
  expect(sent).toEqual([])
  use(81_000)
  await step($, 'w1')
  expect(sent.length).toBe(1)
})

test('context_warn_tokens lower than the percent wins; 0 leaves the percent', { options: { context_warn_tokens: 50_000 } }, async ($, on) => {
  mock.clock(on, { now: 1 })
  on('agent.list', () => ({ value: AGENTS }))
  usageMock(on, 60_000)
  const { sent } = notices(on)
  await step($, 'w1')
  expect(sent.length).toBe(1)
  expect(sent[0]?.text).toMatch(/50k tokens/)
})

test('context_warn_tokens 0 falls back to the percent', { options: { context_warn_tokens: 0 } }, async ($, on) => {
  mock.clock(on, { now: 1 })
  on('agent.list', () => ({ value: AGENTS }))
  const use = usageMock(on, 70_000)
  const { sent } = notices(on)
  await step($, 'w1')
  expect(sent).toEqual([])
  use(85_000)
  await step($, 'w1')
  expect(sent.length).toBe(1)
})

test('the reminder comes on the first call past the limit, every 10th, and on a 10 point rise', async ($, on) => {
  mock.clock(on, { now: 1 })
  on('agent.list', () => ({ value: AGENTS }))
  const use = usageMock(on, 90_000)
  notices(on)
  toolEnd(on)
  expect((await call($, 'w1')).length).toBe(0) // not past yet: no step has crossed
  await step($, 'w1')
  expect((await call($, 'w1')).length).toBe(1)
  for (let i = 0; i < 8; i++) expect((await call($, 'w1')).length).toBe(0)
  expect((await call($, 'w1')).length).toBe(1) // the 10th past the limit
  use(114_000) // 45% -> 57%
  await step($, 'w1')
  expect((await call($, 'w1')).length).toBe(1)
  expect((await call($, 'w1')).length).toBe(0)
})

test('a manager gets manager wording; the queue and a worker below the limit get nothing', async ($, on) => {
  mock.clock(on, { now: 1 })
  on('agent.list', () => ({ value: AGENTS }))
  const use = usageMock(on, 90_000)
  notices(on)
  toolEnd(on)
  await step($, 'm1')
  const m = await call($, 'm1')
  expect(m[0]).toMatch(/once none of your workers is running/)
  await step($, 'q1')
  expect(await call($, 'q1')).toEqual([])
  use(30_000)
  await step($, 'w1')
  expect(await call($, 'w1')).toEqual([])
})

test('no reminder with handoff off', { options: { handoff: false } }, async ($, on) => {
  mock.clock(on, { now: 1 })
  on('agent.list', () => ({ value: AGENTS }))
  usageMock(on, 90_000)
  notices(on)
  toolEnd(on)
  await step($, 'w1')
  expect(await call($, 'w1')).toEqual([])
})

test('after a compaction the reminders stop until the next crossing', async ($, on) => {
  mock.clock(on, { now: 1 })
  on('agent.list', () => ({ value: AGENTS }))
  const use = usageMock(on, 90_000)
  const { sent } = notices(on)
  toolEnd(on)
  await step($, 'w1')
  expect((await call($, 'w1')).length).toBe(1)
  use(20_000)
  await step($, 'w1')
  expect(await call($, 'w1')).toEqual([])
  use(90_000)
  await step($, 'w1')
  expect(sent.length).toBe(2)
  expect((await call($, 'w1')).length).toBe(1)
})

test('main gets one toast per crossing, re-armed after the usage drops', async ($, on) => {
  mock.clock(on, { now: 1 })
  on('agent.list', () => ({ value: AGENTS }))
  usageMock(on, 10_000)
  const { toasts } = notices(on)
  let tokens = 90_000
  on('session.usage', () => ({ value: { context: { tokens, window: 200_000, percent: Math.round(tokens / 2000) } } }) as never)
  const mainToasts = () => toasts.filter(t => t.includes('main session'))
  await step($)
  await step($)
  expect(mainToasts().length).toBe(1)
  tokens = 20_000
  await step($)
  tokens = 100_000
  await step($)
  expect(mainToasts().length).toBe(2)
})

test('main gets no warning when no flow agents exist', async ($, on) => {
  mock.clock(on, { now: 1 })
  on('agent.list', () => ({ value: [] }))
  usageMock(on, 10_000)
  const { toasts } = notices(on)
  on('session.usage', () => ({ value: { context: { tokens: 150_000, window: 200_000, percent: 75 } } }) as never)
  await step($)
  expect(toasts.filter(t => t.includes('main session'))).toEqual([])
})

// The API reports `claude-sonnet-5` without the suffix; the engine's resolved id carries `[1m]`.
const ONE_M = 'claude-sonnet-5[1m]'

test('a [1m] worker is measured against 1M although usage.model lacks the suffix', async ($, on) => {
  mock.clock(on, { now: 1 })
  on('agent.list', () => ({ value: AGENTS }))
  const use = usageMock(on, 300_000)
  const { sent } = notices(on)
  await step($, 'w1', ONE_M)
  expect(sent).toEqual([])
  use(350_000)
  await step($, 'w1', ONE_M)
  expect(sent.length).toBe(1)
  expect(sent[0]?.text).toMatch(/past the 35% limit/)
})

test('a plain sonnet worker is told at 80k', async ($, on) => {
  mock.clock(on, { now: 1 })
  on('agent.list', () => ({ value: AGENTS }))
  const use = usageMock(on, 79_000)
  const { sent } = notices(on)
  await step($, 'w1')
  expect(sent).toEqual([])
  use(80_000)
  await step($, 'w1')
  expect(sent.length).toBe(1)
})

test('the meter shows the token limit next to the marker for a [1m] worker', { options: { context_warn_tokens: 300_000 } }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('agent.list', () => ({ value: AGENTS }))
  on('agent.spawn', () => ({ model: ONE_M, agentId: 'w1' }))
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 200_000, tokens: 1000, percent: 1 } } }))
  usageMock(on, 100_000)
  notices(on)
  await $.agent.spawn({ prompt: 'brief', description: 'A task', subagentType: 'flow:manager', model: ONE_M } as never)
  await step($, 'w1', ONE_M)
  const ui = await $.ui.mount({ plugin: 'flow', surface: 'terminal', component: 'Pane', props: { title: 'Flow' }, requestId: 'flow', viewport: { columns: 100, rows: 40 } } as never)
  await ui.press({ key: 'fold-m1' })
  expect(await ui.find({ type: 'Text', text: /300k│/ })).toBeDefined()
})

// A worker spawned with `model`, whose steps report plain ids (as the API does).
async function spawned($: Dollar, on: On, model: string, tokens: number) {
  mock.clock(on, { now: 1_000_000 })
  on('agent.list', () => ({ value: AGENTS }))
  on('agent.spawn', (_, e) => ({ model: (e as { model?: string }).model ?? 'sonnet', agentId: 'w1' }))
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 200_000, tokens: 1000, percent: 1 } } }))
  const use = usageMock(on, tokens)
  const { sent } = notices(on)
  await $.agent.spawn({ prompt: 'brief', description: 'csv', subagentType: 'flow:worker', model } as never)
  return { use, sent }
}

test('a worker spawned with sonnet[1m] is sized 1M although its steps say plain sonnet', async ($, on) => {
  const { use, sent } = await spawned($, on, 'sonnet[1m]', 80_000)
  await step($, 'w1', 'claude-sonnet-5')
  use(300_000)
  await step($, 'w1', 'claude-sonnet-5')
  expect(sent).toEqual([])
  use(350_000)
  await step($, 'w1', 'claude-sonnet-5')
  expect(sent.length).toBe(1)
})

test('a worker spawned with plain sonnet hands off at 80k', async ($, on) => {
  const { use, sent } = await spawned($, on, 'sonnet', 79_000)
  await step($, 'w1', 'claude-sonnet-5')
  expect(sent).toEqual([])
  use(80_000)
  await step($, 'w1', 'claude-sonnet-5')
  expect(sent.length).toBe(1)
})

test('context_warn_percent_1m moves the 1M handoff', { options: { context_warn_percent_1m: 50 } }, async ($, on) => {
  const { use, sent } = await spawned($, on, 'sonnet[1m]', 400_000)
  await step($, 'w1', 'claude-sonnet-5')
  expect(sent).toEqual([])
  use(500_000)
  await step($, 'w1', 'claude-sonnet-5')
  expect(sent.length).toBe(1)
})

test('context_warn_tokens caps the 1M handoff', { options: { context_warn_tokens: 100_000 } }, async ($, on) => {
  const { use, sent } = await spawned($, on, 'sonnet[1m]', 99_000)
  await step($, 'w1', 'claude-sonnet-5')
  expect(sent).toEqual([])
  use(100_000)
  await step($, 'w1', 'claude-sonnet-5')
  expect(sent.length).toBe(1)
  expect(sent[0]?.text).toMatch(/100k tokens/)
})

test('the meter of a worker spawned with sonnet[1m] shows 1M with the marker at 35%', async ($, on) => {
  await spawned($, on, 'sonnet[1m]', 100_000)
  await step($, 'w1', 'claude-sonnet-5')
  const ui = await $.ui.mount({ plugin: 'flow', surface: 'terminal', component: 'Pane', props: { title: 'Flow' }, requestId: 'flow', viewport: { columns: 100, rows: 40 } } as never)
  await ui.press({ key: 'fold-m1' })
  // 12 cells: 10% fills 1, the marker sits at cell 4 (floor of 35% of 12).
  expect(await ui.find({ type: 'Text', text: /█░{2}░│░{7} 10%/ })).toBeDefined()
})
