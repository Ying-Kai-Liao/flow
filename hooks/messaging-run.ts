import type { AgentInfo } from 'claude-code'
import type { Ledger } from '../types'
import { entriesOfBranch } from './cost'
import { MANAGER } from './core'
import { LIVE } from './deliver'
import type { DeliverOptions } from './deliver'
import { ENV_KIND } from './deploy'
import { answerMessage, findItem, isAddressee, isFyi, markAnswered, needsMessage, notesOwner, overridesManager, paneRows } from './inbox'
import type { Inbox, Marked, PaneRow, Question } from './inbox'
import { PUSH_KIND } from './pushgate'
import { backNote } from './routing'
import { ADD_OPTION } from './guardtests'
import { REVIEWER_KIND } from './reviewer-breaker'
import { noteKey } from './state'

// Answering a question and messaging managers. The atoms and the hooks stay in register.tsx; this takes
// closures over them (the engine refuses `$` across an import).
export type MessagingIo = {
  inbox: () => Promise<Inbox>
  withInbox: <T>(fn: (cur: Inbox) => { inbox: Inbox; out: T }) => Promise<T>
  now: () => Promise<number>
  today: () => Promise<string>
  agents: () => Promise<AgentInfo[]>
  // The facts kept for an agent that left the roster, by name.
  seen: () => Promise<Record<string, { id?: string; status: string }>>
  deliver: (id: string, text: string, opts?: DeliverOptions) => Promise<boolean>
  appendNote: (name: string, line: string) => Promise<boolean>
  best: (what: string, fn: () => Promise<void>) => Promise<void>
  toMain: (text: string) => void
  // Marks a manager id as resumable by a message.
  markResumable: (id: string) => void
  managerFinished: (ids: string[], name: string, rows: AgentInfo[]) => Promise<boolean>
  addGuardTest: (options: Record<string, unknown>, glob: string, test: string) => Promise<string>
  onDeployAnswer: (q: Question, answer: string) => Promise<string>
  onEnvAnswer: (q: Question, answer: string) => Promise<string>
  onPushAnswer: (q: Question, answer: string, by: string) => Promise<string>
  onReviewerAnswer: (answer: string, by: string) => Promise<string>
  loadLedger: () => Promise<void>
  ledger: () => Promise<Ledger>
}

// The question as a notes line: an env change names the variable, never its value.
export const noteText = (q: Question): string => (q.env === undefined ? q.question : `env ${q.env.name} on ${q.env.target} (${q.env.role})`)

// The one way a question gets answered: marks it, tells the asker when that is needed, notes the decision.
// choice null takes the question's default. Returns one result line.
// user: the person answering from the pane or a /flow command, who may answer any question, a manager's included.
export async function answerQuestionTo(io: MessagingIo, wanted: string, choice: string | null, by: string, options: Record<string, unknown>, user = false): Promise<string> {
  const at = await io.now()
  // A decision filed before decisions had d-ids is also found by its old q-id.
  const id = findItem(await io.inbox(), wanted)?.id ?? wanted.trim().toLowerCase()
  const marked = await io.withInbox((cur): { inbox: Inbox; out: Marked | { kind: 'escalated'; q: Question } } => {
    // A standing rule made this the user's decision: only main answers it.
    const held = cur.items.find(x => x.id === id)
    if (held !== undefined && held.state === 'open' && held.escalated !== undefined && by !== 'main' && !(held.viaQ !== undefined && isAddressee(held, by))) return { inbox: cur, out: { kind: 'escalated', q: held } }
    const m = markAnswered(cur, id, choice, by, at, undefined, user)
    return { inbox: m.kind === 'ok' ? m.inbox : cur, out: m }
  })
  if (marked.kind === 'escalated') return `${id}: refused, standing rule ${marked.q.escalated} makes this the user's decision. It is in main's inbox as ${id}; main answers it directly and the asker gets the answer. Don't answer or re-ask it.`
  if (marked.kind === 'unknown') return `${id}: no such question.`
  if (marked.kind === 'answered') return `${id}: already answered ("${marked.q.answer ?? ''}" by ${marked.q.answeredBy ?? '?'}).`
  if (marked.kind === 'refused') return `${id}: refused, it is addressed to ${marked.q.addressee}, not ${by}.`
  if (marked.kind === 'empty') return `${id}: refused, the choice is empty.`
  const { q, answer, isDefault } = marked
  // The user over a manager's head: the asker hears "the user", and the manager learns the question is closed.
  const over = user && overridesManager(q)
  const who = over ? 'the user' : by
  const deployNote = q.kind === 'deploy' ? await io.onDeployAnswer(q, answer) : q.kind === ENV_KIND ? await io.onEnvAnswer(q, answer) : q.kind === PUSH_KIND ? await io.onPushAnswer(q, answer, by) : q.kind === REVIEWER_KIND ? await io.onReviewerAnswer(answer, by) : ''
  let delivered = true
  let hint = ''
  if (needsMessage(q, isDefault)) {
    if (!isFyi(q)) {
      delivered = await tellAskerTo(io, q, answerMessage(q, answer, who, isDefault), by)
    } else {
      const alive = (a: AgentInfo | undefined): a is AgentInfo => a !== undefined && (LIVE.has(a.status) || a.status === 'idle')
      const asker = q.askerId === undefined ? undefined : (await io.agents()).find(a => a.id === q.askerId)
      delivered = false
      if (alive(asker)) {
        delivered = await io.deliver(asker.id, answerMessage(q, answer, who, isDefault), { urgent: false, onGone: () => undefined }).catch(() => false)
      } else if (q.addressee !== 'main') {
        // A finished owner cannot act on an undo: its manager (the notes owner) gets it, naming the owner.
        const mgr = (await io.agents()).find(a => a.type === MANAGER && a.name !== undefined && noteKey(a.name) === noteKey(q.addressee) && alive(a))
        if (mgr !== undefined) {
          delivered = await io.deliver(mgr.id, `${answerMessage(q, answer, by, isDefault)} (This was ${q.owner}'s decision; ${q.owner} is no longer running, so act on it yourself or with a new worker.)`, { urgent: false, onGone: () => undefined }).catch(() => false)
        }
      }
    }
    if (!delivered) hint = `; ${q.owner} is gone: main should relay it to ${noteKey(q.owner)}-2`
  }
  await linkedEscalation(io, q, answer, by, at)
  await io.withInbox(cur => ({
    inbox: { ...cur, items: cur.items.map(x => (x.id === id ? { ...x, delivered } : x)) }, out: undefined,
  }))
  if (over) {
    const mgr = (await io.agents()).find(a => a.type === MANAGER && a.name !== undefined && noteKey(a.name) === noteKey(q.addressee) && (LIVE.has(a.status) || a.status === 'idle'))
    if (mgr !== undefined) {
      await io.deliver(mgr.id, `flow: the user answered ${q.id}, which ${q.owner} asked you: ${answer}. It is closed; don't answer it.`, { urgent: false, onGone: () => undefined }).catch(() => false)
    }
  }
  if (!(isFyi(q) && isDefault)) await io.appendNote(notesOwner(q), `- ${await io.today()} decision: "${q.id} ${noteText(q)}: ${isFyi(q) ? `undone, ${answer}` : answer}"`)
  const guard = q.guard !== undefined && answer === ADD_OPTION ? ` ${await io.addGuardTest(options, q.guard.glob, q.guard.test)}` : ''
  return `${id}: ${answer}${isDefault ? ' (default)' : ''}, ${delivered ? 'delivered' : 'undelivered'}${hint}.${guard}${deployNote}`
}

// Where an answer to a question goes: the asker if it runs (or idles); else, for a blocking question, its
// continuation (`name-2`) or the asker itself resumed (it ended its turn to wait, so it is not finished).
// Undefined when it failed, was killed or cannot be found.
async function askerTargetTo(io: MessagingIo, q: Question): Promise<string | undefined> {
  const rows = await io.agents()
  const up = (a: AgentInfo | undefined): a is AgentInfo => a !== undefined && (LIVE.has(a.status) || a.status === 'idle')
  const row = rows.find(a => a.id === q.askerId)
  const status = row?.status
  if (up(row)) return row.id
  const next = rows.find(a => a.id !== q.askerId && a.name !== undefined && a.name !== q.owner && noteKey(a.name) === noteKey(q.owner) && a.type === (q.askerIsManager ? MANAGER : a.type) && up(a))
  if (next !== undefined) return next.id
  if (!q.blocking || q.askerId === undefined) return undefined
  const seen = (await io.seen())[q.owner]
  if (status === undefined ? seen?.status === 'failed' || seen?.status === 'killed' : status !== 'completed') return undefined
  return q.askerId
}

// Tells the asker of a question: wakes one that ended its turn to wait. Text that cannot be delivered, or whose
// send is dropped because the agent ended meanwhile, goes to main (noted for the owner), never nowhere.
// quiet: the answerer is main itself, who sees the result line. True when it reached the asker.
async function tellAskerTo(io: MessagingIo, q: Question, text: string, by: string): Promise<boolean> {
  const toMain = (t: string) => by === 'main' ? Promise.resolve() : tellMainTo(io, notesOwner(q), `${t} (asked by ${q.owner}.)`)
  const id = await askerTargetTo(io, q)
  if (id === undefined) {
    await toMain(text)
    return false
  }
  if (!(await io.agents()).some(a => a.id === id && (LIVE.has(a.status) || a.status === 'idle'))) io.markResumable(id)
  return io.deliver(id, text, { urgent: q.blocking === true, onGone: toMain }).catch(() => false)
}

// A worker's question that its manager escalated (ask with `for`) and the manager's own question are one
// decision: the answer to either closes the other and reaches both askers. A counterpart already answered stays.
async function linkedEscalation(io: MessagingIo, q: Question, answer: string, by: string, at: number): Promise<void> {
  const otherId = q.forQ ?? q.viaQ
  if (otherId === undefined) return
  const other = await io.withInbox((cur): { inbox: Inbox; out: Question | undefined } => {
    const o = cur.items.find(x => x.id === otherId)
    if (o === undefined || o.state !== 'open') return { inbox: cur, out: undefined }
    const done: Question = { ...o, state: 'answered', answer, answeredBy: by, answeredAt: at, delivered: true }
    return { inbox: { ...cur, items: cur.items.map(x => (x.id === otherId ? done : x)) }, out: done }
  })
  if (other === undefined) return
  if (q.forQ !== undefined) {
    // main answered the manager's escalation: the worker hears it as main's answer, via its manager.
    if (needsMessage(other, answer === other.default)) await tellAskerTo(io, other, answerMessage(other, answer, `main (via ${q.owner})`, answer === other.default), by)
  } else if (by === 'main') {
    await tellAskerTo(io, other, `flow: main answered ${q.id}, which your worker ${q.owner} asked and you escalated as ${other.id}: ${answer}. Both are closed; the worker has the answer.`, by)
  } else {
    io.toMain(`${by} answered ${q.id} (${q.owner}'s question) itself: ${answer}. That closes its escalation ${other.id} to you.`)
  }
}

// The pane's inbox rows, read fresh.
export async function paneInboxRowsTo(io: MessagingIo): Promise<{ rows: PaneRow[]; now: number }> {
  const [box, now] = await Promise.all([io.inbox(), io.now()])
  return { rows: paneRows(box), now }
}

// A message for the manager that owns a PR: sent when it is alive, else noted for it and sent to main.
export async function tellManagerTo(io: MessagingIo, name: string, text: string): Promise<void> {
  const live = (await io.agents()).find(a => a.name === name && (LIVE.has(a.status) || a.status === 'idle'))
  // Urgent: tellManager carries push-gate send-backs and report fallbacks, which the manager acts on now.
  // A failed send has already gone through onGone.
  if (live !== undefined) await io.deliver(live.id, text, { urgent: true, onGone: t => tellMainTo(io, name, t) }).catch(() => undefined)
  else {
    const wake = await wakeTargetTo(io, name)
    if (wake !== undefined) {
      io.markResumable(wake)
      await io.deliver(wake, text, { urgent: true, onGone: t => tellMainTo(io, name, t) }).catch(() => undefined)
    } else await tellMainTo(io, name, text)
  }
}

// A manager that ended its turn (completed, or dropped from the roster) but still has work: its id, so a
// message resumes it. Undefined when it is finished, was killed or failed, or its id is not known.
export async function wakeTargetTo(io: MessagingIo, name: string): Promise<string | undefined> {
  const rows = await io.agents()
  const row = rows.find(a => a.name === name && a.type === MANAGER)
  const seen = row === undefined ? (await io.seen())[name] : undefined
  const id = row === undefined ? seen?.id : row.status === 'completed' ? row.id : undefined
  if (id === undefined || seen?.status === 'failed' || seen?.status === 'killed') return undefined
  return (await io.managerFinished([id], name, rows)) ? undefined : id
}

export async function tellMainTo(io: MessagingIo, name: string, text: string): Promise<void> {
  await io.best('noting a report', async () => void (await io.appendNote(name, `- ${await io.today()} ${text}`)))
  io.toMain(`${text} (${name} is not running; relay it or start a manager.)`)
}

// The line a returned PR's message carries when its worker ran below large (routing.ts backNote).
export async function sizeBackNoteTo(io: MessagingIo, branch: string): Promise<string | undefined> {
  try {
    await io.loadLedger()
    return backNote(entriesOfBranch(await io.ledger(), branch), branch)
  } catch {
    return undefined
  }
}
