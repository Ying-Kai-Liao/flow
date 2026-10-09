# Task sources

A task source is where tasks come from: an issue tracker, a board, a planning doc. flow doesn't
talk to any of them itself. A source is a **markdown doc in the project**, at
`.claude/flow/sources/<name>.md`, that tells the super manager and the managers how to use it
with whatever tools the project has (an MCP server, `gh`, a CLI). The file name is the source's
name: `.claude/flow/sources/issues.md` is the source `issues`.

`examples/github-issues.md` next to this folder is a ready one for GitHub Issues: copy it to
`.claude/flow/sources/issues.md` and adjust the filter.

## What the doc must contain

Three sections, under these headings:

- **List**: how to list candidate tasks (the exact call or command), the default filter (which
  states, which assignee, what's never picked automatically), and what the stable `source_id`
  is: the id that stays the same for the task's lifetime.
- **Render**: how to turn one task into a manager's prompt: which fields to fetch
  (description, comments, subtasks, due date, link). The task's own text is **copied
  verbatim**, never rewritten; the super manager's judgement goes in a separate "Super
  manager's notes" section. Attachments are downloaded to local paths, and the prompt names
  those paths.
- **Write-backs**: every write to the source (comments, status moves, completion,
  reassignment) is drafted, shown to the user, and written only after their OK: the source is
  usually shared with other people. List which write-backs a manager is expected to propose and
  when (a question to the task's author, a comment when the PR is handed over, a status move
  after merge), and which it never makes (usually: marking the task complete).

Anything else project-specific (ids, section names, the user's account) goes in the same doc.
