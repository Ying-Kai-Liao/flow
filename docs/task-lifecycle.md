# Life of a task

One task, from your request to a cleaned-up worktree, with the module under `hooks/` that holds the code at each step. [How flow works](how-it-works.md) is the topical reference and the [reference](reference.md) lists settings, tools and files; this page is the path through them, for reading once and for finding where to look when something goes wrong. Module names come from the module map in [Where code goes](reference.md#develop-it).

```
you -> main (dispatch skill)
        |  one flow:manager per task; its Size: line picks its model
        v
     manager: pre-flight ----> one round to you (asks, defaults)
        |  plan nodes, worker briefs (Size: line picks the worker's model)
        v
     worker(s) in worktrees on flow/<name>      [best-of-N arms: off by default]
        |  own test files only, test and typecheck slots, ## Verification
        v
     PR --> manager review --> handover
                                   v
                       reviewer batch: merge, full check, release, push
                                   v
                       deploy gates (env items, holds, confirm targets)
                                   v
                       person checks, cleanup, fast-forward of main
```

Lite mode (`/flow lite <task>`) is the short variant for one clear, low-risk task: one manager and its workers, no pre-flight round, no separate reviewer agent. See [Lite mode](how-it-works.md#lite-mode).

The run-mode wording on this page (agent workers, terminal workers, terminal managers) may change soon: an open change adds one setting that chooses the mode for the whole run.

## 1. The request in main

Your main session, with the `dispatch` skill (`skills/dispatch/SKILL.md`), is the super manager. It splits your request into tasks (one task is one outcome you would check), drops what already shipped or is running, and starts one `flow:manager` per task, all in one message so they form one pre-flight round. It never writes worker briefs, starts workers or edits code for a task a manager owns. The manager's prompt carries your words, what the manager cannot see, any `Attachments:` paths and a `Size:` line.

Code: the `agent.spawn` hook, `spawn-run.ts` (checks plans, the pre-flight gate and attachments, see `attachments.ts`); `roster-run.ts` keeps the roster the pane and `status` read; `deliver.ts` delivers messages.

## 2. The manager starts: size and model

The `Size: small | normal | large` line on the manager's prompt picks its model at spawn: `small` runs on `manager_model_small`, `normal` on `manager_model_normal` (unset: it follows `manager_model`), `large` or no line on `manager_model`. A worker's brief carries the same line and maps to `worker_model_small`, `worker_model_normal` or `worker_model`. `decision_api` can decide the size instead of the line. Below `large` the plugin files a `worker-size` or `manager-size` decision you can undo, and a successor (`-2`) runs at least one size up.

Reasoning effort follows the same routing: `worker_effort_small`, `worker_effort_normal`, `worker_effort`, `manager_effort`, `reviewer_effort`, `explore_effort`. The spawn decides the level; the `turn.step` hook applies it on each model request, only where the model takes an effort; an explicit effort on the Agent call, or `CLAUDE_CODE_EFFORT_LEVEL` in the environment, overrides it. A new manager also gets a short digest of how earlier workers' `Size:` lines turned out (`size_feedback`), once at least 5 workers are recorded.

Code: `routing.ts` (pure size-to-model rules), `spawn-run.ts` (applies them), `turn-run.ts` (`turn.step`), `sizefeedback.ts`. Detail: [Model routing](reference.md#model-routing).

## 3. Pre-flight

Before any worker starts, the manager reads the code, `git log` and open PRs and files `mcp__flow__preflight`: criteria, work already `shipped`, `depends`, an estimate of workers and any questions. Until it has filed, and while a blocking question of its filing is open, the spawn hook refuses its worker starts. When every manager of the round has filed (or `preflight_wait` minutes pass), main gets one "Pre-flight: N tasks ..." message and you answer once. `preflight` off, a `Pre-flight: skip` line, or lite mode skips the gate.

Code: `preflight.ts` (pure), `spawn-run.ts` (the gate), `command.ts` (`/flow preflight`). Detail: [Pre-flight](how-it-works.md#pre-flight).

## 4. Asks, decisions and standing rules

Agents talk to you through one inbox (`inbox.ts`, `inbox-run.ts`, `askcards.ts`). Three kinds of item:

- An **ask** (`mcp__flow__ask`) has options, a recommended default and a `blocking` flag. Non-blocking: the agent carries on with the default and says so in its report. Blocking: it ends its turn and the answer wakes it. A worker's question goes to its manager, a manager's to main; only main asks you.
- A **decision** (`mcp__flow__fyi`) records a reversible choice the agent took itself. It is not a question; you keep it or undo it later (`/flow ok`, `/flow no <id>`), and an undo messages the owner. The plugin's own `worker-size` and `manager-size` decisions are filed already kept (by `default`): recorded, never open, still undone by id.
- A **standing answer** (`mcp__flow__standing`; `standing.ts`, `standing-run.ts`) answers a recurring question by `topic` or `match` without asking again. You create one by answering with `always`, or from a suggestion: once main has answered the same topic (or, without one, the same question text) the same way three times, main's next answer result or status, whichever comes first, and the pane offer the rule once, and nothing is added until you call `add` (`standing-suggest.ts`). One rule is on by default: `conservative` takes the default of any fresh non-blocking ordinary question (never a decision, a blocking, linked or escalated question, or a deploy, env, push, reviewer or guard item); the setting `conservative_default: false` turns it off. Deploy and env items are answered only by a rule that names their kind; push and reviewer items are never answered by a rule.

When several managers ask main the same question (same topic and options, or same text and options), the inbox shows it once with the askers' names, and one answer fills every open member (`inbox-dups.ts`). Only questions addressed to main are grouped; decisions, guard suggestions, deploy, env, push, reviewer and escalated items are not. Detail: [Questions and the inbox](how-it-works.md#questions-and-the-inbox), [Standing answers](how-it-works.md#standing-answers).

## 5. Plan dependencies

When one task needs another's merged code, the owner declares it with `mcp__flow__plan`: nodes with an `id`, `title` and `after` ids. Main does this for managers, a manager for its workers. The spawn hook refuses to start an agent whose node is still waiting, and one `flow plan:` message per pass tells the owner what became ready or blocked. The plugin never starts agents itself. Code: `plan-run.ts`, `dag.ts` (cycle checks, states), `graph.ts` (the pane's graph view). Detail: [Dependencies](how-it-works.md#dependencies).

## 6. Worker briefs and worktrees

The manager writes the brief: first line `Your name: <slug>`, a `Size:` line, goal, acceptance criteria, scope, attachments. It starts a `flow:worker` with the Agent tool (in mode `orca` or `tmux`, a terminal worker with `mcp__flow__session`); the host gives it a worktree, and the worker renames its branch to `flow/<name>`. A continuation (`Continue on branch: flow/<x>`) is rewritten to run in the old worktree when that is clean and at the pushed branch; otherwise it gets a new one. Up to `max_workers` workers run per manager. Managers cannot edit code: the `tool.call` hook refuses it, so every change goes into a brief.

Code: `spawn.ts` and `spawn-run.ts` (spawn rules, continuation routing), `guards.ts` and `toolcall-run.ts` (the `tool.call` guards), `prompts.ts` (the role rules the plugin adds). A worker can also run in another harness such as Codex: [Workers in other harnesses](how-it-works.md#workers-in-other-harnesses).

## 7. Best-of-N (optional)

With `best_of_n` set to `brief` or `auto` (default `off`), a manager may start 2 to 3 competing workers on one hard package (`best_of_n_arms`, default 2). They share the brief, are named `<pkg>-a`, `<pkg>-b`, and carry an `Arm: <letter> of <N>` line; each counts against `max_workers`. The manager picks one with `mcp__flow__arms`, the other PRs are closed, and only the winner can be handed over. Code: `bestof.ts`, enforced in `spawn-run.ts`. Detail: [Best of N](how-it-works.md#best-of-n).

## 8. Test slots and typecheck slots

Whole-suite runs are expensive, so the `tool.call` hook refuses a Bash command that looks like one (the `test_slot_commands` list) unless the caller holds a test slot (`test_slots`, default 1). Typechecks have a separate, lighter pool (`typecheck_slots`, `typecheck_commands`). A worker never runs the whole suite, even holding a slot: it runs only the test files it touched (one to five explicit files run freely), plus any `always_tests` and any `guard_tests` that `mcp__flow__guard_tests` lists for its diff. The reviewer's full check is the one suite run per batch.

Code: `testguard.ts` (is this command a suite run), `toolcall-run.ts` (the hook), `slots-run.ts` and `slots.ts` (the `test_slot` tool), `typecheck-slots.ts`, `guardtests.ts`, `testfail.ts` (failed and flaky tests). Detail: [The test lock](reference.md#the-test-lock), [Guard tests](reference.md#guard-tests).

## 9. Verification and handover

A worker's PR description ends in a `## Verification` section: `Ran` (each command and result), `Exercised` (how the change was run for real) and `Not verified`. A bare "n/a" or "nothing" is refused. The manager reviews the PR and calls `mcp__flow__handover`, which refuses a PR without that section, or whose `Ran` lacks a `worker_checks` or `always_tests` command or a test that `guard_tests` requires. A handover can ask for `mode: "confirm"` (the PR waits for your `/flow approve`), declare `env` changes for a deploy target, and give a `verify_command` for the after-deploy check.

Code: `handover-run.ts`, `evidence.ts` (the section), `mergemode.ts`. Detail: [Verification](how-it-works.md#verification), [Merge mode](how-it-works.md#merge-mode).

## 10. The reviewer batch

The plugin starts one `flow:reviewer` when handovers are pending (`reviewer-run.ts`, `reviewer-route.ts`), `reviewer_delay` minutes (default 3) after a handover on an idle queue so close handovers share a batch. It takes PRs with `mcp__flow__reviewer` (`list`, `take`, `done`, `back`) and merges them. Right before the full check it lists once more, and PRs that arrived meanwhile join the batch, up to `batch_max` (default 10). Then:

- It runs `full_check_command` once for the batch under a test slot. If failures do not clearly belong to one PR and the batch has more than two, it bisects the merges to the first PR that breaks the check, sends it back and rebuilds without it. If every failing test timed out it reruns the check once. With `flaky_tests` set, when every failing test is in a listed file it reruns once: only those files if `test_command` has a `{files}` slot, otherwise the whole check.
- With `release` on, it cuts the release once per batch (`release-run.ts`, `release.ts`): the Unreleased changelog lines become a version section and the version is bumped.
- It pushes. With `push_mode: confirm` it stops before the push and saves the batch (`pushgate.ts`, `pushgate-run.ts`); you run `/flow push`, send one PR back, or drop the batch. If the base moved meanwhile, it rebuilds and asks again.

A PR sent back returns to its manager, who continues with a fresh worker. After each "done" the plugin fast-forwards the main checkout (`mainff.ts`). After 3 quick deaths in a row or 20 starts in an hour, `reviewer-breaker.ts` stops restarting the reviewer and asks main (retry / not now). Detail: [Reviewer rules](how-it-works.md#reviewer-rules), [Push gate](how-it-works.md#push-gate), [Releases](how-it-works.md#releases).

## 11. Deploy gates

For each target in `deploy_targets`, the reviewer calls `mcp__flow__deploy` `gate` with the target and the pushed sha, and gets `Go`, `Held: <why>`, `Awaits approval: <qid>` or `Awaits env: <qids>`; `Go, first apply env:` comes with commands the reviewer runs, then it calls `env-applied` and deploys. A held or waiting target is skipped for the batch; a failed one stops the targets after it. A `confirm` target needs your answer to a blocking inbox item. Env or secret changes a PR declared are inbox items too, and the gate waits for them before it asks for the deploy approval. `/flow hold` keeps a target back. Code: `deploy.ts` (pure rules), `deploy-run.ts` (state in `deploys.json`). Detail: [Deploying](how-it-works.md#deploying).

## 12. Person checks

After deploy, a check an agent can do runs as a check-only worker. One that needs a person becomes a durable item (`needs a person: PR #<n>: ...` in the reviewer's report), listed by `/flow checks` and closed with `pass`, `fail` (which makes a follow-up for main) or `skip`. A check with a `verify_command` can be closed by the reviewer. Code: `checks.ts`, `checks-run.ts`. Detail: [Person checks](how-it-works.md#person-checks).

## 13. Cleanup

After each PR the reviewer marks done, and when the reviewer ends, the plugin sweeps leftover worktrees under `.claude/worktrees/` and local branches (`cleanup`, default `auto`). It removes only clean work that is on the base or in a merged PR; anything dirty, unpushed, locked, in use, or the branch of an open PR stays and is listed. `/flow clean` shows the list and `/flow clean --yes` removes. The merge deletes the remote branch, never cleanup. Code: `clean.ts` (pure), `branchdelete.ts`. Detail: [Cleanup](how-it-works.md#cleanup).

## 14. Resume after a restart

A restart empties the roster but not the disk. Managers keep notes (`mcp__flow__note`, in the state dir) of progress and your decisions, and the inbox, plans, handovers and push batch are files. A worker or manager near its context limit is told to hand off: a worker commits `WIP handoff: ...`, pushes, writes `## Handoff` in the PR description and ends with `HANDOFF: <branch>`; its manager starts `<name>-2` with `Continue on branch: flow/<x>`. After a restart, `/flow resume` lists open `flow/*` PRs, pushed branches without a PR and worktrees with unpushed work, also unfinished handovers saved on disk, and main starts a `resume-<slug>` manager per task; branches sharing a manager prefix count as one task. Code: `resume.ts`, `command.ts`, `startup-run.ts`. Detail: [Continuing work](how-it-works.md#continuing-work).

## 15. Terminals and the relay

The `mode` setting picks one host for the whole run. In `agent` (the default) managers, workers and the reviewer are agents in your session. In `orca` or `tmux` every manager, worker and the reviewer runs in a terminal in that host, with no per-role mixing: managers and the reviewer are always claude, and workers run the CLI `worker_harness` names (`claude` by default, or one a manager picks per worker). Code: `sessions.ts` and `session-run.ts` for session workers, `role-session-run.ts` for terminal managers and the reviewer (who owns which session, the start line, the reviewer's long-lived terminal).

A terminal claude loads its own copy of the plugin, so its `mcp__flow__*` tools do not run there. Each call is written as a file in the session's relay directory, main's pump runs it as that session and writes the answer back: `relay-run.ts` holds both ends, `relay.ts` the pure parts. Reports travel the other way: the terminal writes `report.md` and main delivers it as a message. Detail: [Managers and the reviewer in a terminal](how-it-works.md#managers-and-the-reviewer-in-a-terminal).

## When something is stuck

`mcp__flow__status` shows the tree, handovers, slots and what waits on whom (`status-run.ts`); `log.jsonl` in the state dir records the plugin's decisions. Look for: an open pre-flight question (3), a plan node still waiting (5), a held test slot (8), a handover `awaiting` your approval or a batch `ready` for `/flow push` (9, 10), a deploy target held or awaiting you (11).
