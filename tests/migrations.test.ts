import { expect } from 'claude-code/testing'
import { test } from './support'
import { analyze, findRefs, render, UNSET_TEXT } from '../hooks/migrations'
import type { PrInput } from '../hooks/migrations'

const D = 'db/migrations'
const run = (baseFiles: string[], prs: PrInput[], refFiles: string[] = baseFiles) => analyze({ dir: D, baseFiles, refFiles, prs })
const base = [`${D}/0001_a.sql`, `${D}/0002_b.sql`, `${D}/0003_c.sql`]

test('no clash: a number above the base is ok', () => {
  const r = run(base, [{ pr: 1, added: [`${D}/0004_d.sql`] }])
  expect(r.baseHigh).toBe(3n)
  expect(r.prs[0]!.migrations[0]!.status).toBe('ok')
  expect(render(r)).toContain('ok: db/migrations/0004_d.sql')
})

test('clash with a number already on the base', () => {
  const m = run(base, [{ pr: 1, added: [`${D}/0003_x.sql`] }]).prs[0]!.migrations[0]!
  expect(m.status).toBe('clash')
  expect(m.clashWith).toBe(`${D}/0003_c.sql`)
  expect(m.newNumber).toBe('0004')
  expect(m.moves).toEqual([{ from: `${D}/0003_x.sql`, to: `${D}/0004_x.sql` }])
})

test('clash between two PRs: the later one is renumbered past the earlier', () => {
  const r = run(base, [{ pr: 1, added: [`${D}/0004_x.sql`] }, { pr: 2, added: [`${D}/0004_y.sql`] }, { pr: 3, added: [`${D}/0004_z.sql`] }])
  expect(r.prs[0]!.migrations[0]!.status).toBe('ok')
  expect(r.prs[1]!.migrations[0]!.clashWith).toBe(`${D}/0004_x.sql`)
  expect(r.prs[1]!.migrations[0]!.newNumber).toBe('0005')
  expect(r.prs[2]!.migrations[0]!.newNumber).toBe('0006')
})

test('at-or-below without a clash: renumbered to highest + 1, no gap fill', () => {
  const m = run([`${D}/0001_a.sql`, `${D}/0005_e.sql`], [{ pr: 1, added: [`${D}/0003_x.sql`] }]).prs[0]!.migrations[0]!
  expect(m.status).toBe('at-or-below')
  expect(m.newNumber).toBe('0006')
})

test('the highest at ref counts too', () => {
  const r = run(base, [{ pr: 1, added: [`${D}/0003_x.sql`] }], [...base, `${D}/0007_q.sql`])
  expect(r.refHigh).toBe(7n)
  expect(r.prs[0]!.migrations[0]!.newNumber).toBe('0008')
})

test('zero padding width of the original prefix is kept, also for long timestamps', () => {
  expect(run([`${D}/001_a.sql`], [{ pr: 1, added: [`${D}/001_x.sql`] }]).prs[0]!.migrations[0]!.newNumber).toBe('002')
  const ts = [`${D}/20260101120000_a.sql`]
  const m = run(ts, [{ pr: 1, added: [`${D}/20260101110000_x.sql`] }]).prs[0]!.migrations[0]!
  expect(m.newNumber).toBe('20260101120001')
})

test('folder-style migrations are renamed as a folder', () => {
  const m = run(base, [{ pr: 1, added: [`${D}/0002_x/up.sql`, `${D}/0002_x/down.sql`] }]).prs[0]!.migrations[0]!
  expect(m.status).toBe('clash')
  expect(m.moves!.map(v => v.to)).toEqual([`${D}/0004_x/down.sql`, `${D}/0004_x/up.sql`])
})

test('a paired up/down is one migration with one new number', () => {
  const r = run(base, [{ pr: 1, added: [`${D}/0003_x.up.sql`, `${D}/0003_x.down.sql`] }])
  expect(r.prs[0]!.migrations).toHaveLength(1)
  expect(r.prs[0]!.migrations[0]!.moves!.map(v => v.to)).toEqual([`${D}/0004_x.down.sql`, `${D}/0004_x.up.sql`])
})

test('entries without leading digits are unnumbered and ignored', () => {
  const r = run(base, [{ pr: 1, added: [`${D}/README.md`, `${D}/0004_d.sql`] }])
  expect(r.prs[0]!.unnumbered).toEqual([`${D}/README.md`])
  expect(render(r)).toContain('unnumbered (ignored): db/migrations/README.md')
})

test('a dir missing on the base starts from the PR\'s own numbers', () => {
  const r = run([], [{ pr: 1, added: [`${D}/0001_a.sql`] }, { pr: 2, added: [`${D}/0001_b.sql`] }])
  expect(r.baseHigh).toBeUndefined()
  expect(r.prs[0]!.migrations[0]!.status).toBe('ok')
  expect(r.prs[1]!.migrations[0]!.newNumber).toBe('0002')
})

test('a PR that failed is reported alone; no prs just reports the highest numbers', () => {
  const r = run(base, [{ pr: 9, added: [], error: 'head not fetchable' }, { pr: 1, added: [`${D}/0004_d.sql`] }])
  expect(render(r)).toContain('not checked: head not fetchable')
  expect(r.prs[1]!.migrations[0]!.status).toBe('ok')
  expect(render(run(base, []))).toContain('Highest on the base: 3')
})

test('a duplicate already on the base is reported as-is, not as the PR\'s problem', () => {
  const dup = [...base, `${D}/0003_dup.sql`]
  const r = run(dup, [{ pr: 1, added: [`${D}/0004_d.sql`] }])
  expect(r.prs[0]!.migrations[0]!.status).toBe('ok')
})

test('a PR already part of ref is not renumbered against itself', () => {
  const m = run(base, [{ pr: 1, added: [`${D}/0004_d.sql`] }], [...base, `${D}/0004_d.sql`]).prs[0]!.migrations[0]!
  expect(m.status).toBe('ok')
})

test('self-references: whole-token number and old name, also inside the migration\'s own files', () => {
  const m = run(base, [{ pr: 1, added: [`${D}/0003_x.up.sql`, `${D}/0003_x.down.sql`] }]).prs[0]!.migrations[0]!
  const refs = findRefs(m, [
    { path: `${D}/0003_x.up.sql`, text: 'create table t();\ninsert into schema_version values (3, \'0003\');\n' },
    { path: `${D}/0003_x.down.sql`, text: 'drop table t;\n' },
    { path: 'db/journal.json', text: '{\n  "tag": "0003_x.up.sql"\n}' },
    { path: 'src/version.ts', text: 'const a = 1\nexport const LATEST = "0003"\nconst b = "00031"' },
  ])
  expect(refs).toEqual([{ file: `${D}/0003_x.up.sql`, line: 2 }, { file: 'db/journal.json', line: 2 }, { file: 'src/version.ts', line: 2 }])
  m.refs = refs
  expect(render({ dir: D, prs: [{ pr: 1, migrations: [m], unnumbered: [] }] })).toContain('references its number in db/journal.json:2')
})

test('migrations_dir unset has its own answer', () => {
  expect(UNSET_TEXT).toContain('migrations_dir')
})
