import type { Session } from '../types'
import { lastLineAsks, REPORT_HINT } from './askcards'
import { ancestorPids } from './clean'
import { parseMode } from './mergemode'
import { ownerVerdict } from './relay'
import type { MainIdentity } from './relay'
import type { Ran } from './session-run'
import { sessionKey, sessionLive } from './sessions'

// Terminal role sessions (managers and the reviewer running as their own claude): who owns them, the sessions
// file, and what happens when one reports or goes away. The engine handle `$` is never passed across an import,
// so register.tsx hands in a RoleIo; the same pattern as session-run.ts.

export type RoleIo = {
  run: (argv: string[], timeoutMs: number) => Promise<Ran>
  now: () => Promise<number>
  sessionId: () => Promise<string | undefined>
  sessions: () => Promise<Record<string, Session>>
  updateSessions: (fn: (all: Record<string, Session>) => Record<string, Session>) => Promise<unknown>
  stateDir: () => Promise<string | undefined>
  readJson: (path: string) => Promise<unknown>
  writeJson: (path: string, obj: unknown) => Promise<boolean>
  mkdirp: (dir: string) => Promise<unknown>
  best: (what: string, fn: () => Promise<void>) => Promise<void>
  warn: (what: string, err: unknown) => Promise<void>
  toMain: (text: string) => void
  refresh: () => Promise<unknown>
  askCards: () => boolean
  // The merge mode of the settings as last loaded, and whether any are held yet.
  heldMergeMode: () => string | undefined
  heldSettings: () => boolean
  batchReady: () => Promise<boolean>
  stopTerminal: (name: string) => Promise<void>
  reviewerRan: (id: string, name: string, end: { answer: string }, ended: boolean) => Promise<void>
  relayReviewerReport: (id: string, name: string, answer: string) => Promise<void>
  reviewerEnded: (name: string, end: { answer: string }) => Promise<void>
}

// Module state, single: only the code below uses it, but register() writes `saved` when it reloads the file.
export const roleState = {
  // The sessions record on disk (<state dir>/sessions.json) as last saved; written only when it changed, so a
  // reload re-reads it.
  saved: '',
  identity: undefined as Promise<MainIdentity | undefined> | undefined,
  aliveAt: new Map<number, { at: number; ok: boolean }>(),
  adopting: false,
}

// The sessions record on disk: a main that restarts keeps its terminal sessions, so their relay directories are
// pumped again and their reports still reach their owner.
export async function persistSessionsTo(io: RoleIo): Promise<void> {
  await io.best('saving sessions', async () => {
    const dir = await io.stateDir()
    if (dir === undefined) return
    const durable = durableSessions(await io.sessions())
    const text = JSON.stringify(durable)
    if (text === roleState.saved) return
    roleState.saved = text
    await io.mkdirp(dir)
    await io.writeJson(`${dir}/sessions.json`, durable)
  })
}

// What the file keeps of a session: the live ones, without what changes on every watch tick (screen,
// look times, the digest). The watcher rebuilds those; the file only changes on a real change (start,
// status, report, nudge, stop). An ended session leaves the file, so its name is free again.
const VOLATILE = ['screenText', 'screen', 'screenAt', 'lookedAt', 'checkedAt', 'digest', 'digestSeen'] as const
export function durableSessions(all: Record<string, Session>): Record<string, Session> {
  return Object.fromEntries(Object.entries(all).filter(([, v]) => sessionLive(v)).map(([k, v]) =>
    [k, Object.fromEntries(Object.entries(v).filter(([f]) => !(VOLATILE as readonly string[]).includes(f))) as Session]))
}

const SESSION_KEEP_MS = 24 * 60 * 60_000

// Records of an older or hand-edited file that cannot be a session are dropped, not trusted, and so are
// ended ones and reported workers nobody has touched for a day (their terminal is long gone).
export function normalizeSessions(raw: unknown, now: number): Record<string, Session> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  return Object.fromEntries(Object.entries(raw).filter(([k, v]) => {
    if (typeof v !== 'object' || v === null || (v as { name?: unknown }).name !== k) return false
    const x = v as Session
    if (typeof x.status !== 'string' || !sessionLive(x)) return false
    return !(x.role === undefined && x.status === 'reported' && now - (x.reportAt ?? x.startedAt ?? 0) > SESSION_KEEP_MS)
  })) as Record<string, Session>
}

// --- Who owns a role session (relay.ts, ownerVerdict) ---
// This main: its session id and the pid of its claude process (the nearest one up from the plugin runner's shell).
// undefined when either cannot be read; a main without an identity behaves as before and owns every session.
export function identityTo(io: RoleIo): Promise<MainIdentity | undefined> {
  roleState.identity ??= (async () => {
    const session = await io.sessionId().catch(() => undefined)
    const ppid = Number((await io.run(['sh', '-c', 'echo $PPID'], 5_000)).stdout.trim())
    if (session === undefined || session === '' || !Number.isInteger(ppid) || ppid <= 1) return undefined
    const chain = await ancestorPids(ppid, async pid => {
      const r = await io.run(['ps', '-o', 'ppid=,comm=', '-p', String(pid)], 5_000)
      const m = /^\s*(\d+)\s+(.*)$/.exec(r.stdout.trim())
      return r.exitCode === 0 && m ? { ppid: Number(m[1]), comm: m[2]! } : undefined
    })
    // Insertion order runs from the shell up to the claude process, which is the last.
    return { session, pid: [...chain].pop() ?? ppid }
  })()
  return roleState.identity
}

// Whether a pid is a live process, looked up at most every few seconds per pid (the pump ticks twice a second).
const ALIVE_TTL_MS = 5_000
export async function pidAliveTo(io: RoleIo, pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 1) return false
  const t = await io.now()
  const hit = roleState.aliveAt.get(pid)
  if (hit !== undefined && t - hit.at < ALIVE_TTL_MS) return hit.ok
  const ok = (await io.run(['kill', '-0', String(pid)], 5_000)).exitCode === 0
  roleState.aliveAt.set(pid, { at: t, ok })
  return ok
}

// A role session this main owns; a worker's record has no owner and is nobody's concern here.
export async function ownsSessionTo(io: RoleIo, s: Session): Promise<boolean> {
  if (s.role === undefined) return true
  const me = await identityTo(io)
  return me === undefined || s.mainOwner?.session === me.session
}

// Settles every role session on record, in memory and on disk, against this main: one whose owner is gone
// (or never recorded) is taken over and saved; one a live main owns stays untouched (ownsSession filters it
// out of pumping and watching). Run at load and on the roster poll, so a restarted main takes its terminals back and a
// running one picks up an orphan.
export async function adoptSessionsTo(io: RoleIo): Promise<void> {
  if (roleState.adopting) return
  roleState.adopting = true
  try {
    const me = await identityTo(io)
    const dir = await io.stateDir()
    if (me === undefined || dir === undefined) return
    const disk = normalizeSessions(await io.readJson(`${dir}/sessions.json`), await io.now())
    const mem = await io.sessions()
    const judged = new Map<string, Session>()
    for (const name of new Set([...Object.keys(mem), ...Object.keys(disk)])) {
      const rec = mem[name] ?? disk[name]
      if (rec?.role === undefined || !sessionLive(rec)) continue
      // The file is the later word on the owner: another main may have taken it over since this one loaded it.
      const owner = disk[name]?.mainOwner ?? mem[name]?.mainOwner
      judged.set(name, { ...rec, ...(owner !== undefined && { mainOwner: owner }) })
    }
    const alive = new Map<number, boolean>()
    for (const r of judged.values()) {
      const pid = r.mainOwner?.pid
      if (pid !== undefined && r.mainOwner?.session !== me.session) alive.set(pid, await pidAliveTo(io, pid))
    }
    const verdicts = [...judged].map(([name, r]) => [name, r, ownerVerdict(r.mainOwner, me, pid => alive.get(pid) === true)] as const)
    const take = verdicts.filter(([, , v]) => v === 'adopt')
    if (take.length === 0) return
    await io.updateSessions(all => {
      const out = { ...all }
      for (const [name, r] of take) out[name] = { ...r, mainOwner: me }
      return out
    })
    await persistSessionsTo(io)
  } catch (err) {
    await io.warn('adopting sessions', err)
  } finally {
    roleState.adopting = false
  }
}

// The role sessions this main owns: the live ones, or with `ended` the ended ones too (their relay still answers).
export async function myRoleSessionsTo(io: RoleIo, ended = false): Promise<Session[]> {
  const mine: Session[] = []
  for (const s of Object.values(await io.sessions())) if (s.role !== undefined && (ended || sessionLive(s)) && await ownsSessionTo(io, s)) mine.push(s)
  return mine
}

// A manager's or the reviewer's terminal wrote its report. A manager's goes to main the way an in-process manager's
// final answer does; it is not an end (a terminal manager reports, then waits for the reviewer's messages), so
// nothing is marked finished here.
export async function onRoleReportTo(io: RoleIo, s: Session, report: string): Promise<void> {
  if (s.role === 'manager') {
    io.toMain(`Report from manager ${s.name}:\n${report}${io.askCards() && lastLineAsks(report) ? `\n${REPORT_HINT}` : ''}`)
    return
  }
  const id = sessionKey(s.name)
  const ready = await io.batchReady()
  // Read now, not at the start: merge_mode may have changed while it worked. A batch waiting for /flow push also
  // ends the session; the push run is a fresh reviewer's.
  const oneBatch = parseMode(io.heldMergeMode()) === 'confirm' || ready
  if (!oneBatch || !io.heldSettings()) {
    await io.reviewerRan(id, s.name, { answer: report }, false)
    return
  }
  await io.best('stopping the reviewer terminal', () => io.stopTerminal(s.name))
  await io.reviewerRan(id, s.name, { answer: report }, true)
}

// A manager's or the reviewer's terminal went away. The session is 'exited', so the roster no longer lists it.
export async function onRoleGoneTo(io: RoleIo, s: Session, tail: string): Promise<void> {
  if (s.role === 'manager') {
    io.toMain(`flow session: manager "${s.name}" (${s.host}) ended its terminal. Its session is over; start a new manager if its task is not done.${tail.trim() ? `\nLast terminal lines:\n${tail.trim()}` : ''}`)
    await io.refresh()
    return
  }
  // Work done since its last report would otherwise be lost: main gets the run's summary line.
  await io.best('relaying the reviewer end', () => io.relayReviewerReport(sessionKey(s.name), s.name, 'The reviewer terminal ended without a final report.'))
  await io.reviewerEnded(s.name, { answer: tail.trim() === '' ? 'the terminal ended' : tail })
}
