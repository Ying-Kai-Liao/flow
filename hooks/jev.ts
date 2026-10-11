// Optional size classifier: TypeSafe's Jev decides small|normal|large for a brief at spawn (size_model "jev").
// The pure parts live here and fetch is injected, so tests need no network. Any failure is a short note
// and the caller falls back to the brief's Size line. The key and response bodies never reach a note.
import { isSize, type Size } from './routing'

export const JEV_DEFAULT_URL = 'https://api.typesafe.ai'
export const JEV_TIMEOUT_MS = 5000
export const JEV_MIN_CONFIDENCE = 0.5
export const JEV_STATE_MAX = 8000
// The project's tsconfig has no node or DOM libs, so the timer globals are typed here.
const g = globalThis as unknown as { setTimeout: (f: () => void, ms: number) => unknown; clearTimeout: (t: unknown) => void }

export const JEV_ENV_FILE = '.config/jev/env'

// KEY=value lines; tolerates `export `, quotes and comments.
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw)
    if (m === null) continue
    let v = m[2]!
    const q = /^(["'])(.*?)\1/.exec(v)
    v = q !== null ? q[2]! : v.replace(/\s+#.*$/, '')
    out[m[1]!] = v
  }
  return out
}

// Env vars first, then the file's values.
export function jevConfig(env: Record<string, string | undefined>, fileText: string | undefined): { key?: string; baseUrl: string } {
  const file = fileText === undefined ? {} : parseEnvFile(fileText) as Record<string, string | undefined>
  const key = env.JEV_API_KEY || file.JEV_API_KEY
  const baseUrl = (env.JEV_BASE_URL || file.JEV_BASE_URL || JEV_DEFAULT_URL).replace(/\/+$/, '')
  return { ...(key ? { key } : {}), baseUrl }
}

// What Jev reads: the brief without its Size line (that would answer the question), capped.
export const jevState = (prompt: string): string => prompt.replace(/^Size:.*(?:\r?\n|$)/gim, '').slice(0, JEV_STATE_MAX)

export function jevBody(prompt: string, model: string): unknown {
  return {
    model,
    state: jevState(prompt),
    questions: {
      size: {
        type: 'choice',
        instructions: 'How big is this coding task for an agent?',
        criteria: {
          small: 'docs, a one-file fix, a rename or a mechanical change',
          normal: 'an ordinary change in a few files with clear scope',
          large: 'cross-cutting work, big files, unclear scope, or needs long context',
        },
      },
    },
  }
}

export type JevAnswer = { size: Size; confidence: number } | { note: string }

export function parseJev(json: unknown): JevAnswer {
  const a = (json as { answers?: { size?: { choice?: unknown; confidence?: unknown } } } | null)?.answers?.size
  if (a === undefined || a === null || typeof a !== 'object') return { note: 'jev unavailable: bad response' }
  if (!isSize(a.choice)) return { note: 'jev unavailable: unknown choice' }
  if (typeof a.confidence !== 'number' || Number.isNaN(a.confidence)) return { note: 'jev unavailable: bad response' }
  if (a.confidence < JEV_MIN_CONFIDENCE) return { note: `jev unavailable: low confidence ${a.confidence.toFixed(2)}` }
  return { size: a.choice, confidence: a.confidence }
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

export async function askJev(fetchFn: FetchLike, cfg: { key?: string; baseUrl: string }, model: string, prompt: string, timeoutMs = JEV_TIMEOUT_MS): Promise<JevAnswer> {
  if (cfg.key === undefined) return { note: 'jev unavailable: no key' }
  const ac = new AbortController()
  const timer = g.setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetchFn(`${cfg.baseUrl}/v1/systemone`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(jevBody(prompt, model)),
      signal: ac.signal,
    })
    if (!res.ok) return { note: `jev unavailable: HTTP ${res.status}` }
    let json: unknown
    try { json = await res.json() } catch { return { note: 'jev unavailable: bad response' } }
    return parseJev(json)
  } catch {
    return { note: ac.signal.aborted ? 'jev unavailable: timeout' : 'jev unavailable: network error' }
  } finally {
    g.clearTimeout(timer)
  }
}

// How the decision text says where the size came from.
export const jevTag = (confidence: number, brief: Size | undefined, size: Size): string =>
  `jev ${confidence.toFixed(2)}${brief !== undefined && brief !== size ? `; brief said ${brief}` : ''}`
