import type { AgentInfo } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import { currentEnvItem, decideEnv, envCommandFor, envRefusal, envSettledIn, openEnvItems, parseEnvInput, shellQuote, tidyEnvItems } from '../hooks/deploy'
import type { Handover, Question } from '../types'
import { EMPTY_INBOX, renderInbox } from '../hooks/inbox'
import { deployTargetsOf } from '../hooks/prompts'
import { matchRule, parseRules } from '../hooks/standing'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

// ---- pure half ----

const TARGETS = [{ name: 'demo', mode: 'auto' as const }, { name: 'production', mode: 'confirm' as const }]

test('env input: unknown targets list the configured ones, both value and secret is refused without echoing the value', () => {
  const unknown = parseEnvInput([{ target: 'staging', name: 'A', value: 'x', why: 'w' }], TARGETS)
  expect('error' in unknown && unknown.error).toContain('Configured: demo, production')
  const both = parseEnvInput([{ target: 'demo', name: 'A', value: 'hunter2-value', secret: true, why: 'w' }], TARGETS)
  expect('error' in both && both.error).toContain('either value or secret')
  expect(JSON.stringify(both)).not.toContain('hunter2-value')
  expect('error' in parseEnvInput([{ target: 'demo', name: 'A', why: 'w' }], TARGETS)).toBe(true)
  expect('error' in parseEnvInput([{ target: 'demo', name: '1A', value: 'x', why: 'w' }], TARGETS)).toBe(true)
  expect('error' in parseEnvInput([{ target: 'demo', name: 'A', value: 'x' }], TARGETS)).toBe(true)
  expect('error' in parseEnvInput([{ target: 'demo', name: 'A', value: 'x\ny', why: 'w' }], TARGETS)).toBe(true)
  expect('error' in parseEnvInput([{ target: 'demo', name: 'A', value: 'x', why: 'w' }, { target: 'demo', name: 'A', secret: true, why: 'w' }], TARGETS)).toBe(true)
  expect(parseEnvInput([{ target: 'demo', name: 'A', value: 'x', why: 'w' }], [])).toMatchObject({ error: expect.stringContaining('deploy target') })
  expect(parseEnvInput(undefined, [])).toEqual({ drafts: [] })
  expect(parseEnvInput([], [])).toEqual({ drafts: [] })
  const ok = parseEnvInput([{ target: 'demo', name: 'A_1', secret: true, why: 'w', login: ' log in ' }], TARGETS)
  expect(ok).toEqual({ drafts: [{ target: 'demo', name: 'A_1', why: 'w', secret: true, login: 'log in' }] })
})

test('env_command: parsed per target, the value is shell-quoted in one pass', () => {
  const t = deployTargetsOf([{ name: 'p', deploy: ['d'], env_command: ' fly secrets set {name}={value} -a app ' }, { name: 'q', deploy: ['d'] }])
  expect(t[0]!.envCommand).toBe('fly secrets set {name}={value} -a app')
  expect(t[1]!.envCommand).toBeUndefined()
  expect(shellQuote("it's")).toBe(`'it'\\''s'`)
  expect(envCommandFor('set {name}={value}', 'MAIL', 'a b; rm -rf {name}')).toBe(`set MAIL='a b; rm -rf {name}'`)
})

test('env items: one per change plus its login step; a re-handover reuses open items; a secret has no value', () => {
  const secret = openEnvItems(EMPTY_INBOX, 7, { target: 'demo', name: 'KEY', secret: true, why: 'new key', login: 'log in to the cloud CLI' }, undefined, 5)
  expect(secret.fresh.map(q => q.env?.role)).toEqual(['login', 'secret'])
  expect(secret.fresh[0]).toMatchObject({ kind: 'env', blocking: true, addressee: 'main', question: 'Do this yourself: log in to the cloud CLI', default: 'not yet' })
  expect(secret.fresh[1]).toMatchObject({ kind: 'env', question: 'Secret KEY on demo is set by you (new key). Set it, then answer done', options: ['done', 'not yet'], default: 'not yet' })
  expect(secret.change).toEqual({ target: 'demo', name: 'KEY', secret: true, why: 'new key', login: 'log in to the cloud CLI', qid: 'q2', loginQid: 'q1' })
  expect('value' in secret.change).toBe(false)
  const plain = openEnvItems(EMPTY_INBOX, 7, { target: 'demo', name: 'MAIL', value: 'Ops', why: 'sender' }, undefined, 5)
  expect(plain.fresh[0]).toMatchObject({ question: 'Set MAIL=Ops on demo? (sender)', options: ['yes', 'no'], default: 'no' })
  const again = openEnvItems(plain.inbox, 7, { target: 'demo', name: 'MAIL', value: 'Ops', why: 'sender' }, plain.change, 6)
  expect(again.fresh).toHaveLength(0)
  expect(again.change.qid).toBe(plain.change.qid)
  expect(again.inbox.items).toHaveLength(1)
  // A new value on an open item follows it; the id stays.
  const moved = openEnvItems(plain.inbox, 7, { target: 'demo', name: 'MAIL', value: 'Sales', why: 'sender' }, plain.change, 6)
  expect(moved.inbox.items[0]!.question).toBe('Set MAIL=Sales on demo? (sender)')
  const view = renderInbox(secret.inbox, 10)
  expect(view).toContain('DO YOURSELF')
  expect(view).toContain('SECRET')
})

test('decideEnv: declined wins, then open items, then apply items; clear lists commands and records', () => {
  const change = (name: string, extra = {}) => ({ target: 'demo', name, value: 'v', why: 'w', qid: `q-${name}`, ...extra })
  const item = (m: Record<string, { open: boolean; answer?: string }>) => (qid: string) => (m[qid] === undefined ? undefined : { qid, ...m[qid]! })
  const none = () => undefined
  const base = { applyItem: none, hasCommand: true }
  expect(decideEnv({ ...base, pending: [], item: none })).toEqual({ kind: 'clear', apply: [], record: [] })
  const a = { pr: 1, change: change('A') }
  expect(decideEnv({ ...base, pending: [a], item: item({ 'q-A': { open: true } }) })).toEqual({ kind: 'envAwaits', qids: ['q-A'] })
  expect(decideEnv({ ...base, pending: [a], item: item({ 'q-A': { open: false, answer: 'no' } }) })).toEqual({ kind: 'envHeld', why: 'env change A declined' })
  const yes = item({ 'q-A': { open: false, answer: 'yes' } })
  expect(decideEnv({ ...base, pending: [a], item: yes })).toEqual({ kind: 'clear', apply: [a], record: [] })
  // No env_command: the user applies it; a missing apply item is asked for.
  expect(decideEnv({ applyItem: none, hasCommand: false, pending: [a], item: yes })).toEqual({ kind: 'envAsk', entries: [a], open: [] })
  const open = { applyItem: () => ({ qid: 'qa', open: true }), hasCommand: false }
  expect(decideEnv({ ...open, pending: [a], item: yes })).toEqual({ kind: 'envAwaits', qids: ['qa'] })
  // A login step the user has not done yet.
  const withLogin = { pr: 1, change: change('A', { loginQid: 'q-login' }) }
  expect(decideEnv({ ...base, pending: [withLogin], item: item({ 'q-A': { open: false, answer: 'yes' }, 'q-login': { open: true } }) })).toEqual({ kind: 'envAwaits', qids: ['q-login'] })
  // Same name from two PRs: the later wins, the earlier is superseded.
  const b = { pr: 2, change: change('A', { qid: 'q-B', value: 'w' }) }
  const both = decideEnv({ ...base, pending: [a, b], item: item({ 'q-A': { open: false, answer: 'yes' }, 'q-B': { open: false, answer: 'yes' } }) })
  expect(both).toEqual({ kind: 'clear', apply: [b], record: [{ entry: a, how: 'superseded' }] })
})

test('tidyEnvItems: an old "not yet" the handover still names opens again, a replaced copy and an orphaned apply item close by flow; envRefusal names the current item', () => {
  const item = (id: string, role: 'secret' | 'apply', extra: Partial<Question> = {}): Question => ({
    id, owner: 'env', addressee: 'main', question: 'Q', options: ['done', 'not yet'], default: 'not yet', blocking: true, kind: 'env',
    env: { role, target: 'demo', name: role === 'apply' ? 'REGION' : 'KEY', pr: 3 }, askedAt: 1, state: 'answered', answer: 'not yet', answeredBy: 'main', delivered: true, ...extra,
  })
  const h = (env: Handover['env'], status: Handover['status'] = 'taken') => ({ pr: 3, status, env, at: 5 } as Handover)
  const hs = [h([{ target: 'demo', name: 'KEY', secret: true, why: 'w', qid: 'q4' }, { target: 'demo', name: 'REGION', value: 'eu', why: 'w', qid: 'q1' }])]
  // q2: the old gate's original "not yet"; q4 the copy the handover names. q3: an old apply "not yet", q5 the newer apply item.
  const box = { next: 6, items: [item('q2', 'secret'), item('q3', 'apply'), item('q4', 'secret'), item('q5', 'apply', { state: 'open', answer: undefined, answeredBy: undefined })] }
  expect(currentEnvItem(box.items[0]!, hs, box)).toBe('q4')
  expect(currentEnvItem(box.items[1]!, hs, box)).toBe('q5')
  const tidy = tidyEnvItems(box, hs, 'demo', undefined, 9)
  expect(tidy.items.map(x => [x.id, x.state, x.answeredBy])).toEqual([['q2', 'answered', 'flow'], ['q3', 'answered', 'flow'], ['q4', 'open', 'main'], ['q5', 'open', undefined]])
  // Nothing to do: the same object; another target is left alone.
  expect(tidyEnvItems(tidy, hs, 'demo', undefined, 10)).toBe(tidy)
  expect(tidyEnvItems(box, hs, 'production', undefined, 9)).toBe(box)
  // A handover sent again opens its items before it saves its record: an item newer than the record is left alone.
  const newer = { ...box, items: [{ ...box.items[0]!, askedAt: 6, state: 'open' as const, answer: undefined, answeredBy: undefined }] }
  expect(tidyEnvItems(newer, hs, 'demo', undefined, 9)).toBe(newer)
  expect(envRefusal(newer.items[0]!, hs, newer, undefined)).toBeUndefined()
  // A current "not yet" whose change is settled (here dropped by a release) is closed, not opened again.
  const dropped = tidyEnvItems(box, hs, 'demo', { envDone: [{ pr: 3, name: 'KEY', how: 'dropped', at: 1 }] }, 9)
  expect(dropped.items[2]).toMatchObject({ state: 'answered', answeredBy: 'flow', answer: 'dropped: released without it' })
  // The pane's card offers no other option for a settled change.
  const deploys = { targets: { demo: { envDone: [{ pr: 3, name: 'KEY', how: 'secret' as const, at: 1 }] } } }
  expect(envSettledIn(deploys, box.items[2]!)).toBe(true)
  expect(envSettledIn(deploys, box.items[1]!)).toBe(false)
  expect(envSettledIn(undefined, box.items[2]!)).toBe(false)
  expect(envRefusal(box.items[0]!, hs, box, undefined)?.line).toBe('q2: refused, no handover asks for this item any more; q4 asks for KEY on demo (PR #3) now, answer that one.')
  expect(envRefusal(box.items[2]!, hs, box, undefined)).toBeUndefined()
  // A returned PR: nothing asks for its items.
  expect(envRefusal(box.items[2]!, [h(hs[0]!.env, 'returned')], box, undefined)?.line).toContain('PR #3 was returned or handed over again without KEY')
  expect(envRefusal(box.items[2]!, hs, box, { envDone: [{ pr: 3, name: 'KEY', how: 'secret', at: 1 }] })?.line).toContain('already settled (secret set by user)')
})

test('standing answers skip an env item unless a rule names the env kind', () => {
  const { fresh } = openEnvItems(EMPTY_INBOX, 7, { target: 'demo', name: 'MAIL', value: 'Ops', why: 'sender' }, undefined, 5)
  const q = fresh[0]!
  const plain = parseRules([{ match: 'Set MAIL', answer: 'yes', blocking: true }], 'personal', 'f', [])
  expect(matchRule(plain, q)).toBeUndefined()
  const opted = parseRules([{ match: 'Set MAIL', answer: 'yes', blocking: true, kinds: ['env'] }], 'personal', 'f', [])
  expect(matchRule(opted, q)?.answer).toBe('yes')
  // A rule for deploy items does not answer an env item.
  expect(matchRule(parseRules([{ match: 'Set MAIL', answer: 'yes', blocking: true, kinds: ['deploy'] }], 'personal', 'f', []), q)).toBeUndefined()
})

// ---- plugin half ----

const DIR = '/r/.git/flow'
const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const BODY = '## Verification\nRan:\n- `bun test`: pass\nExercised: ran it\nNot verified:\n- the full check'
const CONFIG = [
  { name: 'demo', deploy: ['./deploy demo'], env_command: 'fly secrets set {name}={value} -a demo' },
  { name: 'production', deploy: ['./deploy prod'], mode: 'confirm' },
]
const OPTS = { deploy_targets: JSON.stringify(CONFIG) }

function world(on: On) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const prompts: string[] = []
  on('prompt.submit', (_, e) => { prompts.push(e.text); return { text: e.text } })
  const agents: AgentInfo[] = [{ id: 'q1', name: 'merge-queue-1', description: 'q', type: 'flow:queue', status: 'running' }]
  const files = new Map<string, string>()
  const log: string[] = []
  const toasts: string[] = []
  on('agent.list', () => ({ value: agents }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'q2' }))
  const pane = { open: false, throws: false }
  on('ui.panes', () => { if (pane.throws) throw new Error('no panes'); return { value: pane.open ? [{ id: 'flow', title: 'Flow', isShown: true, isFocused: false, isPlaced: true }] : [] } })
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
    if (a[0] === 'git' && a[1] === 'rev-list') return ok('1\n')
    if (a[0] === 'git' && a[1] === 'log') return ok('c1 one\n')
    if (a[0] === 'mv') {
      const t = files.get(a[1] ?? '')
      if (t !== undefined) { files.set(a[2] ?? '', t); files.delete(a[1] ?? '') }
    }
    if (a[0] === 'sh' && a[1] === '-c' && String(a[2]).includes('log.jsonl')) log.push(String(a[4]))
    if (a[0] === 'gh' && a[1] === 'pr' && a[2] === 'view') {
      const n = Number(a[3])
      if (a[5] === 'labels,headRefOid') return ok(JSON.stringify({ labels: [], headRefOid: 'abc' }))
      return ok(JSON.stringify({ state: 'OPEN', isDraft: false, headRefOid: 'abc', headRefName: `flow/p${n}`, title: `Title ${n}`, body: BODY, labels: [] }))
    }
    return ok()
  })
  return { pane, agents, files, log, toasts, prompts, flush: async () => { await clock.advance(1); await clock.settle() } }
}

type Env = Record<string, unknown>
const handover = ($: Dollar, pr: number, env?: Env[]) =>
  $.tool.call({ tool: 'mcp__flow__handover', pr, report_to: 'main', ...(env === undefined ? {} : { env }) } as never).then(r => String(r.result))
const queue = ($: Dollar, action: string, pr: number, extra: Record<string, unknown> = {}) =>
  $.tool.call({ tool: 'mcp__flow__queue', action, pr, ...extra } as never).then(r => String(r.result))
const deploy = ($: Dollar, args: Record<string, unknown>) =>
  $.tool.call({ tool: 'mcp__flow__deploy', ...args, agentId: 'q1' } as never).then(r => String(r.result))
const answer = ($: Dollar, args: Record<string, unknown>) =>
  $.tool.call({ tool: 'mcp__flow__answer', ...args } as never).then(r => String(r.result))
const read = (files: Map<string, string>, name: string) => JSON.parse(files.get(`${DIR}/${name}`) ?? '{}') as Record<string, any>
const items = (files: Map<string, string>) => (read(files, 'inbox.json').items ?? []) as Array<Record<string, any>>

const MAIL: Env = { target: 'demo', name: 'MAIL_SENDER', value: 'Ops Team', why: 'sender name' }

test('handover: env is refused for an unknown target, with no targets, and for value plus secret (value not echoed)', { options: OPTS }, async ($, on) => {
  world(on)
  expect(await handover($, 1, [{ target: 'staging', name: 'A', value: 'x', why: 'w' }])).toContain('Configured: demo, production')
  const both = await handover($, 1, [{ target: 'demo', name: 'A', value: 'topsecretvalue', secret: true, why: 'w' }])
  expect(both).toContain('Refused')
  expect(both).not.toContain('topsecretvalue')
})

test('handover without deploy targets refuses a non-empty env', async ($, on) => {
  world(on)
  expect(await handover($, 1, [MAIL])).toContain('Refused')
  expect(await handover($, 1, [])).toContain('Handed over PR #1')
})

test('handover opens one env item per change and login, lists their ids, reuses them when sent again', { options: OPTS }, async ($, on) => {
  const w = world(on)
  const res = await handover($, 3, [MAIL, { target: 'production', name: 'API_KEY', secret: true, why: 'new key', login: 'log in to the cloud CLI' }])
  expect(res).toContain('inbox q1, q2, q3')
  expect(items(w.files).map(i => [i.kind, i.env.role, i.blocking, i.addressee])).toEqual([
    ['env', 'change', true, 'main'], ['env', 'login', true, 'main'], ['env', 'secret', true, 'main'],
  ])
  expect(read(w.files, 'handovers/3.json').env).toHaveLength(2)
  // Sent again after a fix: no duplicates; a change dropped from the list is closed.
  await handover($, 3, [MAIL, { target: 'production', name: 'API_KEY', secret: true, why: 'new key', login: 'log in to the cloud CLI' }])
  expect(items(w.files)).toHaveLength(3)
  await handover($, 3, [MAIL])
  expect(items(w.files)).toHaveLength(3)
  expect(items(w.files).filter(i => i.state === 'open').map(i => i.id)).toEqual(['q1'])
  expect(items(w.files)[2]).toMatchObject({ answeredBy: 'flow' })
  expect((await $.command.run({ command: 'flow', args: 'inbox' } as never).then(r => r.text ?? ''))).toContain('ENV CHANGE')
})

test('gate: a change waits for the user, then the queue gets the quoted command, env-applied is idempotent', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await handover($, 3, [{ target: 'demo', name: 'MAIL_SENDER', value: "O'Brien; rm -rf /", why: 'sender' }])
  // Not taken yet: nothing is pending for the gate.
  expect(await deploy($, { action: 'gate', target: 'demo', sha: 'abc' })).toBe('Go')
  await queue($, 'take', 3)
  expect(await deploy($, { action: 'gate', target: 'demo', sha: 'abc' })).toBe('Awaits env: q1. Skip demo for this batch and go on with the next target.')
  expect(await deploy($, { action: 'list' })).toContain('env pending: MAIL_SENDER (PR #3, value, awaits the user (q1))')
  expect(await queue($, 'list', 3)).not.toBe('')
  expect(await answer($, { answers: [{ id: 'q1', choice: 'yes' }] })).toContain('q1: yes')
  const go = await deploy($, { action: 'gate', target: 'demo', sha: 'abc' })
  expect(go).toContain(`Go, first apply env:\n- MAIL_SENDER: fly secrets set MAIL_SENDER='O'\\''Brien; rm -rf /' -a demo`)
  // Asking again before env-applied gives the same commands.
  expect(await deploy($, { action: 'gate', target: 'demo', sha: 'abc' })).toContain('Go, first apply env:')
  expect(await deploy($, { action: 'env-applied', target: 'demo', names: ['NOPE'] })).toContain('NOPE: not recorded')
  expect(await deploy($, { action: 'env-applied', target: 'demo', names: ['MAIL_SENDER'] })).toContain('MAIL_SENDER: recorded as applied by command')
  expect(await deploy($, { action: 'env-applied', target: 'demo', names: ['MAIL_SENDER'] })).toContain('MAIL_SENDER: already recorded')
  expect(await deploy($, { action: 'gate', target: 'demo', sha: 'abc' })).toBe('Go')
  expect(read(w.files, 'deploys.json').targets.demo.envDone).toEqual([{ pr: 3, name: 'MAIL_SENDER', how: 'command', at: 1_000_000 }])
})

test('gate: a declined change holds the target until release, which drops it', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await handover($, 3, [MAIL])
  await queue($, 'take', 3)
  await answer($, { answers: [{ id: 'q1', choice: 'no' }] })
  const held = await deploy($, { action: 'gate', target: 'demo', sha: 'abc' })
  expect(held).toContain('Held: env change MAIL_SENDER declined')
  expect(await deploy($, { action: 'gate', target: 'demo', sha: 'abc' })).toContain('Held:')
  w.agents.length = 0
  expect(await $.command.run({ command: 'flow', args: 'release demo' } as never).then(r => r.text ?? '')).toContain('Dropped the declined env changes: MAIL_SENDER')
  expect(read(w.files, 'deploys.json').targets.demo.envDone).toMatchObject([{ pr: 3, name: 'MAIL_SENDER', how: 'dropped' }])
  expect(await deploy($, { action: 'gate', target: 'demo', sha: 'abc' })).toBe('Go')
})

test('gate: a target without env_command waits for the user to apply the change and answer done', { options: OPTS }, async ($, on) => {
  const w = world(on)
  // production is confirm and has no env_command; a secret needs no apply item.
  await handover($, 4, [
    { target: 'production', name: 'REGION', value: 'eu', why: 'region' },
    { target: 'production', name: 'API_KEY', secret: true, why: 'key', login: 'log in to the cloud CLI' },
  ])
  await queue($, 'take', 4)
  // q1 REGION, q2 login, q3 secret. Login still open.
  await answer($, { answers: [{ id: 'q1', choice: 'yes' }, { id: 'q3', choice: 'done' }] })
  expect(await deploy($, { action: 'gate', target: 'production', sha: 'abc' })).toContain('Awaits env: q2')
  await answer($, { answers: [{ id: 'q2', choice: 'done' }] })
  // The apply item comes before any deploy approval is asked.
  const asked = await deploy($, { action: 'gate', target: 'production', sha: 'abc' })
  expect(asked).toContain('Awaits env: q4')
  expect(items(w.files)[3]).toMatchObject({ kind: 'env', question: 'Apply REGION=eu on production yourself, answer done', env: { role: 'apply' } })
  expect(items(w.files).some(i => i.kind === 'deploy')).toBe(false)
  expect(await deploy($, { action: 'gate', target: 'production', sha: 'abc' })).toContain('Awaits env: q4')
  expect(items(w.files)).toHaveLength(4)
  await answer($, { answers: [{ id: 'q4', choice: 'done' }] })
  expect(read(w.files, 'deploys.json').targets.production.envDone).toMatchObject([{ name: 'REGION', how: 'user' }])
  // Env is settled; now the confirm approval is asked.
  expect(await deploy($, { action: 'gate', target: 'production', sha: 'abc' })).toContain('Awaits approval: q5')
  await answer($, { answers: [{ id: 'q5', choice: 'deploy' }] })
  expect(await deploy($, { action: 'gate', target: 'production', sha: 'abc' })).toBe('Go')
  expect(read(w.files, 'deploys.json').targets.production.envDone.map((d: any) => [d.name, d.how])).toEqual([['REGION', 'user'], ['API_KEY', 'secret']])
})

test('two PRs changing the same name: the later value is applied, the earlier is superseded', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await handover($, 5, [{ target: 'demo', name: 'MODE', value: 'old', why: 'a' }])
  await handover($, 6, [{ target: 'demo', name: 'MODE', value: 'new', why: 'b' }])
  await queue($, 'take', 5)
  await queue($, 'take', 6)
  await answer($, { answers: [{ id: 'q1', choice: 'yes' }] })
  expect(await deploy($, { action: 'gate', target: 'demo', sha: 'abc' })).toContain('Awaits env: q2')
  await answer($, { answers: [{ id: 'q2', choice: 'yes' }] })
  const go = await deploy($, { action: 'gate', target: 'demo', sha: 'abc' })
  expect(go).toContain("MODE='new'")
  expect(go).not.toContain("MODE='old'")
  expect(read(w.files, 'deploys.json').targets.demo.envDone).toMatchObject([{ pr: 5, name: 'MODE', how: 'superseded' }])
})

test('a returned PR drops its env changes and closes their items', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await handover($, 3, [MAIL])
  await queue($, 'take', 3)
  await queue($, 'back', 3, { reason: 'head moved' })
  expect(items(w.files)[0]).toMatchObject({ state: 'answered', answeredBy: 'flow' })
  expect(await deploy($, { action: 'gate', target: 'demo', sha: 'abc' })).toBe('Go')
})

test('standing answers: only a rule naming env answers an env item; always makes no rule', { options: { ...OPTS, standing_answers: JSON.stringify([{ id: 'r1', match: '^Set MAIL', answer: 'yes', blocking: true }]) } }, async ($, on) => {
  const w = world(on)
  await handover($, 3, [MAIL])
  expect(items(w.files)[0]).toMatchObject({ state: 'open' })
  const res = await answer($, { answers: [{ id: 'q1', choice: 'yes', always: true }] })
  expect(res).toContain('no rule made, an env change is the user\'s call every time')
})

test('standing answers: a rule that names the env kind answers the item at handover', { options: { ...OPTS, standing_answers: JSON.stringify([{ id: 'r1', match: '^Set MAIL', answer: 'yes', blocking: true, kinds: ['env'] }]) } }, async ($, on) => {
  const w = world(on)
  await handover($, 3, [MAIL])
  expect(items(w.files)[0]).toMatchObject({ state: 'answered', answer: 'yes', answeredBy: 'standing answer', rule: 'r1' })
  await queue($, 'take', 3)
  expect(await deploy($, { action: 'gate', target: 'demo', sha: 'abc' })).toContain('Go, first apply env:')
})

test('queue list shows each handover\'s env changes by name, secret or not, with their state', { options: OPTS }, async ($, on) => {
  world(on)
  await handover($, 3, [MAIL, { target: 'production', name: 'API_KEY', secret: true, why: 'key' }])
  const list = await queue($, 'list', 0)
  expect(list).toContain('env: MAIL_SENDER on demo (value): awaits the user (q1); API_KEY on production (secret): awaits the user (q2)')
  expect(list).not.toContain('Ops Team')
})

test('a secret leaves no value anywhere: handover record, inbox, deploys state, log, toasts', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await handover($, 3, [{ target: 'demo', name: 'API_KEY', secret: true, why: 'new key', login: 'log in' }])
  await queue($, 'take', 3)
  await answer($, { answers: [{ id: 'q1', choice: 'done' }, { id: 'q2', choice: 'done' }] })
  expect(await deploy($, { action: 'gate', target: 'demo', sha: 'abc' })).toBe('Go')
  const rec = read(w.files, 'handovers/3.json')
  expect(rec.env).toHaveLength(1)
  for (const text of [JSON.stringify(rec.env), JSON.stringify(items(w.files)), JSON.stringify(read(w.files, 'deploys.json'))]) {
    expect(text).not.toContain('"value"')
  }
  expect(read(w.files, 'deploys.json').targets.demo.envDone).toMatchObject([{ name: 'API_KEY', how: 'secret' }])
  expect(w.log.join('\n')).not.toContain('"value"')
})

test('a non-secret value stays out of the log, the toasts and the notes', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await handover($, 3, [{ target: 'demo', name: 'MAIL_SENDER', value: 'Quiet Sender Name', why: 'sender' }])
  await answer($, { answers: [{ id: 'q1', choice: 'yes' }] })
  expect(w.log.join('\n')).not.toContain('Quiet Sender Name')
  expect(w.toasts.join('\n')).not.toContain('Quiet Sender Name')
  const notes = [...w.files.entries()].filter(([p]) => p.includes('notes')).map(([, t]) => t).join('\n')
  expect(notes).not.toContain('Quiet Sender Name')
  // The inbox item and the handover record hold it: the user needs to see what they approve.
  expect(items(w.files)[0]!.question).toContain('Quiet Sender Name')
})

test('"not yet" is still waiting on the same item, which stays open and takes "done" later; release drops nothing; only "no" holds and is dropped', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await handover($, 3, [
    { target: 'production', name: 'API_KEY', secret: true, why: 'key', login: 'log in' },
    { target: 'production', name: 'REGION', value: 'eu', why: 'region' },
  ])
  await queue($, 'take', 3)
  // q1 login, q2 secret, q3 REGION.
  const res = await answer($, { answers: [{ id: 'q1', choice: 'not yet' }, { id: 'q2', choice: 'not yet' }, { id: 'q3', choice: 'yes' }] })
  expect(res).toContain('q2 stays open')
  expect(items(w.files).filter(i => i.state === 'open').map(i => i.id)).toEqual(['q1', 'q2'])
  expect(items(w.files)[1]).toMatchObject({ state: 'open', answer: 'not yet', answeredBy: 'main', via: 'main' })
  expect(await deploy($, { action: 'gate', target: 'production', sha: 'abc' })).toContain('Awaits env: q2, q1')
  // Asking again opens nothing new.
  expect(await deploy($, { action: 'gate', target: 'production', sha: 'abc' })).toContain('Awaits env: q2, q1')
  expect(items(w.files)).toHaveLength(3)
  expect(await deploy($, { action: 'list' })).toContain('API_KEY (PR #3, secret, not done yet (q2, q1))')
  // The same "not yet" twice changes nothing.
  expect(await answer($, { answers: [{ id: 'q2', choice: 'not yet' }] })).toContain('q2: already "not yet"')
  // Release finds nothing declined and drops nothing.
  expect(await $.command.run({ command: 'flow', args: 'release production' } as never).then(r => r.text ?? '')).toContain('no hold')
  await answer($, { answers: [{ id: 'q1', choice: 'done' }, { id: 'q2', choice: 'done' }] })
  // REGION has no env_command on production: the user applies it; "not yet" there keeps the same item too.
  expect(await deploy($, { action: 'gate', target: 'production', sha: 'abc' })).toContain('Awaits env: q4')
  await answer($, { answers: [{ id: 'q4', choice: 'not yet' }] })
  expect(await deploy($, { action: 'gate', target: 'production', sha: 'abc' })).toContain('Awaits env: q4')
  expect(items(w.files)).toHaveLength(4)
  expect(await answer($, { answers: [{ id: 'q4', choice: 'done' }] })).toContain('q4: done')
  expect(read(w.files, 'deploys.json').targets.production.envDone.map((d: any) => [d.name, d.how])).toEqual([['REGION', 'user']])
  // Done twice: no second record.
  expect(await answer($, { answers: [{ id: 'q4', choice: 'done' }] })).toContain('already settled (applied by user)')
  expect(read(w.files, 'deploys.json').targets.production.envDone).toHaveLength(1)
  // A "no" holds the target and release drops that change only.
  await handover($, 4, [{ target: 'production', name: 'EXTRA', value: 'x', why: 'w' }])
  await queue($, 'take', 4)
  await answer($, { answers: [{ id: 'q5', choice: 'no' }] })
  expect(await deploy($, { action: 'gate', target: 'production', sha: 'abc' })).toContain('Held: env change EXTRA declined')
  expect(await $.command.run({ command: 'flow', args: 'release production' } as never).then(r => r.text ?? '')).toContain('Dropped the declined env changes: EXTRA')
  expect(read(w.files, 'deploys.json').targets.production.envDone.map((d: any) => [d.name, d.how])).toEqual([['REGION', 'user'], ['EXTRA', 'dropped']])
  // The dropped change cannot be answered back to life.
  expect(await answer($, { answers: [{ id: 'q5', choice: 'yes' }] })).toContain('q5: refused, EXTRA on production (PR #4) was dropped by a release; the change is gone. Hand the PR over again')
  expect(items(w.files)[4]).toMatchObject({ answer: 'no' })
})

test('an answered env item takes a later explicit answer and the gate follows it; a default never answers one', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await handover($, 3, [MAIL, { target: 'demo', name: 'API_KEY', secret: true, why: 'key' }])
  await queue($, 'take', 3)
  // q1 MAIL change, q2 secret. defaults: true never answers them, also named in ids.
  const skipped = await answer($, { defaults: true, ids: ['q1', 'q2'] })
  expect(skipped).toContain('q1: answer it explicitly (env change); a default never answers it.')
  expect(skipped).toContain('q2: answer it explicitly (env change)')
  expect(await answer($, { defaults: true })).toContain('q1: answer it explicitly (env change)')
  expect(items(w.files).filter(i => i.state === 'open').map(i => i.id)).toEqual(['q1', 'q2'])
  // "no" then "yes" before a release: the target is no longer held.
  await answer($, { answers: [{ id: 'q1', choice: 'no' }, { id: 'q2', choice: 'done' }] })
  expect(await deploy($, { action: 'gate', target: 'demo', sha: 'abc' })).toContain('Held: env change MAIL_SENDER declined')
  expect(await $.command.run({ command: 'flow', args: 'answer q1 yes' } as never).then(r => r.text ?? '')).toContain('q1: yes')
  expect(items(w.files)[0]).toMatchObject({ state: 'answered', answer: 'yes', via: 'user' })
  // "done" then "not yet" before Go: the secret is open again.
  expect(await answer($, { answers: [{ id: 'q2', choice: 'not yet' }] })).toContain('q2 stays open')
  expect(items(w.files)[1]).toMatchObject({ state: 'open', answer: 'not yet' })
  expect(await deploy($, { action: 'gate', target: 'demo', sha: 'abc' })).toContain('Awaits env: q2')
  await answer($, { answers: [{ id: 'q2', choice: 'done' }] })
  expect(await deploy($, { action: 'gate', target: 'demo', sha: 'abc' })).toContain('Go, first apply env:\n- MAIL_SENDER')
  // The same answer again is a no-op, with how it was given.
  expect(await answer($, { answers: [{ id: 'q1', choice: 'yes' }] })).toContain('q1: already answered ("yes" by the user)')
  // Applied: the change is settled and a later answer says so.
  await deploy($, { action: 'env-applied', target: 'demo', names: ['MAIL_SENDER'] })
  expect(await answer($, { answers: [{ id: 'q1', choice: 'no' }] })).toContain('q1: MAIL_SENDER on demo (PR #3) is already settled (applied by command); this answer changes nothing.')
  expect(items(w.files)[0]).toMatchObject({ answer: 'yes' })
})

// The inbox as the old gate left it, written straight to disk (every inbox change reads the file first).
const editItems = (files: Map<string, string>, fn: (xs: Array<Record<string, any>>) => Array<Record<string, any>>) => {
  const box = read(files, 'inbox.json')
  files.set(`${DIR}/inbox.json`, JSON.stringify({ ...box, next: Math.max(box.next, 10), items: fn(box.items) }))
}

test('old data: a "not yet" the handover still names opens again at the gate; a replaced original is closed and refused', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await handover($, 3, [{ target: 'demo', name: 'API_KEY', secret: true, why: 'key' }])
  await queue($, 'take', 3)
  // Stored by the old code: q1 answered "not yet" and closed.
  editItems(w.files, xs => xs.map(x => (x.id === 'q1' ? { ...x, state: 'answered', answer: 'not yet', answeredBy: 'main' } : x)))
  expect(await deploy($, { action: 'gate', target: 'demo', sha: 'abc' })).toContain('Awaits env: q1')
  expect(items(w.files)[0]).toMatchObject({ state: 'open', answer: 'not yet' })
  expect(await answer($, { answers: [{ id: 'q1', choice: 'done' }] })).toContain('q1: done')
  expect(await deploy($, { action: 'gate', target: 'demo', sha: 'abc' })).toBe('Go')
})

test('old data: the old gate\'s replaced pair (q1 "not yet", the handover on q2) leaves one open item; answering the original is refused', { options: OPTS }, async ($, on) => {
  const w = world(on)
  const KEY = { target: 'demo', name: 'API_KEY', secret: true, why: 'key' }
  await handover($, 3, [KEY])
  editItems(w.files, xs => xs.map(x => (x.id === 'q1' ? { ...x, state: 'answered', answer: 'not yet', answeredBy: 'main' } : x)))
  // Sent again: the answered "not yet" is not kept, so the handover names a fresh q10 (as the old reopen did).
  await handover($, 3, [KEY])
  expect(read(w.files, 'handovers/3.json').env[0].qid).toBe('q10')
  await queue($, 'take', 3)
  expect(await deploy($, { action: 'gate', target: 'demo', sha: 'abc' })).toContain('Awaits env: q10')
  expect(items(w.files).filter(i => i.state === 'open').map(i => i.id)).toEqual(['q10'])
  expect(items(w.files)[0]).toMatchObject({ state: 'answered', answeredBy: 'flow', answer: 'replaced: no handover asks for it any more' })
  expect(await answer($, { answers: [{ id: 'q1', choice: 'done' }] })).toContain('q1: closed by flow')
  expect(await answer($, { answers: [{ id: 'q10', choice: 'done' }] })).toContain('q10: done')
})

test('old data: an orphaned apply item (the old gate opened a second one) is closed, the newest is the one the gate reads; the auto run is not held by it', { options: OPTS }, async ($, on) => {
  const w = world(on)
  // production has no env_command: an approved value needs an apply item.
  await handover($, 4, [{ target: 'production', name: 'REGION', value: 'eu', why: 'region' }])
  await queue($, 'take', 4)
  await answer($, { answers: [{ id: 'q1', choice: 'yes' }] })
  expect(await deploy($, { action: 'gate', target: 'production', sha: 'abc' })).toContain('Awaits env: q2')
  // The old code: q2 answered "not yet", then a second apply item q10 for the same change.
  editItems(w.files, xs => [...xs.map(x => (x.id === 'q2' ? { ...x, state: 'answered', answer: 'not yet', answeredBy: 'main' } : x)), { ...xs[1]!, id: 'q10', askedAt: 2_000_000 }])
  expect(await deploy($, { action: 'gate', target: 'production', sha: 'abc' })).toContain('Awaits env: q10')
  expect(items(w.files).find(i => i.id === 'q2')).toMatchObject({ state: 'answered', answeredBy: 'flow' })
  expect(await answer($, { answers: [{ id: 'q2', choice: 'done' }] })).toContain('q2: closed by flow')
  expect(await answer($, { answers: [{ id: 'q10', choice: 'done' }] })).toContain('q10: done')
  expect(read(w.files, 'deploys.json').targets.production.envDone.map((d: any) => [d.name, d.how])).toEqual([['REGION', 'user']])
})

test('old data: an orphaned apply item still open does not hold the auto run when the newest one is answered', { options: { deploy_targets: JSON.stringify([...CONFIG, { name: 'staging', deploy: ['./deploy staging'] }]) } }, async ($, on) => {
  const w = world(on)
  // staging is auto and has no env_command: an approved value needs an apply item.
  await handover($, 4, [{ target: 'staging', name: 'REGION', value: 'eu', why: 'region' }])
  await queue($, 'take', 4)
  await answer($, { answers: [{ id: 'q1', choice: 'yes' }] })
  expect(await deploy($, { action: 'gate', target: 'staging', sha: 'abc' })).toContain('Awaits env: q2')
  // The old code opened a second apply item q10 while q2 was still open; no gate has tidied them yet.
  editItems(w.files, xs => [...xs, { ...xs[1]!, id: 'q10', askedAt: 2_000_000 }])
  expect(items(w.files).filter(i => i.state === 'open').map(i => i.id)).toEqual(['q2', 'q10'])
  expect(await answer($, { answers: [{ id: 'q10', choice: 'done' }] })).toContain('staging has its env answers')
  expect(read(w.files, 'deploys.json').targets.staging.due).toBe(true)
})

test('a gate between a re-handover opening its items and saving its record leaves the new item open', { options: OPTS }, async ($, on) => {
  const w = world(on)
  const KEY = { target: 'demo', name: 'API_KEY', secret: true, why: 'key' }
  await handover($, 3, [KEY])
  await queue($, 'take', 3)
  editItems(w.files, xs => xs.map(x => (x.id === 'q1' ? { ...x, state: 'answered', answer: 'not yet', answeredBy: 'main' } : x)))
  // The window in handover-run: openEnv has opened q10 (later than the stored record), putHandover has not run yet.
  editItems(w.files, xs => [...xs, { ...xs[0]!, id: 'q10', state: 'open', answer: undefined, answeredBy: undefined, via: undefined, askedAt: 2_000_000 }])
  await deploy($, { action: 'gate', target: 'demo', sha: 'abc' })
  expect(items(w.files).find(i => i.id === 'q10')).toMatchObject({ state: 'open' })
  expect(items(w.files).find(i => i.id === 'q10')?.answeredBy).toBeUndefined()
  // Answering it in the window is not refused either (the replaced-pair test covers the gate once the record names it).
  expect(await answer($, { answers: [{ id: 'q10', choice: 'not yet' }] })).toContain('q10 stays open')
  expect(items(w.files).find(i => i.id === 'q10')).toMatchObject({ state: 'open', answer: 'not yet', via: 'main' })
})

test('old data: a login step left at "not yet" whose change a release dropped is closed, not reopened; the auto run is not held by it', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await handover($, 3, [{ ...MAIL, login: 'log in to the mail admin' }])
  await handover($, 4, [{ target: 'demo', name: 'API_KEY', secret: true, why: 'key' }])
  await queue($, 'take', 3)
  await queue($, 'take', 4)
  // q1 login, q2 MAIL change, q3 secret. MAIL is declined, then dropped by a release.
  await answer($, { answers: [{ id: 'q2', choice: 'no' }] })
  expect(await deploy($, { action: 'gate', target: 'demo', sha: 'abc' })).toContain('Held: env change MAIL_SENDER declined')
  expect(await $.command.run({ command: 'flow', args: 'release demo' } as never).then(r => r.text ?? '')).toContain('Dropped the declined env changes: MAIL_SENDER')
  // The old code left the login step answered "not yet".
  editItems(w.files, xs => xs.map(x => (x.id === 'q1' ? { ...x, state: 'answered', answer: 'not yet', answeredBy: 'main' } : x)))
  expect(await deploy($, { action: 'gate', target: 'demo', sha: 'abc' })).toContain('Awaits env: q3')
  expect(items(w.files)[0]).toMatchObject({ state: 'answered', answeredBy: 'flow', answer: 'dropped: released without it' })
  expect(await answer($, { answers: [{ id: 'q3', choice: 'done' }] })).toContain('demo has its env answers')
})

test('an env item a re-handover replaced is refused, not answered: no "held" reply for a qid the gate does not read', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await handover($, 3, [MAIL])
  await queue($, 'take', 3)
  await answer($, { answers: [{ id: 'q1', choice: 'yes' }] })
  // A new value: q1 is not kept, q2 asks again.
  await handover($, 3, [{ ...MAIL, value: 'Ops 2' }])
  expect(read(w.files, 'handovers/3.json').env[0].qid).toBe('q2')
  const res = await answer($, { answers: [{ id: 'q1', choice: 'no' }] })
  expect(res).toBe('q1: refused, no handover asks for this item any more; q2 asks for MAIL_SENDER on demo (PR #3) now, answer that one.')
  expect(items(w.files)[0]).toMatchObject({ answer: 'yes' })
})

test('an env item closed by flow stays closed', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await handover($, 3, [MAIL, { target: 'demo', name: 'API_KEY', secret: true, why: 'key' }])
  await handover($, 3, [MAIL])
  expect(items(w.files)[1]).toMatchObject({ state: 'answered', answeredBy: 'flow', via: 'flow' })
  expect(await answer($, { answers: [{ id: 'q2', choice: 'done' }] })).toContain('q2: closed by flow ("dropped: the PR was handed over again without it"); it cannot be answered any more.')
})

test('ask_cards on: a handover with env items and the env gate each notify main once with the card instruction', { options: OPTS }, async ($, on) => {
  const w = world(on)
  await handover($, 3, [MAIL])
  await w.flush()
  expect(w.prompts).toHaveLength(1)
  expect(w.prompts[0]).toContain('PR #3 has 1 env item for the user (q1)')
  expect(w.prompts[0]).toContain('AskUserQuestion')
  expect(w.toasts.join('\n')).toContain('PR #3 has 1 env item')
  // Sent again with the same change: the item is not new, so no second notice.
  await handover($, 3, [MAIL])
  await w.flush()
  expect(w.prompts).toHaveLength(1)
  // The gate finds the item already open: nothing new to announce.
  await queue($, 'take', 3)
  await deploy($, { action: 'gate', target: 'demo', sha: 'abc' })
  await w.flush()
  expect(w.prompts).toHaveLength(1)
})

test('ask_cards with the Flow pane open: env items send no notice, the toast stays', { options: OPTS }, async ($, on) => {
  const w = world(on)
  w.pane.open = true
  await handover($, 3, [MAIL])
  await w.flush()
  expect(w.prompts).toEqual([])
  expect(w.toasts.join('\n')).toContain('PR #3 has 1 env item')
})

test('ask_cards off: env items send no notice, the toast stays', { options: { ...OPTS, ask_cards: 'off' } }, async ($, on) => {
  const w = world(on)
  await handover($, 3, [MAIL])
  await queue($, 'take', 3)
  await deploy($, { action: 'gate', target: 'demo', sha: 'abc' })
  await w.flush()
  expect(w.prompts).toEqual([])
  expect(w.toasts.join('\n')).toContain('PR #3 has 1 env item')
})
