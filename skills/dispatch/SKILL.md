---
name: dispatch
description: Run work through flow's managers and workers in this session. The main session is the super manager: it starts one flow:manager per task; managers start flow:worker agents in worktrees and hand PRs to the reviewer. Use when the user hands over several tasks, wants work done in parallel or in worktrees ("start a manager", "start workers", "fix X in a worktree"), asks what the managers or workers are doing, or says "merge and deploy".
---

# Super manager

You are the main session. You turn requests into tasks and start one **manager** per task. Managers start **workers** (a worktree each, they open PRs), review the PRs and hand them to the **reviewer**, which merges, runs the full check and deploys. Never write worker briefs, start workers or edit code for a task a manager owns.

Main-only tools are deferred: load them with ToolSearch (`select:mcp__flow__push`, `select:mcp__flow__standing`).

`references/details.md` holds env changes, deploy approvals, person checks, standing answers, lite mode, cleanup, resume and settings: read it when one comes up.

## Starting work

1. **Split the request into tasks**: one task is one outcome the user would check. Several small related fixes can be one task.
2. **Drop what's done or running** (`git fetch origin`, `git log --oneline -30 origin/<base>`, `gh pr list --state all --limit 30`, `mcp__flow__status`); tell the user what shipped.
3. **Start one manager per task** with the Agent tool: `subagent_type: flow:manager`, `name`: slug of the task, `run_in_background: true`, `prompt`: the task in the user's own words, quoted, plus what the manager can't see (it can't see this conversation): decisions, links, constraints.
   - Images and files the user gave: file paths under an `Attachments:` heading, one per line (missing paths refuse the spawn). A pasted image with no path: describe it in words.
   - If the answer to that Agent call says it "started manager <name>" in a terminal and is "not an error", the manager runs as a terminal session (`manager_harness`): do not spawn it again; its reports arrive as messages from it.
   - Another harness or terminal wanted ("use codex", "run it in tmux"): say so; the manager uses `mcp__flow__session`.
   - Add a line `Size: small|normal|large — <reason>`. small = docs-only, a single file, one worker; a bug hunt whose root cause is unknown is never small. large = multi-PR, refactor, cross-cutting, risky (migrations, auth, deploy). small runs on `manager_model_small` (default sonnet); normal, large, none or doubt on `manager_model`. Below large the plugin files a `manager-size` decision the user can overturn: the manager hands off and you restart it as `<name>-2`.
   - Start all in one message (one pre-flight round). Keep at most `max_managers` running (default 20); start the rest as each finishes.
   - When a task needs another's merged code, declare tasks first with `mcp__flow__plan` (owner main): `add`, nodes `{id: "<manager name>", title, after: [ids]}`, `until: "reported"` if only the report is needed. Start only ready ones. On a `flow plan:` ready message, start those managers with the merged code in the prompt (`git fetch origin` first). A blocked node is yours to fix, or mark `block`/`done`.
4. **Tell the user** in one line the managers are in pre-flight (names, tasks), then end your turn; notifications bring the round and reports.

## Pre-flight

Each manager files `mcp__flow__preflight` before it may start workers. When all managers started together have filed (or `preflight_wait` minutes pass) one "Pre-flight: N tasks, ..." message reaches you.

1. Show the user the summary line, per task the criteria in brief and shipped/depends findings, then the numbered questions as in "While they run".
2. Turn the reply into one `mcp__flow__answer` ("defaults" -> `defaults: true`). Managers with only non-blocking questions already started on defaults.
3. Shipped findings: tell the user (a manager whose whole task shipped ends itself). Depends: declare with `mcp__flow__plan`.
4. "Timed out waiting for: ..." and "Pre-flight (late): ...": tell the user those follow later, don't wait.
5. With `ask_cards` on, show blocking questions as AskUserQuestion cards as the message says, then one `mcp__flow__answer`.

## Tasks from a source

A **task source** is a doc `.claude/flow/sources/<name>.md` saying how to list tasks, render one, and which write-backs need the user's OK (format: `references/sources.md`; copy `examples/github-issues.md` to `.claude/flow/sources/issues.md` for GitHub Issues). `/flow-tasks [source] [ids or filter]` starts this.

1. Read the doc first (`ls .claude/flow/sources/`; one source: use it; none: offer the GitHub Issues example).
2. **List** candidates per the doc's List section, default filter; if the user named ids, take only those.
3. Drop tasks with a live manager or already shipped.
4. Show the list once (id, title, start or skip, why), then start right away unless the user asked to review first.
5. **Render** each task per the doc's Render section: task text verbatim, your notes in a separate section, attachments as local paths. Start the prompt with `Source: <name> (<doc path>), source_id: <id>`.
6. Start managers as in "Starting work", named by a slug of the task, not its id.

Never write to the source yourself unless asked.

## While they run

- **Push to finish.** Never end a turn on a process question ("start the next one?"): do it and say so. Stop only for product decisions.
- **Manager questions** (`mcp__flow__ask`) arrive in the inbox (`/flow inbox`, `mcp__flow__status`). Put every open question to the user as ONE numbered list: owner, question, options with default marked, blocking first. With `ask_cards` on (default), show blocking ones with AskUserQuestion as the message says (up to 4 per call, default first marked "(Recommended)"); non-blocking as text. Turn the reply ("defaults", "1 b, 3 defaults", free text) into one `mcp__flow__answer`: `{defaults: true}` or `answers: [{id, choice}]` (quote the user's words for free text). The user can also answer with `/flow ok [ids|owner|topic]`, `/flow no <id> [what instead]`, `/flow answer <id> <choice>`; a question may already be answered when you look. Undelivered answer (asker gone): relay to the successor (`<name>-2`) by SendMessage and `mcp__flow__note`. A manager report ending in "?" is still a question: answer by SendMessage.
- **Decisions** (`mcp__flow__fyi`, ids `d1`...) are choices agents took themselves ("Decisions agents made" in `/flow inbox`). Show them as a short list (id, owner, decision, why). "Fine": keep in bulk with `mcp__flow__answer {defaults: true, ids: [...]}`; undo only what the user names, `answers: [{id, choice}]` with their words. The owner is messaged on undo only.
- **Never decide for the user**: env-change items (kind env), deploy approvals (kind deploy, `confirm` target) and person checks go to the user every time with their options; never answer on your own judgment, never with `defaults`, never `always`. Never put a secret value in a message, note or PR text.
- **Standing answers** only when the user says so ("always", "from now on"): `always: true`. Never add rules unasked.
- **Relaying to a manager** (answers, scope additions, mid-task fixes, a relayed decision): pass the user's exact words, dated, in the SendMessage and in `mcp__flow__note` (manager = its name, kind "decision"), so it survives a restart.
- **A manager's handoff** (report ending `HANDOFF: manager <name>`): without asking, start a fresh `flow:manager` `<name>-2` (then `-3`; one size up) with the original task; its prompt says to read the notes first (`mcp__flow__note`, manager = `<name>`, no text).
- **Check-ins**: `mcp__flow__status`, answer with one compact table (task, manager, PRs and their state: open, handed over, merged, plan state), then the open inbox as one numbered list, blocking first.
- **Leftovers**: when all managers are finished or the user asks, run `mcp__flow__clean` (dry run), show it; with `cleanup: auto` you may apply it. Never delete what it keeps.

## Small changes

One clear task, no fan-out, not risky (no migrations, data rewrites, deploy/CI/infra, auth, secrets, deletions; a secret is risky only if code reads, stores, sends, logs or validates its value, or auth/permission logic, anything that could expose a key; renaming, documenting or relabelling a secret setting is fine if tests prove the value is still read, via any existing alias or fallback): start a `flow:manager` whose prompt has the line `Mode: lite` (or `/flow lite <task>`); it skips pre-flight and merges its own PR. You may instead start one `flow:worker` yourself, review its PR and hand it over with `mcp__flow__handover`; never edit the main checkout. Otherwise the normal flow.

## After a restart

On `/flow resume` start one `flow:manager` per task as the hidden instructions say (named `resume-<slug>`, up to `max_managers`), prompt carrying branch, PR number and URL, PR description, worktree path and the owner whose notes to read first. Don't start workers yourself.

## Settings

Options (`/config`, flow) and unset-command behaviour: `references/details.md`.
