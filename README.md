# flow-board

The orca-flow pattern inside one Claude Code session, with nothing else installed: no Orca, no
tmux. You talk to the main session; it runs the work through managers, workers and one merge
queue, and a pane shows the whole tree.

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
| `flow-board:manager` | background agent, named after its task | writes briefs, starts workers, reviews their PRs, hands approved ones to the queue; refused if it tries to edit code |
| `flow-board:worker` | background agent in a worktree of its own | builds one brief, pushes `flow/<name>`, opens a PR, reports or asks |
| `flow-board:queue` | background agent, started by the plugin | merges handed-over PRs in batches, runs the full check once per batch, pushes, deploys, reports back |

Reports and questions travel up the tree on their own: a worker's report wakes its manager, a
manager's wakes the main session. Answers go down by message. Only the main session asks you
anything.

## What you see

- **The Flow pane** (`/flow`): the tree, what needs you first, and the PRs handed to the queue.
  Click any agent to see its activity, its last report or question, and how many agents run
  under it. **Message** starts a message to it in your prompt; **Back** returns.
- **The status line**: `flow: 2 managers · 3 workers · queue: 1 PR · /flow`.
- **Toasts** when an agent finishes, asks a question, or a PR merges or comes back.

## Install

In a Claude Code session:

```
/plugin install flow-board --marketplace Ying-Kai-Liao/flow-board
```

Then ask for work: "start managers for these three tasks: …", or for one change, "start a
worker to fix X".

## Settings

`/config` → flow-board:

| Option | Default | Used by |
|---|---|---|
| `test_command` | tests covering the changed files | workers |
| `full_check_command` | none (the queue says so) | the queue, once per batch |
| `deploy_command` | none (no deploy) | the queue, after pushing |
| `merge_queue` | on | off: managers merge themselves with `merge_method` |
| `merge_method` | `squash` | managers, when there is no queue |
| `max_workers` | 3 | workers per manager at a time |
| `worker_model` | `sonnet` | workers |
| `base_branch` | the remote's default branch | everyone |

An unset full check or deploy is a step that's skipped and reported, never improvised.

## Tools the agents use

- `flow_handover`: a manager hands a reviewed PR over; the plugin records its head and starts
  a queue if none is running.
- `flow_queue`: the queue's worklist (`list`, `take`, `done`, `back`).
- `flow_status`: the tree and the handovers as text, for check-ins.

## Limits

- Everything runs inside one session. Close it and the flow stops; the branches and PRs stay.
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
`claude plugin update flow-board@flow-board` picks it up.
