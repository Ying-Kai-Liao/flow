import type { AgentInfo } from 'claude-code'
import { expect, mock } from 'claude-code/testing'
import { test } from './support'
import type { TestBody } from 'claude-code/testing'
import { failReason, flowCatch, toolCatch, toolFailText } from '../hooks/toolguard'

type On = Parameters<TestBody>[1]

const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const AGENTS: AgentInfo[] = [{ id: 'm1', name: 'csv-export', description: 'm', type: 'flow:manager', status: 'running' }]

const throws = { kind: 'throw', message: 'EIO: disk\nfull' } as const

test('the retry text names the tool, the reason and whether a repeat could double an effect', () => {
  expect(failReason(throws)).toBe('the hook failed: EIO: disk full')
  expect(failReason({ kind: 'timeout' })).toContain('longer than the host allows')
  const write = toolFailText('mcp__flow__handover', { error: throws, called: false })
  expect(write).toContain('flow: handover did not finish')
  expect(write).toContain('may have been recorded in part')
  expect(write).toContain('call it again')
  const read = toolFailText('mcp__flow__status', { error: throws, called: false })
  expect(read).toContain('nothing changed')
  const again = toolFailText('mcp__flow__note', { error: { kind: 're-entry', cause: 'lent' }, called: false })
  expect(again).toContain('did not run')
  expect(again).toContain('Nothing was recorded')
  expect(toolCatch(undefined, { tool: 'mcp__flow__note' }, { error: throws, called: false }).result).toContain('flow: note did not finish')
})

// A subagent's flow tool call whose handler fails (here the roster read rejects). Before the catch
// handler the host failed the call with "no tool.call hook answered this call".
function world(on: On, broken: boolean) {
  mock.clock(on, { now: 1_000_000 })
  on('agent.list', () => { if (broken) throw new Error('roster unavailable'); return { value: AGENTS } })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.read', () => { throw new Error('ENOENT') })
  on('process.run', () => ok('/r/.git\n'))
}

test('a flow tool hook that fails for a subagent answers with a retry message', async ($, on) => {
  world(on, true)
  const r = await $.tool.call({ tool: 'mcp__flow__status', agentId: 'm1' } as never)
  expect(String(r.result)).toContain('flow: status did not finish')
  expect(String(r.result)).toContain('agent.list')
  expect(String(r.result)).toContain('Call it again')
})

const nextOf = (called: boolean, run: () => unknown) =>
  Object.assign((_: unknown) => run(), { error: throws, called }) as never

test('flowCatch: a flow tool that did not run is answered; a replay that rejects again is too; other tools pass on', async () => {
  const notRun = await flowCatch({ tool: 'mcp__flow__handover' }, nextOf(false, () => { throw new Error('must not run') }))
  expect((notRun as { result: string }).result).toContain('flow: handover did not finish')
  const replayFails = await flowCatch({ tool: 'mcp__flow__handover' }, nextOf(true, () => Promise.reject(new Error('again'))))
  expect((replayFails as { result: string }).result).toContain('flow: handover did not finish')
  const replayOk = await flowCatch({ tool: 'mcp__flow__handover' }, nextOf(true, () => ({ result: 'recorded' })))
  expect(replayOk).toEqual({ result: 'recorded' })
  const other = await flowCatch({ tool: 'Bash' }, nextOf(false, () => ({ result: 'ran' })))
  expect(other).toEqual({ result: 'ran' })
  await expect(flowCatch({ tool: 'Bash' }, nextOf(true, () => Promise.reject(new Error('x'))))).rejects.toThrow('x')
})

test('the same call works when nothing fails', async ($, on) => {
  world(on, false)
  const r = await $.tool.call({ tool: 'mcp__flow__status', agentId: 'm1' } as never)
  expect(String(r.result)).not.toContain('did not finish')
})
