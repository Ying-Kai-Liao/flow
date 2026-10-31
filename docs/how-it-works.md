# How flow works

The details behind the [README](../README.md): roles, what the pane shows, pre-flight, the inbox, merging, releasing and deploying. Settings, tools and files on disk are in the [reference](reference.md).

For one task's path from request to cleanup, read [Life of a task](task-lifecycle.md) first.

Sections, in order: roles, dependencies, what you see, pre-flight, questions and the inbox, person checks, attachments, continuing work, merge mode, releases, cleanup, guards, reviewer rules, deploying, verification, workers in other harnesses.

## Roles

| Role | What it is | Job |
|---|---|---|
| Super manager | your main session, with the `dispatch` skill | splits your request into tasks, starts one manager per task, relays questions and answers |
| `flow:manager` | background agent, named after its task | writes briefs, starts workers, reviews their PRs, hands approved ones to the reviewer; refused if it tries to edit code; hands off to a `-2` manager at the context limit |
| `flow:worker` | background agent in a worktree of its own | builds one brief, pushes `flow/<name>`, opens a PR, reports or asks; at the context limit it pushes its work and writes a handoff note |
| `flow:reviewer` | background agent, started by the plugin | merges handed-over PRs in batches, runs the full check once per batch, pushes, deploys, releases, reports back (the plugin fast-forwards the main checkout on its "done") |

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
  A running agent shines: a bright stretch sweeps along its name once per second (the pane's tick) and its card border takes the suggestion color; waiting, idle, pending and ended agents stay plain.
  A worker told to hand off shows a `handoff` badge while it wraps up, and "handed off" once it ends with a `HANDOFF:` line.
  Click a card to see the agent's activity, when it was last active, and its last report or question. The agents under it
  are cards too: click one to open it. **Message** starts a message to it in your prompt;
  **Back** returns to the agent above it, or to the tree from a top-level agent.
  `/flow inbox` lists the open questions (see Questions and the inbox), `/flow checks` lists the after-deploy checks that need a person (see Person checks), `/flow close` closes the pane, `/flow home` (or Esc in the pane) returns it to the home view, `/flow resume` picks up unfinished work, `/flow approve <n>` approves a PR waiting for you and `/flow reject <n> [reason]` (alias `/flow drop`) turns one down (see Merge mode), `/flow preflight` shows the pre-flight round (see Pre-flight), `/flow lite <task>` runs one task as a manager and its workers only (see Lite mode), `/flow clean` lists leftover worktrees and branches (both below). It stays closed while agents keep running, until the next
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
  are done (ended, a terminal manager that reported and sits idle, or one a PR was handed over to
  since it started), or after `preflight_wait` minutes, the main session gets one message, "Pre-flight: 15
  tasks, 2 already shipped, 3 depend on others, 6 questions", with each task's criteria and
  findings and the open numbered questions (answered ones are left out). You answer once. Managers still in recon at the timeout
  follow as "Pre-flight (late): ..."; a done manager shows as e.g. "handed over a PR without
  pre-flight" and is not waited for. A round or late filing that tells main nothing it was not
  already told (every manager as last reported, no new open question) is not sent.
- `/flow preflight` shows the open or latest round; `mcp__flow__status` shows the phase.
- **Skip**: a line `Pre-flight: skip` in a manager's prompt exempts it (the main session uses it
  for a single small change). A `Mode: lite` line implies it (see Lite mode). With `preflight` off, nothing is gated.
- Settings: `preflight` (`on`/`off`, default on) and `preflight_wait` (minutes, default 10).
  State is in `<git-common-dir>/flow/preflight.json`.

## Lite mode

A task can run lite: one `flow:manager` and its workers, nothing else. It saves the pre-flight round,
the size decisions main would otherwise handle, the manager's large model and the separate reviewer
agent. Use it for a single clear task with no fan-out and no risky change; keep the full flow for
several tasks at once, work that depends on other tasks, and anything touching migrations, deploys,
auth or data.

- **Start**: `/flow lite <task>` (no text prints the usage), or a line `Mode: lite` on a `flow:manager`
  prompt that main starts. It is per task; there is no global switch. `/flow lite` submits a short prompt
  to main, which starts the manager with that line.
- **What changes for a lite manager**: it is recorded in `<git-common-dir>/flow/lite.json` (it stays lite
  after a restart, and a successor `x-2` of lite `x` is lite too) and the plugin puts a LITE block in front of
  its prompt. It is skipped in pre-flight like `Pre-flight: skip` and never waits in a round. The plugin files
  no `manager-size` or `worker-size` decision for it or its workers (the routing itself still sets their
  models); other decisions and questions it files go through. Its model is chosen as for any manager
  (`manager_model`, or a `Size:` line on its prompt).
- **No reviewer agent**: `mcp__flow__handover` for a lite manager's PR still checks the PR and its
  `## Verification` section, then records the PR as `taken` by the manager (marked `lite`) and starts no
  reviewer. It answers with the steps to merge the PR itself, in the reviewer's order, for this repo's
  settings: the full check in a clean worktree on the merged head, the release cut (release on), the push
  after a fetch (rebase and recheck when the base moved), the release publish, the deploy gates, then
  `reviewer` action `done` (which fast-forwards the main checkout and deletes the branch) and `clean`. With
  `push_mode` confirm it saves the batch with `reviewer` action `ready` instead of pushing, and `/flow push`
  handles it like a reviewer-built batch.
- **Falls back to the reviewer**: when `merge_mode` is `confirm`, or the PR is risky (migrations, data
  rewrites, deploy, CI or infra, auth or secrets, deletions), the lite manager hands over with
  `mode: "confirm"` and a normal reviewer takes it after `/flow approve`. The manager says so in its report.
- **Tool access**: a lite manager may call `release` (cut and publish), `reviewer` `ready` and `done`, and
  `deploy` `gate`, `deployed` and `env-applied` for its own lite PRs only. A manager that is not lite and every
  worker are refused those calls. `deploy` `hold` and `release`, and `push`, stay main's.
- **Short report**: a few lines: the PR, merged / ready for `/flow push` / handed over, the check result,
  the released version.

## Questions and the inbox

Questions reach you as one batched, numbered inbox instead of free-text reports.

- An agent asks with `mcp__flow__ask` (`from` = its name, `questions`: each with `question`,
  `options` (at least two), a recommended `default`, `blocking`, optional `context` and `topic`).
  One call can carry a batch. A worker's questions reach its manager as one message, a manager's go to you; main cannot ask. Each
  gets an id (`q7`); asking the same open question twice returns the existing id. They are kept in
  `<git-common-dir>/flow/inbox.json`, so they survive restarts.
- **Non-blocking**: the agent goes ahead on the default and says in its report or PR that it
  assumed it; a message comes only if the answer differs. **Blocking**: it ends its turn and waits;
  the answer wakes it as a message, also when it showed as completed or left the roster (it is not
  finished, and `status` shows "waiting on q7"), and it continues from the answer. An asker that
  failed or was killed cannot be woken: the answer is noted for its owner and sent to main. A worker
  continued as `name-2` gets the answer instead.
- **Escalation**: a manager passes a worker's blocking question to you with `mcp__flow__ask` and
  `for: "q7"` (the worker's open question addressed to it). The worker's question then shows as
  escalated; your answer to either question closes both, the worker hears "main answered q7 via
  <manager>" and the manager is told. A second answer to the other one is refused as already answered.
  The manager may still answer q7 itself; that closes its escalation and tells main.
- `/flow inbox` is the person's view: a one-line summary, the questions (blocking first; deploy, push,
  env and guard items tagged NEEDS YOU) with the options on one line (default marked) and age, the decisions
  as one flat table (id, from, headline, age; newest first, the newest 15 and a `+M more` line, `/flow inbox decisions`
  lists all), then what standing answers did. Rows never wrap and headlines are cut with an ellipsis;
  `/flow inbox <id>` prints one item in full, with its why. `worker-size` and `manager-size` decisions are filed already kept (see Decisions); one still open (an escalate rule for its topic, or filed by an older version) is routine, and routine decisions and those of agents that are over are folded into one line (`/flow inbox decisions` lists them, `/flow ok` keeps them with the rest); nothing expires or is acked by itself. `/flow inbox archive` lists what was answered, newest first (50; `archive all` for every one). `status` and the Flow pane show the open inbox first. An agent
  with an open blocking question shows as asking in the pane, the toasts and the task graph.
- You answer from the prompt: `/flow ok` keeps every open decision, `/flow ok d10 d11` or `/flow ok <owner|topic>`
  keeps those (an ordinary question named by id takes its default), `/flow no d12 <what instead>` undoes
  a decision, `/flow answer q3 b` answers any open question (option letter, number, text or free
  text), also one a worker asked its manager: you override the manager, the asker is told "the user answered",
  and a live manager is told the question is closed. A deploy, push, env or guard item is never answered by `/flow ok`; only `/flow answer` does. All of
  them go through the same path as `mcp__flow__answer`, so delivery, notes and standing-answer suggestions
  are unchanged. Main (the agent) answers with `mcp__flow__answer`: `answers: [{id, choice}]` where choice is the option text, its
  letter or number, or free text; or `defaults: true` to accept the defaults of decisions and non-blocking questions; a blocking question is skipped unless its id is in `ids`.
  **In the pane**: with anything open, the key row at the bottom shows `i inbox`. The inbox view lists every
  open question (blocking first; `for <manager>` marks those not addressed to you) and decision (newest first, one row each) with one highlighted row, its options
  and `why:`. Keys: `j`/`k` move, `1`-`9` or `a`-`h` pick that option of the highlighted item, `y` takes a
  question's default or keeps a decision, `w` keeps all open decisions, `n` undoes the
  highlighted decision (with what you typed in the answer field as "what instead"), `r` types a free-text answer
  (Enter sends), `x` folds or expands the group of routine decisions, `v` opens the archive, `i` goes back. Pressing a row opens the item as a large card (also from an open question or decision listed in the tree): full text and why, who asked and for whom, the asker's status, every option as a button (digits and `a`-`h` except `b`, which is Back), the input for your own words (a decision's input is "what instead"), `y`, `n`, `j`/`k`; after an answer the next card opens. The archive's cards are read-only. Deploy, env, push and guard items are never
  answered by `y` or `w`: only their own digit or letter, or free text, answers them. Every answer
  goes through the same path as the `/flow` commands.
  The addressee answers with `mcp__flow__answer` (you, from the prompt or the pane, may answer anything): your main session for managers' questions (tell it "defaults", "1 b,
  3 defaults" or free text), a manager for its workers'. The answer is messaged to the asker and
  recorded as a decision note. If the asker is gone, the result says undelivered and the main
  session relays it to the successor (`<name>-2`).
- **Decisions.** For a reversible choice (a threshold, wording, a name, a default) an agent does not ask: it
  decides, continues, and records `mcp__flow__fyi` (`from`, `items: [{decision, why, alternative?, topic?}]`;
  the batch is validated whole, main cannot call it). A decision is a non-blocking inbox item (stored `kind: "fyi"`,
  its own `d<n>` ids from a separate counter, options Keep / Undo, default Keep; a decision filed before they had d-ids was
  migrated to one and keeps its old q-id as an alias that every command and `mcp__flow__answer` still accepts), addressed like an ask: a worker's to its
  manager, a manager's to main. Nobody is messaged or toasted when one is recorded, and it never
  counts as asking. `/flow inbox` lists them in their own section, `status` and the pane as a count.
  `mcp__flow__answer` keeps it (the choice Keep, or `defaults: true`, also with `ids`): no message. Any other
  choice, free text included, undoes it: the owner is messaged what it decided and what to do instead,
  or, if it is no longer running, its manager (naming the owner); the undo is noted as a decision.
  The addressee may answer a decision, and so may main (the user overrides what a manager has not looked at).
  A decision is kept by a standing answer only through a rule that names `"kinds": ["fyi"]` (see Standing answers); it stays undoable.
  The plugin's own size decisions (`worker-size`, `manager-size`, filed at spawn below large) are filed already
  kept (`answeredBy: "default"`): they came up often and were always kept, so they are never open in the inbox,
  the pane, `/flow ok` or `defaults: true`. They are still recorded (the archive and `/flow inbox <id>` show
  "Kept (by default)") and undone by id exactly as before (`mcp__flow__answer` `{id, choice: <what instead>}` or
  `/flow no <id> <what instead>`): the owner is messaged and the undo is noted. A standing rule that applies still
  answers one first (its id on it), and an escalate rule for the topic leaves it open for you. They never count
  toward a suggested rule.
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

- A rule is `{id?, topic?, match?, answer, blocking?, from?, kinds?, options?, note?}` (or, see below, `{..., escalate: true}`) in the `standing_answers` list of a
  settings file. `topic` equals the question's topic (any case); `match` is a case-insensitive regular
  expression on the question text; with both, both must match. No fuzzy matching. `answer` must be one
  of the new question's options (text, letter or number), else the rule does not apply and the question
  goes to the inbox. `from` limits it to one asker (`foo-2` counts as `foo`). A blocking question is
  answered only by a rule with `blocking: true`. A bad rule is dropped with a settings warning.
- Pushed suggestions. When main has answered a topic (or, with no topic, one exact question text) the
  same way 3 or more times and no rule covers it, main's next `mcp__flow__answer` result (`defaults: true`
  included) or `mcp__flow__status`, whichever comes first, gets one line offering
  the rule with its exact `mcp__flow__standing` add call, and the Flow pane's inbox shows it as a `+ rule?`
  line (`s` hides it). Each (topic, answer) is offered once (`suggest-offered.json` in the state dir);
  `mcp__flow__standing {"action":"dismiss","id":...}` (or `"all"`) drops it for good. Nothing is added
  until you call the add. Decisions main kept count too: three kept decisions of a topic suggest
  `{"topic":"<topic>","answer":"Keep","kinds":["fyi"]}`; size decisions kept by default do not. A group holding a deploy, env, push, reviewer,
  guard, escalated or linked item is never suggested.
- Decision rules. A rule with `kinds: ["fyi"]` (answer `Keep` only) keeps a fresh routine decision the
  moment an agent records it (`answeredBy: "standing answer"`, the rule id on it, an `auto-answer` log
  line); the agent's result is unchanged. It runs before `decide_inbox`, which then skips the item. An
  ordinary rule (no kinds) does not keep a decision an agent records, an fyi rule never answers a question, and escalate rules still
  win. Undo it like any kept decision (`/flow no <id>`); the owner is messaged.
- Matching. Topics compare ignoring case, `_`, `-` and spaces and one trailing "s". A rule made from a
  topic-less question also records its `options`; such a question matches only with the same option set and
  its text matching `match`. No fuzzy matching. Deploy and env items still need a rule naming the kind;
  push and reviewer items are never answered by a rule.
- Two more forms. `escalate: true` with no `answer` holds a matching question for you: no rule ever
  auto-answers it (whatever the order), it is recorded `blocking: true` and flagged
  `escalated: <rule id>`, and `mcp__flow__answer` refuses an answer from anyone but main; a worker's
  it is addressed to main (a worker's manager is told so and must not answer or re-ask it), and `/flow inbox` marks it ESCALATED. `answer: "default"` (the literal word)
  answers a matching non-blocking question with its own default and never touches a blocking one.
  A rule with both `escalate` and an `answer` is invalid and dropped with a warning.
- On by default: `conservative`. Unless the setting `conservative_default` is `false`, an implicit rule with id
  `conservative` (`{"match":".","answer":"default"}`) comes after all of yours: a fresh non-blocking ordinary
  question takes its own default at once, so neither the manager nor you has to answer it. The asker's result says
  "answered by standing answer conservative", and the inbox records `rule: "conservative"`. It never answers a
  blocking question, a decision, a deploy, env, push or reviewer item, a guard suggestion, an escalated question
  or one linked to another (`for`); person checks are not inbox items. Your own rules, and escalate rules, win
  over it. `standing list` shows it; `remove` of it says to set `conservative_default: false`. Adding the
  `conservative` seed yourself writes it to your personal file, and the implicit one then steps aside.
- Seeds. When no rule exists in any layer, `standing list` and the first `status` call by main
  (once; `seeds-offered.json` in flow's state dir, next to `inbox.json`, records it) show "Suggested
  starting rules (not applied)": `tracker` (never write to an external task tracker without your yes;
  topic `external-tracker`, escalate), `prod-env` (production environment changes always ask; topic
  `prod-env-change`, escalate) and `conservative` (non-blocking questions take their own default; offered only
  while `conservative_default` is `false`, since it is on by default). The implicit rule does not count as one of yours.
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
- **`/flow checks`** shows the open checks as one table, a row each (id, PR, title, what it needs, age) that never wraps: the title is cut to the terminal width, and a narrow terminal drops age, then needs. Groups: "Try now" (the installed version covers it, or it names no version), "Needs install of X" (one group per version, ascending), "Version unknown" (the installed version cannot be read). Open follow-ups of failed checks have their own section. The footer lists the person commands. `/flow checks <id>` shows one check in full: steps, verify command, note, and how and when it was closed. `/flow inbox` has a "Checks" section with the count, the pane has a `Checks: n open` line, and `/flow resume` lists open checks (for the user, nothing to start) and open follow-ups (for main to start).
- **Pass and fail.** `/flow checks pass <id...>` closes checks as passed. `/flow checks fail <id> <note>` fails one check; the note (what went wrong) is required. A failed check creates a follow-up for main: main starts a manager on it with the PR, the steps and the note, then marks it with `mcp__flow__check` `started` (id and manager name). `/flow checks skip <id...> <why>` closes checks that no longer apply (superseded, cannot be run) as skipped; the reason is required and a skip makes no follow-up. Closing a closed or unknown id is refused, and nothing is closed when any id is refused.
- **Who closes.** The user with `/flow checks`, or main with `mcp__flow__check` (pass, fail, skip) on the user's word. The reviewer may close only a check that carries a verify command, see below.
- **After an update.** Once per installed version, when an update installs the version some open checks were waiting for, a one-line toast says how many can now be done and points at `/flow checks`. It is not a prompt: an update never starts a turn in main.
- **Scripted checks.** A manager can pass `verify_command` (a shell command, such as an e2e or smoke run) on `mcp__flow__handover` when the after-deploy check can be scripted. If the check still needs a person, the reviewer runs the command at the merged main and closes the check itself: pass on exit 0, fail otherwise. The file-only `verify_paths` setting limits this: when set and the PR changes no matching file, the command is skipped and the check stays open for a person, with a note saying so.

Not to be confused with the check-only verify worker (for after-deploy checks an agent can do, see Deploying), decisions and standing answers (see Questions and the inbox).

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

Run `/flow reject <n> [reason]` (alias `/flow drop`; yours only) to turn a handover down instead. It works on awaiting and pending handovers, not on one the reviewer has taken. The handover becomes `returned` ("declined by the user" plus your reason), its env items close, the manager is messaged, and the GitHub PR and branch are not touched. Separately, a handover whose PR was closed on GitHub without a merge is returned on its own ("PR closed on GitHub"); merged PRs count as done.

## Push gate

`merge_mode: confirm` asks before a PR is merged and a deploy target in `confirm` mode asks before it deploys. `push_mode: confirm` sits between them: the reviewer merges, checks and releases a batch, then stops before the push. You look at the batch and start the push yourself. (`push_mode` is `auto` by default; unknown values mean `auto`, and with `auto` the reviewer's instructions are unchanged.)

The sequence:

1. The reviewer builds the batch, runs the full check and cuts the release as usual. Then it does not push, delete branches, publish or deploy. It saves the batch head under the local ref `refs/flow/push/<id>` (the id is the first 8 characters of the head sha) and records it with `mcp__flow__reviewer` action `ready`. The PRs get the status `ready` (⇪).
2. The batch is shown at the top of the pane with the commands, in `mcp__flow__status` under "Needs the user", first in `/flow resume`, and as an inbox item of kind `push`. A toast says it is ready.
3. You look at it (the PRs, their evidence, the check result, the version), then run `/flow push`. A reviewer checks that the base did not move, pushes, deletes the merged branches, marks the PRs done, publishes the GitHub Release (`release_github`) and deploys, as in a normal batch.

Other ways out:

- **Send back.** `/flow push back <pr>` returns that PR to its manager (reason "sent back by the user at push"). The rest of the batch is rebuilt, re-checked and asked again as a new batch. Sending back the last PR ends the batch.
- **Drop.** `/flow push drop` returns every PR of the batch (reason "batch dropped by the user at push"). A dropped batch may be handed over again as it was.
- **Base moved.** If `origin/<base>` moved between the build and your push, the reviewer never pushes the stale batch. It rebuilds it on the new base (the same PRs, in the same order), runs the full check, cuts the release again (`mcp__flow__release` with `recut`) and asks you again. A PR whose head moved or that no longer merges is sent back.
- **Nothing to push, or twice.** `/flow push` with no batch answers "Nothing ready to push."; once released, a second `/flow push` (or back or drop) is refused because the batch is already being pushed.

While a batch exists, in any state, new handovers stay pending: no second batch starts, and handing over a PR that is in a ready batch again is refused.

The batch lives in `<git-common-dir>/flow/push.json` with the state `ready` (awaits you), `pushing` (released) or `rebuilding`; the local ref keeps the checked commit even when the reviewer's worktree is gone. After a restart, a `pushing` or `rebuilding` batch gets its reviewer started again; a `ready` batch only reappears in the pane, `status`, `/flow resume` and the inbox, and waits for you.

The inbox item asks "Push batch <id>: #n, #m as <version>?" with the options push, not yet (the default) and drop; you can also answer "send back #n". Standing answers never answer it, and taking the defaults (`defaults: true`) never pushes: the default is "not yet". Only a person's command, or main on your word through `mcp__flow__push`, releases a batch; managers, workers and the reviewer cannot.

## Releases

With `release` on, no PR touches the version, so parallel PRs never collide on a version number or a dated changelog section.
- Workers add their changelog lines under `## [Unreleased]` in `changelog_file` and never change the version. Managers check that when they review, and pass `release: "minor"` on the handover for a new feature users see (or put the `flow:minor` label on the PR; `flow:major` / `"major"` only when the task asks). Everything else is a patch.
- After the full check passes and before the push, the reviewer calls `release` once per batch: it moves the Unreleased lines into a new `## [x.y.z] - date` section (a PR title per merged PR when Unreleased is empty) and bumps the version in each `release_files` entry by the highest bump asked in the batch. The reviewer commits "Release x.y.z" and pushes it with the merges. A retried push does not release twice.
- With `release_github` on too, after the push succeeded the reviewer calls `release` with `action: "publish"`: the plugin makes an annotated tag `v<x.y.z>` on the "Release x.y.z" commit, pushes it, and runs `gh release create` with that version's changelog section as the notes (retried with backoff; skipped when the tag and release already exist, so a repeat is harmless). It needs `gh` logged in with repo write. A failure is reported ("GitHub Release: failed: ..."), never sent back as a PR failure: the release commit is already pushed. Past versions are not backfilled.
- Protected branches: an admin bypass lets the reviewer's push through. When the push is refused (`enforce_admins`, "Changes must be made through a pull request", a ruleset), the batch goes in through a batch PR (see Reviewer rules) and the release is published only after that PR merged; tags are not covered by branch protection.
- The release refuses (and the reviewer says so) when the setting is off, no version file is found, or the changelog is missing.
- Recommended for repos that turn it on: a `.gitattributes` line `CHANGELOG.md merge=union`, so Unreleased lines added side by side merge without conflicts.

## Cleanup

Finished agents leave worktrees under `.claude/worktrees/` and local branches (`flow/*`,
`flow/*-N`, `worktree-agent-*`, anything else). Terminal sessions in the terminal host leave theirs
in the host's workspace directory instead: a worker's on `flow/<name>`, a terminal manager's
detached `mgr-<name>` host worktree, the terminal reviewer's detached `reviewer-<n>`.

**Which worktrees count.** Besides everything under `.claude/worktrees/`, any linked worktree flow
made, wherever it lives: one on a `flow/` branch, one that is a session's recorded worktree or host
worktree (any status), and a detached `mgr-<name>` or `reviewer-<n>` whose name flow knows (a
session record or a `spawn` line in the log). Any other worktree is the person's own: never read,
listed or touched. Most PRs are squash-merged, so `git branch -d`
does not see them as merged; the plugin judges each by ancestry and by the PR's head sha instead
of by name.

**What goes.** A worktree of flow's (never the main checkout) when its HEAD is on
`origin/<base>`, or its branch has a merged PR whose head is HEAD (or contains it), or its branch's
PR was closed and HEAD is pushed; and `git status` is empty apart from the untracked type links
`types` and `.claude-plugin/types`; and no live agent works in it; and it is not locked, unless the
lock names an agent that has ended or a process that is gone; and its branch has no open PR. It
goes with `git worktree remove` (never `--force`), then `git worktree prune`; a directory already
missing is pruned. A worktree the terminal host manages (listed by `orca worktree list` while the
host is up) goes with `orca worktree rm` instead, also without `--force`, so the host's own list
drops it too; that also deletes its checked-out branch, so it is used only for a detached worktree
or one whose branch the same sweep removes. If the host is not up, `git worktree remove` as above. A local
branch when it is not checked out anywhere (a worktree removed in the same sweep doesn't count),
is not the base, has no open PR, and its tip is on `origin/<base>` or is the head of a merged PR
of that branch (or contained in it). It goes with `git branch -D`. Remote branches are never
deleted: the reviewer's `gh pr merge --delete-branch` does that.

**What stays, listed for a person.** Uncommitted changes (the files named), unpushed commits,
locked worktrees, a closed PR's branch, a worktree or branch a live agent or a running terminal
session uses (a session waiting or idle between turns counts as running), an open PR's worktree or
branch, and a handed-off worktree whose successor has not started yet. Nothing in that list is
touched in any mode.

**`/flow clean`** lists what would be removed and what is kept, and why; **`/flow clean --yes`**
removes. The tool `clean` (`apply`, default false) does the same for agents. One `git fetch
origin --prune` and one `gh pr list --state all` per sweep; when gh fails the sweep says so and
goes by ancestry only. Every sweep that removed something adds a `clean` line to `log.jsonl`.

**The automatic sweep** (`cleanup` = `auto`, the default) runs the same safe sweep in the
background after each PR the reviewer marks done, and when a reviewer agent ends (its worktree, detached
at the base, goes once the reviewer is gone). Between merges it also runs occasionally: when a
terminal session ends (a worker, a terminal manager), when a manager agent ends, and when main calls
`status` (never an agent's or a terminal session's call). Those occasional runs share one rate
limit, at most one every 10 minutes; the first one after a load only starts the clock, since startup
has just swept. Never two sweeps at once; errors go to the log.

Each occasional run first stops the terminal sessions that are finished, so their worktrees go in the
same sweep. Only sessions this main owns are stopped, and only once their report (or their end) is
at least 15 minutes old, so a follow-up from main or the reviewer can still reach them:
- a worker that reported or exited, whose own PR (exactly its branch) is merged or closed, with no
  handover still queued (pending, awaiting approval, taken or ready for push) and no open ask; no PR yet or an open PR keeps it, and when `gh` fails
  no worker is stopped;
- a manager that wrote its final report (`reported`; never one running or waiting) with no live
  worker session or agent of its own, no handover of its own or its workers' still queued, no
  open PR of its workers, no open blocking ask from it or its workers and no waiting, ready or
  running node in its plan;
- the reviewer, reported or waiting, while no handover is still queued. A new handover then
  starts a fresh reviewer.

A stop closes the terminal (a close that fails, the terminal maybe gone already, still counts),
marks the session `stopped` with when it ended, and writes `stopped: finished, <reason>` on its card
and in the log. The owner is not messaged. It never removes a worktree itself; the sweep right after
does, by its own rules. A reviewer report for a manager stopped this way is noted for that manager
and sent to main. The records of ended sessions stay (the sweep reads them to know flow's
worktrees); `session list` shows them short. With
`cleanup` = `off` nothing runs by itself, the tool's `apply` runs dry and says so, and only
`/flow clean --yes` removes. The pane and `status` show one dim line while there are leftovers,
e.g. `Cleanup: 3 worktrees and 12 branches can be removed, 1 holds work that isn't merged. /flow clean lists them` (zero counts are left out), from a dry sweep
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
- **Nothing changes the main checkout** (the repo's original folder, not the main branch) while flow has work in the repo: a worktree under `.claude/worktrees/` or a live flow manager, worker or reviewer. A repo where flow was never used is never guarded for the main session; flow's own agents are guarded always. Leftover flow worktrees keep the guard on until cleaned up (or `main_checkout_guard` is off). Edit, Write and NotebookEdit aimed at the repo's main
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
- **Bigger batches.** One reviewer, one push path, but each batch carries many PRs: right before the full check the reviewer lists once more and merges PRs that arrived meanwhile (also after the rework of a failed check), up to `batch_max` (default 10; 1 = one PR per batch). A push run or rebuild run takes no late joiners. The sha that is pushed is always one whose exact tree passed the full check; there is one release cut per batch, after the final check; the push gate, deploy gates and the re-check after a rejected push are unchanged. A terminal reviewer told "new handover" mid-batch never starts a second batch: the PR joins before the full check or waits. A handover on an idle queue starts the reviewer only after `reviewer_delay` minutes (default 3; 0 = at once), so handovers that arrive close together share one batch.
- **Failures in a big batch.** When failures do not clearly belong to one PR and the batch has more than 2 PRs, the reviewer bisects the first-parent merges (each step is a full check under the test slot) to the first PR whose merge breaks the check, sends it back, rebuilds the batch without it and checks the final HEAD again. A passing bisect step is never pushed on its own. When every failing test timed out, the full check is rerun once before the failure counts (the first run is released as "fail", the rerun as "pass", so the plugin records the flake). Only a test that fails in both runs, or a failure that is not a timeout, is real; when the rerun fails only on timeouts in tests that passed the first time, the batch passes, the rerun is released as "pass" and every test that failed in either run is reported as flaky.
- **Flaky tests.** With `flaky_tests` set, a full check whose failing tests are all in those files is rerun once for those files (through `test_command` with `{files}` if it has that slot, else the full check once more). If they pass, the batch passes and the report says "flaky rerun: <file> failed, passed on rerun". Any other failure, or a second one, is real.
- **Both-sides additions.** A merge conflict where both sides added lines at the same place (imports, list entries, registry entries, README table rows, CHANGELOG entries) keeps both, drops exact duplicates and keeps sorted lists sorted; the full check covers it and the report says "kept both sides in <files>". The same line changed differently, or a deletion against an edit, goes back to the worker.
- **Respawn circuit breaker.** A reviewer that ends with no answer, on an API error or within 30 seconds counts as a failed start, and the plugin does not replace it at once: the next start waits 30s, then 1m, 2m and 5m (the cap), and a start in between waits for the same timer. After 3 failed starts in a row, or 20 starts in a rolling hour whatever their outcome, the queue halts: no reviewer starts, handovers stay pending, `/flow status` and the pane show the last error (the answer text when the run failed, else "ended with no answer"; the host gives no error field), and one inbox item (kind `reviewer`, options retry / not now) asks main. Standing answers and defaults never answer it, and "not now" asks again. Answering `retry`, `/flow resume` or a new session clears the halt and starts a reviewer if work is pending; the failure count and the start times are kept, so one more immediate failure halts again and the hourly cap still holds. A run that lasts 30 seconds and ends with an answer resets the count. The state is in `reviewer-breaker.json`.
- **Protected base branch.** A push refused by branch protection or a ruleset (GH006, GH013, "protected branch", "Changes must be made through a pull request", "Repository rule violations") never sends a batch that passed its check back. The reviewer pushes the batch to `flow/batch-<id>` (the first 8 characters of the batch head), opens a PR into the base titled "Batch <id>: #a, #b" with the PRs, the check result and the checked head's sha, waits up to 30 minutes for its required checks (`gh pr checks --required --watch`; none reported means nothing to wait for), checks that the base has not moved, and merges with `gh pr merge --merge --match-head-commit <batch sha> --delete-branch`. gh pins the head but not the base, so after the merge the reviewer compares the merge commit's tree with the checked head's. When they differ (the base moved in the seconds before GitHub merged), it runs the full check on the merge commit before anything is published or deployed: a pass deploys the merge commit ("base moved during merge; checked again at <sha>"), a failure deploys nothing, marks the PRs done with that failure (they are in the base and cannot go back) and tells main. Requiring branches to be up to date on the base closes that window on GitHub's side; that setting is yours, flow never changes it. The merge commit keeps every batched PR's head in the base history, so GitHub marks them merged and "done" deletes their branches and fast-forwards the main checkout as after a direct push. Publish, deploy (the batch sha), after_deploy checks and "done" follow as usual, with "merged via batch PR #<n>" in each done line; for the rest of the run the reviewer skips the direct push. A failed required check is a failed full check: the batch PR is closed and the batch reworked. A moved base is merged in, checked again and pushed to the same batch branch, which updates the same PR (in a push run the batch is stale and rebuilt instead). A merge only you can unblock (review required, merge commits disabled, gh not logged in, the wait bound hit) leaves the batch PR open, sends nothing back and tells main: merge it on GitHub or fix the setting. At the start of each batch the reviewer looks at the batch PRs an earlier run left open: only its own branch names, `flow/batch-<8 hex>` and the hand-made `flow/batch-ready-<sha>`, never a worker branch that happens to start with `batch-`. One that can still go in as checked (its PRs still taken at the same heads, its head the checked one, no failed required check) is kept and resumed before the new batch: a moved base is merged in and checked again, then it is merged as above. One still blocked on you stays open, main hears again once per run, and its PRs stay out of the new batch. The others (a PR sent back or moved, a failed check, a title with no PR numbers) are closed as superseded and their PRs come back as usual. A batch PR you merged on GitHub yourself is picked up too: its PRs are not merged again, and when no target has deployed them yet they ride with the run's deploy (with no other PR, the base head is checked and deployed as it stands) and are marked done "merged earlier via batch PR". In a push run, a batch whose sha is already in the base was merged through its batch PR: it is checked as merged and deployed, not rebuilt. The status-file commit goes the same way (`flow/status-<id>`, no deploy), and so does a lite manager's push. The batch branch is the reviewer's own and the only remote branch it removes, through `--delete-branch`; the cost is one refused push per run.
- **Handoff point.** A long-lived reviewer would run on auto-compaction for hours, so it hands off the way managers do. After a "done" or "back", when no PR is taken, no push or rebuild run is in flight and no handover is pending, a reviewer past `reviewer_handoff` percent of its context window (default 50, 0 = never) reads a "flow: HAND OFF" line in that answer, once: it finishes the batch's steps, skips the final list and ends with its report (a list answers the same). A terminal reviewer writes its report, and the plugin stops its session and removes its worktree. With handovers pending it keeps working and hands off at the next such point; a batch that awaits `/flow push` does not hold it. Its worklist and the batch live in the plugin, so a fresh reviewer loses nothing: the next handover, or the end itself when work arrived meanwhile, starts one through the normal start path. A handover during the end waits for it instead of reaching the leaving reviewer, so only one reviewer works at a time, and the breaker counts the end as planned, never as a short, failed or unreachable run.
- **Where the reviewer starts.** In agent mode the plugin spawns the reviewer agent only from a tool.call hook of its own: an agent spawned from a timer gets none of its `mcp__flow__*` calls answered ("no tool.call hook answered this call"). A start that comes from anywhere else (the `reviewer_delay` timer, the breaker's backoff, a reviewer's end, `/flow resume`, `/flow push`, a pane press, a session start) is recorded as wanted, and the next tool call in the session, main's or any agent's, runs the whole start decision again and spawns the reviewer. A handover or a retry answer starts it within its own call. If no tool call comes within 20 seconds, main is asked once to call `mcp__flow__status`. A reviewer whose tools never reach the plugin counts toward the halt when it was spawned from that hook; an agent run recorded as spawned anywhere else does not, since that end is the plugin's doing. Terminal mode (orca, tmux) opens the reviewer's terminal at once from any of these.
- **Fast-forwarding the main checkout.** After a merge batch, when the main checkout is clean and on the base branch, the plugin (not the reviewer, which runs in an isolated worktree) fast-forwards it on each reviewer "done" with `git fetch origin <base>` (retried up to three times when a concurrent fetch in the shared `.git`, such as the auto cleanup sweep, holds the ref lock) and `git merge --ff-only origin/<base>`, so merged `.claude/flow.json` settings take effect. It uses the first `git worktree list` entry, requires no tracked changes and the base branch checked out, never stashes, resets or forces, and does nothing when the batch pushed nothing. The result ("main checkout fast-forwarded to <sha>" or "main checkout not updated: <reason>") is returned with the done.

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
- `fyi`: records a decision the agent took itself, non-blocking and undoable (see Questions and the inbox).
- `answer`: answers inbox questions (and keeps or undoes decisions) by id, or accepts the defaults; `always: true` (main) also makes a standing answer.
- `standing`: main only: list, add and remove standing answers.
- `check`: main only (the reviewer may close checks that carry a verify command): `list`, `pass` (`ids`, optional `note`), `fail` (`id`, required `note`) and `started` (`id`, `manager`) for a failed check's follow-up (see Person checks).
- `note`: a manager's notes (`manager`, optional `text`, `kind` decision or progress). Without
  `text` it returns the notes.
- `clean`: leftover worktrees and branches (see Cleanup); dry unless `apply` is true.
- `test_slot`: a lock on heavy test runs (`acquire`, `release`, `status`; `kind: "typecheck"` for the separate typecheck pool). See below.
- `guard_tests`: the guard tests the worker's diff requires (see Guard tests).

## Best of N

Off by default (`best_of_n`). With `brief` or `auto` a manager may start 2-3 competing workers (`best_of_n_arms`) on one hard package: the same brief, named `<pkg>-a`, `<pkg>-b`, `<pkg>-c`, plus a line `Arm: <letter> of <N>`. The arms are agent workers (never terminal sessions; a manager that runs in a terminal (`mode` `orca` or `tmux`) has no arms and its prompt omits them), each in its own worktree and branch, and each counts against `max_workers`. The plugin refuses an arm spawn when the setting is off, when N is above `best_of_n_arms`, when the letter does not match the name or the manager's workers would exceed `max_workers`. A letter can be used once per package slug (a new set of arms needs a new slug), and a successor manager (`mgr-2`) can pick its predecessor's groups. Arms only count against `max_workers` while working (an idle arm after a handoff does not). An arm that hands off continues as `<pkg>-a-2` and stays in its arm.

The oracle is the evidence first (arm PRs whose `## Verification` shows passing tests), then the manager's review. The manager calls `mcp__flow__arms` with `pick` (group, the winner's PR, a reason): the other arms' PRs are closed with a comment, the log records `arm-pick` and `arm-lost`, and an arm that still runs is named so the manager stops it with TaskStop. Only the picked arm's PR can be handed over; until then the arms are not listed as PRs nobody handed over, and after it the cleanup removes a loser's worktree and local branch once it is pushed and its PR is closed (unpushed or dirty work is still kept). `mcp__flow__arms` `report` shows each arm's cost, whether the winner merged and the overhead of the group over the winner; arms are one package, not reruns, in the size reports.

## Workers in other harnesses

A manager can run a worker outside this session, in any harness, with `mcp__flow__session`: when
the task asks for one ("do the UI part with codex"), and, in mode `orca` or `tmux`, for every worker
(`worker_harness` picks the CLI, `claude` by default). In mode `agent` a `start` is refused. Every harness is driven through its terminal with the same controls, so one that
flow knows nothing about (harness `command`, or one added in `harnesses`) is as controllable as a
built-in.

| Action | What it does, for any harness |
|---|---|
| `start` (name, brief, harness?, command?) | worktree on `flow/<name>` from the base, a terminal in it, the harness started with the worker rules and the brief |
| `send` (name, text) | types a message and submits it (a bracketed paste in tmux, so multi-line text stays whole) |
| `keys` (name, keys) | presses keys: `"1"`, `"y enter"`, `"escape"`, `"interrupt"` (Ctrl-C), `"down down enter"`; named keys are enter, escape, interrupt, tab, up, down, left, right, backspace, space, anything else is typed |
| `read` (name, lines?) | the end of its terminal |
| `restart` (name) | a fresh shell in the same tmux pane (`respawn-pane -k`) or a new Orca terminal, then the harness's resume line, or its start line with the same prompt when it has none |
| `list` | every live session, its harness, host, state and worktree; sessions that ended in the last 24 hours one short line each (name, state, how long ago); older ended ones as one count line |
| `stop` (name, remove_worktree?) | closes the terminal; removes the worktree only when it is clean and pushed |

- **Where.** In an Orca terminal (Orca is a terminal and worktree app; `orca worktree create`, then `orca terminal create`) or a
  detached tmux session (`git worktree add` under `.claude/worktrees/`; watch it with
  `tmux attach -t flow-<name>`). The host is the `mode` setting (`orca` or `tmux`),
  one for the whole run: there is no per-worker host and no fallback to the other.
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
  worker rules, then the brief. The preamble says: the report is a file, answers arrive typed into
  this terminal, and the flow tools: a claude worker's are relayed to main (see The relay below), so it
  takes test slots and calls guard_tests like an agent worker, and says "flow tools missing" first in its
  report if they never reach main; another harness loads no plugin and has none.
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

## Managers and the reviewer in a terminal

`mode` `orca` or `tmux` (default `agent`, which changes nothing) runs every manager and the reviewer as a
claude of its own in that terminal host, the way a session worker runs. They are always claude, whatever
`worker_harness` is. Their start line carries the routed model
and the reasoning effort as `--model` and `--effort` (`manager_effort`, `reviewer_effort`; a session worker gets
the `worker_effort*` of its brief's `Size:` line); `inherit`, an unset effort or `CLAUDE_CODE_EFFORT_LEVEL` in the
environment passes none.

- **Managers.** When main starts a `flow:manager` in a terminal mode, the plugin starts the terminal
  instead and answers the Agent tool with a refusal worded as a success ("started manager ... it runs as a
  terminal session. This is not an error"). The manager works in the main checkout. It reports by writing
  `<git-common-dir>/flow/sessions/<name>/report.md`; each new report reaches main as "Report from manager
  <name>:", and the terminal ending is told to main once. If the terminal cannot start (Orca not running, tmux
  missing), the Agent call is refused with the reason and a toast says why; no agent takes its place.
- **The relay.** A claude in a terminal loads its own copy of the plugin. Its flow tools (`mcp__flow__*`) are not
  run there: each call is left as a file in the session's relay directory, main's pump runs it as that session
  and leaves the answer, so the manager's notes, asks, plan, handovers and the reviewer's take / done / back
  behave as for an agent. A message to a terminal is typed into it. A claude worker relays too, but only the
  worker's tools (test_slot, guard_tests, ask, fyi, note, status); main refuses any other from it, and its
  whole-suite runs are refused as an agent worker's are. A worker started before workers had a relay
  directory keeps a passive copy with no flow tools.
- **Workers of a terminal manager** are always session workers (`mcp__flow__session`, `worker_harness` or claude): a terminal has no `flow:worker` agent type.
- **The reviewer in auto mode** is one long-lived terminal in a worktree of its own. A handover while it
  lives does not start another reviewer: the plugin types `new handover: #N` into it (due deploys and a push run
  likewise), once per PR. When the list is empty, or it is blocked (a PR awaiting approval, a batch awaiting
  `/flow push`, a deploy awaiting approval, a PR sent back) it writes its report and waits with the terminal
  kept; later lines come only from real events (a handover, an approval, a push), never a loop. Its report
  goes to main like an agent's. A terminal that goes away counts in the respawn circuit breaker like a short or
  failed agent run. If its terminal cannot start, a toast and a log line give the reason and the handover stays pending until the next trigger.
- **The reviewer in confirm mode** reviews one batch and ends like the agent: after its report (merge_mode is
  read then, so a change while it worked counts) the plugin stops the terminal, removes its worktree if clean,
  and the next handover starts reviewer-N+1. The same happens in auto mode when a batch awaits `/flow push`.
- **Owners and subagents.** A role session, and a claude worker, records the main that started it (`mainOwner`: session id and
  claude pid). A main pumps, watches and delivers only for its own; one whose owner pid is dead, or that has
  no owner, is taken over by the next main that sees it (the relay claim is an atomic rename, so a race on
  that never runs a call twice). A subagent of a terminal manager (Explore and the like) reaches main as the
  manager, so it may only read: status, guard_tests, migrations, test_slot, `list` actions, note without
  text; everything else is refused with a note to report to the manager. The reviewer's subagents are not
  restricted.
- **Known limits.** A restart of main keeps terminal sessions (they are saved in `sessions.json`), and an agent reviewer running
  when the setting changes finishes as it is. With two mains, the one that saves last keeps only its own records in
  `sessions.json`, so the other's terminals are not restored after its restart.
