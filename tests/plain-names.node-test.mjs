// scripts/plain-names.mjs check 8 on a small hooks file in a scratch repo. The plugin test sandbox has no fs and
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
