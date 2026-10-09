// Where a harness logs what it does: Codex's rollout files, or a Claude Code transcript.
export type DigestKind = 'codex-rollout' | 'claude-transcript'

// What a worker in another harness last did, read from the harness's own log.
export type Digest = {
  // The last three tool calls, oldest first: "exec: npm test", "Edit: src/app.ts".
  actions: string[]
  lastWords?: string
  // When the log last moved, and when its last turn ended (only while no newer turn started).
  at?: number
  turnDone?: number
  tokens?: number
  window?: number
}

// One quota window as the pane draws it: how much is used, when it resets, how long it is.
export type Limit = { tool: string; label: string; used: number; resetsAt?: number; windowMs?: number }

// One agent of this session as the board shows it: the roster row from
// $.agent.list(), plus what the mod saw it do.
export type AgentRow = {
  id: string
  name?: string
  description: string
  type: string
  status: string
  parentId?: string
}

export type Activity = {
  startedAt: number
  lastAt: number
  // The newest last, at most LOG_MAX lines: "Edit src/app.ts", "Bash npm test".
  log: string[]
  // The newest call in a few plain words for the card: "running tests", "editing app.ts".
  doing?: string
  // The last turn's final text: a worker's report, or the question it ended on.
  answer?: string
  // The latest turn.step's context fill; absent until the agent has taken one.
  // The window the agent was started with, from its model; absent when unknown or before this was recorded.
  spawnWindow?: number
  usage?: { tokens: number; model: string; window?: number }
  // When the roster first saw the agent ended; its running time stops there.
  endedAt?: number
  // When the plugin told this agent to hand off; once per agent.
  handoffNotifiedAt?: number
  // The context percent when it was told, and how many wrap-up reminders rode on its tool results since.
  handoffPercent?: number
  remindersSent?: number
  // Reminder bookkeeping: tool calls since the threshold, and the percent at the last reminder.
  callsPastLimit?: number
  remindedPercent?: number
}

// A PR a manager handed to the merge queue (the handover tool), and what the queue did with it.
export type Handover = {
  pr: number
  title: string
  head: string
  branch: string
  reportTo: string
  verified: string
  pending: string
  afterDeploy: string
  // A command the merge queue runs to close a needs-a-person check itself.
  verifyCommand?: string
  // Parsed from the PR's ## Verification section at handover; absent in handovers saved before it existed.
  evidence?: { ran: string[]; exercised: string; notVerified: string[] }
  status: 'pending' | 'awaiting' | 'taken' | 'done' | 'returned'
  // Set by the handover tool; the PR's flow:* label and the merge_mode setting are checked too.
  mode?: 'auto' | 'confirm'
  // The head the user approved with /flow approve; the queue merges a confirm PR only at this head.
  approvedHead?: string
  // How far the release at merge bumps for this PR; absent (old handovers) means patch.
  release?: 'patch' | 'minor' | 'major'
  at: number
  sha?: string
  report?: string
  reason?: string
}

// An open PR as `gh pr list` returns it.
export type OpenPr = {
  number: number
  title: string
  headRefName: string
  isDraft: boolean
  url: string
  updatedAt?: string
}

// The last gh listing of open flow/* PRs; `error` is the last failure, the list stays.
export type PrCache = { prs: OpenPr[]; fetchedAt: number; error?: string }

// The last dry cleanup sweep: what it would remove, and how many it keeps for a person.
export type Leftovers = { worktrees: number; branches: number; needsLook: number }

// One node of an owner's plan: a task (owner "main") or a package (owner is a manager).
export type DagState = 'waiting' | 'ready' | 'running' | 'done' | 'blocked'

export type DagNode = {
  id: string
  title: string
  // Ids of the nodes that must be done before this one starts.
  after: string[]
  // What "done" means for a dependency: its PR merged (default), or the agent reported back.
  until: 'merged' | 'reported'
  state: DagState
  // Why the node is in its state: "merged abc123", "PR returned: reason".
  info?: string
  // Set by the owner by hand; wins over what the plugin sees.
  manual?: 'done' | 'blocked'
  // The owner was already told this node is ready / blocked.
  readyNotified?: boolean
  blockedNotified?: boolean
}
// A holder of, or a waiter for, a test slot (the test_slot tool). key is the agent id, or "main".
export type SlotEntry = { key: string; name: string; label: string; since: number; claimed?: boolean }
// claimed is false for a holder granted the slot from the line who has not yet confirmed with acquire.

export type TestSlots = { holders: SlotEntry[]; waiters: SlotEntry[] }

// One line of the state dir's log.jsonl. `handoff` and `continue` are defined for a later package.
// Where a worker stood when it handed off; the successor reads it.
export type HandoffRecord = {
  branch: string
  agent: string
  agentId: string
  owner: string
  at: number
  digestPath?: string
  worktree?: string
  head?: string
  // Handoffs of this branch so far, this one included.
  count: number
  // The successor that was given this worktree; a second spawn for the branch does not get it.
  takenBy?: string
}

// A worker running outside this session: another harness in an Orca terminal or a tmux session
// (the session tool). It reports by writing `report`; the plugin sends that to its owner.
export type Session = {
  name: string
  harness: string
  host: 'orca' | 'tmux'
  // The tmux session name, or the Orca terminal handle.
  handle: string
  worktree: string
  branch: string
  // The prompt the harness started with and the file it reports into, outside any worktree.
  promptFile: string
  reportFile: string
  // The harness's command line that continues its last conversation, for "restart"; else the start line again.
  resume?: string
  start: string
  // The manager that started it: its agent id ("main" for the main session) and name.
  owner: string
  ownerName: string
  // idle: its screen stopped changing with no new report, so it may be asking something.
  status: 'running' | 'reported' | 'idle' | 'exited' | 'stopped'
  startedAt: number
  // The report file's mtime when it was last delivered.
  reportAt?: number
  // When the terminal was last seen alive.
  checkedAt?: number
  // The screen's fingerprint, when it last changed, and when it was last looked at.
  screen?: string
  screenAt?: number
  lookedAt?: number
  // The last screen itself (its last lines), for the pane.
  screenText?: string
  // The quiet spell already told to the manager as idle: "turn:<ended at>" or "quiet:<since>".
  idleKey?: string
  // Where the harness logs what it does, the file found for this session, and what it said.
  digestKind?: DigestKind
  digestFile?: string
  digestSeen?: number
  digest?: Digest
}

export type LogEvent = {
  ts: string
  event: 'spawn' | 'report' | 'handover' | 'take' | 'done' | 'back' | 'approve' | 'hold' | 'handoff' | 'continue' | 'note' | 'clean' | 'auto-answer' | 'fyi'
  // The manager that owns the work, or "main".
  owner: string
  agent?: string
  pr?: number
  branch?: string
  text?: string
}

export type Question = {
  id: string
  // Absent: a question. 'fyi': a decision the agent took itself (question = the decision, context = why); non-blocking, overturnable.
  kind?: 'question' | 'fyi'
  // The asking agent's name, and who answers: a worker's manager, or "main" for a manager.
  owner: string
  addressee: string
  question: string
  options: string[]
  default: string
  blocking: boolean
  context?: string
  topic?: string
  // What kind of item: absent is an ordinary question. "deploy" asks the user to approve one deploy
  // target at one sha; standing answers never answer it, and no agent waits for the reply.
  kind?: 'deploy'
  askedAt: number
  state: 'open' | 'answered'
  answer?: string
  answeredBy?: string
  answeredAt?: number
  // The answer reached the asker (or needed no message).
  delivered: boolean
  // The asker's agent id, to message it.
  askerId?: string
  // The asker is a manager: its notes get the progress and decision lines, else its manager's.
  askerIsManager?: boolean
  // The standing answer rule that answered it (answeredBy is then "standing answer").
  rule?: string
  // A guard_tests suggestion (guardtests.ts): answering "Add it" writes this mapping to the personal config.
  guard?: { glob: string; test: string }
  // An escalate standing rule holds it for the user: it is blocking and only main may answer it.
  escalated?: string
}

export type Inbox = { next: number; items: Question[] }

// A person check: see hooks/checks.ts.
export type FollowUp = { state: 'open' | 'started'; manager?: string }

export type Check = {
  id: string
  kind: 'check'
  pr: number
  title: string
  steps: string
  // The plugin version that must be installed to do the check.
  version?: string
  sha?: string
  // A command the merge queue runs instead of the user (from the handover's verify_command).
  verifyCommand?: string
  createdAt: number
  state: 'open' | 'passed' | 'failed'
  closedAt?: number
  closedBy?: string
  // Required for a failed check; on an open check, why scripted verification was skipped.
  note?: string
  // Only a failed check has one: work for main to start a manager on.
  followUp?: FollowUp
}

export type Checks = {
  next: number
  items: Check[]
  // The installed version main was last prompted for after an update.
  promptedVersion?: string
}

// Deploy gates (hooks/deploy.ts), kept in <state dir>/deploys.json.
export type DeployMode = 'auto' | 'confirm'
export type Hold = { until: 'batch' | 'released'; by: string; at: number; reason?: string }
// The inbox item that asks for a deploy, and the one sha it approves.
export type Approval = { qid: string; sha: string; state: 'pending' | 'approved'; at: number }
export type TargetState = {
  deployedSha?: string
  deployedAt?: number
  hold?: Hold
  approval?: Approval
  // A deploy-only run has work here: set by an approved deploy, or by releasing a hold on an auto
  // target; cleared when the target is deployed.
  due?: boolean
}
export type Deploys = { targets: Record<string, TargetState> }

export type Filing = {
  summary: string
  workers?: number
  criteria: string[]
  shipped: Array<{ what: string; ref: string }>
  depends: Array<{ on: string; why: string }>
}

export type Entry = {
  // The manager's latest agent name (a successor is `<name>-2`); the entry is keyed by noteKey.
  name: string
  phase: 'recon' | 'filed' | 'skipped'
  // The round it was spawned into (0: none, e.g. it filed without having been recorded at spawn).
  round: number
  spawnedAt: number
  filedAt?: number
  filing?: Filing
  // Ids of the blocking questions of the filing: it is released when none of them is open.
  blocking: string[]
  // Ids of all the questions of the filing.
  asked: string[]
}

export type Round = {
  id: number
  openedAt: number
  members: string[]
  delivered: boolean
  deliveredAt?: number
  // The members the delivered message covered; a later filing is sent on its own.
  reported: string[]
}

export type Preflight = { next: number; entries: Record<string, Entry>; rounds: Round[] }

declare module 'claude-code' {
  interface PluginState {
    'flow': {
      roster: AgentRow[]
      activity: Record<string, Activity>
      selected: string | null
      cursor: string | null
      folded: Record<string, boolean>
      now: number
      handovers: Record<string, Handover>
      // The last status and answer seen per agent name (the plan's AgentFact in hooks/dag.ts).
      'seen-agents': Record<string, { name?: string; status: string; answer?: string; children?: number; at?: number; childAt?: number }>
      // The decision inbox, mirrored from <state dir>/inbox.json.
      inbox: Inbox
      // Person checks, mirrored from <state dir>/checks.json.
      checks: Checks
      queueRuns: number
      prCache: PrCache
      // Deploy gates, mirrored from <state dir>/deploys.json, and how many commits each target is behind the base.
      deploys: Deploys
      behind: Record<string, number>
      // Per owner ("main" or a manager's name), the plan's nodes by id.
      plan: Record<string, Record<string, DagNode>>
      testSlots: TestSlots
      viewMode: 'tree' | 'graph'
      graphFocus: string | null
      overrideView: string | null | undefined
      hinted: boolean
      handoffs: Record<string, HandoffRecord>
      preflight: Preflight
      leftovers: Leftovers
      sessions: Record<string, Session>
      // Quota windows of the harnesses flow can read (Codex's own logs), for the pane.
      harnessLimits: Limit[]
      // A control pressed once that needs a second press: "<session>:<action>", and when.
      armed: { key: string; at: number } | null
    }
  }
}
