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

type Msg = { role: string; text: string; toolUses?: { tool: string; input: Record<string, unknown>; text?: string; isError?: true }[] }

// The old session's working set, read from its transcript: what it touched and ran, not only what it wrote down.
export function buildDigest(msgs: readonly Msg[], branch: string, agent: string): string {
  const files = new Set<string>()
  const cmds: string[] = []
  const gits: string[] = []
  let calls = 0
  for (const m of msgs) {
    for (const u of m.toolUses ?? []) {
      calls++
      const path = u.input.file_path ?? u.input.notebook_path
      if (['Edit', 'Write', 'NotebookEdit'].includes(u.tool) && typeof path === 'string') files.add(path)
      if (u.tool === 'Bash' && typeof u.input.command === 'string') {
        const c = u.input.command.replaceAll('\n', ' ')
        const line = `${u.isError ? '[failed] ' : ''}${c.length > 160 ? `${c.slice(0, 159)}…` : c}`
        cmds.push(line)
        if (/\bgit\s+(commit|push)\b/.test(c)) gits.push(line)
      }
    }
  }
  const turns = msgs.filter(m => m.role === 'assistant').length
  const final = [...msgs].reverse().find(m => m.role === 'assistant' && m.text.trim() !== '')?.text.trim() ?? ''
  const list = (xs: string[]) => (xs.length === 0 ? ['- none'] : xs.map(x => `- ${x}`))
  return [
    `# Handoff digest: ${branch}`, '', `From ${agent}: ${calls} tool calls, ${turns} turns.`, '',
    '## Files edited', ...list([...files]), '',
    '## Last commands', ...list(cmds.slice(-15)), '',
    '## Commits and pushes', ...list(gits), '',
    '## Final report', final.length > 1500 ? `${final.slice(0, 1499)}…` : final || 'none', '',
  ].join('\n')
}

// The worktree of an agent: the entry ending in agent-<id>, else the one checked out on the branch.
export function findWorktree(porcelain: string, agentId: string, branch: string): { path: string; head?: string } | undefined {
  const entries = porcelain.split(/\n\n+/).map(block => {
    const get = (k: string) => block.split('\n').find(l => l.startsWith(`${k} `))?.slice(k.length + 1)
    return { path: get('worktree'), head: get('HEAD'), branch: get('branch') }
  })
  const hit = entries.find(e => e.path?.endsWith(`agent-${agentId}`)) ?? entries.find(e => e.branch === `refs/heads/${branch}`)
  return hit?.path === undefined ? undefined : { path: hit.path, ...(hit.head && { head: hit.head }) }
}
