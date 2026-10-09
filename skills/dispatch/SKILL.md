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
   Start independent managers in one message. Keep at most `max_managers` running (a
   setting, default 20; `mcp__flow__status` shows it as `Limits`); start the rest as each
   finishes, without asking again.
   When one task needs another's merged code, declare the tasks first with `mcp__flow__plan`
   (owner main): action `add`, nodes `{ id: "<manager name>", title, after: [ids] }`, with
   `until: "reported"` when only the other manager's report is needed. Start only the ready
   ones. When a `flow plan:` message says nodes are ready, start their managers, with the
   merged code in the prompt (`git fetch origin` first). Ready nodes over the limit wait for a
   slot; the message says how many are free and arrives again when one frees. A blocked node
   is yours to fix, or to mark with `block` or `done`. Independent tasks need no plan.
4. **Tell the user** in one line per task: the manager's name and what it's doing. Then end your
   turn: each manager's report arrives as a notification.

## Tasks from a source

A **task source** is a markdown doc in the project at `.claude/flow/sources/<name>.md` that
says how to list tasks, render one, and which writes back need the user's OK. The format is in
`references/sources.md`; `examples/github-issues.md` is a ready one for GitHub Issues that the
user can copy to `.claude/flow/sources/issues.md`. `/flow-tasks [source] [ids or filter]`
starts this.

1. Read the source's doc first (`ls .claude/flow/sources/`; with one source and none named,
   use it; with none, say so and offer to copy the GitHub Issues example).
2. **List** candidates the way the doc's List section says, with its default filter. If the user
   named ids, take only those.
3. Drop tasks with a live manager (`mcp__flow__status`) and tasks already shipped (step 2 of
   "Starting work").
4. Show the list once, one line per task: id, title, start or skip, and why. Then start right
   away; wait for an OK only when the user asked to review it first.
5. **Render** each task as the doc's Render section says into the manager's prompt: the task's
   text verbatim, your notes in a separate section, attachments as local paths. Start the
   prompt with `Source: <name> (<doc path>), source_id: <id>` so the manager can follow the
   doc's write-backs.
6. Start the managers as in "Starting work" (up to `max_managers`; the rest as each finishes). Name each
   by a slug of the task, not its id.

You never write to the source yourself unless the user asks; managers draft write-backs and
put them in front of the user.

## While they run

- **Push to finish.** The user handed you the list so they don't have to drive it. Never end a
  turn on a process question ("start the next one?", "restart the manager?"): do it and say
  what you did. Stop only for product decisions.
- **A manager's question** arrives as its report ending in "?". Put every pending question in
  front of the user as one numbered list, each with its owner. Send each answer to its owner by
  SendMessage, quoting the user's words.
- **Anything you relay to a manager** (answers, scope additions, mid-task fixes) goes both in the
  SendMessage and in `mcp__flow__note` (manager = its name, kind "decision", the user's words
  quoted, with the date), so it survives a restart whether or not the manager writes it down.
- **A manager's handoff** is its report ending `HANDOFF: manager <name>`: its context ran out.
  Start a fresh `flow:manager` named `<name>-2` (then `-3`) with the original task plus the
  note, without asking the user. Its prompt says to read its notes first (`mcp__flow__note`
  with manager = `<name>` and no text).
- **Check-ins** ("how is it going?"): call `mcp__flow__status` and answer with one
  compact table (task, manager, PRs, where each PR is: open, handed over, merged, and its plan state if it has a node), then the
  open questions as a numbered list.
- **A relayed decision** is a quote: pass the user's exact words, dated.

## After a restart

The roster is empty after a restart, but branches, PRs and `.claude/worktrees/` stay. When the
user runs `/flow resume`, you receive what it found as hidden instructions: start one
`flow:manager` per task as they say (named `resume-<slug>`, up to `max_managers` at a time), each prompt
carrying the branch, PR number and URL, the PR description and any worktree path. When the
instructions name an owner and its notes, the prompt says to read those notes first. Do not
start workers for it yourself.

## Cleanup

Merged workers' worktrees and local branches are removed by the plugin's sweep (setting
`cleanup`, default `auto`) and by managers and the queue after each merge. You sweep what's
left: when all managers are finished, or when the user asks about leftovers or cleanup, run
`mcp__flow__clean` (a dry run) and show the user what it lists. With `cleanup: auto` you may
then apply the safe sweep yourself (`apply: true`); the user can also run `/flow clean --yes`.
Anything it keeps (uncommitted, unpushed, locked or live work) goes in front of the user to
decide; never delete it.

## Small changes

For a change the user wants right now with no fan-out, you may start a single
`flow:worker` yourself (name, brief as prompt, `run_in_background: true`), review its PR,
and hand it over with `mcp__flow__handover`. Never edit the main checkout for it.

## Settings

The test command, the full check, the deploy command, the merge method, whether there is a
queue, the manager limit (`max_managers`) and the worker limit are this plugin's options (`/config`, flow). An unset full
check or deploy is a step the queue skips and reports; it never improvises one.
