import type { AgentRow, TestSlots } from '../types'
import { heldBy, reapSlots } from './slots'
import { reapTypecheck } from './typecheck-slots'
import { MAX_DEPTH, innerScript, parse, resolve } from './guards'

// The test-slot guard's matcher: is a Bash command a whole-suite run? Pure, so it is testable
// without the engine. A segment matches a pattern by token prefix (the pattern's tokens, then
// anything). What follows decides: no file arguments, a glob, a directory or more than
// MAX_FILES explicit files is the whole suite; one to MAX_FILES explicit files run freely.
const MAX_FILES = 5
const GLOB = /[*?[]/
// A path whose last part has no file extension (`.`, `tests`, `/tmp/x`, `./...`) is a directory.
const dirLike = (a: string) => a.endsWith('/') || !/\.\w+$/.test(a.split('/').pop() ?? a)

// scripts/test-files.sh runs the whole suite with --all (or no files), so it counts like the runner it wraps.
export const DEFAULT_SUITE_COMMANDS = ['claude plugin test', 'npm run check', 'npm test', 'npm run test', 'sh scripts/test-files.sh', 'bash scripts/test-files.sh', 'test-files.sh']

const basename = (w: string) => w.split('/').pop() ?? w

// A trailing "." in a pattern ("claude plugin test .") only says "the whole suite": drop it so
// that `claude plugin test tests/*.test.ts` is judged by its arguments like the rest.
function tokensOf(pattern: string): string[] {
  const t = pattern.trim().split(/\s+/).filter(Boolean)
  return t.length > 1 && t[t.length - 1] === '.' ? t.slice(0, -1) : t
}

// `--help`, `-h` and `--version` only print text: not a run of anything.
const INFO_FLAGS = new Set(['--help', '-h', '--version'])
const infoOnly = (args: string[]) => args.some(a => INFO_FLAGS.has(a))

function suiteArgs(args: string[]): boolean {
  if (infoOnly(args)) return false
  if (args.includes('--all')) return true
  // `--jobs 4` takes a value that is not a file.
  const rest = args.filter((a, i) => !a.startsWith('-') && args[i - 1] !== '--jobs')
  if (rest.length === 0) return true
  if (rest.some(a => GLOB.test(a) || dirLike(a))) return true
  return rest.length > MAX_FILES
}

// The first segment of `command` that runs a whole suite, as text, or undefined.
export const suiteRun = (command: string, patterns: string[]): string | undefined => segmentRun(command, patterns, suiteArgs)

export const DEFAULT_TYPECHECK_COMMANDS = ['npm run typecheck', 'tsc', 'npx tsc']

// The first segment of `command` that starts a typecheck, as text, or undefined. Whatever follows
// the command is irrelevant (`tsc -p .` and `tsc` are the same load), except help and version.
export const typecheckRun = (command: string, patterns: string[]): string | undefined => segmentRun(command, patterns, args => !infoOnly(args))

function segmentRun(command: string, patterns: string[], judge: (args: string[]) => boolean, depth = 0): string | undefined {
  if (depth > MAX_DEPTH || patterns.length === 0) return undefined
  const pats = patterns.map(tokensOf).filter(t => t.length > 0)
  for (const pipeline of parse(command)) {
    for (const cmd of pipeline) {
      for (const sub of cmd.subs) {
        const hit = segmentRun(sub, patterns, judge, depth + 1)
        if (hit !== undefined) return hit
      }
      const { words } = resolve(cmd.words)
      if (words.length === 0) continue
      const script = innerScript(basename(words[0]!), words.slice(1))
      if (script !== undefined) {
        const hit = segmentRun(script, patterns, judge, depth + 1)
        if (hit !== undefined) return hit
      }
      const norm = [basename(words[0]!), ...words.slice(1)]
      for (const p of pats) {
        if (p.length > norm.length || !p.every((tok, i) => tok === norm[i])) continue
        if (judge(norm.slice(p.length))) return words.join(' ')
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

// Workers run the test files they touched, never the whole suite: the reviewer's full check does
// that. Applies even when the worker holds a slot. Undefined for any other caller.
export function workerSuiteRefusal(isWorker: boolean, segment: string): string | undefined {
  if (!isWorker) return undefined
  return `flow: \`${segment}\` runs the whole suite, which only the reviewer's full check does. Run just the test files you added or changed. \`claude plugin test\` takes a folder, not files, so use \`sh scripts/test-files.sh tests/<name>.test.ts ...\` (it runs only those files), or your runner's own file arguments.`
}

// The deny text for a typecheck, or undefined when `key` holds a confirmed typecheck slot. A
// test-slot holder may typecheck too: the reviewer's full check includes one and must not deadlock.
export function typecheckRefusal(tc: TestSlots, tests: TestSlots, rows: AgentRow[], key: string, limit: number, t: number, segment: string): string | undefined {
  const holds = (s: TestSlots) => s.holders.some(h => h.key === key && h.claimed !== false)
  if (holds(reapSlots(tests, rows, t).state)) return undefined
  const live = reapTypecheck(tc, rows, t).state
  const mine = live.holders.find(h => h.key === key)
  if (mine !== undefined && mine.claimed !== false) return undefined
  const held = live.holders.length
    ? `Held now (${live.holders.length}/${limit}): ${live.holders.map(h => heldBy(h, t)).join(', ')}.`
    : 'The slots are free, so acquire is instant.'
  const how = mine !== undefined
    ? 'Your slot is granted but unconfirmed: call mcp__flow__test_slot kind "typecheck" action "acquire" once to confirm it.'
    : 'Call mcp__flow__test_slot with kind "typecheck", action "acquire" first, and "release" when it is over.'
  return `flow: \`${segment}\` is a typecheck. ${how} ${held}`
}
