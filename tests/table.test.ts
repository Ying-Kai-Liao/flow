import { expect, test } from 'claude-code/testing'
import { renderTable, termWidth, truncate } from '../hooks/table'
import type { Column } from '../hooks/table'

const cols: Column[] = [
  { header: 'id' }, { header: 'title', flex: true }, { header: 'needs', max: 14, drop: 2 }, { header: 'age', max: 4, drop: 1 },
]
const rows = [
  'Section',
  ['c1', 'A very long title that will not fit into a narrow terminal at all, really', 'install 0.6.14', '3d'],
  ['c2', 'Short', 'ready', '5h'],
]

test('truncate collapses whitespace and ends in an ellipsis only when it cut', () => {
  expect(truncate('a  b\nc', 10)).toBe('a b c')
  expect(truncate('abcdefgh', 5)).toBe('abcd…')
  expect(truncate('abc', 0)).toBe('')
  expect(truncate('abc', 1)).toBe('…')
})

test('termWidth takes a positive column count, else 100, never under 40', () => {
  expect(termWidth(120)).toBe(120)
  expect(termWidth(0)).toBe(100)
  expect(termWidth(undefined)).toBe(100)
  expect(termWidth(20)).toBe(40)
})

test('every line fits at 100, 50 and 40, the title truncates, narrow widths drop age then needs', () => {
  for (const w of [100, 50, 40]) for (const l of renderTable(cols, rows, w)) expect(l.length).toBeLessThanOrEqual(w)
  const wide = renderTable(cols, rows, 100)
  expect(wide[0]).toMatch(/^id\s+title\s+needs\s+age$/)
  expect(wide.join('\n')).toContain('Section')
  expect(renderTable(cols, rows, 50).join('\n')).toContain('…')
  // Too narrow for the flex column's minimum: age goes first, then needs.
  const tight: Column[] = [{ header: 'id' }, { header: 'title', flex: true }, { header: 'needs', min: 16, drop: 2 }, { header: 'age', min: 10, drop: 1 }]
  const noAge = renderTable(tight, rows, 40).join('\n')
  expect(noAge).not.toContain('age')
  expect(noAge).toContain('needs')
  const bare = renderTable([{ header: 'id' }, { header: 'title', flex: true }, { header: 'needs', min: 26, drop: 2 }, { header: 'age', min: 10, drop: 1 }], rows, 40).join('\n')
  expect(bare).not.toContain('needs')
  expect(bare).not.toContain('age')
  expect(bare).toContain('title')
})

test('limit adds a "+M more" line, with the caller wording when given, and it fits the width', () => {
  const many = Array.from({ length: 5 }, (_, i) => [`c${i}`, 't', 'ready', '1d'])
  expect(renderTable(cols, many, 50, { limit: 2 }).at(-1)).toBe('+3 more')
  expect(renderTable(cols, many, 50, { limit: 2, more: m => `${m} older, use all` }).at(-1)).toBe('3 older, use all')
  expect(renderTable(cols, many, 40, { limit: 2, more: () => 'x'.repeat(80) }).at(-1)!.length).toBeLessThanOrEqual(40)
  expect(renderTable(cols, many, 50).length).toBe(6)
})
