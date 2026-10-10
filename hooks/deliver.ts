// Message delivery to agents. A message to an idle agent starts a new turn, and when the prompt
// cache (5 minutes) has expired that turn re-writes the whole context at full price. So a running
// agent gets a message at once, an idle one gets messages that arrive close together as ONE wake-up,
// and a message that needs no action yet (a non-blocking ask) waits for the agent's next turn.
// The queue is in memory: a plugin reload loses it.

import type { EngineInterface } from 'claude-code'

// How long an idle agent's first queued message waits for company.
export const WINDOW_MS = 8_000
// The longest a held message waits when nothing else wakes the agent.
export const HOLD_CAP_MS = 600_000

export type DeliverOptions = {
  // Flush the queue with this text at once, even if the agent is idle.
  urgent?: boolean
  // Do not wake an idle agent for this text: wait for the next delivery, its next turn or the cap.
  held?: boolean
  // Where the text goes when the agent has ended by the time it is flushed (default: main).
  onGone?: (text: string) => void | Promise<void>
}

type Item = { text: string; held: boolean; onGone?: DeliverOptions['onGone'] }
type Queue = { items: Item[]; timer: number; generation: number }

const queues = new Map<string, Queue>()
let generation = 0
let toMain: (text: string) => void = () => undefined

export const resetDelivery = (main: (text: string) => void): void => {
  queues.clear()
  toMain = main
}

const ENDED = new Set(['completed', 'failed', 'killed'])

// The joined text of the queue: arrival order, identical texts once, a blank line between.
const joined = (items: Item[]): string => [...new Set(items.map(i => i.text))].join('\n\n')

async function statusOf($: EngineInterface, id: string): Promise<string | undefined> {
  return (await $.agent.list()).find(a => a.id === id)?.status
}

// Send a text now; false when the agent is gone or the send fails.
const sendNow = ($: EngineInterface, id: string, text: string): Promise<boolean> =>
  $.session.send({ to: { agentId: id }, text }).then(() => true, () => false)

// The agent is gone: each item goes to its own fallback, else to main with the target named.
async function gone(id: string, items: Item[]): Promise<void> {
  for (const i of items) {
    if (i.onGone !== undefined) await i.onGone(i.text)
    else toMain(`${i.text} (${id} ended before this was delivered.)`)
  }
}

// Send everything queued for an agent as one message. A no-op when nothing is queued.
export async function flushAgent($: EngineInterface, id: string): Promise<void> {
  const q = queues.get(id)
  if (q === undefined || q.items.length === 0) return
  queues.delete(id)
  const status = await statusOf($, id).catch(() => undefined)
  if (status === undefined || ENDED.has(status) || !(await sendNow($, id, joined(q.items)))) await gone(id, q.items)
}

// Arm the flush timer: the window when something is not held, else the cap. A shorter deadline
// replaces a longer one; the stale timer sees its generation changed and does nothing.
function arm($: EngineInterface, id: string, q: Queue): void {
  const ms = q.items.some(i => !i.held) ? WINDOW_MS : HOLD_CAP_MS
  const g = ++generation
  q.generation = g
  q.timer = ms
  $.clock.after(ms, () => {
    if (queues.get(id)?.generation === g) void flushAgent($, id)
  })
}

export async function deliver($: EngineInterface, id: string, text: string, opts: DeliverOptions = {}): Promise<boolean> {
  const status = await statusOf($, id).catch(() => undefined)
  if (status === undefined || ENDED.has(status)) {
    // Not a live target: whatever was queued for it and this text fall back together.
    const q = queues.get(id)
    queues.delete(id)
    await gone(id, [...(q?.items ?? []), { text, held: false, onGone: opts.onGone }])
    return false
  }
  const q = queues.get(id)
  const item: Item = { text, held: opts.held === true, onGone: opts.onGone }
  if (status !== 'idle' || opts.urgent === true) {
    // Running (or urgent): the agent takes everything queued for it now, with this text last.
    queues.delete(id)
    const sent = await sendNow($, id, joined([...(q?.items ?? []), item]))
    if (!sent) await gone(id, [...(q?.items ?? []), item])
    return sent
  }
  const queue: Queue = q ?? { items: [], timer: 0, generation: 0 }
  queues.set(id, queue)
  if (!queue.items.some(i => i.text === text)) queue.items.push(item)
  // A held text must not shorten the wait of a queue that already has a window running.
  if (queue.generation === 0 || (!item.held && queue.timer === HOLD_CAP_MS)) arm($, id, queue)
  return true
}

// The agent starts a turn: held texts ride along while it is running. Sent as one message.
export const onAgentTurn = flushAgent
