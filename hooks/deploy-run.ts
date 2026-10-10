// The deploy gate's state and answers: deploys.json behind one chain, the hold and release of a target, the
// answers to approval and env items, the env items of a handover, and mcp__flow__deploy itself. The pure rules
// are in deploy.ts. The engine handle `$` is never passed across an import, so register.tsx hands in the calls.
import type { EnvChange, Handover, LogEvent } from '../types'
import {
  applyAnswer, applyViewOf, approvalContext, closeEnvItems, declinedEntries, decideEnv, decideGate, ENV_KIND, envCommandFor, envListLine,
  isApprove, normalizeDeploys, openApplyItem, openApprovalItem, reopenItem, openDeployIds, openEnvItems, pendingEnv, recordDeployed,
  release, renderList, retargetItem, unknownTarget, itemViewOf, withApproval, withEnvDone, withHold,
} from './deploy'
import type { Deploys, Draft, EnvInput, Hold, TargetInfo, TargetState } from './deploy'
import { AUTO, matchRule } from './standing'
import type { Resolved } from './standing'
import { markAnswered, notesOwner } from './inbox'
import type { Inbox, Question } from './inbox'

export type DeployIo = {
  stateDir: () => Promise<string | undefined>
  readJson: (path: string) => Promise<unknown>
  writeJson: (path: string, obj: unknown) => Promise<boolean>
  mkdir: (dir: string) => Promise<unknown>
  deploys: () => Promise<Deploys>
  setDeploys: (next: Deploys) => Promise<void>
  behind: () => Promise<Record<string, number>>
  setBehind: (next: Record<string, number>) => Promise<void>
  // The configured deploy targets and the base branch, as they are now.
  infos: () => TargetInfo[]
  base: () => string
  exec: (argv: string[], timeoutMs: number) => Promise<{ exitCode: number; stdout: string }>
  now: () => Promise<number>
  handovers: () => Promise<Record<string, Handover>>
  updateHandovers: (fn: (hs: Record<string, Handover>) => Record<string, Handover>) => Promise<void>
  saveHandover: (h: Handover) => Promise<void>
  inbox: () => Promise<Inbox>
  withInbox: <T>(fn: (cur: Inbox) => { inbox: Inbox; out: T }) => Promise<T>
  ensureQueue: () => Promise<string>
  loadRules: (options: Record<string, unknown>) => Promise<{ rules: Resolved[] }>
  appendNote: (name: string, line: string) => Promise<boolean>
  appendLog: (event: Omit<LogEvent, 'ts'>) => Promise<void>
  today: () => Promise<string>
  noteText: (q: Question) => string
  best: (what: string, fn: () => Promise<void>) => Promise<void>
  toast: (text: string) => void
}

// Deploy gate changes run one after another, like the inbox's.
let deploysChain: Promise<unknown> = Promise.resolve()

// Read deploys.json, let fn change it, write it back atomically and set the atom. fn returns the new state
// (the same object when nothing changed) and whatever the caller wants back.
export function withDeploys<T>(io: DeployIo, fn: (cur: Deploys) => { deploys: Deploys; out: T }): Promise<T> {
  const run = async (): Promise<T> => {
    const dir = await io.stateDir()
    const cur = dir === undefined ? await io.deploys() : normalizeDeploys(await io.readJson(`${dir}/deploys.json`))
    const { deploys: next, out } = fn(cur)
    if (next !== cur) {
      if (dir !== undefined) {
        await io.mkdir(dir)
        await io.writeJson(`${dir}/deploys.json`, next)
      }
      await io.setDeploys(next)
    }
    return out
  }
  const result = deploysChain.then(run, run)
  deploysChain = result.catch(() => undefined)
  return result
}

export const setTarget = (d: Deploys, name: string, ts: TargetState): Deploys => ({ targets: { ...d.targets, [name]: ts } })

// Commits behind the base for each target with a recorded deploy. One git call per target, never from a render.
let behindRun: Promise<void> | undefined
export function refreshBehind(io: DeployIo): Promise<void> {
  behindRun ??= (async () => {
    const d = await io.deploys()
    const out: Record<string, number> = {}
    for (const t of io.infos()) {
      const sha = d.targets[t.name]?.deployedSha
      if (sha === undefined) continue
      const r = await io.exec(['git', 'rev-list', '--count', `${sha}..origin/${io.base()}`], 10_000).catch(() => undefined)
      const n = r !== undefined && r.exitCode === 0 ? Number(r.stdout.trim()) : NaN
      if (Number.isInteger(n)) out[t.name] = n
    }
    await io.setBehind(out)
  })().catch(() => undefined).finally(() => { behindRun = undefined })
  return behindRun
}

// The commits an approval would ship: one line each, at most 15.
async function commitsSince(io: DeployIo, last: string | undefined, sha: string): Promise<string[]> {
  if (last === undefined) return []
  const r = await io.exec(['git', 'log', '--oneline', '-15', `${last}..${sha}`], 10_000).catch(() => undefined)
  return r !== undefined && r.exitCode === 0 ? r.stdout.split('\n').map(l => l.trim()).filter(Boolean) : []
}

// The user's answer to a deploy approval item: record it on its target, and start a deploy-only run for "deploy".
export async function onDeployAnswer(io: DeployIo, q: Question, answer: string): Promise<string> {
  const name = await withDeploys(io, cur => {
    const hit = Object.entries(cur.targets).find(([, ts]) => ts.approval?.qid === q.id)
    if (hit === undefined) return { deploys: cur, out: undefined }
    return { deploys: setTarget(cur, hit[0], applyAnswer(hit[1], answer)), out: hit[0] }
  })
  if (name === undefined) return ''
  if (!isApprove(answer)) return ` ${name} stays behind; the next batch asks again.`
  return ` ${name} approved. ${await io.ensureQueue()}`
}

// The user's answer to an env item. An applied `apply` item records the change as done by the user. A
// positive answer that leaves a target with nothing open, on an auto target, starts a deploy-only run (the
// gate then applies what is approved); a negative one holds the target until main releases it.
export async function onEnvAnswer(io: DeployIo, q: Question, answer: string): Promise<string> {
  const e = q.env
  if (e === undefined) return ''
  const yes = e.role === 'change' ? answer.trim().toLowerCase() === 'yes' : answer.trim().toLowerCase() === 'done'
  const at = await io.now()
  const info = io.infos().find(t => t.name === e.target)
  const hs = Object.values(await io.handovers())
  const waiting = pendingEnv(hs, e.target, (await io.deploys()).targets[e.target]).length > 0
  if (e.role === 'apply' && yes) {
    await withDeploys(io, cur => ({ deploys: setTarget(cur, e.target, withEnvDone(cur.targets[e.target], [{ pr: e.pr, name: e.name, how: 'user', at }])), out: undefined }))
  }
  if (!yes) {
    return e.role === 'change'
      ? ` ${e.target} is held by this: the gate skips it until main runs release on ${e.target}, which drops the declined change.`
      : ` Not yet: ${e.target} keeps waiting; the next gate opens a fresh item for it.`
  }
  const ib = await io.inbox()
  const stillOpen = ib.items.some(x => x.state === 'open' && x.kind === ENV_KIND && x.env?.target === e.target)
  if (!waiting || stillOpen || info === undefined || info.mode !== 'auto') return ''
  await withDeploys(io, cur => ({ deploys: setTarget(cur, e.target, { ...(cur.targets[e.target] ?? {}), due: true }), out: undefined }))
  return ` ${e.target} has its env answers. ${await io.ensureQueue()}`
}

// A person's (or main's) hold on a target.
export async function holdTarget(io: DeployIo, name: string, until: Hold['until'], by: string, reason: string | undefined): Promise<string> {
  const bad = unknownTarget(io.infos(), name)
  if (bad !== undefined) return bad
  const at = await io.now()
  await withDeploys(io, cur => {
    const hold: Hold = { until, by, at, ...(reason ? { reason } : {}) }
    return { deploys: setTarget(cur, name, withHold(cur.targets[name], hold)), out: undefined }
  })
  return until === 'batch'
    ? `${name} held for the next batch: the reviewer's next gate call for it answers Held and the hold ends. Release earlier with release.`
    : `${name} held until released: the reviewer skips it every batch. Release with release (/flow release ${name}).`
}

export async function releaseTarget(io: DeployIo, name: string): Promise<string> {
  const info = io.infos().find(t => t.name === name)
  const bad = unknownTarget(io.infos(), name)
  if (bad !== undefined || info === undefined) return bad ?? ''
  const hs = Object.values(await io.handovers())
  const ib = await io.inbox()
  const at = await io.now()
  // Releasing also drops the env changes the user declined: they are recorded as dropped and stop holding the target.
  const r = await withDeploys(io, cur => {
    const released = release(cur.targets[name], info.mode)
    const pending = pendingEnv(hs, name, released.state)
    const dropped = declinedEntries({ pending, item: itemViewOf(ib) })
    if (!released.had && dropped.length === 0) return { deploys: cur, out: { had: false, dropped } }
    const state = withEnvDone(released.state, dropped.map(d => ({ pr: d.pr, name: d.change.name, how: 'dropped' as const, at })))
    return { deploys: setTarget(cur, name, dropped.length > 0 && info.mode === 'auto' ? { ...state, due: true } : state), out: { had: released.had, dropped } }
  })
  if (!r.had && r.dropped.length === 0) return `${name} has no hold.`
  if (r.dropped.length > 0) {
    const qids = r.dropped.flatMap(d => [d.change.qid, ...(d.change.loginQid === undefined ? [] : [d.change.loginQid])])
    await io.withInbox(cur => ({ inbox: closeEnvItems(cur, qids, 'dropped: released without it', at), out: undefined }))
  }
  const dropNote = r.dropped.length === 0 ? '' : ` Dropped the declined env changes: ${[...new Set(r.dropped.map(d => d.change.name))].join(', ')}.`
  if (info.mode === 'confirm') return `${name} released.${dropNote} It is a confirm target: the next gate still asks for approval.`
  return `${name} released.${dropNote} ${await io.ensureQueue()}`
}


// mcp__flow__deploy. The gate is the one place that decides whether a target deploys in this batch.
export async function deployTool(io: DeployIo, options: Record<string, unknown>, input: Record<string, unknown>, isMain: boolean, caller: string): Promise<string> {
  const action = String(input.action ?? 'list')
  const target = typeof input.target === 'string' ? input.target.trim() : ''
  const sha = typeof input.sha === 'string' ? input.sha.trim() : ''
  if (action === 'list') {
    await refreshBehind(io)
    const d = await withDeploys(io, cur => ({ deploys: cur, out: cur }))
    const hs = Object.values(await io.handovers())
    const ib = await io.inbox()
    const envLines: Record<string, string> = {}
    for (const t of io.infos()) envLines[t.name] = envListLine(pendingEnv(hs, t.name, d.targets[t.name]), d.targets[t.name], itemViewOf(ib))
    return renderList(io.infos(), d, await io.behind(), envLines)
  }
  if (action !== 'gate' && action !== 'deployed' && action !== 'hold' && action !== 'release' && action !== 'env-applied') return 'Unknown action: use gate, deployed, env-applied, hold, release or list.'
  if ((action === 'hold' || action === 'release') && !isMain) return 'Refused: only main holds or releases a target, on the user\'s word. Ask main.'
  const info = io.infos().find(t => t.name === target)
  if (info === undefined) return `Refused: ${unknownTarget(io.infos(), target)}`
  if (action === 'hold') {
    const until = input.until === 'released' ? 'released' : input.until === 'batch' ? 'batch' : undefined
    if (until === undefined) return 'Refused: hold needs until: "batch" or "released".'
    return holdTarget(io, target, until, caller, typeof input.reason === 'string' ? input.reason.trim() : undefined)
  }
  if (action === 'release') return releaseTarget(io, target)
  if (action === 'env-applied') return envApplied(io, info, Array.isArray(input.names) ? input.names.map(String) : [])
  if (sha === '') return 'Refused: sha is required (the short sha just pushed).'
  const at = await io.now()
  if (action === 'deployed') {
    if (typeof input.ok !== 'boolean') return 'Refused: deployed needs ok true or false.'
    await withDeploys(io, cur => ({ deploys: setTarget(cur, target, recordDeployed(cur.targets[target], sha, input.ok === true, at)), out: undefined }))
    await refreshBehind(io)
    return input.ok === true ? `${target}: recorded as deployed at ${sha}.` : `${target}: failure noted; the last good deploy stays recorded.`
  }
  return runGate(io, options, info, sha, at, false)
}

// What the gate needs to know about a target's env changes now: the pending ones and the user's answers.
function envInputFor(info: TargetInfo, ts: TargetState | undefined, hs: Handover[], ib: Inbox): EnvInput | undefined {
  const pending = pendingEnv(hs, info.name, ts)
  if (pending.length === 0) return undefined
  return { pending, item: itemViewOf(ib), applyItem: applyViewOf(ib), hasCommand: info.envCommand !== undefined }
}

const skipText = (target: string) => `Skip ${target} for this batch and go on with the next target.`

// One pass of the gate; `again` is set on the second pass, after a standing rule approved the fresh item.
async function runGate(io: DeployIo, options: Record<string, unknown>, info: TargetInfo, sha: string, at: number, again: boolean): Promise<string> {
  const target = info.name
  const hs = Object.values(await io.handovers())
  const ib = await io.inbox()
  const open = openDeployIds(ib)
  const decided = await withDeploys(io, cur => {
    const env = envInputFor(info, cur.targets[target], hs, ib)
    const r = decideGate(cur.targets[target], info.mode, sha, qid => open.has(qid), env, at)
    return { deploys: r.state === cur.targets[target] ? cur : setTarget(cur, target, r.state), out: r }
  })
  const gate = decided.gate
  if (gate.kind === 'go') return 'Go'
  if (gate.kind === 'goEnv') {
    const lines = gate.apply.map(e => `- ${e.change.name}: ${envCommandFor(info.envCommand ?? '', e.change.name, e.change.value ?? '')}`)
    return `Go, first apply env:\n${lines.join('\n')}\nRun each command in order from the repo root; a non-zero exit fails ${target} (call deployed with ok false and stop). Then call action "env-applied" with target "${target}" and names [${gate.apply.map(e => `"${e.change.name}"`).join(', ')}], then run the target's steps.`
  }
  if (gate.kind === 'held') return `Held: ${gate.why}. ${skipText(target)}`
  if (gate.kind === 'envHeld') return `Held: ${gate.why}. It stays held until main runs release on ${target} (that drops the declined changes). ${skipText(target)}`
  if (gate.kind === 'envAwaits') return `Awaits env: ${gate.qids.join(', ')}. ${skipText(target)}`
  if (gate.kind === 'envAsk') {
    const qids: string[] = [...gate.open]
    const moved: Array<{ pr: number; name: string; field: 'qid' | 'loginQid'; qid: string }> = []
    await io.withInbox(cur => {
      let next = cur
      for (const e of gate.entries) {
        const r = openApplyItem(next, e, at)
        next = r.inbox
        qids.push(r.q.id)
      }
      // An item answered "not yet" is replaced by a fresh copy, so the change keeps one open item.
      for (const re of gate.reopen) {
        const old = next.items.find(x => x.id === re.entry.change[re.field])
        if (old === undefined) continue
        const r = reopenItem(next, old, at)
        next = r.inbox
        qids.push(r.q.id)
        moved.push({ pr: re.entry.pr, name: re.entry.change.name, field: re.field, qid: r.q.id })
      }
      return { inbox: next, out: undefined }
    })
    for (const pr of new Set(moved.map(m => m.pr))) {
      const h = (await io.handovers())[String(pr)]
      if (h?.env === undefined) continue
      const next: Handover = { ...h, env: h.env.map(c => {
        const mine = moved.filter(x => x.pr === pr && x.name === c.name && c.target === target)
        return mine.length === 0 ? c : { ...c, ...Object.fromEntries(mine.map(m => [m.field, m.qid])) }
      }) }
      await io.updateHandovers(hs => ({ ...hs, [String(pr)]: next }))
      await io.best('saving a handover', () => io.saveHandover(next))
    }
    io.toast(`Env on ${target} awaits you: /flow inbox (${qids.join(', ')})`)
    return `Awaits env: ${qids.join(', ')}. ${skipText(target)}`
  }
  const last = (await io.deploys()).targets[target]?.deployedSha
  const context = approvalContext(target, sha, last, await commitsSince(io, last, sha))
  if (gate.kind === 'awaits') {
    await io.withInbox(cur => ({ inbox: retargetItem(cur, gate.qid, target, sha, context), out: undefined }))
    return `Awaits approval: ${gate.qid}. ${skipText(target)}`
  }
  const q = await io.withInbox(cur => {
    const r = openApprovalItem(cur, target, sha, context, at)
    return { inbox: r.inbox, out: r.q }
  })
  await withDeploys(io, cur => ({ deploys: setTarget(cur, target, withApproval(cur.targets[target], q.id, sha, at)), out: undefined }))
  // A standing rule answers the fresh item only if it names the deploy kind (matchRule skips it otherwise).
  const { rules } = await io.loadRules(options)
  const m = matchRule(rules, q)
  if (m !== undefined) {
    const marked = await io.withInbox(cur => {
      const r = markAnswered(cur, q.id, m.answer, AUTO, at, m.rule.rid)
      return { inbox: r.kind === 'ok' ? r.inbox : cur, out: r }
    })
    if (marked.kind === 'ok') {
      await withDeploys(io, cur => ({ deploys: setTarget(cur, target, applyAnswer(cur.targets[target], marked.answer)), out: undefined }))
      await io.appendNote(notesOwner(marked.q), `- ${await io.today()} decision: "${q.id} ${q.question}: ${marked.answer}" (standing answer ${m.rule.rid})`)
      await io.best('logging an auto-answer', () => io.appendLog({ event: 'auto-answer', owner: 'main', text: `${q.id} rule ${m.rule.rid}: ${marked.answer}` }))
      // Approved: the gate runs once more, so the env commands (if any) come with the Go.
      if (isApprove(marked.answer) && !again) return runGate(io, options, info, sha, at, true)
      if (isApprove(marked.answer)) return 'Go'
      return `Held: standing answer ${m.rule.rid} said "${marked.answer}". ${skipText(target)}`
    }
  }
  io.toast(`Deploy ${target} awaits your approval: /flow inbox (${q.id})`)
  return `Awaits approval: ${q.id}. ${skipText(target)}`
}

// env-applied: the reviewer ran the env commands the gate named. Records those changes for the target; asking
// twice changes nothing more. Only changes the user approved (and that the gate named) are recorded.
async function envApplied(io: DeployIo, info: TargetInfo, names: string[]): Promise<string> {
  if (names.length === 0) return 'Refused: env-applied needs names, the variables whose commands you ran.'
  const at = await io.now()
  const hs = Object.values(await io.handovers())
  const ib = await io.inbox()
  const notes: string[] = []
  await withDeploys(io, cur => {
    const ts = cur.targets[info.name]
    const pending = pendingEnv(hs, info.name, ts)
    const d = decideEnv({ pending, item: itemViewOf(ib), applyItem: applyViewOf(ib), hasCommand: info.envCommand !== undefined })
    const ready = d.kind === 'clear' ? d.apply : []
    const add = []
    for (const n of names) {
      const hit = ready.find(e => e.change.name === n)
      if (hit !== undefined) add.push({ pr: hit.pr, name: n, how: 'command' as const, at })
      else if ((ts?.envDone ?? []).some(x => x.name === n)) notes.push(`${n}: already recorded`)
      else notes.push(`${n}: not recorded, it is not approved and ready (the gate names what to apply)`)
    }
    const next = withEnvDone(ts, add)
    notes.push(...add.map(a => `${a.name}: recorded as applied by command`))
    return { deploys: next === ts ? cur : setTarget(cur, info.name, next), out: undefined }
  })
  return `${info.name}: ${notes.join('; ')}. Now run the target's steps.`
}

// The inbox items for a handover's env changes. A handover sent again reuses the earlier items by target and
// name and closes the ones it no longer lists. A standing rule answers an item only if it names the env kind.
// Returns the text for the handover result; the values never go to the log or a toast.
export async function openHandoverEnv(
  io: DeployIo, options: Record<string, unknown>, h: Handover, drafts: Draft[],
  prev: EnvChange[], at: number,
): Promise<string> {
  if (drafts.length === 0 && prev.length === 0) return ''
  const changes: EnvChange[] = []
  const fresh: Question[] = []
  await io.withInbox(cur => {
    let next = cur
    for (const d of drafts) {
      const r = openEnvItems(next, h.pr, d, prev.find(p => p.target === d.target && p.name === d.name), at)
      next = r.inbox
      changes.push(r.change)
      fresh.push(...r.fresh)
    }
    const kept = new Set(changes.flatMap(c => [c.qid, ...(c.loginQid === undefined ? [] : [c.loginQid])]))
    const gone = prev.flatMap(p => [p.qid, ...(p.loginQid === undefined ? [] : [p.loginQid])]).filter(q => !kept.has(q))
    return { inbox: gone.length === 0 ? next : closeEnvItems(next, gone, 'dropped: the PR was handed over again without it', at), out: undefined }
  })
  if (changes.length > 0) h.env = changes
  else delete h.env
  if (fresh.length > 0) {
    const { rules } = await io.loadRules(options)
    for (const q of fresh) {
      const m = matchRule(rules, q)
      if (m === undefined) continue
      const marked = await io.withInbox(cur => {
        const r = markAnswered(cur, q.id, m.answer, AUTO, at, m.rule.rid)
        return { inbox: r.kind === 'ok' ? r.inbox : cur, out: r }
      })
      if (marked.kind !== 'ok') continue
      await onEnvAnswer(io, marked.q, marked.answer)
      await io.appendNote(notesOwner(marked.q), `- ${await io.today()} decision: "${q.id} ${io.noteText(marked.q)}: ${marked.answer}" (standing answer ${m.rule.rid})`)
      await io.best('logging an auto-answer', () => io.appendLog({ event: 'auto-answer', owner: 'main', text: `${q.id} rule ${m.rule.rid}: ${marked.answer}` }))
    }
    const ib = await io.inbox()
    const stillOpen = fresh.filter(q => ib.items.find(x => x.id === q.id)?.state === 'open')
    if (stillOpen.length > 0) io.toast(`PR #${h.pr} has ${stillOpen.length} env item${stillOpen.length === 1 ? '' : 's'} for you: /flow inbox`)
  }
  if (changes.length === 0) return ''
  const ib = await io.inbox()
  const open = changes.flatMap(c => [c.loginQid, c.qid]).filter((q): q is string => q !== undefined && ib.items.find(x => x.id === q)?.state === 'open')
  return ` Env changes for the user (${changes.map(c => `${c.name} on ${c.target}${c.secret === true ? ', secret' : ''}`).join('; ')}): ${open.length === 0 ? 'all answered' : `inbox ${open.join(', ')}`}. Those targets do not deploy until they are answered.`
}

// A returned PR's env changes are dropped: their open items are closed by "flow" with a note.
export async function closeReturnedEnv(io: DeployIo, h: Handover): Promise<void> {
  if (h.env === undefined || h.env.length === 0) return
  const at = await io.now()
  await io.best('closing env items', () => io.withInbox(cur => {
    const qids = [
      ...h.env!.flatMap(c => [c.qid, ...(c.loginQid === undefined ? [] : [c.loginQid])]),
      ...cur.items.filter(x => x.env?.role === 'apply' && x.env.pr === h.pr).map(x => x.id),
    ]
    return { inbox: closeEnvItems(cur, qids, 'dropped: the PR was returned', at), out: undefined }
  }))
}
