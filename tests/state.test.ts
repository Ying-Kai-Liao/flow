import type { AgentInfo } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const PR = { state: 'OPEN', isDraft: false, headRefOid: 'abc1234def5678', headRefName: 'flow/csv', title: 'Export orders as CSV' }
const DIR = '/r/.git/flow'

// A repo whose state dir lives in an in-memory file map; `abs` false makes git print a relative path.
function disk(on: On, files: Map<string, string>, o: { abs?: boolean; agents?: AgentInfo[] } = {}) {
  const spawned: string[] = []
  on('agent.list', () => ({ value: o.agents ?? [] }))
  on('agent.spawn', (_, e) => { spawned.push(e.subagentType); return { model: 'sonnet', agentId: 'q1' } })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('turn.complete', (_, e) => ({ text: e.answer }) as never)
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('fs.read', (_, e) => {
    const t = files.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('fs.list', (_, e) => {
    const names = [...files.keys()].filter(k => k.startsWith(`${e.path}/`)).map(k => k.slice(e.path.length + 1))
    if (names.length === 0) throw new Error('ENOENT')
    return { value: names.map(name => ({ name, kind: 'file' })) as never }
  })
  on('process.run', (_, e) => {
    const a = e.argv
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (a[0] === 'git' && a[1] === 'rev-parse') return out(o.abs === false ? '.git\n' : '/r/.git\n')
    if (a[0] === 'gh') return out(JSON.stringify(PR))
    if (a[0] === 'mv') {
      const t = files.get(a[1] ?? '')
      if (t !== undefined) { files.set(a[2] ?? '', t); files.delete(a[1] ?? '') }
      return out('')
    }
    if (a[0] === 'sh') { // printf "%s\n" "$1" >> "$2"
      const p = a[5] ?? ''
      files.set(p, `${files.get(p) ?? ''}${a[4]}\n`)
      return out('')
    }
    return out('')
  })
}

const logOf = (files: Map<string, string>) =>
  (files.get(`${DIR}/log.jsonl`) ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>)

const call = ($: Dollar, input: Record<string, unknown>) => $.tool.call(input as never)

test('a handover is saved as a versioned file and logged; queue take, done and back follow', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const files = new Map<string, string>()
  disk(on, files)

  await call($, { tool: 'mcp__flow__handover', pr: 7, verified: 'npm test', report_to: 'csv-export' })
  const saved = JSON.parse(files.get(`${DIR}/handovers/7.json`) ?? '{}') as Record<string, unknown>
  expect(saved.version).toBe(1)
  expect(saved.status).toBe('pending')
  expect(saved.branch).toBe('flow/csv')
  expect([...files.keys()].some(k => k.endsWith('.tmp'))).toBe(false)

  await call($, { tool: 'mcp__flow__queue', action: 'take', pr: 7 })
  await call($, { tool: 'mcp__flow__queue', action: 'done', pr: 7, sha: 'abc', report: 'merged ok' })
  expect(JSON.parse(files.get(`${DIR}/handovers/7.json`) ?? '{}').status).toBe('done')
  await call($, { tool: 'mcp__flow__handover', pr: 8, verified: 'x', report_to: 'csv-export' })
  await call($, { tool: 'mcp__flow__queue', action: 'back', pr: 8, reason: 'head moved' })

  const log = logOf(files)
  expect(log.map(l => l.event)).toEqual(['handover', 'take', 'done', 'handover', 'back'])
  expect(log[0]).toMatchObject({ owner: 'csv-export', pr: 7, branch: 'flow/csv' })
  expect(log[2]).toMatchObject({ pr: 7, text: 'merged ok' })
  expect(log[4]).toMatchObject({ pr: 8, text: 'head moved' })
  // The settings package owns config.json: flow never writes it.
  expect(files.has(`${DIR}/config.json`)).toBe(false)
})

test('a spawn and a report of flow agents are logged with their owner', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const files = new Map<string, string>()
  const agents: AgentInfo[] = [
    { id: 'm1', name: 'csv-export', description: 'csv', type: 'flow:manager', status: 'running' },
    { id: 'w1', name: 'csv-worker', description: 'w', type: 'flow:worker', status: 'running', parentId: 'm1' },
  ]
  disk(on, files, { agents })

  await $.agent.spawn({ prompt: 'b', description: 'w', subagentType: 'flow:worker', name: 'csv-worker', parentAgentId: 'm1' } as never)
  await $.agent.spawn({ prompt: 'b', description: 'm', subagentType: 'flow:manager', name: 'csv-export' } as never)
  await $.agent.spawn({ prompt: 'b', description: 'x', subagentType: 'general-purpose' } as never)
  await $.turn.complete({ turnId: 't', agentId: 'w1', answer: 'did it\nPR: https://x/pull/7' } as never)

  const log = logOf(files)
  expect(log[0]).toMatchObject({ event: 'spawn', agent: 'csv-worker', owner: 'csv-export' })
  expect(log[1]).toMatchObject({ event: 'spawn', agent: 'csv-export', owner: 'main' })
  expect(log[2]).toMatchObject({ event: 'report', agent: 'csv-worker', owner: 'csv-export', text: 'PR: https://x/pull/7' })
  expect(log.length).toBe(3)
})

test('notes append dated lines under one manager key and read back; -N is stripped', async ($, on) => {
  mock.clock(on, { now: Date.UTC(2026, 9, 9) })
  const files = new Map<string, string>()
  disk(on, files)

  const none = await call($, { tool: 'mcp__flow__note', manager: 'csv-export' })
  expect(String(none.result)).toBe('No notes yet.')
  const first = await call($, { tool: 'mcp__flow__note', manager: 'csv-export', text: 'use utf-8', kind: 'decision' })
  expect(String(first.result)).toContain(`${DIR}/managers/csv-export/notes.md`)
  await call($, { tool: 'mcp__flow__note', manager: 'csv-export-2', text: 'worker started' })

  const notes = String((await call($, { tool: 'mcp__flow__note', manager: 'csv-export' })).result)
  expect(notes).toContain('- 2026-10-09 decision: "use utf-8"')
  expect(notes).toContain('- 2026-10-09 progress: worker started')
  expect([...files.keys()].filter(k => k.includes('/managers/')).length).toBe(1)
  expect(logOf(files).map(l => l.owner)).toEqual(['csv-export', 'csv-export'])
})

test('status with pr names the owner from the log, else who the handover reports to', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const files = new Map<string, string>()
  disk(on, files)

  await call($, { tool: 'mcp__flow__handover', pr: 7, verified: 'x', report_to: 'csv-export' })
  const r = String((await call($, { tool: 'mcp__flow__status', pr: 7 })).result)
  expect(r).toContain('Owner of PR #7: csv-export')
  expect(r).toContain('handover')
  expect(String((await call($, { tool: 'mcp__flow__status', pr: 99 })).result)).toContain('Owner of PR #99: unknown')

  const plain = String((await call($, { tool: 'mcp__flow__status' })).result)
  expect(plain).toContain('Handed-over PRs:')
  expect(plain.split('\n').pop()).toBe(`State: ${DIR}`)
})

test('outside a git repo state is a no-op and tools still work', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const files = new Map<string, string>()
  disk(on, files, { abs: false })

  const h = await call($, { tool: 'mcp__flow__handover', pr: 7, verified: 'x', report_to: 'm' })
  expect(String(h.result)).toContain('Handed over PR #7')
  const n = await call($, { tool: 'mcp__flow__note', manager: 'm', text: 'x' })
  expect(String(n.result)).toContain('Not saved')
  expect(files.size).toBe(0)
  const plain = String((await call($, { tool: 'mcp__flow__status' })).result)
  expect(plain.split('\n').pop()).toBe('State: none (not a git repo)')
})
