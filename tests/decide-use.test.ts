import type { AgentInfo } from 'claude-code'
import { expect, mock } from 'claude-code/testing'
import { test } from './support'
import type { TestBody } from 'claude-code/testing'

import type { DecideIo, FetchLike } from '../hooks/decide'
import { autoKeepable, autoKeepFyis, decideActive } from '../hooks/decide-use'
import { EMPTY_INBOX } from '../hooks/inbox'
import type { StandingIo } from '../hooks/standing-run'
import { settingsOf } from '../hooks/settings'
import type { Inbox, Question } from '../types'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const DIR = '/r/.git/flow'
const KEY = 'sk-secret-key'
const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const ON = { decision_api: 'jev', jev_api_key: KEY, decide_inbox: true, decide_handoff: true, preflight: 'off' }

// What the fake provider answers per question id: a jev reply, an HTTP failure, or nothing.
type Reply = { choice: string; confidence: number } | 'http500'
function net(replies: Record<string, Reply>, calls: { url: string; body: string }[]) {
  return (url: string, body: string) => {
    calls.push({ url, body })
    const id = Object.keys((JSON.parse(body) as { questions: Record<string, unknown> }).questions)[0]!
    const r = replies[id]
    if (r === undefined || r === 'http500') return { status: r === undefined ? 404 : 500, ok: false, headers: {}, text: '{}' }
    return { status: 200, ok: true, headers: {}, text: JSON.stringify({ answers: { [id]: r } }) }
  }
}

const logOf = (files: Map<string, string>) =>
  (files.get(`${DIR}/log.jsonl`) ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>)

function world(on: On, replies: Record<string, Reply>, extra: { agents?: AgentInfo[]; transcript?: unknown } = {}) {
  mock.clock(on, { now: 1_000_000 })
  const agents: AgentInfo[] = extra.agents ?? [
    { id: 'm1', name: 'csv-export', description: 'm', type: 'flow:manager', status: 'running' },
    { id: 'w1', name: 'csv-worker', description: 'w', type: 'flow:worker', status: 'running', parentId: 'm1' },
    { id: 'w2', name: 'csv-worker-2', description: 'w', type: 'flow:worker', status: 'running', parentId: 'm1' },
    { id: 'w3', name: 'csv-worker-3', description: 'w', type: 'flow:worker', status: 'running', parentId: 'm1' },
  ]
  const files = new Map<string, string>()
  const sent: { to: string; text: string }[] = []
  const calls: { url: string; body: string }[] = []
  const answer = net(replies, calls)
  on('http.fetch', (_, e) => ({ value: answer(e.url, String(e.init?.body ?? '')) }) as never)
  on('agent.list', () => ({ value: agents }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.send', (_, e) => {
    const raw = (e as unknown as { to: string | { agentId: string } }).to
    sent.push({ to: typeof raw === 'string' ? raw : raw.agentId, text: e.text })
    return { isDelivered: true as const }
  })
  on('session.messages', () => ({ value: (extra.transcript ?? []) as never }))
  on('turn.complete', (_, e) => ({ text: e.answer }) as never)
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('fs.read', (_, e) => {
    const t = files.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('process.run', (_, e) => {
    const a = e.argv
    if (a[0] === 'git' && a[1] === 'rev-parse') return ok('/r/.git\n')
    if (a[0] === 'sh' && a[1] === '-c' && a[2]?.includes('>>')) {
      const p = a[5] ?? ''
      files.set(p, `${files.get(p) ?? ''}${a[4]}\n`)
    }
    if (a[0] === 'mv') {
      const t = files.get(a[1] ?? '')
      if (t !== undefined) { files.set(a[2] ?? '', t); files.delete(a[1] ?? '') }
    }
    return ok()
  })
  return { agents, files, sent, calls }
}

const fyi = ($: Dollar, agentId: string, items: unknown[]) =>
  $.tool.call({ tool: 'mcp__flow__fyi', from: 'x', items, agentId } as never).then(r => String(r.result))
const answer = ($: Dollar, agentId: string | null, args: Record<string, unknown>) =>
  $.tool.call({ tool: 'mcp__flow__answer', ...args, ...(agentId === null ? {} : { agentId }) } as never).then(r => String(r.result))
const inboxText = ($: Dollar) => $.command.run({ command: 'flow', args: 'inbox' } as never).then(r => r.text ?? '')
const stored = (files: Map<string, string>) => (JSON.parse(files.get(`${DIR}/inbox.json`) ?? '{"items":[]}') as { items: Question[] }).items

const D1 = { decision: 'Use a 30 s timeout', why: 'the conservative choice' }
const KEEP93 = { inbox_routine: { choice: 'keep', confidence: 0.93 } }

test('decide_inbox off, or decision_api off: no provider call and the decision stays open', { options: { ...ON, decide_inbox: false } }, async ($, on) => {
  const w = world(on, KEEP93)
  expect(await fyi($, 'w1', [D1])).toContain('Recorded d1')
  expect(w.calls).toEqual([])
  expect(stored(w.files)[0]?.state).toBe('open')
})

test('decision_api off: decide_inbox alone sends nothing', { options: { ...ON, decision_api: 'off' } }, async ($, on) => {
  const w = world(on, KEEP93)
  await fyi($, 'w1', [D1])
  expect(w.calls).toEqual([])
  expect(stored(w.files)[0]?.state).toBe('open')
})

test('a confident keep is kept by the provider: same result, visible, no message, a log line without the key', { options: ON }, async ($, on) => {
  const w = world(on, KEEP93)
  const r = await fyi($, 'w1', [D1])
  expect(r).toBe('Recorded d1. Carry on; you get a message only if it is undone.')
  expect(w.calls).toHaveLength(1)
  expect(w.calls[0]!.body).toContain('Use a 30 s timeout')
  const item = stored(w.files)[0]!
  expect(item).toMatchObject({ id: 'd1', state: 'answered', answer: 'Keep', answeredBy: 'jev', delivered: true, auto: { by: 'jev', confidence: 0.93 } })
  expect(w.sent).toEqual([])
  expect(await inboxText($)).toContain('d1 csv-worker: Use a 30 s timeout -> kept by jev (0.93)')
  const arch = await $.command.run({ command: 'flow', args: 'inbox archive' } as never).then(x => x.text ?? '')
  expect(arch).toContain('Kept by jev (0.93)')
  expect(await $.tool.call({ tool: 'mcp__flow__status', agentId: undefined } as never).then(x => String(x.result))).toContain('Inbox: 1 decision kept by jev (undo with mcp__flow__answer).')
  const ev = logOf(w.files).find(l => l.event === 'decide')
  expect(ev).toMatchObject({ feature: 'inbox', id: 'd1', answer: 'keep', confidence: 0.93, applied: true })
  expect(w.files.get(`${DIR}/log.jsonl`)).not.toContain(KEY)
  // Defaults must not answer it twice.
  expect(await answer($, null, { defaults: true })).toBe('No open questions for you.')
})

test('under the threshold, undo, ask_main, an HTTP failure: the decision stays open as today', { options: ON }, async ($, on) => {
  const cases: Array<[string, Reply]> = [
    ['low', { choice: 'keep', confidence: 0.79 }],
    ['undo', { choice: 'undo', confidence: 0.99 }],
    ['ask', { choice: 'ask_main', confidence: 0.99 }],
    ['fail', 'http500'],
  ]
  const replies: Record<string, Reply> = {}
  const w = world(on, replies)
  for (const [name, reply] of cases) {
    replies.inbox_routine = reply
    await fyi($, 'w1', [{ decision: `Decision ${name}`, why: 'because' }])
  }
  expect(w.calls).toHaveLength(4)
  expect(stored(w.files).map(q => q.state)).toEqual(['open', 'open', 'open', 'open'])
  const evs = logOf(w.files).filter(l => l.event === 'decide')
  expect(evs.map(e => e.applied)).toEqual([false, false, false, false])
  expect(evs[3]).toHaveProperty('note')
  expect(w.files.get(`${DIR}/log.jsonl`)).not.toContain(KEY)
})

test('the threshold is decide_min_confidence', { options: { ...ON, decide_min_confidence: 0.5 } }, async ($, on) => {
  const w = world(on, { inbox_routine: { choice: 'keep', confidence: 0.6 } })
  await fyi($, 'w1', [D1])
  expect(stored(w.files)[0]).toMatchObject({ state: 'answered', auto: { confidence: 0.6 } })
})

test('undoing an auto-kept decision messages the owner like any undo; Keep changes nothing', { options: ON }, async ($, on) => {
  const w = world(on, KEEP93)
  await fyi($, 'w1', [D1])
  expect(await answer($, null, { answers: [{ id: 'd1', choice: 'Keep' }] })).toContain('already answered')
  const r = await answer($, null, { answers: [{ id: 'd1', choice: 'use 60 s' }] })
  expect(r).toContain('d1: use 60 s')
  expect(w.sent).toHaveLength(1)
  expect(w.sent[0]!.to).toBe('w1')
  expect(w.sent[0]!.text).toContain('undid your decision d1: you decided "Use a 30 s timeout". Instead: use 60 s.')
  const item = stored(w.files)[0]!
  expect(item.auto).toBeUndefined()
  expect(item.answeredBy).toBe('main')
  expect(await answer($, null, { answers: [{ id: 'd1', choice: 'use 90 s' }] })).toContain('already answered')
})

// --- the guard: nothing that is not a plain decision is ever sent or answered ---

const base = (over: Partial<Question>): Question => ({ id: 'q1', owner: 'csv-worker', addressee: 'main', question: 'Q?', options: ['a', 'b'], default: 'a', blocking: false, askedAt: 1, state: 'open', delivered: false, ...over })
const fyiItem = base({ id: 'd1', kind: 'fyi', options: ['Keep', 'Undo'], default: 'Keep' })

function fakeIo(items: Question[], after?: () => void) {
  let box: Inbox = { ...EMPTY_INBOX, items }
  const logs: unknown[] = []
  const io = {
    inbox: async () => box,
    withInbox: async (fn: (cur: Inbox) => { inbox: Inbox; out: unknown }) => { const r = fn(box); box = r.inbox; return r.out },
    now: async () => 5,
    best: async (_: string, fn: () => Promise<void>) => fn(),
    appendLog: async (e: unknown) => { logs.push(e) },
  } as unknown as StandingIo
  const calls: string[] = []
  const fetch: FetchLike = async (_url, init) => {
    calls.push(init.body)
    after?.()
    return { ok: true, status: 200, json: async () => ({ answers: { inbox_routine: { choice: 'keep', confidence: 0.99 } } }) }
  }
  const netIo: DecideIo = { fetch, after: () => ({ cancel: () => undefined }) }
  return { io, calls, logs, netIo, box: () => box }
}
const S = settingsOf({ decision_api: 'jev', jev_api_key: KEY, decide_inbox: true }, 'main')

test('every item kind that is not a plain decision is never sent to the provider nor answered', async () => {
  const notDecisions: Question[] = [
    base({ id: 'q1', blocking: true }),
    base({ id: 'q2' }),
    base({ id: 'q3', kind: 'question' }),
    base({ id: 'q4', kind: 'env', env: { name: 'X', target: 't', role: 'change' } as never }),
    base({ id: 'q5', kind: 'deploy' }),
    base({ id: 'q6', kind: 'push' }),
    base({ id: 'q7', kind: 'reviewer' }),
    base({ id: 'q8', guard: { glob: '*', test: 't' } }),
    base({ id: 'q9', kind: 'fyi', escalated: 'r1' }),
    base({ id: 'q10', kind: 'fyi', blocking: true }),
    base({ id: 'q11', kind: 'fyi', viaQ: 'q1' }),
    base({ id: 'q12', kind: 'fyi', state: 'answered', answer: 'Keep', answeredBy: 'main' }),
  ]
  const t = fakeIo(notDecisions)
  expect(notDecisions.map(autoKeepable)).toEqual(notDecisions.map(() => false))
  await autoKeepFyis(t.netIo, t.io, S, notDecisions.map(q => q.id))
  expect(t.calls).toEqual([])
  expect(t.box().items.map(q => q.state)).toEqual(notDecisions.map(q => q.state))
  expect(t.logs).toEqual([])
  expect(autoKeepable(fyiItem)).toBe(true)
})

test('an answer that arrives after main answered the decision changes nothing', async () => {
  const t = fakeIo([fyiItem], () => undefined)
  const racing = fakeIo([fyiItem])
  // The provider's reply lands after the item was answered by someone else.
  const answeredMeanwhile: FetchLike = async (u, init) => {
    racing.io.withInbox(cur => ({ inbox: { ...cur, items: cur.items.map(x => ({ ...x, state: 'answered' as const, answer: 'use 60 s', answeredBy: 'main' })) }, out: undefined }))
    return racing.netIo.fetch(u, init)
  }
  await autoKeepFyis({ ...racing.netIo, fetch: answeredMeanwhile }, racing.io, S, ['d1'])
  const item = racing.box().items[0]!
  expect(item).toMatchObject({ answer: 'use 60 s', answeredBy: 'main' })
  expect(item.auto).toBeUndefined()
  expect(racing.logs[0]).toMatchObject({ event: 'decide', feature: 'inbox', applied: false })
  expect(t.calls).toEqual([])
})

test('decideActive needs the toggle and a provider', () => {
  expect(decideActive({ decideInbox: true, decisionApi: 'jev' }, 'inbox')).toBe(true)
  expect(decideActive({ decideInbox: true, decisionApi: 'openai' }, 'inbox')).toBe(true)
  expect(decideActive({ decideInbox: true, decisionApi: 'off' }, 'inbox')).toBe(false)
  expect(decideActive({ decideInbox: true, decisionApi: 'jev' }, 'handoff')).toBe(false)
  expect(decideActive({ decideHandoff: true, decisionApi: 'jev' }, 'handoff')).toBe(true)
  expect(decideActive({ decideInbox: false, decisionApi: 'jev' }, 'inbox')).toBe(false)
})

test('settings: the toggles default off and the threshold is clamped to 0..1', () => {
  expect(settingsOf({}, 'main')).toMatchObject({ decideInbox: false, decideHandoff: false, decideMinConfidence: 0.8 })
  expect(settingsOf({ decide_inbox: true, decide_handoff: true, decide_min_confidence: 3 }, 'main')).toMatchObject({ decideInbox: true, decideHandoff: true, decideMinConfidence: 1 })
  expect(settingsOf({ decide_min_confidence: -1 }, 'main').decideMinConfidence).toBe(0)
})

// --- handoff advice ---

const TRANSCRIPT = [
  { role: 'user', text: 'brief', toolUses: [] },
  { role: 'assistant', text: 'Remaining: a changelog line\nHANDOFF: flow/csv', toolUses: [] },
]
const finish = ($: Dollar, agentId: string) =>
  $.turn.complete({ turnId: 't', agentId, answer: 'done\nHANDOFF: flow/csv' } as never)
const SPLIT = { handoff_next: { choice: 'split', confidence: 0.88 } }

test('below max_continues a confident split is advice to the manager; continue says nothing', { options: ON }, async ($, on) => {
  const w = world(on, SPLIT, { transcript: TRANSCRIPT })
  await finish($, 'w1')
  expect(w.calls).toHaveLength(1)
  expect(w.calls[0]!.body).toContain('Remaining: a changelog line')
  expect(w.sent).toHaveLength(1)
  expect(w.sent[0]!.to).toBe('m1')
  expect(w.sent[0]!.text).toContain('jev advises splitting flow/csv (0.88)')
  expect(logOf(w.files).find(l => l.event === 'decide')).toMatchObject({ feature: 'handoff', id: 'flow/csv', answer: 'split', confidence: 0.88, applied: true })
  expect(w.files.get(`${DIR}/log.jsonl`)).not.toContain(KEY)
})

test('a confident continue, an unsure split or a failure adds nothing', { options: ON }, async ($, on) => {
  const replies: Record<string, Reply> = { handoff_next: { choice: 'continue', confidence: 0.95 } }
  const w = world(on, replies, { transcript: TRANSCRIPT })
  await finish($, 'w1')
  replies.handoff_next = { choice: 'split', confidence: 0.5 }
  await finish($, 'w2')
  expect(w.calls).toHaveLength(2)
  expect(w.sent).toEqual([])
  expect(logOf(w.files).filter(l => l.event === 'decide').map(l => l.applied)).toEqual([false, false])
})

test('past max_continues the split message stays and carries the provider lean; enforcement is unchanged', { options: ON }, async ($, on) => {
  const w = world(on, { handoff_next: { choice: 'continue', confidence: 0.91 } }, { transcript: TRANSCRIPT })
  await finish($, 'w1')
  await finish($, 'w2')
  expect(w.sent).toEqual([])
  await finish($, 'w3')
  expect(w.sent).toHaveLength(1)
  expect(w.sent[0]!.text).toContain('flow/csv has handed off 3 times (max_continues 2)')
  expect(w.sent[0]!.text).toContain('(jev: continue 0.91)')
})

test('decide_handoff off: the handoff makes no provider call and the messages are as before', { options: { ...ON, decide_handoff: false } }, async ($, on) => {
  const w = world(on, SPLIT, { transcript: TRANSCRIPT })
  await finish($, 'w1')
  await finish($, 'w2')
  await finish($, 'w3')
  expect(w.calls).toEqual([])
  expect(w.sent).toHaveLength(1)
  expect(w.sent[0]!.text).not.toContain('(jev:')
})
