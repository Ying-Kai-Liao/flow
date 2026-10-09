import type { AgentInfo } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { Handover } from '../types'
import { EMPTY_INBOX, needsMessage, renderInbox } from '../hooks/inbox'
import {
  batchId, closePushItem, dropStep, itemOf, newBatch, normalizePush, openPushItem, parsePushMode, parseVerdict, recordable, refOf, releaseStep, renderBatch,
  reviewerNote, sendBackStep, settlePrs,
} from '../hooks/pushgate'
import type { ReadyBatch } from '../hooks/pushgate'
import { fill, REVIEWER_PROMPT } from '../hooks/prompts'
import type { Settings } from '../hooks/prompts'
import { KEYS, mergeLayers } from '../hooks/settings'
import { matchRule, parseRules, suggest } from '../hooks/standing'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const S1 = '1'.repeat(40)
const S2 = '2'.repeat(40)
const S3 = '3'.repeat(40)
const BASE = '9'.repeat(40)
const BASE2 = '8'.repeat(40)

const items = [
  { pr: 7, title: 'Export', branch: 'flow/b7', head: 'h7', evidence: '1 ran' },
  { pr: 8, title: 'Import', branch: 'flow/b8', head: 'h8', evidence: '2 ran' },
]
const batch = (extra: Partial<ReadyBatch> = {}): ReadyBatch => ({ ...newBatch({ sha: S1, baseSha: BASE, check: '42 tests passed', version: '0.5.1', items, now: 5 }), ...extra })

// ---- pure half ----

test('push_mode: confirm stays, anything else is auto; the setting is a known key with a closed set of values', () => {
  expect(parsePushMode('confirm')).toBe('confirm')
  expect(parsePushMode('auto')).toBe('auto')
  expect(parsePushMode('always')).toBe('auto')
  expect(parsePushMode(undefined)).toBe('auto')
  expect('push_mode' in KEYS).toBe(true)
  const r = mergeLayers({}, [{ path: '/r/.claude/flow.json', text: JSON.stringify({ push_mode: 'maybe' }) }])
  expect(r.raw.push_mode).toBeUndefined()
  expect(r.warnings.join('\n')).toContain('"push_mode" is "maybe"; use "auto" or "confirm"')
  expect(mergeLayers({}, [{ path: '/r/.claude/flow.json', text: JSON.stringify({ push_mode: 'confirm' }) }]).raw.push_mode).toBe('confirm')
})

test('a new batch is named after its head, saved under refs/flow/push, and holds the PRs it was built from', () => {
  const b = batch()
  expect(b).toMatchObject({ id: '11111111', state: 'ready', prs: [7, 8], sha: S1, baseSha: BASE, ref: 'refs/flow/push/11111111', version: '0.5.1' })
  expect(batchId(S2)).toBe('22222222')
  expect(refOf('abc')).toBe('refs/flow/push/abc')
  const h = { pr: 3, title: 'T', head: 'h', branch: 'flow/t', evidence: { ran: ['a', 'b'], exercised: 'it', notVerified: ['x'] } } as unknown as Handover
  expect(itemOf(h)).toEqual({ pr: 3, title: 'T', branch: 'flow/t', head: 'h', evidence: '2 ran, exercised: it, 1 not verified' })
  expect(itemOf({ ...h, evidence: undefined }).evidence).toBe('no evidence recorded')
})

test('release: only a ready batch is released, once; nothing ready says so', () => {
  expect(releaseStep(undefined, 9)).toEqual({ kind: 'refused', why: 'Nothing ready to push.' })
  const r = releaseStep(batch(), 9)
  expect(r).toMatchObject({ kind: 'ok', batch: { state: 'pushing', releasedAt: 9 } })
  const again = releaseStep(r.kind === 'ok' ? r.batch : undefined, 10)
  expect(again).toMatchObject({ kind: 'refused' })
  expect(again.kind === 'refused' && again.why).toContain('already released')
  expect(releaseStep(batch({ state: 'rebuilding' }), 9)).toMatchObject({ kind: 'refused', why: expect.stringContaining('being rebuilt') })
})

test('send back: a PR that is not in the batch is refused; the rest is rebuilt; the last PR leaves no batch', () => {
  expect(sendBackStep(batch(), 99)).toMatchObject({ kind: 'refused', why: 'PR #99 is not in batch 11111111 (#7, #8).' })
  expect(sendBackStep(undefined, 7)).toMatchObject({ kind: 'refused' })
  const r = sendBackStep(batch({ qid: 'q1' }), 7)
  expect(r).toMatchObject({ kind: 'ok', batch: { state: 'rebuilding', prs: [8], reason: 'PR #7 was sent back by the user' } })
  expect(r.kind === 'ok' && r.batch?.qid).toBeUndefined()
  expect(r.kind === 'ok' && r.batch?.items.map(i => i.pr)).toEqual([8])
  const last = sendBackStep(batch({ prs: [8], items: [items[1]!] }), 8)
  expect(last).toEqual({ kind: 'ok', batch: undefined })
  expect(sendBackStep(batch({ state: 'pushing' }), 7)).toMatchObject({ kind: 'refused' })
})

test('drop: only a ready batch; settle: a finished batch is gone, a half done one shrinks', () => {
  expect(dropStep(batch()).kind).toBe('ok')
  expect(dropStep(batch({ state: 'pushing' })).kind).toBe('refused')
  expect(dropStep(undefined).kind).toBe('refused')
  const status = (m: Record<number, Handover['status']>) => (pr: number) => m[pr]
  expect(settlePrs(batch(), status({ 7: 'ready', 8: 'ready' }))).toEqual(batch())
  expect(settlePrs(batch({ state: 'pushing' }), status({ 7: 'done', 8: 'ready' }))).toMatchObject({ prs: [8], items: [{ pr: 8 }] })
  expect(settlePrs(batch({ state: 'pushing' }), status({ 7: 'done', 8: 'returned' }))).toBeUndefined()
  expect(settlePrs(batch({ state: 'rebuilding' }), status({ 7: 'taken', 8: 'ready' }))?.prs).toEqual([7, 8])
  expect(settlePrs(undefined, status({}))).toBeUndefined()
  expect([recordable('taken'), recordable('ready'), recordable('pending'), recordable('done'), recordable(undefined)]).toEqual([true, true, false, false, false])
})

test('the answer to the push item is parsed: push, send back #n, drop, not yet; anything else is unknown', () => {
  expect(parseVerdict('push')).toEqual({ kind: 'push' })
  expect(parseVerdict(' Push ')).toEqual({ kind: 'push' })
  expect(parseVerdict('send back #7')).toEqual({ kind: 'back', pr: 7 })
  expect(parseVerdict('Send back 12')).toEqual({ kind: 'back', pr: 12 })
  expect(parseVerdict('back #3')).toEqual({ kind: 'back', pr: 3 })
  expect(parseVerdict('drop')).toEqual({ kind: 'drop' })
  expect(parseVerdict('not yet')).toEqual({ kind: 'later' })
  expect(parseVerdict('send back everything')).toEqual({ kind: 'unknown' })
  expect(parseVerdict('yes')).toEqual({ kind: 'unknown' })
})

test('the push item is a blocking item for main with a safe default, closed once; no message goes to an asker', () => {
  const { inbox, q } = openPushItem(EMPTY_INBOX, batch(), 10)
  expect(q).toMatchObject({ id: 'q1', owner: 'push', addressee: 'main', blocking: true, kind: 'push', options: ['push', 'not yet', 'drop'], default: 'not yet', state: 'open' })
  expect(q.question).toBe('Push batch 11111111: #7, #8 as 0.5.1?')
  expect(q.context).toContain('42 tests passed')
  expect(q.context).toContain('#7 Export [1 ran]')
  expect(needsMessage(q, false)).toBe(false)
  expect(renderInbox(inbox, 20)).toContain('PUSH')
  const closed = closePushItem(inbox, 'q1', 'push', 'user', 30)
  expect(closed.items[0]).toMatchObject({ state: 'answered', answer: 'push', answeredBy: 'user' })
  expect(closePushItem(closed, 'q1', 'drop', 'user', 40)).toBe(closed)
  expect(closePushItem(inbox, undefined, 'push', 'user', 40)).toBe(inbox)
})

test('standing answers never answer a push item, even a rule that names the kind; the answer-often suggestion skips it', () => {
  const { q } = openPushItem(EMPTY_INBOX, batch(), 10)
  const any = parseRules([{ match: 'Push batch', answer: 'push', blocking: true }], 'personal', 'f', [])
  const named = parseRules([{ match: 'Push batch', answer: 'push', blocking: true, kinds: ['push'] }], 'personal', 'f', [])
  const dflt = parseRules([{ match: 'Push batch', answer: 'default' }], 'personal', 'f', [])
  expect(matchRule(any, q)).toBeUndefined()
  expect(matchRule(named, q)).toBeUndefined()
  expect(matchRule(dflt, q)).toBeUndefined()
  const answered = { next: 5, items: [1, 2, 3].map(i => ({ ...q, id: `q${i}`, state: 'answered' as const, answer: 'push', answeredBy: 'main' })) }
  expect(suggest(answered, [])).toEqual([])
})

test('normalizePush keeps a valid batch and drops what is malformed', () => {
  const b = batch({ qid: 'q3', releasedAt: 4, reason: 'r' })
  expect(normalizePush({ batch: b })).toEqual({ batch: b })
  expect(normalizePush(null)).toEqual({})
  expect(normalizePush({ batch: { ...b, state: 'weird' } })).toEqual({})
  expect(normalizePush({ batch: { ...b, prs: [] } })).toEqual({})
  expect(normalizePush({ batch: { ...b, sha: '' } })).toEqual({})
  expect(normalizePush({ batch: { ...b, items: [{ pr: 'x' }] } }).batch?.items).toEqual([])
})

test('rendering: the ready batch names the commands; the reviewer is told what to do per state', () => {
  const lines = renderBatch(batch()).join('\n')
  expect(lines).toContain('Batch 11111111 ready to push: #7, #8 (0.5.1)')
  expect(lines).toContain('built on 99999999, head 11111111, ref refs/flow/push/11111111; check: 42 tests passed')
  expect(lines).toContain('/flow push to push it, /flow push back <pr>')
  expect(renderBatch(batch({ state: 'pushing' })).join('\n')).not.toContain('/flow push to push it')
  expect(reviewerNote(batch())).toContain('awaits the user\'s /flow push')
  expect(reviewerNote(batch({ state: 'pushing' }))).toContain(`PUSH RUN: the user released batch 11111111: PRs #7, #8; sha ${S1}; built on base sha ${BASE}`)
  expect(reviewerNote(batch({ state: 'rebuilding', reason: 'PR #7 was sent back by the user', prs: [8] }))).toContain('REBUILD RUN: PR #7 was sent back by the user')
})

const base: Settings = {
  base: 'main', testCommand: '', fullCheck: 'npm test', deployCommand: '', deployTargets: [], stateFile: undefined, mergeMethod: 'squash', mergeMode: 'auto',
  useReviewer: true, maxWorkers: 3, testSlots: 1, workerModel: 'sonnet', managerModel: 'opus', reviewerModel: 'opus', language: 'English',
  bigFiles: [], bigFileLines: 1500, migrationsDir: '', decisionPhrases: [], workerChecks: [], alwaysTests: [],
}

test('the reviewer prompt has the push gate and the push run only with push_mode confirm; auto is the prompt as before', () => {
  const auto = fill(REVIEWER_PROMPT, base)
  expect(fill(REVIEWER_PROMPT, { ...base, pushMode: 'auto' })).toBe(auto)
  expect(auto).not.toContain('{{')
  expect(auto).not.toContain('Push gate')
  expect(auto).not.toContain('Push run')
  const confirm = fill(REVIEWER_PROMPT, { ...base, pushMode: 'confirm', release: true })
  expect(confirm).not.toContain('{{')
  expect(confirm).toContain('Push gate (push_mode is confirm')
  expect(confirm).toContain('git update-ref refs/flow/push/${SHA:0:8} HEAD')
  expect(confirm).toContain('action "ready" with prs')
  expect(confirm).toContain('do not push, delete a branch, publish, deploy')
  expect(confirm).toContain('## Push run')
  expect(confirm).toContain('PUSH RUN')
  expect(confirm).toContain('REBUILD RUN')
  expect(confirm).toContain('passing recut true')
  // The gate comes after the release cut and before the push step.
  expect(confirm.indexOf('Push gate')).toBeGreaterThan(confirm.indexOf('Release, only when'))
  expect(confirm.indexOf('Push gate')).toBeLessThan(confirm.indexOf('4. Push:'))
  expect(fill(REVIEWER_PROMPT, { ...base, pushMode: 'confirm' })).not.toContain('recut')
})

// ---- the plugin, driven end to end ----

const DIR = '/r/.git/flow'
const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const fail = () => ({ value: { exitCode: 1, stdout: '', stderr: 'no', isStdoutTruncated: false, isStderrTruncated: false } })
const BODY = '## Verification\nRan:\n- `bun test`: pass\nExercised: ran it\nNot verified:\n- the full check'
const OPTS = {
  push_mode: 'confirm', release: 'on', release_github: 'on', release_files: ['plugin.json'],
  deploy_targets: JSON.stringify([{ name: 'demo', deploy: ['./deploy demo'] }, { name: 'production', deploy: ['./deploy prod'], mode: 'confirm' }]),
}

// Main, a manager m1, and spawned reviewers r1, r2... `refs` is the local ref store (update-ref / rev-parse --verify).
function world(on: On) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const agents: AgentInfo[] = [{ id: 'm1', name: 'csv-export', description: 'm', type: 'flow:manager', status: 'running' }]
  const files = new Map<string, string>([['/q/CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n\n- A line.\n'], ['/q/plugin.json', '{\n  "version": "0.5.0"\n}\n']])
  const spawns: { type: string; prompt: string }[] = []
  const sent: { to: string; text: string }[] = []
  const toasts: string[] = []
  const calls: (readonly string[])[] = []
  const refs = new Map<string, string>()
  const registered: Record<string, string> = {}
  on('agent.list', () => ({ value: agents }))
  on('session.start', () => ({ cwd: '/r' }))
  on('command.register', () => ({ value: undefined } as never))
  on('tool.register', () => ({ value: undefined } as never))
  on('fs.stat', () => { throw new Error('ENOENT') })
  on('agent.register', (_, e) => { const r = e as unknown as { name: string; prompt: string }; registered[r.name] = r.prompt; return { value: { agent: r.name } } })
  on('agent.spawn', (_, e) => {
    const input = e as unknown as { subagent_type?: string; subagentType?: string; name?: string; description: string; prompt: string }
    const type = input.subagent_type ?? input.subagentType ?? ''
    const id = `r${spawns.length + 1}`
    spawns.push({ type, prompt: input.prompt })
    agents.push({ id, name: input.name, description: input.description, type, status: 'running' })
    return { model: 'sonnet', agentId: id }
  })
  on('session.send', (_, e) => { const raw = (e as unknown as { to: string | { agentId: string } }).to; sent.push({ to: typeof raw === 'string' ? raw : raw.agentId, text: e.text }); return { isDelivered: true as const } })
  on('prompt.submit', (_, e) => ({ text: e.text }))
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
    calls.push(a)
    if (a[0] === 'git' && a[1] === 'rev-parse' && a.includes('--git-common-dir')) return ok('/r/.git\n')
    if (a[0] === 'git' && a[1] === 'rev-parse' && a.includes('--verify')) {
      const ref = String(a.at(-1)).replace('^{commit}', '')
      if (ref.startsWith('refs/flow/push/')) return refs.has(ref) ? ok(`${refs.get(ref)}\n`) : fail()
      return fail()
    }
    if (a[0] === 'git' && a[1] === 'update-ref') {
      if (a[2] === '-d') refs.delete(a[3] ?? '')
      else refs.set(a[2] ?? '', a[3] ?? '')
      return ok()
    }
    if (a[0] === 'mv') {
      const t = files.get(a[1] ?? '')
      if (t !== undefined) { files.set(a[2] ?? '', t); files.delete(a[1] ?? '') }
    }
    if (a[0] === 'gh' && a[1] === 'pr' && a[2] === 'view') {
      const n = Number(a[3])
      return ok(JSON.stringify({ state: 'OPEN', isDraft: false, headRefOid: `h${n}`, headRefName: `flow/b${n}`, title: `Title ${n}`, body: BODY, labels: [] }))
    }
    // publish: the release commit is in the log; the tag does not exist yet; the GitHub Release does.
    if (a[0] === 'git' && a[1] === '-C' && a[3] === 'log') return ok(`${'c'.repeat(40)} Release 0.5.1\n`)
    if (a[0] === 'git' && a[1] === '-C' && a[3] === 'rev-parse') return fail()
    return ok()
  })
  return { agents, files, spawns, sent, toasts, calls, refs, registered, clock }
}

const handover = ($: Dollar, pr: number) => $.tool.call({ tool: 'mcp__flow__handover', pr, agentId: 'm1' } as never).then(r => String(r.result))
const reviewer = ($: Dollar, agentId: string, args: Record<string, unknown>) => $.tool.call({ tool: 'mcp__flow__reviewer', agentId, ...args } as never).then(r => String(r.result))
const ready = ($: Dollar, agentId: string, sha: string, prs: number[], extra: Record<string, unknown> = {}) =>
  reviewer($, agentId, { action: 'ready', prs, sha, base_sha: BASE, check: '42 tests passed', version: '0.5.1', ...extra })
const pushTool = ($: Dollar, args: Record<string, unknown>, agentId?: string) =>
  $.tool.call({ tool: 'mcp__flow__push', ...args, ...(agentId === undefined ? {} : { agentId }) } as never).then(r => String(r.result))
const answer = ($: Dollar, id: string, choice: string, agentId?: string) =>
  $.tool.call({ tool: 'mcp__flow__answer', answers: [{ id, choice }], ...(agentId === undefined ? {} : { agentId }) } as never).then(r => String(r.result))
const cmd = ($: Dollar, args: string) => $.command.run({ command: 'flow', args } as never).then(r => r.text ?? '')
const start = ($: Dollar) => ($ as never as { session: { start: (e: unknown) => Promise<unknown> } }).session.start({ cwd: '/r', surface: null, isInteractive: false })
const status = ($: Dollar) => $.tool.call({ tool: 'mcp__flow__status' } as never).then(r => String(r.result))

type W = ReturnType<typeof world>
const stored = (w: W, name: string) => JSON.parse(w.files.get(`${DIR}/${name}.json`) ?? 'null')
const statusOf = (w: W, pr: number) => (stored(w, `handovers/${pr}`) as { status: string; reason?: string } | null)?.status
const items_ = (w: W) => (stored(w, 'inbox') ?? { items: [] }).items as Array<Record<string, unknown>>
const pushed = (w: W) => w.calls.filter(c => (c[0] === 'git' && c.includes('push')) || (c[0] === 'gh' && c[1] === 'pr' && c[2] === 'merge') || (c[0] === 'git' && c.includes('tag')))

// Hands over PR 7 and 8, lets reviewer r1 take them and record the ready batch at S1.
async function readyBatch($: Dollar, w: W, sha = S1) {
  await handover($, 7)
  await handover($, 8)
  await reviewer($, 'r1', { action: 'take', pr: 7 })
  await reviewer($, 'r1', { action: 'take', pr: 8 })
  w.refs.set(refOf(batchId(sha)), sha)
  return ready($, 'r1', sha, [7, 8])
}

test('confirm: handover -> the reviewer records a ready batch -> pane, status, inbox and resume show it -> nothing was pushed', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await start($)
  expect(w.registered.reviewer).toContain('Push gate (push_mode is confirm')
  expect(w.registered.queue).toContain('Push gate (push_mode is confirm')
  expect(await handover($, 7)).toContain('Started reviewer reviewer-1')
  expect(await handover($, 8)).toContain('picks it up')
  expect(w.spawns.map(s => s.type)).toEqual(['flow:reviewer'])
  expect(w.spawns[0]!.prompt).toContain('Pending handovers: #7.')
  expect(await reviewer($, 'r1', { action: 'list' })).toContain('#7 pending')
  await reviewer($, 'r1', { action: 'take', pr: 7 })
  await reviewer($, 'r1', { action: 'take', pr: 8 })

  // The ref must exist and point at the batch head; the shas must be full.
  expect(await ready($, 'r1', S1, [7, 8])).toContain('refs/flow/push/11111111 does not exist')
  w.refs.set(refOf('11111111'), S2)
  expect(await ready($, 'r1', S1, [7, 8])).toContain(`points at ${S2}, not ${S1}`)
  w.refs.set(refOf('11111111'), S1)
  expect(await ready($, 'r1', 'abc', [7, 8])).toContain('full 40-character sha')
  expect(await ready($, 'r1', S1, [7, 8], { check: ' ' })).toContain('check must say')
  expect(await ready($, 'r1', S1, [7, 99])).toContain('no handover for PR #99')
  expect(await ready($, 'r1', S1, [])).toContain('prs must list')

  const res = await ready($, 'r1', S1, [7, 8])
  expect(res).toContain('Recorded batch 11111111')
  expect(res).toContain('Do not push')
  // Recording twice is harmless.
  expect(await ready($, 'r1', S1, [7, 8])).toContain('already recorded')

  expect(stored(w, 'push').batch).toMatchObject({ id: '11111111', state: 'ready', prs: [7, 8], sha: S1, baseSha: BASE, ref: 'refs/flow/push/11111111', check: '42 tests passed', version: '0.5.1', qid: 'q1', createdAt: 1_000_000 })
  expect(stored(w, 'push').batch.items.map((i: { evidence: string }) => i.evidence)).toEqual(['1 ran, exercised: ran it, 1 not verified', '1 ran, exercised: ran it, 1 not verified'])
  expect([statusOf(w, 7), statusOf(w, 8)]).toEqual(['ready', 'ready'])
  expect(items_(w)).toHaveLength(1)
  expect(items_(w)[0]).toMatchObject({ id: 'q1', kind: 'push', state: 'open', blocking: true, addressee: 'main', default: 'not yet' })
  expect(w.toasts.join('\n')).toContain('Batch 11111111 ready to push (#7 #8): /flow push')

  const st = await status($)
  expect(st).toContain('Needs the user:')
  expect(st).toContain('Batch 11111111 ready to push: #7, #8 (0.5.1)')
  expect(st).toContain('#7 ready (flow/b7 @ h7')
  expect(st).toContain('ready in a batch that awaits the user: /flow push')
  expect(st).toContain('Inbox: 1 open, 1 blocking')
  expect(await cmd($, 'inbox')).toContain('PUSH')
  expect(await cmd($, 'inbox')).toContain('Push batch 11111111: #7, #8 as 0.5.1?')
  const resume = await cmd($, 'resume')
  expect(resume).toContain('Needs you')
  expect(resume).toContain('Batch 11111111 ready to push')
  expect(resume).toContain('/flow push to push it')
  expect(await pushTool($, { action: 'list' })).toContain('Batch 11111111 ready to push')

  // Nothing was pushed, merged, deleted, tagged or marked done.
  expect(pushed(w)).toEqual([])
  expect(Object.values(stored(w, 'push') ? [statusOf(w, 7), statusOf(w, 8)] : [])).not.toContain('done')

  // A pane mounted now shows the batch on top.
  const ui = await $.ui.mount({ plugin: 'flow', surface: 'terminal', component: 'Pane', props: { title: 'Flow' } as never, requestId: 'flow' })
  expect(await ui.find({ type: 'Text', text: /Batch 11111111 ready to push: #7 #8 \(0\.5\.1\) · check: 42 tests passed/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\/flow push · \/flow push back/ })).toBeDefined()
  await ui.unmount()
})

test('while a batch is ready a new handover stays pending, no reviewer starts for it, and the reviewer sees no work', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await readyBatch($, w)
  // The reviewer that recorded it ended.
  w.agents.find(a => a.id === 'r1')!.status = 'completed'
  const spawned = w.spawns.length
  const res = await handover($, 9)
  expect(res).toContain('awaits the user\'s /flow push; new handovers wait behind it')
  expect(statusOf(w, 9)).toBe('pending')
  expect(w.spawns.length).toBe(spawned)
  // Even a reviewer that does start reads no pending work and may not take it.
  expect(await reviewer($, 'r1', { action: 'list' })).toContain('awaits the user\'s /flow push')
  expect(await reviewer($, 'r1', { action: 'take', pr: 9 })).toContain('Held: batch 11111111')
  expect(statusOf(w, 9)).toBe('pending')
  // A PR in the batch cannot be handed over again.
  expect(await handover($, 7)).toContain('is in a batch that awaits the user')
})

test('push_mode auto: ready is refused and the registered reviewer has no push gate', async ($, on) => {
  const w = world(on)
  await start($)
  expect(w.registered.reviewer).toContain('You are the flow reviewer')
  expect(w.registered.reviewer).not.toContain('Push gate')
  expect(await handover($, 7)).toContain('Started reviewer')
  await reviewer($, 'r1', { action: 'take', pr: 7 })
  w.refs.set(refOf(batchId(S1)), S1)
  expect(await ready($, 'r1', S1, [7])).toContain('push_mode is auto')
  expect(statusOf(w, 7)).toBe('taken')
  expect(await cmd($, 'push')).toBe('Nothing ready to push.')
})

test('only main releases the batch: managers, workers and the reviewer are refused; a stranger cannot answer the item', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await readyBatch($, w)
  for (const id of ['m1', 'r1']) {
    expect(await pushTool($, { action: 'push' }, id)).toContain('Refused: only main')
    expect(await pushTool($, { action: 'drop' }, id)).toContain('Refused: only main')
    expect(await pushTool($, { action: 'send-back', pr: 7 }, id)).toContain('Refused: only main')
    expect(await pushTool($, { action: 'list' }, id)).toContain('Refused: only main')
  }
  expect(await answer($, 'q1', 'push', 'm1')).toContain('refused, it is addressed to main')
  expect(await answer($, 'q1', 'push', 'r1')).toContain('refused, it is addressed to main')
  expect(stored(w, 'push').batch.state).toBe('ready')
  expect(w.spawns).toHaveLength(1)
  expect(await pushTool($, { action: 'send-back' })).toContain('needs pr')
  expect(await pushTool($, { action: 'fly' })).toContain('Unknown action')
})

test('/flow push: releases the batch, starts a reviewer with the push prompt, twice says already released; done finishes it', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await readyBatch($, w)
  w.agents.find(a => a.id === 'r1')!.status = 'completed'
  const text = await cmd($, 'push')
  expect(text).toContain('Batch 11111111 released (#7, #8)')
  expect(text).toContain('Started reviewer reviewer-2')
  expect(stored(w, 'push').batch).toMatchObject({ state: 'pushing', releasedAt: 1_000_000 })
  expect(items_(w)[0]).toMatchObject({ state: 'answered', answer: 'push', answeredBy: 'user' })
  expect(w.spawns[1]!.prompt).toContain('Push run for batch 11111111')
  expect(w.spawns[1]!.prompt).toContain('Pending handovers: wait behind the batch')
  // A second push finds it released.
  expect(await cmd($, 'push')).toContain('Batch 11111111 is already released and being pushed')
  expect(await pushTool($, { action: 'push' })).toContain('already released')
  expect(w.spawns).toHaveLength(2)

  // The push run reads its facts from the list, then does what the prompt says.
  const list = await reviewer($, 'r2', { action: 'list' })
  expect(list).toContain(`PUSH RUN: the user released batch 11111111: PRs #7, #8; sha ${S1}; built on base sha ${BASE}; ref refs/flow/push/11111111`)
  expect(await status($)).toContain('Batch 11111111 released, a reviewer is pushing it')
  expect(await reviewer($, 'r2', { action: 'done', pr: 7, sha: '1111111', report: 'full check: 42 passed' })).toContain('PR #7: done')
  // The batch stays until its last PR is done.
  expect(stored(w, 'push').batch).toMatchObject({ prs: [8] })
  expect(w.refs.has('refs/flow/push/11111111')).toBe(true)
  // Publish, deploy: the same tools as in a normal batch.
  expect(await $.tool.call({ tool: 'mcp__flow__release', action: 'publish', dir: '/q', version: '0.5.1', agentId: 'r2' } as never).then(r => String(r.result))).toContain('Published v0.5.1')
  expect(await $.tool.call({ tool: 'mcp__flow__deploy', action: 'gate', target: 'demo', sha: '1111111', agentId: 'r2' } as never).then(r => String(r.result))).toBe('Go')
  await $.tool.call({ tool: 'mcp__flow__deploy', action: 'deployed', target: 'demo', sha: '1111111', ok: true, agentId: 'r2' } as never)
  expect(stored(w, 'deploys').targets.demo.deployedSha).toBe('1111111')
  expect(await reviewer($, 'r2', { action: 'done', pr: 8, sha: '1111111', report: 'full check: 42 passed' })).toContain('PR #8: done')
  expect(stored(w, 'push')).toEqual({})
  expect(w.refs.size).toBe(0)
  expect([statusOf(w, 7), statusOf(w, 8)]).toEqual(['done', 'done'])
  // The queue is free again: a new handover starts a reviewer.
  w.agents.find(a => a.id === 'r2')!.status = 'completed'
  expect(await handover($, 9)).toContain('Started reviewer')
  expect(await cmd($, 'push')).toBe('Nothing ready to push.')
})

test('answering the inbox item "push" does the same as /flow push; "not yet" and nonsense keep the batch and ask again', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await readyBatch($, w)
  w.agents.find(a => a.id === 'r1')!.status = 'completed'
  expect(await answer($, 'q1', 'not yet')).toContain('Batch 11111111 stays ready; q2 asks again')
  expect(items_(w).map(i => [i.id, i.state])).toEqual([['q1', 'answered'], ['q2', 'open']])
  expect(stored(w, 'push').batch).toMatchObject({ state: 'ready', qid: 'q2' })
  expect(await answer($, 'q2', 'yes please')).toContain('is not push, send back #<pr>, drop or not yet')
  expect(stored(w, 'push').batch).toMatchObject({ state: 'ready', qid: 'q3' })
  expect(w.spawns).toHaveLength(1)
  const res = await answer($, 'q3', 'push')
  expect(res).toContain('Batch 11111111 released')
  expect(stored(w, 'push').batch.state).toBe('pushing')
  expect(w.spawns[1]!.prompt).toContain('Push run for batch 11111111')
  expect(items_(w).filter(i => i.state === 'open')).toEqual([])
})

test('answering with always on a push item makes no rule', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await readyBatch($, w)
  const res = await $.tool.call({ tool: 'mcp__flow__answer', answers: [{ id: 'q1', choice: 'not yet', always: true }] } as never).then(r => String(r.result))
  expect(res).toContain('no rule made, pushing a batch is the user\'s call every time')
  expect(w.files.get('/r/.git/flow/config.json') ?? '').not.toContain('standing_answers')
})

test('send back: the PR returns with the reason and its manager is told; the rest is rebuilt, re-checked, recorded again and asked again', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await readyBatch($, w)
  w.agents.find(a => a.id === 'r1')!.status = 'completed'
  expect(await cmd($, 'push back 99')).toContain('PR #99 is not in batch 11111111 (#7, #8)')
  expect(await cmd($, 'push back')).toContain('Usage: /flow push')
  expect(await cmd($, 'push back x')).toContain('Usage: /flow push')
  const text = await cmd($, 'push back 7')
  expect(text).toContain('PR #7 sent back')
  expect(text).toContain('#8) is rebuilt and re-checked')
  expect(statusOf(w, 7)).toBe('returned')
  expect((stored(w, 'handovers/7') as { reason: string }).reason).toBe('sent back by the user at push')
  expect(w.sent.at(-1)).toMatchObject({ to: 'm1' })
  expect(w.sent.at(-1)!.text).toContain('sent back by the user at push')
  expect(statusOf(w, 8)).toBe('ready')
  expect(stored(w, 'push').batch).toMatchObject({ state: 'rebuilding', prs: [8] })
  expect(items_(w)[0]).toMatchObject({ state: 'answered', answer: 'send back #7' })
  expect(w.spawns[1]!.prompt).toContain('Rebuild run for batch 11111111')
  // The rebuild: the reviewer is told, takes the ready PR, builds again, records the new head.
  expect(await reviewer($, 'r2', { action: 'list' })).toContain('REBUILD RUN: PR #7 was sent back by the user')
  expect(await reviewer($, 'r2', { action: 'take', pr: 8 })).toContain('PR #8: taken')
  w.refs.set(refOf(batchId(S2)), S2)
  const res = await ready($, 'r2', S2, [8], { base_sha: BASE2, version: '0.5.1' })
  expect(res).toContain('Recorded batch 22222222')
  // The old ref is gone, the new batch is asked about in a fresh item.
  expect([...w.refs.keys()]).toEqual(['refs/flow/push/22222222'])
  expect(stored(w, 'push').batch).toMatchObject({ id: '22222222', state: 'ready', prs: [8], baseSha: BASE2, qid: 'q2' })
  expect(items_(w).filter(i => i.state === 'open').map(i => [i.id, i.question])).toEqual([['q2', 'Push batch 22222222: #8 as 0.5.1?']])
  expect(statusOf(w, 8)).toBe('ready')
  expect(pushed(w)).toEqual([])
  // Sending back the last PR leaves no batch.
  expect(await answer($, 'q2', 'send back #8')).toContain('It was the last PR of batch 22222222: the batch is gone')
  expect(stored(w, 'push')).toEqual({})
  expect(w.refs.size).toBe(0)
  expect(statusOf(w, 8)).toBe('returned')
})

test('the base moved: the push run rebuilds the same PRs on the new base, re-cuts the release, records it again and the user is asked again', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await readyBatch($, w)
  w.agents.find(a => a.id === 'r1')!.status = 'completed'
  // The release was cut for #7, #8 when the batch was built; a re-cut is refused unless a released batch is rebuilt.
  expect(await $.tool.call({ tool: 'mcp__flow__release', dir: '/q', prs: [7, 8], agentId: 'r1' } as never).then(r => String(r.result))).toContain('Released 0.5.1')
  w.files.set('/q/CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n\n- A line.\n')
  w.files.set('/q/plugin.json', '{\n  "version": "0.5.0"\n}\n')
  expect(await $.tool.call({ tool: 'mcp__flow__release', dir: '/q', prs: [7, 8], recut: true, agentId: 'r1' } as never).then(r => String(r.result))).toContain('already released')
  await cmd($, 'push')
  w.agents.find(a => a.id === 'r2')!.status = 'running'
  expect(await $.tool.call({ tool: 'mcp__flow__release', dir: '/q', prs: [7, 8], agentId: 'r2' } as never).then(r => String(r.result))).toContain('already released')
  expect(await $.tool.call({ tool: 'mcp__flow__release', dir: '/q', prs: [7, 8], recut: true, agentId: 'r2' } as never).then(r => String(r.result))).toContain('Released 0.5.1')
  // The rebuild: take both again, then record the new head.
  expect(await reviewer($, 'r2', { action: 'take', pr: 7 })).toContain('PR #7: taken')
  expect(await reviewer($, 'r2', { action: 'take', pr: 8 })).toContain('PR #8: taken')
  w.refs.set(refOf(batchId(S3)), S3)
  expect(await ready($, 'r2', S3, [7, 8], { base_sha: BASE2 })).toContain('Recorded batch 33333333')
  expect([...w.refs.keys()]).toEqual(['refs/flow/push/33333333'])
  expect(stored(w, 'push').batch).toMatchObject({ id: '33333333', state: 'ready', baseSha: BASE2, qid: 'q2' })
  expect(items_(w).map(i => [i.id, i.state])).toEqual([['q1', 'answered'], ['q2', 'open']])
  expect([statusOf(w, 7), statusOf(w, 8)]).toEqual(['ready', 'ready'])
  expect(w.toasts.filter(t => t.includes('ready to push'))).toHaveLength(2)
  expect(pushed(w)).toEqual([])
  // Asked again: the user pushes the new one.
  expect(await cmd($, 'push')).toContain('Batch 33333333 released')
})

test('drop: every PR returns with the reason, managers are told, the ref and the batch go; the PRs can be handed over again', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await readyBatch($, w)
  w.agents.find(a => a.id === 'r1')!.status = 'completed'
  const text = await pushTool($, { action: 'drop' })
  expect(text).toContain('Batch 11111111 dropped: #7, #8 went back to their managers')
  expect([statusOf(w, 7), statusOf(w, 8)]).toEqual(['returned', 'returned'])
  expect((stored(w, 'handovers/8') as { reason: string }).reason).toBe('batch dropped by the user at push')
  expect(w.sent.filter(s => s.text.includes('batch dropped by the user at push'))).toHaveLength(2)
  expect(stored(w, 'push')).toEqual({})
  expect(w.refs.size).toBe(0)
  expect(items_(w)[0]).toMatchObject({ state: 'answered', answer: 'drop' })
  expect(w.spawns).toHaveLength(1)
  expect(await pushTool($, { action: 'list' })).toBe('Nothing ready to push.')
  expect(await cmd($, 'push drop')).toBe('Nothing ready to push.')
  expect(await handover($, 7)).toContain('Started reviewer')
})

test('a deploy-only run while a batch is ready deploys the due target and leaves the batch alone', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await readyBatch($, w)
  w.agents.find(a => a.id === 'r1')!.status = 'completed'
  await $.tool.call({ tool: 'mcp__flow__deploy', action: 'gate', target: 'production', sha: 'abc1234', agentId: 'r1' } as never)
  const dq = items_(w).find(i => i.kind === 'deploy')!
  expect(String(await answer($, String(dq.id), 'deploy'))).toContain('production approved')
  expect(w.spawns).toHaveLength(2)
  expect(w.spawns[1]!.prompt).toContain('Deploy-only work due: production')
  expect(w.spawns[1]!.prompt).toContain('Batch 11111111 awaits the user\'s push: leave it alone')
  expect(w.spawns[1]!.prompt).not.toContain('Push run for batch')
  expect(await reviewer($, 'r2', { action: 'list' })).toContain('awaits the user\'s /flow push')
  expect(await $.tool.call({ tool: 'mcp__flow__deploy', action: 'gate', target: 'production', sha: 'abc1234', agentId: 'r2' } as never).then(r => String(r.result))).toBe('Go')
  expect(stored(w, 'push').batch.state).toBe('ready')
})

test('restart: a ready batch on disk is shown by status and resume and its inbox item stays open; a released one gets its reviewer', { options: OPTS }, async ($, on) => {
  const w = world(on)
  const b = batch({ qid: 'q1' })
  w.files.set(`${DIR}/push.json`, JSON.stringify({ batch: b }))
  w.files.set(`${DIR}/inbox.json`, JSON.stringify(openPushItem(EMPTY_INBOX, b, 5).inbox))
  for (const [n, t] of [[7, 'Export'], [8, 'Import']] as const) {
    w.files.set(`${DIR}/handovers/${n}.json`, JSON.stringify({ version: 1, pr: n, title: t, head: `h${n}`, branch: `flow/b${n}`, reportTo: 'csv-export', verified: '', pending: 'none', afterDeploy: 'none', status: 'ready', at: 1 }))
  }
  await start($)
  await w.clock.advance(5)
  expect(w.spawns).toHaveLength(0)
  const st = await status($)
  expect(st).toContain('Needs the user:')
  expect(st).toContain('Batch 11111111 ready to push')
  expect(await cmd($, 'inbox')).toContain('Push batch 11111111')
  const resume = await cmd($, 'resume')
  expect(resume).toContain('Batch 11111111 ready to push')
  expect(resume).toContain('handover ready')
  expect(await cmd($, 'push')).toContain('Batch 11111111 released')
  expect(w.spawns).toHaveLength(1)

})

test('restart: a batch released by a session that died gets its reviewer on the next start', { options: OPTS }, async ($, on) => {
  const w2 = world(on)
  w2.files.set(`${DIR}/push.json`, JSON.stringify({ batch: batch({ state: 'pushing', releasedAt: 6 }) }))
  w2.files.set(`${DIR}/handovers/7.json`, JSON.stringify({ version: 1, pr: 7, title: 'Export', head: 'h7', branch: 'flow/b7', reportTo: 'csv-export', verified: '', pending: 'none', afterDeploy: 'none', status: 'ready', at: 1 }))
  await start($)
  await w2.clock.advance(5)
  expect(w2.spawns.map(s => s.prompt.includes('Push run for batch 11111111'))).toEqual([true])
})
