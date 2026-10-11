// The /flow init demo: a scripted replay of one task going through flow, drawn in the Flow pane from canned
// state. No agent is started, no model is called, nothing touches git, and the state lives in one atom of its
// own, so a demo row can never mix with real work. Pure: register.tsx owns the atom and the timers.

import type { Inbox, Question } from './inbox'
import { parseChoice } from './inbox'

export type DemoRole = 'main' | 'manager' | 'worker' | 'reviewer'
export type DemoRow = { name: string; role: DemoRole; status: 'running' | 'idle' | 'completed'; doing: string; depth: number }
type Ask = { id: string; kind?: 'fyi'; owner: string; question: string; options: string[]; default: string; blocking: boolean; context: string; topic?: string }
export type DemoStep = {
  title: string
  // What the viewer is told this step shows, in plain words.
  say: string
  rows: DemoRow[]
  // Extra lines under the cards (a handover, the reviewer's checks).
  notes?: string[]
  // Waits for the viewer's answer instead of the timer.
  ask?: Ask
  // How long the step stays before the replay moves on by itself (ms); absent: until the viewer presses next.
  autoMs?: number
}

const MAIN: DemoRow = { name: 'main', role: 'main', status: 'idle', doing: 'you talk to it', depth: 0 }
const mgr = (status: DemoRow['status'], doing: string): DemoRow => ({ name: 'flow-demo', role: 'manager', status, doing, depth: 1 })
const wrk = (status: DemoRow['status'], doing: string): DemoRow => ({ name: 'flow-demo-hello', role: 'worker', status, doing, depth: 2 })
const rev = (status: DemoRow['status'], doing: string): DemoRow => ({ name: 'reviewer', role: 'reviewer', status, doing, depth: 1 })

export const STEPS: DemoStep[] = [
  { title: 'You hand over a task', say: 'You ask main for work. Main starts one manager per task. Here: "add a hello file".', rows: [{ ...MAIN, status: 'running', doing: 'starting a manager for your task' }], autoMs: 4000 },
  { title: 'Pre-flight', say: 'The manager reads the code first and asks everything it needs in one round, so you can walk away afterwards.', rows: [MAIN, mgr('running', 'pre-flight: reading the code')], notes: ['Pre-flight: nothing to ask this time'], autoMs: 4000 },
  {
    title: 'A question for you', say: 'A question waits for you. Answer it here: press a number, or the button. In real use it also appears in the pane tree, as a notification and in /flow inbox.',
    rows: [MAIN, mgr('idle', 'asks you a question'), wrk('idle', 'waiting for the manager')],
    ask: { id: 'q1', owner: 'flow-demo', question: 'What should flow-demo.md say?', options: ['Hello from flow', 'Hi there'], default: 'Hello from flow', blocking: true, context: 'Demo question. Your answer only moves the replay on.' },
  },
  { title: 'The worker builds', say: 'The manager starts a worker. The worker builds in its own git worktree, so your checkout is never touched.', rows: [MAIN, mgr('running', 'watching its worker'), wrk('running', 'editing flow-demo.md')], notes: ['worktree: .claude/worktrees/flow-demo-hello (branch flow/flow-demo-hello)'], autoMs: 4500 },
  {
    title: 'A decision it took itself', say: 'Small choices do not block anyone. The agent decides, logs it, and you can keep it or undo it. Press y to keep, n to undo.',
    rows: [MAIN, mgr('running', 'watching its worker'), wrk('running', 'running the tests')],
    ask: { id: 'd1', kind: 'fyi', owner: 'flow-demo-hello', question: 'Used the small worker model for this one-line change', options: ['Keep', 'Undo'], default: 'Keep', blocking: false, context: 'A one-line file does not need a big model. Demo decision: nothing changes either way.', topic: 'worker-size' },
  },
  { title: 'The PR is handed over', say: 'The worker opens a PR; the manager reviews it and hands it to the reviewer with the proof of how it was checked.', rows: [MAIN, mgr('running', 'handing PR #1 to the reviewer'), wrk('completed', 'opened PR #1'), rev('idle', 'a handover arrived')], notes: ['PR #1 "Add flow-demo.md" (demo): Verification: Ran npm test: pass'], autoMs: 4500 },
  { title: 'The reviewer merges', say: 'The reviewer merges, runs your full check once per batch, cuts the release and deploys, if you set those up. With merge_mode "confirm" it would wait for /flow approve 1.', rows: [MAIN, mgr('idle', 'waiting for the reviewer'), wrk('completed', 'opened PR #1'), rev('running', 'merging, then the full check')], notes: ['merge: ok', 'full check: pass', 'release: off', 'deploy: none configured'], autoMs: 5000 },
  { title: 'The report', say: 'You get one report per task. That was the whole loop. Nothing here was real: no agents ran, no tokens were used, nothing was written.', rows: [{ ...MAIN, status: 'running', doing: 'reports back to you' }, mgr('completed', 'done'), wrk('completed', 'done'), rev('completed', 'merged PR #1')], notes: ['Report: flow-demo is done: PR #1 merged.', 'Next: /flow init settings to set your commands, or /flow init demo live to run this for real (uses tokens).'] },
]

export type DemoState = { step: number; answers: Record<string, string>; askedAt: Record<string, number>; gen: number; startedAt: number }

export const startDemo = (gen: number, now: number): DemoState => ({ step: 0, answers: {}, askedAt: {}, gen, startedAt: now })
export const stepOf = (s: DemoState): DemoStep => STEPS[Math.min(s.step, STEPS.length - 1)]!
export const isLast = (s: DemoState): boolean => s.step >= STEPS.length - 1
// A step with a question waits for the answer; the last step has nowhere to go.
export const canAdvance = (s: DemoState): boolean => !isLast(s) && (stepOf(s).ask === undefined || s.answers[stepOf(s).ask!.id] !== undefined)

export function advance(s: DemoState, now: number): DemoState {
  if (!canAdvance(s)) return s
  const step = s.step + 1
  const ask = STEPS[step]?.ask
  return { ...s, step, askedAt: ask === undefined ? s.askedAt : { ...s.askedAt, [ask.id]: now } }
}

// The viewer answers the open question (choice null: its default). Answering moves the replay on.
export function answer(s: DemoState, id: string, choice: string | null, now: number): { state: DemoState; text: string } {
  const ask = stepOf(s).ask
  if (ask === undefined || ask.id !== id) return { state: s, text: `${id} is not open in the demo.` }
  if (s.answers[id] !== undefined) return { state: s, text: `${id} is already answered.` }
  const text = choice === null ? ask.default : parseChoice(ask.options, choice).text
  const answered = { ...s, answers: { ...s.answers, [id]: text } }
  return { state: advance(answered, now), text: `${id}: ${text}. The replay moves on.` }
}

// The demo's inbox: the asks so far, in the shape the real inbox card draws. Ids are the demo's own.
export function inboxOf(s: DemoState, now: number): Inbox {
  const items: Question[] = []
  for (const st of STEPS.slice(0, s.step + 1)) {
    const a = st.ask
    if (a === undefined) continue
    const got = s.answers[a.id]
    items.push({
      id: a.id, owner: a.owner, addressee: 'main', question: a.question, options: a.options, default: a.default, blocking: a.blocking, context: `DEMO: ${a.context}`,
      ...(a.topic !== undefined ? { topic: a.topic } : {}), ...(a.kind === 'fyi' ? { kind: 'fyi' as const } : {}),
      askedAt: s.askedAt[a.id] ?? now, state: got === undefined ? 'open' : 'answered', ...(got !== undefined ? { answer: got, answeredBy: 'user', answeredAt: now } : {}),
      delivered: true, askerIsManager: false,
    })
  }
  return { next: 2, items }
}

// The question the viewer can answer right now, if any.
export const openAsk = (s: DemoState): Ask | undefined => {
  const a = stepOf(s).ask
  return a !== undefined && s.answers[a.id] === undefined ? a : undefined
}
