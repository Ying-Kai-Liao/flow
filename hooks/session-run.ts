import type { Activity, LogEvent, Session } from '../types'
import { ENDED } from './deliver'
import { fill, SESSION_PROMPT } from './prompts'
import type { Settings } from './prompts'
import {
  ago, claudeProjectDir, codexLimits, codexRemaining, commandFor, findHandle, findWorktreePath, goneMessage,
  idleMessage, keysOf, NAME_RULE, parseClaudeTranscript, parseCodexRollout, percentOf, pickHost, programOf, reportMessage,
  screenHash, sessionKey, sessionLine, tmuxName,
} from './sessions'
import type { Digest, HarnessSpec, Limit } from './sessions'

// The terminal-session half of sessions.ts: the calls that touch git, the terminals, the disk and the
// clock. The engine handle `$` is never passed across an import, so register.tsx hands in these
// calls (sessionIoOf) and keeps the atoms; the same pattern as deliver.ts.
export type SessionIo = {
  run: (argv: string[], timeoutMs?: number) => Promise<Ran>
  now: () => Promise<number>
  after: (ms: number, fn: () => void) => void
  stat: (path: string) => Promise<{ mtimeMs: number }>
  read: (path: string) => Promise<unknown>
  write: (path: string, text: string) => Promise<unknown>
  sessions: () => Promise<Record<string, Session>>
  updateSessions: (fn: (all: Record<string, Session>) => Record<string, Session>) => Promise<unknown>
  updateActivity: (fn: (acts: Record<string, Activity>) => Record<string, Activity>) => Promise<unknown>
  setLimits: (limits: Limit[]) => Promise<unknown>
  // The refusal text of the preflight gate; undefined when the caller may start workers.
  gate: (agentId: string | undefined) => Promise<string | undefined>
  agents: () => Promise<{ name?: string; status: string }[]>
  stateDir: () => Promise<string | undefined>
  log: (event: Omit<LogEvent, 'ts'>) => Promise<unknown>
  warn: (what: string, err: unknown) => Promise<unknown>
  refresh: () => Promise<unknown>
  openPane: () => Promise<unknown>
  submit: (text: string) => Promise<unknown>
  deliver: (id: string, text: string) => Promise<unknown>
  // How many activity lines a card keeps.
  logMax: number
}

export type SessionSettings = Settings & { harnesses: Record<string, HarnessSpec>; minQuota: number }

// Workers in other harnesses (sessions.ts): started in an Orca terminal or a tmux session, watched
// through the report file they write. A command that can't start is an exit code here, never a throw.
export type Ran = { exitCode: number; stdout: string; stderr: string }

const why = (r: Ran): string => (r.stderr.trim() || r.stdout.trim()).split('\n')[0]?.slice(0, 300) || `exit ${r.exitCode}`

// A terminal is checked this often; the report file on every poll.
const ALIVE_MS = 30_000
// A screen is looked at this often, and a running harness whose screen has not changed for
// IDLE_MS (and wrote no new report) is told to its manager as idle.
const LOOK_MS = 10_000
const IDLE_MS = 90_000
// A harness whose own log says its turn ended is idle this long after, when no report came:
// time for it to write the report file as its turn's last step.
const TURN_GRACE_MS = 15_000
// Quota readings for the pane are refreshed this often.
const LIMITS_MS = 60_000
// A second press within this long confirms restart or stop from the pane.
const ARM_MS = 5000
// A report file younger than this may still be being written: it waits for the next poll.
const SETTLE_MS = 2000
const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash', 'ksh', 'tcsh', 'nu'])

export type Caller = { id: string; name: string }

async function startSession(io: SessionIo, input: Record<string, unknown>, caller: Caller, s: SessionSettings): Promise<string> {
  const gated = await io.gate(caller.id === 'main' ? undefined : caller.id)
  if (gated !== undefined) return `Refused: ${gated}`
  const name = String(input.name ?? '').trim()
  if (!NAME_RULE.test(name)) return 'Refused: name must be letters, digits, "-" or "_" (it becomes the branch flow/<name>).'
  const brief = String(input.brief ?? '').trim()
  if (brief === '') return 'Refused: brief is empty.'
  const old = (await io.sessions())[name]
  if (old !== undefined && !['exited', 'stopped'].includes(old.status)) return `Refused: session ${name} is already running (${old.harness} in ${old.host}).`
  if ((await io.agents()).some(a => a.name === name && !ENDED.has(a.status))) return `Refused: an agent named ${name} is running; pick another name.`
  const harness = String(input.harness ?? (s.workerHarness === 'agent' ? '' : s.workerHarness)).trim()
  const custom = String(input.command ?? '').trim()
  const spec: HarnessSpec | undefined = harness === 'command' ? (custom ? { start: custom } : undefined) : s.harnesses[harness]
  if (harness === 'command' && spec === undefined) return 'Refused: harness "command" needs command, the command line that starts it ({prompt} or {prompt_file} where the prompt goes).'
  if (spec === undefined) return `Refused: unknown harness "${harness}". Known: ${Object.keys(s.harnesses).join(', ')}; or harness "command" with command.`
  const template = spec.start

  // Installed? Homebrew's prefixes are added: a GUI-started engine often lacks them on PATH.
  const program = spec.program ?? programOf(template)
  if (program !== undefined) {
    const found = await io.run(['sh', '-c', 'PATH="$PATH:/opt/homebrew/bin:/usr/local/bin" command -v "$1"', 'sh', program], 10_000)
    if (found.exitCode !== 0) return `Refused: ${program} is not installed (not on PATH). Start this worker as a flow:worker agent instead, or pick another harness.`
  }
  if (spec.quota !== undefined && s.minQuota > 0) {
    const left = await quotaLeft(io, spec.quota)
    if (left !== undefined && left < s.minQuota) {
      return `Refused: ${harness} has ${left}% of its quota left, below min_quota (${s.minQuota}%). Start this worker as a flow:worker agent instead, or with another harness.`
    }
  }

  const dir = await io.stateDir()
  const wl = await io.run(['git', 'worktree', 'list', '--porcelain'])
  const main = /^worktree (.+)$/m.exec(wl.stdout)?.[1]
  if (dir === undefined || main === undefined) return 'Refused: not in a git repo.'
  const choice = String(input.host ?? s.sessionHost)
  const orcaUp = choice !== 'tmux' && await io.run(['orca', 'status'], 10_000).then(r => r.exitCode === 0 && /runtimeReachable:\s*true/.test(r.stdout))
  const tmuxUp = choice !== 'orca' && !orcaUp && (await io.run(['tmux', '-V'], 10_000)).exitCode === 0
  const host = pickHost(choice, orcaUp, tmuxUp)
  if (typeof host !== 'string') return `Refused: ${host.error}`

  const branch = `flow/${name}`
  await io.run(['git', 'fetch', 'origin', s.base], 120_000)
  let worktree: string
  if (host === 'tmux') {
    worktree = `${main}/.claude/worktrees/${name}`
    const r = await io.run(['git', 'worktree', 'add', '-b', branch, worktree, `origin/${s.base}`], 120_000)
    if (r.exitCode !== 0) return `Could not create the worktree: ${why(r)}`
  } else {
    const r = await io.run(['orca', 'worktree', 'create', '--repo', `path:${main}`, '--name', name, '--base-branch', `origin/${s.base}`, '--json'], 180_000)
    const path = r.exitCode === 0 ? findWorktreePath(r.stdout) : undefined
    if (path === undefined) return `Could not create an Orca worktree: ${why(r)}`
    worktree = path
    const m = await io.run(['git', '-C', worktree, 'branch', '-m', branch])
    if (m.exitCode !== 0) return `Created the Orca worktree ${worktree}, but could not name its branch ${branch}: ${why(m)}. Nothing was started in it.`
  }

  const sdir = `${dir}/sessions/${name}`
  const promptFile = `${sdir}/prompt.md`
  const reportFile = `${sdir}/report.md`
  // A report left by an earlier session of this name would read as this one's.
  await io.run(['rm', '-f', reportFile])
  const prompt = fill(SESSION_PROMPT, s)
    .replaceAll('{{HARNESS}}', harness === 'command' ? 'a coding agent' : harness)
    .replaceAll('{{OWNER}}', caller.name).replaceAll('{{NAME}}', name)
    .replaceAll('{{BRANCH}}', branch).replaceAll('{{REPORT}}', reportFile)
  await io.write(promptFile, `${prompt}${brief}\n`)
  const line = commandFor(template, promptFile)

  let handle: string
  if (host === 'tmux') {
    handle = tmuxName(name)
    const r = await io.run(['tmux', 'new-session', '-d', '-s', handle, '-c', worktree])
    if (r.exitCode !== 0) return `The worktree ${worktree} is ready, but tmux could not start: ${why(r)}`
    // A tmux server started from here inherits this session's environment; a nested claude refuses to run under it.
    await io.run(['tmux', 'send-keys', '-t', handle, '-l', `unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT; ${line}`])
    await io.run(['tmux', 'send-keys', '-t', handle, 'Enter'])
  } else {
    const r = await io.run(['orca', 'terminal', 'create', '--worktree', `path:${worktree}`, '--title', name, '--command', line, '--json'])
    const h = r.exitCode === 0 ? findHandle(r.stdout) : undefined
    if (h === undefined) return `The worktree ${worktree} is ready, but the Orca terminal could not start: ${why(r)}`
    handle = h
  }

  const t = await io.now()
  const session: Session = {
    name, harness, host, handle, worktree, branch, promptFile, reportFile, start: template,
    ...(spec.resume !== undefined && { resume: spec.resume }),
    ...(spec.digest !== undefined && { digestKind: spec.digest }),
    owner: caller.id, ownerName: caller.name, status: 'running', startedAt: t,
  }
  await io.updateSessions(all => ({ ...all, [name]: session }))
  await io.updateActivity(acts => ({ ...acts, [sessionKey(name)]: { startedAt: t, lastAt: t, log: [`started ${harness} in ${host}`] } }))
  await io.log({ event: 'spawn', agent: name, owner: caller.name, branch })
  await io.refresh()
  void io.openPane()
  return `Started ${name}: ${harness} in ${host} (${host === 'tmux' ? `tmux attach -t ${handle}` : handle}), worktree ${worktree}, branch ${branch}. ` +
    'Its report comes to you as a "flow session:" message: end your turn while you wait.'
}

// The newest lines with Codex rate limits, newest file first.
async function codexRateLines(io: SessionIo): Promise<string[]> {
  const r = await io.run(['sh', '-c',
    'ls -t "$HOME"/.codex/sessions/*/*/*/rollout-*.jsonl 2>/dev/null | head -5 | while read -r f; do grep -h \'"rate_limits":{\' "$f" | tail -1; done'], 10_000)
  return r.stdout.split('\n')
}

async function codexLimitsNow(io: SessionIo): Promise<Limit[]> {
  const t = await io.now()
  for (const line of await codexRateLines(io)) {
    const limits = codexLimits(line, t)
    if (limits !== undefined) return limits
  }
  return []
}

// The harness's own log for this session: the newest file written since it started, in its worktree.
async function findDigestFile(io: SessionIo, s: Session): Promise<string | undefined> {
  const script = s.digestKind === 'codex-rollout'
    ? 'fs=$(find "$HOME/.codex/sessions" -name "rollout-*.jsonl" -newer "$1" 2>/dev/null | while read -r f; do head -c 20000 "$f" | grep -q -F "\\"cwd\\":\\"$2\\"" && echo "$f"; done); [ -n "$fs" ] && ls -t $fs | head -1'
    : 'fs=$(find "$HOME/.claude/projects/$2" -maxdepth 1 -name "*.jsonl" -newer "$1" 2>/dev/null); [ -n "$fs" ] && ls -t $fs | head -1'
  const arg = s.digestKind === 'codex-rollout' ? s.worktree : claudeProjectDir(s.worktree)
  const r = await io.run(['sh', '-c', script, 'sh', s.promptFile, arg], 10_000)
  const file = r.stdout.trim().split('\n')[0]
  return file === undefined || file === '' ? undefined : file
}

// Reads the tail of the harness's log when it moved, and mirrors it on the card: the newest
// action as what it is doing, new actions in its activity, its context fill on the meter.
async function refreshDigest(io: SessionIo, s: Session, t: number): Promise<Digest | undefined> {
  if (s.digestKind === undefined) return undefined
  const file = (await findDigestFile(io, s)) ?? s.digestFile
  if (file === undefined) return undefined
  const st = await io.stat(file).catch(() => undefined)
  if (st === undefined) return s.digest
  if (file === s.digestFile && st.mtimeMs === s.digestSeen) return s.digest
  const r = await io.run(['tail', '-c', '65536', file], 10_000)
  if (r.exitCode !== 0) return s.digest
  const d = s.digestKind === 'codex-rollout' ? parseCodexRollout(r.stdout) : parseClaudeTranscript(r.stdout)
  await io.updateSessions(all => ({ ...all, [s.name]: { ...all[s.name]!, digestFile: file, digestSeen: st.mtimeMs, digest: d } }))
  const before = s.digest?.actions ?? []
  const fresh = d.actions.filter(a => !before.includes(a))
  const key = sessionKey(s.name)
  await io.updateActivity(acts => {
    const a = acts[key] ?? { startedAt: t, lastAt: t, log: [] }
    return {
      ...acts,
      [key]: {
        ...a, lastAt: d.at ?? a.lastAt, log: [...a.log, ...fresh].slice(-io.logMax),
        ...(d.actions.length > 0 && { doing: d.actions[d.actions.length - 1] }),
        ...(d.tokens !== undefined && { usage: { tokens: d.tokens, model: s.harness, ...(d.window !== undefined && { window: d.window }) } }),
      },
    }
  })
  return d
}

// The share of a harness's quota left: "codex-logs" reads Codex's own rate-limit logs, anything
// else is a shell command that prints a percent. Undefined when it can't tell, which never blocks.
async function quotaLeft(io: SessionIo, how: string): Promise<number | undefined> {
  if (how === 'codex-logs') return codexQuotaLeft(io)
  const r = await io.run(['sh', '-c', how], 20_000)
  return r.exitCode === 0 ? percentOf(r.stdout) : undefined
}

// The newest Codex rate-limit reading, from the five newest rollout files; undefined when there is
// none or it is too old to say anything.
async function codexQuotaLeft(io: SessionIo): Promise<number | undefined> {
  const t = await io.now()
  for (const line of await codexRateLines(io)) {
    const left = codexRemaining(line, t)
    if (left !== undefined) return left
  }
  return undefined
}

// Whether the harness is still there: the terminal exists, and in tmux it is not back at its shell.
async function sessionAlive(io: SessionIo, s: Session): Promise<boolean> {
  if (s.host === 'orca') {
    // A closed terminal still shows, with connected false and why it exited.
    const r = await io.run(['orca', 'terminal', 'show', '--terminal', s.handle, '--json'], 10_000)
    return r.exitCode === 0 && !/"ok":\s*false|"connected":\s*false|"exitCause"/.test(r.stdout)
  }
  const r = await io.run(['tmux', 'display-message', '-p', '-t', s.handle, '#{pane_current_command}'], 10_000)
  return r.exitCode === 0 && !SHELLS.has(r.stdout.trim().replace(/^-/, ''))
}

async function sessionTail(io: SessionIo, s: Session, lines: number): Promise<Ran> {
  return s.host === 'tmux'
    ? io.run(['tmux', 'capture-pane', '-p', '-J', '-t', s.handle, '-S', `-${lines}`], 10_000)
    : io.run(['orca', 'terminal', 'read', '--terminal', s.handle, '--limit', String(lines)], 10_000)
}

// What the terminal shows now (the rendered screen, not the scrollback).
async function sessionScreen(io: SessionIo, s: Session): Promise<string | undefined> {
  const r = s.host === 'tmux'
    ? await io.run(['tmux', 'capture-pane', '-p', '-t', s.handle], 10_000)
    : await io.run(['orca', 'terminal', 'read', '--terminal', s.handle, '--screen'], 10_000)
  return r.exitCode === 0 ? r.stdout : undefined
}

// Types a line into the terminal and submits it: a paste in tmux keeps a multi-line message whole in a TUI.
async function typeInto(io: SessionIo, s: Session, text: string): Promise<Ran> {
  if (s.host === 'orca') return io.run(['orca', 'terminal', 'send', '--terminal', s.handle, '--text', text, '--enter', '--json'])
  let r = await io.run(['tmux', 'set-buffer', '-b', `flow-${s.name}`, '--', text])
  if (r.exitCode === 0) r = await io.run(['tmux', 'paste-buffer', '-d', '-p', '-b', `flow-${s.name}`, '-t', s.handle])
  if (r.exitCode === 0) r = await io.run(['tmux', 'send-keys', '-t', s.handle, 'Enter'])
  return r
}

async function tellOwner(io: SessionIo, s: Session, text: string): Promise<void> {
  if (s.owner === 'main') io.after(0, () => void io.submit(text).catch(() => undefined))
  else await io.deliver(s.owner, text).catch(() => undefined)
}

async function noteSession(io: SessionIo, name: string, t: number, line: string, answer?: string): Promise<void> {
  const key = sessionKey(name)
  await io.updateActivity(acts => {
    const a = acts[key] ?? { startedAt: t, lastAt: t, log: [] }
    return { ...acts, [key]: { ...a, lastAt: t, log: [...a.log, line].slice(-io.logMax), ...(answer !== undefined && { answer }) } }
  })
}

// One poll: a settled, newer report file goes to the owner; a terminal that went away is told once.
let watching = false
let limitsAt = -Infinity
export async function watchSessions(io: SessionIo): Promise<void> {
  if (watching) return
  watching = true
  try {
    const t = await io.now()
    if (t - limitsAt >= LIMITS_MS) {
      limitsAt = t
      const limits = await codexLimitsNow(io)
      await io.setLimits(limits)
    }
    for (const s of Object.values(await io.sessions())) {
      if (s.status === 'stopped' || s.status === 'exited') continue
      const st = await io.stat(s.reportFile).catch(() => undefined)
      if (st !== undefined && st.mtimeMs > (s.reportAt ?? 0) && t - st.mtimeMs >= SETTLE_MS) {
        const report = String(await io.read(s.reportFile).catch(() => '')).trim()
        if (report !== '') {
          await io.updateSessions(all => ({ ...all, [s.name]: { ...all[s.name]!, status: 'reported' as const, reportAt: st.mtimeMs } }))
          await noteSession(io, s.name, t, 'reported', report)
          await io.log({ event: 'report', agent: s.name, owner: s.ownerName, text: report.split('\n').pop() ?? '' })
          await tellOwner(io, s, reportMessage(s, report))
          continue
        }
      }
      // A running harness whose screen stopped changing is told once as idle; a change wakes it again.
      // Idle is told once per quiet spell: the harness's own log says its turn ended, or (for any
      // harness) its screen stopped changing; either way with no report written since.
      if ((s.status === 'running' || s.status === 'idle') && t - (s.lookedAt ?? s.startedAt) >= LOOK_MS) {
        const [screen, digest] = await Promise.all([sessionScreen(io, s), refreshDigest(io, s, t)])
        if (screen !== undefined) {
          const hash = screenHash(screen)
          const changed = hash !== s.screen
          const since = changed ? t : s.screenAt ?? t
          const reported = s.reportAt ?? 0
          const ended = digest?.turnDone
          const why = ended !== undefined && t - ended >= TURN_GRACE_MS && reported < ended
            ? { key: `turn:${ended}`, text: `ended its turn ${ago(t - ended)} ago` }
            : !changed && t - since >= IDLE_MS && reported < since
            ? { key: `quiet:${since}`, text: `has shown nothing new for ${ago(t - since)}` }
            : undefined
          const idle = why !== undefined && s.status === 'running' && why.key !== s.idleKey
          const status = changed && s.status === 'idle' ? 'running' as const : idle ? 'idle' as const : s.status
          const text = screen.split('\n').slice(-40).join('\n')
          await io.updateSessions(all => ({
            ...all,
            [s.name]: { ...all[s.name]!, screen: hash, screenAt: since, lookedAt: t, status, screenText: text, ...(idle && { idleKey: why!.key }) },
          }))
          if (idle) {
            await noteSession(io, s.name, t, 'idle')
            await tellOwner(io, s, idleMessage(s, why!.text, text, digest?.lastWords))
          }
        }
      }
      if (t - (s.checkedAt ?? s.startedAt) < ALIVE_MS) continue
      const alive = await sessionAlive(io, s)
      await io.updateSessions(all => ({ ...all, [s.name]: { ...all[s.name]!, checkedAt: t, ...(!alive && { status: 'exited' as const }) } }))
      if (!alive) {
        const tail = await sessionTail(io, s, 30)
        await noteSession(io, s.name, t, 'ended')
        await tellOwner(io, s, goneMessage(s, tail.exitCode === 0 ? tail.stdout.slice(-3000) : ''))
      }
    }
  } catch (err) {
    await io.warn('watching sessions', err)
  } finally {
    watching = false
  }
}

export async function sessionTool(io: SessionIo, input: Record<string, unknown>, caller: Caller, s: SessionSettings): Promise<string> {
  const action = String(input.action ?? '')
  if (action === 'start') return startSession(io, input, caller, s)
  const all = await io.sessions()
  if (action === 'list') {
    const list = Object.values(all).sort((a, b) => a.startedAt - b.startedAt)
    return list.length === 0 ? 'No sessions.' : list.map(x => `${sessionLine(x)}, owner ${x.ownerName}`).join('\n')
  }
  const name = String(input.name ?? '')
  const ss = all[name]
  if (ss === undefined) return `No session named "${name}". action "list" shows them.`
  const t = await io.now()
  if (action === 'read') {
    const lines = Math.min(1000, Math.max(10, Math.round(Number(input.lines) || 80)))
    const r = await sessionTail(io, ss, lines)
    if (r.exitCode !== 0) return `Could not read ${name}'s terminal: ${why(r)}`
    return r.stdout.length > 12_000 ? `…${r.stdout.slice(-12_000)}` : r.stdout || '(empty)'
  }
  if (action === 'send') {
    const text = String(input.text ?? '').trim()
    if (text === '') return 'Refused: text is empty.'
    if (ss.status === 'stopped' || ss.status === 'exited') return `Refused: ${name} has ${ss.status}. Start a new session to go on.`
    const r = await typeInto(io, ss, text)
    if (r.exitCode !== 0) return `Could not send to ${name}: ${why(r)}`
    await io.updateSessions(x => ({ ...x, [name]: { ...x[name]!, status: 'running' as const } }))
    await noteSession(io, name, t, `message: ${text.replace(/\s+/g, ' ').slice(0, 80)}`)
    return `Sent to ${name}. Its next report comes to you as a "flow session:" message.`
  }
  if (action === 'keys') {
    const keys = String(input.keys ?? '').trim()
    if (keys === '') return 'Refused: keys is empty. Named keys: enter, escape, interrupt, tab, up, down, left, right, backspace, space; any other word is typed as it is.'
    if (ss.status === 'stopped' || ss.status === 'exited') return `Refused: ${name} has ${ss.status}.`
    const k = keysOf(keys)
    const r = ss.host === 'tmux'
      ? await io.run(['tmux', 'send-keys', '-t', ss.handle, ...k.tmux])
      : await io.run(['orca', 'terminal', 'send', '--terminal', ss.handle, '--text', k.raw, '--json'])
    if (r.exitCode !== 0) return `Could not press keys in ${name}: ${why(r)}`
    await io.updateSessions(x => ({ ...x, [name]: { ...x[name]!, status: 'running' as const } }))
    await noteSession(io, name, t, `keys: ${keys}`)
    return `Pressed ${keys} in ${name}. "read" shows what it did.`
  }
  if (action === 'restart') {
    // In the same terminal: the harness is stopped if it still runs, then its resume line (or its
    // start line with the same prompt) is typed into the shell left behind.
    const line = ss.resume !== undefined ? ss.resume : commandFor(ss.start, ss.promptFile)
    if (ss.host === 'tmux') {
      const alive = await io.run(['tmux', 'has-session', '-t', ss.handle], 10_000)
      if (alive.exitCode !== 0) return `Refused: ${name}'s tmux session is gone. Start a new session (a new name) to go on.`
      // A fresh shell in the same pane, whatever the old harness was doing: no harness's own quit keys needed.
      const fresh = await io.run(['tmux', 'respawn-pane', '-k', '-t', ss.handle, '-c', ss.worktree], 10_000)
      if (fresh.exitCode !== 0) return `Could not restart ${name}: ${why(fresh)}`
      await io.run(['tmux', 'send-keys', '-t', ss.handle, '-l', `unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT; ${line}`])
      await io.run(['tmux', 'send-keys', '-t', ss.handle, 'Enter'])
    } else {
      const r = await io.run(['orca', 'terminal', 'create', '--worktree', `path:${ss.worktree}`, '--title', name, '--command', line, '--json'])
      const h = r.exitCode === 0 ? findHandle(r.stdout) : undefined
      if (h === undefined) return `Could not open a new Orca terminal for ${name}: ${why(r)}`
      await io.run(['orca', 'terminal', 'close', '--terminal', ss.handle, '--json'])
      await io.updateSessions(x => ({ ...x, [name]: { ...x[name]!, handle: h } }))
    }
    await io.updateSessions(x => ({ ...x, [name]: { ...x[name]!, status: 'running' as const, checkedAt: t, lookedAt: t } }))
    await noteSession(io, name, t, ss.resume !== undefined ? 'restarted (resumed)' : 'restarted (fresh)')
    return `Restarted ${name} with ${ss.resume !== undefined ? 'its resume line' : 'its start line and the same prompt'}: ${line}. ` +
      'Tell it what to do next with action "send" once "read" shows it is up.'
  }
  if (action === 'stop') {
    const r = ss.host === 'tmux'
      ? await io.run(['tmux', 'kill-session', '-t', ss.handle])
      : await io.run(['orca', 'terminal', 'close', '--terminal', ss.handle, '--json'])
    const closed = r.exitCode === 0 ? 'Terminal closed.' : `The terminal did not close (${why(r)}); it may be gone already.`
    await io.updateSessions(x => ({ ...x, [name]: { ...x[name]!, status: 'stopped' as const } }))
    await noteSession(io, name, t, 'stopped')
    if (input.remove_worktree !== true) return `Stopped ${name}. ${closed} The worktree ${ss.worktree} stays.`
    // Removed only when nothing in it would be lost: no changes, and HEAD on a remote branch.
    const dirty = (await io.run(['git', '-C', ss.worktree, 'status', '--porcelain'])).stdout.trim() !== ''
    const pushed = (await io.run(['git', '-C', ss.worktree, 'branch', '-r', '--contains', 'HEAD'])).stdout.trim() !== ''
    if (dirty || !pushed) return `Stopped ${name}. ${closed} Kept the worktree ${ss.worktree}: ${dirty ? 'it has uncommitted changes' : 'its commits are not pushed'}.`
    const rm = ss.host === 'tmux'
      ? await io.run(['git', 'worktree', 'remove', ss.worktree])
      : await io.run(['orca', 'worktree', 'rm', '--worktree', `path:${ss.worktree}`, '--json'], 120_000)
    return `Stopped ${name}. ${closed} ${rm.exitCode === 0 ? `Removed the worktree ${ss.worktree}.` : `Kept the worktree ${ss.worktree}: ${why(rm)}`}`
  }
  return `Unknown action "${action}".`
}
