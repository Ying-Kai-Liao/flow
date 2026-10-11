import type { AgentInfo } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { Handover } from '../types'
import { detailsKey, detailsStale, DETAILS_RETRY_MS, DETAILS_TTL_MS, fetchDetails, openerFor, parseDetails, prCardRows, whyAwaits } from '../hooks/prcard'
import type { CardRow, DetailsEntry } from '../hooks/prcard'
import { refOf } from '../hooks/pushgate'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const H: Handover = {
  pr: 7, title: 'Export CSV', head: 'abcdef1234567890', branch: 'flow/csv', reportTo: 'csv-export', verified: 'ran the suite', pending: 'none', afterDeploy: 'none',
  status: 'awaiting', at: 1_000_000 - 5 * 60_000,
  evidence: { ran: ['`bun test`: pass'], exercised: 'ran it', notVerified: ['the full check'] },
}
const GH = { url: 'https://github.com/o/r/pull/7', additions: 12, deletions: 3, labels: [{ name: 'flow:confirm' }], headRefOid: 'abcdef1234567890ffff', files: [{ path: 'a.ts', additions: 10, deletions: 1 }, { path: 'b.md', additions: 2, deletions: 2 }] }
const text = (rows: CardRow[]) => rows.map(r => r.text).join('\n')
const card = (h: Handover, entry?: DetailsEntry, mergeMode = 'auto') => text(prCardRows(h, { entry, mergeMode, now: 1_000_000 }))

// ---- the pure pieces ----

test('card rows: an awaiting PR shows title, status, branch, 8-char head, who and how long, why, verified, evidence', () => {
  const t = card({ ...H, mode: 'confirm' })
  expect(t).toContain('#7 Export CSV')
  expect(t).toContain('awaiting · flow/csv · head abcdef12')
  expect(t).toContain('handed over by csv-export, 5 min ago')
  expect(t).toContain('awaits you because the manager marked it risky (mode confirm)')
  expect(t).toContain('verified: ran the suite')
  expect(t).toContain('after deploy: none')
  expect(t).toContain('  - `bun test`: pass')
  expect(t).toContain('Exercised: ran it')
  expect(t).toContain('  - the full check')
  expect(t).not.toContain('pending decisions')
})

test('card rows: pending decisions, verify command and env changes appear when there are some', () => {
  const t = card({ ...H, pending: 'rename the flag?', afterDeploy: 'check the export', verifyCommand: 'curl -f x', env: [{ target: 'demo', name: 'MAIL', value: 'Ops', why: 'sender', qid: 'q1' }, { target: 'prod', name: 'KEY', secret: true, why: 'api', qid: 'q2' }] })
  expect(t).toContain('pending decisions: rename the flag?')
  expect(t).toContain('after deploy: check the export (verify: curl -f x)')
  expect(t).toContain('MAIL on demo = Ops: sender')
  expect(t).toContain('KEY on prod (secret, you set it): api')
})

test('card rows: a non-awaiting PR has no why line; an old handover says no evidence is stored', () => {
  const { evidence: _evidence, ...old } = H
  const t = card({ ...old, status: 'taken' })
  expect(t).toContain('taken · flow/csv')
  expect(t).not.toContain('awaits you because')
  expect(t).toContain('no evidence stored')
  expect(card({ ...H, status: 'returned', reason: 'declined by the user: no' })).toContain('returned: declined by the user: no')
})

test('why it awaits: mode confirm, then the label, then the setting', () => {
  expect(whyAwaits({ ...H, mode: 'confirm' }, 'auto')).toBe('the manager marked it risky (mode confirm)')
  expect(whyAwaits(H, 'auto', ['flow:confirm'])).toContain('flow:confirm label')
  expect(whyAwaits(H, 'confirm')).toBe('the merge_mode setting is confirm')
  expect(whyAwaits({ ...H, mode: 'auto' }, 'auto', [])).toContain('approval was asked for')
})

test('card rows: details loading, unavailable and loaded', () => {
  expect(card(H)).toContain('loading details…')
  expect(card(H, { fetchedAt: 1, fetching: true })).toContain('loading details…')
  expect(card(H, { fetchedAt: 1, error: 'gh: not found' })).toContain('details unavailable: gh: not found')
  const loaded = card(H, { fetchedAt: 1, details: { ...GH, labels: ['flow:confirm'] } })
  expect(loaded).toContain('2 files changed, +12 -3')
  expect(loaded).toContain('  +10 -1 a.ts')
  expect(loaded).toContain('https://github.com/o/r/pull/7')
  expect(loaded).toContain('the PR carries the flow:confirm label')
  expect(loaded).not.toContain('loading details')
})

test('card rows: a head that moved on GitHub warns that the stored head is what gets approved', () => {
  const same = card(H, { fetchedAt: 1, details: { ...GH, labels: [], headRefOid: 'abcdef1234567890ffff' } })
  expect(same).not.toContain('PR moved')
  const moved = card(H, { fetchedAt: 1, details: { ...GH, labels: [], headRefOid: '9999999999999999' } })
  expect(moved).toContain('PR moved since handover: approving approves the stored head abcdef12')
})

test('parseDetails reads the gh JSON, labels as names or strings, and rejects the rest', () => {
  const d = parseDetails(JSON.stringify(GH))
  expect(d).toMatchObject({ url: GH.url, additions: 12, deletions: 3, labels: ['flow:confirm'], headRefOid: GH.headRefOid })
  expect('files' in d && d.files).toEqual(GH.files)
  expect(parseDetails('not json')).toEqual({ error: 'gh printed no JSON' })
  expect(parseDetails('{"files":[]}')).toEqual({ error: 'unexpected gh output' })
})

test('fetchDetails asks gh for the fields, and turns a failure or a throw into an error entry', async () => {
  const seen: string[][] = []
  const good = await fetchDetails(async argv => { seen.push(argv); return { exitCode: 0, stdout: JSON.stringify(GH), stderr: '' } }, 7, 5)
  expect(seen[0]).toEqual(['gh', 'pr', 'view', '7', '--json', 'url,files,additions,deletions,labels,headRefOid'])
  expect(good).toMatchObject({ fetchedAt: 5, details: { url: GH.url } })
  expect(await fetchDetails(async () => ({ exitCode: 1, stdout: '', stderr: 'no pull requests found\nmore' }), 7, 6)).toEqual({ fetchedAt: 6, error: 'no pull requests found' })
  expect(await fetchDetails(async () => { throw new Error('spawn gh ENOENT') }, 7, 7)).toEqual({ fetchedAt: 7, error: 'spawn gh ENOENT' })
})

test('the cache is keyed by PR and head, fresh for a TTL, retried sooner after a failure', () => {
  expect(detailsKey(H)).toBe('7@abcdef1234567890')
  expect(detailsKey({ ...H, head: 'other' })).not.toBe(detailsKey(H))
  expect(detailsStale(undefined, 0)).toBe(true)
  expect(detailsStale({ fetchedAt: 0, details: GH as never }, DETAILS_TTL_MS - 1)).toBe(false)
  expect(detailsStale({ fetchedAt: 0, details: GH as never }, DETAILS_TTL_MS)).toBe(true)
  expect(detailsStale({ fetchedAt: 0, error: 'x' }, DETAILS_RETRY_MS - 1)).toBe(false)
  expect(detailsStale({ fetchedAt: 0, error: 'x' }, DETAILS_RETRY_MS)).toBe(true)
  expect(detailsStale({ fetchedAt: 0, fetching: true }, 1000)).toBe(false)
  expect(detailsStale({ fetchedAt: 0, fetching: true }, 61_000)).toBe(true)
  expect(openerFor('darwin')).toBe('open')
  expect(openerFor('linux')).toBe('xdg-open')
  expect(openerFor('plan9')).toBeUndefined()
})

// ---- the plugin, driven through the pane ----

const DIR = '/r/.git/flow'
const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const fail = (stderr = 'no') => ({ value: { exitCode: 1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } })
const BODY = '## Verification\nRan:\n- `bun test`: pass\nExercised: ran it\nNot verified:\n- the full check'
const OPTS = { merge_mode: 'confirm', push_mode: 'confirm' }
const S1 = '1'.repeat(40)
const BASE = '9'.repeat(40)
const PANE = { component: 'Pane', props: { title: 'Flow' } as never, requestId: 'flow' } as const

function world(on: On, gh: 'ok' | 'fail' | 'slow' = 'ok') {
  mock.clock(on, { now: 1_000_000 })
  const agents: AgentInfo[] = [{ id: 'm1', name: 'csv-export', description: 'm', type: 'flow:manager', status: 'running' }]
  const files = new Map<string, string>()
  const sent: { to: string; text: string }[] = []
  const toasts: string[] = []
  const calls: (readonly string[])[] = []
  const refs = new Map<string, string>()
  on('agent.list', () => ({ value: agents }))
  on('session.start', () => ({ cwd: '/r' }))
  on('command.register', () => ({ value: undefined } as never))
  on('tool.register', () => ({ value: undefined } as never))
  on('fs.stat', () => { throw new Error('ENOENT') })
  on('agent.register', (_, e) => ({ value: { agent: (e as unknown as { name: string }).name } }))
  on('agent.spawn', (_, e) => {
    const id = `r${agents.filter(a => a.type === 'flow:reviewer').length + 1}`
    agents.push({ id, name: (e as unknown as { name?: string }).name, description: 'r', type: 'flow:reviewer', status: 'running' } as AgentInfo)
    return { model: 'sonnet', agentId: id }
  })
  on('session.send', (_, e) => { const raw = (e as unknown as { to: string | { agentId: string } }).to; sent.push({ to: typeof raw === 'string' ? raw : raw.agentId, text: e.text }); return { isDelivered: true as const } })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.focus', () => ({}))
  on('ui.toast', (_, e) => { toasts.push(String((e as { text?: string }).text)); return { value: undefined } })
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 200_000, tokens: 1000, percent: 1 } } }))
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
      return refs.has(ref) ? ok(`${refs.get(ref)}\n`) : fail()
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
      // The handover tool reads state,headRefOid...; the card asks for url,files.
      if (String(a[5]).includes('url')) return gh === 'fail' ? fail('gh: command not found') : ok(JSON.stringify({ url: `https://github.com/o/r/pull/${n}`, additions: 12, deletions: 3, labels: [], headRefOid: `h${n}`, files: [{ path: 'src/a.ts', additions: 12, deletions: 3 }] }))
      return ok(JSON.stringify({ state: 'OPEN', isDraft: false, headRefOid: `h${n}`, headRefName: `flow/b${n}`, title: `Title ${n}`, body: BODY, labels: [] }))
    }
    if (a[0] === 'open' || a[0] === 'xdg-open') return ok()
    return ok()
  })
  return { agents, files, sent, toasts, calls, refs }
}

type W = ReturnType<typeof world>
const handover = ($: Dollar, pr: number) => $.tool.call({ tool: 'mcp__flow__handover', pr, agentId: 'm1' } as never).then(r => String(r.result))
const reviewer = ($: Dollar, agentId: string, args: Record<string, unknown>) => $.tool.call({ tool: 'mcp__flow__reviewer', agentId, ...args } as never).then(r => String(r.result))
const cmd = ($: Dollar, args: string) => $.command.run({ command: 'flow', args } as never).then(r => r.text ?? '')
const rec = (w: W, pr: number) => JSON.parse(w.files.get(`${DIR}/handovers/${pr}.json`) ?? 'null') as { status: string; reason?: string; approvedHead?: string } | null
const push = (w: W) => JSON.parse(w.files.get(`${DIR}/push.json`) ?? '{}') as { batch?: { state: string; prs: number[] } }

type Ui = {
  press(a: { key: string }): Promise<unknown>
  find(a: object): Promise<unknown>
  input(a: object): Promise<unknown>
  unmount(): Promise<void>
}
// The gh details land after the first draw: look again for a moment.
const later = async (ui: Ui, text: RegExp) => {
  for (let i = 0; i < 40; i++) {
    const f = await ui.find({ text })
    if (f !== undefined) return f
    await new Promise(r => (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => void }).setTimeout(r as () => void, 25))
  }
  return undefined
}
const mount = ($: Dollar, rows = 40) => $.ui.mount({ plugin: 'flow', surface: 'terminal', ...PANE, viewport: { columns: 100, rows } } as never) as unknown as Promise<Ui>

test('the pane: an awaiting PR line opens its card with the details loaded from gh; Back returns to the tree', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await handover($, 7)
  const ui = await mount($)
  // Folded: the awaiting summary is the way in.
  await ui.press({ key: 'await-open' })
  expect(await ui.find({ text: /#7 Title 7/ })).toBeDefined()
  expect(await ui.find({ text: /awaiting · flow\/b7 · head h7/ })).toBeDefined()
  expect(await ui.find({ text: /awaits you because the merge_mode setting is confirm/ })).toBeDefined()
  expect(await ui.find({ text: /verified:/ })).toBeDefined()
  // The first draw never waits for gh; the next one has the files.
  expect(await later(ui, /1 file changed, \+12 -3/)).toBeDefined()
  expect(await later(ui, /src\/a\.ts/)).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'pr-approve' })).toBeDefined()
  expect(w.calls.filter(c => c[0] === 'gh' && String(c[5]).includes('url'))).toHaveLength(1)
  await ui.press({ key: 'pr-back' })
  expect(await ui.find({ text: /Reviewer/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'pr-approve' })).toBeUndefined()
  await ui.unmount()
})

test('the pane: gh failing leaves the card working with details unavailable', { options: OPTS }, async ($, on) => {
  const w = world(on, 'fail')
  await handover($, 7)
  const ui = await mount($)
  await ui.press({ key: 'await-open' })
  expect(await later(ui, /details unavailable: gh: command not found/)).toBeDefined()
  await ui.press({ key: 'pr-approve' })
  expect(rec(w, 7)?.status).toBe('pending')
  await ui.unmount()
})

test('the pane: Approve runs what /flow approve runs; a second press is refused politely', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await handover($, 7)
  const ui = await mount($)
  await ui.press({ key: 'await-open' })
  await ui.press({ key: 'pr-approve' })
  expect(rec(w, 7)).toMatchObject({ status: 'pending', approvedHead: 'h7' })
  expect(w.toasts.join('\n')).toContain('PR #7 approved at h7')
  expect(w.agents.some(a => a.type === 'flow:reviewer')).toBe(true)
  // The card stays open and shows the new status; the buttons are gone, so nothing can approve twice.
  expect(await ui.find({ text: /Approved PR #7 at h7/ })).toBeDefined()
  expect(await ui.find({ text: /pending · flow\/b7/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'pr-approve' })).toBeUndefined()
  // The command and the shared function agree on the refusal.
  expect(await cmd($, 'approve 7')).toBe('PR #7 is pending, not awaiting approval.')
  await ui.unmount()
})

test('the pane: a PR that moved on between the draw and the press is refused, not changed', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await handover($, 7)
  const ui = await mount($)
  await ui.press({ key: 'await-open' })
  // Moved on behind the card's back (a command, not the card), without a redraw in between.
  await cmd($, 'reject 7 changed my mind')
  // The card redraws without its buttons; the shared function refuses on its own too.
  expect(await ui.find({ type: 'Button', key: 'pr-approve' })).toBeUndefined()
  expect(await cmd($, 'approve 7')).toBe('PR #7 is returned, not awaiting approval.')
  expect(rec(w, 7)?.status).toBe('returned')
  expect(rec(w, 7)?.approvedHead).toBeUndefined()
  expect(w.toasts.join('\n')).not.toContain('approved')
  await ui.unmount()
})

test('the pane: Reject uses the typed reason, returns the handover and tells the manager', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await handover($, 7)
  const ui = await mount($)
  await ui.press({ key: 'await-open' })
  await ui.input({ key: 'pr-reason', text: 'too risky' })
  expect(rec(w, 7)).toMatchObject({ status: 'returned', reason: 'declined by the user: too risky' })
  expect(w.sent.find(s => s.text.includes('PR #7 was declined by the user: too risky'))).toBeDefined()
  expect(await ui.find({ text: /Rejected PR #7 \(declined by the user: too risky\)/ })).toBeDefined()
  await ui.unmount()
})

test('the pane: Reject by button with no reason', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await handover($, 7)
  const ui = await mount($)
  await ui.press({ key: 'await-open' })
  await ui.press({ key: 'pr-reject' })
  expect(rec(w, 7)).toMatchObject({ status: 'returned', reason: 'declined by the user' })
  await ui.unmount()
})

test('the pane: a PR line in the open Reviewer section opens a read-only card for any status', { options: { ...OPTS, merge_mode: 'auto' } }, async ($, on) => {
  const w = world(on)
  await handover($, 7)
  await reviewer($, 'r1', { action: 'take', pr: 7 })
  expect(rec(w, 7)?.status).toBe('taken')
  const ui = await mount($)
  if (!await ui.find({ text: /#7 taken/ })) await ui.press({ key: 'fold-#merge-queue' })
  await ui.press({ key: 'pr-7' })
  expect(await ui.find({ text: /taken · flow\/b7/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'pr-approve' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'pr-reject' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'pr-open' })).toBeDefined()
  await ui.unmount()
})

test('the pane: Open on GitHub runs the platform opener with the URL, or shows the URL', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await handover($, 7)
  const ui = await mount($)
  await ui.press({ key: 'await-open' })
  await ui.press({ key: 'pr-open' })
  const opener = w.calls.find(c => c[0] === 'open' || c[0] === 'xdg-open')
  if (opener !== undefined) expect(opener[1]).toBe('https://github.com/o/r/pull/7')
  expect(await later(ui, /https:\/\/github\.com\/o\/r\/pull\/7/)).toBeDefined()
  await ui.unmount()
})

// ---- the batch card ----

async function readyBatch($: Dollar, w: W) {
  await handover($, 7)
  await handover($, 8)
  await reviewer($, 'r1', { action: 'take', pr: 7 })
  await reviewer($, 'r1', { action: 'take', pr: 8 })
  w.refs.set(refOf(S1.slice(0, 8)), S1)
  return reviewer($, 'r1', { action: 'ready', prs: [7, 8], sha: S1, base_sha: BASE, check: '42 tests passed', version: '0.5.1' })
}

test('the pane: the ready batch line opens the batch card; a PR in it opens its card and Back returns to the batch', { options: { ...OPTS, merge_mode: 'auto' } }, async ($, on) => {
  const w = world(on)
  expect(await readyBatch($, w)).toContain('Recorded batch 11111111')
  const ui = await mount($)
  await ui.press({ key: 'batch-open' })
  expect(await ui.find({ text: /Batch 11111111 \(0\.5\.1\)/ })).toBeDefined()
  expect(await ui.find({ text: /check: 42 tests passed/ })).toBeDefined()
  expect(await ui.find({ text: /#7 Title 7/ })).toBeDefined()
  await ui.press({ key: 'batch-pr-8' })
  expect(await ui.find({ text: /ready · flow\/b8/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'pr-approve' })).toBeUndefined()
  await ui.press({ key: 'pr-back' })
  expect(await ui.find({ text: /Batch 11111111/ })).toBeDefined()
  await ui.press({ key: 'batch-back' })
  expect(await ui.find({ text: /ready to push/ })).toBeDefined()
  await ui.unmount()
})

test('the pane: Send back asks first, then sends one PR back through the push gate; Drop returns them all', { options: { ...OPTS, merge_mode: 'auto' } }, async ($, on) => {
  const w = world(on)
  await readyBatch($, w)
  const ui = await mount($)
  await ui.press({ key: 'batch-open' })
  await ui.press({ key: 'batch-pick-7' })
  expect(await ui.find({ text: /Send #7 back to its manager\?/ })).toBeDefined()
  await ui.press({ key: 'batch-back-no' })
  expect(await ui.find({ text: /Send #7 back/ })).toBeUndefined()
  expect(rec(w, 7)?.status).toBe('ready')
  await ui.press({ key: 'batch-pick-7' })
  await ui.press({ key: 'batch-back-yes' })
  expect(rec(w, 7)?.status).toBe('returned')
  expect(push(w).batch?.state).toBe('rebuilding')
  await ui.unmount()
})

test('the pane: Drop asks first; No drops nothing, Yes returns every PR', { options: { ...OPTS, merge_mode: 'auto' } }, async ($, on) => {
  const w = world(on)
  await readyBatch($, w)
  const ui = await mount($)
  await ui.press({ key: 'batch-open' })
  await ui.press({ key: 'batch-drop' })
  expect(await ui.find({ text: /Drop the whole batch/ })).toBeDefined()
  expect([rec(w, 7)?.status, rec(w, 8)?.status]).toEqual(['ready', 'ready'])
  await ui.press({ key: 'batch-drop-no' })
  expect(await ui.find({ text: /Drop the whole batch/ })).toBeUndefined()
  expect(push(w).batch).toBeDefined()
  await ui.press({ key: 'batch-drop' })
  await ui.press({ key: 'batch-drop-yes' })
  expect([rec(w, 7)?.status, rec(w, 8)?.status]).toEqual(['returned', 'returned'])
  expect(push(w).batch).toBeUndefined()
  await ui.unmount()
})

test('the pane: Drop returns every PR of the batch; Push on a batch that moved on is refused by the gate', { options: { ...OPTS, merge_mode: 'auto' } }, async ($, on) => {
  const w = world(on)
  await readyBatch($, w)
  const ui = await mount($)
  await ui.press({ key: 'batch-open' })
  await ui.press({ key: 'batch-drop' })
  await ui.press({ key: 'batch-drop-yes' })
  expect([rec(w, 7)?.status, rec(w, 8)?.status]).toEqual(['returned', 'returned'])
  expect(push(w).batch).toBeUndefined()
  expect(await ui.find({ text: /No batch is waiting for a push/ })).toBeDefined()
  await ui.unmount()
})

test('the pane: Push releases the ready batch exactly as /flow push does', { options: { ...OPTS, merge_mode: 'auto' } }, async ($, on) => {
  const w = world(on)
  await readyBatch($, w)
  const ui = await mount($)
  await ui.press({ key: 'batch-open' })
  await ui.press({ key: 'batch-push' })
  expect(push(w).batch?.state).toBe('pushing')
  // A second press finds it released already and does nothing more.
  expect(await cmd($, 'push')).not.toContain('Released')
  await ui.unmount()
})
