import type { AgentInfo } from 'claude-code'
import { expect, mock } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { Breaker, Handover, Session } from '../types'
import { mirror } from '../hooks/core'
import { decide, EMPTY_BREAKER, endRun, HALT_AFTER, haltContext, normalizeBreaker, REACH_MS, reachRun, startRun, UNREACHABLE_ERROR } from '../hooks/reviewer-breaker'
import { noteReviewerEnd, startQueue, toldKey } from '../hooks/reviewer-run'
import type { BreakerIo, QueueIo } from '../hooks/reviewer-run'
import { test } from './support'

// Issue #222 item 2: pending handovers always reach a reviewer (a waiting agent is told, a terminal that reported is
// told again, a reviewer_delay wait survives a hook reload, only this main's terminal counts), and a reviewer whose
// flow tools never reach the plugin is reported once and replaced by a fresh one.

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const ho = (pr: number, status = 'pending', at = 1): Handover => ({ pr, at, status } as unknown as Handover)

// ---- startQueue against a fake QueueIo ----

function setup(initial: { pending?: Handover[]; agents?: { id?: string; name?: string; type: string; status: string }[]; session?: Session; breaker?: Breaker; until?: number; now?: number; terminal?: boolean } = {}) {
  mirror.deployInfos = []
  const w = {
    handovers: Object.fromEntries((initial.pending ?? []).map(h => [String(h.pr), h])) as Record<string, Handover>,
    agents: initial.agents ?? [],
    session: initial.session,
    breaker: initial.breaker ?? EMPTY_BREAKER,
    now: initial.now ?? 1_000_000,
    until: initial.until ?? 0,
    spawns: [] as string[],
    typed: [] as string[],
    sent: [] as { id: string; text: string }[],
    refuse: undefined as string | undefined,
    stopped: [] as string[],
    reaches: [] as number[],
    delays: [] as number[],
    told: [] as string[],
    running: false,
  }
  const breaker: BreakerIo = {
    stateDir: async () => undefined,
    readJson: async () => undefined,
    writeJson: async () => undefined,
    mkdir: async () => undefined,
    get: async () => w.breaker,
    set: async b => { w.breaker = b },
    now: async () => w.now,
    withInbox: async fn => fn({ next: 1, items: [] } as never).out,
    toast: () => undefined,
    tell: text => { w.told.push(text) },
  }
  const io: QueueIo = {
    agents: async () => w.agents,
    batch: async () => undefined,
    handovers: async () => w.handovers,
    deploys: async () => ({ targets: {} }) as never,
    runs: async () => w.spawns.length,
    setRuns: async () => undefined,
    spawn: async input => { w.spawns.push(input.name); return initial.terminal === true ? { terminal: true } : {} },
    reviewerSession: async () => w.session,
    nudge: async (_s, text, told) => { w.typed.push(text); w.session!.nudged = told; return undefined },
    setTold: async (_s, told) => { w.session!.nudged = told },
    stopReviewer: async s => { w.stopped.push(s.name); w.session = undefined },
    reach: ms => { w.reaches.push(ms) },
    tell: async (id, text) => { w.sent.push({ id, text }); return w.refuse },
    breaker,
    wait: () => undefined,
    delay: {
      ms: () => 180_000,
      running: () => w.running,
      start: ms => { if (w.running) return; w.running = true; w.delays.push(ms) },
      until: async () => w.until,
      setUntil: async t => { w.until = t },
    },
  }
  return { w, io }
}

const uid = () => Math.random().toString(36).slice(2)
// What an agent was told is kept by name for the module's life: a test that spawns reviewer-1 seeds it, so a later
// test that must start from nothing passes a name of its own.
const reviewerAgent = (status: string, id = `r-${uid()}`, name = 'reviewer-1') => ({ id, name, type: 'flow:reviewer', status })
const terminal = (name = `rv-${uid()}`, nudged: string[] = []) => ({ name, host: 'tmux', nudged }) as unknown as Session

test('a reviewer agent held on background work is told the pending handovers, once per handover', async () => {
  const a = reviewerAgent('waiting')
  const { w, io } = setup({ pending: [ho(7)], agents: [a] })
  expect(await startQueue(io, 'handover')).toBe('The waiting reviewer reviewer-1 was told: #7.')
  expect(w.sent).toEqual([{ id: a.id, text: expect.stringContaining('Pending handovers: #7.') }])
  expect(await startQueue(io, 'other')).toContain('already been told')
  w.handovers['8'] = ho(8)
  await startQueue(io, 'handover')
  expect(w.sent.map(s => s.text)).toEqual([expect.stringContaining('#7.'), expect.stringContaining('Pending handovers: #8.')])
  // Handed over again (a new instance): told again.
  w.handovers['7'] = ho(7, 'pending', 2)
  await startQueue(io)
  expect(w.sent).toHaveLength(3)
  expect(w.spawns).toEqual([])
})

test('a running reviewer agent is left to list on its own; a waiting one that cannot be messaged is replaced', async () => {
  const running = setup({ pending: [ho(7)], agents: [reviewerAgent('running')] })
  expect(await startQueue(running.io)).toBe('The running reviewer picks it up at its next list.')
  expect(running.w.sent).toEqual([])
  const refused = setup({ pending: [ho(7)], agents: [reviewerAgent('waiting')] })
  refused.w.refuse = 'agent is not accepting messages'
  expect(await startQueue(refused.io)).toBe('Started reviewer reviewer-1.')
  expect(refused.w.spawns).toEqual(['reviewer-1'])
})

test('a reviewer terminal that reports with a PR still pending is told it again, once per report', async () => {
  const h7 = ho(7)
  const s = terminal(undefined, [toldKey(h7)])
  const { w, io } = setup({ pending: [h7], session: s })
  expect(await startQueue(io)).toContain('already been told')
  expect(await startQueue(io, 'other', s.name)).toContain('picks it up')
  expect(w.typed).toEqual(['still pending: #7'])
  // A later trigger that is not a report does not repeat it.
  expect(await startQueue(io)).toContain('already been told')
  // A reviewer that cannot start a batch reports again: #7 is not told a second time, so it does not loop.
  expect(await startQueue(io, 'other', s.name)).toContain('already been told')
  expect(w.typed).toEqual(['still pending: #7'])
  // A new handover after that report is told as new; the next report re-tells it once, and #7 not again.
  w.handovers['8'] = ho(8)
  await startQueue(io, 'handover')
  await startQueue(io, 'other', s.name)
  await startQueue(io, 'other', s.name)
  expect(w.typed).toEqual(['still pending: #7', 'new handover: #8', 'still pending: #8'])
  // A report from some other session name leaves this one's marks alone.
  expect(await startQueue(io, 'other', 'rv-other')).toContain('already been told')
})

test('reviewer_delay: the deadline is kept with the wait, so a timer a reload cancelled is re-armed, or past it the reviewer starts', async () => {
  const fresh = setup({ pending: [ho(7)] })
  expect(await startQueue(fresh.io, 'handover')).toContain('starts in 3m')
  expect(fresh.w.until).toBe(1_000_000 + 180_000)
  // A reload: the timer is gone, the deadline is not. The next handover re-arms what is left and joins.
  const reloaded = setup({ pending: [ho(7), ho(8)], until: 1_000_000 + 60_000 })
  expect(await startQueue(reloaded.io, 'handover')).toContain('joins')
  expect(reloaded.w.delays).toEqual([60_000])
  expect(reloaded.w.spawns).toEqual([])
  // Past the deadline: the reviewer starts now and the deadline is cleared.
  const overdue = setup({ pending: [ho(7), ho(8)], until: 1_000_000 - 1 })
  expect(await startQueue(overdue.io, 'handover')).toContain('Started reviewer')
  expect(overdue.w.until).toBe(0)
  expect(overdue.w.delays).toEqual([])
  // A start for any other reason clears a deadline left behind.
  const other = setup({ pending: [ho(7)], until: 1_000_000 + 60_000 })
  expect(await startQueue(other.io)).toContain('Started reviewer')
  expect(other.w.until).toBe(0)
})

test('a reviewer agent is not messaged about the handovers its spawn prompt named', async () => {
  const { w, io } = setup({ pending: [ho(7), ho(8)] })
  expect(await startQueue(io)).toBe('Started reviewer reviewer-1.')
  // It took some and runs its check in the background: more handovers arrive.
  const id = `r-${uid()}`
  w.agents = [{ id, name: 'reviewer-1', type: 'flow:reviewer', status: 'waiting' }]
  expect(await startQueue(io)).toContain('already been told')
  w.handovers['9'] = ho(9)
  await startQueue(io, 'handover')
  expect(w.sent.map(s => s.text)).toEqual([expect.stringContaining('Pending handovers: #9.')])
})

test('an agent spawn arms no reach timer; only a reviewer started in a terminal does', async () => {
  const agent = setup({ pending: [ho(7)], session: undefined })
  await startQueue(agent.io)
  expect(agent.w.reaches).toEqual([])
  expect(agent.w.breaker.run?.reachFrom).toBeUndefined()
  const term = setup({ pending: [ho(7)], terminal: true })
  await startQueue(term.io)
  expect(term.w.reaches).toEqual([REACH_MS])
})

test('a waiting reviewer that refuses a message while holding taken PRs is not joined by a second one; main is told once', async () => {
  const a = reviewerAgent('waiting', undefined, `rv-${uid()}`)
  const { w, io } = setup({ pending: [ho(7, 'taken'), ho(8)], agents: [a] })
  w.refuse = 'not accepting messages'
  expect(await startQueue(io, 'handover')).toContain('holds taken PRs')
  expect(await startQueue(io, 'handover')).toContain('holds taken PRs')
  expect(w.spawns).toEqual([])
  expect(w.told).toHaveLength(1)
  // Its taken PR is done: nothing it holds is at risk, and a fresh reviewer starts.
  w.handovers['7'] = ho(7, 'done')
  expect(await startQueue(io)).toBe('Started reviewer reviewer-1.')
})

test('the first unreachable retry ignores an earlier short-run backoff', () => {
  const shortRuns: Breaker = { streak: 1, endedAt: 99_000, error: 'ended with no answer' }
  const r = unreachedEnd(shortRuns, 'reviewer-3', 100_000)
  expect(decide(r.breaker, 111_000)).toEqual({ kind: 'spawn' })
  // A short run after it brings the short-run backoff back.
  const short = endRun(startRun(r.breaker, 'reviewer-4', 111_000, true), { name: 'reviewer-4', now: 111_500, answer: '', reason: 'error' })
  expect(decide(short.breaker, 112_000).kind).toBe('wait')
})

test('a stale reviewer_delay deadline does not hold a handover for a busy reviewer terminal', async () => {
  const s = terminal(undefined, [toldKey(ho(7))])
  const { w, io } = setup({ pending: [ho(7), ho(8)], session: s, until: 1_000_000 + 60_000 })
  expect(await startQueue(io, 'handover')).toContain('picks it up')
  expect(w.typed).toEqual(['new handover: #8'])
  expect(w.until).toBe(0)
  expect(w.delays).toEqual([])
})

test('a reviewer terminal whose tools never reached the plugin is stopped and replaced: on its report, or REACH_MS after its start', async () => {
  const s = terminal()
  const started = startRun(EMPTY_BREAKER, s.name, 1_000_000 - 40_000, true)
  const reported = setup({ pending: [ho(7)], session: s, breaker: started, terminal: true })
  expect(await startQueue(reported.io, 'other', s.name)).toBe('Started reviewer reviewer-1.')
  expect(reported.w.stopped).toEqual([s.name])
  expect(reported.w.breaker).toMatchObject({ unreachable: 1, streak: 0, run: { name: 'reviewer-1', reached: false, reachFrom: 1_000_000 } })
  expect(reported.w.told).toHaveLength(1)
  expect(reported.w.reaches).toEqual([REACH_MS])
  // Not yet REACH_MS and no report: it is still starting up, and is told the work.
  const young = terminal()
  const early = setup({ pending: [ho(7)], session: young, breaker: startRun(EMPTY_BREAKER, young.name, 1_000_000 - 1_000, true) })
  expect(await startQueue(early.io)).toContain('picks it up')
  expect(early.w.stopped).toEqual([])
  const old = terminal()
  const late = setup({ pending: [ho(7)], session: old, breaker: startRun(EMPTY_BREAKER, old.name, 1_000_000 - REACH_MS, true) })
  expect(await startQueue(late.io)).toBe('Started reviewer reviewer-1.')
  expect(late.w.stopped).toEqual([old.name])
  // The wait counts from when its terminal started, not from when the run was recorded.
  const slow = terminal()
  const slowRun = { ...startRun(EMPTY_BREAKER, slow.name, 1_000_000 - REACH_MS, true), run: { name: slow.name, startedAt: 1_000_000 - REACH_MS, reached: false, reachFrom: 1_000_000 - 10_000 } }
  const slowStart = setup({ pending: [ho(7)], session: slow, breaker: slowRun })
  expect(await startQueue(slowStart.io)).toContain('picks it up')
  expect(slowStart.w.stopped).toEqual([])
  // One that reached the plugin is never stopped for it.
  const fine = terminal()
  const ok = setup({ pending: [ho(7)], session: fine, breaker: reachRun(startRun(EMPTY_BREAKER, fine.name, 0, true), fine.name) })
  expect(await startQueue(ok.io, 'other', fine.name)).toContain('picks it up')
  expect(ok.w.stopped).toEqual([])
})

// ---- the breaker's rules ----

const unreachedEnd = (b: Breaker, name: string, at: number) => endRun(startRun(b, name, at, true), { name, now: at + 11_000, answer: 'My flow tools fail: no tool.call hook answered this call.' })

test('an answer with no flow tool call reaching the plugin counts as unreachable, apart from the short-run streak', () => {
  const r = unreachedEnd(EMPTY_BREAKER, 'reviewer-1', 0)
  expect(r.unreachable).toBe(true)
  expect(r.breaker).toMatchObject({ streak: 0, unreachable: 1 })
  expect(r.breaker.error).toContain(UNREACHABLE_ERROR)
  // The first is replaced at once, the second waits 30s, the third halts.
  expect(decide(r.breaker, 11_000)).toEqual({ kind: 'spawn' })
  const second = unreachedEnd(r.breaker, 'reviewer-2', 20_000)
  expect(decide(second.breaker, 31_000)).toEqual({ kind: 'wait', ms: 30_000 })
  const third = unreachedEnd(second.breaker, 'reviewer-3', 70_000)
  expect(third.halted).toBe(true)
  expect(third.breaker.unreachable).toBe(HALT_AFTER)
  expect(haltContext(third.breaker.halt!.error)).toContain('ended without one flow tool call reaching the plugin')
  // A failed end (API error, no answer) never got to call a tool: it is a short run, as before.
  const failed = endRun(startRun(EMPTY_BREAKER, 'reviewer-1', 0, true), { name: 'reviewer-1', now: 500, answer: '', reason: 'error' })
  expect(failed.unreachable).toBeUndefined()
  expect(failed.breaker).toMatchObject({ streak: 1 })
  // A run that reached the plugin ends the unreachable streak; an untracked run (older state) is never unreachable.
  const reached = reachRun(startRun(second.breaker, 'reviewer-3', 70_000, true), 'reviewer-3')
  expect(reached.unreachable).toBeUndefined()
  expect(endRun(startRun(EMPTY_BREAKER, 'reviewer-1', 0), { name: 'reviewer-1', now: 40_000, answer: 'Merged #7.' }).unreachable).toBeUndefined()
})

test('a breaker file without the new fields loads, and the new fields round-trip', () => {
  expect(normalizeBreaker({ streak: 2, run: { name: 'reviewer-3', startedAt: 5 } })).toEqual({ streak: 2, run: { name: 'reviewer-3', startedAt: 5 } })
  expect(normalizeBreaker({ streak: 0, run: { name: 'r', startedAt: 5, reached: false }, unreachable: 2, unreachableTold: true }))
    .toEqual({ streak: 0, run: { name: 'r', startedAt: 5, reached: false }, unreachable: 2, unreachableTold: true })
})

test('main is told once per unreachable streak, and again after a reviewer reached the plugin', async () => {
  const { w, io } = setup()
  const breakerIo = io.breaker
  const endAs = async (name: string) => {
    w.breaker = startRun(w.breaker, name, w.now, true)
    w.now += 11_000
    await noteReviewerEnd(breakerIo, { name, answer: 'no tool.call hook answered this call' })
  }
  await endAs('reviewer-1')
  await endAs('reviewer-2')
  expect(w.told).toHaveLength(1)
  expect(w.told[0]).toContain('reviewer reviewer-1 ended, but its flow tools never reached the plugin')
  w.breaker = reachRun(startRun(w.breaker, 'reviewer-3', w.now, true), 'reviewer-3')
  w.breaker = endRun(w.breaker, { name: 'reviewer-3', now: w.now + 60_000, answer: 'Merged #7.' }).breaker
  await endAs('reviewer-4')
  expect(w.told).toHaveLength(2)
})

// ---- the plugin ----

const DIR = '/r/.git/flow'
const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const BODY = '## Verification\nRan:\n- `bun test`: pass\nExercised: ran it\nNot verified:\n- the full check'
const TMUX = { mode: 'tmux' }

function world(on: On) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const agents: AgentInfo[] = [{ id: 'm1', name: 'csv-export', description: 'm', type: 'flow:manager', status: 'running' }]
  const files = new Map<string, string>()
  const spawns: string[] = []
  const sent: { to: unknown; text: string }[] = []
  const prompts: string[] = []
  const runs: string[][] = []
  const state = { refuse: false, ownerAlive: true }
  on('agent.list', () => ({ value: agents }))
  on('session.start', () => ({ cwd: '/r' }))
  on('session.id', () => ({ value: 'me' }) as never)
  on('command.register', () => ({ value: undefined } as never))
  on('tool.register', () => ({ value: undefined } as never))
  on('agent.register', (_, e) => ({ value: { agent: (e as unknown as { name: string }).name } }))
  on('agent.spawn', (_, e) => {
    const input = e as unknown as { subagentType?: string; subagent_type?: string; name?: string; description: string }
    const id = `r${spawns.length + 1}`
    spawns.push(input.name ?? '')
    agents.push({ id, name: input.name, description: input.description, type: input.subagentType ?? input.subagent_type ?? '', status: 'running' })
    return { model: 'sonnet', agentId: id }
  })
  on('session.send', (_, e) => {
    const x = e as unknown as { to: unknown; text: string }
    sent.push({ to: x.to, text: x.text })
    return state.refuse ? { isDelivered: false as const, reason: 'refused' } as never : { isDelivered: true as const }
  })
  on('prompt.submit', (_, e) => { prompts.push(e.text); return { text: e.text } })
  on('turn.complete', (_, e) => ({ text: e.answer }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.exists', (_, e) => ({ value: files.has((e as unknown as { path: string }).path) }))
  on('fs.stat', (_, e) => {
    if (!files.has((e as unknown as { path: string }).path)) throw new Error('ENOENT')
    return { value: { kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false } }
  })
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('fs.read', (_, e) => {
    const t = files.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('fs.list', (_, e) => ({ value: [...files.keys()].filter(k => k.startsWith(`${e.path}/`)).map(k => ({ name: k.slice(e.path.length + 1), isDirectory: false })) }) as never)
  on('process.run', (_, e) => {
    const a = [...e.argv]
    runs.push(a)
    const cmd = a.join(' ')
    if (a[0] === 'git' && a[1] === 'rev-parse' && a.includes('--git-common-dir')) return ok('/r/.git\n')
    if (cmd === 'git worktree list --porcelain') return ok('worktree /r\nHEAD abc\nbranch refs/heads/main\n')
    if (cmd === 'orca status') return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (cmd === 'tmux -V') return ok('tmux 3.4')
    if (cmd.startsWith('tmux display-message')) return ok('claude\n')
    if (cmd.startsWith('tmux capture-pane')) return ok('')
    // This main's identity: session "me", its claude process pid 200.
    if (cmd === 'sh -c echo $PPID') return ok('200\n')
    if (a[0] === 'ps' && a.at(-1) === '200') return ok('1 claude\n')
    if (a[0] === 'kill' && a[1] === '-0') return state.ownerAlive ? ok() : { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (a[0] === 'mv') {
      const t = files.get(a[1] ?? '')
      if (t !== undefined) { files.set(a[2] ?? '', t); files.delete(a[1] ?? '') }
    }
    if (a[0] === 'gh' && a[1] === 'pr' && a[2] === 'view') {
      const n = Number(a[3])
      return ok(JSON.stringify({ state: 'OPEN', isDraft: false, headRefOid: `h${n}`, headRefName: `flow/b${n}`, title: `Title ${n}`, body: BODY, labels: [] }))
    }
    return ok()
  })
  return { agents, files, spawns, sent, prompts, runs, clock, state }
}

type W = ReturnType<typeof world>
const handover = ($: Dollar, pr: number) => $.tool.call({ tool: 'mcp__flow__handover', pr, agentId: 'm1' } as never).then(r => String(r.result))
const start = ($: Dollar) => ($ as never as { session: { start: (e: unknown) => Promise<unknown> } }).session.start({ cwd: '/r', surface: null, isInteractive: false })
const stored = (w: W, name: string) => JSON.parse(w.files.get(`${DIR}/${name}.json`) ?? 'null')
const newSessions = (w: W) => w.runs.filter(a => a[0] === 'tmux' && a[1] === 'new-session').map(a => a[a.indexOf('-s') + 1])
const killed = (w: W) => w.runs.filter(a => a[0] === 'tmux' && a[1] === 'kill-session').map(a => a.at(-1))
const notices = (w: W) => w.prompts.filter(t => t.includes('never reached the plugin'))

// The agent `id` answers after 11s without one flow tool call, as the 0.6.103 reviewers did.
async function endUnreached($: Dollar, w: W, id: string) {
  await w.clock.advance(11_000)
  w.agents.find(a => a.id === id)!.status = 'completed'
  await $.turn.complete({ answer: 'My mcp__flow__ tools fail: no tool.call hook answered this call.', agentId: id, durationMs: 11_000, isAborted: false, turnId: `t-${id}`, reason: 'answer' } as never)
  await w.clock.settle()
}

test('agent mode: a pending handover reaches a reviewer held on background work', async ($, on) => {
  const w = world(on)
  await start($)
  expect(await handover($, 7)).toContain('Started reviewer reviewer-1')
  w.agents.find(a => a.id === 'r1')!.status = 'waiting'
  // #7 was in its spawn prompt: only #8 is sent.
  expect(await handover($, 8)).toContain('The waiting reviewer reviewer-1 was told: #8.')
  expect(w.sent.filter(s => JSON.stringify(s.to).includes('r1'))).toHaveLength(1)
  expect(await handover($, 8)).toContain('already been told')
  // Refused: a fresh reviewer starts rather than leave the PRs waiting.
  w.state.refuse = true
  await $.tool.call({ tool: 'mcp__flow__handover', pr: 9, agentId: 'm1' } as never)
  expect(w.spawns).toEqual(['reviewer-1', 'reviewer-2'])
})

test('agent mode: reviewers whose tools never reach the plugin are reported once and replaced, then halt', async ($, on) => {
  const w = world(on)
  await start($)
  await handover($, 7)
  await endUnreached($, w, 'r1')
  await w.clock.advance(1_000); await w.clock.settle()
  expect(notices(w)).toHaveLength(1)
  expect(notices(w)[0]).toContain('reviewer reviewer-1 ended')
  // Replaced at once with a fresh reviewer.
  expect(w.spawns).toEqual(['reviewer-1', 'reviewer-2'])
  expect(stored(w, 'reviewer-breaker')).toMatchObject({ streak: 0, unreachable: 1 })
  await endUnreached($, w, 'r2')
  await w.clock.advance(1_000); await w.clock.settle()
  expect(notices(w)).toHaveLength(1)
  expect(w.spawns).toHaveLength(2)
  await w.clock.advance(30_000); await w.clock.settle()
  expect(w.spawns).toHaveLength(3)
  await endUnreached($, w, 'r3')
  expect(stored(w, 'reviewer-breaker').halt?.error).toContain(UNREACHABLE_ERROR)
  await w.clock.advance(20 * 60_000); await w.clock.settle()
  expect(w.spawns).toHaveLength(3)
})

test('agent mode: a reviewer that called a flow tool ends normally', async ($, on) => {
  const w = world(on)
  await start($)
  await handover($, 7)
  await $.tool.call({ tool: 'mcp__flow__reviewer', action: 'list', agentId: 'r1' } as never)
  expect(stored(w, 'reviewer-breaker').run).toMatchObject({ name: 'reviewer-1', reached: true })
  await w.clock.advance(40_000)
  w.agents.find(a => a.id === 'r1')!.status = 'completed'
  await $.turn.complete({ answer: 'Nothing merged.', agentId: 'r1', durationMs: 40_000, isAborted: false, turnId: 't-r1', reason: 'answer' } as never)
  await w.clock.settle()
  expect(stored(w, 'reviewer-breaker')).toMatchObject({ streak: 0 })
  expect(stored(w, 'reviewer-breaker').unreachable).toBeUndefined()
  expect(notices(w)).toEqual([])
})

test('terminal mode: a reviewer terminal that relays no call within REACH_MS is stopped and a fresh one starts', { options: TMUX }, async ($, on) => {
  const w = world(on)
  await start($)
  await handover($, 7)
  expect(newSessions(w)).toEqual(['flow-reviewer-1'])
  await w.clock.advance(REACH_MS); await w.clock.settle()
  expect(killed(w)).toEqual(['flow-reviewer-1'])
  expect(newSessions(w)).toEqual(['flow-reviewer-1', 'flow-reviewer-2'])
  expect(notices(w)).toHaveLength(1)
  // reviewer-2 reaches the plugin: it is left alone past REACH_MS.
  await $.tool.call({ tool: 'mcp__flow__reviewer', action: 'list', agentId: 'session:reviewer-2' } as never)
  await w.clock.advance(REACH_MS); await w.clock.settle()
  expect(killed(w)).toEqual(['flow-reviewer-1'])
  expect(stored(w, 'reviewer-breaker')).toMatchObject({ run: { name: 'reviewer-2', reached: true } })
})

test('terminal mode: another main\'s live reviewer terminal is not this main\'s reviewer', { options: TMUX }, async ($, on) => {
  const w = world(on)
  const theirs = { name: 'reviewer-9', harness: 'claude', host: 'tmux', handle: 'flow-reviewer-9', worktree: '/r/.claude/worktrees/reviewer-9', branch: 'b', promptFile: 'p', reportFile: 'f', start: 'claude', owner: 'main', ownerName: 'main', status: 'running', startedAt: 999_000, role: 'reviewer', mainOwner: { session: 'other', pid: 4242 } }
  w.files.set(`${DIR}/sessions.json`, JSON.stringify({ 'reviewer-9': theirs }))
  await start($)
  await w.clock.settle()
  expect(await handover($, 7)).toContain('Started reviewer reviewer-1')
  expect(newSessions(w)).toEqual(['flow-reviewer-1'])
  expect(w.runs.filter(a => a[0] === 'tmux' && a[1] === 'set-buffer' && a.includes('flow-reviewer-9'))).toEqual([])
})
