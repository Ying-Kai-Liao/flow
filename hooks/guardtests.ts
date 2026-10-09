// guard_tests: path globs that force a worker to run specific repo-wide tests when its diff touches them.
// Pure (no plugin runtime): the tool, the handover check and the reviewer suggestion in register.tsx use it.
//
// Glob rule, deliberately small: paths are repo-relative with `/`. `**` matches any number of directories
// (including none), `*` any characters within one path segment, `?` one character that is not `/`. A pattern
// matches the whole path; there is no basename matching, so write `**/routes/*.ts`, not `routes.ts`.

export type GuardMap = Record<string, string[]>
export type GuardHit = { test: string; globs: string[]; files: string[] }

function regexOf(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*' && glob[i + 1] === '*') {
      // `**/` is zero or more directories; a trailing `**` is anything below.
      if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 2 } else { out += '.*'; i += 1 }
    } else if (c === '*') out += '[^/]*'
    else if (c === '?') out += '[^/]'
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

const clean = (p: string) => p.replace(/^\.\//, '')

export function globMatches(glob: string, path: string): boolean {
  return regexOf(glob).test(clean(path))
}

// A map from a value that came from a settings file or /config (an object, or a JSON string of one): a valid map,
// or undefined when the shape is wrong. Each glob's tests are deduped; blank entries are dropped.
export function parseGuardTests(raw: unknown): GuardMap | undefined {
  let v = raw
  if (typeof v === 'string') {
    try { v = JSON.parse(v) } catch { return undefined }
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const out: GuardMap = {}
  for (const [glob, tests] of Object.entries(v)) {
    if (!Array.isArray(tests) || !tests.every(t => typeof t === 'string')) return undefined
    const list = [...new Set((tests as string[]).map(t => t.trim()).filter(t => t !== ''))]
    if (glob.trim() !== '') out[glob.trim()] = list
  }
  return out
}

// Per glob, the lists unioned, each test once; the globs of `base` come first.
export function mergeGuardTests(base: GuardMap | undefined, over: GuardMap | undefined): GuardMap {
  const out: GuardMap = {}
  for (const m of [base ?? {}, over ?? {}]) {
    for (const [g, tests] of Object.entries(m)) out[g] = [...new Set([...(out[g] ?? []), ...tests])]
  }
  return out
}

// Each test the files require, once, in the order the map lists it, with every glob and file that triggered it.
export function guardTestsFor(files: string[], map: GuardMap): GuardHit[] {
  const hits = new Map<string, GuardHit>()
  const uniq = [...new Set(files.map(clean))]
  for (const [glob, tests] of Object.entries(map)) {
    const re = regexOf(glob)
    const matched = uniq.filter(f => re.test(f))
    if (matched.length === 0) continue
    for (const test of tests) {
      const h = hits.get(test) ?? { test, globs: [], files: [] }
      if (!h.globs.includes(glob)) h.globs.push(glob)
      for (const f of matched) if (!h.files.includes(f)) h.files.push(f)
      hits.set(test, h)
    }
  }
  return [...hits.values()]
}

const isTestFile = (f: string) => /(^|\/)(tests?|__tests__|spec)\//.test(f) || /\.(test|spec)\.[^/]+$/.test(f)

const dirOf = (f: string) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '')

// Globs worth suggesting for a test that failed on a PR with these changed files: the deepest directory all the
// non-test files share + `/**`; if they share none, one per distinct top-level directory (at most 3). Files
// at the repo root give no glob.
export function suggestGlobs(files: string[], failedTest: string): string[] {
  const own = files.filter(f => !failedTest.includes(f))
  const src = own.filter(f => !isTestFile(f))
  const use = src.length > 0 ? src : own
  if (use.length === 0) return []
  const parts = use.map(f => dirOf(f).split('/').filter(Boolean))
  let common = parts[0]!
  for (const p of parts.slice(1)) {
    let n = 0
    while (n < common.length && n < p.length && common[n] === p[n]) n++
    common = common.slice(0, n)
  }
  if (common.length > 0) return [`${common.join('/')}/**`]
  const tops = [...new Set(use.filter(f => f.includes('/')).map(f => f.split('/')[0]!))].slice(0, 3)
  return tops.map(t => `${t}/**`)
}

export type GuardSuggestion = { test: string; glob: string; files: string[] }

// One suggestion per failed test and suggested glob, except for tests the map already requires for these files.
export function suggestionsFor(files: string[], failed: string[], map: GuardMap): GuardSuggestion[] {
  const required = new Set(guardTestsFor(files, map).map(h => h.test))
  const out: GuardSuggestion[] = []
  for (const test of [...new Set(failed.map(t => t.trim()).filter(t => t !== ''))]) {
    if (required.has(test)) continue
    for (const glob of suggestGlobs(files, test)) {
      out.push({ test, glob, files: files.filter(f => globMatches(glob, f)) })
    }
  }
  return out
}

export const ADD_OPTION = 'Add it to my personal flow config'

export function suggestionQuestion(pr: number, s: GuardSuggestion) {
  const shown = s.files.slice(0, 5).join(', ') + (s.files.length > 5 ? `, and ${s.files.length - 5} more` : '')
  return {
    question: `PR #${pr} was sent back: \`${s.test}\` failed. It changed ${shown}. Add a guard mapping so workers run it? \`${JSON.stringify({ [s.glob]: [s.test] })}\``,
    options: [ADD_OPTION, 'No'],
    default: 'No',
    blocking: false,
    topic: 'guard-tests',
    guard: { glob: s.glob, test: s.test },
  }
}

// What a worker's tool call answers.
export function guardReport(hits: GuardHit[], configured: boolean): string {
  if (!configured) return 'guard_tests is not configured: no guard tests to run.'
  if (hits.length === 0) return 'No guard tests match your diff.'
  return [
    `Your diff requires ${hits.length} guard test${hits.length === 1 ? '' : 's'}:`,
    ...hits.map(h => `- \`${h.test}\` (for ${h.globs.map(g => `\`${g}\``).join(', ')}: ${h.files.slice(0, 3).join(', ')}${h.files.length > 3 ? `, +${h.files.length - 3} more` : ''})`),
    'Run each under mcp__flow__test_slot (acquire, run, release) and list each under `Ran:` in the PR\'s `## Verification` section. handover refuses the PR otherwise.',
  ].join('\n')
}

// A deleted or renamed path still counts; porcelain status lines give "XY path" or "XY old -> new".
export function pathsFromStatus(porcelain: string): string[] {
  const out: string[] = []
  for (const line of porcelain.split('\n')) {
    if (line.length < 4) continue
    for (const p of line.slice(3).split(' -> ')) out.push(p.trim().replace(/^"|"$/g, ''))
  }
  return out
}

// The answer to the suggestion question that adds the mapping: `map` gains the test under the glob, once.
export function addMapping(map: GuardMap | undefined, glob: string, test: string): GuardMap {
  return mergeGuardTests(map, { [glob]: [test] })
}
