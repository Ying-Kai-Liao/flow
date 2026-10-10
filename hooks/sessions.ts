import type { AgentRow, Digest, DigestKind, Limit, Session } from '../types'

export type { Digest, DigestKind, Limit }

// Workers that run outside this session: another harness (codex, gemini, opencode, or claude on
// its own) in an Orca terminal or a tmux session, where the user can watch and type into them.
// The plugin starts them, waits for the report file they write and sends it to their manager as
// a message. This is the pure half; the calls that touch git, the terminals and the disk live in
// register.tsx (the engine follows `$` only into functions declared there).

export type Host = 'orca' | 'tmux'

export const SESSION = 'flow:session'

// What the plugin needs to know about a harness. Everything else (talking to it, pressing keys,
// noticing it went quiet, stopping it) works the same for every harness, through the terminal.
// - start: the command line; `{prompt}` is the whole prompt as one shell word, `{prompt_file}` its path.
// - resume: the command line that continues its last conversation in the worktree, for "restart".
// - program: what must be on PATH; default the first word of start.
// - quota: how to read the share of quota left before starting: "codex-logs" (Codex's own
//   rate-limit logs), or a shell command that prints a percent.
// - digest: where its own log of what it did lives, for the card's last actions and last words:
//   "codex-rollout" (~/.codex/sessions) or "claude-transcript" (~/.claude/projects).
export type HarnessSpec = { start: string; resume?: string; program?: string; quota?: string; digest?: DigestKind }

// Each built-in runs unattended: nobody sits at the terminal to approve a git push.
export const HARNESSES: Record<string, HarnessSpec> = {
  claude: {
    start: 'claude --permission-mode bypassPermissions {prompt}',
    resume: 'claude --continue --permission-mode bypassPermissions',
    digest: 'claude-transcript',
  },
  codex: {
    start: 'codex --dangerously-bypass-approvals-and-sandbox {prompt}',
    resume: 'codex resume --last --dangerously-bypass-approvals-and-sandbox',
    quota: 'codex-logs',
    digest: 'codex-rollout',
  },
  gemini: { start: 'gemini --yolo --prompt-interactive {prompt}' },
  opencode: { start: 'opencode --prompt {prompt}' },
}

const specOf = (v: unknown): HarnessSpec | undefined => {
  if (typeof v === 'string') return v.trim() === '' ? undefined : { start: v.trim() }
  if (typeof v !== 'object' || v === null) return undefined
  const r = v as Record<string, unknown>
  if (typeof r.start !== 'string' || r.start.trim() === '') return undefined
  const opt = (k: string) => (typeof r[k] === 'string' && (r[k] as string).trim() !== '' ? { [k]: (r[k] as string).trim() } : {})
  const digest = r.digest === 'codex-rollout' || r.digest === 'claude-transcript' ? { digest: r.digest as DigestKind } : {}
  return { start: r.start.trim(), ...opt('resume'), ...opt('program'), ...opt('quota'), ...digest }
}

// The `harnesses` setting over the built-ins: a name to a start command line, or to a full spec
// ({ "aider": { "start": "aider --yes-always --message-file {prompt_file}", "resume": "aider --restore-chat-history" } }).
// /config can only carry a string, so a JSON string is accepted too; "" removes a built-in, and
// an entry without a start line is dropped.
export function harnessesOf(raw: unknown): Record<string, HarnessSpec> {
  let v = raw
  if (typeof v === 'string') {
    try { v = v.trim() === '' ? {} : JSON.parse(v) } catch { v = {} }
  }
  const out = { ...HARNESSES }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return out
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val === '') { delete out[k]; continue }
    const spec = specOf(val)
    if (spec !== undefined) out[k] = spec
  }
  return out
}

// Keys a manager can press in any harness's terminal: tmux key names, and the bytes Orca types.
export const KEYS: Record<string, { tmux: string; raw: string }> = {
  enter: { tmux: 'Enter', raw: '\r' },
  escape: { tmux: 'Escape', raw: '\x1b' },
  interrupt: { tmux: 'C-c', raw: '\x03' },
  tab: { tmux: 'Tab', raw: '\t' },
  up: { tmux: 'Up', raw: '\x1b[A' },
  down: { tmux: 'Down', raw: '\x1b[B' },
  left: { tmux: 'Left', raw: '\x1b[D' },
  right: { tmux: 'Right', raw: '\x1b[C' },
  backspace: { tmux: 'BSpace', raw: '\x7f' },
  space: { tmux: 'Space', raw: ' ' },
}

// "1", "y", "escape", "down down enter": named keys, else the word typed as it is.
export function keysOf(spec: string): { tmux: string[]; raw: string } {
  const words = spec.trim().split(/\s+/).filter(Boolean)
  return {
    tmux: words.map(w => KEYS[w.toLowerCase()]?.tmux ?? w),
    raw: words.map(w => KEYS[w.toLowerCase()]?.raw ?? w).join(''),
  }
}

// The first number a quota command printed, as a percent.
export function percentOf(out: string): number | undefined {
  const m = /-?\d+(\.\d+)?/.exec(out)
  return m === null ? undefined : Math.max(0, Math.min(100, Math.round(Number(m[0]))))
}

// A cheap fingerprint of a terminal screen, to tell a harness that has gone quiet.
export function screenHash(screen: string): string {
  let h = 5381
  const s = screen.replace(/\s+$/gm, '').trimEnd()
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return `${s.length}:${h >>> 0}`
}

export const shellQuote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`

// The line typed into the terminal's shell. The prompt stays in its file, so the line is short
// whatever the brief holds; a template naming neither placeholder gets the prompt at the end.
export function commandFor(template: string, promptFile: string): string {
  const t = /\{prompt(_file)?\}/.test(template) ? template : `${template} {prompt}`
  return t.replaceAll('{prompt_file}', shellQuote(promptFile)).replaceAll('{prompt}', `"$(cat ${shellQuote(promptFile)})"`)
}

// A name doubles as the branch flow/<name>, the worktree dir and the tmux session.
export const NAME_RULE = /^[a-z0-9][a-z0-9_-]{0,62}$/i

export const tmuxName = (name: string): string => `flow-${name}`

export const sessionKey = (name: string): string => `session:${name}`

// `auto` takes Orca when its runtime answers, else tmux.
export function pickHost(choice: string, orcaUp: boolean, tmuxUp: boolean): Host | { error: string } {
  if (choice === 'orca') return orcaUp ? 'orca' : { error: 'Orca is not reachable (orca status). Open Orca, or use host "tmux".' }
  if (choice === 'tmux') return tmuxUp ? 'tmux' : { error: 'tmux is not installed.' }
  if (orcaUp) return 'orca'
  if (tmuxUp) return 'tmux'
  return { error: 'Neither Orca (orca status) nor tmux is available to run a session in.' }
}

// The first terminal handle in an `orca … --json` answer, wherever the runtime puts it.
export function findHandle(json: string): string | undefined {
  return /"(term_[\w-]+)"/.exec(json)?.[1]
}

// The new worktree's path in an `orca worktree create --json` answer.
export function findWorktreePath(json: string): string | undefined {
  try {
    const r = (JSON.parse(json) as { result?: Record<string, unknown> }).result ?? {}
    const wt = (r.worktree ?? r) as { path?: unknown }
    return typeof wt.path === 'string' ? wt.path : undefined
  } catch {
    return undefined
  }
}

const STATUS: Record<Session['status'], string> = {
  running: 'running', reported: 'idle', idle: 'waiting', exited: 'completed', stopped: 'killed',
}

// A session as a roster row, so the tree, the status tool and the plans treat it like a worker.
export function sessionRow(s: Session): AgentRow {
  return {
    id: sessionKey(s.name), name: s.name, description: `${s.harness} in ${s.host}`, type: SESSION,
    status: STATUS[s.status], ...(s.owner !== 'main' && { parentId: s.owner }),
  }
}

export function sessionLine(s: Session): string {
  return `${s.name}: ${s.harness} in ${s.host} (${s.handle}), ${s.status}, worktree ${s.worktree}, branch ${s.branch}`
}

export function reportMessage(s: Session, report: string): string {
  return `flow session: ${s.harness} worker "${s.name}" (${s.host}) reports:\n\n${report.trim()}\n\n` +
    `Answer or send feedback with mcp__flow__session action "send", name "${s.name}"; not SendMessage.`
}

// Codex quota from the newest `rate_limits` line in ~/.codex/sessions/**/rollout-*.jsonl (no
// network): the lowest share left across its windows. A window past its reset counts as unused;
// a reading older than QUOTA_STALE_MS says nothing about now, so it never blocks a start.
const QUOTA_STALE_MS = 6 * 60 * 60_000

type Window = { used_percent?: unknown; resets_at?: unknown; window_minutes?: unknown }


const windowLabel = (minutes: number | undefined, fallback: string): string =>
  minutes === undefined ? fallback : minutes % 1440 === 0 ? `${minutes / 1440 === 7 ? 'week' : `${minutes / 1440}d`}` : `${Math.round(minutes / 60)}h`

// Codex's windows from one rollout line, or undefined when it holds none or is too old to tell.
// A window past its reset counts as unused.
export function codexLimits(line: string, now: number): Limit[] | undefined {
  let d: Record<string, any>
  try { d = JSON.parse(line) } catch { return undefined }
  const at = Date.parse(String(d?.timestamp ?? ''))
  if (!Number.isFinite(at) || now - at > QUOTA_STALE_MS) return undefined
  const rl = d.rate_limits ?? d.payload?.rate_limits ?? d.payload?.info?.rate_limits
  if (typeof rl !== 'object' || rl === null) return undefined
  const out: Limit[] = []
  for (const [key, w] of [['primary', rl.primary], ['secondary', rl.secondary]] as [string, Window | undefined][]) {
    if (typeof w !== 'object' || w === null || typeof w.used_percent !== 'number') continue
    const resetsAt = typeof w.resets_at === 'number' ? w.resets_at * 1000 : undefined
    const minutes = typeof w.window_minutes === 'number' ? w.window_minutes : undefined
    out.push({
      tool: 'codex', label: windowLabel(minutes, key),
      used: resetsAt !== undefined && resetsAt <= now ? 0 : w.used_percent,
      ...(resetsAt !== undefined && { resetsAt }), ...(minutes !== undefined && { windowMs: minutes * 60_000 }),
    })
  }
  return out.length === 0 ? undefined : out
}

export function codexRemaining(line: string, now: number): number | undefined {
  const limits = codexLimits(line, now)
  return limits === undefined ? undefined : Math.min(...limits.map(l => Math.round(100 - l.used)))
}

// Claude's own windows, as $.session.usage() reports them.
const CLAUDE_WINDOWS: Record<string, { label: string; ms: number }> = {
  five_hour: { label: '5h', ms: 5 * 3600_000 },
  seven_day: { label: 'week', ms: 7 * 86_400_000 },
}

export function claudeLimits(rate: { kind: string; percentUsed: number; resetsAt?: string }[]): Limit[] {
  return rate.map(r => {
    const w = CLAUDE_WINDOWS[r.kind] ?? (r.kind.startsWith('seven_day_') ? { label: `week ${r.kind.slice(10)}`, ms: 7 * 86_400_000 } : undefined)
    const resetsAt = r.resetsAt === undefined ? NaN : Date.parse(r.resetsAt)
    return {
      tool: 'claude', label: w?.label ?? r.kind.replaceAll('_', ' '), used: r.percentUsed,
      ...(Number.isFinite(resetsAt) && { resetsAt }), ...(w !== undefined && { windowMs: w.ms }),
    }
  })
}

// At the pace of the window so far, how long until it is used up; undefined when it lasts to the
// reset, or the window is too young (under 10 minutes) to say.
export function runsOutIn(l: Limit, now: number): number | undefined {
  if (l.resetsAt === undefined || l.windowMs === undefined || l.used <= 0) return undefined
  const left = l.resetsAt - now
  const spent = l.windowMs - left
  if (left <= 0 || spent < 10 * 60_000) return undefined
  const rate = l.used / spent
  if (l.used + rate * left <= 100) return undefined
  return Math.max(0, (100 - l.used) / rate)
}


const clip = (s: string, n: number): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

// "tools.exec_command({ cmd: \"npm test\" })" → the command; anything else → its first line.
function codexCall(name: string, input: string): string {
  const cmd = /cmd["']?\s*:\s*(\[[^\]]*\]|"(?:[^"\\]|\\.)*")/.exec(input)?.[1]
  let what = input.split('\n')[0] ?? ''
  if (cmd !== undefined) {
    try {
      const v = JSON.parse(cmd) as unknown
      what = Array.isArray(v) ? v.map(String).join(' ').replace(/^(bash|zsh|sh) -l?c /, '') : String(v)
    } catch { what = cmd }
  }
  return clip(`${name}: ${what}`, 80)
}

// The tail of a Codex rollout file (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl).
export function parseCodexRollout(text: string): Digest {
  const d: Digest = { actions: [] }
  for (const line of text.split('\n')) {
    let row: Record<string, any>
    try { row = JSON.parse(line) } catch { continue }
    const p = row.payload ?? {}
    const at = Date.parse(String(row.timestamp ?? ''))
    if (Number.isFinite(at)) d.at = at
    if (row.type === 'response_item' && p.type === 'custom_tool_call') d.actions.push(codexCall(String(p.name ?? 'tool'), String(p.input ?? '')))
    else if (row.type === 'response_item' && p.type === 'function_call') d.actions.push(codexCall(String(p.name ?? 'tool'), String(p.arguments ?? '')))
    else if (row.type === 'event_msg' && p.type === 'agent_message' && typeof p.message === 'string') d.lastWords = p.message
    else if (row.type === 'event_msg' && p.type === 'task_started') delete d.turnDone
    else if (row.type === 'event_msg' && p.type === 'task_complete') {
      if (Number.isFinite(at)) d.turnDone = at
      if (typeof p.last_agent_message === 'string' && p.last_agent_message.trim() !== '') d.lastWords = p.last_agent_message
    } else if (row.type === 'event_msg' && p.type === 'token_count') {
      const used = p.info?.last_token_usage?.total_tokens
      const window = p.info?.model_context_window
      if (typeof used === 'number') d.tokens = used
      if (typeof window === 'number') d.window = window
    }
  }
  d.actions = d.actions.slice(-3)
  return d
}

// The tail of a Claude Code transcript (~/.claude/projects/<dir>/<session>.jsonl).
export function parseClaudeTranscript(text: string): Digest {
  const d: Digest = { actions: [] }
  for (const line of text.split('\n')) {
    let row: Record<string, any>
    try { row = JSON.parse(line) } catch { continue }
    const at = Date.parse(String(row.timestamp ?? ''))
    if (Number.isFinite(at)) d.at = at
    if (row.type !== 'assistant' || !Array.isArray(row.message?.content)) continue
    for (const c of row.message.content as Record<string, any>[]) {
      if (c.type === 'tool_use') {
        const i = c.input ?? {}
        const arg = [i.command, i.file_path, i.pattern, i.description, i.url].find(v => typeof v === 'string' && v !== '') as string | undefined
        d.actions.push(clip(`${String(c.name)}${arg === undefined ? '' : `: ${arg}`}`, 80))
      } else if (c.type === 'text' && typeof c.text === 'string' && c.text.trim() !== '') d.lastWords = c.text
    }
    const u = row.message.usage
    if (u && typeof u.input_tokens === 'number') {
      d.tokens = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
    }
  }
  d.actions = d.actions.slice(-3)
  return d
}

// Where Claude Code keeps the transcripts of a directory: every character but letters and digits becomes "-".
export const claudeProjectDir = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-')

// The program a command line starts, to check it is installed: its first word, unless that is a
// variable assignment or a shell construct.
export function programOf(command: string): string | undefined {
  const first = command.trim().split(/\s+/)[0] ?? ''
  return /^[\w./~-]+$/.test(first) ? first : undefined
}

export function idleMessage(s: Session, why: string, screen: string, lastWords?: string): string {
  const words = lastWords?.trim() ? `Its last words:\n${lastWords.trim().slice(-1500)}\n\n` : ''
  return `flow session: ${s.harness} worker "${s.name}" (${s.host}) ${why} and wrote no new report. ` +
    `It may be asking something, waiting on a prompt, or stuck.\n\n${words}Its screen:\n` + `${screen.trim() || '(empty)'}\n\n` +
    `Answer with mcp__flow__session action "send", press keys with "keys" (e.g. "1", "y enter", "escape"), or "restart" it.`
}

export function goneMessage(s: Session, tail: string): string {
  return `flow session: ${s.harness} worker "${s.name}" (${s.host}) ended without writing a new report. ` +
    `Its worktree is ${s.worktree} on ${s.branch}.${tail.trim() ? `\nLast terminal lines:\n${tail.trim()}` : ''}`
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60}m`
}
