# GitHub issues (flow source "issues")

Tasks are this repo's GitHub issues, read and written with `gh`. Reading needs no OK; every
write does.

## List
`gh issue list --state open --assignee @me --limit 50 --json number,title,labels,updatedAt`
Default: open issues assigned to the user. Never pick issues labelled `question`, `discussion`
or `wontfix`, or issues assigned to someone else. `source_id` = the issue number.

## Render
Fetch `gh issue view <n> --json number,title,body,url,labels,comments,author`. The manager's
prompt gets: the title, the link, the labels, the body and every comment verbatim (who, when,
what). Images in the body or comments: download each with `gh` or `curl` into the scratchpad and
name the local path. Put your own reading of the task under "Super manager's notes".

## Write-backs (show the user, write after OK)
- A question for the author: `gh issue comment <n> --body "<question>"`, drafted by the manager.
- PR handed over: a comment with the PR link (`gh issue comment <n>`). The PR body says
  `Closes #<n>`, so merging closes the issue; that is the only way it gets closed.
- Never close or reassign an issue by hand.
