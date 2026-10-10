// MCP tool specs (name, description, input schema, deferred flag) for the tools flow registers in session.start.
// Pure data: the `$.tool.register(...)` calls stay in register.tsx because the engine refuses `$` across an import.
import type { ToolSpec } from 'claude-code'
import { WAIT_DEFAULT_S, WAIT_MAX_S } from './slots'
import { seedIds } from './standing'

export const HANDOVER_TOOL: ToolSpec = {
  name: 'handover',
  description: 'Hand an approved PR to the flow reviewer. Records the PR at its current head and starts a reviewer if none is running. ' +
    'Managers call this after reviewing a worker\'s PR; leave the branch alone afterwards. ' +
    'Refused unless the PR description has a ## Verification section (Ran, Exercised, Not verified); the refusal shows the format.',
  inputSchema: {
    type: 'object',
    properties: {
      pr: { type: 'number', description: 'The PR number' },
      verified: { type: 'string', description: 'Optional: your own one-line summary of the review. The proof itself is read from the PR\'s ## Verification section.' },
      pending: { type: 'string', description: '"none", or decisions the user still has to make; the reviewer puts them in its report and the status file' },
      after_deploy: { type: 'string', description: '"none", or what to check after deploy; the reviewer starts a check-only worker for what an agent can check and reports the rest as "needs a person"' },
      verify_command: { type: 'string', description: 'Optional: a shell command that verifies the change after deploy. When the after_deploy check needs a person, the reviewer runs this command at the merged main and closes the check itself (pass on exit 0, fail otherwise).' },
      report_to: { type: 'string', description: 'Optional. Your own agent name (the default), so the reviewer reports back to you. A name that matches no agent is refused; your own worker\'s name is corrected to yours.' },
      release: { type: 'string', enum: ['patch', 'minor', 'major'], description: 'How far the release at merge bumps the version for this PR (only when the release setting is on). "minor" for a new feature users see; omit for patch; "major" only when the task asks for it. The batch gets the highest of its PRs.' },
      env: {
        type: 'array',
        description: 'Optional: env or secret changes the PR needs on a deploy target. Each goes to the user\'s inbox and the target does not deploy until they are answered. A secret has no value here: "secret: true" means the user sets it themselves. Never put a secret value anywhere, in this field or in the PR text.',
        items: {
          type: 'object',
          properties: {
            target: { type: 'string', description: 'A deploy target name from the deploy_targets setting' },
            name: { type: 'string', description: 'The env variable name' },
            value: { type: 'string', description: 'The new value, for a change that is not secret (the user sees it and says yes or no). Not together with secret.' },
            secret: { type: 'boolean', description: 'true: the user sets it themselves and answers done. Not together with value.' },
            why: { type: 'string', description: 'Why the change is needed' },
            login: { type: 'string', description: 'Optional: a step the user must do themselves first, e.g. log in to the cloud CLI. It becomes its own inbox item the change waits for.' },
          },
          required: ['target', 'name', 'why'],
        },
      },
      mode: { type: 'string', enum: ['auto', 'confirm'], description: '"confirm" for a risky PR: it waits for the user\'s /flow approve before the reviewer merges it. "auto" only marks it safe to merge directly and is refused when the merge_mode setting is confirm. Omit to use the setting.' },
    },
    required: ['pr'],
  },
  isDeferred: false,
}

export const RELEASE_TOOL: ToolSpec = {
  name: 'release',
  description: 'Release at merge (the release setting must be on). The reviewer calls this once per batch, after the full check and before the push: it moves the changelog\'s ## [Unreleased] lines into a new version section, bumps the version in the release files (patch, or the highest of the PRs\' handover release field and flow:minor / flow:major labels) and returns the commit command. It does not commit or push. A second call for the same PRs is refused as already released. With action "publish" (release_github on, after the release commit is pushed) it tags v<version>, pushes the tag and creates the GitHub Release from the changelog section; failures come back as a "Not published" line and never throw.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['cut', 'publish'], description: '"cut" (default): cut the changelog and bump the version. "publish": tag, push the tag and create the GitHub Release for the release commit at HEAD of dir.' },
      dir: { type: 'string', description: 'The reviewer\'s worktree, absolute' },
      prs: { type: 'array', items: { type: 'number' }, description: 'cut: the PR numbers merged in this batch' },
      version: { type: 'string', description: 'publish: the version to publish; default the version of the last cut' },
      recut: { type: 'boolean', description: 'cut: true when rebuilding a batch the user released after the base moved (push_mode confirm): the same PRs are cut again against the new base' },
    },
    required: ['dir'],
  },
  isDeferred: false,
}

export const ASK_TOOL: ToolSpec = {
  name: 'ask',
  description: 'Ask a structured question (a batch) instead of asking in prose. A worker\'s questions go to its manager, a manager\'s to main. ' +
    'Give options and the default you recommend. Non-blocking: go ahead on the default now and say in your report that you assumed it; you get a message if the answer differs. ' +
    'Blocking: end your turn; the answer arrives by message. Main cannot ask. ' +
    'Give a recurring kind of question a short stable kebab-case topic (e.g. version-bump, test-approach): the user can answer a topic once, and a standing answer then answers it for you at once (the result line says so).',
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Your agent name' },
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            options: { type: 'array', items: { type: 'string' }, description: 'The choices, at least two' },
            default: { type: 'string', description: 'The option you recommend (its text or its 1-based number)' },
            blocking: { type: 'boolean', description: 'true when you cannot go on without the answer' },
            context: { type: 'string', description: 'What the answerer needs to know' },
            topic: { type: 'string', description: 'For a question of a recurring kind: a short, stable kebab-case label (e.g. version-bump, test-approach), the same every time you ask it. The user can answer such a topic once as a standing answer.' },
          },
          required: ['question', 'options', 'default', 'blocking'],
        },
      },
    },
    required: ['from', 'questions'],
  },
  isDeferred: false,
}

export const FYI_TOOL: ToolSpec = {
  name: 'fyi',
  description: 'Record a decision you took yourself on a reversible choice (a threshold, wording, a name, a default, styling within the existing design) as a non-blocking decision the user can keep or undo: "I decided X because Y; say if wrong". The tool is named fyi for compatibility; the items are decisions with ids d1, d2, ... ' +
    'A worker\'s decisions go to its manager, a manager\'s to main. Never stop for it: carry on. You get a message only if it is undone; then change your work. ' +
    'Irreversible or product-defining choices (what customers pay for, who receives data, deleting data) are asks, not decisions. Main cannot call it.',
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Your agent name' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            decision: { type: 'string', description: 'What you decided' },
            why: { type: 'string', description: 'Why that is the conservative choice' },
            alternative: { type: 'string', description: 'Optional: what you would otherwise have done' },
            topic: { type: 'string', description: 'Optional short kebab-case label' },
          },
          required: ['decision', 'why'],
        },
      },
    },
    required: ['from', 'items'],
  },
  isDeferred: false,
}

export const PREFLIGHT_TOOL: ToolSpec = {
  name: 'preflight',
  description: 'Managers only. File your pre-flight after looking over your task (read the code, the history and open PRs; no workers yet): the plugin refuses your worker starts until you have, ' +
    'and, if you ask blocking questions, until they are answered. Main gets one combined round from all managers started together. ' +
    'questions are stored in the decision inbox for main, like mcp__flow__ask but without a toast. Filing again replaces your earlier filing.',
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Your agent name' },
      summary: { type: 'string', description: 'One line: what you will do' },
      workers: { type: 'number', description: 'Estimate of how many workers you will start' },
      criteria: { type: 'array', items: { type: 'string' }, description: 'Acceptance criteria, at least one' },
      shipped: {
        type: 'array', description: 'Work already shipped, duplicated or already running; empty when none',
        items: { type: 'object', properties: { what: { type: 'string' }, ref: { type: 'string', description: 'PR, commit or branch' } }, required: ['what', 'ref'] },
      },
      depends: {
        type: 'array', description: 'Other tasks or managers this one depends on; empty when none',
        items: { type: 'object', properties: { on: { type: 'string' }, why: { type: 'string' } }, required: ['on', 'why'] },
      },
      questions: {
        type: 'array', description: 'Optional, same shape as mcp__flow__ask',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            options: { type: 'array', items: { type: 'string' }, description: 'The choices, at least two' },
            default: { type: 'string', description: 'The option you recommend (its text or its 1-based number)' },
            blocking: { type: 'boolean', description: 'true when you cannot start without the answer' },
            context: { type: 'string' },
            topic: { type: 'string' },
          },
          required: ['question', 'options', 'default', 'blocking'],
        },
      },
    },
    required: ['from', 'summary', 'criteria', 'shipped', 'depends'],
  },
  isDeferred: false,
}

export const ANSWER_TOOL: ToolSpec = {
  name: 'answer',
  description: 'Answer questions addressed to you in the decision inbox: a manager answers its workers\' asks, main answers the managers\'. ' +
    'Decisions (mcp__flow__fyi, ids d1, d2, ...) are answered the same way: the choice Keep, or defaults: true, keeps them; any other choice or free text undoes the decision and messages the owner. Main may answer any decision. An old q-id of a decision still works. ' +
    'answers: [{id, choice}] (choice is an option\'s letter, number or text, or free text). defaults: true takes every default of your open questions, or only those in ids.',
  inputSchema: {
    type: 'object',
    properties: {
      answers: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' }, choice: { type: 'string' },
            always: { type: 'boolean', description: 'Main only: also make this answer a standing rule, so the same kind of question is answered at once from now on' },
          },
          required: ['id', 'choice'],
        },
      },
      defaults: { type: 'boolean', description: 'Answer with the defaults' },
      ids: { type: 'array', items: { type: 'string' }, description: 'With defaults: only these question ids' },
    },
  },
  isDeferred: false,
}

export const STANDING_TOOL: ToolSpec = {
  name: 'standing',
  description: 'Main only. Standing answers: rules that answer a recurring decision-inbox question at once. action "list": the rules (id, file, match, answer, how often used) and suggestions ' +
    '(questions you answered the same way 3 or more times). "add": topic or match (a case-insensitive regex on the question text), answer, optional blocking (default false: blocking questions are left to you) and from (asker name). ' +
    '"remove": id. Rules without an id are named by file and position: personal:1, repo:2. ' +
    'Instead of an answer, escalate: true makes matching questions blocking and the user\'s alone; answer "default" takes the question\'s own default (non-blocking only). ' +
    '"list" with no rules also offers a few suggested starting rules (not applied); accept with "add" and seed (an id) or seeds (ids).',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'add', 'remove'] },
      topic: { type: 'string' },
      match: { type: 'string' },
      answer: { type: 'string', description: 'An option of the question: its text, letter or number' },
      blocking: { type: 'boolean' },
      escalate: { type: 'boolean', description: 'Instead of an answer: matching questions are never auto-answered, are blocking and only you answer them' },
      from: { type: 'string' },
      id: { type: 'string' },
      seed: { type: 'string', description: `With add: a suggested starting rule by id (${seedIds().join(', ')})` },
      seeds: { type: 'array', items: { type: 'string' }, description: 'With add: several suggested starting rules by id' },
    },
    required: ['action'],
  },
  isDeferred: true,
}

export const CHECK_TOOL: ToolSpec = {
  name: 'check',
  description: 'Main only (the reviewer may close checks that carry a verify command). Person checks: the after-deploy checks that need a person, kept across restarts. ' +
    'action "list": the open checks grouped by the plugin version they need, and the open follow-ups. "pass": id or ids. "fail": id and a note (required); it creates a follow-up for you to start a manager on. ' +
    '"skip": id or ids and a note (required): the check no longer applies (superseded, cannot be run); no follow-up, main only. ' +
    '"started": id of a failed check and manager (the follow-up has a manager now).',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'pass', 'fail', 'skip', 'started'] },
      id: { type: 'string' },
      ids: { type: 'array', items: { type: 'string' } },
      note: { type: 'string', description: 'fail: what went wrong (required). skip: why (required). pass: optional one-line output tail.' },
      manager: { type: 'string', description: 'started: the manager that took the follow-up' },
    },
    required: ['action'],
  },
  isDeferred: false,
}

export const NOTE_TOOL: ToolSpec = {
  name: 'note',
  description: 'A manager\'s notes on disk, kept across restarts. With text, appends a dated line (kind "decision" for what the user decided, else "progress"). ' +
    'Without text, returns the notes.',
  inputSchema: {
    type: 'object',
    properties: {
      manager: { type: 'string', description: 'Your agent name' },
      text: { type: 'string', description: 'The line to add; leave out to read the notes' },
      kind: { type: 'string', enum: ['decision', 'progress'] },
    },
    required: ['manager'],
  },
  isDeferred: false,
}

// 'queue' is the tool's old name: prompts of a reviewer started by an older version still call it.
export const reviewerTool = (name: string): ToolSpec => ({
  name,
  description: (name === 'queue' ? '(The old name of the reviewer tool; use reviewer.) ' : '') + 'The reviewer\'s worklist. action "list": pending and taken handovers in arrival order. ' +
    '"take" (pr), "done" (pr, sha, report) or "back" (pr, reason) record what the reviewer did. ' +
    '"done" also deletes the PR\'s merged branch on the remote (the plugin does it, after confirming the merge is in origin/<base>) and appends "| flaky: <test>" to the report for tests that failed then passed under test_slot. ' +
    'With push_mode confirm, "ready" (prs, sha, base_sha, check, version?) records the checked batch under refs/flow/push/<id> for the user\'s /flow push instead of pushing it. Only the reviewer calls this.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'take', 'done', 'back', 'ready'] },
      pr: { type: 'number' },
      prs: { type: 'array', items: { type: 'number' }, description: 'ready: the PR numbers of the batch' },
      base_sha: { type: 'string', description: 'ready: the full sha of origin/<base> the batch was built on' },
      check: { type: 'string', description: 'ready: one line, the full check result' },
      version: { type: 'string', description: 'ready: the released version, if the batch was released' },
      sha: { type: 'string' },
      report: { type: 'string' },
      reason: { type: 'string' },
      failed_tests: { type: 'array', items: { type: 'string' }, description: 'back: the exact names of the failing tests (and their files or commands); they go into the logged reason as "| failed: …" and main is asked whether workers should run them (guard_tests)' },
    },
    required: ['action'],
  },
  isDeferred: false,
})

export const PUSH_TOOL: ToolSpec = {
  name: 'push',
  description: 'Main only, on the user\'s word: release the batch the reviewer built, checked and saved because push_mode is confirm. ' +
    'action "list": the ready batch. "push": release it (a reviewer pushes it, deploys and marks the PRs done). "send-back" (pr): return one PR of the batch; the rest is rebuilt, re-checked and asked again. ' +
    '"drop": discard the batch and return every PR. Managers, workers and the reviewer are refused. The user can also run /flow push, or answer the push item in /flow inbox.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'push', 'send-back', 'drop'] },
      pr: { type: 'number', description: 'send-back: the PR number' },
    },
    required: ['action'],
  },
  isDeferred: true,
}

export const STATUS_TOOL: ToolSpec = {
  name: 'status',
  description: 'The flow at a glance: managers, workers and reviewer with their status and last report, and handed-over PRs. ' +
    'Scoped by caller: a manager sees its own subtree and PRs, a worker itself and its manager, main and the reviewer everything. ' +
    'Only the newest 5 finished PRs are listed. With pr, that PR in full: its handover line, owner and log lines.',
  inputSchema: { type: 'object', properties: { pr: { type: 'number', description: 'A PR number, to see who owns it' } } },
  isDeferred: false,
}

export const DEPLOY_TOOL: ToolSpec = {
  name: 'deploy',
  description: 'Per-target deploy gates. The reviewer calls action "gate" (target, sha) before each deploy target and gets exactly one of "Go", "Held: <why>" or "Awaits approval: <qid>"; on the last two it skips that target for this batch and goes on. ' +
    'A confirm target opens one inbox item for the user; only the user\'s "deploy" answer lets that sha through. The reviewer calls "deployed" (target, sha, ok) after each target. ' +
    'Main only, on the user\'s word: "hold" (target, until "batch" or "released", reason?) and "release" (target; it also drops env changes the user declined); "demo only, hold production" is a hold on production. "list" shows every target with mode, hold, last deployed sha, how far behind, any approval and pending env changes. ' +
    'Env changes a handed-over PR declared come first in the gate: "Awaits env: <qids>" (the user has not answered; skip the target), "Held: env change NAME declined" (skip it until main releases it), or "Go, first apply env:" with one exact command per change: run each (a non-zero exit fails the target), call "env-applied" (target, names), then deploy.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['gate', 'deployed', 'env-applied', 'hold', 'release', 'list'] },
      names: { type: 'array', items: { type: 'string' }, description: 'env-applied: the env variable names whose commands you ran' },
      target: { type: 'string', description: 'A deploy target name from the deploy_targets setting' },
      sha: { type: 'string', description: 'gate, deployed: the short sha the batch deploys' },
      ok: { type: 'boolean', description: 'deployed: true when every step of the target passed' },
      until: { type: 'string', enum: ['batch', 'released'], description: 'hold: just the next batch, or until released' },
      reason: { type: 'string', description: 'hold: why' },
    },
    required: ['action'],
  },
  isDeferred: false,
}

export const CLEAN_TOOL: ToolSpec = {
  name: 'clean',
  description: 'Leftover worktrees under .claude/worktrees/ and local branches of finished work. Without apply, a dry run: what would be removed and what is kept and why. ' +
    'With apply true, removes only clean work that is on the base or in a merged PR (or pushed with its PR closed); uncommitted, unpushed, locked and live work is never touched.',
  inputSchema: { type: 'object', properties: { apply: { type: 'boolean', description: 'Remove the safe candidates (default false: dry run)' } } },
  isDeferred: false,
}

export const MIGRATIONS_TOOL: ToolSpec = {
  name: 'migrations',
  description: 'Read-only. Reports migration-number clashes and the next free number, for the migrations_dir setting. ' +
    'Shows the highest number on the base and at ref, and for each PR the migrations it adds: ok, clash (same number as another migration on the base, at ref or in an earlier PR of the list) or at-or-below (not above the base\'s highest). ' +
    'For each non-ok one: the next free number (highest + 1, no gap filling), the git mv to run, and where the PR\'s own files mention the old number. Fetches only; changes nothing.',
  inputSchema: {
    type: 'object',
    properties: {
      prs: { type: 'array', items: { type: 'number' }, description: 'PR numbers in merge order (optional)' },
      ref: { type: 'string', description: 'The batch being built in your cwd (default HEAD)' },
    },
  },
  isDeferred: false,
}

export const PLAN_TOOL: ToolSpec = {
  name: 'plan',
  description: 'Declare which packages (or, for main, tasks) wait for others, so the plugin can refuse to start them early and tell you when they are ready. ' +
    'action "add": nodes [{id, title, after?, until?}]; id is the agent name you will start (or its prefix before -N), after lists node ids, until is "merged" (default: the PR is merged) or "reported" (the agent reported back). ' +
    '"list": your graph (main may pass owner). "done" (id, note?) / "block" (id, reason): set a node by hand. "remove" (id): drop a waiting or ready node nothing depends on.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'list', 'done', 'block', 'remove'] },
      nodes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            after: { type: 'array', items: { type: 'string' } },
            until: { type: 'string', enum: ['merged', 'reported'] },
          },
          required: ['id'],
        },
      },
      id: { type: 'string' },
      note: { type: 'string' },
      reason: { type: 'string' },
      owner: { type: 'string', description: 'main only: whose graph to list' },
    },
    required: ['action'],
  },
  isDeferred: false,
}

export const TEST_SLOT_TOOL: ToolSpec = {
  name: 'test_slot',
  description: 'A lock on heavy test runs, so only test_slots of them run at once across all worktrees of this session. ' +
    'action "acquire" before a whole suite or any run over about a minute (waits a few seconds; if it says queued, wait as the answer tells you (grant file or grant message), then call acquire once to confirm), ' +
    '"release" when the run is over or failed (with result "pass" or "fail" and, on fail, failed_tests: the exact names of the failing tests from the output; a pass after a fail with the same label is reported as flaky), "status" to see holders and waiters.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['acquire', 'release', 'status'] },
      label: { type: 'string', description: 'What you will run, e.g. "full suite"' },
      result: { type: 'string', enum: ['pass', 'fail'], description: 'release: how the run ended' },
      failed_tests: { type: 'array', items: { type: 'string' }, description: 'release with result fail: the exact names of the failing tests' },
      wait_s: { type: 'number', description: `Seconds to wait for a slot before answering queued (default ${WAIT_DEFAULT_S}, at most ${WAIT_MAX_S})` },
    },
    required: ['action'],
  },
  isDeferred: false,
}

export const GUARD_TESTS_TOOL: ToolSpec = {
  name: 'guard_tests',
  description: 'The repo-wide tests the guard_tests setting requires for your diff. Call it before gh pr create with no arguments: it works out your changed files itself ' +
    '(origin/<base>...HEAD plus uncommitted and untracked changes in your worktree). Run each test it lists under mcp__flow__test_slot and list each under `Ran:` in the PR\'s ## Verification section; handover refuses otherwise.',
  inputSchema: {
    type: 'object',
    properties: { files: { type: 'array', items: { type: 'string' }, description: 'Optional: use these repo-relative paths instead of your diff' } },
  },
  isDeferred: false,
}

export const SESSION_TOOL: ToolSpec = {
  name: 'session',
  description: 'Workers outside this session: another harness (codex, gemini, opencode, claude, or your own command line) in an Orca terminal or a tmux session the user can watch. ' +
    'action "start" (name, brief, harness, host?, command?) makes a worktree on flow/<name> from the base and starts the harness with the worker rules and the brief; its report comes back to you as a "flow session:" message. ' +
    'The same controls work for every harness: "send" (name, text) types a message and submits it, "keys" (name, keys) presses keys ("1", "y enter", "escape", "interrupt", "down enter"), ' +
    '"read" (name, lines?) shows the end of its terminal, "restart" (name) starts it again in its worktree (resuming its conversation where the harness can), "list" all sessions, "stop" (name, remove_worktree?) closes it. ' +
    'A harness that goes quiet without a report is told to you as idle.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['start', 'send', 'keys', 'read', 'restart', 'list', 'stop'] },
      name: { type: 'string', description: 'The worker name, as for an agent worker: <your name>-<package-slug>' },
      brief: { type: 'string', description: 'start: the whole brief, its first line "Your name: <name>"' },
      harness: { type: 'string', description: 'start: claude, codex, gemini, opencode, a name from the harnesses setting, or "command". Default: the worker_harness setting' },
      command: { type: 'string', description: 'start with harness "command": the command line; {prompt} is the prompt as one shell word, {prompt_file} its path' },
      host: { type: 'string', enum: ['orca', 'tmux'], description: 'start: where it runs. Default: the session_host setting (Orca when it runs, else tmux)' },
      text: { type: 'string', description: 'send: what to type into its terminal' },
      keys: { type: 'string', description: 'keys: space-separated; enter, escape, interrupt (Ctrl-C), tab, up, down, left, right, backspace, space by name, any other word typed as it is' },
      lines: { type: 'number', description: 'read: how many lines from the end (default 80)' },
      remove_worktree: { type: 'boolean', description: 'stop: also remove the worktree, only if it is clean and pushed' },
    },
    required: ['action'],
  },
  isDeferred: false,
}
