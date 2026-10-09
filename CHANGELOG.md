# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
