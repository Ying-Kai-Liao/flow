import type { AgentRow, Session } from '../types'

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
export type HarnessSpec = { start: string; resume?: string; program?: string; quota?: string }

// Each built-in runs unattended: nobody sits at the terminal to approve a git push.
export const HARNESSES: Record<string, HarnessSpec> = {
  claude: { start: 'claude --permission-mode bypassPermissions {prompt}', resume: 'claude --continue --permission-mode bypassPermissions' },
  codex: {
    start: 'codex --dangerously-bypass-approvals-and-sandbox {prompt}',
    resume: 'codex resume --last --dangerously-bypass-approvals-and-sandbox',
    quota: 'codex-logs',
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
  return { start: r.start.trim(), ...opt('resume'), ...opt('program'), ...opt('quota') }
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

type Window = { used_percent?: unknown; resets_at?: unknown }

export function codexRemaining(line: string, now: number): number | undefined {
  let d: Record<string, any>
  try { d = JSON.parse(line) } catch { return undefined }
  const at = Date.parse(String(d?.timestamp ?? ''))
  if (!Number.isFinite(at) || now - at > QUOTA_STALE_MS) return undefined
  const rl = d.rate_limits ?? d.payload?.rate_limits ?? d.payload?.info?.rate_limits
  if (typeof rl !== 'object' || rl === null) return undefined
  const left = [rl.primary, rl.secondary]
    .filter((w): w is Window => typeof w === 'object' && w !== null && typeof w.used_percent === 'number')
    .map(w => (typeof w.resets_at === 'number' && w.resets_at * 1000 <= now ? 100 : Math.round(100 - (w.used_percent as number))))
  return left.length === 0 ? undefined : Math.min(...left)
}

// The program a command line starts, to check it is installed: its first word, unless that is a
// variable assignment or a shell construct.
export function programOf(command: string): string | undefined {
  const first = command.trim().split(/\s+/)[0] ?? ''
  return /^[\w./~-]+$/.test(first) ? first : undefined
}

export function idleMessage(s: Session, quietFor: string, screen: string): string {
  return `flow session: ${s.harness} worker "${s.name}" (${s.host}) has shown nothing new for ${quietFor} and wrote no new report. ` +
    'It may be asking something, waiting on a prompt, or stuck. Its screen:\n' + `${screen.trim() || '(empty)'}\n\n` +
    `Answer with mcp__flow__session action "send", press keys with "keys" (e.g. "1", "y enter", "escape"), or "restart" it.`
}

export function goneMessage(s: Session, tail: string): string {
  return `flow session: ${s.harness} worker "${s.name}" (${s.host}) ended without writing a new report. ` +
    `Its worktree is ${s.worktree} on ${s.branch}.${tail.trim() ? `\nLast terminal lines:\n${tail.trim()}` : ''}`
}
