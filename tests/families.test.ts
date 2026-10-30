import { expect } from 'claude-code/testing'
import { test } from './support'

import { isManagerPredecessor, isWorkerPredecessor } from '../hooks/routing'
import { normalizeFamilies, noteKey, recordFamily, setFamilies } from '../hooks/state'
import type { Families, FamilyFacts } from '../hooks/state'

// Facts as the spawn hook gathers them: names on the roster now, managers seen before (the ledger).
const facts = (listed: string[] = [], seen: string[] = []): FamilyFacts => ({
  listed: n => listed.includes(n),
  seen: n => listed.includes(n) || seen.includes(n),
})
const keyed = (f: Families, ...names: string[]) => { for (const n of names) f = recordFamily(f, n, facts()); return f }

test('issue-238 and issue-240 started as new tasks are two families; so are issue-238 and issue-239 running side by side', () => {
  const f = keyed({}, 'issue-238', 'issue-240', 'issue-239')
  expect(f).toEqual({ 'issue-238': 'issue-238', 'issue-240': 'issue-240', 'issue-239': 'issue-239' })
  setFamilies(f)
  expect(noteKey('issue-238')).toBe('issue-238')
  expect(noteKey('issue-240')).toBe('issue-240')
  expect(noteKey('issue-239')).not.toBe(noteKey('issue-238'))
  setFamilies({})
})

test('real successors join the family: csv -> csv-2 -> csv-3, issue-238 -> issue-238-2', () => {
  let f = keyed({}, 'csv', 'issue-238')
  f = keyed(f, 'csv-2', 'csv-3', 'issue-238-2', 'issue-238-3')
  expect(f).toMatchObject({ csv: 'csv', 'csv-2': 'csv', 'csv-3': 'csv', 'issue-238-2': 'issue-238', 'issue-238-3': 'issue-238' })
  setFamilies(f)
  // The dispatch skill has a successor read notes with manager = <old name>: the same key.
  expect(noteKey('csv-3')).toBe(noteKey('csv'))
  expect(noteKey('issue-238-2')).toBe(noteKey('issue-238'))
  setFamilies({})
})

test('a predecessor known only from the ledger or the roster counts; an unknown base does not', () => {
  expect(recordFamily({}, 'csv-2', facts([], ['csv']))['csv-2']).toBe('csv')
  expect(recordFamily({}, 'csv-2', facts(['csv']))['csv-2']).toBe('csv')
  expect(recordFamily({}, 'csv-2', facts())['csv-2']).toBe('csv-2')
})

test('a name recorded keeps its family (a resume); one listed before families were kept keeps the old reading', () => {
  const f = keyed({}, 'issue-240')
  expect(recordFamily(f, 'issue-240', facts(['issue-240']))).toBe(f)
  // In flight from before the upgrade: issue-238 kept its data under `issue`, and goes on finding it.
  expect(recordFamily({}, 'issue-238', facts(['issue-238']))['issue-238']).toBe('issue')
  // Its successor follows it there.
  expect(recordFamily({}, 'issue-238-2', facts([], ['issue-238']))['issue-238-2']).toBe('issue')
})

test('an unrecorded name keeps the old reading; families.json drops malformed entries', () => {
  setFamilies({})
  expect(noteKey('pkg-2')).toBe('pkg')
  expect(noteKey('a b')).toBe('a_b')
  expect(noteKey('constructor')).toBe('constructor')
  expect(normalizeFamilies({ a: 'a', b: 3, c: '' })).toEqual({ a: 'a' })
  expect(normalizeFamilies([1])).toEqual({})
  expect(normalizeFamilies(null)).toEqual({})
})

test('manager predecessors stay in the family; issue-238 is not issue-240s', () => {
  setFamilies(keyed({}, 'issue-238', 'issue-240', 'csv', 'csv-2', 'csv-3', 'issue-238-2'))
  expect(isManagerPredecessor('issue-238', 'issue-240')).toBe(false)
  expect(isManagerPredecessor('issue-238', 'issue-238-2')).toBe(true)
  expect(isManagerPredecessor('csv', 'csv-3')).toBe(true)
  expect(isManagerPredecessor('csv-2', 'csv-3')).toBe(true)
  // Spawned again after csv-3 started: csv-3 is no predecessor of csv-2.
  expect(isManagerPredecessor('csv-3', 'csv-2')).toBe(false)
  expect(isManagerPredecessor('csv-2', 'csv-2')).toBe(false)
  setFamilies({})
})

test('worker predecessors need the first generation: fix-issue-12 is no successor of fix-issue-7', () => {
  expect(isWorkerPredecessor('fix-issue-7', 'fix-issue-12', ['fix-issue-7'])).toBe(false)
  expect(isWorkerPredecessor('pkg', 'pkg-2', ['pkg'])).toBe(true)
  expect(isWorkerPredecessor('fix-issue-7', 'fix-issue-7-2', ['fix-issue-7', 'fix-issue-12'])).toBe(true)
  expect(isWorkerPredecessor('fix-issue-12', 'fix-issue-7-2', ['fix-issue-7', 'fix-issue-12'])).toBe(false)
  expect(isWorkerPredecessor('pkg-2', 'pkg-3', ['pkg', 'pkg-2'])).toBe(true)
  expect(isWorkerPredecessor('pkg-a', 'pkg-a-2', ['pkg-a', 'pkg-b'])).toBe(true)
  expect(isWorkerPredecessor('pkg-b', 'pkg-a-2', ['pkg-a', 'pkg-b'])).toBe(false)
})
