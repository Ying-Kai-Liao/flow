# Reference

Settings, tools, the test lock, guard tests, state on disk and how to develop the plugin. Section names in parentheses, like "see Deploying", refer to [How flow works](how-it-works.md).

## Settings

Most options are under `/config` → flow:. Every option can also be set in a settings file (`.claude/flow.json`, or the personal `.git/flow/config.json`, see Settings per repo); the ones marked "file only" have no `/config` field. The API keys (`openai_api_key`, `typesafe_api_key`, `openrouter_api_key`) are the exception: they are sensitive `/config` options only, and a settings file that sets one is ignored with a warning.

### Core settings

The ones most repos set. Everything else is under Advanced settings.

| Option | Default | Set in | Used by |
|---|---|---|---|
| `test_command` | tests covering the changed files | `/config`, file | workers |
| `full_check_command` | none (the reviewer says so) | `/config`, file | the reviewer, once per batch |
| `deploy_targets` | none | file only | the reviewer: ordered deploy targets, each with an optional `mode` of `auto` (default) or `confirm` (see Deploying). A JSON array or a JSON string; wins over `deploy_command` |
| `deploy_command` | none (no deploy) | `/config`, file | the reviewer, after pushing. Same as one target `{name: "default", deploy: [deploy_command]}` |
| `merge_mode` | `auto` | `/config`, file | `auto` or `confirm` (unknown: `auto`): `confirm` holds every handed-over PR until you run `/flow approve <n>` (see Merge mode) |
| `push_mode` | `auto` | `/config`, file | `auto` or `confirm` (unknown: `auto`): `confirm` makes the reviewer stop after the full check and the release, and waits for your `/flow push` (see Push gate) |
| `release` | `off` | `/config`, file | `on`: release at merge, the reviewer bumps the version once per batch (see Releases) |
| `manager_model` | `opus` | `/config`, file | managers whose prompt says `Size: large` or has no `Size:` line, and `Size: normal` unless `manager_model_normal` is set |
| `worker_model` | `sonnet[1m]` | `/config`, file | workers of size `large`, and workers whose brief has no `Size:` line (see Model routing). Falls back to `sonnet` once, with a warning, if the engine refuses `[1m]` for sub-agents |
| `max_workers` | 3 | `/config`, file | workers per manager at a time |

### Advanced settings

| Option | Default | Set in | Used by |
|---|---|---|---|
| `reviewer` | on | `/config`, file | off: managers merge themselves with `merge_method` |
| `merge_method` | `squash` | `/config`, file | managers, when there is no reviewer |
| `preflight` | `on` | `/config`, file | `off`: managers are not gated and no round is sent (see Pre-flight) |
| `ask_cards` | `on` | `/config`, file | `off`: messages to main do not tell it to show blocking questions, env changes and deploy approvals as AskUserQuestion cards (no extra notices either) |
| `preflight_wait` | 10 | `/config`, file | minutes the main session waits for managers to file before sending the round |
| `state_file` | none | file only | the reviewer: a status file it updates after each deploy, a path or `{path, keep, archive}` (see Deploying) |
| `release_files` | none (`package.json` at the repo root when there is one) | file only | repo-relative JSON or TOML files whose version the release bumps, a list; the first one gives the current version |
| `release_github` | `off` | `/config`, file | `on` (with `release` on): after the release push the reviewer tags `v<x.y.z>`, pushes the tag and creates a GitHub Release from the changelog section; needs `gh` authenticated with repo write |
| `changelog_file` | `CHANGELOG.md` | `/config`, file | the changelog the release cuts and workers add their lines to |
| `reviewer_model` | `sonnet` | `/config`, file | the reviewer |
| `conflict_model` | `opus` | `/config`, file | the sub-agent the reviewer starts for mechanical conflicts in code files and for fixes to PRs that break only in combination |
| `explore_model` | `haiku` | `/config`, file | an Explore sub-agent that a flow agent (manager, worker, reviewer) starts without its own model. Main's own Explore spawns are untouched |
| `explore_effort` | `low` | `/config`, file | reasoning effort of the same Explore sub-agents. `low`, `medium`, `high`, `xhigh`, `max`; `inherit` (or empty) keeps the session's |
| `worker_effort_small` | `low` | `/config`, file | effort of workers whose brief says `Size: small` |
| `worker_effort_normal` | `medium` | `/config`, file | effort of workers whose brief says `Size: normal` |
| `worker_effort` | `inherit` (unset) | `/config`, file | effort of large workers and workers with no `Size:` line |
| `manager_effort` | `inherit` (unset) | `/config`, file | effort of managers |
| `reviewer_effort` | `medium` | `/config`, file | effort of the reviewer. The conflict sub-agent (`conflict_model`) always inherits |
| `decision_api` | `auto` (unset) | `/config`, file | `auto`: not set, `size_model` applies if set, else `off`. `off`: the brief's `Size:` line picks the size. `jev`: TypeSafe's Jev decides it at spawn. `openai`: an OpenAI chat model decides it. The brief text is sent to the provider (see Model routing) |
| `jev_model` | `jev-latest` | `/config`, file | the Jev model name used when `decision_api` is `jev` |
| `typesafe_api_key` | empty | `/config` only (sensitive) | the key sent to Jev when `decision_api` is `jev` |
| `jev_api_key` | empty | `/config` only (sensitive) | deprecated alias of `typesafe_api_key`, read only while `typesafe_api_key` is empty |
| `jev_base_url` | empty (`https://api.typesafe.ai`) | `/config`, file | where the Jev request goes |
| `openrouter_api_key` | empty | `/config` only (sensitive) | reaches Jev through OpenRouter when `decision_api` is `jev` and `typesafe_api_key` is empty |
| `openrouter_jev_model` | `~typesafe/jev-latest` | `/config`, file | the Jev model name on OpenRouter |
| `openrouter_base_url` | empty (`https://openrouter.ai/api`) | `/config`, file | where the OpenRouter Jev request goes (`/v1/systemone`) |
| `openai_model` | `gpt-4.1-mini` | `/config`, file | the OpenAI chat model used when `decision_api` is `openai`; it must support structured outputs and logprobs (not a gpt-5 or other reasoning model) |
| `decide_inbox` | `false` | `/config`, file | with `decision_api` `jev` or `openai`: when an agent records a decision (`mcp__flow__fyi`), the provider reads its text and flow keeps it if the answer is `keep` with at least `decide_min_confidence`. The decision text is sent to the provider (see Model routing) |
| `decide_handoff` | `false` | `/config`, file | with `decision_api` `jev` or `openai`: at a worker's handoff the provider reads the handoff note and advises the manager to split or continue (advice only). The note is sent to the provider |
| `decide_min_confidence` | `0.8` | `/config`, file | the least confidence (0 to 1) for `decide_inbox` and `decide_handoff` to act; spawn sizing has its own floor, `size_min_confidence` |
| `size_min_confidence` | `0` | `/config`, file | the least confidence (0 to 1) the provider's answer needs for spawn sizing to use it; below it the `Size:` line is used. 0 uses every answer (in flow's own history Jev at any confidence agreed with the right size on 72% of spawns, against 58% for the `Size:` line) |
| `openai_api_key` | empty | `/config` only (sensitive) | the key sent to the OpenAI-compatible API when `decision_api` is `openai` |
| `openai_base_url` | empty (`https://api.openai.com/v1`) | `/config`, file | where the OpenAI request goes, for a compatible endpoint |
| `size_model` | `off` | `/config`, file | deprecated alias of `decision_api` (`jev` or `openai`), read only while `decision_api` is `auto` or unset; an explicit `decision_api`, `off` included, always wins |
| `manager_model_small` | `sonnet` | `/config`, file | managers whose prompt says `Size: small` (see Model routing) |
| `manager_model_normal` | unset (follows `manager_model`) | `/config`, file | managers whose prompt says `Size: normal` (see Model routing) |
| `worker_model_small` | `haiku` | `/config`, file | workers whose brief says `Size: small` |
| `worker_model_normal` | `sonnet` | `/config`, file | workers whose brief says `Size: normal` |
| `max_managers` | 20 | `/config`, file | managers the main session runs at a time |
| `max_continues` | 2 | `/config`, file | how many times a branch may hand off before its manager is told to split the package (a warning only) |
| `test_slots` | 1 | `/config`, file | how many heavy test runs may run at once across all agents (minimum 1) |
| `test_slot_commands` | `claude plugin test`, `npm run check`, `npm test`, `npm run test` | `/config`, file | Bash commands that run a whole suite; refused unless the caller holds a test slot. Empty list: not enforced |
| `language` | `English` | `/config`, file | the language agents write reports and PR text in |
| `context_warn_percent` | 40 | `/config`, file | the context limit as a percent of the window (1 to 100) |
| `context_warn_percent_1m` | 35 | `/config`, file | the same as `context_warn_percent`, for agents on a 1M window (1 to 100); the 200k percent never applies to them |
| `context_warn_tokens` | 0 | `/config`, file | an optional cap in tokens over both percents; the lower applies. 0 = off, percent only. Drives the handoff, the meter marker and the yellow point |
| `handoff` | on | `/config`, file | workers and managers: at the limit they are told to hand off (see Continuing work). Off: the meter only shows |
| `worker_harness` | `agent` | `/config`, file | managers: `agent` starts `flow:worker` agents; a harness name (`codex`, …) starts every worker in a terminal instead (see Workers in other harnesses) |
| `manager_harness` | `agent` | `/config`, file | main: `agent` starts `flow:manager` as an agent; a claude-running harness name (`claude`, …) starts each manager as a claude in a terminal instead (see Managers and the reviewer in a terminal) |
| `reviewer_harness` | `agent` | `/config`, file | `agent` starts the reviewer as an agent; a claude-running harness runs it in a terminal: one long-lived session while `merge_mode` is auto, one batch in confirm mode |
| `session_host` | `auto` | `/config`, file | where session workers, terminal managers and the terminal reviewer run: `auto` (Orca when it runs, else tmux), `orca`, `tmux` |
| `harnesses` | the four built-ins | `/config` (JSON string), file | harness name to a start line or `{start, resume?, program?, quota?, digest?}`, over the built-ins; `""` removes one |
| `min_quota` | 10 | `/config`, file | a session worker whose harness has a `quota` is refused below this percent left; 0 = never |
| `base_branch` | the remote's default branch | `/config`, file | everyone |
| `cleanup` | `auto` | `/config`, file | `auto`: the plugin removes finished, clean worktrees and branches after each merge and when the reviewer ends (see Cleanup). `off`: only `/flow clean --yes` |
| `worker_checks` | none | file only | commands every worker must pass before opening a PR (a list) |
| `always_tests` | none | file only | tests every worker runs on top of the ones for the files it changed (a list) |
| `flaky_tests` | none | file only | test files known to fail now and then: when they are the only failures of the full check, the reviewer reruns them once (a list) |
| `batch_max` | 10 | file only | most PRs one reviewer batch carries (minimum 1); PRs that arrive before the full check join the batch up to this number, the rest wait for the next. 1 restores one-PR batches |
| `verify_paths` | none | file only | path globs (a list): a handover's `verify_command` runs only when the PR changes a matching file, e.g. only PRs touching migrations or code with outbound effects; otherwise the check stays open for a person. Unset: the command always runs (see Person checks) |
| `big_files` | none | file only | files workers grep and never read whole (a list) |
| `big_file_lines` | 1500 | file only | the line count from which a file counts as big |
| `migrations_dir` | none | file only | the directory of migrations: workers number new ones after the highest on the base branch, and the reviewer renumbers a clash (see Reviewer rules) |
| `size_ab` | off | `/config`, file | `daily`, with `decision_api` `jev`: spawns alternate by local epoch day (even: Jev sizes, odd: the `Size:` line alone, no decision API call); each worker and manager ledger row gets `sizeArm`. Read the outcome with `size_ab_report` or `scripts/size-ab.mjs` (packages are attributed to the arm of their first spawn; under 20 packages an arm is too small to conclude) |
| `size_feedback` | on | `/config`, file | each `flow:manager` spawn prompt gets, once, a short digest of how this repo's earlier workers' `Size:` lines turned out (see Model routing). `off`: no digest |
| `main_checkout_guard` | on | `/config`, file | flow's agents always, the main session only while flow has a worktree or live agent in the repo: writes to the main checkout (the repo's folder, not the main branch) are refused (see Guards) |
| `main_checkout_allow` | `.claude/` | `/config`, file | paths still writable in the main checkout, comma-separated, relative to the repo root; one ending in `/` covers a directory. Replaces the default |
| `guard_tests` | none | file only | path globs mapped to repo-wide tests a worker must run when its diff touches a matching path, e.g. `{"src/routes/**": ["test/admin.test.ts"]}` (see Guard tests) |
| `decision_phrases` | none | file only | **deprecated**, use `mcp__flow__ask`: extra phrases that mark a report as a question for the user (a list; see below) |
| `standing_answers` | none | file only | rules that answer recurring inbox questions at once: a list of `{id?, topic?, match?, answer, blocking?, from?, note?}` (see Standing answers). The personal file's rules come before the repo file's and both apply |


`decision_phrases` (deprecated in favour of `mcp__flow__ask`, still honoured; the settings loader warns): a report counts as asking when its last line ends in `?` or `？`, or its last paragraph contains one of the phrases (case-insensitive), unless the phrase directly follows a negation (`不`, `不用`, `不必`, `無需`, `毋需`, `不需要`, `no `, `not `, `don't `, `no need to `): "不需要你決定" does not match `需要你決定`. The pane, the toasts and the task graph all use it.

An unset full check or deploy is a step that's skipped and reported, never improvised.

The reviewer was called the merge queue before. For older setups the agent type `flow:queue`, the tool `mcp__flow__queue` and the settings `merge_queue` and `queue_model` still work as aliases of `flow:reviewer`, `mcp__flow__reviewer`, `reviewer` and `reviewer_model`; the old settings names are deprecated and warn once.

Sub-agents don't run on Fable: a Fable model is refused in settings, for every model key above including `manager_model_small`, `manager_model_normal`, `worker_model_small`, `worker_model_normal`, `explore_model` and `conflict_model` (a warning, the default applies) and denied at spawn, for flow agents and for anything a flow agent starts.

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

### /flow init

`/flow init` is a re-runnable onboarding for a new repo: a short walkthrough of the roles and commands, a demo, and the Core settings. Running it again shows the current settings and lets you change them.

- `/flow init`: walkthrough, then the demo (skippable), then settings. `/flow init settings` jumps to the settings, `/flow init demo` starts the replay, `/flow init demo live` runs the real demo, `/flow init demo stop` ends the replay. Any part writes the marker file.
- The command returns the detected facts as text and hidden instructions for the main session, then submits a short prompt so the main session follows the `flow:init` skill. The replay itself needs no model turn.
- **Detected, never guessed:** test and check command candidates from `package.json` scripts (`test`, `check`, `lint`, `typecheck`, `build`; the package manager from the lockfile: pnpm, yarn, bun or npm), Makefile targets (`test`, `check`), `pyproject.toml` (`pytest`), `Cargo.toml` (`cargo test`) and `go.mod` (`go test ./...`); the base branch; whether the repo has a remote; whether `gh` is installed and logged in; and the value of each Core key in every settings layer. Candidates are suggestions: nothing is written unless you choose it.
- **The demo replay is free.** It draws canned manager, worker and reviewer cards in the Flow pane (labelled DEMO), with a question and a decision you answer on the pane's own large card, a PR handed over and merged, and a report. No agent starts, no model is called, nothing is written, and none of it mixes with real handovers or inbox items. Keys: `m` next step, `x` stop. Its state is one in-memory atom: stopping, finishing or restarting the session clears it.
- **The real demo uses tokens.** `/flow init demo live` (the skill offers it after the replay) starts a real manager `flow-demo` and worker `flow-demo-hello`, which commit a one-line `flow-demo.md` on their own branch in their own worktree. Nothing is pushed, no PR is opened, there is no handover and so no reviewer step, and the base branch is not touched. The skill then removes the worktree and the `flow/flow-demo*` branch with the `demo` tool. With `gh` logged in and a remote, it can also offer a draft PR titled "flow demo (safe to close)", closed and deleted afterwards.
- **Marker and hint:** `<git-common-dir>/flow/init-done` records that init ran in this repo. While neither settings file exists and the marker is missing, a new session shows one line: "New to flow? Run /flow init for a walkthrough, a demo and settings."

Tools (main only, both deferred; load with ToolSearch, e.g. `select:mcp__flow__settings,mcp__flow__demo`):

- `settings`: action `show` lists what init detected and the Core settings in each layer. Action `write` takes `layer` (`repo`: `.claude/flow.json`, committed and shared; `personal`: `<git-common-dir>/flow/config.json`, uncommitted) and `values` (setting names to values; `null` removes a key). It merges into the existing file, keeps other keys, and writes 2-space JSON. It refuses (and writes nothing for the whole call) unknown keys, values of the wrong kind, values outside a setting's allowed choices, nested settings (`deploy_targets`, `guard_tests`, ...: edit those by hand), Fable models, and anything that looks like a key or secret: API keys stay in env or `~/.config` files, never in settings. A file that is not valid JSON is shown and never overwritten. The files are reloaded within a few seconds, as for a hand edit. Commit the repo file to share it.
- `demo`: action `start` / `stop` for the replay, `status`, and `cleanup` (after a real demo: removes its worktree and `flow/flow-demo*` branches only, refused while a demo agent is running).

Advanced settings are only mentioned by init, with a pointer here: `size_model` and the decision API (keys in env, never in settings), `deploy_targets`, `guard_tests`, and standing answers.

## Without Orca

Orca is an optional place to run session workers; flow does not need it. Nothing here changes setting names or defaults.

- **The default path needs neither Orca nor tmux.** With `worker_harness` at `agent`, managers start `flow:worker` agents inside the Claude session. No terminal host is involved.
- **Session workers** (a `worker_harness` such as `codex`) run in a terminal, picked by `session_host`. `auto` uses Orca only when `orca status` exits 0 and reports `runtimeReachable: true`; otherwise it uses tmux when `tmux -V` works; otherwise it refuses to start with `Neither Orca (orca status) nor tmux is available to run a session in.`
- **Managers and the reviewer** can run in a terminal too (`manager_harness`, `reviewer_harness`), on the same host choice; with both at `agent` (the default) neither is used.
- **Pure tmux:** set `session_host` to `tmux`. The Orca probe is then skipped. If tmux is missing the start is refused with `tmux is not installed.` (With `orca` set and Orca not running: `Orca is not reachable (orca status). Open Orca, or use host "tmux".`)
- **What the tmux path does:** it makes the worktree with plain git (`git worktree add -b flow/<name> <repo>/.claude/worktrees/<name> origin/<base>`), then starts the harness in a detached session named `flow-<name>` (`tmux new-session -d`). `stop` runs `tmux kill-session`; `remove_worktree` runs `git worktree remove` only when the tree is clean and pushed; `restart` uses `respawn-pane -k`. If tmux itself fails to start, the worktree stays and the message says so. Cleanup and worktree handling elsewhere use plain git.
- **A missing `orca` binary is harmless.** A command that cannot start counts as a failed probe (exit 127), so `auto` falls back to tmux.
- **Quota** applies only to harness specs with a `quota` field (only the built-in `codex` has one, `codex-logs`, read from `~/.codex/sessions`). A stale or unreadable log never blocks a start.

Settings that matter on this path: `worker_harness`, `manager_harness`, `reviewer_harness`, `session_host`, `harnesses`, `min_quota`. See Workers in other harnesses and Managers and the reviewer in a terminal in [How flow works](how-it-works.md).

## Tools the agents use

- `status`: what the session is doing, scoped by the caller. Main, the reviewer and unknown callers see every agent, handover and cost line. A manager sees its own subtree, its own handovers and its own cost lines. A worker sees itself and its manager, with no cost, plans or handovers. Finished handovers are capped to the newest 5 (open ones, `returned` included, always show) with `+N earlier finished PRs (mcp__flow__status pr:<n> for one)`; finished lines are clipped to 220 characters, and `pr:<n>` gives the full handover line, its owner and log lines.
- Deferred tools: `standing` and `push` (main only) are registered deferred, so they stay out of every agent's tool prefix until loaded. Main loads them with ToolSearch, e.g. `select:mcp__flow__standing`. `queue` (the old name of `reviewer`) is deferred too; older reviewers load it by name. `check` stays loaded because the reviewer and main call it directly.
- `migrations` (read-only; used by the reviewer): `prs` (PR numbers in merge order) and `ref` (default HEAD). It reports the highest migration number on the base branch and at `ref`, each PR's added migrations as ok, clash or at-or-below, the next free number with its zero padding kept, the suggested `git mv`, and where the PR references the old number.
- `reviewer` action `ready` (push_mode confirm; the reviewer only): records the checked batch instead of pushing it. Takes `prs` (the PRs in the batch), `sha` (the batch head, which must match `refs/flow/push/<id>`), `base_sha` (the `origin/<base>` it was built on), `check` (one line, the full check result) and `version` (when released). The PRs become `ready`; it opens the inbox item and a toast (see Push gate).
- `push` (main only, on your word): `list` shows the ready batch, `push` releases it, `send-back` with `pr` returns one PR (the rest is rebuilt), `drop` returns them all. Same as `/flow push`, `/flow push back <pr>` and `/flow push drop`.
- `release`: the reviewer, once per batch before the push (release on): cuts the changelog, bumps the version files, returns the commit command (see Releases). With `action: "publish"` (`release_github` on, after the push; optional `version`, default the last cut) it tags, pushes the tag and creates the GitHub Release. With `recut: true` (push gate, the base moved) it cuts a batch again that was already released.
- `handover` for a lite manager (see Lite mode in how-it-works.md): records the PR as `taken` by the manager itself (`lite: true` in `handovers/<pr>.json`), starts no reviewer and answers with the steps to merge it. `mode: "confirm"`, `merge_mode` confirm or a `flow:confirm` label make it a normal handover. A lite manager may also call `release`, `reviewer` `ready`/`done` and `deploy` `gate`/`deployed`/`env-applied` for its own lite PRs; other managers and workers are refused.
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
## Message delivery

A message to an idle agent starts a turn, and once the 5-minute prompt cache has expired that turn re-writes the whole context at full price. So the plugin batches its messages (`hooks/deliver.ts`):

- A running agent gets a message at once, together with anything queued for it.
- An idle agent's messages are queued and sent as one wake-up 8 seconds after the first; identical texts go once.
- Urgent kinds skip the wait and flush the queue: answers to blocking asks (an asker that ended its turn to wait is resumed by it), push-gate send-backs, the max-continues and wrap-up notices.
- Informational texts are held: they do not wake an idle manager, and go out with the next message, on the agent's next turn, or after 10 minutes at the latest (several held texts leave as one send). They are a worker's non-blocking ask, the "the user answered qN over your head" relay, the "both are closed" copy of a linked escalation and decide_handoff's split advice below max_continues. `/flow inbox` still shows the asks. A held text never resumes a manager that ended its turn to wait; it falls back as for any ended agent. Plan notices, answers a manager has to act on, test-slot grants, reports and everything urgent still wake at once.
- A reviewer's message to a manager holds that manager's queue for the turn the message starts, so both arrive in one turn; a 60 second timer sends the queue if the message never lands.
- If the agent has ended, queued texts go to the message's fallback, else to main. An answer whose send is dropped this way is noted for the asker's owner and sent to main.
- A send the host refuses to an agent that has not ended (for example one waiting between turns) is put back in the queue as held and goes out on its next turn; if it is refused again at the 10 minute cap, it falls back with a "could not be delivered" note.

The queue is in memory: a plugin reload loses it (held texts are at most 10 minutes old and informational; the asks stay in `/flow inbox`).

Measure what wake-ups cost with `node scripts/wake-cost.mjs [projectDir] [--md]`: it reads manager transcripts and lists wake turns by kind with their cache-write tokens and list-price dollars. Most of the cost is cold wake-ups (cache expired) for worker and reviewer reports, which the host delivers and the plugin cannot hold. Claude Code can keep subagent prompt caches for an hour: set `subagentPromptCacheTtl` to `"1h"` in its settings or `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL=1h`. The plugin cannot set it (a spawn takes no such parameter), and it applies to workers too (a 1h write costs 1.6x a 5m one).

Repair a cost ledger inflated before 0.6.70 (every plugin reload then added the disk totals onto the live ones) with `node scripts/ledger-rebuild.mjs [--ledger PATH] [--project DIR] [--write]`. It recomputes every entry's tokens (and turns, where the entry has them) from the agents' transcripts under `~/.claude/projects/<repo>`, keeps names, sizes, manager links and times, and keeps and flags entries whose transcript is gone. It is a dry run by default: before/after tokens and dollars per role, the spread of the inflation factor and the flagged entries. `--write` first copies the old file to `ledger-pre-rebuild-<date>.json` (a taken name gets `-2`, `-3`), then replaces the ledger. It stamps the file with a new epoch, so a running plugin does not overwrite it: its next save reads the file, drops its in-memory base and writes the file plus only what it counted since its last save. Run `--write` with flow idle anyway, so nothing counted meanwhile is derived twice.

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

A hook enforces it: a Bash call (main session included) that runs a whole suite is denied unless
the caller holds a confirmed slot (a grant not yet confirmed with `acquire` does not count). The
deny names who holds the slots, or says they are free; it never acquires for you. A command counts
as a suite when a segment of a `&&`, `||`, `;`, `|` or newline chain (behind `cd`, `FOO=1`, `time`,
`bash -c`) starts with one of the `test_slot_commands` and then has no file argument, a glob
(`tests/*.test.ts`), a directory (an argument without a file extension: `.`, `tests/`,
`/tmp/copy`), or more than 5 files. Flags are ignored; 1 to 5
explicit files run freely. An empty `test_slot_commands` turns it off; other stacks list their own
(`pytest`, `go test ./...`). Workers started in other harnesses (`mcp__flow__session`) do not pass
through the hook. One `claude plugin test` run already starts one child process per test file, and
the runner has no jobs or concurrency flag or environment variable, which is why `test_slots`
defaults to 1.

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

## Model routing

A manager picks a model per worker by size, not by name. It writes `Size: small | normal | large — <reason>` as the second line of the brief (after `Your name:`) and omits the Agent `model` parameter. At spawn the plugin maps the size to a model:

| Size | Setting (default) | Use for |
|---|---|---|
| `small` | `worker_model_small` (`haiku`) | docs, one-file fixes, renames, mechanical changes (not bug fixes whose root cause is unknown) |
| `normal` | `worker_model_normal` (`sonnet`) | an ordinary change in a few files with clear scope |
| `large` | `worker_model` (`sonnet[1m]`) | cross-cutting work, big files, unclear scope, anything needing a long context |

The `Size:` line wins over an explicit `model` parameter. Without one nothing changes: the `model` parameter or `worker_model` applies. An unknown size word is ignored.

- **Escalation:** a successor worker (named `<name>-N`, or a brief with `Continue on branch: flow/<x>`) of a small or normal worker runs at least one size above its predecessor (small, then normal, then large), automatically. That covers a BLOCKED or failed worker, a context handoff, and a PR the reviewer sends back: the reviewer's back message for a small or normal worker's PR tells the manager to continue with a fresh `-N` worker.
- **Managers:** a manager is routed the same way by the `Size:` line on its prompt: `small` -> `manager_model_small` (`sonnet`), `normal` -> `manager_model_normal` (unset: follows `manager_model`, so `opus` by default), `large` or no `Size:` line -> `manager_model`. A successor `<name>-2` of a normal manager runs on `manager_model`.
- **Lite mode:** a manager started with `Mode: lite` is routed like any manager (`manager_model`, or its `Size:` line). It and its workers file no downgrade records; the models are still routed.
- **Downgrade record:** a worker started below large makes the plugin file a non-blocking decision from the manager to the user, topic `worker-size`, e.g. "csv-docs runs small -> haiku: docs only". It is never a blocking ask and never silent. Undo it in `/flow inbox`: the manager is told and restarts the package at the size you chose. Standing answers (`mcp__flow__standing`, topic `worker-size`) can acknowledge recurring cases (see Standing answers).
- **Jev (optional):** with `decision_api` set to `jev`, TypeSafe's Jev classifier picks the size for `flow:worker` and `flow:manager` spawns, even when the brief has no `Size:` line. The successor floor still applies on top. One call per spawn, with a 5 second wait. **The brief text (minus its `Size:` line, capped at 8000 characters) is sent to api.typesafe.ai: data leaves the machine.** The key is the `/config` option `typesafe_api_key` (sensitive, kept in secure storage); `jev_base_url` (default `https://api.typesafe.ai`) points it elsewhere. Neither the environment nor a file is read for it. Jev can also be reached through OpenRouter: with no `typesafe_api_key` and an `openrouter_api_key`, the same request goes to `openrouter_base_url` (default `https://openrouter.ai/api`, path `/v1/systemone`) with that key and the model `openrouter_jev_model`; the decision text then reads "jev via openrouter" and the host is openrouter.ai. `typesafe_api_key` (or the deprecated `jev_api_key`) wins when both are set. Jev's answer counts only when it is small, normal or large with confidence of at least `size_min_confidence` (default 0, so any). Anything else (no key, timeout, an HTTP error, a bad answer, low confidence) falls back silently to the `Size:` line and adds a short note to the downgrade record, e.g. "csv-docs runs small -> haiku (jev 0.98; brief said normal): docs only" or "(jev unavailable: HTTP 401)". The key and response bodies never appear in notes or logs. Off, the plugin makes no network call.
- **OpenAI (optional):** with `decision_api` set to `openai`, an OpenAI chat model (`openai_model`) picks the size the same way, with the same criteria, through Chat Completions strict structured output at temperature 0. The key is the `/config` option `openai_api_key` (sensitive, kept in secure storage; the `OPENAI_API_KEY` environment variable is not read); `openai_base_url` (default `https://api.openai.com/v1`) points it at a compatible endpoint. **The brief text (minus its `Size:` line, capped at 8000 characters) is sent to api.openai.com, or the `openai_base_url` host: data leaves the machine.** Both providers' requests go through the engine's `$.http.fetch`. Confidence is the probability of the answer's tokens from the response logprobs and must be at least `size_min_confidence` (default 0). If the endpoint returns no usable logprobs, the answer is accepted without the threshold and the decision text shows no number, e.g. "(openai gpt-4.1-mini)". Failures fall back silently to the `Size:` line with a note like "(openai unavailable: HTTP 401)"; the key and response bodies never appear in notes or logs.
- **Routine decisions and handoff advice (optional, both off):** two more uses of the same provider, each behind its own toggle and active only while `decision_api` is `jev` or `openai`. `decide_inbox`: right after a decision is recorded (`mcp__flow__fyi`, the agent's result is unchanged), the provider is asked keep, undo or ask_main. Only `keep` with confidence of at least `decide_min_confidence` (default 0.8; no confidence counts as under) keeps it, so main is not woken for it; anything else, a timeout or a failure leaves it open as before. Only plain decisions are ever asked about: never a question (blocking or not), an env change, a deploy approval, a push or reviewer item, a guard suggestion, a person check or a pre-flight question, and a standing answer that applies wins. A kept decision is answered `Keep` by the provider and shows as "kept by jev (0.93)" in `/flow inbox`, the archive and `mcp__flow__status` ("Inbox: 2 decisions kept by jev (undo with mcp__flow__answer)"); it never counts as work for main. It stays undoable: `mcp__flow__answer` or `/flow no` with anything but Keep messages the owner exactly like a normal undo. `decide_handoff`: at a worker's handoff the provider reads the handoff digest. Below `max_continues` a confident `split` adds a line to the manager ("jev advises splitting flow/x (0.88)"); a confident `continue` adds nothing. Past `max_continues` the usual split message is sent and a confident answer is appended to it, e.g. "(jev: continue 0.91)". It never changes the `max_continues` rule. **The decision text or the handoff note (capped at 8000 characters) is sent to the provider: data leaves the machine, only with the toggle on.** Each call appends a `decide` event to `log.jsonl` (feature, id, answer, confidence, applied or a failure note); the key and response bodies are never logged. `decide_eval` measures how often the provider agrees with main before you turn either on; its `size` feature replays spawn sizing and compares Jev with the brief's `Size:` line and with always-normal, and adds a per-role split and a "normal managers on sonnet" cost counterfactual; its `route` feature measures whether Jev can tell a task that needs a manager with several workers (`manager+n`), a manager with one worker (`manager+1`) and a direct worker (`direct`), labelled from what each manager family actually did (workers, merged PRs, blocking questions, send-backs, plan nodes, successor managers; risky tasks excluded), against main's choice, simple rules and the always-baselines, with a dollar column. It measures only; nothing routes on it.
- **Explore and reviewer:** Explore sub-agents of flow agents run on `explore_model`. The reviewer runs on `reviewer_model`; it still resolves changelog and version-file conflicts itself, and starts a sub-agent on `conflict_model` for mechanical conflicts in code files and for fixes to PRs that break only in combination.

**Effort.** Reasoning effort follows the same routing: Explore (of flow agents) `explore_effort`, workers by routed size (a successor escalated to a bigger size gets that size's effort) `worker_effort_small` / `worker_effort_normal` / `worker_effort`, the reviewer `reviewer_effort`, managers `manager_effort`. Defaults are `low` for Explore and small workers, `medium` for normal workers and the reviewer, and no override (the session's effort) for large workers, managers and the conflict sub-agent: bounded lookups gain nothing above `low` (a measured haiku lookup took about 1k, 6k and 115k output tokens at `low`, `high` and `max`). The plugin applies it on each of the agent's model requests (`turn.step`), only where the model takes an effort, so a model without effort support is left alone. An `effort` passed on the Agent tool call wins, and so does `CLAUDE_CODE_EFFORT_LEVEL` in the environment: with it set, flow overrides no effort at all. Managers, the reviewer and session workers that run as a `claude` in a terminal get the same effort as `--effort <level>` on their start line (next to `--model`; other harnesses are left alone). The cost meter's ledger records the effort flow applied per agent.

**Size feedback.** A manager never sees how its workers' sizes turned out, so it guesses from scratch and leans cheap (a replay of this repo's history found worker Size lines under-sized about half the time, mostly `normal` workers that needed a successor or a handoff). At spawn, each `flow:manager` prompt gets one appended block (`## Recent worker sizing on this repo`) of at most four lines from flow's own records: per size, how many of the last 20 first-generation workers there are and how many needed a rerun (a `-N` successor, or a continue/handoff on the branch; a handoff of a `large` worker is not counted, a successor is), with up to three names. Workers still running count as recent, not as rerun. It is built once at spawn (nothing per turn, so the cached prompt prefix is unchanged), needs no network and works with `decision_api` off; with fewer than 5 sized workers in the ledger there is no digest, and any failure spawns the manager unchanged. The manager's ledger row carries `sizeFeedback: true`, and `decide_eval`'s size feature prints a table of worker Size-line agreement, under-sized and over-sized with and without the digest. `size_feedback` `false` skips it.

## Cost meter

Every agent step adds its tokens (input, cache write 5m and 1h, cache read, output) to a ledger
keyed by agent, then by the model the API reports. Main's steps count under `main`. Each entry
keeps the agent's name, role, manager, branch, size and spawn model, so the ledger keeps an agent the
roster forgot and cost can be split by model and size. It is saved to `ledger.json` at most every few seconds and loaded again after a
restart. Each save merges: it reads `ledger.json`, adds this session's unsaved counts (kept apart from the loaded history, and across plugin reloads) and writes the result atomically under the file's `__epoch` stamp, so two sessions sharing the file, or a rebuild while one runs, lose nothing. A failure in the ledger never touches the step.

- **Where it shows:** `mcp__flow__status` and `/flow status` print "Cost (estimates at API list
  prices)": one line per agent (tokens in / cache write / cache read / out, cache hit %, `~$`),
  then a total per manager (its own plus its workers' and its successors'), per PR (the workers
  on the PR's branch, `-2` successors included), the reviewer, main and the session. Handover
  lines in status carry the PR's cost, and the reviewer's done report gets `| cost: ~$X (...)`
  appended (once). Workers run in other harness sessions are not counted.
- **Session scope:** the block lists this session's entries (agents in the roster, or counted since
  the session started; main is keyed per session as `main@<start>`) plus one "All time" line.
  Per-PR cost on handover lines and in the done report is by branch across sessions. Entries not
  counted for 90 days are dropped from `ledger.json` when it is loaded or saved.
- **Prices are estimates:** one table in `hooks/cost.ts`, USD per million tokens at Anthropic
  first-party API list prices (taken 2026-10-10). Subscription plans are billed differently. A
  model not in the table is priced as the newest of its family; one that matches no family
  shows `~$?`. To update, edit the table there; the ledger holds tokens, so history is repriced.
- **Cache hit %** is cache read over input + cache write + cache read.
- **Turns:** each completed turn (a wake-up; interrupted ones too, once per turn id) adds 1 to the
  agent's `turns` in `ledger.json`; rows from before the counter read as 0. Once an agent has
  turns, its line and the totals end with `, N turns, ~Xk cache write/turn`. That is cache write
  (5m + 1h) divided by turns: when a wake-up comes after the 5-minute cache expiry the whole context
  is written again, so a high figure means many cold wake-ups.

## The PR card and the batch card

Pane views for the reviewer's work (`hooks/prcard.ts`, `hooks/pane-view.tsx`). Both are reached from the Reviewer section of the tree; `b` goes back.

- **PR card:** press a PR line (or the "N awaiting approval" summary, which opens the first awaiting PR). Any status opens it; Approve and Reject show only while the handover is `awaiting`.
  - Shows `#N title`, status, branch, the first 8 characters of the stored head, who handed it over and when, why it awaits you (`mode` confirm: "the manager marked it risky"; else the `flow:confirm` label; else the `merge_mode` setting), `verified`, pending decisions, after-deploy check and verify command, the stored evidence ("no evidence stored" for old handovers), env changes, and the files with +/- counts and the URL.
  - The files, counts and URL come from `gh pr view <n> --json url,files,additions,deletions,labels,headRefOid`, run in the background when the card is drawn, never in the render. They are cached per `<pr>@<head>` for 5 minutes (30 seconds after a failure). The card says "loading details…" first, and "details unavailable: <reason>" if `gh` fails; the rest still works. If GitHub's head differs from the stored one the card warns that approving approves the stored head.
  - Keys: `a` Approve, `r` Reject (the input is an optional reason), `g` Open on GitHub (`open` on macOS, `xdg-open` on Linux; the URL is shown when no opener works).
  - Approve and Reject call the same functions as `/flow approve` and `/flow reject` (`approvePr`, `rejectPr`). Each re-reads the handover and refuses when it is no longer awaiting (Reject also takes a pending one, from the command), so a double press, or a reviewer that took the PR meanwhile, changes nothing. The result is shown on the card and as a toast; the card stays open with the new status.
- **Batch card:** press the "ready to push" batch line. Shows the batch id, version, the check line and its PRs (press one for its PR card, read-only). Keys: `p` Push, `d` Drop, and `send back` on a PR followed by `y` (or `n` to cancel). They call the same push gate as `/flow push`, `/flow push drop` and `/flow push back <pr>`. Only a `ready` batch has these buttons.

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
  push.json                the batch behind the push gate (see Push gate)
  reviewer-breaker.json    the reviewer respawn breaker (see Reviewer rules)
  preflight.json           pre-flight filings and rounds (see Pre-flight)
  lite.json                managers started in lite mode (see Lite mode)
  checks.json              person checks and their follow-ups (see Person checks)
  ledger.json              tokens spent per agent and model (see Cost meter)
  config.json              not state: the settings loader's file, written only by the settings tool (/flow init)
  init-done                marker: /flow init was run in this repo (silences the first-run hint)
```

- `handovers/<pr>.json`: `{version: 1, pr, title, head, branch, reportTo, verified, pending,
  afterDeploy, evidence?: {ran, exercised, notVerified}, status, at, sha?, report?, reason?}`; `status` is pending, awaiting, taken, ready (⇪, in a batch that awaits `/flow push`), done or returned.
  A new session loads these.
- `push.json`: `{batch?: {id, state, prs, items, sha, baseSha, ref, check, createdAt, version?, qid?, releasedAt?, reason?}}`; `state` is ready, pushing or rebuilding, `ref` is `refs/flow/push/<id>` (a local ref shared by all worktrees). The inbox item has kind `push`, options push / not yet (default) / drop, and is never answered by standing answers.
- `reviewer-breaker.json`: `{streak, run?: {name, startedAt}, endedAt?, error?, starts?: [ms], halt?: {at, error, qid?}}`; `halt` stops reviewer starts until a retry. Its inbox item has kind `reviewer`, options retry / not now (default), and is never answered by standing answers. Missing or damaged reads as an empty history.
- `log.jsonl`: one JSON object per line, `{ts, event, owner, agent?, pr?, branch?, text?}`;
  `event` is spawn, report, handover, take, done, back or note. `owner` is the manager the
  event belongs to (or `main`).
- `managers/<key>/notes.md`: dated lines, `- 2026-10-09 decision: "…"`. The key is the manager's
  name without a trailing `-N`, so `csv-export-2` continues `csv-export`'s notes.

`/flow resume` reads this too: it lists unfinished handovers next to the GitHub leftovers
(a handover whose PR is merged counts as done), groups them by owning manager, and gives each
restarted manager its notes (the last 3k characters).

## Develop it

```bash
claude --plugin-dir .            # a session with your working copy loaded
npm ci                           # the pinned TypeScript (devDependency, no runtime deps)
npm run typecheck                # tsc -p ., must report 0 errors
npm run validate                 # claude plugin validate . (must pass)
npm run check                    # typecheck + validate + claude plugin test .
```

Where code goes: `hooks/register.tsx` is the wiring only (atoms, `on(...)` hooks, `$.tool.register` calls, and small io builders that spell out each `$.noun.event(...)` call). Put new logic in a module under `hooks/`. The engine refuses `$` across an import and wants atoms declared in `register.tsx`, so a module is either pure (`pushgate.ts`, `clean.ts`, `table.ts`) or takes an io object of plain closures that `register.tsx` builds (`deliver.ts` is the example).

`npm run typecheck` works in a fresh worktree: it runs `npm ci` when `node_modules` is missing and,
when `.claude-plugin/types` is missing, symlinks it to the main checkout's copy. Claude Code writes
those type definitions itself (gitignored, per Claude Code version) when it loads the plugin from a
folder you own, so open a session in the main checkout with `claude --plugin-dir .` once. Flow
ignores and removes such links when it cleans a worktree. The repo's `.claude/flow.json` makes
`npm run typecheck` and `npm run validate` worker checks and `npm run check` the reviewer's full check, so no PR merges
with type errors.

Do not change `version` in `.claude-plugin/plugin.json`: this repo has `release` on, so add your changelog lines under `## [Unreleased]` in `CHANGELOG.md` and the reviewer bumps the version and cuts the release at merge (that is what `claude plugin update flow@flow` picks up).
