# flow-board

A Claude Code mod for running coding workers in parallel from one session. Workers are background
subagents of the main session, each in a git worktree of its own, started through the
`flow-board:worker` agent type. You stay in the main session and watch them from a pane. It needs
nothing else installed: no Orca, no tmux.

## What you get

- **The Flow pane**: one row per worker with its status. Open it with `/flow`.
- **Click a row** to see that worker's activity (its tool calls) and its final report.
- **Message** starts a message to the selected worker in your prompt; **Back** returns to the list.
- **A status line** with the count of live and ended workers.
- **Toasts** when a worker finishes its turn, asks a question or changes status.

## Requirements

Claude Code 2.1.287 or later (for mods).

## Install

In a Claude Code session:

```
/plugin install flow-board --marketplace Ying-Kai-Liao/flow-board
```

Then ask Claude to start a worker ("start a worker to fix X") and open the pane with `/flow`.

## Develop it

```bash
claude --plugin-dir .            # a session with your working copy loaded
claude plugin validate .
claude plugin test .
```

## Limits

- Workers live only as long as the main session. Close it and they stop.
- The pane shows tool calls and reports, not the full transcript.
- Orca and tmux backends are planned, not built yet.
