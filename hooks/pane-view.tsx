import type { EngineInterface } from 'claude-code'

import type { Activity, AgentRow, Handover, Limit, Session } from '../types'
import { shimmerParts } from './shimmer'
import { asksQuestion } from './dag'
import type { Plan } from './dag'
import { envSettledIn } from './deploy'
import type { Deploys } from './deploy'
import { ENDED } from './deliver'
import { CARD_ROWS, cells, elapsed, labelOf, limitTokens, meterColor, METER_CELLS, tokensDown } from './meter'
import { askBright, COLOR, FINISHED_KEY, GLYPH, handoffOf, ICON, handoffText, HANDOVER_GLYPH, nodeColor, nodeGlyph, rankOf, ROLE, ROOT_GLYPH, treeItems, viewOf } from './pane'
import { graphNodes, layoutGraph, moveFocus } from './graph'
import type { GNode, Seg } from './graph'
import { age, archiveOf, archiveRowText, archiveWho, ARCHIVE_SHOWN, decisionOutcomeText, clip, envLabel, envReanswerable, findItem, isAddressee, isFyi, overridesManager, OVERTURN, fit, groupHint, groupTitle, paneRowText, plural, protectedWhy, tagsOf } from './inbox'
import { dupAskers, dupHidden, dupMark } from './inbox-dups'
import type { Inbox, PaneGroup, PaneRow, Question } from './inbox'
import { MANAGER } from './core'
import type { PushState } from './pushgate'
import type { PushAct } from './pushgate-run'
import { prCardRows } from './prcard'
import { clipLines, inlineEl, linesEl, mdLines, mdPlain, rowLines, spansEl, textRows } from './markdown'
import type { Line } from './markdown'
import type { CardRow, DetailsEntry } from './prcard'
import type { Unhanded } from './status-run'
import { noteKey } from './state'
import { ago, runsOutIn, SESSION } from './sessions'
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
  columns: number
  // The short model tag of an agent; undefined when unknown.
  modelOf: (a: AgentRow) => string | undefined
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
  const doing = asks ? 'asks: ' + mdPlain((act?.answer ?? '').trim().split('\n').pop() ?? '') : act?.doing
  const u = c.usageOf(a)
  const under = list.filter(x => x.parentId === a.id).length
  // What a collapsed card hides that needs a person.
  const hidden = (id: string): AgentRow[] => list.filter(x => x.parentId === id).flatMap(x => [x, ...hidden(x.id)])
  const below = collapsed ? hidden(a.id) : []
  const nAsk = below.filter(asksOf).length
  const nHand = below.filter(x => handoffOf(x, acts[x.id])?.kind === 'wrapping').length
  // Only a running agent shines; a pending one is still starting up.
  const working = a.status === 'running' && !asks
  // The model tag is the first thing to go when the row is short: it shows only if the whole head
  // (and the collapsed row's percent) still fits, so the name is never cut for it.
  const tag = c.modelOf(a)
  const headWidth = 2 + labelOf(a).length + (under > 0 ? ` (+${under})`.length : 0) + 2 + (ROLE[a.type] ?? a.type).length
    + (hand?.kind === 'wrapping' ? 9 : 0) + (collapsed && asks ? 5 : 0)
    + (nAsk > 0 ? ` · ${nAsk} asks`.length : 0) + (nHand > 0 ? ` · ${nHand} handoff`.length : 0)
    + (!(full && !collapsed) && u !== undefined ? ` ${u.percent}%`.length : 0)
  const chrome = depth * 2 + 1 + (collapsed !== undefined ? 2 : 0) + (bordered && full && !collapsed ? 4 : 0)
  const showTag = tag !== undefined && headWidth + 3 + tag.length + chrome <= c.columns
  const head = <Text>
    <Text color={COLOR[a.status]}>{GLYPH[a.status] ?? '?'}</Text> {working
      ? <Text bold>{shimmerParts(labelOf(a), t).map((p, i) => <Text key={`sh${i}`} bold inverse={hot} color={p.lit ? 'suggestion' : undefined}>{p.text}</Text>)}</Text>
      : <Text bold inverse={hot}>{labelOf(a)}</Text>}
    {under > 0 && <Text dimColor> (+{under})</Text>}
    <Text dimColor>  {ROLE[a.type] ?? a.type}</Text>
    {showTag && <Text dimColor> · {tag}</Text>}
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
    <Box key={`row-${a.id}`} flexDirection="row" paddingLeft={bordered ? depth * 2 : depth * 2 + 1}>
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

// What the views below need from the render hook: plain values and closures (the handlers call
// `$` there, so `$` never crosses this import).
export type PaneCtx = {
  els: Els
  list: AgentRow[]
  acts: Record<string, Activity>
  plans: Plan
  rows: number
  columns: number
  t: number
  gfocus: string | null
  shown: boolean
  sessionMap: Record<string, Session>
  arm: { key: string; at: number } | null
  armMs: number
  askers: string[]
  decisionPhrases: string[]
  toggle: JSX.Element
  modelOf: (a: AgentRow) => string | undefined
  card: (a: AgentRow, depth: number, full: boolean, bordered: boolean, hot?: boolean, collapsed?: boolean) => JSX.Element
  runTime: (act: Activity | undefined, isEnded: boolean) => string
  control: (name: string, input: Record<string, unknown>, confirm?: string) => () => Promise<void>
  acted: () => Promise<void>
  open: (id: string) => Promise<void>
  back: (parentId: string | null) => Promise<void>
  fill: (text: string) => unknown
  toast: (text: string) => void
  readFocus: () => Promise<string | null>
  setFocus: (id: string) => Promise<unknown>
}

export type TreeCtx = PaneCtx & {
  hs: Record<string, Handover>
  fold: Record<string, boolean>
  cur: string | null
  unhanded: Unhanded[]
  leftover: string | undefined
  limits: Limit[]
  openQs: Question[]
  // What the tree lists under the summary: the open questions, then the decisions that are not folded.
  openItems: Question[]
  fyiCount: number
  anyOpen: boolean
  checksLine: string | undefined
  gate: PushState['batch']
  breakerNote: string | undefined
  inboxRows: number
  deployLines: string[]
  mainU: Usage | undefined
  mainModel: string | undefined
  mainTime: string
  mergeQueueKey: string
  questionsKey: string
  // The top-level agents folded into the one finished row (finishedIds in hooks/pane.ts).
  finished: Set<string>
  warnOf: (window: number) => number
  meter: (u: Usage | undefined, dim: boolean, time: string) => ReturnType<typeof meter>
  toggleFold: (a: AgentRow, shown: boolean) => Promise<void>
  toggleQueue: () => Promise<void>
  toggleQuestions: () => Promise<void>
  toggleFinished: () => Promise<void>
  readCursor: () => Promise<string | null>
  setCursor: (id: string) => Promise<unknown>
  focusRow: (id: string) => Promise<unknown>
  openInbox: () => Promise<void>
  // Opens the inbox at one item's card; Back returns to the tree.
  openCard: (id: string) => Promise<void>
  // Opens the PR card of a handover (read-only unless it awaits approval), and the ready push batch's card.
  openPr: (pr: number) => Promise<void>
  openBatch: () => Promise<void>
}

type InputProps = { key: string; label: string; placeholder: string; value: string; onInput: (v: string) => void; onSubmit: (v: string) => void }
export type InboxCtx = {
  els: Els
  Input: ((p: InputProps) => null) | undefined
  rows: number
  // The pane's width: list rows are cut to one line of it.
  columns: number
  ibox: Inbox
  icur: string | null
  draft: string
  note: string
  irows: PaneRow[]
  // Standing-rule suggestions (standing-suggest.ts), pending and not dismissed; none when absent.
  sugg?: Array<{ id: string; text: string }>
  // Which items are expanded into cards, by id.
  iopen: Record<string, boolean>
  // The roster and the clock, for the card's agent line and ages.
  list: AgentRow[]
  now: number
  // Where Back goes from a card.
  from: 'tree' | 'inbox' | 'archive'
  // The large card's body offset; without it (the demo) the body shows from its top.
  scroll?: CardScroll
  // The deploy state, for the card: an env item whose change is settled takes no other option.
  deploys?: Deploys
  io: {
    acted: () => Promise<void>
    rows: () => Promise<PaneRow[]>
    readInbox: () => Promise<Inbox>
    readCursor: () => Promise<string | null>
    setCursor: (key: string | null) => Promise<unknown>
    readDraft: () => Promise<string>
    setDraft: (v: string) => Promise<unknown>
    setNote: (v: string) => Promise<unknown>
    answer: (id: string, choice: string | null) => Promise<string>
    // Dismisses suggestions by id, so they are not offered again.
    dismissSugg?: (ids: string[]) => Promise<unknown>
    serial: <T>(fn: () => Promise<T>) => Promise<T>
    toast: (text: string) => void
    focus: (key: string) => Promise<unknown>
    back: () => Promise<void>
    // The card of one item; the view Back returns to.
    open: (id: string, from: 'tree' | 'inbox' | 'archive') => Promise<void>
    leave: (to: 'tree' | 'inbox' | 'archive') => Promise<void>
    // Opens or folds one card (its fold key); the highlight parks on a folded card and goes to firstKey on an opened one.
    toggleFold: (key: string, firstKey: string) => Promise<void>
    // Expands or collapses one item's card; the highlight goes to it.
    toggleItem: (id: string) => Promise<void>
  }
}

// The graph of one level: the plan's nodes (waiting ones have no agent yet) and the agents the
// plan does not know. `spare` is the rows the rest of the pane takes.
export function graphView(c: PaneCtx, owner: string, level: AgentRow[], spare: number) {
  const { Box, Text, Button } = c.els
  const { list, plans, gfocus, rows, acted, toggle } = c
  const children = Object.fromEntries(level.map(a => [a.id, list.filter(c => c.parentId === a.id).length]))
  const raw = graphNodes(plans[owner], level, { children })
  // The glyph is part of the label so the layout counts its columns.
  const nodes: GNode[] = raw.map(n => ({ ...n, label: `${nodeGlyph(n)} ${n.label}` }))
  const layout = layoutGraph(nodes, Math.max(10, c.columns - 2))
  const hot = gfocus !== null && layout.order.includes(gfocus) ? gfocus : layout.order[0]
  const byId = Object.fromEntries(nodes.map(n => [n.id, n]))
  const press = (key: 'h' | 'j' | 'k' | 'l') => async () => {
    await acted()
    const cur = await c.readFocus()
    const target = moveFocus(layout, nodes, cur !== null && layout.order.includes(cur) ? cur : hot, key)
    if (target !== undefined) await c.setFocus(target)
  }
  const openNode = async (id: string | undefined) => {
    const n = id === undefined ? undefined : byId[id]
    if (n === undefined) return
    await acted()
    if (n.agentId !== undefined) return c.open(n.agentId)
    const waiting = n.after.filter(d => byId[d] !== undefined && byId[d]!.state !== 'done').map(d => raw.find(r => r.id === d)?.label ?? d)
    c.toast(`${raw.find(r => r.id === id)?.label ?? id} is ${n.state}${waiting.length ? `, waiting on ${waiting.join(', ')}` : ''}`)
  }
  const hint = (
    <Box flexDirection="row" gap={1}>
      <Button key="g-h" plain dimColor hotkey="h" onPress={press('h')}>h</Button>
      <Button key="g-j" plain dimColor hotkey="j" onPress={press('j')}>j</Button>
      <Button key="g-k" plain dimColor hotkey="k" onPress={press('k')}>k</Button>
      <Button key="g-l" plain dimColor hotkey="l" onPress={press('l')}>l</Button>
      <Text dimColor>move ·</Text>
      <Button key="g-open" plain dimColor hotkey="o" onPress={() => openNode(hot)}>o open</Button>
      <Text dimColor>·</Text>
      {toggle}
    </Box>
  )
  if (nodes.length === 0) {
    return <Box flexDirection="column"><Text dimColor>No plan yet. Managers declare one with mcp__flow__plan.</Text>{hint}</Box>
  }
  const seg = (s: Seg, i: number) => {
    if (s.node === undefined) return <Text key={`s${i}`} dimColor={s.dim}>{s.text}</Text>
    const n = byId[s.node]!
    const dim = n.state === 'done' || n.state === 'completed' || (n.agentId === undefined && n.state === 'waiting')
    return (
      <Button key={`n-${s.node}`} plain dimColor={dim} onPress={() => openNode(s.node)}>
        <Text color={nodeColor(n)} inverse={s.node === hot} bold={s.node === hot}>{s.text}</Text>
      </Button>
    )
  }
  const line = (l: number) => <Box key={`l${l}`} flexDirection="row">{layout.lines[l]!.map(seg)}</Box>
  const hotLine = hot === undefined ? 0 : layout.at[hot] ?? 0
  const size = Math.max(0, rows - spare)
  if (size < 4) return <Box flexDirection="column">{line(hotLine)}{hint}</Box>
  const clipped = layout.lines.length > size
  const win = clipped ? viewOf(layout.lines.map((_, i) => i), hotLine, size - 2) : { top: 0, rows: layout.lines.map((_, i) => i) }
  const below = layout.lines.length - win.top - win.rows.length
  return (
    <Box flexDirection="column">
      {win.top > 0 && <Text dimColor>↑ {win.top} more</Text>}
      {win.rows.map(line)}
      {below > 0 && <Text dimColor>↓ {below} more</Text>}
      {hint}
    </Box>
  )
}

export function managerGraphView(c: PaneCtx, agent: AgentRow, owner: string) {
  const { Box, Text, Button } = c.els
  const { list } = c
  const parent = list.find(a => a.id === agent.parentId)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Button key="back" hotkey="b" onPress={() => c.back(parent?.id ?? null)}>Back</Button>
        <Text dimColor>esc home</Text>
      </Box>
      <Text bold color={COLOR[agent.status]}>{GLYPH[agent.status] ?? '?'} {labelOf(agent)} <Text dimColor>{ROLE[agent.type]} · {agent.status}</Text></Text>
      {graphView(c, owner, list.filter(a => a.parentId === agent.id), 5)}
    </Box>
  )
}

export function agentView(c: PaneCtx, agent: AgentRow) {
  const { Box, Text, Button } = c.els
  const { list, acts, rows, t, shown, sessionMap, arm } = c
  const act = acts[agent.id]
  const model = c.modelOf(agent)
  const answer = (act?.answer ?? '').trim()
  const children = list.filter(a => a.parentId === agent.id).sort((a, b) => rankOf(a, acts) - rankOf(b, acts))
  const fullChildren = children.length * CARD_ROWS <= rows - 15
  const room = Math.max(3, rows - 12 - (fullChildren ? children.length * (CARD_ROWS - 1) : 0))
  // The parent chain is the history: Back climbs one level, an orphan or top-level agent goes to the tree.
  const parent = list.find(a => a.id === agent.parentId)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Button key="back" hotkey="b" onPress={() => c.back(parent?.id ?? null)}>Back</Button>
        <Text dimColor>esc home</Text>
        {agent.type === MANAGER && c.toggle}
        <Button key="msg" hotkey="m" onPress={() => c.fill(
          agent.type === SESSION
            ? `Send to session "${labelOf(agent)}" with mcp__flow__session action "send": `
            : `Send a message to ${ROLE[agent.type] ?? 'agent'} "${labelOf(agent)}": `,
        )}>Message</Button>
      </Box>
      <Text bold color={COLOR[agent.status]}>
        {GLYPH[agent.status] ?? '?'} {labelOf(agent)} <Text dimColor>{ROLE[agent.type] ?? agent.type}{model === undefined ? '' : ` · ${model}`} · {agent.status}
        {act ? ` · ${c.runTime(act, ENDED.has(agent.status))} · last active ${ago(t - act.lastAt)} ago` : ''}{children.length ? ` · ${children.length} under it` : ''}</Text>
      </Text>
      <Text dimColor>{agent.description}</Text>
      {agent.type === SESSION && sessionMap[agent.name ?? ''] !== undefined && (() => {
        const ss = sessionMap[agent.name ?? '']!
        const name = ss.name
        const live = ss.status !== 'exited' && ss.status !== 'stopped'
        const armedFor = arm !== null && t - arm.at <= c.armMs && arm.key.startsWith(`${name}:`) ? arm.key.slice(name.length + 1) : undefined
        const key = (k: string, label: string, keys: string) => (
          <Button key={`key-${k}`} plain hotkey={k} onPress={c.control(name, { action: 'keys', keys })}>{label}</Button>
        )
        const dg = ss.digest
        return (
          <Box flexDirection="column">
            <Text dimColor wrap="truncate-end">
              {ss.host === 'tmux' ? `tmux attach -t ${ss.handle}` : `orca ${ss.handle}`} · {ss.worktree} · {ss.branch}
            </Text>
            {live && (
              <Box flexDirection="row" gap={1}>
                <Text dimColor>keys</Text>
                {key('1', '1', '1')}{key('2', '2', '2')}{key('3', '3', '3')}{key('y', 'y', 'y')}{key('n', 'n', 'n')}
                {key('e', 'e ⏎', 'enter')}{key('z', 'z esc', 'escape')}{key('i', 'i ^C', 'interrupt')}
              </Box>
            )}
            <Box flexDirection="row" gap={1}>
              <Text dimColor>do</Text>
              <Button key="ctl-restart" plain hotkey="r" onPress={c.control(name, { action: 'restart' }, 'restart')}>
                {armedFor === 'restart' ? 'r again to restart' : 'r restart'}
              </Button>
              {live && <Button key="ctl-stop" plain hotkey="x" onPress={c.control(name, { action: 'stop' }, 'stop')}>
                {armedFor === 'stop' ? 'x again to stop' : 'x stop'}
              </Button>}
            </Box>
            {armedFor !== undefined && <Text color="warning">Press {armedFor === 'restart' ? 'r' : 'x'} again within {c.armMs / 1000}s to {armedFor} {name}.</Text>}
            {dg !== undefined && dg.actions.length > 0 && <Text wrap="truncate-end"><Text dimColor>did    </Text>{dg.actions.join(' → ')}</Text>}
            {dg?.at !== undefined && <Text dimColor>active {ago(t - dg.at)} ago{dg.turnDone !== undefined ? ' · turn ended' : ''}</Text>}
            {dg?.lastWords !== undefined && <Text wrap="truncate-end"><Text dimColor>said   </Text>{mdPlain(dg.lastWords).slice(-160)}</Text>}
            {ss.screenText !== undefined && ss.screenText.trim() !== '' && <Text bold>Screen</Text>}
            {ss.screenText !== undefined && ss.screenText.trim() !== '' && (
              ss.screenText.trimEnd().split('\n').slice(-Math.max(3, Math.min(12, rows - 22))).map((l, i) => (
                <Text key={`scr-${i}`} dimColor wrap="truncate-end">{l || ' '}</Text>
              ))
            )}
          </Box>
        )
      })()}
      {act?.handoffNotifiedAt !== undefined && <Text color="warning">
        Handoff: told {ago(t - act.handoffNotifiedAt)} ago{act.handoffPercent === undefined ? '' : ` at ${act.handoffPercent}%`}, {act.remindersSent ?? 0} reminders
      </Text>}
      {shown && <Text dimColor>To see its chat: ← then pick {labelOf(agent)}</Text>}
      {children.length > 0 && <Text bold>Under it</Text>}
      {children.map(ch => c.card(ch, 0, fullChildren, true))}
      <Text bold>Activity</Text>
      {(act?.log ?? []).length === 0 && <Text dimColor>Nothing seen yet.</Text>}
      {(act?.log ?? []).slice(-room).map(line => <Text wrap="truncate-end">{line}</Text>)}
      {answer !== '' && <Text bold color={asksQuestion(answer, c.decisionPhrases) || c.askers.includes(agent.name ?? '') ? 'warning' : undefined}>
        {asksQuestion(answer, c.decisionPhrases) || c.askers.includes(agent.name ?? '') ? 'Asks' : 'Last report'}
      </Text>}
      {answer !== '' && linesEl(Text, mdLines(answer.length > 1200 ? '…' + answer.slice(-1200) : answer, c.columns), 'answer')}
    </Box>
  )
}

export function graphModeView(c: PaneCtx) {
  const { Box, Text } = c.els
  const { list } = c
  const live = list.filter(a => !ENDED.has(a.status)).length
  const ids = new Set(list.map(a => a.id))
  return (
    <Box flexDirection="column">
      <Text dimColor>{list.length} agents · {live} live · graph</Text>
      {graphView(c, 'main', list.filter(a => a.parentId === undefined || !ids.has(a.parentId)), 3)}
    </Box>
  )
}

// The waiting "?" in warning colour: bold when bright, dim when not.
const askMark = (Text: Els['Text'], now: number) => <Text color="warning" bold={askBright(now)} dimColor={!askBright(now)}>{ICON.ask}</Text>

// How many lines an expanded card gives its text, its "why:" and its "instead could:", roomiest tier first;
// a short pane takes a lower one.
const CARD_TIERS = [[3, 2, 2], [2, 1, 1], [1, 0, 0]] as const

// One drawn piece of the inbox list: an owner's header line, a collapsed item's line or an expanded item's card.
type InboxBlock = { key: string; height: number; hot: boolean; node: JSX.Element; rows: number }

export function inboxView(x: InboxCtx) {
  const { Input, ibox, icur, draft, note, irows, iopen, io } = x
  const { Box, Text, Button } = x.els
  const rows = x.rows
  const ihot = Math.max(0, irows.findIndex(r => r.key === icur))
  const hotRow = irows[ihot]
  const hq = hotRow?.q
  const W = Math.max(20, x.columns)
  // A decision is kept or undone with y and n; only a question has options to pick.
  const nOpts = hq === undefined || isFyi(hq) ? 0 : hq.options.length
  // Every press reads the inbox fresh (never the row drawn), so it acts on what is open now.
  // strict: a highlight that is no longer in the list (answered meanwhile, or folded away) answers nothing;
  // the highlight moves to the first row and the person presses again. `at`: an inline button's own item
  // instead of the highlight; a gone one answers nothing and leaves the highlight alone.
  const here = async (strict = true, at?: string) => {
    await io.acted()
    const fresh = await io.rows()
    const c = at ?? await io.readCursor()
    const found = fresh.findIndex(r => r.key === c)
    if (strict && c !== null && found < 0) {
      const was = (await io.readInbox()).items.find(x => x.id === c)
      const by = was?.state === 'answered' ? ` (by ${archiveWho(was)})` : ''
      if (at === undefined) await io.setCursor(fresh[0]?.key ?? null)
      await io.setNote(`${c} ${was?.state === 'answered' ? 'was answered meanwhile' : 'moved out of the list'}${by}; ${at === undefined ? 'the highlight moved, press again' : 'nothing was changed'}.`)
      return undefined
    }
    const i = Math.max(0, found)
    return { fresh, i, row: fresh[i] }
  }
  // After an answer the highlight goes to the next row (else the one before), and the result is shown.
  // The next item keeps its own expanded state: it is not opened for the person.
  const done = async (lines: string[], fresh: PaneRow[], i: number) => {
    const near = fresh[i + 1] ?? fresh[i - 1]
    await io.setCursor(near?.key ?? null)
    const text = lines.join(' ')
    await io.setNote(text)
    io.toast(clip(text, 120))
  }
  const say = (text: string) => io.setNote(text)
  const answerRow = (id: string, choice: string | null) => io.answer(id, choice)
  const pickOption = (n: number, at?: string) => () => io.serial(async () => {
    const spot = await here(true, at)
    if (spot === undefined) return
    const { fresh, i, row } = spot
    if (row?.q === undefined) return say('Move to a question or a decision first.')
    if (n >= row.q.options.length) return
    await done([await answerRow(row.q.id, row.q.options[n]!)], fresh, i)
  })
  const takeDefault = (at?: string) => io.serial(async () => {
    const spot = await here(true, at)
    if (spot === undefined) return
    const { fresh, i, row } = spot
    if (row === undefined) return
    if (row.ids.length === 0) return say(`${row.group?.owner ?? 'It'} holds only questions: expand it (c) first.`)
    const lines: string[] = []
    let refused = 0
    for (const id of row.ids) {
      const q = (await io.readInbox()).items.find(x => x.id === id)
      const why = q === undefined ? undefined : protectedWhy(q)
      if (why !== undefined) { lines.push(why); refused++; continue }
      lines.push(await answerRow(id, null))
    }
    // A refusal leaves the highlight where it is.
    if (refused === lines.length) return say(lines.join(' '))
    await done(lines, fresh, i)
  })
  const keepAll = () => io.serial(async () => {
    const spot = await here(false)
    if (spot === undefined) return
    const { fresh, i } = spot
    const open = (await io.readInbox()).items.filter(x => x.state === 'open' && isFyi(x) && protectedWhy(x) === undefined)
    if (open.length === 0) return say('No open decisions to keep.')
    const lines: string[] = []
    for (const q of open) lines.push(await answerRow(q.id, null))
    const kept = lines.filter(l => l.includes(': Keep (default)')).length
    await done([`Kept ${kept} decision${kept === 1 ? '' : 's'}.`, ...lines.filter(l => !l.includes(': Keep (default)'))], fresh, i)
  })
  const undo = (at?: string) => io.serial(async () => {
    const spot = await here(true, at)
    if (spot === undefined) return
    const { fresh, i, row } = spot
    if (row?.q === undefined || !isFyi(row.q)) return say('n undoes one decision: move to it first.')
    const text = (await io.readDraft()).trim()
    await io.setDraft('')
    await done([await answerRow(row.q.id, text === '' ? OVERTURN : text)], fresh, i)
  })
  const reply = (at?: string) => io.serial(async () => {
    await io.acted()
    if (at !== undefined) await io.setCursor(at)
    await say('Type your answer and press Enter.')
    void io.focus('inbox-answer')
  })
  const submit = (value: string) => void io.serial(async () => {
    const text = value.trim()
    if (text === '') return
    const spot = await here()
    if (spot === undefined) return
    const { fresh, i, row } = spot
    if (row?.q === undefined) return say('Move to a question or a decision first.')
    await io.setDraft('')
    await done([await answerRow(row.q.id, text)], fresh, i)
  })
  const move = (d: number) => () => io.serial(async () => {
    const spot = await here(false)
    if (spot === undefined) return
    const { fresh, row } = spot
    const at = Math.max(0, fresh.findIndex(r => r.key === row?.key))
    const to = fresh[Math.min(fresh.length - 1, Math.max(0, at + d))]
    if (to !== undefined) await io.setCursor(to.key)
  })
  const back = io.back
  const dupRows = dupHidden(ibox.items)
  const nQ = ibox.items.filter(x => x.state === 'open' && !isFyi(x) && !dupRows.has(x.id)).length
  const nF = ibox.items.filter(x => x.state === 'open' && isFyi(x)).length
  const archived = archiveOf(ibox).length
  const hasGroup = irows.length > 0
  const foldHot = () => io.serial(async () => {
    const spot = await here(false)
    const g = spot?.row?.group
    if (g !== undefined) await io.toggleFold(g.key, g.firstKey)
  })
  // e opens or closes the hot item's card (the hot owner row: its group).
  const toggleHot = () => io.serial(async () => {
    const spot = await here(false)
    const r = spot?.row
    if (r?.q !== undefined) await io.toggleItem(r.key)
    else if (r?.group !== undefined) await io.toggleFold(r.group.key, r.group.firstKey)
  })
  const foldGroup = (g: PaneGroup) => () => void io.serial(async () => { await io.acted(); await io.toggleFold(g.key, g.firstKey) })
  const toggleItem = (id: string) => () => void io.serial(async () => { await io.acted(); await io.toggleItem(id) })

  // The list as blocks. Owner headers are plain lines; each item is a collapsed line or, once opened, a card.
  const build = (tier: readonly [number, number, number]): InboxBlock[] => {
    const lineCap = Math.max(8, W - 14)
    // The text as markdown rows, at most `lines` of them; `lead` is the label that opens the first row.
    const wrapped = (text: string, lines: number, lead?: string) => {
      const l = clipLines(mdLines(text, lineCap, lead === undefined ? {} : { lead: { t: lead, dim: true }, hang: 0 }), lines, lineCap)
      return { lines: l, n: Math.max(1, l.length) }
    }
    const blocks: InboxBlock[] = []
    const header = (g: PaneGroup, hot: boolean) => {
      const full = g.routine ? groupTitle(g) : `${g.owner} · ${g.total}${g.asks ? ' asks' : ''}`
      const width = W - 3
      const shown = fit(full, width)
      const text = g.routine || shown !== full || !g.asks
        ? <Text inverse={hot} dimColor={!hot}>{shown}</Text>
        : <Text inverse={hot}><Text dimColor>{`${g.owner} · ${g.total}`}</Text><Text color="warning"> asks</Text></Text>
      blocks.push({
        key: `hdr-${g.key}`, height: 1, hot, rows: g.expanded ? 0 : 1,
        node: (
          <Box key={`hdr-${g.key}`} flexDirection="row">
            <Button key={`fold-${g.key}`} plain dimColor onPress={foldGroup(g)}>{g.expanded ? '▾ ' : '▸ '}</Button>
            <Button key={`row-${g.key}`} plain onPress={foldGroup(g)}>{text}</Button>
          </Box>
        ),
      })
    }
    const item = (r: PaneRow) => {
      const q = r.q!
      const hot = r.key === hotRow?.key
      const fyi = isFyi(q)
      const open = iopen[q.id] === true
      if (!open) {
        const other = fyi ? '' : tagsOf(q).replace(/^BLOCKING ?/, '')
        const mark = r.dups === undefined ? '' : ` ${dupMark(r.dups)}`
        const lead = `  ▸ ${q.id}${mark}${q.blocking && !fyi ? ' BLOCKING' : ''}${other === '' ? '' : ` ${other}`} `
        const line = (
          <Text inverse={hot}>
            {'  ▸ '}<Text dimColor={!hot}>{q.id}</Text>{mark}{q.blocking && !fyi && <Text color="warning"> BLOCKING</Text>}{other === '' ? '' : ` ${other}`} {inlineEl(Text, q.question, `ql-${q.id}`, W - 1 - lead.length)}
          </Text>
        )
        blocks.push({ key: `item-${q.id}`, height: 1, hot, rows: 1, node: <Button key={`item-${q.id}`} plain onPress={toggleItem(q.id)}>{line}</Button> })
        return
      }
      const text = wrapped(q.question, tier[0])
      const why = q.context ? wrapped(q.context, tier[1], 'why: ') : undefined
      const alt = fyi && q.alternative && tier[2] > 0 ? wrapped(q.alternative, tier[2], 'instead could: ') : undefined
      const shownOpts = fyi ? [] : q.options.slice(0, 9)
      const buttons = fyi ? 1 : shownOpts.length + 1
      const height = 2 + 1 + text.n + (why?.n ?? 0) + (alt?.n ?? 0) + buttons
      const who = r.dups !== undefined ? `, ${dupMark(r.dups)} (answers all): ${dupAskers(r.dups)}` : fyi || isAddressee(q, 'main') ? '' : `, for ${q.addressee}`
      blocks.push({
        key: `item-${q.id}`, height, hot, rows: 1,
        node: (
          <Box key={`item-${q.id}`} flexDirection="row" paddingLeft={2}>
            <Button key={`fold-${q.id}`} plain dimColor onPress={toggleItem(q.id)}>{'▾ '}</Button>
            {/* A Button holds Text only, so the border is drawn around the buttons, as for an agent's card. */}
            <Box flexDirection="column" width={W - 6} borderStyle="round" borderDimColor={!hot} borderColor={hot ? 'suggestion' : undefined} paddingX={1}>
              <Button key={`head-${q.id}`} plain onPress={toggleItem(q.id)}>
                <Text wrap="truncate-end">
                  <Text bold>{q.id}</Text>
                  <Text dimColor> · {age(x.now - q.askedAt)} ago{fyi && q.topic ? ` [${q.topic}]` : ''}{who}</Text>
                  {!fyi && tagsOf(q) !== '' && <Text color={q.blocking ? 'warning' : undefined}> {tagsOf(q)}</Text>}
                </Text>
              </Button>
              {linesEl(Text, text.lines, `q-${q.id}`)}
              {why !== undefined && linesEl(Text, why.lines, `why-${q.id}`)}
              {alt !== undefined && linesEl(Text, alt.lines, `alt-${q.id}`)}
              {fyi ? (
                <Box flexDirection="row" gap={2}>
                  <Button key={`keep-${q.id}`} plain onPress={() => takeDefault(q.id)}>y Keep</Button>
                  <Button key={`undo-${q.id}`} plain onPress={() => undo(q.id)}>n Undo</Button>
                </Box>
              ) : (
                <Box flexDirection="column">
                  {shownOpts.map((o, k) => (
                    <Button key={`opt-${q.id}-${k}`} plain onPress={pickOption(k, q.id)}>{`${k + 1}/${String.fromCharCode(97 + k)} ${fit(o, lineCap - 6)}${o === q.default ? ' (default)' : ''}`}</Button>
                  ))}
                  <Button key={`reply-${q.id}`} plain onPress={() => reply(q.id)}>r reply</Button>
                </Box>
              )}
            </Box>
          </Box>
        ),
      })
    }
    const seen = new Set<string>()
    for (const r of irows) {
      const g = r.group!
      if (r.q === undefined) { header(g, r.key === hotRow?.key); continue }
      if (!seen.has(g.key)) { seen.add(g.key); header(g, false) }
      item(r)
    }
    return blocks
  }
  // Fit: the roomiest text tier whose whole list fits; else a window of blocks around the hot one, with a
  // line each for "↑ N above" and "↓ N more". The footer is outside this budget, so it is always drawn.
  const sugg = (x.sugg ?? []).slice(0, 2)
  const hideSugg = () => io.serial(async () => {
    await io.acted()
    await io.dismissSugg?.(sugg.map(s => s.id))
    await say('Standing-rule hint hidden; it is not offered again.')
  })
  const footerLines = sugg.length + (note !== '' ? 1 : 0) + (Input !== undefined ? 1 : 0) + (nOpts > 0 ? 1 : 0) + 2
  const budget = Math.max(2, rows - 1 - footerLines)
  const hotAt = (bs: InboxBlock[]) => Math.max(0, bs.findIndex(b => b.hot))
  const sum = (bs: InboxBlock[]) => bs.reduce((n, b) => n + b.height, 0)
  let blocks = build(CARD_TIERS[CARD_TIERS.length - 1]!)
  for (const t of CARD_TIERS) {
    const bs = build(t)
    if (sum(bs) <= budget || bs[hotAt(bs)]!.height + 4 <= budget) { blocks = bs; break }
  }
  let lo = 0
  let hi = blocks.length - 1
  if (sum(blocks) > budget) {
    const hot = hotAt(blocks)
    lo = hi = hot
    let used = blocks[hot]!.height
    const extra = (first: number, last: number) => (first > 0 ? 1 : 0) + (last < blocks.length - 1 ? 1 : 0)
    for (let grew = true; grew;) {
      grew = false
      if (hi + 1 < blocks.length && used + blocks[hi + 1]!.height + extra(lo, hi + 1) <= budget) { used += blocks[++hi]!.height; grew = true }
      if (lo > 0 && used + blocks[lo - 1]!.height + extra(lo - 1, hi) <= budget) { used += blocks[--lo]!.height; grew = true }
    }
  }
  const countRows = (from: number, to: number) => blocks.slice(from, to).reduce((n, b) => n + b.rows, 0)
  const iAbove = countRows(0, lo)
  const iBelow = countRows(hi + 1, blocks.length)
  return (
    <Box flexDirection="column" height={rows}>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
      <Text bold><Text color={irows.length === 0 ? undefined : 'warning'} dimColor={irows.length === 0}>{ICON.inbox}</Text> Inbox{nQ > 0 && <Text> {askMark(Text, x.now)}</Text>} <Text dimColor>{irows.length === 0 ? 'Nothing open.' : `${nQ} question${nQ === 1 ? '' : 's'}, ${nF} decision${nF === 1 ? '' : 's'}`}</Text></Text>
      {sugg.map(s => <Text key={`sugg-${s.id}`} color="suggestion" wrap="truncate-end">{`+ ${s.text}`}</Text>)}
      {iAbove > 0 && <Text dimColor>  ↑ {iAbove} above</Text>}
      {blocks.slice(lo, hi + 1).map(b => b.node)}
      {iBelow > 0 && <Text dimColor>  ↓ {iBelow} more</Text>}
      {hotRow === undefined && <Text dimColor>Nothing to answer.</Text>}
      </Box>
      <Box flexDirection="column" flexShrink={0}>
      {note !== '' && <Text color="suggestion" wrap="truncate-end">{note}</Text>}
      {Input !== undefined && <Input key="inbox-answer" label="answer " placeholder="your own words (r), or what instead (n)" value={draft} onInput={(v: string) => void io.setDraft(v)} onSubmit={submit} />}
      {nOpts > 0 && <Box flexDirection="row" gap={1}>
        {Array.from({ length: Math.min(nOpts, 8) }, (_, k) => (
          <Button key={`pick-${String.fromCharCode(97 + k)}`} plain dimColor hotkey={String.fromCharCode(97 + k)} onPress={pickOption(k)}>{String.fromCharCode(97 + k)}</Button>
        ))}
        {Array.from({ length: Math.min(nOpts, 9) }, (_, k) => (
          <Button key={`pick-${k + 1}`} plain dimColor hotkey={String(k + 1)} onPress={pickOption(k)}>{k + 1}</Button>
        ))}
        {nOpts > 0 && <Text dimColor>pick</Text>}
      </Box>}
      <Box flexDirection="row" gap={2}>
        <Button key="inbox-next" plain dimColor hotkey="j" onPress={move(1)}>j next</Button>
        <Button key="inbox-prev" plain dimColor hotkey="k" onPress={move(-1)}>k prev</Button>
        {/* The hint joins the c button, so a hot collapsed owner reads "c expand · y keeps all 3". */}
        {hasGroup && (
          <Box flexDirection="row" gap={1}>
            <Button key="inbox-fold" plain dimColor hotkey="c" onPress={foldHot}>{hotRow?.group?.expanded ? 'c collapse' : 'c expand'}</Button>
            {hotRow?.q === undefined && hotRow?.group !== undefined && <Text dimColor>{fit(`· ${groupHint(hotRow.group)}`, Math.max(8, W - 42))}</Text>}
          </Box>
        )}
        {hq !== undefined && hotRow !== undefined && (
          <Button key="inbox-open" plain dimColor hotkey="o" onPress={() => io.serial(async () => { await io.acted(); await io.open(hotRow.key, 'inbox') })}>o open</Button>
        )}
        {/* x stays as an alias of c, and e opens or closes the hot item's card (a hotkey is one letter, so not Enter); neither is labelled. */}
        {hasGroup && <Button key="inbox-fold-x" plain hotkey="x" onPress={foldHot}>{''}</Button>}
        {hasGroup && <Button key="inbox-toggle" plain hotkey="e" onPress={toggleHot}>{''}</Button>}
        <Text dimColor>esc home</Text>
      </Box>
      <Box flexDirection="row" gap={2}>
        <Button key="inbox-yes" plain dimColor hotkey="y" onPress={() => takeDefault()}>{hq !== undefined && !isFyi(hq) ? 'y default' : 'y keep'}</Button>
        <Button key="inbox-no" plain dimColor hotkey="n" onPress={() => undo()}>n undo</Button>
        <Button key="inbox-all" plain dimColor hotkey="w" onPress={keepAll}>w keep all</Button>
        <Button key="inbox-reply" plain dimColor hotkey="r" onPress={() => reply()}>r reply</Button>
        <Button key="inbox-archive" plain dimColor hotkey="v" onPress={() => io.serial(async () => { await io.acted(); await io.leave('archive') })}>v archive{archived > 0 ? ` (${archived})` : ''}</Button>
        {sugg.length > 0 && <Button key="inbox-sugg" plain dimColor hotkey="s" onPress={hideSugg}>s hide rule hint</Button>}
        <Button key="inbox-back" plain dimColor hotkey="i" onPress={back}>i back</Button>
      </Box>
      </Box>
    </Box>
  )
}

// The questions block: one row folded; unfolded, the items capped at a third of the pane (the
// header and "and N more" lines included) so the agent tree keeps its room.
export function questionsBlock(count: number, open: boolean, rows: number) {
  if (count === 0) return { shown: 0, more: 0, rows: 0 }
  if (!open) return { shown: 0, more: 0, rows: 1 }
  const cap = Math.max(3, Math.floor(rows / 3))
  const clipped = count > cap - 1
  const shown = clipped ? cap - 2 : count
  return { shown, more: count - shown, rows: 1 + shown + (clipped ? 1 : 0) }
}

export function treeView(c: TreeCtx) {
  const { Box, Text, Button } = c.els
  const { list, fold, acts, hs, rows, limits, anyOpen, unhanded, leftover, inboxRows, deployLines, cur, gate, openQs, fyiCount, checksLine, breakerNote, mainU, mainTime, toggle, card } = c
  const { toggleFold, toggleQueue, toggleQuestions, toggleFinished, open, finished } = c
  // The tree: each agent under the one that started it, what needs a person first.
  const first = treeItems(list, fold, undefined, false, acts, finished).items[0]?.a.id
  const prs = Object.values(hs).sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
  const live = list.filter(a => !ENDED.has(a.status)).length
  // Header, the PR lines and the hint row are fixed; the root and the agents share what is left.
  // Full cards if all fit, else the crowded tree (compact rows, folded but for the highlight's
  // path) in a window that follows the highlight.
  const queueOpen = fold[c.mergeQueueKey] === false
  const prRows = prs.length > 0 ? 1 + (queueOpen ? Math.min(prs.length, 5) : 0) : 0
  const usageRows = rows >= 20 ? Math.min(4, limits.length) : 0
  const qOpen = fold[c.questionsKey] === false
  // Nothing to unfold (decisions only) keeps the plain Inbox line.
  const canFold = c.openItems.length > 0
  const qBlock = questionsBlock(c.openItems.length, qOpen, rows)
  const qRows = canFold ? qBlock.rows : openQs.length > 0 || fyiCount > 0 ? 1 : 0
  const avail = rows - 1 - prRows - usageRows - (list.length === 0 ? 1 : 0) - (list.length > 0 || anyOpen || Object.keys(hs).length > 0 ? 1 : 0) - (unhanded.length > 0 ? 1 : 0) - (leftover ? 1 : 0) - inboxRows - qRows - deployLines.length
  const wide = treeItems(list, fold, cur ?? first, false, acts, finished)
  // The finished row is one line, open or not.
  const fullTree = CARD_ROWS + wide.items.reduce((n, i) => n + (i.collapsed || i.finished ? 1 : CARD_ROWS), 0) <= avail
  const { items, at } = fullTree ? wide : treeItems(list, fold, cur ?? first, true, acts, finished)
  const rootFull = fullTree || avail >= CARD_ROWS + items.length
  const left = avail - (rootFull ? CARD_ROWS : 1)
  const cut = !fullTree && items.length > left
  const hotIdx = Math.max(0, items.findIndex(i => i.a.id === at))
  // Two rows of the window go to the "above" and "more" lines.
  const view = cut ? viewOf(items, hotIdx, Math.max(1, left - 2)) : { top: 0, rows: items }
  const below = items.length - view.top - view.rows.length
  const hotId = items[hotIdx]?.a.id
  const countOf = (s: Handover['status']) => prs.filter(p => p.status === s).length
  const returned = countOf('returned')
  const awaiting = countOf('awaiting')
  const queueSummary = (['pending', 'taken', 'done'] as const).map(s => `${countOf(s)} ${s}`).join(' · ')  + (countOf('ready') > 0 ? ` · ${countOf('ready')} ready to push` : '')
  // Keys read the state fresh, so rapid presses each count once.
  const step = (d: number) => async () => {
    if (items.length === 0) return
    await c.acted()
    const curId = (await c.readCursor()) ?? hotId
    // A cursor on a row that is not drawn (folded into the finished row) steps from the highlight.
    const was = items.findIndex(x => x.a.id === curId)
    const i = Math.min(items.length - 1, Math.max(0, (was === -1 ? hotIdx : was) + d))
    const id = items[i]!.a.id
    await c.setCursor(id)
    // Moves the focus ring too; it waits for the next drawing, so it is not awaited.
    void c.focusRow(id)
  }
  const hotItem = async () => {
    await c.acted()
    const curId = (await c.readCursor()) ?? hotId
    return items.find(x => x.a.id === curId) ?? items[hotIdx]
  }
  return (
    <Box flexDirection="column" height={rows}>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
      {gate !== undefined && gate.state === 'ready' && (
        <Button key="batch-open" plain onPress={c.openBatch}>
          <Text color="warning" bold wrap="truncate-end">⇪ Batch {gate.id} ready to push: {gate.prs.map(n => `#${n}`).join(' ')}{gate.version === undefined ? '' : ` (${gate.version})`} · check: {inlineEl(Text, gate.check, 'gate-check')}</Text>
        </Button>
      )}
      {gate !== undefined && gate.state === 'ready' && <Text color="warning" wrap="truncate-end">  /flow push · /flow push back {'<pr>'} · /flow push drop</Text>}
      {gate !== undefined && gate.state !== 'ready' && (
        <Text color="suggestion" wrap="truncate-end">⇪ Batch {gate.id} {gate.state === 'pushing' ? 'released, a reviewer is pushing it' : `is being rebuilt${gate.reason === undefined ? '' : ` (${gate.reason})`}`}: {gate.prs.map(n => `#${n}`).join(' ')}</Text>
      )}
      <Text dimColor>{ICON.agents} {list.length} agents · {live} live{prs.length ? ` · ${prs.length} PR${prs.length === 1 ? '' : 's'} with the reviewer` : ''}{list.length > 0 ? ' · press an agent to open it' : ''}</Text>
      {qRows > 0 && (() => {
        const blocking = openQs.filter(q => q.blocking).length
        const summary = [
          ...(openQs.length > 0 ? [`${openQs.length} question${openQs.length === 1 ? '' : 's'}${blocking > 0 ? ` (${blocking} blocking)` : ''}`] : []),
          ...(fyiCount > 0 ? [`${fyiCount} decision${fyiCount === 1 ? '' : 's'}`] : []),
        ].join(' · ')
        const line = (
          <Text color={blocking > 0 ? 'warning' : undefined} dimColor={blocking === 0} wrap="truncate-end">
            {canFold && `${qOpen ? '▾' : '▸'} `}<Text color="warning" dimColor={false}>{ICON.inbox}</Text> {openQs.length > 0 && askMark(Text, c.t)}{openQs.length > 0 && ' '}{summary}
          </Text>
        )
        return canFold ? <Button key={`fold-${c.questionsKey}`} plain onPress={toggleQuestions}>{line}</Button> : line
      })()}
      {qOpen && c.openItems.slice(0, qBlock.shown).map(q => (
        <Button key={`open-${q.id}`} plain onPress={() => c.openCard(q.id)}>
          <Text color={q.blocking ? 'warning' : undefined} wrap="truncate-end">  {q.id} {q.owner}: {inlineEl(Text, q.question, `tq-${q.id}`)}</Text>
        </Button>
      ))}
      {qOpen && qBlock.more > 0 && <Text dimColor>  and {qBlock.more} more</Text>}
      {checksLine !== undefined && <Text dimColor wrap="truncate-end">{ICON.checks} {checksLine}</Text>}
      {unhanded.length > 0 && (
        <Text color="warning" wrap="truncate-end">
          ⚠ {unhanded.length} PR{unhanded.length > 1 ? 's' : ''} nobody handed over: {unhanded.map(u => `#${u.pr}`).join(' ')}
        </Text>
      )}
      {leftover && <Text dimColor wrap="truncate-end">{ICON.leftover} {leftover}</Text>}
      {rootFull ? (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          <Text bold>{ROOT_GLYPH} main <Text dimColor> super manager{c.mainModel === undefined ? '' : ` · ${c.mainModel}`}</Text></Text>
          {c.meter(mainU, false, mainTime)}
          {limits.slice(0, usageRows).map(l => limitLine(c.els, c.t, l))}
        </Box>
      ) : (
        <Text bold>{ROOT_GLYPH} main <Text dimColor>· super manager{c.mainModel === undefined ? '' : ` · ${c.mainModel}`}</Text>
          {mainU !== undefined && <Text color={meterColor(mainU.percent, c.warnOf(mainU.window))}> {mainU.percent}%</Text>}
        </Text>
      )}
      {!rootFull && limits.slice(0, usageRows).map(l => limitLine(c.els, c.t, l))}
      {list.length === 0 && <Text dimColor>  Nothing running. Ask Claude to start managers or a worker, e.g. "start a manager for X".</Text>}
      {view.top > 0 && <Text dimColor>  ↑ {view.top} above</Text>}
      {view.rows.map(({ a, depth, collapsed, finished: f }) => f !== undefined ? (
        <Button key={a.id} plain onPress={toggleFinished}>
          <Text dimColor={a.id !== hotId} inverse={a.id === hotId} wrap="truncate-end">  {collapsed ? '▸' : '▾'} {f.managers} finished{f.workers > 0 && <Text dimColor> · {f.workers} worker{f.workers === 1 ? '' : 's'}</Text>}</Text>
        </Button>
      ) : card(
        a, depth + 1, fullTree, depth === 0, a.id === hotId, collapsed,
      ))}
      {below > 0 && <Text dimColor>  +{below} more</Text>}
      {prs.length > 0 && (
        <Box flexDirection="row">
          <Button key={`fold-${c.mergeQueueKey}`} plain dimColor onPress={toggleQueue}>{queueOpen ? '  ▾ ' : '  ▸ '}</Button>
          <Text bold>Reviewer</Text>
          {!queueOpen && <Text dimColor>  {queueSummary}</Text>}
          {!queueOpen && awaiting > 0 && (
            <Button key="await-open" plain onPress={() => c.openPr(prs.find(p => p.status === 'awaiting')!.pr)}>
              <Text color="warning"> · {awaiting} awaiting approval</Text>
            </Button>
          )}
          {!queueOpen && returned > 0 && <Text color="warning"> · {returned} returned</Text>}
        </Box>
      )}
      {breakerNote !== undefined && <Text color="warning" wrap="truncate-end">{'    '}⚠ {breakerNote}</Text>}
      {queueOpen && prs.slice(0, 5).map(ho => (
        <Button key={`pr-${ho.pr}`} plain onPress={() => c.openPr(ho.pr)}>
          <Text dimColor={ho.status === 'done'} color={ho.status === 'awaiting' || ho.status === 'ready' ? 'warning' : undefined} wrap="truncate-end">
            {'    '}{HANDOVER_GLYPH[ho.status]} #{ho.pr} {ho.status === 'awaiting' ? `awaiting your approval: press to review, /flow approve ${ho.pr} or /flow reject ${ho.pr}` : ho.status === 'ready' ? 'ready, awaiting your push: /flow push' : ho.status}{ho.status === 'returned' ? `: ${ho.reason ?? ''}` : ''} <Text dimColor>{ho.title}</Text>
          </Text>
        </Button>
      ))}
      {deployLines.map(l => <Text key={`deploy-${l}`} dimColor wrap="truncate-end">{'  '}⏸ {l}</Text>)}
      </Box>
      {(list.length > 0 || anyOpen || prs.length > 0) && (
        <Box flexDirection="row" gap={1} flexShrink={0}>
          {list.length > 0 && <Button key="nav-next" plain dimColor hotkey="j" onPress={step(1)}>j next</Button>}
          {list.length > 0 && <Button key="nav-prev" plain dimColor hotkey="k" onPress={step(-1)}>k prev</Button>}
          {list.length > 0 && <Button key="nav-open" plain dimColor hotkey="o" onPress={async () => {
            const i = await hotItem()
            if (i?.finished) await toggleFinished()
            else if (i) await open(i.a.id)
          }}>o open</Button>}
          {list.length > 0 && <Button key="nav-fold" plain dimColor hotkey="c" onPress={async () => {
            const i = await hotItem()
            if (i?.finished) await toggleFinished()
            else if (i) await toggleFold(i.a, i.collapsed)
          }}>{items[hotIdx]?.collapsed ? 'c expand' : 'c collapse'}</Button>}
          {finished.size > 0 && <Button key="nav-finished" plain dimColor hotkey="f" onPress={toggleFinished}>{fold[FINISHED_KEY] === false ? 'f fold' : 'f finished'}</Button>}
          {prs.length > 0 && <Button key="nav-queue" plain dimColor hotkey="q" onPress={toggleQueue}>q reviewer</Button>}
          {canFold && <Button key="nav-questions" plain dimColor hotkey="a" onPress={toggleQuestions}>{qOpen ? 'a fold' : 'a questions'}</Button>}
          {anyOpen && <Button key="nav-inbox" plain dimColor hotkey="i" onPress={c.openInbox}>i inbox</Button>}
          {list.length > 0 && toggle}
        </Box>
      )}
    </Box>
  )
}

// --- The inbox's large card (one item) and the archive. ---

// A card body taller than its room scrolls under a pinned header and pinned buttons. `at` is the stored
// offset and the card it belongs to (another card starts at its top); `seen` tells the render hook which
// body is drawn, its last offset and a page, so the wheel and PgUp/PgDn (ui.scroll) move it; `move` is u/m.
export type CardScroll = {
  at: { key: string; top: number }
  seen: (key: string, max: number, page: number) => void
  move: (by: number) => Promise<unknown>
}

// The body rows that show in `room` rows from the stored offset, clamped (the text or the pane may have
// changed since), with a position line taking the last row when not all fit.
export function scrollWindow<T>(all: T[], room: number, key: string, scroll: CardScroll | undefined) {
  const fits = all.length <= room
  const view = fits ? all.length : Math.max(1, room - 1)
  const max = Math.max(0, all.length - view)
  const top = Math.min(max, Math.max(0, scroll?.at.key === key ? scroll.at.top : 0))
  const page = Math.max(1, view - 1)
  scroll?.seen(key, max, page)
  const shown = all.slice(top, top + view)
  const pos = fits ? undefined : `${top > 0 ? `↑ ${top} above · ` : ''}lines ${top + 1}-${top + shown.length} of ${all.length}${top < max ? ` · ↓ ${all.length - top - shown.length} below` : ''}`
  return { shown, pos, page, scrolls: max > 0, height: fits ? all.length : view + 1 }
}

// u and m page the body; free on all three cards (the question card's letters run a-h).
function scrollKeys(Button: Els['Button'], prefix: string, w: ReturnType<typeof scrollWindow>, scroll: CardScroll | undefined) {
  if (!w.scrolls || scroll === undefined) return []
  return [
    <Button key={`${prefix}-up`} plain dimColor hotkey="u" onPress={() => void scroll.move(-w.page)}>u up</Button>,
    <Button key={`${prefix}-down`} plain dimColor hotkey="m" onPress={() => void scroll.move(w.page)}>m more</Button>,
  ]
}

const kindOf = (q: Question): string =>
  isFyi(q) ? 'decision' : q.kind === 'deploy' ? 'deploy approval' : q.kind === 'push' ? 'push' : q.kind === 'reviewer' ? 'reviewer retry' : q.kind === 'env' ? `env change${envLabel(q)}` : q.guard !== undefined ? 'guard test suggestion' : 'question'

// One item in full: every option a Button, the Input for words of your own. An item answered meanwhile
// shows its answer and answers nothing. Every press reads the inbox fresh.
export function cardView(x: InboxCtx & { id: string | null }) {
  const { Input, draft, note, io, rows, now, list, from } = x
  const { Box, Text, Button } = x.els
  const q = x.id === null ? undefined : findItem(x.ibox, x.id)
  const back = () => io.serial(async () => { await io.acted(); await io.leave(from) })
  const backBtn = <Button key="card-back" hotkey="b" onPress={back}>Back</Button>
  if (q === undefined) {
    return (
      <Box flexDirection="column" height={rows}>
        <Box flexDirection="row" gap={1}>{backBtn}<Text dimColor>esc home</Text></Box>
        <Text dimColor>{x.id ?? 'That item'} is not in the inbox any more.</Text>
      </Box>
    )
  }
  const open = q.state === 'open'
  // An answered env item takes another option (the user changed their mind), unless its change is settled for the
  // target; the answer path refuses a settled one anyway.
  const answerable = open || (envReanswerable(q) && !envSettledIn(x.deploys, q))
  const linked = q.forQ === undefined ? undefined : findItem(x.ibox, q.forQ)
  const agent = list.find(a => a.name !== undefined && noteKey(a.name) === noteKey(q.owner))
  // Where the next card comes from: the rows as they are after the answer, from this one on.
  const answerWith = (choice: string | null) => io.serial(async () => {
    await io.acted()
    const before = (await io.rows()).filter(r => r.q !== undefined).map(r => r.q!.id)
    const fresh = findItem(await io.readInbox(), q.id)
    if (fresh === undefined) return
    if (fresh.state === 'answered' && !(choice !== null && envReanswerable(fresh))) {
      const text = `${fresh.id} is already answered: ${fresh.answer ?? ''} (by ${archiveWho(fresh)}).`
      await io.setNote(text)
      io.toast(clip(text, 120))
      return
    }
    if (choice === null) {
      const why = protectedWhy(fresh)
      if (why !== undefined) return void (await io.setNote(why))
    }
    const text = await io.answer(fresh.id, choice)
    await io.setDraft('')
    await io.setNote(text)
    io.toast(clip(text, 120))
    const after = (await io.rows()).filter(r => r.q !== undefined).map(r => r.q!.id)
    const following = [...before.slice(before.indexOf(fresh.id) + 1), ...before].find(id => id !== fresh.id && after.includes(id))
    if (following !== undefined) await io.open(following, from)
    else await io.leave(from === 'tree' ? 'tree' : 'inbox')
  })
  const pick = (n: number) => () => void answerWith(q.options[n]!)
  const step = (d: number) => () => io.serial(async () => {
    await io.acted()
    const ids = (await io.rows()).filter(r => r.q !== undefined).map(r => r.q!.id)
    const at = ids.indexOf(q.id)
    const to = ids[Math.min(ids.length - 1, Math.max(0, (at < 0 ? 0 : at) + d))]
    if (to !== undefined && to !== q.id) await io.open(to, from)
  })
  const submit = (value: string) => {
    const text = value.trim()
    if (text !== '') void answerWith(text)
  }
  const undo = () => {
    const text = draft.trim()
    void answerWith(text === '' ? OVERTURN : text)
  }
  const tags = tagsOf(q)
  const who = isAddressee(q, 'main') ? q.owner : `${q.owner}, for ${q.addressee}`
  // The question, its context and the alternative as markdown: the body, which scrolls between the pinned header
  // above and the options, note, answer Input and keys below. Those count their own rows (each meta line is one,
  // cut at the edge) so the body gets the rest, and a long text never pushes the options out of the box.
  const lines = [
    ...mdLines(q.question, x.columns),
    ...(q.context ? mdLines(q.context, x.columns, { lead: { t: 'why: ', dim: true }, hang: 0 }) : []),
    ...(isFyi(q) && q.alternative ? mdLines(q.alternative, x.columns, { lead: { t: 'instead could: ', dim: true }, hang: 0 }) : []),
  ]
  const overrideText = open && overridesManager(q) ? `It is for ${q.addressee}: answering it overrides ${q.addressee}, who is told.` : undefined
  const optText = (o: string, k: number) => `${k + 1}) ${o}${o === q.default ? ' (default)' : ''}`
  const doneText = open ? undefined : isFyi(q) ? decisionOutcomeText(q, now) : `Answered: ${q.answer ?? ''} (by ${archiveWho(q)}${q.answeredAt === undefined ? '' : `, ${age(now - q.answeredAt)} ago`}). ${answerable ? 'Press another option to change it.' : 'Nothing more to answer.'}`
  const protectedText = open && x.id !== null && protectedWhy(q) !== undefined ? 'Needs an explicit choice: y never answers it.' : undefined
  const inputLabel = isFyi(q) ? 'instead ' : 'answer '
  const inputHint = isFyi(q) ? 'what instead (n, or Enter): undoes the decision' : 'your own words, then Enter'
  const rowsOf = (t: string | undefined) => (t === undefined || t === '' ? 0 : textRows(t, x.columns))
  const head = 5 + (tags !== '' ? 1 : 0) + (isFyi(q) && q.topic ? 1 : 0) + (isFyi(q) ? 0 : 1) + (linked !== undefined ? 1 : 0) + (q.env !== undefined ? 1 : 0) + rowsOf(overrideText)
  const foot = 1 + (isFyi(q) ? 0 : q.options.reduce((n, o, k) => n + rowsOf(`${answerable ? '' : '  '}${optText(o, k)}`), 0)) + rowsOf(doneText) + rowsOf(protectedText)
    + rowsOf(note) + (open && Input !== undefined ? rowsOf(`${inputLabel}${draft === '' ? inputHint : draft}`) : 0) + (open ? 1 : 0)
  const w = scrollWindow(lines, Math.max(3, rows - head - foot), `q:${q.id}`, x.scroll)
  return (
    <Box flexDirection="column" height={rows}>
      <Box flexDirection="column" flexShrink={1} overflow="hidden">
      <Box flexDirection="row" gap={1} flexShrink={0}>
        {backBtn}
        <Text dimColor>esc home</Text>
        {open && <Button key="card-prev" plain dimColor hotkey="k" onPress={step(-1)}>k prev</Button>}
        {open && <Button key="card-next" plain dimColor hotkey="j" onPress={step(1)}>j next</Button>}
        {scrollKeys(Button, 'card', w, x.scroll)}
      </Box>
      <Text wrap="truncate-end"><Text bold>{q.id}</Text><Text dimColor> · {q.owner || 'unknown'} · {age(now - q.askedAt)}</Text></Text>
      <Text wrap="truncate-end">{kindOf(q)}{q.alias === undefined ? '' : <Text dimColor> (earlier id {q.alias})</Text>}</Text>
      {tags !== '' && <Text color={q.blocking ? 'warning' : undefined} wrap="truncate-end">{tags}</Text>}
      {isFyi(q) && q.topic && <Text dimColor wrap="truncate-end">[{q.topic}]</Text>}
      {!isFyi(q) && <Text dimColor wrap="truncate-end">from {who} · {age(now - q.askedAt)} ago{q.escalated !== undefined ? ' · escalated to you' : ''}</Text>}
      {agent !== undefined && <Text dimColor wrap="truncate-end">{q.owner} is {agent.status}</Text>}
      {agent === undefined && <Text dimColor wrap="truncate-end">{q.owner} is not in the roster</Text>}
      {linked !== undefined && <Text wrap="truncate-end">escalated from {linked.owner}'s {linked.id}: {inlineEl(Text, linked.question, `esc-${linked.id}`)}</Text>}
      {q.env !== undefined && <Text dimColor wrap="truncate-end">PR #{q.env.pr}, target {q.env.target}</Text>}
      {overrideText !== undefined && <Text color="warning">{overrideText}</Text>}
      <Text> </Text>
      </Box>
      <Box flexDirection="column" flexShrink={0} height={w.height} overflow="hidden">
      {linesEl(Text, w.shown, 'card-body')}
      {w.pos !== undefined && <Text dimColor wrap="truncate-end">{w.pos}</Text>}
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={0}>
      <Text dimColor>{'─'.repeat(Math.max(20, x.columns))}</Text>
      {!isFyi(q) && q.options.map((o, k) => {
        return answerable ? (
          <Button key={`card-opt-${k}`} hotkey={k < 9 ? String(k + 1) : undefined} onPress={pick(k)}>
            {optText(o, k)}
          </Button>
        ) : (
          <Text key={`card-opt-${k}`} bold={o === q.answer}>{o === q.answer ? '> ' : '  '}{optText(o, k)}</Text>
        )
      })}
      {doneText !== undefined && <Text color="success">{doneText}</Text>}
      {protectedText !== undefined && <Text dimColor>{protectedText}</Text>}
      </Box>
      <Box flexDirection="column" flexShrink={0}>
      {note !== '' && <Text color="suggestion">{note}</Text>}
      {open && Input !== undefined && <Input key="card-answer" label={inputLabel} placeholder={inputHint} value={draft} onInput={(v: string) => void io.setDraft(v)} onSubmit={submit} />}
      {open && (
        <Box flexDirection="row" gap={1}>
          <Button key="card-yes" plain dimColor hotkey="y" onPress={() => void answerWith(null)}>{isFyi(q) ? 'y Keep' : 'y default'}</Button>
          {isFyi(q) && <Button key="card-no" plain dimColor hotkey="n" onPress={undo}>n Undo (say what instead)</Button>}
          {/* b is Back here, so the second option's letter is left out; its digit and button work. */}
          {Array.from({ length: isFyi(q) ? 0 : Math.min(q.options.length, 8) }, (_, k) => String.fromCharCode(97 + k)).filter(l => l !== 'b').map(l => (
            <Button key={`card-pick-${l}`} plain dimColor hotkey={l} onPress={pick(l.charCodeAt(0) - 97)}>{l}</Button>
          ))}
          {Input !== undefined && <Button key="card-reply" plain dimColor hotkey="r" onPress={() => void io.focus('card-answer')}>r reply</Button>}
        </Box>
      )}
      </Box>
    </Box>
  )
}

// Answered questions and kept or undone decisions, newest first; pressing one opens its card (read-only).
export function archiveView(x: InboxCtx) {
  const { icur, io, rows, now } = x
  const { Box, Text, Button } = x.els
  const all = archiveOf(x.ibox)
  const items = all.slice(0, ARCHIVE_SHOWN)
  const at = Math.max(0, items.findIndex(q => q.id === icur))
  const size = Math.max(2, rows - 5)
  const win = viewOf(items, at, size)
  const move = (d: number) => () => io.serial(async () => {
    await io.acted()
    const fresh = archiveOf(await io.readInbox()).slice(0, ARCHIVE_SHOWN)
    const c = await io.readCursor()
    const i = Math.min(fresh.length - 1, Math.max(0, Math.max(0, fresh.findIndex(q => q.id === c)) + d))
    if (fresh[i] !== undefined) await io.setCursor(fresh[i]!.id)
  })
  return (
    <Box flexDirection="column" height={rows}>
<Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
      <Text bold>Archive <Text dimColor>{all.length === 0 ? 'Nothing answered yet.' : `${plural(all.length, 'answered item')}, newest first`}</Text></Text>
      {win.top > 0 && <Text dimColor>  ↑ {win.top} above</Text>}
      {win.rows.map(q => (
        <Button key={`arch-${q.id}`} plain onPress={() => void io.serial(async () => { await io.acted(); await io.open(q.id, 'archive') })}>
          <Text inverse={q.id === items[at]?.id} wrap="truncate-end">{q.id === items[at]?.id ? '> ' : '  '}{archiveRowText(q, now)}</Text>
        </Button>
      ))}
      {items.length - win.top - win.rows.length > 0 && <Text dimColor>  ↓ {items.length - win.top - win.rows.length} more</Text>}
      {all.length > items.length && <Text dimColor>  +{all.length - items.length} older: /flow inbox archive all</Text>}
      </Box>
      <Box flexDirection="row" gap={1} flexShrink={0}>
        <Button key="arch-next" plain dimColor hotkey="j" onPress={move(1)}>j next</Button>
        <Button key="arch-prev" plain dimColor hotkey="k" onPress={move(-1)}>k prev</Button>
        <Button key="arch-open" plain dimColor hotkey="o" onPress={() => void io.serial(async () => {
          await io.acted()
          const c = await io.readCursor()
          const q = archiveOf(await io.readInbox()).find(y => y.id === c) ?? items[0]
          if (q !== undefined) await io.open(q.id, 'archive')
        })}>o open</Button>
        <Button key="arch-back" plain dimColor hotkey="b" onPress={() => void io.serial(async () => { await io.acted(); await io.leave('inbox') })}>b back</Button>
        <Text dimColor>esc home</Text>
      </Box>
    </Box>
  )
}

// --- The PR card and the batch card (Reviewer section). ---

type PrIo = {
  acted: () => Promise<void>
  serial: <T>(fn: () => Promise<T>) => Promise<T>
  // Both re-read the handover and refuse when it is no longer in the right state (prcard.ts).
  approve: (pr: number) => Promise<string>
  reject: (pr: number, why: string) => Promise<string>
  openUrl: (pr: number) => Promise<string>
  setNote: (v: string) => Promise<unknown>
  readDraft: () => Promise<string>
  setDraft: (v: string) => Promise<unknown>
  toast: (text: string) => void
  leave: () => Promise<void>
}
export type PrCardCtx = {
  els: Els
  Input: ((p: InputProps) => null) | undefined
  rows: number
  columns: number
  pr: number | null
  ho: Handover | undefined
  entry: DetailsEntry | undefined
  mergeMode: string
  now: number
  draft: string
  note: string
  scroll?: CardScroll
  io: PrIo
}

const toneOf = (r: CardRow): string | undefined => r.tone

// One handed-over PR in full. Approve and Reject only on an awaiting one; every press runs the
// shared functions, which read the handover fresh, so a double press or a reviewer that took it
// meanwhile changes nothing.
export function prCardView(x: PrCardCtx) {
  const { Input, io, rows, draft, note } = x
  // Not named h: that is the JSX factory.
  const ho = x.ho
  const { Box, Text, Button } = x.els
  const back = () => io.serial(async () => { await io.acted(); await io.leave() })
  const backBtn = <Button key="pr-back" hotkey="b" onPress={back}>Back</Button>
  if (ho === undefined) {
    return (
      <Box flexDirection="column" height={rows}>
        <Box flexDirection="row" gap={1}>{backBtn}<Text dimColor>esc home</Text></Box>
        <Text dimColor>PR #{x.pr ?? '?'} is not handed over any more.</Text>
      </Box>
    )
  }
  const awaiting = ho.status === 'awaiting'
  const act = (run: () => Promise<string>) => () => void io.serial(async () => {
    await io.acted()
    const text = await run()
    await io.setNote(text)
    io.toast(clip(text, 120))
  })
  const approve = act(() => io.approve(ho.pr))
  // The reason is what is typed now (or what Enter submitted), read fresh at the press.
  const reject = (typed?: string) => act(async () => {
    const text = await io.reject(ho.pr, (typed ?? await io.readDraft()).trim())
    await io.setDraft('')
    return text
  })()
  // The rows after markdown: one entry per drawn row, so the room below counts what is really on screen.
  const body: { line: Line; row: CardRow }[] = prCardRows(ho, { entry: x.entry, mergeMode: x.mergeMode, now: x.now })
    .flatMap(r => { const ls = rowLines(r, Math.max(20, x.columns)); return (ls.length === 0 ? [[]] : ls).map(line => ({ line, row: r })) })
  // The back row, the button row, the note and the input take what the body does not; the body scrolls in the rest.
  const w = scrollWindow(body, Math.max(3, rows - 2 - (note === '' ? 0 : 1) - (awaiting && Input !== undefined ? 1 : 0)), `pr:${ho.pr}`, x.scroll)
  return (
    <Box flexDirection="column" height={rows}>
      <Box flexDirection="row" gap={1} flexShrink={0}>{backBtn}<Text dimColor>esc home</Text>{scrollKeys(Button, 'pr', w, x.scroll)}</Box>
<Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
      {w.shown.map((r, i) => spansEl(Text, r.line, `pr-row-${i}`, { ...(r.row.bold ? { bold: true as const } : {}), ...(r.row.dim ? { dim: true as const } : {}), ...(toneOf(r.row) === undefined ? {} : { color: toneOf(r.row)! }) }, 'truncate-end'))}
      {w.pos !== undefined && <Text dimColor wrap="truncate-end">{w.pos}</Text>}
      </Box>
      <Box flexDirection="column" flexShrink={0}>
      {note !== '' && <Text color="suggestion" wrap="truncate-end">{note}</Text>}
      {awaiting && Input !== undefined && <Input key="pr-reason" label="reason " placeholder="why you reject it (optional), then Enter" value={draft} onInput={(v: string) => void io.setDraft(v)} onSubmit={(v: string) => reject(v)} />}
      <Box flexDirection="row" gap={1}>
        {awaiting && <Button key="pr-approve" hotkey="a" onPress={approve}>Approve</Button>}
        {awaiting && <Button key="pr-reject" hotkey="r" onPress={() => reject()}>Reject</Button>}
        <Button key="pr-open" hotkey="g" onPress={act(() => io.openUrl(ho.pr))}>Open on GitHub</Button>
      </Box>
      </Box>
    </Box>
  )
}

export type BatchCtx = {
  els: Els
  rows: number
  batch: PushState['batch']
  hs: Record<string, Handover>
  note: string
  // The PR picked to be sent back (or 0, Drop of the whole batch), awaiting the confirming press.
  pick: number | null
  now: number
  columns: number
  scroll?: CardScroll
  io: {
    acted: () => Promise<void>
    serial: <T>(fn: () => Promise<T>) => Promise<T>
    // The same io.pushAct /flow push calls, as the person.
    act: (act: PushAct) => Promise<string>
    openPr: (pr: number) => Promise<void>
    setPick: (pr: number | null) => Promise<unknown>
    setNote: (v: string) => Promise<unknown>
    toast: (text: string) => void
    leave: () => Promise<void>
  }
}

// The pick value that asks to confirm Drop instead of naming a PR (PR numbers are positive).
const DROP_PICK = 0

// The ready push batch: its PRs (each opens its own card) and Push, Send one back, Drop.
export function batchCardView(x: BatchCtx) {
  const { io, rows, batch, hs, note, pick } = x
  const { Box, Text, Button } = x.els
  const back = () => io.serial(async () => { await io.acted(); await io.leave() })
  const backBtn = <Button key="batch-back" hotkey="b" onPress={back}>Back</Button>
  if (batch === undefined) {
    return (
      <Box flexDirection="column" height={rows}>
        <Box flexDirection="row" gap={1}>{backBtn}<Text dimColor>esc home</Text></Box>
        <Text dimColor>No batch is waiting for a push.</Text>
        {note !== '' && <Text color="suggestion">{note}</Text>}
      </Box>
    )
  }
  const ready = batch.state === 'ready'
  const run = (a: PushAct) => () => void io.serial(async () => {
    await io.acted()
    await io.setPick(null)
    const text = await io.act(a)
    await io.setNote(text)
    io.toast(clip(text, 120))
  })
  const titleOf = (n: number) => batch.items.find(i => i.pr === n)?.title ?? hs[String(n)]?.title ?? ''
  // The PR rows scroll between the header (back row, title, check, state, blank) and the confirm prompt, note and keys.
  const busyText = ready ? undefined : `Not waiting for you: ${batch.state === 'pushing' ? 'a reviewer is pushing it' : `it is being rebuilt${batch.reason === undefined ? '' : ` (${batch.reason})`}`}.`
  const confirmText = !ready ? undefined : pick !== null && batch.prs.includes(pick) ? `Send #${pick} back to its manager? Yes, send back No` : pick === DROP_PICK ? 'Drop the whole batch (all PRs go back)? Yes, drop No' : undefined
  const rowsOf = (t: string | undefined) => (t === undefined ? 0 : textRows(t, x.columns))
  const w = scrollWindow(batch.prs, Math.max(3, rows - 4 - rowsOf(busyText) - rowsOf(confirmText) - (note === '' ? 0 : 1) - (ready ? 1 : 0)), `batch:${batch.id}`, x.scroll)
  return (
    <Box flexDirection="column" height={rows}>
<Box flexDirection="column" flexShrink={1} overflow="hidden">
      <Box flexDirection="row" gap={1} flexShrink={0}>{backBtn}<Text dimColor>esc home</Text>{scrollKeys(Button, 'batch', w, x.scroll)}</Box>
      <Text bold color="warning" wrap="truncate-end">Batch {batch.id}{batch.version === undefined ? '' : ` (${batch.version})`} <Text dimColor>{ready ? 'ready to push' : batch.state}</Text></Text>
      <Text dimColor wrap="truncate-end">checked {age(x.now - batch.createdAt)} ago · check: {batch.check === '' ? '(none recorded)' : inlineEl(Text, batch.check, 'batch-check')}</Text>
      {busyText !== undefined && <Text color="suggestion">{busyText}</Text>}
      <Text> </Text>
      </Box>
      <Box flexDirection="column" flexShrink={0} height={w.height} overflow="hidden">
      {w.shown.map(n => (
        <Box key={`batch-row-${n}`} flexDirection="row" gap={1}>
          <Button key={`batch-pr-${n}`} plain onPress={() => void io.serial(async () => { await io.acted(); await io.openPr(n) })}>
            <Text wrap="truncate-end">#{n} {inlineEl(Text, titleOf(n), `batch-title-${n}`)}{hs[String(n)] === undefined ? '' : ` · ${hs[String(n)]!.status}`}</Text>
          </Button>
          {ready && <Button key={`batch-pick-${n}`} plain dimColor onPress={() => void io.serial(async () => { await io.acted(); await io.setPick(n) })}>send back</Button>}
        </Box>
      ))}
      {w.pos !== undefined && <Text dimColor wrap="truncate-end">{w.pos}</Text>}
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={0}>
      {ready && pick !== null && batch.prs.includes(pick) && (
        <Box flexDirection="row" gap={1}>
          <Text color="warning">Send #{pick} back to its manager?</Text>
          <Button key="batch-back-yes" hotkey="y" onPress={run({ kind: 'back', pr: pick })}>Yes, send back</Button>
          <Button key="batch-back-no" hotkey="n" onPress={() => void io.serial(async () => { await io.acted(); await io.setPick(null) })}>No</Button>
        </Box>
      )}
      {ready && pick === DROP_PICK && (
        <Box flexDirection="row" gap={1}>
          <Text color="warning">Drop the whole batch (all PRs go back)?</Text>
          <Button key="batch-drop-yes" hotkey="y" onPress={run({ kind: 'drop' })}>Yes, drop</Button>
          <Button key="batch-drop-no" hotkey="n" onPress={() => void io.serial(async () => { await io.acted(); await io.setPick(null) })}>No</Button>
        </Box>
      )}
      </Box>
      <Box flexDirection="column" flexShrink={0}>
      {note !== '' && <Text color="suggestion" wrap="truncate-end">{note}</Text>}
      {ready && (
        <Box flexDirection="row" gap={1}>
          <Button key="batch-push" hotkey="p" onPress={run({ kind: 'push' })}>Push</Button>
          <Button key="batch-drop" hotkey="d" onPress={() => void io.serial(async () => { await io.acted(); await io.setPick(DROP_PICK) })}>Drop</Button>
        </Box>
      )}
      </Box>
    </Box>
  )
}
