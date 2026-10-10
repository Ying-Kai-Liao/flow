// Message delivery to agents. A message to an idle agent starts a new turn, and when the prompt
// cache (5 minutes) has expired that turn re-writes the whole context at full price. So a running
// agent gets a message at once, an idle one gets messages that arrive close together as ONE wake-up,
// and a message that needs no action yet (a non-blocking ask) waits for the agent's next turn.
// The queue is in memory: a plugin reload loses it.

// The engine handle `$` is never passed across an import, so the caller hands in these calls.
export type DeliverIo = {
  // The agent's status; undefined when it is not on the roster; throws when the roster cannot be read.
  status: (id: string) => Promise<string | undefined>
  // Throws when the agent is gone or the session refuses the message.
  send: (id: string, text: string) => Promise<void>
  after: (ms: number, fn: () => void) => void
  // The name to show in a fallback text; the id is used when absent.
  name?: (id: string) => Promise<string | undefined>
}

export const ENDED = new Set(['completed', 'failed', 'killed'])
export const LIVE = new Set(['pending', 'running', 'waiting'])

// How long an idle agent's first queued message waits for company.
export const WINDOW_MS = 8_000
// The longest a held message waits when nothing else wakes the agent.
export const HOLD_CAP_MS = 600_000
// How long a queue held for a reviewer's message waits if that message never lands.
export const REVIEWER_HOLD_MS = 60_000

export type DeliverOptions = {
  // Flush the queue with this text at once, even if the agent is idle.
  urgent?: boolean
  // Do not wake an idle agent for this text: wait for the next delivery, its next turn or the cap.
  held?: boolean
  // Where the text goes when the agent has ended by the time it is flushed (default: main).
  onGone?: (text: string) => void | Promise<void>
}

type Item = { text: string; held: boolean; onGone?: DeliverOptions['onGone'] }
// refused: a send of this queue was refused while the agent was not ended; the next cap flush is final.
type Queue = { items: Item[]; windowMs: number; generation: number; refused?: boolean }

const queues = new Map<string, Queue>()
let generation = 0
let toMain: (text: string) => void = () => undefined

export const resetDelivery = (main: (text: string) => void): void => {
  queues.clear()
  toMain = main
}

// The joined text of the queue: arrival order, identical texts once, a blank line between.
const joined = (items: Item[]): string => [...new Set(items.map(i => i.text))].join('\n\n')

// An unreadable roster is not an ended agent: 'unknown' is sent to now, and the send says if it is gone.
const statusOf = (io: DeliverIo, id: string): Promise<string | undefined> => io.status(id).catch(() => 'unknown')

// Send a text now; false when the agent is gone or the send fails.
const sendNow = (io: DeliverIo, id: string, text: string): Promise<boolean> =>
  io.send(id, text).then(() => true, () => false)

// The agent is gone, or kept refusing: each item goes to its own fallback, else to main with the target named.
async function gone(io: DeliverIo, id: string, items: Item[], why: 'ended' | 'refused' = 'ended'): Promise<void> {
  const name = (await io.name?.(id).catch(() => undefined)) ?? id
  for (const i of items) {
    if (i.onGone !== undefined) await i.onGone(i.text)
    else toMain(why === 'ended' ? `${i.text} (${name} ended before this was delivered.)` : `${i.text} (This could not be delivered to ${name}: it kept refusing the message.)`)
  }
}

// Put refused items back, ahead of anything queued since, as held: they go out on the agent's next
// turn or delivery, and at the cap timer at the latest.
function requeue(io: DeliverIo, id: string, items: Item[]): void {
  const q = queues.get(id) ?? { items: [], windowMs: 0, generation: 0 }
  queues.set(id, q)
  const seen = new Set<string>()
  q.items = [...items, ...q.items].filter(i => !seen.has(i.text) && seen.add(i.text))
  for (const i of q.items) i.held = true
  q.refused = true
  arm(io, id, q, HOLD_CAP_MS)
}

// Send items as one message. A refusal by an agent that has not ended is not a gone agent (the host
// refuses one waiting between turns): the items are re-queued, or fall back when this was the final
// try. True when sent or re-queued; false when the items went to their fallbacks.
async function sendItems(io: DeliverIo, id: string, items: Item[], final = false): Promise<boolean> {
  if (await sendNow(io, id, joined(items))) return true
  const status = await statusOf(io, id)
  if (status === undefined || ENDED.has(status)) await gone(io, id, items)
  else if (final) await gone(io, id, items, 'refused')
  else {
    requeue(io, id, items)
    return true
  }
  return false
}

// Send everything queued for an agent as one message. A no-op when nothing is queued.
// The cap timer passes capTimer: a queue that was refused before and is refused again falls back.
export async function flushAgent(io: DeliverIo, id: string, capTimer = false): Promise<void> {
  const q = queues.get(id)
  if (q === undefined || q.items.length === 0) return
  queues.delete(id)
  const status = await statusOf(io, id)
  if (status === undefined || ENDED.has(status)) await gone(io, id, q.items)
  else await sendItems(io, id, q.items, capTimer && q.refused === true)
}

// Arm the flush timer: the window when something is not held, else the cap. A shorter deadline
// replaces a longer one; the stale timer sees its generation changed and does nothing.
function arm(io: DeliverIo, id: string, q: Queue, ms: number): void {
  const g = ++generation
  q.generation = g
  q.windowMs = ms
  io.after(ms, () => {
    if (queues.get(id)?.generation === g) void flushAgent(io, id, true)
  })
}

// True when the text was sent or is queued, also re-queued after a refusal (it goes out later); false when the
// agent is gone. A caller that must know about a refusal reads it from its io (see sendWrapUp).
export async function deliver(io: DeliverIo, id: string, text: string, opts: DeliverOptions = {}): Promise<boolean> {
  const status = await statusOf(io, id)
  if (status === undefined || ENDED.has(status)) {
    // Not a live target: whatever was queued for it and this text fall back together.
    const q = queues.get(id)
    queues.delete(id)
    await gone(io, id, [...(q?.items ?? []), { text, held: false, onGone: opts.onGone }])
    return false
  }
  const q = queues.get(id)
  const item: Item = { text, held: opts.held === true, onGone: opts.onGone }
  if (status !== 'idle' || opts.urgent === true) {
    // Running (or urgent): the agent takes everything queued for it now, with this text last.
    queues.delete(id)
    return sendItems(io, id, [...(q?.items ?? []), item])
  }
  const queue: Queue = q ?? { items: [], windowMs: 0, generation: 0 }
  queues.set(id, queue)
  if (!queue.items.some(i => i.text === text)) queue.items.push(item)
  // A held text must not shorten the wait of a queue that already has a window running.
  if (queue.generation === 0 || (!item.held && queue.windowMs > WINDOW_MS)) arm(io, id, queue, item.held ? HOLD_CAP_MS : WINDOW_MS)
  return true
}

// A reviewer's message to this agent is about to land and will start its turn: what is queued waits
// for that turn (flushAgent on its first step) instead of waking the agent a second time. The short
// timer sends it anyway if the message never lands.
export function holdForReviewer(io: DeliverIo, id: string): void {
  const q = queues.get(id)
  if (q === undefined || q.items.length === 0) return
  for (const i of q.items) i.held = true
  arm(io, id, q, REVIEWER_HOLD_MS)
}
