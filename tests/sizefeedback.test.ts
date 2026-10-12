import { expect } from 'claude-code/testing'
import { test } from './support'

import { DIGEST_HEADER, sizeDigest, withDigest } from '../hooks/sizefeedback'
import { withSizeFeedback } from '../hooks/spawn'
import type { SpawnIo } from '../hooks/spawn'
import { settingsOf } from '../hooks/settings'
import type { Ledger } from '../types'

const w = (name: string, size: string, firstAt = 0) => ({ role: 'worker', name, manager: 'm', branch: `flow/${name}`, size, firstAt, models: {} }) as const
const ledgerOf = (...rows: ReturnType<typeof w>[]): Ledger => Object.fromEntries(rows.map(r => [r.name, r])) as unknown as Ledger
const many = (n: number, size: string, prefix = size) => Array.from({ length: n }, (_, i) => w(`${prefix}${i}`, size, i))

test('digest: empty or thin history gives nothing', () => {
  expect(sizeDigest({}, [])).toBe('')
  expect(sizeDigest(ledgerOf(...many(4, 'normal')), [])).toBe('')
})

test('digest: a successor counts as a rerun, with example names; running workers count as recent only', () => {
  const l = ledgerOf(...many(4, 'normal'), w('normal1-2', 'large'), ...many(2, 'small'))
  const d = sizeDigest(l, [])
  expect(d.split('\n')[0]).toBe(DIGEST_HEADER)
  expect(d).toContain('- small: 2 recent, 0 needed a rerun one size up')
  expect(d).toContain('- normal: 4 recent, 1 needed a rerun (successor or handoff), e.g. normal1')
  expect(d).not.toContain('- large')
})

test('digest: a handoff counts below large but not for a large worker', () => {
  const l = ledgerOf(...many(3, 'normal'), ...many(3, 'large'))
  const log = [{ event: 'handoff', branch: 'flow/normal0' }, { event: 'continue', branch: 'flow/large1' }] as never
  const d = sizeDigest(l, log)
  expect(d).toContain('- normal: 3 recent, 1 needed a rerun (successor or handoff), e.g. normal0')
  expect(d).toContain('- large: 3 recent')
  expect(d).not.toContain('large1')
})

test('digest: only the last 20 first-generation workers per size, by time', () => {
  // normal0 is the oldest: with a successor it falls out of the window of 20; normal20 is inside it
  expect(sizeDigest(ledgerOf(...many(21, 'normal'), w('normal0-2', 'normal', 99)), [])).toContain('- normal: 20 recent, 0 needed')
  expect(sizeDigest(ledgerOf(...many(21, 'normal'), w('normal20-2', 'normal', 99)), [])).toContain('- normal: 20 recent, 1 needed')
})

test('withDigest appends once and never twice', () => {
  const d = `${DIGEST_HEADER}\n- normal: 5 recent`
  const once = withDigest('Your name: m\nbrief', d)
  expect(once.endsWith(`${d}\n`)).toBe(true)
  expect(withDigest(once, d)).toBe(once)
  expect(withDigest('x', '')).toBe('x')
})

const io = (ledger: Ledger, boom = false): SpawnIo => ({
  loadLedger: async () => undefined,
  ledger: async () => { if (boom) throw new Error('disk'); return ledger },
  readLog: async () => [],
  warn: async () => undefined,
}) as unknown as SpawnIo
const spawn = { name: 'mgr', description: 'mgr', prompt: 'Your name: mgr\nbrief', subagentType: 'flow:manager' } as never

test('withSizeFeedback adds the digest to the prompt and says so; thin history or a failure leaves the spawn unchanged', async () => {
  const fed = await withSizeFeedback(io(ledgerOf(...many(5, 'normal'))), spawn)
  expect(fed.fed).toBe(true)
  expect((fed.e as { prompt: string }).prompt).toContain(DIGEST_HEADER)
  const twice = await withSizeFeedback(io(ledgerOf(...many(5, 'normal'))), fed.e)
  expect((twice.e as { prompt: string }).prompt).toBe((fed.e as { prompt: string }).prompt)
  expect(await withSizeFeedback(io({}), spawn)).toEqual({ e: spawn, fed: false })
  expect(await withSizeFeedback(io(ledgerOf(...many(5, 'normal')), true), spawn)).toEqual({ e: spawn, fed: false })
})

test('size_feedback defaults on and false turns it off', () => {
  expect(settingsOf({}, 'main').sizeFeedback).toBe(true)
  expect(settingsOf({ size_feedback: false }, 'main').sizeFeedback).toBe(false)
})
