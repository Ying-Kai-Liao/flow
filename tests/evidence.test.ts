import { expect } from 'claude-code/testing'
import { test } from './support'
import { checkEvidence, evidenceRefusal, evidenceSummary, evidenceText, parseVerification, verificationSection } from '../hooks/evidence'

const good = '## Verification\nRan:\n- `tsc -p .`: pass\n- `bun test`: pass (42 tests)\nExercised: launched the pane and saw the line\nNot verified:\n- the full check'
const problems = (body: string, req: string[] = []): string[] => {
  const r = checkEvidence(body, req)
  return 'problems' in r ? r.problems : []
}

test('a complete section is accepted and parsed', () => {
  const r = checkEvidence(good, ['tsc -p .', 'bun test'])
  expect(r).toEqual({ evidence: { ran: ['`tsc -p .`: pass', '`bun test`: pass (42 tests)'], exercised: 'launched the pane and saw the line', notVerified: ['the full check'] } })
})

test('missing and empty sections are refused', () => {
  expect(problems('Summary only')[0]).toContain('no `## Verification` section')
  expect(problems('## Verification\n\n## Other\nx')[0]).toContain('is empty')
  expect(problems('')[0]).toContain('no `## Verification` section')
})

test('each missing part is listed, all at once', () => {
  const p = problems('## Verification\nRan:\n')
  expect(p.some(x => x.includes('`Ran:`'))).toBe(true)
  expect(p.some(x => x.includes('`Exercised:`'))).toBe(true)
  expect(p.some(x => x.includes('`Not verified:`'))).toBe(true)
  expect(problems('## Verification\nRan:\n- a: pass\nNot verified:\n- b')).toEqual(['`Exercised:` is missing or empty'])
  expect(problems('## Verification\nRan:\n- a: pass\nExercised: x')).toEqual(['`Not verified:` is missing or empty'])
})

test('a required check missing from Ran is refused; backticks are optional', () => {
  expect(problems(good, ['pnpm lint'])).toEqual(['required command `pnpm lint` does not appear under `Ran:`'])
  expect(problems(good.replace(/`/g, ''), ['tsc -p .'])).toEqual([])
  expect(problems(good, [])).toEqual([])
})

test('the section ends at the next ## heading, and the heading is case-insensitive', () => {
  const body = '## Summary\nx\n## verification\nRan:\n- a: pass\nExercised: x\nNot verified:\n- y\n## Notes\nRan:\n- z'
  expect(checkEvidence(body, [])).toEqual({ evidence: { ran: ['a: pass'], exercised: 'x', notVerified: ['y'] } })
  expect(verificationSection(body)).not.toContain('Notes')
})

test('CRLF bodies parse', () => {
  expect('evidence' in checkEvidence(good.replace(/\n/g, '\r\n'), ['bun test'])).toBe(true)
})

test('inline label text counts as an entry', () => {
  const p = parseVerification('Ran: bun test: pass\nExercised: ok\nNot verified: the full check')
  expect(p).toEqual({ ran: ['bun test: pass'], exercised: 'ok', notVerified: ['the full check'] })
})

test('"Not verified: nothing" and bare "n/a" are refused', () => {
  const mk = (nv: string, ex = 'x') => `## Verification\nRan:\n- a: pass\nExercised: ${ex}\nNot verified: ${nv}`
  expect(problems(mk('nothing'))[0]).toContain('honest item')
  expect(problems(mk('none'))[0]).toContain('honest item')
  expect(problems(mk('none, because it is a docs change'))).toEqual([])
  expect(problems(mk('x', 'n/a'))[0]).toContain('needs a reason')
  expect(problems(mk('x', 'n/a: docs only'))).toEqual([])
})

test('the refusal shows the format and the fix', () => {
  const t = evidenceRefusal(5, ['a problem'])
  expect(t).toContain('- a problem')
  expect(t).toContain('## Verification')
  expect(t).toContain('gh pr edit 5 --body-file')
})

test('summaries tolerate missing evidence', () => {
  expect(evidenceText(undefined)).toBe('no evidence recorded')
  expect(evidenceSummary(undefined)).toBe('no evidence recorded')
  expect(evidenceSummary({ ran: ['a'], exercised: 'x', notVerified: ['b'] })).toBe('1 ran, exercised: x, 1 not verified')
})
