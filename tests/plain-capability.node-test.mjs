import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

// The plugin loader (MOD_CAPABILITY_USE_NOT_PLAIN) refuses a hooks file where a call receiving `$` is wrapped,
// e.g. `return (await runFlowTool($, ...))!`. `claude plugin validate` does not load hooks, so it never
// noticed; this scan keeps the pattern out. Bind the result first, then `return out!`.
const WRAPPED = /\(\s*await\s+[\w.]+\(\s*\$\s*[,)][^\n]*\)\s*\)\s*!($|[^=])/

test('no call receiving $ is wrapped in parentheses and !', () => {
  const dir = new URL('../hooks/', import.meta.url)
  const bad = []
  for (const f of readdirSync(dir).filter(n => /\.tsx?$/.test(n))) {
    readFileSync(new URL(f, dir), 'utf8').split('\n').forEach((line, i) => { if (WRAPPED.test(line)) bad.push(`hooks/${f}:${i + 1}`) })
  }
  assert.deepEqual(bad, [])
})
