import type { AgentInfo } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const DIR = '/r/.git/flow'
const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const fail = () => ({ value: { exitCode: 1, stdout: '', stderr: 'no', isStdoutTruncated: false, isStderrTruncated: false } })

// Main plus a manager m1, a worker w1 and the merge queue q1. `plugin` is what plugin.json says at the merged sha.
function world(on: On, opts: { shaVersion?: string; installed?: string; changed?: string[] | 'fail' } = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const agents: AgentInfo[] = [
    { id: 'm1', name: 'csv-export', description: 'm', type: 'flow:manager', status: 'running' },
    { id: 'w1', name: 'csv-worker', description: 'w', type: 'flow:worker', status: 'running', parentId: 'm1' },
    { id: 'q1', name: 'flow-queue', description: 'q', type: 'flow:queue', status: 'running' },
  ]
  const files = new Map<string, string>()
  const submitted: string[] = []
  on('agent.list', () => ({ value: agents }))
  on('session.start', () => ({ cwd: '/r' }))
  on('command.register', () => ({ value: undefined } as never))
  on('tool.register', () => ({ value: undefined } as never))
  on('agent.register', (_, e) => ({ value: { agent: (e as unknown as { name: string }).name } }))
  on('fs.exists', (_, e) => ({ value: files.has((e as unknown as { path: string }).path) }))
  on('fs.stat', () => { throw new Error('ENOENT') })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => { submitted.push(e.text); return { text: e.text } })
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('fs.read', (_, e) => {
    const t = files.get(e.path)
    if (t !== undefined) return { value: t }
    if (opts.installed !== undefined && e.path.endsWith('/.claude-plugin/plugin.json')) return { value: JSON.stringify({ version: opts.installed }) }
    throw new Error('ENOENT')
  })
  on('fs.list', (_, e) => ({ value: [...files.keys()].filter(k => k.startsWith(`${e.path}/`)).map(k => ({ name: k.slice(e.path.length + 1), isDirectory: false })) }) as never)
  on('process.run', (_, e) => {
    const a = e.argv
    if (a[0] === 'git' && a[1] === 'rev-parse') return ok('/r/.git\n')
    if (a[0] === 'git' && a[1] === 'show') return opts.shaVersion === undefined ? fail() : ok(JSON.stringify({ version: opts.shaVersion }))
    if (a[0] === 'gh' && a[1] === 'pr' && a[2] === 'view' && a.includes('files')) {
      return opts.changed === undefined || opts.changed === 'fail' ? fail() : ok(JSON.stringify({ files: opts.changed.map(path => ({ path })) }))
    }
    if (a[0] === 'mv') {
      const t = files.get(a[1] ?? '')
      if (t !== undefined) { files.set(a[2] ?? '', t); files.delete(a[1] ?? '') }
    }
    return ok()
  })
  return { agents, files, submitted, clock }
}

const handover = (n: number, extra: Record<string, unknown> = {}) => ({
  version: 1, pr: n, title: `Title ${n}`, head: 'h', branch: `flow/b${n}`, reportTo: 'csv-export', verified: '', pending: 'none', afterDeploy: 'x',
  status: 'pending', at: 1, ...extra,
})
const seed = (w: ReturnType<typeof world>, n: number, extra: Record<string, unknown> = {}) =>
  w.files.set(`${DIR}/handovers/${n}.json`, JSON.stringify(handover(n, extra)))
const start = ($: Dollar) => ($ as never as { session: { start: (e: unknown) => Promise<unknown> } }).session.start({ cwd: '/r', surface: null, isInteractive: false })
const done = ($: Dollar, pr: number, report: string) =>
  $.tool.call({ tool: 'mcp__flow__queue', action: 'done', pr, sha: 'abc1234', report, agentId: 'q1' } as never).then(r => String(r.result))
const check = ($: Dollar, agentId: string | null, args: Record<string, unknown>) =>
  $.tool.call({ tool: 'mcp__flow__check', ...args, ...(agentId === null ? {} : { agentId }) } as never).then(r => String(r.result))
const cmd = ($: Dollar, args: string) => $.command.run({ command: 'flow', args } as never).then(r => r.text ?? '')
const stored = (w: ReturnType<typeof world>) => JSON.parse(w.files.get(`${DIR}/checks.json`) ?? '{"items":[]}') as { items: { id: string; version?: string; state: string; closedBy?: string; note?: string; verifyCommand?: string }[]; promptedVersion?: string }

test('a done report with a needs-a-person line creates one check with the version at the merged sha, once', async ($, on) => {
  const w = world(on, { shaVersion: '0.3.40', installed: '0.3.30' })
  seed(w, 7)
  await start($)
  await done($, 7, 'full check: 3 passed | after_deploy: needs a person: PR #7: look at the pane | pending decisions: none')
  await done($, 7, 'full check: 3 passed | after_deploy: needs a person: PR #7: look at the pane')
  expect(stored(w).items.length).toBe(1)
  expect(stored(w).items[0]).toMatchObject({ id: 'c1', version: '0.3.40', state: 'open' })
  const text = await cmd($, 'checks')
  expect(text).toContain('Needs install of 0.3.40 and a restart:')
  expect(text).toContain('c1 PR #7 Title 7: look at the pane')
  expect(await cmd($, 'inbox')).toContain('Checks: 1 open (1 need install of 0.3.40)')
})

test('no check without the line, and the steps version is the fallback when the sha has no plugin.json', async ($, on) => {
  const w = world(on)
  seed(w, 7)
  seed(w, 8)
  await start($)
  await done($, 7, 'full check: 3 passed | after_deploy: passed')
  expect(stored(w).items.length).toBe(0)
  await done($, 8, 'needs a person: PR #8: install 0.9.1 and look')
  expect(stored(w).items[0]!.version).toBe('0.9.1')
})

test('backfill: a done handover on disk gets its check once, not twice across restarts', async ($, on) => {
  const w = world(on)
  seed(w, 30, { status: 'done', sha: 's', report: 'needs a person: PR #30: try it' })
  await start($)
  await start($)
  expect(stored(w).items.map(i => i.id)).toEqual(['c1'])
})

test('pass, fail with a follow-up, and refusal of a closed check; managers and workers are refused', async ($, on) => {
  const w = world(on)
  seed(w, 7, { status: 'done', sha: 's', report: 'needs a person: PR #7: a | needs a person: PR #7: b | needs a person: PR #7: c' })
  await start($)
  expect(await check($, 'm1', { action: 'list' })).toContain('Refused: only main')
  expect(await check($, 'w1', { action: 'pass', id: 'c1' })).toContain('Refused: only main')
  expect(await check($, null, { action: 'pass', ids: ['c1'] })).toBe('Passed: c1.')
  expect(await check($, null, { action: 'pass', id: 'c1' })).toContain('already passed')
  expect(await check($, null, { action: 'fail', id: 'c2' })).toContain('needs a note')
  expect(await check($, null, { action: 'fail', id: 'c2', note: 'blank page' })).toContain('Start a manager on the follow-up')
  expect(await cmd($, 'checks')).toContain('Open follow-ups from failed checks:')
  expect(await check($, null, { action: 'started', id: 'c2', manager: 'fixer' })).toContain('started by fixer')
  expect(await cmd($, 'checks')).not.toContain('Open follow-ups')
  expect(await cmd($, 'checks pass c3')).toBe('Passed: c3.')
  expect(await cmd($, 'checks fail c3 late')).toContain('already passed')
  expect(stored(w).items.map(i => i.state)).toEqual(['passed', 'failed', 'passed'])
  expect(stored(w).items[0]!.closedBy).toBe('main')
})

test('the plugin pane, resume and the inbox list open checks; resume mentions checks and starts nobody for them', async ($, on) => {
  const w = world(on)
  seed(w, 7, { status: 'done', sha: 's', report: 'needs a person: PR #7: look' })
  await start($)
  const resume = await cmd($, 'resume')
  expect(resume).toContain('Open checks')
  expect(resume).toContain('c1 PR #7')
  expect(w.submitted.filter(s => s.includes('start the managers'))).toEqual([])
  await check($, null, { action: 'fail', id: 'c1', note: 'bad' })
  expect(await cmd($, 'resume')).toContain('Open follow-ups from failed checks (start a manager on each)')
})

test('scripted checks: the queue is told to run the command, may close only those, and verify_paths can skip it', async ($, on) => {
  const w = world(on, { changed: ['src/a.ts'] })
  seed(w, 7, { verifyCommand: 'npm run smoke' })
  seed(w, 8)
  await start($)
  const r = await done($, 7, 'needs a person: PR #7: look')
  expect(r).toContain('Run `npm run smoke` in your worktree at the merged main now')
  expect(r).toContain('mcp__flow__check action pass id c1')
  await done($, 8, 'needs a person: PR #8: look too')
  expect(await cmd($, 'checks')).toContain('(scripted: npm run smoke)')
  expect(await check($, 'q1', { action: 'pass', id: 'c2' })).toContain('only main')
  expect(await check($, 'q1', { action: 'started', id: 'c1', manager: 'x' })).toContain('only main')
  expect(await check($, 'q1', { action: 'pass', id: 'c1', note: 'ok 5 tests' })).toBe('Passed: c1.')
  expect(stored(w).items[0]).toMatchObject({ state: 'passed', closedBy: 'flow-queue' })
  expect(await check($, 'w1', { action: 'pass', id: 'c1' })).toContain('Refused')
})

test('verify_paths: no changed file matching skips the command; gh failing runs it anyway', async ($, on) => {
  const w = world(on, { changed: ['docs/readme.md'] })
  w.files.set(`${DIR}/config.json`, JSON.stringify({ verify_paths: ['migrations/**'] }))
  seed(w, 7, { verifyCommand: 'npm run smoke' })
  await start($)
  const r = await done($, 7, 'needs a person: PR #7: look')
  expect(r).not.toContain('Run `npm run smoke`')
  expect(r).toContain('stays open for a person')
  expect(stored(w).items[0]!.note).toBe('scripted verification skipped: no changed file matches verify_paths')
  expect(stored(w).items[0]!.verifyCommand).toBeUndefined()
})

test('verify_paths: a matching file keeps the command', async ($, on) => {
  const w = world(on, { changed: ['migrations/1.sql'] })
  w.files.set(`${DIR}/config.json`, JSON.stringify({ verify_paths: ['migrations/**'] }))
  seed(w, 7, { verifyCommand: 'npm run smoke' })
  await start($)
  expect(await done($, 7, 'needs a person: PR #7: look')).toContain('Run `npm run smoke`')
})

test('verify_paths: gh failing runs the command anyway', async ($, on) => {
  const w = world(on, { changed: 'fail' })
  w.files.set(`${DIR}/config.json`, JSON.stringify({ verify_paths: ['migrations/**'] }))
  seed(w, 7, { verifyCommand: 'npm run smoke' })
  await start($)
  expect(await done($, 7, 'needs a person: PR #7: look')).toContain('Run `npm run smoke`')
})

test('after an update, main is prompted once per installed version with the checks it covers', async ($, on) => {
  const w = world(on, { installed: '0.3.40', shaVersion: '0.3.39' })
  seed(w, 7, { status: 'done', sha: 's', report: 'needs a person: PR #7: look' })
  await start($)
  await w.clock.advance(5)
  expect(w.submitted.length).toBe(1)
  expect(w.submitted[0]).toContain('c1 PR #7 Title 7: look')
  expect(stored(w).promptedVersion).toBe('0.3.40')
  await start($)
  expect(w.submitted.length).toBe(1)
})
