// The Jev provider of the decision API (decide.ts, decision_api "jev"): POST {base}/v1/systemone with a state and
// one question. Fetch is injected, so tests need no network. The key and response bodies never reach a note.
import { criteriaOf, decisionText, DECIDE_MIN_CONFIDENCE, DECIDE_TIMEOUT_MS, optionsOf, post } from './decide'
import type { Decision, Provider, Question } from './decide'

export const JEV_DEFAULT_URL = 'https://api.typesafe.ai'

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

export function parseJev(json: unknown, q: Question): Decision {
  const a = (json as { answers?: Record<string, { choice?: unknown; confidence?: unknown } | undefined> } | null)?.answers?.[q.id]
  if (a === undefined || a === null || typeof a !== 'object') return { note: 'jev unavailable: bad response' }
  if (typeof a.choice !== 'string' || !optionsOf(q).includes(a.choice)) return { note: 'jev unavailable: unknown choice' }
  if (typeof a.confidence !== 'number' || Number.isNaN(a.confidence)) return { note: 'jev unavailable: bad response' }
  if (a.confidence < DECIDE_MIN_CONFIDENCE) return { note: `jev unavailable: low confidence ${a.confidence.toFixed(2)}` }
  return { answer: a.choice, confidence: a.confidence }
}

export const askJev: Provider = async (fetchFn, cfg, model, text, q, timeoutMs = DECIDE_TIMEOUT_MS) => {
  if (cfg.key === undefined) return { note: 'jev unavailable: no key' }
  return post(fetchFn, 'jev', `${cfg.baseUrl}/v1/systemone`, cfg.key, jevBody(text, model, q), timeoutMs, json => parseJev(json, q))
}
