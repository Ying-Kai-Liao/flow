import { expect } from 'claude-code/testing'
import { test } from './support'

import { deploySection, fill, HEALTH_FIRST_WAIT_SECONDS, HEALTH_RETRY_MINUTES, MANAGER_PROMPT, NO_REVIEWER_RULE, PUSH_RETRY_BACKOFF, PUSH_RETRY_MINUTES, REVIEWER_PROMPT, REVIEWER_RULE, WORKER_PROMPT } from '../hooks/prompts'
import type { Settings } from '../hooks/prompts'

const base: Settings = {
  base: 'main', testCommand: 'npm test', fullCheck: '', deployCommand: '', deployTargets: [], stateFile: undefined,
  mergeMethod: 'merge', mergeMode: 'auto', useReviewer: true, maxWorkers: 3, testSlots: 1, workerModel: 'sonnet', managerModel: 'opus', reviewerModel: 'opus',
  language: 'English', bigFiles: [], bigFileLines: 1500, migrationsDir: '', decisionPhrases: [], workerChecks: [], alwaysTests: [],
}
const all = (s: Settings) => [WORKER_PROMPT, MANAGER_PROMPT.replace('{{REVIEWER_RULE}}', REVIEWER_RULE), REVIEWER_PROMPT].map((p) => fill(p, s))

test('the defaults leave no slot, no empty bullet and no language line', () => {
  for (const p of all(base)) {
    expect(p).not.toContain('{{')
    expect(p).not.toMatch(/\n-\s*\n/)
    expect(p).not.toContain('Write PR titles')
    expect(p).not.toContain('Required before')
    expect(p).not.toMatch(/New migrations|add migrations|add a migration/)
  }
  expect(fill(NO_REVIEWER_RULE, base)).not.toContain('{{')
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
  const manager = fill(MANAGER_PROMPT.replace('{{REVIEWER_RULE}}', REVIEWER_RULE), base)
  expect(manager).toContain('mcp__flow__ask')
  expect(manager).toContain('mcp__flow__answer')
})

test('worker and manager prompts ask for a stable topic and mention standing answers', () => {
  const worker = fill(WORKER_PROMPT, base)
  const manager = fill(MANAGER_PROMPT.replace('{{REVIEWER_RULE}}', REVIEWER_RULE), base)
  for (const p of [worker, manager]) {
    expect(p).toContain('`topic`')
    expect(p).toContain('standing answer')
  }
})

test('the manager does recon, then files a pre-flight before starting workers', () => {
  const manager = fill(MANAGER_PROMPT.replace('{{REVIEWER_RULE}}', REVIEWER_RULE), base)
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
  expect(w).toContain('the reviewer renumbers the later one itself')
  expect(m).toContain('may run in parallel: the reviewer renumbers a clash.')
  expect(q).toContain('step 2 renumbers a clashing one instead of sending the PR back')
  expect(q).toContain('`mcp__flow__migrations`')
  expect(q).toContain('Renumber migration <old> to <new> (reviewer)')
  expect(q).toContain('plain, never force')
  expect(q).toContain('not "head moved"')
})

test('without migrations_dir the queue prompt says nothing about migrations', () => {
  const q = all(base)[2]
  expect(q).not.toContain('mcp__flow__migrations')
  expect(q).not.toContain('Renumber migration')
})

test('the queue retries infrastructure failures within fixed bounds', () => {
  const q = all(base)[2]
  expect(q).toContain('(5xx, timeout, connection reset; not a rejection)')
  expect(q).toContain(`${PUSH_RETRY_BACKOFF}) for at most ${PUSH_RETRY_MINUTES} minutes`)
  expect(q).toContain('push to main failed for 20 minutes (infrastructure); PR unchanged, hand it over again')
  expect(q).toContain('push retries: <n>')
  const h = deploySection({ deployCommand: '', deployTargets: [{ name: 'p', mode: 'auto', backup: [], deploy: ['d'], healthUrl: 'https://x/h', verify: [] }] })
  expect(h).toContain(`wait ${HEALTH_FIRST_WAIT_SECONDS}s after the deploy`)
  expect(h).toContain(`at most ${HEALTH_RETRY_MINUTES} minutes`)
})

test('flaky_tests adds the rerun rule, and nothing when empty', () => {
  expect(all(base)[2]).not.toContain('Known flaky')
  expect(all({ ...base, flakyTests: [] })[2]).not.toContain('Known flaky')
  const q = all({ ...base, flakyTests: ['tests/a.test.ts'] })[2]
  expect(q).toContain('Known flaky tests: `tests/a.test.ts`')
  expect(q).toContain('by running the full check once more')
  expect(q).toContain('flaky: <test>')
  expect(all({ ...base, flakyTests: ['tests/a.test.ts'], testCommand: 'vitest run {files}' })[2]).toContain('in place of {files}')
})

test('both-sided additions are kept and reported', () => {
  const q = all(base)[2]
  expect(q).toContain('keep both, drop exact duplicates, keep sorted lists sorted')
  expect(q).toContain('kept both sides in <files>')
  expect(q).toContain('one side deleting what the other edited')
})

test('the manager, the no-queue rule and the queue call the cleanup sweep', () => {
  const [, m, q] = all(base)
  expect(m).toContain('`mcp__flow__clean` with apply true')
  expect(q).toContain('`mcp__flow__clean` with apply true')
  expect(fill(NO_REVIEWER_RULE, base)).toContain('`mcp__flow__clean` with apply true')
  expect(m).toContain('Do not remove the old worktree')
})

test('the manager hands over mode confirm for risky PRs and the queue skips a Held take', () => {
  const [, m, q] = all(base)
  expect(m).toContain('Pass mode "confirm" for a risky PR')
  expect(m).toContain('/flow approve <n>')
  expect(q).toContain('If "take" answers "Held:"')
})

test('the plugin fast-forwards the main checkout on done; the reviewer only copies the line', () => {
  const q = fill(REVIEWER_PROMPT, base)
  expect(q).toContain('the plugin, not by you')
  expect(q).toContain('Never run git against the main checkout yourself')
  expect(q).not.toContain('git -C <main>')
  expect(q).not.toContain('pull --ff-only')
  expect(q).toContain('written after your last tool call')
  expect(q).toContain('main checkout fast-forwarded to <sha>')
  expect(q).toContain('main checkout not updated: <dirty | on branch X | ff failed | nothing pushed>')
})

test('the push run continues with the after-batch steps and the untracked clause is there', () => {
  const q = fill(REVIEWER_PROMPT, { ...base, pushMode: 'confirm' })
  const run = q.slice(q.indexOf('## Push run'), q.indexOf('## A batch'))
  expect(run).toContain('"After a batch" section')
  expect(run).toContain('the plugin fast-forwards the main checkout when you call "done"')
  expect(run).toContain('main checkout not updated: batch awaits /flow push')
  expect(q).toContain('\n## After a batch\n')
  const after = q.slice(q.indexOf('## After a batch'))
  expect(after).toContain('main checkout fast-forwarded to <sha>')
  expect(after.startsWith('## After a batch\n\nAfter every batch, call')).toBe(true)
  expect(after).toContain('nothing pushed')
  expect(after).toContain('clean apart from untracked files')
})

test('the manager prompt routes by the Size line and never tells an agent to pass a [1m] model; the reviewer sends code conflicts to a sub-agent', () => {
  const s: Settings = { ...base, workerModel: 'sonnet[1m]', workerModelSmall: 'haiku', workerModelNormal: 'sonnet', conflictModel: 'opus' }
  const m = fill(MANAGER_PROMPT.replace('{{REVIEWER_RULE}}', REVIEWER_RULE), s)
  expect(m).toContain('small -> haiku, normal -> sonnet, large -> sonnet[1m]')
  expect(m).toContain('"Size: small|normal|large')
  expect(m).not.toMatch(/model "sonnet\[1m\]"/)
  expect(fill(REVIEWER_PROMPT, s)).toContain('subagent_type "general-purpose", model "opus"')
})
