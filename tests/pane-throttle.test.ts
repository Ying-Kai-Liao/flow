import { expect } from 'claude-code/testing'
import { test } from './support'
import { paneDraw } from '../hooks/pane-run'
import { BG_MS, TOKENS_MS, createGate, sameBeyondTokens, ttlCache } from '../hooks/pane-throttle'
import type { DrawKeys } from '../hooks/pane-throttle'

const keys = (over: Partial<DrawKeys> = {}): DrawKeys => ({ props: 'p', user: [1, 2], bg: ['a', 'b'], activity: {}, ...over })

// A gate on a hand-moved clock whose draw counts itself and whose `later` records the requested timers.
function rig() {
  let t = 1000
  const g = createGate<number>(() => t)
  let draws = 0
  const timers: Array<{ ms: number; fired: () => void }> = []
  const frame = (k: DrawKeys) => g.frame(k, async () => ++draws, (ms, fired) => timers.push({ ms, fired }))
  return { frame, advance: (ms: number) => { t += ms }, draws: () => draws, timers }
}

test('the first frame draws and an identical one returns the same tree', async () => {
  const r = rig()
  expect(await r.frame(keys())).toBe(1)
  expect(await r.frame(keys())).toBe(1)
  expect(r.draws()).toBe(1)
})

test('background changes inside one window draw once and ask for one trailing redraw', async () => {
  const r = rig()
  await r.frame(keys())
  r.advance(50)
  for (let i = 0; i < 20; i++) expect(await r.frame(keys({ bg: ['a', i] }))).toBe(1)
  expect(r.draws()).toBe(1)
  expect(r.timers.length).toBe(1)
  expect(r.timers[0]!.ms).toBe(BG_MS - 50)
  // The timer fires, the engine draws again, and the newest state is drawn.
  r.advance(BG_MS - 50)
  r.timers[0]!.fired()
  expect(await r.frame(keys({ bg: ['a', 19] }))).toBe(2)
})

test('a background change after the window draws at once', async () => {
  const r = rig()
  await r.frame(keys())
  r.advance(BG_MS)
  expect(await r.frame(keys({ bg: ['a', 'c'] }))).toBe(2)
  expect(r.timers.length).toBe(0)
})

test('a person is never throttled: new props or user state draw inside the window', async () => {
  const r = rig()
  await r.frame(keys())
  expect(await r.frame(keys({ props: 'scrolled' }))).toBe(2)
  expect(await r.frame(keys({ props: 'scrolled', user: [1, 3] }))).toBe(3)
  expect(r.timers.length).toBe(0)
})

test('token-only activity changes wait the slower window, other activity changes the fast one', async () => {
  const r = rig()
  const act = (tokens: number, doing = 'x') => ({ w1: { doing, log: [], usage: { tokens, model: 'm' } } })
  await r.frame(keys({ activity: act(10) }))
  r.advance(BG_MS)
  expect(await r.frame(keys({ activity: act(20) }))).toBe(1)
  expect(r.timers[0]!.ms).toBe(TOKENS_MS - BG_MS)
  expect(await r.frame(keys({ activity: act(20, 'y') }))).toBe(2)
})

test('a changed reference with equal content draws nothing', async () => {
  const r = rig()
  await r.frame(keys({ activity: { w1: { doing: 'x' } } }))
  r.advance(5000)
  expect(await r.frame(keys({ activity: { w1: { doing: 'x' } } }))).toBe(1)
  expect(r.draws()).toBe(1)
})

test('sameBeyondTokens ignores only usage.tokens', () => {
  expect(sameBeyondTokens({ a: { usage: { tokens: 1, model: 'm' } } }, { a: { usage: { tokens: 2, model: 'm' } } })).toBe(true)
  expect(sameBeyondTokens({ a: { usage: { tokens: 1, model: 'm' } } }, { a: { usage: { tokens: 1, model: 'n' } } })).toBe(false)
  expect(sameBeyondTokens({ a: {} }, { b: {} })).toBe(false)
})

test('ttlCache fetches once per ttl and again after it', async () => {
  let t = 0
  let n = 0
  const c = ttlCache<number>(1000, () => t)
  expect(await c(async () => ++n)).toBe(1)
  t = 999
  expect(await c(async () => ++n)).toBe(1)
  t = 1000
  expect(await c(async () => ++n)).toBe(2)
})

test('paneDraw reads each atom once per call and hands the gate the keys', async () => {
  const counts: Record<string, number> = {}
  const names = ['roster', 'activity', 'selected', 'now', 'handovers', 'ledger', 'inboxCursor', 'viewMode', 'plan', 'checks', 'sessions']
  const read = Object.fromEntries(names.map(n => [n, async () => { counts[n] = (counts[n] ?? 0) + 1; return n }]))
  const io = { read, now: async () => 1, usage: async () => undefined, after: () => {}, invalidate: () => {} } as never
  let seen: DrawKeys | undefined
  const gate = { last: () => undefined, frame: async (k: DrawKeys) => { seen = k; return 'tree' } }
  expect(await paneDraw(io, { props: {} } as never, gate as never)).toBe('tree')
  expect(Object.values(counts).every(c => c === 1)).toBe(true)
  expect(Object.keys(counts).length).toBe(names.length)
  expect(seen!.user.length).toBeGreaterThan(0)
})
