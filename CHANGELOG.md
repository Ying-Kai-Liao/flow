# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.17] - 2026-10-11

### Changed

- Docs: short settings table in the README, Core and Advanced settings in the reference (#92)

## [0.6.16] - 2026-10-11

### Changed

- Rename FYI to Decisions: d-ids, undo wording, flat decisions table (#89)
### Changed

- README lists the handful of settings most repos set in a short table, and docs/reference.md splits its Settings section into Core settings and Advanced settings. No setting or default changed.

## [0.6.15] - 2026-10-11

### Fixed

- A manager whose last answer says it waits for a PR's merge (or the reviewer's report) is woken by that report instead of being treated as finished and having the report sent to main.
### Changed

- "FYI" is now "Decisions" everywhere a person or an agent reads it (/flow inbox, /flow ok and no, the Flow pane, status, docs, agent prompts and tool descriptions), and "overturn" is "undo" (`n undo`, `/flow no d12 <what instead>`). The `mcp__flow__fyi` tool keeps its name.
- Decisions have their own ids, `d1`, `d2`, ..., from a counter separate from questions (`q1`, ...). Decisions already stored under a q-id are migrated on read to stable d-ids (oldest first) and keep the old q-id as an alias: `/flow ok q10`, `/flow no q10`, `/flow inbox q10` and `mcp__flow__answer` with `q10` still find them, and no new question reuses a number an alias holds.
- /flow inbox shows the decisions as one flat table (id, from, headline, age; newest first, the newest 15 and a `+M more` line, at the terminal width, like /flow checks; `/flow inbox decisions` lists all). Questions list their options on one line; the full text and the why are in `/flow inbox <id>`. The commands footer lists only what a person types.
- Flow pane inbox view: decisions are plain rows, newest first.

### Removed

- The "Older" row, the per-owner and per-topic group rows of decisions, and the pane's `x expand` key. `/flow inbox all` is still accepted as `/flow inbox decisions`.

## [0.6.14] - 2026-10-11

### Added

- `/flow checks` is a compact table: one row per open check (id, PR, title cut to the terminal width, what it needs, age), grouped as Try now, Needs install of X and Version unknown, with failed checks that have an open follow-up in their own section and a footer of person commands. A narrow terminal drops age, then needs.
- `/flow checks <id>` shows one check in full; `/flow checks skip <id...> <why>` (and `mcp__flow__check` action `skip`, main only) closes checks that no longer apply, with a required reason and no follow-up.
- A shared text table helper (`hooks/table.ts`) for person views.

### Changed

- The post-update prompt for main names the number of checks now due and shows them as the table, not every step.

## [0.6.13] - 2026-10-10

### Fixed

- A manager that ended its turn waiting for a merge, with an open plan node or handover, is woken by the reviewer's report and plan notices instead of the report going to main.

## [0.6.12] - 2026-10-10

### Added

- Flow pane: a running agent's name shimmers (a bright stretch moves one step per second on the shared tick) and its card border uses the suggestion color; idle, waiting, pending and ended agents look as before.

## [0.6.11] - 2026-10-10

### Added

- Flow pane inbox view (`i`): read every open question and FYI, and answer with keys (`j`/`k`, digits and letters, `y`, `w`, `n`, `r` and the answer field). FYIs fold by topic (`worker-size x7`) and age. Deploy, env, push and guard items are never answered by `y` or `w`.

### Changed

- The user may answer any open question from the pane and `/flow ok|no|answer`, including a worker's question to its manager; the asker and a live manager are told. `mcp__flow__answer` keeps the addressee rule.
- The pane's key row is pinned to the bottom of the pane and also shows with no agents when a key in it works.
- The pane's status lines are plain language: one inbox line, "Cleanup: ... can be removed, ... hold work that isn't merged", "N checks to try by hand".

## [0.6.10] - 2026-10-10

### Fixed

- Main gets each reviewer outcome once: a reworded repeat of a "needs a person: PR #n" line is deduped per reviewer run, manager and PR, the reviewer prompt keeps that line inside the done line only, and the reviewer's per-run work is persisted so its whole final report survives a plugin reload.

## [0.6.9] - 2026-10-10

### Changed

- Less re-sent text: scoped status, stable-first session prompt, deferred tools (#79)

## [0.6.8] - 2026-10-10

### Added

- `/flow ok`, `/flow no <id> [what instead]` and `/flow answer <id> <choice>` answer inbox items from the prompt; `/flow ok` never answers deploy, push, env or guard items.
- `/flow inbox all` and `/flow inbox <id>`.

### Changed

- Fewer wake-ups: messages to an idle agent that arrive within 8 seconds go out as one; urgent ones (blocking answers, push-gate send-backs, max-continues, wrap-up) go at once; a non-blocking ask waits for the manager's next turn (10 minutes at most). See "Message delivery" in `docs/reference.md`.
- `/flow inbox` is a skimmable view: a summary line, questions (blocking first, NEEDS YOU for deploy/push/env), FYIs grouped by owner with repeated topics and stale items collapsed, and person commands instead of tool-call hints.

## [0.6.7] - 2026-10-10

### Added

- The cost meter counts turns per agent and shows `N turns, ~Xk cache write/turn` on the cost lines, so the cache cost of each wake-up can be read.

### Fixed

- The plugin now fast-forwards the main checkout after the reviewer's "done" (a worktree-isolated reviewer cannot), and relays the reviewer's whole final report to main instead of only its last line.

## [0.6.6] - 2026-10-10

### Changed

- Docs: model routing (brief sizes, escalation, `worker-size` FYIs, `explore_model`, `reviewer_model` now `sonnet`, `conflict_model`) in the reference.

## [0.6.5] - 2026-10-10

### Added

- Model routing: a worker brief's `Size: small | normal | large` line picks the worker's model at spawn (settings `worker_model_small` haiku, `worker_model_normal` sonnet, large = `worker_model`); the Size line wins over a model param, and a brief without one is spawned as before. The ledger records the size, `status` shows cost by size, and a worker below large gets a non-blocking `worker-size` FYI (overturnable, answerable by a standing rule).
- A successor of a worker (`<name>-N`, or `Continue on branch:`) runs one size up from its predecessors' recorded size; a reviewer "back" for a small or normal worker's PR tells the manager to continue with a fresh worker.
- Settings `explore_model` (haiku: Explore sub-agents started by flow agents) and `conflict_model` (opus: the reviewer's sub-agent for code-file merge conflicts and combination fixes).

### Changed

- `reviewer_model` now defaults to `sonnet` (was `opus`).
### Changed

- `mcp__flow__status` is scoped by caller: a manager sees its own subtree, handovers and cost lines, a worker sees itself and its manager, main and the reviewer see everything. Finished handovers show the newest 5 with a `+N earlier finished PRs` line and are clipped to 220 characters; `pr:<n>` gives the full line.
- The worker session prompt now starts with the shared rules and ends with the per-session values, so workers in other harnesses share a common prompt prefix.
- `standing` and `push` (main only) are deferred tools, kept out of every agent's tool prefix; main loads them with ToolSearch.

## [0.6.4] - 2026-10-10

### Fixed

- The reviewer now fast-forwards the main checkout and reports it after a PUSH RUN too (push_mode confirm), not only after a normal push; untracked files no longer count as a dirty main checkout.

## [0.6.3] - 2026-10-10

### Added

- Cost meter: a durable per-agent, per-model token ledger (`ledger.json`) with API list-price estimates (`hooks/cost.ts`). `mcp__flow__status` and the new `/flow status` show cost per agent, manager, PR, reviewer, main and session with cache-hit rates; the reviewer's done report and handover lines carry the PR's cost.

## [0.6.2] - 2026-10-10

### Fixed

- Release cut dates the new CHANGELOG section with the machine's local date instead of UTC.

## [0.6.1] - 2026-10-09

### Changed

- Docs: push gate (push_mode confirm, /flow push) (#73)

## [0.6.0] - 2026-10-09

### Added

- `push_mode` setting (`auto` by default, `confirm` in this repo): with `confirm` the reviewer builds the batch, runs the full check and cuts the release, then stops. It saves the batch head under `refs/flow/push/<id>` and records it with `mcp__flow__reviewer` action `ready`; nothing is pushed, deleted, published or deployed until you run `/flow push`.
- A ready batch shows at the top of the Flow pane, in `mcp__flow__status` under "Needs the user", in `/flow resume` and in `/flow inbox` (a `push` item, never answered by standing answers), and raises a toast. It survives a restart (`push.json` in the state dir).
- `/flow push` pushes the batch (a reviewer checks the base did not move, pushes, marks the PRs done, publishes and deploys); `/flow push back <pr>` returns one PR and the rest is rebuilt, re-checked and asked again; `/flow push drop` returns them all. Main has the same through the `mcp__flow__push` tool (list, push, send-back, drop) or by answering the inbox item "push", "send back #n" or "drop".
- If the base moved before the push, the reviewer rebuilds the batch on the new base, re-checks it and asks again; `mcp__flow__release` takes `recut` for that.
- While a batch is ready, new handovers stay pending and no new batch starts.

## [0.5.0] - 2026-10-09

### Changed

- Publish tag and GitHub Release after the release push (#71)

## [0.4.5] - 2026-10-09

### Changed

- Report routing: main gets each outcome once (#70)
### Added

- `release_github` setting (default `off`): with `release` on, the reviewer calls `mcp__flow__release` action `publish` after a successful push, which tags `v<x.y.z>`, pushes the tag and creates a GitHub Release from the changelog section. Failures are reported, never fatal.
- The reviewer treats a push refused by branch protection as neither a retry nor a publish case: the batch goes back with a clear reason.

## [0.4.4] - 2026-10-09

### Changed

- The README is now a short guide for people: what flow is, install, a first run, the commands you use and the few settings you change. The detailed sections moved to `docs/how-it-works.md` and `docs/reference.md`, unchanged in substance.
### Fixed

- Main gets each outcome once: a woken manager's turn-end report is relayed only when main's transcript lacks it, the reviewer's repeated reports for a finished manager are forwarded once per manager and PR (a repeat forwards only new needs-a-person or pending-decisions lines), a reviewer message to main that repeats forwarded lines is dropped, and the reviewer prompt no longer tells it to SendMessage those lines to main.

## [0.4.3] - 2026-10-09

### Changed

- Cleanup: break stale reviewer locks held by this session; sweep at start (#68)

## [0.4.2] - 2026-10-09

### Changed

- The Flow pane's key-hint row (`j next · k prev · o open · c collapse · q reviewer · g ...`) now sits at the very bottom of the tree view, below the Reviewer section and the deploy lines, instead of above them.
### Fixed

- Cleanup removes the locked worktrees of ended reviewers: a lock naming this Claude process (found as the nearest `claude` ancestor of the plugin's process) is broken when its agent ended or is missing from the roster (empty after a plugin reload), the worktree is clean and landed, and, for a missing agent, the lock is over 10 minutes old. Never `--force`.
- The automatic sweep also runs at session start and when a reviewer is first seen already ended, so a reload no longer leaves reviewer worktrees behind.

## [0.4.1] - 2026-10-10

### Added

- After a batch the reviewer fast-forwards the main checkout (`git pull --ff-only`) when it is clean and on the base branch, so merged changes such as `.claude/flow.json` take effect there. Otherwise it leaves it alone and reports "main checkout not updated: <dirty | on branch X | ff failed>".

### Changed

- The merge queue is now the reviewer: agent type `flow:reviewer`, agents `reviewer-N`, tool `mcp__flow__reviewer`, options `reviewer` and `reviewer_model`, and the "Reviewer" section and status line. The old names still work: `flow:queue`, `mcp__flow__queue`, and the `merge_queue` / `queue_model` keys in /config, `.claude/flow.json` and the personal config (each warns once per session that it is deprecated; the new key wins when both are set in a layer). A reviewer already running under `flow:queue` is recognised, not doubled.

## [0.4.0] - 2026-10-10

### Added

- Docs for person checks: README "Person checks" section, `check` tool, `verify_command` and `verify_paths`; the dispatch playbook tells main to list checks by version and close them only on the user's word; manager and queue prompts mention `verify_command` and the recorded check.
- Env and secret changes on a handover: `mcp__flow__handover` takes an optional `env` list (target,
  name, a value or `secret: true`, why, optional `login`). Each entry becomes blocking inbox items of
  the new kind `env` for the user (never answered by a standing answer unless a rule names the kind),
  and the deploy gate waits for them (`Awaits env`, `Held: env change NAME declined` until main
  releases the target). A non-secret change is applied by the queue through the target's new
  `env_command` template (`{name}`, `{value}`, shell-quoted), reported back with the new
  `mcp__flow__deploy` action `env-applied`; without one the user applies it and answers done. A
  secret has no value in flow and is set by the user. The queue list, the deploy list and the status
  file entry show each change by name.

- Release at merge: new settings `release` (`on`/`off`, default off), `release_files` and
  `changelog_file`. With it on, workers add changelog lines under `## [Unreleased]` and never touch
  the version; the merge queue calls the new `mcp__flow__release` tool once per batch, which cuts the
  changelog, bumps the version files (patch, or the highest of the handover `release` field and the
  `flow:minor` / `flow:major` labels) and returns the commit command; the queue commits "Release
  x.y.z" and pushes. Worker, manager and queue prompts carry the rules when it is on. This repo turns
  it on, so PRs here no longer bump `plugin.json`.
- `guard_tests` setting (file only; the personal file merges per glob): path globs mapped to repo-wide tests a
  worker must run when its diff touches them. The new `mcp__flow__guard_tests` tool computes the list from the
  worker's diff; `mcp__flow__handover` refuses a PR whose `Ran:` lacks a required guard test, naming the glob.
  `mcp__flow__queue` `back` takes `failed_tests`: for a failed test no glob requires, main gets an inbox question
  suggesting a mapping, and answering "Add" writes it to the personal config (never the committed file).
- Person checks: an after-deploy check that needs a person is now a durable item. When the merge
  queue reports a PR done with a `needs a person: PR #<n>: <steps>` line, the plugin stores an open
  check in `<state dir>/checks.json` with the version it needs (`plugin.json` at the merged sha, else
  a version named in the steps). Handovers already done on disk are backfilled once. `/flow checks`
  groups them by version to install, `/flow checks pass <id...>` and `/flow checks fail <id> <note>`
  close them, and `/flow inbox`, `/flow resume` and the Flow pane show them. A failed check creates a
  follow-up for main to start a manager on. New tool `mcp__flow__check` (main only). After a plugin
  update, main is prompted once per installed version with the checks it now covers.
- Scripted verification: `mcp__flow__handover` takes an optional `verify_command`. When the PR's
  check needs a person, the queue is told to run it at the merged main and pass or fail the check
  itself (the only closing besides main). The new `verify_paths` setting (a list of path globs, file
  only) limits this to PRs that change a matching file; otherwise the check stays open for a person.
- Attachments in briefs: an optional `## Attachments` section (or `Attachments:` line) lists file paths a
  worker opens first. The spawn hook refuses a manager, worker or continuation spawn whose listed files are
  missing, unreadable or directories (naming each), and rewrites relative paths to absolute ones. The worker
  prompt reports `BLOCKED: attachment <path> could not be opened`; the dispatch skill passes user files to
  managers as paths.
- Seeded standing answers: when no rule exists, `standing list` and main's first `status` call offer
  three common rules as suggestions (`tracker`, `prod-env`, `conservative`); accept with
  `standing add` and `seed`/`seeds`. Nothing is applied unasked.
- Two rule forms: `escalate: true` (a matching question is never auto-answered, is recorded blocking
  and flagged, and only main may answer it) and `answer: "default"` (a non-blocking question takes its
  own default). The ask guidance names the stable topics `external-tracker` and `prod-env-change`.
- Per-target deploy mode: `deploy_targets[].mode` is `auto` (default) or `confirm`; an unknown value counts
  as `confirm` and the settings warning says so. New tool `mcp__flow__deploy`: the queue calls `gate` before
  each target (`Go`, `Held: ...` or `Awaits approval: <qid>`) and `deployed` after it; main holds and
  releases a target (`hold` / `release`, also `/flow hold <target> [batch|released]` and
  `/flow release <target>`); `list` shows mode, hold, last deployed sha, behind count and approval.
- A confirm target opens one blocking inbox item (kind deploy) per target; answering `deploy` approves that
  sha and starts a deploy-only queue run. Standing answers never answer it unless a rule names
  `kinds: ["deploy"]`.
- `mcp__flow__status` and the pane show "<target> behind by N commits" (cached, off the render path) and
  "no deploy recorded". State in `deploys.json` beside `inbox.json`.

### Changed

- The queue skips a held or awaiting target and goes on to the next one; only a failed target stops the rest.

### Fixed

- The plugin's own test suite no longer fails at random under load: the kit's 5 s per-test limit includes
  loading the plugin (1-4 s idle), so tests now go through `tests/support.ts`, which sets a 60 s floor.
  The 20-manager render test's 500 ms wall-clock budget is 2500 ms.

## [0.3.38] - 2026-10-10

### Changed

- `handover`: `report_to` is optional and defaults to the caller's own agent name. A name that
  matches no agent is refused (naming the right value) and nothing is recorded; the caller's own
  worker's name is corrected to the caller's, with a note.
- A manager's turn-end report is forwarded to main when the turn was started by the queue or a
  worker, so nobody has to relay it by hand. Main's own wake-ups are not forwarded twice.
- The merge queue no longer wakes a finished manager: a SendMessage from the queue to an ended
  manager (or an unknown name) is answered "Not sent", the report is added to the manager's notes
  and sent to main. A live manager is still messaged.

## [0.3.37] - 2026-10-10

### Added

- FYI inbox items: `mcp__flow__fyi` records "I decided X because Y; say if wrong" as a non-blocking inbox
  item (`kind: "fyi"`). `mcp__flow__answer` acks it (Keep, or `defaults: true`) or overturns it, which
  messages the owner (its manager if the owner is gone). Main may answer any FYI. `/flow inbox` lists
  FYIs in their own section; status and the pane show a count. Worker and manager prompts now say to
  pick the conservative option for reversible choices, record it as an FYI and continue.

## [0.3.36] - 2026-10-10

### Changed

- Questions filed in a pre-flight go through the standing-answer rules like `mcp__flow__ask`: a fresh
  question a rule matches is stored and answered at once (decision note and `auto-answer` log event as
  for ask), shows under Auto-answered, stays out of the round and never gates the manager. The result
  names the answered ids, their rule and answer. A filing sent again does not store them twice, and a
  question the manager already had answered (by a rule or by main) is reported as already answered
  instead of being asked again.

## [0.3.35] - 2026-10-10

### Fixed

- Plan nodes of managers no longer fall back to "ready" or stay "running" forever. A manager
  that ends its turn is `idle`, which the plan never counted as finished; it now does, once its
  last report is final, every handover it owns is merged, none of its workers is live or has
  reported after the manager's last turn, and its own plan graph has nothing open (so an
  investigation without a PR finishes too). An agent the host drops from its list keeps its last
  known state instead of reading as never started. A handover with a wrong `report_to` still
  counts for the manager that started its worker (read from the spawn log). With two rows of one
  name, the live one decides.

## [0.3.34] - 2026-10-10

### Added

- Merge queue rules: with `migrations_dir` set the queue renumbers a clashing migration itself (new
  read-only tool `mcp__flow__migrations`: highest numbers, per-PR ok / clash / at-or-below, next free
  number, suggested `git mv`, references) instead of sending the PR back, so packages that add
  migrations may run in parallel. Pushes and `gh` calls that fail with a server or network error are
  retried with backoff for up to 20 minutes before the batch goes back; health checks wait 30 seconds
  and retry for up to 10 minutes. New list setting `flaky_tests` (file only, appended like
  `always_tests`): the queue reruns those files once when they are the only failures. Conflicts where
  both sides added lines at the same place keep both sides and are reported.

## [0.3.33] - 2026-10-10

### Fixed

- `.gitignore` ignores `.claude-plugin/types` without the trailing slash, so the symlink `npm run typecheck`
  creates in a worktree is ignored too and `git worktree remove` no longer refuses it.

## [0.3.32] - 2026-10-10

### Added

- Type gate: pinned TypeScript 6.0.3 (`package.json`, lockfile), `npm run typecheck` (installs and links
  the engine's types in a fresh worktree) and `npm run check`; `.claude/flow.json` makes them the worker
  check and the full check. `claude plugin validate .` now passes: the types contract
  (`types/index.d.ts`) is self-contained, holding the inbox and pre-flight state types the hooks import.

### Fixed

- The type errors on main: an unnamed manager as an ask addressee, and the test helpers' parameter types.

## [0.3.31] - 2026-10-10

### Changed

- Rebrand: flow is presented as a standalone orchestration plugin for software development in
  Claude Code. The README opens with a short pitch and a quick start, then "How it works" and
  "Reference"; the plugin and marketplace descriptions say the same. The dispatch skill no longer
  mentions a separately installed skill in its description. Orca now appears only where it is a
  real option (`session_host`, workers in other harnesses). No tool, agent, skill or setting
  names changed.

## [0.3.30] - 2026-10-10

### Changed

- Docs for pre-flight: the manager prompt now starts with a recon step and the
  `mcp__flow__preflight` filing (and says questions known up front go there, later ones to
  `mcp__flow__ask`); the dispatch skill starts managers in one message and walks the user through
  the round; the README has a Pre-flight section, the `/flow preflight` command, the tool, the
  settings and `preflight.json`.

## [0.3.29] - 2026-10-10

### Changed

- Prompts: workers and managers give recurring questions a stable kebab-case `topic` and carry on
  from a standing answer; the dispatch skill tells main when to make, offer and remove standing answers.

## [0.3.28] - 2026-10-10

### Added

- Pre-flight: a manager main starts must look over its task and call `mcp__flow__preflight`
  (summary, acceptance criteria, already shipped, dependencies, optional questions) before it may
  start workers. Until it has, and while any blocking question of its filing is open, a
  `flow:worker` spawn (and an `mcp__flow__session` start) by it is refused with a message naming
  the tool. Recon agents (Explore, general-purpose) are not refused. Answering through
  `mcp__flow__answer` (choices or `defaults: true`) releases it.
- Main gets one combined round: when every manager started together has filed, skipped or ended,
  or after `preflight_wait` minutes, one message summarises tasks, already-shipped work,
  dependencies and the numbered questions. A late filing follows on its own.
- Exempt: the `preflight` setting `off`, a `Pre-flight: skip` line in the manager's prompt, a
  handoff successor (inherits the record), and managers not in the record (older data never blocks).
- `/flow preflight` shows the current or latest round; `mcp__flow__status` shows each manager's
  pre-flight phase. Settings `preflight` (on or off) and `preflight_wait` (minutes, default 10).
- State in `<git-common-dir>/flow/preflight.json`. A round left undelivered by an ended session is
  closed unsent on load, and a round already past its wait is closed when the next manager is
  spawned, so old rounds never swallow a new one.
- Standing answers: answer a recurring inbox question once. `mcp__flow__answer` takes `always: true` per
  answer (main only) and adds a rule to the personal `config.json`; the new `standing_answers` setting
  (`topic` or `match`, `answer`, `blocking`, `from`) answers matching fresh questions at once, with
  `answeredBy: "standing answer"`, no message to the addressee, a decision note and an `auto-answer` log
  event. A blocking question is answered only by a rule with `blocking: true`.
- `mcp__flow__standing` (main only): `list` (with suggestions for questions answered the same way 3 or
  more times), `add`, `remove`.
- `/flow inbox` shows an "Auto-answered" section (last 24 h) with the rule ids to revoke; `status` has a
  count line. The `ask` tool tells agents to give recurring questions a stable kebab-case `topic`.

## [0.3.27] - 2026-10-10

### Fixed

- Cleanup sweep: type links (`types`, `.claude-plugin/types`, symlinks only) are deleted before a plain
  `git worktree remove`, so a worktree with only those untracked links goes; any other untracked file
  still keeps it. `--force` is never used.
- Cleanup sweep: a branch tip not on the base counts as landed when every file its commits changed is
  identical on origin/main and a merged PR exists for the branch (or its `-N` sibling). The dropped
  commits (short sha and subject) are listed in the sweep text and the `clean` log event.
- A handoff whose branch has a merged PR no longer keeps its worktree waiting.
- A lock `claude agent agent-<id> (pid P ...)` is stale when P is this Claude process and no agent
  `<id>` is in the roster.

## [0.3.26] - 2026-10-10

### Added

- `mcp__flow__ask`: an agent asks one or a batch of questions, each with options, a recommended
  default and whether it is blocking. A worker's goes to its manager, a manager's to the user.
  Non-blocking: the asker goes on with the default and says in its PR what it assumed; blocking:
  it ends its turn and the answer arrives by message.
- `mcp__flow__answer`: answers by id (option text, letter, number or free text) or accepts the
  defaults. The answer is messaged to the asker and recorded as a decision note; one for an
  asker that is gone is reported undelivered so main relays it to the successor.
- The inbox, kept in `<git-common-dir>/flow/inbox.json`, survives restarts. `/flow inbox` lists
  it numbered, grouped by owner, blocking first; `status` and the Flow pane show it first.
- An agent with an open blocking ask counts as asking in the pane, the toasts and the task graph.

### Changed

- Worker and manager prompts and the dispatch skill ask and answer through the tools. A report
  whose last line ends in "?" still counts as a question.

### Deprecated

- `decision_phrases`: still honoured; use `mcp__flow__ask`.

## [0.3.25] - 2026-10-10

### Added

- Collapsible cards in the Flow pane: `c` collapses or expands the highlighted card, and the
  chevron (clicking elsewhere on the card still opens it) does the same. Managers and the merge
  queue start collapsed to one line, with asks, handoff and awaiting-approval warnings summed for
  hidden workers; workers start expanded. `q` toggles the Merge queue section. Choices stick
  while the pane is open.

## [0.3.24] - 2026-10-10

### Added

- `merge_mode` (`auto` default, or `confirm`): `confirm` holds handed-over PRs until you run
  `/flow approve <n>`. PR labels `flow:confirm` / `flow:auto` override it (both: confirm), and
  `mcp__flow__handover` takes an optional `mode` (managers can only raise to `confirm`).
- Awaiting PRs show in the pane, `status` and `/flow resume`. The queue re-checks labels and the
  approved head when it takes a PR and skips one that answers "Held:".
- Managers mark risky PRs (migrations, deploy/infra config, auth, deletions, irreversible
  operations) `confirm`.

## [0.3.23] - 2026-10-10

### Fixed

- Continuing a handed-off worker failed with "names no agent this call can dispatch": hiding `flow:continue`
  from the model also refused the plugin's own rewrite. It is now offered only while that rewrite dispatches,
  and if the host still refuses it the spawn falls back to a plain `flow:worker` in a new worktree and the
  worktree claim is given back.

## [0.3.22] - 2026-10-10

### Added

- `handover` refuses a PR whose description lacks a valid `## Verification` section (Ran, Exercised,
  Not verified; every `worker_checks` and `always_tests` command under Ran). The evidence is stored
  on the handover and shown in `queue list`, `status`, the queue's report and the status file.

### Changed

- The worker prompt asks for the section; the manager prompt checks it against the diff.
  The `verified` input of `handover` is optional.

## [0.3.21] - 2026-10-10

### Added

- `context_warn_percent_1m` (default 35): the handoff percent for agents on a 1M window.
  `context_warn_percent` (40) now applies to smaller windows only.

### Changed

- An agent's window is the one it was started with (`[1m]` in the model it was finally spawned
  with means 1M; a plain model keeps the old rule), not a guess from the step's model id. A `sonnet[1m]` worker was told to hand
  off at 80k when the step model lacked `[1m]`.
- `context_warn_tokens` now defaults to 0 (off); it stays an optional cap over both percents.
  Set it to 350000 for the old behaviour.
- Note: a `worker_model` saved in /config as plain `sonnet` (the old default) overrides the
  `sonnet[1m]` default. Set it to `sonnet[1m]` or clear it.

## [0.3.20] - 2026-10-10

### Added

- Digest of a worker in another harness, from the harness's own log (`digest` in a harness spec;
  built in for codex, from its rollout file in `~/.codex/sessions`, and for claude, from its
  transcript): its last three actions, its last words and its context fill, on its card, in its
  detail view and in the idle notice to its manager.
- A turn that the harness's log says ended, with no report 15 s later, makes the worker idle at
  once, ahead of the 90 s quiet-screen rule.
- Controls in a session's detail view, run without a model turn: keys `1` `2` `3` `y` `n`, `e`
  Enter, `z` Esc, `i` Ctrl-C; `r` restart and `x` stop on a second press within 5 s. The view
  also shows where it runs and the last lines of its screen.
- Quota meters on the root card: Claude's windows (`$.session.usage()`) and Codex's (its logs),
  the share left, the reset, and when the current pace runs it out.

## [0.3.19] - 2026-10-09

### Added

- Workers in any harness: the `session` tool lets a manager run a worker as Codex, Claude on its
  own, Gemini, OpenCode, a harness from the `harnesses` setting or any command line, in an Orca
  terminal or a tmux session, and drive every one the same way: `start`, `send` (a message),
  `keys` (Enter, Escape, Ctrl-C, arrows, or text, for prompts and menus), `read`, `restart`
  (resuming its conversation where the harness has a resume line), `list`, `stop`.
- The plugin makes the worktree on `flow/<name>`, writes the prompt (worker rules plus brief) to
  `<git-common-dir>/flow/sessions/<name>/prompt.md`, and watches three things the same way for
  every harness: the report file the worker writes (sent to its manager as a message), the screen
  (unchanged for 90 s with no report: the manager is told it is idle, with the screen), and the
  terminal (gone or back at its shell: told once).
- A start checks the harness's program is installed, and for a harness with a quota reader
  (Codex's own rate-limit logs built in, or a command) that at least `min_quota` percent is left;
  otherwise it is refused and the manager starts an agent worker instead.
- Sessions show in the pane as workers under their manager and count as live for plans,
  `status`, `/flow resume` and the cleanup.
- Settings `worker_harness` (`agent` default: unchanged), `session_host` (`auto`, `orca`,
  `tmux`), `harnesses` (name to a start line or `{start, resume, program, quota}`) and
  `min_quota` (default 10).

## [0.3.18] - 2026-10-09

### Fixed

- The Flow pane was blank whenever a PR had been handed over: the Merge queue rows used a callback
  parameter named `h`, which shadowed the JSX factory, so every draw threw `h is not a function`.
  The parameter is renamed, and a new test fails if any `hooks/*.tsx` scope containing JSX binds `h`.
- If drawing the pane throws, it now shows `flow: pane failed to draw: <message>` instead of nothing.

## [0.3.17] - 2026-10-09

### Added

- Cleanup of finished work: `/flow clean` lists leftover worktrees under `.claude/worktrees/` and
  local branches, what would be removed and what is kept for a person and why; `/flow clean --yes`
  and the `clean` tool (`apply`) remove only clean work that is on the base or in a merged PR (by
  head sha, so squash merges count), or pushed with its PR closed. Uncommitted, unpushed, locked
  and live work is never touched. Removals are logged as `clean` events.
- `cleanup` setting (`auto` default, `off`): with `auto` the safe sweep runs in the background after
  each PR the queue marks done and when the queue ends.
- The pane and `status` show one line while leftovers exist.

### Changed

- README settings table now lists all 27 options with a "Set in" column (`/config` or file only); the long `decision_phrases` detail moved below the table.
- `manager_model` and `queue_model` each describe only their own role in `/config`.
- A handed-off worktree whose only untracked files are the `types` links counts as clean for the
  continuation in place.

### Fixed

- README gave `language` a default of "none"; it is `English`.

## [0.3.16] - 2026-10-09

### Added

- `decision_phrases` now works: a report whose last paragraph contains one of the phrases
  (case-insensitive) counts as a question, in the pane, the toasts and the task graph, unless the
  phrase directly follows a negation such as `不`, `不需要`, `no ` or `not `.

## [0.3.15] - 2026-10-09

### Added

- Settings now shape the prompts: `worker_checks` and `always_tests` are hard requirements for workers (no PR if a check fails; the report lists every command run), `language` adds a language line to worker, manager and queue, `big_files` and `big_file_lines` tell agents not to read big files whole, `migrations_dir` adds the migration numbering rules for worker, manager and queue.

## [0.3.14] - 2026-10-09

### Added

- Settings per repo: `.claude/flow.json` (flat JSON, the same keys as `/config`) and a personal
  overlay `<git-common-dir>/flow/config.json`. Precedence: defaults, `/config`, repo file,
  personal file. The personal file's `worker_checks`, `always_tests`, `big_files` and
  `decision_phrases` are added to the repo file's. An unknown key, bad JSON or a wrong type warns
  and the layer below applies. The files are re-read every few seconds by mtime; new settings
  apply to agents started afterwards.
- `manager_model` and `queue_model` (default `opus`); `worker_model` now defaults to
  `sonnet[1m]` and falls back to `sonnet` once, with a warning, if the engine refuses `[1m]`.
- Keys read but not yet wired into the prompts: `language`, `big_files`, `big_file_lines`,
  `migrations_dir`, `decision_phrases`, `worker_checks`, `always_tests`.

### Changed

- Sub-agents don't run on Fable: refused in settings, denied at spawn for flow agent types and
  for agents started by a flow agent.

## [0.3.13] - 2026-10-09

### Added

- Graph view in the Flow pane. `g` switches between the tree and the plan's dependency graph, at the
  top level and inside a manager; `h` `j` `k` `l` move the highlight, `o` opens a node's agent,
  waiting nodes show without an agent, managers carry `+N workers`, and narrow panes fall back to a list.

## [0.3.12] - 2026-10-09

### Added

- Handoff parity with orca-flow. On a worker's `HANDOFF: <branch>` a transcript digest is
  written to `handoffs/<branch-slug>/<n>.md` in the state directory, with a `handoff` log event.
- The continuation worker gets the digest (capped at 4k) and, when the old worktree is clean,
  at `origin/flow/<x>`, its agent has ended and no other spawn claimed it, runs in that
  worktree through the new non-isolated `flow:continue` type. Otherwise it gets a new worktree
  and the old one is removed if clean and behind.
- `max_continues` setting (default 2): past it the owning manager is told to split the package.

### Changed

- Managers no longer remove worktrees on handoff.

## [0.3.11] - 2026-10-09

### Added

- Handoff on the Flow pane's cards. A live agent that was told to hand off shows a `handoff`
  badge and "wrapping up (told at N%) · M reminders"; once it ends with a `HANDOFF:` line the
  card shows "handed off → ..." and is not dimmed. The detail view has a "Handoff:" line and
  `mcp__flow__status` carries the same suffixes.

## [0.3.10] - 2026-10-09

### Fixed

- A `sonnet[1m]` worker is measured against 1M (hands off at 350k, not 80k): the agent keeps the engine's `[1m]` id when the API's usage id lacks it. The pane meter shows the token limit (`350k│`) when it is the one in force.

## [0.3.9] - 2026-10-09

### Fixed

- Fix: hooks module failed to load (local variable shadowed startQueue)

## [0.3.8] - 2026-10-09

### Added

- Flow's state survives a restart. It is written to `<git-common-dir>/flow/`:
  `handovers/<pr>.json` (one file per handed-over PR), `log.jsonl` (one JSON event per line)
  and `managers/<key>/notes.md` (a manager's notes). `config.json` in that directory is
  reserved for the settings loader.
- Persisted handovers are loaded when a session starts, so the queue and `status` see PRs
  handed over before the restart.
- `log.jsonl` records events such as a manager or worker spawning and reporting back.
- `mcp__flow__note` tool: managers and the main session record notes of kind `decision`
  or `progress`; they are appended to the manager's `notes.md`.
- `mcp__flow__status` shows which manager owns each PR, by PR number.
- `/flow resume` reads the state dir: handovers by owner, each manager's notes, and PRs that
  merged since are shown as done. The main session starts one manager per task from that.
- Notes rules: managers read their notes first and note each decision the user makes and
  each step they finish; the main session notes the user's instructions to managers. A
  resumed manager writes notes under its owner's name.
- README section "State on disk".

## [0.3.7] - 2026-10-09

### Added

- Pane hotkeys `j`/`k`/`o`/`c`, a tree that stays usable with 10 to 20 managers (auto-collapse, `↑ N above`, `+N more`), and a pane that follows the agent whose chat is in view.

## [0.3.6] - 2026-10-09

### Added

- `test_slot` tool and `test_slots` option (default 1): at most that many heavy test runs
  at once across all agents. Workers acquire before a whole suite or any long run and release
  after; the queue does so around the full check. Waiters queue first come, first served;
  slots free when the agent ends or after a 45 minute lease. `mcp__flow__status` and the
  status line show the holders. A free slot is granted to the head waiter at once, signalled
  by a `.granted` file in the git common dir and a message; the waiter confirms with one
  `acquire` within 2 minutes or the grant passes on, so waiting costs no tool calls.

## [0.3.5] - 2026-10-09

### Added

- Dependencies: the `mcp__flow__plan` tool declares which tasks or packages wait for others,
  with states (waiting, ready, running, done, blocked), cycle refusal, refusal to start an agent
  whose node is waiting, and one `flow plan:` wake-up per pass to the owner. Plans show in
  `mcp__flow__status`.
- `max_managers` option: how many managers the main session runs at once (default 20).

### Changed

- The dispatch skill and the manager prompt use plans for work that needs other work's merged code.
- The managers limit is a setting (it was fixed at 3).

## [0.3.4] - 2026-10-09

### Added

- Process guard: `pkill`, `killall`, `kill` of pid `-1`, `0`, `1` or a process group, and
  `kill` fed by `lsof` without `-sTCP:LISTEN` are refused for every agent and the main session,
  with a refusal that says to find the pid and `kill <pid>`.
- Main-checkout guard: Edit, Write, NotebookEdit and obvious shell writes (redirects, `tee`,
  `sed -i`, `cp`/`mv`, `rm`, `touch`, `git commit` and other checkout-changing git commands)
  aimed at the repo's main checkout are refused for every agent and the main session.
  Worktrees, `.git/` and files outside the repo stay writable. New settings
  `main_checkout_guard` (default on) and `main_checkout_allow` (default `.claude/`).

## [0.3.3] - 2026-10-09

### Added

- Open `flow/*` PRs that nobody handed over (and whose worker has ended, or whose handover was returned)
  show under "Needs attention:" in `mcp__flow__status` and as one warning line on the pane. The PR list
  comes from `gh pr list` every 5 minutes, and on a status call at most once a minute. A gh failure shows
  one line in status and keeps the last list.

## [0.3.2] - 2026-10-09

### Added

- `context_warn_tokens` (default 350000, 0 = off). The handoff limit is the lower of it and
  `context_warn_percent` of the window; it also places the meter marker and yellow point.
- The wrap-up reaches a busy agent: a reminder is appended to its tool results (first call past
  the limit, every 10th, every +10 points), besides the message for an idle one. Never denies.
- The main session gets one toast and log line per crossing while flow agents exist; no auto-compact.

### Fixed

- The context window guess strips `[1m]`, date suffixes and `-latest` when matching models, and
  usage above 200k means a 1M window, so percents are no longer inflated.

## [0.3.1] - 2026-10-09

### Added

- `deploy_targets`: ordered deploy targets with backup, deploy, health check (the pushed sha) and verify notes; the queue stops at the first failing target and reports it. `deploy_command` still works as one target named `default`.
- `state_file`: a status file only the queue edits, one entry per batch, older entries archived.
- The queue acts on `after_deploy` (a check-only worker, or a "needs a person" line) and reports `pending` decisions. Workers understand "Check only:" briefs.

## [0.2.9] - 2026-10-09

### Changed

- The Flow pane's colors follow the light or dark theme (theme keys instead of fixed colors).
- Cards are quieter: no brackets around buttons, short activity summaries instead of raw
  commands, the description only while there is no activity, borders only on top-level cards,
  and `(+N)` after the name for the agents under it.
- The meter line shows elapsed time and tokens (`42%   1m 43s · ↓ 84.0k tokens`), like the
  native subagent row; the detail view says when the agent was last active.

### Added

- The pane redraws when the theme is switched.

## [0.2.8] - 2026-10-09

### Added

- Handoff: a worker or manager that reaches `context_warn_percent` gets one notice (and a
  toast). A worker commits, pushes, keeps a draft PR with a `## Handoff` note and ends with
  `HANDOFF: <branch>`; its manager starts `<name>-2` on the same branch with the note and
  removes the old worktree only when it is clean and pushed. A manager waits for its workers,
  then ends with `HANDOFF: manager <name>`; the main session starts `<name>-2`. New option
  `handoff` (default on) turns it off.
- `/flow resume` lists unfinished flow work after a restart (open `flow/*` PRs, pushed branches
  without a PR, worktrees with leftover work) and has the main session start `resume-<slug>`
  managers for it.
- Workers continue earlier work with `Continue on branch: flow/<x>` in the brief.

### Changed

- The `/flow` usage line and argument hint now read `[close|resume]`.

## [0.2.7] - 2026-10-09

### Added

- Task sources: a markdown doc per source at `.claude/flow/sources/<name>.md` with List, Render
  and Write-backs sections (`skills/dispatch/references/sources.md`), and a ready GitHub Issues
  source to copy (`skills/dispatch/examples/github-issues.md`).
- `/flow-tasks [source] [ids or filter]`: the super manager picks tasks from a source and starts
  a manager for each.
- Managers started from a source draft every write-back (comments, status moves) for the user's
  OK before writing it.

## [0.2.6] - 2026-10-09

### Added

- `/flow close` closes the Flow pane; with the pane not open it says so. Plain `/flow` still
  opens it. A closed pane stays closed while agents keep running (the roster poll never opens
  it); the next `/flow` or a newly started agent opens it again.

## [0.2.5] - 2026-10-09

### Added

- Every agent in the Flow pane (the main root, managers, workers, the merge queue, and the
  agents under one in its detail view) is a card with a context meter: a bar, percent and
  tokens, with a marker at the warning threshold. The meter turns yellow past the threshold and
  red from 90%; unknown usage shows `context ?`.
- Option `context_warn_percent` (default 40, 1 to 100): where the meter's marker sits.

### Changed

- On a short terminal the cards shrink to one-line rows, and `+N more` shows what doesn't fit
  instead of dropping it silently; the header and the root row stay visible.

## [0.2.4] - 2026-10-09

### Added

- The Flow pane tree starts with a root row for the main session (super manager); managers
  and the merge queue sit under it.
- An agent's detail view lists the agents under it as buttons that open their detail view.

### Changed

- Back in the detail view returns to the parent agent, or to the tree from a top-level agent.

## [0.2.3] - 2026-10-09

### Changed

- Renamed from flow-board to flow: the plugin and marketplace are `flow`, the agent types
  `flow:manager`, `flow:worker`, `flow:queue`, the skill `flow:dispatch`, and the tools
  `mcp__flow__handover`, `mcp__flow__queue`, `mcp__flow__status`. Install with
  `/plugin install flow --marketplace Ying-Kai-Liao/flow`.
- The dispatch skill leaves work run through Orca to the orca-flow skill.

## [0.2.2] - 2026-10-09

### Fixed

- Removed two agent worktrees that 0.2.1 committed by mistake, and ignored `.claude/worktrees/`.

## [0.2.1] - 2026-10-09

### Fixed

- Managers name workers `<manager>-<package>`, so a worker never shares its manager's name and
  messages reach the right agent (a manager and its worker were both named `changelog`).
- The base branch is found on a fresh clone with no `origin/HEAD`, by asking the remote.

## [0.2.0] - 2026-10-09

### Added

- Managers, workers and a merge queue in one session. The main session is the super manager
  (the `dispatch` skill) and starts one `flow-board:manager` per task.
- `flow-board:manager` owns a task: it writes briefs, starts `flow-board:worker` agents in git
  worktrees of their own, and reviews their PRs. Managers can't edit code.
- `flow_handover` tool: a manager hands an approved PR to the plugin, which records its head and
  starts a `flow-board:queue` agent if none is running.
- `flow-board:queue` agent: merges handed-over PRs, runs the full check, pushes and deploys.
  Its worklist is the `flow_queue` tool (`list`, `take`, `done`, `back`).
- `flow_status` tool: the tree and the handed-over PRs as text, for check-ins.
- Options (`/config` → flow-board): `test_command`, `full_check_command`, `deploy_command`,
  `merge_queue`, `merge_method`, `max_workers`, `worker_model` and `base_branch`. An unset full
  check or deploy is skipped and reported, not improvised.

### Changed

- The Flow pane draws the tree of the main session, managers and workers, and the PRs handed to
  the queue, instead of a flat list of workers.
- The status line reports managers, workers and queued PRs, for example
  `flow: 2 managers · 3 workers · queue: 1 PR · /flow`.
- The README describes the roles, settings and tools above.

## [0.1.0] - 2026-10-09

### Added

- Parallel coding workers in one Claude Code session. Workers are background subagents of the
  main session, each in a git worktree of its own, started through the `flow-board:worker`
  agent type.
- The Flow pane (`/flow`): one row per worker with its status. Click a row to see that worker's
  tool calls and final report; **Message** starts a message to the selected worker in the
  prompt, **Back** returns to the list.
- A status line with the count of live and ended workers.
- Toasts when a worker finishes its turn, asks a question or changes status.
- Moved out of orca-flow (`mod/flow-board`, #21) into a plugin of its own, with a marketplace
  file so it installs with `/plugin install`.

[0.2.0]: https://github.com/Ying-Kai-Liao/flow-board/commit/314ae64
[0.1.0]: https://github.com/Ying-Kai-Liao/flow-board/commit/8828e2f
