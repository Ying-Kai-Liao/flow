// The kit gives a test 5 s unless it passes its own timeoutMs, and under load that fails unrelated tests at random.
// tests/support.ts holds the 60 s floor, so a test file takes `test` from there and never straight from the kit.
// Runs under `node --test` (npm run check): the plugin test sandbox has no fs to list the test files.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))

// The names a value import from 'claude-code/testing' binds `test` to, `test as x` included; type imports are skipped.
function kitTestImports(src) {
  const found = []
  for (const m of src.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]claude-code\/testing['"]/g)) {
    if (m[1] !== undefined) continue
    for (const spec of m[2].split(',')) {
      const [name, alias] = spec.trim().split(/\s+as\s+/)
      if (name === 'test') found.push(alias ?? name)
    }
  }
  return found
}

test('the check finds test taken from the kit, renamed or on several lines, and passes the other kit imports', () => {
  assert.deepEqual(kitTestImports("import { expect, mock, test } from 'claude-code/testing'"), ['test'])
  assert.deepEqual(kitTestImports("import { test as kitTest } from 'claude-code/testing'"), ['kitTest'])
  assert.deepEqual(kitTestImports('import {\n  expect,\n  test,\n} from "claude-code/testing"'), ['test'])
  assert.deepEqual(kitTestImports("import { expect, mock } from 'claude-code/testing'\nimport { test } from './support'"), [])
  assert.deepEqual(kitTestImports("import type { TestBody } from 'claude-code/testing'"), [])
})

test('no test file takes test straight from the kit, so each one gets the 60 s floor', () => {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.ts') || f.endsWith('.test.tsx'))
  assert.ok(files.length > 0)
  const bad = files.filter(f => kitTestImports(fs.readFileSync(path.join(dir, f), 'utf8')).length > 0)
  assert.deepEqual(bad, [], `import test from './support' (timedTest as test for the floor alone) in: ${bad.join(', ')}`)
})
