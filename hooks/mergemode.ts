// Merge mode: whether the queue merges an approved PR directly (auto) or waits for the user's
// /flow approve (confirm). Pure rules, so the handover and queue handlers stay thin.

export type MergeMode = 'auto' | 'confirm'

export const CONFIRM_LABEL = 'flow:confirm'
export const AUTO_LABEL = 'flow:auto'

// Unknown values fall back to auto, the behaviour before the setting existed.
export const parseMode = (v: unknown): MergeMode => v === 'confirm' ? 'confirm' : 'auto'

// The PR's own label wins; both labels means the safer one.
export function labelMode(labels: string[]): MergeMode | undefined {
  if (labels.includes(CONFIRM_LABEL)) return 'confirm'
  if (labels.includes(AUTO_LABEL)) return 'auto'
  return undefined
}

// Label > the mode stored on the handover > the setting.
export const effectiveMode = (labels: string[], stored: MergeMode | undefined, setting: MergeMode): MergeMode =>
  labelMode(labels) ?? stored ?? setting

// A manager may only make a PR safer; lowering a confirm setting is the user's call.
export const autoRefused = (requested: MergeMode | undefined, setting: MergeMode): boolean =>
  requested === 'auto' && setting === 'confirm'

// What `take` does: hold a confirm PR until the user approved exactly this head.
export const takeDecision = (a: { labels: string[]; stored?: MergeMode; setting: MergeMode; head: string; approvedHead?: string }): 'take' | 'hold' =>
  effectiveMode(a.labels, a.stored, a.setting) === 'confirm' && a.approvedHead !== a.head ? 'hold' : 'take'

export const labelSpec = (mode: MergeMode): { name: string; color: string; description: string } =>
  mode === 'confirm'
    ? { name: CONFIRM_LABEL, color: 'D93F0B', description: 'flow: the merge queue waits for the user to approve this PR (/flow approve)' }
    : { name: AUTO_LABEL, color: '0E8A16', description: 'flow: the merge queue may merge this PR without asking' }
