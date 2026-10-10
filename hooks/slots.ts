import type { AgentRow, SlotEntry, TestSlots } from '../types'
import { ENDED } from './deliver'

// A hook has a 10 s budget, a $.clock wait included, so acquire blocks only briefly. A free slot
// is granted to the head waiter at once (claimed: false); it has CLAIM_MS to confirm with acquire,
// else the grant passes on. The grant is signalled by a file and a message, so waiting costs no turns.
export const LEASE_MS = 45 * 60_000
export const CLAIM_MS = 2 * 60_000
export const WAIT_MAX_S = 8
export const WAIT_DEFAULT_S = 2

// The grant file of a waiter, under the slot directory `dir`; undefined when there is none.
export const grantFile = (dir: string | undefined, key: string): string | undefined => dir && `${dir}/${key.replace(/[^\w.-]/g, '_')}.granted`

export const span = (ms: number): string => {
  const m = Math.floor(ms / 60_000)
  return m < 1 ? `${Math.max(0, Math.round(ms / 1000))}s` : `${m}m`
}
export const heldBy = (h: SlotEntry, t: number): string => `${h.name} (${h.label}, ${span(t - h.since)})`

// Drops holders and waiters whose agent ended or is gone and holders past the lease. The main session (key "main") never ends. Returns the new state and what was dropped.
export function reapSlots(state: TestSlots, rows: AgentRow[], t: number): { state: TestSlots; notes: string[] } {
  const status = new Map(rows.map(a => [a.id, a.status]))
  const gone = (key: string) => key !== 'main' && (status.get(key) === undefined || ENDED.has(status.get(key)!))
  const notes: string[] = []
  const holders = state.holders.filter(h => {
    if (gone(h.key)) return false
    if (t - h.since >= LEASE_MS) {
      notes.push(`test slot of ${h.name} (${h.label}) released after ${span(LEASE_MS)}: its lease ran out`)
      return false
    }
    return true
  })
  const waiters = state.waiters.filter(w => !gone(w.key))
  const changed = holders.length !== state.holders.length || waiters.length !== state.waiters.length
  return { state: changed ? { holders, waiters } : state, notes }
}

// Gives free slots to the head waiters, after dropping grants nobody confirmed within CLAIM_MS.
// Pure: the caller does the signalling for `granted`.
export function grantSlots(state: TestSlots, limit: number, t: number): { state: TestSlots; granted: SlotEntry[]; notes: string[] } {
  const notes: string[] = []
  const holders = state.holders.filter(h => {
    if (h.claimed !== false || t - h.since < CLAIM_MS) return true
    notes.push(`test slot offered to ${h.name} (${h.label}) passed on: not confirmed within ${span(CLAIM_MS)}`)
    return false
  })
  const waiters = [...state.waiters]
  const granted: SlotEntry[] = []
  while (holders.length < limit && waiters.length > 0) {
    const w = { ...waiters.shift()!, since: t, claimed: false }
    holders.push(w)
    granted.push(w)
  }
  const changed = holders.length !== state.holders.length || granted.length > 0
  return { state: changed ? { holders, waiters } : state, granted, notes }
}

export function slotLine(state: TestSlots, limit: number, t: number): string {
  if (state.holders.length === 0 && state.waiters.length === 0) return ''
  const held = state.holders.length ? `held by ${state.holders.map(h => heldBy(h, t)).join(', ')}` : 'free'
  return `Test slots: ${state.holders.length}/${limit} ${held}${state.waiters.length ? ` · ${state.waiters.length} waiting` : ''}`
}
