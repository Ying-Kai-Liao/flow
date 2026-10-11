---
name: init
description: Onboard a user to flow after /flow init. A short walkthrough of how flow works, a demo (a free replay in the Flow pane, or a real run that uses tokens) and the Core settings, written through the mcp__flow__settings tool. Use when /flow init, /flow init settings or /flow init demo live asks you to follow this skill, or when the user asks how to get started with flow or how to set it up.
---

# flow init

The user ran `/flow init`. The command already gave you the detected facts (base branch, remote, gh, test and
check command candidates, and what each settings layer holds). Do the **part** you were told: `all` (walkthrough,
then demo, then settings), `settings`, or `live` (only the real demo). Keep steps short and let the user skip ahead ("skip", "next", "settings"). Do not start managers or workers for anything except the real demo, and only after the user confirms.

Some tools are deferred: load `mcp__flow__settings` and `mcp__flow__demo` with ToolSearch first
(`select:mcp__flow__settings,mcp__flow__demo`).

## 1. Walkthrough (part: all)

Give these as a few short messages. After each, ask whether to go on or skip to the demo or settings. Say only what is true in the README ("A day with flow"); do not invent commands.

1. **Roles.** You (main) hand over tasks. flow starts one **manager** per task. A manager plans the task and
   starts **workers**, each building one piece in its own git worktree and opening a PR. One **reviewer**
   merges handed-over PRs, runs the full check, cuts the release and deploys. Everything runs inside this session.
2. **Pre-flight.** Before workers start, each manager looks at its task and asks everything it needs in one
   round, so you can walk away after answering.
3. **The Flow pane** (`/flow`): who is doing what, and what needs you first. `/flow close` closes it.
4. **The inbox.** Two kinds of items. A **question** needs your answer. A **decision** is a small choice an agent
   made itself: keep it or undo it. `/flow inbox` lists them; `/flow ok` keeps decisions (or takes a question's
   default), `/flow no <id> [what instead]` undoes one, `/flow answer <id> <choice>` answers a question,
   `/flow inbox archive` lists what is answered. In the pane press `i` for the inbox; pressing a row opens a
   large card with the full text and every option as a button.
5. **Approvals.** With `merge_mode: confirm` the reviewer waits for `/flow approve <pr>`; `/flow reject <pr>`
   turns a PR down. With `push_mode: confirm` the reviewer checks a batch and stops; `/flow push` pushes it.
6. **Checks.** After a deploy, what an agent cannot verify becomes a check for a person: `/flow checks`.
7. **Coming back.** `/flow resume` picks up unfinished work after a restart; `/flow clean` lists leftover
   worktrees and branches (`--yes` removes them).
8. **Trim context per project.** Every flow agent inherits this session's global skills, plugins and MCP servers,
   so unused ones are paid for in every manager, worker and reviewer. Run `/context all` to see what each costs,
   then override per project in `.claude/settings.local.json` (usually git-ignored): `"skillOverrides": {"<skill>": "off"}`
   for personal and claude.ai-synced skills (not plugin skills), `"enabledPlugins": {"<name>@<marketplace>": false}`
   for plugins (claude.ai-synced ones are `<name>@synced`; `claude plugin list` shows ids), and
   `"deniedMcpServers": [{"serverName": "..."}]` for MCP servers. `/mcp` and `/skills` toggle these per project.
   `/plugin` may write to your user (global) settings, so prefer the local file. Then `/reload-plugins` or restart.

## 2. Demo (part: all, or when asked)

Offer two kinds and say which costs tokens:

- **Replay (free).** A scripted walkthrough in the Flow pane: canned manager, worker and reviewer cards, a
  question and a decision you answer in the pane, a PR handed over and merged, a report. No agents run, no model
  calls, nothing is written. Start it with `mcp__flow__demo` `{"action":"start"}` (the user can also type
  `/flow init demo`; `/flow init demo stop` or `x` in the pane ends it). Tell the user it is running, that it
  is labelled DEMO, and to say "done" when they have seen it; then end your turn.
- **Real run (uses tokens).** See section 4. Offer it after the replay, never as the default.

If the user skips the demo, go on to settings.

## 3. Settings (part: all or settings)

1. Call `mcp__flow__settings` `{"action":"show"}` to refresh the facts. If a layer says INVALID JSON, show the
   user the file and error and stop the settings part: flow never overwrites a file it cannot parse. If the repo
   is not a git repository, say flow needs one.
2. If values already exist in a layer, show them first (this is a re-run) and ask what to change; leave the rest
   alone. Never reset a value the user did not mention.
3. Ask a few questions at a time (AskUserQuestion), using the detected commands as suggested options only. The
   user can always type their own or choose none. **flow never guesses a command:** nothing is written that the
   user did not choose.
   - `test_command`: what a worker runs to check its package (suggest detected `test` candidates). Empty: the
     tests covering the changed files.
   - `full_check_command`: what the reviewer runs once per batch before pushing (suggest `check` or a
     lint/typecheck/build candidate). Empty: no full check, and the reviewer says so.
   - `deploy_command`: what the reviewer runs after pushing. Default none.
   - `merge_mode`: `auto` (the reviewer merges approved PRs) or `confirm` (it waits for `/flow approve <pr>`).
   - `push_mode`: `auto` or `confirm` (`/flow push`).
   - `release`: `on` or `off` (a merged batch bumps the version and cuts a changelog section). `release_github`
     and pushing need a remote: if there is none, say so.
   - Optionally `manager_model`, `worker_model`, `max_workers` (workers per manager, default 3).
4. Ask which file: the **repo file** `.claude/flow.json` (committed, shared with the team) or the **personal file**
   (uncommitted, only this clone's user). Personal values override repo values.
5. Write with `mcp__flow__settings` `{"action":"write","layer":"repo"|"personal","values":{...}}`. It merges into
   the file, keeps other keys, and `null` removes a key. It refuses unknown keys, wrong kinds, values outside the
   allowed choices, and anything that looks like a secret. Never put API keys or tokens in settings: they stay in
   env variables or files under `~/.config`. Report what it answered. Values apply within seconds, no restart. If the repo file was written, tell the user to commit it.
6. Mention, one line each and without asking, the advanced settings and where they are documented in
   `docs/reference.md`: `size_model` and the decision API (its keys live in env, never in settings),
   `deploy_targets` (several deploy targets with gates), `guard_tests` (tests required for matching files),
   standing answers (`/flow inbox` suggests rules for questions you keep answering the same way).
   Suggest `decision_api` `jev` for worker model sizing: it halved under-sized spawns in flow's own history, and it
   sends the brief text to the provider (api.typesafe.ai).

Finish with the next step: ask for work in this session (for example "Add CSV export to the reports page"), and
`/flow` to watch it. Running `/flow init` again shows the current settings and lets them change any.

## 4. Real demo (part: live, or when the user picks it; uses tokens)

Say first: this starts a real manager and a real worker, so it uses tokens like any flow task. Nothing is pushed,
no PR is opened, nothing is merged, and your base branch is not touched. Confirm before starting.

1. `mcp__flow__demo` `{"action":"status"}`. If a demo agent is running, say so and stop. If an earlier demo left a
   worktree or branch, `{"action":"cleanup"}` first.
2. Start **one manager** with the Agent tool: `subagent_type: flow:manager`, `name: flow-demo`,
   `run_in_background: true`. Its prompt (use these lines, adapted only for the file name):
   ```
   Pre-flight: skip
   Size: small - a throwaway one-line file
   This is the flow init demo. Start one worker named flow-demo-hello with this brief: add the file
   flow-demo.md containing one line, "Hello from the flow demo". The worker first runs
   `git switch -c flow/flow-demo-hello` in its own worktree, then commits that one file (a single commit on
   top of the base). The worker must NOT push, must NOT open a PR and must NOT call mcp__flow__handover; it
   reports the branch and the commit sha. You (the manager) review the diff (it must be exactly that one file),
   then report to main. Do NOT call mcp__flow__handover or open or merge a PR: this demo has no reviewer step.
   ```
3. While it runs, point the user at the pane (`/flow`) where flow-demo and flow-demo-hello appear like any agents.
   The inbox may get a worker-size decision; that is normal.
4. When the manager reports, show the diff summary, then explain what the reviewer would do next without doing it:
   merge the PR, run `full_check_command` once for the batch, cut the release, push (or wait for `/flow push`),
   and deploy.
5. **Clean up:** `mcp__flow__demo` `{"action":"cleanup"}` removes the demo's worktree and its `flow/flow-demo*`
   branch, and nothing else. It also takes a demo worker's worktree that kept another branch name or a detached
   HEAD, but only when it is clean and its one commit adds exactly `flow-demo.md`; anything else it cannot tie to
   the demo is left alone. Run it even if the demo was interrupted. Tell the user the file `flow-demo.md` never
   reaches their main checkout (it stays as it was), so there is nothing to revert.
6. Only if `gh` is installed and logged in and the repo has a remote, offer an extra opt-in: a **real draft PR**.
   The worker pushes its branch and opens a DRAFT PR titled "flow demo (safe to close)"; show it; then close the
   PR and delete the remote branch (`gh pr close <n> --delete-branch`). Still no merge and no handover. Skip this
   unless the user asks for it.
