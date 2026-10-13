import type { AgentInfo } from 'claude-code'
import { expect, mock } from 'claude-code/testing'
import { test } from './support'
import type { TestBody } from 'claude-code/testing'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const DIR = '/r/.git/flow'
const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const BODY = '## Verification\nRan:\n- `bun test`: pass\nExercised: ran it\nNot verified:\n- the full check'
const TMUX = { mode: 'tmux' }

// The breaker tests' world plus a tmux that starts, types and dies on cue.
function world(on: On) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const agents: AgentInfo[] = [{ id: 'm1', name: 'csv-export', description: 'm', type: 'flow:manager', status: 'running' }]
  const files = new Map<string, string>()
  const mtimes = new Map<string, number>()
  const spawns: { name: string | undefined; prompt: string }[] = []
  const toasts: string[] = []
  const runs: string[][] = []
  const state = { alive: true, tmuxDown: false }
  on('agent.list', () => ({ value: agents }))
  on('session.start', () => ({ cwd: '/r' }))
  on('command.register', () => ({ value: undefined } as never))
  on('tool.register', () => ({ value: undefined } as never))
  on('agent.register', (_, e) => ({ value: { agent: (e as unknown as { name: string }).name } }))
  on('agent.spawn', (_, e) => {
    const input = e as unknown as { subagentType: string; name?: string; description: string; prompt: string }
    const id = `r${spawns.length + 1}`
    spawns.push({ name: input.name, prompt: input.prompt })
    agents.push({ id, name: input.name, description: input.description, type: input.subagentType, status: 'running' })
    return { model: 'sonnet', agentId: id }
  })
  on('session.send', () => ({ isDelivered: true as const }))
  const prompts: string[] = []
  on('prompt.submit', (_, e) => { prompts.push(e.text); return { text: e.text } })
  on('turn.complete', (_, e) => ({ text: e.answer }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', (_, e) => { toasts.push(String((e as { text?: string }).text)); return { value: undefined } })
  on('fs.exists', (_, e) => ({ value: files.has((e as unknown as { path: string }).path) }))
  on('fs.stat', (_, e) => {
    const path = (e as unknown as { path: string }).path
    if (!files.has(path)) throw new Error('ENOENT')
    return { value: { kind: 'file' as const, size: 1, mtimeMs: mtimes.get(path) ?? 1, isLink: false } }
  })
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('fs.read', (_, e) => {
    const t = files.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('fs.list', (_, e) => ({ value: [...files.keys()].filter(k => k.startsWith(`${e.path}/`)).map(k => ({ name: k.slice(e.path.length + 1), isDirectory: false })) }) as never)
  on('process.run', (_, e) => {
    const a = [...e.argv]
    runs.push(a)
    const cmd = a.join(' ')
    if (a[0] === 'git' && a[1] === 'rev-parse' && a.includes('--git-common-dir')) return ok('/r/.git\n')
    if (cmd === 'git worktree list --porcelain') return ok('worktree /r\nHEAD abc\nbranch refs/heads/main\n')
    if (cmd === 'orca status') return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (cmd === 'tmux -V') return state.tmuxDown ? { value: { exitCode: 127, stdout: '', stderr: 'not found', isStdoutTruncated: false, isStderrTruncated: false } } : ok('tmux 3.4')
    if (cmd.startsWith('tmux display-message')) return ok(state.alive ? 'claude\n' : 'zsh\n')
    if (cmd.startsWith('tmux capture-pane')) return ok('')
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
  return { agents, files, mtimes, spawns, toasts, runs, clock, state, prompts }
}

type W = ReturnType<typeof world>
const handover = ($: Dollar, pr: number) => $.tool.call({ tool: 'mcp__flow__handover', pr, agentId: 'm1' } as never).then(r => String(r.result))
const start = ($: Dollar) => ($ as never as { session: { start: (e: unknown) => Promise<unknown> } }).session.start({ cwd: '/r', surface: null, isInteractive: false })
const stored = (w: W, name: string) => JSON.parse(w.files.get(`${DIR}/${name}.json`) ?? 'null')
const spawnManager = ($: Dollar, name: string) =>
  $.agent.spawn({ prompt: 'Build the csv export.', description: name, name, subagentType: 'flow:manager' } as never).then(r => JSON.stringify(r), e => String(e))
const newSessions = (w: W) => w.runs.filter(a => a[0] === 'tmux' && a[1] === 'new-session').map(a => a[a.indexOf('-s') + 1])
const typed = (w: W) => w.runs.filter(a => a[0] === 'tmux' && a[1] === 'set-buffer').map(a => a.at(-1))
// The session `name` writes its report file and the watcher (every poll) picks it up.
async function report(w: W, name: string, text: string) {
  const file = `${DIR}/sessions/${name}/report.md`
  w.files.set(file, text)
  w.mtimes.set(file, (await w.clock.now()) - 5000)
  await w.clock.advance(3500)
  await w.clock.settle()
}

test('mode tmux: main\'s manager spawn starts a terminal session and is answered as a success', { options: TMUX }, async ($, on) => {
  const w = world(on)
  await start($)
  const r = await spawnManager($, 'csv-mgr')
  expect(r).toContain('started manager csv-mgr in tmux')
  expect(r).toContain('This is not an error: do not spawn it again')
  expect(w.spawns).toEqual([])
  expect(newSessions(w)).toEqual(['flow-csv-mgr'])
  const prompt = w.files.get(`${DIR}/sessions/csv-mgr/prompt.md`)!
  expect(prompt).toContain('You run in a terminal')
  expect(prompt).toContain('Build the csv export.')
  expect(stored(w, 'sessions')['csv-mgr']).toMatchObject({ role: 'manager', owner: 'main' })
  // The pre-flight record an in-process manager gets.
  expect(stored(w, 'preflight').entries['csv-mgr']).toBeDefined()
})

test('mode agent (the default) starts the agent as before', async ($, on) => {
  const w = world(on)
  await start($)
  const r = await spawnManager($, 'csv-mgr')
  expect(r).not.toContain('terminal session')
  expect(w.spawns.map(s => s.name)).toEqual(['csv-mgr'])
  expect(newSessions(w)).toEqual([])
})

test('a terminal mode starts the manager as claude whatever worker_harness is', { options: { ...TMUX, worker_harness: 'codex' } }, async ($, on) => {
  const w = world(on)
  await start($)
  await spawnManager($, 'csv-mgr')
  expect(w.spawns).toEqual([])
  expect(stored(w, 'sessions')['csv-mgr']).toMatchObject({ role: 'manager', harness: 'claude' })
})

test('mode tmux, auto: two handovers use one terminal; the second is typed into it', { options: TMUX }, async ($, on) => {
  const w = world(on)
  await start($)
  expect(await handover($, 7)).toContain('Started reviewer reviewer-1')
  expect(w.spawns).toEqual([])
  expect(newSessions(w)).toEqual(['flow-reviewer-1'])
  expect(w.files.get(`${DIR}/sessions/reviewer-1/prompt.md`)).toContain('typed into the terminal means start again')
  expect(stored(w, 'sessions')['reviewer-1']).toMatchObject({ role: 'reviewer', nudged: [expect.stringMatching(/^7:/)] })

  expect(await handover($, 8)).toContain('The reviewer in tmux picks it up')
  expect(newSessions(w)).toEqual(['flow-reviewer-1'])
  expect(typed(w)).toEqual(['new handover: #8'])
  expect(stored(w, 'sessions')['reviewer-1'].nudged).toHaveLength(2)
  // Told once: a repeat ensureQueue types nothing more.
  expect(await handover($, 8)).toContain('already been told')
  expect(typed(w)).toEqual(['new handover: #8'])
})

test('reviewer in a terminal with merge_mode confirm: one batch, the session is stopped after its report and the next start is reviewer-2', { options: { merge_mode: 'confirm', ...TMUX } }, async ($, on) => {
  const w = world(on)
  await start($)
  // A confirm-mode PR waits for the user; the approval starts the reviewer.
  expect(await handover($, 7)).toContain('awaits the user')
  await $.command.run({ command: 'flow', args: 'approve 7' } as never)
  await w.clock.settle()
  expect(w.files.get(`${DIR}/sessions/reviewer-1/prompt.md`)).toContain('write your report')
  expect(w.files.get(`${DIR}/sessions/reviewer-1/prompt.md`)).not.toContain('typed into the terminal means start again')
  // Past the breaker's short-run window, then the report.
  await w.clock.advance(40_000)
  await report(w, 'reviewer-1', 'PR #7 awaits /flow approve.')
  expect(w.runs.some(a => a[0] === 'tmux' && a[1] === 'kill-session' && a.includes('flow-reviewer-1'))).toBe(true)
  expect(stored(w, 'sessions')['reviewer-1']).toBeUndefined()
  // #7 is still pending (nobody took it), so the ended run is replaced.
  expect(newSessions(w)).toEqual(['flow-reviewer-1', 'flow-reviewer-2'])
})

test('reviewer in a terminal, auto: a report keeps the terminal and a gone terminal counts in the breaker', { options: TMUX }, async ($, on) => {
  const w = world(on)
  await start($)
  await handover($, 7)
  await w.clock.advance(40_000)
  await report(w, 'reviewer-1', 'Held: PR #7 awaits approval.')
  expect(w.runs.some(a => a[0] === 'tmux' && a[1] === 'kill-session')).toBe(false)
  expect(stored(w, 'sessions')['reviewer-1']).toMatchObject({ status: 'reported' })
  expect(newSessions(w)).toEqual(['flow-reviewer-1'])
  expect(typed(w)).toEqual([])
  // The terminal goes away: the breaker closes the run and the queue starts reviewer-2 for the pending PR.
  w.state.alive = false
  await w.clock.advance(35_000)
  await w.clock.settle()
  expect(newSessions(w)).toEqual(['flow-reviewer-1', 'flow-reviewer-2'])
  expect(stored(w, 'reviewer-breaker').run).toMatchObject({ name: 'reviewer-2' })
})

test('mode tmux with tmux missing: the manager is refused, not started as an agent', { options: TMUX }, async ($, on) => {
  const w = world(on)
  w.state.tmuxDown = true
  await start($)
  const r = await spawnManager($, 'csv-mgr')
  expect(r).toContain('mode tmux, but tmux is not installed')
  expect(w.spawns).toEqual([])
  expect(newSessions(w)).toEqual([])
})

test('mode orca with Orca down: the manager is refused and tmux is not tried', { options: { mode: 'orca' } }, async ($, on) => {
  const w = world(on)
  await start($)
  const r = await spawnManager($, 'csv-mgr')
  expect(r).toContain('mode orca, but Orca is not reachable')
  expect(w.spawns).toEqual([])
  expect(newSessions(w)).toEqual([])
})

test('mode tmux with tmux missing: no agent reviewer takes over; the reason is toasted and the next trigger retries', { options: TMUX }, async ($, on) => {
  const w = world(on)
  w.state.tmuxDown = true
  await start($)
  expect(await handover($, 7)).not.toContain('Started reviewer reviewer-1')
  expect(w.spawns).toEqual([])
  expect(w.toasts.some(t => t.includes('could not start the reviewer') && t.includes('tmux is not installed'))).toBe(true)
  w.state.tmuxDown = false
  await handover($, 8)
  expect(newSessions(w).length).toBe(1)
})

test('mode agent (the default): the reviewer is an agent and no session is started', async ($, on) => {
  const w = world(on)
  await start($)
  expect(await handover($, 7)).toContain('Started reviewer reviewer-1')
  expect(w.spawns.map(s => s.name)).toEqual(['reviewer-1'])
  expect(newSessions(w)).toEqual([])
})

test('a PR sent back and handed over again, or approved after being held, is typed into the live reviewer again', { options: TMUX }, async ($, on) => {
  const w = world(on)
  await start($)
  await handover($, 7)
  const rv = (input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__flow__reviewer', agentId: 'session:reviewer-1', ...input } as never).then(r => String(r.result))
  await rv({ action: 'take', pr: 7 })
  await rv({ action: 'back', pr: 7, reason: 'head moved' })
  await w.clock.advance(1000)
  expect(await handover($, 7)).toContain('picks it up')
  expect(typed(w)).toEqual(['new handover: #7'])
  // A PR handed over for approval is not typed; the approval is.
  await $.tool.call({ tool: 'mcp__flow__handover', pr: 9, mode: 'confirm', agentId: 'm1' } as never)
  expect(typed(w)).toEqual(['new handover: #7'])
  await $.command.run({ command: 'flow', args: 'approve 9' } as never)
  await w.clock.settle()
  expect(typed(w)).toEqual(['new handover: #7', 'new handover: #9'])
})

test('a manager whose terminal already runs is answered as started, not spawned as an agent', { options: TMUX }, async ($, on) => {
  const w = world(on)
  await start($)
  await spawnManager($, 'csv-mgr')
  const again = await spawnManager($, 'csv-mgr')
  expect(again).toContain('already runs in tmux')
  expect(w.spawns).toEqual([])
  expect(newSessions(w)).toEqual(['flow-csv-mgr'])
})

const reports = (got: string[]) => got.filter(t => t.startsWith('Report from reviewer'))
async function goneAfter(w: W) {
  await w.clock.advance(40_000)
  w.state.alive = false
  await w.clock.advance(35_000)
  await w.clock.settle()
  await w.clock.advance(5000)
  await w.clock.settle()
}

test('a reviewer terminal that goes away after batch work relays a summary to main, and the work record is cleared', { options: { reviewer_harness: 'claude', ...TMUX } }, async ($, on) => {
  const w = world(on)
  const got = w.prompts
  await start($)
  await handover($, 7)
  await $.tool.call({ tool: 'mcp__flow__reviewer', agentId: 'session:reviewer-1', action: 'take', pr: 7 } as never)
  await goneAfter(w)
  const sent = reports(got)
  expect(sent).toHaveLength(1)
  expect(sent[0]).toContain('Report from reviewer reviewer-1:\nThe reviewer terminal ended without a final report.')
  expect(sent[0]).toContain('main checkout not updated')
  // The work record went with the report: a later reviewer end with no new work relays nothing more.
  await goneAfter(w)
  expect(reports(got)).toHaveLength(1)
})

test('a reviewer terminal that goes away with no batch work sends main no report', { options: { reviewer_harness: 'claude', ...TMUX } }, async ($, on) => {
  const w = world(on)
  const got = w.prompts
  await start($)
  await handover($, 7)
  await goneAfter(w)
  expect(newSessions(w)).toEqual(['flow-reviewer-1', 'flow-reviewer-2'])
  expect(reports(got)).toEqual([])
})
