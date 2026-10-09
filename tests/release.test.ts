import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { fill, MANAGER_PROMPT, REVIEWER_PROMPT, REVIEWER_RULE, WORKER_PROMPT } from '../hooks/prompts'
import type { Settings } from '../hooks/prompts'
import { bumpVersion, changelogSection, cutChangelog, highestBump, labelBump, readVersion, setVersion } from '../hooks/release'
import { KEYS, mergeLayers } from '../hooks/settings'

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

test('bumpVersion: patch, minor, major', () => {
  expect(bumpVersion('0.3.31', 'patch')).toBe('0.3.32')
  expect(bumpVersion('0.3.31', 'minor')).toBe('0.4.0')
  expect(bumpVersion('1.9.9', 'major')).toBe('2.0.0')
})

test('bumpVersion refuses a pre-release or odd version', () => {
  expect(() => bumpVersion('1.0.0-beta.1', 'patch')).toThrow('not a plain x.y.z')
  expect(() => bumpVersion('1.0', 'patch')).toThrow('not a plain x.y.z')
  expect(() => bumpVersion('v1.0.0', 'patch')).toThrow('not a plain x.y.z')
})

test('highestBump: patch by default, the biggest wins, junk ignored', () => {
  expect(highestBump([])).toBe('patch')
  expect(highestBump([undefined, 'patch'])).toBe('patch')
  expect(highestBump(['patch', 'minor', undefined])).toBe('minor')
  expect(highestBump(['minor', 'major', 'patch'])).toBe('major')
  expect(highestBump(['huge'])).toBe('patch')
  expect(labelBump(['bug'])).toBeUndefined()
  expect(labelBump(['flow:minor'])).toBe('minor')
  expect(labelBump(['flow:minor', 'flow:major'])).toBe('major')
})

const LOG = `# Changelog

All notable changes are documented here.

## [Unreleased]

### Added

- A thing.

## [1.0.0] - 2026-01-01

### Added

- First.
`

test('cutChangelog moves the Unreleased body into the new section and keeps the header', () => {
  const out = cutChangelog(LOG, '1.0.1', '2026-02-02', ['- unused (#1)'])
  expect(out).toBe(`# Changelog

All notable changes are documented here.

## [Unreleased]

## [1.0.1] - 2026-02-02

### Added

- A thing.

## [1.0.0] - 2026-01-01

### Added

- First.
`)
})

test('cutChangelog adds the Unreleased heading above the first version section when missing', () => {
  const out = cutChangelog('# Changelog\n\n## [1.0.0] - 2026-01-01\n\n- First.\n', '1.0.1', '2026-02-02', ['- Fix it (#4)'])
  expect(out).toBe('# Changelog\n\n## [Unreleased]\n\n## [1.0.1] - 2026-02-02\n\n### Changed\n\n- Fix it (#4)\n\n## [1.0.0] - 2026-01-01\n\n- First.\n')
})

test('cutChangelog writes the fallback lines when Unreleased is empty (headings only counts as empty)', () => {
  const out = cutChangelog('# Changelog\n\n## [Unreleased]\n\n### Added\n\n## [1.0.0] - 2026-01-01\n', '1.0.1', '2026-02-02', ['- One (#1)', '- Two (#2)'])
  expect(out).toContain('## [Unreleased]\n\n## [1.0.1] - 2026-02-02\n\n### Changed\n\n- One (#1)\n- Two (#2)\n\n## [1.0.0]')
})

test('cutChangelog works with Unreleased last and with no version sections at all', () => {
  expect(cutChangelog('# Changelog\n\n## [Unreleased]\n\n- A.\n', '0.0.2', '2026-02-02', [])).toBe('# Changelog\n\n## [Unreleased]\n\n## [0.0.2] - 2026-02-02\n\n- A.\n')
  expect(cutChangelog('# Changelog\n', '0.0.2', '2026-02-02', ['- X (#1)'])).toBe('# Changelog\n\n## [Unreleased]\n\n## [0.0.2] - 2026-02-02\n\n### Changed\n\n- X (#1)\n')
})

test('setVersion keeps the JSON formatting and touches only the top-level version', () => {
  const text = '{\n    "name": "x",\n    "nested": { "version": "9.9.9" },\n    "version"  :  "0.3.31",\n    "other": 1\n}\n'
  expect(readVersion(text, 'plugin.json')).toBe('0.3.31')
  expect(setVersion(text, 'plugin.json', '0.3.32')).toBe(text.replace('0.3.31', '0.3.32'))
  expect(() => setVersion('{"name":"x"}', 'package.json', '1.0.0')).toThrow('no version key')
})

test('setVersion handles TOML: [package], [project], top level, first match', () => {
  const cargo = '[package]\nname = "x"\nversion = "0.1.0"\n\n[dependencies]\nserde = { version = "1" }\nversion = "7"\n'
  expect(setVersion(cargo, 'Cargo.toml', '0.1.1')).toBe(cargo.replace('0.1.0', '0.1.1'))
  const py = '[build-system]\nversion = "3"\n\n[project]\nname = "x"\nversion = "2.0.0"\n'
  expect(readVersion(py, 'pyproject.toml')).toBe('2.0.0')
  expect(readVersion('version = "4.5.6"\n', 'x.toml')).toBe('4.5.6')
  expect(() => setVersion('[tool]\nname = "x"\n', 'x.toml', '1.0.0')).toThrow('no version key')
})

test('setVersion refuses other file types', () => {
  expect(() => setVersion('version: 1', 'pubspec.yaml', '1.0.1')).toThrow('only .json and .toml')
})

test('settings: release is on or off, release_files a list, changelog_file a string', () => {
  expect(KEYS.release).toBe('string')
  expect(KEYS.release_files).toBe('list')
  expect(KEYS.changelog_file).toBe('string')
  const ok = mergeLayers({}, [{ path: 'r', text: JSON.stringify({ release: 'on', release_files: ['a.json'], changelog_file: 'CHANGES.md' }) }])
  expect(ok.warnings).toEqual([])
  expect(ok.raw.release).toBe('on')
  const bad = mergeLayers({}, [{ path: 'r', text: JSON.stringify({ release: 'maybe', release_files: 'a.json' }) }])
  expect(bad.warnings.length).toBe(2)
  expect(bad.warnings[0]).toContain('use "on" or "off"')
  expect(bad.raw.release).toBeUndefined()
})

const base: Settings = {
  base: 'main', testCommand: 'npm test', fullCheck: '', deployCommand: '', deployTargets: [], stateFile: undefined,
  mergeMethod: 'merge', mergeMode: 'auto', useReviewer: true, maxWorkers: 3, testSlots: 1, workerModel: 'sonnet', managerModel: 'opus', reviewerModel: 'opus',
  language: 'English', bigFiles: [], bigFileLines: 1500, migrationsDir: '', decisionPhrases: [], workerChecks: [], alwaysTests: [],
}
const prompts = (s: Settings) => [WORKER_PROMPT, MANAGER_PROMPT.replace('{{REVIEWER_RULE}}', REVIEWER_RULE), REVIEWER_PROMPT].map(p => fill(p, s))

test('prompts: release slots are empty when off, present when on', () => {
  for (const p of prompts(base)) {
    expect(p).not.toContain('{{')
    expect(p).not.toContain('Unreleased')
    expect(p).not.toContain('mcp__flow__release')
  }
  const [worker, manager, queue] = prompts({ ...base, release: true, releaseFiles: ['.claude-plugin/plugin.json'], changelogFile: 'CHANGELOG.md' })
  for (const p of [worker, manager, queue]) expect(p).not.toContain('{{')
  expect(worker).toContain('Add your changelog lines under `## [Unreleased]` in `CHANGELOG.md`')
  expect(worker).toContain('Never change the version in `.claude-plugin/plugin.json`')
  expect(manager).toContain('added its lines under `## [Unreleased]`')
  expect(manager).toContain('release "minor"')
  expect(queue).toContain('`mcp__flow__release`')
  expect(queue).toContain('Release x.y.z')
  expect(queue).toContain('released: <version>')
  expect(queue).toContain('keep every line under `## [Unreleased]`')
})

// ---- the tool, driven through the plugin ----

const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const BODY = '## Verification\nRan:\n- `bun test`: pass\nExercised: ran it\nNot verified:\n- the full check'

let clock: ReturnType<typeof mock.clock>

type Proc = (argv: readonly string[]) => { value: { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean } } | undefined

function world(on: On, labels: Record<number, string[] | 'fail'> = {}, proc?: Proc) {
  clock = mock.clock(on, { now: Date.UTC(2026, 9, 10) })
  const files = new Map<string, string>([
    ['/q/CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n\n- A line.\n\n## [0.3.31] - 2026-10-09\n\n- Old.\n'],
    ['/q/plugin.json', '{\n  "name": "x",\n  "version": "0.3.31"\n}\n'],
  ])
  on('agent.list', () => ({ value: [] }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'q1' }))
  on('session.start', () => ({ cwd: '/r' }))
  on('command.register', () => ({ value: undefined } as never))
  on('tool.register', () => ({ value: undefined } as never))
  on('agent.register', (_, e) => ({ value: { agent: (e as unknown as { name: string }).name } }))
  on('fs.exists', (_, e) => ({ value: files.has((e as unknown as { path: string }).path) }))
  on('fs.stat', () => { throw new Error('ENOENT') })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('fs.read', (_, e) => {
    const t = files.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('process.run', (_, e) => {
    const a = e.argv
    const custom = proc?.(a)
    if (custom !== undefined) return custom
    if (a[0] === 'git' && a[1] === 'rev-parse') return ok('/r/.git\n')
    if (a[0] === 'mv') {
      files.set(a[2] ?? '', files.get(a[1] ?? '') ?? '')
      files.delete(a[1] ?? '')
    }
    if (a[0] === 'gh' && a[1] === 'pr' && a[2] === 'view') {
      const n = Number(a[3])
      if (a[5] === 'labels') {
        const l = labels[n] ?? []
        return l === 'fail' ? { value: { exitCode: 1, stdout: '', stderr: 'boom', isStdoutTruncated: false, isStderrTruncated: false } } : ok(JSON.stringify({ labels: l.map(name => ({ name })) }))
      }
      return ok(JSON.stringify({ state: 'OPEN', isDraft: false, headRefOid: 'abc', headRefName: `flow/p${n}`, title: `Title ${n}`, body: BODY, labels: [] }))
    }
    return ok()
  })
  return files
}

const OPTS = { release: 'on', release_files: ['plugin.json'] }
const release = ($: Dollar, prs = [1], dir = '/q') => $.tool.call({ tool: 'mcp__flow__release', dir, prs } as never).then(r => String(r.result))
const handover = ($: Dollar, pr: number, extra: Record<string, unknown> = {}) =>
  $.tool.call({ tool: 'mcp__flow__handover', pr, report_to: 'main', ...extra } as never).then(r => String(r.result))

test('the release tool is refused when the release setting is off', async ($, on) => {
  const files = world(on)
  expect(await release($)).toContain('release setting is off')
  expect(files.get('/q/plugin.json')).toContain('0.3.31')
})

test('the release tool bumps a patch, cuts the changelog and says what to commit', { options: OPTS }, async ($, on) => {
  const files = world(on)
  await handover($, 1)
  const r = await release($)
  expect(r).toContain('Released 0.3.32')
  expect(r).toContain('commit -am "Release 0.3.32"')
  expect(files.get('/q/plugin.json')).toBe('{\n  "name": "x",\n  "version": "0.3.32"\n}\n')
  expect(files.get('/q/CHANGELOG.md')).toContain('## [Unreleased]\n\n## [0.3.32] - 2026-10-10\n\n- A line.\n\n## [0.3.31]')
})

test('the bump is the highest of the handover field and the flow:minor label', { options: OPTS }, async ($, on) => {
  const files = world(on, { 2: ['flow:minor'] })
  await handover($, 1, { release: 'patch' })
  await handover($, 2)
  expect(await release($, [1, 2])).toContain('Released 0.4.0')
  expect(files.get('/q/plugin.json')).toContain('"0.4.0"')
})

test('the handover field alone asks for minor, and the queue list shows it', { options: OPTS }, async ($, on) => {
  world(on)
  await handover($, 1, { release: 'minor' })
  expect(String(await $.tool.call({ tool: 'mcp__flow__queue', action: 'list' } as never).then(r => r.result))).toContain('release: minor')
  expect(await release($)).toContain('Released 0.4.0')
})

test('a gh failure falls back to the handover field and says so', { options: OPTS }, async ($, on) => {
  world(on, { 1: 'fail' })
  await handover($, 1, { release: 'minor' })
  const r = await release($)
  expect(r).toContain('Released 0.4.0')
  expect(r).toContain('gh could not read some PR labels')
})

test('a second call for the same batch is refused, a different batch is not', { options: OPTS }, async ($, on) => {
  const files = world(on)
  await handover($, 1)
  expect(await release($)).toContain('Released 0.3.32')
  expect(await release($)).toContain('already released 0.3.32')
  expect(files.get('/q/plugin.json')).toContain('"0.3.32"')
  expect(await release($, [2])).toContain('Released 0.3.33')
})

test('refuses with no version file, and changes nothing', { options: { release: 'on' } }, async ($, on) => {
  const files = world(on)
  expect(await release($)).toContain('release_files')
  expect(files.get('/q/CHANGELOG.md')).toContain('A line.')
})

test('refuses when the changelog is missing', { options: OPTS }, async ($, on) => {
  const files = world(on)
  files.delete('/q/CHANGELOG.md')
  expect(await release($)).toContain('CHANGELOG.md does not exist')
  expect(files.get('/q/plugin.json')).toContain('0.3.31')
})

// ---- changelogSection and publish ----

test('changelogSection: a middle section, the last section, a missing version', () => {
  const log = '# C\n\n## [Unreleased]\n\n- U.\n\n## [1.1.0] - 2026-02-01\n\n### Added\n\n- B.\n\n## [1.0.0] - 2026-01-01\n\n- A.\n\n[1.0.0]: https://x/1.0.0\n'
  expect(changelogSection(log, '1.1.0')).toBe('### Added\n\n- B.')
  expect(changelogSection(log, '1.0.0')).toBe('- A.')
  expect(changelogSection(log, '1.10.0')).toBeUndefined()
  expect(changelogSection(log, '1x0x0')).toBeUndefined()
})

const fail = (stderr: string) => ({ value: { exitCode: 1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } })
const PUB = { release: 'on', release_files: ['plugin.json'], release_github: 'on' }
const publish = ($: Dollar, extra: Record<string, unknown> = {}) => $.tool.call({ tool: 'mcp__flow__release', action: 'publish', dir: '/q', ...extra } as never).then(r => String(r.result))

function gitgh(opts: { merge?: boolean; tagAt?: string; releaseExists?: boolean; createFails?: boolean; subject?: string } = {}) {
  const calls: (readonly string[])[] = []
  const proc: Proc = a => {
    if (a[0] !== 'git' && a[0] !== 'gh') return undefined
    if (a[0] === 'gh' && a[1] === 'pr') return undefined
    if (a[0] === 'git' && a[1] === 'rev-parse') return undefined
    calls.push(a)
    const sha = 'a'.repeat(40)
    if (a[0] === 'git' && a[3] === 'log') return ok((opts.merge ? `${'f'.repeat(40)} Merge origin/main\n` : '') + `${sha} ${opts.subject ?? 'Release 0.3.32'}\n`)
    if (a[0] === 'git' && a[3] === 'merge-base') return ok()
    if (a[0] === 'git' && a[3] === 'rev-parse') return opts.tagAt === undefined ? fail('') : ok(opts.tagAt + '\n')
    if (a[0] === 'gh' && a[2] === 'view') return a.includes('--json') ? ok('https://github.com/o/r/releases/tag/v0.3.32\n') : opts.releaseExists ? ok() : fail('not found')
    if (a[0] === 'gh' && a[2] === 'create' && opts.createFails) return fail('HTTP 502')
    return ok()
  }
  return { calls, proc }
}

test('publish: tags, pushes the tag and creates the release with the changelog section', { options: PUB }, async ($, on) => {
  const g = gitgh()
  const files = world(on, {}, g.proc)
  files.set('/q/CHANGELOG.md', '# C\n\n## [Unreleased]\n\n## [0.3.32] - 2026-10-10\n\n- Shipped.\n\n## [0.3.31] - x\n\n- Old.\n')
  const r = await publish($, { version: '0.3.32' })
  expect(r).toContain('Published v0.3.32: tag pushed, GitHub Release created https://github.com/o/r/releases/tag/v0.3.32')
  expect(g.calls).toContainEqual(['git', '-C', '/q', 'tag', '-a', 'v0.3.32', '-m', 'Release 0.3.32', 'a'.repeat(40)])
  expect(g.calls).toContainEqual(['git', '-C', '/q', 'push', 'origin', 'v0.3.32'])
  const create = g.calls.find(c => c[2] === 'create')!
  expect(create.slice(0, 7)).toEqual(['gh', 'release', 'create', 'v0.3.32', '--title', 'v0.3.32', '--notes-file'])
  expect(create).toContain('--verify-tag')
  expect(files.get(create[7]!)).toBe('- Shipped.\n')
})

test('publish: tag already at the sha and release already exists is a skip', { options: PUB }, async ($, on) => {
  const g = gitgh({ tagAt: 'a'.repeat(40), releaseExists: true })
  world(on, {}, g.proc)
  const r = await publish($, { version: '0.3.32' })
  expect(r).toContain('Published v0.3.32')
  expect(r).toContain('already existed')
  expect(g.calls.some(c => c[3] === 'tag' || c[2] === 'create')).toBe(false)
})

test('publish: a tag at another sha is reported, not moved', { options: PUB }, async ($, on) => {
  const g = gitgh({ tagAt: 'deadbeef' })
  world(on, {}, g.proc)
  expect(await publish($, { version: '0.3.32' })).toContain('Not published: tag v0.3.32 already exists at deadbeef')
})

test('publish: gh release create failing every attempt gives a Not published line after 4 tries', { options: PUB }, async ($, on) => {
  const g = gitgh({ createFails: true })
  world(on, {}, g.proc)
  const pending = publish($, { version: '0.3.32' })
  for (let i = 0; i < 5; i++) await clock.advance(10_000)
  const r = await pending
  expect(r).toContain('Not published: gh release create failed: HTTP 502')
  expect(r).toContain('the batch stays done')
  expect(g.calls.filter(c => c[2] === 'create').length).toBe(4)
})

test('publish: finds the release commit below a merge commit at HEAD', { options: PUB }, async ($, on) => {
  const g = gitgh({ merge: true })
  world(on, {}, g.proc)
  expect(await publish($, { version: '0.3.32' })).toContain('Published v0.3.32')
  expect(g.calls).toContainEqual(['git', '-C', '/q', 'tag', '-a', 'v0.3.32', '-m', 'Release 0.3.32', 'a'.repeat(40)])
})

test('publish: refuses when no release commit is found', { options: PUB }, async ($, on) => {
  world(on, {}, gitgh({ subject: 'Merge PR #5' }).proc)
  expect(await publish($, { version: '0.3.32' })).toContain('no commit "Release 0.3.32"')
})

test('publish: defaults to the version of the last cut', { options: PUB }, async ($, on) => {
  const g = gitgh()
  world(on, {}, g.proc)
  await handover($, 1)
  await release($)
  expect(await publish($)).toContain('Published v0.3.32')
})

test('publish: refused when release_github is off', { options: OPTS }, async ($, on) => {
  const g = gitgh()
  world(on, {}, g.proc)
  expect(await publish($, { version: '0.3.32' })).toContain('release_github setting is off')
  expect(g.calls.length).toBe(0)
})

test('prompts: the publish step needs release and release_github; the branch protection rule is always there', () => {
  const on = { ...base, release: true, releaseGithub: true, releaseFiles: ['p.json'], changelogFile: 'CHANGELOG.md' }
  expect(fill(REVIEWER_PROMPT, on)).toContain('action "publish"')
  expect(fill(REVIEWER_PROMPT, on)).toContain('GitHub Release: ok|failed')
  expect(fill(REVIEWER_PROMPT, { ...on, releaseGithub: false })).not.toContain('action "publish"')
  expect(fill(REVIEWER_PROMPT, { ...base, releaseGithub: true })).not.toContain('action "publish"')
  for (const s of [base, on]) {
    const p = fill(REVIEWER_PROMPT, s)
    expect(p).toContain('GH006')
    expect(p).toContain('refused by branch protection')
  }
})
