import type { Ledger, LogEvent } from '../types'
import { baseName } from './cost'
import { generation, isSize } from './routing'
import type { Size } from './routing'

export const DIGEST_HEADER = "## Recent worker sizing on this repo (from flow's records; weigh it when you write Size lines)"
const WINDOW = 20
const MIN_WORKERS = 5
const EXAMPLES = 3

// How this repo's earlier workers turned out, by the Size line they ran at, for the manager who is about to write new
// ones. A worker "needed a rerun" by the same signals as sizeData (hooks/decide-eval.ts): a -N successor in the ledger,
// or a continue/handoff event on its branch; a handoff of a worker that ran large says nothing about the model, so
// only a successor counts there. Workers still running count as recent, not as rerun. '' when there is too little history.
export function sizeDigest(ledger: Ledger, log: Pick<LogEvent, 'event' | 'branch'>[]): string {
  const workers = Object.values(ledger).filter(r => r.role === 'worker')
  const firsts = workers.filter(r => generation(r.name) === 1 && isSize(r.size))
  if (firsts.length < MIN_WORKERS) return ''
  const handedOff = new Set(log.filter(l => (l.event === 'continue' || l.event === 'handoff') && l.branch !== undefined).map(l => l.branch))
  const successors = new Set(workers.filter(r => generation(r.name) > 1).map(r => baseName(r.name)))
  const lines: string[] = []
  for (const size of ['small', 'normal', 'large'] as Size[]) {
    // Ledger order is spawn order; firstAt (when present) settles a merged or rebuilt file.
    const recent = firsts.map((r, i) => ({ r, i })).filter(x => x.r.size === size).sort((a, b) => (a.r.firstAt ?? 0) - (b.r.firstAt ?? 0) || a.i - b.i).slice(-WINDOW).map(x => x.r)
    if (recent.length === 0) continue
    const reran = recent.filter(r => successors.has(r.name) || (size !== 'large' && r.branch !== undefined && handedOff.has(r.branch)))
    const eg = reran.length > 0 ? `, e.g. ${reran.slice(-EXAMPLES).map(r => r.name).join(', ')}` : ''
    const what = size === 'small' ? 'a rerun one size up' : 'a rerun (successor or handoff)'
    lines.push(`- ${size}: ${recent.length} recent${size === 'large' ? '' : `, ${reran.length} needed ${what}${eg}`}`)
  }
  return [DIGEST_HEADER, ...lines].join('\n')
}

// The prompt with the digest appended once; unchanged when it already has the header or there is no digest.
export function withDigest(prompt: string, digest: string): string {
  return digest === '' || prompt.includes(DIGEST_HEADER) ? prompt : `${prompt.replace(/\s+$/, '')}\n\n${digest}\n`
}
