import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity, AgentRow, Handover } from '../types'
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
  running: 'cyan', waiting: 'yellow', idle: 'yellow', completed: 'green', failed: 'red', killed: 'red',
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

// One line for a tool call: the tool and its most telling argument.
function describeCall(e: Record<string, unknown>): string {
  const tool = String(e.tool ?? '?').replace(/^mcp__flow__/, '')
  const arg = [e.file_path, e.command, e.pattern, e.path, e.url, e.description, e.action, e.prompt]
    .find(v => typeof v === 'string' && v.length > 0) as string | undefined
  const short = arg === undefined ? '' : ' ' + arg.replace(/\s+/g, ' ').slice(0, 90)
  return tool + short
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
const CARD_ROWS = 4
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
function bar(percent: number, warn: number): string {
  const filled = Math.round(Math.min(100, percent) / 100 * METER_CELLS)
  const mark = Math.min(METER_CELLS - 1, Math.floor(warn / 100 * METER_CELLS))
  return Array.from({ length: METER_CELLS }, (_, i) => i === mark ? '│' : i < filled ? '█' : '░').join('')
}

function meterColor(percent: number, warn: number): string | undefined {
  return percent >= DANGER_PERCENT && percent >= warn ? 'red' : percent >= warn ? 'yellow' : undefined
}

function rank(status: string): number {
  const i = ORDER.indexOf(status)
  return i === -1 ? ORDER.length : i
}

// The pane's context meter marks this percent; the rest of the settings go into the prompts.
function settingsOf(options: Record<string, unknown>, base: string): Settings & { contextWarn: number } {
  const str = (k: string, d: string) => (typeof options[k] === 'string' && options[k] !== '' ? String(options[k]) : d)
  const num = (k: string, d: number) => (typeof options[k] === 'number' ? Number(options[k]) : d)
  return {
    contextWarn: Math.min(100, Math.max(1, Math.round(num('context_warn_percent', 40)))),
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
  for (const a of rows) {
    const prev = was.get(a.id)
    if (prev === undefined || prev === a.status || ENDED.has(prev)) continue
    if (ENDED.has(a.status) || a.status === 'idle') {
      const asks = asksQuestion(acts[a.id]?.answer)
      const role = ROLE[a.type] ? `${ROLE[a.type]} ` : ''
      void $.ui.toast(`${role}${labelOf(a)}: ${asks ? 'asks a question' : a.status === 'idle' ? 'finished its turn' : a.status}`)
    }
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
  $.ui.status(rows.length === 0 && hs.length === 0 ? undefined
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

export const register: Register = (on, options) => {
  let settings = settingsOf(options, 'main')
  // Main's model and window, to size a subagent that runs the same model.
  let mainModel: string | undefined
  let mainWindow: number | undefined

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
      if (base !== '') settings = settingsOf(options, base)
    } catch {
      // Not a git repo, or no remote: keep "main".
    }

    await $.command.register({
      name: 'flow',
      description: 'Show the flow in a pane: managers, their workers, the merge queue and handed-over PRs',
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
    return next(e)
  })

  on('command.run', { command: 'flow' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Flow', focus: true })
    return { text: 'Flow pane opened.' }
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
        return { ...acts, [id]: { ...a, lastAt: t, log: [...a.log, line].slice(-LOG_MAX) } }
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
    const [rows, acts, hs] = await Promise.all([refresh($), read($, activity), read($, handovers)])
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

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [list, acts, pick, t, hs] = await Promise.all([
      read($, roster), read($, activity), read($, selected), read($, now), read($, handovers),
    ])
    const rows = e.viewport?.rows ?? 24
    const warn = settings.contextWarn
    // Free: no breakdown asked. Main's figures also size a subagent on the same model.
    const main = await $.session.usage().then(u => u.context, () => undefined)
    if (main !== undefined) mainWindow = main.window

    const usageOf = (a: AgentRow): { percent: number; tokens: number; window: number } | undefined => {
      const u = acts[a.id]?.usage
      if (u === undefined) return undefined
      const window = windowOf(u.model, mainModel, mainWindow)
      return { percent: Math.round(u.tokens / window * 100), tokens: u.tokens, window }
    }
    const meter = (u: { percent: number; tokens: number; window: number } | undefined, dim: boolean) => u === undefined
      ? <Text dimColor>context ?</Text>
      : <Text color={meterColor(u.percent, warn)} dimColor={dim}>{bar(u.percent, warn)} {u.percent}% · {tokensLabel(u.tokens)}/{tokensLabel(u.window)}</Text>

    // One agent: a bordered card (two lines), or one compact row when the pane is short.
    const card = (a: AgentRow, depth: number, full: boolean) => {
      const act = acts[a.id]
      const dim = ENDED.has(a.status)
      const asks = asksQuestion(act?.answer) && !['running', 'pending'].includes(a.status)
      const last = asks ? 'asks: ' + (act?.answer ?? '').trim().split('\n').pop() : act?.log[act.log.length - 1] ?? ''
      const u = usageOf(a)
      const under = list.filter(c => c.parentId === a.id).length
      const role = ROLE[a.type] ? `${ROLE[a.type]} ` : ''
      const head = <Text>
        <Text color={COLOR[a.status]}>{GLYPH[a.status] ?? '?'}</Text> <Text bold>{role}{labelOf(a)}</Text>
        <Text dimColor> {act ? ago(t - act.lastAt) : ''}</Text> <Text color={asks ? 'yellow' : undefined} dimColor={!asks}>{last.slice(0, 70)}</Text>
      </Text>
      return (
        <Box key={`row-${a.id}`} paddingLeft={depth * 2}>
          {full ? (
            // A Button holds Text only, so the border is drawn around it.
            <Box flexDirection="column" borderStyle="round" borderDimColor={dim} paddingX={1}>
              <Button key={a.id} dimColor={dim} onPress={() => update($, selected, () => a.id)}>
                {head}{'\n'}{meter(u, dim)}<Text dimColor>  {a.description.slice(0, 60)}{under ? ` · ${under} under it` : ''}</Text>
              </Button>
            </Box>
          ) : (
            <Button key={a.id} dimColor={dim} onPress={() => update($, selected, () => a.id)}>
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
            {act ? ` · started ${ago(t - act.startedAt)} ago` : ''}{children.length ? ` · ${children.length} under it` : ''}</Text>
          </Text>
          <Text dimColor>{agent.description}</Text>
          {children.length > 0 && <Text bold>Under it</Text>}
          {children.map(c => card(c, 0, fullChildren))}
          <Text bold>Activity</Text>
          {(act?.log ?? []).length === 0 && <Text dimColor>Nothing seen yet.</Text>}
          {(act?.log ?? []).slice(-room).map(line => <Text wrap="truncate-end">{line}</Text>)}
          {answer !== '' && <Text bold color={asksQuestion(answer) ? 'yellow' : undefined}>
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
    const avail = rows - 1 - prRows - (list.length === 0 ? 1 : 0)
    const fullTree = (flat.length + 1) * CARD_ROWS <= avail
    const rootFull = fullTree || avail >= CARD_ROWS + flat.length
    const left = avail - (rootFull ? CARD_ROWS : 1)
    const shown = fullTree || flat.length <= left ? flat : flat.slice(0, Math.max(0, left - 1))
    const mainU = main?.tokens === undefined ? undefined
      : { percent: main.percent ?? Math.round(main.tokens / main.window * 100), tokens: main.tokens, window: main.window }

    return (
      <Box flexDirection="column">
        <Text dimColor>{list.length} agents · {live} live{prs.length ? ` · ${prs.length} PRs handed over` : ''} · press one to see it</Text>
        {rootFull ? (
          <Box flexDirection="column" borderStyle="round" paddingX={1}>
            <Text bold>{ROOT_GLYPH} main <Text dimColor>· super manager</Text></Text>
            {meter(mainU, false)}
          </Box>
        ) : (
          <Text bold>{ROOT_GLYPH} main <Text dimColor>· super manager</Text>
            {mainU !== undefined && <Text color={meterColor(mainU.percent, warn)}> {mainU.percent}%</Text>}
          </Text>
        )}
        {list.length === 0 && <Text dimColor>  Nothing running. Ask Claude to start managers or a worker, e.g. "start a manager for X".</Text>}
        {shown.map(({ a, depth }) => card(a, depth + 1, fullTree))}
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
