# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- The plugin directory's MOD_CAPABILITY_USE_NOT_PLAIN finding at the `flowToolsIoOf($, settings, options)` calls, at its source: the four `$` shapes register.tsx gained after 0.6.84 (the last release the directory passed) are gone. agentsOf no longer spreads `await $.agent.list()` inside square brackets, the pane's `resolve` has no cast inside `$.ui.resolve(...)`, nothing spreads a call passing `$` into an object (`...guardIoOf($)`, `...relayIoOf($)`, `...relayRunIoOf($)`), and nothing reads `.updateSessions` straight off `sessionIoOf($)`. flowToolsIoOf and paneIoOf now hold only plain `$.noun.method(...)` calls or single calls passing `$` to a function in the file. `scripts/plain-names.mjs` gains check 7, which follows `$` from each hook through the file's functions: it reports 2142, 2145 and 2151 on 0.6.109 and nothing on 0.6.84.

## [0.6.109] - 2026-10-14

### Fixed

- The plugin directory's MOD_CAPABILITY_USE_NOT_PLAIN finding at the `flowToolsIoOf($, c, e)` calls in register.tsx: no closure holds `$` and a hook's event together any more (flowToolsIoOf takes settings and options, the flow tool cases pass the call to the io methods that need it, and the pane's `resolve` takes the render event). `scripts/plain-names.mjs` gains check 6, which reports those call sites on 0.6.103 and 0.6.108 as the directory did.

## [0.6.108] - 2026-10-13

### Added

- README: a "How it works at a glance" section with two diagrams, the architecture and the life of a task, in light and dark SVG with interactive HTML versions and their sources under `docs/diagrams/`.

## [0.6.107] - 2026-10-13

### Changed

- Add reviewer_delay: close handovers share one reviewer batch (#209)

## [0.6.106] - 2026-10-13

### Fixed

- The plugin's fast-forward of the main checkout no longer fails at random with "ff failed: From https://...". Its `git pull` raced the auto cleanup sweep's `git fetch origin --prune`, which starts on the same reviewer "done": both update `refs/remotes/origin/<base>` in the shared `.git`, and the loser gets "cannot lock ref". The sweep now starts only after the fast-forward, and the fast-forward fetches (retrying up to three times on a lock error, for other concurrent fetches such as the reviewer's own) and merges `--ff-only` separately, and a failure reports git's last `error:`/`fatal:` line instead of the fetch's "From <url>" line.
### Added

- `reviewer_delay` setting (minutes, default 3; 0 = start at once): a handover on an idle queue starts the reviewer only after the wait, and handovers during it join, so PRs handed over close together land in one batch (one reviewer start, one full check, one release). An approval starts at once unless a wait is running, then joins it; push and rebuild runs, due deploys, leftover work and a session start never wait.

## [0.6.105] - 2026-10-13

### Changed

- Fix agent.register and $-plain directory findings in register.tsx; guard both (#207)

## [0.6.104] - 2026-10-13

### Changed

- One `mode` setting (`agent` default, `orca` or `tmux`) for the whole run. In `orca` or `tmux` every manager, worker and the reviewer runs in that host; managers and the reviewer are always claude, workers run `worker_harness` (claude by default). In `agent` mode `mcp__flow__session` `start` is refused. No mixing: a host that is not up refuses the start (a manager's Agent call is denied; the reviewer's handover stays pending) instead of falling back to the other host or an agent. Terminal managers' prompts say to start workers with `mcp__flow__session`, not the Agent tool.

### Removed

- The `manager_harness`, `reviewer_harness` and `session_host` settings and the session tool's `host` parameter. A file that still has them is read once per load with a toast: a terminal manager or reviewer harness maps to mode `session_host` (`orca` or `tmux`, else `orca`).
### Fixed
- Plugin directory checks: `$.agent.register` takes its spec as an object literal written in the call (MOD_PERMISSION_ANSWER_UNREAD), and the `(await f($, x))?.y` / `[...]` reads in hooks/register.tsx go through a const (MOD_CAPABILITY_USE_NOT_PLAIN); `scripts/plain-names.mjs` now guards both.

## [0.6.103] - 2026-10-13

### Fixed

- The plugin loader rejected `hooks/register.tsx` (`MOD_CAPABILITY_USE_NOT_PLAIN`) because two `runFlowTool($, ...)` calls were wrapped in parentheses and `!`; they are plain statements now, and `scripts/plain-names.mjs` (run by `npm run typecheck`) flags the pattern under `hooks/`.
### Added

- `docs/task-lifecycle.md`: a walkthrough of one task from request to cleanup, naming the `hooks/` module behind each step.

## [0.6.102] - 2026-10-13

### Changed

- The demo replay's code moved out of `hooks/register.tsx` into `hooks/demo-run.ts`, and "Where code goes" in the reference now maps each hook to its module (no behaviour change).

## [0.6.101] - 2026-10-13

### Changed

- Move the disk relay and terminal role-session code out of hooks/register.tsx into hooks/relay-run.ts and hooks/role-session-run.ts (no behaviour change)

## [0.6.100] - 2026-10-13

### Changed

- Internal: the session.start hook body and the settings loading moved to hooks/startup-run.ts; no behaviour change.

## [0.6.99] - 2026-10-13

### Changed

- Throttle Flow pane redraws (#203)

## [0.6.98] - 2026-10-13

### Changed

- Internal: the generic tool.call hook body, the main-checkout guard, the wrap-up reminder and the flow tools' multi-line cases (guard_tests, note, clean, push, session, deploy, release, reviewer) moved from hooks/register.tsx to hooks/toolcall-run.ts; no behaviour change.
### Changed

- The Flow pane redraws background updates (activity, ledger, roster, clock) at most about 4 times a second with a trailing redraw, skips draws that change nothing, reads each atom once per draw and caches session usage for 1 s; key presses and selection still redraw at once

## [0.6.97] - 2026-10-13

### Changed

- Move the Flow pane's hook bodies into hooks/pane-run.tsx (#200)

## [0.6.96] - 2026-10-13

### Changed

- Move the agent.spawn hook body into hooks/spawn-run.ts (no behaviour change)

## [0.6.95] - 2026-10-13

### Changed

- Internal: the turn.step and turn.complete hook bodies and the handoff recording moved from hooks/register.tsx to hooks/turn-run.ts; no behaviour change.
### Changed

- Internal: the Flow pane's hook bodies (draw and focus) moved from hooks/register.tsx to hooks/pane-run.tsx; no behaviour change.

## [0.6.94] - 2026-10-13

### Changed

- Group duplicate questions across managers: one row, one answer (#197)

## [0.6.93] - 2026-10-13

### Changed

- Best-of-N competing workers (opt-in) (#193)

## [0.6.92] - 2026-10-13

### Changed

- Reviewer carries many PRs per full check (batch_max, late join, bisect, timeout rerun) (#192)
- Typecheck slot pool; workers run only their test files (#194)
### Added

- Best-of-N, opt-in (`best_of_n` off | brief | auto, `best_of_n_arms` 2..3): a manager may start 2-3 competing agent workers on one brief, named `<pkg>-a`/`-b`/`-c` with an `Arm: <letter> of <N>` line. The spawn hook refuses an arm spawn that breaks the protocol (setting off, too many arms, wrong letter or name, not a manager, over `max_workers`); arm ledger rows carry `arm` so cost per arm is recorded. The new `mcp__flow__arms` tool picks the winner (`pick` closes the other arms' PRs, logs `arm-pick` / `arm-lost`, names losers that still run) and reports cost per arm and the group's overhead over the winner (`report`). Handover refuses an arm's PR unless it is the picked winner; the "PR nobody handed over" list skips open arm groups and losers; the cleanup removes a loser's worktree and local branch once it is pushed with its PR closed. Arms count as one package in the size digest, the size A/B report and the decide-eval size data. Docs: Best of N.
### Added

- Duplicate question groups: the same open question (same topic and options, or same text and options) from several managers shows once in `/flow inbox`, the Flow pane and `mcp__flow__status` (`x3` and the askers), and one answer from main or the user answers every open member. Deploy, env, push, reviewer, guard and escalated items are never grouped.

## [0.6.91] - 2026-10-13

### Changed

- The reviewer (agent or terminal) queues ahead of worker and main waiters for a test slot, so its full check no longer waits behind every worker's run; it never preempts a holder or an offered grant.

### Added

- Unit tests for the `/flow` command dispatch (`tests/command.test.ts`), the usage accounting behind `turn.step` and `turn.complete` (`tests/usage-run.test.ts`: tokens in the ledger, a turn counted once, the hand-off warning) and the pane's body-rows sizing (the key-hint row stays last when the tree overflows).

### Added

- Standing rules settle the inbox. After main answers, `mcp__flow__answer` offers (once, with the exact `mcp__flow__standing` add call) a rule for any topic or exact question answered the same way 3 or more times, and the Flow pane's inbox shows it as a `+ rule?` line (`s` hides it); `mcp__flow__standing` has a `dismiss` action. Kept decisions are covered: a rule with `kinds: ["fyi"]` and answer `Keep` keeps matching decisions the moment they are recorded, before `decide_inbox`, and stays undoable. Topics compare normalized (case, `_`/`-`/space, one trailing "s"), and a rule made from a topic-less question records its option set. Nothing is added without your add call; deploy, env, push, reviewer and person-check items are never auto-answered or suggested.

### Added

- Direct unit tests for `hooks/resume.ts` (leftover gathering, disk items, resume instructions), `hooks/reviewer-route.ts` (send guard, report routing, need lines) and `hooks/roster-run.ts` (plan owner, manager ownership, live managers).

## [0.6.90] - 2026-10-13

### Changed

- Live-test fixes: lite line, manager report write, relayed ask test (#195)
### Fixed

- `mcp__flow__answer` with `defaults: true` and no `ids` no longer answers blocking questions: it skips them and says so; naming one in `ids` still takes its default.

## [0.6.89] - 2026-10-13

### Changed

- usage-command tests (WIP) (#187)
### Fixed

- A task line that merely starts with "Mode: lite" (such as "Mode: lite is NOT wanted") no longer starts the manager in lite mode; only a line that is exactly `Mode: lite` does.
- A terminal manager can write its own session report file (`sessions/<name>/report.md`); every other edit stays refused.
- Test that a blocking ask relayed from a terminal manager stays open in main's inbox and cannot be answered by the manager.
### Added

- Bigger reviewer batches: PRs that arrive before the full check join the batch (also after a failed check's rework) up to the new `batch_max` setting (default 10; 1 = one PR per batch). On a failure that does not belong to one PR the reviewer bisects the batch to the PR that breaks the check, and a failure where every test timed out is rerun once before it counts. The pushed sha is still always one whose exact tree passed the full check.
### Added

- Typechecks (`npm run typecheck`, `tsc`, `npx tsc`) take a lock of their own: `test_slot` with `kind: "typecheck"`, settings `typecheck_slots` (default 1) and `typecheck_commands` (empty: off), a 10 minute lease, shown in the Flow status line as `tsc 1/1`. The hook refuses a typecheck without a typecheck slot (a test-slot holder, like the reviewer's full check, may typecheck).
- `scripts/test-files.sh` runs only the named test files (`claude plugin test` takes a folder, not files), or with `--jobs N` the whole suite in chunks of N files to cap the runner's child processes.

### Changed

- A worker's whole-suite run is refused even when it holds a test slot; workers run only the files they touched. The worker prompt says so. The reviewer's full check is unchanged.
- `claude plugin test --help`, `-h` and `--version` are no longer treated as suite runs.
- docs: the runner starts min(files, CPU cores) child processes, not one per file; sizing advice for `test_slots`.

## [0.6.88] - 2026-10-13

### Changed

- Relay ownership per main; subagents of a terminal manager read-only (#185)

## [0.6.87] - 2026-10-13

### Added

- Claude terminal sessions get flow's routed reasoning effort as `--effort <level>` on their start line: terminal managers (`manager_effort`), the terminal reviewer (`reviewer_effort`) and session workers (`worker_effort_small` / `worker_effort_normal` / `worker_effort` by the brief's `Size:` line). `inherit`, empty, an unknown level or `CLAUDE_CODE_EFFORT_LEVEL` in the environment passes nothing.
### Fixed

- Two main sessions in one repo no longer both pump and deliver for the same terminal manager or reviewer: each role session records its owning main (session id and pid), a main handles only its own, and takes over ones whose owner is gone or unrecorded. A subagent of a terminal manager can now only read through the flow tools (status, guard_tests, migrations, test_slot, list actions); its writes are refused.
### Added

- Tests for the reviewer terminal re-tell (a due deploy or push run is typed again only when its signature changes) and for the gone-reviewer relay to main.

## [0.6.86] - 2026-10-13

### Added

- `manager_harness` and `reviewer_harness` now take effect. With a claude-running harness, main's `flow:manager` spawn starts a terminal session (the Agent call is answered with a refusal worded as a success, so the manager is not spawned twice), and the reviewer runs in a terminal: one long-lived session while `merge_mode` is auto (new handovers, due deploys and a push run are typed into it once, a block keeps the terminal), one batch in confirm mode (the terminal is stopped after its report and the next handover starts a fresh one). Manager and reviewer reports and ended terminals reach main and the reviewer circuit breaker as an agent's would. With both settings at `agent` nothing changes. Docs: Managers and the reviewer in a terminal.

## [0.6.85] - 2026-10-13

### Added

- The disk relay is wired in. A plugin copy started in a terminal with `FLOW_ROLE`/`FLOW_NAME`/`FLOW_RELAY` is passive for a worker (no tools, no state, no timers) and forwards every flow tool call of a manager or the reviewer to the main session, which runs it as that session (`session:<name>`); main pumps the relay directories every 500 ms while a role session is live. A role session counts as a manager or the reviewer wherever a caller is identified (pre-flight gate, plan, notes, handover, deploy, `report_to`), and a message to a session goes by typing it into its terminal, also from `SendMessage`. The sessions record is saved to `sessions.json` in the state dir and read back at start. Nothing starts a role session yet, so with the default `agent` settings nothing changes.

### Fixed

- A worker started as a Claude session no longer wipes main's test-slot grants when its own plugin copy starts.

## [0.6.84] - 2026-10-12

### Added

- Building blocks for running managers and the reviewer as terminal (Orca or tmux) claude sessions: `manager_harness` and `reviewer_harness` settings (default `agent`, today's behaviour; only a claude-running harness is accepted), a disk relay (hooks/relay.ts) that forwards a terminal session's flow tool calls to the main session, role-aware session rows, start, watch and message delivery (hooks/sessions.ts, hooks/session-run.ts), and the manager and reviewer terminal prompts. Not wired in yet.

### Changed

- A session worker's command line now starts with `FLOW_ROLE=worker FLOW_NAME=<name>`; the clean sweep keeps the worktree of an idle session; a Claude session's turn end is read from its transcript.

## [0.6.83] - 2026-10-12

### Added

- The Flow pane renders markdown in free text (hooks/markdown.tsx, no dependency): question, context and decision text, PR card rows, batch titles and checks, agent reports. Headings, bold, italic, code, lists, quotes, tables, links and rules are drawn with the pane's theme colours; one-row places show the text with markers stripped. Unknown syntax stays as literal text.

## [0.6.82] - 2026-10-12

### Changed

- Esc returns to the Flow pane home view; drop duplicated inbox hint (#175)

## [0.6.81] - 2026-10-12

### Changed

- Ask cards: skip AskUserQuestion notice while the Flow pane is open (#176)
### Added

- Esc in the Flow pane returns to the home view from any sub-view (inbox, cards, archive, PR and batch cards, agent views, the demo) and never closes the pane; an unsent draft is kept, and a focused field only blurs on its first Esc. Sub-views show a dim "esc home" hint, and `/flow home` does the same reset

### Fixed

- The Flow pane no longer shows the inbox key hint twice: the questions row and the "and N more" row drop their "i" hint, which the key row already shows as "i inbox"

## [0.6.80] - 2026-10-12

### Changed

- Size A/B: opt-in daily Jev vs Size-line arms with per-arm cost report (#174)
### Fixed

- A blocking question, env item or deploy approval no longer also reaches main as an AskUserQuestion card while the Flow pane is open (the pane already shows it, and a card left open there went stale); with the pane closed the notice is sent as before, and it re-checks that the items are still open right before sending

## [0.6.79] - 2026-10-12

### Changed

- The plugin and marketplace description now reads "with Jev picking the right model for each task to keep cost down", claiming only the model choice that the decide_eval route test measured
### Added

- Size A/B: opt-in `size_ab` setting (default off). With `daily` and `decision_api` jev, spawns alternate by local day between Jev sizing and the Size line alone, each tagged `sizeArm` in the cost ledger; the main-only `size_ab_report` tool and `scripts/size-ab.mjs` print $ per merged PR, the -N successor rate and the model mix per arm

## [0.6.78] - 2026-10-12

### Added

- Size feedback: each manager's spawn prompt gets a short digest of how this repo's earlier workers' Size lines turned out (reruns per size), behind the `size_feedback` setting (default on); `decide_eval` size prints worker Size-line agreement with and without it

## [0.6.77] - 2026-10-12

### Changed

- Pane: fold open questions into one collapsible row (#171)

## [0.6.76] - 2026-10-12

### Changed

- Size pane views to the body rows (#170)
### Changed

- Pane: open questions and approvals fold into one row (`▸ ▤ ? 3 questions (1 blocking) · 2 decisions · i`), collapsed by default so they no longer push the agent tree out of view. Press the row or `a` to list them, capped at about a third of the pane with "and N more · i inbox".

## [0.6.75] - 2026-10-12

### Fixed

- Cost ledger: a running plugin no longer overwrites a newer `ledger.json` (a `ledger-rebuild --write`, or another session's saves) with its stale in-memory copy. The file carries an `__epoch` stamp, and every save writes the disk ledger plus only this session's unsaved counts.
### Fixed

- Size pane views to the body's rows (props.scroll.bodyRows) instead of the whole terminal, so the bottom hotkey row is no longer hidden behind the prompt

## [0.6.74] - 2026-10-12

### Changed

- Route reasoning effort per role and size (#168)

## [0.6.73] - 2026-10-12

### Changed

- Manager and dispatch prompts: a fix whose root cause is not known yet is never sized small.
### Added
- **Effort routing:** flow sets reasoning effort per role and size on the agents it starts: `explore_effort` (`low`), `worker_effort_small` (`low`), `worker_effort_normal` (`medium`), `reviewer_effort` (`medium`); `worker_effort` and `manager_effort` are unset (inherit). An explicit Agent `effort` and `CLAUDE_CODE_EFFORT_LEVEL` win; the ledger records the effort applied.

## [0.6.72] - 2026-10-12

### Added

- `scripts/ledger-rebuild.mjs` recomputes the cost ledger's token and turn totals from the agents' transcripts, repairing totals inflated before 0.6.70. Dry run by default; `--write` backs the old ledger up first.

## [0.6.71] - 2026-10-12

### Changed

- Dispatch: split auth-or-secrets by risk in the small-change rule (#165)

## [0.6.70] - 2026-10-12

### Changed

- The `jev_api_key` option is now `typesafe_api_key`. `jev_api_key` still works as a deprecated alias, read only while `typesafe_api_key` is empty.
### Changed

- Dispatch: the small-change rule splits "auth or secrets" by risk. Code that reads, stores, sends, logs or validates a secret value, or auth/permission logic, stays a full manager; renaming, documenting or relabelling a secret setting goes lite when tests prove the value is still read.

## [0.6.69] - 2026-10-12

### Changed

- Pane inbox: each decision and question is its own expandable card (collapsed to one line by default; click it, or press e on the hot one, to open text, why, instead-could and inline Keep/Undo or option buttons); the owner is a plain collapsible header. The ruled preview under the list is gone; o opens the full-screen card.

## [0.6.68] - 2026-10-12

### Changed

- Pane: monochrome glyphs instead of emoji (#162)

## [0.6.67] - 2026-10-12

### Fixed

- The pane's answer input and hotkey row (inbox, question card, tree, archive, PR and batch cards) are pinned to the bottom of the visible pane and always shown; long content is clipped above them instead of pushing them off screen.

### Added

- A logo: an f drawn as three parallel lanes with one green crossbar. It is the new plugin icon and appears at the top of the README. Logo files, a social preview image and usage notes are in `docs/brand/`.

### Changed

- The pane's status-line and inbox icons are plain one-column text glyphs (≡ agents, ▤ inbox, ☰ checks, ⌫ leftovers) coloured by the theme, not emoji. A collapsed inbox card's hint reads "c expand · y keeps all 3".

## [0.6.66] - 2026-10-12

### Fixed

- The pane's answer row (the input and y/n/r buttons) sits right under the card or inbox content instead of at the bottom of the pane, so it no longer needs a scroll to reach.

## [0.6.65] - 2026-10-12

### Changed

- manager_model_normal: third manager model tier routed by Size (#156)
- decide_eval size: per-role split and normal-managers-on-sonnet counterfactual (#155)

## [0.6.64] - 2026-10-12

### Changed

- Test-slot hook guard: refuse whole-suite runs without a slot (#158)
- The pane's inbox draws each owner as a collapsible card like the tree's agents (chevron, round border, "owner · N decisions", one clipped line per item); the routine decisions are a collapsed card; c (or x) and the chevron fold a card, and a pane too short for all cards draws all but the hot one collapsed. The decision card's header is "id · owner · age".
- The pane's status lines get icons from one map in `hooks/pane.ts`: 📬 (something open) or 📭 (empty) on the inbox title and the tree's inbox line (now "📬 ? 2 questions · 9 decisions · i"), 👥 agents, 📋 checks, 🧹 leftovers. A waiting question shows a "?" in warning colour that pulses bright and dim once a second from the clock. In an owner's card a question row is the id, BLOCKING in warning colour, then the text (the card names the owner; ", for x" only for a linked escalation), and every open card is the full pane width.

## [0.6.63] - 2026-10-12

### Changed

- Fewer manager wakes: hold informational relays; wake-cost measurement (#157)

## [0.6.62] - 2026-10-12

### Changed

- decide_eval: route feature (direct / manager+1 / manager+n) (#152)
### Added
- A hook refuses a whole-suite Bash run (`claude plugin test`, `npm run check`, `npm test`, also behind `cd`, `&&`, `|`, `time` and globs like `tests/*.test.ts`) unless the caller holds a confirmed test slot. New setting `test_slot_commands` (empty list turns it off).

## [0.6.61] - 2026-10-12

### Changed

- The main-checkout guard covers the main session only while flow has work in the repo (a flow worktree or a live flow agent), and its refusal now says "main checkout" means the repo folder, not the main branch, and names the settings to change
### Added

- `scripts/wake-cost.mjs`: counts manager wake-up turns in the transcripts by kind and estimates their cache-write cost, with the share the delivery rules hold and what a 1h cache TTL would change

### Changed

- Fewer manager wake-ups: the "the user answered qN over your head" relay, the "both are closed" copy of a linked escalation and decide_handoff's split advice are held for the manager's next turn (or 10 minutes) instead of waking it; the copy no longer resumes a manager that ended its turn
### Added

- Manager model tier for `Size: normal`: the new `manager_model_normal` setting (Advanced). Unset it follows `manager_model`, so nothing changes until you set it; small stays on `manager_model_small`, large and no size on `manager_model`.
- `decide_eval` size report: a per-role split (workers and managers by the model they ran on: n, agreement, under-sized rate, $ as run) and a "normal managers on sonnet" counterfactual for managers, also printed by `scripts/decide-eval.mjs`.
### Fixed

- The cost ledger no longer multiplies its totals when the plugin reloads: the disk history was merged into the in-memory ledger again on every reload. Ledger totals recorded before this fix may be inflated; existing `ledger.json` files are not repaired.

## [0.6.60] - 2026-10-12

### Changed

- The plugin description (plugin.json, marketplace.json) is simplified to "Claude Code agents that work like a company, with Jev-assisted routing to keep cost down"
### Added

- `decide_eval` feature `route`: measures whether Jev can tell `direct` (one worker would do), `manager+1` and `manager+n` for a manager's task text, labelled from what each manager family did, scored against main's choice (lite = direct), a Size/docs rule and the always-baselines with under-/over-shaped rates and a cost column; risky tasks (migrations, auth, secrets, deploy/CI/infra, data rewrites) are excluded. Measurement only, no routing behaviour. `scripts/decide-eval.mjs` prints the key-free baselines

## [0.6.59] - 2026-10-12

### Added

- `size_min_confidence` (default 0): the least confidence the decision API's answer needs for spawn sizing to use it, below which the brief's `Size:` line is used

### Changed

- Spawn sizing now uses the decision API's answer at any confidence (was 0.5 or more); in flow's own history this raised agreement with the right size from 58% to 72%. Set `size_min_confidence` 0.5 for the old behaviour

## [0.6.58] - 2026-10-12

### Added

- `decide_eval` gets a `size` feature: replays spawn sizing (worker and manager briefs from transcripts, labelled under/ok/over from successors, handoffs, undone size decisions and PR size) and compares Jev, the brief's `Size:` line and always-normal on agreement, under-size rate, over-size rate and estimated cost; `scripts/decide-eval.mjs` prints the key-free part

## [0.6.57] - 2026-10-12

### Added

- Jev through OpenRouter: set `openrouter_api_key` (with optional `openrouter_jev_model`, `openrouter_base_url`) and, with no `jev_api_key`, `decision_api` jev sends the request to openrouter.ai; decisions read "jev via openrouter"

### Changed

- Inbox list: every row is one line of the pane width (single "…"), decisions sit under a dim "owner · N" header with a dim id, the folded group reads "▸ 5 routine (labels)" with its keys hint in the footer, the preview and card get a dim rule, a header line and dim labels, and the footer is a nav row plus a keys row that are always visible (`hooks/pane-view.tsx`, `hooks/inbox.ts`)
- `decide_inbox`: with `decision_api` jev or openai, a recorded decision (`mcp__flow__fyi`) the provider confidently calls routine is kept by flow, shown as "kept by jev (0.93)" in the inbox, status and archive, and still undoable with `mcp__flow__answer`. Default off
- `decide_handoff`: at a worker's handoff the provider's confident lean (split or continue) is sent to the manager as advice, or appended to the `max_continues` split message; `max_continues` itself is unchanged. Default off
- `decide_min_confidence` (default 0.8): the shared threshold for both; every call is logged as a `decide` event in `log.jsonl`

## [0.6.56] - 2026-10-12

### Changed

- Decision-API eval: four questions and a replay tool (decide_eval) (#145)

## [0.6.55] - 2026-10-12

### Changed

- Plugin and marketplace description now reads "Jev-assisted agent orchestration for Claude Code" (`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`)
### Added

- `hooks/decide-questions.ts`: four decision-API questions (`inbox_routine`, `test_failure`, `merge_conflict`, `handoff_next`) with pure text builders; `hooks/decide-eval.ts` replays real flow history through them; the main-only deferred tool `decide_eval` runs that replay with the `decision_api` key from /config and reports agreement, fall-through, confidence and estimated savings per question (no key, no record text in its output file); `scripts/decide-eval.mjs` is its dry run. `decide()` takes an optional `minConfidence`. Nothing is wired into the plugin yet

## [0.6.54] - 2026-10-12

### Changed

- `/flow init` walkthrough adds a step on trimming unused global skills, plugins and MCP servers per project (`.claude/settings.local.json`) before running flow, since every agent inherits them

## [0.6.53] - 2026-10-12

### Changed

- Shorter flow MCP tool descriptions (about 30% fewer description bytes in `hooks/tools.ts`), and the old-name `queue` tool is deferred so it costs no context until fetched

## [0.6.52] - 2026-10-12

### Changed

- Trim dispatch and init skills (#140)

## [0.6.51] - 2026-10-12

### Changed

- Decisions read as statements, not questions: the pane tree folds them into the Inbox line ("1 question for you, 9 decisions to keep or undo"), and the inbox preview and card show the decision, why and "instead could" with only Keep and Undo; answered ones read Kept or Undone. A decision now stores its alternative in its own field.
### Changed

- Cut the dispatch skill to about half its size; rare procedures moved to skills/dispatch/references/details.md

## [0.6.50] - 2026-10-12

### Changed

- Clear MOD_CAPABILITY_USE_NOT_PLAIN and reflective-code findings, with a source guard (#138)

## [0.6.49] - 2026-10-12

### Fixed

- Reworded the open-checks help text and made the demo-commit diff line a plain constant so the plugin directory no longer flags MCP_FORWARDS_CREDENTIAL_ENV; no behaviour change

## [0.6.48] - 2026-10-12

### Fixed

- The settings-write test uses obviously fake placeholder secrets (YOUR_API_KEY, sk-EXAMPLE..., xxxx) so the plugin directory no longer flags SECRET_IN_SCRIPT, and the secret refusal now points flow's own keys to /config
### Fixed

- Clear the plugin directory's MOD_CAPABILITY_USE_NOT_PLAIN finding: the .tsx files no longer name anything `h` or `Fragment` (the PR card's handover is `ho`), every helper taking `$` with a return type is a function declaration, and no local reuses the names `next` or `on`. `scripts/plain-names.mjs`, run by `npm run typecheck`, and a test in `tests/jsx-factory.test.ts` keep it from coming back.
- No reflective `globalThis` code left: the decision API's timeout uses `$.clock.after`, the PR card's URL opener finds the platform once through `uname -s` (macOS when that fails), and `/flow inbox` and `/flow checks` size their tables from the command's own terminal width. The README's "What flow does on your machine" lists the hosts flow contacts (api.openai.com, api.typesafe.ai, github.com) and says both base URLs are set in `/config`.

## [0.6.47] - 2026-10-12

### Changed

- Quiet after-update notice: toast instead of a prompt to main (#135)

## [0.6.46] - 2026-10-12
### Changed

- After an update, the after-deploy checks the new version covers are announced with a one-line toast ("flow <version>: N after-deploy checks can be done now. /flow checks lists them."), once per version, instead of a prompt submitted to main. An update no longer starts a turn; the checks stay in `/flow checks`, the inbox and the pane.

## [0.6.43] - 2026-10-12

### Changed

- Answer the plugin directory's policy findings: keys from /config, $.http.fetch, icon, README section (#134)

## [0.6.45] - 2026-10-12
### Added

- README section "What flow does on your machine": what flow sends and where, the programs it runs (including the permission-bypass flags of session harnesses), the files it writes, what it puts in prompts and gives its agents, and what each hook does.
- Plugin icon at `.claude-plugin/icon.png`.

### Changed

- The decision API keys now come from `/config`: set `openai_api_key` (and `openai_base_url`) instead of the `OPENAI_API_KEY` / `OPENAI_BASE_URL` env vars, and `jev_api_key` (and `jev_base_url`) instead of `JEV_API_KEY` / `JEV_BASE_URL` or `~/.config/jev/env`. The keys are sensitive options kept in secure storage; a settings file that sets one is ignored with a warning. flow no longer reads your environment for them.
- The OpenAI and Jev requests go through the engine's `$.http.fetch` instead of the global `fetch`.

## [0.6.42] - 2026-10-12

### Changed

- `decision_api` is a dropdown in `/config`: `auto` (the default, same as unset: `size_model` applies if set), `off`, `jev`, `openai`. Explicit values always win.
- The push-batch card's Drop now asks "Drop the whole batch (all PRs go back)?" with Yes/No before returning the PRs. `/flow push drop` is unchanged.

## [0.6.43] - 2026-10-12
## [0.6.44] - 2026-10-12

Ships the changes that the 0.6.42 and 0.6.43 entries listed but their tags did not contain: two reviewers released at the same time, so those tags were cut before these merges.

### Added

- `ask_cards` setting (default on): the messages to the main session tell it to show blocking questions, env changes and deploy approvals as AskUserQuestion cards (clickable options plus Other); new short notices for a blocking ask to main, env items and deploy approvals, and a hint on a manager report that ends in a question. (#127)
- Flow pane: PR card and push batch card. Press a PR line (or the awaiting / ready-to-push line) to see who handed it over and why it awaits you, its Verification evidence, env changes, after-deploy checks and changed files, with Approve, Reject and Open on GitHub; the push batch card has Push, Send one back and Drop. GitHub details load in the background and are cached. (#128)
- `/flow init`: a re-runnable onboarding. A short walkthrough, a demo and the Core settings, driven by the new `flow:init` skill. Detects test and check commands (package.json, Makefile, pyproject, Cargo, go.mod), the base branch, the remote and `gh`; nothing is written unless you choose it. `/flow init settings`, `/flow init demo`, `/flow init demo live` and `/flow init demo stop` jump to a part. (#130)
- The demo is a free replay in the Flow pane by default (canned agents, a question and a decision you answer, a handover and merge; no agents, no tokens, nothing written, labelled DEMO). `/flow init demo live` runs a real throwaway demo (uses tokens) in its own worktree, with nothing pushed, and cleans up after itself. (#130)
- Tools `settings` (show, and write to the repo or personal file with validation: known keys, kinds and choices only, merged into the existing file, `null` removes a key, secrets refused, invalid JSON never overwritten) and `demo` (replay start/stop, cleanup of a real demo's worktree and branch). Both main only. (#130)
- First-run hint at session start: while neither settings file exists and `/flow init` never ran in the repo (marker `<git-common-dir>/flow/init-done`), one line points at `/flow init`. (#130)

### Fixed

- A reviewer's message to a finished manager is refused as a `deny` (the "Not sent" text) instead of a string result, which the host rejected as "SendMessage output is not an object". (#131)
- An explicit `decision_api` (including `off`) now always wins over the deprecated `size_model`, which is read only while `decision_api` is unset. `decision_api` has no default in `/config` so unset stays distinguishable; an unknown value means off. (#126)

## [0.6.43] - 2026-10-12

### Changed

- Renamed local `h` variables and parameters in the .tsx hooks so the plugin directory's JSX check (MOD_CAPABILITY_USE_NOT_PLAIN) passes; no behaviour change (#132)

## [0.6.42] - 2026-10-12

### Added

- MIT license (`LICENSE`) and plugin metadata for the Claude plugin directory listing: `license`, `homepage`, `repository` and `keywords` in `plugin.json`. (#129)

### Fixed

- The README install command: `/plugin marketplace add Ying-Kai-Liao/flow`, then `/plugin install flow@flow`. (#129)

## [0.6.41] - 2026-10-12

### Changed

- Continue-on-branch spawn never fails with the flow:continue refusal (#125)

## [0.6.40] - 2026-10-12

### Added

- Optional `decision_api` setting (`off` by default): `jev` (TypeSafe's Jev) or `openai` (an OpenAI chat model, `openai_model`, key from `OPENAI_API_KEY`) picks the worker and manager size at spawn through one small decision API, falling back to the `Size:` line when the provider is unavailable. The brief text is sent to the provider (api.typesafe.ai, or the OpenAI host) when on. `size_model` stays as a deprecated alias.
### Added

- Flow pane: the Reviewer section's PR lines, and the "N awaiting approval" summary, open a PR card with the title, status, branch, head, who handed it over and why it awaits you, the verified line, pending decisions, evidence, env changes and the changed files (from `gh pr view`, fetched in the background and cached per PR and head for 5 minutes). An awaiting PR has Approve (`a`), Reject (`r`, the input is the reason) and Open on GitHub (`g`); they run the same code as `/flow approve` and `/flow reject`, which now share their functions with the pane. The ready push batch line opens a batch card with Push (`p`), Send back and Drop (`d`), which call the same push gate as `/flow push`.

## [0.6.39] - 2026-10-12

### Added

- Lite mode: `/flow lite <task>`, or a `Mode: lite` line on a manager's prompt, runs one task as just a manager and its workers to save tokens. A lite manager is skipped in pre-flight, files no manager-size or worker-size decisions, and merges its own PR (full check, release, push, deploy gates, `reviewer` done) instead of starting a reviewer agent, then reports in a few lines. A PR under `merge_mode` confirm or judged risky is handed over with `mode: "confirm"` and goes to a normal reviewer. Only a lite manager's own PRs open the `release`, `reviewer` ready/done and `deploy` gate tools to it; other managers and workers are refused them.
### Fixed

- A `Continue on branch:` worker spawn no longer fails with "a hook's subagentType 'flow:continue' names no agent this call can dispatch". The host checks a rewrite against the offer as listed and replays that refusal to a second `next` of the same spawn, so the 0.3.23 in-call fallback could not recover. `flow:continue` is now always offered (a model's own spawn of it is denied). If the host still refuses, the claim is given back, in-place continuations stop for the session, and the manager is told to spawn the brief again, which starts a plain `flow:worker` in a new worktree.

## [0.6.38] - 2026-10-11

### Added

- Inbox pane: pressing a row (or an open question or decision in the tree) opens a large card with the full text, why, who asked and for whom, the asker's status, and every option as a button plus an input for your own words. After an answer the next item's card opens. An item answered meanwhile shows its answer and answers nothing again.
- Inbox archive: answered questions and kept or undone decisions, newest first, with answer, who and when (pane key `v`, `/flow inbox archive [all]`; 50 shown unless `all`). Archived cards are read-only.
- The tree lists important open decisions under the agent summary, and its question lines are buttons.

### Changed

- An escalated pair (a manager's question and the worker's question behind it) is one inbox item: the worker's question is hidden while the manager's is open, its tag reads `ESCALATED via qN`, and the manager's card shows "escalated from <worker>'s qN" with the worker's text.
- The inbox list and `/flow inbox` fold routine decisions (topics `worker-size` and `manager-size`) and the decisions of finished agents into one group row; `y` and `w` (and `/flow ok`) keep them all, pressing the row (or `x`) lists them. They stay open and undoable.

## [0.6.37] - 2026-10-11

### Added

- `mcp__flow__ask` takes `for: "<qid>"` for managers: it escalates a worker's open question to main. Main's answer to either question closes both and reaches the worker and the manager; no hand relay.
- `mcp__flow__status` shows an agent that ended its turn on a blocking ask as "waiting on qN".

### Fixed

- The answer to a blocking question wakes an asker that shows as completed or left the roster (workers too); a failed or killed asker, or a send dropped because the agent ended, now sends the answer to main instead of losing it.

## [0.6.36] - 2026-10-11

### Added

- `/flow reject <pr> [reason]` (alias `/flow drop`) turns down an awaiting or pending handover; handovers whose PR was closed on GitHub are returned automatically, including awaiting ones.

## [0.6.35] - 2026-10-11

### Added

- Optional `size_model` setting (`off` by default): `jev` lets TypeSafe's Jev classifier pick the worker and manager size at spawn, falling back to the `Size:` line when Jev is unavailable. The brief text is sent to api.typesafe.ai when on.

## [0.6.34] - 2026-10-11

### Added

- Pane cards show the model each agent runs on (opus, sonnet, sonnet[1m], haiku; the harness name for sessions), in the collapsed line, the card and the detail view, and next to main in the header. It is the first thing dropped when the pane is narrow.

## [0.6.33] - 2026-10-11

### Changed

- syncPlans and refresh moved from hooks/register.tsx into hooks/roster-run.ts, with the pure plan-owner helpers. No behavior change.

## [0.6.32] - 2026-10-11

### Changed

- Answering a question and the manager-messaging helpers (tellManager, tellMain, the pane's inbox rows) moved from hooks/register.tsx into hooks/messaging-run.ts. No behavior change.

## [0.6.31] - 2026-10-11

### Changed

- The usage accounting in the turn.step and turn.complete hooks (context meter, handoff threshold, cost ledger) moved from hooks/register.tsx into hooks/usage-run.ts. No behavior change.

## [0.6.30] - 2026-10-11

### Changed

- Move the pane's graph, agent detail, inbox and tree views out of register.tsx into pane-view.tsx (pure refactor)

## [0.6.29] - 2026-10-11

### Fixed

- The reviewer's worklist and `status` now mark handovers whose PR was merged elsewhere as done ("merged elsewhere (<sha>)") and put a taken handover back to pending when its reviewer is gone, so stale records no longer cause needless restarts.
- A reviewer that kept failing to start (for example on a usage limit) was replaced about once a second, hundreds of times, until the session was restarted. Now a reviewer that ends with no answer, on an API error or within 30 seconds counts as a failed start: the next start waits 30s, 1m, 2m, then 5m, and after 3 in a row (or 20 starts in a rolling hour) the plugin stops, shows the error in `/flow status` and the pane, and asks main once in the inbox (kind `reviewer`, never auto-answered) whether to retry. `/flow resume` and a new session also retry; the failure history is kept in `reviewer-breaker.json`.
### Fixed

- A flow tool whose hook fails (a handler throws, a `$` call rejects, the hook outruns its budget or its worker is replaced) now answers "flow: <tool> did not finish (<reason>) ... call it again" instead of the host's "no tool.call hook answered this call"; the generic tool.call hook's catch swallowed such failures before the tool hook's own could answer

## [0.6.28] - 2026-10-11

### Changed

- Move the reviewer tool handler, the reviewer report routing and the reviewer start out of register.tsx (pure refactor)

## [0.6.27] - 2026-10-11

### Changed

- Move inbox-side tool handlers out of register.tsx (#109)

## [0.6.26] - 2026-10-11

### Changed

- Publish: tag a release only when its commit is on origin/main (#108)
### Changed

- Internal: the ask, fyi, preflight, answer, standing and check tool handlers moved out of `hooks/register.tsx` into `hooks/inbox-run.ts`, `hooks/standing-run.ts` and `hooks/checks-run.ts`; no behavior change.

## [0.6.25] - 2026-10-11

### Changed

- Internal: tool specs moved out of `hooks/register.tsx` into `hooks/tools.ts`; no behavior change.
- Internal: moved spawn routing (attachment check, continue rewrite, worker and manager model routing, size decisions, Fable refusal) into `hooks/spawn.ts` (no behavior change).
- Internal: moved the handover, plan, test_slot, migrations and status tool handlers and the `/flow` command out of `hooks/register.tsx` into `hooks/handover-run.ts`, `plan-run.ts`, `slots-run.ts`, `migrations-run.ts`, `status-run.ts` and `command.ts` (no behavior change).
### Fixed

- The release publish step fetches origin/main and refuses to tag a release commit that is not on it, so a tag is never pushed for a commit that did not reach origin.

## [0.6.24] - 2026-10-11

### Changed

- Internal: moved the pane tree, fold and handoff helpers into `hooks/pane.ts` and the card, meter and quota-line builders into `hooks/pane-view.tsx` (no behavior change).

## [0.6.23] - 2026-10-11

### Changed

- Moved the pure meter and label helpers out of `hooks/register.tsx` into `hooks/meter.ts` (no behavior change).

## [0.6.22] - 2026-10-11

### Changed

- Move standing rules out of register.tsx into hooks/standing-run.ts (#99)

## [0.6.21] - 2026-10-11

### Changed

- Internal: the release tool and cost ledger moved from register.tsx into hooks/release-run.ts and hooks/cost-run.ts (no behavior change)
- Internal: the push gate and deploy gate logic moved out of `register.tsx` into `hooks/pushgate-run.ts` and `hooks/deploy-run.ts`; no behavior change.

## [0.6.20] - 2026-10-11

### Changed

- Internal: agent-type constants and the settings mirrors moved from register.tsx to hooks/core.ts (no behavior change)
### Changed

- Internal: standing-answer and guard-test rule handling moved out of register.tsx into hooks/standing-run.ts; no behavior change.
### Added

- Manager model routing: a manager whose prompt says `Size: small` runs on the new `manager_model_small` (default `sonnet`); other sizes and no size stay on `manager_model`. A successor (`<name>-2`) runs one size up, and the plugin files a `manager-size` decision the user can overturn.
### Changed

- The plugin deletes a merged PR branch itself when the reviewer calls "done", only once the branch is in origin/<base> (with a lease), and refuses `git push` deletes from subagents; failing test names given to `test_slot` release and `back` are logged, and a fail-then-pass is reported as `flaky: <test>`.

## [0.6.19] - 2026-10-11

### Changed

- Move cleanup sweep and resume leftovers out of register.tsx (#95)
- Move terminal sessions out of register.tsx into hooks/session-run.ts (#96)

## [0.6.18] - 2026-10-11

### Changed

- Internal: test slots (pure parts) and `settingsOf` moved out of `register.tsx` into `hooks/slots.ts` and `hooks/settings.ts`; no behavior change.
- Docs: the `/config` descriptions now start with the setting's Core or Advanced tier, matching the reference, and the reference has a "Without Orca" section for running with plain tmux or in-session agents only.
### Changed

- Internal: the cleanup sweep moved out of register.tsx into hooks/clean.ts and the resume leftovers into hooks/resume.ts; no behavior change.
### Changed

- Internal: terminal sessions moved out of register.tsx into hooks/session-run.ts; no behavior change.

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
