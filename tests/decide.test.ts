import { expect } from 'claude-code/testing'
import { test } from './support'

import { decide, sourceOf } from '../hooks/decide'
import type { DecideIo, Decision, FetchLike, Question } from '../hooks/decide'
import { jevBody } from '../hooks/jev'
import { answerConfidence, askOpenai, openaiBody, openaiConfig, parseOpenai } from '../hooks/openai'
import { settingsOf } from '../hooks/settings'
import { SIZE_QUESTION } from '../hooks/spawn'

const YESNO: Question = { id: 'docs', type: 'yesno', instructions: 'Is this only documentation?' }
const cfg = { key: 'sk-test', baseUrl: 'https://oai.example/v1' }

// A chat completion whose content is {"answer": "<a>"}, with token-level logprobs when given.
const completion = (answer: unknown, logprob?: number, content = JSON.stringify({ answer })) => ({
  choices: [{
    message: { content },
    logprobs: logprob === undefined ? null : { content: [{ token: '{"answer":"', logprob: 0 }, { token: String(answer), logprob }, { token: '"}', logprob: 0 }] },
  }],
})
const ok = (json: unknown): FetchLike => async () => ({ ok: true, status: 200, json: async () => json })
// Probabilities come back through exp(log(p)): compare them rounded.
const rounded = (d: Decision): Decision => ('confidence' in d && d.confidence !== undefined ? { ...d, confidence: Math.round(d.confidence * 1e4) / 1e4 } : d)
const failing = (e: () => unknown): FetchLike => async () => { throw e() }

test('answerConfidence multiplies the probabilities of the answer tokens only', () => {
  const content = '{"answer":"small"}'
  const toks = [{ token: '{"answer":"', logprob: -0.5 }, { token: 'sm', logprob: Math.log(0.5) }, { token: 'all', logprob: Math.log(0.5) }, { token: '"}', logprob: -0.5 }]
  expect(Math.round(answerConfidence(content, toks, ['small', 'normal'])! * 1e4) / 1e4).toBe(0.25)
  expect(answerConfidence(content, null, ['small'])).toBeUndefined()
  // Tokens that do not add up to the message text can't be trusted.
  expect(answerConfidence(content, toks.slice(0, 2), ['small'])).toBeUndefined()
  expect(answerConfidence(content, [{ token: 5, logprob: 0 }], ['small'])).toBeUndefined()
  expect(answerConfidence('{"answer":"huge"}', toks, ['small'])).toBeUndefined()
})

test('parseOpenai: logprobs give a confidence, none leaves the answer unthresholded', () => {
  expect(rounded(parseOpenai(completion('small', Math.log(0.97)), SIZE_QUESTION))).toEqual({ answer: 'small', confidence: 0.97 })
  expect(parseOpenai(completion('small'), SIZE_QUESTION)).toEqual({ answer: 'small' })
  expect(parseOpenai(completion('small', Math.log(0.3)), SIZE_QUESTION)).toEqual({ note: 'openai unavailable: low confidence 0.30' })
  expect(parseOpenai(completion('huge'), SIZE_QUESTION)).toEqual({ note: 'openai unavailable: unknown choice' })
  expect(parseOpenai(completion('x', undefined, 'not json'), SIZE_QUESTION)).toEqual({ note: 'openai unavailable: bad response' })
  expect(parseOpenai(completion('x', undefined, '{}'), SIZE_QUESTION)).toEqual({ note: 'openai unavailable: bad response' })
  expect(parseOpenai({}, SIZE_QUESTION)).toEqual({ note: 'openai unavailable: bad response' })
  expect(parseOpenai(completion('yes'), YESNO)).toEqual({ answer: 'yes' })
})

test('openaiConfig reads the env only and trims the base url', () => {
  expect(openaiConfig({})).toEqual({ baseUrl: 'https://api.openai.com/v1' })
  expect(openaiConfig({ OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: 'https://gw.example/v1//' })).toEqual({ key: 'sk-test', baseUrl: 'https://gw.example/v1' })
})

test('openai request: URL, bearer key, strict schema enum, Size line stripped, text capped', async () => {
  let seen: { url: string; auth: string; body: Record<string, unknown> } | undefined
  const spy: FetchLike = async (url, init) => { seen = { url, auth: init.headers.Authorization!, body: JSON.parse(init.body) as Record<string, unknown> }; return { ok: true, status: 200, json: async () => completion('normal', Math.log(0.9)) } }
  const r = await askOpenai(spy, { key: 'sk-test', baseUrl: 'https://oai.example/v1///' }, 'gpt-4.1-mini', `Size: small\n${'a'.repeat(9000)}`, SIZE_QUESTION)
  expect(rounded(r)).toEqual({ answer: 'normal', confidence: 0.9 })
  expect(seen?.url).toBe('https://oai.example/v1/chat/completions')
  expect(seen?.auth).toBe('Bearer sk-test')
  const b = seen!.body as { model: string; temperature: number; logprobs: boolean; max_completion_tokens: number; messages: { role: string; content: string }[]; response_format: { type: string; json_schema: { strict: boolean; schema: { properties: { answer: { enum: string[] } } } } } }
  expect(b.model).toBe('gpt-4.1-mini')
  expect(b.temperature).toBe(0)
  expect(b.logprobs).toBe(true)
  expect(b.max_completion_tokens).toBeLessThanOrEqual(50)
  expect(b.response_format.type).toBe('json_schema')
  expect(b.response_format.json_schema.strict).toBe(true)
  expect(b.response_format.json_schema.schema.properties.answer.enum).toEqual(['small', 'normal', 'large'])
  expect(b.messages[1]!.content).toBe('a'.repeat(8000))
  expect((openaiBody('x', 'm', YESNO) as { response_format: { json_schema: { schema: { properties: { answer: { enum: string[] } } } } } }).response_format.json_schema.schema.properties.answer.enum).toEqual(['yes', 'no'])
})

test('openai failures are named without leaking the key or the body', async () => {
  const ask = (f: FetchLike, c: { key?: string; baseUrl: string } = cfg, t?: number) => askOpenai(f, c, 'm', 'p', SIZE_QUESTION, t)
  expect(await ask(ok({}), { baseUrl: 'x' })).toEqual({ note: 'openai unavailable: no key' })
  expect(await ask(async () => ({ ok: false, status: 401, json: async () => ({ detail: 'sk-test' }) }))).toEqual({ note: 'openai unavailable: HTTP 401' })
  expect(await ask(async () => ({ ok: true, status: 200, json: async () => { throw new Error('sk-test') } }))).toEqual({ note: 'openai unavailable: bad response' })
  expect(await ask(failing(() => new Error('sk-test refused')))).toEqual({ note: 'openai unavailable: network error' })
  const hang: FetchLike = (_u, init) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))))
  expect(await ask(hang, cfg, 20)).toEqual({ note: 'openai unavailable: timeout' })
})

const io = (f: FetchLike, env: Record<string, string> = {}, file?: string): DecideIo => ({ env, fetch: f, readFile: async () => file })

test('decide through jev: choice and yes/no', async () => {
  const jev = ok({ answers: { size: { choice: 'large', confidence: 0.9 } } })
  expect(await decide(io(jev, { JEV_API_KEY: 'k' }), { decisionApi: 'jev' }, 'text', SIZE_QUESTION)).toEqual({ answer: 'large', confidence: 0.9 })
  const yn = ok({ answers: { docs: { choice: 'yes', confidence: 0.8 } } })
  expect(await decide(io(yn, {}, 'JEV_API_KEY=k'), { decisionApi: 'jev' }, 'text', YESNO)).toEqual({ answer: 'yes', confidence: 0.8 })
  expect(await decide(io(yn), { decisionApi: 'jev' }, 'text', YESNO)).toEqual({ note: 'jev unavailable: no key' })
})

test('decide through openai: choice and yes/no', async () => {
  const env = { OPENAI_API_KEY: 'sk-test' }
  expect(rounded(await decide(io(ok(completion('small', Math.log(0.99))), env), { decisionApi: 'openai' }, 't', SIZE_QUESTION))).toEqual({ answer: 'small', confidence: 0.99 })
  expect(await decide(io(ok(completion('no')), env), { decisionApi: 'openai', openaiModel: 'gpt-x' }, 't', YESNO)).toEqual({ answer: 'no' })
  expect(await decide(io(ok(completion('no'))), { decisionApi: 'openai' }, 't', YESNO)).toEqual({ note: 'openai unavailable: no key' })
})

test('decide off makes no network call', async () => {
  let calls = 0
  const f: FetchLike = async () => { calls++; return { ok: true, status: 200, json: async () => ({}) } }
  expect('note' in await decide(io(f, { OPENAI_API_KEY: 'sk-test', JEV_API_KEY: 'k' }), { decisionApi: 'off' }, 't', SIZE_QUESTION)).toBe(true)
  expect('note' in await decide(io(f, { OPENAI_API_KEY: 'sk-test' }), {}, 't', SIZE_QUESTION)).toBe(true)
  expect(calls).toBe(0)
})

test('the jev request for sizing keeps its shape', () => {
  expect(JSON.stringify(jevBody('Size: x\nhi', 'jev-latest', SIZE_QUESTION))).toBe(JSON.stringify({
    model: 'jev-latest',
    state: 'hi',
    questions: { size: { type: 'choice', instructions: 'How big is this coding task for an agent?', criteria: {
      small: 'docs, a one-file fix, a rename or a mechanical change',
      normal: 'an ordinary change in a few files with clear scope',
      large: 'cross-cutting work, big files, unclear scope, or needs long context',
    } } },
  }))
})

test('sourceOf names the provider for the decision text', () => {
  expect(sourceOf({ decisionApi: 'jev' })).toBe('jev')
  expect(sourceOf({ decisionApi: 'openai' })).toBe('openai gpt-4.1-mini')
  expect(sourceOf({ decisionApi: 'openai', openaiModel: 'gpt-x' })).toBe('openai gpt-x')
})

test('settings: decision_api, the size_model alias and unknown values', () => {
  const api = (o: Record<string, unknown>) => settingsOf(o, 'main').decisionApi
  expect(api({})).toBe('off')
  expect(api({ decision_api: 'jev' })).toBe('jev')
  expect(api({ decision_api: 'openai' })).toBe('openai')
  expect(api({ size_model: 'jev' })).toBe('jev')
  expect(api({ size_model: 'openai' })).toBe('openai')
  expect(api({ size_model: 'off' })).toBe('off')
  expect(api({ decision_api: 'off', size_model: 'jev' })).toBe('jev')
  expect(api({ decision_api: 'openai', size_model: 'jev' })).toBe('openai')
  expect(api({ decision_api: 'bogus', size_model: 'jev' })).toBe('off')
  expect(api({ size_model: 'bogus' })).toBe('off')
  expect(settingsOf({}, 'main').openaiModel).toBe('gpt-4.1-mini')
  expect(settingsOf({ openai_model: 'gpt-x' }, 'main').openaiModel).toBe('gpt-x')
  expect(settingsOf({}, 'main').jevModel).toBe('jev-latest')
})
