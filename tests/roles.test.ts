import { expect } from 'claude-code/testing'
import { test } from './support'

import { harnessesOf, parseClaudeTranscript, relayEnv, roleAgents, sessionLive, sessionRow } from '../hooks/sessions'
import { mergeLayers, modeOf, settingsOf } from '../hooks/settings'
import { myRelaySessionsTo, roleState } from '../hooks/role-session-run'
import type { RoleIo } from '../hooks/role-session-run'
import type { Session } from '../types'
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

test('the Claude digest marks the turn done when the last assistant row ended it and no user row follows', () => {
  const asst = (stop: string | null, t: string) => JSON.stringify({ type: 'assistant', timestamp: t, message: { stop_reason: stop, content: [{ type: 'text', text: 'ok' }] } })
  const user = JSON.stringify({ type: 'user', timestamp: '2026-10-09T11:00:30Z', message: { content: 'next' } })
  expect(parseClaudeTranscript(asst('end_turn', '2026-10-09T11:00:00Z')).turnDone).toBe(Date.parse('2026-10-09T11:00:00Z'))
  expect(parseClaudeTranscript([asst('end_turn', '2026-10-09T11:00:00Z'), user].join('\n')).turnDone).toBeUndefined()
  expect(parseClaudeTranscript([asst('end_turn', '2026-10-09T11:00:00Z'), asst('tool_use', '2026-10-09T11:00:40Z')].join('\n')).turnDone).toBeUndefined()
  expect(sessionLive({ ...SESSION_BASE, status: 'idle' })).toBe(true)
  expect(sessionLive({ ...SESSION_BASE, status: 'stopped' })).toBe(false)
})

test('mode defaults to agent; the replaced keys map onto it, with one note', () => {
  expect(settingsOf({}, 'main').mode).toBe('agent')
  expect(settingsOf({ mode: 'tmux' }, 'main').mode).toBe('tmux')
  expect(settingsOf({ mode: 'bogus' }, 'main').mode).toBe('agent')
  expect(modeOf({ manager_harness: 'claude' })).toMatchObject({ mode: 'orca', note: expect.stringContaining('using mode orca') })
  expect(modeOf({ reviewer_harness: 'claude', session_host: 'tmux' }).mode).toBe('tmux')
  expect(modeOf({ manager_harness: 'agent', reviewer_harness: 'agent', session_host: 'tmux' })).toMatchObject({ mode: 'agent', note: expect.stringContaining('using mode agent') })
  expect(modeOf({ mode: 'tmux', manager_harness: 'claude' }).mode).toBe('tmux')
  expect(modeOf({}).note).toBeUndefined()
  expect(settingsOf({ manager_harness: 'claude', session_host: 'tmux' }, 'main').mode).toBe('tmux')
})

test('loading warns once about the replaced keys, and about a terminal worker_harness in agent mode', () => {
  const old = mergeLayers({}, [{ path: '/r/s.json', text: JSON.stringify({ manager_harness: 'claude', session_host: 'tmux' }) }])
  expect(old.warnings.filter(w => w.includes('replaced by `mode`'))).toEqual(['flow: manager_harness/session_host are replaced by `mode`; using mode tmux'])
  const w = mergeLayers({}, [{ path: '/r/s.json', text: JSON.stringify({ worker_harness: 'codex' }) }])
  expect(w.warnings.some(x => x.includes('need mode orca or tmux'))).toBe(true)
  expect(w.raw.mode).toBeUndefined()
  expect(mergeLayers({ mode: 'orca' }, [{ path: '/r/s.json', text: JSON.stringify({ worker_harness: 'codex' }) }]).warnings).toEqual([])
})

test('the terminal role prompts carry the report file and their rules', () => {
  expect(MANAGER_SESSION_RULES).toContain('{{REPORT}}')
  expect(MANAGER_SESSION_RULES).toContain('never with the Agent tool')
  expect(REVIEWER_SESSION_RULES_AUTO).toContain('wait in this terminal')
  expect(REVIEWER_SESSION_RULES_AUTO).toContain('new handover')
  expect(REVIEWER_SESSION_RULES_CONFIRM).toContain('and stop')
  expect(REVIEWER_SESSION_RULES_CONFIRM).not.toContain('new handover')
})

test('main pumps its role sessions and its relaying workers; a worker without a relay dir, another main\'s worker and an ended one are left out', async () => {
  const me = { session: 's-me', pid: 100 }
  const other = { session: 's-other', pid: 200 }
  const all: Record<string, Session> = {
    m1: { ...SESSION_BASE, role: 'manager', relayDir: '/d/m1', mainOwner: me },
    w1: { ...SESSION_BASE, name: 'w1', relayDir: '/d/w1', mainOwner: me },
    w2: { ...SESSION_BASE, name: 'w2', relayDir: '/d/w2', mainOwner: other },
    w3: { ...SESSION_BASE, name: 'w3', relayDir: '/d/w3', mainOwner: me, status: 'exited' },
    old: { ...SESSION_BASE, name: 'old' },
  }
  const io = { sessions: async () => all } as unknown as RoleIo
  const was = roleState.identity
  roleState.identity = Promise.resolve(me)
  try {
    expect((await myRelaySessionsTo(io)).map(s => s.name)).toEqual(['m1', 'w1'])
    expect((await myRelaySessionsTo(io, true)).map(s => s.name)).toEqual(['m1', 'w1', 'w3'])
  } finally {
    roleState.identity = was
  }
})
