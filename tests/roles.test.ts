import { expect } from 'claude-code/testing'
import { test } from './support'

import { harnessesOf, parseClaudeTranscript, relayEnv, roleAgents, roleHarnessOf, sessionLive, sessionRow } from '../hooks/sessions'
import { settingsOf } from '../hooks/settings'
import { MANAGER_SESSION_RULES, REVIEWER_SESSION_RULES_AUTO, REVIEWER_SESSION_RULES_CONFIRM } from '../hooks/prompts'

const SESSION_BASE = {
  name: 'm1', harness: 'claude', host: 'tmux' as const, handle: 'flow-m1', worktree: '/r', branch: 'main', promptFile: '/p', reportFile: '/r.md',
  start: 'claude {prompt}', owner: 'main', ownerName: 'main', status: 'running' as const, startedAt: 1,
}

test('a role session stands in the roster as the manager or the reviewer; a worker session as before', () => {
  expect(sessionRow(SESSION_BASE)).toMatchObject({ id: 'session:m1', type: 'flow:session', status: 'running' })
  expect(sessionRow({ ...SESSION_BASE, role: 'manager' })).toMatchObject({ type: 'flow:manager' })
  expect(sessionRow({ ...SESSION_BASE, role: 'reviewer', status: 'reported' })).toMatchObject({ type: 'flow:reviewer', status: 'idle' })
  // The workers of a role session nest under it.
  expect(sessionRow({ ...SESSION_BASE, name: 'w1', owner: 'session:m1', ownerName: 'm1' }).parentId).toBe('session:m1')
})

test('roleAgents lists the live role sessions as agent rows', () => {
  const rows = roleAgents({
    m1: { ...SESSION_BASE, role: 'manager' },
    rev: { ...SESSION_BASE, name: 'rev', role: 'reviewer', status: 'idle' },
    old: { ...SESSION_BASE, name: 'old', role: 'manager', status: 'exited' },
    w1: { ...SESSION_BASE, name: 'w1' },
  })
  expect(rows.map(r => `${r.id} ${r.type} ${r.status}`)).toEqual(['session:m1 flow:manager running', 'session:rev flow:reviewer waiting'])
  expect(rows[0]).toMatchObject({ name: 'm1' })
})

test('the relay environment is a quoted inline prefix', () => {
  expect(relayEnv('manager', 'm1', '/r/.git/flow/sessions/m1/relay')).toBe("FLOW_ROLE=manager FLOW_NAME='m1' FLOW_RELAY='/r/.git/flow/sessions/m1/relay'")
  expect(relayEnv('worker', 'w1')).toBe("FLOW_ROLE=worker FLOW_NAME='w1'")
  expect(relayEnv('manager', "it's", '/a b')).toBe(`FLOW_ROLE=manager FLOW_NAME='it'\\''s' FLOW_RELAY='/a b'`)
})

test('only agent or a claude-running harness can run a manager or the reviewer', () => {
  const h = harnessesOf({ mine: { start: 'my-wrapper {prompt}', digest: 'claude-transcript' }, wrapped: '/usr/local/bin/claude --x {prompt}', aider: 'aider {prompt}' })
  expect(roleHarnessOf('agent', h)).toEqual({ harness: 'agent' })
  expect(roleHarnessOf('', h)).toEqual({ harness: 'agent' })
  expect(roleHarnessOf('claude', h)).toEqual({ harness: 'claude' })
  expect(roleHarnessOf('mine', h)).toEqual({ harness: 'mine' })
  expect(roleHarnessOf('wrapped', h)).toEqual({ harness: 'wrapped' })
  expect(roleHarnessOf('codex', h)).toMatchObject({ harness: 'agent', reason: expect.stringContaining('claude') })
  expect(roleHarnessOf('aider', h).harness).toBe('agent')
  expect(roleHarnessOf('nope', h)).toMatchObject({ harness: 'agent', reason: expect.stringContaining('unknown') })
})

test('the Claude digest marks the turn done when the last assistant row ended it and no user row follows', () => {
  const asst = (stop: string | null, t: string) => JSON.stringify({ type: 'assistant', timestamp: t, message: { stop_reason: stop, content: [{ type: 'text', text: 'ok' }] } })
  const user = JSON.stringify({ type: 'user', timestamp: '2026-10-09T11:00:30Z', message: { content: 'next' } })
  expect(parseClaudeTranscript(asst('end_turn', '2026-10-09T11:00:00Z')).turnDone).toBe(Date.parse('2026-10-09T11:00:00Z'))
  expect(parseClaudeTranscript([asst('end_turn', '2026-10-09T11:00:00Z'), user].join('\n')).turnDone).toBeUndefined()
  expect(parseClaudeTranscript([asst('end_turn', '2026-10-09T11:00:00Z'), asst('tool_use', '2026-10-09T11:00:40Z')].join('\n')).turnDone).toBeUndefined()
  expect(sessionLive({ ...SESSION_BASE, status: 'idle' })).toBe(true)
  expect(sessionLive({ ...SESSION_BASE, status: 'stopped' })).toBe(false)
})

test('manager_harness and reviewer_harness default to agent', () => {
  const d = settingsOf({}, 'main')
  expect(d.managerHarness).toBe('agent')
  expect(d.reviewerHarness).toBe('agent')
  const s = settingsOf({ manager_harness: 'claude', reviewer_harness: 'claude' }, 'main')
  expect([s.managerHarness, s.reviewerHarness]).toEqual(['claude', 'claude'])
})

test('the terminal role prompts carry the report file and their rules', () => {
  expect(MANAGER_SESSION_RULES).toContain('{{REPORT}}')
  expect(MANAGER_SESSION_RULES).toContain('never with the Agent tool')
  expect(REVIEWER_SESSION_RULES_AUTO).toContain('wait in this terminal')
  expect(REVIEWER_SESSION_RULES_AUTO).toContain('new handover')
  expect(REVIEWER_SESSION_RULES_CONFIRM).toContain('and stop')
  expect(REVIEWER_SESSION_RULES_CONFIRM).not.toContain('new handover')
})
