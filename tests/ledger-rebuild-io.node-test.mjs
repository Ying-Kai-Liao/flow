// The file-system part of scripts/ledger-rebuild.mjs. The plugin test sandbox cannot import node
// modules, so this runs under `node --test` (npm run check); the logic is in tests/ledger-rebuild.test.ts.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { discover, slugOf, writeLedger } from '../scripts/ledger-rebuild.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-rebuild-'))
const line = (id, input, at = 1_000_000) => JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), message: { id, model: 'claude-opus-5-5', content: [], usage: { input_tokens: input, output_tokens: 0 } } })

test('discover finds root sessions, subagent files by id (several files per id) and worktree slugs', () => {
  const base = tmp()
  const main = path.join(base, '-repo')
  for (const d of [path.join(main, 's1', 'subagents'), path.join(main, 's2', 'subagents'), path.join(base, '-repo--claude-worktrees-x', 's3', 'subagents'), path.join(base, '-other')]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(main, 's1.jsonl'), `${line('a', 1)}\n`)
  fs.writeFileSync(path.join(main, 's1', 'subagents', 'agent-aaa.jsonl'), `${line('b', 10)}\n`)
  fs.writeFileSync(path.join(main, 's2', 'subagents', 'agent-aaa.jsonl'), `${line('c', 100)}\n`)
  fs.writeFileSync(path.join(base, '-repo--claude-worktrees-x', 's3', 'subagents', 'agent-bbb.jsonl'), `${line('d', 1000)}\n`)
  fs.writeFileSync(path.join(base, '-other', 'agent-ccc.jsonl'), `${line('e', 1)}\n`)
  const found = discover(main)
  assert.equal(found.sessions.length, 1)
  assert.equal(found.sessions[0].first, 1_000_000)
  assert.deepEqual([...found.agents.keys()].sort(), ['aaa', 'bbb'])
  assert.equal(found.agentTexts('aaa').length, 2)
  assert.equal(found.agentTexts('zzz'), undefined)
})

test('--write backs up under a dated name, never overwrites a backup, and replaces the ledger atomically', () => {
  const dir = tmp()
  const file = path.join(dir, 'ledger.json')
  fs.writeFileSync(file, '{"old":1}\n')
  const b1 = writeLedger(file, { k: { name: 'w' } }, '2026-10-12')
  assert.equal(path.basename(b1), 'ledger-pre-rebuild-2026-10-12.json')
  assert.equal(fs.readFileSync(b1, 'utf8'), '{"old":1}\n')
  const b2 = writeLedger(file, { k2: {} }, '2026-10-12')
  assert.equal(path.basename(b2), 'ledger-pre-rebuild-2026-10-12-2.json')
  assert.equal(JSON.parse(fs.readFileSync(b2, 'utf8')).k.name, 'w')
  const written = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(written.k2, {})
  assert.match(written.__epoch, /^rebuild-/)
  // Every write is a new generation, so a running plugin drops its stale base.
  const before = written.__epoch
  writeLedger(file, { k2: {} }, '2026-10-13')
  assert.notEqual(JSON.parse(fs.readFileSync(file, 'utf8')).__epoch, before)
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')), [])
})

test('the slug rule is wake-cost.mjs\'s: / and . become -', () => {
  assert.equal(slugOf('/Users/Kath/Workspace/flow'), '-Users-Kath-Workspace-flow')
  assert.equal(slugOf('/a/b.c/.d'), '-a-b-c--d')
})

test('the CLI: a dry run writes nothing, --write rebuilds and backs up', () => {
  const base = tmp()
  const project = path.join(base, 'proj')
  fs.mkdirSync(path.join(project, 's', 'subagents'), { recursive: true })
  fs.writeFileSync(path.join(project, 's', 'subagents', 'agent-aaa.jsonl'), `${line('m', 7)}\n`)
  const file = path.join(base, 'ledger.json')
  const old = { aaa: { role: 'worker', name: 'w', models: { 'claude-opus-5-5': { input: 700, write5m: 0, write1h: 0, read: 0, output: 0 } }, firstAt: 1, lastAt: 2 }, gone: { role: 'worker', name: 'g', models: {} } }
  fs.writeFileSync(file, `${JSON.stringify(old, null, 2)}\n`)
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'ledger-rebuild.mjs')
  const dry = execFileSync('node', [script, '--ledger', file, '--project', project], { encoding: 'utf8', cwd: base })
  assert.match(dry, /Dry run/)
  assert.match(dry, /gone worker\/g: no transcript found/)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), old)
  assert.deepEqual(fs.readdirSync(base).sort(), ['ledger.json', 'proj'])
  execFileSync('node', [script, '--ledger', file, '--project', project, '--write'], { encoding: 'utf8', cwd: base })
  const now = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(now.aaa.models['claude-opus-5-5'].input, 7)
  assert.deepEqual(now.gone, old.gone)
  assert.deepEqual(Object.keys(now.aaa), ['role', 'name', 'models', 'firstAt', 'lastAt'])
  assert.equal(fs.readdirSync(base).filter(f => f.startsWith('ledger-pre-rebuild-')).length, 1)
})
