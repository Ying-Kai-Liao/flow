// Two uses of the decision API (decide.ts) besides sizing, each behind its own setting and default off: keeping a routine
// decision an agent recorded (so main is not woken for it), and advising a manager at a handoff. A provider call needs
// the toggle on and decision_api jev or openai; otherwise nothing is sent. Every call is logged without the key or the
// response body, and a failure of any kind leaves things exactly as they were.
import { decide, DECIDE_TIMEOUT_MS, sourceOf } from './decide'
import type { DecideIo, DecideSettings, Decision, Question as DecideQuestion } from './decide'
import { HANDOFF_QUESTION, INBOX_ROUTINE_QUESTION, textOfHandoff, textOfInbox } from './decide-questions'
import { findItem, isFyi, KEEP } from './inbox'
import type { Question } from './inbox'
import type { StandingIo } from './standing-run'
import { noteKey } from './state'
import type { LogEvent } from '../types'

export type DecideUseSettings = DecideSettings & { decideInbox?: boolean; decideHandoff?: boolean; decideMinConfidence?: number }
export const DECIDE_USE_MIN_CONFIDENCE = 0.8

export const decideActive = (s: DecideUseSettings, feature: 'inbox' | 'handoff'): boolean =>
  (feature === 'inbox' ? s.decideInbox : s.decideHandoff) === true && (s.decisionApi === 'jev' || s.decisionApi === 'openai')

// Only a plain decision an agent recorded and nobody has answered: a question (blocking or not), an env change, a deploy
// approval, a push, a reviewer retry, a person check or a pre-flight question is never the provider's to answer.
export const autoKeepable = (q: Question): boolean =>
  isFyi(q) && q.state === 'open' && !q.blocking && q.guard === undefined && q.env === undefined && q.escalated === undefined && q.forQ === undefined && q.viaQ === undefined

const round2 = (n: number): number => Math.round(n * 100) / 100

// The provider's answer at or over the threshold; a missing confidence can't be checked, so it counts as under.
function confident(d: Decision, s: DecideUseSettings): { answer: string; confidence: number } | undefined {
  if (!('answer' in d) || d.confidence === undefined) return undefined
  return d.confidence >= (s.decideMinConfidence ?? DECIDE_USE_MIN_CONFIDENCE) ? { answer: d.answer, confidence: d.confidence } : undefined
}

type Logged = { feature: 'inbox' | 'handoff'; id: string; owner: string; d: Decision; applied: boolean }
const logEvent = ({ feature, id, owner, d, applied }: Logged): Omit<LogEvent, 'ts'> => ({
  event: 'decide', owner: noteKey(owner), feature, id, applied,
  ...('answer' in d ? { answer: d.answer, ...(d.confidence !== undefined ? { confidence: round2(d.confidence) } : {}) } : { note: d.note }),
})

// minConfidence 0: the provider's answer always comes back, so the log shows it even when it is not applied.
const ask = (net: DecideIo, s: DecideUseSettings, text: string, q: DecideQuestion): Promise<Decision> =>
  decide(net, s, text, q, DECIDE_TIMEOUT_MS, 0).catch((): Decision => ({ note: 'decision api failed' }))

// Asks about each recorded decision on its own; only "keep" with enough confidence marks it kept, and only if it is
// still open and plain when the answer comes back (main or a rule may have answered meanwhile).
export async function autoKeepFyis(net: DecideIo, io: StandingIo, s: DecideUseSettings, ids: string[]): Promise<void> {
  if (!decideActive(s, 'inbox')) return
  await Promise.all(ids.map(async id => {
    const item = findItem(await io.inbox(), id)
    if (item === undefined || !autoKeepable(item)) return
    const d = await ask(net, s, textOfInbox(item), INBOX_ROUTINE_QUESTION)
    const sure = confident(d, s)
    let applied = false
    if (sure?.answer === 'keep') {
      const by = sourceOf(s)
      const at = await io.now()
      const auto = { by, confidence: round2(sure.confidence) }
      applied = await io.withInbox(cur => {
        const q = findItem(cur, id)
        if (q === undefined || !autoKeepable(q)) return { inbox: cur, out: false }
        return { inbox: { ...cur, items: cur.items.map(x => (x.id === q.id ? { ...x, state: 'answered' as const, answer: KEEP, answeredBy: by, answeredAt: at, delivered: true, auto } : x)) }, out: true }
      })
    }
    await io.best('logging a decision api call', () => io.appendLog(logEvent({ feature: 'inbox', id, owner: item.owner, d, applied })))
  }))
}

export type HandoffAsk = { branch: string; owner: string; note: string | undefined; count: number; maxContinues: number }
export type Lean = { answer: 'continue' | 'split'; confidence: number }
// The provider's confident lean at a handoff, or undefined (off, no note, unsure, failed). Advice only.
export async function handoffLean(net: DecideIo, io: Pick<StandingIo, 'appendLog' | 'best'>, s: DecideUseSettings, r: HandoffAsk): Promise<Lean | undefined> {
  if (!decideActive(s, 'handoff') || r.note === undefined || r.note.trim() === '') return undefined
  const d = await ask(net, s, textOfHandoff({ note: r.note, count: r.count, maxContinues: r.maxContinues }), HANDOFF_QUESTION)
  const sure = confident(d, s)
  const lean: Lean | undefined = sure !== undefined && (sure.answer === 'continue' || sure.answer === 'split') ? { answer: sure.answer, confidence: round2(sure.confidence) } : undefined
  // Applied: a split lean is sent as a line, and any lean past max_continues is appended to the split message.
  await io.best('logging a decision api call', () => io.appendLog(logEvent({ feature: 'handoff', id: r.branch, owner: r.owner, d, applied: lean !== undefined && (lean.answer === 'split' || r.count > r.maxContinues) })))
  return lean
}

// Below max_continues a split lean is a line of its own to the manager; a continue lean says nothing.
export const adviceLine = (source: string, branch: string, lean: Lean): string | undefined =>
  lean.answer === 'split' ? `flow: ${source} advises splitting ${branch} (${lean.confidence.toFixed(2)}): its handoff note reads as a lot of work left, or several independent parts. Consider briefs for the remaining parts instead of another plain continuation. Advice only.` : undefined
// Past max_continues the lean is appended to the split message that is sent anyway.
export const adviceSuffix = (source: string, lean: Lean): string => ` (${source}: ${lean.answer} ${lean.confidence.toFixed(2)})`
