import { expect } from 'claude-code/testing'
import { test } from './support'
import type { Handover, LogEvent, Session } from '../types'
import { diskItems, gatherLeftovers, resumeInstructions } from '../hooks/resume'
import type { Leftover, ResumeIo } from '../hooks/resume'

type R = { exitCode: number; stdout: string; stderr: string }
const ok = (stdout = ''): R => ({ exitCode: 0, stdout, stderr: '' })
const bad = (stderr: string): R => ({ exitCode: 1, stdout: '', stderr })

type World = {
  open?: unknown[]
  all?: unknown[]
  refs?: string[]
  worktrees?: { path: string; branch?: string; dirty?: boolean; unpushed?: string; head?: string; remoteHas?: boolean }[]
  fail?: Record<string, R | 'throw'>
  agents?: { id: string; status: string; name?: string }[]
  sessions?: Partial<Session>[]
  handovers?: Record<string, Handover>
  events?: LogEvent[]
}

const handover = (pr: number, branch: string, status: Handover['status'], extra: Partial<Handover> = {}): Handover => ({
  pr, title: `title ${pr}`, head: 'abc', branch, reportTo: 'mgr', verified: 'yes.', pending: 'none', afterDeploy: 'none', status, at: 1, ...extra,
})

// A fake of the git/gh calls gatherLeftovers makes, keyed by what the command is.
function fake(w: World = {}) {
  const saved: Handover[] = []
  const merged: Record<string, Handover>[] = []
  const wts = w.worktrees ?? []
  const io: ResumeIo = {
    exec: async argv => {
      const key = argv.slice(0, 3).join(' ')
      const f = w.fail?.[key]
      if (f === 'throw') throw new Error('spawn ENOENT')
      if (f !== undefined) return f
      if (key === 'git fetch origin') return ok()
      if (key === 'gh pr list') return ok(JSON.stringify(argv.includes('open') ? (w.open ?? []) : (w.all ?? [])))
      if (key === 'git for-each-ref --format=%(refname:short)') return ok((w.refs ?? []).join('\n'))
      if (key === 'git worktree list') {
        return ok(wts.map(t => `worktree ${t.path}\nHEAD ${t.head ?? 'h'}\n${t.branch ? `branch refs/heads/${t.branch}` : 'detached'}`).join('\n\n') + '\n')
      }
      if (argv[0] === 'git' && argv[1] === '-C') {
        const t = wts.find(x => x.path === argv[2])!
        const sub = argv.slice(3).join(' ')
        if (sub === 'status --porcelain') return ok(t.dirty ? ' M file.ts\n' : '')
        if (sub === 'rev-parse --abbrev-ref @{u}') return bad('no upstream')
        if (sub.startsWith('log --oneline')) return ok(t.unpushed ?? '')
        if (sub === 'rev-parse HEAD') return ok(t.head ?? 'h')
        if (sub === 'branch -r --contains HEAD') return ok(t.remoteHas ? '  origin/x\n' : '')
      }
      return bad('unexpected ' + argv.join(' '))
    },
    agents: async () => w.agents ?? [],
    sessions: async () => (w.sessions ?? []) as Session[],
    log: async () => w.events ?? [],
    loadHandovers: async () => structuredClone(w.handovers ?? {}),
    saveHandover: async h => { saved.push(h) },
    best: async (_what, fn) => { await fn() },
    mergeHandovers: async all => { merged.push(all) },
  }
  return { io, saved, merged }
}

const pr = (number: number, branch: string, extra: Record<string, unknown> = {}) => ({ number, title: `T${number}`, headRefName: branch, isDraft: false, url: `https://gh/${number}`, body: 'body text', ...extra })

test('an open flow PR is listed with its description; non-flow PRs are not', async () => {
  const { io } = fake({ open: [pr(5, 'flow/a'), pr(6, 'feature/x'), pr(7, 'flow/b', { isDraft: true, body: '  ' })] })
  const g = await gatherLeftovers(io, 'main', new Set())
  expect(g.error).toBeUndefined()
  expect(g.items.map(i => i.key)).toEqual(['flow/a', 'flow/b'])
  expect(g.items[0]!.line).toBe('#5 flow/a: T5 https://gh/5')
  expect(g.items[0]!.detail).toContain('body text')
  expect(g.items[1]!.line).toContain('(draft)')
  expect(g.items[1]!.detail).toContain('(empty)')
})

test('a pushed flow branch without a PR is listed; one with an open or ended PR is not', async () => {
  const { io } = fake({
    open: [pr(5, 'flow/a')],
    all: [{ number: 4, headRefName: 'flow/old', headRefOid: 'x', state: 'CLOSED' }],
    refs: ['origin/flow/a', 'origin/flow/old', 'origin/flow/lonely', 'origin/other'],
  })
  const g = await gatherLeftovers(io, 'main', new Set())
  expect(g.items.map(i => [i.key, i.kind])).toEqual([['flow/a', 'pr'], ['flow/lonely', 'branch']])
  expect(g.items[1]!.line).toBe('flow/lonely (pushed, no PR)')
})

test('a dirty worktree is listed, with its branch or as detached HEAD', async () => {
  const { io } = fake({ worktrees: [
    { path: '/r', branch: 'main' },
    { path: '/r/.claude/worktrees/agent-1', branch: 'flow/w', dirty: true },
    { path: '/r/.claude/worktrees/agent-2', dirty: true },
  ] })
  const g = await gatherLeftovers(io, 'main', new Set())
  expect(g.items.map(i => i.line)).toEqual([
    '/r/.claude/worktrees/agent-1 on flow/w: uncommitted changes',
    '/r/.claude/worktrees/agent-2 on detached HEAD: uncommitted changes',
  ])
})

test('a clean worktree is listed only for unpushed commits that no remote branch holds', async () => {
  const { io } = fake({ worktrees: [
    { path: '/r/.claude/worktrees/agent-1', branch: 'flow/a', unpushed: 'c1 one\nc2 two' },
    { path: '/r/.claude/worktrees/agent-2', branch: 'flow/b', unpushed: '' },
    { path: '/r/.claude/worktrees/agent-3', branch: 'flow/c', unpushed: 'c3 x', remoteHas: true },
    { path: '/r/.claude/worktrees/agent-4' },
  ] })
  const g = await gatherLeftovers(io, 'main', new Set())
  expect(g.items.map(i => i.line)).toEqual(['/r/.claude/worktrees/agent-1 on flow/a: 2 unpushed commit(s)'])
})

test('a worktree of a branch that has an open PR joins the PR item instead of a second one', async () => {
  const { io } = fake({
    open: [pr(5, 'flow/a')],
    worktrees: [{ path: '/r/.claude/worktrees/agent-1', branch: 'flow/a', dirty: true }],
  })
  const g = await gatherLeftovers(io, 'main', new Set())
  expect(g.items).toHaveLength(1)
  expect(g.items[0]!.line).toContain('| worktree /r/.claude/worktrees/agent-1 (uncommitted changes)')
  expect(g.items[0]!.detail).toContain('Its worktree: /r/.claude/worktrees/agent-1')
})

test('worktrees outside .claude/worktrees are ignored', async () => {
  const { io } = fake({ worktrees: [{ path: '/elsewhere/wt', branch: 'flow/a', dirty: true }] })
  expect((await gatherLeftovers(io, 'main', new Set())).items).toEqual([])
})

test('merged and squash-merged work is skipped', async () => {
  const { io } = fake({
    all: [
      { number: 1, headRefName: 'flow/merged', headRefOid: 'aaa', state: 'MERGED' },
      { number: 2, headRefName: 'flow/squashed', headRefOid: 'bbb', state: 'MERGED' },
    ],
    refs: ['origin/flow/merged'],
    worktrees: [
      // branch name closed
      { path: '/r/.claude/worktrees/agent-1', branch: 'flow/merged', dirty: true },
      // renamed branch whose head is the merged PR's head (squash merge deleted the remote branch)
      { path: '/r/.claude/worktrees/agent-2', branch: 'flow/other', unpushed: 'c1 x', head: 'bbb' },
    ],
  })
  const g = await gatherLeftovers(io, 'main', new Set())
  expect(g.items).toEqual([])
  expect(g.skipped).toEqual([])
})

test('a live agent owns its branch and worktree; an ended one does not', async () => {
  const world: World = {
    open: [pr(5, 'flow/live'), pr(6, 'flow/gone'), pr(7, 'flow/sess')],
    worktrees: [{ path: '/r/.claude/worktrees/agent-abc', branch: 'flow/unrenamed', dirty: true }],
    agents: [{ id: 'abc', status: 'running' }, { id: 'z', status: 'idle', name: 'live' }, { id: 'y', status: 'completed', name: 'gone' }],
    sessions: [{ branch: 'flow/sess', status: 'running' }, { branch: 'flow/gone', status: 'exited' }],
  }
  const g = await gatherLeftovers(fake(world).io, 'main', new Set())
  // flow/live: idle agent named live; flow/sess: running session; the worktree: agent id in its path.
  expect(g.items.map(i => i.key)).toEqual(['flow/gone'])
  expect(g.skipped).toEqual([])
})

test('an item already resumed this session is reported as skipped, not listed again', async () => {
  const { io } = fake({ open: [pr(5, 'flow/a'), pr(6, 'flow/b')] })
  const first = await gatherLeftovers(io, 'main', new Set())
  expect(first.items.map(i => i.key)).toEqual(['flow/a', 'flow/b'])
  const second = await gatherLeftovers(io, 'main', new Set(['flow/a']))
  expect(second.items.map(i => i.key)).toEqual(['flow/b'])
  expect(second.skipped.map(i => i.key)).toEqual(['flow/a'])
})

test('a failing or throwing git/gh call gives an error, not a throw', async () => {
  for (const [key, label] of [['git fetch origin', 'git fetch origin'], ['gh pr list', 'gh pr list'], ['git for-each-ref --format=%(refname:short)', 'git for-each-ref']] as const) {
    const g = await gatherLeftovers(fake({ fail: { [key]: bad('boom\nsecond line') } }).io, 'main', new Set())
    expect(g.items).toEqual([])
    expect(g.error).toBe(`Cannot look for unfinished work: ${label} failed: boom`)
  }
  const thrown = await gatherLeftovers(fake({ fail: { 'git fetch origin': 'throw' } }).io, 'main', new Set())
  expect(thrown.error).toContain('spawn ENOENT')
  const silent = await gatherLeftovers(fake({ fail: { 'git fetch origin': bad('') } }).io, 'main', new Set())
  expect(silent.error).toContain('failed: no output')
})

test('when gh fails, unfinished handovers on disk are still listed, minus resumed ones', async () => {
  const handovers = { '8': handover(8, 'flow/h', 'pending'), '9': handover(9, 'flow/r', 'returned', { reason: 'tests' }) }
  const { io } = fake({ fail: { 'gh pr list': bad('no auth') }, handovers })
  const g = await gatherLeftovers(io, 'main', new Set(['flow/r']))
  expect(g.items.map(i => i.key)).toEqual(['flow/h'])
  expect(g.skipped.map(i => i.key)).toEqual(['flow/r'])
  expect(g.error).toContain('GitHub was unavailable: these come from the state dir only.')
})

test('a failing worktree list leaves PR and branch items intact', async () => {
  const { io } = fake({ open: [pr(5, 'flow/a')], fail: { 'git worktree list': bad('nope') } })
  const g = await gatherLeftovers(io, 'main', new Set())
  expect(g.error).toBeUndefined()
  expect(g.items.map(i => i.key)).toEqual(['flow/a'])
})

test('diskItems marks a handover whose PR GitHub shows merged as done and does not list it', async () => {
  const { io, saved, merged } = fake({ handovers: { '3': handover(3, 'flow/m', 'taken'), '4': handover(4, 'flow/n', 'taken') } })
  const items: Leftover[] = []
  await diskItems(io, items, { prs: new Set([3]), branches: new Set() })
  expect(saved.map(h => [h.pr, h.status])).toEqual([[3, 'done']])
  expect(merged[0]!['3']!.status).toBe('done')
  expect(items.map(i => i.key)).toEqual(['flow/n'])
  // by branch too
  const again = fake({ handovers: { '4': handover(4, 'flow/n', 'pending') } })
  const items2: Leftover[] = []
  await diskItems(again.io, items2, { prs: new Set(), branches: new Set(['flow/n']) })
  expect(items2).toEqual([])
  expect(again.saved).toHaveLength(1)
})

test('diskItems skips done handovers without rewriting them, and does nothing with none', async () => {
  const done = fake({ handovers: { '3': handover(3, 'flow/m', 'done') } })
  const items: Leftover[] = []
  await diskItems(done.io, items, undefined)
  expect(items).toEqual([])
  expect(done.saved).toEqual([])
  const none = fake()
  await diskItems(none.io, items, undefined)
  expect(none.merged).toEqual([])
})

test('diskItems adds statuses to the note: awaiting, ready and returned say do not restart', async () => {
  const { io } = fake({ handovers: {
    '1': handover(1, 'flow/a', 'awaiting'),
    '2': handover(2, 'flow/b', 'ready'),
    '3': handover(3, 'flow/c', 'returned', { reason: 'CI red' }),
    '4': handover(4, 'flow/d', 'returned'),
  } })
  const items: Leftover[] = []
  await diskItems(io, items, undefined)
  const by = (b: string) => items.find(i => i.key === b)!
  expect(by('flow/a').detail).toContain("awaits the user's /flow approve 1; do not restart")
  expect(by('flow/b').detail).toContain('awaits the user\'s /flow push')
  expect(by('flow/c').detail).toContain('is returned (CI red)')
  expect(by('flow/d').detail).toContain('is returned (no reason)')
  expect(by('flow/a').line).toBe('#1 flow/a: handover awaiting — title 1')
})

test('diskItems folds a handover into the item of the same branch and picks the owner from the log', async () => {
  const events: LogEvent[] = [
    { ts: 't', event: 'handover', owner: 'late', pr: 5, branch: 'flow/a' },
    { ts: 't', event: 'spawn', owner: 'sole', branch: 'flow/lone' },
  ]
  const { io } = fake({ handovers: { '5': handover(5, 'flow/a', 'pending') }, events })
  const items: Leftover[] = [
    { key: 'flow/a', branch: 'flow/a', kind: 'pr', line: '#5 flow/a: T', detail: 'Branch flow/a' },
    { key: 'flow/lone', branch: 'flow/lone', kind: 'branch', line: 'l', detail: 'd' },
    { key: '/wt', kind: 'worktree', line: 'w', detail: 'd' },
  ]
  await diskItems(io, items, undefined)
  expect(items).toHaveLength(3)
  expect(items[0]!.line).toBe('#5 flow/a: T | handover pending')
  expect(items[0]!.detail).toContain('Handover #5 is pending, reported to mgr')
  expect(items[0]!.owner).toBe('late')
  expect(items[1]!.owner).toBe('sole')
  expect(items[2]!.owner).toBeUndefined()
})

test('a handover owner falls back to its report_to when the log has none', async () => {
  const { io } = fake({ handovers: { '5': handover(5, 'flow/a', 'pending', { reportTo: 'boss' }) } })
  const items: Leftover[] = []
  await diskItems(io, items, undefined)
  expect(items[0]!.owner).toBe('boss')
})

const item = (key: string, owner?: string): Leftover => ({ key, branch: key, kind: 'pr', line: key, detail: `Branch ${key}\nsecond`, ...(owner && { owner }) })

test('resumeInstructions without owners lists every item and states the limit', async () => {
  const text = resumeInstructions([item('flow/a'), item('flow/b')], 3)
  expect(text).toContain('at most 3 at a time')
  expect(text).toContain('Found:\n- Branch flow/a\n  second\n- Branch flow/b\n  second')
  expect(text).not.toContain('Owner ')
  expect(resumeInstructions([], 2)).toContain('at most 2 at a time')
})

test('resumeInstructions groups by owner, quotes notes, and lists ownerless items last', async () => {
  const notes = new Map([['alice', { path: '/n/alice.md', text: 'user said: keep the API' }]])
  const text = resumeInstructions([item('flow/a', 'alice'), item('flow/b', 'bob'), item('flow/c'), item('flow/d', 'alice')], 1, notes)
  expect(text).toContain('at most 1 at a time')
  expect(text).toContain('Owner alice:\n- Branch flow/a\n  second\n- Branch flow/d')
  expect(text).toContain('Notes (/n/alice.md):\nuser said: keep the API')
  expect(text).toContain('Owner bob:')
  expect(text).toContain('Notes: none.')
  expect(text).toContain('No recorded owner:\n- Branch flow/c')
  expect(text).not.toContain('Found:')
  // all owned: no "No recorded owner" block; empty note text counts as none
  const all = resumeInstructions([item('flow/a', 'alice')], 1, new Map([['alice', { path: 'p', text: '' }]]))
  expect(all).not.toContain('No recorded owner')
  expect(all).toContain('Notes: none.')
})
