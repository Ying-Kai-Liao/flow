// Replay of flow's own history through the decision API (decide.ts) for the four questions of decide-questions.ts:
// the datasets from .git/flow (and, when given, transcript events), the scoring, and the report text. Pure: files are
// read by the caller, the provider is an injected `ask`, so tests need no network and no disk. The live run is the
// main-only `decide_eval` tool (register.tsx); scripts/decide-eval.mjs builds the same datasets for a dry run.
// A results object holds record ids, labels, answers and confidences, never a record's text.
// The fifth question, `size`, is the one use the decision API already has (spawn.ts sizing): see sizeData for its labels.
import { baseName, costOf } from './cost'
import type { Decision, Question } from './decide'
import { generation, isSize, parseSize } from './routing'
import type { Size } from './routing'
import { SIZE_QUESTION } from './spawn'
import { isLite } from './preflight'
import { noteKey } from './state'
import { HANDOFF_QUESTION, INBOX_ROUTINE_QUESTION, MERGE_CONFLICT_QUESTION, ROUTE_QUESTION, TEST_FAILURE_QUESTION, textOfConflict, textOfHandoff, textOfInbox, textOfTestFailure } from './decide-questions'

export type FeatureKey = 'inbox' | 'test' | 'conflict' | 'handoff' | 'size' | 'route'
export const FEATURES: FeatureKey[] = ['inbox', 'test', 'conflict', 'handoff', 'size', 'route']
export const THRESHOLDS = [0.5, 0.7, 0.8, 0.9]
export const QUESTIONS: Record<FeatureKey, Question> = { inbox: INBOX_ROUTINE_QUESTION, test: TEST_FAILURE_QUESTION, conflict: MERGE_CONFLICT_QUESTION, handoff: HANDOFF_QUESTION, size: SIZE_QUESTION, route: ROUTE_QUESTION }

export type LogLine = { ts?: string; event: string; owner?: string; agent?: string; branch?: string; pr?: number; text?: string }
export type EvalRecord = { id: string; text: string; label: string; baseline?: string; agent?: boolean; size?: SizeMeta; route?: RouteMeta }
export type Dataset = { key: FeatureKey; records: EvalRecord[]; guard?: EvalRecord[]; notes: string[] }

// Light events of one transcript, in order (scripts/decide-eval.mjs extracts them; the tool has none).
export type TranscriptEvent =
  | { t: 'agent'; model: string; type: string; prompt: string; name?: string }
  | { t: 'edit' }
  | { t: 'result'; id: string; text: string }
  // The agent a transcript file belongs to (first event of a sub-agent file), and its flow tool calls that route needs:
  // plan nodes added (ids), a question asked or filed (blocking), by `owner` (the call's `from`, else the file's agent).
  | { t: 'owner'; name: string }
  | { t: 'flow'; tool: 'plan' | 'ask'; owner?: string; ids?: string[]; blocking?: boolean }

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
type LedgerRow = { role?: string; name?: string; manager?: string; branch?: string; spawnModel?: string; size?: string; turns?: number; models?: Record<string, { input: number; write5m: number; write1h: number; read: number; output: number }> }
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
  return { inbox: per('main'), test: per('reviewer'), conflict: sub, handoff: per('manager'), size: { usd: 0, tokens: 0, basis: 'size: priced per spawn from its own tokens (see the size notes)' }, route: { usd: 0, tokens: 0, basis: 'route: priced per task from its own family (see the route notes)' } }
}


// ---- size: model sizing at spawn (spawn.ts routeWorker / routeManager) ----
// One record per package (a worker's `x`, a manager's task), scored at its FIRST spawn; a `x-2` successor is the same
// package and is the under-size signal. The text is the spawn prompt, which is exactly what sizeWith hands to
// SIZE_QUESTION. Label rule (what the right size turned out to be, judged by what happened after):
//   under  = the package needed a rerun at a bigger size: a `<name>-N` successor, a `continue` or `handoff` event on its
//            branch, or its worker-size / manager-size inbox decision undone (answered anything but Keep). Right size:
//            one up from the one it ran at. A worker that already ran large cannot be under-sized (no bigger model);
//            its handoffs are context exhaustion, not evidence about the model choice, so they never label it under.
//   over   = it ran large (opus for a manager) and its PRs are trivial: at most OVER_LINES changed lines outside
//            CHANGELOG.md, plugin.json, package and marketplace files. Right size: one down (a manager has two classes,
//            small and opus, so one down is small). Only large is judged over: nothing shows that a normal-sized
//            package would also have worked at small, so a sizer that picks small is only ever penalised for under.
//   ok     = merged with no successor and not over. Right size: the size it ran at.
//   unlabelable = no PR merged (aborted, still running, no PR), or the model it ran on is unknown. Skipped; counted in notes.
// A sizer that picks below the right size is counted as under-sized, above it as over-sized.
// 100: in flow's own history the smallest PRs of large workers are 81 and 100 lines, then 164 and up, so the cap sits at the
// break before the first ordinary-sized one.
export const OVER_LINES = 100
export const MANAGER_OVER_LINES = 150
export type PrStat = { state: string; files: { path: string; additions: number; deletions: number }[] }
export type SizeRole = 'worker' | 'manager'
export type SizeMeta = {
  role: SizeRole
  used: Size
  right: Size
  brief?: Size
  // The size recorded in the inbox decision when a decision-API tag is in its text; absent when none (large is never filed).
  recorded?: { size: Size; confidence?: number }
  tokens: { input: number; write5m: number; write1h: number; read: number; output: number }
  // The real USD of the successors, when the package needed a rerun and they are in the ledger.
  rerunUsd?: number
  lines?: number
}

// Which model a size runs on, with the defaults of settings.ts: worker small/normal/large = haiku/sonnet/sonnet[1m];
// manager small = the cheap model (sonnet), normal and large = opus.
export const modelOfSize = (role: SizeRole, s: Size): string => (role === 'worker' ? (s === 'small' ? 'haiku' : 'sonnet') : s === 'small' ? 'sonnet' : 'opus')
// Managers have two classes, so normal and large are the same answer for them.
export const sizeClass = (role: SizeRole, s: Size): number => (role === 'manager' ? (s === 'small' ? 0 : 1) : ['small', 'normal', 'large'].indexOf(s))
const SIZE_ORDER: Size[] = ['small', 'normal', 'large']
const down = (s: Size): Size => SIZE_ORDER[Math.max(0, SIZE_ORDER.indexOf(s) - 1)]!
const up = (s: Size): Size => SIZE_ORDER[Math.min(2, SIZE_ORDER.indexOf(s) + 1)]!

export const prLines = (pr: PrStat): number => pr.files.filter(f => !isTrivialFile(f.path)).reduce((n, f) => n + f.additions + f.deletions, 0)
const usedOf = (role: SizeRole, model: string | undefined, logSize: string | undefined, ledgerSize: string | undefined): Size | undefined => {
  if (isSize(logSize)) return logSize
  if (isSize(ledgerSize)) return ledgerSize
  if (model === undefined) return undefined
  // No Size line and no floor: the spawn ran as the manager wrote it. A manager on opus is large for this purpose.
  if (role === 'worker') return /haiku/.test(model) ? 'small' : /1m|opus/.test(model) ? 'large' : /sonnet/.test(model) ? 'normal' : undefined
  return /opus/.test(model) ? 'large' : /sonnet|haiku/.test(model) ? 'small' : undefined
}
// "(jev 0.76)" in a recorded size decision: Jev (or openai) answered; "(jev unavailable: ...)" means it did not.
export function recordedSize(question: string): { name: string; size: Size; confidence?: number; answered: boolean } | undefined {
  const m = /^(\S+) runs (small|normal|large) ->/.exec(question)
  if (m === null) return undefined
  const tag = /\((jev|openai)\b([^)]*)\)/.exec(question)
  const c = tag === null ? undefined : /\b(\d(?:\.\d+)?)\b/.exec(tag[2]!.replace(/;.*/, ''))
  const answered = tag !== null && !/unavailable/.test(tag[2]!)
  return { name: m[1]!, size: m[2] as Size, ...(answered && c ? { confidence: Number(c[1]) } : {}), answered }
}

const sumTokens = (rows: LedgerRow[]): SizeMeta['tokens'] => {
  const t = { input: 0, write5m: 0, write1h: 0, read: 0, output: 0 }
  for (const r of rows) for (const b of Object.values(r.models ?? {})) { t.input += b.input; t.write5m += b.write5m; t.write1h += b.write1h; t.read += b.read; t.output += b.output }
  return t
}
const usdOfRows = (rows: LedgerRow[]): number => rows.reduce((n, r) => n + Object.entries(r.models ?? {}).reduce((m, [model, b]) => m + (costOf(model, b) ?? 0), 0), 0)

export type SizeSource = { log: LogLine[]; ledger: Record<string, LedgerRow>; inbox: InboxItem[]; transcripts?: TranscriptEvent[][]; prs?: Record<string, PrStat> }

export function sizeData(src: SizeSource): Dataset {
  const rows = Object.values(src.ledger).filter(r => r.name !== undefined)
  // The spawn prompt of each flow agent by name (the first line of a brief is "Your name: <slug>"); the first sighting wins.
  const prompts = new Map<string, string>()
  for (const evs of src.transcripts ?? []) {
    for (const e of evs) {
      if (e.t !== 'agent' || (e.type !== 'flow:worker' && e.type !== 'flow:manager')) continue
      const name = /^\s*Your name:\s*(\S+)/m.exec(e.prompt)?.[1] ?? e.name
      if (name !== undefined && !prompts.has(`${e.type}|${name}`)) prompts.set(`${e.type}|${name}`, e.prompt)
    }
  }
  const spawnText = new Map<string, string>()
  for (const l of src.log) if (l.event === 'spawn' && l.agent !== undefined && l.text !== undefined && !spawnText.has(l.agent)) spawnText.set(l.agent, l.text)
  const decisions = new Map<string, InboxItem>()
  for (const i of src.inbox) {
    const r = recordedSize(i.question ?? '')
    if ((i.topic === 'worker-size' || i.topic === 'manager-size') && r !== undefined && !decisions.has(`${i.topic}|${r.name}`)) decisions.set(`${i.topic}|${r.name}`, i)
  }
  const prOf = (branch: string | undefined): PrStat | undefined => (branch === undefined ? undefined : src.prs?.[branch])
  const records: EvalRecord[] = []
  const skip: Record<string, number> = { 'no prompt': 0, 'model unknown': 0, 'no merged PR': 0 }
  let total = 0
  const roleCount = { worker: 0, manager: 0 }
  const why = { successor: 0, 'continue/handoff': 0, undone: 0 }
  for (const role of ['worker', 'manager'] as SizeRole[]) {
    const mine = rows.filter(r => r.role === role)
    const firsts = [...new Map(mine.filter(r => generation(r.name!) === 1).map(r => [r.name!, r])).values()]
    for (const first of firsts) {
      const name = first.name!
      total++
      roleCount[role]++
      const text = prompts.get(`flow:${role}|${name}`)
      if (text === undefined) { skip['no prompt']!++; continue }
      const used = usedOf(role, first.spawnModel, /^size (\w+) ->/.exec(spawnText.get(name) ?? '')?.[1], first.size)
      if (used === undefined) { skip['model unknown']!++; continue }
      const own = mine.filter(r => r.name === name)
      const successors = mine.filter(r => baseName(r.name!) === name && generation(r.name!) > 1)
      const dec = decisions.get(`${role}-size|${name}`)
      const undone = dec !== undefined && dec.state === 'answered' && typeof dec.answer === 'string' && dec.answer.trim() !== '' && dec.answer.trim() !== 'Keep'
      const onBranch = role === 'worker' && src.log.some(l => (l.event === 'continue' || l.event === 'handoff') && l.branch !== undefined && l.branch === first.branch)
      // The package's pull requests: a worker's branch (and its successors' branches), a manager's workers' branches.
      const workers = role === 'worker' ? [first] : rows.filter(r => r.role === 'worker' && r.manager !== undefined && baseName(r.manager) === name)
      const prs = [...new Set([...workers.map(w => w.branch), ...successors.map(s => s.branch)])].map(prOf).filter((p): p is PrStat => p !== undefined)
      const merged = prs.filter(p => p.state === 'MERGED')
      const rerun = successors.length > 0 || onBranch || undone
      // A handoff or successor of a worker that ran large says nothing about the model choice.
      const under = used !== 'large' && rerun
      if (under) { if (successors.length > 0) why.successor++; else if (onBranch) why['continue/handoff']++; else why.undone++ }
      const lines = merged.reduce((n, p) => n + prLines(p), 0)
      const cap = role === 'worker' ? OVER_LINES : MANAGER_OVER_LINES
      let label: string
      let right: Size
      if (under) { label = 'under'; right = up(used) }
      else if (merged.length === 0) { skip['no merged PR']!++; continue }
      else if (used === 'large' && lines <= cap && !rerun) { label = 'over'; right = role === 'manager' ? 'small' : down(used) }
      else { label = 'ok'; right = used }
      const brief = parseSize(text)?.size
      const rec = dec === undefined ? undefined : recordedSize(dec.question ?? '')
      const meta: SizeMeta = {
        role, used, right, ...(brief !== undefined ? { brief } : {}),
        ...(rec?.answered ? { recorded: { size: rec.size, ...(rec.confidence !== undefined ? { confidence: rec.confidence } : {}) } } : {}),
        tokens: sumTokens(own), ...(under && successors.length > 0 ? { rerunUsd: usdOfRows(successors) } : {}), lines,
      }
      records.push({ id: `${role === 'worker' ? 'w' : 'm'}-${name}`, text, label, size: meta })
    }
  }
  const dist: Record<string, number> = {}
  for (const r of records) dist[r.label] = (dist[r.label] ?? 0) + 1
  return {
    key: 'size', records,
    notes: [
      `spawn packages (first spawns of ${roleCount.worker} workers and ${roleCount.manager} managers in the ledger): ${total}; labelable with a recoverable prompt: ${records.length}; skipped ${JSON.stringify(skip)}; labels ${JSON.stringify(dist)}; under by first signal ${JSON.stringify(why)}`,
      `label rule: under = a -N successor, a continue/handoff event on the branch (not for a worker that ran large: context exhaustion says nothing about the model) or an undone size decision; over = ran large and its merged PRs changed <= ${OVER_LINES} lines (manager: <= ${MANAGER_OVER_LINES}) outside changelog/version/package files; ok = merged otherwise; else unlabelable`,
      'the right size: under = one up, over = one down (a manager: small), ok = the size it ran at. A Size-line sizer without a Size line = what spawn.ts leaves: the spawn as the manager wrote it (the size it ran at)',
    ],
  }
}

// ---- size scoring ----
export type SizerRow = { sizer: string; n: number; agree: number; under: number; over: number; usd: number; actualUsd: number; fellThrough?: number }
export type SizeReport = { rows: SizerRow[]; model: string }
const COST_MODEL = 'Cost model: the package\'s first-spawn tokens are priced at the model a size runs on (hooks/cost.ts list prices; worker small/normal/large = haiku/sonnet/sonnet, manager small = sonnet, normal/large = opus); a size below the right one adds the rerun (the real successors\' cost when in the ledger, else the same tokens at the right size); a size at or above it costs one attempt. "as run" is the same formula at the size it ran at; "vs as run" is the sizer\'s total minus the as-run total over the same records (negative = cheaper). Tokens are not rescaled by model.'

const attemptUsd = (m: SizeMeta, s: Size): number => costOf(modelOfSize(m.role, s), m.tokens) ?? 0
export const costAtSize = (m: SizeMeta, s: Size): number => attemptUsd(m, s) + (sizeClass(m.role, s) < sizeClass(m.role, m.right) ? m.rerunUsd ?? attemptUsd(m, m.right) : 0)

function scoreSizer(sizer: string, recs: { meta: SizeMeta; answer: Size }[], fellThrough?: number): SizerRow {
  let agree = 0
  let under = 0
  let over = 0
  let usd = 0
  let actualUsd = 0
  for (const { meta, answer } of recs) {
    const a = sizeClass(meta.role, answer)
    const r = sizeClass(meta.role, meta.right)
    if (a === r) agree++
    else if (a < r) under++
    else over++
    usd += costAtSize(meta, answer)
    actualUsd += costAtSize(meta, meta.used)
  }
  return { sizer, n: recs.length, agree, under, over, usd, actualUsd, ...(fellThrough !== undefined ? { fellThrough } : {}) }
}

// `results` are the replay answers. Jev@T falls back to the Size line below confidence T (and on an error), like the plugin
// does with decide_min_confidence (default 0.8).
export function sizeReport(records: EvalRecord[], results: Result[]): SizeReport {
  const byId = new Map(results.map(r => [r.id, r]))
  const withMeta = records.filter(r => r.size !== undefined).map(r => ({ meta: r.size!, id: r.id }))
  const line = (m: SizeMeta): Size => m.brief ?? m.used
  const jevAt = (min: number | undefined) => withMeta.map(({ meta, id }) => {
    const r = byId.get(id)
    const ok = r?.answer !== undefined && isSize(r.answer) && (min === undefined || (r.confidence ?? 1) >= min)
    return { meta, answer: ok ? (r!.answer as Size) : line(meta), live: ok }
  })
  const rows: SizerRow[] = [
    scoreSizer('as run', withMeta.map(({ meta }) => ({ meta, answer: meta.used }))),
    scoreSizer('always normal', withMeta.map(({ meta }) => ({ meta, answer: 'normal' as Size }))),
    scoreSizer('Size line', withMeta.map(({ meta }) => ({ meta, answer: line(meta) }))),
  ]
  if (results.length > 0) {
    const live = jevAt(undefined).filter(x => x.live)
    rows.push(scoreSizer('jev (answered only)', live, withMeta.length - live.length))
    for (const t of [0.7, 0.8]) {
      const all = jevAt(t)
      rows.push(scoreSizer(`jev >= ${t}, else Size line`, all, all.filter(x => !x.live).length))
    }
  }
  const rec = withMeta.filter(x => x.meta.recorded !== undefined)
  rows.push(scoreSizer('recorded jev tag (no network)', rec.map(x => ({ meta: x.meta, answer: x.meta.recorded!.size }))))
  rows.push(scoreSizer('Size line, same records', rec.map(x => ({ meta: x.meta, answer: line(x.meta) }))))
  rows.push(scoreSizer('always normal, same records', rec.map(x => ({ meta: x.meta, answer: 'normal' as Size }))))
  return { rows, model: COST_MODEL }
}

// The key-free part (Size line, always-normal, recorded tags) for the dry run.
export const sizeBaselines = (records: EvalRecord[]): SizeReport => sizeReport(records, [])

export function formatSize(r: SizeReport): string {
  const pc = (a: number, b: number): string => (b === 0 ? '-' : `${Math.round((100 * a) / b)}%`)
  const lines = ['sizer                            n    agree        under-sized  over-sized   $ total   vs as run   fell-through']
  for (const x of r.rows) {
    lines.push(`${x.sizer.padEnd(32)} ${String(x.n).padEnd(4)} ${`${pc(x.agree, x.n)} (${x.agree})`.padEnd(12)} ${`${pc(x.under, x.n)} (${x.under})`.padEnd(12)} ${`${pc(x.over, x.n)} (${x.over})`.padEnd(12)} ${`$${x.usd.toFixed(2)}`.padEnd(9)} ${`${x.usd - x.actualUsd >= 0 ? '+' : '-'}$${Math.abs(x.usd - x.actualUsd).toFixed(2)}`.padEnd(11)} ${x.fellThrough ?? ''}`)
  }
  lines.push(r.model)
  return lines.join('\n')
}

// ---- route: is a manager needed, or would a direct worker do? (measure only; nothing at runtime asks ROUTE_QUESTION) ----
// One record per task = per manager family (a manager and its `-N` successors, grouped by noteKey like lite.ts). The text is
// the manager's spawn prompt (the task text main gave it). Label rule:
//   direct    = the family started exactly one worker (a `-N` worker successor makes two), produced exactly one merged PR,
//               filed no blocking question (mcp__flow__ask or pre-flight, blocking true), the reviewer sent nothing back
//               (no `back` event for it), it declared no plan DAG nodes, and it had no successor manager.
//   manager+1 = exactly one worker (no -N worker successor) but another direct condition failed.
//   manager+n = two or more distinct workers across the manager and its -N successors.
//   unlabelable = no recoverable prompt, no worker at all (shipped already, or died before starting one), or no merged PR
//             (still running, aborted, open PR). Skipped; counted in notes.
// Hard rule (before scoring, for every router): a task touching migrations, auth or permissions, secrets, deploy/CI/infra
// config, or data rewrites or deletions is never `direct`; it is removed from scoring. Signals: the prompt text (HARD_PROMPT),
// the merged PRs' files (HARD_FILE), a handover with mode "confirm" or an `approve` event for its branch.
export const HARD_PROMPT = /\bmigrations?\b|\bauth(?:entication|orization|orisation)?\b|\bpermissions?\b|\bsecrets?\b|\bcredentials?\b|\bapi[_ -]?keys?\b|\bCI\b|\.github\/workflows|\binfra(?:structure)?\b|\bterraform\b|\bdeploy(?:ment)? (?:config|target|pipeline|script|workflow)s?\b|\bdrop (?:table|column)\b|\b(?:rewrite|delete|wipe|purge|backfill)\b[^.\n]{0,30}\b(?:data|records|rows|database|db)\b|\bdestructive\b/i
export const HARD_FILE = /(?:^|\/)(?:db\/)?migrations?\/|(?:^|\/)\.github\/workflows\/|(?:^|\/)(?:Dockerfile|docker-compose[^/]*|\.env[^/]*|\.gitlab-ci\.yml|Jenkinsfile|fly\.toml|vercel\.json|netlify\.toml|serverless\.ya?ml)$|\.tf$|(?:^|\/)(?:terraform|infra|k8s|helm)\/|(?:^|\/)deploy[^/]*\.(?:ya?ml|json|toml)$/i
// Two or more listed packages: lines like "Package 2", "Part B", "WP3".
const MULTI_PACKAGE = /^\s*(?:#{1,4}\s*)?(?:package|part|wp)\s*[\dA-Z]\b/gim
const DOC_FILE = /\.mdx?$/i
const DOCS_PROMPT = /\bdocs?[- ]only\b|\breadme\b|\bchangelog\b|\bdocumentation\b/i
const CODE_PROMPT = /\.(?:tsx?|mjs|js|json)\b|\bhooks?\/|\bsrc\/|\btests?\b|\bfunction\b|\brefactor/i
// A main PR review, in turns of main: the ledger has no per-PR split, so a fixed count at main's average turn cost.
export const REVIEW_TURNS = 4

export type RouteLabel = 'direct' | 'manager+1' | 'manager+n'
export const ROUTE_LABELS: RouteLabel[] = ['direct', 'manager+1', 'manager+n']
const shape = (l: RouteLabel): number => ROUTE_LABELS.indexOf(l)
export type RouteMeta = {
  label: RouteLabel
  // Main's actual choice: a lite manager (prompt line or lite state) = direct, else manager+1 (the record cannot tell +1 from +n).
  main: RouteLabel
  sizeSmall: boolean
  sizeLarge: boolean
  multiPackage: boolean
  docsOnlyPr: boolean
  docsOnlyPrompt: boolean
  managerUsd: number
  workerUsd: number
  reviewUsd: number
}
export type RouteSource = SizeSource & {
  // lite.json (noteKey -> record), preflight.json entries by name, and the handover files; undefined when the file is absent.
  lite?: Record<string, unknown>
  preflight?: Record<string, { asked?: string[]; blocking?: string[] }>
  handovers?: { branch?: string; mode?: string }[]
}

export function routeData(src: RouteSource): Dataset {
  const rows = Object.values(src.ledger).filter(r => r.name !== undefined)
  const prompts = new Map<string, string>()
  for (const evs of src.transcripts ?? []) {
    for (const e of evs) {
      if (e.t !== 'agent' || e.type !== 'flow:manager') continue
      const name = /^\s*Your name:\s*(\S+)/m.exec(e.prompt)?.[1] ?? e.name
      if (name !== undefined && !prompts.has(name)) prompts.set(name, e.prompt)
    }
  }
  const families = [...new Set(rows.filter(r => r.role === 'manager').map(r => noteKey(r.name!)))]
  let prefixOwned = 0
  // A worker belongs to the family of its ledger `manager` field; without one, to the longest family its name is prefixed by.
  const familyOf = (r: LedgerRow): string | undefined => {
    if (r.manager !== undefined) return noteKey(r.manager)
    const f = families.filter(x => r.name!.startsWith(`${x}-`)).sort((a, b) => b.length - a.length)[0]
    if (f !== undefined) prefixOwned++
    return f
  }
  const workerRows = rows.filter(r => r.role === 'worker')
  const reviewUsd = unitCosts(src.ledger).inbox.usd * REVIEW_TURNS
  const flowEvs = (src.transcripts ?? []).flat().filter((e): e is Extract<TranscriptEvent, { t: 'flow' }> => e.t === 'flow')
  const planOwners = new Set(flowEvs.filter(e => e.tool === 'plan' && e.owner !== undefined).map(e => noteKey(e.owner!)))
  const planIds = flowEvs.flatMap(e => (e.tool === 'plan' ? e.ids ?? [] : []))
  const askOwners = new Set(flowEvs.filter(e => e.tool === 'ask' && e.blocking === true && e.owner !== undefined).map(e => noteKey(e.owner!)))
  const planKnown = (src.transcripts ?? []).length > 0
  const records: EvalRecord[] = []
  const skip: Record<string, number> = { 'no prompt': 0, 'no worker': 0, 'no merged PR': 0 }
  const hard: Record<string, number> = { prompt: 0, files: 0, confirm: 0 }
  const disq: Record<string, number> = { 'workers != 1': 0, 'merged PRs != 1': 0, 'blocking question': 0, 'reviewer back': 0, 'plan nodes': 0, 'successor manager': 0 }
  let liteUnknown = 0
  for (const family of families) {
    const managers = rows.filter(r => r.role === 'manager' && noteKey(r.name!) === family)
    const text = prompts.get(family) ?? [...prompts].find(([n]) => noteKey(n) === family)?.[1]
    if (text === undefined) { skip['no prompt']!++; continue }
    const workers = workerRows.filter(r => familyOf(r) === family)
    const names = new Set(workers.map(r => r.name!))
    if (names.size === 0) { skip['no worker']!++; continue }
    const branches = [...new Set(workers.map(r => r.branch).filter((b): b is string => b !== undefined))]
    const merged = branches.map(b => src.prs?.[b]).filter((p): p is PrStat => p !== undefined && p.state === 'MERGED')
    if (merged.length === 0) { skip['no merged PR']!++; continue }
    const mine = (x: LogLine): boolean => (x.owner !== undefined && noteKey(x.owner) === family) || (x.branch !== undefined && branches.includes(x.branch))
    const pre = Object.entries(src.preflight ?? {}).filter(([n]) => noteKey(n) === family).map(([, e]) => e)
    const asked = new Set(pre.flatMap(e => e.asked ?? []))
    const blocking = src.inbox.some(i => i.blocking === true && ((i.owner !== undefined && noteKey(i.owner) === family) || asked.has(i.id))) || pre.some(e => (e.blocking ?? []).length > 0) || askOwners.has(family)
    const back = src.log.some(l => l.event === 'back' && mine(l))
    const plan = planOwners.has(family) || planIds.some(id => id.startsWith(`${family}-`) || noteKey(id) === family)
    const successors = new Set(managers.map(m => m.name!)).size > 1
    const dq: string[] = []
    if (names.size !== 1) dq.push('workers != 1')
    if (merged.length !== 1) dq.push('merged PRs != 1')
    if (blocking) dq.push('blocking question')
    if (back) dq.push('reviewer back')
    if (plan) dq.push('plan nodes')
    if (successors) dq.push('successor manager')
    for (const d of dq) disq[d]!++
    const label: RouteLabel = names.size >= 2 ? 'manager+n' : dq.length === 0 ? 'direct' : 'manager+1'
    const files = merged.flatMap(p => p.files.map(f => f.path))
    const confirm = (src.handovers ?? []).some(h => h.mode === 'confirm' && h.branch !== undefined && branches.includes(h.branch)) || src.log.some(l => l.event === 'approve' && mine(l))
    const signal = HARD_PROMPT.test(text) ? 'prompt' : files.some(f => HARD_FILE.test(f)) ? 'files' : confirm ? 'confirm' : undefined
    if (signal !== undefined) { hard[signal]!++; continue }
    const litePrompt = isLite(text)
    const liteState = src.lite === undefined ? undefined : src.lite[family] !== undefined
    if (liteState === undefined && !litePrompt) liteUnknown++
    const main: RouteLabel = litePrompt || liteState === true ? 'direct' : 'manager+1'
    const meta: RouteMeta = {
      label, main, sizeSmall: parseSize(text)?.size === 'small', sizeLarge: parseSize(text)?.size === 'large', multiPackage: (text.match(MULTI_PACKAGE) ?? []).length >= 2, docsOnlyPr: files.length > 0 && files.every(f => DOC_FILE.test(f)),
      docsOnlyPrompt: DOCS_PROMPT.test(text) && !CODE_PROMPT.test(text), managerUsd: usdOfRows(managers), workerUsd: usdOfRows(workers), reviewUsd,
    }
    records.push({ id: `r-${family}`, text, label, route: meta })
  }
  const dist: Record<string, number> = {}
  for (const r of records) dist[r.label] = (dist[r.label] ?? 0) + 1
  const excluded = hard.prompt! + hard.files! + hard.confirm!
  return {
    key: 'route', records,
    notes: [
      `manager families in the ledger: ${families.length}; labelable: ${records.length + excluded}; unlabelable ${JSON.stringify(skip)} (no worker = shipped already or died before starting one, its own bucket); excluded by the hard rule: ${excluded} ${JSON.stringify(hard)} (first signal only); scored: ${records.length}; labels ${JSON.stringify(dist)}; other-direct-condition failures (a family can have several) ${JSON.stringify(disq)}`,
      'label rule: manager+n = two or more distinct workers (a -N worker successor counts); else direct = exactly one merged PR, no blocking question (mcp__flow__ask or pre-flight), no reviewer back event, no plan DAG nodes, no successor manager; else manager+1; unlabelable = no prompt, no worker or no merged PR',
      'hard rule: never direct for migrations, auth/permissions, secrets, deploy/CI/infra config, data rewrites or deletions; detected from the prompt text, the merged PR files, and a confirm-mode handover or approve event; those tasks are removed from scoring for every router',
      `evidence gaps: ${prefixOwned} worker ledger rows had no manager field and were matched by name prefix; ${liteUnknown} families had no lite state or Mode: lite line, so main's choice there is manager+1 (lite state unknown, not false); main only chose manager or lite, never a worker count: a non-lite choice agrees with manager+1 and manager+n alike (under/over count only across the direct/manager boundary), and the main row costs the real M+W (its choice is what ran, so vs as run is $0); plan nodes and blocking asks are read from transcripts (${planKnown ? 'present' : 'absent: counted as none'}), the inbox and preflight.json; the main router sees managers only, a flow:worker started by main with no manager has no record`,
      'rule routers: direct = Size: small or docs-only, manager+n = Size: large or two listed packages (Package/Part/WP lines), else manager+1; "docs PR" variant peeks at the outcome (the merged PRs\' files), so it is not usable at spawn; "Size small | docs prompt" uses the prompt alone',
    ],
  }
}

// ---- route scoring ----
export type RouterRow = { router: string; n: number; agree: number; under: number; over: number; usd: number; actualUsd: number; agree2: number; needless: number; wronglyDirect: number; usd2: number; fellThrough?: number }
export type RouteReport = { rows: RouterRow[]; model: string }
const ROUTE_COST_MODEL = `Cost model: the family's real spend from the ledger at hooks/cost.ts list prices (M = manager rows, W = worker rows); "as run" is M+W. Router answers priced by (answer, label): answer direct on a direct label = W + R, where R is a main PR review (main's average per-turn ledger cost x ${REVIEW_TURNS} turns) and the manager's spend is saved; answer direct on a manager label (under-shaped) = M + 2W + R (the rerun under a manager plus the failed direct attempt); answer manager+1 on a manager+n label (under-shaped) = M+W plus a successor manager, estimated as M again; an over-shaped answer (manager+1 or +n on a lighter label) costs M+W, as run (the wasted manager or workers are already in the ledger); the right class costs as run, except direct = W + R. "vs as run" is the router's total minus the real M+W over the same records (negative = cheaper). The direct-vs-any-manager table below it prices the same way with manager+1 and +n merged. The main row costs the real M+W. Under-shaped = picked a lower class than the label (lost review, or a successor or extra workers needed); over-shaped = picked a higher class (wasted manager or workers); both are shares of all scored records.`

export const costOfRoute = (m: RouteMeta, answer: RouteLabel): number => {
  if (answer === 'direct') return m.label === 'direct' ? m.workerUsd + m.reviewUsd : m.managerUsd + 2 * m.workerUsd + m.reviewUsd
  if (answer === 'manager+1' && m.label === 'manager+n') return 2 * m.managerUsd + m.workerUsd
  return m.managerUsd + m.workerUsd
}

// `asRun`: the main row. Main's choice is what ran, so its cost is the real M+W for every record, and since main only chose
// manager or lite (never a worker count) a non-lite choice agrees with both manager+1 and manager+n: under/over only count
// across the direct/manager boundary.
function scoreRouter(router: string, recs: { meta: RouteMeta; answer: RouteLabel }[], fellThrough?: number, asRun = false): RouterRow {
  const row: RouterRow = { router, n: recs.length, agree: 0, under: 0, over: 0, usd: 0, actualUsd: 0, agree2: 0, needless: 0, wronglyDirect: 0, usd2: 0, ...(fellThrough !== undefined ? { fellThrough } : {}) }
  for (const { meta, answer } of recs) {
    const actual = meta.managerUsd + meta.workerUsd
    const lenient = asRun && answer === 'manager+1' && meta.label !== 'direct'
    if (answer === meta.label || lenient) row.agree++
    else if (shape(answer) < shape(meta.label)) row.under++
    else row.over++
    row.usd += asRun ? actual : costOfRoute(meta, answer)
    row.actualUsd += actual
    // The collapsed view: direct against any manager.
    const said = answer === 'direct', was = meta.label === 'direct'
    if (said === was) row.agree2++
    else if (said) row.wronglyDirect++
    else row.needless++
    row.usd2 += asRun ? actual : said ? (was ? meta.workerUsd + meta.reviewUsd : meta.managerUsd + 2 * meta.workerUsd + meta.reviewUsd) : actual
  }
  return row
}

// Jev falls back to manager+1 (the middle class) on an error, a non-answer or a confidence under the threshold.
export function routeReport(records: EvalRecord[], results: Result[]): RouteReport {
  const byId = new Map(results.map(r => [r.id, r]))
  const withMeta = records.filter(r => r.route !== undefined).map(r => ({ meta: r.route!, id: r.id }))
  const jevAt = (min: number | undefined) => withMeta.map(({ meta, id }) => {
    const r = byId.get(id)
    const ok = r?.answer !== undefined && (ROUTE_LABELS as string[]).includes(r.answer) && (min === undefined || (r.confidence ?? 1) >= min)
    return { meta, answer: ok ? (r!.answer as RouteLabel) : ('manager+1' as RouteLabel), live: ok }
  })
  const all = (answer: (m: RouteMeta) => RouteLabel) => withMeta.map(({ meta }) => ({ meta, answer: answer(meta) }))
  const rule = (m: RouteMeta, docs: boolean): RouteLabel => (m.sizeSmall || docs ? 'direct' : m.sizeLarge || m.multiPackage ? 'manager+n' : 'manager+1')
  const rows: RouterRow[] = [
    scoreRouter('main (lite = direct)', all(m => m.main), undefined, true),
    scoreRouter('always direct', all(() => 'direct')),
    scoreRouter('always manager+1', all(() => 'manager+1')),
    scoreRouter('always manager+n', all(() => 'manager+n')),
    scoreRouter('rule: Size/packages | docs PR*', all(m => rule(m, m.docsOnlyPr))),
    scoreRouter('rule: Size/packages | docs prompt', all(m => rule(m, m.docsOnlyPrompt))),
  ]
  if (results.length > 0) {
    const live = jevAt(undefined).filter(x => x.live)
    rows.push(scoreRouter('jev (answered only)', live, withMeta.length - live.length))
    for (const t of [undefined, 0.7, 0.8]) {
      const a = jevAt(t)
      rows.push(scoreRouter(t === undefined ? 'jev, else manager+1' : `jev >= ${t}, else manager+1`, a, a.filter(x => !x.live).length))
    }
  }
  return { rows, model: ROUTE_COST_MODEL }
}
export const routeBaselines = (records: EvalRecord[]): RouteReport => routeReport(records, [])

export function formatRoute(r: RouteReport): string {
  const pc = (a: number, b: number): string => (b === 0 ? '-' : `${Math.round((100 * a) / b)}%`)
  const lines = ['router                           n    agree        under-shaped over-shaped  $ total   vs as run   fell-through']
  for (const x of r.rows) {
    lines.push(`${x.router.padEnd(32)} ${String(x.n).padEnd(4)} ${`${pc(x.agree, x.n)} (${x.agree})`.padEnd(12)} ${`${pc(x.under, x.n)} (${x.under})`.padEnd(12)} ${`${pc(x.over, x.n)} (${x.over})`.padEnd(12)} ${`$${x.usd.toFixed(2)}`.padEnd(9)} ${`${x.usd - x.actualUsd >= 0 ? '+' : '-'}$${Math.abs(x.usd - x.actualUsd).toFixed(2)}`.padEnd(11)} ${x.fellThrough ?? ''}`)
  }
  lines.push('')
  lines.push('direct vs any manager (the original question: is a manager needed at all)')
  lines.push('router                           n    agree        needless-mgr wrongly-direct $ total   vs as run')
  for (const x of r.rows) {
    lines.push(`${x.router.padEnd(32)} ${String(x.n).padEnd(4)} ${`${pc(x.agree2, x.n)} (${x.agree2})`.padEnd(12)} ${`${pc(x.needless, x.n)} (${x.needless})`.padEnd(12)} ${`${pc(x.wronglyDirect, x.n)} (${x.wronglyDirect})`.padEnd(14)} ${`$${x.usd2.toFixed(2)}`.padEnd(9)} ${`${x.usd2 - x.actualUsd >= 0 ? '+' : '-'}$${Math.abs(x.usd2 - x.actualUsd).toFixed(2)}`}`)
  }
  lines.push('* the docs-PR rule peeks at the outcome (merged PR files); the other rule and the rest use only what was known at spawn')
  lines.push(r.model)
  return lines.join('\n')
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
export type FeatureReport = { key: FeatureKey; n: number; labels: Record<string, number>; unit: Unit; rows: Row[]; histogram: Record<string, number>; results: Result[]; notes: string[]; errors: string[]; mustNotAutoAnswer?: { threshold: number; wronglyAnswered: number; of: number }[]; baseline?: { agree: number; n: number; nonTrivialFiles: number; agentStarted: number }; size?: SizeReport; route?: RouteReport }

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
  if (f.route) {
    const lines = [`== ${f.key}  (n=${f.n}; actual labels ${JSON.stringify(f.labels)}; routers scored against the label)`, formatRoute(f.route)]
    lines.push(`confidence histogram: ${BUCKETS.map(b => `${b}:${f.histogram[b]}`).join('  ')}`)
    if (f.errors.length > 0) lines.push(`errors (count as fall-through): ${f.errors.join('; ')}`)
    for (const note of f.notes) lines.push(`   ${note}`)
    return lines.join('\n')
  }
  if (f.size) {
    const lines = [`== ${f.key}  (n=${f.n}; actual labels ${JSON.stringify(f.labels)}; sizers scored against the implied right size)`, formatSize(f.size)]
    lines.push(`confidence histogram: ${BUCKETS.map(b => `${b}:${f.histogram[b]}`).join('  ')}`)
    if (f.errors.length > 0) lines.push(`errors (count as fall-through): ${f.errors.join('; ')}`)
    for (const note of f.notes) lines.push(`   ${note}`)
    return lines.join('\n')
  }
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
    // A size record replays against its implied right size; the label (under/over/ok) is reported with the sizers.
    const results = await replay(ask, ds.key === 'size' ? records.map(r => ({ ...r, label: r.size?.right ?? r.label })) : records, q, conc)
    const report = summarize(ds, results, units[ds.key], ds.key === 'conflict' ? r => r.answer === 'trivial' : undefined)
    if (ds.guard) {
      const g = await replay(ask, keep(ds.guard), q, conc)
      report.mustNotAutoAnswer = THRESHOLDS.map(threshold => ({ threshold, wronglyAnswered: g.filter(r => r.answer !== undefined && r.answer !== 'ask_main' && conf(r) >= threshold).length, of: g.length }))
    }
    if (ds.key === 'size') {
      report.size = sizeReport(records, results)
      report.labels = {}
      for (const r of records) report.labels[r.label] = (report.labels[r.label] ?? 0) + 1
    }
    if (ds.key === 'route') report.route = routeReport(records, results)
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
export type FlowSource = { read: (rel: string) => Promise<string | undefined>; readAbs: (path: string) => Promise<string | undefined>; maxContinues: number; transcripts?: TranscriptEvent[][]; prs?: Record<string, PrStat>; handovers?: { branch?: string; mode?: string }[] }
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
  const sizeSrc: SizeSource = { log, ledger, inbox: inbox.items ?? [], ...(src.transcripts ? { transcripts: src.transcripts } : {}), ...(src.prs ? { prs: src.prs } : {}) }
  const lite = await json<Record<string, unknown> | undefined>('lite.json', undefined)
  const pre = await json<{ entries?: RouteSource['preflight'] }>('preflight.json', {})
  const datasets = [inboxData(inbox.items ?? []), testData(log, src.transcripts), conflictData(log, src.transcripts), await handoffData(log, src.maxContinues, src.readAbs), sizeData(sizeSrc), routeData({ ...sizeSrc, ...(lite ? { lite } : {}), ...(pre.entries ? { preflight: pre.entries } : {}), ...(src.handovers ? { handovers: src.handovers } : {}) })]
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
