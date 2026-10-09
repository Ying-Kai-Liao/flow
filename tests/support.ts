import { test as kitTest } from 'claude-code/testing'
import type { TestRest } from 'claude-code/testing'

// The kit's default is 5 s per test, and that time includes loading the whole plugin on the test's
// first `$` call (1-4 s on an idle machine, several times that with other agents running). Under load
// the default fails unrelated tests at random, so every test gets this floor; a test can still pass
// its own `timeoutMs`.
export const TEST_TIMEOUT_MS = 60_000

export const test = (name: string, ...rest: TestRest): void => {
  const [options, body] = rest.length === 1 ? [{}, rest[0]] : rest
  kitTest(name, { timeoutMs: TEST_TIMEOUT_MS, ...options }, body)
}
