// The ask_cards setting: main's messages tell it to put blocking items in front of the user with its own
// AskUserQuestion tool (clickable options plus "Other"). The plugin cannot open that picker; only the text differs.

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

// Appended to a manager's report whose last line is a question.
export const REPORT_HINT = 'If it has clear choices, ask the user with AskUserQuestion, then relay the pick to the manager with SendMessage.'

export const lastLineAsks = (report: string) => (report.trim().split('\n').pop() ?? '').trim().endsWith('?')
