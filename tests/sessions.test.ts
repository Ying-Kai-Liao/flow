import type { AgentInfo } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { codexRemaining, commandFor, harnessesOf, keysOf, percentOf, pickHost, programOf, screenHash } from '../hooks/sessions'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const DIR = '/r/.git/flow'
const PROMPT = `${DIR}/sessions/csv-codex/prompt.md`
const REPORT = `${DIR}/sessions/csv-codex/report.md`

test('the command line keeps the prompt in its file, quoted', () => {
  expect(commandFor('codex --x {prompt}', "/a b/it's.md")).toBe(`codex --x "$(cat '/a b/it'\\''s.md')"`)
  expect(commandFor('aider --message-file {prompt_file}', '/p.md')).toBe("aider --message-file '/p.md'")
  expect(commandFor('mytool', '/p.md')).toBe(`mytool "$(cat '/p.md')"`)
})

test('the harnesses setting adds, replaces and removes harnesses, as a line or a full spec; a JSON string works too', () => {
  const h = harnessesOf('{"aider": {"start": "aider --yes-always {prompt}", "resume": "aider --restore-chat-history", "quota": "echo 50"}, "gemini": "", "codex": "codex {prompt}", "bad": 3, "half": {"resume": "x"}}')
  expect(h.aider).toEqual({ start: 'aider --yes-always {prompt}', resume: 'aider --restore-chat-history', quota: 'echo 50' })
  expect(h.codex).toEqual({ start: 'codex {prompt}' })
  expect(h.gemini).toBeUndefined()
  expect(h.bad).toBeUndefined()
  expect(h.half).toBeUndefined()
  expect(h.claude?.resume).toContain('--continue')
  expect(Object.keys(harnessesOf('not json'))).toEqual(['claude', 'codex', 'gemini', 'opencode'])
})

test('auto picks Orca when it answers, else tmux; a named host must be there', () => {
  expect(pickHost('auto', true, true)).toBe('orca')
  expect(pickHost('auto', false, true)).toBe('tmux')
  expect(pickHost('tmux', true, true)).toBe('tmux')
  expect(pickHost('orca', false, true)).toMatchObject({ error: expect.stringContaining('Orca') })
  expect(pickHost('auto', false, false)).toMatchObject({ error: expect.stringContaining('tmux') })
})

// A repo at /r with a manager m1, an in-memory state dir, and every command recorded.
function world(on: On, o: { orca?: boolean; paneCommand?: string; orcaClosed?: boolean; missing?: boolean; quotaLine?: string; screen?: () => string } = {}) {
  const files = new Map<string, string>()
  const mtimes = new Map<string, number>()
  const runs: string[][] = []
  const sent: { to: string; text: string }[] = []
  const agents: AgentInfo[] = [{ id: 'm1', name: 'csv', description: 'csv export', type: 'flow:manager', status: 'running' }]
  on('agent.list', () => ({ value: agents }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.send', (_, e) => { sent.push({ to: e.to, text: e.text }); return { isDelivered: true as const } })
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('fs.read', (_, e) => {
    const t = files.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('fs.stat', (_, e) => {
    const path = (e as unknown as { path: string }).path
    if (!files.has(path)) throw new Error('ENOENT')
    return { value: { kind: 'file' as const, size: files.get(path)!.length, mtimeMs: mtimes.get(path) ?? 1, isLink: false } }
  })
  on('process.run', (_, e) => {
    const a = [...e.argv]
    runs.push(a)
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const cmd = a.join(' ')
    if (cmd.startsWith('git rev-parse')) return out('/r/.git\n')
    if (cmd === 'git worktree list --porcelain') return out('worktree /r\nHEAD abc\nbranch refs/heads/main\n')
    if (cmd === 'orca status') return o.orca ? out('appRunning: true\nruntimeReachable: true\n') : out('', 1)
    if (cmd.startsWith('orca worktree create')) return out(JSON.stringify({ ok: true, result: { worktree: { path: '/o/csv-codex' } } }))
    if (cmd.startsWith('orca terminal create')) return out(JSON.stringify({ ok: true, result: { terminal: { handle: 'term_abc' } } }))
    if (a[0] === 'sh' && cmd.includes('command -v')) return out(o.missing ? '' : '/bin/x\n', o.missing ? 1 : 0)
    if (a[0] === 'sh' && cmd.includes('rate_limits')) return out(o.quotaLine ?? '')
    if (cmd.startsWith('orca terminal show')) return out(JSON.stringify({ ok: true, result: { terminal: { handle: 'term_abc', connected: !o.orcaClosed, ...(o.orcaClosed && { exitCause: { kind: 'operator_close' } }) } } }))
    if (cmd.startsWith('tmux capture-pane') || cmd.startsWith('orca terminal read')) return out(o.screen?.() ?? 'working…')
    if (cmd.startsWith('tmux display-message')) return out(`${o.paneCommand ?? 'codex'}\n`)
    if (a[0] === 'gh') return out('[]')
    return out('')
  })
  return { files, mtimes, runs, sent, agents }
}

const call = async ($: Dollar, input: Record<string, unknown>) =>
  String((await $.tool.call({ tool: 'mcp__flow__session', agentId: 'm1', ...input } as never)).result)

const START = { action: 'start', name: 'csv-codex', harness: 'codex', brief: 'Your name: csv-codex\n\n# csv: export orders' }

test('start in tmux: a worktree on flow/<name>, the prompt in a file, codex typed into the session', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  const r = await call($, START)
  expect(r).toContain('tmux attach -t flow-csv-codex')
  expect(w.runs).toContainEqual(['git', 'worktree', 'add', '-b', 'flow/csv-codex', '/r/.claude/worktrees/csv-codex', 'origin/main'])
  expect(w.runs).toContainEqual(['tmux', 'new-session', '-d', '-s', 'flow-csv-codex', '-c', '/r/.claude/worktrees/csv-codex'])
  const typed = w.runs.find(a => a[0] === 'tmux' && a[1] === 'send-keys' && a.includes('-l'))!
  expect(typed.at(-1)).toContain(`codex --dangerously-bypass-approvals-and-sandbox "$(cat '${PROMPT}')"`)
  const prompt = w.files.get(PROMPT) ?? ''
  expect(prompt).toContain('running as codex')
  expect(prompt).toContain('Your manager is csv')
  expect(prompt).toContain(REPORT)
  expect(prompt).toContain('You are a flow worker.')
  expect(prompt.endsWith('# csv: export orders\n')).toBe(true)

  // It stands in the tree as a worker under its manager, and a second start of the name is refused.
  const status = String((await $.tool.call({ tool: 'mcp__flow__status' } as never)).result)
  expect(status).toMatch(/- manager csv: running\n\s+- worker csv-codex: running/)
  expect(await call($, START)).toContain('already running')
})

test('start in Orca: an Orca worktree renamed to flow/<name>, the harness in an Orca terminal', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on, { orca: true })
  const r = await call($, { ...START, harness: 'claude' })
  expect(r).toContain('claude in orca (term_abc)')
  expect(w.runs).toContainEqual(['git', '-C', '/o/csv-codex', 'branch', '-m', 'flow/csv-codex'])
  const create = w.runs.find(a => a.join(' ').startsWith('orca terminal create'))!
  expect(create).toContain('path:/o/csv-codex')
  expect(create[create.indexOf('--command') + 1]).toContain('claude --permission-mode bypassPermissions')
  expect(w.runs.some(a => a[0] === 'tmux')).toBe(false)
})

test('an unknown harness or a bad name is refused before anything is made', async ($, on) => {
  mock.clock(on, { now: 1 })
  const w = world(on)
  expect(await call($, { ...START, harness: 'nope' })).toContain('unknown harness "nope"')
  expect(await call($, { ...START, harness: 'command' })).toContain('needs command')
  expect(await call($, { ...START, name: 'a b' })).toContain('Refused: name')
  expect(w.runs.some(a => a.includes('worktree') && a.includes('add'))).toBe(false)
})

test('a written report goes to the manager once; send types into the terminal; a gone terminal is told', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on)
  for (const k of ['command.register', 'agent.register', 'tool.register']) on(k as 'tool.register', () => ({ value: undefined }) as never)
  on('session.start', () => ({ cwd: '/r' }))
  await $.session.start({ cwd: '/r' } as never)
  await call($, START)

  w.files.set(REPORT, 'PR #12 https://x/12\nDone.')
  w.mtimes.set(REPORT, 1_000_500)
  await clock.advance(3000)
  const reports = () => w.sent.filter(m => m.text.includes('reports:'))
  expect(reports().length).toBe(1)
  expect(reports()[0]!.to).toBe('m1')
  expect(reports()[0]!.text).toContain('PR #12 https://x/12')
  await clock.advance(6000)
  expect(reports().length).toBe(1)

  expect(await call($, { action: 'send', name: 'csv-codex', text: 'Rename the column.\nThen push.' })).toContain('Sent to csv-codex')
  expect(w.runs).toContainEqual(['tmux', 'set-buffer', '-b', 'flow-csv-codex', '--', 'Rename the column.\nThen push.'])
  expect(w.runs).toContainEqual(['tmux', 'send-keys', '-t', 'flow-csv-codex', 'Enter'])

  // A rewritten report is a new report.
  w.mtimes.set(REPORT, 1_010_000)
  w.files.set(REPORT, 'Renamed. PR #12 updated.')
  await clock.advance(3000)
  expect(reports().length).toBe(2)
})

test('a harness back at its shell without a report is told once; stop keeps a dirty worktree', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { paneCommand: 'zsh' })
  for (const k of ['command.register', 'agent.register', 'tool.register']) on(k as 'tool.register', () => ({ value: undefined }) as never)
  on('session.start', () => ({ cwd: '/r' }))
  await $.session.start({ cwd: '/r' } as never)
  await call($, START)
  await clock.advance(31_000)
  await clock.advance(31_000)
  const gone = w.sent.filter(m => m.text.includes('ended without writing a new report'))
  expect(gone.length).toBe(1)
  expect(await call($, { action: 'send', name: 'csv-codex', text: 'hi' })).toContain('has exited')

  const r = await call($, { action: 'stop', name: 'csv-codex', remove_worktree: true })
  expect(r).toContain('Kept the worktree')
  expect(w.runs.some(a => a.join(' ') === 'git worktree remove /r/.claude/worktrees/csv-codex')).toBe(false)
})

test('an Orca terminal that closed still answers show: connected false counts as gone', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { orca: true, orcaClosed: true })
  for (const k of ['command.register', 'agent.register', 'tool.register']) on(k as 'tool.register', () => ({ value: undefined }) as never)
  on('session.start', () => ({ cwd: '/r' }))
  await $.session.start({ cwd: '/r' } as never)
  await call($, START)
  await clock.advance(31_000)
  expect(w.sent.filter(m => m.text.includes('ended without writing a new report')).length).toBe(1)
  expect(await call($, { action: 'list' })).toContain('exited')
})

const rl = (at: string, primary: number, secondary: number, resets = 9_999_999_999) => JSON.stringify({
  timestamp: at, type: 'event_msg',
  payload: { type: 'token_count', rate_limits: { primary: { used_percent: primary, resets_at: resets }, secondary: { used_percent: secondary, resets_at: resets } } },
})

test('Codex quota: the lowest window left; a past reset is unused; an old reading says nothing', () => {
  const now = Date.parse('2026-10-09T12:00:00Z')
  expect(codexRemaining(rl('2026-10-09T11:00:00Z', 30, 95), now)).toBe(5)
  expect(codexRemaining(rl('2026-10-09T11:00:00Z', 30, 95, now / 1000 - 1), now)).toBe(100)
  expect(codexRemaining(rl('2026-10-08T11:00:00Z', 30, 95), now)).toBeUndefined()
  expect(codexRemaining('not json', now)).toBeUndefined()
  expect(programOf('codex --x {prompt}')).toBe('codex')
  expect(programOf('FOO=1 codex')).toBeUndefined()
  expect(percentOf('remaining: 42.6%')).toBe(43)
  expect(percentOf('none')).toBeUndefined()
})

test('keys: named keys for tmux and as bytes for Orca; other words are typed', () => {
  expect(keysOf('1 enter')).toEqual({ tmux: ['1', 'Enter'], raw: '1\r' })
  expect(keysOf('Escape interrupt down')).toEqual({ tmux: ['Escape', 'C-c', 'Down'], raw: '\x1b\x03\x1b[B' })
  expect(screenHash('a  \nb\n\n')).toBe(screenHash('a\nb'))
  expect(screenHash('a')).not.toBe(screenHash('b'))
})

test('a missing harness or a Codex low on quota is refused before anything is made', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-09T12:00:00Z') })
  const w = world(on, { missing: true })
  expect(await call($, START)).toContain('codex is not installed')
  expect(w.runs.some(a => a.includes('worktree') && a.includes('add'))).toBe(false)
})

test('Codex under codex_min_quota is refused; Claude is not checked', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-09T12:00:00Z') })
  const w = world(on, { quotaLine: rl('2026-10-09T11:30:00Z', 10, 96) })
  expect(await call($, START)).toContain('codex has 4% of its quota left')
  expect(await call($, { ...START, harness: 'claude' })).toContain('Started csv-codex')
  expect(w.runs.filter(a => a.join(' ').includes('rate_limits')).length).toBe(1)
})

async function started($: Dollar, on: On, o: Parameters<typeof world>[1] = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, o)
  for (const k of ['command.register', 'agent.register', 'tool.register']) on(k as 'tool.register', () => ({ value: undefined }) as never)
  on('session.start', () => ({ cwd: '/r' }))
  await $.session.start({ cwd: '/r' } as never)
  return { clock, w }
}

test('keys are pressed the same way in any harness: tmux key names, Orca bytes', async ($, on) => {
  const { w } = await started($, on)
  await call($, { ...START, harness: 'gemini' })
  expect(await call($, { action: 'keys', name: 'csv-codex', keys: '2 enter' })).toContain('Pressed 2 enter')
  expect(w.runs).toContainEqual(['tmux', 'send-keys', '-t', 'flow-csv-codex', '2', 'Enter'])
  expect(await call($, { action: 'keys', name: 'csv-codex', keys: '' })).toContain('Named keys')
})

test('a screen that stops changing with no report is told once as idle; a change wakes it again', async ($, on) => {
  let screen = 'Do you want to run git push? 1. Yes 2. No'
  const { clock, w } = await started($, on, { screen: () => screen })
  await call($, START)
  for (let i = 0; i < 12; i++) await clock.advance(10_000)
  const idle = () => w.sent.filter(m => m.text.includes('has shown nothing new'))
  expect(idle().length).toBe(1)
  expect(idle()[0]!.to).toBe('m1')
  expect(idle()[0]!.text).toContain('Do you want to run git push?')
  expect(await call($, { action: 'list' })).toContain('idle')
  for (let i = 0; i < 6; i++) await clock.advance(10_000)
  expect(idle().length).toBe(1)

  // It moves on, then stops again: a second notice.
  screen = 'Pushing…'
  await clock.advance(13_000)
  expect(await call($, { action: 'list' })).toContain('running')
  for (let i = 0; i < 12; i++) await clock.advance(10_000)
  expect(idle().length).toBe(2)
})

test('restart in tmux: a fresh shell in the same pane, then the harness resume line', async ($, on) => {
  const { w } = await started($, on)
  await call($, START)
  expect(await call($, { action: 'restart', name: 'csv-codex' })).toContain('codex resume --last')
  expect(w.runs).toContainEqual(['tmux', 'respawn-pane', '-k', '-t', 'flow-csv-codex', '-c', '/r/.claude/worktrees/csv-codex'])
  const typed = w.runs.filter(a => a[1] === 'send-keys' && a.includes('-l')).at(-1)!
  expect(typed.at(-1)).toContain('codex resume --last --dangerously-bypass-approvals-and-sandbox')

  // A harness without a resume line starts again with the same prompt.
  await call($, { action: 'stop', name: 'csv-codex' })
  await call($, { ...START, name: 'csv-gem', harness: 'gemini' })
  expect(await call($, { action: 'restart', name: 'csv-gem' })).toContain('its start line and the same prompt')
})

test('restart in Orca opens a new terminal in the worktree and closes the old one', async ($, on) => {
  const { w } = await started($, on, { orca: true })
  await call($, { ...START, harness: 'claude' })
  expect(await call($, { action: 'restart', name: 'csv-codex' })).toContain('claude --continue')
  const creates = w.runs.filter(a => a.join(' ').startsWith('orca terminal create'))
  expect(creates.length).toBe(2)
  expect(creates[1]![creates[1]!.indexOf('--command') + 1]).toContain('claude --continue')
  expect(w.runs).toContainEqual(['orca', 'terminal', 'close', '--terminal', 'term_abc', '--json'])
})

test('a harness with its own quota command is checked against min_quota', async ($, on) => {
  mock.clock(on, { now: 1 })
  const w = world(on)
  on('session.start', () => ({ cwd: '/r' }))
  for (const k of ['command.register', 'agent.register', 'tool.register']) on(k as 'tool.register', () => ({ value: undefined }) as never)
  // A harness from the settings, with a quota command; the mock's sh prints nothing for it, so it can't tell and starts.
  expect(await call($, { ...START, harness: 'command', command: 'mytool {prompt}' })).toContain('Started csv-codex')
  expect(w.runs.some(a => a.join(' ').includes('rate_limits'))).toBe(false)
})
