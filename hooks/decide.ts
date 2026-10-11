// One small decision API: ask a provider a choice or yes/no question about a text. Providers are plain functions
// (jev.ts, openai.ts) that take the injected fetch (the engine's $.http.fetch in register.tsx), so tests need no
// network. Keys and base URLs come from /config only. Any failure is a short note and the caller falls back to
// its default. The key and response bodies never reach a note.
import { askJev, jevConfig } from './jev'
import { askOpenai, OPENAI_DEFAULT_MODEL, openaiConfig } from './openai'

export const DECIDE_TIMEOUT_MS = 5000
export const DECIDE_MIN_CONFIDENCE = 0.5
export const DECIDE_TEXT_MAX = 8000
export const JEV_DEFAULT_MODEL = 'jev-latest'
// The project's tsconfig has no node or DOM libs, so the timer globals are typed here.
const g = globalThis as unknown as { setTimeout: (f: () => void, ms: number) => unknown; clearTimeout: (t: unknown) => void }

export type DecisionApi = 'off' | 'jev' | 'openai'

// `id` is the key a provider may answer under; a choice lists its options with criteria, a yes/no answers "yes" or "no".
export type Question =
  | { id: string; type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { id: string; type: 'yesno'; instructions: string }
export type Decision = { answer: string; confidence?: number } | { note: string }

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>
export type ProviderConfig = { key?: string; baseUrl: string }
export type Provider = (fetchFn: FetchLike, cfg: ProviderConfig, model: string, text: string, q: Question, timeoutMs?: number) => Promise<Decision>

export const optionsOf = (q: Question): string[] => (q.type === 'choice' ? Object.keys(q.criteria) : ['yes', 'no'])
// Both providers get a yes/no as a choice between yes and no.
export const criteriaOf = (q: Question): Record<string, string> => (q.type === 'choice' ? q.criteria : { yes: 'the answer is yes', no: 'the answer is no' })

// What a provider reads: the text without its Size line (that would answer the sizing question), capped.
export const decisionText = (text: string): string => text.replace(/^Size:.*(?:\r?\n|$)/gim, '').slice(0, DECIDE_TEXT_MAX)

// Shared by the providers: the timer, and one note per failure kind.
export async function post(fetchFn: FetchLike, name: string, url: string, key: string, body: unknown, timeoutMs: number, parse: (json: unknown) => Decision): Promise<Decision> {
  const ac = new AbortController()
  let timer: unknown
  // The race, not the signal alone, ends the wait: the engine's fetch takes no signal.
  const timedOut = new Promise<'timeout'>(resolve => { timer = g.setTimeout(() => { ac.abort(); resolve('timeout') }, timeoutMs) })
  try {
    const res = await Promise.race([fetchFn(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    }), timedOut])
    if (res === 'timeout') return { note: `${name} unavailable: timeout` }
    if (!res.ok) return { note: `${name} unavailable: HTTP ${res.status}` }
    let json: unknown
    try { json = await res.json() } catch { return { note: `${name} unavailable: bad response` } }
    return parse(json)
  } catch {
    return { note: ac.signal.aborted ? `${name} unavailable: timeout` : `${name} unavailable: network error` }
  } finally {
    g.clearTimeout(timer)
  }
}

export type DecideIo = { fetch: FetchLike }
// The keys and base URLs are /config options (sensitive keys), never read from the environment or a file.
export type DecideSettings = { decisionApi?: DecisionApi; jevModel?: string; openaiModel?: string; jevApiKey?: string; jevBaseUrl?: string; openaiApiKey?: string; openaiBaseUrl?: string }

// How the decision text names the provider ("jev", "openai gpt-4.1-mini").
export const sourceOf = (s: DecideSettings): string => (s.decisionApi === 'openai' ? `openai ${s.openaiModel ?? OPENAI_DEFAULT_MODEL}` : 'jev')

export async function decide(io: DecideIo, s: DecideSettings, text: string, q: Question, timeoutMs = DECIDE_TIMEOUT_MS): Promise<Decision> {
  if (s.decisionApi === 'openai') return askOpenai(io.fetch, openaiConfig(s), s.openaiModel ?? OPENAI_DEFAULT_MODEL, text, q, timeoutMs)
  if (s.decisionApi === 'jev') return askJev(io.fetch, jevConfig(s), s.jevModel ?? JEV_DEFAULT_MODEL, text, q, timeoutMs)
  return { note: 'decision api off' }
}
