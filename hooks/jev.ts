// The Jev provider of the decision API (decide.ts, decision_api "jev"): POST {base}/v1/systemone with a state and
// one question. Fetch is injected, so tests need no network. The key and response bodies never reach a note.
import { criteriaOf, decisionText, DECIDE_MIN_CONFIDENCE, DECIDE_TIMEOUT_MS, optionsOf, post } from './decide'
import type { Decision, Provider, Question } from './decide'

export const JEV_DEFAULT_URL = 'https://api.typesafe.ai'

// From the /config options jev_api_key and jev_base_url (settings.ts).
export function jevConfig(s: { jevApiKey?: string; jevBaseUrl?: string }): { key?: string; baseUrl: string } {
  const key = s.jevApiKey
  const baseUrl = (s.jevBaseUrl || JEV_DEFAULT_URL).replace(/\/+$/, '')
  return { ...(key ? { key } : {}), baseUrl }
}

export function jevBody(text: string, model: string, q: Question): unknown {
  return {
    model,
    state: decisionText(text),
    questions: {
      [q.id]: {
        type: 'choice',
        instructions: q.instructions,
        criteria: criteriaOf(q),
      },
    },
  }
}

export function parseJev(json: unknown, q: Question, minConfidence = DECIDE_MIN_CONFIDENCE): Decision {
  const a = (json as { answers?: Record<string, { choice?: unknown; confidence?: unknown } | undefined> } | null)?.answers?.[q.id]
  if (a === undefined || a === null || typeof a !== 'object') return { note: 'jev unavailable: bad response' }
  if (typeof a.choice !== 'string' || !optionsOf(q).includes(a.choice)) return { note: 'jev unavailable: unknown choice' }
  if (typeof a.confidence !== 'number' || Number.isNaN(a.confidence)) return { note: 'jev unavailable: bad response' }
  if (a.confidence < minConfidence) return { note: `jev unavailable: low confidence ${a.confidence.toFixed(2)}` }
  return { answer: a.choice, confidence: a.confidence }
}

export const askJev: Provider = async (io, cfg, model, text, q, timeoutMs = DECIDE_TIMEOUT_MS, minConfidence = DECIDE_MIN_CONFIDENCE) => {
  if (cfg.key === undefined) return { note: 'jev unavailable: no key' }
  return post(io, 'jev', `${cfg.baseUrl}/v1/systemone`, cfg.key, jevBody(text, model, q), timeoutMs, json => parseJev(json, q, minConfidence))
}
