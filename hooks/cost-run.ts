import type { Ledger } from '../types'
import { costBlock, EPOCH_KEY, epochOf, diffLedger, mergeLedgers, normalizeLedger, prCost, pruneLedger, reportSuffix } from './cost'

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
  // What this process counted since its last save (the ledger atom holds base + these). Atoms too, so a reload keeps them.
  delta: () => Promise<Ledger>
  updateDelta: (fn: (l: Ledger) => Ledger) => Promise<void>
  // The epoch of the file the in-memory base came from ('' for a file without one).
  epoch: () => Promise<string>
  setEpoch: (e: string) => Promise<void>
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
// Changes and saves run one after another, so a step counted while a save is in flight lands in the next one.
let ledgerChain: Promise<unknown> = Promise.resolve()
const inChain = <T,>(fn: () => Promise<T>): Promise<T> => {
  const run = ledgerChain.then(fn, fn)
  ledgerChain = run.catch(() => undefined)
  return run
}

// A plugin reload starts with this undefined again; tests call it to simulate one.
export function forgetLedgerLoad(): void { ledgerLoad = undefined; ledgerSaveDue = false }

export function loadLedger(io: CostIo): Promise<void> {
  ledgerLoad ??= (async () => {
    try {
      if (await io.loaded()) return
      const dir = await io.stateDir()
      if (dir === undefined) return
      const raw = await io.readJson(`${dir}/ledger.json`)
      const now = await io.now()
      await io.updateLedger(cur => pruneLedger(mergeLedgers(normalizeLedger(raw), cur), now))
      await io.setEpoch(epochOf(raw))
      await io.markLoaded()
    } catch {
      // No history: count from here.
    }
  })()
  return ledgerLoad
}

// The file is the truth: write disk + this process's unsaved deltas, under the file's epoch, and make the
// in-memory view equal that. A rebuilt or otherwise newer file therefore replaces the old base instead of
// being overwritten by it. A file that is missing or does not parse counts as empty (readJson cannot tell
// the two apart). On a failed write nothing changes and the deltas wait for the next save.
export function saveLedger(io: CostIo): Promise<void> {
  return inChain(() => saveNow(io))
}
async function saveNow(io: CostIo): Promise<void> {
  try {
    const dir = await io.stateDir()
    if (dir === undefined) return
    await io.mkdirp(dir)
    const path = `${dir}/ledger.json`
    const raw = await io.readJson(path)
    const now = await io.now()
    const epoch = epochOf(raw) || `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    // The delta first: its names, sizes and times win over the disk's, the counts add.
    const merged = pruneLedger(mergeLedgers(await io.delta(), normalizeLedger(raw)), now)
    if (!(await io.writeJsonAtomic(path, { [EPOCH_KEY]: epoch, ...merged }))) return
    await io.updateLedger(() => merged)
    await io.updateDelta(() => ({}))
    await io.setEpoch(epoch)
  } catch {
    // The meter is best-effort.
  }
}

// Every step changes the ledger; the file is written at most every few seconds.
export async function changeLedger(io: CostIo, fn: (l: Ledger, now: number) => Ledger): Promise<void> {
  await loadLedger(io)
  await inChain(async () => {
    const now = await io.now()
    const before = await io.ledger()
    const after = fn(before, now)
    await io.updateLedger(() => after)
    // Not fn(delta): a key missing from the delta would get a default identity that overrides the real one on merge.
    const d = diffLedger(before, after)
    if (Object.keys(d).length > 0) await io.updateDelta(cur => mergeLedgers(d, cur))
  })
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
