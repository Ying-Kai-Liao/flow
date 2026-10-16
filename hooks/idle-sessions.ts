import type { Handover, Session } from '../types'
import type { Plan } from './dag'
import { sessionKey, sessionLive } from './sessions'

// Terminal sessions that are finished and only hold a terminal: a worker whose PR merged or closed, a manager
// that reported with nothing left open, a reviewer waiting with an empty queue. The occasional sweep stops them
// (session-run.ts stopIdleSessions) just before it sweeps, so their worktrees go in the same pass. Pure: the
// caller gathers the inputs.

// A report or an end this young may still get a follow-up (a message from main or the reviewer), so it waits.
export const IDLE_GRACE_MS = 15 * 60_000

export type PrState = { number: number; headRefName: string; state: string }

export type IdleInputs = {
  sessions: Session[]
  // The names of the sessions this main owns; another main's terminals are never stopped here.
  owned: Set<string>
  handovers: Handover[]
  // Every PR's branch and state; undefined when gh failed: no worker is stopped then.
  prs: PrState[] | undefined
  // The names with an open blocking ask in the inbox (askingNames).
  asking: string[]
  plans: Plan
  agents: { id: string; name?: string; status: string; parentId?: string }[]
  now: number
}

export type IdleStop = { name: string; reason: string }

// An agent that may still be working: running, waiting, or idle between turns (clean.ts isLive).
const LIVE = new Set(['pending', 'running', 'waiting', 'idle'])
// A handover still in the queue: everything but done and returned. An approval or a batch awaiting /flow push
// would reach a fresh reviewer too (ensureQueue), but the one waiting is kept for it.
const QUEUED = new Set(['pending', 'awaiting', 'taken', 'ready'])

// A name and its continuations (`<name>-N`) are one line of work.
const sameLine = (name: string, other: string | undefined): boolean =>
  other !== undefined && (other === name || (other.startsWith(`${name}-`) && /^\d+$/.test(other.slice(name.length + 1))))

// Since when a session has had nothing new: its report, its last screen change while idle, or its end. Undefined
// when its record does not say, which never counts as long enough.
export function quietSince(s: Session): number | undefined {
  if (s.status === 'reported') return s.reportAt
  if (s.status === 'idle') {
    const at = Math.max(s.reportAt ?? 0, s.screenAt ?? 0)
    return at === 0 ? undefined : at
  }
  if (s.status === 'exited' || s.status === 'stopped') return s.endedAt ?? s.checkedAt ?? s.startedAt
  return undefined
}

const settled = (s: Session, now: number): boolean => {
  const at = quietSince(s)
  return at !== undefined && now - at >= IDLE_GRACE_MS
}

// Why a worker session may stop, or undefined to keep it. Reported or exited, its own PR (exactly its branch: a
// `-N` branch is another worker's PR) merged or closed, and nothing about it still open.
function workerStop(s: Session, i: IdleInputs): string | undefined {
  if (s.status !== 'reported' && s.status !== 'exited') return undefined
  if (i.prs === undefined) return undefined
  if (i.handovers.some(h => QUEUED.has(h.status) && (h.branch === s.branch || h.reportTo === s.name))) return undefined
  if (i.asking.includes(s.name)) return undefined
  const prs = i.prs.filter(p => p.headRefName === s.branch)
  // No PR yet (a HANDOFF successor may still open one) or one still open (it may come back with fixes): kept.
  if (prs.length === 0 || prs.some(p => p.state === 'OPEN')) return undefined
  const merged = prs.find(p => p.state === 'MERGED')
  const p = merged ?? prs.find(p => p.state === 'CLOSED')
  return p === undefined ? undefined : `PR #${p.number} ${merged !== undefined ? 'merged' : 'closed'}`
}

// A manager stops only after its final report, with no live worker, nothing queued for the reviewer, no open PR
// of its workers, no open ask and no open plan node. `stopping`: workers stopped in this same pass.
function managerStop(m: Session, i: IdleInputs, stopping: Set<string>): string | undefined {
  if (m.status !== 'reported') return undefined
  const workers = i.sessions.filter(s => s.role === undefined && (s.owner === sessionKey(m.name) || s.ownerName === m.name))
  if (workers.some(s => sessionLive(s) && !stopping.has(s.name))) return undefined
  if (i.agents.some(a => a.parentId === sessionKey(m.name) && LIVE.has(a.status))) return undefined
  const names = workers.map(s => s.name)
  const branches = new Set(workers.map(s => s.branch))
  const mine = (who: string | undefined) => sameLine(m.name, who) || (who !== undefined && names.includes(who))
  if (i.handovers.some(h => QUEUED.has(h.status) && (mine(h.reportTo) || branches.has(h.branch)))) return undefined
  // gh unknown: the PR check is skipped, the others still hold it.
  if ((i.prs ?? []).some(p => p.state === 'OPEN' && branches.has(p.headRefName))) return undefined
  if (i.asking.some(mine)) return undefined
  const family = m.name.replace(/-\d+$/, '')
  const graph = i.plans[m.name] ?? i.plans[family] ?? {}
  if (Object.values(graph).some(n => n.state === 'waiting' || n.state === 'ready' || n.state === 'running')) return undefined
  return 'manager reported, nothing left open'
}

function reviewerStop(r: Session, i: IdleInputs): string | undefined {
  if (r.status !== 'reported' && r.status !== 'idle') return undefined
  if (i.handovers.some(h => QUEUED.has(h.status))) return undefined
  return 'reviewer waiting, no handover queued'
}

// The sessions to stop now, each with why. Workers first, so a manager whose last workers stop in this pass
// stops with them.
export function idleSessions(i: IdleInputs): IdleStop[] {
  const candidates = i.sessions.filter(s => i.owned.has(s.name) && settled(s, i.now))
  const out: IdleStop[] = []
  for (const s of candidates) {
    if (s.role !== undefined) continue
    const reason = workerStop(s, i)
    if (reason !== undefined) out.push({ name: s.name, reason })
  }
  const stopping = new Set(out.map(x => x.name))
  for (const s of candidates) {
    const reason = s.role === 'manager' ? managerStop(s, i, stopping) : s.role === 'reviewer' ? reviewerStop(s, i) : undefined
    if (reason !== undefined) out.push({ name: s.name, reason })
  }
  return out
}

// gh's `pr list --json number,headRefName,state` answer; undefined when it is not one.
export function parsePrStates(stdout: string): PrState[] | undefined {
  try {
    const v = JSON.parse(stdout || '[]') as unknown
    if (!Array.isArray(v)) return undefined
    return (v as PrState[]).filter(p => typeof p?.number === 'number' && typeof p.headRefName === 'string' && typeof p.state === 'string')
  } catch {
    return undefined
  }
}

// Ended sessions in `session list`: one short line each for the last ENDED_SHOWN_MS, a count for the older ones.
export const ENDED_SHOWN_MS = 24 * 3600_000

export const endedAt = (s: Session): number => s.endedAt ?? s.checkedAt ?? s.startedAt
