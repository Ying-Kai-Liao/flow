# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
