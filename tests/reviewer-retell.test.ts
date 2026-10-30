import { expect } from 'claude-code/testing'
import type { Deploys, Handover, Session } from '../types'
import { mirror } from '../hooks/core'
import { startQueue, toldKey } from '../hooks/reviewer-run'
import type { QueueIo } from '../hooks/reviewer-run'
import { test } from './support'

// startQueue against a fake QueueIo: a reviewer terminal that waits, and what is typed into it when work comes due.

type Batch = NonNullable<Awaited<ReturnType<QueueIo['batch']>>>

function setup(initial: { pending?: Handover[]; deploys?: Deploys; batch?: Batch; nudged?: string[] } = {}) {
  mirror.deployInfos = [{ name: 'prod', mode: 'auto' }]
  // A name per call: the signature memory is by session name and survives between tests.
  const session = { name: `rv-${Math.random().toString(36).slice(2)}`, host: 'tmux', nudged: initial.nudged ?? [] } as unknown as Session
  const w = {
    session,
    typed: [] as string[],
    handovers: Object.fromEntries((initial.pending ?? []).map(h => [String(h.pr), h])) as Record<string, Handover>,
    deploys: initial.deploys ?? ({ targets: {} } as Deploys),
    batch: initial.batch as Batch | undefined,
  }
  const io = {
    agents: async () => [],
    batch: async () => w.batch,
    handovers: async () => w.handovers,
    deploys: async () => w.deploys,
    runs: async () => 0,
    setRuns: async () => undefined,
    spawn: async () => { throw new Error('a waiting terminal must not be respawned') },
    reviewerSession: async () => w.session,
    nudge: async (_s: Session, text: string, told: string[]) => { w.typed.push(text); w.session.nudged = told; return undefined },
    setTold: async (_s: Session, told: string[]) => { w.session.nudged = told },
    // Read for a reviewer told to hand off (none here); nothing else of the breaker is used on this path.
    breaker: { stateDir: async () => undefined, get: async () => ({ streak: 0 }) } as never,
    wait: () => undefined,
  } as QueueIo
  return { w, io }
}

const ho = (pr: number, status = 'pending', at = 1): Handover => ({ pr, at, status } as unknown as Handover)
const due = (deployedAt?: number, approvalAt?: number): Deploys => ({
  targets: { prod: { due: true, ...(deployedAt === undefined ? {} : { deployedAt }), ...(approvalAt === undefined ? {} : { approval: { at: approvalAt } }) } },
} as unknown as Deploys)
const batch = (state: Batch['state'], id = 'b1'): Batch => ({ id, state } as Batch)

test('a due deploy is typed into the waiting reviewer once, and again after a new deploy or a new approval', async () => {
  const { w, io } = setup({ deploys: due(100, 50) })
  expect(await startQueue(io)).toContain('picks it up')
  expect(w.typed).toEqual(['deploy due: prod'])
  // Same signature on later ticks: nothing more is typed.
  expect(await startQueue(io)).toContain('already been told')
  expect(await startQueue(io)).toContain('already been told')
  expect(w.typed).toHaveLength(1)
  // A new deploy of the target makes it due again.
  w.deploys = due(200, 50)
  await startQueue(io)
  expect(w.typed).toHaveLength(2)
  await startQueue(io)
  expect(w.typed).toHaveLength(2)
  // So does a new approval.
  w.deploys = due(200, 90)
  await startQueue(io)
  expect(w.typed).toHaveLength(3)
  expect(w.typed.every(t => t === 'deploy due: prod')).toBe(true)
})

test('a deploy that was cleared and comes due with the same signature is typed again', async () => {
  const { w, io } = setup({ deploys: due(100, 50), pending: [ho(3)] })
  await startQueue(io)
  w.deploys = { targets: {} }
  w.handovers = {}
  await startQueue(io)
  w.deploys = due(100, 50)
  await startQueue(io)
  expect(w.typed).toEqual(['new handover: #3; deploy due: prod', 'deploy due: prod'])
})

test('the push run is typed once per batch state, and again when it comes due again', async () => {
  const { w, io } = setup({ batch: batch('pushing') })
  await startQueue(io)
  expect(w.typed).toEqual(['push run due: batch b1'])
  expect(await startQueue(io)).toContain('already been told')
  // The push finished; the next batch is released.
  w.batch = undefined
  await startQueue(io)
  w.batch = batch('pushing', 'b2')
  await startQueue(io)
  expect(w.typed).toEqual(['push run due: batch b1', 'push run due: batch b2'])
  // A batch awaiting the user's push is not push work.
  w.batch = batch('ready', 'b3')
  expect(await startQueue(io)).toContain('awaits the user')
  expect(w.typed).toHaveLength(2)
})

test('a handover already in nudged is not re-told; a new one is, with only the new one named', async () => {
  const h7 = ho(7)
  const { w, io } = setup({ pending: [h7], nudged: [toldKey(h7)] })
  expect(await startQueue(io)).toContain('already been told')
  expect(w.typed).toEqual([])
  w.handovers = { 7: h7, 8: ho(8) }
  await startQueue(io)
  expect(w.typed).toEqual(['new handover: #8'])
  expect(w.session.nudged).toEqual([toldKey(h7), toldKey(ho(8))])
})
