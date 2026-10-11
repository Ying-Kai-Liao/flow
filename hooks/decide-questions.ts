// The four questions the decision API (decide.ts) may answer in place of an agent turn, and the pure builders that turn a
// record into the provider text. Wiring them into the plugin is done elsewhere, behind settings; scripts/decide-eval.mjs
// replays real history through them. A provider reads nothing but this text, so each builder puts in everything the
// criteria refer to, and none reads a key, the environment or anything outside its record.
import { DECIDE_TEXT_MAX } from './decide'
import type { Question } from './decide'

// "ask_main" is the way out: a person should look. A classifier unsure between keep and undo should lean to it.
export const INBOX_ROUTINE_QUESTION: Question = {
  id: 'inbox_routine',
  type: 'choice',
  instructions: 'An agent recorded a routine, reversible decision with a default and asked whether to keep it or undo it. Decide from the text alone.',
  criteria: {
    keep: 'the decision is a reversible, conservative choice (a size, a threshold, wording, a name, a default) and nothing in the context says it is wrong, risky or contested',
    undo: 'the context shows the decision is wrong, contradicts a stated requirement, or the alternative is clearly better',
    ask_main: 'a person should look: it concerns money, publishing, deleting data, credentials, a production environment, a deploy, or what customers get; or it is a blocking question; or the text is unclear or the choice is a real trade-off',
  },
}

export const TEST_FAILURE_QUESTION: Question = {
  id: 'test_failure',
  type: 'choice',
  instructions: 'A test run failed. Decide from the failure output whether the failure is flaky (not caused by the change under test) or real.',
  criteria: {
    flaky: 'the failure looks environmental or nondeterministic: a timeout, a port or file already in use, a network error, a race, an ENOENT on a temp path, a test that passes alone and fails in a full run, with no assertion about the changed behavior',
    real: 'the failure is a deterministic assertion, type or syntax error, or a missing or changed export or behavior that the change under test plausibly broke',
  },
}

export const MERGE_CONFLICT_QUESTION: Question = {
  id: 'merge_conflict',
  type: 'choice',
  instructions: 'A merge of a pull request branch into the base branch conflicted. Decide from the conflicting files and hunks whether it is a trivial conflict a script may resolve, or one an agent must resolve.',
  criteria: {
    trivial: 'every conflicting file is a changelog or a version file (CHANGELOG.md, package.json version, plugin.json version) and both sides only add lines, so keeping both sides is correct',
    needs_agent: 'any conflicting file is source code, a test, documentation or configuration, or the two sides change the same lines differently, so the right result needs understanding of both changes',
  },
}

export const HANDOFF_QUESTION: Question = {
  id: 'handoff_next',
  type: 'choice',
  instructions: 'A worker ran out of context and handed its branch off, and the branch has passed the number of allowed continues. Decide from the handoff note whether a fresh worker should continue the same branch or the remaining work should be split into smaller packages.',
  criteria: {
    continue: 'little work is left (a test, a changelog line, a small fix) and the note is concrete about the next step',
    split: 'a lot is left, or the work spans several independent parts, or earlier workers kept running out of context before finishing the same part',
  },
}

// A text never goes over what a provider reads; the cut says so.
const CUT = '\n[...trimmed...]'
const cap = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, Math.max(0, n - CUT.length))}${CUT}`)
const fit = (head: string, body: string): string => cap(`${head}${cap(body, Math.max(0, DECIDE_TEXT_MAX - head.length))}`, DECIDE_TEXT_MAX)

export type InboxRecord = { question: string; context?: string; options: string[]; default?: string; owner?: string; topic?: string; blocking?: boolean; kind?: string }
export function textOfInbox(r: InboxRecord): string {
  const lines = [
    `Asked by: ${r.owner ?? 'unknown'}`,
    `Topic: ${r.topic ?? 'none'}`,
    `Kind: ${r.kind === 'fyi' ? 'decision already taken, keep or undo' : r.blocking ? 'blocking question' : 'question'}`,
    `Blocking: ${r.blocking ? 'yes' : 'no'}`,
    `Question: ${r.question}`,
    ...(r.context !== undefined && r.context !== '' ? [`Context: ${r.context}`] : []),
    `Options: ${r.options.join(', ')}`,
    ...(r.default !== undefined ? [`Default: ${r.default}`] : []),
  ]
  return cap(lines.join('\n'), DECIDE_TEXT_MAX)
}

export type TestFailureRecord = { name?: string; output: string; failed?: string[] }
// The tail of a test run holds the failures; keep it, not the beginning.
export function textOfTestFailure(r: TestFailureRecord): string {
  const head = [
    `Test run: ${r.name ?? 'unnamed'}`,
    ...(r.failed !== undefined && r.failed.length > 0 ? [`Failing tests: ${r.failed.join('; ')}`] : []),
    'Output:',
    '',
  ].join('\n')
  const room = Math.max(0, DECIDE_TEXT_MAX - head.length)
  return fit(head, r.output.length > room ? `[...]${r.output.slice(r.output.length - room + 5)}` : r.output)
}

export type ConflictRecord = { files: string[]; hunks?: string }
export function textOfConflict(r: ConflictRecord): string {
  const head = `Conflicting files (${r.files.length}):\n${r.files.map(f => `- ${f}`).join('\n')}\n\nConflict hunks:\n`
  return fit(head, r.hunks !== undefined && r.hunks !== '' ? r.hunks : '(not shown)')
}

export type HandoffRecord = { note: string; count: number; maxContinues: number }
export function textOfHandoff(r: HandoffRecord): string {
  const head = `Handoffs so far on this branch: ${r.count}\nAllowed continues (max_continues): ${r.maxContinues}\n\nHandoff note:\n`
  return fit(head, r.note)
}
