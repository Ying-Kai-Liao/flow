import type { AgentRow, LogEvent, SlotEntry, TestSlots } from '../types'
import type { Settings } from './prompts'
import { grantFile, heldBy, slotLine, span, CLAIM_MS, LEASE_MS, WAIT_DEFAULT_S, WAIT_MAX_S } from './slots'
import { noteRelease } from './testfail'
import type { TestFails } from './testfail'
import { labelOf } from './meter'

// The test_slot tool. The engine refuses `$` across an import, so register.tsx builds a SlotsIo of
// closures over the calls this needs.
export type SlotsIo = {
  refresh: () => Promise<AgentRow[]>
  now: () => Promise<number>
  sleep: (ms: number) => Promise<void>
  slots: () => Promise<TestSlots>
  settleSlots: (rows: AgentRow[], t: number, pre?: (s: TestSlots) => TestSlots, me?: string) => Promise<void>
  best: (what: string, fn: () => Promise<void>) => Promise<void>
  testFails: () => Promise<TestFails>
  setTestFails: (state: TestFails) => Promise<void>
  appendLog: (event: Omit<LogEvent, 'ts'>) => Promise<void>
  slotDir: () => string | undefined
}

export async function testSlotTool(io: SlotsIo, settings: Settings, input: Record<string, unknown>): Promise<{ result: string }> {
    const action = String(input.action)
    const key = typeof input.agentId === 'string' ? input.agentId : 'main'
    const rows = await io.refresh()
    const name = key === 'main' ? 'main' : labelOf(rows.find(a => a.id === key) ?? { id: key, description: '', type: '', status: '' })
    const label = typeof input.label === 'string' && input.label.trim() !== '' ? input.label.trim().slice(0, 60) : 'tests'
    const limit = settings.testSlots
    const t = await io.now()

    if (action === 'status') {
      return { result: slotLine(await io.slots(), limit, t) || `Test slots: 0/${limit} held, nobody waiting.` }
    }
    if (action === 'release') {
      let freed = false
      await io.settleSlots(rows, t, st => {
        freed = st.holders.some(h => h.key === key)
        return freed ? { ...st, holders: st.holders.filter(h => h.key !== key) } : st
      })
      let noted = ''
      await io.best('recording a test result', async () => {
        const n = noteRelease(await io.testFails(), key, label, input.result, input.failed_tests)
        if (n.event === undefined) return
        await io.setTestFails(n.state)
        await io.appendLog({ event: n.event.kind, owner: name, agent: name, text: n.event.text })
        noted = ` ${n.answer}`
      })
      return { result: `${freed ? 'Released your test slot.' : 'You held no test slot; nothing to release.'}${noted}` }
    }
    if (action !== 'acquire') return { result: `Unknown action "${action}".` }

    // Check and take inside one update(), so two callers never both get the last slot. A holder
    // whose grant is still unclaimed confirms it here.
    const attempt = async (): Promise<string | undefined> => {
      let already: SlotEntry | undefined
      const at = await io.now()
      await io.settleSlots(rows, at, st => {
        already = st.holders.find(h => h.key === key)
        if (already || st.waiters.some(w => w.key === key)) return st
        return { ...st, waiters: [...st.waiters, { key, name, label, since: at }] }
      }, key)
      if (already?.claimed === true) {
        return `You already hold a test slot (${already.label}, ${span(at - already.since)}). Release it when your run is over.`
      }
      const st = await io.slots()
      if (!st.holders.some(h => h.key === key)) return undefined
      return `Test slot granted (${st.holders.length}/${limit}). Run, then release it, also if the run fails. It frees by itself after ${span(LEASE_MS)}.`
    }

    const wait = Math.min(WAIT_MAX_S, Math.max(0, Number.isFinite(Number(input.wait_s)) ? Number(input.wait_s) : WAIT_DEFAULT_S))
    const first = await attempt()
    if (first !== undefined) return { result: first }
    // The hook's budget bounds this wait; the waiter keeps its place in line between calls.
    for (let waited = 0; waited < wait; waited++) {
      await io.sleep(1000)
      await io.refresh()
      const got = await attempt()
      if (got !== undefined) return { result: got }
    }
    const st = await io.slots()
    const pos = st.waiters.findIndex(w => w.key === key) + 1
    const f = grantFile(io.slotDir(), key)
    return {
      result: `No slot after ${wait} s; queued, position ${pos}. Held by ${st.holders.map(h => heldBy(h, t)).join(', ') || 'nobody'}. You keep your place and are granted the slot when it is your turn (it is offered for ${span(CLAIM_MS)}). Don't poll acquire. ${f ? `Wait with Bash (timeout 600000, or run_in_background and continue when notified): until [ -e '${f}' ]; do sleep 3; done . Or do other work; a "your test slot is granted" message arrives.` : 'Do other work; a "your test slot is granted" message arrives.'} Then call acquire once to confirm, run, and release.`,
    }
}
