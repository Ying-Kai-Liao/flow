import { expect } from 'claude-code/testing'
import { test } from './support'

import { armHandoverRefusal, armHidden, armOfSpawn, armsReport, armsTool, armSpawnRefusal, parseArm } from '../hooks/bestof'
import type { ArmsIo, SpawnFacts } from '../hooks/bestof'
import { selectCleanup, parsePorcelain } from '../hooks/clean'
import type { CleanInputs } from '../hooks/clean'
import { fill, MANAGER_PROMPT, REVIEWER_RULE } from '../hooks/prompts'
import type { Settings } from '../hooks/prompts'
import { routeWorker } from '../hooks/spawn'
import type { SpawnIo } from '../hooks/spawn'
import { settingsOf } from '../hooks/settings'
import { sizeAbReport } from '../hooks/size-ab'
import { sizeDigest } from '../hooks/sizefeedback'
import type { Ledger, LedgerEntry, LogEvent } from '../types'

const USAGE = { input: 1_000_000, write5m: 0, write1h: 0, read: 0, output: 0 }
const row = (name: string, o: Partial<LedgerEntry> = {}): LedgerEntry => ({ role: 'worker', name, manager: 'mgr', branch: `flow/${name.replace(/-\d+$/, '')}`, size: 'normal', models: { 'claude-sonnet-5-5': USAGE }, ...o })
const arm = (group: string, id: string, of = 2) => ({ group, id, of })
const ledgerOf = (rows: LedgerEntry[]): Ledger => Object.fromEntries(rows.map((r, i) => [`id${i}`, r]))
const GROUP: LedgerEntry[] = [row('csv-a', { arm: arm('csv', 'a') }), row('csv-b', { arm: arm('csv', 'b') })]
const ev = (event: LogEvent['event'], o: Partial<LogEvent> = {}): LogEvent => ({ ts: 't', event, owner: 'mgr', ...o })
const PICK = ev('arm-pick', { id: 'csv', pr: 11, branch: 'flow/csv-a', text: 'tests pass' })

const facts = (o: Partial<SpawnFacts> = {}): SpawnFacts => ({ name: 'csv-a', prompt: 'Your name: csv-a\nSize: large - hard\nArm: a of 2\n', bestOfN: 'brief', arms: 2, parentIsManager: true, liveSiblings: [], maxWorkers: 3, ...o })

test('settings: best_of_n defaults off, arms clamp to 2..3', () => {
  expect(settingsOf({}, 'main').bestOfN).toBe('off')
  expect(settingsOf({}, 'main').bestOfNArms).toBe(2)
  expect(settingsOf({ best_of_n: 'auto' }, 'main').bestOfN).toBe('auto')
  expect(settingsOf({ best_of_n: 'always' }, 'main').bestOfN).toBe('off')
  expect(settingsOf({ best_of_n_arms: 1 }, 'main').bestOfNArms).toBe(2)
  expect(settingsOf({ best_of_n_arms: 9 }, 'main').bestOfNArms).toBe(3)
  expect(settingsOf({ best_of_n_arms: 3 }, 'main').bestOfNArms).toBe(3)
})

test('the arm line parses; a non-arm brief has none', () => {
  expect(parseArm('Size: large\nArm: b of 3\n')).toEqual({ id: 'b', of: 3 })
  expect(parseArm('Size: large\nno arm\n')).toBeUndefined()
  expect(parseArm('Arm: d of 3')).toBeUndefined()
})

test('spawn check: a non-arm spawn is never refused; a good arm passes', () => {
  expect(armSpawnRefusal(facts({ prompt: 'Size: large', bestOfN: 'off', parentIsManager: false }))).toBeUndefined()
  expect(armSpawnRefusal(facts())).toBeUndefined()
  expect(armSpawnRefusal(facts({ name: 'csv-a-2' }))).toBeUndefined()
})

test('spawn check: refuses off, too many arms, letter mismatch, N below 2, non-manager and max_workers, each saying what to do', () => {
  expect(armSpawnRefusal(facts({ bestOfN: 'off' }))).toMatch(/best_of_n is off/)
  expect(armSpawnRefusal(facts({ prompt: 'Arm: a of 3' }))).toMatch(/best_of_n_arms allows 2/)
  expect(armSpawnRefusal(facts({ prompt: 'Arm: a of 1' }))).toMatch(/at least 2 arms/)
  expect(armSpawnRefusal(facts({ name: 'csv-b' }))).toMatch(/must be named "<package>-a"/)
  expect(armSpawnRefusal(facts({ name: 'csv-2' }))).toMatch(/letter suffix, never a number/)
  expect(armSpawnRefusal(facts({ prompt: 'Arm: c of 2', name: 'csv-c' }))).toMatch(/does not exist in a best-of-2/)
  expect(armSpawnRefusal(facts({ parentIsManager: false }))).toMatch(/only a manager/)
  expect(armSpawnRefusal(facts({ liveSiblings: ['x', 'y', 'z'] }))).toMatch(/max_workers is 3/)
  expect(armSpawnRefusal(facts({ liveSiblings: ['x', 'y'] }))).toBeUndefined()
})

test('the ledger tag: an arm from its brief, its successor stays in the arm, a plain worker has none', () => {
  const l = ledgerOf(GROUP)
  expect(armOfSpawn('csv-b', 'Arm: b of 2', {})).toEqual(arm('csv', 'b'))
  expect(armOfSpawn('csv-a-2', 'Continue on branch: flow/csv-a', l)).toEqual(arm('csv', 'a'))
  expect(armOfSpawn('csv-a-2', 'Arm: a of 2', {})).toEqual(arm('csv', 'a'))
  expect(armOfSpawn('csv-a-2', 'no arm line', {})).toBeUndefined()
  expect(armOfSpawn('plain-a', 'Size: small', l)).toBeUndefined()
  expect(armOfSpawn('csv-b', 'Arm: a of 2', l)).toBeUndefined()
})

// A fake IO: gh answers from `prs`, the log accumulates what the tool appends.
function fake(o: { rows?: LedgerEntry[]; log?: LogEvent[]; prs?: Record<number, { head: string; state: string }>; live?: string[]; caller?: string; closeFails?: number[] }) {
  const log = [...(o.log ?? [])]
  const calls: string[][] = []
  const prs = o.prs ?? { 11: { head: 'flow/csv-a', state: 'OPEN' }, 12: { head: 'flow/csv-b', state: 'OPEN' } }
  const io: ArmsIo = {
    run: async argv => {
      calls.push(argv)
      if (argv[2] === 'view') { const p = prs[Number(argv[3])]; return p === undefined ? { exitCode: 1, stdout: '', stderr: 'no pr' } : { exitCode: 0, stdout: JSON.stringify({ headRefName: p.head, state: p.state }), stderr: '' } }
      if (argv[2] === 'list') return { exitCode: 0, stdout: JSON.stringify(Object.entries(prs).filter(([, p]) => p.state === 'OPEN').map(([n, p]) => ({ number: Number(n), headRefName: p.head }))), stderr: '' }
      if (argv[2] === 'close') return o.closeFails?.includes(Number(argv[3])) ? { exitCode: 1, stdout: '', stderr: 'denied' } : { exitCode: 0, stdout: '', stderr: '' }
      return { exitCode: 1, stdout: '', stderr: 'unexpected' }
    },
    ledger: async () => ledgerOf(o.rows ?? GROUP),
    log: async () => log,
    appendLog: async e => { log.push({ ts: 't', ...e }) },
    callerName: async id => (id === undefined ? undefined : (o.caller ?? 'mgr')),
    liveNames: async () => o.live ?? [],
  }
  return { io, log, calls }
}

test('pick: closes the other arm PRs with a comment, keeps branches, logs the pick and each loss, names a live loser', async () => {
  const f = fake({ live: ['csv-b', 'unrelated'] })
  const { result } = await armsTool(f.io, { action: 'pick', group: 'csv', pr: 11, reason: 'tests pass, smaller diff' }, 'mgr-id')
  expect(f.calls.filter(c => c[2] === 'close')).toHaveLength(1)
  const close = f.calls.find(c => c[2] === 'close')!
  expect(close[3]).toBe('12')
  expect(close.join(' ')).toContain('arm a (PR #11) won')
  expect(close.join(' ')).toContain('tests pass, smaller diff')
  expect(f.calls.some(c => c.includes('--delete-branch') || c[2] === 'delete')).toBe(false)
  expect(f.log.map(l => [l.event, l.branch])).toEqual([['arm-pick', 'flow/csv-a'], ['arm-lost', 'flow/csv-b']])
  expect(result).toContain('Picked arm a (PR #11)')
  expect(result).toContain('Still running: csv-b')
  expect(result).toContain('TaskStop')
  expect(result).not.toContain('unrelated')
  expect(result).toContain('arm a: won')
  expect(result).toContain('arm b: lost')
})

test('pick: a repeat of the same PR is idempotent, another PR is refused, a PR outside the group is refused', async () => {
  const f = fake({})
  await armsTool(f.io, { action: 'pick', group: 'csv', pr: 11, reason: 'r' }, undefined)
  const again = await armsTool(f.io, { action: 'pick', group: 'csv', pr: 11, reason: 'r' }, undefined)
  expect(again.result).toContain('Already picked arm a')
  expect(f.log.filter(l => l.event === 'arm-pick')).toHaveLength(1)
  expect(f.log.filter(l => l.event === 'arm-lost')).toHaveLength(1)
  expect((await armsTool(f.io, { action: 'pick', group: 'csv', pr: 12, reason: 'r' }, undefined)).result).toMatch(/already picked: PR #11/)
  const g = fake({ prs: { 20: { head: 'flow/other', state: 'OPEN' } } })
  expect((await armsTool(g.io, { action: 'pick', group: 'csv', pr: 20, reason: 'r' }, undefined)).result).toMatch(/no arm of group csv/)
  expect(g.log).toEqual([])
})

test('pick: only the arms\' manager or main; unknown group; missing reason', async () => {
  const f = fake({ caller: 'other' })
  expect((await armsTool(f.io, { action: 'pick', group: 'csv', pr: 11, reason: 'r' }, 'x')).result).toMatch(/belongs to manager mgr/)
  expect((await armsTool(f.io, { action: 'pick', group: 'nope', pr: 11, reason: 'r' }, undefined)).result).toMatch(/no arms recorded/)
  expect((await armsTool(f.io, { action: 'pick', group: 'csv', pr: 11 }, undefined)).result).toMatch(/needs group/)
  expect(f.log).toEqual([])
})

test('pick: a close that fails is reported, a successor of the loser counts as live', async () => {
  const f = fake({ closeFails: [12], live: ['csv-b-2'] })
  const { result } = await armsTool(f.io, { action: 'pick', group: 'csv', pr: 11, reason: 'r' }, undefined)
  expect(result).toContain('Could not close: #12')
  expect(result).toContain('Still running: csv-b-2')
})

test('report: cost per arm, outcome, merged and overhead; a manager sees its groups, main all', () => {
  const rows = [...GROUP, row('csv-b-2', { arm: arm('csv', 'b'), branch: 'flow/csv-b' }), row('x-a', { arm: arm('x', 'a'), manager: 'other' }), row('x-b', { arm: arm('x', 'b'), manager: 'other' })]
  const l = ledgerOf(rows)
  const log = [PICK, ev('done', { branch: 'flow/csv-a' })]
  const text = armsReport(l, log, 'mgr')
  expect(text).toContain('group csv (manager mgr), 2 arms: winner flow/csv-a (PR #11)')
  expect(text).toContain('arm a: won (merged), ~$2.00')
  expect(text).toContain('arm b: lost, ~$4.00')
  expect(text).toContain('group total ~$6.00, winner ~$2.00, overhead ~$4.00')
  expect(text).not.toContain('group x')
  const all = armsReport(l, log, undefined)
  expect(all).toContain('group x (manager other), 2 arms: no winner picked yet')
  expect(all).toContain('arm a: pending')
  expect(armsReport({}, [], undefined)).toMatch(/No best-of-N arms/)
})

test('handover gate: an arm PR needs the pick; the loser never; plain and old data are untouched', () => {
  const l = ledgerOf(GROUP)
  expect(armHandoverRefusal('flow/csv-a', l, [])).toMatch(/mcp__flow__arms action "pick"/)
  expect(armHandoverRefusal('flow/csv-a', l, [PICK])).toBeUndefined()
  expect(armHandoverRefusal('flow/csv-a-2', l, [PICK])).toBeUndefined()
  expect(armHandoverRefusal('flow/csv-b', l, [PICK])).toMatch(/lost group csv to flow\/csv-a/)
  expect(armHandoverRefusal('flow/other', l, [])).toBeUndefined()
  expect(armHandoverRefusal('flow/csv-a', ledgerOf([row('csv-a')]), [])).toBeUndefined()
})

test('unhanded filter: open groups with live arms and picked losers are hidden, a picked winner and a dead unpicked group are not', () => {
  const l = ledgerOf(GROUP)
  const live = (...names: string[]) => (n: string) => names.includes(n)
  expect(armHidden(l, [], live('csv-b'))('flow/csv-a')).toBe(true)
  expect(armHidden(l, [], live())('flow/csv-a')).toBe(false)
  expect(armHidden(l, [PICK], live())('flow/csv-b')).toBe(true)
  expect(armHidden(l, [PICK], live('csv-b'))('flow/csv-a')).toBe(false)
  expect(armHidden(l, [], live('csv-a'))('flow/plain')).toBe(false)
})

test('clean: a pushed loser branch with a closed PR is removed only once an arm-lost event names it', () => {
  const tip = 'c'.repeat(40)
  const BASE = 'b'.repeat(40)
  const wt = (extra: Partial<CleanInputs>): CleanInputs => ({
    main: '/repo', base: 'main', worktrees: parsePorcelain(`worktree /repo\nHEAD ${BASE}\nbranch refs/heads/main\n`), status: {},
    branches: { main: BASE, 'flow/csv-b': tip }, onBase: new Set([BASE]), remote: { main: BASE, 'flow/csv-b': tip },
    prs: [{ number: 12, headRefName: 'flow/csv-b', headRefOid: tip, state: 'CLOSED' }], roster: [], ancestry: new Set(), ...extra,
  })
  expect(selectCleanup(wt({})).remove.branches).toEqual([])
  expect(selectCleanup(wt({ lost: new Set(['flow/csv-b']) })).remove.branches).toEqual(['flow/csv-b'])
  // Unpushed loser work is never removed, a live arm is protected.
  expect(selectCleanup(wt({ lost: new Set(['flow/csv-b']), remote: { main: BASE } })).remove.branches).toEqual([])
  expect(selectCleanup(wt({ lost: new Set(['flow/csv-b']), roster: [{ id: 'w', name: 'csv-b', live: true }] })).remove.branches).toEqual([])
})

test('arms are one package: size A/B counts the group once and no rerun; the digest counts one first attempt', () => {
  const a = { ...row('csv-a', { arm: arm('csv', 'a') }), sizeArm: 'jev' }
  const b = { ...row('csv-b', { arm: arm('csv', 'b') }), sizeArm: 'jev' }
  const r = sizeAbReport({ a, b } as unknown as Ledger, new Set(['flow/csv-b']))
  expect(r.worker.jev.packages).toBe(1)
  expect(r.worker.jev.rerun).toBe(0)
  expect(r.worker.jev.merged).toBe(1)
  expect(Math.round(r.worker.jev.usd)).toBe(4)
  // A successor of an arm is a rerun of that package, as for any worker.
  const s = { ...row('csv-a-2', { arm: arm('csv', 'a') }), sizeArm: 'jev' }
  expect(sizeAbReport({ a, b, s } as unknown as Ledger, new Set()).worker.jev.rerun).toBe(1)
  // Without arm data the same names are separate packages, as today.
  const plain = sizeAbReport({ a: { ...a, arm: undefined }, b: { ...b, arm: undefined } } as unknown as Ledger, new Set())
  expect(plain.worker.jev.packages).toBe(2)

  const others = ['p1', 'p2', 'p3', 'p4'].map(n => row(n))
  const withArms = sizeDigest(ledgerOf([...others, a as LedgerEntry, b as LedgerEntry]), [])
  expect(withArms).toContain('normal: 5 recent')
  expect(sizeDigest(ledgerOf([...others, row('csv-a'), row('csv-b')]), [])).toContain('normal: 6 recent')
})

test('routeWorker: arm c is not escalated because other arms exist; arm a-2 floors on arm a alone', async () => {
  const l = ledgerOf([row('csv-a', { arm: arm('csv', 'a'), size: 'normal' }), row('csv-b', { arm: arm('csv', 'b'), size: 'small' })])
  const io = { loadLedger: async () => undefined, ledger: async () => l } as unknown as SpawnIo
  const models = { small: 'haiku', normal: 'sonnet', large: 'opus' }
  const c = await routeWorker(io, { name: 'csv-c', description: 'x', prompt: 'Size: small - x\nArm: c of 3', subagentType: 'flow:worker' } as never, models)
  expect(c.routed?.size).toBe('small')
  expect(c.routed?.escalated).toBe(false)
  const a2 = await routeWorker(io, { name: 'csv-a-2', description: 'x', prompt: 'Size: small - x\nContinue on branch: flow/csv-a', subagentType: 'flow:worker' } as never, models)
  expect(a2.routed?.size).toBe('large')
})

test('manager prompt: best-of-N text only when the setting is on, filled from the settings', () => {
  const s: Settings = {
    base: 'main', testCommand: 'npm test', fullCheck: '', deployCommand: '', deployTargets: [], stateFile: undefined,
    mergeMethod: 'merge', mergeMode: 'auto', useReviewer: true, maxWorkers: 3, testSlots: 1, workerModel: 'sonnet', managerModel: 'opus', reviewerModel: 'opus',
    language: 'English', bigFiles: [], bigFileLines: 1500, migrationsDir: '', decisionPhrases: [], workerChecks: [], alwaysTests: [],
  }
  const p = (o: Partial<Settings>) => fill(MANAGER_PROMPT.replace('{{REVIEWER_RULE}}', REVIEWER_RULE), { ...s, ...o })
  expect(p({})).not.toContain('mcp__flow__arms')
  expect(p({ bestOfN: 'off' })).not.toContain('Best of N')
  const brief = p({ bestOfN: 'brief', bestOfNArms: 2 })
  expect(brief).toContain('only when your task or the user asks for arms')
  expect(brief).toContain('`<package>-b`')
  expect(brief).not.toContain('`<package>-c`')
  expect(brief).toContain('Arm: <letter> of <N>')
  expect(brief).toContain('mcp__flow__arms')
  expect(brief).toContain('TaskStop')
  expect(brief).not.toContain('{{')
  const auto = p({ bestOfN: 'auto', bestOfNArms: 3 })
  expect(auto).toContain('bug hunt whose root cause is unknown')
  expect(auto).toContain('`<package>-c`')
})
