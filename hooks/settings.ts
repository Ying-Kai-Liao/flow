// Where the flow's settings come from, lowest to highest:
//   built-in defaults (settingsOf) < /config (the plugin's options)
//   < <repo>/.claude/flow.json (committed) < <git-common-dir>/flow/config.json (personal, uncommitted).
// Flat JSON, the same snake_case keys as /config. A key is replaced whole by a higher layer,
// except the APPEND_KEYS lists: the personal file adds to the repo file's list, and guard_tests, whose
// personal map is merged per glob (tests unioned). standing_answers appends
// too, but is parsed (standing.ts) into resolved rules: personal first, then repo, then /config.

import { parseRules } from './standing'
import type { Resolved } from './standing'
import { mergeGuardTests, parseGuardTests } from './guardtests'

type Kind = 'string' | 'number' | 'boolean' | 'list' | 'objects' | 'object' | 'globmap'

export const KEYS: Record<string, Kind> = {
  test_command: 'string',
  full_check_command: 'string',
  deploy_command: 'string',
  merge_method: 'string',
  merge_mode: 'string',
  reviewer: 'boolean',
  merge_queue: 'boolean',
  max_workers: 'number',
  context_warn_percent: 'number',
  context_warn_percent_1m: 'number',
  handoff: 'boolean',
  worker_model: 'string',
  manager_model: 'string',
  reviewer_model: 'string',
  queue_model: 'string',
  base_branch: 'string',
  language: 'string',
  big_files: 'list',
  big_file_lines: 'number',
  migrations_dir: 'string',
  decision_phrases: 'list',
  worker_checks: 'list',
  always_tests: 'list',
  flaky_tests: 'list',
  guard_tests: 'globmap',
  verify_paths: 'list',
  deploy_targets: 'objects',
  standing_answers: 'objects',
  state_file: 'object',
  test_slots: 'number',
  context_warn_tokens: 'number',
  max_managers: 'number',
  max_continues: 'number',
  main_checkout_guard: 'boolean',
  main_checkout_allow: 'string',
  cleanup: 'string',
  worker_harness: 'string',
  session_host: 'string',
  harnesses: 'object',
  min_quota: 'number',
  preflight: 'string',
  preflight_wait: 'number',
  release: 'string',
  release_files: 'list',
  changelog_file: 'string',
}

// String settings with a closed set of values: another value is dropped with a warning.
export const CHOICES: Record<string, string[]> = { preflight: ['on', 'off'], release: ['on', 'off'] }

export const APPEND_KEYS = ['worker_checks', 'always_tests', 'flaky_tests', 'big_files', 'decision_phrases']

// Sub-agents don't run on Fable: a model setting naming it is refused.
export const MODEL_KEYS = ['worker_model', 'manager_model', 'reviewer_model', 'queue_model']
export const isFable = (model: unknown): boolean => typeof model === 'string' && /fable/i.test(model)

export type Loaded = { raw: Record<string, unknown>; files: string[]; warnings: string[] }

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diag = row[0]!
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const up = row[j]!
      row[j] = Math.min(up + 1, row[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1))
      diag = up
    }
  }
  return row[b.length]!
}

function nearest(key: string): string | undefined {
  let best: string | undefined
  let at = 3
  for (const k of Object.keys(KEYS)) {
    const d = distance(key.toLowerCase(), k)
    if (d < at) { best = k; at = d }
  }
  return best
}

const isRecord = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v)

function typeOk(kind: Kind, v: unknown): boolean {
  if (kind === 'list') return v === null || (Array.isArray(v) && v.every(x => typeof x === 'string'))
  // Plugin options carry only strings, so deploy_targets and state_file may be a JSON string
  // (deployTargetsOf / stateFileOf parse it).
  if (kind === 'objects') return typeof v === 'string' || v === null || (Array.isArray(v) && v.every(isRecord))
  if (kind === 'object') return typeof v === 'string' || isRecord(v)
  // guard_tests: glob -> list of tests, as an object or (from /config) a JSON string of one.
  if (kind === 'globmap') return parseGuardTests(v) !== undefined
  if (kind === 'number') return typeof v === 'number' && Number.isFinite(v)
  return typeof v === kind
}

// The role was called the merge queue: its old keys are still read and mapped onto the new ones.
export const RENAMED: Record<string, string> = { merge_queue: 'reviewer', queue_model: 'reviewer_model' }
const RENAMED_DEFAULTS: Record<string, unknown> = { reviewer: true, reviewer_model: 'opus' }
// The first settings, built from the raw options before any file is read: old keys mapped, no warning (loading warns).
export function renameOptions(options: Record<string, unknown>): Record<string, unknown> {
  const out = { ...options }
  for (const [old, now] of Object.entries(RENAMED)) {
    if (!(old in out)) continue
    if (!(now in out) || out[now] === RENAMED_DEFAULTS[now]) out[now] = out[old]
    delete out[old]
  }
  return out
}
// Deprecation warnings already shown, so a settings re-check (mtime change) doesn't toast them again.
const warnedRenamed = new Set<string>()
export const resetRenamedWarnings = (): void => warnedRenamed.clear()

// One layer, checked: a bad value is dropped (with a warning) so the layer below it stands.
function checked(source: string, layer: Record<string, unknown>, warnings: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(layer)) {
    const kind = KEYS[k]
    if (kind === undefined) {
      const near = nearest(k)
      warnings.push(`${source}: unknown key "${k}"${near === undefined ? '' : ` (did you mean "${near}"?)`}`)
      out[k] = v
    } else if (!typeOk(kind, v)) {
      warnings.push(`${source}: "${k}" should be a ${kind === 'list' ? 'list of strings' : kind === 'objects' ? 'list of objects' : kind === 'globmap' ? 'object mapping a glob to a list of test strings' : kind}; ignored`)
    } else if (CHOICES[k] !== undefined && !CHOICES[k]!.includes(String(v))) {
      warnings.push(`${source}: "${k}" is ${JSON.stringify(v)}; use ${CHOICES[k]!.map(c => `"${c}"`).join(' or ')}; ignored`)
    } else if (MODEL_KEYS.includes(k) && isFable(v)) {
      warnings.push(`${source}: "${k}" is ${JSON.stringify(v)}; sub-agents don't run on Fable, using the default`)
    } else {
      if (k === 'decision_phrases' && Array.isArray(v) && v.length > 0) {
        warnings.push(`${source}: "decision_phrases" is deprecated in favour of the mcp__flow__ask tool (agents ask structured questions into the /flow inbox); it still works as a fallback`)
      }
      out[k] = kind === 'globmap' ? parseGuardTests(v) : v
    }
  }
  for (const [old, now] of Object.entries(RENAMED)) {
    if (!(old in out)) continue
    // The new key wins when the same layer sets both. /config always carries the new key at its
    // default, so there an old key set to something else is the user's earlier choice and wins.
    if (!(now in out) || (source === '/config' && out[now] === RENAMED_DEFAULTS[now])) out[now] = out[old]
    delete out[old]
    if (!warnedRenamed.has(`${source}|${old}`)) {
      warnedRenamed.add(`${source}|${old}`)
      warnings.push(`${source}: "${old}" is deprecated; use "${now}"`)
    }
  }
  return out
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

// Merge the layers, lowest first: the plugin's options, then each file's text (undefined = no file).
// Only the second file (the personal overlay) appends to list keys; the first replaces them.
export function mergeLayers(options: Record<string, unknown>, layers: { path: string; text: string | undefined }[]): Loaded {
  const warnings: string[] = []
  const raw = checked('/config', options, warnings)
  const files: string[] = []
  const rules: { personal: Resolved[]; repo: Resolved[]; config: Resolved[] } = { personal: [], repo: [], config: [] }
  let hasRules = false
  if ('standing_answers' in raw) {
    hasRules = true
    rules.config = parseRules(raw.standing_answers, 'config', '/config', warnings)
    delete raw.standing_answers
  }
  for (const [i, { path, text }] of layers.entries()) {
    if (text === undefined) continue
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch (err) {
      warnings.push(`${path}: not valid JSON, skipped (${err instanceof Error ? err.message : String(err)})`)
      continue
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      warnings.push(`${path}: not a JSON object, skipped`)
      continue
    }
    files.push(path)
    for (const [k, v] of Object.entries(checked(path, data as Record<string, unknown>, warnings))) {
      if (k === 'standing_answers') {
        hasRules = true
        rules[i > 0 ? 'personal' : 'repo'] = parseRules(v, i > 0 ? 'personal' : 'repo', path, warnings)
      } else if (i > 0 && k === 'guard_tests') {
        raw[k] = mergeGuardTests(raw[k] as Record<string, string[]> | undefined, v as Record<string, string[]>)
      } else if (i > 0 && APPEND_KEYS.includes(k)) raw[k] = [...new Set([...list(raw[k]), ...list(v)])]
      else raw[k] = v
    }
  }
  if (hasRules) raw.standing_answers = [...rules.personal, ...rules.repo, ...rules.config]
  return { raw, files, warnings }
}
