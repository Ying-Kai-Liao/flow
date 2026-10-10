// The /flow resume leftovers: unfinished flow work an earlier session left behind, and the
// instructions that restart it. The engine handle `$` is never passed across an import, so the
// caller hands in these calls.

import type { Handover, LogEvent, Session } from '../types'
import { LIVE } from './deliver'
import { parsePorcelain } from './clean'
import { ownerFor } from './state'

export type ResumeIo = {
  // A process run; a failure to start throws.
  exec: (argv: string[], timeoutMs: number) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  agents: () => Promise<{ id: string; status: string; name?: string }[]>
  sessions: () => Promise<Session[]>
  log: () => Promise<LogEvent[]>
  loadHandovers: () => Promise<Record<string, Handover>>
  saveHandover: (h: Handover) => Promise<void>
  // State on disk is best-effort: a failure goes to the UI log.
  best: (what: string, fn: () => Promise<void>) => Promise<void>
  // Adds the handovers read from disk to the atom; what the atom already holds wins.
  mergeHandovers: (all: Record<string, Handover>) => Promise<void>
}

const OWNED = new Set([...LIVE, 'idle'])

const resumeHead = (limit: number): string => [
  'The user ran /flow resume. Unfinished flow work was found (below). Start flow managers for it with the Agent tool, without asking:',
  '- One flow:manager per task, named resume-<slug>, run_in_background true, at most ' + limit + ' at a time; start the rest as each finishes. Items whose branch names share a manager prefix (flow/csv-export-endpoint and flow/csv-export-button) are one task.',
  '- Each manager\'s prompt carries, for every item of its task: the branch, the PR number and URL, the PR description (including any ## Handoff section), and for a worktree its path. It carries the work on from there and must not redo work already merged into the base branch.',
].join('\n')

// Unfinished flow work left behind by an earlier session, as `/flow resume` lists it.
export type Leftover = { key: string; branch?: string; kind: 'pr' | 'branch' | 'worktree'; line: string; detail: string; owner?: string }

// `error` with items means GitHub was unavailable and the items come from the state dir alone.
export type Gathered = { items: Leftover[]; skipped: Leftover[]; error?: string }

// Handovers on disk that are not finished, as resume items. A handover whose PR GitHub shows as
// merged counts as done: it is marked so in the atom and not restarted.
export async function diskItems(io: ResumeIo, items: Leftover[], merged: { prs: Set<number>; branches: Set<string> } | undefined): Promise<void> {
  const all = await io.loadHandovers()
  const events = await io.log()
  const hs = Object.values(all)
  if (hs.length === 0) return
  const finished = (h: Handover) => h.status === 'done' || (merged !== undefined && (merged.prs.has(h.pr) || merged.branches.has(h.branch)))
  await io.best('restoring handovers', async () => {
    for (const h of hs) {
      if (h.status !== 'done' && finished(h)) {
        all[String(h.pr)] = { ...h, status: 'done' }
        await io.saveHandover(all[String(h.pr)] as Handover)
      }
    }
    await io.mergeHandovers(all)
  })
  for (const h of hs) {
    if (finished(h)) continue
    const note = `Handover #${h.pr} is ${h.status}${h.status === 'returned' ? ` (${h.reason ?? 'no reason'})` : ''}, reported to ${h.reportTo}. Verified: ${h.verified} Pending: ${h.pending}` +
      (h.status === 'awaiting' ? ` It awaits the user's /flow approve ${h.pr}; do not restart work on it.` : '') +
      (h.status === 'ready' ? ' It is in a batch the reviewer built and checked, which awaits the user\'s /flow push; do not restart work on it.' : '')
    const mate = items.find(i => i.key === h.branch)
    if (mate !== undefined) {
      mate.line += ` | handover ${h.status}`
      mate.detail += `\n${note}`
    } else {
      items.push({ key: h.branch, branch: h.branch, kind: 'pr', line: `#${h.pr} ${h.branch}: handover ${h.status} — ${h.title}`, detail: `Branch ${h.branch}, PR #${h.pr}, title "${h.title}".\n${note}` })
    }
    const at = items.find(i => i.key === h.branch)
    if (at !== undefined) at.owner = ownerFor(events, { pr: h.pr, branch: h.branch }) ?? h.reportTo
  }
  for (const i of items) {
    if (i.owner === undefined && i.branch !== undefined) i.owner = ownerFor(events, { branch: i.branch })
  }
}

// Finds what a restart leaves behind: flow/* PRs and pushed branches, and worktrees with
// uncommitted or unpushed work. Any git or gh failure becomes one line, never a throw.
export async function gatherLeftovers(io: ResumeIo, base: string, resumed: Set<string>): Promise<Gathered> {
  const run = async (argv: string[]) => {
    try {
      return await io.exec(argv, 60_000)
    } catch (err) {
      return { exitCode: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
    }
  }
  const fail = async (what: string, r: { stderr: string }): Promise<Gathered> => {
    const items: Leftover[] = []
    await diskItems(io, items, undefined)
    return {
      items: items.filter(i => !resumed.has(i.key)), skipped: items.filter(i => resumed.has(i.key)),
      error: `Cannot look for unfinished work: ${what} failed: ${r.stderr.trim().split('\n')[0]?.slice(0, 200) || 'no output'}${items.length ? '. GitHub was unavailable: these come from the state dir only.' : ''}`,
    }
  }

  const fetched = await run(['git', 'fetch', 'origin', '--prune'])
  if (fetched.exitCode !== 0) return await fail('git fetch origin', fetched)
  const open = await run(['gh', 'pr', 'list', '--state', 'open', '--json', 'number,title,headRefName,isDraft,url,body', '--limit', '100'])
  if (open.exitCode !== 0) return await fail('gh pr list', open)
  const all = await run(['gh', 'pr', 'list', '--state', 'all', '--json', 'number,headRefName,headRefOid,state', '--limit', '200'])
  if (all.exitCode !== 0) return await fail('gh pr list', all)
  const refs = await run(['git', 'for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin/flow/'])
  if (refs.exitCode !== 0) return await fail('git for-each-ref', refs)

  type Pr = { number: number; title: string; headRefName: string; isDraft: boolean; url: string; body: string }
  const prs = (JSON.parse(open.stdout || '[]') as Pr[]).filter(p => p.headRefName.startsWith('flow/'))
  const ended = (JSON.parse(all.stdout || '[]') as { number?: number; headRefName: string; headRefOid?: string; state: string }[])
    .filter(p => p.state !== 'OPEN')
  const closed = new Set(ended.map(p => p.headRefName))
  // A squash-merged branch is deleted on the remote, so its worktree looks unpushed: match by head too.
  const endedHeads = new Set(ended.map(p => p.headRefOid).filter(Boolean))
  const withPr = new Set(prs.map(p => p.headRefName))
  const branches = refs.stdout.split('\n').map(l => l.trim().replace(/^origin\//, ''))
    .filter(b => b.startsWith('flow/') && !withPr.has(b) && !closed.has(b))

  // A live agent named like the branch owns it.
  const liveAgents = (await io.agents()).filter(a => OWNED.has(a.status))
  const owners = new Set(liveAgents.filter(a => a.name !== undefined).map(a => `flow/${a.name}`))
  for (const s of await io.sessions()) if (s.status === 'running' || s.status === 'reported') owners.add(s.branch)
  // A worktree path ends in agent-<agentId>: that covers a worker that has not renamed its branch, and the reviewer.
  const liveIds = new Set(liveAgents.map(a => `agent-${a.id}`))

  const items: Leftover[] = []
  for (const p of prs) {
    items.push({
      key: p.headRefName, kind: 'pr',
      line: `#${p.number} ${p.headRefName}${p.isDraft ? ' (draft)' : ''}: ${p.title} ${p.url}`,
      detail: `Branch ${p.headRefName}, PR #${p.number} ${p.url}${p.isDraft ? ' (draft)' : ''}, title "${p.title}".\nPR description:\n${p.body.trim() || '(empty)'}`,
    })
  }
  for (const b of branches) {
    items.push({ key: b, kind: 'branch', line: `${b} (pushed, no PR)`, detail: `Branch ${b}, pushed, no PR yet.` })
  }

  const wt = await run(['git', 'worktree', 'list', '--porcelain'])
  if (wt.exitCode === 0) {
    for (const { path, branch } of parsePorcelain(wt.stdout)) {
      if (!path.includes('/.claude/worktrees/')) continue
      if (liveIds.has(path.split('/').pop() ?? '') || (branch !== undefined && closed.has(branch))) continue
      const dirty = (await run(['git', '-C', path, 'status', '--porcelain'])).stdout.trim() !== ''
      if (branch === undefined && !dirty) continue
      let unpushed = ''
      if (!dirty) {
        const up = await run(['git', '-C', path, 'rev-parse', '--abbrev-ref', '@{u}'])
        unpushed = (await run(up.exitCode === 0
          ? ['git', '-C', path, 'log', '--oneline', '@{u}..']
          : ['git', '-C', path, 'log', '--oneline', `origin/${base}..HEAD`])).stdout.trim()
      }
      if (!dirty && unpushed === '') continue
      const head = (await run(['git', '-C', path, 'rev-parse', 'HEAD'])).stdout.trim()
      if (endedHeads.has(head)) continue
      if (!dirty && (await run(['git', '-C', path, 'branch', '-r', '--contains', 'HEAD'])).stdout.trim() !== '') continue
      const what = dirty ? 'uncommitted changes' : `${unpushed.split('\n').length} unpushed commit(s)`
      const mate = branch === undefined ? undefined : items.find(i => i.key === branch)
      if (mate !== undefined) {
        mate.line += ` | worktree ${path} (${what})`
        mate.detail += `\nIts worktree: ${path} (${what}).`
        continue
      }
      items.push({
        key: path, branch, kind: 'worktree', line: `${path} on ${branch ?? 'detached HEAD'}: ${what}`,
        detail: `Worktree ${path}, branch ${branch ?? 'detached HEAD'}: ${what}.`,
      })
    }
  }

  await diskItems(io, items, {
    prs: new Set(ended.filter(p => p.state === 'MERGED' && p.number !== undefined).map(p => p.number as number)),
    branches: new Set(ended.filter(p => p.state === 'MERGED').map(p => p.headRefName)),
  })

  const live = (i: Leftover) => owners.has(i.branch ?? i.key)
  return {
    items: items.filter(i => !live(i) && !resumed.has(i.key)),
    skipped: items.filter(i => !live(i) && resumed.has(i.key)),
  }
}

export type OwnerNotes = { path: string; text: string }

export function resumeInstructions(items: Leftover[], limit: number, notes: Map<string, OwnerNotes> = new Map()): string {
  const owners = [...new Set(items.map(i => i.owner).filter((o): o is string => o !== undefined))]
  // Recorded owners: the state on disk says who ran each item and what the user told them.
  const grouped = owners.length === 0 ? [] : [
    '',
    'Flow state on disk names the manager that owned each item. Items of one owner go to ONE manager. Its prompt tells it to read its notes first (mcp__flow__note with manager = the owner name below and no text), and carries the notes quoted here. A manager with notes but no item below is not restarted.',
    ...owners.flatMap(o => {
      const n = notes.get(o)
      return [
        '',
        `Owner ${o}:`,
        ...items.filter(i => i.owner === o).map(i => `- ${i.detail.replaceAll('\n', '\n  ')}`),
        n?.text ? `Notes (${n.path}):\n${n.text}` : 'Notes: none.',
      ]
    }),
    ...(items.some(i => i.owner === undefined) ? ['', 'No recorded owner:', ...items.filter(i => i.owner === undefined).map(i => `- ${i.detail.replaceAll('\n', '\n  ')}`)] : []),
  ]
  if (grouped.length) return [resumeHead(limit), ...grouped].join('\n')
  return [
    resumeHead(limit),
    '',
    'Found:',
    ...items.map(i => `- ${i.detail.replaceAll('\n', '\n  ')}`),
  ].join('\n')
}
