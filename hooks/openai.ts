// The OpenAI provider of the decision API (decide.ts, decision_api "openai"): Chat Completions with a strict
// json_schema whose enum is the question's options. Fetch is injected, so tests need no network. The key and
// response bodies never reach a note.
import { criteriaOf, decisionText, DECIDE_MIN_CONFIDENCE, DECIDE_TIMEOUT_MS, optionsOf, post } from './decide'
import type { Decision, Provider, Question } from './decide'

export const OPENAI_DEFAULT_URL = 'https://api.openai.com/v1'
export const OPENAI_DEFAULT_MODEL = 'gpt-4.1-mini'

export function openaiConfig(env: Record<string, string | undefined>): { key?: string; baseUrl: string } {
  const key = env.OPENAI_API_KEY
  const baseUrl = (env.OPENAI_BASE_URL || OPENAI_DEFAULT_URL).replace(/\/+$/, '')
  return { ...(key ? { key } : {}), baseUrl }
}

export function openaiBody(text: string, model: string, q: Question): unknown {
  const options = optionsOf(q)
  const system = [
    q.instructions,
    `Reply with JSON: {"answer": ${options.map(o => `"${o}"`).join(' | ')}}.`,
    ...Object.entries(criteriaOf(q)).map(([k, v]) => `${k}: ${v}.`),
  ].join('\n')
  return {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: decisionText(text) }],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: q.id,
        strict: true,
        schema: { type: 'object', properties: { answer: { enum: options } }, required: ['answer'], additionalProperties: false },
      },
    },
    temperature: 0,
    logprobs: true,
    max_completion_tokens: 20,
  }
}

type Tok = { token?: unknown; logprob?: unknown }
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Probability of the tokens that carry the answer value: lay the tokens over the message text, find the value after
// the "answer" key, and multiply the probabilities of the tokens that overlap it. undefined when the layout can't be trusted.
export function answerConfidence(content: string, tokens: unknown, options: string[]): number | undefined {
  if (!Array.isArray(tokens)) return undefined
  const m = new RegExp(`"answer"\\s*:\\s*"(${options.map(escape).join('|')})"`).exec(content)
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

export function parseOpenai(json: unknown, q: Question): Decision {
  const choice = (json as { choices?: { message?: { content?: unknown }; logprobs?: { content?: unknown } | null }[] } | null)?.choices?.[0]
  const content = choice?.message?.content
  if (typeof content !== 'string') return { note: 'openai unavailable: bad response' }
  let parsed: unknown
  try { parsed = JSON.parse(content) } catch { return { note: 'openai unavailable: bad response' } }
  const answer = (parsed as { answer?: unknown } | null)?.answer
  if (answer === undefined) return { note: 'openai unavailable: bad response' }
  const options = optionsOf(q)
  if (typeof answer !== 'string' || !options.includes(answer)) return { note: 'openai unavailable: unknown choice' }
  // Without usable logprobs the answer stands without the threshold.
  const confidence = answerConfidence(content, choice?.logprobs?.content, options)
  if (confidence === undefined) return { answer }
  if (confidence < DECIDE_MIN_CONFIDENCE) return { note: `openai unavailable: low confidence ${confidence.toFixed(2)}` }
  return { answer, confidence }
}

export const askOpenai: Provider = async (fetchFn, cfg, model, text, q, timeoutMs = DECIDE_TIMEOUT_MS) => {
  if (cfg.key === undefined) return { note: 'openai unavailable: no key' }
  return post(fetchFn, 'openai', `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, cfg.key, openaiBody(text, model, q), timeoutMs, json => parseOpenai(json, q))
}
