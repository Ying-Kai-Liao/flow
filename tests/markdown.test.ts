import { expect } from 'claude-code/testing'
import { timedTest as test } from './support'
import { clipLines, mdFit, mdFlat, mdLines, mdPlain, parseInline, rowLines, strWidth, textRows } from '../hooks/markdown'
import type { Line, Span } from '../hooks/markdown'

const str = (l: Line): string => l.map(s => s.t).join('')
const rows = (text: string, width = 60, o: Parameters<typeof mdLines>[2] = {}): string[] => mdLines(text, width, o).map(str)
const cols = (s: string): number => [...s].length
const widest = (out: string[]): number => Math.max(0, ...out.map(cols))

// Every element, at the two widths the pane is tested at; no row is ever wider than the width.
const SAMPLE = [
  '# Title', '', 'Some **bold**, *italic*, `code` and a [link](https://example.com/x) in a long paragraph that has to wrap around.', '',
  '- first item with enough words to wrap past the edge of a sixty column pane',
  '  - nested item', '    - deeper one', '2. numbered', '', '> quoted text that is long enough to wrap onto a second row as well',
  '', '```ts', 'const a = "a very long line of code that will not fit in sixty columns, for sure, never"', '```',
  '', '| name | value |', '| --- | ---: |', '| one | 1 |', '| two | 22 |', '', '---', '', 'the end',
].join('\n')

for (const width of [60, 100]) {
  test(`every element fits ${width} columns and keeps its text`, () => {
    const out = rows(SAMPLE, width)
    expect(widest(out)).toBeLessThanOrEqual(width)
    const t = out.join('\n')
    expect(t).toContain('Title')
    expect(t).toContain('Some bold, italic, code and a link (https://example.com/x)')
    expect(t).toContain('• first item')
    expect(t).toContain('  ◦ nested item')
    expect(t).toContain('2. numbered')
    expect(t).toContain('│ quoted text')
    expect(t).toContain('const a = "a very')
    expect(t).toContain('name │ value')
    expect(t).toContain('two  │    22')
    expect(t).toContain('─────')
    expect(t).toContain('the end')
    expect(t).not.toMatch(/\*\*|```|\[link\]/)
  })
}

test('headings are bold, the first level underlined; code is the code colour; links are underlined with the url dim', () => {
  const [h1, , h2] = mdLines('# One\n\n## Two', 60)
  expect(h1).toEqual([{ t: 'One', bold: true, under: true }])
  expect(h2).toEqual([{ t: 'Two', bold: true }])
  expect(parseInline('`npm test`')).toEqual([{ t: 'npm test', color: 'suggestion' }])
  expect(parseInline('[docs](https://x.io)')).toEqual([{ t: 'docs', under: true }, { t: ' (https://x.io)', dim: true }])
  expect(parseInline('[https://x.io](https://x.io)')).toEqual([{ t: 'https://x.io', under: true }])
  expect(parseInline('**b *i* b**')).toEqual([{ t: 'b ', bold: true }, { t: 'i', bold: true, italic: true }, { t: ' b', bold: true }])
  expect(parseInline('~~gone~~')).toEqual([{ t: 'gone', strike: true }])
  expect(parseInline('***both***')).toEqual([{ t: 'both', bold: true, italic: true }])
})

test('fenced and indented code keep every line, whitespace and markers inside as they are', () => {
  expect(rows('```\n**not bold**\n  indented\n```')).toEqual(['  **not bold**', '    indented'])
  expect(rows('para\n\n    four spaces\n    again')).toEqual(['para', '', '  four spaces', '  again'])
  // An unclosed fence runs to the end of the text.
  expect(rows('```sh\nls -la\nwhoami')).toEqual(['  ls -la', '  whoami'])
  // A long code line wraps by cutting, never dropped.
  const long = rows('```\n' + 'x'.repeat(130) + '\n```', 60)
  expect(long.join('').replace(/\s/g, '')).toBe('x'.repeat(130))
  expect(widest(long)).toBeLessThanOrEqual(60)
})

test('lists nest by indent, number, and carry their continuation lines', () => {
  expect(rows('- a\n  - b\n    - c\n- d')).toEqual(['• a', '  ◦ b', '    ◦ c', '• d'])
  expect(rows('1. one\n2. two\n   more of two')).toEqual(['1. one', '2. two', '   more of two'])
  // A blank line between items does not end the list.
  expect(rows('- a\n\n- b')).toEqual(['• a', '• b'])
  // A long item hangs under its text.
  const r = rows('- ' + 'word '.repeat(30), 40)
  expect(r[0]!.startsWith('• word')).toBe(true)
  expect(r.slice(1).every(l => l.startsWith('  word'))).toBe(true)
})

test('tables align by their delimiter row; one too wide for the room falls back to header: value rows', () => {
  expect(rows('| a | bb |\n|:--|--:|\n| 1 | 2 |')).toEqual(['a │ bb', '──┼───', '1 │  2'])
  const wide = rows('| Command | Result |\n| --- | --- |\n| ' + 'c'.repeat(40) + ' | ' + 'r'.repeat(30) + ' |\n| second | ok |', 40)
  expect(wide[0]).toBe('Command:')
  expect(wide.join('\n')).toContain('Result: ')
  expect(wide.join('\n')).toContain('Command: second')
  expect(widest(wide)).toBeLessThanOrEqual(40)
  expect(wide.join('').replace(/\s/g, '')).toContain('c'.repeat(40))
})

test('unknown or malformed syntax comes through as its literal characters', () => {
  for (const s of ['**unclosed bold', 'stray ` backtick', 'a * b * c', '2 * 3', 'under_score_name', 'hooks/foo_bar.ts and src/**/*.ts', '<div class="x">html</div>', '[not a link] (x)', '[x](', '~~half', '`', '\\', '#hashtag #171', '1.5 is not a list', 'a | b | c', '|']) {
    expect(mdPlain(s)).toBe(s.trim())
  }
  expect(parseInline('a_b_c')).toEqual([{ t: 'a_b_c' }])
  expect(mdPlain('https://x.io/a_b_c_d and https://y.io/*star*')).toBe('https://x.io/a_b_c_d and https://y.io/*star*')
  expect(mdPlain('escaped \\*stars\\* and \\`ticks\\`')).toBe('escaped *stars* and `ticks`')
})

test('plain text keeps its words and its line breaks; markers are the only thing taken out', () => {
  expect(rows('line one\nline two\n\nafter a gap')).toEqual(['line one', 'line two', '', 'after a gap'])
  expect(rows('')).toEqual([])
  expect(rows('   \n  ')).toEqual([])
  expect(rows('a\tb')).toEqual(['a b'])
  expect(rows('Ran:\n- `a`: pass\n- `b`: pass')).toEqual(['Ran:', '• a: pass', '• b: pass'])
  // A word longer than the row is cut, not dropped.
  expect(rows('x'.repeat(75), 60).join('')).toBe('x'.repeat(75))
})

test('a lead span opens the first paragraph, a tail closes the last, and a hanging indent aligns the rest', () => {
  expect(rows('the **text**', 60, { lead: { t: 'why: ', dim: true } })).toEqual(['why: the text'])
  expect(rows('- a\n- b', 60, { lead: { t: 'why: ' } })).toEqual(['why: ', '• a', '• b'])
  expect(rows('```\ncode\n```', 60, { lead: { t: 'why: ' } })).toEqual(['why: ', '  code'])
  expect(rows('x', 60, { tail: { t: ' (tail)' } })).toEqual(['x (tail)'])
  const r = rows('word '.repeat(20), 30, { lead: { t: '  - ' }, hang: 4 })
  expect(r[0]!.startsWith('  - word')).toBe(true)
  expect(r.slice(1).every(l => l.startsWith('    word'))).toBe(true)
  expect(rows('', 30, { lead: { t: 'label' } })).toEqual(['label'])
})

test('rowLines marks only the md range as markdown and keeps the rest literal', () => {
  const r = rowLines({ text: 'verified: **ran** it (verify: a_b *c*)', md: [10, 17] }, 60)
  expect(r.map(str)).toEqual(['verified: ran it (verify: a_b *c*)'])
  expect(rowLines({ text: 'hooks/a_b.ts' }, 60).map(str)).toEqual(['hooks/a_b.ts'])
  expect(rowLines({ text: '' }, 60)).toEqual([[]])
})

test('flat and fitted forms: one line, markers dropped, style kept, cut with an ellipsis', () => {
  expect(mdPlain('# Head\n\n- a\n- b\n\n**c**')).toBe('Head • a • b c')
  expect(mdPlain('line  one\nline two')).toBe('line one line two')
  expect(mdFlat('**bold** text')).toEqual([{ t: 'bold', bold: true }, { t: ' text' }])
  expect(mdPlain('**bold** and `code` here', 12)).toBe('bold and co…')
  expect(mdFit('short', 40)).toEqual([{ t: 'short' }])
  expect(mdPlain('x'.repeat(50), 10)).toBe('xxxxxxxxx…')
})

test('clipLines ends a long text in a marker instead of overflowing', () => {
  const l = mdLines('a\nb\nc\nd\ne', 60)
  expect(clipLines(l, 9, 60)).toBe(l)
  expect(clipLines(l, 2, 60).map(str)).toEqual(['a', 'b…'])
  expect(clipLines(mdLines('a long line of text', 60), 1, 60)).toHaveLength(1)
})

test('display width: CJK, kana, Hangul and fullwidth forms take two columns, combining and zero-width marks none, box drawing one', () => {
  expect(strWidth('abc')).toBe(3)
  expect(strWidth('测试')).toBe(4)
  expect(strWidth('テスト')).toBe(6)
  expect(strWidth('한국')).toBe(4)
  expect(strWidth('ＡＢ')).toBe(4)
  expect(strWidth('e\u0301')).toBe(1)
  expect(strWidth('a\u200bb')).toBe(2)
  expect(strWidth('┌─┐│└┘')).toBe(6)
})

for (const width of [20, 21, 60]) {
  test(`CJK text wraps by display width at ${width} columns: no row is wider and no wide character is split`, () => {
    const text = `${'这是一个很长的测试问题文本'.repeat(4)} テスト mixed with words テスト **太字** and \`代码\`\n\n- 列表项目 ${'很长'.repeat(15)}\n\n\`\`\`\n┌──────┐ 框图 ${'内容'.repeat(20)}\n\`\`\``
    const out = rows(text, width)
    for (const l of out) expect(strWidth(l)).toBeLessThanOrEqual(width)
    // Every character comes through: the rows joined hold the whole question text.
    expect(out.join('').replace(/\s/g, '')).toContain('这是一个很长的测试问题文本'.repeat(4))
    expect(out.join('')).toContain('┌──────┐')
    // Wide rows are filled: a run of CJK uses the width, not a character count of it.
    const full = out.find(l => /^[这是一个很长的测试问题文本]+$/.test(l))!
    expect(strWidth(full)).toBeGreaterThanOrEqual(width - 1)
  })
}

test('textRows counts the rows plain text wraps to, wide characters by their width', () => {
  expect(textRows('short', 40)).toBe(1)
  expect(textRows('', 40)).toBe(1)
  expect(textRows('one\ntwo', 40)).toBe(2)
  expect(textRows('测'.repeat(30), 20)).toBe(3)
})

test('a real PR body is read as markdown: the section heading, labels, code and the bullets', () => {
  const body = 'Status: ready. Open questions/approvals now fold into one row in the main pane, collapsed by default.\n\nRules changed\n- Collapsed: one row `▸ ▤ ? 3 questions (1 blocking) · 2 decisions · i` (warning colour when blocking), merging the old Inbox count line. Press it or `a` to expand.\n- Fold state reuses the `folded` atom under key `#questions` (default collapsed, like the Reviewer row).\n\n## Verification\nRan:\n- `npm run typecheck`: pass\nNot verified: live terminal look; `node --test tests/ledger-rebuild-io.node-test.mjs`.'
  for (const width of [60, 100]) {
    const out = rows(body, width)
    expect(widest(out)).toBeLessThanOrEqual(width)
    const t = out.join('\n')
    expect(t).toContain('• Collapsed: one row ▸ ▤ ? 3 questions')
    expect(t).toContain('Verification')
    expect(t).not.toContain('`')
    expect(t).not.toContain('## ')
    expect(t).toContain('• npm run typecheck: pass')
    expect(t).toContain('tests/ledger-rebuild-io.node-test.mjs')
  }
})
