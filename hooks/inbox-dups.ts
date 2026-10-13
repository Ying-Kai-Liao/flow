import { noteKey } from './state'
import { normTopic, optionSet } from './standing'
import type { Inbox, Question } from '../types'

// Duplicate question groups: the same question asked by several managers is shown to the user once, and one
// answer answers every open member. Display and answer fan-out only: a later question is never answered from
// an earlier answer (that is what a standing rule is for). Pure; no import from inbox.ts (it imports this).

const lower = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()

// Only an ordinary open question for main can be grouped. Deploy, env, push and reviewer items, guard
// suggestions, escalated ones and the two halves of an escalation are always the user's one by one.
const groupable = (q: Question): boolean =>
  q.state === 'open' && (q.kind === undefined || q.kind === 'question') && noteKey(q.addressee) === 'main' &&
  q.guard === undefined && q.escalated === undefined && q.forQ === undefined && q.viaQ === undefined && Array.isArray(q.options)

// Same normalized topic and option set; with no topic, the same normalized text and option set.
const keyOf = (q: Question): string => {
  const topic = typeof q.topic === 'string' ? normTopic(q.topic) : ''
  return `${topic !== '' ? `t:${topic}` : `x:${lower(q.question)}`}|${optionSet(q.options)}`
}

const num = (id: string) => Number(/\d+/.exec(id)?.[0] ?? 0)

// Each group: two or more open questions of different owners, first-asked first. An owner's second item of
// the same key is not a member (the same asker is addressed by addQuestions' own dedupe, not here).
export function dupGroups(items: Question[]): Question[][] {
  const buckets = new Map<string, Question[]>()
  for (const q of [...items].filter(groupable).sort((a, b) => a.askedAt - b.askedAt || num(a.id) - num(b.id))) {
    const k = keyOf(q)
    const b = buckets.get(k) ?? []
    if (!b.some(m => noteKey(m.owner) === noteKey(q.owner))) b.push(q)
    buckets.set(k, b)
  }
  return [...buckets.values()].filter(b => b.length >= 2)
}

// The group an open question belongs to (itself included), or [] when it is in none.
export const dupGroupOf = (inbox: Inbox | undefined, id: string): Question[] =>
  dupGroups(inbox?.items ?? []).find(g => g.some(m => m.id === id || m.alias === id)) ?? []

// The ids of the members after the first: rows a view leaves out.
export const dupHidden = (items: Question[]): Set<string> => new Set(dupGroups(items).flatMap(g => g.slice(1).map(m => m.id)))

// first-asked id -> its group, for views that draw the group as the first member's row.
export const dupHeads = (items: Question[]): Map<string, Question[]> => new Map(dupGroups(items).map(g => [g[0]!.id, g]))

export const dupMark = (g: Question[]): string => `x${g.length}`
export const dupAskers = (g: Question[]): string => g.map(m => m.owner).join(', ')
