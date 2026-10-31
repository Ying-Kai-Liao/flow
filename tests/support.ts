import { test as kitTest } from 'claude-code/testing'
import type { TestRest } from 'claude-code/testing'

// The kit's default is 5 s per test, and that time includes loading the whole plugin on the test's
// first `$` call (1-4 s on an idle machine, several times that with other agents running). Under load
// the default fails unrelated tests at random, so every test gets this floor; a test can still pass
// its own `timeoutMs`.
export const TEST_TIMEOUT_MS = 60_000

// The floor alone, for test files whose tests run with the plugin's own option defaults. tests/test-floor.node-test.mjs
// fails a test file that takes `test` from the kit instead.
export const timedTest = (name: string, ...rest: TestRest): void => {
  const [options, body] = rest.length === 1 ? [{}, rest[0]] : rest
  kitTest(name, { timeoutMs: TEST_TIMEOUT_MS, ...options }, body)
}

// reviewer_delay defaults to 0 here, so a handover starts the reviewer at once as the tests were written for; a
// test of the delay sets it in its own options.
export const test = (name: string, ...rest: TestRest): void => {
  const [options, body] = rest.length === 1 ? [{}, rest[0]] : rest
  timedTest(name, { ...options, options: { reviewer_delay: 0, ...(options as { options?: Record<string, unknown> }).options } }, body)
}

// For tests of the inbox's own mechanics: the conservative standing rule, on by default, would answer their
// non-blocking asks at once. A test can still turn it on in its own options.
export const inboxTest = (name: string, ...rest: TestRest): void => {
  const [options, body] = rest.length === 1 ? [{}, rest[0]] : rest
  test(name, { ...options, options: { conservative_default: false, ...(options as { options?: Record<string, unknown> }).options } }, body)
}
