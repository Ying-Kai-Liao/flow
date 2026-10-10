import type { AgentRow, Handover, LogEvent } from '../types'
import type { settingsOf } from './settings'
import type { Inbox } from './inbox'
import { expandOk, findItem, isFyi, OVERTURN, renderInbox, renderItem, stillOpen } from './inbox'
import { termWidth } from './table'
import { CHECKS_USAGE, closeChecks, inboxChecksSection, renderCheckDetail, renderChecksTable, resumeChecksLines } from './checks'
import type { Checks } from './checks'
import { renderStatus } from './preflight'
import type { Preflight } from './preflight'
import { resumeInstructions } from './resume'
import type { Gathered, Leftover, OwnerNotes } from './resume'
import { pushLines } from './pushgate-run'
import type { PushAct } from './pushgate-run'
import type { PushState } from './pushgate'
import type { Hold } from './deploy'
import { mirror, PANE } from './core'

type Settings = ReturnType<typeof settingsOf>

// The /flow command. The engine refuses `$` across an import, so register.tsx builds a CommandIo of
// closures over the calls this needs.
export type CommandIo = {
  now: () => Promise<number>
  inbox: () => Promise<Inbox>
  checks: () => Promise<Checks>
  answerQuestion: (wanted: string, choice: string | null, by: string, options: Record<string, unknown>, user: boolean) => Promise<string>
  withChecks: <T>(fn: (cur: Checks) => { checks: Checks; out: T }) => Promise<T>
  costLines: (prs: { pr: number; branch: string }[]) => Promise<string[]>
  handovers: () => Promise<Record<string, Handover>>
  preflight: () => Promise<Preflight>
  roster: () => Promise<AgentRow[]>
  endedManagers: (rows: AgentRow[]) => Set<string>
  panes: () => Promise<Array<{ id: string }>>
  close: () => Promise<unknown>
  open: () => Promise<unknown>
  gatherLeftovers: (base: string, resumed: Set<string>) => Promise<Gathered>
  pushState: () => Promise<PushState>
  after: (ms: number, fn: () => void) => void
  submit: (text: string) => Promise<unknown>
  notesPath: (owner: string) => Promise<string | undefined>
  readNotes: (owner: string) => Promise<string>
  sweep: (base: string, apply: boolean, dryHint?: string) => Promise<string>
  putHandover: (pr: string, h: Handover) => Promise<void>
  best: (what: string, fn: () => Promise<void>) => Promise<void>
  saveHandover: (h: Handover) => Promise<void>
  appendLog: (event: Omit<LogEvent, 'ts'>) => Promise<void>
  toast: (text: string) => void
  ensureQueue: () => Promise<string>
  refresh: () => Promise<unknown>
  pushAct: (act: PushAct, by: string) => Promise<string>
  holdTarget: (name: string, until: Hold['until'], by: string, reason: string | undefined) => Promise<string>
  releaseTarget: (name: string) => Promise<string>
  refreshBehind: () => Promise<void>
}

export async function flowCommand(
  io: CommandIo, settings: Settings, installed: string | undefined, resumed: Set<string>, options: Record<string, unknown>, args: string | undefined,
): Promise<{ text: string; context?: string[] }> {
    // A plugin's $.command.run may leave args out.
    const arg = (args ?? '').trim()
    if (arg === 'inbox' || arg.startsWith('inbox ')) {
      const w = arg.split(/\s+/).slice(1)
      const box = await io.inbox()
      const now = await io.now()
      if (w.length === 1 && /^[qd]\d+$/i.test(w[0]!)) return { text: renderItem(box, w[0]!, now) }
      // `all` is the older spelling of `decisions`: both list every decision.
      if (w.length > 1 || (w.length === 1 && w[0] !== 'all' && w[0] !== 'decisions')) return { text: 'Usage: /flow inbox, /flow inbox decisions (every decision), /flow inbox <id> (one item in full)' }
      const sec = inboxChecksSection(await io.checks(), installed)
      return { text: [renderInbox(box, now, { all: w.length === 1, width: termWidth() }), ...sec].join('\n') }
    }
    if (/^(ok|no|answer)(\s|$)/.test(arg)) {
      const [verb = ''] = arg.split(/\s+/)
      const rest = arg.slice(verb.length).trim()
      const lines: string[] = []
      if (verb === 'ok') {
        const { ids, lines: refused } = expandOk(await io.inbox(), rest === '' ? [] : rest.split(/\s+/))
        lines.push(...refused)
        for (const id of ids) lines.push(await io.answerQuestion(id, null, 'main', options, true))
      } else if (verb === 'no') {
        const m = /^(\S+)(?:\s+([\s\S]+))?$/.exec(rest)
        const q = m === null ? undefined : findItem(await io.inbox(), m[1]!)
        if (m === null) return { text: 'Usage: /flow no <id> [what to do instead]' }
        if (q !== undefined && !isFyi(q)) lines.push(`${q.id}: not a decision; answer a question with /flow answer ${q.id} <choice>.`)
        else lines.push(await io.answerQuestion(m[1]!.toLowerCase(), m[2] ?? OVERTURN, 'main', options, true))
      } else {
        const m = /^(\S+)\s+([\s\S]+)$/.exec(rest)
        if (m === null) return { text: 'Usage: /flow answer <id> <option letter, number or your own words>' }
        lines.push(await io.answerQuestion(m[1]!.toLowerCase(), m[2]!, 'main', options, true))
      }
      lines.push(stillOpen(await io.inbox()))
      return { text: lines.join('\n') }
    }
    if (arg === 'checks' || arg.startsWith('checks ')) {
      const w = arg.split(/\s+/).slice(1)
      // Ids are matched in any case; only the id words are lowercased, the reason or note keeps its own.
      for (let n = ['pass', 'fail', 'skip'].includes(w[0] ?? '') ? 1 : 0; /^c\d+$/i.test(w[n] ?? ''); n++) w[n] = w[n]!.toLowerCase()
      const t = await io.now()
      if (w.length === 0) return { text: renderChecksTable(await io.checks(), installed, termWidth(), t) }
      if (w.length === 1 && !['pass', 'fail', 'skip'].includes(w[0]!)) return { text: renderCheckDetail(await io.checks(), w[0]!, installed, t) }
      if (w[0] === 'pass' && w.length > 1) {
        return { text: await io.withChecks(cur => {
          const r = closeChecks(cur, w.slice(1), 'pass', 'user', undefined, t)
          return 'error' in r ? { checks: cur, out: `Not closed: ${r.error}` } : { checks: r.checks, out: r.text }
        }) }
      }
      if (w[0] === 'fail' && w.length > 1) {
        return { text: await io.withChecks(cur => {
          const r = closeChecks(cur, [w[1]!], 'fail', 'user', w.slice(2).join(' '), t)
          return 'error' in r ? { checks: cur, out: `Not closed: ${r.error}` } : { checks: r.checks, out: `${w[1]} failed; main starts a manager on the follow-up (/flow resume lists it).` }
        }) }
      }
      if (w[0] === 'skip' && w.length > 1) {
        // Leading ids share one reason: the words after the last id-shaped word.
        let n = 1
        while (/^c\d+$/.test(w[n] ?? '')) n++
        return { text: await io.withChecks(cur => {
          const r = closeChecks(cur, w.slice(1, n), 'skip', 'user', w.slice(n).join(' '), t)
          return 'error' in r ? { checks: cur, out: `Not closed: ${r.error}` } : { checks: r.checks, out: r.text }
        }) }
      }
      return { text: CHECKS_USAGE }
    }
    if (arg === 'status') {
      const lines = await io.costLines(Object.values(await io.handovers()))
      return { text: lines.length > 0 ? lines.join('\n') : 'No agent steps counted yet.' }
    }
    if (arg === 'preflight') {
      return { text: renderStatus(await io.preflight(), await io.inbox(), io.endedManagers(await io.roster()), await io.now(), mirror.preflightWaitMs) }
    }
    if (arg === 'close') {
      if (!(await io.panes()).some(p => p.id === PANE)) return { text: 'The Flow pane is not open.' }
      try {
        await io.close()
      } catch (err) {
        return { text: `The Flow pane stayed open: ${err instanceof Error ? err.message : String(err)}` }
      }
      return { text: 'Flow pane closed.' }
    }
    if (arg === 'resume') {
      const found = await io.gatherLeftovers(settings.base, resumed)
      // A batch the user has not pushed yet comes first; no manager is started for it.
      const batchLines = pushLines(await io.pushState())
      const waiting = batchLines.length === 0 ? [] : ['Needs you (a checked batch awaits your push; no manager is started for it):', ...batchLines]
      if (found.error !== undefined && found.items.length === 0) return { text: [...waiting, found.error].join('\n') }
      const lines = (kind: Leftover['kind'], title: string) => {
        const rows = found.items.filter(i => i.kind === kind)
        return rows.length ? [`${title}:`, ...rows.map(i => `  ${i.line}`)] : []
      }
      const again = found.skipped.length ? ['Already resumed in this session:', ...found.skipped.map(i => `  ${i.line}`)] : []
      const checkLines = resumeChecksLines(await io.checks(), installed)
      if (found.items.length === 0) return { text: [...waiting, ...(checkLines.length || waiting.length ? [] : ['Nothing unfinished.']), ...checkLines, ...again].join('\n') }
      const text = [
        ...waiting,
        ...checkLines,
        ...(found.error !== undefined ? [found.error] : []),
        ...lines('pr', 'Open PRs'), ...lines('branch', 'Branches without a PR'), ...lines('worktree', 'Worktrees with leftover work'), ...again,
      ].join('\n')
      for (const i of found.items) resumed.add(i.key)
      // The instructions ride as hidden `context`. A command's context alone starts no turn and the
      // host refuses `prompt.submit` from inside a command.run hook, so a short prompt is submitted
      // once the command has returned, to make the main session act on it.
      io.after(0, () => {
        void io.submit('Carry out the /flow resume instructions: start the managers.').catch(() => undefined)
      })
      const notes = new Map<string, OwnerNotes>()
      for (const o of new Set(found.items.map(i => i.owner))) {
        const path = o === undefined ? undefined : await io.notesPath(o)
        if (o !== undefined && path !== undefined) notes.set(o, { path, text: await io.readNotes(o) })
      }
      return { text, context: [resumeInstructions(found.items, settings.maxManagers, notes)] }
    }
    const words = arg.split(/\s+/)
    if (words[0] === 'clean' && words.slice(1).every(w => w === '--yes')) {
      // A person's command: --yes removes whatever the cleanup setting says.
      return { text: await io.sweep(settings.base, words.length > 1, 'Run /flow clean --yes to remove them.') }
    }
    if (words[0] === 'approve') {
      // Only a person's command approves; no tool does.
      const n = Number(words[1])
      if (words.length !== 2 || !Number.isInteger(n) || n <= 0) return { text: 'Usage: /flow approve <pr>' }
      const h = (await io.handovers())[String(n)]
      if (h === undefined) return { text: `No handover for PR #${n}.` }
      if (h.status !== 'awaiting') return { text: `PR #${n} is ${h.status}, not awaiting approval.` }
      const next: Handover = { ...h, status: 'pending', approvedHead: h.head }
      await io.putHandover(String(n), next)
      await io.best('saving a handover', async () => {
        await io.saveHandover(next)
        await io.appendLog({ event: 'approve', owner: next.reportTo, pr: n, branch: next.branch, text: next.title })
      })
      void io.toast(`PR #${n} approved at ${h.head.slice(0, 8)}`)
      const queue = await io.ensureQueue()
      await io.refresh()
      return { text: `Approved PR #${n} at ${h.head.slice(0, 8)}. ${queue}` }
    }
    if (words[0] === 'push') {
      // Only a person's command releases a ready batch (or main, on the user's word, with the push tool).
      const usage = 'Usage: /flow push (push the ready batch), /flow push back <pr> (send one PR back), /flow push drop (return them all)'
      if (words.length === 1) return { text: await io.pushAct({ kind: 'push' }, 'user') }
      if (words[1] === 'drop' && words.length === 2) return { text: await io.pushAct({ kind: 'drop' }, 'user') }
      const n = Number((words[2] ?? '').replace(/^#/, ''))
      if (words[1] === 'back' && words.length === 3 && Number.isInteger(n) && n > 0) return { text: await io.pushAct({ kind: 'back', pr: n }, 'user') }
      return { text: usage }
    }
    if (words[0] === 'hold' || words[0] === 'release') {
      // A person's command, the same as the deploy tool is for main.
      const [, name, until] = words
      if (name === undefined || words.length > (words[0] === 'hold' ? 3 : 2) || (until !== undefined && until !== 'batch' && until !== 'released')) {
        return { text: words[0] === 'hold' ? 'Usage: /flow hold <target> [batch|released] (default released)' : 'Usage: /flow release <target>' }
      }
      const text = words[0] === 'hold' ? await io.holdTarget(name, until === 'batch' ? 'batch' : 'released', 'user', undefined) : await io.releaseTarget(name)
      await io.refreshBehind()
      return { text }
    }
    if (arg !== '') return { text: `Unknown argument "${arg}". /flow opens the Flow pane, /flow inbox lists the open questions and the decisions agents made, /flow ok keeps decisions, /flow no <id> undoes one, /flow answer <id> <choice> answers a question, /flow checks lists the after-deploy checks that need a person, /flow preflight shows the pre-flight round, /flow close closes it, /flow resume picks up unfinished work, /flow approve <pr> lets the reviewer merge a PR that awaits your approval, /flow push starts the push of the batch the reviewer checked (/flow push back <pr> sends one PR back, /flow push drop returns them all), /flow hold <target> [batch|released] keeps a deploy target from deploying and /flow release <target> lets it, /flow clean lists leftover worktrees and branches (/flow clean --yes removes them).` }
    await io.open()
    return { text: 'Flow pane opened.' }
}
