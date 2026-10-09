import type { LogEvent } from '../types'

// The pure half of flow's state on disk (<git-common-dir>/flow/). The helpers that touch the disk
// live in register.tsx: the engine follows `$` only into functions declared in the same file.
// `config.json` in the state dir belongs to the settings package: never touched here.

// "csv-export-2" and "csv-export" share one manager's notes.
export const noteKey = (name: string): string => name.replace(/-\d+$/, '').replace(/[^\w.-]/g, '_') || 'manager'

// Who owns a PR or branch: the latest handover or spawn event that names it.
export function ownerFor(events: LogEvent[], match: { pr?: number; branch?: string }): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e === undefined || (e.event !== 'handover' && e.event !== 'spawn')) continue
    if ((match.pr !== undefined && e.pr === match.pr) || (match.branch !== undefined && e.branch === match.branch)) return e.owner
  }
  return undefined
}
