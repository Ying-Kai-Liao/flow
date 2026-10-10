// A small pure text table for the person views (/flow checks, and others that reuse it): fixed-width columns, one
// flex column that takes the leftover room, columns dropped when the width is too narrow, rows that never wrap.
// No imports: the callers own what the cells say.

export type Column = {
  header: string
  // Narrowest and widest the column may be (fixed columns default to their content; the flex column's min to 12).
  min?: number
  max?: number
  // The one column that shrinks (and truncates) to fit; the first flagged one wins.
  flex?: boolean
  // When the flex column would get less than its min, columns with a drop rank are removed, lowest rank first.
  drop?: number
  align?: 'left' | 'right'
}

// A row is its cells, or a plain string: a section headline spanning the table, set off by a blank line.
export type Row = string[] | string

export const DEFAULT_WIDTH = 100
export const MIN_WIDTH = 40

// The width to render at: the given columns when a positive number, else the default; never below the minimum.
export const termWidth = (columns: unknown = (globalThis as { process?: { stdout?: { columns?: number } } }).process?.stdout?.columns): number =>
  Math.max(MIN_WIDTH, typeof columns === 'number' && Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : DEFAULT_WIDTH)

// Collapses whitespace and cuts to max characters, ending in an ellipsis when something was cut.
export function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return max <= 0 ? '' : t.length <= max ? t : max === 1 ? '…' : `${t.slice(0, max - 1).trimEnd()}…`
}

export function renderTable(cols: Column[], rows: Row[], width: number, opts: { limit?: number; indent?: number; more?: (m: number) => string } = {}): string[] {
  const w = Math.max(MIN_WIDTH, Math.floor(width))
  const indent = ' '.repeat(opts.indent ?? 0)
  const room = w - indent.length
  const data = rows.filter((r): r is string[] => typeof r !== 'string')
  const flexAt = Math.max(0, cols.findIndex(c => c.flex))
  const natural = (i: number) => Math.max(cols[i]!.header.length, ...data.map(r => (r[i] ?? '').length))
  const fixedWidth = (i: number) => Math.min(Math.max(natural(i), cols[i]!.min ?? 0), cols[i]!.max ?? Infinity)
  let use = cols.map((_, i) => i)
  const left = () => room - (use.length - 1) - use.filter(i => i !== flexAt).reduce((n, i) => n + fixedWidth(i), 0)
  const flexMin = cols[flexAt]?.min ?? 12
  while (left() < flexMin) {
    const gone = use.filter(i => i !== flexAt && cols[i]!.drop !== undefined).sort((a, b) => cols[a]!.drop! - cols[b]!.drop!)[0]
    if (gone === undefined) break
    use = use.filter(i => i !== gone)
  }
  const sizes = new Map(use.map(i => [i, i === flexAt ? Math.max(1, Math.min(fixedWidth(i), left())) : fixedWidth(i)]))
  const line = (cell: (i: number) => string): string =>
    (indent + use.map((i, k) => {
      const v = truncate(cell(i), sizes.get(i)!)
      return k === use.length - 1 && cols[i]!.align !== 'right' ? v : cols[i]!.align === 'right' ? v.padStart(sizes.get(i)!) : v.padEnd(sizes.get(i)!)
    }).join(' ')).trimEnd()

  const out = [line(i => cols[i]!.header)]
  let shown = 0
  let hidden = 0
  for (const r of rows) {
    if (typeof r === 'string') { if (opts.limit === undefined || shown < opts.limit) out.push('', indent + truncate(r, room)); continue }
    if (opts.limit !== undefined && shown >= opts.limit) { hidden++; continue }
    shown++
    out.push(line(i => r[i] ?? ''))
  }
  if (hidden > 0) out.push(indent + truncate(opts.more ? opts.more(hidden) : `+${hidden} more`, room))
  return out
}
