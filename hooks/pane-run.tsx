// The bodies of the Flow pane's hooks (ui.focus, ui.render), as functions of a PaneIo: register.tsx owns the
// `on(...)` registrations and writes the io from the event's `$` in each hook, so `$` never crosses an import.
import type { Activity, AgentRow, Breaker, Handover, Ledger, Leftovers, Session } from '../types'
import type { AgentFact, Plan } from './dag'
import type { Limit } from './sessions'
import type { PushAct } from './pushgate-run'
import type { PushState } from './pushgate'
import type { Deploys } from './deploy'
import type { Checks } from './checks'
import type { Inbox, PaneRow } from './inbox'
import type { Unhanded } from './status-run'
import type { DemoState } from './demo-replay'
import type { DetailsCache } from './prcard'
import type { settingsOf } from './settings'
import type { EngineInterface } from 'claude-code'
import { agentView, archiveView, batchCardView, card as cardTo, cardView, graphModeView, inboxView, managerGraphView, meter as meterTo, prCardView, treeView } from './pane-view'
import type { CardScroll, InboxCtx, PaneCtx, Usage } from './pane-view'
import { demoView } from './demo-view'
import { canAdvance, advance as demoAdvance, answer as demoAnswer, isLast as demoIsLast } from './demo-replay'
import { detailsKey, detailsStale, fetchDetails, openerFor, urlNote } from './prcard'
import { dupHidden } from './inbox-dups'
import { askingNames, foldedOf, groupExpanded, hiddenByLink, isFyi, openAll } from './inbox'
import { leftoverLine } from './clean'
import { PUSH_KIND } from './pushgate'
import { breakerLine } from './reviewer-breaker'
import { paneChecksLine } from './checks'
import { behindLines } from './deploy'
import { claudeLimits, SESSION } from './sessions'
import { elapsed, labelOf, warnPercent, windowOf } from './meter'
import { FINISHED_KEY, finishedIds, foldDefault, shortModel } from './pane'
import { MANAGER, mirror } from './core'
import { planOwner } from './roster-run'
import { createGate, ttlCache, USAGE_TTL_MS } from './pane-throttle'
import type { DrawKeys, Gate } from './pane-throttle'

export const DEMO_DONE = 'Demo finished. /flow init settings sets your commands; /flow init demo live runs it for real (uses tokens).'
const MERGE_QUEUE_KEY = '#merge-queue'
const QUESTIONS_KEY = '#questions'
// A second press within this long confirms restart or stop from the pane.
const ARM_MS = 5000

// The state the pane reads and writes, by atom name (the atoms are declared in register.tsx).
export type PaneState = {
  roster: AgentRow[]
  activity: Record<string, Activity>
  selected: string | null
  cursor: string | null
  folded: Record<string, boolean>
  overrideView: string | null | undefined
  hinted: boolean
  now: number
  handovers: Record<string, Handover>
  inbox: Inbox
  checks: Checks
  ledger: Ledger
  leftovers: Leftovers
  sessions: Record<string, Session>
  harnessLimits: Limit[]
  armed: { key: string; at: number } | null
  deploys: Deploys
  behind: Record<string, number>
  pushState: PushState
  reviewerBreaker: Breaker
  plan: Plan
  viewMode: 'tree' | 'graph' | 'inbox' | 'card' | 'archive' | 'pr' | 'batch'
  prShown: number | null
  prBack: 'tree' | 'batch'
  batchPick: number | null
  prDetails: DetailsCache
  inboxCursor: string | null
  cardBack: 'tree' | 'inbox' | 'archive'
  inboxFolds: Record<string, boolean>
  inboxOpen: Record<string, boolean>
  inboxDraft: string
  inboxNote: string
  graphFocus: string | null
  demo: DemoState | null
  // The scrolled offset of a card's body and the card it is for (q:<id>, pr:<n>, batch:<id>); another card starts at 0.
  cardScroll: { key: string; top: number }
}

// The single seam for the pane's state reads: one closure per atom, called while the pane draws so the
// draw subscribes through the render hook's own `$`. Everything the pane needs from register.tsx
// (the engine, the `$`-taking helpers, the closure lets) is behind this io, written per event in the ui.render hook.
export type PaneIo = {
  read: { [K in keyof PaneState]: () => Promise<PaneState[K]> }
  set: {
    [K in 'selected' | 'cursor' | 'folded' | 'overrideView' | 'hinted' | 'armed' | 'viewMode' | 'prShown' | 'prBack' | 'batchPick' | 'prDetails' | 'inboxCursor' | 'cardBack' | 'inboxFolds' | 'inboxOpen' | 'inboxDraft' | 'inboxNote' | 'graphFocus' | 'demo' | 'cardScroll']: (fn: (v: PaneState[K]) => PaneState[K]) => Promise<unknown>
  }
  // Takes the render event: register.tsx keeps no closure holding `$` and the hook's event together.
  resolve: (e: PaneEvent) => ReturnType<EngineInterface['ui']['resolve']>
  now: () => Promise<number>
  usage: () => Promise<Awaited<ReturnType<EngineInterface['session']['usage']>> | undefined>
  toast: (text: string) => void
  // Ask the engine for another ui.render, and run something later (clock.after): the throttle's trailing redraw.
  invalidate: () => void
  after: (ms: number, fn: () => void) => void
  focus: (key: string) => Promise<unknown>
  fill: (text: string) => Promise<unknown>
  runProcess: (argv: string[], timeoutMs: number) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  serial: <T>(fn: () => Promise<T>) => Promise<T>
  settings: () => ReturnType<typeof settingsOf>
  installed: () => string | undefined
  mainModel: () => string | undefined
  mainWindow: () => number | undefined
  setMainWindow: (w: number) => void
  paneFollow: () => { pick: string; cur: string } | null
  setPaneFollow: (f: { pick: string; cur: string } | null) => void
  paneView: () => string | null
  setPaneView: (v: string | null) => void
} & PaneActs

// The pane's actions that run a `$`-taking helper of register.tsx, written in the same io literal
// (a builder of their own, paneActsIoOf, until plain-names check 11).
export type PaneActs = {
  unhanded: () => Promise<Unhanded[]>
  endedOwners: () => Promise<Set<string>>
  demoArm: (s: DemoState) => void
  demoMove: (fn: (s: DemoState, t: number) => DemoState) => Promise<void>
  demoStop: () => Promise<string>
  pushAct: (act: PushAct, by: string) => Promise<string>
  approve: (pr: number) => Promise<string>
  reject: (pr: number, why: string) => Promise<string>
  platform: () => Promise<string>
  paneInboxRows: () => Promise<{ rows: PaneRow[]; now: number }>
  suggestions: () => Promise<Array<{ id: string; text: string }>>
  dismiss: (ids: string[]) => Promise<void>
  answer: (id: string, choice: string | null) => Promise<string>
  sessionTool: (input: Record<string, unknown>) => Promise<string>
}

// What ui.focus and ui.scroll use of PaneIo: their hooks write just these members inline (plain-names check 11).
export type PaneFocusIo = {
  read: Pick<PaneIo['read'], 'roster'>
  set: Pick<PaneIo['set'], 'selected' | 'cursor' | 'overrideView'>
} & Pick<PaneIo, 'paneFollow' | 'paneView'>
export type PaneScrollIo = { set: Pick<PaneIo['set'], 'cardScroll'> } & Pick<PaneIo, 'invalidate'>

export type PaneEvent = { props?: unknown; viewport?: { rows: number; columns: number } }

// The PR card's gh details, fetched when the card is opened (a render is pure, it cannot write): the entry
// is marked first so a second open does not start another call, and the result lands in the cache, which
// redraws the pane. Keyed by PR and head; a fresh entry is not fetched again.
function fetchPrDetails(io: PaneIo, pr: number): void {
  void (async () => {
    const ho = (await io.read.handovers())[String(pr)]
    if (ho === undefined) return
    const key = detailsKey(ho)
    const t = await io.now()
    if (!detailsStale((await io.read.prDetails())[key], t)) return
    await io.set.prDetails(c => ({ ...c, [key]: { ...c[key], fetchedAt: t, fetching: true as const } }))
    const fresh = await fetchDetails((argv, timeoutMs) => io.runProcess(argv, timeoutMs), pr, await io.now())
    await io.set.prDetails(c => ({ ...c, [key]: fresh }))
  })().catch(() => undefined)
}

// Arrows and Tab move the focus ring over the cards; the highlight follows it.
export async function paneFocus(io: PaneFocusIo, element: string | undefined): Promise<void> {
  if (element === undefined || !(await io.read.roster()).some(a => a.id === element)) return
  // Acting while following keeps what was shown, then the person's move applies on top.
  const f = io.paneFollow()
  if (f !== null) {
    await io.set.selected(() => f.pick)
    await io.set.cursor(() => f.cur)
  }
  const view = io.paneView()
  await io.set.overrideView(() => view)
  await io.set.cursor(() => element)
}

// The card body drawn last that has more rows than room (its key, last offset and page), set by the draw:
// null while no card body scrolls, so ui.scroll then leaves the pane's own scroll to the engine.
let scrollable: { key: string; max: number; page: number } | null = null
export const NO_SCROLL = { key: '', top: 0 }

// Moves the drawn card's body by `by` rows, clamped at both ends; a page key (by a whole pane body, `bodyRows`)
// moves the card's own page. False when no card body scrolls.
export async function paneScroll(io: PaneScrollIo, by: number, bodyRows?: number): Promise<boolean> {
  const s = scrollable
  if (s === null) return false
  const step = bodyRows !== undefined && Math.abs(by) >= bodyRows ? Math.sign(by) * s.page : by
  await io.set.cardScroll(c => ({ key: s.key, top: Math.min(s.max, Math.max(0, (c.key === s.key ? Math.min(c.top, s.max) : 0) + step)) }))
  io.invalidate()
  return true
}

// The body's rows, not the terminal's: viewport.rows counts the whole screen, so a tree that tall
// would push its bottom rows (the hotkey row) under the prompt.
const bodyRowsOf = (e: PaneEvent) =>
  (e.props as { scroll?: { bodyRows?: number } }).scroll?.bodyRows ?? e.viewport?.rows ?? 24

export async function renderPane(io: PaneIo, e: PaneEvent) {
  // A throw while building the tree would leave the pane blank with no hint why; draw one line instead.
  // The body below is wrapped as is (not re-indented) to keep the diff to this fix.
  try {
  return await (async () => {
  const { Box, Text, Button } = io.resolve(e)
  // Only a card drawn in this draw scrolls; its view says so through `seen`.
  scrollable = null
  const scroll: CardScroll = {
    at: await io.read.cardScroll(),
    seen: (key, max, page) => { scrollable = max > 0 ? { key, max, page } : null },
    move: by => paneScroll(io, by),
  }
  const dm = await io.read.demo()
  if (dm !== null) {
    const Input = (io.resolve(e) as unknown as { Input?: Parameters<typeof demoView>[0]['Input'] }).Input
    return demoView({
      els: { Box, Text, Button }, Input, rows: bodyRowsOf(e), state: dm, now: await io.read.now(), draft: await io.read.inboxDraft(), note: await io.read.inboxNote(),
      io: {
        setDraft: v => io.set.inboxDraft(() => v),
        setNote: v => io.set.inboxNote(() => v),
        answer: (id, choice) => io.serial(async () => {
          const cur = await io.read.demo()
          if (cur === null) return 'The demo has ended.'
          const r = demoAnswer(cur, id, choice, await io.now())
          await io.set.demo(() => r.state)
          await io.set.inboxDraft(() => '')
          if (r.state.step !== cur.step) { if (demoIsLast(r.state)) void io.toast(DEMO_DONE); io.demoArm(r.state) }
          return r.text
        }),
        toast: text => { void io.toast(text) },
        focus: key => io.focus(key).catch(() => undefined),
        advance: () => io.demoMove((s, t) => (canAdvance(s) ? demoAdvance(s, t) : s)),
        stop: async () => { void io.toast(await io.demoStop()) },
      },
    })
  }
  let [list, acts, pick, t, hs, cur, fold, unhanded, leftCounts] = await Promise.all([
    io.read.roster(), io.read.activity(), io.read.selected(), io.read.now(), io.read.handovers(),
    io.read.cursor(), io.read.folded(), io.unhanded(), io.read.leftovers(),
  ])
  const leftover = leftoverLine(leftCounts)
  // The push item is drawn as the banner on top, not as a question.
  const boxNow = await io.read.inbox()
  const dupRows = dupHidden(openAll(boxNow))
  const openQs = openAll(boxNow).filter(q => !isFyi(q) && q.kind !== PUSH_KIND && !hiddenByLink(boxNow, q) && !dupRows.has(q.id)).sort((a, b) => Number(b.blocking) - Number(a.blocking))
  const gate = (await io.read.pushState()).batch
  const breakerNote = breakerLine(await io.read.reviewerBreaker(), t)
  const askers = askingNames(await io.read.inbox())
  const fyiCount = openAll(await io.read.inbox()).filter(isFyi).length
  // Rows in the tree: questions and approvals, not decisions; those fold into the one Inbox line.
  const openItems = [...openQs, ...foldedOf(await io.read.inbox(), await io.endedOwners()).shown.filter(q => q.kind !== PUSH_KIND && !isFyi(q)).reverse()]
  // The key row is drawn when any key in it works: the agents' keys, the reviewer's, or the inbox's.
  // The inbox key also opens the archive, so answered items keep it drawn.
  const anyOpen = (await io.read.inbox()).items.length > 0
  const checksLine = paneChecksLine(await io.read.checks(), io.installed())
  // The questions block's rows depend on the pane height and its fold; the tree counts them itself (questionsBlock).
  const inboxRows = (checksLine === undefined ? 0 : 1) + (gate === undefined ? 0 : gate.state === 'ready' ? 2 : 1)
  const deployLines = behindLines(mirror.deployInfos, await io.read.deploys(), await io.read.behind()).slice(0, 3)
  const shown = await io.read.hinted()
  const override = await io.read.overrideView()
  const [mode, gfocus, plans] = await Promise.all([io.read.viewMode(), io.read.graphFocus(), io.read.plan()])
  const [sessionMap, hLimits, arm] = await Promise.all([io.read.sessions(), io.read.harnessLimits(), io.read.armed()])

  // The pane follows the transcript in view, derived here without writing: the viewed agent wins
  // until the person acts in the pane under that view. An id not in the roster is ignored.
  const viewId = (e.props as { view?: { agentId?: string } }).view?.agentId ?? null
  const following = viewId !== null && list.some(a => a.id === viewId) && viewId !== override
  if (following) {
    pick = viewId
    cur = viewId
  }
  io.setPaneFollow(following ? { pick: viewId!, cur: viewId! } : null)
  // Handlers record which view they acted in, so a later view change follows again.
  io.setPaneView(viewId)
  const acted = async () => {
    // Acting while following adopts what was shown, so the stored state does not jump back.
    if (following) {
      await io.set.selected(() => viewId)
      await io.set.cursor(() => viewId)
    }
    await io.set.overrideView(() => viewId)
  }
  const rows = bodyRowsOf(e)
  const settings = io.settings()
  const warnOf = (window: number) => warnPercent(settings, window)
  // Free: no breakdown asked. Main's figures also size a subagent on the same model.
  const usage = await io.usage().then(u => u, () => undefined)
  const main = usage?.context
  if (main !== undefined) io.setMainWindow(main.window)

  const usageOf = (a: AgentRow): Usage | undefined => {
    const u = acts[a.id]?.usage
    if (u === undefined) return undefined
    const window = u.window ?? windowOf(u.model, io.mainModel(), io.mainWindow(), u.tokens)
    return { percent: Math.round(u.tokens / window * 100), tokens: u.tokens, window }
  }
  const meter = (u: Usage | undefined, dim: boolean, time: string) => meterTo({ Box, Text, Button }, settings, warnOf, u, dim, time)
  // Running time: to now while live, frozen at the end once it ended (the moment the roster saw
  // it end, else its last activity). No start on record, no time.
  const runTime = (act: Activity | undefined, isEnded: boolean): string =>
    act?.startedAt === undefined ? '' : elapsed((isEnded ? act.endedAt ?? act.lastAt : t) - act.startedAt)

  // Quota left per window, for Claude (this session's account) and the harnesses flow can read:
  // the share left as a bar that turns at 40% and 20%, the reset, and when the pace runs it out.
  const limits = [...claudeLimits(usage?.rateLimits ?? []), ...hLimits]

  // A control on a session worker, run here without a model turn. Restart and stop take a second
  // press within ARM_MS, so a stray key never kills a worker.
  const control = (name: string, input: Record<string, unknown>, confirm?: string) => async () => {
    await acted()
    if (confirm !== undefined) {
      const key = `${name}:${String(input.action)}`
      const now2 = await io.now()
      const was = await io.read.armed()
      if (was?.key !== key || now2 - was.at > ARM_MS) {
        await io.set.armed(() => ({ key, at: now2 }))
        return
      }
      await io.set.armed(() => null)
    }
    const result = await io.sessionTool({ name, ...input })
    void io.toast(result.length > 200 ? `${result.slice(0, 199)}…` : result)
  }

  // One agent: a card (name, what it does, meter), or one compact row when the pane is short.
  // Only a top-level card has a border; deeper ones read as a tree by their indent.
  const open = async (id: string) => {
    await acted()
    await io.set.cursor(() => id)
    await io.set.selected(() => id)
    // No API switches the transcript, so say once how to get to it.
    if (!shown) {
      await io.set.hinted(() => true)
      const a = list.find(x => x.id === id)
      void io.toast(`To see its chat: ← then pick ${a === undefined ? 'it' : labelOf(a)}`)
    }
  }
  // Flips a card from what is drawn now; the choice is read fresh so rapid presses each count once.
  const toggleFold = async (a: AgentRow, shown: boolean) => {
    await acted()
    await io.set.folded(f => ({ ...f, [a.id]: !(f[a.id] ?? foldDefault(a) ?? shown) }))
  }
  const spent = await io.read.ledger()
  const modelOf = (a: AgentRow) => a.type === SESSION ? sessionMap[a.name ?? '']?.harness : shortModel(spent[a.id]?.spawnModel)
  const columns = e.viewport?.columns ?? 80
  const card = (a: AgentRow, depth: number, full: boolean, bordered: boolean, hot = false, collapsed?: boolean) => cardTo({
    els: { Box, Text, Button }, list, acts, askers, decisionPhrases: settings.decisionPhrases, t, usageOf, warnOf, meter, runTime, toggleFold, open, columns, modelOf,
  }, a, depth, full, bordered, hot, collapsed)
  const agent = list.find(a => a.id === pick)

  const toggle = <Button key="toggle-view" plain dimColor hotkey="g" onPress={async () => {
    await acted()
    await io.set.viewMode(m => (m === 'graph' ? 'tree' : 'graph'))
  }}>g {mode === 'graph' ? 'tree' : 'graph'}</Button>

  const toggleQueue = async () => {
    await acted()
    await io.set.folded(f => ({ ...f, [MERGE_QUEUE_KEY]: f[MERGE_QUEUE_KEY] === false }))
  }
  const toggleQuestions = async () => {
    await acted()
    await io.set.folded(f => ({ ...f, [QUESTIONS_KEY]: f[QUESTIONS_KEY] === false }))
  }
  const toggleFinished = async () => {
    await acted()
    await io.set.folded(f => ({ ...f, [FINISHED_KEY]: f[FINISHED_KEY] === false }))
  }
  const ctx: PaneCtx = {
    els: { Box, Text, Button }, list, acts, plans, rows, columns, modelOf, t, gfocus, shown, sessionMap, arm, armMs: ARM_MS,
    askers, decisionPhrases: settings.decisionPhrases, toggle, card, runTime, control, acted, open,
    back: async parentId => { await acted(); await io.set.selected(() => parentId) },
    fill: text => io.fill(text),
    toast: text => { void io.toast(text) },
    readFocus: () => io.read.graphFocus(),
    setFocus: id => io.set.graphFocus(() => id),
  }

  if (agent !== undefined && agent.type === MANAGER && mode === 'graph') return managerGraphView(ctx, agent, planOwner(plans, agent.name))
  if (agent !== undefined) return agentView(ctx, agent)

  if (mode === 'pr' || mode === 'batch') {
    const [shownPr, back, pickPr, note, draft, cache, sstate] = await Promise.all([io.read.prShown(), io.read.prBack(), io.read.batchPick(), io.read.inboxNote(), io.read.inboxDraft(), io.read.prDetails(), io.read.pushState()])
    const leave = async () => {
      await io.set.inboxNote(() => '')
      await io.set.inboxDraft(() => '')
      await io.set.batchPick(() => null)
      await io.set.cardScroll(() => NO_SCROLL)
      await io.set.viewMode(() => mode === 'pr' ? back : 'tree')
    }
    const openPr = async (n: number, from: 'tree' | 'batch') => {
      fetchPrDetails(io, n)
      await io.set.prShown(() => n)
      await io.set.prBack(() => from)
      await io.set.inboxNote(() => '')
      await io.set.inboxDraft(() => '')
      await io.set.cardScroll(() => NO_SCROLL)
      await io.set.viewMode(() => 'pr')
    }
    const common = { acted, serial: io.serial, toast: (text: string) => { void io.toast(text) }, setNote: (v: string) => io.set.inboxNote(() => v) }
    if (mode === 'batch') {
      return batchCardView({
        els: { Box, Text, Button }, rows, columns, batch: sstate.batch, hs, note, pick: pickPr, now: t, scroll,
        io: { ...common, act: a => io.pushAct(a, 'user'), openPr: n => openPr(n, 'batch'), setPick: n => io.set.batchPick(() => n), leave },
      })
    }
    const ho = shownPr === null ? undefined : hs[String(shownPr)]
    const key = ho === undefined ? undefined : detailsKey(ho)
    const Input = (io.resolve(e) as unknown as { Input?: InboxCtx['Input'] }).Input
    return prCardView({
      els: { Box, Text, Button }, Input, rows, columns, pr: shownPr, ho, entry: key === undefined ? undefined : cache[key], mergeMode: settings.mergeMode, now: t, draft, note, scroll,
      io: {
        ...common, leave,
        approve: n => io.approve(n),
        reject: (n, why) => io.reject(n, why),
        readDraft: () => io.read.inboxDraft(),
        setDraft: v => io.set.inboxDraft(() => v),
        openUrl: async n => {
          const url = (await io.read.prDetails())[detailsKey((await io.read.handovers())[String(n)] ?? { pr: n, head: '' })]?.details?.url
          if (url === undefined) return 'No URL yet: the details have not loaded.'
          const opener = openerFor(await io.platform())
          if (opener === undefined) return urlNote(url)
          const r = await io.runProcess([opener, url], 5_000).catch(() => undefined)
          return r !== undefined && r.exitCode === 0 ? `Opened ${url}` : urlNote(url)
        },
      },
    })
  }
  if (mode === 'inbox' || mode === 'card' || mode === 'archive') {
    // Only some surfaces have an Input; without one the keys still answer.
    const Input = (io.resolve(e) as unknown as { Input?: InboxCtx['Input'] }).Input
    const [ibox, icur, draft, note, from, iopen] = await Promise.all([io.read.inbox(), io.read.inboxCursor(), io.read.inboxDraft(), io.read.inboxNote(), io.read.cardBack(), io.read.inboxOpen()])
    // The same rows a press reads, so what is drawn and what is pressed fold alike.
    const irows = (await io.paneInboxRows()).rows
    const sugg = mode === 'inbox' ? await io.suggestions() : []
    const deploys = mode === 'card' ? await io.read.deploys() : undefined
    const ictx: InboxCtx = {
      els: { Box, Text, Button }, Input, rows, columns, ibox, icur, draft, note, irows, sugg, iopen, list, now: t, from, scroll, deploys,
      io: {
        acted,
        rows: async () => (await io.paneInboxRows()).rows,
        readInbox: () => io.read.inbox(),
        readCursor: () => io.read.inboxCursor(),
        setCursor: key => io.set.inboxCursor(() => key),
        readDraft: () => io.read.inboxDraft(),
        setDraft: v => io.set.inboxDraft(() => v),
        setNote: v => io.set.inboxNote(() => v),
        answer: (id, choice) => io.answer(id, choice),
        dismissSugg: async ids => { await io.dismiss(ids) },
        serial: io.serial,
        toast: text => { void io.toast(text) },
        focus: key => io.focus(key).catch(() => undefined),
        back: async () => {
          await acted()
          await io.set.viewMode(() => 'tree')
        },
        open: async (id, origin) => {
          await io.set.inboxCursor(() => id)
          await io.set.cardBack(() => origin)
          await io.set.inboxNote(() => '')
          await io.set.cardScroll(() => NO_SCROLL)
          await io.set.viewMode(() => 'card')
        },
        leave: async to => {
          await io.set.inboxNote(() => '')
          await io.set.cardScroll(() => NO_SCROLL)
          await io.set.viewMode(() => to === 'tree' ? 'tree' : to)
        },
        toggleFold: async (key, firstKey) => {
          // Read fresh, so rapid presses each flip once.
          const was = groupExpanded(await io.read.inboxFolds(), key)
          await io.set.inboxFolds(f => ({ ...f, [key]: !was }))
          // A folded-away highlight would move on the next press; park it on the card's row, and on opening go to its first item.
          await io.set.inboxCursor(() => was ? key : firstKey)
        },
        // Expands or collapses one item's card; the highlight goes to it.
        toggleItem: async id => {
          await io.set.inboxOpen(o => ({ ...o, [id]: !o[id] }))
          await io.set.inboxCursor(() => id)
        },
      },
    }
    if (mode === 'card') return cardView({ ...ictx, id: icur })
    if (mode === 'archive') return archiveView(ictx)
    return inboxView(ictx)
  }
  if (mode === 'graph') return graphModeView(ctx)
  const mainTime = usage?.startedAt === undefined ? '' : elapsed(t - usage.startedAt)
  const mainU = main?.tokens === undefined ? undefined
    : { percent: main.percent ?? Math.round(main.tokens / main.window * 100), tokens: main.tokens, window: main.window }

  // Finished managers fold into one row; the transcript in view keeps its agent drawn.
  const finished = finishedIds(list, {
    handovers: Object.values(hs),
    owners: openAll(boxNow).map(q => q.owner),
    planOpen: name => Object.values(plans[planOwner(plans, name)] ?? {}).some(n => n.state !== 'done'),
  }, following ? viewId : undefined)
  return treeView({
    ...ctx, hs, fold, cur, unhanded, leftover, limits, openQs, openItems, fyiCount, anyOpen, checksLine, gate, breakerNote, inboxRows, deployLines, mainU, mainModel: shortModel(io.mainModel()), mainTime,
    mergeQueueKey: MERGE_QUEUE_KEY, questionsKey: QUESTIONS_KEY, finished, warnOf, meter, toggleFold, toggleQueue, toggleQuestions, toggleFinished,
    readCursor: () => io.read.cursor(),
    setCursor: id => io.set.cursor(() => id),
    focusRow: id => io.focus(id).catch(() => undefined),
    openInbox: async () => {
      await acted()
      await io.set.inboxCursor(() => null)
      await io.set.viewMode(() => 'inbox')
    },
    openCard: async id => {
      await acted()
      await io.set.inboxCursor(() => id)
      await io.set.cardBack(() => 'tree')
      await io.set.cardScroll(() => NO_SCROLL)
      await io.set.viewMode(() => 'card')
    },
    openPr: async n => {
      fetchPrDetails(io, n)
      await acted()
      await io.set.prShown(() => n)
      await io.set.prBack(() => 'tree')
      await io.set.inboxNote(() => '')
      await io.set.inboxDraft(() => '')
      await io.set.cardScroll(() => NO_SCROLL)
      await io.set.viewMode(() => 'pr')
    },
    openBatch: async () => {
      await acted()
      await io.set.batchPick(() => null)
      await io.set.inboxNote(() => '')
      await io.set.cardScroll(() => NO_SCROLL)
      await io.set.viewMode(() => 'batch')
    },
  })
  })()
  } catch (err) {
    const { Text } = io.resolve(e)
    return <Text>flow: pane failed to draw: {err instanceof Error ? err.message : String(err)}</Text>
  }
}

// What a person does changes these (or the props: scroll, view, width), and the draw follows at once; the inbox,
// handovers and push gate are rare and a person acts on them. The rest are background streams: the throttle
// paces them (pane-throttle.ts).
const USER_STATE = [
  'selected', 'cursor', 'folded', 'overrideView', 'hinted', 'armed', 'viewMode', 'prShown', 'prBack', 'batchPick', 'prDetails', 'inboxCursor', 'cardBack',
  'inboxFolds', 'inboxOpen', 'inboxDraft', 'inboxNote', 'graphFocus', 'demo', 'cardScroll', 'inbox', 'handovers', 'pushState',
] as const satisfies ReadonlyArray<keyof PaneState>
const BG_STATE = ['roster', 'now', 'checks', 'ledger', 'leftovers', 'sessions', 'harnessLimits', 'deploys', 'behind', 'reviewerBreaker', 'plan'] as const satisfies ReadonlyArray<keyof PaneState>

// The gate paces by the engine clock (read each draw), not Date.now, so a mocked or replayed clock paces too.
let paneNow = 0
const paneGate: Gate<Awaited<ReturnType<typeof renderPane>>> = createGate(() => paneNow)
const usageCache = ttlCache<Awaited<ReturnType<PaneIo['usage']>>>(USAGE_TTL_MS)

const propsKey = (e: PaneEvent): string => {
  try { return JSON.stringify([e.props, e.viewport]) } catch { return String(Math.random()) }
}

// The pane's hook entry: reads every atom once into a snapshot (so the engine subscribes the instance to each),
// lets the gate decide between drawing and returning the last tree, and draws from that snapshot. After the
// draw the snapshot is dropped: a key handler built in it reads live state when it runs.
export async function paneDraw(io: PaneIo, e: PaneEvent, gate: Gate<Awaited<ReturnType<typeof renderPane>>> = paneGate) {
  paneNow = await io.now()
  const names = Object.keys(io.read) as Array<keyof PaneState>
  const values = await Promise.all(names.map(n => io.read[n]()))
  const snap = Object.fromEntries(names.map((n, i) => [n, values[i]])) as PaneState
  let live = true
  const read = Object.fromEntries(names.map(n => [n, () => (live ? Promise.resolve(snap[n]) : io.read[n]())])) as PaneIo['read']
  const usage: PaneIo['usage'] = () => usageCache(() => io.usage())
  const keys: DrawKeys = { props: propsKey(e), user: USER_STATE.map(n => snap[n]), bg: BG_STATE.map(n => snap[n]), activity: snap.activity }
  try {
    return await gate.frame(keys, () => renderPane({ ...io, read, usage }, e), (ms, fired) => io.after(ms, () => { fired(); io.invalidate() }))
  } finally {
    live = false
  }
}
