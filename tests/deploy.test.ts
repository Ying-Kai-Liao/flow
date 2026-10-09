import { expect, test } from 'claude-code/testing'
import { deployTargetsOf, fill, QUEUE_PROMPT, stateFileOf, WORKER_PROMPT } from '../hooks/prompts'
import type { Settings } from '../hooks/prompts'

const BASE: Settings = {
  base: 'main', testCommand: '', fullCheck: '', deployCommand: '', deployTargets: [], stateFile: undefined,
  mergeMethod: 'squash', useQueue: true, maxWorkers: 3, workerModel: 'sonnet',
}

const TWO = deployTargetsOf([
  { name: 'demo', deploy: ['./deploy demo'], health_url: 'https://demo.example/health' },
  { name: 'production', backup: ['./backup'], deploy: ['./deploy a', './deploy b'], verify: ['look at the dashboard'] },
])

test('deployTargetsOf keeps valid entries and drops invalid ones', () => {
  expect(deployTargetsOf([
    { name: 'demo', deploy: ['x'] },
    { name: '', deploy: ['x'] },
    { name: 'nodeploy' },
    { name: 'bad', deploy: [1] },
    'text',
    { name: 'full', backup: ['b'], deploy: 'd', health_url: ' http://h ', verify: ['v'] },
  ])).toEqual([
    { name: 'demo', backup: [], deploy: ['x'], verify: [] },
    { name: 'full', backup: ['b'], deploy: ['d'], healthUrl: 'http://h', verify: ['v'] },
  ])
})

test('deployTargetsOf accepts a JSON string and rejects junk', () => {
  expect(deployTargetsOf('[{"name":"a","deploy":["x"]}]')).toHaveLength(1)
  expect(deployTargetsOf('not json')).toEqual([])
  expect(deployTargetsOf(undefined)).toEqual([])
  expect(deployTargetsOf({ name: 'a', deploy: ['x'] })).toEqual([])
})

test('stateFileOf takes a path or an object, with defaults', () => {
  expect(stateFileOf('NOW.md')).toEqual({ path: 'NOW.md', keep: 10, archive: 'NOW-archive.md' })
  expect(stateFileOf({ path: 'docs/STATE.md', keep: 3, archive: 'old.md' })).toEqual({ path: 'docs/STATE.md', keep: 3, archive: 'old.md' })
  expect(stateFileOf('{"path":"NOW.md"}')?.keep).toBe(10)
  expect(stateFileOf('')).toBeUndefined()
  expect(stateFileOf(undefined)).toBeUndefined()
})

test('no targets and no deploy_command: no deploy, never guessed', () => {
  expect(fill('{{DEPLOY}}', BASE)).toContain('none configured: no deploy; never guess a deploy command')
})

test('a deploy_command alone is one target named default', () => {
  const out = fill('{{DEPLOY}}', { ...BASE, deployCommand: 'make ship' })
  expect(out).toContain('Target "default"')
  expect(out).toContain('`make ship`')
  expect(out).not.toContain('Backup,')
  expect(out).not.toContain('Health:')
})

test('two targets render in order with backup, health and verify only where set', () => {
  const out = fill('{{DEPLOY}}', { ...BASE, deployTargets: TWO })
  expect(out.indexOf('Target "demo"')).toBeLessThan(out.indexOf('Target "production"'))
  expect(out).toContain('Stop at the first target that fails')
  expect(out).toContain('https://demo.example/health')
  expect(out).toContain('`./backup`')
  expect(out).toContain('`./deploy a`, then `./deploy b`')
  expect(out).toContain('look at the dashboard')
  expect(out.match(/Health:/g)).toHaveLength(1)
  expect(out.match(/Backup,/g)).toHaveLength(1)
  expect(out).toContain('not "back"')
})

test('deploy_targets win over deploy_command', () => {
  const out = fill('{{DEPLOY}}', { ...BASE, deployCommand: 'make ship', deployTargets: TWO })
  expect(out).not.toContain('make ship')
})

test('the status file lines appear only when state_file is set', () => {
  const off = fill(QUEUE_PROMPT, BASE)
  expect(off).not.toContain('Status file')
  expect(fill(WORKER_PROMPT, BASE)).not.toContain('Never edit the status file')
  const s = { ...BASE, stateFile: stateFileOf({ path: 'NOW.md', keep: 5 }) }
  const on = fill(QUEUE_PROMPT, s)
  expect(on).toContain('Status file `NOW.md`')
  expect(on).toContain('more than 5 entries')
  expect(on).toContain('NOW-archive.md')
  expect(on).toContain('git push origin HEAD:main')
  expect(fill(WORKER_PROMPT, s)).toContain('Never edit the status file `NOW.md`')
})

test('the queue acts on after_deploy and pending; workers know check-only briefs', () => {
  const q = fill(QUEUE_PROMPT, BASE)
  expect(q).toContain('<your name>-verify-<pr>')
  expect(q).toContain('needs a person: PR #<n>')
  expect(q).toContain('pending decisions: PR #<n>')
  expect(q).toContain('SendMessage the same line to main')
  expect(q).toContain('SendMessage each such line to main')
  const w = fill(WORKER_PROMPT, BASE)
  expect(w).toContain('"Check only:"')
  expect(w.indexOf('"Check only:"')).toBeLessThan(w.indexOf('Before you touch anything'))
})
