import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity, AgentRow, Handover, OpenPr, PrCache } from '../types'
import {
  fill, MANAGER_PROMPT, NO_QUEUE_RULE, QUEUE_PROMPT, QUEUE_RULE, WORKER_PROMPT,
} from './prompts'
import type { Settings } from './prompts'

// The orca-flow pattern inside one Claude Code session. The main session is the super manager
// (the `dispatch` skill); it starts `flow:manager` agents, which start
// `flow:worker` agents in worktrees of their own and hand approved PRs to the
// `flow:queue` agent through this plugin's tools. The pane in main shows the tree.

const PANE = 'flow'
const POLL_MS = 3000
const LOG_MAX = 40
const MANAGER = 'flow:manager'
const WORKER = 'flow:worker'
const QUEUE = 'flow:queue'
const ENDED = new Set(['completed', 'failed', 'killed'])
const LIVE = new Set(['pending', 'running', 'waiting'])
// Display order: what may need a person first, finished agents last.
const ORDER = ['waiting', 'idle', 'running', 'pending', 'failed', 'killed', 'completed']
const GLYPH: Record<string, string> = {
  pending: '○', running: '●', waiting: '◐', idle: '◌', completed: '✓', failed: '✗', killed: '■',
}
const COLOR: Record<string, string> = {
  running: 'suggestion', waiting: 'warning', idle: 'warning', completed: 'success', failed: 'error', killed: 'error',
}
const ROLE: Record<string, string> = { [MANAGER]: 'manager', [WORKER]: 'worker', [QUEUE]: 'queue' }
const ROOT_GLYPH = '◆'
const HANDOVER_GLYPH: Record<Handover['status'], string> = {
  pending: '…', taken: '●', done: '✓', returned: '↩',
}

const roster = atom({ plugin: 'flow', key: 'roster' } as const, [] as AgentRow[])
const activity = atom({ plugin: 'flow', key: 'activity' } as const, {} as Record<string, Activity>)
const selected = atom({ plugin: 'flow', key: 'selected' } as const, null as string | null)
const now = atom({ plugin: 'flow', key: 'now' } as const, 0)
const handovers = atom({ plugin: 'flow', key: 'handovers' } as const, {} as Record<string, Handover>)
const queueRuns = atom({ plugin: 'flow', key: 'queueRuns' } as const, 0)
// The open PRs gh listed last, so the 3 s refresh never calls gh itself.
const prCache = atom({ plugin: 'flow', key: 'prCache' } as const, { prs: [], fetchedAt: 0 } as PrCache)

const PR_POLL_MS = 5 * 60_000
const PR_MIN_GAP_MS = 60_000
// A worker that just ended: its manager is probably reviewing the PR.
const GRACE_MS = 20 * 60_000
// Set by register(); refresh() and the pane flag nothing when there is no merge queue.
let queueOn = true

export type Unhanded = { pr: number; title: string; branch: string; note: string }

// Open flow/* PRs that nobody handed to the merge queue and nobody is working on any more.
// A draft is a WIP handoff, a pending/taken/done handover is in hand, a returned one needs a
// manager again. The worker is the agent named like the branch, or its continuation (-2, -3).
export function unhandedPrs(
  prs: OpenPr[], handovers: Record<string, Handover>, roster: AgentRow[],
  activity: Record<string, Activity>, t: number, graceMs = GRACE_MS,
): Unhanded[] {
  const out: Unhanded[] = []
  for (const p of prs) {
    if (p.isDraft || !p.headRefName.startsWith('flow/')) continue
    const h = handovers[String(p.number)]
    if (h !== undefined && h.status !== 'returned') continue
    const slug = p.headRefName.slice('flow/'.length)
    const mine = roster.filter(a => a.name === slug || (a.name?.startsWith(`${slug}-`) === true && /^\d+$/.test(a.name.slice(slug.length + 1))))
    if (mine.some(a => !ENDED.has(a.status))) continue
    const endedAt = Math.max(...mine.map(a => activity[a.id]?.endedAt ?? activity[a.id]?.lastAt ?? 0))
    if (mine.length > 0 && endedAt > 0 && t - endedAt < graceMs) continue
    const last = mine.length > 0 ? mine.reduce((x, y) => (activity[y.id]?.endedAt ?? 0) >= (activity[x.id]?.endedAt ?? 0) ? y : x) : undefined
    const note = h !== undefined ? `returned: ${h.reason ?? ''}`
      : last === undefined ? 'no agent in this session'
        : `no handover, worker ${labelOf(last)} ended${endedAt > 0 ? ` ${ago(t - endedAt)} ago` : ''}`
    out.push({ pr: p.number, title: p.title, branch: p.headRefName, note })
  }
  return out
}

const unhandedLine = (u: Unhanded): string => `#${u.pr} ${u.title} (${u.branch}) — ${u.note}`

async function currentUnhanded($: EngineInterface): Promise<Unhanded[]> {
  if (!queueOn) return []
  const [cache, hs, rows, acts, t] = await Promise.all([
    read($, prCache), read($, handovers), read($, roster), read($, activity), $.clock.now(),
  ])
  return unhandedPrs(cache.prs, hs, rows, acts, t)
}

// One line for a tool call: the tool and its most telling argument.
function describeCall(e: Record<string, unknown>): string {
  const tool = String(e.tool ?? '?').replace(/^mcp__flow__/, '')
  const arg = [e.file_path, e.command, e.pattern, e.path, e.url, e.description, e.action, e.prompt]
    .find(v => typeof v === 'string' && v.length > 0) as string | undefined
  // A command is its first line, cut at a heredoc: its body is code, not news.
  const text = arg === undefined ? '' : (e.command === arg ? arg.split('\n')[0]!.replace(/<<.*$/, '') : arg)
  const short = text === '' ? '' : ' ' + text.replace(/\s+/g, ' ').trim().slice(0, 90)
  return tool + short
}

const base = (path: unknown): string => String(path ?? '').split('/').pop() ?? ''

// What a call is, in a few plain words for a card: never a command's body or a prompt.
export function summarizeCall(e: Record<string, unknown>): string {
  const tool = String(e.tool ?? '?').replace(/^mcp__flow__/, '')
  const file = base(e.file_path)
  switch (tool) {
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return file ? `editing ${file}` : 'editing'
    case 'Write': return file ? `writing ${file}` : 'writing'
    case 'Read': return file ? `reading ${file}` : 'reading'
    case 'Grep': case 'Glob': return 'searching'
    case 'Agent': {
      const role = String(e.subagent_type ?? e.subagentType ?? '').replace(/^flow:/, '')
      const name = String(e.name ?? '')
      return ['started', role === 'manager' || role === 'worker' ? role : 'agent', name].filter(Boolean).join(' ')
    }
    case 'Bash': {
      const cmd = String(e.command ?? '').split('\n')[0]!.trim()
      // git and gh first: a commit message may say "test".
      if (/^git\s+\S+/.test(cmd)) return 'git ' + cmd.split(/\s+/)[1]
      if (/^gh\s+pr\b/.test(cmd)) return 'gh pr ' + (cmd.split(/\s+/)[2] ?? '')
      if (/\b(tsc|test|vitest|jest|pytest)\b/.test(cmd)) return 'running tests'
      return 'running a command'
    }
    default: return tool
  }
}

// Running time as the native subagent row has it: 12s, 1m 43s, 1h 5m.
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

// "↓ 84.0k tokens": the context the agent has taken in, one decimal like the native row.
export function tokensDown(n: number): string {
  return `↓ ${n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n} tokens`
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60}m`
}

function labelOf(a: AgentRow): string {
  return a.name ?? a.description ?? a.id.slice(0, 8)
}

function asksQuestion(answer: string | undefined): boolean {
  const last = (answer ?? '').trim().split('\n').pop() ?? ''
  return /[?？][*_`'")\s]*$/.test(last)
}

const DEFAULT_WINDOW = 200_000
const METER_CELLS = 12
const CARD_ROWS = 5
const DANGER_PERCENT = 90

// A subagent reports no window of its own: borrow the main session's when it runs the same
// model, else 200k, or 1M for a `[1m]` model id.
function windowOf(model: string, mainModel: string | undefined, mainWindow: number | undefined): number {
  if (mainWindow !== undefined && model === mainModel) return mainWindow
  return model.includes('[1m]') ? 1_000_000 : DEFAULT_WINDOW
}

function tokensLabel(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

// The bar with a marker cell at the warn threshold, so how close an agent is stays readable.
function cells(percent: number, warn: number): { ch: string; kind: 'mark' | 'fill' | 'empty' }[] {
  const filled = Math.round(Math.min(100, percent) / 100 * METER_CELLS)
  const mark = Math.min(METER_CELLS - 1, Math.floor(warn / 100 * METER_CELLS))
  return Array.from({ length: METER_CELLS }, (_, i) =>
    i === mark ? { ch: '│', kind: 'mark' } : i < filled ? { ch: '█', kind: 'fill' } : { ch: '░', kind: 'empty' })
}

function meterColor(percent: number, warn: number): string | undefined {
  return percent >= DANGER_PERCENT && percent >= warn ? 'error' : percent >= warn ? 'warning' : undefined
}

function rank(status: string): number {
  const i = ORDER.indexOf(status)
  return i === -1 ? ORDER.length : i
}

// The pane's context meter marks this percent; the rest of the settings go into the prompts.
function settingsOf(options: Record<string, unknown>, base: string): Settings & { contextWarn: number; handoff: boolean } {
  const str = (k: string, d: string) => (typeof options[k] === 'string' && options[k] !== '' ? String(options[k]) : d)
  const num = (k: string, d: number) => (typeof options[k] === 'number' ? Number(options[k]) : d)
  return {
    contextWarn: Math.min(100, Math.max(1, Math.round(num('context_warn_percent', 40)))),
    handoff: options.handoff !== false,
    base: str('base_branch', base),
    testCommand: str('test_command', ''),
    fullCheck: str('full_check_command', ''),
    deployCommand: str('deploy_command', ''),
    mergeMethod: str('merge_method', 'squash'),
    useQueue: options.merge_queue !== false,
    maxWorkers: num('max_workers', 3),
    workerModel: str('worker_model', 'sonnet'),
  }
}

// The roster as the board shows it: every agent of the session, with its role.
async function refresh($: EngineInterface): Promise<AgentRow[]> {
  const [list, t, before, acts] = await Promise.all([
    $.agent.list(), $.clock.now(), read($, roster), read($, activity),
  ])
  const rows: AgentRow[] = list.map(a => ({
    id: a.id, name: a.name, description: a.description, type: a.type,
    status: a.status, parentId: a.parentId,
  }))
  const was = new Map(before.map(a => [a.id, a.status]))
  const ended: string[] = []
  for (const a of rows) {
    const prev = was.get(a.id)
    if (prev === undefined || prev === a.status || ENDED.has(prev)) continue
    if (ENDED.has(a.status) && acts[a.id] !== undefined) ended.push(a.id)
    if (ENDED.has(a.status) || a.status === 'idle') {
      const asks = asksQuestion(acts[a.id]?.answer)
      const role = ROLE[a.type] ? `${ROLE[a.type]} ` : ''
      void $.ui.toast(`${role}${labelOf(a)}: ${asks ? 'asks a question' : a.status === 'idle' ? 'finished its turn' : a.status}`)
    }
  }
  if (ended.length > 0) {
    await update($, activity, all => {
      const next = { ...all }
      for (const id of ended) if (next[id] !== undefined && next[id]!.endedAt === undefined) next[id] = { ...next[id]!, endedAt: t }
      return next
    })
  }
  if (JSON.stringify(rows) !== JSON.stringify(before)) await update($, roster, () => rows)
  await update($, now, () => t)

  const hs = Object.values(await read($, handovers))
  const live = rows.filter(a => !ENDED.has(a.status))
  const count = (type: string) => live.filter(a => a.type === type).length
  const queued = hs.filter(h => h.status === 'pending' || h.status === 'taken').length
  const parts = [
    count(MANAGER) && `${count(MANAGER)} managers`,
    count(WORKER) && `${count(WORKER)} workers`,
    queued && `queue: ${queued} PR${queued > 1 ? 's' : ''}`,
  ].filter(Boolean)
  const unhanded = (await currentUnhanded($)).length
  if (unhanded) parts.push(`${unhanded} unhanded`)
  $.ui.status(rows.length === 0 && hs.length === 0 && !unhanded ? undefined
    : `flow: ${parts.length ? parts.join(' · ') : `${live.length} live`} · /flow`)
  return rows
}

async function openPane($: EngineInterface): Promise<void> {
  const r = await $.ui.open({ id: PANE, title: 'Flow' })
  if (!r.isPlaced) void $.ui.toast('flow is running agents: type /flow to watch them')
}

// Starts a merge queue unless one is live. The queue drains every pending handover, then ends;
// the next handover, or a queue that ended with work left, starts a fresh one.
async function ensureQueue($: EngineInterface): Promise<string> {
  const list = await $.agent.list()
  if (list.some(a => a.type === QUEUE && LIVE.has(a.status))) {
    return 'The running merge queue picks it up at its next list.'
  }
  const pending = Object.values(await read($, handovers)).filter(h => h.status === 'pending')
  if (pending.length === 0) return 'Nothing pending.'
  const n = (await read($, queueRuns)) + 1
  await update($, queueRuns, () => n)
  const started = await $.agent.spawn({
    subagentType: QUEUE,
    name: `merge-queue-${n}`,
    description: 'merge queue',
    prompt: `Pending handovers: ${pending.map(h => `#${h.pr}`).join(', ')}. Start with mcp__flow__queue action "list".`,
  })
  if (started.deny !== undefined) return `Could not start a merge queue: ${started.deny}`
  return `Started merge queue merge-queue-${n}.`
}

function handoverLine(h: Handover): string {
  const tail = h.status === 'done' ? ` ${h.sha ?? ''} ${h.report ?? ''}`
    : h.status === 'returned' ? ` returned: ${h.reason ?? ''}` : ''
  return `#${h.pr} ${h.status} (${h.branch} @ ${h.head.slice(0, 8)}, from ${h.reportTo})${tail} — ${h.title}`
}

const OWNED = new Set([...LIVE, 'idle'])

// Unfinished flow work left behind by an earlier session, as `/flow resume` lists it.
type Leftover = { key: string; branch?: string; kind: 'pr' | 'branch' | 'worktree'; line: string; detail: string }

type Gathered = { items: Leftover[]; skipped: Leftover[]; error?: string }

// Finds what a restart leaves behind: flow/* PRs and pushed branches, and worktrees with
// uncommitted or unpushed work. Any git or gh failure becomes one line, never a throw.
async function gatherLeftovers($: EngineInterface, base: string, resumed: Set<string>): Promise<Gathered> {
  const run = async (argv: string[]) => {
    try {
      return await $.process.run(argv, { timeoutMs: 60_000 })
    } catch (err) {
      return { exitCode: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
    }
  }
  const fail = (what: string, r: { stderr: string }): Gathered =>
    ({ items: [], skipped: [], error: `Cannot look for unfinished work: ${what} failed: ${r.stderr.trim().split('\n')[0]?.slice(0, 200) || 'no output'}` })

  const fetched = await run(['git', 'fetch', 'origin', '--prune'])
  if (fetched.exitCode !== 0) return fail('git fetch origin', fetched)
  const open = await run(['gh', 'pr', 'list', '--state', 'open', '--json', 'number,title,headRefName,isDraft,url,body', '--limit', '100'])
  if (open.exitCode !== 0) return fail('gh pr list', open)
  const all = await run(['gh', 'pr', 'list', '--state', 'all', '--json', 'headRefName,headRefOid,state', '--limit', '200'])
  if (all.exitCode !== 0) return fail('gh pr list', all)
  const refs = await run(['git', 'for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin/flow/'])
  if (refs.exitCode !== 0) return fail('git for-each-ref', refs)

  type Pr = { number: number; title: string; headRefName: string; isDraft: boolean; url: string; body: string }
  const prs = (JSON.parse(open.stdout || '[]') as Pr[]).filter(p => p.headRefName.startsWith('flow/'))
  const ended = (JSON.parse(all.stdout || '[]') as { headRefName: string; headRefOid?: string; state: string }[])
    .filter(p => p.state !== 'OPEN')
  const closed = new Set(ended.map(p => p.headRefName))
  // A squash-merged branch is deleted on the remote, so its worktree looks unpushed: match by head too.
  const endedHeads = new Set(ended.map(p => p.headRefOid).filter(Boolean))
  const withPr = new Set(prs.map(p => p.headRefName))
  const branches = refs.stdout.split('\n').map(l => l.trim().replace(/^origin\//, ''))
    .filter(b => b.startsWith('flow/') && !withPr.has(b) && !closed.has(b))

  // A live agent named like the branch owns it.
  const liveAgents = (await $.agent.list()).filter(a => OWNED.has(a.status))
  const owners = new Set(liveAgents.filter(a => a.name !== undefined).map(a => `flow/${a.name}`))
  // A worktree path ends in agent-<agentId>: that covers a worker that has not renamed its branch, and the queue.
  const liveIds = new Set(liveAgents.map(a => `agent-${a.id}`))

  const items: Leftover[] = []
  for (const p of prs) {
    items.push({
      key: p.headRefName, kind: 'pr',
      line: `#${p.number} ${p.headRefName}${p.isDraft ? ' (draft)' : ''}: ${p.title} ${p.url}`,
      detail: `Branch ${p.headRefName}, PR #${p.number} ${p.url}${p.isDraft ? ' (draft)' : ''}, title "${p.title}".\nPR description:\n${p.body.trim() || '(empty)'}`,
    })
  }
  for (const b of branches) {
    items.push({ key: b, kind: 'branch', line: `${b} (pushed, no PR)`, detail: `Branch ${b}, pushed, no PR yet.` })
  }

  const wt = await run(['git', 'worktree', 'list', '--porcelain'])
  if (wt.exitCode === 0) {
    for (const block of wt.stdout.split('\n\n')) {
      const path = /^worktree (.+)$/m.exec(block)?.[1]
      if (path === undefined || !path.includes('/.claude/worktrees/')) continue
      const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]
      if (liveIds.has(path.split('/').pop() ?? '') || (branch !== undefined && closed.has(branch))) continue
      const dirty = (await run(['git', '-C', path, 'status', '--porcelain'])).stdout.trim() !== ''
      if (branch === undefined && !dirty) continue
      let unpushed = ''
      if (!dirty) {
        const up = await run(['git', '-C', path, 'rev-parse', '--abbrev-ref', '@{u}'])
        unpushed = (await run(up.exitCode === 0
          ? ['git', '-C', path, 'log', '--oneline', '@{u}..']
          : ['git', '-C', path, 'log', '--oneline', `origin/${base}..HEAD`])).stdout.trim()
      }
      if (!dirty && unpushed === '') continue
      const head = (await run(['git', '-C', path, 'rev-parse', 'HEAD'])).stdout.trim()
      if (endedHeads.has(head)) continue
      if (!dirty && (await run(['git', '-C', path, 'branch', '-r', '--contains', 'HEAD'])).stdout.trim() !== '') continue
      const what = dirty ? 'uncommitted changes' : `${unpushed.split('\n').length} unpushed commit(s)`
      const mate = branch === undefined ? undefined : items.find(i => i.key === branch)
      if (mate !== undefined) {
        mate.line += ` | worktree ${path} (${what})`
        mate.detail += `\nIts worktree: ${path} (${what}).`
        continue
      }
      items.push({
        key: path, branch, kind: 'worktree', line: `${path} on ${branch ?? 'detached HEAD'}: ${what}`,
        detail: `Worktree ${path}, branch ${branch ?? 'detached HEAD'}: ${what}.`,
      })
    }
  }

  const live = (i: Leftover) => owners.has(i.branch ?? i.key)
  return {
    items: items.filter(i => !live(i) && !resumed.has(i.key)),
    skipped: items.filter(i => !live(i) && resumed.has(i.key)),
  }
}

function resumeInstructions(items: Leftover[]): string {
  return [
    'The user ran /flow resume. Unfinished flow work was found (below). Start flow managers for it with the Agent tool, without asking:',
    '- One flow:manager per task, named resume-<slug>, run_in_background true, at most 3 at a time; start the rest as each finishes. Items whose branch names share a manager prefix (flow/csv-export-endpoint and flow/csv-export-button) are one task.',
    '- Each manager\'s prompt carries, for every item of its task: the branch, the PR number and URL, the PR description (including any ## Handoff section), and for a worktree its path. It carries the work on from there and must not redo work already merged into the base branch.',
    '',
    'Found:',
    ...items.map(i => `- ${i.detail.replaceAll('\n', '\n  ')}`),
  ].join('\n')
}

export const register: Register = (on, options) => {
  let settings = settingsOf(options, 'main')
  queueOn = settings.useQueue
  // One gh call at a time: the timer and a status call may meet.
  let fetching: Promise<void> | undefined
  const fetchPrs = ($: EngineInterface): Promise<void> => {
    fetching ??= (async () => {
      let error: string | undefined
      let prs: OpenPr[] | undefined
      try {
        const r = await $.process.run(
          ['gh', 'pr', 'list', '--state', 'open', '--json', 'number,title,headRefName,isDraft,url,updatedAt', '--limit', '100'],
          { timeoutMs: 20_000 })
        if (r.exitCode !== 0) throw new Error(r.stderr.trim().split('\n')[0]?.slice(0, 200) || 'no output')
        const parsed = JSON.parse(r.stdout || '[]') as unknown
        if (!Array.isArray(parsed)) throw new Error('unexpected gh output')
        prs = (parsed as OpenPr[]).filter(p => typeof p.headRefName === 'string' && p.headRefName.startsWith('flow/'))
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
      }
      const t = await $.clock.now()
      // A failure keeps the last list, and counts as a fetch so a status call does not retry at once.
      await update($, prCache, c => ({ prs: prs ?? c.prs, fetchedAt: t, error }))
    })().catch(() => undefined).finally(() => { fetching = undefined })
    return fetching
  }
  // Main's model and window, to size a subagent that runs the same model.
  let mainModel: string | undefined
  let mainWindow: number | undefined
  // What /flow resume already handed to managers in this session.
  const resumed = new Set<string>()

  on('session.start', async ($, e, next) => {
    // The base branch: the option, else the remote's default branch, else main.
    // A fresh clone may have no origin/HEAD, so ask the remote when the local ref is missing.
    try {
      const local = await $.process.run(['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
      let base = local.exitCode === 0 ? local.stdout.trim().replace(/^origin\//, '') : ''
      if (base === '') {
        const remote = await $.process.run(['git', 'ls-remote', '--symref', 'origin', 'HEAD'], { timeoutMs: 10_000 })
        base = /ref: refs\/heads\/(\S+)\s+HEAD/.exec(remote.stdout)?.[1] ?? ''
      }
      if (base !== '') { settings = settingsOf(options, base); queueOn = settings.useQueue }
    } catch {
      // Not a git repo, or no remote: keep "main".
    }

    await $.command.register({
      name: 'flow',
      description: 'Show the flow in a pane: managers, their workers, the merge queue and handed-over PRs. /flow close closes it, /flow resume picks up unfinished flow work',
      argumentHint: '[close|resume]',
    })
    await $.command.register({
      name: 'flow-tasks',
      description: 'Pick tasks from a task source (.claude/flow/sources/<name>.md) and start a manager for each',
      argumentHint: '[source] [ids or filter]',
    })
    await $.agent.register({
      name: 'manager',
      description: 'A flow manager: owns one task, writes briefs, starts flow:worker agents, reviews their PRs and hands them to the merge queue. ' +
        'Pass the task in the user\'s words as the prompt and a short task slug as the name; run it in the background.',
      prompt: fill(MANAGER_PROMPT.replace('{{QUEUE_RULE}}', settings.useQueue ? QUEUE_RULE : NO_QUEUE_RULE), settings),
      background: true,
    })
    await $.agent.register({
      name: 'worker',
      description: 'A flow worker: implements one brief in a git worktree of its own and opens a PR. ' +
        'Pass the whole brief as the prompt, its first line "Your name: <slug>", and the slug as the name.',
      prompt: fill(WORKER_PROMPT, settings),
      isolation: 'worktree',
      background: true,
    })
    await $.agent.register({
      name: 'queue',
      description: 'The flow merge queue. Started by the plugin when a PR is handed over; never start it yourself.',
      prompt: fill(QUEUE_PROMPT, settings),
      isolation: 'worktree',
      background: true,
    })

    await $.tool.register({
      name: 'handover',
      description: 'Hand an approved PR to the flow merge queue. Records the PR at its current head and starts a queue if none is running. ' +
        'Managers call this after reviewing a worker\'s PR; leave the branch alone afterwards.',
      inputSchema: {
        type: 'object',
        properties: {
          pr: { type: 'number', description: 'The PR number' },
          verified: { type: 'string', description: 'What the worker ran, and that the full check was not run' },
          pending: { type: 'string', description: '"none", or decisions the user still has to make' },
          after_deploy: { type: 'string', description: '"none", or what to check after deploy' },
          report_to: { type: 'string', description: 'Your agent name, so the queue reports back to you' },
        },
        required: ['pr', 'verified', 'report_to'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'queue',
      description: 'The merge queue\'s worklist. action "list": pending and taken handovers in arrival order. ' +
        '"take" (pr), "done" (pr, sha, report) or "back" (pr, reason) record what the queue did. Only the merge queue calls this.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'take', 'done', 'back'] },
          pr: { type: 'number' },
          sha: { type: 'string' },
          report: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['action'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'status',
      description: 'The flow at a glance: every manager, worker and queue of this session with its status and last report, and every handed-over PR.',
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    })

    $.clock.every(POLL_MS, () => void refresh($))
    // gh is not free: a slow timer, one look shortly after the start, and status when the list is stale.
    $.clock.every(PR_POLL_MS, () => void fetchPrs($))
    void fetchPrs($)
    // One shared tick for every running time on the pane: the render reads `now`, no card has a timer.
    $.clock.every(1000, () => void $.clock.now().then(t => update($, now, () => t)).catch(() => undefined))
    return next(e)
  })

  // A closed pane stays closed: only this command and a newly started agent (openPane) open it,
  // never the roster poll, so `/flow close` holds while agents keep running.
  on('command.run', { command: 'flow' }, async ($, e) => {
    // A plugin's $.command.run may leave args out.
    const arg = (e.args ?? '').trim()
    if (arg === 'close') {
      if (!(await $.ui.panes()).some(p => p.id === PANE)) return { text: 'The Flow pane is not open.' }
      try {
        await $.ui.close({ id: PANE })
      } catch (err) {
        return { text: `The Flow pane stayed open: ${err instanceof Error ? err.message : String(err)}` }
      }
      return { text: 'Flow pane closed.' }
    }
    if (arg === 'resume') {
      const found = await gatherLeftovers($, settings.base, resumed)
      if (found.error !== undefined) return { text: found.error }
      const lines = (kind: Leftover['kind'], title: string) => {
        const rows = found.items.filter(i => i.kind === kind)
        return rows.length ? [`${title}:`, ...rows.map(i => `  ${i.line}`)] : []
      }
      const again = found.skipped.length ? ['Already resumed in this session:', ...found.skipped.map(i => `  ${i.line}`)] : []
      if (found.items.length === 0) return { text: ['Nothing unfinished.', ...again].join('\n') }
      const text = [
        ...lines('pr', 'Open PRs'), ...lines('branch', 'Branches without a PR'), ...lines('worktree', 'Worktrees with leftover work'), ...again,
      ].join('\n')
      for (const i of found.items) resumed.add(i.key)
      // The instructions ride as hidden `context`. A command's context alone starts no turn and the
      // host refuses `prompt.submit` from inside a command.run hook, so a short prompt is submitted
      // once the command has returned, to make the main session act on it.
      $.clock.after(0, () => {
        void $.prompt.submit({ text: 'Carry out the /flow resume instructions: start the managers.' }).catch(() => undefined)
      })
      return { text, context: [resumeInstructions(found.items)] }
    }
    if (arg !== '') return { text: `Unknown argument "${arg}". /flow opens the Flow pane, /flow close closes it, /flow resume picks up unfinished work.` }
    await $.ui.open({ id: PANE, title: 'Flow', focus: true })
    return { text: 'Flow pane opened.' }
  })

  // Hands the request to the main session's model, which runs it with the dispatch skill. A
  // command can't submit a prompt itself (it would wait on its own turn), so a timer queues it
  // once the command has returned.
  on('command.run', { command: 'flow-tasks' }, async ($, e) => {
    const args = e.args.trim()
    const text = `Use the flow:dispatch skill, "Tasks from a source": pick tasks from ${args ? `the task source and selection "${args}"` : 'this project\'s task source'} and start a manager for each.`
    $.clock.after(1, () => void $.prompt.submit({ text }))
    return { text: `Picking tasks${args ? ` from ${args}` : ''}.` }
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.agentId !== undefined) {
      const t = await $.clock.now()
      const id = started.agentId
      await update($, activity, acts => ({
        ...acts, [id]: { startedAt: t, lastAt: t, log: [`started: ${e.description}`] },
      }))
      await refresh($)
      void openPane($)
    }
    return started
  }).catch(($, e, next) => next(e))

  // Every subagent tool call: refuse code edits from managers (a change goes into a worker's
  // brief), then keep the call as a line of the agent's activity log. The guard judges before
  // `next`, so the catch passes the call on only when the hook failed before it ran.
  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    if (id !== undefined) {
      if (['Edit', 'Write', 'NotebookEdit', 'MultiEdit'].includes(e.tool)) {
        const me = (await $.agent.list()).find(a => a.id === id)
        if (me?.type === MANAGER) {
          return { deny: 'flow: managers don\'t edit code. Put the change in a worker\'s brief, or send it to the worker that owns the file.' }
        }
      }
      const t = await $.clock.now()
      const line = describeCall(e as unknown as Record<string, unknown>)
      await update($, activity, acts => {
        const a = acts[id] ?? { startedAt: t, lastAt: t, log: [] }
        return { ...acts, [id]: { ...a, lastAt: t, doing: summarizeCall(e as unknown as Record<string, unknown>), log: [...a.log, line].slice(-LOG_MAX) } }
      })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__flow__handover' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const pr = Number(input.pr)
    if (!Number.isInteger(pr) || pr <= 0) return { result: 'Refused: pr must be a PR number.' }
    if (!settings.useQueue) {
      return { result: `Refused: this repo has no merge queue (the plugin's merge_queue option is off). Merge it yourself: full check, then gh pr merge ${pr} --${settings.mergeMethod} --delete-branch.` }
    }
    const view = await $.process.run(['gh', 'pr', 'view', String(pr), '--json', 'state,isDraft,headRefOid,headRefName,title'])
    if (view.exitCode !== 0) return { result: `Refused: gh pr view ${pr} failed: ${view.stderr.trim().slice(0, 300)}` }
    const info = JSON.parse(view.stdout) as { state: string; isDraft: boolean; headRefOid: string; headRefName: string; title: string }
    if (info.state !== 'OPEN') return { result: `Refused: PR #${pr} is ${info.state}.` }
    if (info.isDraft) return { result: `Refused: PR #${pr} is a draft. Mark it ready (gh pr ready ${pr}) first.` }
    const t = await $.clock.now()
    const h: Handover = {
      pr, title: info.title, head: info.headRefOid, branch: info.headRefName,
      reportTo: String(input.report_to ?? 'main'), verified: String(input.verified ?? ''),
      pending: String(input.pending ?? 'none'), afterDeploy: String(input.after_deploy ?? 'none'),
      status: 'pending', at: t,
    }
    await update($, handovers, hs => ({ ...hs, [String(pr)]: h }))
    const queue = await ensureQueue($)
    await refresh($)
    return { result: `Handed over PR #${pr} at ${info.headRefOid.slice(0, 8)}. ${queue} The queue reports back to ${h.reportTo} by message.` }
  })

  on('tool.call', { tool: 'mcp__flow__queue' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const action = String(input.action)
    const all = await read($, handovers)
    if (action === 'list') {
      const open = Object.values(all).filter(h => h.status === 'pending' || h.status === 'taken').sort((a, b) => a.at - b.at)
      if (open.length === 0) return { result: 'No pending handovers.' }
      return {
        result: open.map(h =>
          `#${h.pr} ${h.status}: "${h.title}" branch ${h.branch} head ${h.head} | report_to: ${h.reportTo} | verified: ${h.verified} | pending decisions: ${h.pending} | after deploy: ${h.afterDeploy}`,
        ).join('\n'),
      }
    }
    const key = String(Number(input.pr))
    const h = all[key]
    if (h === undefined) return { result: `No handover for PR #${key}.` }
    const next: Handover = action === 'take' ? { ...h, status: 'taken' }
      : action === 'done' ? { ...h, status: 'done', sha: String(input.sha ?? ''), report: String(input.report ?? '') }
      : action === 'back' ? { ...h, status: 'returned', reason: String(input.reason ?? '') }
      : h
    if (next === h) return { result: `Unknown action "${action}".` }
    await update($, handovers, hs => ({ ...hs, [key]: next }))
    if (action !== 'take') void $.ui.toast(`PR #${key} ${next.status === 'done' ? `merged ${next.sha ?? ''}` : `returned: ${next.reason ?? ''}`}`)
    await refresh($)
    return { result: `PR #${key}: ${next.status}.` }
  })

  on('tool.call', { tool: 'mcp__flow__status' }, async $ => {
    if (queueOn && (await $.clock.now()) - (await read($, prCache)).fetchedAt > PR_MIN_GAP_MS) await fetchPrs($)
    const [rows, acts, hs] = await Promise.all([refresh($), read($, activity), read($, handovers)])
    const [unhanded, cache] = [await currentUnhanded($), await read($, prCache)]
    const lines: string[] = []
    const byParent = new Map<string | undefined, AgentRow[]>()
    for (const a of rows) byParent.set(a.parentId, [...(byParent.get(a.parentId) ?? []), a])
    const ids = new Set(rows.map(a => a.id))
    const walk = (a: AgentRow, depth: number) => {
      const answer = (acts[a.id]?.answer ?? '').trim().split('\n').pop() ?? ''
      lines.push(`${'  '.repeat(depth)}- ${ROLE[a.type] ?? a.type} ${labelOf(a)}: ${a.status}${answer ? ` | last: ${answer.slice(0, 160)}` : ''}`)
      for (const c of byParent.get(a.id) ?? []) walk(c, depth + 1)
    }
    for (const a of rows.filter(r => r.parentId === undefined || !ids.has(r.parentId))) walk(a, 0)
    const list = Object.values(hs).sort((a, b) => a.at - b.at)
    return {
      result: [
        rows.length ? 'Agents:' : 'No agents in this session.', ...lines,
        list.length ? 'Handed-over PRs:' : 'No PRs handed over.', ...list.map(handoverLine),
        ...(unhanded.length ? [
          'Needs attention:', ...unhanded.map(u => `  ${unhandedLine(u)}`),
          'A manager reviews it and hands it over, or closes it.',
        ] : []),
        ...(queueOn && cache.error !== undefined ? [`Open PRs not checked: gh pr list failed: ${cache.error}`] : []),
      ].join('\n'),
    }
  })

  // Context used by a subagent: the input side of its latest step. Observe only; the step passes untouched.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    try {
      const id = e.agentId
      if (id === undefined) {
        mainModel = e.model
      } else if (r?.usage) {
        const tokens = r.usage.input_tokens + r.usage.cache_creation_input_tokens + r.usage.cache_read_input_tokens
        const model = r.usage.model || e.model
        const t = await $.clock.now()
        await update($, activity, acts => {
          const a = acts[id] ?? { startedAt: t, lastAt: t, log: [] }
          return { ...acts, [id]: { ...a, usage: { tokens, model } } }
        })
        // Tell a worker or manager once when it reaches the warning percent. Marked before it is
        // sent, so a send that fails (the agent already ended) is not retried every step.
        const percent = Math.round(tokens / windowOf(model, mainModel, mainWindow) * 100)
        if (settings.handoff && percent >= settings.contextWarn && (await read($, activity))[id]?.handoffNotifiedAt === undefined) {
          const me = (await $.agent.list()).find(a => a.id === id)
          if (me?.type === WORKER || me?.type === MANAGER) {
            await update($, activity, acts => {
              const a = acts[id] ?? { startedAt: t, lastAt: t, log: [] }
              return { ...acts, [id]: { ...a, handoffNotifiedAt: t } }
            })
            const role = ROLE[me.type]
            void $.ui.toast(`${role} ${labelOf(me)}: past ${settings.contextWarn}% context, handing off`)
            const text = `flow: your context is at ${percent}%, past the ${settings.contextWarn}% limit. Hand off now: follow the Handoff section of your instructions.`
            await $.session.send({ to: { agentId: id }, text }).catch(() => undefined)
          }
        }
      }
    } catch {
      // The meter is cosmetic: never fail the agent's step over it.
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    if (id !== undefined) {
      const t = await $.clock.now()
      await update($, activity, acts => {
        const a = acts[id] ?? { startedAt: t, lastAt: t, log: [] }
        return { ...acts, [id]: { ...a, lastAt: t, answer: e.answer } }
      })
      // A queue that ended while PRs were still pending: start a fresh one for them.
      const me = (await refresh($)).find(a => a.id === id)
      if (me?.type === QUEUE) await ensureQueue($)
    }
    return next(e)
  })

  // The pane paints with theme keys, which the engine resolves; a theme switch only needs a redraw.
  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const r = await next(e)
    try { $.ui.invalidate('ui.render') } catch { /* pane closed */ }
    return r
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [list, acts, pick, t, hs, unhanded] = await Promise.all([
      read($, roster), read($, activity), read($, selected), read($, now), read($, handovers), currentUnhanded($),
    ])
    const rows = e.viewport?.rows ?? 24
    const warn = settings.contextWarn
    // Free: no breakdown asked. Main's figures also size a subagent on the same model.
    const usage = await $.session.usage().then(u => u, () => undefined)
    const main = usage?.context
    if (main !== undefined) mainWindow = main.window

    const usageOf = (a: AgentRow): { percent: number; tokens: number; window: number } | undefined => {
      const u = acts[a.id]?.usage
      if (u === undefined) return undefined
      const window = windowOf(u.model, mainModel, mainWindow)
      return { percent: Math.round(u.tokens / window * 100), tokens: u.tokens, window }
    }
    // Theme keys only: the filled part is legible on any background, the empty cells are 'inactive'
    // rather than dim, and the colour turns at the warn and danger marks.
    const meter = (u: { percent: number; tokens: number; window: number } | undefined, dim: boolean, time: string) => {
      // Time and tokens sit dimmed together after the bar; the window figures are not repeated.
      const tail = [time, u === undefined ? '' : tokensDown(u.tokens)].filter(Boolean).join(' · ')
      return u === undefined
        ? <Text dimColor>context ?{tail ? `   ${tail}` : ''}</Text>
        : <Text dimColor={dim}>
          {cells(u.percent, warn).map((c, i) => (
            <Text key={String(i)} dimColor={dim} color={c.kind === 'empty' ? 'inactive' : c.kind === 'mark' ? 'text' : meterColor(u.percent, warn) ?? 'success'}>{c.ch}</Text>
          ))}
          <Text color={meterColor(u.percent, warn)} dimColor={dim}> {u.percent}%</Text>
          <Text dimColor>{tail ? `   ${tail}` : ''}</Text>
        </Text>
    }
    // Running time: to now while live, frozen at the end once it ended (the moment the roster saw
    // it end, else its last activity). No start on record, no time.
    const runTime = (act: Activity | undefined, isEnded: boolean): string =>
      act?.startedAt === undefined ? '' : elapsed((isEnded ? act.endedAt ?? act.lastAt : t) - act.startedAt)

    // One agent: a card (name, what it does, meter), or one compact row when the pane is short.
    // Only a top-level card has a border; deeper ones read as a tree by their indent.
    const card = (a: AgentRow, depth: number, full: boolean, bordered: boolean) => {
      const act = acts[a.id]
      const dim = ENDED.has(a.status)
      const asks = asksQuestion(act?.answer) && !['running', 'pending'].includes(a.status)
      const doing = asks ? 'asks: ' + (act?.answer ?? '').trim().split('\n').pop() : act?.doing
      const u = usageOf(a)
      const under = list.filter(c => c.parentId === a.id).length
      const head = <Text>
        <Text color={COLOR[a.status]}>{GLYPH[a.status] ?? '?'}</Text> <Text bold>{labelOf(a)}</Text>
        {under > 0 && <Text dimColor> (+{under})</Text>}
        <Text dimColor>  {ROLE[a.type] ?? a.type}</Text>
      </Text>
      // The description shows only while there is nothing done to show; the detail view has it.
      const second = doing !== undefined && doing !== ''
        ? <Text color={asks ? 'warning' : undefined} dimColor={!asks}>{doing.slice(0, 60)}</Text>
        : <Text dimColor>{a.description.slice(0, 60)}</Text>
      return (
        <Box key={`row-${a.id}`} paddingLeft={bordered ? depth * 2 : depth * 2 + 1}>
          {full ? (
            // A Button holds Text only, so the border is drawn around it.
            <Box flexDirection="column" borderStyle={bordered ? 'round' : undefined} borderDimColor={dim} paddingX={bordered ? 1 : 0}>
              <Button key={a.id} plain dimColor={dim} onPress={() => update($, selected, () => a.id)}>
                {head}{'\n'}{second}{'\n'}{meter(u, dim, runTime(act, dim))}
              </Button>
            </Box>
          ) : (
            <Button key={a.id} plain dimColor={dim} onPress={() => update($, selected, () => a.id)}>
              {head}{u !== undefined && <Text color={meterColor(u.percent, warn)}> {u.percent}%</Text>}
            </Button>
          )}
        </Box>
      )
    }
    const agent = list.find(a => a.id === pick)

    if (agent !== undefined) {
      const act = acts[agent.id]
      const answer = (act?.answer ?? '').trim()
      const children = list.filter(a => a.parentId === agent.id).sort((a, b) => rank(a.status) - rank(b.status))
      const fullChildren = children.length * CARD_ROWS <= rows - 15
      const room = Math.max(3, rows - 12 - (fullChildren ? children.length * (CARD_ROWS - 1) : 0))
      // The parent chain is the history: Back climbs one level, an orphan or top-level agent goes to the tree.
      const parent = list.find(a => a.id === agent.parentId)
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Button key="back" hotkey="b" onPress={() => update($, selected, () => parent?.id ?? null)}>Back</Button>
            <Button key="msg" hotkey="m" onPress={() => $.prompt.fill({
              text: `Send a message to ${ROLE[agent.type] ?? 'agent'} "${labelOf(agent)}": `, mode: 'replace',
            })}>Message</Button>
          </Box>
          <Text bold color={COLOR[agent.status]}>
            {GLYPH[agent.status] ?? '?'} {labelOf(agent)} <Text dimColor>{ROLE[agent.type] ?? agent.type} · {agent.status}
            {act ? ` · ${runTime(act, ENDED.has(agent.status))} · last active ${ago(t - act.lastAt)} ago` : ''}{children.length ? ` · ${children.length} under it` : ''}</Text>
          </Text>
          <Text dimColor>{agent.description}</Text>
          {children.length > 0 && <Text bold>Under it</Text>}
          {children.map(c => card(c, 0, fullChildren, true))}
          <Text bold>Activity</Text>
          {(act?.log ?? []).length === 0 && <Text dimColor>Nothing seen yet.</Text>}
          {(act?.log ?? []).slice(-room).map(line => <Text wrap="truncate-end">{line}</Text>)}
          {answer !== '' && <Text bold color={asksQuestion(answer) ? 'warning' : undefined}>
            {asksQuestion(answer) ? 'Asks' : 'Last report'}
          </Text>}
          {answer !== '' && <Text>{answer.length > 1200 ? '…' + answer.slice(-1200) : answer}</Text>}
        </Box>
      )
    }

    // The tree: each agent under the one that started it, what needs a person first.
    const ids = new Set(list.map(a => a.id))
    const kids = (id: string | undefined) => list
      .filter(a => (id === undefined ? a.parentId === undefined || !ids.has(a.parentId) : a.parentId === id))
      .sort((a, b) => rank(a.status) - rank(b.status))
    const flat: { a: AgentRow; depth: number }[] = []
    const walk = (a: AgentRow, depth: number) => {
      flat.push({ a, depth })
      for (const c of kids(a.id)) walk(c, depth + 1)
    }
    for (const a of kids(undefined)) walk(a, 0)
    const prs = Object.values(hs).sort((a, b) => b.at - a.at)
    const live = list.filter(a => !ENDED.has(a.status)).length
    // Header and the PR lines are fixed; the root and the agents share what is left. Full cards
    // (4 rows) if all fit, else compact rows, else compact rows and a "+N more" line.
    const prRows = prs.length > 0 ? 1 + Math.min(prs.length, 5) : 0
    const avail = rows - 1 - prRows - (list.length === 0 ? 1 : 0) - (unhanded.length > 0 ? 1 : 0)
    const fullTree = (flat.length + 1) * CARD_ROWS <= avail
    const rootFull = fullTree || avail >= CARD_ROWS + flat.length
    const left = avail - (rootFull ? CARD_ROWS : 1)
    const shown = fullTree || flat.length <= left ? flat : flat.slice(0, Math.max(0, left - 1))
    const mainTime = usage?.startedAt === undefined ? '' : elapsed(t - usage.startedAt)
    const mainU = main?.tokens === undefined ? undefined
      : { percent: main.percent ?? Math.round(main.tokens / main.window * 100), tokens: main.tokens, window: main.window }

    return (
      <Box flexDirection="column">
        <Text dimColor>{list.length} agents · {live} live{prs.length ? ` · ${prs.length} PRs handed over` : ''} · press one to see it</Text>
        {unhanded.length > 0 && (
          <Text color="warning" wrap="truncate-end">
            ⚠ {unhanded.length} PR{unhanded.length > 1 ? 's' : ''} nobody handed over: {unhanded.map(u => `#${u.pr}`).join(' ')}
          </Text>
        )}
        {rootFull ? (
          <Box flexDirection="column" borderStyle="round" paddingX={1}>
            <Text bold>{ROOT_GLYPH} main <Text dimColor> super manager</Text></Text>
            {meter(mainU, false, mainTime)}
          </Box>
        ) : (
          <Text bold>{ROOT_GLYPH} main <Text dimColor>· super manager</Text>
            {mainU !== undefined && <Text color={meterColor(mainU.percent, warn)}> {mainU.percent}%</Text>}
          </Text>
        )}
        {list.length === 0 && <Text dimColor>  Nothing running. Ask Claude to start managers or a worker, e.g. "start a manager for X".</Text>}
        {shown.map(({ a, depth }) => card(a, depth + 1, fullTree, depth === 0))}
        {shown.length < flat.length && <Text dimColor>  +{flat.length - shown.length} more</Text>}
        {prs.length > 0 && <Text bold>  Merge queue</Text>}
        {prs.slice(0, 5).map(h => (
          <Text key={`pr-${h.pr}`} dimColor={h.status === 'done'} wrap="truncate-end">
            {'    '}{HANDOVER_GLYPH[h.status]} #{h.pr} {h.status}{h.status === 'returned' ? `: ${h.reason ?? ''}` : ''} <Text dimColor>{h.title}</Text>
          </Text>
        ))}
      </Box>
    )
  })
}
