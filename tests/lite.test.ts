import type { AgentInfo } from 'claude-code'
import { expect, mock } from 'claude-code/testing'
import { test } from './support'
import type { TestBody } from 'claude-code/testing'
import { isLite, isSkip } from '../hooks/preflight'
import { deployToolAccess, isLiteName, liteStartPrompt, LITE_USAGE, normalizeLite, recordLite, releaseToolAccess, reviewerToolAccess } from '../hooks/lite'
import { LITE_RULES, liteSteps } from '../hooks/prompts'
import type { Handover } from '../types'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const DIR = '/r/.git/flow'
const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const PR = { state: 'OPEN', isDraft: false, headRefOid: 'abc1234def5678', headRefName: 'flow/csv', title: 'Export', labels: [], body: '## Verification\nRan:\n- `bun test`: pass\nExercised: ran it\nNot verified:\n- full check' }

// Main starts managers and gets ids a1, a2, ..; every spawn is recorded with its model and prompt.
function world(on: On) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const agents: AgentInfo[] = []
  const files = new Map<string, string>()
  const spawned: { type: string; name?: string; model?: string; prompt: string }[] = []
  const submitted: string[] = []
  const prBody = { text: PR.body }
  on('agent.list', () => ({ value: agents }))
  on('agent.spawn', (_, e) => {
    const input = e as unknown as { subagentType: string; name?: string; description: string; model?: string; prompt: string; parentAgentId?: string }
    spawned.push({ type: input.subagentType, name: input.name, model: input.model, prompt: input.prompt })
    const id = `a${agents.length + 1}`
    agents.push({ id, name: input.name, description: input.description, type: input.subagentType, status: 'running', parentId: input.parentAgentId })
    return { model: input.model ?? 'none', agentId: id }
  })
  on('session.start', () => ({ cwd: '/r' }))
  on('command.register', () => ({ value: undefined } as never))
  on('tool.register', () => ({ value: undefined } as never))
  on('agent.register', (_, e) => ({ value: { agent: (e as unknown as { name: string }).name } }))
  on('fs.exists', (_, e) => ({ value: files.has((e as unknown as { path: string }).path) }))
  on('fs.stat', () => { throw new Error('ENOENT') })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.send', () => ({ isDelivered: true as const }))
  on('prompt.submit', (_, e) => { submitted.push(e.text); return { text: e.text } })
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('fs.read', (_, e) => {
    const t = files.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('process.run', (_, e) => {
    const a = e.argv
    if (a[0] === 'git' && a[1] === 'rev-parse') return ok('/r/.git\n')
    if (a[0] === 'gh') return ok(JSON.stringify({ ...PR, body: prBody.text }))
    if (a[0] === 'mv') {
      const t = files.get(a[1] ?? '')
      if (t !== undefined) { files.set(a[2] ?? '', t); files.delete(a[1] ?? '') }
    }
    return ok()
  })
  return { clock, agents, files, spawned, submitted, prBody }
}

const manager = ($: Dollar, name: string, prompt: string) =>
  $.agent.spawn({ prompt, description: name, name, subagentType: 'flow:manager' } as never)
const worker = ($: Dollar, parent: string, name: string, prompt = 'brief') =>
  $.agent.spawn({ prompt, description: name, name, subagentType: 'flow:worker', parentAgentId: parent } as never).then(r => JSON.stringify(r))
const tool = ($: Dollar, agentId: string | null, input: Record<string, unknown>) =>
  $.tool.call({ ...input, ...(agentId === null ? {} : { agentId }) } as never).then(r => String(r.result))
const handover = ($: Dollar, agentId: string, extra: Record<string, unknown> = {}) =>
  tool($, agentId, { tool: 'mcp__flow__handover', pr: 7, verified: 'v', ...extra })
const inboxItems = (w: ReturnType<typeof world>) => (JSON.parse(w.files.get(`${DIR}/inbox.json`) ?? '{"items":[]}') as { items: { topic?: string }[] }).items

test('Mode: lite is detected and implies Pre-flight: skip', () => {
  expect(isLite('Mode: lite\nfix the typo')).toBe(true)
  expect(isLite('task\n  Mode:  Lite\n')).toBe(true)
  expect(isLite('The Mode: lite switch')).toBe(false)
  expect(isLite('Mode: litezone')).toBe(false)
  // The live Orca test: a task that says lite is not wanted must not start lite.
  expect(isLite('Mode: lite is NOT wanted: use normal handovers')).toBe(false)
  expect(isLite('Mode: lite, no pre-flight')).toBe(false)
  expect(isSkip('Mode: lite is NOT wanted')).toBe(false)
  expect(isSkip('Mode: lite\nx')).toBe(true)
  expect(isSkip('plain task')).toBe(false)
})

test('lite state: keyed by note key, so a successor is lite too; bad records are dropped', () => {
  const s = recordLite({}, 'csv-fix', 5)
  expect(isLiteName(s, 'csv-fix-2')).toBe(true)
  expect(isLiteName(s, 'other')).toBe(false)
  expect(recordLite(s, 'csv-fix-2', 9)).toBe(s)
  expect(normalizeLite({ a: { name: 'a', at: 1 }, b: 3, c: { at: 2 } })).toEqual({ a: { name: 'a', at: 1 } })
})

test('the LITE block carries the self-merge steps for the repo settings', () => {
  const base = { base: 'main', fullCheck: 'npm run check', deployCommand: '', deployTargets: [], release: false, pushMode: 'auto' }
  const plain = liteSteps(base as never)
  expect(plain).toContain('npm run check')
  expect(plain).toContain('git push origin HEAD:main')
  expect(plain).toContain('action "done"')
  expect(plain).not.toContain('mcp__flow__release')
  expect(LITE_RULES).toContain('{{LITE_STEPS}}')
  expect(LITE_RULES).toContain('mode "confirm"')
  const full = liteSteps({ ...base, release: true, releaseGithub: true, deployTargets: [{ name: 'demo', mode: 'auto', backup: [], deploy: ['./d'], verify: [] }] } as never)
  expect(full).toContain('mcp__flow__release')
  expect(full).toContain('action "publish"')
  expect(full).toContain('mcp__flow__deploy')
  const gated = liteSteps({ ...base, release: true, pushMode: 'confirm' } as never)
  expect(gated).toContain('action "ready"')
  expect(gated).not.toContain('git push origin HEAD:main')
})

test('tool access: a lite manager reaches the reviewer tools for its own PRs only', () => {
  const own = { pr: 7, lite: true, reportTo: 'csv-fix' } as unknown as Handover
  const theirs = { pr: 8, lite: true, reportTo: 'other' } as unknown as Handover
  const normal = { pr: 9, reportTo: 'csv-fix' } as unknown as Handover
  const hs = { '7': own, '8': theirs, '9': normal }
  const lite = { kind: 'lite', name: 'csv-fix' } as const
  expect(reviewerToolAccess(lite, { action: 'done', pr: 7 }, hs)).toBeUndefined()
  expect(reviewerToolAccess(lite, { action: 'ready', prs: [7] }, hs)).toBeUndefined()
  expect(reviewerToolAccess(lite, { action: 'done', pr: 8 }, hs)).toContain('Refused')
  expect(reviewerToolAccess(lite, { action: 'done', pr: 9 }, hs)).toContain('Refused')
  expect(reviewerToolAccess(lite, { action: 'take', pr: 7 }, hs)).toContain('Refused')
  expect(reviewerToolAccess({ kind: 'other' }, { action: 'done', pr: 7 }, hs)).toContain('Refused')
  expect(reviewerToolAccess({ kind: 'other' }, { action: 'list' }, hs)).toBeUndefined()
  expect(reviewerToolAccess({ kind: 'reviewer' }, { action: 'done', pr: 8 }, hs)).toBeUndefined()
  expect(releaseToolAccess(lite, { prs: [7] }, hs)).toBeUndefined()
  expect(releaseToolAccess(lite, { prs: [7, 8] }, hs)).toContain('Refused')
  expect(releaseToolAccess(lite, { action: 'publish' }, hs)).toBeUndefined()
  expect(releaseToolAccess(lite, { action: 'publish' }, {})).toContain('Refused')
  expect(releaseToolAccess({ kind: 'other' }, { prs: [7] }, hs)).toContain('Refused')
  expect(deployToolAccess(lite, { action: 'gate' }, hs)).toBeUndefined()
  expect(deployToolAccess(lite, { action: 'gate' }, { '8': theirs })).toContain('Refused')
  expect(deployToolAccess({ kind: 'other' }, { action: 'deployed' }, hs)).toContain('Refused')
  expect(deployToolAccess({ kind: 'other' }, { action: 'list' }, hs)).toBeUndefined()
  expect(deployToolAccess({ kind: 'main' }, { action: 'hold' }, hs)).toBeUndefined()
})

test('a lite manager is recorded, gets the LITE block and the normal manager model, and survives in lite.json', async ($, on) => {
  const w = world(on)
  await manager($, 'csv-fix', 'Mode: lite\nfix the csv header')
  const m = w.spawned[0]!
  expect(m.prompt.startsWith('## LITE MODE')).toBe(true)
  expect(m.prompt).toContain('fix the csv header')
  expect(m.model).toBeUndefined()
  const stored = JSON.parse(w.files.get(`${DIR}/lite.json`) ?? '{}') as Record<string, { name: string }>
  expect(stored['csv-fix']!.name).toBe('csv-fix')
  // A restarted manager of the same task (no Mode line on its prompt) is still lite, and the block is not doubled.
  await manager($, 'csv-fix-2', 'continue the csv work')
  expect(w.spawned[1]!.prompt.startsWith('## LITE MODE')).toBe(true)
  await manager($, 'csv-fix-3', `${m.prompt}`)
  expect(w.spawned[2]!.prompt.match(/## LITE MODE/g)!.length).toBe(1)
})

test('normal manager size routing applies unchanged to a lite manager; a plain manager has no block', async ($, on) => {
  const w = world(on)
  await manager($, 'big', 'Mode: lite\nSize: large - wide change\nrework')
  expect(w.spawned[0]!.model).not.toBe('sonnet')
  await manager($, 'plain', 'just a task')
  expect(w.spawned[1]!.prompt).toBe('just a task')
})

test('a lite manager is skipped in pre-flight: never gated, never waiting in a round', async ($, on) => {
  const w = world(on)
  await manager($, 'csv-fix', 'Mode: lite\nfix')
  expect(await worker($, 'a1', 'w1')).not.toContain('pre-flight')
  const state = JSON.parse(w.files.get(`${DIR}/preflight.json`) ?? '{}') as { entries: Record<string, { phase: string }> }
  expect(state.entries['csv-fix']!.phase).toBe('skipped')
  await w.clock.advance(10 * 60_000 + 1000)
  expect(w.submitted).toEqual([])
})

test('a lite manager and its workers file no size decisions, but routing still sets the worker model', async ($, on) => {
  const w = world(on)
  await manager($, 'csv-fix', 'Mode: lite\nfix')
  await worker($, 'a1', 'csv-w', 'Size: small - one line\nYour name: csv-w')
  expect(w.spawned[1]!.model).toBe('haiku')
  expect(inboxItems(w).filter(i => i.topic === 'manager-size' || i.topic === 'worker-size')).toEqual([])
  // A normal small manager still files its decision.
  await manager($, 'docs', 'Size: small - docs\nfix docs')
  expect(inboxItems(w).filter(i => i.topic === 'manager-size').length).toBe(1)
})

test('/flow lite submits the start prompt to main; alone it prints the usage', async ($, on) => {
  const w = world(on)
  const none = await $.command.run({ command: 'flow', args: 'lite' } as never)
  expect(none.text).toBe(LITE_USAGE)
  const r = await $.command.run({ command: 'flow', args: 'lite fix the csv header' } as never)
  expect(r.text).toContain('lite manager')
  await w.clock.advance(5)
  expect(w.submitted).toEqual([liteStartPrompt('fix the csv header')])
  expect(w.submitted[0]).toContain('Mode: lite')
  expect(w.submitted[0]).toContain('fix the csv header')
})

test('a lite handover starts no reviewer, records the PR as taken and answers with the merge steps', async ($, on) => {
  const w = world(on)
  await manager($, 'csv-fix', 'Mode: lite\nfix')
  const r = await handover($, 'a1')
  expect(r).toContain('no reviewer was started')
  expect(r).toContain('action "done"')
  expect(w.spawned.map(s => s.type)).toEqual(['flow:manager'])
  const stored = JSON.parse(w.files.get(`${DIR}/handovers/7.json`) ?? '{}') as Handover
  expect(stored).toMatchObject({ status: 'taken', lite: true, reportTo: 'csv-fix' })
  // Twice for the same PR is fine.
  expect(await handover($, 'a1')).toContain('no reviewer was started')
  // The lite manager may finish its own PR; a reviewer would not be needed.
  expect(await tool($, 'a1', { tool: 'mcp__flow__reviewer', action: 'done', pr: 7, sha: 'abc1234', report: 'full check: ok' })).toContain('PR #7: done')
})

test('a lite handover still needs the Verification section', async ($, on) => {
  const w = world(on)
  await manager($, 'csv-fix', 'Mode: lite\nfix')
  w.prBody.text = 'no proof'
  expect(await handover($, 'a1')).toMatch(/^Refused:/)
  expect(w.files.has(`${DIR}/handovers/7.json`)).toBe(false)
})

test('a lite handover with mode confirm, or under merge_mode confirm, falls back to the reviewer path', async ($, on) => {
  const w = world(on)
  await manager($, 'csv-fix', 'Mode: lite\nfix')
  const r = await handover($, 'a1', { mode: 'confirm' })
  expect(r).toContain('awaits the user')
  expect(JSON.parse(w.files.get(`${DIR}/handovers/7.json`) ?? '{}')).toMatchObject({ status: 'awaiting' })
  expect(JSON.parse(w.files.get(`${DIR}/handovers/7.json`) ?? '{}').lite).toBeUndefined()
})

test('under merge_mode confirm a lite manager hands over normally', { options: { merge_mode: 'confirm' } }, async ($, on) => {
  const w = world(on)
  await manager($, 'csv-fix', 'Mode: lite\nfix')
  expect(await handover($, 'a1')).toContain('awaits the user')
  expect(JSON.parse(w.files.get(`${DIR}/handovers/7.json`) ?? '{}')).toMatchObject({ status: 'awaiting' })
})

test('a lite manager reaches release and deploy for its own PR; a normal manager and a worker are refused', async ($, on) => {
  const w = world(on)
  await manager($, 'csv-fix', 'Mode: lite\nfix')
  await manager($, 'plain', 'normal task')
  await worker($, 'a1', 'csv-w')
  await handover($, 'a1')
  const notForYou = /is not for you|Refused: a lite manager/
  // Lite on its own PR: the call gets past the access check (the release setting is off in this repo, so the tool itself refuses).
  expect(await tool($, 'a1', { tool: 'mcp__flow__release', dir: '/r', prs: [7] })).toContain('release setting is off')
  expect(await tool($, 'a1', { tool: 'mcp__flow__reviewer', action: 'ready', prs: [7] })).toContain('push_mode is auto')
  expect(await tool($, 'a1', { tool: 'mcp__flow__deploy', action: 'gate', target: 'x', sha: 'abc' })).not.toMatch(notForYou)
  // A normal manager (a2) and a worker (a3) are refused.
  for (const id of ['a2', 'a3']) {
    expect(await tool($, id, { tool: 'mcp__flow__release', dir: '/r', prs: [7] })).toMatch(notForYou)
    expect(await tool($, id, { tool: 'mcp__flow__reviewer', action: 'done', pr: 7, sha: 'a' })).toMatch(notForYou)
    expect(await tool($, id, { tool: 'mcp__flow__deploy', action: 'gate', target: 'x', sha: 'abc' })).toMatch(notForYou)
  }
  // Main-only actions stay main-only for a lite manager.
  expect(await tool($, 'a1', { tool: 'mcp__flow__deploy', action: 'hold', target: 'x', until: 'batch' })).toContain('only main')
  expect(await tool($, 'a1', { tool: 'mcp__flow__push', action: 'push' })).toContain('only main')
  expect(w.spawned.filter(s => s.type === 'flow:reviewer')).toEqual([])
})
