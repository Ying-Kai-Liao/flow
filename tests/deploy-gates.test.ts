import type { AgentInfo } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import {
  applyAnswer, approvalContext, behindLines, decideGate, normalizeDeploys, openApprovalItem, openDeployIds, recordDeployed, release,
  renderList, retargetItem, unknownTarget, withApproval, withHold,
} from '../hooks/deploy'
import { EMPTY_INBOX, needsMessage, renderInbox } from '../hooks/inbox'
import { deployModeWarnings, deployTargetsOf, deploySection, targetsOf } from '../hooks/prompts'
import { matchRule, parseRules, validateRule } from '../hooks/standing'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const none = () => false

// ---- pure half ----

test('deploy mode: absent is auto, confirm stays, anything else is confirm with a warning', () => {
  const raw = [
    { name: 'a', deploy: ['x'] },
    { name: 'b', deploy: ['x'], mode: 'auto' },
    { name: 'c', deploy: ['x'], mode: 'confirm' },
    { name: 'd', deploy: ['x'], mode: 'Confirmed' },
  ]
  expect(deployTargetsOf(raw).map(t => [t.name, t.mode])).toEqual([['a', 'auto'], ['b', 'auto'], ['c', 'confirm'], ['d', 'confirm']])
  expect(deployModeWarnings(raw)).toEqual(['deploy_targets: "d" has mode "Confirmed"; treated as "confirm" (use "auto" or "confirm")'])
  expect(deployModeWarnings(JSON.stringify(raw))).toHaveLength(1)
  expect(deployModeWarnings(undefined)).toEqual([])
})

test('a single legacy deploy_command stays auto, and the section names each mode and the gate', () => {
  const s = { deployCommand: './deploy', deployTargets: [] }
  expect(targetsOf(s).map(t => t.mode)).toEqual(['auto'])
  const section = deploySection({ deployCommand: '', deployTargets: deployTargetsOf([{ name: 'demo', deploy: ['d'] }, { name: 'production', deploy: ['p'], mode: 'confirm' }]) })
  expect(section).toContain('Target "demo" (mode auto)')
  expect(section).toContain('Target "production" (mode confirm')
  expect(section).toContain('"gate"')
  expect(section).toContain('"deployed"')
  expect(section).toContain('does not: go on to the next one')
})

test('decideGate: auto goes, a batch hold stops the first call only, a released hold stays', () => {
  expect(decideGate(undefined, 'auto', 'abc', none).gate).toEqual({ kind: 'go' })
  const batch = withHold(undefined, { until: 'batch', by: 'main', at: 1, reason: 'demo only' })
  const first = decideGate(batch, 'auto', 'abc', none)
  expect(first.gate.kind).toBe('held')
  expect(first.gate.kind === 'held' && first.gate.why).toContain('demo only')
  expect(decideGate(first.state, 'auto', 'abc', none).gate).toEqual({ kind: 'go' })
  const rel = withHold(undefined, { until: 'released', by: 'user', at: 1 })
  const a = decideGate(rel, 'auto', 'abc', none)
  expect(a.gate.kind).toBe('held')
  expect(decideGate(a.state, 'auto', 'abc', none).gate.kind).toBe('held')
})

test('decideGate: a confirm target asks, reuses its open item, follows the newest sha, and goes only on the approved sha', () => {
  expect(decideGate(undefined, 'confirm', 'aaa', none).gate).toEqual({ kind: 'ask' })
  const asked = withApproval(undefined, 'q4', 'aaa', 1)
  const open = (id: string) => id === 'q4'
  expect(decideGate(asked, 'confirm', 'aaa', open).gate).toEqual({ kind: 'awaits', qid: 'q4' })
  const moved = decideGate(asked, 'confirm', 'bbb', open)
  expect(moved.gate).toEqual({ kind: 'awaits', qid: 'q4' })
  expect(moved.state.approval?.sha).toBe('bbb')
  // The item was closed some other way: a new one.
  expect(decideGate(asked, 'confirm', 'aaa', none).gate).toEqual({ kind: 'ask' })
  const approved = applyAnswer(asked, 'deploy')
  expect(approved.due).toBe(true)
  expect(decideGate(approved, 'confirm', 'aaa', none).gate).toEqual({ kind: 'go' })
  expect(decideGate(approved, 'confirm', 'aaa', none).gate).toEqual({ kind: 'go' })
  // Base moved on: the approval does not cover the newer sha.
  expect(decideGate(approved, 'confirm', 'ccc', none).gate).toEqual({ kind: 'ask' })
  // A hold wins over an approval.
  expect(decideGate(withHold(approved, { until: 'released', by: 'main', at: 2 }), 'confirm', 'aaa', none).gate.kind).toBe('held')
})

test('applyAnswer: "not now" and free text drop the approval; deployed spends it and is idempotent', () => {
  const asked = withApproval(undefined, 'q4', 'aaa', 1)
  expect(applyAnswer(asked, 'not now').approval).toBeUndefined()
  expect(applyAnswer(asked, 'yes please').approval).toBeUndefined()
  expect(applyAnswer(undefined, 'deploy')).toEqual({})
  const approved = applyAnswer(asked, 'deploy')
  const done = recordDeployed(approved, 'aaa', true, 50)
  expect(done).toEqual({ deployedSha: 'aaa', deployedAt: 50 })
  expect(recordDeployed(done, 'aaa', true, 99)).toEqual({ deployedSha: 'aaa', deployedAt: 50 })
  expect(recordDeployed(done, 'bbb', false, 99)).toBe(done)
  // A pending item for a newer sha survives an older deploy.
  expect(recordDeployed(withApproval(undefined, 'q9', 'ccc', 1), 'aaa', true, 5).approval?.qid).toBe('q9')
})

test('release: an auto target becomes due, a confirm one does not; no hold changes nothing', () => {
  const held = withHold({ deployedSha: 'aaa' }, { until: 'released', by: 'user', at: 1 })
  expect(release(held, 'auto')).toEqual({ state: { deployedSha: 'aaa', due: true }, had: true })
  expect(release(held, 'confirm')).toEqual({ state: { deployedSha: 'aaa' }, had: true })
  expect(release({ deployedSha: 'aaa' }, 'auto').had).toBe(false)
  expect(release(undefined, 'auto').had).toBe(false)
})

test('normalizeDeploys drops what is malformed and keeps what is valid', () => {
  expect(normalizeDeploys(null)).toEqual({ targets: {} })
  expect(normalizeDeploys('x')).toEqual({ targets: {} })
  expect(normalizeDeploys({ targets: [] })).toEqual({ targets: {} })
  const d = normalizeDeploys({
    targets: {
      demo: { deployedSha: 'abc', deployedAt: 5, hold: { until: 'forever', by: 'x', at: 1 }, approval: { qid: 'q1', sha: 'abc', state: 'weird', at: 1 } },
      production: { hold: { until: 'batch', by: 'main', at: 2, reason: 'r' }, approval: { qid: 'q2', sha: 'def', state: 'pending', at: 3 }, due: true },
      bad: 4,
    },
  })
  expect(d.targets.demo).toEqual({ deployedSha: 'abc', deployedAt: 5 })
  expect(d.targets.production).toEqual({ hold: { until: 'batch', by: 'main', at: 2, reason: 'r' }, approval: { qid: 'q2', sha: 'def', state: 'pending', at: 3 }, due: true })
  expect(d.targets.bad).toBeUndefined()
})

test('behind text: never deployed, behind by N, quiet when up to date; list shows the rest', () => {
  const targets = [{ name: 'demo', mode: 'auto' as const }, { name: 'production', mode: 'confirm' as const }]
  const d = { targets: { demo: { deployedSha: 'aaaaaaaa11' }, production: { deployedSha: 'bbbbbbbb22', hold: { until: 'released' as const, by: 'user', at: 1 } } } }
  expect(behindLines(targets, d, { demo: 0, production: 3 })).toEqual(['production behind by 3 commits (held by user until released)'])
  expect(behindLines(targets, { targets: {} }, {})).toEqual(['demo: no deploy recorded', 'production: no deploy recorded'])
  expect(behindLines(targets, d, { production: 1 })[0]).toContain('behind by 1 commit ')
  const list = renderList(targets, d, { production: 3 })
  expect(list).toContain('demo: mode auto; not held; last deployed aaaaaaaa')
  expect(list).toContain('production: mode confirm; held by user until released; last deployed bbbbbbbb, behind by 3 commits')
  expect(unknownTarget(targets, 'nope')).toBe('Unknown target "nope". Configured: demo, production.')
  expect(unknownTarget(targets, 'demo')).toBeUndefined()
})

test('the approval item is a blocking deploy item for main, with the sha and commits; retargeting keeps its id', () => {
  const ctx = approvalContext('production', 'abcdef1234', 'aaaaaaaa11', ['abc1 one', 'abc2 two'])
  expect(ctx).toContain('since aaaaaaaa: abc1 one; abc2 two')
  const { inbox, q } = openApprovalItem(EMPTY_INBOX, 'production', 'abcdef1234', ctx, 10)
  expect(q).toMatchObject({ id: 'q1', addressee: 'main', blocking: true, kind: 'deploy', options: ['deploy', 'not now'], default: 'not now', state: 'open' })
  expect(q.question).toBe('Deploy production at abcdef12?')
  expect(needsMessage(q, false)).toBe(false)
  expect(openDeployIds(inbox).has('q1')).toBe(true)
  expect(renderInbox(inbox, 20)).toContain('DEPLOY APPROVAL')
  const moved = retargetItem(inbox, 'q1', 'production', '999999999', 'ctx2')
  expect(moved.items).toHaveLength(1)
  expect(moved.items[0]).toMatchObject({ id: 'q1', question: 'Deploy production at 99999999?', context: 'ctx2' })
})

test('standing answers skip a deploy approval unless a rule names the kind', () => {
  const { inbox, q } = openApprovalItem(EMPTY_INBOX, 'production', 'abcdef1234', 'c', 10)
  void inbox
  const plain = parseRules([{ match: 'Deploy', answer: 'deploy', blocking: true }], 'personal', 'f', [])
  expect(matchRule(plain, q)).toBeUndefined()
  const opted = parseRules([{ match: 'Deploy', answer: 'deploy', blocking: true, kinds: ['deploy'] }], 'personal', 'f', [])
  expect(matchRule(opted, q)?.answer).toBe('deploy')
  // A rule limited to deploy items does not answer ordinary questions.
  const ordinary = { question: 'Deploy now?', options: ['deploy', 'not now'], blocking: true, owner: 'w' }
  expect(matchRule(opted, ordinary)).toBeUndefined()
  expect('error' in validateRule({ topic: 't', answer: 'a', kinds: 5 })).toBe(true)
  expect(validateRule({ topic: 't', answer: 'a', kinds: 'deploy' })).toMatchObject({ rule: { kinds: ['deploy'] } })
})

// ---- plugin half ----

const DIR = '/r/.git/flow'
const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const TARGETS = [
  { name: 'demo', deploy: ['./deploy demo'] },
  { name: 'production', deploy: ['./deploy prod'], mode: 'confirm' },
]

function world(on: On) {
  mock.clock(on, { now: 1_000_000 })
  const agents: AgentInfo[] = [{ id: 'q1', name: 'merge-queue-1', description: 'q', type: 'flow:queue', status: 'running' }]
  const files = new Map<string, string>()
  const spawned: string[] = []
  const toasts: string[] = []
  let behind = '4'
  on('agent.list', () => ({ value: agents }))
  on('agent.spawn', (_, e) => {
    const input = e as unknown as { subagent_type?: string; subagentType?: string; name?: string; description: string }
    const type = input.subagent_type ?? input.subagentType ?? ''
    spawned.push(type)
    agents.push({ id: 'q2', name: input.name, description: input.description, type, status: 'running' })
    return { model: 'sonnet', agentId: 'q2' }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', (_, e) => { toasts.push(String((e as { text?: string }).text)); return { value: undefined } })
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('fs.read', (_, e) => {
    const t = files.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('process.run', (_, e) => {
    const a = e.argv
    if (a[0] === 'git' && a[1] === 'rev-parse') return ok('/r/.git\n')
    if (a[0] === 'git' && a[1] === 'rev-list') return ok(`${behind}\n`)
    if (a[0] === 'git' && a[1] === 'log') return ok('c3 third\nc2 second\n')
    if (a[0] === 'mv') {
      const t = files.get(a[1] ?? '')
      if (t !== undefined) { files.set(a[2] ?? '', t); files.delete(a[1] ?? '') }
    }
    return ok()
  })
  return { agents, files, spawned, toasts, setBehind: (n: string) => { behind = n } }
}

const deploy = ($: Dollar, args: Record<string, unknown>, agentId: string | null = null) =>
  $.tool.call({ tool: 'mcp__flow__deploy', ...args, ...(agentId === null ? {} : { agentId }) } as never).then(r => String(r.result))
const answer = ($: Dollar, args: Record<string, unknown>) =>
  $.tool.call({ tool: 'mcp__flow__answer', ...args } as never).then(r => String(r.result))
const stored = (files: Map<string, string>) => JSON.parse(files.get(`${DIR}/deploys.json`) ?? '{}') as { targets: Record<string, Record<string, unknown>> }
const inboxOf = (files: Map<string, string>) => JSON.parse(files.get(`${DIR}/inbox.json`) ?? '{"items":[]}') as { items: Array<Record<string, unknown>> }

test('gate: an auto target goes; a confirm target opens one item and reuses it; the skipped target does not block a go', { options: { deploy_targets: JSON.stringify(TARGETS) } }, async ($, on) => {
  const w = world(on)
  expect(await deploy($, { action: 'gate', target: 'demo', sha: 'abc1234' }, 'q1')).toBe('Go')
  const first = await deploy($, { action: 'gate', target: 'production', sha: 'abc1234' }, 'q1')
  expect(first).toContain('Awaits approval: q1')
  expect(await deploy($, { action: 'gate', target: 'production', sha: 'abc1234' }, 'q1')).toContain('Awaits approval: q1')
  const items = inboxOf(w.files).items
  expect(items).toHaveLength(1)
  expect(items[0]).toMatchObject({ id: 'q1', kind: 'deploy', blocking: true, addressee: 'main', default: 'not now' })
  expect(stored(w.files).targets.production).toMatchObject({ approval: { qid: 'q1', sha: 'abc1234', state: 'pending' } })
  expect(w.toasts.join('\n')).toContain('production awaits your approval')
  // A newer sha while the item is open: the same item follows it.
  expect(await deploy($, { action: 'gate', target: 'production', sha: 'def5678' }, 'q1')).toContain('Awaits approval: q1')
  const after = inboxOf(w.files).items
  expect(after).toHaveLength(1)
  expect(String(after[0]!.question)).toContain('def5678')
  const view = await $.command.run({ command: 'flow', args: 'inbox' } as never).then(r => r.text ?? '')
  expect(view).toContain('DEPLOY APPROVAL')
})

test('answering "deploy" approves that sha and starts a deploy-only queue; the gate then goes for it only', { options: { deploy_targets: JSON.stringify(TARGETS) } }, async ($, on) => {
  const w = world(on)
  // No queue is running now, so the answer starts one.
  w.agents.length = 0
  await deploy($, { action: 'gate', target: 'production', sha: 'abc1234' })
  const res = await answer($, { answers: [{ id: 'q1', choice: 'deploy' }] })
  expect(res).toContain('production approved')
  expect(w.spawned).toEqual(['flow:queue'])
  expect(stored(w.files).targets.production).toMatchObject({ approval: { state: 'approved', sha: 'abc1234' }, due: true })
  expect(await deploy($, { action: 'list' })).toContain('DUE: deploy abc1234')
  expect(await deploy($, { action: 'gate', target: 'production', sha: 'abc1234' }, 'q2')).toBe('Go')
  expect(await deploy($, { action: 'gate', target: 'production', sha: 'fff9999' }, 'q2')).toContain('Awaits approval: q2')
  await deploy($, { action: 'deployed', target: 'production', sha: 'abc1234', ok: true }, 'q2')
  await deploy($, { action: 'deployed', target: 'production', sha: 'abc1234', ok: true }, 'q2')
  const t = stored(w.files).targets.production!
  expect(t.deployedSha).toBe('abc1234')
  expect(t.due).toBeUndefined()
  expect(t.approval).toMatchObject({ qid: 'q2', state: 'pending' })
})

test('"not now" leaves the target behind and starts no queue; the next gate asks again', { options: { deploy_targets: JSON.stringify(TARGETS) } }, async ($, on) => {
  const w = world(on)
  w.agents.length = 0
  await deploy($, { action: 'gate', target: 'production', sha: 'abc1234' })
  const res = await answer($, { answers: [{ id: 'q1', choice: 'not now' }] })
  expect(res).toContain('stays behind')
  expect(w.spawned).toEqual([])
  expect(await deploy($, { action: 'gate', target: 'production', sha: 'abc1234' })).toContain('Awaits approval: q2')
})

test('hold and release are main only; unknown targets list the configured ones; a batch hold is spent by one gate', { options: { deploy_targets: JSON.stringify(TARGETS) } }, async ($, on) => {
  const w = world(on)
  expect(await deploy($, { action: 'hold', target: 'demo', until: 'batch' }, 'q1')).toContain('Refused: only main')
  expect(await deploy($, { action: 'release', target: 'demo' }, 'q1')).toContain('Refused: only main')
  expect(await deploy($, { action: 'hold', target: 'nope', until: 'batch' })).toContain('Configured: demo, production')
  expect(await deploy($, { action: 'hold', target: 'demo' })).toContain('until')
  await deploy($, { action: 'hold', target: 'demo', until: 'batch', reason: 'demo only' })
  await deploy($, { action: 'hold', target: 'demo', until: 'batch', reason: 'latest wins' })
  expect(stored(w.files).targets.demo!.hold).toMatchObject({ until: 'batch', reason: 'latest wins', by: 'main' })
  expect(await deploy($, { action: 'gate', target: 'demo', sha: 'abc' }, 'q1')).toContain('Held: held by main (latest wins) for this batch')
  expect(await deploy($, { action: 'gate', target: 'demo', sha: 'abc' }, 'q1')).toBe('Go')
  await deploy($, { action: 'hold', target: 'demo', until: 'released' })
  expect(await deploy($, { action: 'gate', target: 'demo', sha: 'abc' }, 'q1')).toContain('Held:')
  expect(await deploy($, { action: 'gate', target: 'demo', sha: 'abc' }, 'q1')).toContain('Held:')
  w.agents.length = 0
  const rel = await $.command.run({ command: 'flow', args: 'release demo' } as never).then(r => r.text ?? '')
  expect(rel).toContain('demo released')
  expect(w.spawned).toEqual(['flow:queue'])
  expect(await deploy($, { action: 'gate', target: 'demo', sha: 'abc' }, 'q2')).toBe('Go')
  expect(await $.command.run({ command: 'flow', args: 'release demo' } as never).then(r => r.text ?? '')).toContain('has no hold')
})

test('/flow hold sets a hold until released by default; bad usage is explained', { options: { deploy_targets: JSON.stringify(TARGETS) } }, async ($, on) => {
  const w = world(on)
  const run = (args: string) => $.command.run({ command: 'flow', args } as never).then(r => r.text ?? '')
  expect(await run('hold production')).toContain('held until released')
  expect(stored(w.files).targets.production!.hold).toMatchObject({ until: 'released', by: 'user' })
  expect(await run('hold production sometimes')).toContain('Usage: /flow hold')
  expect(await run('hold')).toContain('Usage: /flow hold')
  expect(await run('hold nope')).toContain('Unknown target')
  expect(await run('bogus')).toContain('/flow hold <target>')
})

test('status shows "behind by N commits" for a deployed target and "no deploy recorded" for a new one', { options: { deploy_targets: JSON.stringify(TARGETS) } }, async ($, on) => {
  world(on)
  await deploy($, { action: 'deployed', target: 'demo', sha: 'abc1234', ok: true }, 'q1')
  const status = String((await $.tool.call({ tool: 'mcp__flow__status' } as never)).result)
  expect(status).toContain('Deploy: demo behind by 4 commits')
  expect(status).toContain('Deploy: production: no deploy recorded')
  expect(await deploy($, { action: 'list' })).toContain('demo: mode auto; not held; last deployed abc1234, behind by 4 commits')
})

test('answer with always on a deploy approval makes no rule', { options: { deploy_targets: JSON.stringify(TARGETS) } }, async ($, on) => {
  const w = world(on)
  await deploy($, { action: 'gate', target: 'production', sha: 'abc1234' })
  const res = await answer($, { answers: [{ id: 'q1', choice: 'deploy', always: true }] })
  expect(res).toContain('no rule made, a deploy approval is the user\'s call every time')
  expect(w.files.get('/r/.git/flow/config.json') ?? '').not.toContain('standing_answers')
})

test('a legacy deploy_command is one auto target: the gate goes', { options: { deploy_command: './deploy' } }, async ($, on) => {
  world(on)
  expect(await deploy($, { action: 'gate', target: 'default', sha: 'abc1234' }, 'q1')).toBe('Go')
  expect(await deploy($, { action: 'list' })).toContain('default: mode auto')
})
