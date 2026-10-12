// The ask_cards setting: main's messages tell it to put blocking items in front of the user with its own
// AskUserQuestion tool (clickable options plus "Other"). The plugin cannot open that picker; only the text differs.

import type { Inbox } from './inbox'

export const cardsOn = (options: Record<string, unknown>) => options.ask_cards !== 'off'

// One instruction for every message, so main reads the same words each time.
export const CARDS_TEXT = [
  'Ask the user with AskUserQuestion for the blocking items (and for env/deploy/push/reviewer items), at most 4 per call, picked by priority (deploy/env/blocking first, oldest first).',
  'Per card: header = the owner or a short label (max 12 chars); question = the full question with its context; options = the item\'s options, default first, its label ending in " (Recommended)" (env/deploy/push/reviewer items get no Recommended mark).',
  'An item with more than 4 options or a very long context stays as text.',
  'Turn the picks into ONE mcp__flow__answer call; an "Other" free-text answer goes in quoted as the choice.',
  'Never answer env/deploy/push/reviewer items with defaults.',
  'If more than 4 are open, say how many remain and pop the next ones after the answer.',
  'Non-blocking questions and decisions are not popped: they stay in the text list and the inbox.',
].join(' ')

// The short message main gets when an item for the user is created.
export const cardsNotice = (what: string, ids: string[]) => `${what} (${ids.join(', ')}). ${CARDS_TEXT}`

// What sendCards needs from the engine: whether the Flow pane is up, which of the ids are still open, and the send.
export const openOf = (ib: Inbox, ids: string[]) => ids.filter(id => ib.items.find(x => x.id === id)?.state === 'open')

export interface CardsIo {
  paneOpen: () => Promise<boolean>
  openIds: (ids: string[]) => Promise<string[]>
  send: (text: string) => void
}

// Sends the cards notice only when it still helps: the Flow pane shows every open inbox item (blocking, env, deploy),
// so with it up a second card in Claude Code would only go stale when the user answers in the pane. Pane closed or
// the probe failing: send (never lose the prompt), for the ids still open right now.
export async function sendCards(io: CardsIo, options: Record<string, unknown>, what: (n: number) => string, ids: string[]): Promise<void> {
  if (!cardsOn(options)) return
  if (await io.paneOpen().catch(() => false)) return
  const open = await io.openIds(ids).catch(() => ids)
  if (open.length > 0) io.send(cardsNotice(what(open.length), open))
}

// Appended to a manager's report whose last line is a question.
export const REPORT_HINT = 'If it has clear choices, ask the user with AskUserQuestion, then relay the pick to the manager with SendMessage.'

export const lastLineAsks = (report: string) => (report.trim().split('\n').pop() ?? '').trim().endsWith('?')
