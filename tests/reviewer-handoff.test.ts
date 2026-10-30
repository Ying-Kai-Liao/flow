import type { AgentInfo } from 'claude-code'
import { expect, mock } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { Breaker, Handover, Session } from '../types'
import { mirror } from '../hooks/core'
import { EMPTY_BREAKER, endRun, HANDED_OFF_KEPT, markHandedOff, normalizeBreaker, SHORT_RUN_MS, startRun } from '../hooks/reviewer-breaker'
import { atHandoffPoint, HANDED_OFF_LIST, reviewerToolRun, startQueue } from '../hooks/reviewer-run'
import type { BreakerIo, QueueIo, ReviewerIo } from '../hooks/reviewer-run'
import { onRoleReportTo } from '../hooks/role-session-run'
import type { RoleIo } from '../hooks/role-session-run'
import { settingsOf } from '../hooks/settings'
import { test } from './support'

// Issue #236: after a batch with nothing pending, a reviewer past reviewer_handoff ends, and a fresh one takes the next
// handover. The end is planned: the breaker never counts it as a short, failed or unreachable run.

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const ho = (pr: number, status = 'pending', at = 1): Handover => ({ pr, at, status, branch: `flow/b${pr}`, reportTo: 'm', title: `T${pr}` } as unknown as Handover)
type Batch = Parameters<typeof atHandoffPoint>[1]
const batchIn = (state: 'ready' | 'pushing' | 'rebuilding') => ({ id: 'b1', state, prs: [1] }) as unknown as Batch

// ---- the pure rules ----

test('a handed-off run ends as planned: no streak, no error, no halt, however short or failed its end', () => {
  const started = startRun({ streak: 2 }, 'reviewer-3', 0, true)
  const told = markHandedOff(started, 'reviewer-3').breaker
  for (const end of [{ answer: 'merged #7' }, { answer: '' }, { answer: '', reason: 'error' }]) {
    const r = endRun(told, { name: 'reviewer-3', now: SHORT_RUN_MS - 1, ...end })
    expect(r.halted).toBe(false)
    expect(r.unreachable).toBeUndefined()
    expect(r.breaker).toMatchObject({ streak: 0, endedAt: SHORT_RUN_MS - 1 })
    expect(r.breaker.run).toBeUndefined()
    expect(r.breaker.error).toBeUndefined()
  }
  // Not handed off: the same short end counts as before.
  expect(endRun(started, { name: 'reviewer-3', now: 500, answer: 'hi' }).breaker.streak).toBeGreaterThan(0)
})

test('the handoff is marked once per reviewer; old breaker state reads without it, and the list is kept short', () => {
  const once = markHandedOff(EMPTY_BREAKER, 'reviewer-1')
  expect(once.marked).toBe(true)
  expect(markHandedOff(once.breaker, 'reviewer-1')).toEqual({ breaker: once.breaker, marked: false })
  expect(normalizeBreaker({ streak: 1 }).handedOff).toBeUndefined()
  expect(normalizeBreaker({ streak: 0, handedOff: ['reviewer-1', 3, null, 'reviewer-2'] }).handedOff).toEqual(['reviewer-1', 'reviewer-2'])
  let b: Breaker = EMPTY_BREAKER
  for (let i = 1; i <= HANDED_OFF_KEPT + 2; i++) b = markHandedOff(b, `reviewer-${i}`).breaker
  expect(b.handedOff).toHaveLength(HANDED_OFF_KEPT)
  expect(b.handedOff?.at(-1)).toBe(`reviewer-${HANDED_OFF_KEPT + 2}`)
})

test('the handoff point: nothing taken, no push or rebuild run, no handover pending; a batch awaiting /flow push does not hold it', () => {
  expect(atHandoffPoint([ho(1, 'done'), ho(2, 'returned')], undefined)).toBe(true)
  expect(atHandoffPoint([ho(1, 'done'), ho(2, 'pending')], undefined)).toBe(false)
  expect(atHandoffPoint([ho(1, 'taken')], undefined)).toBe(false)
  expect(atHandoffPoint([], batchIn('pushing'))).toBe(false)
  expect(atHandoffPoint([], batchIn('rebuilding'))).toBe(false)
  expect(atHandoffPoint([ho(1, 'ready'), ho(2, 'pending')], batchIn('ready'))).toBe(true)
})

test('reviewer_handoff defaults to 50 percent; 0 turns it off; out-of-range values clamp', () => {
  expect(settingsOf({}, 'main').reviewerHandoff).toBe(50)
  expect(settingsOf({ reviewer_handoff: 0 }, 'main').reviewerHandoff).toBe(0)
  expect(settingsOf({ reviewer_handoff: 70 }, 'main').reviewerHandoff).toBe(70)
  expect(settingsOf({ reviewer_handoff: -5 }, 'main').reviewerHandoff).toBe(0)
  expect(settingsOf({ reviewer_handoff: 140 }, 'main').reviewerHandoff).toBe(100)
})

// ---- reviewerToolRun's done and back against a fake ReviewerIo ----

function breakerOf(w: { breaker: Breaker }): BreakerIo {
  return {
    stateDir: async () => undefined,
    readJson: async () => undefined,
    writeJson: async () => undefined,
    mkdir: async () => undefined,
    get: async () => w.breaker,
    set: async b => { w.breaker = b },
    now: async () => 1_000_000,
    withInbox: async fn => fn({ next: 1, items: [] } as never).out,
    toast: () => undefined,
  }
}

function toolWorld(init: { handovers: Handover[]; percent?: number; batch?: Batch }) {
  const w = {
    handovers: Object.fromEntries(init.handovers.map(h => [String(h.pr), h])) as Record<string, Handover>,
    batch: init.batch,
    percent: init.percent,
    breaker: EMPTY_BREAKER as Breaker,
    toasts: [] as string[],
  }
  const io: ReviewerIo = {
    reconcile: async () => undefined,
    run: async () => ({ exitCode: 1, stdout: '', stderr: 'no git here' }),
    handovers: async () => w.handovers,
    putHandover: async (pr, h) => { w.handovers[pr] = h },
    batch: async () => w.batch,
    deploys: async () => ({ targets: {} }) as never,
    inbox: async () => ({ next: 1, items: [] }) as never,
    flaky: async () => undefined,
    noteRunWork: async () => undefined,
    recordReady: async () => '',
    best: async (_what, fn) => { await fn() },
    saveHandover: async () => undefined,
    appendLog: async () => undefined,
    toast: text => { w.toasts.push(text) },
    refresh: async () => [],
    closeReturnedEnv: async () => undefined,
    settleBatch: async () => undefined,
    autoSweep: () => undefined,
    withCost: async (_b, report) => report,
    captureChecks: async () => [],
    suggestGuardTests: async () => '',
    sizeBackNote: async () => undefined,
    handoff: {
      name: async id => (id.startsWith('session:') ? id.slice('session:'.length) : id === 'r1' ? 'reviewer-1' : undefined),
      percent: async () => w.percent,
      breaker: breakerOf(w),
    },
  }
  return { w, io }
}

const settings = (reviewer_handoff?: number) => settingsOf(reviewer_handoff === undefined ? {} : { reviewer_handoff }, 'main')
const back = (io: ReviewerIo, pr: number, agentId = 'r1', s = settings()) => reviewerToolRun(io, s, { action: 'back', pr, reason: 'tests fail' }, agentId).then(r => r.result)

test('past the threshold at the end of a batch with nothing pending: told once to end, and the breaker remembers it', async () => {
  const { w, io } = toolWorld({ handovers: [ho(7, 'taken'), ho(8, 'taken')], percent: 62 })
  // Mid-batch (#8 still taken): not told.
  expect(await back(io, 7)).not.toContain('HAND OFF')
  const last = await back(io, 8)
  expect(last).toContain('flow: HAND OFF: your context is at 62% (past the reviewer_handoff 50%)')
  expect(last).toContain('end with your final report now')
  expect(w.breaker.handedOff).toEqual(['reviewer-1'])
  expect(w.toasts.some(t => t.includes('handing off'))).toBe(true)
  // Once per run: a later done or back says nothing more.
  w.handovers['9'] = ho(9, 'taken')
  expect(await back(io, 9)).not.toContain('HAND OFF')
  // Its next list takes no new work.
  w.handovers['10'] = ho(10)
  expect((await reviewerToolRun(io, settings(), { action: 'list' }, 'r1')).result).toBe(HANDED_OFF_LIST)
})

test('pending handovers, a push run, a lower context share or reviewer_handoff 0 keep the reviewer working', async () => {
  const pending = toolWorld({ handovers: [ho(7, 'taken'), ho(8)], percent: 90 })
  expect(await back(pending.io, 7)).not.toContain('HAND OFF')
  expect(pending.w.breaker.handedOff).toBeUndefined()
  // The next point with none pending hands it off.
  pending.w.handovers['8'] = ho(8, 'taken')
  expect(await back(pending.io, 8)).toContain('HAND OFF')

  const pushing = toolWorld({ handovers: [ho(7, 'taken')], percent: 90, batch: batchIn('pushing') })
  expect(await back(pushing.io, 7)).not.toContain('HAND OFF')
  const low = toolWorld({ handovers: [ho(7, 'taken')], percent: 49 })
  expect(await back(low.io, 7)).not.toContain('HAND OFF')
  const unknown = toolWorld({ handovers: [ho(7, 'taken')] })
  expect(await back(unknown.io, 7)).not.toContain('HAND OFF')
  const off = toolWorld({ handovers: [ho(7, 'taken')], percent: 99 })
  expect(await back(off.io, 7, 'r1', settings(0))).not.toContain('HAND OFF')
  // A list before any handoff answers as always.
  expect((await reviewerToolRun(off.io, settings(), { action: 'list' }, 'r1')).result).not.toBe(HANDED_OFF_LIST)
})

test('a terminal reviewer is told to write its report and wait for the plugin to stop it', async () => {
  const { w, io } = toolWorld({ handovers: [ho(7, 'taken')], percent: 55 })
  const out = await back(io, 7, 'session:rv-1')
  expect(out).toContain('write your final report to your report file')
  expect(out).toContain('the plugin then stops this session')
  expect(w.breaker.handedOff).toEqual(['rv-1'])
})

// ---- startQueue: who gets the next handover ----

function queueWorld(init: { pending: Handover[]; agents?: { id?: string; name?: string; type: string; status: string }[]; session?: Session; breaker: Breaker }) {
  mirror.deployInfos = []
  const w = {
    handovers: Object.fromEntries(init.pending.map(h => [String(h.pr), h])) as Record<string, Handover>,
    agents: init.agents ?? [],
    session: init.session,
    breaker: init.breaker,
    spawns: [] as string[],
    typed: [] as string[],
    sent: [] as string[],
  }
  const io: QueueIo = {
    agents: async () => w.agents,
    batch: async () => undefined,
    handovers: async () => w.handovers,
    deploys: async () => ({ targets: {} }) as never,
    runs: async () => 4 + w.spawns.length,
    setRuns: async () => undefined,
    spawn: async input => { w.spawns.push(input.name); return {} },
    reviewerSession: async () => w.session,
    nudge: async (_s, text) => { w.typed.push(text); return undefined },
    setTold: async () => undefined,
    tell: async (_id, text) => { w.sent.push(text); return undefined },
    breaker: breakerOf(w),
    wait: () => undefined,
  }
  return { w, io }
}

const told = (name: string): Breaker => ({ streak: 0, handedOff: [name] })

test('a handed-off reviewer agent still finishing holds the start; once it only waits on background work, a fresh one starts', async () => {
  const running = queueWorld({ pending: [ho(9)], agents: [{ id: 'r1', name: 'reviewer-1', type: 'flow:reviewer', status: 'running' }], breaker: told('reviewer-1') })
  expect(await startQueue(running.io, 'handover')).toBe('The reviewer reviewer-1 is handing off; a fresh reviewer starts when it ends.')
  expect(running.w.spawns).toEqual([])
  const waiting = queueWorld({ pending: [ho(9)], agents: [{ id: 'r1', name: 'reviewer-1', type: 'flow:reviewer', status: 'waiting' }], breaker: told('reviewer-1') })
  expect(await startQueue(waiting.io, 'handover')).toBe('Started reviewer reviewer-5.')
  // It is never messaged about the new handover.
  expect(waiting.w.sent).toEqual([])
  expect(waiting.w.spawns).toEqual(['reviewer-5'])
})

test('a handed-off reviewer terminal is typed nothing; its report stops it and starts the next one', async () => {
  const s = { name: 'rv-1', host: 'tmux', nudged: [] } as unknown as Session
  const { w, io } = queueWorld({ pending: [ho(9)], session: s, breaker: told('rv-1') })
  expect(await startQueue(io, 'handover')).toBe('The reviewer rv-1 is handing off; a fresh reviewer starts after its report.')
  expect(w.typed).toEqual([])
  expect(w.spawns).toEqual([])
})

test('the report of a handed-off reviewer terminal stops its session and ends its run, even in merge_mode auto', async () => {
  const calls: string[] = []
  const io = {
    batchReady: async () => false,
    heldMergeMode: () => 'auto',
    heldSettings: () => true,
    handedOff: async (name: string) => name === 'rv-1',
    best: async (_what: string, fn: () => Promise<void>) => { await fn() },
    stopTerminal: async (name: string) => { calls.push(`stop ${name}`) },
    reviewerRan: async (_id: string, name: string, _end: unknown, ended: boolean) => { calls.push(`ran ${name} ended=${ended}`) },
  } as unknown as RoleIo
  await onRoleReportTo(io, { name: 'rv-1', role: 'reviewer' } as unknown as Session, 'merged #7')
  expect(calls).toEqual(['stop rv-1', 'ran rv-1 ended=true'])
  calls.length = 0
  await onRoleReportTo(io, { name: 'rv-2', role: 'reviewer' } as unknown as Session, 'merged #8')
  expect(calls).toEqual(['ran rv-2 ended=false'])
})

// ---- the plugin, agent mode ----

const DIR = '/r/.git/flow'
const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const BODY = '## Verification\nRan:\n- `bun test`: pass\nExercised: ran it\nNot verified:\n- the full check'

function world(on: On, tokens: number) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const agents: AgentInfo[] = [{ id: 'm1', name: 'csv-export', description: 'm', type: 'flow:manager', status: 'running' }]
  const files = new Map<string, string>()
  const spawns: string[] = []
  const sent: { to: unknown; text: string }[] = []
  on('agent.list', () => ({ value: agents }))
  on('session.start', () => ({ cwd: '/r' }))
  on('command.register', () => ({ value: undefined } as never))
  on('tool.register', () => ({ value: undefined } as never))
  on('fs.stat', () => { throw new Error('ENOENT') })
  on('agent.register', (_, e) => ({ value: { agent: (e as unknown as { name: string }).name } }))
  on('agent.spawn', (_, e) => {
    const input = e as unknown as { subagent_type?: string; subagentType?: string; name?: string; description: string }
    const id = `r${spawns.length + 1}`
    spawns.push(input.name ?? '')
    agents.push({ id, name: input.name, description: input.description, type: input.subagent_type ?? input.subagentType ?? '', status: 'running' })
    return { model: 'sonnet', agentId: id }
  })
  on('session.send', (_, e) => { sent.push(e as never); return { isDelivered: true as const } })
  on('turn.step', async function* () {
    return { turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: { model: 'claude-sonnet-4', input_tokens: tokens, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', (_, e) => ({ text: e.answer }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.exists', (_, e) => ({ value: files.has((e as unknown as { path: string }).path) }))
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('fs.read', (_, e) => {
    const t = files.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('fs.list', (_, e) => ({ value: [...files.keys()].filter(k => k.startsWith(`${e.path}/`)).map(k => ({ name: k.slice(e.path.length + 1), isDirectory: false })) }) as never)
  on('process.run', (_, e) => {
    const a = e.argv
    if (a[0] === 'git' && a[1] === 'rev-parse' && a.includes('--git-common-dir')) return ok('/r/.git\n')
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
  return { agents, files, spawns, sent, clock }
}

const start = ($: Dollar) => ($ as never as { session: { start: (e: unknown) => Promise<unknown> } }).session.start({ cwd: '/r', surface: null, isInteractive: false })
const handover = ($: Dollar, pr: number) => $.tool.call({ tool: 'mcp__flow__handover', pr, agentId: 'm1' } as never).then(r => String(r.result))
const reviewer = ($: Dollar, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__flow__reviewer', agentId: 'r1', ...input } as never).then(r => String(r.result))
const step = async ($: Dollar, agentId: string) => {
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'sonnet', messageCount: 1, agentId } as never)
  for await (const chunk of stream) void chunk
  return stream.result
}
const stored = (w: ReturnType<typeof world>, name: string) => JSON.parse(w.files.get(`${DIR}/${name}.json`) ?? 'null')

test('agent mode: the reviewer past its handoff point ends; a handover during its end waits; its end starts one fresh reviewer and the breaker stays clean', async ($, on) => {
  // 120k of a 200k window: 60%, past the default 50.
  const w = world(on, 120_000)
  await start($)
  expect(await handover($, 7)).toContain('Started reviewer reviewer-1')
  await step($, 'r1')
  expect(await reviewer($, { action: 'take', pr: 7 })).toContain('PR #7: taken')
  const out = await reviewer($, { action: 'back', pr: 7, reason: 'tests fail' })
  expect(out).toContain('flow: HAND OFF: your context is at 60%')
  expect(stored(w, 'reviewer-breaker').handedOff).toEqual(['reviewer-1'])
  // A handover while it finishes: it is not messaged and no second reviewer starts beside it.
  expect(await handover($, 8)).toContain('reviewer-1 is handing off')
  expect(await reviewer($, { action: 'list' })).toBe(HANDED_OFF_LIST)
  expect(w.spawns).toEqual(['reviewer-1'])
  // It ends at once (well inside the short-run window): planned, so no backoff, and the next tool call starts one.
  w.agents.find(a => a.id === 'r1')!.status = 'completed'
  await $.turn.complete({ answer: 'PR #7 returned. Handing off.', agentId: 'r1', durationMs: 5, isAborted: false, turnId: 't-r1', reason: 'answer' } as never)
  await w.clock.settle()
  await $.tool.call({ tool: 'mcp__flow__status' } as never)
  await w.clock.settle()
  expect(w.spawns).toEqual(['reviewer-1', 'reviewer-2'])
  const b = stored(w, 'reviewer-breaker')
  expect(b.streak).toBe(0)
  expect(b.error).toBeUndefined()
  expect(b.halt).toBeUndefined()
  expect(w.sent.some(m => m.text.includes('Pending handovers'))).toBe(false)
})

test('agent mode: under the threshold the reviewer gets no handoff line', async ($, on) => {
  const w = world(on, 60_000)
  await start($)
  await handover($, 7)
  await step($, 'r1')
  await reviewer($, { action: 'take', pr: 7 })
  expect(await reviewer($, { action: 'back', pr: 7, reason: 'tests fail' })).not.toContain('HAND OFF')
  expect(stored(w, 'reviewer-breaker').handedOff).toBeUndefined()
})
