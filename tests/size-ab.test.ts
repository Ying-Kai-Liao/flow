import { expect } from 'claude-code/testing'
import { test } from './support'

import { formatSizeAb, mergedBranches, reportFrom, sizeAbReport, sizeAbTool, sizeArmOf, sizerFor } from '../hooks/size-ab'
import { routeWorker } from '../hooks/spawn'
import type { SpawnIo } from '../hooks/spawn'
import { settingsOf } from '../hooks/settings'

// Local noon of a calendar day, so the arm does not depend on the machine's time zone.
const noon = (y: number, m: number, d: number): number => new Date(y, m - 1, d, 12).getTime()
const epochDay = (y: number, m: number, d: number): number => Date.UTC(y, m - 1, d) / 86_400_000

test('size_ab defaults off; daily is the only other choice', () => {
  expect(settingsOf({}, 'main').sizeAb).toBe('off')
  expect(settingsOf({ size_ab: 'daily' }, 'main').sizeAb).toBe('daily')
  expect(settingsOf({ size_ab: 'weekly' }, 'main').sizeAb).toBe('off')
})

test('arm: even local epoch day is jev, odd is off; the month boundary does not repeat an arm', () => {
  const arms = [noon(2026, 10, 30), noon(2026, 10, 31), noon(2026, 11, 1), noon(2026, 11, 2)].map(t => sizeArmOf('daily', 'jev', t))
  expect(arms[0]).not.toBe(arms[1])
  expect(arms[1]).not.toBe(arms[2])
  expect(arms[2]).not.toBe(arms[3])
  const even = epochDay(2026, 10, 12) % 2 === 0
  expect(sizeArmOf('daily', 'jev', noon(2026, 10, 12))).toBe(even ? 'jev' : 'off')
  expect(sizeArmOf('daily', 'jev', noon(2026, 10, 13))).toBe(even ? 'off' : 'jev')
})

test('no arm when size_ab is off or decision_api is not jev', () => {
  const t = noon(2026, 10, 12)
  expect(sizeArmOf('off', 'jev', t)).toBeUndefined()
  expect(sizeArmOf(undefined, 'jev', t)).toBeUndefined()
  for (const api of ['off', 'openai', undefined]) expect(sizeArmOf('daily', api, t)).toBeUndefined()
})

const MODELS = { small: 'haiku', normal: 'sonnet', large: 'sonnet[1m]' }
const io = { loadLedger: async () => undefined, ledger: async () => ({}) } as unknown as SpawnIo
const spawn = { name: 'x', description: 'x', prompt: 'Size: normal - a few files', subagentType: 'flow:worker' } as never

test('the off arm makes no decision API call and sizes by the Size line; the jev arm calls it', async () => {
  let calls = 0
  const jev = async () => { calls++; return { size: 'small' as const, confidence: 0.9, source: 'jev' } }
  const off = await routeWorker(io, spawn, MODELS, sizerFor('off', () => jev))
  expect(calls).toBe(0)
  expect(off.routed?.size).toBe('normal')
  expect(off.routed?.jev).toBeUndefined()
  const on = await routeWorker(io, spawn, MODELS, sizerFor('jev', () => jev))
  expect(calls).toBe(1)
  expect(on.routed?.size).toBe('small')
  expect(sizerFor(undefined, () => jev)).toBe(jev)
})

const row = (name: string, arm: 'jev' | 'off' | undefined, o: Record<string, unknown> = {}) => ({
  role: 'worker', name, branch: `flow/${name}`, spawnModel: 'sonnet', models: { 'claude-sonnet-4-5': { input: 1_000_000, write5m: 0, write1h: 0, read: 0, output: 0 } }, ...(arm && { sizeArm: arm }), ...o,
})
const ledger = (...rows: ReturnType<typeof row>[]) => Object.fromEntries(rows.map(r => [r.name, r]))

test('report: packages by the arm of the first spawn, successor rate, $ per merged PR, model mix; untagged rows ignored', () => {
  const l = ledger(
    row('a', 'jev'), row('a-2', 'off'), row('b', 'jev'), // a: first spawn jev, one successor
    row('c', 'off'), row('d', undefined), row('d-2', 'jev'), // d: first spawn untagged, so left out
  )
  const r = sizeAbReport(l as never, new Set(['flow/a-2', 'flow/c']))
  expect(r.worker.jev).toMatchObject({ packages: 2, merged: 1, rerun: 1, models: { sonnet: 3 } })
  expect(r.worker.off).toMatchObject({ packages: 1, merged: 1, rerun: 0 })
  expect(Math.abs(r.worker.jev.usd - 3 * r.worker.off.usd) < 1e-9).toBe(true)
  expect(r.worker.jev.usdPerMerged).toBe(r.worker.jev.usd)
  expect(r.manager.jev.packages).toBe(0)
})

test('report: a manager package is merged by its workers\' branches', () => {
  const l = ledger(row('m', 'jev', { role: 'manager', branch: undefined }), row('w', undefined, { manager: 'm' }))
  expect(sizeAbReport(l as never, new Set()).manager.jev.merged).toBe(0)
  expect(sizeAbReport(l as never, new Set(['flow/w'])).manager.jev).toMatchObject({ packages: 1, merged: 1 })
})

test('report text: small-n note under 20 packages in an arm, none at 20 each', () => {
  const small = formatSizeAb(sizeAbReport(ledger(row('a', 'jev')) as never, new Set()))
  expect(small).toContain('Too small to conclude')
  expect(small).toContain('no $ per merged PR')
  const many = (arm: 'jev' | 'off') => Array.from({ length: 20 }, (_, i) => row(`${arm}${i}`, arm))
  const big = formatSizeAb(sizeAbReport(ledger(...many('jev'), ...many('off')) as never, new Set()))
  expect(big).toContain('Too small to conclude (manager')
  expect(big).not.toContain('worker and')
  expect(big).not.toContain('(worker')
})

test('merged branches come from done events; reportFrom tolerates missing and torn files', () => {
  expect([...mergedBranches([{ event: 'done', branch: 'flow/a' }, { event: 'back', branch: 'flow/b' }, { event: 'done' }] as never)]).toEqual(['flow/a'])
  expect(reportFrom(undefined, undefined)).toContain('Too small to conclude')
  const text = reportFrom(JSON.stringify(ledger(row('a', 'off'))), '{"event":"done","branch":"flow/a"}\n{torn')
  expect(text).toContain('off: 1 packages, 1 merged')
})

test('the tool is main only and reads state files, never writes', async () => {
  const reads: string[] = []
  const io = { stateDir: async () => '/state', readFile: async (p: string) => { reads.push(p); return undefined } }
  expect(await sizeAbTool(io, 'agent-1')).toContain('Refused')
  expect(reads).toEqual([])
  expect(await sizeAbTool(io, undefined)).toContain('Size A/B')
  expect(reads).toEqual(['/state/ledger.json', '/state/log.jsonl'])
  expect(await sizeAbTool({ ...io, stateDir: async () => undefined }, undefined)).toContain('Refused')
})
