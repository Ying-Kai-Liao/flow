import { expect } from 'claude-code/testing'
import type { Breaker, Deploys, Handover, Session } from '../types'
import { mirror } from '../hooks/core'
import { EMPTY_BREAKER } from '../hooks/reviewer-breaker'
import { startQueue } from '../hooks/reviewer-run'
import type { BreakerIo, QueueIo } from '../hooks/reviewer-run'
import { test } from './support'

// reviewer_delay against a fake QueueIo: a fresh handover on an idle queue arms one timer, and what never waits.

type Batch = NonNullable<Awaited<ReturnType<QueueIo['batch']>>>

function setup(initial: { delayMin?: number; pending?: Handover[]; deploys?: Deploys; batch?: Batch; breaker?: Breaker; session?: Session } = {}) {
  mirror.deployInfos = [{ name: 'prod', mode: 'auto' }]
  const w = {
    handovers: Object.fromEntries((initial.pending ?? []).map(h => [String(h.pr), h])) as Record<string, Handover>,
    deploys: initial.deploys ?? ({ targets: {} } as Deploys),
    batch: initial.batch as Batch | undefined,
    breaker: initial.breaker ?? EMPTY_BREAKER,
    session: initial.session,
    spawns: [] as string[],
    typed: [] as string[],
    delays: [] as number[],
    waits: [] as number[],
    running: false,
  }
  const breaker: BreakerIo = {
    stateDir: async () => undefined,
    readJson: async () => undefined,
    writeJson: async () => undefined,
    mkdir: async () => undefined,
    get: async () => w.breaker,
    set: async b => { w.breaker = b },
    now: async () => 1_000_000,
    withInbox: async fn => fn({ items: [] } as never).out,
    toast: () => undefined,
  }
  const io: QueueIo = {
    agents: async () => [],
    batch: async () => w.batch,
    handovers: async () => w.handovers,
    deploys: async () => w.deploys,
    runs: async () => w.spawns.length,
    setRuns: async () => undefined,
    spawn: async input => { w.spawns.push(input.prompt); return {} },
    reviewerSession: async () => w.session,
    nudge: async (_s, text, told) => { w.typed.push(text); w.session!.nudged = told; return undefined },
    setTold: async (_s, told) => { w.session!.nudged = told },
    breaker,
    wait: ms => { w.waits.push(ms) },
    delay: {
      ms: () => (initial.delayMin ?? 3) * 60_000,
      running: () => w.running,
      start: ms => { if (w.running) return; w.running = true; w.delays.push(ms) },
    },
  }
  // The timer fires: ensureQueue runs as any other caller.
  const fire = () => { w.running = false; return startQueue(io) }
  return { w, io, fire }
}

const ho = (pr: number, status = 'pending', at = 1): Handover => ({ pr, at, status } as unknown as Handover)

test('several handovers during the delay arm one timer and start one reviewer with all of them', async () => {
  const { w, io, fire } = setup({ pending: [ho(7)] })
  expect(await startQueue(io, 'handover')).toBe('The reviewer starts in 3m so close handovers share a batch.')
  w.handovers['8'] = ho(8)
  expect(await startQueue(io, 'handover')).toContain('joins')
  w.handovers['9'] = ho(9)
  await startQueue(io, 'handover')
  expect(w.delays).toEqual([180_000])
  expect(w.spawns).toHaveLength(0)
  expect(await fire()).toContain('Started reviewer reviewer-1')
  expect(w.spawns).toHaveLength(1)
  expect(w.spawns[0]).toContain('#7, #8, #9')
})

test('reviewer_delay 0 starts at once', async () => {
  const { w, io } = setup({ delayMin: 0, pending: [ho(7)] })
  expect(await startQueue(io, 'handover')).toContain('Started reviewer reviewer-1')
  expect(w.delays).toEqual([])
})

test('an approval with no wait running starts at once', async () => {
  const { w, io } = setup({ pending: [ho(7)] })
  expect(await startQueue(io, 'approval')).toContain('Started reviewer reviewer-1')
  expect(w.delays).toEqual([])
})

test('an approval during a running wait joins it', async () => {
  const { w, io, fire } = setup({ pending: [ho(7)] })
  await startQueue(io, 'handover')
  w.handovers['8'] = ho(8)
  expect(await startQueue(io, 'approval')).toContain('joins')
  expect(w.spawns).toHaveLength(0)
  await fire()
  expect(w.spawns).toHaveLength(1)
  expect(w.spawns[0]).toContain('#7, #8')
})

test('a push run is not delayed', async () => {
  const { w, io } = setup({ batch: { id: 'b1', state: 'pushing' } as Batch })
  expect(await startQueue(io, 'other')).toContain('Started reviewer')
  expect(w.delays).toEqual([])
})

test('due deploys and leftover work start at once', async () => {
  const { w, io } = setup({ pending: [ho(7)], deploys: { targets: { prod: { due: true } } } as unknown as Deploys })
  expect(await startQueue(io, 'handover')).toContain('Started reviewer')
  const left = setup({ pending: [ho(8)] })
  expect(await startQueue(left.io)).toContain('Started reviewer')
  expect([...w.delays, ...left.w.delays]).toEqual([])
})

test('the breaker backoff still uses its own timer, and a halted queue arms no delay', async () => {
  const backoff = setup({ pending: [ho(7)], breaker: { ...EMPTY_BREAKER, streak: 1, endedAt: 999_000 } })
  expect(await startQueue(backoff.io, 'handover')).toContain('Backing off')
  expect(backoff.w.waits).toHaveLength(1)
  expect(backoff.w.delays).toEqual([])
  const halted = setup({ pending: [ho(7)], breaker: { ...EMPTY_BREAKER, halt: { at: 1, error: 'x' } } })
  expect(await startQueue(halted.io, 'handover')).toContain('halted')
  expect(halted.w.delays).toEqual([])
})

test('an idle reviewer terminal waits for the delay; one already told work is told the new handover now', async () => {
  const idle = { name: `rv-${Math.random().toString(36).slice(2)}`, host: 'tmux', nudged: [] } as unknown as Session
  const a = setup({ pending: [ho(7)], session: idle })
  expect(await startQueue(a.io, 'handover')).toContain('starts in 3m')
  expect(a.w.typed).toEqual([])
  expect(await a.fire()).toContain('picks it up')
  expect(a.w.typed).toEqual(['new handover: #7'])
  const busy = { name: `rv-${Math.random().toString(36).slice(2)}`, host: 'tmux', nudged: [] } as unknown as Session
  const b = setup({ pending: [ho(7, 'taken'), ho(8)], session: busy })
  expect(await startQueue(b.io, 'handover')).toContain('picks it up')
  expect(b.w.typed).toEqual(['new handover: #8'])
  expect(b.w.delays).toEqual([])
})
