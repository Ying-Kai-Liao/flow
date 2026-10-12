import { expect } from 'claude-code/testing'
import type { Handover } from '../types'
import { flowCommand } from '../hooks/command'
import type { CommandIo } from '../hooks/command'
import { EMPTY_INBOX } from '../hooks/inbox'
import { EMPTY_CHECKS, CHECKS_USAGE } from '../hooks/checks'
import { EMPTY_PREFLIGHT } from '../hooks/preflight'
import { LITE_USAGE } from '../hooks/lite'
import { PANE } from '../hooks/core'
import { test } from './support'

// A CommandIo whose calls are recorded by name. Anything a test did not stub is undefined, so a
// command that reaches for the wrong handler shows up in `calls` (or as a crash), not silently.
function fake(over: Record<string, unknown> = {}) {
  const calls: string[] = []
  const stubs: Record<string, unknown> = {
    now: async () => 1_000_000,
    inbox: async () => EMPTY_INBOX,
    checks: async () => EMPTY_CHECKS,
    answerQuestion: async (id: string, choice: string | null) => `answered ${id} ${choice}`,
    withChecks: async (fn: (c: unknown) => { out: unknown }) => fn(EMPTY_CHECKS).out,
    costLines: async () => [],
    handovers: async () => ({}),
    roster: async () => [],
    endedManagers: () => new Set<string>(),
    panes: async () => [],
    close: async () => undefined,
    home: async () => undefined,
    open: async () => undefined,
    gatherLeftovers: async () => ({ items: [], skipped: [] }),
    releaseReviewerHalt: async () => false,
    pushState: async () => ({}),
    after: (_ms: number, fn: () => void) => { fn() },
    submit: async () => undefined,
    sweep: async (base: string, apply: boolean) => `sweep ${base} ${apply}`,
    pushAct: async (act: { kind: string; pr?: number }, by: string) => `push ${act.kind} ${act.pr ?? ''} ${by}`.replace(/ +/g, ' ').trim(),
    holdTarget: async (name: string, until: string, by: string) => `hold ${name} ${until} ${by}`,
    releaseTarget: async (name: string) => `release ${name}`,
    refreshBehind: async () => undefined,
    ensureQueue: async () => 'queue ok',
    refresh: async () => undefined,
    best: async (_w: string, fn: () => Promise<void>) => fn(),
    toast: () => undefined,
    ...over,
  }
  const io = new Proxy({}, {
    get: (_t, name: string) => {
      const fn = stubs[name]
      if (fn === undefined) return undefined
      return (...a: unknown[]) => { calls.push(name); return (fn as (...x: unknown[]) => unknown)(...a) }
    },
  }) as unknown as CommandIo
  return { io, calls }
}

const settings = { base: 'main', maxManagers: 3 } as never
const run = (io: CommandIo, args: string | undefined, resumed = new Set<string>()) =>
  flowCommand(io, settings, undefined, resumed, {}, args)

const handover = (status: string): Handover => ({ pr: 7, branch: 'flow/p7', title: 'Export CSV', head: 'abcdef1234567', status, reportTo: 'csv' }) as unknown as Handover

test('no args, empty and blank args open the pane', async () => {
  for (const args of [undefined, '', '   ']) {
    const { io, calls } = fake()
    expect((await run(io, args)).text).toBe('Flow pane opened.')
    expect(calls).toEqual(['open'])
  }
})

test('an unknown subcommand answers with the help text and opens nothing', async () => {
  const { io, calls } = fake()
  const out = await run(io, 'frobnicate now')
  expect(out.text).toContain('Unknown argument "frobnicate now"')
  expect(out.text).toContain('/flow inbox')
  expect(calls).toEqual([])
  // A word that only starts like a known one is not that command.
  expect((await run(io, 'inboxes')).text).toContain('Unknown argument "inboxes"')
  expect((await run(io, 'cleanup')).text).toContain('Unknown argument "cleanup"')
})

test('inbox: list, one item, archive and its usage errors', async () => {
  const { io } = fake()
  expect((await run(io, 'inbox')).text.length).toBeGreaterThan(0)
  expect((await run(io, 'inbox q9')).text).toContain('q9')
  expect((await run(io, 'inbox archive')).text.length).toBeGreaterThan(0)
  expect((await run(io, 'inbox archive all')).text.length).toBeGreaterThan(0)
  expect((await run(io, 'inbox archive soon')).text).toBe('Usage: /flow inbox archive [all]')
  expect((await run(io, 'inbox archive all more')).text).toBe('Usage: /flow inbox archive [all]')
  expect((await run(io, 'inbox bogus')).text).toMatch(/^Usage: \/flow inbox,/)
  expect((await run(io, 'inbox decisions')).text.length).toBeGreaterThan(0)
  expect((await run(io, 'inbox all')).text.length).toBeGreaterThan(0)
})

test('answer, no and ok route to answerQuestion with the user flag', async () => {
  const seen: unknown[][] = []
  const { io } = fake({ answerQuestion: async (...a: unknown[]) => { seen.push(a); return 'done' } })
  expect((await run(io, 'answer')).text).toBe('Usage: /flow answer <id> <option letter, number or your own words>')
  expect((await run(io, 'answer Q4')).text).toBe('Usage: /flow answer <id> <option letter, number or your own words>')
  expect((await run(io, 'answer Q4 use the second one')).text).toContain('done')
  expect(seen.at(-1)).toEqual(['q4', 'use the second one', 'main', {}, true])
  expect((await run(io, 'no')).text).toBe('Usage: /flow no <id> [what to do instead]')
  // Nothing was answered by the usage replies.
  expect(seen).toHaveLength(1)
})

test('checks: table, detail, and the pass/fail/skip branches', async () => {
  const { io } = fake()
  expect((await run(io, 'checks')).text.length).toBeGreaterThan(0)
  // An id nobody has is reported, never throws.
  expect((await run(io, 'checks c9')).text).toContain('c9')
  expect((await run(io, 'checks pass')).text).toBe(CHECKS_USAGE)
  expect((await run(io, 'checks frob a')).text).toBe(CHECKS_USAGE)
  expect((await run(io, 'checks pass c1')).text).toMatch(/^Not closed:/)
  expect((await run(io, 'checks fail C1')).text).toMatch(/^Not closed:/)
  expect((await run(io, 'checks skip c1 c2 no longer applies')).text).toMatch(/^Not closed:/)
})

test('status prints cost lines or says none were counted', async () => {
  let prs: unknown
  const { io } = fake({ costLines: async (p: unknown) => { prs = p; return ['cost: $1'] }, handovers: async () => ({ 7: { pr: 7, branch: 'flow/p7' } }) })
  expect((await run(io, 'status')).text).toBe('cost: $1')
  expect(prs).toEqual([{ pr: 7, branch: 'flow/p7' }])
  expect((await run(fake().io, 'status')).text).toBe('No agent steps counted yet.')
})

test('preflight renders the round through the roster', async () => {
  const { io, calls } = fake({ preflight: async () => EMPTY_PREFLIGHT })
  const out = await run(io, 'preflight')
  expect(typeof out.text).toBe('string')
  expect(calls).toEqual(expect.arrayContaining(['preflight', 'inbox', 'roster', 'endedManagers', 'now']))
})

test('home goes to the home view', async () => {
  const { io, calls } = fake()
  expect((await run(io, 'home')).text).toBe('Flow pane is on its home view.')
  expect(calls).toEqual(['home'])
})

test('close: not open, closes, and a close that throws', async () => {
  const none = fake()
  expect((await run(none.io, 'close')).text).toBe('The Flow pane is not open.')
  expect(none.calls).not.toContain('close')
  expect((await run(fake({ panes: async () => [{ id: PANE }] }).io, 'close')).text).toBe('Flow pane closed.')
  const bad = fake({ panes: async () => [{ id: PANE }], close: async () => { throw new Error('busy') } })
  expect((await run(bad.io, 'close')).text).toBe('The Flow pane stayed open: busy')
  const odd = fake({ panes: async () => [{ id: PANE }], close: async () => { throw 'nope' } })
  expect((await run(odd.io, 'close')).text).toBe('The Flow pane stayed open: nope')
})

test('lite: usage without a task, otherwise submits a start prompt', async () => {
  const sent: string[] = []
  const { io } = fake({ submit: async (t: string) => { sent.push(t) } })
  expect((await run(io, 'lite')).text).toBe(LITE_USAGE)
  expect((await run(io, 'lite   ')).text).toBe(LITE_USAGE)
  expect(sent).toEqual([])
  expect((await run(io, 'lite add a csv export')).text).toContain('lite manager')
  expect(sent).toHaveLength(1)
  expect(sent[0]).toContain('add a csv export')
})

test('resume: nothing unfinished, an error, and leftovers that ride as context once', async () => {
  const empty = fake()
  expect((await run(empty.io, 'resume')).text).toBe('Nothing unfinished.')

  const err = fake({ gatherLeftovers: async () => ({ items: [], skipped: [], error: 'gh is not logged in' }) })
  expect((await run(err.io, 'resume')).text).toBe('gh is not logged in')

  const halted = fake({ releaseReviewerHalt: async () => true })
  const h = await run(halted.io, 'resume')
  expect(h.text).toContain('Reviewer halt cleared')
  expect(halted.calls).toContain('ensureQueue')

  const sent: string[] = []
  const items = [{ kind: 'pr', key: 'pr:7', line: '#7 Export CSV', detail: 'open PR', owner: 'csv' }]
  const some = fake({ gatherLeftovers: async () => ({ items, skipped: [] }), submit: async (t: string) => { sent.push(t) }, notesPath: async () => undefined })
  const resumed = new Set<string>()
  const out = await run(some.io, 'resume', resumed)
  expect(out.text).toContain('Open PRs:')
  expect(out.text).toContain('#7 Export CSV')
  expect(out.context).toHaveLength(1)
  expect(resumed.has('pr:7')).toBe(true)
  expect(sent).toEqual(['Carry out the /flow resume instructions: start the managers.'])
})

test('approve: usage and routing to the handover', async () => {
  const usage = 'Usage: /flow approve <pr>'
  const { io } = fake({
    handovers: async () => ({ 7: handover('awaiting') }), putHandover: async () => undefined, saveHandover: async () => undefined, appendLog: async () => undefined,
  })
  for (const a of ['approve', 'approve x', 'approve 0', 'approve -3', 'approve 1.5', 'approve 7 8']) expect((await run(io, a)).text).toBe(usage)
  expect((await run(io, 'approve 9')).text).toBe('No handover for PR #9.')
  expect((await run(io, 'approve 7')).text).toContain('Approved PR #7 at abcdef12')
})

test('reject and drop are the same command; # is allowed; a reason is kept', async () => {
  const usage = 'Usage: /flow reject <pr> [reason] (alias: /flow drop)'
  const { io } = fake({
    handovers: async () => ({ 7: handover('pending') }), putHandover: async () => undefined, saveHandover: async () => undefined,
    appendLog: async () => undefined, closeReturnedEnv: async () => undefined, settleBatch: async () => undefined, tellManager: async () => undefined,
  })
  expect((await run(io, 'reject')).text).toBe(usage)
  expect((await run(io, 'drop abc')).text).toBe(usage)
  expect((await run(io, 'reject #7 too risky')).text).toContain('declined by the user: too risky')
  expect((await run(io, 'drop 7')).text).toContain('Rejected PR #7 (declined by the user)')
  expect((await run(io, 'reject 8')).text).toBe('No handover for PR #8.')
})

test('push: push, drop, back and its usage', async () => {
  const { io } = fake()
  expect((await run(io, 'push')).text).toBe('push push user')
  expect((await run(io, 'push drop')).text).toBe('push drop user')
  expect((await run(io, 'push back 7')).text).toBe('push back 7 user')
  expect((await run(io, 'push back #7')).text).toBe('push back 7 user')
  for (const a of ['push back', 'push back x', 'push back 0', 'push back 7 8', 'push drop 7', 'push later']) {
    expect((await run(io, a)).text).toMatch(/^Usage: \/flow push/)
  }
})

test('hold and release route to the deploy target and refresh the behind marks', async () => {
  const { io, calls } = fake()
  expect((await run(io, 'hold prod')).text).toBe('hold prod released user')
  expect((await run(io, 'hold prod batch')).text).toBe('hold prod batch user')
  expect((await run(io, 'release prod')).text).toBe('release prod')
  expect(calls.filter(c => c === 'refreshBehind')).toHaveLength(3)
  const hold = 'Usage: /flow hold <target> [batch|released] (default released)'
  expect((await run(io, 'hold')).text).toBe(hold)
  expect((await run(io, 'hold prod forever')).text).toBe(hold)
  expect((await run(io, 'hold prod batch more')).text).toBe(hold)
  expect((await run(io, 'release')).text).toBe('Usage: /flow release <target>')
  expect((await run(io, 'release prod batch')).text).toBe('Usage: /flow release <target>')
})

test('clean lists by default and removes only with --yes', async () => {
  const { io } = fake()
  expect((await run(io, 'clean')).text).toBe('sweep main false')
  expect((await run(io, 'clean --yes')).text).toBe('sweep main true')
  // Anything else after clean is not a clean command.
  expect((await run(io, 'clean --all')).text).toContain('Unknown argument')
})

test('init goes to the init command: usage on a bad part, and the repo check', async () => {
  const { io, calls } = fake({ initDetect: async () => ({ isRepo: false }), initMark: async () => undefined })
  expect((await run(io, 'init bogus')).text).toContain('Usage')
  expect(calls).not.toContain('initDetect')
  expect((await run(io, 'init')).text).toContain('needs a git repository')
  expect(calls).toContain('initDetect')
})
