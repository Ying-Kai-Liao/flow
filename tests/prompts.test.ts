import { expect } from 'claude-code/testing'
import { test } from './support'

import { fill, MANAGER_PROMPT, NO_QUEUE_RULE, QUEUE_PROMPT, QUEUE_RULE, WORKER_PROMPT } from '../hooks/prompts'
import type { Settings } from '../hooks/prompts'

const base: Settings = {
  base: 'main', testCommand: 'npm test', fullCheck: '', deployCommand: '', deployTargets: [], stateFile: undefined,
  mergeMethod: 'merge', mergeMode: 'auto', useQueue: true, maxWorkers: 3, testSlots: 1, workerModel: 'sonnet', managerModel: 'opus', queueModel: 'opus',
  language: 'English', bigFiles: [], bigFileLines: 1500, migrationsDir: '', decisionPhrases: [], workerChecks: [], alwaysTests: [],
}
const all = (s: Settings) => [WORKER_PROMPT, MANAGER_PROMPT.replace('{{QUEUE_RULE}}', QUEUE_RULE), QUEUE_PROMPT].map((p) => fill(p, s))

test('the defaults leave no slot, no empty bullet and no language line', () => {
  for (const p of all(base)) {
    expect(p).not.toContain('{{')
    expect(p).not.toMatch(/\n-\s*\n/)
    expect(p).not.toContain('Write PR titles')
    expect(p).not.toContain('Required before')
    expect(p).not.toMatch(/New migrations|add migrations|add a migration/)
  }
  expect(fill(NO_QUEUE_RULE, base)).not.toContain('{{')
})

test('worker checks and always tests are hard requirements in the worker prompt', () => {
  const p = fill(WORKER_PROMPT, { ...base, workerChecks: ['tsc -p .', 'pnpm lint'], alwaysTests: ['tests/guard.test.ts'] })
  expect(p).toContain('Required before `gh pr create`, on your final commit: run each of these and they must pass: `tsc -p .`, `pnpm lint`.')
  expect(p).toContain('report BLOCKED with the output')
  expect(p).toContain('Also run these every time, on top of the tests for the files you changed: `tests/guard.test.ts`. Run each entry as a command.')
  expect(p).toContain('including every required check named above (each must appear under Ran)')
  expect(p).toContain('## Verification')
})

test('always tests go through {files} when the test command has it', () => {
  const p = fill(WORKER_PROMPT, { ...base, testCommand: 'vitest run {files}', alwaysTests: ['tests/guard.test.ts'] })
  expect(p).toContain('Files go through the test command in place of {files}')
})

test('questions go through mcp__flow__ask and mcp__flow__answer', () => {
  expect(fill(WORKER_PROMPT, base)).toContain('mcp__flow__ask')
  const manager = fill(MANAGER_PROMPT.replace('{{QUEUE_RULE}}', QUEUE_RULE), base)
  expect(manager).toContain('mcp__flow__ask')
  expect(manager).toContain('mcp__flow__answer')
})

test('worker and manager prompts ask for a stable topic and mention standing answers', () => {
  const worker = fill(WORKER_PROMPT, base)
  const manager = fill(MANAGER_PROMPT.replace('{{QUEUE_RULE}}', QUEUE_RULE), base)
  for (const p of [worker, manager]) {
    expect(p).toContain('`topic`')
    expect(p).toContain('standing answer')
  }
})

test('the manager does recon, then files a pre-flight before starting workers', () => {
  const manager = fill(MANAGER_PROMPT.replace('{{QUEUE_RULE}}', QUEUE_RULE), base)
  expect(manager).toContain('mcp__flow__preflight')
  expect(manager).toContain('Recon first, with no workers yet')
  expect(manager).toContain('Pre-flight: skip')
  expect(fill(WORKER_PROMPT, base)).not.toContain('mcp__flow__preflight')
})

test('the language line is in all three prompts for 繁體中文 and for no English spelling', () => {
  for (const p of all({ ...base, language: '繁體中文' })) expect(p).toContain('in 繁體中文. Code, identifiers and commit messages follow the codebase.')
  for (const p of all({ ...base, language: 'english' })) expect(p).not.toContain('Write PR titles')
})

test('big files render with the threshold, and the threshold alone when the list is empty', () => {
  const listed = all({ ...base, bigFiles: ['src/app.ts'], bigFileLines: 900 })
  expect(listed[0]).toContain('never read these whole, grep for names and read line ranges: `src/app.ts`; any file over 900 lines counts as big too.')
  expect(listed[1]).toContain('`src/app.ts`')
  expect(all(base)[0]).toContain('file over 1500 lines counts as big too.')
  expect(all(base)[0]).not.toContain('these whole')
})

test('migrations reach the worker, the manager and the queue', () => {
  const [w, m, q] = all({ ...base, migrationsDir: 'db/migrations' })
  expect(w).toContain('New migrations go in `db/migrations`, numbered after the highest on origin/main')
  expect(m).toContain('Two packages that both add migrations run one after the other.')
  expect(q).toContain('no two PRs add a migration with the same number in `db/migrations`; send the later one back.')
})

test('the manager, the no-queue rule and the queue call the cleanup sweep', () => {
  const [, m, q] = all(base)
  expect(m).toContain('`mcp__flow__clean` with apply true')
  expect(q).toContain('`mcp__flow__clean` with apply true')
  expect(fill(NO_QUEUE_RULE, base)).toContain('`mcp__flow__clean` with apply true')
  expect(m).toContain('Do not remove the old worktree')
})

test('the manager hands over mode confirm for risky PRs and the queue skips a Held take', () => {
  const [, m, q] = all(base)
  expect(m).toContain('Pass mode "confirm" for a risky PR')
  expect(m).toContain('/flow approve <n>')
  expect(q).toContain('If "take" answers "Held:"')
})
