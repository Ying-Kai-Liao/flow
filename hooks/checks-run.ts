// The check tool: person checks listed, passed, failed or skipped by main or the reviewer. The engine refuses
// `$` across an import, so register.tsx builds a ChecksIo of closures (checksIoOf).
import { isReviewer } from './core'
import { closeChecks, markStarted, renderChecksForAgents } from './checks'
import type { Checks } from './checks'

export type ChecksIo = {
  agents: () => Promise<Array<{ id: string; type: string; name?: string }>>
  checks: () => Promise<Checks>
  now: () => Promise<number>
  withChecks: <T>(fn: (cur: Checks) => { checks: Checks; out: T }) => Promise<T>
}

export async function checkTool(io: ChecksIo, installed: string | undefined, input: Record<string, unknown>, agentId: string | undefined): Promise<{ result: string }> {
  const me = agentId === undefined ? undefined : (await io.agents()).find(a => a.id === agentId)
  const isMain = agentId === undefined
  if (!isMain && !(me && isReviewer(me.type))) return { result: 'Refused: only main closes person checks. Tell main in your report.' }
  const action = String(input.action ?? 'list')
  if (action === 'list') return { result: renderChecksForAgents(await io.checks(), installed) }
  const t = await io.now()
  if (action === 'pass' || action === 'fail' || action === 'skip') {
    const ids = Array.isArray(input.ids) ? input.ids.map(String) : typeof input.id === 'string' ? [input.id] : []
    const by = isMain ? 'main' : (me?.name ?? 'reviewer')
    const note = typeof input.note === 'string' ? input.note : undefined
    return { result: await io.withChecks(cur => {
      const r = closeChecks(cur, ids, action, by, note, t, !isMain)
      return 'error' in r ? { checks: cur, out: `Refused: ${r.error}` } : { checks: r.checks, out: r.text }
    }) }
  }
  if (action === 'started') {
    if (!isMain) return { result: 'Refused: only main marks a follow-up started.' }
    return { result: await io.withChecks(cur => {
      const r = markStarted(cur, String(input.id ?? ''), String(input.manager ?? ''))
      return 'error' in r ? { checks: cur, out: `Refused: ${r.error}` } : { checks: r.checks, out: r.text }
    }) }
  }
  return { result: 'Unknown action: use list, pass, fail, skip or started.' }
}
