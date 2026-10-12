// Markdown for the Flow pane: the free text of questions, decisions, PR cards and reports, drawn with the
// pane's own Text elements. A small in-repo parser (the plugin has no dependencies) that never drops
// content: anything it does not understand comes through as its literal characters.
//
// Everything is worked out as `Line`s (rows of styled spans, already wrapped to the width), so a caller
// that has to count or slice rows (the PR card's "+N more lines") counts what is really drawn. The
// element helpers at the bottom only turn Lines into Text. Pure and cheap: results are cached per text
// and width.
import type { Els } from './pane-view'

// One run of text with one style. `color` is a theme name.
export type Span = { t: string; bold?: true; italic?: true; under?: true; strike?: true; dim?: true; color?: string }
export type Line = Span[]

const CODE_COLOR = 'suggestion'
const BULLETS = ['•', '◦']
const BAR = '│'
const RULE = '─'

const len = (s: string): number => [...s].length
const lineLen = (l: Line): number => l.reduce((n, s) => n + len(s.t), 0)
const sameStyle = (a: Span, b: Span): boolean => a.bold === b.bold && a.italic === b.italic && a.under === b.under && a.strike === b.strike && a.dim === b.dim && a.color === b.color
const styleOf = (s: Span): Omit<Span, 't'> => { const { t: _t, ...rest } = s; return rest }

// ---- inline: `code`, **bold**, *italic*, ~~strike~~, [text](url), bare and <autolinked> urls ----

const PUNCT = /[!-/:-@[-`{-~]/
const isAlnum = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c)
const isSpace = (c: string | undefined): boolean => c === undefined || /\s/.test(c)

function add(out: Span[], t: string, st: Omit<Span, 't'>): void {
  if (t === '') return
  const last = out[out.length - 1]
  if (last !== undefined && sameStyle(last, { t, ...st })) last.t += t
  else out.push({ t, ...st })
}

// The end of the backtick run that closes the one opening at `from` (its length n), or -1.
function codeEnd(s: string, from: number, n: number): number {
  const mark = '`'.repeat(n)
  let j = from + n
  for (;;) {
    const k = s.indexOf(mark, j)
    if (k < 0) return -1
    let e = k
    while (s[e] === '`') e++
    if (e - k === n) return k
    j = e
  }
}

// The ']' closing the '[' at i, then the ')' closing a '(' straight after it.
function linkAt(s: string, i: number): { text: string; url: string; end: number } | undefined {
  let depth = 0
  let k = i
  for (; k < s.length; k++) {
    if (s[k] === '\\') { k++; continue }
    if (s[k] === '[') depth++
    else if (s[k] === ']' && --depth === 0) break
  }
  if (k >= s.length || s[k + 1] !== '(') return undefined
  let d = 0
  let e = k + 1
  for (; e < s.length; e++) {
    if (s[e] === '\\') { e++; continue }
    if (s[e] === '(') d++
    else if (s[e] === ')' && --d === 0) break
  }
  if (e >= s.length) return undefined
  const url = s.slice(k + 2, e).trim().split(/\s+/)[0]?.replace(/^<|>$/g, '') ?? ''
  if (url === '') return undefined
  return { text: s.slice(i + 1, k), url, end: e + 1 }
}

// A closing delimiter run for an opener of n characters at i, or undefined. `_` follows the intraword rule
// (snake_case stays as it is); a closer is never preceded by a space.
function closerOf(s: string, c: string, n: number, from: number): { at: number; end: number } | undefined {
  let j = from
  while (j < s.length) {
    const k = s.indexOf(c, j)
    if (k < 0) return undefined
    if (s[k - 1] === '\\') { j = k + 1; continue }
    let e = k
    while (s[e] === c) e++
    const run = e - k
    const ok = !isSpace(s[k - 1]) && (n >= 2 ? run >= n : run === 1) && (c !== '_' || !isAlnum(s[e]))
    if (ok) return { at: e - n, end: e }
    j = e
  }
  return undefined
}

function walk(s: string, st: Omit<Span, 't'>, out: Span[]): void {
  let buf = ''
  const flush = () => { add(out, buf, st); buf = '' }
  let i = 0
  while (i < s.length) {
    const c = s[i]!
    if (c === '\\' && i + 1 < s.length && PUNCT.test(s[i + 1]!)) { buf += s[i + 1]; i += 2; continue }
    if (c === '`') {
      let n = 1
      while (s[i + n] === '`') n++
      const k = codeEnd(s, i, n)
      if (k < 0) { buf += '`'.repeat(n); i += n; continue }
      flush()
      let inner = s.slice(i + n, k).replace(/\n/g, ' ')
      if (inner.length > 2 && inner.startsWith(' ') && inner.endsWith(' ') && inner.trim() !== '') inner = inner.slice(1, -1)
      add(out, inner, { ...st, color: CODE_COLOR })
      i = k + n
      continue
    }
    if (c === 'h' && !isAlnum(s[i - 1]) && /^https?:\/\//.test(s.slice(i, i + 8))) {
      // A bare url is taken whole, so its `_` and `*` are never markup.
      let url = /^\S+/.exec(s.slice(i))![0]
      url = url.replace(/[*_~.,;:!?'"\]>]+$/, '')
      while (url.endsWith(')') && url.split(')').length > url.split('(').length) url = url.slice(0, -1)
      buf += url
      i += url.length
      continue
    }
    if (c === '<') {
      const m = /^<(https?:\/\/[^\s>]+)>/.exec(s.slice(i))
      if (m !== null) { buf += m[1]; i += m[0].length; continue }
    }
    if (c === '[') {
      const l = linkAt(s, i)
      if (l !== undefined) {
        flush()
        walk(l.text, { ...st, under: true }, out)
        if (l.url !== l.text.trim()) add(out, ` (${l.url})`, { ...st, dim: true })
        i = l.end
        continue
      }
    }
    if (c === '*' || c === '_' || (c === '~' && s[i + 1] === '~')) {
      let run = 0
      while (s[i + run] === c) run++
      const n = c === '~' ? 2 : Math.min(run, 3)
      const openOk = run <= 3 && !isSpace(s[i + run]) && (c !== '_' || !isAlnum(s[i - 1])) && (c !== '~' || run === 2)
      const close = openOk ? closerOf(s, c, n, i + run) : undefined
      if (close === undefined) { buf += c.repeat(run); i += run; continue }
      flush()
      const inner = s.slice(i + run, close.at)
      const next = c === '~' ? { ...st, strike: true as const } : { ...st, ...(n >= 2 ? { bold: true as const } : {}), ...(n === 1 || n === 3 ? { italic: true as const } : {}) }
      walk(inner, next, out)
      i = close.end
      continue
    }
    buf += c
    i++
  }
  flush()
}

export function parseInline(s: string): Span[] {
  const out: Span[] = []
  walk(s, {}, out)
  return out
}

// ---- blocks ----

type Align = 'left' | 'right' | 'center'
type Body =
  | { k: 'p'; lines: string[] }
  | { k: 'h'; level: number; text: string }
  | { k: 'code'; lines: string[] }
  | { k: 'hr' }
  | { k: 'quote'; inner: string[] }
  | { k: 'list'; items: { depth: number; marker: string; text: string }[] }
  | { k: 'table'; head: string[]; align: Align[]; rows: string[][] }
type Block = Body & { gap: boolean }

const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/
const HEADING = /^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/
const QUOTE = /^ {0,3}>\s?(.*)$/
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

function cellsOf(line: string): string[] {
  let t = line.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && t[i + 1] === '|') { cur += '|'; i++ }
    else if (t[i] === '|') { cells.push(cur.trim()); cur = '' }
    else cur += t[i]
  }
  cells.push(cur.trim())
  return cells
}

const startsTable = (lines: string[], i: number): boolean =>
  lines[i]!.includes('|') && i + 1 < lines.length && lines[i + 1]!.includes('-') && DELIM.test(lines[i + 1]!) && cellsOf(lines[i]!).length === cellsOf(lines[i + 1]!).length

// Whether a line starts a block of its own (so a paragraph stops before it).
const startsBlock = (lines: string[], i: number): boolean => {
  const l = lines[i]!
  return FENCE.test(l) || HEADING.test(l) || HR.test(l) || QUOTE.test(l) || ITEM.test(l) || startsTable(lines, i)
}

export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')
  const blocks: Block[] = []
  let gap = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.trim() === '') { gap = true; i++; continue }
    const push = (b: Body) => { blocks.push({ ...b, gap }); gap = false }
    const fence = FENCE.exec(line)
    if (fence !== null && !(fence[2]![0] === '`' && fence[3]!.includes('`'))) {
      const indent = fence[1]!.length
      const close = new RegExp(`^\\s*${fence[2]![0] === '`' ? '`' : '~'}{${fence[2]!.length},}\\s*$`)
      const body: string[] = []
      i++
      // An unclosed fence runs to the end: the text is kept.
      while (i < lines.length && !close.test(lines[i]!)) { body.push(lines[i]!.replace(new RegExp(`^ {0,${indent}}`), '')); i++ }
      i++
      push({ k: 'code', lines: body })
      continue
    }
    const hd = HEADING.exec(line)
    if (hd !== null) { push({ k: 'h', level: hd[1]!.length, text: hd[2]! }); i++; continue }
    if (HR.test(line)) { push({ k: 'hr' }); i++; continue }
    if (QUOTE.test(line)) {
      const inner: string[] = []
      while (i < lines.length && QUOTE.test(lines[i]!)) { inner.push(QUOTE.exec(lines[i]!)![1]!); i++ }
      push({ k: 'quote', inner })
      continue
    }
    if (startsTable(lines, i)) {
      const head = cellsOf(line)
      const align = cellsOf(lines[i + 1]!).map((c): Align => c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left')
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i]!.trim() !== '' && lines[i]!.includes('|')) {
        const r = cellsOf(lines[i]!)
        rows.push(head.map((_, k) => r[k] ?? ''))
        i++
      }
      push({ k: 'table', head, align, rows })
      continue
    }
    if (ITEM.test(line)) {
      const items: { depth: number; marker: string; text: string }[] = []
      const stack: number[] = []
      while (i < lines.length) {
        const l = lines[i]!
        const m = ITEM.exec(l)
        if (m !== null && !HR.test(l)) {
          const indent = m[1]!.length
          if (stack.length === 0 || indent > stack[stack.length - 1]!) stack.push(indent)
          else while (stack.length > 1 && stack[stack.length - 2]! >= indent) stack.pop()
          items.push({ depth: stack.length - 1, marker: m[2]!, text: m[3]!.trim() })
          i++
        } else if (l.trim() === '') {
          let k = i
          while (k < lines.length && lines[k]!.trim() === '') k++
          // A list goes on past a blank line when an item or an indented paragraph follows.
          if (k < lines.length && ((ITEM.test(lines[k]!) && !HR.test(lines[k]!)) || /^ {2,}\S/.test(lines[k]!)) && !FENCE.test(lines[k]!)) {
            if (!ITEM.test(lines[k]!)) items[items.length - 1]!.text += `\n${lines[k]!.trim()}`
            i = k + (ITEM.test(lines[k]!) ? 0 : 1)
          } else break
        } else if (FENCE.test(l) || (!/^\s/.test(l) && startsBlock(lines, i))) break
        else { items[items.length - 1]!.text += `\n${l.trim()}`; i++ }
      }
      push({ k: 'list', items })
      continue
    }
    if (/^ {4}/.test(line)) {
      const body: string[] = []
      while (i < lines.length && (/^ {4}/.test(lines[i]!) || (lines[i]!.trim() === '' && i + 1 < lines.length && /^ {4}/.test(lines[i + 1]!)))) { body.push(lines[i]!.slice(4)); i++ }
      push({ k: 'code', lines: body })
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i]!.trim() !== '' && (para.length === 0 || !startsBlock(lines, i))) { para.push(lines[i]!.trim()); i++ }
    push({ k: 'p', lines: para })
  }
  return blocks
}

// ---- layout: spans to wrapped Lines ----

type Word = { parts: Span[]; n: number; space: boolean }

// A word cut into pieces of at most `n` columns, styles kept.
function pieces(w: Word, n: number): Word[] {
  if (w.n <= n) return [w]
  const out: Word[] = []
  let cur: Word = { parts: [], n: 0, space: w.space }
  for (const p of w.parts) {
    let rest = [...p.t]
    while (rest.length > 0) {
      const take = rest.slice(0, n - cur.n)
      cur.parts.push({ ...p, t: take.join('') })
      cur.n += take.length
      rest = rest.slice(take.length)
      if (cur.n >= n) { out.push(cur); cur = { parts: [], n: 0, space: false } }
    }
  }
  if (cur.n > 0) out.push(cur)
  return out
}

// Greedy word wrap to `width` columns. The first line starts with `first`, the others with `rest`
// (plain text of equal or other width); a word longer than a line is cut. Leading blanks of the text are kept.
function wrap(spans: Span[], width: number, first: Span[], rest: Span[]): Line[] {
  const words: Word[] = []
  let cur: Word | undefined
  let space = false
  let lead = ''
  for (const sp of spans) {
    for (const m of sp.t.matchAll(/(\s+)|(\S+)/g)) {
      if (m[1] !== undefined) {
        if (words.length === 0 && cur === undefined) lead += m[1]
        else { cur = undefined; space = true }
      } else {
        if (cur === undefined) { cur = { parts: [], n: 0, space }; words.push(cur); space = false }
        cur.parts.push({ ...styleOf(sp), t: m[2]! })
        cur.n += len(m[2]!)
      }
    }
  }
  const out: Line[] = []
  let line: Line = [...first]
  if (lead !== '') line.push({ t: lead })
  let col = lineLen(line)
  let any = false
  const restLen = lineLen(rest)
  for (const w of words) {
    for (const [pi, p] of pieces(w, Math.max(1, width - restLen)).entries()) {
      const need = (any && pi === 0 && w.space ? 1 : 0) + p.n
      if (col + need > width && any) {
        out.push(line)
        line = [...rest]
        col = restLen
        any = false
      }
      const gapSp = any && pi === 0 && w.space
      if (gapSp) { line.push({ t: ' ' }); col++ }
      line.push(...p.parts)
      col += p.n
      any = true
    }
  }
  out.push(line)
  return out.map(l => mergeSpans(l))
}

function mergeSpans(l: Line): Line {
  const out: Line = []
  for (const s of l) {
    const last = out[out.length - 1]
    if (last !== undefined && sameStyle(last, s)) out[out.length - 1] = { ...last, t: last.t + s.t }
    else if (s.t !== '') out.push(s)
  }
  return out
}

const withStyle = (spans: Span[], st: Omit<Span, 't'>): Span[] => spans.map(s => ({ ...s, ...st }))
const plainSpan = (t: string, st: Omit<Span, 't'> = {}): Span => ({ t, ...st })

type Ctx = { lead?: Span; tail?: Span; hang: string; used: boolean }

function layoutTable(b: Extract<Block, { k: 'table' }>, width: number): Line[] {
  const head = b.head.map(c => parseInline(c))
  const rows = b.rows.map(r => r.map(c => parseInline(c)))
  const w = b.head.map((_, k) => Math.max(lineLen(head[k]!), ...rows.map(r => lineLen(r[k]!))))
  const total = w.reduce((a, n) => a + n, 0) + 3 * (w.length - 1)
  if (total <= width) {
    const cell = (spans: Span[], k: number, st: Omit<Span, 't'>): Span[] => {
      const pad = w[k]! - lineLen(spans)
      const left = b.align[k] === 'right' ? pad : b.align[k] === 'center' ? Math.floor(pad / 2) : 0
      return [plainSpan(' '.repeat(left)), ...withStyle(spans, st), plainSpan(' '.repeat(pad - left))]
    }
    const join = (cells: Span[][], sep: string): Line => mergeSpans(cells.flatMap((c, k) => (k === 0 ? c : [plainSpan(sep, { dim: true }), ...c])))
    const trim = (l: Line): Line => {
      const last = l[l.length - 1]
      if (last === undefined) return l
      const t = last.t.trimEnd()
      return t === '' ? trim(l.slice(0, -1)) : [...l.slice(0, -1), { ...last, t }]
    }
    return [
      trim(join(head.map((c, k) => cell(c, k, { bold: true })), ` ${BAR} `)),
      [plainSpan(w.map(n => RULE.repeat(n)).join(`${RULE}┼${RULE}`), { dim: true })],
      ...rows.map(r => trim(join(r.map((c, k) => cell(c, k, {})), ` ${BAR} `))),
    ]
  }
  // Too wide: each row as "header: value" lines, a blank line between rows.
  const out: Line[] = []
  rows.forEach((r, ri) => {
    if (ri > 0) out.push([])
    r.forEach((c, k) => {
      const label = `${b.head[k]!}: `
      out.push(...wrap([plainSpan(label, { dim: true }), ...c], width, [], [plainSpan('  ')]))
    })
  })
  return out
}

function layout(blocks: Block[], width: number, ctx: Ctx): Line[] {
  const out: Line[] = []
  // The lead span opens the first paragraph or heading; any other block gets it on a line of its own.
  const takeLead = (): Span[] => {
    if (ctx.lead === undefined || ctx.used) return []
    ctx.used = true
    return [ctx.lead]
  }
  blocks.forEach((b, bi) => {
    if (bi > 0 && b.gap) out.push([])
    if (bi === 0 && ctx.lead !== undefined && !['p', 'h'].includes(b.k)) { out.push([ctx.lead]); ctx.used = true }
    const hang = [plainSpan(ctx.hang)]
    switch (b.k) {
      case 'p':
        b.lines.forEach(l => out.push(...wrap([...takeLead(), ...parseInline(l)], width, [], hang)))
        break
      case 'h':
        out.push(...wrap([...takeLead(), ...withStyle(parseInline(b.text), b.level === 1 ? { bold: true, under: true } : { bold: true })], width, [], hang))
        break
      case 'code': {
        const room = Math.max(1, width - 2)
        for (const l of b.lines) {
          const chunks = l === '' ? [''] : [...pieces({ parts: [{ t: l }], n: len(l), space: false }, room)].map(p => p.parts.map(x => x.t).join(''))
          chunks.forEach(c => out.push([plainSpan('  '), plainSpan(c, { color: CODE_COLOR })]))
        }
        break
      }
      case 'hr':
        out.push([plainSpan(RULE.repeat(Math.max(1, Math.min(width, 60))), { dim: true })])
        break
      case 'quote':
        for (const l of layout(parseBlocks(b.inner.join('\n')), Math.max(4, width - 2), { hang: '', used: true })) out.push([plainSpan(`${BAR} `, { dim: true }), ...l])
        break
      case 'list':
        b.items.forEach((it, k) => {
          const ordered = /\d/.test(it.marker)
          const mark = ordered ? it.marker : BULLETS[Math.min(it.depth, BULLETS.length - 1)]!
          const prefix = `${'  '.repeat(it.depth)}${mark} `
          // Beyond a third of the width the nesting stops indenting, so the text keeps room.
          const pre = len(prefix) > Math.floor(width / 3) ? `${mark} ` : prefix
          const rest = [plainSpan(' '.repeat(len(pre)))]
          it.text.split('\n').forEach((l, li) => {
            out.push(...wrap([...parseInline(l)], width, li === 0 ? [plainSpan(pre)] : rest, rest))
          })
        })
        break
      case 'table':
        out.push(...layoutTable(b, width))
        break
    }
  })
  return out
}

const CACHE = new Map<string, Line[]>()

// The markdown as wrapped rows of at most `width` columns. `lead` is a span put in front of the first
// paragraph (a "why: " label); `tail` is put after the last line; `hang` indents the continuation lines of a
// paragraph that has a lead. Empty or blank text gives no rows.
export function mdLines(text: string, width: number, o: { lead?: Span; tail?: Span; hang?: number } = {}): Line[] {
  const w = Math.max(8, Math.floor(width))
  const key = `${w}\u0000${o.hang ?? 0}\u0000${JSON.stringify(o.lead ?? '')}\u0000${JSON.stringify(o.tail ?? '')}\u0000${text}`
  const hit = CACHE.get(key)
  if (hit !== undefined) return hit
  const ctx: Ctx = { ...o, hang: ' '.repeat(o.hang ?? 0), used: false }
  const blocks = parseBlocks(text)
  let lines = layout(blocks, w, ctx)
  if (blocks.length === 0 && o.lead !== undefined) lines = [[o.lead]]
  if (o.tail !== undefined && lines.length > 0) {
    const last = lines[lines.length - 1]!
    if (lineLen(last) + len(o.tail.t) <= w) lines = [...lines.slice(0, -1), [...last, o.tail]]
    else lines = [...lines, [plainSpan(ctx.hang), o.tail]]
  }
  if (CACHE.size > 300) CACHE.clear()
  CACHE.set(key, lines)
  return lines
}

// The text on one line, every block flattened and the markers dropped (bold, code and the rest keep their
// style): for the one-row places (a collapsed list row, a title).
export function mdFlat(text: string): Span[] {
  const rows = mdLines(text, 100_000).filter(l => l.length > 0)
  const out: Span[] = []
  rows.forEach((l, i) => {
    if (i > 0) out.push({ t: ' ' })
    out.push(...l)
  })
  // Blank-leading indents and runs of blanks fold to one space, as fit() does.
  return mergeSpans(out.map(s => ({ ...s, t: s.t.replace(/\s+/g, ' ') }))).map((s, i, all) => (i === 0 ? { ...s, t: s.t.trimStart() } : i === all.length - 1 ? { ...s, t: s.t.trimEnd() } : s))
}

// The same cut to at most `max` columns, ending in "…" when something was cut.
export function mdFit(text: string, max: number): Span[] {
  const spans = mdFlat(text)
  const total = lineLen(spans)
  const room = Math.max(1, max)
  if (total <= room) return spans
  const out: Span[] = []
  let left = room - 1
  for (const s of spans) {
    if (left <= 0) break
    const t = [...s.t].slice(0, left).join('')
    left -= len(t)
    out.push({ ...s, t })
  }
  const last = out[out.length - 1]
  if (last !== undefined) last.t = last.t.trimEnd()
  out.push({ t: '…' })
  return out
}

// The plain string of mdFlat (or cut to `max`): for places that build text from strings.
export function mdPlain(text: string, max?: number): string {
  return (max === undefined ? mdFlat(text) : mdFit(text, max)).map(s => s.t).join('')
}

// At most `max` rows: when some do not fit, the last shown one is replaced by "+N more lines".
export function cutLines(lines: Line[], max: number): Line[] {
  if (lines.length <= max) return lines
  const keep = Math.max(0, max - 1)
  return [...lines.slice(0, keep), [plainSpan(`+${lines.length - keep} more lines`, { dim: true })]]
}

// At most `max` rows, the last shown one ending in "…" when some were left out: for a card with a fixed height.
export function clipLines(lines: Line[], max: number, width: number): Line[] {
  if (lines.length <= max) return lines
  const keep = lines.slice(0, Math.max(1, max))
  const last = keep[keep.length - 1]!
  const room = Math.max(1, width - 1)
  const spans: Span[] = []
  let left = room
  for (const sp of last) {
    if (left <= 0) break
    const t = [...sp.t].slice(0, left).join('')
    left -= len(t)
    spans.push({ ...sp, t })
  }
  if (spans.length > 0) spans[spans.length - 1]!.t = spans[spans.length - 1]!.t.trimEnd()
  return [...keep.slice(0, -1), [...spans, { t: '…' }]]
}

// ---- elements ----

type TextEl = Els['Text']

export function spansEl(Text: TextEl, spans: Span[], key: string, base: Omit<Span, 't'> = {}, wrapMode?: 'truncate-end') {
  const kids = spans.length === 0 ? ' ' : undefined
  return (
    <Text key={key} bold={base.bold} dimColor={base.dim} color={base.color} wrap={wrapMode}>
      {kids}
      {spans.map((s, i) => (
        <Text key={`${key}-${i}`} bold={s.bold ?? base.bold} italic={s.italic} underline={s.under} strikethrough={s.strike} dimColor={s.dim ?? base.dim} color={s.color ?? base.color}>{s.t}</Text>
      ))}
    </Text>
  )
}

// One row of the pane per Line.
export function linesEl(Text: TextEl, lines: Line[], key: string, base: Omit<Span, 't'> = {}) {
  return lines.map((l, i) => spansEl(Text, l, `${key}-${i}`, base))
}

// A one-row inline form of the markdown: a Text to put among other Text (it cuts to `max` when given).
export function inlineEl(Text: TextEl, text: string, key: string, max?: number, base: Omit<Span, 't'> = {}) {
  const spans = max === undefined ? mdFlat(text) : mdFit(text, max)
  return (
    <Text key={key} bold={base.bold} dimColor={base.dim} color={base.color}>
      {spans.map((s, i) => (
        <Text key={`${key}-${i}`} bold={s.bold ?? base.bold} italic={s.italic} underline={s.under} strikethrough={s.strike} dimColor={s.dim ?? base.dim} color={s.color ?? base.color}>{s.t}</Text>
      ))}
    </Text>
  )
}

// The rows of a PR card row: its text, with the part in `md` ([from, to) offsets) read as markdown and the rest
// kept literal; the row's own style applies to every span. A row without `md` is one literal row.
export type MdRow = { text: string; md?: readonly [number, number] }
export function rowLines(r: MdRow, width: number): Line[] {
  if (r.md === undefined) return [r.text === '' ? [] : [plainSpan(r.text)]]
  const [from, to] = r.md
  const lead = r.text.slice(0, from)
  const tail = r.text.slice(to)
  const indent = /^\s*/.exec(lead)![0].length + 2
  return mdLines(r.text.slice(from, to), width, {
    ...(lead === '' ? {} : { lead: plainSpan(lead) }),
    ...(tail === '' ? {} : { tail: plainSpan(tail) }),
    hang: Math.min(indent, 6),
  })
}
