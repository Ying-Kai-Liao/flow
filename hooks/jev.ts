// The Jev provider of the decision API (decide.ts, decision_api "jev"): POST {base}/v1/systemone with a state and
// one question. Fetch is injected, so tests need no network. The key and response bodies never reach a note.
import { criteriaOf, decisionText, DECIDE_MIN_CONFIDENCE, DECIDE_TIMEOUT_MS, optionsOf, post } from './decide'
import type { Decision, Provider, Question } from './decide'

export const JEV_DEFAULT_URL = 'https://api.typesafe.ai'
export const OPENROUTER_DEFAULT_URL = 'https://openrouter.ai/api'
export const OPENROUTER_JEV_MODEL = '~typesafe/jev-latest'
export const JEV_DEFAULT_MODEL = 'jev-latest'

type JevSettings = { jevApiKey?: string; jevBaseUrl?: string; jevModel?: string; openrouterApiKey?: string; openrouterBaseUrl?: string; openrouterJevModel?: string }

// The route to Jev: the direct key (jev_api_key, jev_base_url, jev_model) wins; else the OpenRouter key
// (openrouter_api_key, openrouter_base_url, openrouter_jev_model), same request and response. `via` names the route in notes.
export function jevConfig(s: JevSettings): { key?: string; baseUrl: string; model: string; via?: 'openrouter' } {
  const trim = (u: string) => u.replace(/\/+$/, '')
  if (!s.jevApiKey && s.openrouterApiKey) {
    return { key: s.openrouterApiKey, baseUrl: trim(s.openrouterBaseUrl || OPENROUTER_DEFAULT_URL), model: s.openrouterJevModel || OPENROUTER_JEV_MODEL, via: 'openrouter' }
  }
  return { ...(s.jevApiKey ? { key: s.jevApiKey } : {}), baseUrl: trim(s.jevBaseUrl || JEV_DEFAULT_URL), model: s.jevModel ?? JEV_DEFAULT_MODEL }
}

// How the decision text names the route.
export const jevName = (via?: string): string => (via === 'openrouter' ? 'jev via openrouter' : 'jev')

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
  const name = jevName((cfg as { via?: string }).via)
  if (cfg.key === undefined) return { note: `${name} unavailable: no key` }
  return post(io, name, `${cfg.baseUrl}/v1/systemone`, cfg.key, jevBody(text, model, q), timeoutMs, json => parseJev(json, q, minConfidence))
}
