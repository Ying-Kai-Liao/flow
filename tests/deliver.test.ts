import { expect, test } from 'claude-code/testing'

import { deliver, flushAgent, resetDelivery, HOLD_CAP_MS, WINDOW_MS, type DeliverIo } from '../hooks/deliver'

// A fake world: agent statuses, the sends, the main-session fallbacks and a clock moved by hand.
function world() {
  const status = new Map<string, string>([['m1', 'idle']])
  const sent: { to: string; text: string }[] = []
  const main: string[] = []
  let now = 0
  const timers: { at: number; fn: () => void }[] = []
  const io: DeliverIo = {
    status: async id => status.get(id),
    send: async (id, text) => void sent.push({ to: id, text }),
    after: (ms, fn) => void timers.push({ at: now + ms, fn }),
  }
  const advance = async (ms: number) => {
    now += ms
    for (const t of timers.splice(0).sort((a, b) => a.at - b.at)) {
      if (t.at <= now) t.fn()
      else timers.push(t)
    }
    await new Promise(r => setTimeout(r, 0))
  }
  resetDelivery(t => void main.push(t))
  return { io, status, sent, main, advance }
}

test('a running agent gets the message at once', async () => {
  const w = world()
  w.status.set('m1', 'running')
  await deliver(w.io, 'm1', 'hello')
  expect(w.sent).toEqual([{ to: 'm1', text: 'hello' }])
})

test('an idle agent gets messages inside the window as one send, identical texts once', async () => {
  const w = world()
  await deliver(w.io, 'm1', 'a')
  await w.advance(WINDOW_MS - 1000)
  await deliver(w.io, 'm1', 'b')
  await deliver(w.io, 'm1', 'a')
  expect(w.sent).toEqual([])
  await w.advance(1000)
  expect(w.sent).toEqual([{ to: 'm1', text: 'a\n\nb' }])
  await w.advance(WINDOW_MS)
  expect(w.sent.length).toBe(1)
})

test('urgent flushes at once with what was queued', async () => {
  const w = world()
  await deliver(w.io, 'm1', 'plan notice')
  await deliver(w.io, 'm1', 'answer', { urgent: true })
  expect(w.sent).toEqual([{ to: 'm1', text: 'plan notice\n\nanswer' }])
  await w.advance(WINDOW_MS * 2)
  expect(w.sent.length).toBe(1)
})

test('a held text waits for the agent next turn', async () => {
  const w = world()
  await deliver(w.io, 'm1', 'ask', { held: true })
  await w.advance(WINDOW_MS * 2)
  expect(w.sent).toEqual([])
  w.status.set('m1', 'running')
  await flushAgent(w.io, 'm1')
  expect(w.sent).toEqual([{ to: 'm1', text: 'ask' }])
})

test('a held text goes out at the cap', async () => {
  const w = world()
  await deliver(w.io, 'm1', 'ask', { held: true })
  await w.advance(HOLD_CAP_MS - 1)
  expect(w.sent).toEqual([])
  await w.advance(1)
  expect(w.sent).toEqual([{ to: 'm1', text: 'ask' }])
})

test('a plain message shortens the wait of a held queue and carries the held text', async () => {
  const w = world()
  await deliver(w.io, 'm1', 'ask', { held: true })
  await deliver(w.io, 'm1', 'report')
  await w.advance(WINDOW_MS)
  expect(w.sent).toEqual([{ to: 'm1', text: 'ask\n\nreport' }])
})

test('an ended or unknown agent sends to the fallback, else to main', async () => {
  const w = world()
  w.status.set('m1', 'completed')
  const fell: string[] = []
  expect(await deliver(w.io, 'm1', 'x', { onGone: t => void fell.push(t) })).toBe(false)
  expect(fell).toEqual(['x'])
  await deliver(w.io, 'nobody', 'y')
  expect(w.sent).toEqual([])
  expect(w.main).toEqual(['y (nobody ended before this was delivered.)'])
})

test('queued text falls back when the agent ends before the window closes', async () => {
  const w = world()
  await deliver(w.io, 'm1', 'late')
  w.status.set('m1', 'killed')
  await w.advance(WINDOW_MS)
  expect(w.sent).toEqual([])
  expect(w.main.length).toBe(1)
})
