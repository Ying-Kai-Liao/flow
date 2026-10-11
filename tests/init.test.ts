import { expect, mock } from 'claude-code/testing'
import { test } from './support'
import type { TestBody } from 'claude-code/testing'

import { candidatesOf, detect, firstRun, initCommand, refuse, settingsTool, writeSettings } from '../hooks/init'
import type { Detected, InitCmdIo, InitIo } from '../hooks/init'
import { advance, answer, canAdvance, inboxOf, isLast, openAsk, startDemo, STEPS, stepOf } from '../hooks/demo-replay'
import { planCleanup } from '../hooks/demo-clean'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const TOP = '/repo'
const COMMON = '/repo/.git'
const REPO_FILE = `${TOP}/.claude/flow.json`
const PERSONAL = `${COMMON}/flow/config.json`
const MARKER = `${COMMON}/flow/init-done`
const out = (stdout = '', exitCode = 0) => ({ exitCode, stdout, stderr: '' })

// An InitIo over an in-memory file map: a repo at /repo unless `git` is false.
function fake(files: Record<string, string> = {}, o: { git?: boolean; remote?: string; gh?: 'none' | 'noauth' | 'auth'; head?: string } = {}) {
  const f = new Map(Object.entries(files))
  const ran: string[][] = []
  const io: InitIo = {
    readFile: async p => f.get(p),
    exists: async p => f.has(p) || [...f.keys()].some(k => k.startsWith(`${p}/`)),
    writeFile: async (p, t) => { f.set(p, t); return true },
    mkdirp: async () => undefined,
    run: async argv => {
      ran.push(argv)
      const line = argv.join(' ')
      if (argv[0] === 'git') {
        if (o.git === false) return out('', 128)
        if (line.includes('--show-toplevel')) return out(`${TOP}\n`)
        if (line.includes('--git-common-dir')) return out(`${COMMON}\n`)
        if (line.includes('symbolic-ref')) return o.head === undefined ? out('', 1) : out(`${o.head}\n`)
        if (line === 'git remote') return out(o.remote ?? '')
      }
      if (argv[0] === 'gh') {
        if ((o.gh ?? 'none') === 'none') return out('', 127)
        return argv[1] === 'auth' ? out('', o.gh === 'auth' ? 0 : 1) : out('gh version 2')
      }
      return out('', 1)
    },
  }
  return { io, f, ran }
}

// --- detection ---

test('detection: package.json scripts and the package manager from the lockfile', async () => {
  const { io } = fake({ [`${TOP}/package.json`]: JSON.stringify({ scripts: { test: 'x', check: 'y', lint: 'z', start: 'q' } }), [`${TOP}/pnpm-lock.yaml`]: '' })
  expect(await candidatesOf(io, TOP)).toEqual([
    { command: 'pnpm run test', source: 'package.json scripts.test', role: 'test' },
    { command: 'pnpm run check', source: 'package.json scripts.check', role: 'check' },
    { command: 'pnpm run lint', source: 'package.json scripts.lint', role: 'other' },
  ])
  const npm = fake({ [`${TOP}/package.json`]: JSON.stringify({ scripts: { test: 'x', typecheck: 'y', build: 'b' } }) })
  expect((await candidatesOf(npm.io, TOP)).map(c => c.command)).toEqual(['npm test', 'npm run typecheck', 'npm run build'])
  for (const [lock, pm] of [['yarn.lock', 'yarn'], ['bun.lockb', 'bun']]) {
    const t = fake({ [`${TOP}/package.json`]: JSON.stringify({ scripts: { test: 'x' } }), [`${TOP}/${lock}`]: '' })
    expect((await candidatesOf(t.io, TOP))[0]?.command).toBe(`${pm} run test`)
  }
})

test('detection: Makefile, pytest, cargo and go; an unreadable package.json offers nothing', async () => {
  const { io } = fake({ [`${TOP}/Makefile`]: 'build:\n\tcc\ntest:\n\t./t\ncheck : test\n', [`${TOP}/pyproject.toml`]: '[tool.pytest.ini_options]\n', [`${TOP}/Cargo.toml`]: '', [`${TOP}/go.mod`]: '', [`${TOP}/package.json`]: '{nope' })
  expect((await candidatesOf(io, TOP)).map(c => c.command)).toEqual(['make test', 'make check', 'pytest', 'cargo test', 'go test ./...'])
  expect(await candidatesOf(fake().io, TOP)).toEqual([])
})

test('detection: base branch, remote, gh and every layer, an invalid file shown not clobbered', async () => {
  const w = fake({ [REPO_FILE]: JSON.stringify({ test_command: 'npm test', other: 1 }), [PERSONAL]: '{broken' }, { head: 'origin/trunk', remote: 'origin\n', gh: 'auth' })
  const d = await detect(w.io, { merge_mode: 'confirm' })
  expect(d).toMatchObject({ isRepo: true, top: TOP, common: COMMON, base: 'trunk', hasRemote: true, ghInstalled: true, ghAuthed: true, marker: false })
  expect(d.layers.map(l => [l.name, l.state])).toEqual([['config', 'ok'], ['repo', 'ok'], ['personal', 'invalid']])
  expect(d.layers[1]!.values.test_command).toBe('npm test')
  const bare = await detect(fake({}, { gh: 'noauth' }).io, {})
  expect(bare).toMatchObject({ base: 'main', hasRemote: false, ghInstalled: true, ghAuthed: false })
  expect(bare.layers.map(l => l.state)).toEqual(['missing', 'missing', 'missing'])
  expect((await detect(fake({}, { git: false }).io, {})).isRepo).toBe(false)
  // settings.base_branch wins over origin/HEAD
  expect((await detect(fake({}, { head: 'origin/trunk' }).io, { base_branch: 'develop' })).base).toBe('develop')
})

// --- the first-run hint ---

test('first-run hint: only with no settings file and no marker, in a repo', async () => {
  expect(await firstRun(fake().io)).toBe(true)
  expect(await firstRun(fake({ [REPO_FILE]: '{}' }).io)).toBe(false)
  expect(await firstRun(fake({ [PERSONAL]: '{}' }).io)).toBe(false)
  expect(await firstRun(fake({ [MARKER]: 'x' }).io)).toBe(false)
  expect(await firstRun(fake({}, { git: false }).io)).toBe(false)
})

// --- the settings write ---

const detected = async (w: ReturnType<typeof fake>): Promise<Detected> => detect(w.io, {})

test('settings write: creates the repo file, merges into an existing one, keeps unknown keys, null removes', async () => {
  const w = fake({ [REPO_FILE]: JSON.stringify({ test_command: 'old', max_workers: 2, custom_unknown: { a: 1 } }) })
  const r = await writeSettings(w.io, await detected(w), 'repo', { test_command: 'npm test', merge_mode: 'confirm', max_workers: null })
  expect(r.ok).toBe(true)
  expect(r.text).toContain('commit it')
  expect(JSON.parse(w.f.get(REPO_FILE)!)).toEqual({ test_command: 'npm test', custom_unknown: { a: 1 }, merge_mode: 'confirm' })
  expect(w.f.get(REPO_FILE)).toBe(`${JSON.stringify(JSON.parse(w.f.get(REPO_FILE)!), null, 2)}\n`)
  // Twice with the same values: the same file.
  const before = w.f.get(REPO_FILE)
  await writeSettings(w.io, await detected(w), 'repo', { test_command: 'npm test', merge_mode: 'confirm' })
  expect(w.f.get(REPO_FILE)).toBe(before)
})

test('settings write: the personal file lives under the git common dir and is not committed', async () => {
  const w = fake()
  const r = await writeSettings(w.io, await detected(w), 'personal', { push_mode: 'confirm', release: 'off' })
  expect(r.ok).toBe(true)
  expect(r.text).toContain('not committed')
  expect(JSON.parse(w.f.get(PERSONAL)!)).toEqual({ push_mode: 'confirm', release: 'off' })
  expect(w.f.has(REPO_FILE)).toBe(false)
})

test('settings write: unknown keys, wrong kinds, bad choices, secrets and nested settings are refused and nothing is written', async () => {
  const w = fake()
  const d = await detected(w)
  const bad: Record<string, unknown>[] = [
    { nonsense_key: 'x' }, { max_workers: 'three' }, { max_workers: 0 }, { push_mode: 'sometimes' }, { merge_mode: 'maybe' }, { release: 'yes' },
    { test_command: 'API_KEY=abc123 npm test' }, { test_command: 'npm test --token sk-abcdefghijklmnopqrstuvwx' }, { deploy_command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz"' },
    { manager_model: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' }, { worker_model: 'fable' }, { deploy_targets: [{ name: 'a' }] }, { guard_tests: {} },
  ]
  for (const values of bad) {
    const r = await writeSettings(w.io, d, 'repo', values)
    expect(r.ok, JSON.stringify(values)).toBe(false)
    expect(r.text).toContain('Not written')
  }
  expect(w.f.size).toBe(0)
  // One bad value refuses the whole call.
  expect((await writeSettings(w.io, d, 'repo', { test_command: 'npm test', push_mode: 'x' })).ok).toBe(false)
  expect(w.f.size).toBe(0)
  expect((await writeSettings(w.io, d, 'elsewhere', { test_command: 'a' })).ok).toBe(false)
  expect((await writeSettings(w.io, d, 'repo', {})).ok).toBe(false)
  // Ordinary commands are fine.
  for (const [k, v] of [['test_command', 'pnpm run test -- --run'], ['full_check_command', 'npm run typecheck && npm run validate'], ['max_workers', 4], ['release', 'on'], ['worker_model', 'sonnet[1m]'], ['worker_checks', ['npm test']]] as const) {
    expect(refuse(k, v), k).toBeUndefined()
  }
})

test('settings write: a file with invalid JSON is shown and refused, never clobbered', async () => {
  const w = fake({ [REPO_FILE]: '{ not json' })
  const r = await writeSettings(w.io, await detected(w), 'repo', { test_command: 'npm test' })
  expect(r.ok).toBe(false)
  expect(r.text).toContain('not valid JSON')
  expect(w.f.get(REPO_FILE)).toBe('{ not json')
  const arr = fake({ [PERSONAL]: '[1]' })
  expect((await writeSettings(arr.io, await detected(arr), 'personal', { release: 'on' })).ok).toBe(false)
  expect(arr.f.get(PERSONAL)).toBe('[1]')
  const nogit = fake({}, { git: false })
  expect((await writeSettings(nogit.io, await detected(nogit), 'repo', { release: 'on' })).ok).toBe(false)
})

test('settings tool: only main, show lists the layers, write goes through the same checks', async () => {
  const w = fake({ [REPO_FILE]: JSON.stringify({ merge_mode: 'confirm' }) })
  expect((await settingsTool(w.io, {}, { action: 'write', layer: 'repo', values: { release: 'on' } }, 'w1')).result).toContain('Refused')
  expect(JSON.parse(w.f.get(REPO_FILE)!)).toEqual({ merge_mode: 'confirm' })
  const shown = (await settingsTool(w.io, {}, { action: 'show' }, undefined)).result
  expect(shown).toContain('merge_mode="confirm"')
  expect(shown).toContain('personal file')
  expect((await settingsTool(w.io, {}, { action: 'write', layer: 'repo', values: { release: 'on' } }, undefined)).result).toContain('Wrote')
  expect(JSON.parse(w.f.get(REPO_FILE)!)).toEqual({ merge_mode: 'confirm', release: 'on' })
})

// --- the /flow init command ---

function cmdIo(d: Detected) {
  const calls: string[] = []
  const submitted: string[] = []
  let timer: (() => void) | undefined
  const io: InitCmdIo = {
    detect: async () => d,
    markDone: async () => { calls.push('mark') },
    demoStart: async () => { calls.push('start'); return 'started' },
    demoStop: async () => { calls.push('stop'); return 'stopped' },
    after: (_ms, fn) => { timer = fn },
    submit: async text => { submitted.push(text) },
  }
  return { io, calls, submitted, fire: () => timer?.() }
}

test('/flow init: text with the facts, hidden context for the skill, a prompt submitted after it returns', async () => {
  const w = fake({ [`${TOP}/package.json`]: JSON.stringify({ scripts: { test: 'x' } }) }, { remote: 'origin', gh: 'auth' })
  const c = cmdIo(await detected(w))
  const r = await initCommand(c.io, [])
  expect(r.text).toContain('walkthrough')
  expect(r.text).toContain('npm test (package.json scripts.test)')
  expect(r.context?.[0]).toContain('flow:init skill')
  expect(r.context?.[0]).toContain('part: all')
  expect(c.calls).toEqual(['mark'])
  expect(c.submitted).toEqual([])
  c.fire()
  expect(c.submitted).toHaveLength(1)
  expect(c.submitted[0]).toContain('flow:init')
})

test('/flow init settings and demo live jump to their part; demo and demo stop use the replay and ask no model', async () => {
  const d = await detected(fake())
  const s = cmdIo(d)
  expect((await initCommand(s.io, ['settings'])).context?.[0]).toContain('part: settings')
  const l = cmdIo(d)
  const live = await initCommand(l.io, ['demo', 'live'])
  expect(live.context?.[0]).toContain('part: live')
  expect(live.context?.[0]).toContain('uses tokens')
  const r = cmdIo(d)
  expect(await initCommand(r.io, ['demo'])).toEqual({ text: 'started' })
  expect(await initCommand(r.io, ['demo', 'stop'])).toEqual({ text: 'stopped' })
  r.fire()
  expect(r.submitted).toEqual([])
  expect(r.calls).toEqual(['mark', 'start', 'mark', 'stop'])
})

test('/flow init: bad arguments show the usage, a non-repo explains and stops, nothing is marked', async () => {
  const c = cmdIo(await detected(fake()))
  for (const w of [['nope'], ['settings', 'x'], ['demo', 'x'], ['demo', 'live', 'x']]) expect((await initCommand(c.io, w)).text).toContain('Usage: /flow init')
  expect(c.calls).toEqual([])
  const n = cmdIo(await detected(fake({}, { git: false })))
  const r = await initCommand(n.io, [])
  expect(r.text).toContain('needs a git repository')
  expect(r.context).toBeUndefined()
  n.fire()
  expect(n.submitted).toEqual([])
  expect(n.calls).toEqual([])
})

// --- the demo replay (pure) ---

test('replay: steps advance, a question waits for its answer and answering advances it', () => {
  let s = startDemo(1, 0)
  expect(stepOf(s).title).toBe('You hand over a task')
  const seen: string[] = []
  for (let n = 0; n < 40 && !isLast(s); n++) {
    seen.push(stepOf(s).title)
    const ask = openAsk(s)
    if (ask === undefined) {
      expect(canAdvance(s)).toBe(true)
      s = advance(s, n)
    } else {
      // Blocked until answered: advance does nothing, a wrong id does nothing.
      expect(canAdvance(s)).toBe(false)
      expect(advance(s, n)).toBe(s)
      expect(answer(s, 'zz', null, n).state).toBe(s)
      expect(inboxOf(s, n).items.at(-1)).toMatchObject({ id: ask.id, state: 'open', addressee: 'main' })
      const r = answer(s, ask.id, ask.options[1]!, n)
      expect(r.state.answers[ask.id]).toBe(ask.options[1])
      expect(r.state.step).toBe(s.step + 1)
      expect(answer(r.state, ask.id, null, n).text).toContain('not open')
      s = r.state
    }
  }
  expect(isLast(s)).toBe(true)
  expect(seen).toHaveLength(STEPS.length - 1)
  expect(canAdvance(s)).toBe(false)
  expect(advance(s, 1)).toBe(s)
  // Both asks are answered in the demo inbox; they are the demo's own ids and never real ones.
  expect(inboxOf(s, 9).items.map(q => [q.id, q.state])).toEqual([['q1', 'answered'], ['d1', 'answered']])
  expect(inboxOf(s, 9).items.find(q => q.id === 'd1')?.kind).toBe('fyi')
})

test('replay: an answer by default, letter or number all work; the replay never claims real work', () => {
  let s = startDemo(1, 0)
  while (openAsk(s) === undefined) s = advance(s, 0)
  expect(answer(s, openAsk(s)!.id, null, 0).state.answers.q1).toBe('Hello from flow')
  expect(answer(s, 'q1', 'b', 0).state.answers.q1).toBe('Hi there')
  expect(answer(s, 'q1', '2', 0).state.answers.q1).toBe('Hi there')
  for (const st of STEPS) expect(st.rows.every(r => /^(main|flow-demo(-hello)?|reviewer)$/.test(r.name))).toBe(true)
})

test('demo cleanup: only the demo\'s own worktree and branch, never the main checkout or other flow work', () => {
  const porcelain = [
    'worktree /repo\nHEAD aaa\nbranch refs/heads/main',
    'worktree /repo/.claude/worktrees/flow-demo-hello\nHEAD bbb\nbranch refs/heads/flow/flow-demo-hello',
    'worktree /repo/.claude/worktrees/csv\nHEAD ccc\nbranch refs/heads/flow/csv-export',
    'worktree /repo/.claude/worktrees/locked-demo\nHEAD ddd\nbranch refs/heads/flow/flow-demo-2\nlocked busy',
  ].join('\n\n')
  const plan = planCleanup(porcelain, ['main', 'flow/flow-demo-hello', 'flow/flow-demo', 'flow/csv-export', 'flow/flow-demo-2', 'flow/flow-demonstration', 'flow-demo'])
  expect(plan.worktrees).toEqual([{ path: '/repo/.claude/worktrees/flow-demo-hello', branch: 'flow/flow-demo-hello' }])
  expect(plan.branches.sort()).toEqual(['flow/flow-demo', 'flow/flow-demo-hello'])
  expect(plan.kept[0]).toContain('locked')
})

// --- the pane and the tools, in the engine ---

const PANE = { component: 'Pane', props: { title: 'Flow' } as never, requestId: 'flow' } as const

function world(on: On, opts: { git?: boolean; files?: Record<string, string>; agents?: { id: string; name: string; status: string }[] } = {}) {
  mock.clock(on, { now: 1_000_000 })
  const files = new Map<string, string>(Object.entries(opts.files ?? {}))
  const toasts: string[] = []
  const submitted: string[] = []
  const calls: string[][] = []
  const opened: unknown[] = []
  on('session.start', () => ({ cwd: TOP }))
  on('command.register', () => ({ value: undefined } as never))
  on('tool.register', () => ({ value: undefined } as never))
  on('agent.list', () => ({ value: (opts.agents ?? []).map(a => ({ ...a, description: 'd', type: 'flow:manager' })) }) as never)
  on('agent.register', (_, e) => ({ value: { agent: (e as unknown as { name: string }).name } }))
  on('prompt.submit', (_, e) => { submitted.push(e.text); return { text: e.text } })
  on('ui.open', (_, e) => { opened.push(e); return { value: { isPlaced: true } } })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.focus', () => ({}))
  on('ui.toast', (_, e) => { toasts.push(String((e as { text?: string }).text)); return { value: undefined } })
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 200_000, tokens: 1000, percent: 1 } } }))
  on('fs.stat', () => { throw new Error('ENOENT') })
  on('fs.exists', (_, e) => ({ value: files.has((e as unknown as { path: string }).path) }))
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('fs.read', (_, e) => {
    const t = files.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('process.run', (_, e) => {
    const a = e.argv
    calls.push([...a])
    const line = a.join(' ')
    const ok = (stdout = '', exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (a[0] === 'git' && opts.git === false) return ok('', 128)
    if (line.includes('--show-toplevel')) return ok(`${TOP}\n`)
    if (line.includes('--git-common-dir')) return ok(`${COMMON}\n`)
    if (a[0] === 'mv') {
      const t = files.get(a[1] ?? '')
      if (t !== undefined) { files.set(a[2] ?? '', t); files.delete(a[1] ?? '') }
      return ok()
    }
    if (line === 'git worktree list --porcelain') return ok(`worktree ${TOP}\nHEAD a\nbranch refs/heads/main\n\nworktree ${TOP}/.claude/worktrees/flow-demo-hello\nHEAD b\nbranch refs/heads/flow/flow-demo-hello\n\nworktree ${TOP}/.claude/worktrees/real\nHEAD c\nbranch refs/heads/flow/real\n`)
    if (line.startsWith('git for-each-ref')) return ok('flow/flow-demo-hello\nflow/real\n')
    return ok()
  })
  return { files, toasts, submitted, calls, opened }
}

const cmd = ($: Dollar, args: string) => $.command.run({ command: 'flow', args } as never).then(r => r as { text?: string; context?: string[] })
const tool = ($: Dollar, name: string, input: Record<string, unknown>, agentId?: string) => $.tool.call({ tool: `mcp__flow__${name}`, ...input, ...(agentId === undefined ? {} : { agentId }) } as never).then(r => String(r.result))

type Ui = { press(a: { key: string }): Promise<unknown>; find(a: object): Promise<unknown>; unmount(): Promise<void> }
const mount = ($: Dollar) => $.ui.mount({ plugin: 'flow', surface: 'terminal', ...PANE, viewport: { columns: 100, rows: 40 } } as never) as unknown as Promise<Ui>

test('/flow init through the plugin: hidden context, a submitted prompt, the marker written, the help text lists init', async ($, on) => {
  const w = world(on)
  const r = await cmd($, 'init settings')
  expect(r.text).toContain('your settings')
  expect(r.context?.[0]).toContain('part: settings')
  expect(w.files.has(MARKER)).toBe(true)
  expect(await cmd($, 'bogus').then(x => x.text)).toContain('/flow init')
  expect(await cmd($, 'init bogus').then(x => x.text)).toContain('Usage: /flow init')
})

test('/flow init outside a git repository explains and writes no marker', async ($, on) => {
  const w = world(on, { git: false })
  const r = await cmd($, 'init')
  expect(r.text).toContain('needs a git repository')
  expect(w.files.size).toBe(0)
})

test('the settings tool through the plugin: main writes the personal file, a subagent is refused', async ($, on) => {
  const w = world(on)
  expect(await tool($, 'settings', { action: 'write', layer: 'personal', values: { merge_mode: 'confirm' } })).toContain('Wrote')
  expect(JSON.parse(w.files.get(PERSONAL)!)).toEqual({ merge_mode: 'confirm' })
  expect(await tool($, 'settings', { action: 'write', layer: 'personal', values: { merge_mode: 'auto' } }, 'w1')).toContain('Refused')
  expect(JSON.parse(w.files.get(PERSONAL)!)).toEqual({ merge_mode: 'confirm' })
})

test('the demo replay in the pane: labelled DEMO, a question and a decision answered by the real card, nothing else touched, stop clears it', async ($, on) => {
  const w = world(on)
  expect(await cmd($, 'init demo').then(r => r.text)).toContain('No agents run, no tokens are used')
  expect(w.submitted).toEqual([])
  expect(await cmd($, 'init demo').then(r => r.text)).toContain('already running')
  const ui = await mount($)
  expect(await ui.find({ text: /DEMO/ })).toBeDefined()
  expect(await ui.find({ text: /Step 1\/8: You hand over a task/ })).toBeDefined()
  await ui.press({ key: 'demo-next' })
  await ui.press({ key: 'demo-next' })
  expect(await ui.find({ text: /Step 3\/8: A question for you/ })).toBeDefined()
  expect(await ui.find({ text: /What should flow-demo.md say/ })).toBeDefined()
  // The question blocks: no next button, the card's option answers it.
  await ui.press({ key: 'card-opt-1' })
  expect(await ui.find({ text: /Step 4\/8: The worker builds/ })).toBeDefined()
  await ui.press({ key: 'demo-next' })
  expect(await ui.find({ text: /Step 5\/8: A decision it took itself/ })).toBeDefined()
  await ui.press({ key: 'card-yes' })
  expect(await ui.find({ text: /Step 6\/8: The PR is handed over/ })).toBeDefined()
  // A replay makes no state of the real flow, runs no git write and starts no agent.
  expect([...w.files.keys()].filter(k => k.includes('/flow/') && !k.endsWith('init-done') )).toEqual([])
  expect(w.calls.some(c => c[0] === 'git' && ['commit', 'push', 'branch', 'worktree', 'checkout', 'add', 'merge'].includes(c[1] ?? ''))).toBe(false)
  expect(await cmd($, 'init demo stop').then(r => r.text)).toContain('Demo stopped')
  expect(await cmd($, 'init demo stop').then(r => r.text)).toBe('No demo is running.')
  await ui.unmount()
  const again = await mount($)
  expect(await again.find({ text: /super manager/ })).toBeDefined()
  await again.unmount()
})

test('the demo tool: status, start/stop, cleanup removes only the demo and refuses while a demo agent runs', async ($, on) => {
  const w = world(on)
  expect(await tool($, 'demo', { action: 'status' })).toContain('Replay: not running')
  expect(await tool($, 'demo', { action: 'start' })).toContain('Demo started')
  expect(await tool($, 'demo', { action: 'status' })).toContain('Replay: running')
  expect(await tool($, 'demo', { action: 'stop' })).toContain('Demo stopped')
  expect(await tool($, 'demo', { action: 'start' }, 'm1')).toContain('Refused')
  const res = await tool($, 'demo', { action: 'cleanup' })
  expect(res).toContain('flow-demo-hello')
  const removed = w.calls.filter(c => c[0] === 'git' && (c[1] === 'worktree' && c[2] === 'remove' || c[1] === 'branch'))
  expect(removed).toEqual([
    ['git', 'worktree', 'remove', '--force', `${TOP}/.claude/worktrees/flow-demo-hello`],
    ['git', 'branch', '-D', 'flow/flow-demo-hello'],
  ])
})

test('the demo tool refuses to clean while a demo agent is running', async ($, on) => {
  const w = world(on, { agents: [{ id: 'm9', name: 'flow-demo', status: 'running' }] })
  expect(await tool($, 'demo', { action: 'cleanup' })).toContain('still running')
  expect(w.calls.some(c => c[1] === 'worktree' && c[2] === 'remove')).toBe(false)
})
