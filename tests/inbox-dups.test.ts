import type { AgentInfo } from 'claude-code'
import { expect, mock } from 'claude-code/testing'
import { test } from './support'
import { addQuestions, EMPTY_INBOX, inboxHead, normalizeInbox, paneRows, paneRowText, renderInbox } from '../hooks/inbox'
import { dupGroupOf, dupGroups } from '../hooks/inbox-dups'
import type { AskedQuestion, Inbox, Question } from '../hooks/inbox'
import type { TestBody } from 'claude-code/testing'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const ask = (question: string, extra: Partial<AskedQuestion> = {}): AskedQuestion => ({ question, options: ['Yes', 'No'], default: 'Yes', blocking: false, ...extra })
const M = (name: string) => ({ name, id: `id-${name}`, isManager: true })

function store(parts: Array<[string, AskedQuestion, ('fyi' | undefined)?]>, patch: (q: Question) => Question = q => q): Inbox {
  let box = EMPTY_INBOX
  let t = 1000
  for (const [who, a, kind] of parts) box = addQuestions(box, M(who), 'main', [a], t++, kind).inbox
  return { ...box, items: box.items.map(patch) }
}
const ids = (g: Question[][]) => g.map(x => x.map(q => q.id))

test('dupGroups: same topic (normalized) and option set groups, whatever the text; foo-2 is foo', () => {
  const box = store([
    ['a', ask('Use pnpm?', { topic: 'tooling' })],
    ['b', ask('Which package manager?', { topic: 'Tooling', options: ['no', 'yes'], default: 'no' })],
    ['c-2', ask('pm?', { topic: 'tooling' })],
    ['c', ask('other', { topic: 'tooling' })],
  ])
  expect(ids(dupGroups(box.items))).toEqual([['q1', 'q2', 'q3']])
  expect(dupGroupOf(box, 'q3').map(q => q.id)).toEqual(['q1', 'q2', 'q3'])
})

test('dupGroups: without a topic the normalized text and options decide; a topic on one side never matches a topic-less one', () => {
  const box = store([
    ['a', ask('Use  pnpm?')],
    ['b', ask('use pnpm?')],
    ['c', ask('Use pnpm?', { topic: 'x' })],
    ['d', ask('Use pnpm?', { options: ['Yes', 'No', 'Maybe'] })],
  ])
  expect(ids(dupGroups(box.items))).toEqual([['q1', 'q2']])
})

test('dupGroups: the same owner twice is no group; a blocking member makes the pane row blocking', () => {
  const same = store([['a', ask('Q1', { topic: 't' })], ['a', ask('Q2', { topic: 't' })]])
  expect(dupGroups(same.items)).toEqual([])
  const mixed = store([['a', ask('Q', { topic: 't' })], ['b', ask('Q', { topic: 't', blocking: true })]])
  expect(ids(dupGroups(mixed.items))).toEqual([['q1', 'q2']])
  const rows = paneRows(mixed)
  expect(rows.length).toBe(1)
  expect(rows[0]!.q!.id).toBe('q1')
  expect(rows[0]!.group!.blocking).toBe(true)
})

test('dupGroups never groups deploy/env/push/reviewer, guard, escalated, forQ/viaQ, answered, decisions or worker-addressed items', () => {
  const mk = (patch: Partial<Question>) => store([['a', ask('Q', { topic: 't' })], ['b', ask('Q', { topic: 't' })]], q => (q.id === 'q2' ? { ...q, ...patch } : q))
  for (const patch of [
    { kind: 'deploy' }, { kind: 'env' }, { kind: 'push' }, { kind: 'reviewer' }, { guard: { glob: 'a', test: 'b' } }, { escalated: 'r1' },
    { forQ: 'q9' }, { viaQ: 'q9' }, { state: 'answered' }, { addressee: 'mgr' },
  ] as Partial<Question>[]) expect(dupGroups(mk(patch).items)).toEqual([])
  expect(dupGroups(store([['a', ask('D', { topic: 't' }), 'fyi'], ['b', ask('D', { topic: 't' }), 'fyi']]).items)).toEqual([])
})

test('old stored items without topic or options fields do not crash (an item without options is dropped on read)', () => {
  const raw = { next: 3, items: [
    { id: 'q1', owner: 'a', addressee: 'main', question: 'Q', options: ['Yes', 'No'], default: 'Yes', blocking: false, askedAt: 1, state: 'open', delivered: false },
    { id: 'q2', owner: 'b', addressee: 'main', question: 'Q', options: ['Yes', 'No'], default: 'Yes', blocking: false, askedAt: 2, state: 'open', delivered: false },
    { id: 'q3', owner: 'c', addressee: 'main', question: 'Q', default: 'Yes', blocking: false, askedAt: 3, state: 'open', delivered: false },
  ] }
  const box = normalizeInbox(raw)
  expect(ids(dupGroups(box.items))).toEqual([['q1', 'q2']])
  expect(renderInbox(box, 5000)).toContain('q1 x2')
  expect(dupGroups([{ ...box.items[0]!, options: undefined } as unknown as Question, box.items[1]!])).toEqual([])
})

test('renderInbox, inboxHead and the pane rows show a group once with a count and the askers', () => {
  const box = store([['a', ask('Use pnpm?', { topic: 't' })], ['b', ask('Use pnpm?', { topic: 't' })], ['c', ask('Use pnpm?', { topic: 't' })], ['d', ask('Other?')]])
  const text = renderInbox(box, 5000)
  expect(text).toContain('2 questions.')
  expect(text).toContain('q1 x3')
  expect(text).toContain('a, b, c')
  expect(text).toContain('answering q1 answers all')
  expect(text).not.toContain('  q2 ')
  expect(inboxHead(box, 5000).join('\n')).toContain('q1 x3')
  const rows = paneRows(box, undefined, { 'grp:a': true, 'grp:d': true })
  expect(rows.map(r => r.key)).toEqual(['q1', 'q4'])
  expect(paneRowText(rows[0]!)).toBe('q1 x3 [t] a, b, c: Use pnpm?')
})

// --- the answer path ---

const DIR = '/r/.git/flow'
const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

function world(on: On) {
  mock.clock(on, { now: 1_000_000 })
  const agents: AgentInfo[] = [
    { id: 'm1', name: 'csv-export', description: 'm', type: 'flow:manager', status: 'running' },
    { id: 'm2', name: 'pdf-export', description: 'm', type: 'flow:manager', status: 'running' },
  ]
  const files = new Map<string, string>()
  const sent: { to: string; text: string }[] = []
  on('agent.list', () => ({ value: agents }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('session.send', (_, e) => {
    const raw = (e as unknown as { to: string | { agentId: string } }).to
    sent.push({ to: typeof raw === 'string' ? raw : raw.agentId, text: e.text })
    return { isDelivered: true as const }
  })
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('fs.read', (_, e) => { const t = files.get(e.path); if (t === undefined) throw new Error('ENOENT'); return { value: t } })
  on('process.run', (_, e) => {
    const a = e.argv
    if (a[0] === 'git' && a[1] === 'rev-parse') return ok('/r/.git\n')
    if (a[0] === 'mv') {
      const t = files.get(a[1] ?? '')
      if (t !== undefined) { files.set(a[2] ?? '', t); files.delete(a[1] ?? '') }
    }
    return ok()
  })
  return { files, sent }
}
const askAs = ($: Dollar, agentId: string, q: object) => $.tool.call({ tool: 'mcp__flow__ask', from: 'x', questions: [q], agentId } as never).then(r => String(r.result))
const answer = ($: Dollar, args: Record<string, unknown>) => $.tool.call({ tool: 'mcp__flow__answer', ...args } as never).then(r => String(r.result))
const items = (files: Map<string, string>) => (JSON.parse(files.get(`${DIR}/inbox.json`) ?? '{"items":[]}') as { items: Array<{ id: string; state: string; answer?: string }> }).items
const notes = (files: Map<string, string>, who: string) => files.get(`${DIR}/managers/${who}/notes.md`) ?? ''
const B = { question: 'Which format?', options: ['csv', 'tsv'], default: 'csv', blocking: true, topic: 'format' }

test('answering one member answers all, delivers to each asker, notes each owner, and names the ids', async ($, on) => {
  const w = world(on)
  await askAs($, 'm1', B)
  await askAs($, 'm2', { ...B, question: 'Format for the export?', options: ['tsv', 'csv'] })
  const r = await answer($, { answers: [{ id: 'q2', choice: 'a' }] })
  expect(r).toContain('Answered together (same question): q1 (csv-export), q2 (pdf-export)')
  // Letter a means tsv for q2 (its order); the same text goes to q1.
  expect(items(w.files).map(x => `${x.id}:${x.state}:${x.answer}`)).toEqual(['q1:answered:tsv', 'q2:answered:tsv'])
  expect(w.sent.filter(s => s.text.includes('Answer: tsv')).map(s => s.to).sort()).toEqual(['m1', 'm2'])
  expect(notes(w.files, 'csv-export')).toContain('decision: "q1 Which format?: tsv"')
  expect(notes(w.files, 'pdf-export')).toContain('decision: "q2 Format for the export?: tsv"')
})

test('two answers to members of one group in a call: answered once, the second reported as answered; free text applies to all', async ($, on) => {
  const w = world(on)
  await askAs($, 'm1', B)
  await askAs($, 'm2', B)
  const r = await answer($, { answers: [{ id: 'q1', choice: 'json please' }, { id: 'q2', choice: 'csv' }] })
  expect(r).toContain('q2: already answered ("json please"')
  expect(items(w.files).map(x => x.answer)).toEqual(['json please', 'json please'])
})

test('a member closed meanwhile is not in the group; a later ask is a new open item', async ($, on) => {
  const w = world(on)
  await askAs($, 'm1', B)
  await askAs($, 'm2', B)
  await answer($, { answers: [{ id: 'q1', choice: 'csv' }] })
  await askAs($, 'm1', { ...B, question: 'Format again?' })
  expect(items(w.files).filter(x => x.state === 'open').map(x => x.id)).toEqual(['q3'])
})

test('defaults: a shared default answers the group; differing defaults answer each its own', async ($, on) => {
  const w = world(on)
  await askAs($, 'm1', B)
  await askAs($, 'm2', B)
  const r = await answer($, { defaults: true, ids: ['q1'] })
  expect(r).toContain('Answered together')
  expect(items(w.files).map(x => x.answer)).toEqual(['csv', 'csv'])
  await askAs($, 'm1', { ...B, topic: 'other' })
  await askAs($, 'm2', { ...B, topic: 'other', default: 'tsv' })
  await answer($, { defaults: true, ids: ['q3'] })
  expect(items(w.files).map(x => `${x.id}:${x.state}`).slice(2)).toEqual(['q3:answered', 'q4:open'])
})
