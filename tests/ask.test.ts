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
