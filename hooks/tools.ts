// MCP tool specs (name, description, input schema, deferred flag) for the tools flow registers in session.start.
// Pure data: the `$.tool.register(...)` calls stay in register.tsx because the engine refuses `$` across an import.
import type { ToolSpec } from 'claude-code'
import { WAIT_DEFAULT_S, WAIT_MAX_S } from './slots'
import { seedIds } from './standing'

export const HANDOVER_TOOL: ToolSpec = {
  name: 'handover',
  description: 'Hand an approved PR to the flow reviewer (records it at its current head, starts a reviewer if none runs). Managers call this after reviewing a worker\'s PR; leave the branch alone afterwards. ' +
    'Refused unless the PR description has a ## Verification section (Ran, Exercised, Not verified); the refusal shows the format.',
  inputSchema: {
    type: 'object',
    properties: {
      pr: { type: 'number', description: 'The PR number' },
      verified: { type: 'string', description: 'Optional: one-line summary of your review' },
      pending: { type: 'string', description: '"none", or decisions the user still has to make' },
      after_deploy: { type: 'string', description: '"none", or what to check after deploy (an agent checks what it can; the rest is reported as "needs a person")' },
      verify_command: { type: 'string', description: 'Optional: shell command that verifies the change after deploy; for a check that needs a person, the reviewer runs it at merged main and closes the check (pass on exit 0)' },
      report_to: { type: 'string', description: 'Optional: your own agent name (default); an unknown name is refused' },
      release: { type: 'string', enum: ['patch', 'minor', 'major'], description: 'Version bump at merge (release setting on only): omit for patch, "minor" for a user-visible feature, "major" only when the task asks. The batch gets the highest.' },
      env: {
        type: 'array',
        description: 'Optional: env or secret changes the PR needs on a deploy target; each goes to the user\'s inbox and the target does not deploy until answered. Never put a secret value anywhere, in this field or in the PR text.',
        items: {
          type: 'object',
          properties: {
            target: { type: 'string', description: 'A deploy target name from the deploy_targets setting' },
            name: { type: 'string', description: 'The env variable name' },
            value: { type: 'string', description: 'New value of a non-secret change. Not together with secret.' },
            secret: { type: 'boolean', description: 'true: the user sets it themselves. Not together with value.' },
            why: { type: 'string', description: 'Why the change is needed' },
            login: { type: 'string', description: 'Optional: a step the user must do first, e.g. log in to the cloud CLI' },
          },
          required: ['target', 'name', 'why'],
        },
      },
      mode: { type: 'string', enum: ['auto', 'confirm'], description: '"confirm" for a risky PR: waits for the user\'s /flow approve before merge. "auto": safe to merge directly; refused when merge_mode is confirm. Omit to use the setting.' },
    },
    required: ['pr'],
  },
  isDeferred: false,
}

export const RELEASE_TOOL: ToolSpec = {
  name: 'release',
  description: 'Release at merge (release setting on). The reviewer calls it once per batch, after the full check and before the push: moves the changelog\'s ## [Unreleased] lines into a new version section, bumps the version (patch, or the highest of the PRs\' handover release field and flow:minor / flow:major labels) and returns the commit command; it does not commit or push. A second call for the same PRs is refused. Action "publish" (release_github on, after the release commit is pushed) tags v<version>, pushes the tag and creates the GitHub Release; failures come back as a "Not published" line.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['cut', 'publish'], description: '"cut" (default) or "publish" (for the release commit at HEAD of dir)' },
      dir: { type: 'string', description: 'The reviewer\'s worktree, absolute' },
      prs: { type: 'array', items: { type: 'number' }, description: 'cut: the PR numbers merged in this batch' },
      version: { type: 'string', description: 'publish: the version to publish; default the version of the last cut' },
      recut: { type: 'boolean', description: 'cut: true to cut the same PRs again after the base moved (push_mode confirm)' },
    },
    required: ['dir'],
  },
  isDeferred: false,
}

export const ASK_TOOL: ToolSpec = {
  name: 'ask',
  description: 'Ask structured questions (a batch) instead of asking in prose. A worker\'s go to its manager, a manager\'s to main; main cannot ask. ' +
    'Give options and your recommended default. Non-blocking: go ahead on the default and say in your report that you assumed it; you get a message if the answer differs. ' +
    'Blocking: end your turn and wait; you are woken with the answer. A manager escalating a worker\'s open question sets `for` to its id, and main\'s answer reaches both. ' +
    'Give a recurring kind of question a stable kebab-case topic: the user can answer a topic once as a standing answer.',
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
            default: { type: 'string', description: 'Your recommended option (text or 1-based number)' },
            blocking: { type: 'boolean', description: 'true if you cannot go on without the answer' },
            context: { type: 'string', description: 'What the answerer needs to know' },
            topic: { type: 'string', description: 'Short stable kebab-case label for a recurring kind (e.g. version-bump, test-approach), the same every time' },
            for: { type: 'string', description: 'Managers only: id of a worker\'s open question (e.g. q12) this escalates to main' },
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
  description: 'Record a reversible choice you took yourself (a threshold, wording, a name, a default, styling within the existing design) as a non-blocking decision (ids d1, d2, ...) the user can keep or undo. ' +
    'A worker\'s go to its manager, a manager\'s to main. Never stop for it; you get a message only if it is undone, then change your work. ' +
    'Irreversible or product-defining choices (what customers pay for, who receives data, deleting data) are asks. Main cannot call it.',
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
  description: 'Managers only. File your pre-flight after looking over your task (code, history, open PRs; no workers yet). Worker starts are refused until you have, and, with blocking questions, until they are answered. ' +
    'Questions go to main\'s decision inbox like mcp__flow__ask. Filing again replaces the earlier filing.',
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
            default: { type: 'string', description: 'Your recommended option (text or 1-based number)' },
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
  description: 'Answer questions addressed to you in the decision inbox: a manager answers its workers\', main the managers\'. ' +
    'Decisions (mcp__flow__fyi, ids d1, ...) work the same way: choice Keep, or defaults: true, keeps them; any other choice or free text undoes the decision and messages the owner. Main may answer any decision. ' +
    'answers: [{id, choice}] (an option\'s letter, number or text, or free text). defaults: true takes every default of your open questions, or only those in ids.',
  inputSchema: {
    type: 'object',
    properties: {
      answers: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' }, choice: { type: 'string' },
            always: { type: 'boolean', description: 'Main only: also make this a standing rule' },
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
  description: 'Main only. Standing answers: rules that answer a recurring decision-inbox question at once. "list": the rules (id, file, match, answer, use count) and suggestions (questions you answered the same way 3+ times); with no rules it also offers starting rules, accepted with "add" and seed/seeds. ' +
    '"add": topic or match (case-insensitive regex on the question text), answer, optional blocking (default false: blocking questions are left to you) and from (asker name). "remove": id (rules without an id are named by file and position: personal:1, repo:2). ' +
    'Instead of an answer, escalate: true makes matching questions blocking and yours alone; answer "default" takes the question\'s own default (non-blocking only).',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'add', 'remove'] },
      topic: { type: 'string' },
      match: { type: 'string' },
      answer: { type: 'string', description: 'An option of the question: its text, letter or number' },
      blocking: { type: 'boolean' },
      escalate: { type: 'boolean', description: 'Instead of an answer: matching questions are blocking and never auto-answered' },
      from: { type: 'string' },
      id: { type: 'string' },
      seed: { type: 'string', description: `With add: a starting rule by id (${seedIds().join(', ')})` },
      seeds: { type: 'array', items: { type: 'string' }, description: 'With add: several starting rules by id' },
    },
    required: ['action'],
  },
  isDeferred: true,
}

export const CHECK_TOOL: ToolSpec = {
  name: 'check',
  description: 'Main only (the reviewer may close checks that carry a verify command). After-deploy checks that need a person, kept across restarts. ' +
    '"list": open checks grouped by plugin version, and open follow-ups. "pass": id or ids. "fail": id and note (required); creates a follow-up for you to start a manager on. ' +
    '"skip": id or ids and note (required) when the check no longer applies; no follow-up. "started": id of a failed check and manager.',
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
  isDeferred: true,
}

export const NOTE_TOOL: ToolSpec = {
  name: 'note',
  description: 'A manager\'s notes on disk, kept across restarts. With text, appends a dated line (kind "decision" for what the user decided, else "progress"); without text, returns the notes.',
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
export const reviewerTool = (name: string, isDeferred = false): ToolSpec => ({
  name,
  description: (name === 'queue' ? '(Old name of reviewer; use reviewer.) ' : '') + 'The reviewer\'s worklist; only the reviewer calls it. "list": pending and taken handovers in arrival order. ' +
    '"take" (pr), "done" (pr, sha, report) or "back" (pr, reason) record what the reviewer did. ' +
    '"done" also deletes the merged PR branch on the remote (after confirming the merge is in origin/<base>) and appends "| flaky: <test>" for tests that failed then passed under test_slot. ' +
    'With push_mode confirm, "ready" (prs, sha, base_sha, check, version?) saves the checked batch under refs/flow/push/<id> for the user\'s /flow push instead of pushing.',
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
      failed_tests: { type: 'array', items: { type: 'string' }, description: 'back: exact names of the failing tests (and their files or commands); logged as "| failed: …" and main is asked whether workers should run them (guard_tests)' },
    },
    required: ['action'],
  },
  isDeferred,
})

export const PUSH_TOOL: ToolSpec = {
  name: 'push',
  description: 'Main only, on the user\'s word: release the batch the reviewer saved because push_mode is confirm. Managers, workers and the reviewer are refused. ' +
    '"list": the ready batch. "push": release it (a reviewer pushes, deploys and marks the PRs done). "send-back" (pr): return one PR; the rest is rebuilt, re-checked and asked again. "drop": discard the batch and return every PR.',
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
  description: 'The flow at a glance: managers, workers and reviewer with status and last report, and handed-over PRs. ' +
    'Scoped by caller: a manager sees its own subtree and PRs, a worker itself and its manager, main and the reviewer everything. ' +
    'Lists only the newest 5 finished PRs; with pr, that PR in full (handover line, owner, log).',
  inputSchema: { type: 'object', properties: { pr: { type: 'number', description: 'A PR number, to see who owns it' } } },
  isDeferred: false,
}

export const DEPLOY_TOOL: ToolSpec = {
  name: 'deploy',
  description: 'Per-target deploy gates. The reviewer calls "gate" (target, sha) before each deploy target and gets exactly one of "Go", "Held: <why>" or "Awaits approval: <qid>"; on the last two it skips that target for this batch. ' +
    'A confirm target opens one inbox item; only the user\'s "deploy" answer lets that sha through. The reviewer calls "deployed" (target, sha, ok) after each target. ' +
    'Main only, on the user\'s word: "hold" (target, until "batch" or "released", reason?) and "release" (target; also drops env changes the user declined). "list": every target with mode, hold, last deployed sha, how far behind, approval and pending env changes. ' +
    'Env changes declared by a handed-over PR come first in the gate: "Awaits env: <qids>" (skip the target), "Held: env change NAME declined" (skip until main releases it), or "Go, first apply env:" with one exact command per change: run each (non-zero exit fails the target), call "env-applied" (target, names), then deploy.',
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
  description: 'Leftover worktrees under .claude/worktrees/ and local branches of finished work. Without apply: a dry run listing what would be removed and what is kept and why. ' +
    'With apply true: removes only clean work that is on the base or in a merged PR (or pushed with its PR closed); uncommitted, unpushed, locked and live work is never touched.',
  inputSchema: { type: 'object', properties: { apply: { type: 'boolean', description: 'Remove the safe candidates (default false: dry run)' } } },
  isDeferred: false,
}

export const MIGRATIONS_TOOL: ToolSpec = {
  name: 'migrations',
  description: 'Read-only (fetches only). Reports migration-number clashes and the next free number, for the migrations_dir setting: the highest number on the base and at ref, and per PR each migration it adds as ok, clash (same number as one on the base, at ref or in an earlier PR of the list) or at-or-below (not above the base\'s highest). ' +
    'For each non-ok one: the next free number (highest + 1, no gap filling), the git mv to run, and where the PR\'s own files mention the old number.',
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
  description: 'Declare which packages (for main, tasks) wait for others; the plugin refuses early starts and tells you when they are ready. ' +
    '"add": nodes [{id, title, after?, until?}]: id is the agent name you will start (or its prefix before -N), after lists node ids, until is "merged" (default) or "reported" (agent reported back). ' +
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
  description: 'A lock on heavy test runs: only test_slots of them run at once across all worktrees. ' +
    '"acquire" before a whole suite or any run over about a minute (waits a few seconds; if it says queued, wait as the answer tells you (grant file or message), then call acquire once to confirm). ' +
    '"release" when the run ends or fails, with result "pass" or "fail" and on fail failed_tests (exact names from the output; a pass after a fail with the same label is reported as flaky). "status": holders and waiters.',
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
  description: 'The repo-wide tests the guard_tests setting requires for your diff. Call it before gh pr create, normally with no arguments (it finds your changed files: origin/<base>...HEAD plus uncommitted and untracked). ' +
    'Run each listed test under mcp__flow__test_slot and list each under `Ran:` in the PR\'s ## Verification section; handover refuses otherwise.',
  inputSchema: {
    type: 'object',
    properties: { files: { type: 'array', items: { type: 'string' }, description: 'Optional: use these repo-relative paths instead of your diff' } },
  },
  isDeferred: false,
}

export const SESSION_TOOL: ToolSpec = {
  name: 'session',
  description: 'Workers outside this session: another harness (codex, gemini, opencode, claude, or your own command line) in an Orca terminal or tmux session the user can watch. ' +
    '"start" (name, brief, harness, host?, command?) makes a worktree on flow/<name> from the base and starts the harness with the worker rules and the brief; its report comes back as a "flow session:" message, and a quiet harness is reported as idle. ' +
    'Same controls for every harness: "send" (name, text) types and submits, "keys" (name, keys) presses keys ("1", "y enter", "escape", "interrupt", "down enter"), ' +
    '"read" (name, lines?) shows the end of its terminal, "restart" (name) resumes it in its worktree where the harness can, "list", "stop" (name, remove_worktree?).',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['start', 'send', 'keys', 'read', 'restart', 'list', 'stop'] },
      name: { type: 'string', description: 'Worker name: <your name>-<package-slug>' },
      brief: { type: 'string', description: 'start: the whole brief, first line "Your name: <name>"' },
      harness: { type: 'string', description: 'start: claude, codex, gemini, opencode, a harnesses-setting name, or "command" (default: worker_harness setting)' },
      command: { type: 'string', description: 'harness "command": the command line; {prompt} is the prompt as one shell word, {prompt_file} its path' },
      host: { type: 'string', enum: ['orca', 'tmux'], description: 'start: where it runs (default: session_host setting)' },
      text: { type: 'string', description: 'send: what to type into its terminal' },
      keys: { type: 'string', description: 'keys: space-separated; named keys (enter, escape, interrupt, tab, arrows, backspace, space), any other word typed as is' },
      lines: { type: 'number', description: 'read: how many lines from the end (default 80)' },
      remove_worktree: { type: 'boolean', description: 'stop: also remove the worktree, only if it is clean and pushed' },
    },
    required: ['action'],
  },
  isDeferred: false,
}
