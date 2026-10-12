// Redraw pacing for the Flow pane. The engine redraws a render hook whenever an atom it read changes (at most
// ten a second), and every draw rebuilds the whole tree, so ten streaming agents made the pane redraw as fast as
// the engine allowed. A draw here reads one snapshot of the atoms (the engine still subscribes the instance to
// each), then decides: a person's action (props, focus, selection, scrolling, the inbox) draws at once; a
// background change (activity, ledger, roster, the clock) draws at most every BG_MS, the newest state always
// drawn by a trailing redraw; a change that alters nothing drawn returns the last tree.
export const BG_MS = 250
// Token counts move on every step but a changing number needs no more than this to look live.
export const TOKENS_MS = 1000
export const USAGE_TTL_MS = 1000

const sameList = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]))

// Activity maps equal apart from usage.tokens, which only the slower window waits for.
export function sameBeyondTokens(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  if (a === b) return true
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every(k => {
    const x = a[k] as Record<string, unknown> | undefined
    const y = b[k] as Record<string, unknown> | undefined
    if (x === y) return true
    if (x === undefined || y === undefined) return false
    const { usage: ux, ...rx } = x as { usage?: Record<string, unknown> }
    const { usage: uy, ...ry } = y as { usage?: Record<string, unknown> }
    if (JSON.stringify(rx) !== JSON.stringify(ry)) return false
    if (ux === undefined || uy === undefined) return ux === uy
    return JSON.stringify({ ...ux, tokens: 0 }) === JSON.stringify({ ...uy, tokens: 0 })
  })
}

// What a draw's decision looks at. `user` and `bg` are lists of atom values compared by identity; `activity` is the
// activity map; `props` is the event's props and viewport as text.
export type DrawKeys = { props: string; user: readonly unknown[]; bg: readonly unknown[]; activity: Record<string, unknown> }

export type Drawn<T> = { tree: T; keys: DrawKeys; at: number }

export type Gate<T> = {
  // Draws (calling `draw`) or returns the last tree; `later(ms, fired)` asks for a redraw that long from now and calls `fired` when it comes.
  frame: (keys: DrawKeys, draw: () => Promise<T>, later: (ms: number, fired: () => void) => void) => Promise<T>
  last: () => Drawn<T> | undefined
}

export function createGate<T>(clock: () => number = Date.now): Gate<T> {
  let last: Drawn<T> | undefined
  let waiting = false
  const drawNow = async (keys: DrawKeys, draw: () => Promise<T>) => {
    const tree = await draw()
    last = { tree, keys, at: clock() }
    return tree
  }
  return {
    last: () => last,
    async frame(keys, draw, later) {
      if (last === undefined || last.keys.props !== keys.props || !sameList(last.keys.user, keys.user)) return drawNow(keys, draw)
      const shapeMoved = !sameList(last.keys.bg, keys.bg) || !sameBeyondTokens(last.keys.activity, keys.activity)
      if (!shapeMoved && last.keys.activity === keys.activity) return last.tree
      const wait = (shapeMoved ? BG_MS : TOKENS_MS) - (clock() - last.at)
      if (wait <= 0) return drawNow(keys, draw)
      // One pending timer covers every change inside the window; its redraw finds the newest state.
      if (!waiting) {
        waiting = true
        later(wait, () => { waiting = false })
      }
      return last.tree
    },
  }
}

// A value fetched at most once per ttl; a clock that went backwards fetches again.
export function ttlCache<T>(ttl: number, clock: () => number = Date.now): (fetch: () => Promise<T>) => Promise<T> {
  let seen: { at: number; value: T } | undefined
  return async fetch => {
    const t = clock()
    if (seen === undefined || t - seen.at >= ttl || t < seen.at) seen = { at: t, value: await fetch() }
    return seen.value
  }
}
