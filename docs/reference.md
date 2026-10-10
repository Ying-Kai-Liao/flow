# Reference

Settings, tools, the test lock, guard tests, state on disk and how to develop the plugin. Section names in parentheses, like "see Deploying", refer to [How flow works](how-it-works.md).

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
| `push_mode` | `auto` | `/config`, file | `auto` or `confirm` (unknown: `auto`): `confirm` makes the reviewer stop after the full check and the release, and waits for your `/flow push` (see Push gate) |
| `preflight` | `on` | `/config`, file | `off`: managers are not gated and no round is sent (see Pre-flight) |
| `preflight_wait` | 10 | `/config`, file | minutes the main session waits for managers to file before sending the round |
| `release` | `off` | `/config`, file | `on`: release at merge, the reviewer bumps the version once per batch (see Releases) |
| `release_files` | none (`package.json` at the repo root when there is one) | file only | repo-relative JSON or TOML files whose version the release bumps, a list; the first one gives the current version |
| `release_github` | `off` | `/config`, file | `on` (with `release` on): after the release push the reviewer tags `v<x.y.z>`, pushes the tag and creates a GitHub Release from the changelog section; needs `gh` authenticated with repo write |
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
- `reviewer` action `ready` (push_mode confirm; the reviewer only): records the checked batch instead of pushing it. Takes `prs` (the PRs in the batch), `sha` (the batch head, which must match `refs/flow/push/<id>`), `base_sha` (the `origin/<base>` it was built on), `check` (one line, the full check result) and `version` (when released). The PRs become `ready`; it opens the inbox item and a toast (see Push gate).
- `push` (main only, on your word): `list` shows the ready batch, `push` releases it, `send-back` with `pr` returns one PR (the rest is rebuilt), `drop` returns them all. Same as `/flow push`, `/flow push back <pr>` and `/flow push drop`.
- `release`: the reviewer, once per batch before the push (release on): cuts the changelog, bumps the version files, returns the commit command (see Releases). With `action: "publish"` (`release_github` on, after the push; optional `version`, default the last cut) it tags, pushes the tag and creates the GitHub Release. With `recut: true` (push gate, the base moved) it cuts a batch again that was already released.
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
- Urgent kinds skip the wait and flush the queue: answers to blocking asks, push-gate send-backs, the max-continues and wrap-up notices.
- A non-blocking ask is held: it does not wake the manager, and goes out with the next message, on the agent's next turn, or after 10 minutes at the latest. `/flow inbox` still shows it.
- A reviewer's message to a manager holds that manager's queue for the turn the message starts, so both arrive in one turn; a 60 second timer sends the queue if the message never lands.
- If the agent has ended, queued texts go to the message's fallback, else to main.

The queue is in memory: a plugin reload loses it.

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

## Cost meter

Every agent step adds its tokens (input, cache write 5m and 1h, cache read, output) to a ledger
keyed by agent, then by the model the API reports. Main's steps count under `main`. Each entry
keeps the agent's name, role, manager, branch and spawn model, so the ledger keeps an agent the
roster forgot. It is saved to `ledger.json` at most every few seconds and loaded again after a
restart. A failure in the ledger never touches the step.

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
  preflight.json           pre-flight filings and rounds (see Pre-flight)
  checks.json              person checks and their follow-ups (see Person checks)
  ledger.json              tokens spent per agent and model (see Cost meter)
  config.json              not state: the settings loader's file, never touched by flow
```

- `handovers/<pr>.json`: `{version: 1, pr, title, head, branch, reportTo, verified, pending,
  afterDeploy, evidence?: {ran, exercised, notVerified}, status, at, sha?, report?, reason?}`; `status` is pending, awaiting, taken, ready (⇪, in a batch that awaits `/flow push`), done or returned.
  A new session loads these.
- `push.json`: `{batch?: {id, state, prs, items, sha, baseSha, ref, check, createdAt, version?, qid?, releasedAt?, reason?}}`; `state` is ready, pushing or rebuilding, `ref` is `refs/flow/push/<id>` (a local ref shared by all worktrees). The inbox item has kind `push`, options push / not yet (default) / drop, and is never answered by standing answers.
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

`npm run typecheck` works in a fresh worktree: it runs `npm ci` when `node_modules` is missing and,
when `.claude-plugin/types` is missing, symlinks it to the main checkout's copy. Claude Code writes
those type definitions itself (gitignored, per Claude Code version) when it loads the plugin from a
folder you own, so open a session in the main checkout with `claude --plugin-dir .` once. Flow
ignores and removes such links when it cleans a worktree. The repo's `.claude/flow.json` makes
`npm run typecheck` and `npm run validate` worker checks and `npm run check` the reviewer's full check, so no PR merges
with type errors.

Do not change `version` in `.claude-plugin/plugin.json`: this repo has `release` on, so add your changelog lines under `## [Unreleased]` in `CHANGELOG.md` and the reviewer bumps the version and cuts the release at merge (that is what `claude plugin update flow@flow` picks up).
