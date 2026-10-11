// Optional size classifier through an OpenAI chat model (size_model "openai"): same question and criteria as Jev (jev.ts),
// answered with Chat Completions structured outputs. Fetch is injected, so tests need no network. Any failure is a short
// note and the caller falls back to the brief's Size line. The key and response bodies never reach a note.
import { isSize, type Size } from './routing'
import { JEV_MIN_CONFIDENCE, JEV_TIMEOUT_MS, jevState } from './jev'
import type { FetchLike } from './jev'

export const OPENAI_DEFAULT_URL = 'https://api.openai.com/v1'
export const OPENAI_DEFAULT_MODEL = 'gpt-4.1-mini'
const g = globalThis as unknown as { setTimeout: (f: () => void, ms: number) => unknown; clearTimeout: (t: unknown) => void }

export type OpenAiAnswer = { size: Size; confidence?: number } | { note: string }

export function openaiConfig(env: Record<string, string | undefined>): { key?: string; baseUrl: string } {
  const key = env.OPENAI_API_KEY
  const baseUrl = (env.OPENAI_BASE_URL || OPENAI_DEFAULT_URL).replace(/\/+$/, '')
  return { ...(key ? { key } : {}), baseUrl }
}

const SYSTEM = [
  'You size a coding task for an agent. Reply with JSON: {"size": "small" | "normal" | "large"}.',
  'small: docs, a one-file fix, a rename or a mechanical change.',
  'normal: an ordinary change in a few files with clear scope.',
  'large: cross-cutting work, big files, unclear scope, or needs long context.',
].join('\n')

export function openaiBody(prompt: string, model: string): unknown {
  return {
    model,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: jevState(prompt) }],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'task_size',
        strict: true,
        schema: { type: 'object', properties: { size: { enum: ['small', 'normal', 'large'] } }, required: ['size'], additionalProperties: false },
      },
    },
    temperature: 0,
    logprobs: true,
    max_completion_tokens: 20,
  }
}

type Tok = { token?: unknown; logprob?: unknown }

// Probability of the tokens that carry the size value: lay the tokens over the message text, find the value after the
// "size" key, and multiply the probabilities of the tokens that overlap it. undefined when the layout can't be trusted.
export function sizeConfidence(content: string, tokens: unknown): number | undefined {
  if (!Array.isArray(tokens)) return undefined
  const m = /"size"\s*:\s*"(small|normal|large)"/.exec(content)
  if (m === null) return undefined
  const start = m.index + m[0].length - 1 - m[1]!.length
  const end = start + m[1]!.length
  let pos = 0
  let logp = 0
  let hit = false
  for (const t of tokens as Tok[]) {
    if (typeof t?.token !== 'string' || typeof t.logprob !== 'number' || Number.isNaN(t.logprob)) return undefined
    const from = pos
    pos += t.token.length
    if (pos > start && from < end) { logp += t.logprob; hit = true }
  }
  return hit && pos === content.length ? Math.exp(logp) : undefined
}

export function parseOpenai(json: unknown): OpenAiAnswer {
  const choice = (json as { choices?: { message?: { content?: unknown }; logprobs?: { content?: unknown } | null }[] } | null)?.choices?.[0]
  const content = choice?.message?.content
  if (typeof content !== 'string') return { note: 'openai unavailable: bad response' }
  let parsed: unknown
  try { parsed = JSON.parse(content) } catch { return { note: 'openai unavailable: bad response' } }
  const size = (parsed as { size?: unknown } | null)?.size
  if (!isSize(size)) return { note: size === undefined ? 'openai unavailable: bad response' : 'openai unavailable: unknown choice' }
  // Without usable logprobs the answer stands without the threshold.
  const confidence = sizeConfidence(content, choice?.logprobs?.content)
  if (confidence === undefined) return { size }
  if (confidence < JEV_MIN_CONFIDENCE) return { note: `openai unavailable: low confidence ${confidence.toFixed(2)}` }
  return { size, confidence }
}

export async function askOpenai(fetchFn: FetchLike, cfg: { key?: string; baseUrl: string }, model: string, prompt: string, timeoutMs = JEV_TIMEOUT_MS): Promise<OpenAiAnswer> {
  if (cfg.key === undefined) return { note: 'openai unavailable: no key' }
  const ac = new AbortController()
  const timer = g.setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetchFn(`${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(openaiBody(prompt, model)),
      signal: ac.signal,
    })
    if (!res.ok) return { note: `openai unavailable: HTTP ${res.status}` }
    let json: unknown
    try { json = await res.json() } catch { return { note: 'openai unavailable: bad response' } }
    return parseOpenai(json)
  } catch {
    return { note: ac.signal.aborted ? 'openai unavailable: timeout' : 'openai unavailable: network error' }
  } finally {
    g.clearTimeout(timer)
  }
}
