import { expect } from 'claude-code/testing'
import { test } from './support'

import { DECIDE_TEXT_MAX, optionsOf } from '../hooks/decide'
import { HANDOFF_QUESTION, INBOX_ROUTINE_QUESTION, MERGE_CONFLICT_QUESTION, TEST_FAILURE_QUESTION, textOfConflict, textOfHandoff, textOfInbox, textOfTestFailure } from '../hooks/decide-questions'

const big = 'x'.repeat(DECIDE_TEXT_MAX * 3)

test('the four questions have the agreed ids and options', () => {
  expect(INBOX_ROUTINE_QUESTION.id).toBe('inbox_routine')
  expect(optionsOf(INBOX_ROUTINE_QUESTION)).toEqual(['keep', 'undo', 'ask_main'])
  expect(TEST_FAILURE_QUESTION.id).toBe('test_failure')
  expect(optionsOf(TEST_FAILURE_QUESTION)).toEqual(['flaky', 'real'])
  expect(MERGE_CONFLICT_QUESTION.id).toBe('merge_conflict')
  expect(optionsOf(MERGE_CONFLICT_QUESTION)).toEqual(['trivial', 'needs_agent'])
  expect(HANDOFF_QUESTION.id).toBe('handoff_next')
  expect(optionsOf(HANDOFF_QUESTION)).toEqual(['continue', 'split'])
})

test('an inbox item becomes its question, context, options, owner and topic', () => {
  const t = textOfInbox({ question: 'worker-size small?', context: 'docs only', options: ['Keep', 'Overturn'], default: 'Keep', owner: 'gh-releases', topic: 'worker-size', blocking: false, kind: 'fyi' })
  for (const s of ['gh-releases', 'worker-size', 'worker-size small?', 'docs only', 'Keep, Overturn', 'Blocking: no']) expect(t).toContain(s)
  expect(textOfInbox({ question: 'q', options: ['a', 'b'], blocking: true })).toContain('Blocking: yes')
})

test('a failing test run keeps the tail of its output', () => {
  const t = textOfTestFailure({ name: 'full plugin tests', failed: ['a test'], output: `START${big}END` })
  expect(t).toContain('full plugin tests')
  expect(t).toContain('a test')
  expect(t).toContain('END')
  expect(t).not.toContain('START')
})

test('a conflict lists its files and trims its hunks', () => {
  const t = textOfConflict({ files: ['CHANGELOG.md', 'hooks/a.ts'], hunks: `<<<<<<< HEAD${big}` })
  expect(t).toContain('- CHANGELOG.md')
  expect(t).toContain('- hooks/a.ts')
  expect(t).toContain('<<<<<<< HEAD')
  expect(textOfConflict({ files: ['x'] })).toContain('(not shown)')
})

test('a handoff carries its note, count and max_continues', () => {
  const t = textOfHandoff({ note: 'tests remain', count: 3, maxContinues: 2 })
  expect(t).toContain('tests remain')
  expect(t).toContain('so far on this branch: 3')
  expect(t).toContain('(max_continues): 2')
})

test('every text is capped at DECIDE_TEXT_MAX and holds no key', () => {
  const texts = [
    textOfInbox({ question: big, context: big, options: ['a', 'b'] }),
    textOfTestFailure({ output: big, failed: [big] }),
    textOfConflict({ files: ['a'], hunks: big }),
    textOfHandoff({ note: big, count: 1, maxContinues: 2 }),
  ]
  for (const t of texts) {
    expect(t.length <= DECIDE_TEXT_MAX).toBe(true)
    expect(t).not.toContain('sk-')
  }
})
