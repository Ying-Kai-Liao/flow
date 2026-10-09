import { expect, test } from 'claude-code/testing'
import { register } from '../hooks/register'

// The engine compiles JSX with `h` as the factory (jsxFactory in .claude-plugin/types/tsconfig.json),
// so any scope that contains JSX and also binds `h` calls that binding instead of the factory:
// `list.map(h => <Text/>)` threw "h is not a function" on every pane draw once a PR was handed over.
// This is a source scan, not a parser: it masks comments and strings, finds each binding of `h`,
// works out the scope the binding covers and flags it when that scope holds JSX.

/** Blank comments, string and template text (keeping `${}` code) so brackets and `<` mean code only. */
function mask(src: string): string {
  const out = src.split('')
  const modes: string[] = ['code']
  const braces: number[] = [] // brace depth at each open `${`
  let depth = 0
  const blank = (i: number) => { if (out[i] !== '\n') out[i] = ' ' }
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!
    const mode = modes[modes.length - 1]!
    if (mode === 'code') {
      if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') blank(i++); i-- }
      else if (c === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2)
        const stop = end < 0 ? src.length : end + 2
        while (i < stop) blank(i++)
        i--
      } else if (c === "'" || c === '"') { modes.push(c); blank(i) }
      else if (c === '`') { modes.push('`'); blank(i) }
      else if (c === '{') depth++
      else if (c === '}') {
        if (braces.length > 0 && braces[braces.length - 1] === depth) { braces.pop(); modes.pop(); blank(i) } else depth--
      }
    } else if (mode === '`') {
      if (c === '\\') { blank(i); blank(i + 1); i++ }
      else if (c === '`') { modes.pop(); blank(i) }
      else if (c === '$' && src[i + 1] === '{') { blank(i); blank(i + 1); i++; braces.push(depth); modes.push('code') }
      else blank(i)
    } else {
      if (c === '\\') { blank(i); blank(i + 1); i++ }
      else if (c === mode) { modes.pop(); blank(i) }
      else blank(i)
    }
  }
  return out.join('')
}

const OPEN = '([{'
const CLOSE = ')]}'

function matchFwd(s: string, open: number): number {
  let d = 0
  for (let i = open; i < s.length; i++) {
    if (OPEN.includes(s[i]!)) d++
    else if (CLOSE.includes(s[i]!) && --d === 0) return i
  }
  return s.length - 1
}

function matchBack(s: string, close: number): number {
  let d = 0
  for (let i = close; i >= 0; i--) {
    if (CLOSE.includes(s[i]!)) d++
    else if (OPEN.includes(s[i]!) && --d === 0) return i
  }
  return 0
}

/** The innermost bracket pair around `at`, which for a declaration is the block it sits in. */
function enclosing(s: string, at: number): [number, number] {
  let d = 0
  for (let i = at; i >= 0; i--) {
    if (CLOSE.includes(s[i]!)) d++
    else if (OPEN.includes(s[i]!)) {
      if (d === 0) return [i, matchFwd(s, i)]
      d--
    }
  }
  return [0, s.length - 1]
}

/** Where the body of an arrow whose `=>` ends at `after` stops. */
function arrowEnd(s: string, after: number): number {
  let i = after
  while (/\s/.test(s[i] ?? '')) i++
  if (s[i] === '{') return matchFwd(s, i)
  let d = 0
  for (; i < s.length; i++) {
    const c = s[i]!
    if (OPEN.includes(c)) d++
    else if (CLOSE.includes(c)) { if (d === 0) return i; d-- }
    else if ((c === ',' || c === ';') && d === 0) return i
  }
  return s.length - 1
}

const HAS_H = /(^|[^\w$.])h(?![\w$])/

/** A top-level parameter binds `h` when its name part (before a type or default) does. */
function paramsBindH(params: string): boolean {
  const parts: string[] = []
  let d = 0
  let cur = ''
  for (const c of params) {
    if (OPEN.includes(c)) d++
    else if (CLOSE.includes(c)) d--
    if (c === ',' && d === 0) { parts.push(cur); cur = '' } else cur += c
  }
  parts.push(cur)
  return parts.some(p => {
    const t = p.trim()
    if (t.startsWith('{') || t.startsWith('[')) return HAS_H.test(t.replace(/[}\]]\s*:[\s\S]*$/, '}'))
    return /^(\.\.\.)?h(?![\w$])/.test(t)
  })
}

// Compiled JSX is a call of the factory, `h(Text, {...})`; a scope that binds `h` and calls it is the bug.
const JSX = /(^|[^\w$.])h\(/

type Hit = { line: number; text: string }

/** Bindings of `h` whose scope contains JSX. */
function shadowsOfFactory(src: string): Hit[] {
  const s = mask(src)
  const scopes: Array<[number, number, number]> = [] // [binding at, scope start, scope end]
  let m: RegExpExecArray | null

  // `h => ...`, `(a, h) => ...`, `async ({ h }) => ...`
  const arrows = /=>/g
  while ((m = arrows.exec(s)) !== null) {
    let j = m.index - 1
    while (j >= 0 && /\s/.test(s[j]!)) j--
    if (s[j] === ')') {
      const open = matchBack(s, j)
      if (paramsBindH(s.slice(open + 1, j))) scopes.push([open, open, arrowEnd(s, m.index + 2)])
    } else {
      const id = /([\w$]+)$/.exec(s.slice(Math.max(0, j - 40), j + 1))
      if (id?.[1] === 'h') scopes.push([j, j, arrowEnd(s, m.index + 2)])
    }
  }

  // `function name(h) { ... }`
  const fns = /\bfunction\b[^(]*\(/g
  while ((m = fns.exec(s)) !== null) {
    const open = m.index + m[0].length - 1
    const close = matchFwd(s, open)
    if (!paramsBindH(s.slice(open + 1, close))) continue
    const body = s.indexOf('{', close)
    if (body >= 0) scopes.push([open, open, matchFwd(s, body)])
  }

  // `const h`, `let { h }`, `var [h]`, `catch (h)`: the block they sit in.
  const decls = /\b(?:const|let|var)\s+([{[][^=;]*?[}\]]|[\w$]+)\s*[=:;]|\bcatch\s*\(\s*([\w$]+)/g
  while ((m = decls.exec(s)) !== null) {
    const names = m[1] ?? m[2] ?? ''
    if (!HAS_H.test(' ' + names)) continue
    const [a, b] = enclosing(s, m.index)
    scopes.push([m.index, a, b])
  }

  const hits: Hit[] = []
  for (const [at, a, b] of scopes) {
    if (!JSX.test(s.slice(a, b + 1))) continue
    const line = src.slice(0, at).split('\n').length
    hits.push({ line, text: src.split('\n')[line - 1]!.trim() })
  }
  return hits
}

test('the scan catches h bound in a scope that calls the factory', () => {
  const bad = [
    'const x = h(Box, null, prs.map((h) => h(Text, { key: h.pr }, h.title)))',
    'const x = rows.map((r, h) => h(Text, null, r))',
    'const x = rows.map(({ h }) => h(Text, null, h))',
    'function draw(h) { return h(Text, null, h); }',
    'function draw() { const h = 1; return h(Text, null, h); }',
    'function draw() { const { h } = o; return h(Fragment, null, h(Text, null)); }',
  ]
  for (const src of bad) expect(shadowsOfFactory(src).length).toBeGreaterThan(0)
})

test('the scan leaves h bindings alone where the factory is not called in their scope', () => {
  const fine = [
    'const t = list.filter((h) => h.ok).length;\nfunction draw(ho) { return h(Text, null, ho); }',
    'function f() { const h = 1; return h; }\nfunction g() { return h(Text, null, `${1 < 2}`); }',
    "const s = '(h) => h(Text)'; // (h) => h(Box)",
    'const ok = a < b && b > c, hh = (x) => x, n = heldBy(h2, t)',
  ]
  for (const src of fine) expect(shadowsOfFactory(src)).toEqual([])
})

test('no scope in the compiled pane that calls the JSX factory binds h', () => {
  // The test sandbox has no fs module; the compiled function keeps its parameter names
  // and its JSX shows as `h(Text, ...)`, which is what the engine runs.
  const src = String(register)
  expect(src).toContain('h(Text')
  expect(shadowsOfFactory(src).map(x => `${x.line}: ${x.text}`)).toEqual([])
})
