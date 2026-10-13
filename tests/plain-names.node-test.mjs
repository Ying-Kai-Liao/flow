// scripts/plain-names.mjs checks 8 and 9 on a small hooks file in a scratch repo. The plugin test sandbox has no fs and
// cannot run the script, so this runs under `node --test` (npm run check).
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../scripts/plain-names.mjs', import.meta.url))

// A hooks file whose runFlowTool switch calls `builder` from each of `cases`; the builder has `members` members using $.
function hooksFile(members, cases) {
  const body = Array.from({ length: members }, (_, i) => `    m${i}: () => help${i}($),`).join('\n')
  const helpers = Array.from({ length: members }, (_, i) => `function help${i}($: any) { return $.clock.now() }`).join('\n')
  const arms = cases.map(c => `    case '${c}': return use(bigIoOf($))`).join('\n')
  return `${helpers}
function use(io: unknown) { return io }
function bigIoOf($: any) {
  return {
${body}
  }
}
function runFlowTool($: any, tool: string) {
  switch (tool) {
${arms}
    default: return undefined
  }
}
export default (on: any) => {
  on('tool.call', async ($: any, e: any) => runFlowTool($, e.tool))
}
`
}

function run(src) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-names-'))
  fs.mkdirSync(path.join(dir, 'hooks'))
  fs.writeFileSync(path.join(dir, 'hooks', 'register.ts'), src)
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['add', '.'], { cwd: dir })
  const r = spawnSync('node', [script], { cwd: dir, encoding: 'utf8' })
  fs.rmSync(dir, { recursive: true, force: true })
  return { status: r.status, out: r.stderr }
}

test('check 8 flags an io builder with more than 12 $ members shared by two switch cases, at each call', () => {
  const r = run(hooksFile(13, ['a', 'b']))
  assert.equal(r.status, 1)
  assert.equal((r.out.match(/bigIoOf is one io shared by 2 switch cases with 13 members using \$/g) ?? []).length, 2)
})

test('check 8 passes 12 members shared by many cases, and a large io used by one case', () => {
  assert.equal(run(hooksFile(12, ['a', 'b', 'c', 'd'])).status, 0)
  assert.equal(run(hooksFile(20, ['a'])).status, 0)
})

// A hooks file whose tool.call hook reaches `body` through a declared function taking $.
function reached(body) {
  return `${body}
export default (on: any) => {
  on('tool.call', async ($: any, e: any) => use($, e.tool))
}
`
}

test('check 9 flags a $ call that is chained, in a ternary, wrapped by a call, under void or assigned to a let', () => {
  const shapes = [
    ['function use($: any, t: string) { return $.env.get(t).catch(() => undefined) }', 'is chained with .catch'],
    ['function use($: any, t: string) { return { exec: (cwd?: string) => cwd === undefined ? $.process.run([t]) : $.process.run([t], { cwd }) } }', 'is in a ternary'],
    ['async function use($: any, t: string) { return JSON.parse(await $.fs.read(t)) }', 'is an argument of another call'],
    ['function use($: any, t: string) { void $.prompt.submit({ text: t }) }', 'is under void'],
    ['async function use($: any, t: string) { let x = 0; x = await $.clock.now(); return x }', 'is an operand of ='],
    ['async function use($: any, t: string) { return (await $.agent.list()).find((a: any) => a.id === t) }', 'is parenthesized'],
    ['async function use($: any, t: string) { return `${await $.clock.now()}` }', 'is in a template'],
  ]
  for (const [src, why] of shapes) {
    const r = run(reached(src))
    assert.equal(r.status, 1, src)
    assert.match(r.out, new RegExp(`a \\$ call ${why.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*\\(check 9\\)`), src)
  }
})

test('check 9 follows $ into the functions a hook reaches, and flags a chained call passing $ and a const helper taking $', () => {
  const deep = run(reached('function inner($: any) { return $.clock.now().then((t: number) => t) }\nfunction use($: any, t: string) { return { now: () => inner($) } }'))
  assert.equal(deep.status, 1)
  assert.match(deep.out, /register\.ts:1: a \$ call is chained with \.then/)
  const passing = run(reached('function inner($: any) { return $.clock.now() }\nfunction use($: any, t: string) { return inner($).catch(() => 0) }'))
  assert.match(passing.out, /a call passing \$ is chained with \.catch/)
  const helper = run(reached('const now = ($: any) => $.clock.now()\nfunction use($: any, t: string) { return now($) }'))
  assert.match(helper.out, /a const helper takes \$: declare it with function/)
})

test('check 9 passes $ calls written as whole statements, return values, arrow bodies and consts', () => {
  const r = run(reached(`async function quiet($: any, key: string) {
  try {
    return await $.env.get(key)
  } catch {
    return undefined
  }
}
function execIn($: any, argv: string[], cwd?: string) {
  if (cwd === undefined) return $.process.run(argv)
  return $.process.run(argv, { cwd })
}
async function use($: any, t: string) {
  const text = await $.fs.read(t)
  $.ui.toast(text)
  await $.fs.write(t, text)
  return { exec: (cwd?: string) => execIn($, [t], cwd), env: () => quiet($, t), now: () => $.clock.now(), parsed: JSON.parse(text) }
}`))
  assert.equal(r.status, 0, r.out)
})
