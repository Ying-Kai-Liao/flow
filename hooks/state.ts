import type { EngineInterface } from 'claude-code'

import type { Handover, LogEvent } from '../types'

// flow's state on disk: <git-common-dir>/flow/. Shared by every worktree of the repo, never part
// of a working tree. Every helper is best-effort: outside a repo, or when a write fails, it
// does nothing (a failure goes to $.ui.log) and never throws, so a tool call or turn never fails
// over state. `config.json` in this dir belongs to the settings package: never touched here.

const TEXT_MAX = 300
const NOTES_MAX = 3000

let cached: string | undefined

// Forget the resolved dir; a new session resolves it again.
export function resetStateDir(): void {
  cached = undefined
}

async function warn($: EngineInterface, what: string, err: unknown): Promise<void> {
  try {
    await $.ui.log(`flow state: ${what}: ${err instanceof Error ? err.message : String(err)}`)
  } catch {
    // No log to write to.
  }
}

// The state dir, or undefined when this is not a repo (or the answer is no absolute path).
export async function stateDir($: EngineInterface): Promise<string | undefined> {
  if (cached !== undefined) return cached
  try {
    const r = await $.process.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'])
    const out = r.stdout.trim()
    if (r.exitCode !== 0 || !out.startsWith('/') || out.includes('\n')) return undefined
    cached = `${out.replace(/\/+$/, '')}/flow`
    return cached
  } catch {
    return undefined
  }
}

// Write a temp file next to the target, then rename it over: a reader sees the old file or the new one.
export async function writeJsonAtomic($: EngineInterface, path: string, obj: unknown): Promise<boolean> {
  try {
    const tmp = `${path}.${Date.now()}.tmp`
    await $.fs.write(tmp, `${JSON.stringify(obj, null, 2)}\n`)
    const r = await $.process.run(['mv', tmp, path])
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || 'mv failed')
    return true
  } catch (err) {
    await warn($, `writing ${path}`, err)
    return false
  }
}

// The parsed file, or undefined when it is missing, unreadable or not JSON.
export async function readJson($: EngineInterface, path: string): Promise<unknown> {
  try {
    return JSON.parse(await $.fs.read(path))
  } catch {
    return undefined
  }
}

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// One line appended to log.jsonl. A single short append does not interleave with another session's.
export async function appendLog($: EngineInterface, event: Omit<LogEvent, 'ts'>): Promise<void> {
  try {
    const dir = await stateDir($)
    if (dir === undefined) return
    const ts = new Date(await $.clock.now()).toISOString()
    const entry: LogEvent = { ts, ...event }
    if (entry.text !== undefined) entry.text = cap(entry.text.replaceAll('\n', ' '), TEXT_MAX)
    await $.process.run(['mkdir', '-p', dir])
    const r = await $.process.run(['sh', '-c', 'printf "%s\\n" "$1" >> "$2"', 'sh', JSON.stringify(entry), `${dir}/log.jsonl`])
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || 'append failed')
  } catch (err) {
    await warn($, 'appending to log.jsonl', err)
  }
}

// Every parsable line, oldest first; a corrupt line is skipped.
export async function readLog($: EngineInterface): Promise<LogEvent[]> {
  const dir = await stateDir($)
  if (dir === undefined) return []
  let raw: string
  try {
    raw = await $.fs.read(`${dir}/log.jsonl`)
  } catch {
    return []
  }
  const events: LogEvent[] = []
  for (const line of raw.split('\n')) {
    try {
      const e = JSON.parse(line) as LogEvent
      if (typeof e === 'object' && e !== null && typeof e.event === 'string') events.push(e)
    } catch {
      // Skip a torn or corrupt line.
    }
  }
  return events
}

// "csv-export-2" and "csv-export" share one manager's notes.
export const noteKey = (name: string): string => name.replace(/-\d+$/, '').replace(/[^\w.-]/g, '_') || 'manager'

export async function notesPath($: EngineInterface, managerName: string): Promise<string | undefined> {
  const dir = await stateDir($)
  return dir === undefined ? undefined : `${dir}/managers/${noteKey(managerName)}/notes.md`
}

export async function appendNote($: EngineInterface, name: string, line: string): Promise<boolean> {
  try {
    const path = await notesPath($, name)
    if (path === undefined) return false
    const old = await $.fs.read(path).catch(() => `# ${name.replace(/-\d+$/, '')}\n`)
    // fs has no append: the file is rewritten whole. Notes are small and a manager is their only writer.
    await $.fs.write(path, `${old.endsWith('\n') ? old : `${old}\n`}${line}\n`)
    return true
  } catch (err) {
    await warn($, 'appending a note', err)
    return false
  }
}

// The notes, capped to their tail: the newest lines matter most.
export async function readNotes($: EngineInterface, name: string, max = NOTES_MAX): Promise<string> {
  try {
    const path = await notesPath($, name)
    if (path === undefined) return ''
    const text = await $.fs.read(path)
    return text.length > max ? `…${text.slice(text.length - max)}` : text
  } catch {
    return ''
  }
}

const STATUSES = new Set(['pending', 'taken', 'done', 'returned'])

// One file per PR, rewritten whole on every change. `version` is for readers of the file.
export async function saveHandover($: EngineInterface, h: Handover): Promise<void> {
  const dir = await stateDir($)
  if (dir === undefined) return
  await writeJsonAtomic($, `${dir}/handovers/${h.pr}.json`, { version: 1, ...h })
}

// Handovers earlier sessions left, keyed by PR. Unknown fields are kept; an unparsable file is absent.
export async function loadHandovers($: EngineInterface): Promise<Record<string, Handover>> {
  const out: Record<string, Handover> = {}
  const dir = await stateDir($)
  if (dir === undefined) return out
  let names: string[]
  try {
    names = (await $.fs.list(`${dir}/handovers`)).filter(f => f.name.endsWith('.json')).map(f => f.name)
  } catch {
    return out
  }
  for (const name of names) {
    const h = await readJson($, `${dir}/handovers/${name}`) as Handover | undefined
    if (typeof h !== 'object' || h === null || !Number.isInteger(h.pr) || !STATUSES.has(h.status)) continue
    out[String(h.pr)] = h
  }
  return out
}

// Who owns a PR or branch: the latest handover or spawn event that names it.
export function ownerFor(events: LogEvent[], match: { pr?: number; branch?: string }): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e === undefined || (e.event !== 'handover' && e.event !== 'spawn')) continue
    if ((match.pr !== undefined && e.pr === match.pr) || (match.branch !== undefined && e.branch === match.branch)) return e.owner
  }
  return undefined
}
