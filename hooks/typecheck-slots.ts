import type { AgentRow, SlotEntry, TestSlots } from '../types'
import { ENDED } from './deliver'
import { grantSlots, grantFile, heldBy, span, CLAIM_MS, WAIT_DEFAULT_S, WAIT_MAX_S } from './slots'
import type { SlotsIo } from './slots-run'
import type { Settings } from './prompts'

// The typecheck pool: the same shape and rules as the test slots, but its own holders, a short
// lease (a typecheck takes a minute, not a suite's 45), and a lighter limit, so a typecheck never
// queues behind a suite.
export const TYPECHECK_LEASE_MS = 10 * 60_000

// Like reapSlots, with the short lease.
export function reapTypecheck(state: TestSlots, rows: AgentRow[], t: number): { state: TestSlots; notes: string[] } {
  const status = new Map(rows.map(a => [a.id, a.status]))
  const gone = (key: string) => key !== 'main' && (status.get(key) === undefined || ENDED.has(status.get(key)!))
  const notes: string[] = []
  const holders = state.holders.filter(h => {
    if (gone(h.key)) return false
    if (t - h.since >= TYPECHECK_LEASE_MS) {
      notes.push(`typecheck slot of ${h.name} (${h.label}) released after ${span(TYPECHECK_LEASE_MS)}: its lease ran out`)
      return false
    }
    return true
  })
  const waiters = state.waiters.filter(w => !gone(w.key))
  const changed = holders.length !== state.holders.length || waiters.length !== state.waiters.length
  return { state: changed ? { holders, waiters } : state, notes }
}

// grantSlots, with its notes worded for this pool.
export function grantTypecheck(state: TestSlots, limit: number, t: number): { state: TestSlots; granted: SlotEntry[]; notes: string[] } {
  const g = grantSlots(state, limit, t)
  return { ...g, notes: g.notes.map(n => n.replace('test slot', 'typecheck slot')) }
}

// Grant files of the typecheck pool live beside the test pool's, in a subdirectory.
export const typecheckDir = (dir: string | undefined): string | undefined => dir && `${dir}/typecheck`

export function typecheckLine(state: TestSlots, limit: number, t: number): string {
  if (state.holders.length === 0 && state.waiters.length === 0) return ''
  const held = state.holders.length ? `held by ${state.holders.map(h => heldBy(h, t)).join(', ')}` : 'free'
  return `Typecheck slots: ${state.holders.length}/${limit} ${held}${state.waiters.length ? ` · ${state.waiters.length} waiting` : ''}`
}

// test_slot with kind "typecheck": acquire, release, status on the typecheck pool.
export async function typecheckSlotTool(io: SlotsIo, settings: Settings, input: Record<string, unknown>, rows: AgentRow[], key: string, name: string): Promise<{ result: string }> {
  const action = String(input.action)
  const label = typeof input.label === 'string' && input.label.trim() !== '' ? input.label.trim().slice(0, 60) : 'typecheck'
  const limit = settings.typecheckSlots ?? 1
  const t = await io.now()
  const slots = io.typecheckSlots!
  const settle = io.settleTypecheck!

  if (action === 'status') {
    return { result: typecheckLine(await slots(), limit, t) || `Typecheck slots: 0/${limit} held, nobody waiting.` }
  }
  if (action === 'release') {
    let freed = false
    await settle(rows, t, st => {
      freed = st.holders.some(h => h.key === key)
      return freed ? { ...st, holders: st.holders.filter(h => h.key !== key) } : st
    })
    return { result: freed ? 'Released your typecheck slot.' : 'You held no typecheck slot; nothing to release.' }
  }
  if (action !== 'acquire') return { result: `Unknown action "${action}".` }

  // Check and take inside one update(), so two callers never both get the last slot.
  const attempt = async (): Promise<string | undefined> => {
    let already: SlotEntry | undefined
    const at = await io.now()
    await settle(rows, at, st => {
      already = st.holders.find(h => h.key === key)
      if (already || st.waiters.some(w => w.key === key)) return st
      return { ...st, waiters: [...st.waiters, { key, name, label, since: at }] }
    }, key)
    if (already?.claimed === true) {
      return `You already hold a typecheck slot (${already.label}, ${span(at - already.since)}). Release it when the typecheck is over.`
    }
    const st = await slots()
    if (!st.holders.some(h => h.key === key)) return undefined
    return `Typecheck slot granted (${st.holders.length}/${limit}). Run it, then release the slot, also if it fails. It frees by itself after ${span(TYPECHECK_LEASE_MS)}.`
  }

  const wait = Math.min(WAIT_MAX_S, Math.max(0, Number.isFinite(Number(input.wait_s)) ? Number(input.wait_s) : WAIT_DEFAULT_S))
  const first = await attempt()
  if (first !== undefined) return { result: first }
  for (let waited = 0; waited < wait; waited++) {
    await io.sleep(1000)
    await io.refresh()
    const got = await attempt()
    if (got !== undefined) return { result: got }
  }
  const st = await slots()
  const pos = st.waiters.findIndex(w => w.key === key) + 1
  const f = grantFile(typecheckDir(io.slotDir()), key)
  return {
    result: `No typecheck slot after ${wait} s; queued, position ${pos}. Held by ${st.holders.map(h => heldBy(h, t)).join(', ') || 'nobody'}. You keep your place and are granted the slot when it is your turn (it is offered for ${span(CLAIM_MS)}). Don't poll acquire. ${f ? `Wait with Bash: until [ -e '${f}' ]; do sleep 3; done . Or do other work; a "your typecheck slot is granted" message arrives.` : 'Do other work; a "your typecheck slot is granted" message arrives.'} Then call acquire (kind "typecheck") once to confirm, run, and release.`,
  }
}
