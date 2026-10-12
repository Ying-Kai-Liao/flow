import { expect, test } from 'claude-code/testing'

import { NO_ANSWER, NO_PICKUP, pumpRelay, relayCall, resetRelay, RELAY_STALE_MS, stripEngineFields } from '../hooks/relay'
import type { PumpIo, RelayCall } from '../hooks/relay'

const DIR = '/r/.git/flow/sessions/m1/relay'

// An in-memory directory with atomic renames and a clock moved by hand.
function world(o: { live?: boolean; exit?: number; stdout?: string } = {}) {
  const files = new Map<string, string>()
  const mtimes = new Map<string, number>()
  const state = { now: 1_000_000 }
  const ran: string[][] = []
  const io: PumpIo = {
    list: async dir => [...files.keys()].filter(k => k.startsWith(`${dir}/`)).map(k => k.slice(dir.length + 1)),
    read: async p => {
      const t = files.get(p)
      if (t === undefined) throw new Error('ENOENT')
      return t
    },
    write: async (p, text) => { files.set(p, text); mtimes.set(p, state.now) },
    rename: async (a, b) => {
      const t = files.get(a)
      if (t === undefined) return false
      files.delete(a)
      files.set(b, t)
      return true
    },
    remove: async p => { files.delete(p) },
    mtime: async p => mtimes.get(p),
    now: async () => state.now,
    run: async argv => { ran.push(argv); return { exitCode: o.exit ?? 0, stdout: o.stdout ?? '', stderr: '' } },
    dirs: async () => [{ name: 'm1', dir: DIR, live: o.live ?? true }],
  }
  resetRelay()
  return { io, files, mtimes, state, ran }
}

const call = (id: string): RelayCall => ({ id, tool: 'mcp__flow__status', input: { pr: 3 }, from: 'session:m1', role: 'manager', by: 'm1', at: 1 })
const req = { tool: 't', input: {}, from: 'f', role: 'manager', by: 'm1' }

test('two ticks racing on one call run it once: the rename is the claim', async () => {
  const w = world()
  w.files.set(`${DIR}/call-a.json`, JSON.stringify(call('a')))
  let runs = 0
  const exec = async () => { runs++; await Promise.resolve(); return { result: 'ok' } }
  const started = (await Promise.all([pumpRelay(w.io, exec), pumpRelay(w.io, exec)])).flat()
  await Promise.all(started)
  expect(runs).toBe(1)
  expect(JSON.parse(w.files.get(`${DIR}/answer-a.json`)!)).toEqual({ result: 'ok' })
  expect(w.files.has(`${DIR}/taken-a.json`)).toBe(false)
  expect(w.files.has(`${DIR}/call-a.json`)).toBe(false)
})

test('a call is handed to exec with its payload and the session name; calls run concurrently', async () => {
  const w = world()
  w.files.set(`${DIR}/call-a.json`, JSON.stringify(call('a')))
  w.files.set(`${DIR}/call-b.json`, JSON.stringify({ ...call('b'), tool: 'mcp__flow__note' }))
  const seen: string[] = []
  const gates: (() => void)[] = []
  const started = await pumpRelay(w.io, async (c, name) => {
    seen.push(`${c.tool}:${name}:${JSON.stringify(c.input)}`)
    await new Promise<void>(r => gates.push(r))
    return { result: c.id }
  })
  // Both are in flight before either answers.
  for (let i = 0; i < 5; i++) await Promise.resolve()
  expect(seen.sort()).toEqual(['mcp__flow__note:m1:{"pr":3}', 'mcp__flow__status:m1:{"pr":3}'])
  gates.forEach(g => g())
  await Promise.all(started)
  expect(JSON.parse(w.files.get(`${DIR}/answer-b.json`)!)).toEqual({ result: 'b' })
})

test('a malformed call gets an error answer and never crashes the tick', async () => {
  const w = world()
  w.files.set(`${DIR}/call-x.json`, '{not json')
  w.files.set(`${DIR}/call-y.json`, '{"input":{}}')
  let runs = 0
  await Promise.all(await pumpRelay(w.io, async () => { runs++; return { result: 1 } }))
  expect(runs).toBe(0)
  expect(JSON.parse(w.files.get(`${DIR}/answer-x.json`)!).deny).toContain('not valid JSON')
  expect(JSON.parse(w.files.get(`${DIR}/answer-y.json`)!).deny).toContain('not valid JSON')
})

test('an exec that throws answers with a refusal', async () => {
  const w = world()
  w.files.set(`${DIR}/call-a.json`, JSON.stringify(call('a')))
  await Promise.all(await pumpRelay(w.io, async () => { throw new Error('boom') }))
  expect(JSON.parse(w.files.get(`${DIR}/answer-a.json`)!).deny).toContain('boom')
})

test('a call from an ended or unknown session is refused, not run', async () => {
  const w = world({ live: false })
  w.files.set(`${DIR}/call-a.json`, JSON.stringify(call('a')))
  let runs = 0
  await Promise.all(await pumpRelay(w.io, async () => { runs++; return { result: 1 } }))
  expect(runs).toBe(0)
  expect(JSON.parse(w.files.get(`${DIR}/answer-a.json`)!).deny).toContain('not running')
})

test('stale call, taken and answer files are removed after 15 minutes; fresh ones stay', async () => {
  const w = world()
  for (const n of ['taken-old.json', 'answer-old.json', 'answer-old2.json.tmp']) {
    w.files.set(`${DIR}/${n}`, '{}')
    w.mtimes.set(`${DIR}/${n}`, w.state.now - RELAY_STALE_MS - 1)
  }
  w.files.set(`${DIR}/answer-new.json`, '{}')
  w.mtimes.set(`${DIR}/answer-new.json`, w.state.now - 1000)
  w.files.set(`${DIR}/notes.txt`, 'x')
  await pumpRelay(w.io, async () => ({ result: 1 }))
  expect([...w.files.keys()].sort()).toEqual([`${DIR}/answer-new.json`, `${DIR}/notes.txt`])
})

test('the client writes the call atomically, waits in one process and returns the answer as it is', async () => {
  const w = world({ stdout: '{"result":"fine"}' })
  const r = await relayCall(w.io, DIR, { tool: 'mcp__flow__status', input: { a: 1 }, from: 'session:m1', role: 'manager', by: 'm1' })
  expect(r).toEqual({ result: 'fine' })
  expect(w.ran.length).toBe(1)
  expect(w.ran[0]!.slice(0, 2)).toEqual(['sh', '-c'])
  const id = w.ran[0]!.at(-1)!
  const sent = JSON.parse(w.files.get(`${DIR}/call-${id}.json`)!) as RelayCall
  expect(sent).toMatchObject({ id, tool: 'mcp__flow__status', input: { a: 1 }, from: 'session:m1', role: 'manager', by: 'm1', at: 1_000_000 })
  expect(w.files.has(`${DIR}/call-${id}.json.tmp`)).toBe(false)
  const deny = world({ stdout: '{"deny":"no"}' })
  expect(await relayCall(deny.io, DIR, req)).toEqual({ deny: 'no' })
})

test('ids are unique per call, so a retry never reads an old answer', async () => {
  const w = world({ stdout: '{"result":1}' })
  await relayCall(w.io, DIR, req)
  await relayCall(w.io, DIR, req)
  expect(w.ran[0]!.at(-1)).not.toBe(w.ran[1]!.at(-1))
})

test('exit 3 means main did not pick the call up, exit 4 that it did not answer; the call file is withdrawn', async () => {
  const three = world({ exit: 3 })
  expect(await relayCall(three.io, DIR, req)).toEqual({ result: NO_PICKUP })
  expect(NO_PICKUP).toBe('flow relay: the main Claude Code session did not pick up the call; is it running?')
  expect([...three.files.keys()].filter(k => k.includes('call-'))).toEqual([])
  const four = world({ exit: 4 })
  expect(await relayCall(four.io, DIR, req)).toEqual({ result: NO_ANSWER })
  expect(NO_ANSWER).toBe('flow relay: main took the call but did not answer in 10 minutes')
})

test('engine fields are stripped from a tool event input', () => {
  expect(stripEngineFields({ tool: 'mcp__flow__ask', tool_use_id: 'x', agentId: 'a', consent: 'c', requestMeta: {}, questions: [1], action: 'list' }))
    .toEqual({ questions: [1], action: 'list' })
})
