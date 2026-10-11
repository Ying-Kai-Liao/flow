import type { AgentInfo } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const DIR = '/r/.git/flow'
const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const BODY = '## Verification\nRan:\n- `bun test`: pass\nExercised: ran it\nNot verified:\n- the full check'
// merge_mode confirm makes every handover wait for /flow approve.
const OPTS = { merge_mode: 'confirm', deploy_targets: JSON.stringify([{ name: 'demo', deploy: ['./deploy demo'] }]) }

function world(on: On) {
  mock.clock(on, { now: 1_000_000 })
  const agents: AgentInfo[] = [{ id: 'm1', name: 'csv-export', description: 'm', type: 'flow:manager', status: 'running' }]
  const files = new Map<string, string>()
  const sent: { to: string; text: string }[] = []
  const toasts: string[] = []
  const calls: (readonly string[])[] = []
  on('agent.list', () => ({ value: agents }))
  on('session.start', () => ({ cwd: '/r' }))
  on('command.register', () => ({ value: undefined } as never))
  on('tool.register', () => ({ value: undefined } as never))
  on('fs.stat', () => { throw new Error('ENOENT') })
  on('agent.register', (_, e) => ({ value: { agent: (e as unknown as { name: string }).name } }))
  on('agent.spawn', (_, e) => {
    const id = `r${agents.length + 1}`
    agents.push({ id, name: (e as unknown as { name?: string }).name, description: 'r', type: 'flow:reviewer', status: 'running' } as AgentInfo)
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
  return { files, sent, toasts, calls }
}

type W = ReturnType<typeof world>
const handover = ($: Dollar, pr: number, env?: unknown[]) =>
  $.tool.call({ tool: 'mcp__flow__handover', pr, agentId: 'm1', ...(env === undefined ? {} : { env }) } as never).then(r => String(r.result))
const queue = ($: Dollar, action: string, pr: number, extra: Record<string, unknown> = {}) =>
  $.tool.call({ tool: 'mcp__flow__queue', action, pr, ...extra } as never).then(r => String(r.result))
const cmd = ($: Dollar, args: string) => $.command.run({ command: 'flow', args } as never).then(r => r.text ?? '')
const stored = (w: W, name: string) => JSON.parse(w.files.get(`${DIR}/${name}.json`) ?? 'null')
const rec = (w: W, pr: number) => stored(w, `handovers/${pr}`) as { status: string; reason?: string } | null
const items = (w: W) => (stored(w, 'inbox') ?? { items: [] }).items as Array<Record<string, unknown>>
const ghWrites = (w: W) => w.calls.filter(c => c[0] === 'gh' && c[2] !== 'view')

test('reject: an awaiting handover is returned with the reason, the manager is told, the GitHub PR is left alone', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await handover($, 7)
  expect(rec(w, 7)?.status).toBe('awaiting')
  const before = ghWrites(w).length
  const res = await cmd($, 'reject 7 too risky for now')
  expect(res).toContain('Rejected PR #7 (declined by the user: too risky for now)')
  expect(rec(w, 7)).toMatchObject({ status: 'returned', reason: 'declined by the user: too risky for now' })
  expect(w.sent.find(s => s.text.includes('PR #7 was declined by the user: too risky for now'))).toBeDefined()
  expect(w.toasts.join('\n')).toContain('PR #7 returned')
  expect(ghWrites(w)).toHaveLength(before)
  expect(w.calls.some(c => c[0] === 'git' && (c.includes('push') || c.includes('branch')))).toBe(false)
  // A second reject finds it already returned.
  expect(await cmd($, 'reject 7')).toContain('PR #7 is returned')
})

test('reject: no reason, a leading #, and the drop alias all work; a pending handover can be rejected too', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await handover($, 7)
  expect(await cmd($, 'drop #7')).toContain('Rejected PR #7 (declined by the user)')
  expect(rec(w, 7)?.reason).toBe('declined by the user')
  await handover($, 8)
  w.files.set(`${DIR}/handovers/8.json`, JSON.stringify({ ...JSON.parse(w.files.get(`${DIR}/handovers/8.json`)!), status: 'pending' }))
  expect(await cmd($, 'reject 8 later')).toContain('Rejected PR #8')
  expect(rec(w, 8)?.status).toBe('returned')
})

test('reject: refused for a taken, done or unknown handover, which stay as they were', { options: { ...OPTS, merge_mode: 'auto' } }, async ($, on) => {
  const w = world(on)
  await handover($, 7)
  await queue($, 'take', 7)
  expect(await cmd($, 'reject 7')).toContain('PR #7 is taken')
  expect(await cmd($, 'reject 7')).toContain('The reviewer owns it now')
  expect(rec(w, 7)?.status).toBe('taken')
  await queue($, 'done', 7, { sha: 'abc', report: 'merged' })
  expect(await cmd($, 'reject 7')).toContain('PR #7 is done')
  expect(rec(w, 7)?.status).toBe('done')
  expect(await cmd($, 'reject 99')).toBe('No handover for PR #99.')
})

test('reject: bad arguments show the usage and change nothing', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await handover($, 7)
  for (const a of ['reject', 'reject abc', 'reject 0', 'reject -3', 'drop']) expect(await cmd($, a)).toContain('Usage: /flow reject <pr> [reason]')
  expect(rec(w, 7)?.status).toBe('awaiting')
})

test('reject: the env items of the returned handover are closed', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await handover($, 7, [{ target: 'demo', name: 'MAIL_SENDER', value: 'Ops', why: 'sender' }])
  expect(items(w)[0]).toMatchObject({ state: 'open' })
  await cmd($, 'reject 7')
  expect(items(w)[0]).toMatchObject({ state: 'answered', answeredBy: 'flow' })
})
