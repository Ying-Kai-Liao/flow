# flow

flow is a Claude Code plugin that works through a batch of software tasks in parallel, inside your
session. Managers plan each task. Workers build it, each in its own git worktree, and open pull
requests. A reviewer merges them, runs your checks, cuts the release and deploys. You only make
the decisions.

```
you ── main session
         ├── manager: csv-export          one per task: plans, reviews, hands PRs over
         │     ├── worker: csv-endpoint   one per piece of work, in its own worktree
         │     └── worker: csv-button
         ├── manager: login-redirect
         │     └── worker: redirect-fix
         └── reviewer                    merges PRs, runs the full check, deploys
```

## Why use it

- **One round of questions up front.** Managers look at their tasks first and ask what they need.
  After you answer, you can walk away.
- **Small choices don't block you.** Agents decide them, log them, and you can undo any of them.
- **Answer a question once.** Standing answers handle the ones that keep coming back.
- **Every PR shows how it was checked.** A PR without a verification section is turned away.
- **Risky things wait for you.** You can require approval before a merge, and before a deploy to
  production.
- **Checks only a person can do are tracked.** After a deploy, anything an agent can't verify goes
  on a list instead of getting lost.

## Install

In a Claude Code session:

```
/plugin install flow --marketplace Ying-Kai-Liao/flow
```

## Your first run

Ask for work in your main session:

```
Add CSV export to the reports page, and fix the login redirect loop.
```

Here is what happens next:

1. flow starts one manager per task. Each reads the code and may ask you a few questions. You get
   them all in one round.
2. Managers start workers. Each worker builds one piece in its own worktree and opens a PR.
3. The manager reviews each PR and hands it to the reviewer.
4. The reviewer merges, runs your full check, and deploys if you set that up.
5. You see a report for each task.

Type `/flow` to open a pane that shows who is doing what. For a single change, "start a worker to
fix X" is enough.

## A day with flow

| Command | What it does |
|---|---|
| `/flow` | Opens the pane: managers, workers, and what needs you first. |
| `/flow inbox` | Lists what waits for you: a summary line, the questions (blocking first, deploy/push/env marked NEEDS YOU), the decisions agents made as one flat table (newest 15; `/flow inbox decisions` lists all, `/flow inbox d12` one item in full) and what standing answers did. |
| `/flow ok [d10 d11 \| owner \| topic]` | Keeps decisions (no words: every open decision) or takes the default of an ordinary question. Never answers a deploy, push, env or guard item. |
| `/flow no d12 [what instead]` | Undoes a decision; the agent is told what to do instead. |
| `/flow answer q3 <choice>` | Answers any question addressed to main (option letter, number, text, or your own words), deploy, push and env items included. |
| `/flow checks` | Lists the after-deploy checks that only a person can do as one table (id, PR, title, what it needs, age). `/flow checks <id>` shows one in full; `pass`, `fail` and `skip <id...> <why>` close them. |
| `/flow approve <n>` | Approves PR `n` when it is waiting for you. |
| `/flow push` | Pushes the batch the reviewer built and checked, when `push_mode` is `confirm`. `/flow push back <pr>` returns one PR, `/flow push drop` all of them. |
| `/flow hold <target>` / `/flow release <target>` | Keeps a deploy target from deploying, or lets it go again. |
| `/flow resume` | Picks up unfinished work after a restart. |
| `/flow clean` | Lists leftover worktrees and branches. Add `--yes` to remove them. |

Questions, approvals and checks also show up in the pane and as notifications. With anything open, press `i` in the pane to read and answer the inbox there (`j`/`k` move, a digit or letter picks an option, `y` takes the default or keeps a decision, `w` keeps all decisions, `n` undoes, `r` types an answer); you may answer any question, a manager's too. The key row sits at the pane's bottom.

## Settings

flow works with no setup. Most people set a few things in `.claude/flow.json` at the repo root:

```json
{
  "test_command": "pnpm test",
  "full_check_command": "pnpm check",
  "deploy_targets": [{ "name": "staging", "deploy": ["./deploy.sh staging"] }],
  "merge_mode": "confirm",
  "max_workers": 3
}
```

- `test_command`: what workers run to test their change.
- `full_check_command`: what the reviewer runs once before it pushes a batch of merges.
- `deploy_targets`: where the reviewer deploys, in order. Give a target `"mode": "confirm"` to make production wait for your OK. Leave it out and nothing deploys.
- `merge_mode`: `auto` merges handed-over PRs; `confirm` waits for your `/flow approve`.
- `worker_model`, `worker_model_small`, `worker_model_normal`, `manager_model`, `reviewer_model`, `conflict_model`, `explore_model`, `max_managers`, `max_workers`: models and limits.

Anything you leave out is skipped and reported. flow never guesses a command. The full list, with
defaults, is in the [reference](docs/reference.md).

## Learn more

- [How flow works](docs/how-it-works.md): roles, pre-flight, the inbox and standing answers,
  merge modes, releases, deploying, cleanup and the rules the reviewer follows.
- [Reference](docs/reference.md): every setting, the tools agents use, and the files flow keeps.
- Workers can also run in other coding tools, such as Codex. See
  [Workers in other harnesses](docs/how-it-works.md#workers-in-other-harnesses).

## Limits

- Everything runs inside one session. Close it and the work stops. Your branches and PRs stay,
  and `/flow resume` picks them up in a new session.
- The pane shows tool calls and reports, not full transcripts.
- All agents use the same Claude account's usage, so a big batch uses it quickly.

## Develop it

```bash
claude --plugin-dir .    # a session with your working copy loaded
npm ci                   # install TypeScript
npm run typecheck        # must report 0 errors
npm run validate         # must pass
npm run check            # typecheck, validate and the plugin tests
```

Add your changelog lines under `## [Unreleased]` in `CHANGELOG.md`. Don't change the version; the
reviewer does that at merge. More in the [reference](docs/reference.md#develop-it).
