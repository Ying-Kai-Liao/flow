import type { AgentInfo } from 'claude-code'
import { expect, mock } from 'claude-code/testing'
import { test } from './support'
import type { TestBody } from 'claude-code/testing'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const DIR = '/r/.git/flow'
const RELAY = `${DIR}/sessions/m1/relay`
const ok = (stdout = '', exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

const SESSION = {
  name: 'm1', harness: 'claude', host: 'tmux' as const, handle: 'flow-m1', worktree: '/r', branch: 'main', promptFile: `${DIR}/sessions/m1/prompt.md`,
  reportFile: `${DIR}/sessions/m1/report.md`, start: 'claude {prompt}', owner: 'main', ownerName: 'main', status: 'running' as const, startedAt: 1,
}
const MANAGER = { ...SESSION, role: 'manager' as const, relayDir: RELAY }
const REVIEWER = { ...SESSION, name: 'rv', handle: 'flow-rv', role: 'reviewer' as const, relayDir: `${DIR}/sessions/rv/relay`, promptFile: `${DIR}/sessions/rv/prompt.md` }

// An in-memory repo at /r: files, every process run, a clock, and the mv/rm the relay uses.
function world(on: On, env: Record<string, string> = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, env)
  const files = new Map<string, string>()
  const runs: string[][] = []
  const registered: string[] = []
  const submitted: string[] = []
  const agents: AgentInfo[] = []
  // What the fake "main" answers a waiting client with; set by the test.
  const wait: { answer: (call: Record<string, unknown>) => unknown } = { answer: () => ({ result: 'pong' }) }
  on('session.start', () => ({ cwd: '/r' }))
  on('command.register', (_, e) => { registered.push(`command:${(e as unknown as { name: string }).name}`); return { value: undefined } as never })
  on('tool.register', (_, e) => { registered.push(`tool:${(e as unknown as { name: string }).name}`); return { value: undefined } as never })
  on('agent.register', (_, e) => ({ value: { agent: (e as unknown as { name: string }).name } }))
  on('agent.list', () => ({ value: agents }))
  on('prompt.submit', (_, e) => { submitted.push(e.text); return { text: e.text } })
  on('fs.exists', (_, e) => ({ value: files.has((e as unknown as { path: string }).path) }))
  on('fs.stat', (_, e) => {
    const path = (e as unknown as { path: string }).path
    if (!files.has(path)) throw new Error('ENOENT')
    return { value: { kind: 'file' as const, size: 1, mtimeMs: 1_000_000, isLink: false } }
  })
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('fs.read', (_, e) => {
    const t = files.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('fs.list', (_, e) => {
    const dir = (e as unknown as { path: string }).path
    return { value: [...files.keys()].filter(k => k.startsWith(`${dir}/`) && !k.slice(dir.length + 1).includes('/')).map(k => ({ name: k.slice(dir.length + 1), kind: 'file' as const, size: 1, mtimeMs: 1_000_000, isLink: false })) }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.send', () => ({ isDelivered: true as const }))
  on('process.run', (_, e) => {
    const a = [...e.argv]
    runs.push(a)
    if (a[0] === 'git' && a[1] === 'rev-parse') return ok(a.includes('--git-common-dir') ? '/r/.git\n' : '/r\n')
    if (a[0] === 'mv') {
      const t = files.get(a[1] ?? '')
      if (t === undefined) return ok('', 1)
      files.set(a[2] ?? '', t)
      files.delete(a[1] ?? '')
      return ok()
    }
    if (a[0] === 'rm' && a[1] === '-f') { files.delete(a[2] ?? ''); return ok() }
    // The client's wait loop: main answers it from `wait.answer`, as the pump would.
    if (a[0] === 'sh' && a[1] === '-c' && a[3] === 'sh') {
      const dir = a[4] ?? ''
      const id = a[5] ?? ''
      const call = JSON.parse(files.get(`${dir}/call-${id}.json`) ?? '{}') as Record<string, unknown>
      return ok(JSON.stringify(wait.answer(call)))
    }
    if (a[0] === 'git' && a[1] === 'symbolic-ref') return ok('origin/main\n')
    return ok()
  })
  return { clock, files, runs, registered, submitted, agents, wait }
}

const start = ($: Dollar) => $.session.start({ cwd: '/r' } as never)
const calls = (w: { files: Map<string, string> }, dir = RELAY) =>
  [...w.files.entries()].filter(([k]) => k.startsWith(`${dir}/call-`)).map(([, v]) => JSON.parse(v) as Record<string, unknown>)

test('a worker session\'s copy is passive: no tools, no slot wipe, calls pass straight through', async ($, on) => {
  const w = world(on, { FLOW_ROLE: 'worker', FLOW_NAME: 'w1' })
  on('tool.call', () => ({ result: 'ran' }))
  await start($)
  expect(w.runs.some(a => a.join(' ').includes('rm -rf'))).toBe(false)
  expect(w.runs.some(a => a[0] === 'git')).toBe(false)
  expect(w.registered).toEqual([])
  // Not even the kill refusal: a passive copy leaves every tool to the session's own rules.
  const r = await $.tool.call({ tool: 'Bash', command: 'pkill -f node' } as never)
  expect(r.result).toBe('ran')
  await w.clock.advance(5000)
  expect(w.runs.some(a => a[0] === 'gh')).toBe(false)
})

test('a manager session\'s copy shows the tools and /flow stub, relays flow tools to main and refuses code edits', async ($, on) => {
  const w = world(on, { FLOW_ROLE: 'manager', FLOW_NAME: 'm1', FLOW_RELAY: RELAY })
  on('tool.call', () => ({ result: 'ran' }))
  await start($)
  expect(w.registered).toContain('command:flow')
  expect(w.registered).toContain('tool:note')
  expect(w.registered).toContain('tool:handover')
  expect(w.runs.some(a => a.join(' ').includes('rm -rf'))).toBe(false)

  w.wait.answer = () => ({ result: 'Noted in /r/notes.md.' })
  const r = await $.tool.call({ tool: 'mcp__flow__note', manager: 'm1', text: 'hello' } as never)
  expect(r.result).toBe('Noted in /r/notes.md.')
  // The call carries the tool's own input only, and who it is from.
  const [sent] = calls(w)
  expect(sent).toMatchObject({ tool: 'mcp__flow__note', input: { manager: 'm1', text: 'hello' }, from: 'session:m1', role: 'manager', by: 'm1' })
  expect(Object.keys(sent!.input as object)).toEqual(['manager', 'text'])

  // A subagent of the manager may read but not write; nothing is left for main.
  const before = calls(w).length
  expect(JSON.stringify(await $.tool.call({ tool: 'mcp__flow__handover', pr: 1, agentId: 'sub1' } as never))).toContain('subagent of terminal manager m1')
  expect(calls(w).length).toBe(before)
  w.wait.answer = () => ({ result: 'status' })
  expect((await $.tool.call({ tool: 'mcp__flow__status', agentId: 'sub1' } as never)).result).toBe('status')

  // Main's refusal reaches the model as a refusal.
  w.wait.answer = () => ({ deny: 'Refused: nope' })
  expect(JSON.stringify(await $.tool.call({ tool: 'mcp__flow__ask', questions: [], agentId: undefined } as never))).toContain('Refused: nope')

  expect(JSON.stringify(await $.tool.call({ tool: 'Edit', file_path: 'a.ts', old_string: 'a', new_string: 'b' } as never))).toContain("managers don't edit code")
  expect(JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'pkill -f node' } as never))).toContain('flow')
  expect((await $.tool.call({ tool: 'Read', file_path: '/r/a.ts' } as never)).result).toBe('ran')
  expect((await $.command.run({ command: 'flow', args: '' } as never)).text).toContain('main')
})

test('in a relay copy a flow:* subagent is refused and a plain one passes; SendMessage to a stranger is relayed', async ($, on) => {
  const w = world(on, { FLOW_ROLE: 'reviewer', FLOW_NAME: 'rv', FLOW_RELAY: `${DIR}/sessions/rv/relay` })
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'x1' }))
  on('tool.call', () => ({ result: 'ran' }))
  await start($)
  const denied = await $.agent.spawn({ prompt: 'p', description: 'w', subagentType: 'flow:worker' } as never).then(r => JSON.stringify(r), e => String(e))
  expect(denied).toContain('mcp__flow__session')
  const plain = await $.agent.spawn({ prompt: 'p', description: 'e', subagentType: 'Explore' } as never)
  expect(plain.agentId).toBe('x1')

  w.wait.answer = () => ({ result: 'Sent to csv by flow.' })
  const r = JSON.stringify(await $.tool.call({ tool: 'SendMessage', to: 'csv', message: 'hi' } as never))
  expect(r).toContain('Sent to csv by flow.')
  expect(calls(w, `${DIR}/sessions/rv/relay`)[0]).toMatchObject({ tool: 'send', input: { to: 'csv', text: 'hi' }, role: 'reviewer' })
})

test('a suite run in a relay copy asks main for the slot check', async ($, on) => {
  const w = world(on, { FLOW_ROLE: 'reviewer', FLOW_NAME: 'rv', FLOW_RELAY: `${DIR}/sessions/rv/relay` })
  on('tool.call', () => ({ result: 'ran' }))
  await start($)
  w.wait.answer = () => ({ deny: 'flow: `npm test` runs a whole suite. Call acquire first.' })
  expect(JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'claude plugin test .' } as never))).toContain('runs a whole suite')
  w.wait.answer = () => ({ result: 'ok' })
  expect((await $.tool.call({ tool: 'Bash', command: 'claude plugin test .' } as never)).result).toBe('ran')
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' } as never)).result).toBe('ran')
  expect(calls(w, `${DIR}/sessions/rv/relay`).every(c => c.tool === 'slot-check')).toBe(true)
})

// A pending call as a terminal's copy leaves it.
const leave = (w: { files: Map<string, string> }, id: string, tool: string, input: Record<string, unknown>, name = 'm1') =>
  w.files.set(`${DIR}/sessions/${name}/relay/call-${id}.json`, JSON.stringify({ id, tool, input, from: `session:${name}`, role: 'manager', by: name, at: 1 }))
const answerOf = (w: { files: Map<string, string> }, id: string, name = 'm1') =>
  JSON.parse(w.files.get(`${DIR}/sessions/${name}/relay/answer-${id}.json`) ?? 'null') as { result?: string; deny?: string } | null

test('main pumps a role session\'s calls and runs them as that session: a note, an ask, an unknown tool, an ended session', async ($, on) => {
  const w = world(on)
  w.files.set(`${DIR}/sessions.json`, JSON.stringify({ m1: MANAGER, gone: { ...MANAGER, name: 'gone', relayDir: `${DIR}/sessions/gone/relay` } }))
  await start($)
  // A session that ends while its call is pending: the call is refused, not run.
  await $.tool.call({ tool: 'mcp__flow__session', action: 'stop', name: 'gone' } as never)

  leave(w, 'a1', 'mcp__flow__note', { manager: 'm1', text: 'pump works', kind: 'progress' })
  leave(w, 'a2', 'mcp__flow__ask', { from: 'x', questions: [{ question: 'Which format?', options: ['csv', 'tsv'], default: 'csv', blocking: false }] })
  leave(w, 'a3', 'mcp__flow__nothing', {})
  leave(w, 'a4', 'mcp__flow__note', { manager: 'gone', text: 'late' }, 'gone')
  await w.clock.advance(1200)

  expect(answerOf(w, 'a1')?.result).toContain('Noted in')
  expect(w.files.get(`${DIR}/managers/m1/notes.md`)).toContain('progress: pump works')
  // The ask is recorded under the session's own name, as if a manager had asked.
  expect(answerOf(w, 'a2')?.result).toContain('proceed on the default')
  const items = (JSON.parse(w.files.get(`${DIR}/inbox.json`) ?? '{"items":[]}') as { items: { owner: string; question: string }[] }).items
  expect(items[0]).toMatchObject({ owner: 'm1', question: 'Which format?' })
  expect(answerOf(w, 'a3')?.deny).toContain('not a flow tool')
  expect(answerOf(w, 'a4', 'gone')?.deny).toContain('not running')
  // Claimed files are gone.
  expect([...w.files.keys()].some(k => k.includes('/taken-'))).toBe(false)
})

test('a relayed session start by a manager that has not filed its pre-flight is refused before anything starts', async ($, on) => {
  const w = world(on)
  w.files.set(`${DIR}/sessions.json`, JSON.stringify({ m1: MANAGER }))
  w.files.set(`${DIR}/preflight.json`, JSON.stringify({
    next: 2,
    entries: { m1: { name: 'm1', phase: 'recon', round: 1, spawnedAt: 0, blocking: [], asked: [] } },
    rounds: [{ id: 1, openedAt: 0, members: ['m1'], delivered: false, reported: [] }],
  }))
  await start($)
  leave(w, 'g1', 'mcp__flow__session', { action: 'start', name: 'csv-w', brief: 'Your name: csv-w\n\nbrief' })
  await w.clock.advance(1200)
  const a = answerOf(w, 'g1')
  expect(a?.result).toContain('Refused')
  expect(a?.result).toContain('mcp__flow__preflight')
  expect(w.runs.some(r => r[0] === 'tmux' && r[1] === 'new-session')).toBe(false)
})

test('slot-check and send run in main for the session; the reviewer\'s guard sees its session id', async ($, on) => {
  const w = world(on)
  w.files.set(`${DIR}/sessions.json`, JSON.stringify({ m1: MANAGER, rv: REVIEWER }))
  w.agents.push({ id: 'a1', name: 'csv', description: 'csv', type: 'flow:manager', status: 'running' })
  await start($)

  leave(w, 's1', 'slot-check', { suite: 'claude plugin test .' })
  leave(w, 's2', 'send', { to: 'm1', text: 'Review of #3 is done.' }, 'rv')
  leave(w, 's3', 'send', { to: 'nobody', text: 'x' })
  await w.clock.advance(1200)
  expect(answerOf(w, 's1')?.deny).toContain('runs a whole suite')
  expect(answerOf(w, 's2', 'rv')?.result).toBe('Sent to m1 by flow.')
  // Typed into the manager's terminal, from the reviewer.
  expect(w.runs.some(r => r[0] === 'tmux' && r[1] === 'set-buffer' && r.at(-1) === 'Message from rv: Review of #3 is done.')).toBe(true)
  expect(answerOf(w, 's3')?.deny).toContain('no agent or session named "nobody"')
})

test('a SendMessage in main to a worker session or a role session is delivered by typing, and answered as a refusal', async ($, on) => {
  const w = world(on)
  const worker = { ...SESSION, name: 'w1', handle: 'flow-w1', owner: 'session:m1', ownerName: 'm1' }
  w.files.set(`${DIR}/sessions.json`, JSON.stringify({ m1: MANAGER, w1: worker }))
  await start($)
  const typed = () => w.runs.filter(r => r[0] === 'tmux' && r[1] === 'set-buffer').map(r => r.at(-1))

  const r1 = JSON.stringify(await $.tool.call({ tool: 'SendMessage', to: 'w1', message: 'rebase please' } as never))
  expect(r1).toContain('Delivered to w1 by flow (terminal session).')
  const r2 = JSON.stringify(await $.tool.call({ tool: 'SendMessage', to: 'session:m1', message: 'status?' } as never))
  expect(r2).toContain('Delivered to m1 by flow (terminal session).')
  expect(typed()).toEqual(['Message from main: rebase please', 'Message from main: status?'])
})

test('a restart drops ended sessions and old reported workers, so their names are free', async ($, on) => {
  const w = world(on)
  const day = 24 * 60 * 60_000
  w.files.set(`${DIR}/sessions.json`, JSON.stringify({
    m1: MANAGER,
    dead: { ...SESSION, name: 'dead', status: 'exited' },
    stale: { ...SESSION, name: 'stale', status: 'reported', startedAt: 1, reportAt: 1_000_000 - day - 1 },
    fresh: { ...SESSION, name: 'fresh', status: 'reported', startedAt: 1, reportAt: 1_000_000 - 1000 },
  }))
  await start($)
  const list = String((await $.tool.call({ tool: 'mcp__flow__session', action: 'list' } as never)).result)
  expect(list).toContain('m1:')
  expect(list).toContain('fresh:')
  expect(list).not.toContain('dead:')
  expect(list).not.toContain('stale:')
})

test('sessions persist to sessions.json and come back after a restart', async ($, on) => {
  const w = world(on)
  w.files.set(`${DIR}/sessions.json`, JSON.stringify({ m1: { ...MANAGER, status: 'idle' }, junk: 3, other: { name: 'mismatch', status: 'running' } }))
  await start($)
  // A session the first read brought back is known to the tools; junk is dropped.
  const list = String((await $.tool.call({ tool: 'mcp__flow__session', action: 'list' } as never)).result)
  expect(list).toContain('m1: claude in tmux')
  expect(list).not.toContain('mismatch')
  // A change writes the file.
  await $.tool.call({ tool: 'mcp__flow__session', action: 'send', name: 'm1', text: 'hello' } as never)
  const saved = JSON.parse(w.files.get(`${DIR}/sessions.json`) ?? '{}') as Record<string, { status: string }>
  expect(Object.keys(saved)).toEqual(['m1'])
  expect(saved.m1?.status).toBe('running')
  // Volatile fields stay off the disk, and writes happen only on a real change.
  await $.tool.call({ tool: 'mcp__flow__session', action: 'send', name: 'm1', text: 'again' } as never)
  expect(JSON.parse(w.files.get(`${DIR}/sessions.json`) ?? '{}').m1.screenText).toBeUndefined()
})

test('a terminal manager may write its own report file and nothing else', async ($, on) => {
  world(on, { FLOW_ROLE: 'manager', FLOW_NAME: 'm1', FLOW_RELAY: RELAY })
  on('tool.call', () => ({ result: 'ran' }))
  await start($)
  const report = `${DIR}/sessions/m1/report.md`
  expect((await $.tool.call({ tool: 'Write', file_path: report, content: 'done' } as never)).result).toBe('ran')
  expect((await $.tool.call({ tool: 'Edit', file_path: report, old_string: 'a', new_string: 'b' } as never)).result).toBe('ran')
  // Another session's report, a sibling file and a subagent's write stay refused.
  for (const e of [
    { tool: 'Write', file_path: `${DIR}/sessions/m2/report.md`, content: 'x' },
    { tool: 'Write', file_path: `${DIR}/sessions/m1/prompt.md`, content: 'x' },
    { tool: 'Write', file_path: `${report}/../prompt.md`, content: 'x' },
    { tool: 'Write', file_path: '/r/a.ts', content: 'x' },
    { tool: 'Write', file_path: report, content: 'x', agentId: 'sub1' },
  ]) expect(JSON.stringify(await $.tool.call(e as never))).toContain("managers don't edit code")
})

test('a blocking ask from a terminal manager waits open in main\'s inbox, whoever calls answer for it', async ($, on) => {
  const w = world(on)
  w.files.set(`${DIR}/sessions.json`, JSON.stringify({ m1: MANAGER }))
  await start($)
  const ask = { from: 'm1', questions: [{ question: 'Which way?', options: ['a', 'b'], default: 'b', blocking: true, topic: 'which-way' }] }
  leave(w, 'k1', 'mcp__flow__ask', ask)
  await w.clock.advance(1200)
  expect(answerOf(w, 'k1')?.result).toContain('end your turn')
  const items = () => (JSON.parse(w.files.get(`${DIR}/inbox.json`) ?? '{"items":[]}') as { items: { id: string; state: string; addressee: string; answeredBy?: string }[] }).items
  expect(items()[0]).toMatchObject({ state: 'open', addressee: 'main' })
  // The relay retrying the same call after a timeout does not make a second question.
  leave(w, 'k2', 'mcp__flow__ask', ask)
  // The manager answering for main (its own question, or all of main's with defaults) is refused: only main answers.
  leave(w, 'k3', 'mcp__flow__answer', { answers: [{ id: items()[0]!.id, choice: 'b' }] })
  leave(w, 'k4', 'mcp__flow__answer', { defaults: true })
  await w.clock.advance(1200)
  expect(items().length).toBe(1)
  expect(items()[0]).toMatchObject({ state: 'open' })
  expect(answerOf(w, 'k3')?.result).toContain('refused')
})
