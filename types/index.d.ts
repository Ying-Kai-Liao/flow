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
  usage?: { tokens: number; model: string }
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
  status: 'pending' | 'taken' | 'done' | 'returned'
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

declare module 'claude-code' {
  interface PluginState {
    'flow': {
      roster: AgentRow[]
      activity: Record<string, Activity>
      selected: string | null
      now: number
      handovers: Record<string, Handover>
      queueRuns: number
      prCache: PrCache
      // Per owner ("main" or a manager's name), the plan's nodes by id.
      plan: Record<string, Record<string, DagNode>>
    }
  }
}
