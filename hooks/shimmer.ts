// The "working" shine of an agent's name in the pane: a short bright stretch that sweeps along the
// label, one step per pane tick. Pure, so the pane and its tests share it.
export type ShimmerPart = { text: string; lit: boolean }

const WIDTH = 2
const GAP = 4

// The phase comes from the clock, not from a counter, so every card sweeps in step and a redraw
// never restarts it. `now` is in milliseconds; the sweep moves once per second.
export function shimmerParts(label: string, now: number): ShimmerPart[] {
  const chars = [...label]
  if (chars.length === 0) return []
  const at = Math.floor(now / 1000) % (chars.length + GAP) - WIDTH + 1
  const from = Math.max(0, at)
  const to = Math.min(chars.length, at + WIDTH)
  const parts: ShimmerPart[] = [
    { text: chars.slice(0, from).join(''), lit: false },
    { text: chars.slice(from, Math.max(from, to)).join(''), lit: true },
    { text: chars.slice(Math.max(from, to)).join(''), lit: false },
  ]
  return parts.filter(p => p.text !== '')
}
