# flow

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
| `flow:manager` | background agent, named after its task | writes briefs, starts workers, reviews their PRs, hands approved ones to the queue; refused if it tries to edit code; hands off to a `-2` manager at the context limit |
| `flow:worker` | background agent in a worktree of its own | builds one brief, pushes `flow/<name>`, opens a PR, reports or asks; at the context limit it pushes its work and writes a handoff note |
| `flow:queue` | background agent, started by the plugin | merges handed-over PRs in batches, runs the full check once per batch, pushes, deploys, reports back |

Reports and questions travel up the tree on their own: a worker's report wakes its manager, a
manager's wakes the main session. Answers go down by message. Only the main session asks you
anything.

## What you see

- **The Flow pane** (`/flow`): the tree rooted at your main session (the super manager), with
  the managers, what needs you first, and the PRs handed to the queue under it. Every agent is
  a card: a status glyph, the bold name with `(+N)` for the agents under it, the role dimmed, one
  short activity line (what it is doing, or the question it asks; the description only while
  there is no activity yet), and the meter below with elapsed time and tokens. Only top-level
  cards have a border. Colors follow your light or dark theme (the theme's suggestion, warning,
  success and error colors), and the pane redraws when you switch `/theme`.
  Click a card to see the agent's activity, when it was last active, and its last report or question. The agents under it
  are cards too: click one to open it. **Message** starts a message to it in your prompt;
  **Back** returns to the agent above it, or to the tree from a top-level agent.
  `/flow close` closes the pane, `/flow resume` picks up unfinished work (below). It stays closed while agents keep running, until the next
  `/flow` or a newly started agent opens it again.
- **Pane keys**: `j` / `k` move the highlight down and up the tree, `o` opens the highlighted agent,
  `c` folds or unfolds its children. In an agent's detail, `b` goes back and `m` starts a message.
  Arrow keys, Tab and Enter go through the pane's focus ring, and the highlight follows it. Esc
  can't be caught inside a pane, and `g` is reserved for the graph view.
- **Many agents**: with 10 to 20 managers the tree auto-collapses to the highlight's path, shows
  `↑ N above` and `+N more` for rows out of the window, and scrolls to keep the highlight in view.
  `c` overrides the automatic folding for one agent.
- **Following the chat view**: plugins can't switch the transcript, so the pane follows it. Open an
  agent from the tasks list (`←`) and the pane shows that agent; back to main restores what you had.
  Anything you do in the pane wins until the view changes. The first card click shows a one-time
  hint on how to open that agent's chat. Known limit: if you act while viewing agent X, go to main
  without acting, and reopen X, the pane doesn't re-follow X until you act on main or open another agent.
- **A context meter on each card**: `███│░░░░░░░ 42%   1m 43s · ↓ 84.0k tokens`, with `│` marking the warning
  threshold (`context_warn_percent`). The meter turns the theme's warning color at or past the threshold and its error
  color from 90%. The time runs while the agent runs and freezes when it ends. Where an agent's usage isn't known yet it says `context ?` and shows no tokens, never a guess. A
  subagent's window is the main session's when it runs the same model, else 200k (1M for a
  `[1m]` model).
  On a short terminal the cards shrink to one-line rows (just `42%`), and `+N more` stands in
  for rows that don't fit.
- **The status line**: `flow: 2 managers · 3 workers · queue: 1 PR · /flow`.
- **Toasts** when an agent finishes, asks a question, or a PR merges or comes back.

## Continuing work

**Handoff.** When a worker or manager reaches `context_warn_percent` (once per agent; the queue
and the main session never get it), the plugin sends it a notice and a toast. A worker finishes
its small step, commits everything as `WIP handoff: …`, pushes `flow/<name>`, opens or updates a
draft PR, writes the note into the PR description under `## Handoff` (Done / Remaining /
Decisions / Gotchas) and ends its report with `HANDOFF: <branch>`. Its manager checks the push,
starts `<name>-2` on the same branch (`Continue on branch: flow/<name>`) with the original brief
and the note, and removes the old worktree only if it is clean and fully pushed. A manager
hands off the same way, but only when none of its workers is running; the main session starts
`<name>-2` from its note. The note lives in the PR description and the report, never in a file
on the branch.

**`/flow resume`.** After a restart the roster is empty but branches, PRs and
`.claude/worktrees/` stay. `/flow resume` lists open `flow/*` PRs, pushed `flow/*` branches
without a PR (merged or closed ones are skipped) and leftover worktrees with uncommitted or
unpushed work, then has the main session start one `resume-<slug>` manager per task (at most 3
at a time). Work owned by a live agent, or already resumed in this session, is not listed again.

## Install

In a Claude Code session:

```
/plugin install flow --marketplace Ying-Kai-Liao/flow
```

Then ask for work: "start managers for these three tasks: …", or for one change, "start a
worker to fix X".

## Settings

`/config` → flow:

| Option | Default | Used by |
|---|---|---|
| `test_command` | tests covering the changed files | workers |
| `full_check_command` | none (the queue says so) | the queue, once per batch |
| `deploy_command` | none (no deploy) | the queue, after pushing |
| `merge_queue` | on | off: managers merge themselves with `merge_method` |
| `merge_method` | `squash` | managers, when there is no queue |
| `max_workers` | 3 | workers per manager at a time |
| `worker_model` | `sonnet` | workers |
| `context_warn_percent` | 40 | the pane's context meter: where the marker sits and the meter turns yellow (1 to 100) |
| `handoff` | on | workers and managers: at `context_warn_percent` they are told to hand off (see Continuing work). Off: the meter only shows |
| `base_branch` | the remote's default branch | everyone |

An unset full check or deploy is a step that's skipped and reported, never improvised.

## Tools the agents use

- `handover`: a manager hands a reviewed PR over; the plugin records its head and starts
  a queue if none is running.
- `queue`: the queue's worklist (`list`, `take`, `done`, `back`).
- `status`: the tree and the handovers as text, for check-ins.

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
