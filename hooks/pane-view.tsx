import type { EngineInterface } from 'claude-code'

import type { Activity, AgentRow, Limit } from '../types'
import { shimmerParts } from './shimmer'
import { asksQuestion } from './dag'
import { ENDED } from './deliver'
import { cells, elapsed, labelOf, limitTokens, meterColor, METER_CELLS, tokensDown } from './meter'
import { COLOR, GLYPH, handoffOf, handoffText, ROLE } from './pane'
import { runsOutIn } from './sessions'
import type { WarnSettings } from './settings'

// The pane's builders. The render hook resolves the elements and passes them in as plain values,
// with closures for every action: `$` never crosses this import.
export type Els = Pick<ReturnType<EngineInterface['ui']['resolve']>, 'Box' | 'Text' | 'Button'>
export type Usage = { percent: number; tokens: number; window: number }

// Theme keys only: the filled part is legible on any background, the empty cells are 'inactive'
// rather than dim, and the colour turns at the warn and danger marks.
export function meter(
  { Text }: Els, settings: WarnSettings, warnOf: (window: number) => number,
  u: Usage | undefined, dim: boolean, time: string,
) {
  // Time and tokens sit dimmed together after the bar; the window figures are not repeated.
  const tail = [time, u === undefined ? '' : tokensDown(u.tokens)].filter(Boolean).join(' · ')
  return u === undefined
    ? <Text dimColor>context ?{tail ? `   ${tail}` : ''}</Text>
    : <Text dimColor={dim}>
      {cells(u.percent, warnOf(u.window)).map((c, i) => (
        <Text key={String(i)} dimColor={dim} color={c.kind === 'empty' ? 'inactive' : c.kind === 'mark' ? 'text' : meterColor(u.percent, warnOf(u.window)) ?? 'success'}>{c.ch}</Text>
      ))}
      <Text color={meterColor(u.percent, warnOf(u.window))} dimColor={dim}> {u.percent}%</Text>
      {limitTokens(settings, u.window) !== undefined && <Text dimColor> · {limitTokens(settings, u.window)}│</Text>}
      <Text dimColor>{tail ? `   ${tail}` : ''}</Text>
    </Text>
}

// Quota left per window: the share left as a bar that turns at 40% and 20%, the reset, and when
// the pace runs it out.
export function limitLine({ Text }: Els, t: number, l: Limit) {
  const left = Math.max(0, Math.min(100, Math.round(100 - l.used)))
  const tone = left <= 20 ? 'error' : left <= 40 ? 'warning' : 'success'
  const filled = left > 0 ? Math.max(1, Math.round(left / 100 * METER_CELLS)) : 0
  const out = runsOutIn(l, t)
  return (
    <Text key={`lim-${l.tool}-${l.label}`} wrap="truncate-end">
      <Text dimColor>{`${l.tool} ${l.label}`.padEnd(12)}</Text>
      <Text color={tone}>{'█'.repeat(filled)}</Text><Text color="inactive">{'░'.repeat(METER_CELLS - filled)}</Text>
      <Text color={tone}> {left}% left</Text>
      {l.resetsAt !== undefined && l.resetsAt > t && <Text dimColor> · resets in {elapsed(l.resetsAt - t)}</Text>}
      {out !== undefined && <Text color={out < 3600_000 ? 'error' : 'warning'}> · empty in {elapsed(out)} at this pace</Text>}
    </Text>
  )
}

// What card needs from the render hook: plain data and closures (the handlers call `$` there).
export type CardCtx = {
  els: Els
  list: AgentRow[]
  acts: Record<string, Activity>
  askers: string[]
  decisionPhrases: string[]
  t: number
  usageOf: (a: AgentRow) => Usage | undefined
  warnOf: (window: number) => number
  meter: (u: Usage | undefined, dim: boolean, time: string) => ReturnType<typeof meter>
  runTime: (act: Activity | undefined, isEnded: boolean) => string
  toggleFold: (a: AgentRow, shown: boolean) => Promise<void>
  open: (id: string) => Promise<void>
}

// One agent: a card (name, what it does, meter), or one compact row when the pane is short.
// Only a top-level card has a border; deeper ones read as a tree by their indent.
// `collapsed` undefined draws no chevron (the detail view's cards).
export function card(c: CardCtx, a: AgentRow, depth: number, full: boolean, bordered: boolean, hot = false, collapsed?: boolean) {
  const { Box, Text, Button } = c.els
  const { list, acts, t } = c
  const asksOf = (x: AgentRow) => asksQuestion(acts[x.id]?.answer, c.decisionPhrases) && !['running', 'pending'].includes(x.status)
  const act = acts[a.id]
  const hand = handoffOf(a, act)
  const dim = ENDED.has(a.status) && hand?.kind !== 'done'
  const asks = (asksQuestion(act?.answer, c.decisionPhrases) || c.askers.includes(a.name ?? '')) && !['running', 'pending'].includes(a.status)
  const doing = asks ? 'asks: ' + (act?.answer ?? '').trim().split('\n').pop() : act?.doing
  const u = c.usageOf(a)
  const under = list.filter(x => x.parentId === a.id).length
  // What a collapsed card hides that needs a person.
  const hidden = (id: string): AgentRow[] => list.filter(x => x.parentId === id).flatMap(x => [x, ...hidden(x.id)])
  const below = collapsed ? hidden(a.id) : []
  const nAsk = below.filter(asksOf).length
  const nHand = below.filter(x => handoffOf(x, acts[x.id])?.kind === 'wrapping').length
  // Only a running agent shines; a pending one is still starting up.
  const working = a.status === 'running' && !asks
  const head = <Text>
    <Text color={COLOR[a.status]}>{GLYPH[a.status] ?? '?'}</Text> {working
      ? <Text bold>{shimmerParts(labelOf(a), t).map((p, i) => <Text key={`sh${i}`} bold inverse={hot} color={p.lit ? 'suggestion' : undefined}>{p.text}</Text>)}</Text>
      : <Text bold inverse={hot}>{labelOf(a)}</Text>}
    {under > 0 && <Text dimColor> (+{under})</Text>}
    <Text dimColor>  {ROLE[a.type] ?? a.type}</Text>
    {hand?.kind === 'wrapping' && <Text bold color="warning">  handoff</Text>}
    {collapsed && asks && <Text color="warning"> asks</Text>}
    {nAsk > 0 && <Text color="warning"> · {nAsk} asks</Text>}
    {nHand > 0 && <Text color="warning"> · {nHand} handoff</Text>}
  </Text>
  // The description shows only while there is nothing done to show; the detail view has it.
  const second = hand !== undefined && !asks
    ? <Text color={hand.kind === 'wrapping' ? 'warning' : undefined}>{handoffText(hand)}</Text>
    : doing !== undefined && doing !== ''
    ? <Text color={asks ? 'warning' : undefined} dimColor={!asks}>{doing.slice(0, 60)}</Text>
    : <Text dimColor>{a.description.slice(0, 60)}</Text>
  return (
    <Box key={`row-${a.id}`} paddingLeft={bordered ? depth * 2 : depth * 2 + 1}>
      {collapsed !== undefined && (
        <Button key={`fold-${a.id}`} plain dimColor={dim} onPress={() => c.toggleFold(a, collapsed)}>{collapsed ? '▸ ' : '▾ '}</Button>
      )}
      {full && !collapsed ? (
        // A Button holds Text only, so the border is drawn around it.
        <Box flexDirection="column" borderStyle={bordered ? 'round' : undefined} borderDimColor={dim} borderColor={working ? 'suggestion' : undefined} paddingX={bordered ? 1 : 0}>
          <Button key={a.id} plain dimColor={dim} onPress={() => c.open(a.id)}>
            {head}{'\n'}{second}{'\n'}{c.meter(u, dim, c.runTime(act, dim))}
          </Button>
        </Box>
      ) : (
        <Button key={a.id} plain dimColor={dim} onPress={() => c.open(a.id)}>
          {head}{u !== undefined && <Text color={meterColor(u.percent, c.warnOf(u.window))}> {u.percent}%</Text>}
        </Button>
      )}
    </Box>
  )
}
