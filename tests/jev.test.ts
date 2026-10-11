import { expect } from 'claude-code/testing'
import { test } from './support'

import { decide, decisionText } from '../hooks/decide'
import type { DecideIo, FetchLike, Question } from '../hooks/decide'
import { askJev as askJevQ, jevBody as jevBodyQ, jevConfig, parseJev as parseJevQ } from '../hooks/jev'
import { routeManager, routeWorker, SIZE_QUESTION, sizeWith } from '../hooks/spawn'
import type { SpawnIo } from '../hooks/spawn'
import type { Ledger } from '../types'

const MODELS = { small: 'haiku', normal: 'sonnet', large: 'sonnet[1m]' }
const answer = (choice: unknown, confidence: unknown) => ({ answers: { size: { type: 'choice', choice, confidence } } })
const ok = (json: unknown): FetchLike => async () => ({ ok: true, status: 200, json: async () => json })
const jevState = decisionText
const jevBody = (p: string, m: string) => jevBodyQ(p, m, SIZE_QUESTION)
const parseJev = (j: unknown) => parseJevQ(j, SIZE_QUESTION)
// The sizing call as spawn makes it: the fixed question through the Jev provider.
// The timer `post` races the fetch against: `fire` runs out at once (a timeout test), else it never does.
const net = (f: FetchLike, fire = false): DecideIo => ({
  fetch: f,
  after: (_ms, fn) => { if (fire) void Promise.resolve().then(fn); return { cancel: () => undefined } },
})
const askJev = (f: FetchLike, c: { key?: string; baseUrl: string }, m: string, p: string, t?: number) => sizeWith((text, q: Question) => askJevQ(net(f, t !== undefined), c, m, text, q, t), 'jev')(p)
const cfg = { key: 'fake-key', baseUrl: 'https://jev.example' }

function ioWith(ledger: Ledger = {}): SpawnIo {
  return { loadLedger: async () => undefined, ledger: async () => ledger } as unknown as SpawnIo
}
const spawn = (prompt: string, name = 'csv-docs') => ({ name, description: name, prompt, subagentType: 'flow:worker' }) as never

test('jevConfig reads the /config options only and defaults the base url', () => {
  expect(jevConfig({ jevApiKey: 'e', jevBaseUrl: 'https://f.example/' })).toEqual({ key: 'e', baseUrl: 'https://f.example', model: 'jev-latest' })
  expect(jevConfig({ jevApiKey: 'f', jevModel: 'm' })).toEqual({ key: 'f', baseUrl: 'https://api.typesafe.ai', model: 'm' })
  expect(jevConfig({})).toEqual({ baseUrl: 'https://api.typesafe.ai', model: 'jev-latest' })
})

test('jevConfig routes through OpenRouter only without a direct key', () => {
  expect(jevConfig({ openrouterApiKey: 'or' })).toEqual({ key: 'or', baseUrl: 'https://openrouter.ai/api', model: '~typesafe/jev-latest', via: 'openrouter' })
  expect(jevConfig({ jevApiKey: 'j', openrouterApiKey: 'or' })).toEqual({ key: 'j', baseUrl: 'https://api.typesafe.ai', model: 'jev-latest' })
  expect(jevConfig({ openrouterApiKey: 'or', openrouterBaseUrl: 'https://gw.example/api/', openrouterJevModel: 'x' })).toEqual({ key: 'or', baseUrl: 'https://gw.example/api', model: 'x', via: 'openrouter' })
})

test('the state drops the Size line and is capped at 8000 chars', () => {
  expect(jevState('Your name: x\nSize: small — docs\nbody')).toBe('Your name: x\nbody')
  expect(jevState('a'.repeat(9000)).length).toBe(8000)
  expect((jevBody('Size: large\nhi', 'jev-latest') as { model: string; state: string }).state).toBe('hi')
})

test('parseJev accepts a confident known choice and rejects the rest', () => {
  expect(parseJev(answer('small', 0.98))).toEqual({ answer: 'small', confidence: 0.98 })
  expect(parseJev(answer('small', 0.5))).toEqual({ answer: 'small', confidence: 0.5 })
  expect(parseJev(answer('small', 0.49))).toEqual({ note: 'jev unavailable: low confidence 0.49' })
  expect(parseJev(answer('huge', 1))).toEqual({ note: 'jev unavailable: unknown choice' })
  expect(parseJev(answer('small', 'high'))).toEqual({ note: 'jev unavailable: bad response' })
  expect(parseJev({})).toEqual({ note: 'jev unavailable: bad response' })
  expect(parseJev(null)).toEqual({ note: 'jev unavailable: bad response' })
})

test('askJev sends the key and body, and names each failure kind without leaking the key', async () => {
  let seen: { url: string; auth: string; body: string } | undefined
  const spy: FetchLike = async (url, init) => { seen = { url, auth: init.headers.Authorization!, body: init.body }; return { ok: true, status: 200, json: async () => answer('normal', 0.9) } }
  expect(await askJev(spy, cfg, 'jev-latest', 'Size: small\nhello')).toEqual({ size: 'normal', confidence: 0.9, source: 'jev' })
  expect(seen?.url).toBe('https://jev.example/v1/systemone')
  expect(seen?.auth).toBe('Bearer fake-key')
  expect(JSON.parse(seen!.body).state).toBe('hello')

  expect(await askJev(ok({}), { baseUrl: 'x' }, 'm', 'p')).toEqual({ note: 'jev unavailable: no key' })
  const http: FetchLike = async () => ({ ok: false, status: 401, json: async () => ({ detail: 'fake-key' }) })
  expect(await askJev(http, cfg, 'm', 'p')).toEqual({ note: 'jev unavailable: HTTP 401' })
  const badJson: FetchLike = async () => ({ ok: true, status: 200, json: async () => { throw new Error('nope') } })
  expect(await askJev(badJson, cfg, 'm', 'p')).toEqual({ note: 'jev unavailable: bad response' })
  const down: FetchLike = async () => { throw new Error('fake-key refused') }
  expect(await askJev(down, cfg, 'm', 'p')).toEqual({ note: 'jev unavailable: network error' })
  const hang: FetchLike = (_u, init) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))))
  expect(await askJev(hang, cfg, 'm', 'p', 20)).toEqual({ note: 'jev unavailable: timeout' })
})

test('off: no Jev function means routing is the Size line alone', async () => {
  const r = await routeWorker(ioWith(), spawn('Size: normal — a few files'), MODELS)
  expect(r.routed).toMatchObject({ size: 'normal', model: 'sonnet' })
  expect(r.routed?.jev).toBeUndefined()
})

test('on: Jev wins over the Size line and the decision says so', async () => {
  const jev = (p: string) => askJev(ok(answer('small', 0.98)), cfg, 'jev-latest', p)
  const r = await routeWorker(ioWith(), spawn('Size: normal — docs only'), MODELS, jev)
  expect(r.routed).toMatchObject({ size: 'small', model: 'haiku', reason: 'docs only', jev: 'jev 0.98; brief said normal' })
  expect(r.e.model).toBe('haiku')
})

test('on: Jev decides with no Size line, and a manager routes the same way', async () => {
  const jev = (p: string) => askJev(ok(answer('large', 0.8)), cfg, 'jev-latest', p)
  const w = await routeWorker(ioWith(), spawn('no size line'), MODELS, jev)
  expect(w.routed).toMatchObject({ size: 'large', model: 'sonnet[1m]', jev: 'jev 0.80' })
  const small = (p: string) => askJev(ok(answer('small', 1)), cfg, 'jev-latest', p)
  const m = await routeManager(ioWith(), spawn('plain', 'mgr'), 'sonnet', 'opus', small)
  expect(m.routed).toMatchObject({ size: 'small', model: 'sonnet', jev: 'jev 1.00' })
})

test('on but Jev fails: the Size line stands and the note rides along', async () => {
  const jev = (p: string) => askJev(ok({ answers: {} }), cfg, 'jev-latest', p)
  const r = await routeWorker(ioWith(), spawn('Size: small — docs'), MODELS, jev)
  expect(r.routed).toMatchObject({ size: 'small', model: 'haiku', jev: 'jev unavailable: bad response' })
  const none = await routeWorker(ioWith(), spawn('no size'), MODELS, async () => ({ note: 'jev unavailable: timeout' }))
  expect(none.routed).toBeUndefined()
})

test('the successor floor still raises Jev\'s size', async () => {
  const ledger = { a: { role: 'worker', name: 'csv-docs', size: 'normal' } } as unknown as Ledger
  const jev = (p: string) => askJev(ok(answer('small', 0.99)), cfg, 'jev-latest', p)
  const r = await routeWorker(ioWith(ledger), spawn('x', 'csv-docs-2'), MODELS, jev)
  expect(r.routed).toMatchObject({ size: 'large', escalated: true })
})

// Spawn sizing as register.tsx wires it: decide() with the setting as the floor (default 0).
const sized = (floor: number) => sizeWith((text, q: Question) => decide(net(ok(answer('large', 0.3))), { decisionApi: 'jev', jevApiKey: 'k' }, text, q, 5000, floor), 'jev')('hello')

test('sizing uses a low-confidence answer with the default floor 0 and falls back to the Size line above it', async () => {
  expect(await sized(0)).toEqual({ size: 'large', confidence: 0.3, source: 'jev' })
  expect(await sized(0.5)).toEqual({ note: 'jev unavailable: low confidence 0.30' })
})
