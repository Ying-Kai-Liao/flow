// Replay of flow's own history through the decision API (decide.ts) for the four questions of decide-questions.ts:
// the datasets from .git/flow (and, when given, transcript events), the scoring, and the report text. Pure: files are
// read by the caller, the provider is an injected `ask`, so tests need no network and no disk. The live run is the
// main-only `decide_eval` tool (register.tsx); scripts/decide-eval.mjs builds the same datasets for a dry run.
// A results object holds record ids, labels, answers and confidences, never a record's text.
import { costOf } from './cost'
import type { Decision, Question } from './decide'
import { HANDOFF_QUESTION, INBOX_ROUTINE_QUESTION, MERGE_CONFLICT_QUESTION, TEST_FAILURE_QUESTION, textOfConflict, textOfHandoff, textOfInbox, textOfTestFailure } from './decide-questions'

export type FeatureKey = 'inbox' | 'test' | 'conflict' | 'handoff'
export const FEATURES: FeatureKey[] = ['inbox', 'test', 'conflict', 'handoff']
export const THRESHOLDS = [0.5, 0.7, 0.8, 0.9]
export const QUESTIONS: Record<FeatureKey, Question> = { inbox: INBOX_ROUTINE_QUESTION, test: TEST_FAILURE_QUESTION, conflict: MERGE_CONFLICT_QUESTION, handoff: HANDOFF_QUESTION }

export type LogLine = { ts?: string; event: string; owner?: string; agent?: string; branch?: string; pr?: number; text?: string }
export type EvalRecord = { id: string; text: string; label: string; baseline?: string; agent?: boolean }
export type Dataset = { key: FeatureKey; records: EvalRecord[]; guard?: EvalRecord[]; notes: string[] }

// Light events of one transcript, in order (scripts/decide-eval.mjs extracts them; the tool has none).
export type TranscriptEvent =
  | { t: 'agent'; model: string; type: string; prompt: string }
  | { t: 'edit' }
  | { t: 'result'; id: string; text: string }

type InboxItem = { id: string; owner?: string; question?: string; context?: string; options?: string[]; default?: string; blocking?: boolean; kind?: string; topic?: string; state?: string; answer?: string }
const recOf = (i: InboxItem) => ({ question: i.question ?? '', ...(i.context !== undefined ? { context: i.context } : {}), options: i.options ?? [], ...(i.default !== undefined ? { default: i.default } : {}), ...(i.owner !== undefined ? { owner: i.owner } : {}), ...(i.topic !== undefined ? { topic: i.topic } : {}), ...(i.blocking !== undefined ? { blocking: i.blocking } : {}), ...(i.kind !== undefined ? { kind: i.kind } : {}) })

export function inboxData(items: InboxItem[]): Dataset {
  const answered = items.filter(i => i.state === 'answered')
  const fyi = answered.filter(i => i.kind === 'fyi')
  const labelled = fyi.filter(i => typeof i.answer === 'string' && i.answer.trim() !== '')
  const records = labelled.map(i => ({ id: i.id, text: textOfInbox(recOf(i)), label: (i.answer ?? '').trim() === 'Keep' ? 'keep' : 'undo' }))
  // Everything that is not a decision to keep or undo must come back ask_main.
  const guard = answered.filter(i => i.kind !== 'fyi').map(i => ({ id: i.id, text: textOfInbox(recOf(i)), label: 'ask_main' }))
  return { key: 'inbox', records, guard, notes: [`fyi answered: ${fyi.length}, skipped (empty answer): ${fyi.length - labelled.length}`, `non-fyi answered (must-not-auto-answer check): ${guard.length}`] }
}

const TRIVIAL = /^(?:.*\/)?(?:CHANGELOG\.md|plugin\.json|package(?:-lock)?\.json|marketplace\.json)$/
export const isTrivialFile = (f: string): boolean => TRIVIAL.test(f)
const conflictFiles = (text: string): string[] => {
  const files = new Set<string>()
  for (const m of text.matchAll(/^CONFLICT \([^)]*\):.*?(?:Merge conflict in|\bin) (\S+)\s*$/gm)) files.add(m[1]!)
  return [...files]
}

// The conflict records: reviewer "kept both sides in <files>" reports, plus `git merge` results in transcripts when given.
export function conflictData(log: LogLine[], transcripts: TranscriptEvent[][] = []): Dataset {
  const records: EvalRecord[] = []
  const seen = new Set<string>()
  let fromTranscripts = 0
  for (const evs of transcripts) {
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i]!
      if (e.t !== 'result' || !/CONFLICT \(/.test(e.text) || !/Automatic merge failed|Auto-merging/.test(e.text)) continue
      const files = conflictFiles(e.text)
      if (files.length === 0 || seen.has(e.id)) continue
      seen.add(e.id)
      let hunks = ''
      for (let k = i + 1; k < Math.min(evs.length, i + 8); k++) {
        const x = evs[k]!
        if (x.t === 'result' && /<<<<<<<|^@@ /m.test(x.text)) hunks += `${x.text.slice(0, 3000)}\n`
      }
      let agent = false
      for (let k = i + 1; k < evs.length && k <= i + 80; k++) {
        const x = evs[k]!
        if (x.t === 'result' && /CONFLICT \(/.test(x.text)) break
        if (x.t === 'agent' && /conflict/i.test(x.prompt) && (/opus/i.test(x.model) || x.type === 'general-purpose' || x.type === '')) { agent = true; break }
      }
      const trivialFiles = files.every(isTrivialFile)
      records.push({ id: `tr-${records.length + 1}`, text: textOfConflict({ files, hunks }), label: !agent && trivialFiles ? 'trivial' : 'needs_agent', baseline: trivialFiles ? 'trivial' : 'needs_agent', agent })
      fromTranscripts++
    }
  }
  for (const x of log.filter(l => l.event === 'done' && /kept both sides in/.test(l.text ?? ''))) {
    const part = (x.text ?? '').split('kept both sides in')[1]!.split('|')[0]!
    const files = [...new Set(part.match(/[\w./-]+\.(?:tsx|ts|mjs|json|md|js)\b/g) ?? [])]
    if (files.length === 0) continue
    const agent = /sub-?agent/i.test(part)
    const trivialFiles = files.every(isTrivialFile)
    records.push({ id: `log-pr${x.pr}`, text: textOfConflict({ files }), label: !agent && trivialFiles ? 'trivial' : 'needs_agent', baseline: trivialFiles ? 'trivial' : 'needs_agent', agent })
  }
  return { key: 'conflict', records, notes: [`conflicts from transcripts: ${fromTranscripts}, from reviewer reports in log.jsonl: ${records.length - fromTranscripts}`, 'label rule: trivial iff every file is a changelog or version file and no conflict agent started; the baseline rule uses the file list alone, so it agrees by construction wherever no agent started'] }
}

// Failing runs from the log: a tests-failed event followed by a flaky event of the same owner was flaky, else real.
export function testDataFromLog(log: LogLine[]): EvalRecord[] {
  const out: EvalRecord[] = []
  for (const [i, x] of log.entries()) {
    if (x.event !== 'tests-failed') continue
    const names = (x.text ?? '').replace(/^.*?failed:\s*/, '')
    const flaky = log.slice(i + 1).some(y => y.event === 'flaky' && y.owner === x.owner && (y.text ?? '').includes(names))
    out.push({ id: `log-tf-${out.length + 1}`, text: textOfTestFailure({ name: x.text?.split(':')[0] ?? 'test run', failed: names.split(', '), output: x.text ?? '' }), label: flaky ? 'flaky' : 'real' })
  }
  return out
}

const testRun = (text: string): { ok: boolean; fails: string[] } | undefined => {
  const fails = [...text.matchAll(/^(?:\d+:)?\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/gm)].map(m => m[1]!)
  const pass = /(\d+) pass\b/.exec(text)
  const nfail = /(\d+) fail\b/.exec(text)
  if (fails.length > 0 || (nfail && Number(nfail[1]) > 0)) return { ok: false, fails: [...new Set(fails)] }
  return pass ? { ok: true, fails: [] } : undefined
}
const suiteSize = (text: string): number | undefined => { const m = /Ran (\d+) tests/.exec(text); return m ? Number(m[1]) : undefined }
const failBlocks = (text: string): string => {
  const out: string[] = []
  let on = false
  for (const l of text.split('\n')) {
    if (/\(fail\)/.test(l)) { on = true; out.push(l) } else if (/^\(?(pass|skip)\)?|^\s*\d+ (pass|fail|skip)\b|^Ran \d+/.test(l)) { on = /^\s*\d+ (fail|pass)|^Ran /.test(l); if (on) out.push(l) } else if (on) out.push(l)
  }
  return out.join('\n')
}

// Failing full-suite runs in transcripts: flaky when a same-size rerun passed with no edit in between, real when an
// edit followed or the same names failed again. A rerun of another size says nothing. Worker "red" runs are real.
export function testDataFromTranscripts(transcripts: TranscriptEvent[][]): EvalRecord[] {
  const records: EvalRecord[] = []
  for (const evs of transcripts) {
    let last: { names: string; at: number } | undefined
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i]!
      const run = e.t === 'result' ? testRun(e.text) : undefined
      if (e.t !== 'result' || !run || run.ok || run.fails.length === 0 || (suiteSize(e.text) ?? 0) < 100) continue
      const names = run.fails.join('|')
      // The same failing names read again (a sed of the saved output) are the same failure.
      if (last !== undefined && last.names === names && !evs.slice(last.at + 1, i).some(x => x.t === 'edit' || (x.t === 'result' && testRun(x.text)))) continue
      last = { names, at: i }
      let label: string | undefined
      for (let k = i + 1; k < evs.length && k <= i + 120; k++) {
        const x = evs[k]!
        if (x.t === 'edit') { label = 'real'; break }
        const next = x.t === 'result' ? testRun(x.text) : undefined
        if (next?.ok && suiteSize(e.text) !== undefined && Math.abs(suiteSize(e.text)! - (suiteSize(x.t === 'result' ? x.text : '') ?? 0)) <= 5) { label = 'flaky'; break }
        if (next && !next.ok && next.fails.join('|') !== names) continue
        if (next && !next.ok) { label = 'real'; break }
      }
      if (label === undefined) continue
      records.push({ id: `tf-${records.length + 1}`, text: textOfTestFailure({ name: 'test run', failed: run.fails, output: failBlocks(e.text) }), label })
    }
  }
  return records
}

export function testData(log: LogLine[], transcripts: TranscriptEvent[][] = []): Dataset {
  const fromLog = testDataFromLog(log)
  const fromTr = testDataFromTranscripts(transcripts)
  const flakyKnown = log.filter(l => l.event === 'flaky').length
  return { key: 'test', records: [...fromLog, ...fromTr], notes: [`failing runs: ${fromLog.length} from log.jsonl (tests-failed; ${flakyKnown} flaky event(s)), ${fromTr.length} from transcripts (flaky = a same-size rerun passed with no edit in between, real = an edit followed or it failed again unchanged)`] }
}

// split: the successor is not named <name>-N (a package split off the branch), or the manager's note names max_continues.
export async function handoffData(log: LogLine[], maxContinues: number, readNote: (path: string) => Promise<string | undefined>): Promise<Dataset> {
  const records: EvalRecord[] = []
  let skipped = 0
  let total = 0
  const count = new Map<string, number>()
  for (const [i, h] of log.entries()) {
    if (h.event !== 'handoff') continue
    total++
    const n = (count.get(h.branch ?? '') ?? 0) + 1
    count.set(h.branch ?? '', n)
    const note = h.text === undefined ? undefined : await readNote(h.text)
    if (note === undefined) { skipped++; continue }
    const nextContinue = log.slice(i + 1).find(x => x.event === 'continue' && x.branch === h.branch)
    const successor = nextContinue !== undefined && /-\d+$/.test(nextContinue.agent ?? '')
    const t0 = Date.parse(h.ts ?? '')
    const noted = log.slice(i + 1).some(x => x.event === 'note' && x.owner === h.owner && Date.parse(x.ts ?? '') - t0 < 3_600_000 && /max_continues/i.test(x.text ?? ''))
    const split = noted || (nextContinue !== undefined && !successor)
    if (!split && nextContinue === undefined) { skipped++; continue }
    records.push({ id: `ho-${records.length + 1}`, text: textOfHandoff({ note, count: n, maxContinues }), label: split ? 'split' : 'continue' })
  }
  return { key: 'handoff', records, notes: [`handoffs in log: ${total}, unlabelled or note file gone: ${skipped}`, 'all labelled handoffs are replayed, not only those past max_continues (the rule asks the same of each)'] }
}

// ---- savings: the ledger's average cost of one turn by role, at hooks/cost.ts list prices ----
export type Unit = { usd: number; tokens: number; basis: string }
type LedgerRow = { role?: string; turns?: number; models?: Record<string, { input: number; write5m: number; write1h: number; read: number; output: number }> }
export function unitCosts(ledger: Record<string, LedgerRow>): Record<FeatureKey, Unit> {
  const acc: Record<string, { usd: number; tokens: number; turns: number; entries: number }> = {}
  for (const e of Object.values(ledger)) {
    if (!e.turns || e.role === undefined) continue
    const a = (acc[e.role] ??= { usd: 0, tokens: 0, turns: 0, entries: 0 })
    for (const [m, b] of Object.entries(e.models ?? {})) {
      const usd = costOf(m, b)
      if (usd !== undefined) a.usd += usd
      a.tokens += b.input + b.write5m + b.write1h + b.read + b.output
    }
    a.turns += e.turns
    a.entries++
  }
  const per = (r: string): Unit => { const a = acc[r]; return a ? { usd: a.usd / a.turns, tokens: a.tokens / a.turns, basis: `${r}: ${a.turns} turns in ${a.entries} agents` } : { usd: 0, tokens: 0, basis: `${r}: no data` } }
  // A conflict sub-agent is a whole agent run, not one turn: priced as the average "other" agent (sub-agents).
  const o = acc.other
  const sub: Unit = o ? { usd: o.usd / o.entries, tokens: o.tokens / o.entries, basis: `other: average of ${o.entries} sub-agent runs` } : { usd: 0, tokens: 0, basis: 'other: no data' }
  return { inbox: per('main'), test: per('reviewer'), conflict: sub, handoff: per('manager') }
}

// ---- scoring ----
export type Result = { id: string; label: string; answer?: string; confidence?: number; lowConfidence?: number; error?: string }
export type Ask = (text: string, q: Question) => Promise<Decision>

export async function pool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i]!) }
  }))
  return results
}

// The provider is asked with a minimum confidence of 0, so every answer carries its raw confidence; the note form of a
// low confidence stays understood for a caller that kept the default floor.
export async function replay(ask: Ask, records: EvalRecord[], q: Question, limit: number): Promise<Result[]> {
  return pool(records, limit, async (r): Promise<Result> => {
    const d = await ask(r.text, q)
    if ('answer' in d) return { id: r.id, label: r.label, answer: d.answer, ...(d.confidence !== undefined ? { confidence: d.confidence } : {}) }
    const low = /low confidence ([\d.]+)/.exec(d.note)
    return low ? { id: r.id, label: r.label, lowConfidence: Number(low[1]) } : { id: r.id, label: r.label, error: d.note }
  })
}

export type Row = { threshold: number; answered: number; fellThrough: number; agree: number; savedDecisions: number; savedCorrect: number; savedUsd: number; savedUsdCorrect: number; savedTokens: number; savedTokensCorrect: number }
export type FeatureReport = { key: FeatureKey; n: number; labels: Record<string, number>; unit: Unit; rows: Row[]; histogram: Record<string, number>; results: Result[]; notes: string[]; errors: string[]; mustNotAutoAnswer?: { threshold: number; wronglyAnswered: number; of: number }[]; baseline?: { agree: number; n: number; nonTrivialFiles: number; agentStarted: number } }

// An answer without a confidence (openai without logprobs) counts as certain: the plugin would act on it.
const conf = (r: Result): number => r.confidence ?? 1
export const BUCKETS = ['<0.5', '0.5-0.6', '0.6-0.7', '0.7-0.8', '0.8-0.9', '0.9-1.0', 'none', 'error']

export function summarize(ds: Dataset, results: Result[], unit: Unit, savesOn?: (r: Result) => boolean): FeatureReport {
  const n = results.length
  const rows = THRESHOLDS.map((threshold): Row => {
    const ans = results.filter(r => r.answer !== undefined && conf(r) >= threshold)
    const saving = ans.filter(r => (savesOn ? savesOn(r) : true))
    const good = saving.filter(r => r.answer === r.label)
    return { threshold, answered: ans.length, fellThrough: n - ans.length, agree: ans.filter(r => r.answer === r.label).length, savedDecisions: saving.length, savedCorrect: good.length, savedUsd: saving.length * unit.usd, savedUsdCorrect: good.length * unit.usd, savedTokens: Math.round(saving.length * unit.tokens), savedTokensCorrect: Math.round(good.length * unit.tokens) }
  })
  const histogram = Object.fromEntries(BUCKETS.map(b => [b, 0])) as Record<string, number>
  for (const r of results) {
    const c = r.confidence
    if (r.error !== undefined) histogram.error!++
    else if (r.lowConfidence !== undefined) histogram['<0.5']!++
    else if (c === undefined) histogram.none!++
    else histogram[c >= 0.9 ? '0.9-1.0' : c >= 0.8 ? '0.8-0.9' : c >= 0.7 ? '0.7-0.8' : c >= 0.6 ? '0.6-0.7' : c >= 0.5 ? '0.5-0.6' : '<0.5']!++
  }
  const labels: Record<string, number> = {}
  for (const r of results) labels[r.label] = (labels[r.label] ?? 0) + 1
  const errors = [...new Set(results.filter(r => r.error !== undefined).map(r => r.error!))]
  return { key: ds.key, n, labels, unit, rows, histogram, results: results.map(r => ({ ...r })), notes: ds.notes, errors }
}

const pct = (a: number, b: number): string => (b === 0 ? '-' : `${Math.round((100 * a) / b)}%`)
const usd = (n: number): string => `$${n.toFixed(2)}`

export function formatFeature(f: FeatureReport): string {
  const lines = [`== ${f.key}  (n=${f.n}; actual labels ${JSON.stringify(f.labels)}; unit ${usd(f.unit.usd)} / ${Math.round(f.unit.tokens / 1000)}k tokens, ${f.unit.basis})`]
  lines.push('threshold  answered  fell-through  agreement  saved decisions  saved (all)  saved (correct only)')
  for (const r of f.rows) {
    lines.push(`${String(r.threshold).padEnd(10)} ${String(r.answered).padEnd(9)} ${`${r.fellThrough} (${pct(r.fellThrough, f.n)})`.padEnd(13)} ${`${pct(r.agree, r.answered)} (${r.agree}/${r.answered})`.padEnd(14)} ${String(r.savedDecisions).padEnd(16)} ${`${usd(r.savedUsd)} ${Math.round(r.savedTokens / 1e3)}k tok`.padEnd(12)} ${usd(r.savedUsdCorrect)} ${Math.round(r.savedTokensCorrect / 1e3)}k tok`)
  }
  lines.push(`confidence histogram: ${BUCKETS.map(b => `${b}:${f.histogram[b]}`).join('  ')}`)
  if (f.errors.length > 0) lines.push(`errors (count as fall-through): ${f.errors.join('; ')}`)
  for (const note of f.notes) lines.push(`   ${note}`)
  if (f.mustNotAutoAnswer) lines.push(`must-not-auto-answer (non-fyi questions answered keep/undo instead of ask_main): ${f.mustNotAutoAnswer.map(x => `@${x.threshold}: ${x.wronglyAnswered}/${x.of}`).join('  ')}`)
  if (f.baseline) lines.push(`deterministic baseline (file-list rule, no API): agrees ${f.baseline.agree}/${f.baseline.n}; of ${f.baseline.nonTrivialFiles} with non-trivial files a conflict agent was started in ${f.baseline.agentStarted} (the rest were resolved by the reviewer itself)`)
  return lines.join('\n')
}

export type EvalOptions = { features: FeatureKey[]; concurrency?: number; limit?: number }
const CONCURRENCY = 4

// Replays each dataset through `ask`; `limit` keeps the newest records of each. The savings of a conflict only count
// where the answer was trivial (it gates the sub-agent).
export async function runEval(ask: Ask, datasets: Dataset[], units: Record<FeatureKey, Unit>, opts: EvalOptions): Promise<FeatureReport[]> {
  const reports: FeatureReport[] = []
  const conc = opts.concurrency ?? CONCURRENCY
  const keep = <T,>(xs: T[]): T[] => (opts.limit !== undefined && opts.limit > 0 ? xs.slice(-opts.limit) : xs)
  for (const ds of datasets.filter(d => opts.features.includes(d.key))) {
    const q = QUESTIONS[ds.key]
    const records = keep(ds.records)
    const results = await replay(ask, records, q, conc)
    const report = summarize(ds, results, units[ds.key], ds.key === 'conflict' ? r => r.answer === 'trivial' : undefined)
    if (ds.guard) {
      const g = await replay(ask, keep(ds.guard), q, conc)
      report.mustNotAutoAnswer = THRESHOLDS.map(threshold => ({ threshold, wronglyAnswered: g.filter(r => r.answer !== undefined && r.answer !== 'ask_main' && conf(r) >= threshold).length, of: g.length }))
    }
    if (ds.key === 'conflict') {
      const nonTrivial = records.filter(r => r.baseline === 'needs_agent')
      report.baseline = { agree: records.filter(r => r.baseline === r.label).length, n: records.length, nonTrivialFiles: nonTrivial.length, agentStarted: nonTrivial.filter(r => r.agent).length }
    }
    reports.push(report)
  }
  return reports
}

// The datasets of a flow state dir. `read` gives a file's text by its path relative to .git/flow (undefined when absent);
// transcripts are optional because the engine's file API cannot read files over 4 MiB.
export type FlowSource = { read: (rel: string) => Promise<string | undefined>; readAbs: (path: string) => Promise<string | undefined>; maxContinues: number; transcripts?: TranscriptEvent[][] }
export const parseLog = (raw: string | undefined): LogLine[] => {
  const out: LogLine[] = []
  for (const line of (raw ?? '').split('\n')) {
    try { const e = JSON.parse(line) as LogLine; if (typeof e === 'object' && e !== null && typeof e.event === 'string') out.push(e) } catch { /* torn line */ }
  }
  return out
}
export async function loadDatasets(src: FlowSource): Promise<{ datasets: Dataset[]; units: Record<FeatureKey, Unit> }> {
  const json = async <T,>(rel: string, dflt: T): Promise<T> => { try { return JSON.parse((await src.read(rel)) ?? '') as T } catch { return dflt } }
  const log = parseLog(await src.read('log.jsonl'))
  const inbox = await json<{ items?: InboxItem[] }>('inbox.json', {})
  const ledger = await json<Record<string, LedgerRow>>('ledger.json', {})
  const datasets = [inboxData(inbox.items ?? []), testData(log, src.transcripts), conflictData(log, src.transcripts), await handoffData(log, src.maxContinues, src.readAbs)]
  return { datasets, units: unitCosts(ledger) }
}

export type EvalReport = { provider: string; at: string; features: FeatureReport[] }
// The file keeps ids, labels, answers and confidences, never a record's text or a key.
export const reportJson = (r: EvalReport): string => JSON.stringify(r, null, 2)
export const reportText = (r: EvalReport): string => [`decide eval, provider ${r.provider}, ${r.at}`, ...r.features.map(formatFeature)].join('\n\n')

// The export a script writes for the tool (the tool cannot read transcripts, but it can read this file): the built
// datasets and unit costs, texts cut to `textMax` so the file stays under the engine's 4 MiB read cap.
export const EXPORT_FILE = 'decide-eval-data.json'
export type ExportData = { at: string; datasets: Dataset[]; units: Record<FeatureKey, Unit> }
export function exportJson(datasets: Dataset[], units: Record<FeatureKey, Unit>, at: string, textMax: number): string {
  const cut = (r: EvalRecord): EvalRecord => ({ ...r, text: r.text.slice(0, textMax) })
  return JSON.stringify({ at, datasets: datasets.map(d => ({ ...d, records: d.records.map(cut), ...(d.guard ? { guard: d.guard.map(cut) } : {}) })), units })
}
export function parseExport(raw: string | undefined): ExportData | undefined {
  try {
    const d = JSON.parse(raw ?? '') as ExportData
    const ok = typeof d.at === 'string' && Array.isArray(d.datasets) && d.datasets.every(x => FEATURES.includes(x.key) && Array.isArray(x.records)) && typeof d.units === 'object' && d.units !== null
    return ok ? d : undefined
  } catch {
    return undefined
  }
}
