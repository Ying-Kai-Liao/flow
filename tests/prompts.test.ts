import { expect } from 'claude-code/testing'
import { test } from './support'

import { BATCH_PR_CHECKS_MINUTES, deploySection, fill, HEALTH_FIRST_WAIT_SECONDS, HEALTH_RETRY_MINUTES, MANAGER_PROMPT, NO_REVIEWER_RULE, PUSH_RETRY_BACKOFF, PUSH_RETRY_MINUTES, REVIEWER_PROMPT, REVIEWER_RULE, REVIEWER_SESSION_RULES_AUTO, SESSION_NO_TOOLS, SESSION_PROMPT, SESSION_RELAYED_TOOLS, WORKER_PROMPT } from '../hooks/prompts'
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

test('a terminal mode tells the manager to start workers with the session tool; agent mode drops that section', () => {
  const m = (s: Settings) => fill(MANAGER_PROMPT.replace('{{REVIEWER_RULE}}', REVIEWER_RULE), s)
  const term = m({ ...base, mode: 'tmux', workerHarness: 'codex' })
  expect(term).toContain('Start each worker with `mcp__flow__session` action "start" (this repo runs in mode tmux')
  expect(term).not.toContain('Start each worker with the Agent tool')
  expect(term).not.toContain('{{')
  expect(term).toContain('workers run in codex by default')
  const agent = m(base)
  expect(agent).toContain('Start each worker with the Agent tool')
  expect(agent).not.toContain('## Workers in a terminal')
})

test('batch_max renders into the reviewer prompt, default 10, minimum 1', () => {
  expect(all(base)[2]).toContain('A batch holds at most 10 PRs.')
  expect(all({ ...base, batchMax: 3 })[2]).toContain('until the batch holds 3 PRs')
  expect(all({ ...base, batchMax: 0 })[2]).toContain('A batch holds at most 1 PRs.')
  expect(all(base)[2]).not.toContain('{{')
})

test('late join, bisect, timeout rerun and the guarantees are in the reviewer prompt', () => {
  const q = all(base)[2]
  expect(q).toContain('Late join (a normal batch only, never a PUSH RUN or REBUILD RUN). Right before step 3')
  expect(q).toContain('never merge it twice')
  expect(q).toContain('After the rework of a failed check, do 2b again')
  expect(q).toContain('bisect instead of guessing')
  expect(q).toContain('A passing bisect step is never pushed by itself')
  expect(q).toContain('Every failing test failed on a timeout')
  expect(q).toContain('A second failure is real.')
  expect(q).toContain('the sha you push is always one whose exact tree passed the full check')
  expect(q).toContain('one release cut per batch, after the final check passes')
  expect(q).not.toContain('Known flaky')
})

test('push and rebuild runs take no late joins; the terminal reviewer never runs two batches', () => {
  expect(all(base)[2]).not.toContain('## Push run')
  expect(all({ ...base, pushMode: 'confirm' })[2]).toContain('takes no late joins')
  expect(REVIEWER_SESSION_RULES_AUTO).toContain('you never run two batches at once')
})

test('a push refused by branch protection takes the batch PR route and sends nothing back', () => {
  const q = fill(REVIEWER_PROMPT, base)
  const push = q.slice(q.indexOf('4. Push:'), q.indexOf('5. Deploy:'))
  for (const s of ['"GH006"', '"GH013"', '"protected branch"', '"Changes must be made through a pull request"', '"Repository rule violations"']) expect(push).toContain(s)
  expect(push).toContain('never send a PR back for it')
  expect(push).toContain('Take the batch PR route')
  expect(q).not.toContain('refused by branch protection; the reviewer needs push rights')
  expect(q).toContain('never sent back because branch protection refused the push')
  const route = q.slice(q.indexOf('## Batch PR route'), q.indexOf('## After a batch'))
  expect(route).toContain('`git push origin HEAD:refs/heads/flow/batch-<id>`')
  expect(route).toContain('first 8 characters of the batch head')
  expect(route).toContain('gh pr create --base main --head flow/batch-<id>')
  expect(route).toContain(`gh pr checks <b> --required --watch --fail-fast\` (run_in_background), for at most ${BATCH_PR_CHECKS_MINUTES} minutes`)
  expect(route).toContain('"no required checks reported" means there is nothing to wait for')
  expect(route).toContain('`git merge-base --is-ancestor origin/main HEAD` must succeed')
  expect(route).toContain('`gh pr merge <b> --merge --match-head-commit <full sha of HEAD> --delete-branch`')
  expect(route).toContain('| merged via batch PR #<b>')
  expect(route).toContain('never with `git push --delete`')
  // Failure branches: none sends a PR back.
  expect(route).toContain('handle it by step 3\'s rules')
  expect(route).toContain('with the same id (it updates the open PR, never a second one)')
  expect(route).toContain('leave the batch PR open, send nothing back')
  expect(route).toContain('merge it on GitHub or fix the repo setting')
  expect(route).toContain('the merge counts as blocked (above), never a send-back')
  expect(route).not.toMatch(/action "back"/)
})

test('each batch starts by closing leftover batch PRs, and a PR merged through one is done, not merged again', () => {
  const q = fill(REVIEWER_PROMPT, base)
  const step1 = q.slice(q.indexOf('1. Start clean'), q.indexOf('2. For each pending PR'))
  expect(step1).toContain('select(.headRefName | startswith("flow/batch-"))')
  expect(step1).toContain('gh pr close <n> --delete-branch --comment "superseded by a new batch"')
  const step2 = q.slice(q.indexOf('2. For each pending PR'), q.indexOf('2b. Late join'))
  expect(step2).toContain('State MERGED with the handover\'s head in the base (`git merge-base --is-ancestor <head sha> origin/main` succeeds)')
  expect(step2).toContain('do not merge it again and do not send it back')
  expect(step2).toContain('"merged earlier via batch PR; not deployed by this run"')
})

test('the push run and the status file go through the batch PR route too', () => {
  const run = fill(REVIEWER_PROMPT, { ...base, pushMode: 'confirm' })
  expect(run.slice(run.indexOf('## Push run'), run.indexOf('## A batch'))).toContain('a branch-protection refusal takes the batch PR route, where a moved base makes the batch stale')
  expect(run).toContain('In a PUSH RUN the batch is stale instead: close the batch PR as superseded')
  const st = fill(REVIEWER_PROMPT, { ...base, stateFile: { path: 'STATUS.md', archive: 'STATUS-archive.md', keep: 5 } })
  const step8 = st.slice(st.indexOf('8. Status file'))
  expect(step8).toContain('`git fetch origin && git checkout --detach origin/main` first')
  expect(step8).toContain('`flow/status-<id>`')
  expect(step8).toContain('no publish and no deploy')
})

test('the session preamble has one flow-tools line: relayed for a claude worker with the missing-tools rule, none for another harness', () => {
  const preamble = SESSION_PROMPT.slice(WORKER_PROMPT.length)
  expect(preamble).toContain('{{FLOW_TOOLS_RULE}}')
  expect(preamble).not.toContain('You have no flow tools')
  expect(SESSION_NO_TOOLS).toContain('You have no flow tools (mcp__flow__*): skip the test slot steps')
  expect(SESSION_RELAYED_TOOLS).toContain('Your flow tools (mcp__flow__*) are relayed to the main session; use them as the rules above say.')
  expect(SESSION_RELAYED_TOOLS).toContain('as the first line of your report ("flow tools missing: <what you saw>")')
  expect(SESSION_RELAYED_TOOLS).toContain('leave guard_tests and whole-suite runs to the reviewer')
})
