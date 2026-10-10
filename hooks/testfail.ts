// Failing tests under test_slot: which tests failed, and which passed on a rerun (flaky). Pure
// helpers; the plugin keeps the state in an atom and logs the events.

export type TestFails = {
  // agent key + label -> the test names of its last failed run ([] when it gave none)
  last: Record<string, string[]>
  // agent key -> flaky test names seen during its run
  flaky: Record<string, string[]>
}
export const NO_FAILS: TestFails = { last: {}, flaky: {} }

const MAX_KEPT = 50
const cleanNames = (names: unknown): string[] =>
  Array.isArray(names) ? [...new Set(names.filter((n): n is string => typeof n === 'string').map(n => n.trim()).filter(Boolean))] : []
const slotKey = (agent: string, label: string): string => `${agent}\u0000${label}`

export type ReleaseNote = { state: TestFails; answer: string; event?: { kind: 'tests-failed' | 'flaky'; text: string } }

// What a test_slot "release" with a result means: the answer for the agent, the log event, the new state.
export function noteRelease(state: TestFails, agent: string, label: string, result: unknown, failed: unknown): ReleaseNote {
  const k = slotKey(agent, label)
  const names = cleanNames(failed)
  if (result === 'fail') {
    const last = { ...Object.fromEntries(Object.entries(state.last).slice(-MAX_KEPT)), [k]: names }
    const text = names.length ? `${label}: failed: ${names.join(', ')}` : `${label}: fail (names not given)`
    const answer = names.length
      ? `Failing tests recorded: ${names.join(', ')}.`
      : 'No failing test names given: put the exact names of the failing tests (from the output) in your report.'
    return { state: { ...state, last }, answer, event: { kind: 'tests-failed', text } }
  }
  if (result === 'pass' && k in state.last) {
    const was = state.last[k]!
    const { [k]: _gone, ...rest } = state.last
    const flaky = { ...state.flaky, [agent]: [...new Set([...(state.flaky[agent] ?? []), ...was])] }
    const list = was.length ? was.join(', ') : 'an unnamed test'
    return {
      state: { last: rest, flaky },
      answer: `flaky: ${list} (failed, passed on rerun): name it in your report as flaky: <test>.`,
      event: { kind: 'flaky', text: `${label}: flaky: ${list}` },
    }
  }
  return { state, answer: '' }
}

// The reviewer's report with "| flaky: a, b" appended for the names it does not mention yet.
export function withFlaky(report: string, flaky: string[] | undefined): string {
  const names = (flaky ?? []).filter(n => !report.includes(n))
  return names.length === 0 ? report : `${report} | flaky: ${names.join(', ')}`
}

// The reason of a "back" with the failing tests named.
export function withFailed(reason: string, failed: unknown): string {
  const names = cleanNames(failed)
  return names.length === 0 ? reason : `${reason} | failed: ${names.join(', ')}`
}
