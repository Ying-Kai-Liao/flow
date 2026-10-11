import type { AgentRow, TestSlots } from '../types'
import { heldBy, reapSlots } from './slots'
import { MAX_DEPTH, innerScript, parse, resolve } from './guards'

// The test-slot guard's matcher: is a Bash command a whole-suite run? Pure, so it is testable
// without the engine. A segment matches a pattern by token prefix (the pattern's tokens, then
// anything). What follows decides: no file arguments, a glob, a directory or more than
// MAX_FILES explicit files is the whole suite; one to MAX_FILES explicit files run freely.
const MAX_FILES = 5
const GLOB = /[*?[]/
// A path whose last part has no file extension (`.`, `tests`, `/tmp/x`, `./...`) is a directory.
const dirLike = (a: string) => a.endsWith('/') || !/\.\w+$/.test(a.split('/').pop() ?? a)

export const DEFAULT_SUITE_COMMANDS = ['claude plugin test', 'npm run check', 'npm test', 'npm run test']

const basename = (w: string) => w.split('/').pop() ?? w

// A trailing "." in a pattern ("claude plugin test .") only says "the whole suite": drop it so
// that `claude plugin test tests/*.test.ts` is judged by its arguments like the rest.
function tokensOf(pattern: string): string[] {
  const t = pattern.trim().split(/\s+/).filter(Boolean)
  return t.length > 1 && t[t.length - 1] === '.' ? t.slice(0, -1) : t
}

function suiteArgs(args: string[]): boolean {
  const rest = args.filter(a => !a.startsWith('-'))
  if (rest.length === 0) return true
  if (rest.some(a => GLOB.test(a) || dirLike(a))) return true
  return rest.length > MAX_FILES
}

// The first segment of `command` that runs a whole suite, as text, or undefined.
export function suiteRun(command: string, patterns: string[], depth = 0): string | undefined {
  if (depth > MAX_DEPTH || patterns.length === 0) return undefined
  const pats = patterns.map(tokensOf).filter(t => t.length > 0)
  for (const pipeline of parse(command)) {
    for (const cmd of pipeline) {
      for (const sub of cmd.subs) {
        const hit = suiteRun(sub, patterns, depth + 1)
        if (hit !== undefined) return hit
      }
      const { words } = resolve(cmd.words)
      if (words.length === 0) continue
      const script = innerScript(basename(words[0]!), words.slice(1))
      if (script !== undefined) {
        const hit = suiteRun(script, patterns, depth + 1)
        if (hit !== undefined) return hit
      }
      const norm = [basename(words[0]!), ...words.slice(1)]
      for (const p of pats) {
        if (p.length > norm.length || !p.every((tok, i) => tok === norm[i])) continue
        if (suiteArgs(norm.slice(p.length))) return words.join(' ')
      }
    }
  }
  return undefined
}

// The deny text for a whole-suite run, or undefined when `key` holds a confirmed slot.
// Holders are judged after reapSlots: an ended agent or an expired lease holds nothing, and an
// unconfirmed grant does not count until the agent calls acquire.
export function slotRefusal(state: TestSlots, rows: AgentRow[], key: string, limit: number, t: number, segment: string): string | undefined {
  const live = reapSlots(state, rows, t).state
  const mine = live.holders.find(h => h.key === key)
  if (mine !== undefined && mine.claimed !== false) return undefined
  const held = live.holders.length
    ? `Held now (${live.holders.length}/${limit}): ${live.holders.map(h => heldBy(h, t)).join(', ')}.`
    : 'The slots are free, so acquire is instant.'
  const how = mine !== undefined
    ? 'Your slot is granted but unconfirmed: call mcp__flow__test_slot action "acquire" once to confirm it.'
    : 'Call mcp__flow__test_slot action "acquire" first, and "release" when the run is over.'
  return `flow: \`${segment}\` runs a whole suite. ${how} ${held}`
}
