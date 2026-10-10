// Model routing, the pure part: a brief's `Size:` line picks the worker's model at spawn, and a
// successor of a worker that failed runs one size up.

export type Size = 'small' | 'normal' | 'large'
export const SIZES: Size[] = ['small', 'normal', 'large']
export type SizeModels = Record<Size, string>

const SIZE_LINE = /^Size:\s*(small|normal|large)\b(.*)$/im

// The brief's size and its reason (the rest of the line, minus the dash or parentheses around it).
// An unknown word (`Size: tiny`) is no size line.
export function parseSize(prompt: string): { size: Size; reason: string } | undefined {
  const m = SIZE_LINE.exec(prompt)
  if (m === null) return undefined
  const reason = m[2]!.trim().replace(/^[\s\-–—(]+/, '').replace(/[\s)]+$/, '').trim()
  return { size: m[1]!.toLowerCase() as Size, reason }
}

export const isSize = (v: unknown): v is Size => v === 'small' || v === 'normal' || v === 'large'

export const modelFor = (size: Size, models: SizeModels): string => models[size]

export const escalate = (size: Size): Size => SIZES[Math.min(SIZES.indexOf(size) + 1, SIZES.length - 1)]!

export const biggerOf = (a: Size, b: Size): Size => (SIZES.indexOf(a) >= SIZES.indexOf(b) ? a : b)

// The least size a successor may run, from its predecessors' recorded sizes: one up from the largest.
// A predecessor with no recorded size (older data) says nothing; with none recorded there is no floor.
export function floorFrom(predecessors: Array<Size | string | undefined>): Size | undefined {
  const sizes = predecessors.filter(isSize)
  if (sizes.length === 0) return undefined
  return escalate(sizes.reduce(biggerOf))
}

// `x-2` and up is a successor of `x`; the number is its generation (a plain name is the first).
export const generation = (name: string): number => {
  const n = /-(\d+)$/.exec(name)
  return n === null ? 1 : Number(n[1])
}
export const isSuccessorName = (name: string): boolean => generation(name) >= 2

// The size a spawn ends up with: the brief's own, raised to the floor. Neither leaves it unset, which is
// today's behaviour. A large floor is kept, so the next successor escalates from large, not from nothing.
export function effectiveSize(declared: Size | undefined, floor: Size | undefined): Size | undefined {
  if (declared === undefined || floor === undefined) return declared ?? floor
  return biggerOf(declared, floor)
}

// Added to what a reviewer's "back" (or the user's send-back) tells the manager: when the PR's last
// worker ran below large, the continuation is a fresh `-N` worker, which the plugin runs one size up.
export function backNote(workers: Array<{ name: string; size?: string; spawnModel?: string }>, branch: string): string | undefined {
  const last = [...workers].sort((a, b) => generation(a.name) - generation(b.name)).at(-1)
  if (last === undefined || (last.size !== 'small' && last.size !== 'normal')) return undefined
  const next = `${last.name.replace(/-\d+$/, '')}-${generation(last.name) + 1}`
  return `Its worker ran ${last.size}${last.spawnModel === undefined ? '' : ` (${last.spawnModel})`}: continue with a fresh ${next} worker (Continue on branch: ${branch}); it runs one size up.`
}
