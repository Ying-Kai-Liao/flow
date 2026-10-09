import type { AgentInfo } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { isFable, KEYS, mergeLayers } from '../hooks/settings'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const REPO = '/repo/.claude/flow.json'
const OVERLAY = '/repo/.git/flow/config.json'

// A repo at /repo: the two settings files are whatever `files` holds; `mtimes` is bumped on a change.
function world(on: On, files: Record<string, string>, opts: { git?: boolean; agents?: AgentInfo[] } = {}) {
  const mtimes: Record<string, number> = {}
  const registered: { name: string; model?: string; prompt: string }[] = []
  const toasts: string[] = []
  const isGit = opts.git !== false
  on('process.run', (_, e) => {
    const cmd = (e as unknown as { argv: string[] }).argv
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const line = cmd.join(' ')
    if (!isGit) return out('', 128)
    if (line.includes('--show-toplevel')) return out('/repo\n')
    if (line.includes('--git-common-dir')) return out('/repo/.git\n')
    if (line.includes('symbolic-ref')) return out('origin/main\n')
    return out('', 1)
  })
  on('fs.exists', (_, e) => ({ value: (e as unknown as { path: string }).path in files }))
  on('fs.read', (_, e) => ({ value: files[(e as unknown as { path: string }).path] ?? '' }))
  on('fs.stat', (_, e) => {
    const path = (e as unknown as { path: string }).path
    if (!(path in files)) throw new Error('ENOENT')
    return { value: { kind: 'file' as const, size: files[path]!.length, mtimeMs: mtimes[path] ?? 1, isLink: false } }
  })
  on('agent.register', (_, e) => {
    registered.push(e as unknown as { name: string; model?: string; prompt: string })
    return { value: { agent: (e as unknown as { name: string }).name } }
  })
  on('ui.toast', (_, e) => { toasts.push(String((e as { text?: string }).text ?? JSON.stringify(e))); return { value: undefined } })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('agent.list', () => ({ value: opts.agents ?? [] }))
  on('session.start', () => ({ cwd: '/repo' }))
  const clock = mock.clock(on, { now: 1_000_000 })
  on('command.register', () => ({ value: undefined } as never))
  on('tool.register', () => ({ value: undefined } as never))
  return {
    registered, toasts, clock,
    touch: (path: string, text?: string) => { if (text !== undefined) files[path] = text; mtimes[path] = (mtimes[path] ?? 1) + 1 },
    remove: (path: string) => { delete files[path] },
    last: (name: string) => registered.filter(r => r.name === name).at(-1),
  }
}

const start = ($: Dollar) =>
  ($ as never as { session: { start: (e: unknown) => Promise<unknown> } }).session.start({ cwd: '/repo', surface: null, isInteractive: false })

test('the repo file lays over /config, the overlay over the repo file', { options: { max_workers: 5, worker_model: 'haiku', test_command: 'npm test' } }, async ($, on) => {
  const w = world(on, {
    [REPO]: JSON.stringify({ worker_model: 'opus', test_command: 'pnpm test' }),
    [OVERLAY]: JSON.stringify({ test_command: 'make test' }),
  })
  await start($)
  const worker = w.last('worker')!
  expect(worker.model).toBe('opus')
  expect(worker.prompt).toContain('make test')
  expect(worker.prompt).not.toContain('pnpm test')
  expect(w.toasts).toEqual([])
})

test('list keys from the overlay are added to the repo file\'s, once each', () => {
  const r = mergeLayers({}, [
    { path: REPO, text: JSON.stringify({ worker_checks: ['a', 'b'], always_tests: ['t'], flaky_tests: ['f1'], big_files: ['x'] }) },
    { path: OVERLAY, text: JSON.stringify({ worker_checks: ['b', 'c'], always_tests: [], flaky_tests: ['f2', 'f1'], big_files: null }) },
  ])
  expect(r.raw.worker_checks).toEqual(['a', 'b', 'c'])
  expect(r.raw.always_tests).toEqual(['t'])
  expect(r.raw.flaky_tests).toEqual(['f1', 'f2'])
  expect(r.raw.big_files).toEqual(['x'])
  expect(r.files).toEqual([REPO, OVERLAY])
  expect(r.warnings).toEqual([])
})

test('decision_phrases warns that it is deprecated and still applies', () => {
  const r = mergeLayers({}, [{ path: REPO, text: JSON.stringify({ decision_phrases: ['which approach'] }) }])
  expect(r.warnings.some(x => x.includes(REPO) && x.includes('decision_phrases') && x.includes('deprecated'))).toBe(true)
  expect(r.raw.decision_phrases).toEqual(['which approach'])
  const empty = mergeLayers({}, [{ path: REPO, text: JSON.stringify({ decision_phrases: [] }) }])
  expect(empty.warnings).toEqual([])
})

test('the repo file replaces a list from /config; only the overlay appends', () => {
  const r = mergeLayers({ worker_checks: ['cfg'] }, [
    { path: REPO, text: JSON.stringify({ worker_checks: ['repo'] }) },
    { path: OVERLAY, text: JSON.stringify({ worker_checks: ['mine'] }) },
  ])
  expect(r.raw.worker_checks).toEqual(['repo', 'mine'])
})

test('the repo file lays over /config, the overlay over the repo file', () => {
  const r = mergeLayers({ max_workers: 5, test_command: 'npm test' }, [
    { path: REPO, text: JSON.stringify({ test_command: 'pnpm test' }) },
    { path: OVERLAY, text: JSON.stringify({ test_command: 'make test' }) },
  ])
  expect(r.raw).toEqual({ max_workers: 5, test_command: 'make test' })
})

test('an unknown key, bad JSON or a wrong type warns and the default applies', () => {
  const r = mergeLayers({ max_workers: 4 }, [
    { path: REPO, text: JSON.stringify({ max_workes: 2, max_workers: 'many', worker_model: 'opus' }) },
    { path: OVERLAY, text: '{ not json' },
  ])
  expect(r.warnings.some(x => x.includes(REPO) && x.includes('max_workes') && x.includes('max_workers'))).toBe(true)
  expect(r.warnings.some(x => x.includes('"max_workers"') && x.includes('number'))).toBe(true)
  expect(r.warnings.some(x => x.includes(OVERLAY) && x.includes('not valid JSON'))).toBe(true)
  expect(r.raw.max_workers).toBe(4)
  expect(r.raw.max_workes).toBe(2)
  expect(r.raw.worker_model).toBe('opus')
  expect(r.files).toEqual([REPO])
})

test('a missing file is silent; a file that is not an object is skipped', () => {
  const quiet = mergeLayers({}, [{ path: REPO, text: undefined }, { path: OVERLAY, text: undefined }])
  expect(quiet).toEqual({ raw: {}, files: [], warnings: [] })
  const r = mergeLayers({}, [{ path: REPO, text: '[1]' }])
  expect(r.warnings.some(x => x.includes('not a JSON object'))).toBe(true)
  expect(r.files).toEqual([])
})

test('deploy_targets, state_file and test_slots keep their shape and are replaced whole', () => {
  const targets = [{ name: 'web', command: 'deploy web' }]
  const r = mergeLayers({ deploy_targets: [{ name: 'old' }] }, [
    { path: REPO, text: JSON.stringify({ deploy_targets: targets, state_file: { path: 'x.json' }, test_slots: 2 }) },
    { path: OVERLAY, text: JSON.stringify({ deploy_targets: [{ name: 'mine' }] }) },
  ])
  expect(r.raw.deploy_targets).toEqual([{ name: 'mine' }])
  expect(r.raw.state_file).toEqual({ path: 'x.json' })
  expect(r.raw.test_slots).toBe(2)
  const bad = mergeLayers({}, [{ path: REPO, text: JSON.stringify({ deploy_targets: ['web'], state_file: [1], test_slots: 'two' }) }])
  expect(bad.raw).toEqual({})
  expect(bad.warnings.length).toBe(3)
})

test('a Fable model is refused in every layer, a real one kept', () => {
  expect(isFable('Claude-Fable-1')).toBe(true)
  expect(isFable('opus')).toBe(false)
  const r = mergeLayers({ worker_model: 'fable' }, [{ path: REPO, text: JSON.stringify({ manager_model: 'Claude-Fable-1', queue_model: 'sonnet' }) }])
  expect(r.raw).toEqual({ queue_model: 'sonnet' })
  expect(r.warnings.length).toBe(2)
})

test('a Fable model setting is refused at load', async ($, on) => {
  const w = world(on, { [REPO]: JSON.stringify({ manager_model: 'Claude-Fable-1', worker_model: 'fable' }) })
  await start($)
  expect(w.last('worker')!.model).toBe('sonnet[1m]')
  expect(w.last('manager')!.model).toBe('opus')
  expect(w.toasts.join('\n')).toContain('Fable')
})

test('agents carry the configured models, opus for manager and queue by default', async ($, on) => {
  const w = world(on, {})
  await start($)
  expect(w.last('manager')!.model).toBe('opus')
  expect(w.last('queue')!.model).toBe('opus')
  expect(w.last('worker')!.model).toBe('sonnet[1m]')
})

test('a Fable spawn of a flow agent, or by one, is denied; others pass', async ($, on) => {
  const agents: AgentInfo[] = [{ id: 'm1', name: 'task', description: 't', type: 'flow:manager', status: 'running' }]
  world(on, {}, { agents })
  const spawned: string[] = []
  on('agent.spawn', (_, e) => { spawned.push((e as unknown as { subagentType: string }).subagentType); return { model: 'sonnet', agentId: 'a1' } })
  await start($)
  const spawn = (subagentType: string, model: string | undefined, parentAgentId?: string) =>
    $.agent.spawn({ prompt: 'p', description: 'd', subagentType, model, parentAgentId } as never)
  const denied = await spawn('flow:worker', 'fable')
  expect(JSON.stringify(denied)).toContain('sub-agents don')
  expect(JSON.stringify(await spawn('general-purpose', 'fable', 'm1'))).toContain('Fable')
  expect(spawned).toEqual([])
  await spawn('general-purpose', 'fable')
  await spawn('flow:worker', 'sonnet')
  expect(spawned).toEqual(['general-purpose', 'flow:worker'])
})

test('a changed settings file is picked up by the poll, once', async ($, on) => {
  const w = world(on, { [REPO]: JSON.stringify({ worker_model: 'opus' }) })
  const { clock } = w
  await start($)
  expect(w.last('worker')!.model).toBe('opus')
  const before = w.registered.length

  await clock.advance(3000)
  expect(w.registered.length).toBe(before) // no change, no re-registration

  w.touch(REPO, JSON.stringify({ worker_model: 'haiku', bogus: 1 }))
  await clock.advance(3000)
  await clock.settle()
  expect(w.last('worker')!.model).toBe('haiku')
  expect(w.toasts.filter(t => t.includes('bogus')).length).toBe(1)

  await clock.advance(9000)
  expect(w.toasts.filter(t => t.includes('bogus')).length).toBe(1)

  // A file appearing, then half-written, then fixed.
  w.touch(OVERLAY, '{')
  await clock.advance(3000)
  await clock.settle()
  expect(w.last('worker')!.model).toBe('haiku')
  expect(w.toasts.some(t => t.includes('not valid JSON'))).toBe(true)
  w.touch(OVERLAY, JSON.stringify({ worker_model: 'sonnet' }))
  await clock.advance(3000)
  await clock.settle()
  expect(w.last('worker')!.model).toBe('sonnet')
})

test('a reload re-registers the agents with the new models and applies the new limits', async ($, on) => {
  const w = world(on, { [REPO]: JSON.stringify({ merge_queue: true, max_managers: 7 }) })
  on('tool.call', () => ({ result: 'ok' }) as never)
  await start($)
  const call = (input: Record<string, unknown>) => $.tool.call(input as never).then(r => String(r.result))
  expect(w.last('manager')!.model).toBe('opus')
  expect(await call({ tool: 'mcp__flow__status' })).toContain('managers 0/7')
  expect(await call({ tool: 'mcp__flow__handover', pr: 5, verified: 'x' })).not.toContain('no merge queue')

  // Same mtime: nothing is read again.
  const before = w.registered.length
  await w.clock.advance(9000)
  await w.clock.settle()
  expect(w.registered.length).toBe(before)

  w.touch(REPO, JSON.stringify({ merge_queue: false, max_managers: 2, test_slots: 3, manager_model: 'sonnet' }))
  await w.clock.advance(3000)
  await w.clock.settle()
  expect(w.registered.length).toBeGreaterThan(before)
  expect(w.last('manager')!.model).toBe('sonnet')
  expect(await call({ tool: 'mcp__flow__handover', pr: 6, verified: 'x' })).toContain('no merge queue')
  expect(await call({ tool: 'mcp__flow__status' })).toContain('managers 0/2')
})

test('a refused [1m] model falls back once to the plain model, tells once, and later spawns skip the try', { options: { worker_model: 'sonnet[1m]' } }, async ($, on) => {
  const w = world(on, {})
  const tried: (string | undefined)[] = []
  on('agent.spawn', (_, e) => {
    const model = (e as unknown as { model?: string }).model
    tried.push(model)
    if (model?.includes('[1m]')) return { deny: 'model sonnet[1m] is not available for sub-agents' }
    return { model: model ?? 'none', agentId: `a${tried.length}` }
  })
  await start($)
  const spawn = (model?: string) => $.agent.spawn({ prompt: 'p', description: 'd', subagentType: 'flow:worker', model } as never)
  const first = await spawn('sonnet[1m]')
  expect(JSON.stringify(first)).toContain('a2')
  expect(tried).toEqual(['sonnet[1m]', 'sonnet'])
  expect(w.toasts.filter(t => t.includes('was refused'))).toEqual(['flow: sonnet[1m] was refused for sub-agents; using sonnet'])

  await spawn('sonnet[1m]')
  expect(tried.slice(2)).toEqual(['sonnet'])
  // No model given: the registered worker model is the one tried and stripped.
  await spawn()
  expect(tried.at(-1)).toBe('sonnet')
  expect(w.toasts.filter(t => t.includes('was refused')).length).toBe(1)
})

// The test loader cannot import JSON, so the userConfig keys of .claude-plugin/plugin.json are listed by hand: keep in step.
// A key the loader does not know would be set in the plugin UI and silently ignored.
const USER_CONFIG_KEYS = [
  'test_command', 'full_check_command', 'deploy_command', 'merge_method', 'merge_mode', 'merge_queue', 'max_managers', 'max_workers',
  'test_slots', 'context_warn_percent', 'context_warn_percent_1m', 'context_warn_tokens', 'handoff', 'main_checkout_guard', 'main_checkout_allow', 'max_continues',
  'worker_model', 'manager_model', 'queue_model', 'language', 'base_branch', 'cleanup',
]

test('every userConfig key in plugin.json is a settings key', () => {
  const missing = USER_CONFIG_KEYS.filter(k => !(k in KEYS))
  expect(missing).toEqual([])
})

test("the worker agent carries the repo file required checks", async ($, on) => {
  const w = world(on, { [REPO]: JSON.stringify({ worker_checks: ["tsc -p ."] }) })
  await start($)
  expect(w.last("worker")!.prompt).toContain("`tsc -p .`")
  expect(w.last("manager")!.prompt).not.toContain("`tsc -p .`")
})
