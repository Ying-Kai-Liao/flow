# flow

The orca-flow pattern inside one Claude Code session, with nothing else installed: no Orca, no
tmux. You talk to the main session; it runs the work through managers, workers and one merge
queue, and a pane shows the whole tree. When Orca or tmux is there, a manager can also run a
worker in another harness (Codex, Gemini, OpenCode, Claude on its own, or any CLI) in a terminal
you can watch.

```
you ── main session (super manager)
         ├── manager: csv-export          one per task: briefs, reviews, hands PRs over
         │     ├── worker: csv-endpoint   one per package, in a git worktree of its own
         │     └── worker: csv-button
         ├── manager: login-redirect
         │     └── worker: redirect-fix
         └── merge queue                  merges handed-over PRs, runs the full check, deploys
```

## Roles

| Role | What it is | Job |
|---|---|---|
| Super manager | your main session, with the `dispatch` skill | splits your request into tasks, starts one manager per task, relays questions and answers |
| `flow:manager` | background agent, named after its task | writes briefs, starts workers, reviews their PRs, hands approved ones to the queue; refused if it tries to edit code; hands off to a `-2` manager at the context limit |
| `flow:worker` | background agent in a worktree of its own | builds one brief, pushes `flow/<name>`, opens a PR, reports or asks; at the context limit it pushes its work and writes a handoff note |
| `flow:queue` | background agent, started by the plugin | merges handed-over PRs in batches, runs the full check once per batch, pushes, deploys, reports back |

Reports and questions travel up the tree on their own: a worker's report wakes its manager, a
manager's wakes the main session. Answers go down by message. Only the main session asks you
anything.

## Dependencies

When one task or package needs another's merged code, the owner declares it with `mcp__flow__plan`
(`add`, with `nodes: [{ id, title, after?, until? }]`; also `list`, `done`, `block`, `remove`).
The owner is a manager for its workers, or the main session for managers. A node's id is the agent
name it will run as; `-2`, `-3` continuations count as the same node. Cycles, duplicate ids and
unknown dependencies are refused.

- **Done** means the PR is merged (a manager node: it finished and everything it handed over is
  merged). `until: "reported"` means the agent's report arrived instead. **Blocked**: the agent
  failed, its PR came back, it reported `BLOCKED:`, or the owner said so.
- **Automatic:** states, cycle refusal, refusing to start an agent whose node is still waiting, and
  one `flow plan: ...` message to the owner per pass (done, ready, blocked). The main session is
  woken again when a manager slot frees and nodes are still ready.
- **Left to the owner:** writing briefs and starting ready nodes (the plugin never starts agents)
  on the merged code, marking done or blocked by hand, and deciding what a blocked node needs.

```
add csv-export
add login-redirect  after: csv-export
-> login-redirect starts when csv-export's PR is merged
```

## What you see

- **The Flow pane** (`/flow`): the tree rooted at your main session (the super manager), with
  the managers, what needs you first, and the PRs handed to the queue under it. Every agent is
  a card: a status glyph, the bold name with `(+N)` for the agents under it, the role dimmed, one
  short activity line (what it is doing, or the question it asks; the description only while
  there is no activity yet), and the meter below with elapsed time and tokens. Only top-level
  cards have a border. Colors follow your light or dark theme (the theme's suggestion, warning,
  success and error colors), and the pane redraws when you switch `/theme`.
  A worker told to hand off shows a `handoff` badge while it wraps up, and "handed off" once it ends with a `HANDOFF:` line.
  Click a card to see the agent's activity, when it was last active, and its last report or question. The agents under it
  are cards too: click one to open it. **Message** starts a message to it in your prompt;
  **Back** returns to the agent above it, or to the tree from a top-level agent.
  `/flow inbox` lists the open questions (see Questions and the inbox), `/flow close` closes the pane, `/flow resume` picks up unfinished work, `/flow approve <n>` approves a PR waiting for you (see Merge mode), `/flow clean` lists leftover worktrees and branches (both below). It stays closed while agents keep running, until the next
  `/flow` or a newly started agent opens it again.
- **Pane keys**: `j` / `k` move the highlight down and up the tree, `o` opens the highlighted agent,
  `c` collapses or expands the highlighted card, `q` the Merge queue section. In an agent's detail, `b` goes back and `m` starts a message.
  Arrow keys, Tab and Enter go through the pane's focus ring, and the highlight follows it. Esc
  can't be caught inside a pane. `g` switches between the tree and the graph view (below).
- **The graph view** (`g`): the plan's dependency graph instead of the cards. At the top level it
  shows every agent without a parent plus the planned nodes of the main plan, so a node that
  is planned but not started (no agent yet, drawn `○` and dimmed) is visible with what it
  waits on. A manager that has workers carries a `+N workers` badge. Open a manager and press `g`
  to see its workers' graph the same way. Nodes are colored by state like the cards (running,
  done, blocked; ready in the warning color). `h` moves to what the highlight waits on, `l` to
  what waits on it, `j` / `k` to the next or previous node, `o` opens the highlighted node's
  agent (a waiting node only says what it waits on), and `b` goes back from a manager. A pane
  too narrow for columns falls back to a list with `after:` lines; a graph taller than the pane
  scrolls with `↑ N more` / `↓ N more`.
- **Collapsible cards**: `c` collapses or expands the highlighted card; clicking a card's ▸/▾
  toggles it, clicking elsewhere on the card opens it. Managers and the merge queue start collapsed
  (one line each, with asks and handoff shown, including for hidden workers); workers start
  expanded. `q` toggles the Merge queue section. Your choices stick while the pane is open.
- **Many agents**: with 10 to 20 managers the tree shows one line per collapsed manager,
  `↑ N above` and `+N more` for rows out of the window, and scrolls to keep the highlight in view.
- **Following the chat view**: plugins can't switch the transcript, so the pane follows it. Open an
  agent from the tasks list (`←`) and the pane shows that agent; back to main restores what you had.
  Anything you do in the pane wins until the view changes. The first card click shows a one-time
  hint on how to open that agent's chat. Known limit: if you act while viewing agent X, go to main
  without acting, and reopen X, the pane doesn't re-follow X until you act on main or open another agent.
- **A context meter on each card**: `███│░░░░░░░ 42%   1m 43s · ↓ 84.0k tokens`, with `│` marking the warning
  threshold (`context_warn_percent`, or `context_warn_percent_1m` on a 1M window, capped by `context_warn_tokens` when that is set). The meter turns the theme's warning color at or past the threshold and its error
  color from 90%. The time runs while the agent runs and freezes when it ends. Where an agent's usage isn't known yet it says `context ?` and shows no tokens, never a guess. A
  subagent's window is the one it was started with (1M when spawned with a `[1m]` model); otherwise the main session's when it runs the same model, else 200k (1M for a
  `[1m]` model).
  On a short terminal the cards shrink to one-line rows (just `42%`), and `+N more` stands in
  for rows that don't fit.
- **Unhanded PRs**: open, non-draft `flow/*` PRs with no handover (or a returned one) and no live worker show as "⚠ N PRs nobody handed over" under the pane header and under "Needs attention:" in `status`. Checked with `gh pr list` every 5 minutes; a worker that ended less than 20 minutes ago gets a grace period. Off when the merge queue is off.
- **The status line**: `flow: 2 managers · 3 workers · queue: 1 PR · /flow`.
- **Toasts** when an agent finishes, asks a question, or a PR merges or comes back.

## Continuing work

**Handoff.** When a worker or manager reaches the limit (once per agent; the queue never gets it),
the plugin tells it to wrap up and shows a toast. The limit is `context_warn_percent` (default 40) of the agent's window, or
`context_warn_percent_1m` (default 35) on a 1M window, so a 1M model hands off at 350k tokens and a
200k model at 80k. `context_warn_tokens` (default 0, off) is an optional absolute cap over both. The wrap-up reaches the agent two ways: a message (read
when the agent is idle or waiting) and a reminder appended to a tool result (read mid-turn: on the
first tool call past the limit, every 10th after, and when usage rises another 10 points). Nothing
is denied or interrupted. After a compaction the reminders stop until the next crossing. The window
is the main session's when the agent runs the same model, else 200k, and 1M once its usage exceeds
200k; that is a guess the engine does not confirm. The main session can't be replaced, so while
flow agents exist it gets one toast and log line per crossing (run `/compact`, or restart and
`/flow resume`), never an automatic compaction. A worker finishes
its small step, commits everything as `WIP handoff: …`, pushes `flow/<name>`, opens or updates a
draft PR, writes the note into the PR description under `## Handoff` (Done / Remaining /
Decisions / Gotchas) and ends its report with `HANDOFF: <branch>`. On `HANDOFF: <branch>` the plugin writes a digest of the worker's transcript to
`<state dir>/handoffs/<branch-slug>/<n>.md`, logs a `handoff` event and keeps a handoff record.
Its manager checks the push and starts `<name>-2` on the same branch (`Continue on branch:
flow/<x>`) with the original brief and the note; the plugin appends the digest (capped at 4k).
Managers no longer remove worktrees on handoff.

The continuation runs in the old worktree (the spawn is rewritten to the non-isolated
`flow:continue` type with that cwd) when all four hold: the worktree is clean, it is at
`origin/flow/<x>`, its old agent has ended, and no other spawn has claimed it (first spawn wins).
Otherwise the worker gets a new worktree and the plugin removes the old one if it is clean and
behind. The worker skips the checkout when it already stands on the branch.

`max_continues` (default 2): once a branch has handed off more often than that, the owning manager
gets a message to split the package. Nothing is refused. A manager hands off the same way, but only
when none of its workers is running; the main session starts `<name>-2` from its note. The note
lives in the PR description and the report, never in a file on the branch.

**`/flow resume`.** After a restart the roster is empty but branches, PRs and
`.claude/worktrees/` stay. `/flow resume` lists open `flow/*` PRs, pushed `flow/*` branches
without a PR (merged or closed ones are skipped) and leftover worktrees with uncommitted or
unpushed work, then has the main session start one `resume-<slug>` manager per task (up to `max_managers`
at a time). Work owned by a live agent, or already resumed in this session, is not listed again.

## Workers in other harnesses

A manager can run a worker outside this session, in any harness, with `mcp__flow__session`: when
the task asks for one ("do the UI part with codex"), or for every worker when `worker_harness`
names a harness. Every harness is driven through its terminal with the same controls, so one that
flow knows nothing about (harness `command`, or one added in `harnesses`) is as controllable as a
built-in.

| Action | What it does, for any harness |
|---|---|
| `start` (name, brief, harness, host?, command?) | worktree on `flow/<name>` from the base, a terminal in it, the harness started with the worker rules and the brief |
| `send` (name, text) | types a message and submits it (a bracketed paste in tmux, so multi-line text stays whole) |
| `keys` (name, keys) | presses keys: `"1"`, `"y enter"`, `"escape"`, `"interrupt"` (Ctrl-C), `"down down enter"`; named keys are enter, escape, interrupt, tab, up, down, left, right, backspace, space, anything else is typed |
| `read` (name, lines?) | the end of its terminal |
| `restart` (name) | a fresh shell in the same tmux pane (`respawn-pane -k`) or a new Orca terminal, then the harness's resume line, or its start line with the same prompt when it has none |
| `list` | every session, its harness, host, state and worktree |
| `stop` (name, remove_worktree?) | closes the terminal; removes the worktree only when it is clean and pushed |

- **Where.** In an Orca terminal (`orca worktree create`, then `orca terminal create`) or a
  detached tmux session (`git worktree add` under `.claude/worktrees/`; watch it with
  `tmux attach -t flow-<name>`). `session_host` `auto` takes Orca when its runtime answers, else
  tmux; a manager can name one per worker.
- **What it watches, the same for every harness.**
  - The report file: the worker writes `<git-common-dir>/flow/sessions/<name>/report.md`
    (rewritten each time); a new one, settled for 2 s, goes to the manager as a `flow session:`
    message, the way an agent's report wakes it.
  - The harness's own log, when it has one (`digest`): Codex's rollout file in `~/.codex/sessions`
    (found by its `cwd`), Claude's transcript in `~/.claude/projects/<worktree path>`. Its last
    three tool calls, last words and context fill go on the card and the meter (Codex's own
    window size), and a turn that ended 15 s ago with no new report makes it idle at once.
  - The screen, every 10 s: unchanged for 90 s with no new report, the manager is told once that
    it is idle, with the screen and its last words, since it may be on a question, a permission
    prompt or a menu. It answers with `send` or `keys`; a change on screen makes it running again.
  - The terminal, every 30 s: closed, or back at its shell, without a new report, the manager is
    told once with the last lines, and can `restart` it.
- **Harnesses.** A harness is a start line plus what flow can't find out by itself:

  | Field | Meaning |
  |---|---|
  | `start` | the command line; `{prompt}` is the prompt as one shell word, `{prompt_file}` the path of the file holding it |
  | `resume` | the command line that continues its last conversation in the worktree, for `restart` |
  | `program` | what must be on PATH; default the first word of `start` |
  | `quota` | `codex-logs` (Codex's own rate-limit logs), or a shell command printing the percent left |
  | `digest` | `codex-rollout` or `claude-transcript`: where its log of what it did is (built in for codex and claude) |

  Built in, each set to run unattended so it can push and open its PR:

  | Name | start | resume | quota |
  |---|---|---|---|
  | `claude` | `claude --permission-mode bypassPermissions {prompt}` | `claude --continue --permission-mode bypassPermissions` | |
  | `codex` | `codex --dangerously-bypass-approvals-and-sandbox {prompt}` | `codex resume --last --dangerously-bypass-approvals-and-sandbox` | `codex-logs` |
  | `gemini` | `gemini --yolo --prompt-interactive {prompt}` | | |
  | `opencode` | `opencode --prompt {prompt}` | | |

  `harnesses` adds or replaces them, as a start line or a full spec
  (`{"aider": {"start": "aider --yes-always --message-file {prompt_file}", "resume": "aider --restore-chat-history"}}`;
  `""` removes one), and harness `command` with a `command` line runs anything once.
- **Before it starts.** The program must be on PATH (Homebrew's prefixes added), and a harness
  with `quota` must show at least `min_quota` percent left (`codex-logs`: the newest reading
  under 6 h old, the lowest window; anything older can't tell and doesn't block). Otherwise the
  start is refused and the manager starts a `flow:worker` agent instead.
- **What it reads.** The prompt (`…/sessions/<name>/prompt.md`) is a short preamble, the usual
  worker rules, then the brief. The preamble says: no flow tools, the report is a file, answers
  arrive typed into this terminal.
- **In the pane** it is a worker card under its manager (yellow while idle), showing its newest
  action and its context meter. Its detail view has:
  - where it runs (`tmux attach -t …` or the Orca handle), worktree and branch;
  - keys you press there, sent to it without a model turn: `1` `2` `3` `y` `n`, `e` Enter, `z` Esc,
    `i` Ctrl-C;
  - `r` restart and `x` stop, each taking a second press within 5 s;
  - `did` (its last three actions), `said` (its last words), when it was last active;
  - the last lines of its screen.

  The plans, `status`, `/flow resume` and the cleanup treat a live session's branch and worktree
  as owned.
- **Quota on the root card.** One line per window: Claude's own (`5h`, `week`, per model, from
  this session) and Codex's (from its logs, under 6 h old), as the share left, coloured at 40% and
  20%, when it resets, and `empty in …` when the pace so far runs it out before the reset.
- **Limits.** No context meter and no handoff notice: it hands off by itself if it notices.
  Sessions live in this Claude Code session's memory: after a restart the terminals keep running,
  but their reports reach nobody; `/flow resume` picks up their branches like any other.

## Questions and the inbox

Questions reach you as one batched, numbered inbox instead of free-text reports.

- An agent asks with `mcp__flow__ask` (`from` = its name, `questions`: each with `question`,
  `options` (at least two), a recommended `default`, `blocking`, optional `context` and `topic`).
  One call can carry a batch. A worker's questions go to its manager, a manager's to you. Each
  gets an id (`q7`); asking the same open question twice returns the existing id. They are kept in
  `<git-common-dir>/flow/inbox.json`, so they survive restarts.
- **Non-blocking**: the agent goes ahead on the default and says in its report or PR that it
  assumed it; a message comes only if the answer differs. **Blocking**: it ends its turn and the
  answer arrives by message.
- `/flow inbox` lists what is open, numbered, grouped by owner, blocking first, with the options
  (default marked), context and age. `status` and the Flow pane show the open inbox first. An agent
  with an open blocking question shows as asking in the pane, the toasts and the task graph.
- Answer with `mcp__flow__answer`: `answers: [{id, choice}]` where choice is the option text, its
  letter or number, or free text; or `defaults: true` (optionally `ids`) to accept the defaults.
  Only the addressee answers: your main session for managers' questions (tell it "defaults", "1 b,
  3 defaults" or free text), a manager for its workers'. The answer is messaged to the asker and
  recorded as a decision note. If the asker is gone, the result says undelivered and the main
  session relays it to the successor (`<name>-2`).
- A report whose last line ends in `?` still counts as a question, for agents that don't use the
  tool. `decision_phrases` is deprecated.

## Cleanup

Finished agents leave worktrees under `.claude/worktrees/` and local branches (`flow/*`,
`flow/*-N`, `worktree-agent-*`, anything else). Most PRs are squash-merged, so `git branch -d`
does not see them as merged; the plugin judges each by ancestry and by the PR's head sha instead
of by name.

**What goes.** A worktree under `.claude/worktrees/` (never the main checkout) when its HEAD is on
`origin/<base>`, or its branch has a merged PR whose head is HEAD (or contains it), or its branch's
PR was closed and HEAD is pushed; and `git status` is empty apart from the untracked type links
`types` and `.claude-plugin/types`; and no live agent works in it; and it is not locked, unless the
lock names an agent that has ended or a process that is gone. It goes with `git worktree remove`
(never `--force`), then `git worktree prune`; a directory already missing is pruned. A local
branch when it is not checked out anywhere (a worktree removed in the same sweep doesn't count),
is not the base, has no open PR, and its tip is on `origin/<base>` or is the head of a merged PR
of that branch (or contained in it). It goes with `git branch -D`. Remote branches are never
deleted: the queue's `gh pr merge --delete-branch` does that.

**What stays, listed for a person.** Uncommitted changes (the files named), unpushed commits,
locked worktrees, a closed PR's branch, a worktree or branch a live agent uses, an open PR's
branch, and a handed-off worktree whose successor has not started yet. Nothing in that list is
touched in any mode.

**`/flow clean`** lists what would be removed and what is kept, and why; **`/flow clean --yes`**
removes. The tool `clean` (`apply`, default false) does the same for agents. One `git fetch
origin --prune` and one `gh pr list --state all` per sweep; when gh fails the sweep says so and
goes by ancestry only. Every sweep that removed something adds a `clean` line to `log.jsonl`.

**The automatic sweep** (`cleanup` = `auto`, the default) runs the same safe sweep in the
background after each PR the queue marks done, and when a queue agent ends (its worktree, detached
at the base, goes once the queue is gone). Never two sweeps at once; errors go to the log. With
`cleanup` = `off` nothing runs by itself, the tool's `apply` runs dry and says so, and only
`/flow clean --yes` removes. The pane and `status` show one dim line while there are leftovers,
e.g. `3 leftover worktrees · 12 branches · 1 needs a look · /flow clean`, from a dry sweep
refreshed with the PR list (every 5 minutes).

## Merge mode

By default the queue merges every PR a manager hands over. Set `merge_mode` to `confirm` and it
holds each one until you approve it. A PR's effective mode comes from, in order:

1. Its labels: `flow:confirm` or `flow:auto` (with both, `confirm` wins).
2. The `mode` the manager gave when handing it over (`mcp__flow__handover` takes `auto` or `confirm`;
   the plugin adds the matching label, and a label that fails to apply is reported, not fatal).
3. The `merge_mode` setting.

Managers can only raise a PR to `confirm`: under a `confirm` setting a handover with mode `auto` is
refused, so only you can add `flow:auto` there. Managers mark a PR `confirm` when it has database
migrations or data rewrites, deploy/CI/infra config, auth/permissions/secrets, deletions of
things users rely on, or irreversible operations.

A PR waiting for you has status `awaiting`: no queue is started for it, and it shows in the pane,
in `status` and in `/flow resume`. Run `/flow approve <n>` (yours only; it works on awaiting PRs
and nothing else) to put it in the queue. The approval is tied to the head commit: if the
branch moves and the manager hands it over again, you approve again. The queue re-reads the labels
and head when it takes a PR; a PR still unapproved answers "Held:" and is skipped, and if `gh` fails
the labels count as none, so it never merges something it could not check.

## Guards

The plugin's `tool.call` hook refuses three things for every agent of the flow, the main
session included. A rule in a prompt can be skipped; a refused tool call can't.

- **Managers don't edit code.** A manager's Edit, Write and NotebookEdit calls are refused; the
  change goes into a worker's brief.
- **No broad process kills.** `pkill` and `killall` in any form (on macOS, options after the
  pattern become more patterns: `pkill -f X -n -u 501` once killed every session), `kill` of
  pid `-1`, `0` or `1` or of a process group (a negative pid), and `kill` fed by `lsof` without
  `-sTCP:LISTEN`. Every flow agent lives in this one Claude Code session, so a broad kill stops
  the whole flow. `kill <pid>` stays allowed: find the pid with `lsof -i :PORT` or
  `pgrep -fl <pattern>`.
- **Nothing changes the main checkout.** Edit, Write and NotebookEdit aimed at the repo's main
  checkout are refused, and so are obvious shell writes there: `>`/`>>` redirects, `tee`,
  `sed -i`/`perl -i`, `cp`/`mv` targets, `rm`, `touch`, and git commands that change the
  checkout (`commit`, `merge`, `rebase`, `cherry-pick`, `revert`, `am`, `apply`, `reset`,
  `restore`, `checkout`, `switch`, `stash`). Linked worktrees, `.git/`, files outside the repo
  and `main_checkout_allow` stay writable; reading, `git fetch`, `git pull` and `gh` are not
  touched. A shell command's relative paths are placed by the session's directory for the main
  session and managers, and by any `cd` or `git -C` in the command; a worker's relative paths
  land in its own worktree and pass. Turn it off with `main_checkout_guard`.

## Install

In a Claude Code session:

```
/plugin install flow --marketplace Ying-Kai-Liao/flow
```

Then ask for work: "start managers for these three tasks: …", or for one change, "start a
worker to fix X".

## Settings

Most options are under `/config` → flow:. Every option can also be set in a settings file (`.claude/flow.json`, or the personal `.git/flow/config.json`, see Settings per repo); the ones marked "file only" have no `/config` field.

| Option | Default | Set in | Used by |
|---|---|---|---|
| `test_command` | tests covering the changed files | `/config`, file | workers |
| `full_check_command` | none (the queue says so) | `/config`, file | the queue, once per batch |
| `deploy_command` | none (no deploy) | `/config`, file | the queue, after pushing. Same as one target `{name: "default", deploy: [deploy_command]}` |
| `deploy_targets` | none | file only | the queue: ordered deploy targets (see Deploying). A JSON array or a JSON string; wins over `deploy_command` |
| `state_file` | none | file only | the queue: a status file it updates after each deploy, a path or `{path, keep, archive}` (see Deploying) |
| `merge_queue` | on | `/config`, file | off: managers merge themselves with `merge_method` |
| `merge_method` | `squash` | `/config`, file | managers, when there is no queue |
| `merge_mode` | `auto` | `/config`, file | `auto` or `confirm` (unknown: `auto`): `confirm` holds every handed-over PR until you run `/flow approve <n>` (see Merge mode) |
| `max_managers` | 20 | `/config`, file | managers the main session runs at a time |
| `max_continues` | 2 | `/config`, file | how many times a branch may hand off before its manager is told to split the package (a warning only) |
| `max_workers` | 3 | `/config`, file | workers per manager at a time |
| `test_slots` | 1 | `/config`, file | how many heavy test runs may run at once across all agents (minimum 1) |
| `worker_model` | `sonnet[1m]` | `/config`, file | workers. Falls back to `sonnet` once, with a warning, if the engine refuses `[1m]` for sub-agents |
| `manager_model` | `opus` | `/config`, file | managers |
| `queue_model` | `opus` | `/config`, file | the merge queue |
| `language` | `English` | `/config`, file | the language agents write reports and PR text in |
| `big_files` | none | file only | files workers grep and never read whole (a list) |
| `big_file_lines` | 1500 | file only | the line count from which a file counts as big |
| `migrations_dir` | none | file only | the directory of migrations |
| `decision_phrases` | none | file only | **deprecated**, use `mcp__flow__ask`: extra phrases that mark a report as a question for the user (a list; see below) |
| `worker_checks` | none | file only | commands every worker must pass before opening a PR (a list) |
| `always_tests` | none | file only | tests every worker runs on top of the ones for the files it changed (a list) |
| `context_warn_percent` | 40 | `/config`, file | the context limit as a percent of the window (1 to 100) |
| `context_warn_percent_1m` | 35 | `/config`, file | the same as `context_warn_percent`, for agents on a 1M window (1 to 100); the 200k percent never applies to them |
| `context_warn_tokens` | 0 | `/config`, file | an optional cap in tokens over both percents; the lower applies. 0 = off, percent only. Drives the handoff, the meter marker and the yellow point |
| `handoff` | on | `/config`, file | workers and managers: at the limit they are told to hand off (see Continuing work). Off: the meter only shows |
| `base_branch` | the remote's default branch | `/config`, file | everyone |
| `main_checkout_guard` | on | `/config`, file | every agent and the main session: writes to the main checkout are refused (see Guards) |
| `cleanup` | `auto` | `/config`, file | `auto`: the plugin removes finished, clean worktrees and branches after each merge and when the queue ends (see Cleanup). `off`: only `/flow clean --yes` |
| `worker_harness` | `agent` | `/config`, file | managers: `agent` starts `flow:worker` agents; a harness name (`codex`, …) starts every worker in a terminal instead (see Workers in other harnesses) |
| `session_host` | `auto` | `/config`, file | where session workers run: `auto` (Orca when it runs, else tmux), `orca`, `tmux` |
| `harnesses` | the four built-ins | `/config` (JSON string), file | harness name to a start line or `{start, resume?, program?, quota?, digest?}`, over the built-ins; `""` removes one |
| `min_quota` | 10 | `/config`, file | a session worker whose harness has a `quota` is refused below this percent left; 0 = never |
| `main_checkout_allow` | `.claude/` | `/config`, file | paths still writable in the main checkout, comma-separated, relative to the repo root; one ending in `/` covers a directory. Replaces the default |

`decision_phrases` (deprecated in favour of `mcp__flow__ask`, still honoured; the settings loader warns): a report counts as asking when its last line ends in `?` or `？`, or its last paragraph contains one of the phrases (case-insensitive), unless the phrase directly follows a negation (`不`, `不用`, `不必`, `無需`, `毋需`, `不需要`, `no `, `not `, `don't `, `no need to `): "不需要你決定" does not match `需要你決定`. The pane, the toasts and the task graph all use it.

An unset full check or deploy is a step that's skipped and reported, never improvised.

Sub-agents don't run on Fable: a Fable model is refused in settings (a warning, the default applies) and denied at spawn, for flow agents and for anything a flow agent starts.

### Settings per repo

A repo can carry its own settings in `.claude/flow.json`, a flat JSON object with the same snake_case keys as `/config` (plus the file-only ones in the table above):

```json
{
  "test_command": "pnpm test",
  "worker_checks": ["pnpm lint", "pnpm typecheck"],
  "big_files": ["src/schema.ts"],
  "worker_model": "sonnet"
}
```

A personal overlay lives in `<git-common-dir>/flow/config.json` (that is `.git/flow/config.json`) and is never committed.

Precedence, lowest first: built-in defaults, `/config`, `.claude/flow.json`, the personal file. For `worker_checks`, `always_tests`, `big_files` and `decision_phrases` the personal file's entries are added to the repo file's, each once; every other key is replaced.

An unknown key, bad JSON or a wrong type is a warning (shown as a toast) and the layer below applies for that key or file.

The files are checked every few seconds by modification time. New settings apply to agents started afterwards; running agents keep their prompts.

## Deploying

`deploy_targets` is an ordered list. Per target, the queue runs `backup` commands (every batch, checking their output is sane), then the `deploy` commands, then fetches `health_url` (retrying a few minutes) until it contains the short sha just pushed, then follows the free-text `verify` notes. It stops at the first failing target and reports it, e.g. `deployed: demo ✓, production ✗ at health: ...`. The PRs are already merged by then; they are marked done with the failure in the report.

```json
{
  "deploy_targets": [
    { "name": "demo", "deploy": ["./deploy.sh demo"], "health_url": "https://demo.example.com/health" },
    { "name": "production", "backup": ["./scripts/backup.sh"], "deploy": ["./deploy.sh prod"],
      "health_url": "https://example.com/health", "verify": ["check the error rate for 5 minutes"] }
  ],
  "state_file": { "path": "NOW.md", "keep": 10 }
}
```

`state_file` (set it per repo, see Settings per repo): after deploying, the queue adds one entry at the top of the file (date, PRs with titles, deployed sha and targets, verified, not verified, pending decisions), moves entries beyond `keep` (default 10) to the end of the archive (default `<stem>-archive.md` next to it, oldest last), and commits and pushes "Status: <PRs> deployed <sha>" without deploying again. Workers are told never to edit it.

After deploying, a PR whose `after_deploy` an agent can check gets a check-only worker (`<queue>-verify-<pr>`); one that needs a person is reported as `needs a person: PR #<n>: ...`. A PR's `pending` decisions go into the reports and the status entry as `pending decisions: PR #<n>: ...`.

## Tools the agents use

- `handover`: a manager hands a reviewed PR over; the plugin records its head and starts
  a queue if none is running.
  It refuses a PR whose description has no valid `## Verification` section (checked after the
  closed and draft checks), records nothing and starts no queue, and lists every problem with the
  expected format. Fix with `gh pr edit <n> --body-file <file>` and call again. The format:

```
## Verification
Ran:
- `<command>`: pass (<short result, e.g. 42 tests>)
Exercised: <how the change was run for real: app launched and what was seen, screenshot path, curl output, or "n/a: <reason>" for docs/prompt-only changes>
Not verified:
- <what you did not check>   (or one line "Not verified: none, because <reason>")
```

  `Ran` needs at least one entry and must include every `worker_checks` and `always_tests`
  command (backticks optional). `Exercised` and `Not verified` must be non-empty; a bare
  "Not verified: nothing" and a bare "n/a" are refused. The section is stored on the handover and
  shown in `queue list`, in the queue's report, in the status file entry and in `status`.
- `queue`: the queue's worklist (`list`, `take`, `done`, `back`).
- `plan`: dependencies between tasks or packages (see Dependencies).
- `status`: the tree, the handovers, the limits, the plans and the test slots as text, for check-ins; with `pr` it names the PR's owner.
- `ask`: questions with options, a recommended default and `blocking` (see Questions and the inbox).
- `answer`: answers inbox questions by id, or accepts the defaults.
- `note`: a manager's notes (`manager`, optional `text`, `kind` decision or progress). Without
  `text` it returns the notes.
- `clean`: leftover worktrees and branches (see Cleanup); dry unless `apply` is true.
- `test_slot`: a lock on heavy test runs (`acquire`, `release`, `status`). See below.

## The test lock

Six worktrees running the whole suite at once can exhaust memory and time out the real check.
Workers call `test_slot` `acquire` before a heavy run (a whole suite, anything over about a
minute) and `release` after it; the queue does the same around the full check. At most
`test_slots` runs hold a slot; the rest wait first come, first served. A hook has a 10 second
budget, so `acquire` waits at most a few seconds and then answers "queued, position N". The
head of the line is granted a free slot at once and told two ways: a file
`<git-common-dir>/flow/test-slots/<agent>.granted` (wait with `until [ -e FILE ]; do sleep 3; done`)
and a message; it confirms with one `acquire` within 2 minutes, else the grant passes on. A slot is
freed when its agent ends, when released, or after a 45 minute lease (with a toast). The Flow
status line shows `tests 1/1`. The lock lives in this session's plugin state: it covers every
worktree of the session's agents, not other Claude sessions, and a plugin reload empties it.

## State on disk

Flow's state survives a restart. It lives in `<git-common-dir>/flow/` (for example `.git/flow/`),
shared by all worktrees. Writes are best-effort: a failed write is logged in the UI and never
stops a tool call.

```
<git-common-dir>/flow/
  handovers/<pr>.json      one file per handed-over PR, rewritten on every change
  log.jsonl                append-only event log
  handoffs/<branch-slug>/<n>.md  transcript digest of a worker's n-th handoff
  managers/<key>/notes.md  a manager's notes
  config.json              not state: the settings loader's file, never touched by flow
```

- `handovers/<pr>.json`: `{version: 1, pr, title, head, branch, reportTo, verified, pending,
  afterDeploy, evidence?: {ran, exercised, notVerified}, status, at, sha?, report?, reason?}`; `status` is pending, taken, done or returned.
  A new session loads these.
- `log.jsonl`: one JSON object per line, `{ts, event, owner, agent?, pr?, branch?, text?}`;
  `event` is spawn, report, handover, take, done, back or note. `owner` is the manager the
  event belongs to (or `main`).
- `managers/<key>/notes.md`: dated lines, `- 2026-10-09 decision: "…"`. The key is the manager's
  name without a trailing `-N`, so `csv-export-2` continues `csv-export`'s notes.

`/flow resume` reads this too: it lists unfinished handovers next to the GitHub leftovers
(a handover whose PR is merged counts as done), groups them by owning manager, and gives each
restarted manager its notes (the last 3k characters).

## Limits

- Everything runs inside one session. Close it and the flow stops; the branches and PRs stay, and `/flow resume` picks them up in a new session.
- The pane shows tool calls and reports, not full transcripts.
- Every agent counts against the same Claude account's usage.

## Develop it

```bash
claude --plugin-dir .            # a session with your working copy loaded
claude plugin validate .
claude plugin test .
tsc -p .
```

Bump `version` in `.claude-plugin/plugin.json` before pushing a change, so
`claude plugin update flow@flow` picks it up.
