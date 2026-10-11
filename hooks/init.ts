// /flow init: detection of what a repo offers, the validated settings write, the first-run hint and the
// command's text. Pure functions over an InitIo (register.tsx builds it; the engine refuses `$` across an
// import). Detected commands are suggestions only: nothing is written unless the user chose it.

import { isFable, KEYS, CHOICES, MODEL_KEYS } from './settings'

export type Ran = { exitCode: number; stdout: string; stderr: string }

export type InitIo = {
  // The file's text, undefined when it is missing or unreadable.
  readFile: (path: string) => Promise<string | undefined>
  exists: (path: string) => Promise<boolean>
  writeFile: (path: string, text: string) => Promise<boolean>
  mkdirp: (dir: string) => Promise<unknown>
  // A failure to start is an exit code, never a throw.
  run: (argv: string[]) => Promise<Ran>
}

// The keys init asks for (the Core settings of /config) and the closed choices of those the shared CHOICES lacks.
export const CORE_KEYS = ['test_command', 'full_check_command', 'deploy_command', 'merge_mode', 'push_mode', 'release', 'manager_model', 'worker_model', 'max_workers']
const EXTRA_CHOICES: Record<string, string[]> = { merge_mode: ['auto', 'confirm'] }
const choicesOf = (key: string): string[] | undefined => CHOICES[key] ?? EXTRA_CHOICES[key]

export const MARKER = 'init-done'

export type Candidate = { command: string; source: string; role: 'test' | 'check' | 'other' }
export type LayerInfo = { name: 'config' | 'repo' | 'personal'; path: string; state: 'missing' | 'ok' | 'invalid'; error?: string; values: Record<string, unknown> }
export type Detected = {
  isRepo: boolean
  top: string
  common: string
  candidates: Candidate[]
  base: string
  hasRemote: boolean
  ghInstalled: boolean
  ghAuthed: boolean
  layers: LayerInfo[]
  marker: boolean
}

export const repoFile = (top: string): string => `${top}/.claude/flow.json`
export const personalFile = (common: string): string => `${common}/flow/config.json`
export const markerFile = (common: string): string => `${common}/flow/${MARKER}`

function manager(has: (f: string) => boolean): 'pnpm' | 'yarn' | 'bun' | 'npm' {
  return has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm'
}

// Test and check candidates from the files a repo already has. Never invented: each names its source.
export async function candidatesOf(io: Pick<InitIo, 'readFile' | 'exists'>, top: string): Promise<Candidate[]> {
  const out: Candidate[] = []
  const known = new Set<string>()
  for (const f of ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'package-lock.json']) if (await io.exists(`${top}/${f}`)) known.add(f)
  const pkg = await io.readFile(`${top}/package.json`)
  if (pkg !== undefined) {
    let scripts: Record<string, unknown> = {}
    try {
      const s = (JSON.parse(pkg) as { scripts?: unknown }).scripts
      if (typeof s === 'object' && s !== null) scripts = s as Record<string, unknown>
    } catch { /* an unreadable package.json offers nothing */ }
    const pm = manager(f => known.has(f))
    for (const name of ['test', 'check', 'lint', 'typecheck', 'build']) {
      if (typeof scripts[name] !== 'string') continue
      out.push({ command: pm === 'npm' && name === 'test' ? 'npm test' : `${pm} run ${name}`, source: `package.json scripts.${name}`, role: name === 'test' ? 'test' : name === 'check' ? 'check' : 'other' })
    }
  }
  const make = await io.readFile(`${top}/Makefile`)
  if (make !== undefined) {
    for (const name of ['test', 'check']) if (new RegExp(`^${name}\\s*:`, 'm').test(make)) out.push({ command: `make ${name}`, source: `Makefile target ${name}`, role: name as 'test' | 'check' })
  }
  const py = await io.readFile(`${top}/pyproject.toml`)
  if (py !== undefined && /pytest/i.test(py)) out.push({ command: 'pytest', source: 'pyproject.toml (pytest)', role: 'test' })
  if (await io.exists(`${top}/Cargo.toml`)) out.push({ command: 'cargo test', source: 'Cargo.toml', role: 'test' })
  if (await io.exists(`${top}/go.mod`)) out.push({ command: 'go test ./...', source: 'go.mod', role: 'test' })
  return out
}

async function layerOf(io: Pick<InitIo, 'readFile'>, name: LayerInfo['name'], path: string): Promise<LayerInfo> {
  const text = path === '' ? undefined : await io.readFile(path)
  if (text === undefined) return { name, path, state: 'missing', values: {} }
  try {
    const data: unknown = JSON.parse(text)
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return { name, path, state: 'invalid', error: 'not a JSON object', values: {} }
    return { name, path, state: 'ok', values: data as Record<string, unknown> }
  } catch (err) {
    return { name, path, state: 'invalid', error: err instanceof Error ? err.message : String(err), values: {} }
  }
}

// Everything the skill and the command need to know about the repo. `options` are the /config values.
export async function detect(io: InitIo, options: Record<string, unknown>): Promise<Detected> {
  const git = async (...args: string[]) => (await io.run(['git', ...args]))
  const topR = await git('rev-parse', '--show-toplevel')
  const empty = (): Detected => ({ isRepo: false, top: '', common: '', candidates: [], base: '', hasRemote: false, ghInstalled: false, ghAuthed: false, layers: [], marker: false })
  if (topR.exitCode !== 0 || topR.stdout.trim() === '') return empty()
  const top = topR.stdout.trim()
  const commonR = await git('rev-parse', '--path-format=absolute', '--git-common-dir')
  const common = commonR.exitCode === 0 ? commonR.stdout.trim().replace(/\/+$/, '') : ''
  const head = await git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
  const baseOpt = typeof options.base_branch === 'string' && options.base_branch.trim() !== '' ? options.base_branch.trim() : undefined
  const cfg: LayerInfo = { name: 'config', path: '/config', state: Object.keys(options).length > 0 ? 'ok' : 'missing', values: options }
  const layers = [cfg, await layerOf(io, 'repo', repoFile(top)), common === '' ? { name: 'personal' as const, path: '', state: 'missing' as const, values: {} } : await layerOf(io, 'personal', personalFile(common))]
  const fileBase = [layers[2]!, layers[1]!, cfg].map(l => l.values.base_branch).find((v): v is string => typeof v === 'string' && v.trim() !== '')
  const remotes = await git('remote')
  const gh = await io.run(['gh', '--version'])
  const auth = gh.exitCode === 0 ? await io.run(['gh', 'auth', 'status']) : undefined
  return {
    isRepo: true, top, common,
    candidates: await candidatesOf(io, top),
    base: fileBase ?? baseOpt ?? (head.exitCode === 0 && head.stdout.trim() !== '' ? head.stdout.trim().replace(/^origin\//, '') : 'main'),
    hasRemote: remotes.exitCode === 0 && remotes.stdout.trim() !== '',
    ghInstalled: gh.exitCode === 0,
    ghAuthed: auth?.exitCode === 0,
    layers,
    marker: common !== '' && await io.exists(markerFile(common)),
  }
}

// The first-run hint: no settings file in either place and init never run in this repo. Cheap: git and file checks only.
export async function firstRun(io: Pick<InitIo, 'run' | 'exists'>): Promise<boolean> {
  const top = await io.run(['git', 'rev-parse', '--show-toplevel'])
  const common = await io.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (top.exitCode !== 0 || common.exitCode !== 0 || top.stdout.trim() === '' || common.stdout.trim() === '') return false
  const dir = common.stdout.trim().replace(/\/+$/, '')
  for (const f of [repoFile(top.stdout.trim()), personalFile(dir), markerFile(dir)]) if (await io.exists(f)) return false
  return true
}

export const HINT = 'New to flow? Run /flow init for a walkthrough, a demo and settings.'

export async function writeMarker(io: InitIo, d: Detected): Promise<void> {
  if (!d.isRepo || d.common === '') return
  await io.mkdirp(`${d.common}/flow`)
  await io.writeFile(markerFile(d.common), 'init was run in this repo\n')
}

const show = (v: unknown): string => (v === undefined ? '-' : typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v))

// The facts as lines: for the command's text and the settings tool's `show`.
export function factLines(d: Detected): string[] {
  const lines = [`Repo: ${d.top}`, `Base branch: ${d.base}`, `Remote: ${d.hasRemote ? 'yes' : 'none (the demo and settings still work; push, PRs and release_github need a remote)'}`,
    `gh: ${!d.ghInstalled ? 'not installed' : d.ghAuthed ? 'installed and logged in' : 'installed, not logged in (gh auth login)'}`]
  const cands = d.candidates.map(c => `${c.command} (${c.source})`)
  lines.push(`Detected commands (suggestions only): ${cands.length === 0 ? 'none' : cands.join('; ')}`)
  for (const l of d.layers) {
    const where = l.name === 'config' ? '/config options' : l.name === 'repo' ? `repo file ${l.path} (committed, shared)` : `personal file ${l.path || '(no repo)'} (uncommitted)`
    if (l.state === 'invalid') { lines.push(`${where}: INVALID JSON (${l.error}); fix it by hand first, flow will not write to it`); continue }
    if (l.state === 'missing') { lines.push(`${where}: not set`); continue }
    lines.push(`${where}: ${CORE_KEYS.map(k => `${k}=${show(l.values[k])}`).join(', ')}`)
  }
  return lines
}

// --- The settings write ---

// Keys never go in settings: they stay in env or ~/.config files.
const SECRET_VALUE = [
  /\bsk-[A-Za-z0-9_-]{16,}/, /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9]{16,}/, /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bAIza[0-9A-Za-z_-]{30,}/,
  /\b[A-Z0-9_]*(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD)[A-Z0-9_]*\s*=\s*\S+/i, /\bBearer\s+[A-Za-z0-9._-]{16,}/i, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
]
const looksSecret = (s: string): boolean => SECRET_VALUE.some(re => re.test(s)) || (/^[A-Za-z0-9_-]{32,}$/.test(s) && /\d/.test(s) && /[A-Za-z]/.test(s))

// Why one value is refused, or undefined when it may be written. null removes the key.
export function refuse(key: string, v: unknown): string | undefined {
  const kind = KEYS[key]
  if (kind === undefined) return `"${key}" is not a flow setting`
  if (v === null) return undefined
  if (kind === 'objects' || kind === 'object' || kind === 'globmap') return `"${key}" is edited by hand in the file (init writes plain values only)`
  if (kind === 'list') {
    if (!Array.isArray(v) || !v.every(x => typeof x === 'string')) return `"${key}" must be a list of strings`
  } else if (kind === 'number') {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || !Number.isInteger(v)) return `"${key}" must be a whole number of 1 or more`
  } else if (typeof v !== kind) return `"${key}" must be a ${kind}`
  const texts = typeof v === 'string' ? [v] : Array.isArray(v) ? (v as string[]) : []
  if (texts.some(looksSecret)) return `"${key}" looks like it holds a secret or API key; keys never go in settings (keep them in env or ~/.config files)`
  const choices = choicesOf(key)
  if (choices !== undefined && !choices.includes(v as string)) return `"${key}" must be one of ${choices.join(', ')}`
  if (MODEL_KEYS.includes(key) && isFable(v)) return `"${key}": sub-agents don't run on Fable`
  return undefined
}

export type WriteResult = { ok: boolean; text: string }

// Merges `values` into the layer's file: reads it, keeps every other key, null removes one, writes 2-space JSON.
// All values are checked first: one refusal writes nothing.
export async function writeSettings(io: InitIo, d: Detected, layer: unknown, values: unknown): Promise<WriteResult> {
  if (!d.isRepo) return { ok: false, text: 'Not written: this is not a git repository.' }
  if (layer !== 'repo' && layer !== 'personal') return { ok: false, text: 'Not written: layer must be "repo" (committed, shared) or "personal" (uncommitted).' }
  if (typeof values !== 'object' || values === null || Array.isArray(values) || Object.keys(values).length === 0) return { ok: false, text: 'Not written: values must be a non-empty object of setting names to values (null removes one).' }
  const entries = Object.entries(values as Record<string, unknown>)
  const bad = entries.flatMap(([k, v]) => { const why = refuse(k, v); return why === undefined ? [] : [why] })
  if (bad.length > 0) return { ok: false, text: `Not written, nothing changed:\n${bad.map(b => `- ${b}`).join('\n')}` }
  const info = d.layers.find(l => l.name === layer)
  if (info === undefined || info.path === '') return { ok: false, text: 'Not written: the personal file needs a repo.' }
  if (info.state === 'invalid') return { ok: false, text: `Not written: ${info.path} is not valid JSON (${info.error}); fix it first, flow does not overwrite it.` }
  const next: Record<string, unknown> = { ...info.values }
  for (const [k, v] of entries) { if (v === null) delete next[k]; else next[k] = v }
  await io.mkdirp(info.path.replace(/\/[^/]*$/, ''))
  if (!await io.writeFile(info.path, `${JSON.stringify(next, null, 2)}\n`)) return { ok: false, text: `Not written: could not write ${info.path}.` }
  const shared = layer === 'repo' ? ' It is the repo file: commit it to share it with the team.' : ' It is the personal file: not committed.'
  return { ok: true, text: `Wrote ${entries.map(([k, v]) => (v === null ? `${k} removed` : `${k}=${JSON.stringify(v)}`)).join(', ')} to ${info.path}.${shared} Flow reloads settings within a few seconds.` }
}

// The settings tool. Only main may call it.
export async function settingsTool(io: InitIo, options: Record<string, unknown>, input: Record<string, unknown>, agentId: string | undefined): Promise<{ result: string }> {
  if (agentId !== undefined) return { result: 'Refused: only main reads or writes settings. Ask main in the chat.' }
  const action = String(input.action ?? 'show')
  const d = await detect(io, options)
  if (action === 'show') return { result: d.isRepo ? factLines(d).join('\n') : 'Not a git repository: flow needs one.' }
  if (action === 'write') return { result: (await writeSettings(io, d, input.layer, input.values)).text }
  return { result: 'Unknown action. Use "show" or "write".' }
}

// --- The /flow init command ---

export type InitCmdIo = {
  detect: () => Promise<Detected>
  markDone: (d: Detected) => Promise<void>
  demoStart: () => Promise<string>
  demoStop: () => Promise<string>
  after: (ms: number, fn: () => void) => void
  submit: (text: string) => Promise<unknown>
}

export const INIT_USAGE = 'Usage: /flow init (walkthrough, demo and settings), /flow init settings, /flow init demo (a free replay in the pane), /flow init demo live (runs it for real, uses tokens), /flow init demo stop'

function instructions(part: 'all' | 'settings' | 'live', facts: string[]): string {
  return [
    `The user ran /flow init ${part === 'all' ? '' : part === 'live' ? 'demo live' : 'settings'}. Follow the flow:init skill (Skill tool, skill "flow:init"), part: ${part}.`,
    part === 'all' ? 'Walk through, offer the free replay (mcp__flow__demo start), then do the settings.' : part === 'live' ? 'Run only the live demo section (it uses tokens: say so and confirm first).' : 'Do only the settings section.',
    'Detected facts (suggestions only; write nothing the user did not choose):',
    ...facts,
  ].join('\n')
}

export async function initCommand(io: InitCmdIo, words: string[]): Promise<{ text: string; context?: string[] }> {
  const [part, sub, ...rest] = words
  const ok = part === undefined ? sub === undefined
    : part === 'settings' ? sub === undefined
      : part === 'demo' && (sub === undefined || ((sub === 'live' || sub === 'stop') && rest.length === 0))
  if (!ok || rest.length > 0) return { text: INIT_USAGE }
  const d = await io.detect()
  if (!d.isRepo) return { text: 'flow needs a git repository: run /flow init inside one (git init, or cd into your project).' }
  await io.markDone(d)
  if (part === 'demo' && sub === undefined) return { text: await io.demoStart() }
  if (part === 'demo' && sub === 'stop') return { text: await io.demoStop() }
  const which = part === 'settings' ? 'settings' : part === 'demo' ? 'live' : 'all'
  const head = which === 'all' ? 'flow init: a short walkthrough, then a demo (a free replay in the pane, or a real run that uses tokens), then your settings.'
    : which === 'live' ? 'flow init: the real demo (uses tokens): a throwaway change in its own worktree, nothing pushed.' : 'flow init: your settings.'
  // As /flow resume does: the instructions ride as hidden context, and a short prompt submitted after
  // the command returns makes the main session act on them.
  io.after(0, () => { void io.submit(`Follow the /flow init instructions (flow:init skill, part: ${which}).`).catch(() => undefined) })
  return { text: [head, ...factLines(d)].join('\n'), context: [instructions(which, factLines(d))] }
}
