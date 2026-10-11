import type { Ledger } from '../types'
import { costBlock, mergeLedgers, normalizeLedger, prCost, pruneLedger, reportSuffix } from './cost'

// The cost ledger's disk and atom I/O. The `ledger` atom stays in register.tsx; this takes closures
// over it (the engine refuses `$` across an import).
export type CostIo = {
  stateDir: () => Promise<string | undefined>
  readJson: (path: string) => Promise<unknown>
  writeJsonAtomic: (path: string, obj: unknown) => Promise<boolean>
  mkdirp: (dir: string) => Promise<void>
  now: () => Promise<number>
  after: (ms: number, fn: () => void) => void
  // The ledger atom: read it, or change it with fn.
  ledger: () => Promise<Ledger>
  updateLedger: (fn: (l: Ledger) => Ledger) => Promise<void>
  // Whether the disk history is already in the atom. Lives in an atom too, so it survives a plugin reload like the ledger does.
  loaded: () => Promise<boolean>
  markLoaded: () => Promise<void>
  // When this session started, or undefined when the engine cannot say.
  startedAt: () => Promise<number | undefined>
  liveIds: () => Promise<string[]>
  hasSessions: () => Promise<boolean>
}

// Loaded from disk once, before the first change, so what this run counts is added to the history.
// The promise only dedupes concurrent calls; `io.loaded` is what stops a second merge after a reload
// (the atom still holds the history, the module variable does not, and merging adds tokens).
let ledgerLoad: Promise<void> | undefined
let ledgerSaveDue = false

// A plugin reload starts with this undefined again; tests call it to simulate one.
export function forgetLedgerLoad(): void { ledgerLoad = undefined }

export function loadLedger(io: CostIo): Promise<void> {
  ledgerLoad ??= (async () => {
    try {
      if (await io.loaded()) return
      const dir = await io.stateDir()
      if (dir === undefined) return
      const disk = normalizeLedger(await io.readJson(`${dir}/ledger.json`))
      const now = await io.now()
      await io.updateLedger(cur => pruneLedger(mergeLedgers(disk, cur), now))
      await io.markLoaded()
    } catch {
      // No history: count from here.
    }
  })()
  return ledgerLoad
}

async function saveLedger(io: CostIo): Promise<void> {
  try {
    const dir = await io.stateDir()
    if (dir === undefined) return
    await io.mkdirp(dir)
    await io.writeJsonAtomic(`${dir}/ledger.json`, pruneLedger(await io.ledger(), await io.now()))
  } catch {
    // The meter is best-effort.
  }
}

// Every step changes the ledger; the file is written at most every few seconds.
export async function changeLedger(io: CostIo, fn: (l: Ledger, now: number) => Ledger): Promise<void> {
  await loadLedger(io)
  const now = await io.now()
  await io.updateLedger(l => fn(l, now))
  if (ledgerSaveDue) return
  ledgerSaveDue = true
  io.after(3000, () => { ledgerSaveDue = false; void saveLedger(io) })
}

// Main's entry is per session: the ledger outlives the session, and its steps must not merge with an earlier one's.
export async function mainKey(io: CostIo): Promise<string> {
  return `main@${(await io.startedAt()) ?? 0}`
}

// The cost block of status, or nothing before the first counted step.
export async function costLines(io: CostIo, prs: { pr: number; branch: string }[], keep?: (e: Ledger[string]) => boolean): Promise<string[]> {
  try {
    await loadLedger(io)
    const start = (await io.startedAt()) ?? 0
    const live = new Set(await io.liveIds())
    const all = await io.ledger()
    const led = keep === undefined ? all : Object.fromEntries(Object.entries(all).filter(([, e]) => keep(e)))
    return costBlock(led, prs, await io.hasSessions(), { start, live })
  } catch {
    return []
  }
}

// The reviewer's report with the PR's workers' cost appended, once.
export async function withCost(io: CostIo, branch: string, report: string): Promise<string> {
  if (report.includes('| cost:')) return report
  try {
    await loadLedger(io)
    return `${report}${reportSuffix(prCost(await io.ledger(), branch))}`
  } catch {
    return report
  }
}
