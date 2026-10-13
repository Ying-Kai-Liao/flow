import type { AgentInfo } from 'claude-code'
import { expect, mock } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { Breaker, Question } from '../types'
import { EMPTY_INBOX, needsMessage, protectedWhy } from '../hooks/inbox'
import {
  BACKOFF_MS, breakerLine, CAP_ERROR, clearHalt, decide, delayFor, EMPTY_BREAKER, endRun, errorText, HALT_AFTER, HOUR_MS, MAX_STARTS_PER_HOUR, normalizeBreaker,
  openHaltItem, SHORT_RUN_MS, startRun,
} from '../hooks/reviewer-breaker'
import { test } from './support'
import { matchRule, parseRules, suggest } from '../hooks/standing'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

// ---- pure half ----

// Starts the run `name` at `at` and ends it `lived` ms later.
function run(b: Breaker, name: string, at: number, lived: number, answer = '', extra: { reason?: string; status?: string } = {}) {
  return endRun(startRun(b, name, at), { name, now: at + lived, answer, ...extra })
}

test('short-lived reviewers escalate the wait: 30s, 1m, 2m, then the 5m cap', () => {
  expect(BACKOFF_MS).toEqual([30_000, 60_000, 120_000, 300_000])
  expect([1, 2, 3, 4, 5, 9].map(delayFor)).toEqual([30_000, 60_000, 120_000, 300_000, 300_000, 300_000])
  let b: Breaker = EMPTY_BREAKER
  expect(decide(b, 0)).toEqual({ kind: 'spawn' })
  b = run(b, 'reviewer-1', 0, 500).breaker
  expect(b).toMatchObject({ streak: 1, endedAt: 500 })
  expect(decide(b, 1_000)).toEqual({ kind: 'wait', ms: 29_500 })
  expect(decide(b, 30_500)).toEqual({ kind: 'spawn' })
  b = run(b, 'reviewer-2', 31_000, 500).breaker
  expect(decide(b, 32_000)).toEqual({ kind: 'wait', ms: 59_500 })
})

test('a non-empty answer that came too soon still counts as short-lived', () => {
  const r = run(EMPTY_BREAKER, 'reviewer-1', 0, SHORT_RUN_MS - 1, 'Nothing to do.')
  expect(r.breaker.streak).toBe(1)
  expect(r.breaker.error).toContain('Nothing to do.')
})

test('a long, successful run resets the counter and the wait', () => {
  let b = run(run(EMPTY_BREAKER, 'reviewer-1', 0, 100).breaker, 'reviewer-2', 40_000, 100).breaker
  expect(b.streak).toBe(2)
  b = run(b, 'reviewer-3', 200_000, SHORT_RUN_MS, 'Merged #7.').breaker
  expect(b).toMatchObject({ streak: 0 })
  expect(b.error).toBeUndefined()
  expect(decide(b, b.endedAt!)).toEqual({ kind: 'spawn' })
})

test('a long run that failed counts once, not as a streak', () => {
  const b = run({ streak: 2 }, 'reviewer-5', 0, 10 * 60_000, '').breaker
  expect(b.streak).toBe(1)
  expect(b.halt).toBeUndefined()
})

test('the third short run in a row halts; decide says halt until it is cleared', () => {
  let b: Breaker = EMPTY_BREAKER
  let halted = false
  for (let i = 1; i <= HALT_AFTER; i++) {
    const r = run(b, `reviewer-${i}`, i * 100_000, 800)
    b = r.breaker
    halted = r.halted
  }
  expect(halted).toBe(true)
  expect(b.halt?.error).toContain('no answer')
  expect(decide(b, 10_000_000)).toEqual({ kind: 'halt' })
  expect(breakerLine(b, 0)).toContain('Reviewer halted')
})

test('retry clears the halt and the wait but keeps the history, so one more failure halts again', () => {
  let b: Breaker = EMPTY_BREAKER
  for (let i = 1; i <= HALT_AFTER; i++) b = run(b, `reviewer-${i}`, i * 100_000, 800).breaker
  const cleared = clearHalt(b)
  expect(cleared.halt).toBeUndefined()
  expect(cleared.endedAt).toBeUndefined()
  expect(cleared.streak).toBe(HALT_AFTER - 1)
  expect(decide(cleared, 1_000_000)).toEqual({ kind: 'spawn' })
  expect(run(cleared, 'reviewer-9', 1_000_000, 800).halted).toBe(true)
})

test('only the run the plugin started counts, and only once', () => {
  const started = startRun(EMPTY_BREAKER, 'reviewer-1', 0)
  expect(endRun(started, { name: 'reviewer-7', now: 5, answer: '' }).breaker).toBe(started)
  const once = endRun(started, { name: 'reviewer-1', now: 5, answer: '' }).breaker
  expect(endRun(once, { name: 'reviewer-1', now: 6, answer: '' }).breaker).toBe(once)
})

test('the hourly start cap: 20 starts within an hour stop the next one; starts older than an hour do not count; retry keeps the history', () => {
  // Healthy runs, so only the cap can stop them.
  let b: Breaker = EMPTY_BREAKER
  for (let i = 0; i < MAX_STARTS_PER_HOUR - 1; i++) b = run(b, `reviewer-${i}`, i * 60_000, 40_000, 'Merged.').breaker
  expect(decide(b, 25 * 60_000)).toEqual({ kind: 'spawn' })
  b = run(b, 'reviewer-last', 19 * 60_000, 40_000, 'Merged.').breaker
  expect(b.starts).toHaveLength(MAX_STARTS_PER_HOUR)
  expect(decide(b, 25 * 60_000)).toEqual({ kind: 'cap' })
  // The first start leaves the hour: the cap lifts.
  expect(decide(b, HOUR_MS + 1)).toEqual({ kind: 'spawn' })
  // A halt from the cap is cleared by retry, but the starts stay, so it holds until the hour moves on.
  const halted = { ...b, halt: { at: 25 * 60_000, error: CAP_ERROR } }
  const cleared = clearHalt(halted)
  expect(cleared.halt).toBeUndefined()
  expect(cleared.starts).toEqual(b.starts)
  expect(decide(cleared, 26 * 60_000)).toEqual({ kind: 'cap' })
  // Old entries are pruned when a new start is recorded.
  expect(startRun(b, 'reviewer-x', 3 * HOUR_MS).starts).toEqual([3 * HOUR_MS])
})

test('the error text comes from the answer when the host failed the run, else a plain description', () => {
  expect(errorText({ name: 'r', now: 0, answer: 'Agent terminated early due to an API error: weekly limit\nmore', status: 'failed' })).toBe('Agent terminated early due to an API error: weekly limit')
  expect(errorText({ name: 'r', now: 0, answer: '', reason: 'error' })).toContain('API error')
  expect(errorText({ name: 'r', now: 0, answer: '', status: 'failed' })).toContain('failed')
  expect(errorText({ name: 'r', now: 0, answer: '  ' })).toContain('no answer')
})

test('state from before the breaker, or damaged, is an empty history', () => {
  expect(normalizeBreaker(undefined)).toEqual(EMPTY_BREAKER)
  expect(normalizeBreaker('x')).toEqual(EMPTY_BREAKER)
  expect(normalizeBreaker({ streak: 'many', halt: { at: 'now' } })).toEqual(EMPTY_BREAKER)
  expect(normalizeBreaker({ streak: 2, endedAt: 5, error: 'e', starts: [1, 'x', 2], halt: { at: 6, error: 'h', qid: 'q1' } })).toEqual({ streak: 2, endedAt: 5, error: 'e', starts: [1, 2], halt: { at: 6, error: 'h', qid: 'q1' } })
})

test('the halt item is blocking for main, never messages an asker, is protected and is never answered by a rule', () => {
  const { q } = openHaltItem(EMPTY_INBOX, 'weekly limit', 10)
  expect(q).toMatchObject({ id: 'q1', owner: 'reviewer', addressee: 'main', blocking: true, kind: 'reviewer', options: ['retry', 'not now'], default: 'not now' })
  expect(q.context).toContain('weekly limit')
  expect(openHaltItem(EMPTY_INBOX, CAP_ERROR, 10).q.context).toContain('hourly start cap')
  expect(needsMessage(q, false)).toBe(false)
  expect(protectedWhy(q)).toContain('a reviewer retry')
  const any = parseRules([{ match: 'reviewer', answer: 'retry', blocking: true }], 'personal', 'f', [])
  const named = parseRules([{ match: 'reviewer', answer: 'retry', blocking: true, kinds: ['reviewer'] }], 'personal', 'f', [])
  const dflt = parseRules([{ match: 'reviewer', answer: 'default' }], 'personal', 'f', [])
  for (const rules of [any, named, dflt]) expect(matchRule(rules, q)).toBeUndefined()
  const answered = { next: 5, items: [1, 2, 3].map(i => ({ ...q, id: `q${i}`, state: 'answered' as const, answer: 'retry', answeredBy: 'main' } as Question)) }
  expect(suggest(answered, [])).toEqual([])
})

// ---- the plugin ----

const DIR = '/r/.git/flow'
const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const BODY = '## Verification\nRan:\n- `bun test`: pass\nExercised: ran it\nNot verified:\n- the full check'

function world(on: On) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const agents: AgentInfo[] = [{ id: 'm1', name: 'csv-export', description: 'm', type: 'flow:manager', status: 'running' }]
  const files = new Map<string, string>()
  const spawns: { name: string | undefined; prompt: string }[] = []
  const toasts: string[] = []
  // A test can hold spawn() open and have the new reviewer already dead in the roster.
  const hold: { gate?: Promise<void>; status?: AgentInfo['status'] } = {}
  on('agent.list', () => ({ value: agents }))
  on('session.start', () => ({ cwd: '/r' }))
  on('command.register', () => ({ value: undefined } as never))
  on('tool.register', () => ({ value: undefined } as never))
  on('fs.stat', () => { throw new Error('ENOENT') })
  on('agent.register', (_, e) => ({ value: { agent: (e as unknown as { name: string }).name } }))
  on('agent.spawn', async (_, e) => {
    const input = e as unknown as { subagent_type?: string; subagentType?: string; name?: string; description: string; prompt: string }
    const id = `r${spawns.length + 1}`
    spawns.push({ name: input.name, prompt: input.prompt })
    agents.push({ id, name: input.name, description: input.description, type: input.subagent_type ?? input.subagentType ?? '', status: hold.status ?? 'running' })
    if (hold.gate !== undefined) await hold.gate
    return { model: 'sonnet', agentId: id }
  })
  on('session.send', () => ({ isDelivered: true as const }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', (_, e) => ({ text: e.answer }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', (_, e) => { toasts.push(String((e as { text?: string }).text)); return { value: undefined } })
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
  return { agents, files, spawns, toasts, clock, hold }
}

type W = ReturnType<typeof world>
const handover = ($: Dollar, pr: number) => $.tool.call({ tool: 'mcp__flow__handover', pr, agentId: 'm1' } as never).then(r => String(r.result))
const answer = ($: Dollar, id: string, choice: string) => $.tool.call({ tool: 'mcp__flow__answer', answers: [{ id, choice }] } as never).then(r => String(r.result))
const cmd = ($: Dollar, args: string) => $.command.run({ command: 'flow', args } as never).then(r => r.text ?? '')
const start = ($: Dollar) => ($ as never as { session: { start: (e: unknown) => Promise<unknown> } }).session.start({ cwd: '/r', surface: null, isInteractive: false })
const status = ($: Dollar) => $.tool.call({ tool: 'mcp__flow__status' } as never).then(r => String(r.result))
const stored = (w: W, name: string) => JSON.parse(w.files.get(`${DIR}/${name}.json`) ?? 'null')
const haltItems = (w: W) => ((stored(w, 'inbox') ?? { items: [] }).items as Array<Record<string, unknown>>).filter(x => x.kind === 'reviewer')

// The reviewer `id` ends `afterMs` after it started, with `answer` ('' is the host's failed end).
async function end($: Dollar, w: W, id: string, afterMs: number, answer = '') {
  await w.clock.advance(afterMs)
  w.agents.find(a => a.id === id)!.status = answer === '' ? 'failed' : 'completed'
  await $.turn.complete({ answer, agentId: id, durationMs: afterMs, isAborted: false, turnId: `t-${id}`, reason: answer === '' ? 'error' : 'answer' } as never)
  await w.clock.settle()
}

test('the pane shows the halt warning while the breaker is tripped', async ($, on) => {
  const w = world(on)
  await start($)
  expect(await handover($, 7)).toContain('Started reviewer reviewer-1')
  await end($, w, 'r1', 800)
  await w.clock.advance(31_000)
  await w.clock.settle()
  await end($, w, 'r2', 800)
  await w.clock.advance(61_000)
  await w.clock.settle()
  await end($, w, 'r3', 800)
  expect(stored(w, 'reviewer-breaker').halt).toBeDefined()
  const ui = await $.ui.mount({ plugin: 'flow', surface: 'terminal', component: 'Pane', props: { title: 'Flow' } as never, requestId: 'flow' })
  expect(await ui.find({ type: 'Text', text: /Reviewer halted/ })).toBeDefined()
  await ui.unmount()
})

test('a reviewer that ends with no answer is not replaced at once; the next start waits 30s, then 1m, and the third failure halts', async ($, on) => {
  const w = world(on)
  await start($)
  expect(await handover($, 7)).toContain('Started reviewer reviewer-1')
  await end($, w, 'r1', 800)
  expect(w.spawns).toHaveLength(1)
  expect(stored(w, 'reviewer-breaker')).toMatchObject({ streak: 1, error: expect.stringContaining('API error') })
  // Another handover during the wait does not bypass it, and the timer does not stack.
  expect(await handover($, 8)).toContain('Backing off')
  await w.clock.advance(28_000)
  await w.clock.settle()
  expect(w.spawns).toHaveLength(1)
  await w.clock.advance(2_000)
  await w.clock.settle()
  expect(w.spawns.map(s => s.name)).toEqual(['reviewer-1', 'reviewer-2'])

  await end($, w, 'r2', 800)
  await w.clock.advance(59_000)
  await w.clock.settle()
  expect(w.spawns).toHaveLength(2)
  await w.clock.advance(1_500)
  await w.clock.settle()
  expect(w.spawns).toHaveLength(3)

  await end($, w, 'r3', 800)
  expect(stored(w, 'reviewer-breaker').halt).toMatchObject({ qid: 'q1' })
  expect(haltItems(w)).toEqual([expect.objectContaining({ id: 'q1', state: 'open', blocking: true, owner: 'reviewer' })])
  expect(w.toasts.some(t => t.includes('Reviewer halted'))).toBe(true)
  await w.clock.advance(20 * 60_000)
  await w.clock.settle()
  expect(w.spawns).toHaveLength(3)
  const st = await status($)
  expect(st).toContain('Reviewer halted')
  expect(st).toContain('API error')
})

test('a handover while halted does not restart the loop or open a second item; a retry answer starts one reviewer, a second answer does nothing', async ($, on) => {
  const w = world(on)
  await start($)
  await handover($, 7)
  await end($, w, 'r1', 500)
  await w.clock.advance(31_000); await w.clock.settle()
  await end($, w, 'r2', 500)
  await w.clock.advance(61_000); await w.clock.settle()
  await end($, w, 'r3', 500)
  expect(w.spawns).toHaveLength(3)
  expect(await handover($, 8)).toContain('halted')
  expect(await handover($, 9)).toContain('halted')
  expect(w.spawns).toHaveLength(3)
  expect(haltItems(w)).toHaveLength(1)
  // Naming it in ids takes its default, which never retries it: "not now" leaves the queue halted and asks again as q2.
  expect(await $.tool.call({ tool: 'mcp__flow__answer', defaults: true, ids: ['q1'] } as never).then(r => String(r.result))).toContain('q1')
  expect(w.spawns).toHaveLength(3)
  expect(stored(w, 'reviewer-breaker').halt).toMatchObject({ qid: 'q2' })
  expect(haltItems(w).filter(x => x.state === 'open')).toHaveLength(1)

  const reply = await answer($, 'q2', 'retry')
  expect(reply).toContain('Started reviewer reviewer-4')
  expect(w.spawns.map(s => s.name)).toEqual(['reviewer-1', 'reviewer-2', 'reviewer-3', 'reviewer-4'])
  expect(stored(w, 'reviewer-breaker').halt).toBeUndefined()
  expect(haltItems(w)[1]).toMatchObject({ state: 'answered', answer: 'retry' })
  // A double answer finds it answered and starts nothing.
  expect(await answer($, 'q2', 'retry')).toContain('already answered')
  expect(w.spawns).toHaveLength(4)
  // The history survives: one more immediate failure halts again.
  await end($, w, 'r4', 500)
  expect(stored(w, 'reviewer-breaker').halt).toBeDefined()
  expect(haltItems(w)).toHaveLength(3)
})

test('a reviewer that dies before spawn() resolves still counts, and is not respawned at once; a denied spawn leaves no run behind', async ($, on) => {
  const w = world(on)
  await start($)
  // Hold the spawn open: the reviewer is already dead and ends before the host answers.
  let release: () => void = () => undefined
  w.hold.gate = new Promise<void>(r => { release = r })
  w.hold.status = 'failed'
  const first = handover($, 7)
  await w.clock.settle()
  // Its ensureQueue waits behind the held spawn, but the end itself is recorded first.
  const ended = $.turn.complete({ answer: '', agentId: 'r1', durationMs: 5, isAborted: false, turnId: 't-r1', reason: 'error' } as never)
  await w.clock.settle()
  expect(stored(w, 'reviewer-breaker')).toMatchObject({ streak: 1 })
  release()
  await first
  await ended
  await w.clock.settle()
  expect(stored(w, 'reviewer-breaker')).toMatchObject({ streak: 1 })
  expect(w.spawns).toHaveLength(1)
  await w.clock.advance(1_000)
  await w.clock.settle()
  expect(w.spawns).toHaveLength(1)
})

test('a long successful reviewer resets the breaker', async ($, on) => {
  const w = world(on)
  await start($)
  await handover($, 7)
  await end($, w, 'r1', 500)
  await w.clock.advance(31_000); await w.clock.settle()
  expect(w.spawns).toHaveLength(2)
  await end($, w, 'r2', 5 * 60_000, 'PR #7 merged.')
  expect(stored(w, 'reviewer-breaker')).toMatchObject({ streak: 0 })
  expect(stored(w, 'reviewer-breaker').error).toBeUndefined()
  // The handover is still pending in this fake, so the next reviewer starts at once.
  expect(w.spawns).toHaveLength(3)
})

test('the hourly start cap halts the queue even when every run is healthy; one item; retry keeps the start history', async ($, on) => {
  const w = world(on)
  await start($)
  await handover($, 7)
  for (let i = 1; i <= MAX_STARTS_PER_HOUR; i++) {
    expect(w.spawns).toHaveLength(i)
    await end($, w, `r${i}`, 40_000, 'Merged.')
  }
  expect(w.spawns).toHaveLength(MAX_STARTS_PER_HOUR)
  expect(stored(w, 'reviewer-breaker').halt).toMatchObject({ error: CAP_ERROR, qid: 'q1' })
  expect(haltItems(w)).toHaveLength(1)
  expect(await handover($, 8)).toContain('halted')
  expect(haltItems(w)).toHaveLength(1)
  expect(await status($)).toContain('hourly start cap')
  // Retry clears the halt, not the starts: the cap holds and asks again.
  await answer($, 'q1', 'retry')
  expect(w.spawns).toHaveLength(MAX_STARTS_PER_HOUR)
  expect(stored(w, 'reviewer-breaker').starts).toHaveLength(MAX_STARTS_PER_HOUR)
  expect(haltItems(w)).toHaveLength(2)
  // Once the hour has passed the next retry starts a reviewer.
  await w.clock.advance(HOUR_MS)
  await answer($, 'q2', 'retry')
  expect(w.spawns).toHaveLength(MAX_STARTS_PER_HOUR + 1)
})

test('/flow resume and a session restart clear the halt, keep the failure history, and start a reviewer for pending work', async ($, on) => {
  const w = world(on)
  await start($)
  await handover($, 7)
  await end($, w, 'r1', 500)
  await w.clock.advance(31_000); await w.clock.settle()
  await end($, w, 'r2', 500)
  await w.clock.advance(61_000); await w.clock.settle()
  await end($, w, 'r3', 500)
  expect(stored(w, 'reviewer-breaker').halt).toBeDefined()
  expect(await cmd($, 'resume')).toContain('Reviewer halt cleared')
  await w.clock.settle()
  expect(w.spawns).toHaveLength(4)
  expect(stored(w, 'reviewer-breaker')).toMatchObject({ streak: HALT_AFTER - 1 })
  expect(stored(w, 'reviewer-breaker').halt).toBeUndefined()
  expect(haltItems(w)[0]).toMatchObject({ state: 'answered' })

  // Halt again, then restart the session: the halt is gone, the streak stays.
  await end($, w, 'r4', 500)
  expect(stored(w, 'reviewer-breaker').halt).toBeDefined()
  await start($)
  await w.clock.advance(5); await w.clock.settle()
  expect(stored(w, 'reviewer-breaker').halt).toBeUndefined()
  expect(stored(w, 'reviewer-breaker').streak).toBe(HALT_AFTER - 1)
  expect(w.spawns).toHaveLength(5)
})

test('old state with no breaker file starts with an empty history', async ($, on) => {
  const w = world(on)
  await start($)
  expect(await handover($, 7)).toContain('Started reviewer reviewer-1')
  expect(stored(w, 'reviewer-breaker')).toMatchObject({ streak: 0, run: { name: 'reviewer-1' } })
})

test('reviewer_delay: handovers on an idle queue wait one timer, then one reviewer starts', { options: { reviewer_delay: 1 } }, async ($, on) => {
  const w = world(on)
  await start($)
  expect(await handover($, 7)).toContain('The reviewer starts in 1m')
  expect(await handover($, 8)).toContain('joins')
  await w.clock.advance(30_000)
  await w.clock.settle()
  expect(w.spawns).toHaveLength(0)
  await w.clock.advance(30_000)
  await w.clock.settle()
  expect(w.spawns).toHaveLength(1)
  expect(w.spawns[0]!.prompt).toContain('#7, #8')
})
