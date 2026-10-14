// scripts/plain-names.mjs checks 8 to 12 on a small hooks file in a scratch repo. The plugin test sandbox has no fs and
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

// A hooks file whose hook calls bigIoOf($, held) in place; bigIoOf has `members` members using $ and `extra` written in.
function setterFile(members, extra, held = '{}') {
  const body = Array.from({ length: members }, (_, i) => `    m${i}: () => help${i}($),`).join('\n')
  const helpers = Array.from({ length: members }, (_, i) => `function help${i}($: any) { return $.clock.now() }`).join('\n')
  return `${helpers}
let last: number | undefined
const memo = { last: undefined as number | undefined }
function setLast(x: number) { last = x }
function bigIoOf($: any, held: any) {
  return {
    ...held,
${body}
    ${extra}
  }
}
export default (on: any) => {
  let flag = false
  const state = { flag: () => flag, setFlag: () => { flag = true } }
  on('session.start', async ($: any, e: any) => bigIoOf($, ${held}))
}
`
}

test('check 10 flags a large io builder handing out a setter, written in it or spread in from an argument', () => {
  const own = run(setterFile(13, 'setLast: (x: number) => { last = x },'))
  assert.equal(own.status, 1)
  assert.match(own.out, /bigIoOf hands out a setter and has 13 members using \$ \(over 12\).*\(check 10\)/)
  const spread = run(setterFile(13, '', 'state'))
  assert.match(spread.out, /bigIoOf hands out a setter and has 13 members using \$.*\(check 10\)/)
})

test('check 10 passes a property write, a top-level function, and a small builder with a setter', () => {
  assert.equal(run(setterFile(13, 'setLast: (x: number) => { memo.last = x },')).status, 0)
  assert.equal(run(setterFile(13, 'setLast,')).status, 0)
  assert.equal(run(setterFile(12, 'setLast: (x: number) => { last = x },')).status, 0)
})

test('check 10 flags a builder reaching a setter builder through another function, and not the inner call', () => {
  const src = `let last: number | undefined
function releaseIoOf($: any) {
  return { now: () => $.clock.now(), setLast: (x: number) => { last = x } }
}
async function releaseRun($: any) {
  const io = releaseIoOf($)
  return io
}
function releaseCaseIoOf($: any) {
  return { release: () => releaseRun($) }
}
function runFlowTool($: any, tool: string) {
  switch (tool) {
    case 'release': return releaseCaseIoOf($)
    default: return releaseIoOf($)
  }
}
export default (on: any) => {
  on('tool.call', async ($: any, e: any) => runFlowTool($, e.tool))
}
`
  const r = run(src)
  assert.equal(r.status, 1)
  assert.equal((r.out.match(/\(check 10\)/g) ?? []).length, 1, r.out)
  assert.match(r.out, /register\.ts:14: releaseCaseIoOf reaches a builder that hands out a setter through another function/)
})

// A runFlowTool case calling a case io whose closure wraps a helper that builds another io from $ and `pass` (a
// helper parameter, or nothing).
function caseIoFile(pass) {
  return `function reviewerIoOf($: any, base?: string) {
  return { now: () => $.clock.now(), base: () => base }
}
async function reviewerRun($: any, settings: { base: string }) {
  const io = reviewerIoOf($${pass})
  return io
}
function reviewerCaseIoOf($: any) {
  return { reviewer: (settings: { base: string }) => reviewerRun($, settings) }
}
function runFlowTool($: any, tool: string) {
  switch (tool) {
    case 'reviewer': return reviewerCaseIoOf($)
    default: return undefined
  }
}
export default (on: any) => {
  on('tool.call', async ($: any, e: any) => runFlowTool($, e.tool))
}
`
}

test('check 11 flags a case io whose closure wraps a helper building an io from $ and its own parameter', () => {
  const r = run(caseIoFile(', settings.base'))
  assert.equal(r.status, 1)
  assert.equal((r.out.match(/\(check 11\)/g) ?? []).length, 1, r.out)
  assert.match(r.out, /register\.ts:13: reviewerCaseIoOf reaches an io through a closure calling reviewerRun, which builds reviewerIoOf/)
  // A helper building its io from $ alone (sessionTool, markNudged, paneDemoArm on 0.6.115) passes.
  assert.equal(run(caseIoFile('')).status, 0)
})

// A pane hook calling an io builder that spreads `lets` in; `lets` holds a setter when `setter` is set.
function spreadFile(members, setter) {
  const body = Array.from({ length: members }, (_, i) => `    m${i}: () => $.clock.now(),`).join('\n')
  return `const kept = { follow: 0 }
function paneIoOf($: any, lets: any) {
  return {
${body}
    ...lets,
  }
}
export default (on: any) => {
  const lets = { follow: () => kept.follow${setter ? ', setFollow: (f: number) => { kept.follow = f }' : ''} }
  on('ui.render', async ($: any, e: any) => paneIoOf($, lets))
}
`
}

test('check 11 flags a large io builder spreading in a parameter that holds a setter, property writes included', () => {
  const r = run(spreadFile(13, true))
  assert.equal(r.status, 1)
  assert.match(r.out, /paneIoOf spreads its parameter lets, which holds a setter, into an io with 13 members using \$ \(over 12\).*\(check 11\)/)
  // No setter in it (toolCallIoOf's held), or a small io (usageIoOf's mainHeld): passes.
  assert.equal(run(spreadFile(13, false)).status, 0)
  assert.equal(run(spreadFile(12, true)).status, 0)
})

// A runFlowTool case io whose member calls `helper`, the body of which is `body` (0.6.116's sessionWorktreeOf).
function chainFile(body) {
  return `function read($: any, key: string) { return $.state.get(key) }
async function sessionOfId($: any, id: string) {
  const all = await read($, 'sessions')
  return all[id]
}
async function helper($: any, id: string) {
${body}
}
function guardTestsCase(io: unknown) { return io }
function runFlowTool($: any, tool: string) {
  switch (tool) {
    case 'guard': {
      const io = {
        lookup: (id: string) => helper($, id),
        agents: () => $.agent.list(),
      }
      return guardTestsCase(io)
    }
    default: return undefined
  }
}
export default (on: any) => {
  on('tool.call', async ($: any, e: any) => runFlowTool($, e.tool))
}
`
}

test('check 12 flags a call passing $ to a helper that returns an optional chain on a value from $', () => {
  const r = run(chainFile('  const s = await sessionOfId($, id)\n  return s?.worktree'))
  assert.equal(r.status, 1)
  assert.equal((r.out.match(/\(check 12\)/g) ?? []).length, 1, r.out)
  assert.match(r.out, /register\.ts:15: helper returns an optional chain \(\?\.\) on a value from \$/)
  // On a $ call itself, too.
  assert.match(run(chainFile('  return (await $.session.usage())?.startedAt')).out, /\(check 12\)/)
})

test('check 12 passes a plain if before the read, the whole value returned, and [...] alone', () => {
  assert.equal(run(chainFile('  const s = await sessionOfId($, id)\n  if (s === undefined) return undefined\n  return s.worktree')).status, 0)
  assert.equal(run(chainFile('  return sessionOfId($, id)')).status, 0)
  // sessionOfId's own `all[id]` is not reported: 0.6.84 had `(await read($, x))[k]` and passed.
  assert.equal(run(chainFile('  const all = await read($, "sessions")\n  return all[id]')).status, 0)
})
