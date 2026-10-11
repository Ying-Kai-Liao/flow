// The io half of the main-only `decide_eval` tool (tools.ts): reads the flow state dir, replays it through decide() with
// the session's own settings (so the key stays in /config and never reaches an agent), writes the results next to the state.
import { decide } from './decide'
import type { DecideIo, DecideSettings, Question } from './decide'
import { EXPORT_FILE, FEATURES, formatSize, loadDatasets, parseExport, reportJson, reportText, runEval, sizeBaselines } from './decide-eval'
import type { FeatureKey } from './decide-eval'

export const DECIDE_EVAL_FILE = 'decide-eval.json'

export type DecideEvalIo = {
  stateDir: () => Promise<string | undefined>
  readFile: (path: string) => Promise<string | undefined>
  writeFile: (path: string, text: string) => Promise<void>
  decideIo: DecideIo
  now: () => Promise<number>
}

export async function decideEvalTool(io: DecideEvalIo, settings: DecideSettings & { maxContinues: number }, input: Record<string, unknown>, agentId: string | undefined): Promise<string> {
  if (agentId !== undefined) return 'Refused: only main runs decide_eval.'
  const provider = input.provider === 'jev' || input.provider === 'openai' ? input.provider : settings.decisionApi
  const dry = input.dry_run === true
  if (!dry && (provider === undefined || provider === 'off')) return 'Refused: decision_api is off. Set it to jev or openai in /config (with its key), or pass dry_run.'
  const dir = await io.stateDir()
  if (dir === undefined) return 'Refused: not in a git repo, so there is no flow state to replay.'
  const features = Array.isArray(input.features) ? FEATURES.filter(f => (input.features as unknown[]).includes(f)) : FEATURES
  const limit = typeof input.limit === 'number' && input.limit > 0 ? Math.floor(input.limit) : undefined
  // The export of scripts/decide-eval.mjs carries the transcript-derived sets; without it only the state dir is read.
  const exported = parseExport(await io.readFile(`${dir}/${EXPORT_FILE}`))
  const { datasets, units } = exported ?? await loadDatasets({ read: rel => io.readFile(`${dir}/${rel}`), readAbs: io.readFile, maxContinues: settings.maxContinues })
  const ageMin = exported === undefined ? 0 : Math.max(0, Math.round((await io.now() - Date.parse(exported.at)) / 60000))
  const sources = exported
    ? `Source: ${EXPORT_FILE} (export from ${exported.at}, ${ageMin} min old; rerun scripts/decide-eval.mjs --export to refresh).`
    : `Source: the flow state dir only (no ${EXPORT_FILE}; run scripts/decide-eval.mjs --export to add transcript-derived test failures and conflicts, otherwise those come from log.jsonl alone).`
  if (dry) {
    // Size also says how many spawns were labelable of how many, and what the key-free sizers score.
    const lines = datasets.filter(d => features.includes(d.key)).map(d => `${d.key}: ${d.records.length} records${d.guard ? ` (+${d.guard.length} must-not-auto-answer)` : ''}. Sample: ${(d.records[0]?.text ?? 'none').slice(0, 300).replace(/\n/g, ' / ')}${d.key === 'size' ? `\n  ${d.notes.join('\n  ')}\n${formatSize(sizeBaselines(d.records))}` : ''}`)
    return ['Dry run, no network.', ...lines, sources].join('\n')
  }
  const s: DecideSettings = { ...settings, decisionApi: provider as 'jev' | 'openai' }
  // A minimum confidence of 0 keeps the raw confidence of every answer; the thresholds are applied when scoring.
  const ask = (text: string, q: Question) => decide(io.decideIo, s, text, q, undefined, 0)
  const reports = await runEval(ask, datasets, units, { features: features as FeatureKey[], ...(limit !== undefined ? { limit } : {}) })
  const report = { provider: provider as string, at: new Date(await io.now()).toISOString(), features: reports }
  const path = `${dir}/${DECIDE_EVAL_FILE}`
  await io.writeFile(path, reportJson(report))
  return `${reportText(report)}\n\n${sources}\nResults (ids, labels, answers, confidences) written to ${path}.`
}
