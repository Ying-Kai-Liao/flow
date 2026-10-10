import type { AgentInfo } from 'claude-code'
import { expect, mock } from 'claude-code/testing'
import { test } from './support'
import type { TestBody } from 'claude-code/testing'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const DIR = '/r/.git/flow'
const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

// A manager "csv-export" (m1, under main) with one worker (w1); `agents` is the live roster the tests edit.
function world(on: On) {
  mock.clock(on, { now: 1_000_000 })
  const agents: AgentInfo[] = [
    { id: 'm1', name: 'csv-export', description: 'm', type: 'flow:manager', status: 'running' },
    { id: 'w1', name: 'csv-worker', description: 'w', type: 'flow:worker', status: 'running', parentId: 'm1' },
  ]
  const files = new Map<string, string>()
  const sent: { to: string; text: string }[] = []
  const toasts: string[] = []
  on('agent.list', () => ({ value: agents }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', (_, e) => { toasts.push(String((e as { text?: string }).text)); return { value: undefined } })
  on('session.send', (_, e) => {
    const raw = (e as unknown as { to: string | { agentId: string } }).to
    sent.push({ to: typeof raw === 'string' ? raw : raw.agentId, text: e.text })
    return { isDelivered: true as const }
  })
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('fs.read', (_, e) => {
    const t = files.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('process.run', (_, e) => {
    const a = e.argv
    if (a[0] === 'git' && a[1] === 'rev-parse') return ok('/r/.git\n')
    if (a[0] === 'mv') {
      const t = files.get(a[1] ?? '')
      if (t !== undefined) { files.set(a[2] ?? '', t); files.delete(a[1] ?? '') }
    }
    return ok()
  })
  return { agents, files, sent, toasts }
}

const ask = ($: Dollar, agentId: string | null, questions: unknown[]) =>
  $.tool.call({ tool: 'mcp__flow__ask', from: 'x', questions, ...(agentId === null ? {} : { agentId }) } as never).then(r => String(r.result))
const answer = ($: Dollar, agentId: string | null, args: Record<string, unknown>) =>
  $.tool.call({ tool: 'mcp__flow__answer', ...args, ...(agentId === null ? {} : { agentId }) } as never).then(r => String(r.result))
const inbox = ($: Dollar) => $.command.run({ command: 'flow', args: 'inbox' } as never).then(r => r.text ?? '')
const notes = (files: Map<string, string>) => files.get(`${DIR}/managers/csv-export/notes.md`) ?? ''

const BLOCK = { question: 'Which format?', options: ['csv', 'tsv'], default: 'csv', blocking: true }
const SOFT = { question: 'Quote fields?', options: ['yes', 'no'], default: 'yes', blocking: false }

test('a worker batch: one message to the manager, results per question, assumption noted, inbox.json written', async ($, on) => {
  const w = world(on)
  const r = await ask($, 'w1', [BLOCK, SOFT])
  expect(r).toContain('q1: end your turn now')
  expect(r).toContain('q2: proceed on the default (yes)')

  expect(w.sent.length).toBe(1)
  expect(w.sent[0]!.to).toBe('m1')
  expect(w.sent[0]!.text).toContain('q1 (blocking): Which format?')
  expect(w.sent[0]!.text).toContain('q2 (non-blocking): Quote fields?')
  expect(w.sent[0]!.text.endsWith('Answer with mcp__flow__answer.')).toBe(true)

  expect(notes(w.files)).toContain('progress: assumed yes for q2')
  const stored = JSON.parse(w.files.get(`${DIR}/inbox.json`) ?? '{}') as { items: { id: string }[] }
  expect(stored.items.map(i => i.id)).toEqual(['q1', 'q2'])
})

test('the same question asked again while open is not stored or sent twice', async ($, on) => {
  const w = world(on)
  await ask($, 'w1', [BLOCK])
  const again = await ask($, 'w1', [BLOCK])
  expect(again).toContain('already asked as q1')
  expect(w.sent.length).toBe(1)
})

test('the manager answers: the worker is told, the decision is noted, the inbox drops the question', async ($, on) => {
  const w = world(on)
  await ask($, 'w1', [BLOCK])
  expect(await inbox($)).toContain('q1')

  const r = await answer($, 'm1', { answers: [{ id: 'q1', choice: 'b' }] })
  expect(r).toContain('q1: tsv')
  expect(r).toContain('delivered')
  const msg = w.sent.find(s => s.to === 'w1')
  expect(msg?.text).toContain('Which format?')
  expect(msg?.text).toContain('tsv')
  expect(notes(w.files)).toContain('decision: "q1 Which format?: tsv"')
  expect(await inbox($)).toBe('No open questions.')
})

test('main answers a manager\'s questions with defaults; a non-blocking default sends no message', async ($, on) => {
  const w = world(on)
  await ask($, 'm1', [BLOCK, SOFT])
  expect(w.sent).toEqual([])
  expect(w.toasts.join('\n')).toContain('/flow inbox')

  const r = await answer($, null, { defaults: true })
  expect(r).toContain('q1: csv (default)')
  expect(r).toContain('q2: yes (default)')
  expect(w.sent.length).toBe(1)
  expect(w.sent[0]!.to).toBe('m1')
  expect(w.sent[0]!.text).toContain('Which format?')
})

test('an answer for an asker that is gone is undelivered and says who relays it', async ($, on) => {
  const w = world(on)
  await ask($, 'w1', [BLOCK])
  w.agents.splice(1, 1)
  const r = await answer($, 'm1', { answers: [{ id: 'q1', choice: 'tsv' }] })
  expect(r).toContain('undelivered')
  expect(r).toContain('main should relay')
})

test('main cannot ask and only the addressee answers', async ($, on) => {
  const w = world(on)
  expect(await ask($, null, [BLOCK])).toContain('main cannot ask')
  await ask($, 'w1', [BLOCK])
  const r = await answer($, null, { answers: [{ id: 'q1', choice: 'a' }] })
  expect(r).toContain('refused')
  expect(r).toContain('addressed to csv-export')
  expect(w.sent.filter(s => s.to === 'w1')).toEqual([])
})

test('status starts with the inbox head while a blocking question is open', async ($, on) => {
  world(on)
  await ask($, 'w1', [BLOCK])
  const out = String((await $.tool.call({ tool: 'mcp__flow__status' } as never)).result)
  expect(out.startsWith('Inbox: 1 open, 1 blocking')).toBe(true)
  expect(out).toContain('q1 BLOCKING csv-worker: Which format?')
})

const fyi = ($: Dollar, agentId: string | null, items: unknown[]) =>
  $.tool.call({ tool: 'mcp__flow__fyi', from: 'x', items, ...(agentId === null ? {} : { agentId }) } as never).then(r => String(r.result))
const D1 = { decision: 'Use a 30 s timeout', why: 'the conservative choice' }

test('an FYI is recorded quietly, listed, and acked with defaults without a message', async ($, on) => {
  const w = world(on)
  expect(await fyi($, null, [D1])).toContain('Refused')
  expect(await fyi($, 'w1', [D1, { decision: 'x' }])).toContain('Refused, nothing recorded')
  const r = await fyi($, 'w1', [D1])
  expect(r).toContain('Recorded q1')
  expect(r).toContain('only if it is overturned')
  expect(await fyi($, 'w1', [D1])).toContain('Recorded q1')
  expect(w.sent).toEqual([])
  expect(w.toasts).toEqual([])
  const text = await inbox($)
  expect(text.startsWith('1 FYI.')).toBe(true)
  expect(text).toContain('csv-worker:')
  expect(text).toContain('q1 (0 min): Use a 30 s timeout')
  expect(await answer($, 'm1', { defaults: true })).toContain('q1: Keep (default)')
  expect(w.sent).toEqual([])
  expect(await inbox($)).toBe('No open questions.')
})

test('overturning an FYI messages the owner; with the owner gone, its manager', async ($, on) => {
  const w = world(on)
  await fyi($, 'w1', [D1, { decision: 'Name it exporter', why: 'matches the module' }])
  const r = await answer($, null, { answers: [{ id: 'q1', choice: 'use 60 s' }] })
  expect(r).toContain('q1: use 60 s')
  expect(w.sent[0]!.to).toBe('w1')
  expect(w.sent[0]!.text).toContain('overturned your FYI q1: you decided "Use a 30 s timeout". Instead: use 60 s.')
  expect(notes(w.files)).toContain('overturned, use 60 s')

  w.agents.splice(1, 1)
  await answer($, null, { answers: [{ id: 'q2', choice: 'Overturn' }] })
  const last = w.sent[w.sent.length - 1]!
  expect(last.to).toBe('m1')
  expect(last.text).toContain('overturned your FYI q2')
  expect(last.text).toContain('csv-worker')
})

// ---- /flow ok, /flow no, /flow answer: the person's commands ----

const cmd = ($: Dollar, args: string) => $.command.run({ command: 'flow', args } as never).then(r => r.text ?? '')
const D2 = { decision: 'Name it export.csv', why: 'matches the docs', topic: 'naming' }

test('/flow ok keeps every open FYI and leaves questions; twice finds nothing; no message is sent', async ($, on) => {
  const w = world(on)
  await fyi($, 'w1', [D1, D2])
  await ask($, 'm1', [SOFT])
  const r = await cmd($, 'ok')
  expect(r).toContain('q1: Keep (default)')
  expect(r).toContain('q2: Keep (default)')
  expect(r).not.toContain('q3:')
  expect(r).toContain('Still open: 1 question')
  expect(w.sent).toEqual([])
  expect(await cmd($, 'ok')).toContain('No open FYIs to keep.')
})

test('/flow ok <ids|owner|topic>: a question takes its default, words expand to FYIs, repeats are reported once', async ($, on) => {
  world(on)
  await fyi($, 'w1', [D1, D2])
  await fyi($, 'm1', [{ decision: 'Use UTF-8', why: 'safe' }])
  await ask($, 'm1', [SOFT])
  const r = await cmd($, 'ok q4 q4 q9')
  expect(r.match(/q4: yes \(default\)/g)?.length).toBe(1)
  expect(r).toContain('q9: no such question.')
  expect(await cmd($, 'ok naming')).toContain('q2: Keep (default)')
  expect(await cmd($, 'ok q2')).toContain('q2: already answered')
  expect(await cmd($, 'ok csv-export')).toContain('q3: Keep (default)')
  expect(await cmd($, 'ok nothing-like-this')).toContain('no open FYIs for that owner or topic')
})

test('/flow no overturns an FYI with the words given and tells its owner; a question is refused', async ($, on) => {
  const w = world(on)
  await fyi($, 'w1', [D1, D2])
  await ask($, 'm1', [SOFT])
  const r = await cmd($, 'no q1 use 60 s, not 30')
  expect(r).toContain('q1: use 60 s, not 30')
  expect(w.sent[0]!.to).toBe('w1')
  expect(w.sent[0]!.text).toContain('Instead: use 60 s, not 30.')
  expect(await cmd($, 'no q2')).toContain('q2: Overturn')
  expect(w.sent[1]!.text).toContain('Instead: undo it.')
  expect(await cmd($, 'no q3')).toContain('not an FYI')
  expect(await cmd($, 'no')).toContain('Usage')
})

test('/flow answer takes a letter or free text, also for a question addressed to a manager (the user overrides it)', async ($, on) => {
  const w = world(on)
  await ask($, 'm1', [BLOCK, SOFT])
  await ask($, 'w1', [{ ...BLOCK, question: 'Which delimiter?' }])
  expect(await cmd($, 'answer q1 b')).toContain('q1: tsv')
  expect(await cmd($, 'answer q2 maybe, ask legal')).toContain('q2: maybe, ask legal')
  expect(w.sent.some(s => s.to === 'm1' && s.text.includes('maybe, ask legal'))).toBe(true)
  const over = await cmd($, 'answer q3 a')
  expect(over).toContain('q3: csv')
  expect(w.sent.some(s => s.to === 'w1' && s.text.includes('the user answered q3'))).toBe(true)
  expect(w.sent.some(s => s.to === 'm1' && s.text.includes('the user answered q3, which csv-worker asked you: csv. It is closed'))).toBe(true)
  expect(await cmd($, 'answer q1 a')).toContain('already answered')
  expect(await cmd($, 'answer q8 a')).toContain('no such question')
  expect(await cmd($, 'answer q1')).toContain('Usage')
})

test('/flow ok refuses a guard item and says how; /flow answer answers it', async ($, on) => {
  const w = world(on)
  w.files.set(`${DIR}/inbox.json`, JSON.stringify({ next: 2, items: [{
    id: 'q1', owner: 'reviewer-1', addressee: 'main', question: 'Add a guard mapping?', options: ['Add it to my personal flow config', 'No'], default: 'No',
    blocking: false, askedAt: 1_000_000, state: 'open', delivered: false, guard: { glob: 'src/**', test: 't.test.ts' },
  }] }))
  // any inbox write loads the file into the atom the commands read
  await fyi($, 'w1', [D1])
  expect(await cmd($, 'ok q1')).toContain('answer it explicitly: /flow answer q1 <choice>')
  const bulk = await cmd($, 'ok')
  expect(bulk).toContain('q2: Keep (default)')
  expect(bulk).not.toContain('q1:')
  expect(await cmd($, 'answer q1 b')).toContain('q1: No')
})

test('/flow inbox <id> prints one item in full; inbox all shows older FYIs of agents that are gone', async ($, on) => {
  const w = world(on)
  await fyi($, 'w1', [D1])
  w.agents.splice(1, 1)
  expect(await cmd($, 'inbox')).toContain('Older: 1 FYI (q1)')
  expect(await cmd($, 'inbox all')).toContain('q1 (0 min): Use a 30 s timeout')
  const one = await cmd($, 'inbox q1')
  expect(one).toContain('why: the conservative choice')
  expect(one).toContain('/flow no q1')
  expect(await cmd($, 'inbox q7')).toContain('no such question')
})
