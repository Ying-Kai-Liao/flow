// Shared state of the flow plugin: agent-type constants, the settings mirrors and the few helpers every area uses.
import type { TargetInfo } from './deploy'
import { SESSION } from './sessions'

// The flow pane's id, and the agent types the plugin tells apart.
export const PANE = 'flow'
export const POLL_MS = 3000
// The 1M-window Sonnet: workers read whole diffs and long briefs. Refused for sub-agents, it falls back to plain sonnet.
export const DEFAULT_WORKER_MODEL = 'sonnet[1m]'
export const LOG_MAX = 40
export const MANAGER = 'flow:manager'
export const WORKER = 'flow:worker'
// A worker continued in its predecessor's worktree: the plugin rewrites a spawn to it, the model never picks it.
export const CONTINUE = 'flow:continue'
export const WORKERS = new Set([WORKER, CONTINUE, SESSION])
export const REVIEWER = 'flow:reviewer'
// The reviewer's old agent type: a reviewer started by an older version still runs under it.
export const QUEUE = 'flow:queue'
export const isReviewer = (type: string): boolean => type === REVIEWER || type === QUEUE
export const LIVE_STATUS = new Set(['running', 'pending'])

// Settings the plugin reads on every poll, mirrored here by register() whenever the settings load or change.
// One shared object, not importable `let`s: an importer cannot assign to those.
export const mirror = {
  // refresh() and the pane flag nothing when there is no reviewer.
  queueOn: true,
  // The cleanup setting and the base it sweeps against.
  cleanupMode: 'auto' as 'auto' | 'off',
  cleanupBase: 'main',
  // The deploy targets and their modes.
  deployInfos: [] as TargetInfo[],
  // How many managers main runs at once; refresh needs it to tell main how many slots are free.
  maxManagers: 20,
  // The test_slots setting, for refresh()'s status line.
  slotLimit: 1,
  // The decision_phrases setting, for the question check in refresh() and syncPlans().
  decisionPhrases: [] as string[],
  // Pre-flight setting and round wait (ms).
  preflightOn: true,
  preflightWaitMs: 10 * 60_000,
}


export const TEXT_MAX = 300
export const NOTES_MAX = 3000
export const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
