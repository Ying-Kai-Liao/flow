// The inbox-side tools: ask, fyi, preflight and answer. The engine refuses `$` across an import, so
// register.tsx builds an InboxIo of closures (inboxIoOf) and the atom-backed helpers reach this module that way.
import type { AgentRow } from '../types'
import { MANAGER } from './core'
import type { DeliverOptions } from './deliver'
import { addQuestions, fyiAsked, isFyi, findItem, notesOwner, openFor, parseAsk, parseFyi } from './inbox'
import { followUp, FILE_HELP, parseFiling, recordFiling, renderFollowUp } from './preflight'
import type { Preflight } from './preflight'
import { alwaysRule, autoAnswer, loadRules, recordAutoAnswers } from './standing-run'
import type { AutoHits, StandingIo } from './standing-run'
import { AUTO } from './standing'
import { noteKey } from './state'

export type InboxIo = {
  // The inbox, clock, notes and log closures standing-run.ts already works through.
  standing: StandingIo
  refresh: () => Promise<AgentRow[]>
  deliver: (id: string, text: string, opts?: DeliverOptions) => Promise<boolean>
  toast: (text: string) => void
  ownerNameOf: (id: string | undefined) => Promise<string>
  answerQuestion: (wanted: string, choice: string | null, by: string, options: Record<string, unknown>, user?: boolean) => Promise<string>
  withPreflight: <T>(fn: (cur: Preflight) => { state: Preflight; out: T }) => Promise<T>
  preflightTick: (rows: AgentRow[]) => Promise<void>
  // Fire-and-forget: submit the text as a prompt on the next tick.
  submitLater: (text: string) => void
}

export async function askTool(io: InboxIo, options: Record<string, unknown>, input: Record<string, unknown>, agentId: string | undefined): Promise<{ result: string }> {
  if (agentId === undefined) return { result: 'Refused: main cannot ask; decide, or ask the user in the chat.' }
  const parsed = parseAsk(input)
  if ('error' in parsed) return { result: `Refused, nothing recorded: ${parsed.error}` }
  const rows = await io.refresh()
  const me = rows.find(a => a.id === agentId)
  const name = me?.name ?? (String(input.from ?? '').trim() || 'unknown')
  const parent = me?.parentId === undefined ? undefined : rows.find(a => a.id === me.parentId)
  const addressee = parent !== undefined && parent.type === MANAGER && parent.name !== undefined ? parent.name : 'main'
  const at = await io.standing.now()
  // Standing answers hook: rules are read fresh. A fresh question that one matches is stored, then marked
  // answered in the same write (so it has an id and history); the result line tells the asker.
  const { rules } = await loadRules(io.standing, options)
  const { added, auto } = await io.standing.withInbox(cur => {
    const r = autoAnswer(cur, addQuestions(cur, { name, id: agentId, isManager: me?.type === MANAGER }, addressee, parsed.questions, at), rules, at, true)
    return { inbox: r.inbox, out: { added: r.added, auto: r.hits } }
  })
  await recordAutoAnswers(io.standing, added, auto, name)
  const date = await io.standing.today()
  for (const { q, fresh } of added) {
    const owner = notesOwner(q)
    if (fresh && !auto.has(q.id) && !q.blocking && owner !== 'main') {
      await io.standing.appendNote(owner, `- ${date} progress: assumed ${q.default} for ${q.id}: ${q.question}`)
    }
  }
  const fresh = added.filter(a => a.fresh && !auto.has(a.q.id)).map(a => a.q)
  if (addressee !== 'main' && fresh.length > 0 && parent !== undefined) {
    const lines = fresh.map(q =>
      `${name} asks ${q.id} (${q.blocking ? 'blocking' : 'non-blocking'}): ${q.question} - options ` +
      `${q.options.map((o, i) => `${String.fromCharCode(97 + i)}) ${o}`).join(' ')} (default: ${q.default})` +
      (q.escalated !== undefined ? ` - a standing rule (${q.escalated}) makes this the user's decision; it is in main's inbox as ${q.id}, main answers it directly and the worker gets the answer; don't answer or re-ask it.` : ''))
    await io.deliver(parent.id, `${lines.join('\n')}\nAnswer with mcp__flow__answer.`, { held: !fresh.some(q => q.blocking), urgent: fresh.some(q => q.blocking) }).catch(() => undefined)
  } else if (addressee === 'main' && fresh.some(q => q.blocking)) {
    io.toast(`${name} asks: ${fresh.length} question(s) in /flow inbox`)
  }
  return {
    result: added.map(({ q, fresh: isNew }) => {
      if (!isNew) return `${q.id}: already asked as ${q.id}.`
      const hit = auto.get(q.id)
      if (hit !== undefined) return `${q.id}: answered by standing answer ${hit.rid}: ${hit.answer}. Carry on from it.`
      return q.blocking
        ? `${q.id}: end your turn now; the answer arrives by message.`
        : `${q.id}: proceed on the default (${q.default}), say in your report/PR that you assumed it; you'll get a message if the answer differs.`
    }).join('\n'),
  }
}

export async function fyiTool(io: InboxIo, input: Record<string, unknown>, agentId: string | undefined): Promise<{ result: string }> {
  if (agentId === undefined) return { result: 'Refused: main cannot record a decision; just decide.' }
  const parsed = parseFyi(input)
  if ('error' in parsed) return { result: `Refused, nothing recorded: ${parsed.error}` }
  const rows = await io.refresh()
  const me = rows.find(a => a.id === agentId)
  const name = me?.name ?? (String(input.from ?? '').trim() || 'unknown')
  const parent = me?.parentId === undefined ? undefined : rows.find(a => a.id === me.parentId)
  const addressee = parent !== undefined && parent.type === MANAGER && parent.name !== undefined ? parent.name : 'main'
  const at = await io.standing.now()
  const added = await io.standing.withInbox(cur => {
    const r = addQuestions(cur, { name, id: agentId, isManager: me?.type === MANAGER }, addressee, parsed.items.map(fyiAsked), at, 'fyi')
    return { inbox: r.added.some(a => a.fresh) ? r.inbox : cur, out: r.added }
  })
  // Quiet by design: a log line, no message or toast.
  await io.standing.best('logging a decision', () => io.standing.appendLog({ event: 'fyi', owner: noteKey(name), agent: name, text: added.map(a => a.q.id).join(' ') }))
  return { result: `Recorded ${added.map(a => a.q.id).join(', ')}. Carry on; you get a message only if it is undone.` }
}

export async function preflightTool(io: InboxIo, options: Record<string, unknown>, input: Record<string, unknown>, agentId: string | undefined): Promise<{ result: string }> {
  if (agentId === undefined) return { result: 'Refused: main does not file a pre-flight; it answers the managers\' questions in the round it receives.' }
  const rows = await io.refresh()
  const me = rows.find(a => a.id === agentId)
  if (me?.type !== MANAGER) return { result: 'Refused: only managers file a pre-flight. A worker asks its manager with mcp__flow__ask.' }
  const parsed = parseFiling(input)
  if ('error' in parsed) return { result: `Refused, nothing recorded: ${parsed.error} To file: ${FILE_HELP}.` }
  const name = me.name ?? (String(input.from ?? '').trim() || 'unknown')
  const at = await io.standing.now()
  // Same standing-answer check as ask: a fresh question a rule matches is answered at once, so it is not
  // open, never gates the manager and stays out of the round.
  const { rules } = await loadRules(io.standing, options)
  // A filing is often sent again whole, and an answered question no longer dedupes in addQuestions: one
  // already answered for this manager (by a rule or by main) is reported again, not stored again, so it
  // neither re-gates the manager nor asks the user twice.
  const norm = (t: string) => t.trim().replace(/\s+/g, ' ').toLowerCase()
  const { added, auto, earlier } = parsed.questions.length === 0 ? { added: [], auto: new Map() as AutoHits, earlier: [] as string[] } : await io.standing.withInbox(cur => {
    const before = (text: string) => cur.items.find(x => x.owner === name && x.state === 'answered' && norm(x.question) === norm(text))
    const fresh = parsed.questions.filter(a => before(a.question) === undefined)
    const earlier = parsed.questions.flatMap(a => { const x = before(a.question); return x === undefined ? [] : [`${x.id} already answered${x.answeredBy === AUTO ? ` by standing answer ${x.rule ?? '?'}` : ''}: ${x.answer ?? ''}`] })
    const r = autoAnswer(cur, addQuestions(cur, { name, id: agentId, isManager: true }, 'main', fresh, at), rules, at)
    return { inbox: r.inbox, out: { added: r.added, auto: r.hits, earlier } }
  })
  await recordAutoAnswers(io.standing, added, auto, name)
  const kept = added.filter(a => !auto.has(a.q.id))
  const ids = { asked: kept.map(a => a.q.id), blocking: kept.filter(a => a.q.blocking).map(a => a.q.id) }
  const answered = [...earlier, ...added.filter(a => auto.has(a.q.id)).map(a => `${a.q.id} by standing answer ${auto.get(a.q.id)!.rid}: ${auto.get(a.q.id)!.answer}`)]
  const answeredLine = answered.length > 0 ? ` Answered, carry on from them: ${answered.join('; ')}.` : ''
  const late = await io.withPreflight(cur => {
    const f = followUp(recordFiling(cur, name, parsed.filing, ids, at), name)
    return { state: f.state, out: f.send ? f.state : undefined }
  })
  if (late !== undefined) {
    const text = renderFollowUp(late, await io.standing.inbox(), name, at)
    io.submitLater(text)
  }
  await io.preflightTick(rows)
  return {
    result: ids.blocking.length === 0
      ? `Pre-flight filed. Start your workers now.${answeredLine}${ids.asked.length > 0 ? ` Your non-blocking question(s) ${ids.asked.join(', ')} are with main: go on the defaults, say so in your PRs; you get a message if an answer differs.` : ''}`
      : `Pre-flight filed with blocking question(s) ${ids.blocking.join(', ')}. End your turn now: main answers once for all managers and the answers arrive by message. Then start workers.${answeredLine}`,
  }
}

export async function answerTool(io: InboxIo, options: Record<string, unknown>, input: Record<string, unknown>, agentId: string | undefined): Promise<{ result: string }> {
  const by = agentId === undefined ? 'main' : await io.ownerNameOf(agentId)
  const todo = new Map<string, string | null>()
  const lines: string[] = []
  const always = new Set<string>()
  const answers = Array.isArray(input.answers) ? input.answers as Array<{ id?: unknown; choice?: unknown; always?: unknown }> : []
  for (const a of answers) {
    const id = String(a?.id ?? '').trim()
    if (id === '' || typeof a?.choice !== 'string') {
      lines.push(`${id || '(no id)'}: refused, each answer needs an id and a choice.`)
    } else if (!todo.has(id)) {
      todo.set(id, a.choice)
      if (a.always === true) always.add(id)
    }
  }
  if (input.defaults === true) {
    const ids = Array.isArray(input.ids) ? input.ids.map(String) : undefined
    const open = openFor(await io.standing.inbox(), by).map(q => q.id)
    for (const id of ids ?? open) if (!todo.has(id)) todo.set(id, null)
    if (ids === undefined && open.length === 0 && todo.size === 0) lines.push('No open questions for you.')
  }
  if (todo.size === 0 && lines.length === 0) lines.push('Nothing to answer: pass answers, or defaults: true.')
  for (const [id, choice] of todo) {
    const before = always.has(id) ? findItem(await io.standing.inbox(), id) : undefined
    lines.push(await io.answerQuestion(id, choice, by, options))
    if (always.has(id) && choice !== null && before !== undefined && !isFyi(before)) lines.push(await alwaysRule(io.standing, options, id, choice, agentId === undefined, before))
  }
  return { result: lines.join('\n') }
}
