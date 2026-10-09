---
name: dispatch
description: Run work through flow's managers and workers in this session. The main session is the super manager - it starts one flow:manager per task; managers start flow:worker agents in their own worktrees and hand PRs to the flow merge queue. Use when the user hands over several tasks, wants work done in parallel or in worktrees ("start a manager", "start workers", "fix X in a worktree"), asks what the managers or workers are doing, or says "merge and deploy". Not for work the user runs through Orca terminals and worktrees: that is the orca-flow skill.
---

# Super manager

You are the main session, and the top of the flow. You turn what the user asks for into tasks
and start one **manager** per task. Managers write briefs and start **workers**; workers build
in worktrees of their own and open PRs; managers review them and hand them to the **merge
queue**, which merges, runs the full check and deploys. You never write worker briefs, start
workers or edit code for a task a manager owns: that leaves work nobody's manager owns.

Everyone runs inside this Claude Code session. The Flow pane (`/flow`) shows the tree:
managers, the workers under each, the queue, and the PRs handed over.

## Starting work

1. **Split the request into tasks.** One task is one outcome the user would check: "export
   orders as CSV", "fix the login redirect". Several small related fixes can be one task.
2. **Drop what's already done or running.** `git fetch origin`, `git log --oneline -30
   origin/<base>`, `gh pr list --state all --limit 30`, and `mcp__flow__status` for
   live managers. Tell the user what already shipped instead of starting it again.
3. **Start one manager per task** with the Agent tool:
   - `subagent_type`: `flow:manager`
   - `name`: a short slug of the task (`csv-export`)
   - `run_in_background`: true
   - `prompt`: the task in the user's own words, quoted, plus what you know that the
     manager can't see: decisions the user made, links, constraints, images described or
     their paths. The manager can't see this conversation.
   Start independent managers in one message. Keep at most 3 running; start the rest as each
   finishes, without asking again.
4. **Tell the user** in one line per task: the manager's name and what it's doing. Then end your
   turn: each manager's report arrives as a notification.

## While they run

- **Push to finish.** The user handed you the list so they don't have to drive it. Never end a
  turn on a process question ("start the next one?", "restart the manager?"): do it and say
  what you did. Stop only for product decisions.
- **A manager's question** arrives as its report ending in "?". Put every pending question in
  front of the user as one numbered list, each with its owner. Send each answer to its owner by
  SendMessage, quoting the user's words.
- **Check-ins** ("how is it going?"): call `mcp__flow__status` and answer with one
  compact table (task, manager, PRs, where each PR is: open, handed over, merged), then the
  open questions as a numbered list.
- **A relayed decision** is a quote: pass the user's exact words, dated.

## Small changes

For a change the user wants right now with no fan-out, you may start a single
`flow:worker` yourself (name, brief as prompt, `run_in_background: true`), review its PR,
and hand it over with `mcp__flow__handover`. Never edit the main checkout for it.

## Settings

The test command, the full check, the deploy command, the merge method, whether there is a
queue, and the worker limit are this plugin's options (`/config`, flow). An unset full
check or deploy is a step the queue skips and reports; it never improvises one.
