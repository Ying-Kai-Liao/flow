# flow

Standalone orchestration for software development, as a Claude Code plugin. Hand Claude Code a
batch of tasks and it runs them through managers, workers that each build in a git worktree of
their own, and one reviewer, all inside your session. Nothing else to install.

Your attention goes only to decisions: one pre-flight round of questions before work starts, a
decision inbox, and standing answers for what you would answer the same way again. Every PR
carries proof it was verified, a `## Verification` section, and risky PRs wait for your approval
(merge mode `confirm` or the `flow:confirm` label).

```
you ── main session (super manager)
         ├── manager: csv-export          one per task: briefs, reviews, hands PRs over
         │     ├── worker: csv-endpoint   one per package, in a git worktree of its own
         │     └── worker: csv-button
         ├── manager: login-redirect
         │     └── worker: redirect-fix
         └── reviewer                  merges handed-over PRs, runs the full check, deploys
```

## Quick start

In a Claude Code session:

```
/plugin install flow --marketplace Ying-Kai-Liao/flow
```

Then ask for work in the main session, for example:

```
Add CSV export to the reports page, and fix the login redirect loop.
```

Open `/flow` to watch the managers and workers, and answer the questions that reach you. For one
change, "start a worker to fix X" is enough.

## How it works

Sections below, in order: roles, dependencies, what you see, pre-flight, questions and the inbox, person checks, continuing work, merge mode, cleanup, guards, reviewer rules, deploying, verification, workers in other harnesses.

## Roles

| Role | What it is | Job |
|---|---|---|
| Super manager | your main session, with the `dispatch` skill | splits your request into tasks, starts one manager per task, relays questions and answers |
| `flow:manager` | background agent, named after its task | writes briefs, starts workers, reviews their PRs, hands approved ones to the reviewer; refused if it tries to edit code; hands off to a `-2` manager at the context limit |
| `flow:worker` | background agent in a worktree of its own | builds one brief, pushes `flow/<name>`, opens a PR, reports or asks; at the context limit it pushes its work and writes a handoff note |
| `flow:reviewer` | background agent, started by the plugin | merges handed-over PRs in batches, runs the full check once per batch, pushes, deploys, releases, fast-forwards the main checkout, reports back |

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
  the managers, what needs you first, and the PRs handed to the reviewer under it. Every agent is
  a card: a status glyph, the bold name with `(+N)` for the agents under it, the role dimmed, one
  short activity line (what it is doing, or the question it asks; the description only while
  there is no activity yet), and the meter below with elapsed time and tokens. Only top-level
  cards have a border. Colors follow your light or dark theme (the theme's suggestion, warning,
  success and error colors), and the pane redraws when you switch `/theme`.
  A worker told to hand off shows a `handoff` badge while it wraps up, and "handed off" once it ends with a `HANDOFF:` line.
  Click a card to see the agent's activity, when it was last active, and its last report or question. The agents under it
  are cards too: click one to open it. **Message** starts a message to it in your prompt;
  **Back** returns to the agent above it, or to the tree from a top-level agent.
  `/flow inbox` lists the open questions (see Questions and the inbox), `/flow checks` lists the after-deploy checks that need a person (see Person checks), `/flow close` closes the pane, `/flow resume` picks up unfinished work, `/flow approve <n>` approves a PR waiting for you (see Merge mode), `/flow preflight` shows the pre-flight round (see Pre-flight), `/flow clean` lists leftover worktrees and branches (both below). It stays closed while agents keep running, until the next
  `/flow` or a newly started agent opens it again.
- **Pane keys**: `j` / `k` move the highlight down and up the tree, `o` opens the highlighted agent,
  `c` collapses or expands the highlighted card, `q` the Reviewer section. In an agent's detail, `b` goes back and `m` starts a message.
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
  toggles it, clicking elsewhere on the card opens it. Managers and the reviewer start collapsed
  (one line each, with asks and handoff shown, including for hidden workers); workers start
  expanded. `q` toggles the Reviewer section. Your choices stick while the pane is open.
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
- **Unhanded PRs**: open, non-draft `flow/*` PRs with no handover (or a returned one) and no live worker show as "⚠ N PRs nobody handed over" under the pane header and under "Needs attention:" in `status`. Checked with `gh pr list` every 5 minutes; a worker that ended less than 20 minutes ago gets a grace period. Off when the reviewer is off.
- **The status line**: `flow: 2 managers · 3 workers · reviewer: 1 PR · /flow`.
- **Toasts** when an agent finishes, asks a question, or a PR merges or comes back.

## Pre-flight

Before any worker starts, each manager looks over its task and files what it found, so most
interruptions come before you leave.

- A manager reads the code at the base, `git log` and open PRs (Explore and general-purpose
  subagents are allowed, no workers) and calls `mcp__flow__preflight`: `from`, `summary`,
  `criteria`, `shipped` (work that already exists), `depends` (other tasks it needs), optional
  `workers` estimate and `questions` in the `ask` shape. Filing again replaces the filing.
- **The gate**: until a manager has filed, and while a blocking question of its filing is open,
  the plugin refuses its `flow:worker` starts and `mcp__flow__session` starts. Answering with
  `mcp__flow__answer` (choices or `defaults: true`) releases it. A manager with only
  non-blocking questions starts at once on the defaults.
- **The round**: managers started together form one round. When all have filed, skipped or
  ended, or after `preflight_wait` minutes, the main session gets one message, "Pre-flight: 15
  tasks, 2 already shipped, 3 depend on others, 6 questions", with each task's criteria and
  findings and the numbered questions. You answer once. Managers still in recon at the timeout
  follow as "Pre-flight (late): ...".
- `/flow preflight` shows the open or latest round; `mcp__flow__status` shows the phase.
- **Skip**: a line `Pre-flight: skip` in a manager's prompt exempts it (the main session uses it
  for a single small change). With `preflight` off, nothing is gated.
- Settings: `preflight` (`on`/`off`, default on) and `preflight_wait` (minutes, default 10).
  State is in `<git-common-dir>/flow/preflight.json`.

## Questions and the inbox

Questions reach you as one batched, numbered inbox instead of free-text reports.

- An agent asks with `mcp__flow__ask` (`from` = its name, `questions`: each with `question`,
  `options` (at least two), a recommended `default`, `blocking`, optional `context` and `topic`).
  One call can carry a batch. A worker's questions reach its manager as one message, a manager's go to you; main cannot ask. Each
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
- **FYIs.** For a reversible choice (a threshold, wording, a name, a default) an agent does not ask: it
  decides, continues, and records `mcp__flow__fyi` (`from`, `items: [{decision, why, alternative?, topic?}]`;
  the batch is validated whole, main cannot call it). An FYI is a non-blocking inbox item (`kind: "fyi"`,
  same `q<n>` ids, options Keep / Overturn, default Keep), addressed like an ask: a worker's to its
  manager, a manager's to main. Nobody is messaged or toasted when one is recorded, and it never
  counts as asking. `/flow inbox` lists them in their own section, `status` and the pane as a count.
  `mcp__flow__answer` acks (the choice Keep, or `defaults: true`, also with `ids`): no message. Any other
  choice, free text included, overturns: the owner is messaged what it decided and what to do instead,
  or, if it is no longer running, its manager (naming the owner); the overturn is noted as a decision.
  The addressee may answer an FYI, and so may main (the user overrides what a manager has not looked at).
  Standing answers never answer an FYI.
- A report whose last line ends in `?` still counts as a question, for agents that don't use the
  tool. `decision_phrases` is deprecated.

### Standing answers

Answer a recurring question once. Give an inbox answer `always: true` (`answers: [{id, choice, always: true}]`;
only main may) and flow adds a rule to your personal file, `<git-common-dir>/flow/config.json`: by the
question's `topic` when it has one (agents are told to give recurring questions a stable kebab-case
topic such as `version-bump`), else by the exact question text. From then on a fresh question that the
rule matches is stored, marked answered at once (`answeredBy: "standing answer"`, the rule id on it)
and the asker's `ask` result says so; nobody is messaged or toasted, and the decision goes to the notes
and `log.jsonl` (`auto-answer`). `/flow inbox` lists the last 24 h under "Auto-answered" with the rule
id to revoke.

- A rule is `{id?, topic?, match?, answer, blocking?, from?, note?}` (or, see below, `{..., escalate: true}`) in the `standing_answers` list of a
  settings file. `topic` equals the question's topic (any case); `match` is a case-insensitive regular
  expression on the question text; with both, both must match. No fuzzy matching. `answer` must be one
  of the new question's options (text, letter or number), else the rule does not apply and the question
  goes to the inbox. `from` limits it to one asker (`foo-2` counts as `foo`). A blocking question is
  answered only by a rule with `blocking: true`. A bad rule is dropped with a settings warning.
- Two more forms. `escalate: true` with no `answer` holds a matching question for you: no rule ever
  auto-answers it (whatever the order), it is recorded `blocking: true` and flagged
  `escalated: <rule id>`, and `mcp__flow__answer` refuses an answer from anyone but main; a worker's
  it is addressed to main (a worker's manager is told so and must not answer or re-ask it), and `/flow inbox` marks it ESCALATED. `answer: "default"` (the literal word)
  answers a matching non-blocking question with its own default and never touches a blocking one.
  A rule with both `escalate` and an `answer` is invalid and dropped with a warning.
- Seeds. When no rule exists in any layer, `standing list` and the first `status` call by main
  (once; `seeds-offered.json` in flow's state dir, next to `inbox.json`, records it) show "Suggested
  starting rules (not applied)": `tracker` (never write to an external task tracker without your yes;
  topic `external-tracker`, escalate), `prod-env` (production environment changes always ask; topic
  `prod-env-change`, escalate) and `conservative` (non-blocking questions take their own default).
  Nothing is applied until you accept: `mcp__flow__standing {"action":"add","seed":"<id>"}` (or
  `seeds: [ids]`) adds the rule to your personal file; an unknown id lists the valid ones, and a
  seed already present is not added twice. `standing list` keeps showing the remaining seeds while
  every rule you have is an accepted seed, and hides them once you have a rule of your own.
- The personal file's rules come before the repo file's and both apply; the first match wins.
  A rule without `id` is named by file and position: `personal:1`, `repo:2`. `always` makes `s1`,
  `s2`, ...
- `mcp__flow__standing` (main only): `list` shows each rule with its file, match, answer and use
  count, and suggests rules for questions you answered the same way 3 or more times; `add`
  (`topic` or `match`, `answer`, optional `blocking`, `from`) writes the personal file; `remove`
  (`id`) removes a rule from whichever file holds it (a repo-file rule is a committed file).

## Person checks

An after-deploy check that needs a person (a browser look, a real conversation, a judgment call) becomes a durable item instead of a line in a chat report. Checks are separate from inbox questions and shown alongside them.

- **What creates one.** Each `needs a person: PR #<n>: <steps>` line in the reviewer's done report for a PR. The same PR and steps never get two checks. The check's version is read from `.claude-plugin/plugin.json` at the merged sha; when that is unreadable (not a plugin repo), it falls back to a version named in the steps ("install 0.3.31", else any `X.Y.Z`). Handovers that were already done before this existed are backfilled once at session start.
- **Where.** `<state dir>/checks.json`. A check has an id (`c1`, `c2`, ...), the PR, its steps, an optional version and an optional verify command. State is `open`, `passed` or `failed`; a failed check also carries a follow-up that is `open` or `started`.
- **`/flow checks`** lists the open checks grouped by what they need: "Needs install of X and a restart" (one group per version, ascending), "Ready on the installed version", "No version", and "Version unknown" (a versioned check when the installed version cannot be read). Open follow-ups are listed after them. `/flow inbox` has a "Checks" section with the count, the pane has a `Checks: n open` line, and `/flow resume` lists open checks (for the user, nothing to start) and open follow-ups (for main to start).
- **Pass and fail.** `/flow checks pass <id...>` closes checks as passed. `/flow checks fail <id> <note>` fails one check; the note (what went wrong) is required. A failed check creates a follow-up for main: main starts a manager on it with the PR, the steps and the note, then marks it with `mcp__flow__check` `started` (id and manager name). Closing a closed or unknown id is refused.
- **Who closes.** The user with `/flow checks`, or main with `mcp__flow__check` on the user's word. The reviewer may close only a check that carries a verify command, see below.
- **After an update.** Once per installed version, when an update installs the version some open checks were waiting for, main gets one prompt listing the checks that can now be done. Main tells the user; it starts no managers for them.
- **Scripted checks.** A manager can pass `verify_command` (a shell command, such as an e2e or smoke run) on `mcp__flow__handover` when the after-deploy check can be scripted. If the check still needs a person, the reviewer runs the command at the merged main and closes the check itself: pass on exit 0, fail otherwise. The file-only `verify_paths` setting limits this: when set and the PR changes no matching file, the command is skipped and the check stays open for a person, with a note saying so.

Not to be confused with the check-only verify worker (for after-deploy checks an agent can do, see Deploying), FYIs and standing answers (see Questions and the inbox).

## Attachments

A brief can carry files the worker should look at (screenshots, mockups, logs) in an optional
`## Attachments` section (or an `Attachments:` line), one path per line, as `- <path>` bullets or bare
lines; quotes and backticks around a path are fine, and `~` expands to your home. The list ends at the
next heading. When a manager, worker or continuation is started, the spawn hook checks every listed path
and refuses the spawn, naming each bad one, if it is missing, unreadable or a directory. Relative paths
resolve against the spawning agent's directory and are rewritten to absolute paths in the prompt, since a
worker's worktree doesn't hold the manager's untracked files. Workers open each attachment first and end
with `BLOCKED: attachment <path> could not be opened` if they can't. The main session passes the user's
images and files to managers as paths under an `Attachments:` heading. Workers started with
`mcp__flow__session` are not checked by the hook.

## Continuing work

**Handoff.** When a worker or manager reaches the limit (once per agent; the reviewer never gets it),
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

## Merge mode

By default the reviewer merges every PR a manager hands over. Set `merge_mode` to `confirm` and it
holds each one until you approve it. A PR's effective mode comes from, in order:

1. Its labels: `flow:confirm` or `flow:auto` (with both, `confirm` wins).
2. The `mode` the manager gave when handing it over (`mcp__flow__handover` takes `auto` or `confirm`;
   the plugin adds the matching label, and a label that fails to apply is reported, not fatal).
3. The `merge_mode` setting.

Managers can only raise a PR to `confirm`: under a `confirm` setting a handover with mode `auto` is
refused, so only you can add `flow:auto` there. Managers mark a PR `confirm` when it has database
migrations or data rewrites, deploy/CI/infra config, auth/permissions/secrets, deletions of
things users rely on, or irreversible operations.

A PR waiting for you has status `awaiting`: no reviewer is started for it, and it shows in the pane,
in `status` and in `/flow resume`. Run `/flow approve <n>` (yours only; it works on awaiting PRs
and nothing else) to put it in the reviewer. The approval is tied to the head commit: if the
branch moves and the manager hands it over again, you approve again. The reviewer re-reads the labels
and head when it takes a PR; a PR still unapproved answers "Held:" and is skipped, and if `gh` fails
the labels count as none, so it never merges something it could not check.

## Releases

With `release` on, no PR touches the version, so parallel PRs never collide on a version number or a dated changelog section.
- Workers add their changelog lines under `## [Unreleased]` in `changelog_file` and never change the version. Managers check that when they review, and pass `release: "minor"` on the handover for a new feature users see (or put the `flow:minor` label on the PR; `flow:major` / `"major"` only when the task asks). Everything else is a patch.
- After the full check passes and before the push, the reviewer calls `release` once per batch: it moves the Unreleased lines into a new `## [x.y.z] - date` section (a PR title per merged PR when Unreleased is empty) and bumps the version in each `release_files` entry by the highest bump asked in the batch. The reviewer commits "Release x.y.z" and pushes it with the merges. A retried push does not release twice.
- The release refuses (and the reviewer says so) when the setting is off, no version file is found, or the changelog is missing.
- Recommended for repos that turn it on: a `.gitattributes` line `CHANGELOG.md merge=union`, so Unreleased lines added side by side merge without conflicts.

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
deleted: the reviewer's `gh pr merge --delete-branch` does that.

**What stays, listed for a person.** Uncommitted changes (the files named), unpushed commits,
locked worktrees, a closed PR's branch, a worktree or branch a live agent uses, an open PR's
branch, and a handed-off worktree whose successor has not started yet. Nothing in that list is
touched in any mode.

**`/flow clean`** lists what would be removed and what is kept, and why; **`/flow clean --yes`**
removes. The tool `clean` (`apply`, default false) does the same for agents. One `git fetch
origin --prune` and one `gh pr list --state all` per sweep; when gh fails the sweep says so and
goes by ancestry only. Every sweep that removed something adds a `clean` line to `log.jsonl`.

**The automatic sweep** (`cleanup` = `auto`, the default) runs the same safe sweep in the
background after each PR the reviewer marks done, and when a reviewer agent ends (its worktree, detached
at the base, goes once the reviewer is gone). Never two sweeps at once; errors go to the log. With
`cleanup` = `off` nothing runs by itself, the tool's `apply` runs dry and says so, and only
`/flow clean --yes` removes. The pane and `status` show one dim line while there are leftovers,
e.g. `3 leftover worktrees · 12 branches · 1 needs a look · /flow clean`, from a dry sweep
refreshed with the PR list (every 5 minutes).

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

## Reviewer rules

Beyond merging, checking and deploying, the reviewer handles five things on its own:

- **Migration clashes** (when `migrations_dir` is set). After taking a PR and checking its head, the reviewer calls `mcp__flow__migrations` with the PR and the earlier PRs of the batch. If a migration of the PR has the same number as one on the base branch, at HEAD or in an earlier PR of the batch, or is at or below the highest on the base branch, the reviewer renumbers it in a temporary worktree on the PR's head: `git mv` to the next free number the tool reports (highest + 1, no gaps), updates the PR's own mechanical references to the old number (the paired down migration, a journal or index entry, a file name in a list), commits "Renumber migration <old> to <new> (reviewer)" and pushes to the PR's branch (never forced), then merges the new head. The batch's full check covers it. The done line and the report to the manager say so. When the number is referenced in a way it cannot update safely (code constants, generated checksums or snapshots, data that records the version) or the branch moved meanwhile, the PR goes back with the reason. Two packages that both add migrations can therefore run in parallel.
- **Infrastructure flakes.** A push that fails with a server or network error (5xx, timeout, connection reset; a rejection keeps the fetch, merge, check rule) is retried with backoff (30s, 1m, 2m, 4m, then every 4m) for at most 20 minutes, as is any `gh` call of the batch; the retry count goes in the done line. After that the batch's PRs go back with "push to <base> failed for 20 minutes (infrastructure); PR unchanged, hand it over again" and main is told. Health checks get 30 seconds before the first fetch and 10 minutes of retries.
- **Flaky tests.** With `flaky_tests` set, a full check whose failing tests are all in those files is rerun once for those files (through `test_command` with `{files}` if it has that slot, else the full check once more). If they pass, the batch passes and the report says "flaky rerun: <file> failed, passed on rerun". Any other failure, or a second one, is real.
- **Both-sides additions.** A merge conflict where both sides added lines at the same place (imports, list entries, registry entries, README table rows, CHANGELOG entries) keeps both, drops exact duplicates and keeps sorted lists sorted; the full check covers it and the report says "kept both sides in <files>". The same line changed differently, or a deletion against an edit, goes back to the worker.
- **Fast-forwarding the main checkout.** After a merge batch, when the main checkout is clean and on the base branch, the reviewer fast-forwards it (`git pull --ff-only`) so merged `.claude/flow.json` settings take effect. Otherwise it leaves the checkout alone and says in its report that it was not updated, and why.

## Deploying

`deploy_targets` is an ordered list. Per target, the reviewer runs `backup` commands (every batch, checking their output is sane), then the `deploy` commands, then fetches `health_url` until it contains the short sha just pushed (it waits 30 seconds after the deploy, then retries with backoff for up to 10 minutes; a failed fetch inside that window is not a failure), then follows the free-text `verify` notes. A target that fails stops the ones after it and is reported, e.g. `deployed: demo ✓, production ✗ at health: ...`. The PRs are already merged by then; they are marked done with the failure in the report.

Each target has a `mode`: `auto` (the default; deployed every batch) or `confirm`. Any other value is treated as `confirm` and the settings warning says so. Before each target the reviewer calls `mcp__flow__deploy` `gate` with the target and the short sha, and gets `Go`, `Held: <why>` or `Awaits approval: <qid>`; a held or awaiting target is skipped for that batch and the next target goes on (only a failed one stops the rest). The reviewer records each result with `deployed`, and reports per target, e.g. `deployed: demo ✓, production ⏸ awaits approval (q12)`.

- **Confirm targets.** The gate opens one blocking inbox item for you ("Deploy production at abc12345?", options `deploy` / `not now`, default `not now`, with the commits since that target's last deploy). Repeat gates reuse the open item and move it to the newest sha. Answering `deploy` approves exactly that sha and starts a deploy-only reviewer run (no merge, no full check, the approved sha); a later batch with a newer sha needs a new approval. `not now` leaves the target behind and the next batch asks again. Standing answers never answer a deploy approval (a rule would have to name `"kinds": ["deploy"]`), and `always` on one makes no rule.
- **Holds.** `/flow hold <target> [batch|released]` (default `released`) keeps a target from deploying: `batch` stops only the next gate call for it, `released` stays until `/flow release <target>`. Releasing an auto target starts a deploy-only run that catches it up. Main does the same with `mcp__flow__deploy` `hold` / `release` when you say "demo only, hold production"; agents cannot.
- **Behind count.** `mcp__flow__status` and the Flow pane's reviewer section show `production behind by N commits` (commits between the target's last deployed sha and `origin/<base>`, refreshed with the PR list, never on every render), or `production: no deploy recorded` for a target flow has not deployed. `mcp__flow__deploy` `list` shows every target with mode, hold, last sha and approval. The state is in `deploys.json` next to `inbox.json`.

- **Env and secret changes.** A PR that needs a server environment variable or a secret changed on a target declares it in the `env` field of its handover (see the `handover` reference below). Each change becomes blocking inbox items for you, addressed to main and never answered by a standing answer (a rule would have to name `"kinds": ["env"]`; `always` on one makes no rule). A non-secret change reads `Set NAME=value on production? (why)` with `yes` / `no` (default `no`). A secret reads `Secret NAME on production is set by you (why). Set it, then answer done` with `done` / `not yet`: flow never has its value, there is no field for it, and nothing is ever written to the log, the PR text or a state file. A `login` step ("log in to the cloud CLI") is its own item, `Do this yourself: ...`, and the change waits for it. The inbox labels them ENV CHANGE, SECRET and DO YOURSELF.
- **How the gate treats them.** For a target, the gate checks the env changes of handed-over PRs that are taken or done and not yet recorded for it, after the hold and before the deploy approval (so you are not asked to approve a deploy that cannot go yet). Any item still open: `Awaits env: <qids>`, and the target is skipped for that batch. An item answered `not yet` (a secret, a login step, an apply item) is still waiting: the gate opens a fresh item for it, answers `Awaits env: <qid>`, and skips the target for that batch; a change always has one open item. Only `no` on a non-secret change counts as declined: `Held: env change NAME declined`, until main runs `release` on the target, which drops the declined (`no`) changes only (recorded as dropped). When everything is answered yes or done, a non-secret change is applied only through the target's `env_command`, a template with `{name}` and `{value}` such as `fly secrets set {name}={value} -a myapp` (the value is shell-quoted; never put quotes around the placeholders; never used for secrets). The gate then answers `Go, first apply env:` with the exact command per change; the reviewer runs them (a non-zero exit fails the target), calls `mcp__flow__deploy` `env-applied` with the target and names, then deploys. A target without `env_command` gets one more item, `Apply NAME=value on production yourself, answer done`, and waits for it. The reviewer records each change in the status file entry by name and target: applied by command, applied by you, secret set by you, declined or dropped. Two PRs changing the same NAME on one target: the later handover's value wins, the earlier is recorded as superseded; you still answer both items. A returned PR's env items are closed. The same PR handed over again reuses its open items instead of duplicating them. `mcp__flow__reviewer` `list` shows each handover's env changes and `mcp__flow__deploy` `list` the pending ones per target.

```json
{
  "deploy_targets": [
    { "name": "demo", "deploy": ["./deploy.sh demo"], "health_url": "https://demo.example.com/health",
      "env_command": "fly secrets set {name}={value} -a myapp-demo" },
    { "name": "production", "backup": ["./scripts/backup.sh"], "deploy": ["./deploy.sh prod"],
      "health_url": "https://example.com/health", "verify": ["check the error rate for 5 minutes"] }
  ],
  "state_file": { "path": "NOW.md", "keep": 10 }
}
```

`state_file` (set it per repo, see Settings per repo): after deploying, the reviewer adds one entry at the top of the file (date, PRs with titles, deployed sha and targets, verified, not verified, pending decisions), moves entries beyond `keep` (default 10) to the end of the archive (default `<stem>-archive.md` next to it, oldest last), and commits and pushes "Status: <PRs> deployed <sha>" without deploying again. Workers are told never to edit it.

After deploying, a PR whose `after_deploy` an agent can check gets a check-only worker (`<reviewer>-verify-<pr>`); one that needs a person is reported as `needs a person: PR #<n>: ...` and recorded as a check (see Person checks). A PR's `pending` decisions go into the reports and the status entry as `pending decisions: PR #<n>: ...`.

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
  shown in `reviewer list`, in the reviewer's report, in the status file entry and in `status`.
- `reviewer`: the reviewer's worklist (`list`, `take`, `done`, `back`).
- `plan`: dependencies between tasks or packages (see Dependencies).
- `status`: the tree, the handovers, the limits, the plans and the test slots as text, for check-ins; with `pr` it names the PR's owner.
- `preflight`: a manager files its pre-flight before starting workers (see Pre-flight).
- `ask`: questions with options, a recommended default and `blocking` (see Questions and the inbox).
- `fyi`: records a decision the agent took itself, non-blocking and overturnable (see Questions and the inbox).
- `answer`: answers inbox questions (and acks or overturns FYIs) by id, or accepts the defaults; `always: true` (main) also makes a standing answer.
- `standing`: main only: list, add and remove standing answers.
- `check`: main only (the reviewer may close checks that carry a verify command): `list`, `pass` (`ids`, optional `note`), `fail` (`id`, required `note`) and `started` (`id`, `manager`) for a failed check's follow-up (see Person checks).
- `note`: a manager's notes (`manager`, optional `text`, `kind` decision or progress). Without
  `text` it returns the notes.
- `clean`: leftover worktrees and branches (see Cleanup); dry unless `apply` is true.
- `test_slot`: a lock on heavy test runs (`acquire`, `release`, `status`). See below.
- `guard_tests`: the guard tests the worker's diff requires (see Guard tests).

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

- **Where.** In an Orca terminal (Orca is a terminal and worktree app; `orca worktree create`, then `orca terminal create`) or a
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

## Reference

Sections below: settings, tools the agents use, the test lock, state on disk, limits, develop it.

## Settings

Most options are under `/config` → flow:. Every option can also be set in a settings file (`.claude/flow.json`, or the personal `.git/flow/config.json`, see Settings per repo); the ones marked "file only" have no `/config` field.

| Option | Default | Set in | Used by |
|---|---|---|---|
| `test_command` | tests covering the changed files | `/config`, file | workers |
| `full_check_command` | none (the reviewer says so) | `/config`, file | the reviewer, once per batch |
| `deploy_command` | none (no deploy) | `/config`, file | the reviewer, after pushing. Same as one target `{name: "default", deploy: [deploy_command]}` |
| `deploy_targets` | none | file only | the reviewer: ordered deploy targets, each with an optional `mode` of `auto` (default) or `confirm` (see Deploying). A JSON array or a JSON string; wins over `deploy_command` |
| `state_file` | none | file only | the reviewer: a status file it updates after each deploy, a path or `{path, keep, archive}` (see Deploying) |
| `reviewer` | on | `/config`, file | off: managers merge themselves with `merge_method` |
| `merge_method` | `squash` | `/config`, file | managers, when there is no reviewer |
| `merge_mode` | `auto` | `/config`, file | `auto` or `confirm` (unknown: `auto`): `confirm` holds every handed-over PR until you run `/flow approve <n>` (see Merge mode) |
| `preflight` | `on` | `/config`, file | `off`: managers are not gated and no round is sent (see Pre-flight) |
| `preflight_wait` | 10 | `/config`, file | minutes the main session waits for managers to file before sending the round |
| `release` | `off` | `/config`, file | `on`: release at merge, the reviewer bumps the version once per batch (see Releases) |
| `release_files` | none (`package.json` at the repo root when there is one) | file only | repo-relative JSON or TOML files whose version the release bumps, a list; the first one gives the current version |
| `changelog_file` | `CHANGELOG.md` | `/config`, file | the changelog the release cuts and workers add their lines to |
| `max_managers` | 20 | `/config`, file | managers the main session runs at a time |
| `max_continues` | 2 | `/config`, file | how many times a branch may hand off before its manager is told to split the package (a warning only) |
| `max_workers` | 3 | `/config`, file | workers per manager at a time |
| `test_slots` | 1 | `/config`, file | how many heavy test runs may run at once across all agents (minimum 1) |
| `worker_model` | `sonnet[1m]` | `/config`, file | workers. Falls back to `sonnet` once, with a warning, if the engine refuses `[1m]` for sub-agents |
| `manager_model` | `opus` | `/config`, file | managers |
| `reviewer_model` | `opus` | `/config`, file | the reviewer |
| `language` | `English` | `/config`, file | the language agents write reports and PR text in |
| `big_files` | none | file only | files workers grep and never read whole (a list) |
| `big_file_lines` | 1500 | file only | the line count from which a file counts as big |
| `migrations_dir` | none | file only | the directory of migrations: workers number new ones after the highest on the base branch, and the reviewer renumbers a clash (see Reviewer rules) |
| `decision_phrases` | none | file only | **deprecated**, use `mcp__flow__ask`: extra phrases that mark a report as a question for the user (a list; see below) |
| `standing_answers` | none | file only | rules that answer recurring inbox questions at once: a list of `{id?, topic?, match?, answer, blocking?, from?, note?}` (see Standing answers). The personal file's rules come before the repo file's and both apply |
| `verify_paths` | none | file only | path globs (a list): a handover's `verify_command` runs only when the PR changes a matching file, e.g. only PRs touching migrations or code with outbound effects; otherwise the check stays open for a person. Unset: the command always runs (see Person checks) |
| `worker_checks` | none | file only | commands every worker must pass before opening a PR (a list) |
| `always_tests` | none | file only | tests every worker runs on top of the ones for the files it changed (a list) |
| `flaky_tests` | none | file only | test files known to fail now and then: when they are the only failures of the full check, the reviewer reruns them once (a list) |
| `guard_tests` | none | file only | path globs mapped to repo-wide tests a worker must run when its diff touches a matching path, e.g. `{"src/routes/**": ["test/admin.test.ts"]}` (see Guard tests) |
| `context_warn_percent` | 40 | `/config`, file | the context limit as a percent of the window (1 to 100) |
| `context_warn_percent_1m` | 35 | `/config`, file | the same as `context_warn_percent`, for agents on a 1M window (1 to 100); the 200k percent never applies to them |
| `context_warn_tokens` | 0 | `/config`, file | an optional cap in tokens over both percents; the lower applies. 0 = off, percent only. Drives the handoff, the meter marker and the yellow point |
| `handoff` | on | `/config`, file | workers and managers: at the limit they are told to hand off (see Continuing work). Off: the meter only shows |
| `base_branch` | the remote's default branch | `/config`, file | everyone |
| `main_checkout_guard` | on | `/config`, file | every agent and the main session: writes to the main checkout are refused (see Guards) |
| `cleanup` | `auto` | `/config`, file | `auto`: the plugin removes finished, clean worktrees and branches after each merge and when the reviewer ends (see Cleanup). `off`: only `/flow clean --yes` |
| `worker_harness` | `agent` | `/config`, file | managers: `agent` starts `flow:worker` agents; a harness name (`codex`, …) starts every worker in a terminal instead (see Workers in other harnesses) |
| `session_host` | `auto` | `/config`, file | where session workers run: `auto` (Orca when it runs, else tmux), `orca`, `tmux` |
| `harnesses` | the four built-ins | `/config` (JSON string), file | harness name to a start line or `{start, resume?, program?, quota?, digest?}`, over the built-ins; `""` removes one |
| `min_quota` | 10 | `/config`, file | a session worker whose harness has a `quota` is refused below this percent left; 0 = never |
| `main_checkout_allow` | `.claude/` | `/config`, file | paths still writable in the main checkout, comma-separated, relative to the repo root; one ending in `/` covers a directory. Replaces the default |

`decision_phrases` (deprecated in favour of `mcp__flow__ask`, still honoured; the settings loader warns): a report counts as asking when its last line ends in `?` or `？`, or its last paragraph contains one of the phrases (case-insensitive), unless the phrase directly follows a negation (`不`, `不用`, `不必`, `無需`, `毋需`, `不需要`, `no `, `not `, `don't `, `no need to `): "不需要你決定" does not match `需要你決定`. The pane, the toasts and the task graph all use it.

An unset full check or deploy is a step that's skipped and reported, never improvised.

The reviewer was called the merge queue before. For older setups the agent type `flow:queue`, the tool `mcp__flow__queue` and the settings `merge_queue` and `queue_model` still work as aliases of `flow:reviewer`, `mcp__flow__reviewer`, `reviewer` and `reviewer_model`; the old settings names are deprecated and warn once.

Sub-agents don't run on Fable: a Fable model is refused in settings (a warning, the default applies) and denied at spawn, for flow agents and for anything a flow agent starts.

### Settings per repo

A repo can carry its own settings in `.claude/flow.json`, a flat JSON object with the same snake_case keys as `/config` (plus the file-only ones in the table above):

```json
{
  "test_command": "pnpm test",
  "worker_checks": ["pnpm lint", "pnpm typecheck"],
  "guard_tests": { "src/routes/**": ["test/admin.test.ts"], "sql/**": ["test/migrations.test.ts"] },
  "big_files": ["src/schema.ts"],
  "worker_model": "sonnet"
}
```

A personal overlay lives in `<git-common-dir>/flow/config.json` (that is `.git/flow/config.json`) and is never committed.

Precedence, lowest first: built-in defaults, `/config`, `.claude/flow.json`, the personal file. For `worker_checks`, `always_tests`, `flaky_tests`, `big_files` and `decision_phrases` the personal file's entries are added to the repo file's, each once; `guard_tests` is merged per glob (the personal file's tests are added to the repo file's for the same glob, each once); every other key is replaced.

An unknown key, bad JSON or a wrong type is a warning (shown as a toast) and the layer below applies for that key or file.

The files are checked every few seconds by modification time. New settings apply to agents started afterwards; running agents keep their prompts.

## Tools the agents use

- `migrations` (read-only; used by the reviewer): `prs` (PR numbers in merge order) and `ref` (default HEAD). It reports the highest migration number on the base branch and at `ref`, each PR's added migrations as ok, clash or at-or-below, the next free number with its zero padding kept, the suggested `git mv`, and where the PR references the old number.
- `release`: the reviewer, once per batch before the push (release on): cuts the changelog, bumps the version files, returns the commit command (see Releases).
- `handover`: a manager hands a reviewed PR over (optional `release`: `patch`, `minor` or `major`; optional `env`: a list of `{target, name, value | secret: true, why, login?}` env changes, one inbox item each, see Deploying; `target` must be a configured deploy target, `name` an env variable name, an entry with both `value` and `secret: true` is refused without repeating the value, and a non-empty `env` is refused when no deploy target is configured; a secret has no value in flow; optional `verify_command`, a shell command the reviewer runs after merge to close a needs-a-person check, see Person checks); the plugin records its head and starts
  a reviewer if none is running. `report_to` is optional and defaults to the caller's own name
  (`main` for the main session). A name that matches no agent of the session is refused, naming
  the caller's own name; the caller's own worker's name is corrected to the caller's, with a note.
  When the reviewer messages a `report_to` manager that has already finished, the plugin does not wake
  it: it adds the report to that manager's notes and sends it to main. A manager that someone other
  than main woke (reviewer, worker) has its turn-end report forwarded to main as well.
  It refuses a PR whose description has no valid `## Verification` section (checked after the
  closed and draft checks), records nothing and starts no reviewer, and lists every problem with the
  expected format. Fix with `gh pr edit <n> --body-file <file>` and call again. The format:

```
## The test lock

Six worktrees running the whole suite at once can exhaust memory and time out the real check.
Workers call `test_slot` `acquire` before a heavy run (a whole suite, anything over about a
minute) and `release` after it; the reviewer does the same around the full check. At most
`test_slots` runs hold a slot; the rest wait first come, first served. A hook has a 10 second
budget, so `acquire` waits at most a few seconds and then answers "queued, position N". The
head of the line is granted a free slot at once and told two ways: a file
`<git-common-dir>/flow/test-slots/<agent>.granted` (wait with `until [ -e FILE ]; do sleep 3; done`)
and a message; it confirms with one `acquire` within 2 minutes, else the grant passes on. A slot is
freed when its agent ends, when released, or after a 45 minute lease (with a toast). The Flow
status line shows `tests 1/1`. The lock lives in this session's plugin state: it covers every
worktree of the session's agents, not other Claude sessions, and a plugin reload empties it.

## Guard tests

`always_tests` runs on every PR, which a small machine cannot afford. `guard_tests` is the cheaper
form: a map from path globs to the repo-wide tests (a route-permission test, a migration test) that a
worker must run only when its diff touches a matching path.

- Globs match the whole repo-relative path: `**` any number of directories (also none), `*` within
  one path segment, `?` one character. There is no basename matching: write `**/routes/*.ts`.
- A worker calls `guard_tests` before `gh pr create`. With no arguments the plugin works out the
  changed files itself (`git diff origin/<base>...HEAD` plus uncommitted and untracked files in the
  worker's worktree) and lists each test with the glob and files that require it. The worker runs
  them under `test_slot` and lists each under `Ran:`.
- `handover` reads the PR's files with `gh pr diff <n> --name-only` and refuses a PR whose `Ran:`
  lacks a required test, naming the glob. If `gh` fails, handover refuses with its error.
- When the reviewer sends a PR back for a failing test (`reviewer back` with `failed_tests`) and no glob
  requires that test for the PR's files, main gets one non-blocking inbox question suggesting a
  mapping (the deepest common directory of the changed files, as `dir/**`). Answering "Add it to my
  personal flow config" writes it to `<git-common-dir>/flow/config.json`; copy it into
  `.claude/flow.json` to share it. Flow never edits the committed file.

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
  preflight.json           pre-flight filings and rounds (see Pre-flight)
  checks.json              person checks and their follow-ups (see Person checks)
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
npm ci                           # the pinned TypeScript (devDependency, no runtime deps)
npm run typecheck                # tsc -p ., must report 0 errors
npm run validate                 # claude plugin validate . (must pass)
npm run check                    # typecheck + validate + claude plugin test .
```

`npm run typecheck` works in a fresh worktree: it runs `npm ci` when `node_modules` is missing and,
when `.claude-plugin/types` is missing, symlinks it to the main checkout's copy. Claude Code writes
those type definitions itself (gitignored, per Claude Code version) when it loads the plugin from a
folder you own, so open a session in the main checkout with `claude --plugin-dir .` once. Flow
ignores and removes such links when it cleans a worktree. The repo's `.claude/flow.json` makes
`npm run typecheck` and `npm run validate` worker checks and `npm run check` the reviewer's full check, so no PR merges
with type errors.

Do not change `version` in `.claude-plugin/plugin.json`: this repo has `release` on, so add your changelog lines under `## [Unreleased]` in `CHANGELOG.md` and the reviewer bumps the version and cuts the release at merge (that is what `claude plugin update flow@flow` picks up).
