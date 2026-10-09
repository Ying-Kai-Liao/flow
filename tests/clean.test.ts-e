import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import { ancestryQueries, containedCandidates, dirtyFiles, leftoverLine, parsePorcelain, selectCleanup, sweepText, typeLinks, waitingPaths } from '../hooks/clean'
import type { CleanInputs, PrRow } from '../hooks/clean'

const MAIN = '/repo'
const WT = (n: string) => `/repo/.claude/worktrees/${n}`
const BASE = 'b'.repeat(40)

type Wt = { path: string; head: string; branch?: string; locked?: string; prunable?: boolean }

const porcelain = (wts: Wt[]) => wts.map(w => [
  `worktree ${w.path}`, `HEAD ${w.head}`, w.branch ? `branch refs/heads/${w.branch}` : 'detached',
  ...(w.locked !== undefined ? [w.locked === '' ? 'locked' : `locked ${w.locked}`] : []),
  ...(w.prunable ? ['prunable gitdir file points to non-existent location'] : []),
].join('\n')).join('\n\n') + '\n'

// A repo whose main checkout is on main at BASE, plus the given worktrees and branches.
function inputs(o: {
  wts?: Wt[]; status?: Record<string, string>; branches?: Record<string, string>; onBase?: string[]
  remote?: Record<string, string>; prs?: PrRow[] | undefined; roster?: CleanInputs['roster']; ancestry?: string[]
  deadPids?: number[]; waiting?: string[]; contained?: Record<string, string[]>; ownPid?: number
}): CleanInputs {
  const wts = [{ path: MAIN, head: BASE, branch: 'main' }, ...(o.wts ?? [])]
  const status: Record<string, string> = {}
  for (const w of o.wts ?? []) status[w.path] = o.status?.[w.path] ?? ''
  return {
    main: MAIN, base: 'main', worktrees: parsePorcelain(porcelain(wts)), status,
    branches: { main: BASE, ...o.branches }, onBase: new Set([BASE, ...(o.onBase ?? [])]),
    remote: { main: BASE, ...o.remote }, prs: 'prs' in o ? o.prs : [], roster: o.roster ?? [],
    ancestry: new Set(o.ancestry ?? []), deadPids: new Set(o.deadPids ?? []), waiting: new Set(o.waiting ?? []),
    ...(o.contained && { contained: o.contained }), ...(o.ownPid !== undefined && { ownPid: o.ownPid }),
  }
}

const kept = (s: ReturnType<typeof selectCleanup>, name: string) => s.keep.find(k => k.name === name)

test('parsePorcelain reads branch, detached, locked and prunable entries', () => {
  const ws = parsePorcelain(porcelain([
    { path: MAIN, head: BASE, branch: 'main' },
    { path: WT('a'), head: 'a1', locked: 'claude agent agent-a (pid 7 start x)' },
    { path: WT('b'), head: 'b1', branch: 'flow/b', prunable: true },
  ]))
  expect(ws.map(w => w.path)).toEqual([MAIN, WT('a'), WT('b')])
  expect(ws[1]).toEqual({ path: WT('a'), head: 'a1', locked: 'claude agent agent-a (pid 7 start x)', prunable: false })
  expect(ws[2]!.branch).toBe('flow/b')
  expect(ws[2]!.prunable).toBe(true)
})

test('dirtyFiles ignores only the type-definition links', () => {
  expect(dirtyFiles('?? types\n?? .claude-plugin/types\n')).toEqual([])
  expect(dirtyFiles('?? types/\n?? .claude-plugin/types/\n')).toEqual([])
  expect(dirtyFiles(' M src/a.ts\n?? types\n?? notes.md\n')).toEqual(['src/a.ts', 'notes.md'])
})

test('a locked worktree is kept, unless its lock names an agent that ended', () => {
  const lock = 'claude agent agent-q1 (pid 61445 start Fri Oct  9 06:03:14 2026)'
  const a = selectCleanup(inputs({ wts: [{ path: WT('agent-q1'), head: BASE, locked: lock }] }))
  expect(kept(a, WT('agent-q1'))?.reason).toBe('locked')
  expect(a.remove.worktrees).toEqual([])
  const b = selectCleanup(inputs({ wts: [{ path: WT('agent-q1'), head: BASE, locked: lock }], roster: [{ id: 'q1', live: false }] }))
  expect(b.remove.worktrees).toEqual([WT('agent-q1')])
  expect(b.unlock).toEqual([WT('agent-q1')])
  // Not in this roster, but its process is gone.
  const c = selectCleanup(inputs({ wts: [{ path: WT('agent-q1'), head: BASE, locked: lock }], deadPids: [61445] }))
  expect(c.remove.worktrees).toEqual([WT('agent-q1')])
  // A lock that names no agent stays.
  const d = selectCleanup(inputs({ wts: [{ path: WT('x'), head: BASE, locked: '' }], deadPids: [61445] }))
  expect(kept(d, WT('x'))?.reason).toBe('locked')
})

test('a dirty worktree is kept with its files named; one with only the type links goes', () => {
  const s = selectCleanup(inputs({
    wts: [{ path: WT('dirty'), head: BASE, branch: 'flow/dirty' }, { path: WT('links'), head: BASE, branch: 'flow/links' }],
    status: { [WT('dirty')]: ' M a.ts\n?? b.ts\n?? c.ts\n?? d.ts\n?? types\n', [WT('links')]: '?? types\n?? .claude-plugin/types\n' },
    branches: { 'flow/dirty': BASE, 'flow/links': BASE },
  }))
  expect(kept(s, WT('dirty'))).toEqual({ kind: 'worktree', name: WT('dirty'), reason: 'uncommitted changes: a.ts, b.ts, c.ts and 1 more', needsLook: true })
  expect(s.remove.worktrees).toEqual([WT('links')])
  // The dirty worktree's branch stays checked out there; the removed one's branch goes too.
  expect(kept(s, 'flow/dirty')?.reason).toBe(`checked out in ${WT('dirty')}`)
  expect(s.remove.branches).toEqual(['flow/links'])
})

test('a squash-merged branch goes; one with a local commit after the merge is kept as unpushed', () => {
  const prs = [
    { number: 3, headRefName: 'flow/sq', headRefOid: 's1', state: 'MERGED' },
    { number: 4, headRefName: 'flow/more', headRefOid: 'm1', state: 'MERGED' },
    { number: 5, headRefName: 'flow/older', headRefOid: 'o2', state: 'MERGED' },
  ]
  const base = { branches: { 'flow/sq': 's1', 'flow/more': 'm2', 'flow/older': 'o1' }, prs, ancestry: ['o1 o2'] }
  const s = selectCleanup(inputs(base))
  expect(s.remove.branches).toEqual(['flow/sq', 'flow/older'])
  expect(kept(s, 'flow/more')).toEqual({ kind: 'branch', name: 'flow/more', reason: 'unpushed commits after its PR was merged', needsLook: true })
  // The queries ask exactly what ancestry needs.
  const { ancestry: _, ...rest } = inputs(base)
  expect(ancestryQueries(rest).sort()).toEqual(['m2 m1', 'o1 o2'])
})

test('a branch on the base by ancestry goes; unpushed and closed-PR branches stay', () => {
  const s = selectCleanup(inputs({
    branches: { pth2: 'p1', 'worktree-agent-x': 'u1', 'flow/closed': 'c1', 'flow/pushed': 'q1' },
    onBase: ['p1'],
    remote: { 'flow/closed': 'c1', 'flow/pushed': 'q1' },
    prs: [{ number: 9, headRefName: 'flow/closed', headRefOid: 'c1', state: 'CLOSED' }],
  }))
  expect(s.remove.branches).toEqual(['pth2'])
  expect(kept(s, 'worktree-agent-x')?.reason).toBe('unpushed commits')
  expect(kept(s, 'flow/closed')?.reason).toBe('PR #9 closed without merging, pushed')
  expect(kept(s, 'flow/pushed')?.reason).toBe('pushed, not merged, no PR')
  // The base branch and the main checkout never appear.
  expect(s.keep.some(k => k.name === 'main' || k.name === MAIN)).toBe(false)
  expect(s.remove.worktrees.includes(MAIN)).toBe(false)
})

test('a worktree with a closed PR goes once its head is pushed', () => {
  const s = selectCleanup(inputs({
    wts: [{ path: WT('c'), head: 'c1', branch: 'flow/c' }],
    branches: { 'flow/c': 'c1' }, remote: { 'flow/c': 'c2' }, ancestry: ['c1 origin/flow/c'],
    prs: [{ number: 9, headRefName: 'flow/c', headRefOid: 'c2', state: 'CLOSED' }],
  }))
  expect(s.remove.worktrees).toEqual([WT('c')])
  // The branch rules do not take a closed PR: it is left for a person.
  expect(kept(s, 'flow/c')?.reason).toBe('PR #9 closed without merging, pushed')
})

test('a live agent\'s worktree and branch are kept', () => {
  const s = selectCleanup(inputs({
    wts: [{ path: WT('agent-w1'), head: BASE, branch: 'flow/csv' }, { path: WT('agent-old'), head: BASE, branch: 'flow/cont' }],
    branches: { 'flow/csv': BASE, 'flow/cont': BASE, 'flow/named': BASE },
    roster: [
      { id: 'w1', name: 'csv-x', live: true },
      { id: 'w2', name: 'cont-2', live: true, cwd: WT('agent-old') },
      { id: 'w3', name: 'named', live: true },
    ],
  }))
  expect(kept(s, WT('agent-w1'))?.reason).toBe('in use by csv-x')
  expect(kept(s, WT('agent-old'))?.reason).toBe('in use by cont-2')
  expect(kept(s, 'flow/named')?.reason).toBe('in use by named')
  expect(s.remove).toEqual({ worktrees: [], branches: [] })
  // The main session working inside a linked worktree keeps it.
  const m = selectCleanup(inputs({
    wts: [{ path: WT('mine'), head: BASE }], roster: [{ id: 'main', name: 'the main session', live: true, cwd: `${WT('mine')}/src` }],
  }))
  expect(kept(m, WT('mine'))?.reason).toBe('in use by the main session')
})

test('an open-PR branch is kept, and a worktree waiting for its successor', () => {
  const s = selectCleanup(inputs({
    wts: [{ path: WT('h'), head: BASE, branch: 'flow/h' }],
    branches: { 'flow/open': BASE, 'flow/h': BASE },
    prs: [{ number: 12, headRefName: 'flow/open', headRefOid: BASE, state: 'OPEN' }],
    waiting: [WT('h')],
  }))
  expect(kept(s, 'flow/open')).toEqual({ kind: 'branch', name: 'flow/open', reason: 'PR #12 is open', needsLook: false })
  expect(kept(s, WT('h'))?.reason).toBe('waiting for its successor')
  expect(kept(s, 'flow/h')?.reason).toBe(`checked out in ${WT('h')}`)
})

test('the queue\'s detached worktree at origin/main goes, and a missing directory is pruned', () => {
  const s = selectCleanup(inputs({
    wts: [{ path: WT('agent-q'), head: BASE }, { path: WT('gone'), head: 'g1', branch: 'flow/gone', prunable: true }],
    branches: { 'flow/gone': 'g1' },
    roster: [{ id: 'q', live: false }],
  }))
  expect(s.remove.worktrees).toEqual([WT('agent-q'), WT('gone')])
  // A detached head off the base is kept.
  const t = selectCleanup(inputs({ wts: [{ path: WT('d'), head: 'd1' }] }))
  expect(kept(t, WT('d'))?.reason).toBe('detached HEAD with commits not on the base')
})

test('without gh, only ancestry counts', () => {
  const s = selectCleanup(inputs({ branches: { 'flow/sq': 's1', 'flow/on': BASE }, prs: undefined }))
  expect(s.remove.branches).toEqual(['flow/on'])
  expect(kept(s, 'flow/sq')?.needsLook).toBe(true)
})

test('the listing and the leftover line', () => {
  const s = selectCleanup(inputs({
    wts: [{ path: WT('a'), head: BASE, branch: 'flow/a' }, { path: WT('b'), head: 'x1', branch: 'flow/b' }],
    branches: { 'flow/a': BASE, 'flow/b': 'x1' },
  }))
  const dry = sweepText(s, { applied: false, dryHint: 'Run /flow clean --yes to remove them.' })
  expect(dry).toContain('Would remove 1 worktree:')
  expect(dry).toContain('Kept for a person to decide:')
  expect(dry.split('\n').at(-1)).toBe('Run /flow clean --yes to remove them.')
  expect(sweepText(s, { applied: true })).toContain('Removed 1 branch:')
  expect(leftoverLine({ worktrees: 3, branches: 12, needsLook: 1 })).toBe('3 leftover worktrees · 12 branches · 1 needs a look · /flow clean')
  expect(leftoverLine({ worktrees: 0, branches: 0, needsLook: 0 })).toBeUndefined()
})

test('type links: only the ignored untracked links are listed for deletion, a tracked or other file is not', () => {
  expect(typeLinks('?? types\n?? .claude-plugin/types/\n')).toEqual(['types', '.claude-plugin/types'])
  expect(typeLinks('?? types\n?? notes.md\n M types.ts\n')).toEqual(['types'])
  const s = selectCleanup(inputs({
    wts: [{ path: WT('l'), head: BASE, branch: 'flow/l' }, { path: WT('n'), head: BASE, branch: 'flow/n' }],
    status: { [WT('l')]: '?? types\n?? .claude-plugin/types\n', [WT('n')]: '?? types\n?? scratch.md\n' },
    branches: { 'flow/l': BASE, 'flow/n': BASE },
  }))
  expect(s.remove.worktrees).toEqual([WT('l')])
  expect(s.links).toEqual({ [WT('l')]: ['types', '.claude-plugin/types'] })
  // A worktree with another untracked file keeps its files and its links.
  expect(kept(s, WT('n'))?.reason).toBe('uncommitted changes: scratch.md')
})

test('commits already on the base file for file go when a merged PR of the branch family exists', () => {
  const prs: PrRow[] = [{ number: 7, headRefName: 'flow/x', headRefOid: 'r2', state: 'MERGED' }]
  const wts = [{ path: WT('x'), head: 'w1', branch: 'flow/x-2' }]
  const base = { wts, branches: { 'flow/x-2': 'w1' }, prs }
  // The family's PR merged and the content check passed: dropped, the commits listed.
  const ok = selectCleanup(inputs({ ...base, contained: { w1: ['abc1234 WIP handoff: half done'] } }))
  expect(ok.remove.worktrees).toEqual([WT('x')])
  expect(ok.remove.branches).toEqual(['flow/x-2'])
  expect(ok.dropped).toEqual([
    { kind: 'worktree', name: WT('x'), commits: ['abc1234 WIP handoff: half done'] },
    { kind: 'branch', name: 'flow/x-2', commits: ['abc1234 WIP handoff: half done'] },
  ])
  expect(sweepText(ok, { applied: false })).toContain('    abc1234 WIP handoff: half done')
  // The content check did not pass (no entry): kept as unpushed.
  const no = selectCleanup(inputs(base))
  expect(no.remove).toEqual({ worktrees: [], branches: [] })
  expect(kept(no, WT('x'))?.needsLook).toBe(true)
  // The check passed but no PR of the family merged (open or none): kept.
  const open = selectCleanup(inputs({ ...base, contained: { w1: ['abc1234 x'] }, prs: [{ ...prs[0]!, state: 'OPEN' }] }))
  expect(open.remove).toEqual({ worktrees: [], branches: [] })
  // Which tips need the check: not on the base, with a merged PR in the family.
  const { ancestry: _, ...rest } = inputs(base)
  expect(containedCandidates(rest)).toEqual(['w1'])
  const { ancestry: _2, ...none } = inputs({ ...base, prs: [] })
  expect(containedCandidates(none)).toEqual([])
})

test('a handoff waits for its successor, unless its branch has a merged PR', () => {
  const h = { branch: 'flow/h', worktree: WT('h'), at: 100 }
  expect([...waitingPaths([h], [], [])]).toEqual([WT('h')])
  expect([...waitingPaths([h], [], [{ number: 1, headRefName: 'flow/h', headRefOid: 'a', state: 'OPEN' }])]).toEqual([WT('h')])
  expect([...waitingPaths([h], [], [{ number: 1, headRefName: 'flow/h', headRefOid: 'a', state: 'MERGED' }])]).toEqual([])
  expect([...waitingPaths([{ ...h, takenBy: 'w2' }], [], [])]).toEqual([])
  expect([...waitingPaths([h], [{ branch: 'flow/h', ts: new Date(200).toISOString() }], [])]).toEqual([])
})

test('a lock from this very process goes when its agent is not in the roster; others stay', () => {
  const lock = 'claude agent agent-q1 (pid 33643 start Fri Oct  9 12:54:11 2026)'
  const w = [{ path: WT('agent-q1'), head: BASE, locked: lock }]
  const own = selectCleanup(inputs({ wts: w, ownPid: 33643 }))
  expect(own.remove.worktrees).toEqual([WT('agent-q1')])
  expect(own.unlock).toEqual([WT('agent-q1')])
  // A live agent of this session keeps its lock.
  expect(kept(selectCleanup(inputs({ wts: w, ownPid: 33643, roster: [{ id: 'q1', live: true }] })), WT('agent-q1'))?.reason).toBe('locked')
  // Another process's lock, an unreadable own pid, and a lock naming no agent all stay.
  expect(kept(selectCleanup(inputs({ wts: w, ownPid: 99 })), WT('agent-q1'))?.reason).toBe('locked')
  expect(kept(selectCleanup(inputs({ wts: w })), WT('agent-q1'))?.reason).toBe('locked')
  const anon = [{ path: WT('x'), head: BASE, locked: 'pid 33643' }]
  expect(kept(selectCleanup(inputs({ wts: anon, ownPid: 33643 })), WT('x'))?.reason).toBe('locked')
})

// --- The hooks: /flow clean and mcp__flow__clean against a scripted git ---

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

// A repo with one finished worktree (flow/a, on the base) and one finished branch (flow/b).
function repo(on: On) {
  const ran: string[] = []
  const log: string[] = []
  mock.clock(on, { now: 1_000_000 })
  on('agent.list', () => ({ value: [] }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    const a = e.argv.join(' ')
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (a === 'git worktree list --porcelain') return out(porcelain([{ path: MAIN, head: BASE, branch: 'main' }, { path: WT('a'), head: BASE, branch: 'flow/a' }]))
    if (a.startsWith('git for-each-ref --merged')) return out(`${BASE}\n`)
    if (a.endsWith('refs/heads')) return out(`main ${BASE}\nflow/a ${BASE}\nflow/b ${BASE}\n`)
    if (a.endsWith('refs/remotes/origin')) return out(`origin ${BASE}\norigin/main ${BASE}\n`)
    if (a.startsWith('gh ')) return out('[]')
    if (a.startsWith('git rev-parse')) return out('/repo/.git\n')
    if (e.argv[0] === 'sh') { log.push(String(e.argv[4])); return out('') }
    if (/^git (worktree (remove|unlock|prune)|branch -D)/.test(a)) ran.push(a)
    return out('')
  })
  return { ran, log }
}

const flow = ($: Dollar, args: string) => $.command.run({ command: 'flow', args } as never)

test('/flow clean lists, /flow clean --yes removes and logs', async ($, on) => {
  const r = repo(on)
  const dry = String((await flow($, 'clean')).text)
  expect(dry).toContain(`Would remove 1 worktree:\n  ${WT('a')}`)
  expect(dry).toContain('Would remove 2 branches:')
  expect(dry.split('\n').at(-1)).toBe('Run /flow clean --yes to remove them.')
  expect(r.ran).toEqual([])
  // The dry sweep's counts feed the status line.
  const status = async () => String((await $.tool.call({ tool: 'mcp__flow__status' } as never)).result)
  expect(await status()).toContain('1 leftover worktree · 2 branches · /flow clean')
  const done = String((await flow($, 'clean --yes')).text)
  expect(done).toContain('Removed 1 worktree:')
  expect(r.ran).toEqual([`git worktree remove ${WT('a')}`, 'git worktree prune', 'git branch -D flow/a', 'git branch -D flow/b'])
  expect(r.log.map(l => JSON.parse(l).event)).toEqual(['clean'])
  expect(await status()).not.toContain('leftover')
})

test('mcp__flow__clean runs dry by default and removes with apply', async ($, on) => {
  const r = repo(on)
  expect(String((await $.tool.call({ tool: 'mcp__flow__clean', agentId: 'm1' } as never)).result)).toContain('Would remove')
  expect(r.ran).toEqual([])
  expect(String((await $.tool.call({ tool: 'mcp__flow__clean', apply: true, agentId: 'm1' } as never)).result)).toContain('Removed')
  expect(r.ran.length).toBe(4)
})

test('with cleanup off, the tool answers so and runs dry', { options: { cleanup: 'off' } }, async ($, on) => {
  const r = repo(on)
  const res = String((await $.tool.call({ tool: 'mcp__flow__clean', apply: true, agentId: 'm1' } as never)).result)
  expect(res).toContain('Cleanup is off')
  expect(res).toContain('Would remove')
  expect(r.ran).toEqual([])
})

// A scripted repo for the type-link order: one finished worktree with untracked links.
function linkRepo(on: On, o: { real?: boolean; removeFails?: boolean }) {
  const ran: string[] = []
  mock.clock(on, { now: 1_000_000 })
  on('agent.list', () => ({ value: [] }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    const a = e.argv.join(' ')
    const out = (stdout: string, exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    if (a === 'git worktree list --porcelain') return out(porcelain([{ path: MAIN, head: BASE, branch: 'main' }, { path: WT('a'), head: BASE, branch: 'flow/a' }]))
    if (a.startsWith('git for-each-ref --merged')) return out(`${BASE}\n`)
    if (a.endsWith('refs/heads')) return out(`main ${BASE}\nflow/a ${BASE}\n`)
    if (a.endsWith('refs/remotes/origin')) return out(`origin/main ${BASE}\n`)
    if (a.startsWith('gh ')) return out('[]')
    if (a.endsWith('status --porcelain')) return out('?? types\n?? .claude-plugin/types\n')
    if (e.argv[0] === 'test') { ran.push(a); return out('', o.real && a.endsWith('/.claude-plugin/types') ? 1 : 0) }
    if (e.argv[0] === 'rm') { ran.push(a); return out('') }
    if (/^git (worktree (remove|unlock|prune)|branch -D)/.test(a)) {
      ran.push(a)
      if (o.removeFails && a.startsWith('git worktree remove')) return out('', 128, "fatal: '/x' contains modified or untracked files")
    }
    return out('')
  })
  return ran
}

test('sweep unlinks the type links before git worktree remove, and never a real directory', async ($, on) => {
  const ran = linkRepo(on, { real: true })
  await flow($, 'clean --yes')
  const t = `${WT('a')}/types`
  const c = `${WT('a')}/.claude-plugin/types`
  expect(ran).toEqual([
    `test -L ${t}`, `rm -f -- ${t}`, `test -L ${c}`,
    `git worktree remove ${WT('a')}`, 'git worktree prune', 'git branch -D flow/a',
  ])
})

test('a remove that fails after the links went is reported as kept, and its branch stays', async ($, on) => {
  const ran = linkRepo(on, { removeFails: true })
  const text = String((await flow($, 'clean --yes')).text)
  expect(ran.findIndex(r => r.startsWith('rm ')) < ran.findIndex(r => r.startsWith('git worktree remove'))).toBe(true)
  expect(text).toContain('Removed nothing.')
  expect(text).toContain('contains modified or untracked files')
  expect(ran.some(r => r.startsWith('git branch -D'))).toBe(false)
})
