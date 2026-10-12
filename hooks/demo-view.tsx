import type { AgentRow } from '../types'
import { cardView } from './pane-view'
import type { Els, InboxCtx } from './pane-view'
import { inboxOf, isLast, openAsk, stepOf, STEPS } from './demo-replay'
import type { DemoState } from './demo-replay'
import { GLYPH, COLOR } from './pane'

// The pane while the /flow init replay runs. Nothing here is real: the rows are canned, and the open question is
// drawn with the inbox's own large card (pane-view cardView) over a demo-only inbox, so its keys are the real ones.
export type DemoCtx = {
  els: Els
  Input: InboxCtx['Input']
  rows: number
  state: DemoState
  now: number
  draft: string
  note: string
  io: {
    setDraft: (v: string) => Promise<unknown>
    setNote: (v: string) => Promise<unknown>
    answer: (id: string, choice: string | null) => Promise<string>
    toast: (text: string) => void
    focus: (key: string) => Promise<unknown>
    advance: () => Promise<void>
    stop: () => Promise<void>
  }
}

export function demoView(c: DemoCtx) {
  const { Box, Text, Button } = c.els
  const step = stepOf(c.state)
  const ask = openAsk(c.state)
  const list: AgentRow[] = step.rows.map(r => ({ id: r.name, name: r.name, description: r.doing, type: `flow:${r.role}`, status: r.status === 'idle' ? 'waiting' : r.status }))
  const head = (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text bold color="warning">DEMO</Text>
        <Text dimColor>a replay: no agents run, no tokens are used, nothing is written</Text>
      </Box>
      <Text bold>Step {c.state.step + 1}/{STEPS.length}: {step.title}</Text>
      <Text>{step.say}</Text>
    </Box>
  )
  const stop = <Button key="demo-stop" plain dimColor hotkey="x" onPress={() => void c.io.stop()}>x stop the demo</Button>
  if (ask !== undefined) {
    const ictx: InboxCtx = {
      els: c.els, Input: c.Input, rows: Math.max(8, c.rows - 6), columns: 80, ibox: inboxOf(c.state, c.now), icur: ask.id, draft: c.draft, note: c.note, irows: [], iopen: {}, list, now: c.now, from: 'tree',
      io: {
        acted: async () => undefined, rows: async () => [], readInbox: async () => inboxOf(c.state, c.now), readCursor: async () => ask.id, setCursor: async () => undefined,
        readDraft: async () => c.draft, setDraft: c.io.setDraft, setNote: c.io.setNote, answer: c.io.answer, serial: fn => fn(), toast: c.io.toast, focus: c.io.focus,
        back: async () => undefined, open: async () => undefined, leave: async () => undefined, toggleFold: async () => undefined, toggleItem: async () => undefined,
      },
    }
    return (
      <Box flexDirection="column" height={c.rows}>
        {head}
        {cardView({ ...ictx, id: ask.id })}
        <Box flexDirection="row" gap={1}>{stop}<Text dimColor>esc home</Text></Box>
      </Box>
    )
  }
  return (
    <Box flexDirection="column" height={c.rows}>
      {head}
      <Text> </Text>
      {step.rows.map(r => (
        <Box key={`demo-${r.name}`} paddingLeft={r.depth * 2}>
          <Text>
            <Text color={COLOR[r.status === 'idle' ? 'waiting' : r.status]}>{GLYPH[r.status === 'idle' ? 'waiting' : r.status] ?? '?'}</Text> <Text bold>{r.name}</Text>
            <Text dimColor>  {r.role}  </Text>{r.doing}
          </Text>
        </Box>
      ))}
      {(step.notes ?? []).length > 0 && <Text> </Text>}
      {(step.notes ?? []).map((n, i) => <Text key={`demo-note-${i}`} dimColor>{n}</Text>)}
      <Box flexGrow={1} />
      <Box flexDirection="row" gap={1}>
        {!isLast(c.state) && <Button key="demo-next" plain dimColor hotkey="m" onPress={() => void c.io.advance()}>m next</Button>}
        {stop}
        <Text dimColor>esc home</Text>
      </Box>
    </Box>
  )
}
