// Release at merge: the pure parts. Workers add changelog lines under "## [Unreleased]" and never touch the
// version; the reviewer calls mcp__flow__release once per batch, which uses these to cut the changelog and
// bump the version files. No IO here: register.tsx reads and writes the files.

export type Bump = 'patch' | 'minor' | 'major'

const ORDER: Bump[] = ['patch', 'minor', 'major']
export const isBump = (v: unknown): v is Bump => typeof v === 'string' && (ORDER as string[]).includes(v)

export function bumpVersion(v: string, kind: Bump): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim())
  if (m === null) throw new Error(`"${v}" is not a plain x.y.z version (pre-release and build suffixes are not bumped)`)
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (kind === 'major') return `${major + 1}.0.0`
  if (kind === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

// The biggest of the asked bumps; patch when none was asked. Unknown values are ignored.
export function highestBump(list: (string | undefined)[]): Bump {
  let best = 0
  for (const b of list) {
    const i = ORDER.indexOf(b as Bump)
    if (i > best) best = i
  }
  return ORDER[best]!
}

// The bump a PR's labels ask for, if any.
export function labelBump(labels: string[]): Bump | undefined {
  if (labels.includes('flow:major')) return 'major'
  if (labels.includes('flow:minor')) return 'minor'
  return undefined
}

const isHeading = (line: string) => /^## \[/.test(line)
const isUnreleased = (line: string) => /^## \[unreleased\]/i.test(line)
const isRef = (line: string) => /^\[[^\]]+\]:\s/.test(line)

// Move the body of "## [Unreleased]" into a "## [version] - date" section right below the emptied heading.
// A body with no bullets or text (blank lines and ### headings only) counts as empty and gets the fallback
// lines under "### Changed", so every release has an entry.
export function cutChangelog(text: string, version: string, date: string, fallbackLines: string[]): string {
  const lines = text.split('\n')
  let at = lines.findIndex(isUnreleased)
  if (at < 0) {
    at = lines.findIndex(isHeading)
    if (at < 0) {
      while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
      at = lines.length + 1
      lines.push('', '## [Unreleased]', '')
    } else {
      lines.splice(at, 0, '## [Unreleased]', '')
    }
  }
  let end = at + 1
  while (end < lines.length && !isHeading(lines[end]!) && !isRef(lines[end]!)) end++
  const body = lines.slice(at + 1, end)
  while (body.length > 0 && body[0]!.trim() === '') body.shift()
  while (body.length > 0 && body[body.length - 1]!.trim() === '') body.pop()
  const empty = body.every(l => l.trim() === '' || /^###\s/.test(l))
  const entry = empty ? ['### Changed', '', ...fallbackLines] : body
  return [...lines.slice(0, at + 1), '', `## [${version}] - ${date}`, '', ...entry, '', ...lines.slice(end)].join('\n')
}

type Span = { start: number; end: number; value: string }

// The value of the top-level "version" key of a JSON text: found by scanning, so the rest keeps its formatting.
function jsonVersion(text: string): Span | undefined {
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') depth--
    else if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      if (depth === 1 && text.slice(i + 1, j) === 'version') {
        const m = /^(\s*:\s*")((?:[^"\\]|\\.)*)"/.exec(text.slice(j + 1))
        if (m !== null) {
          const start = j + 1 + m[1]!.length
          return { start, end: start + m[2]!.length, value: m[2]! }
        }
      }
      i = j
    }
  }
  return undefined
}

// The first `version = "..."` at the top level or in [package] / [project].
function tomlVersion(text: string): Span | undefined {
  let section = ''
  let pos = 0
  for (const line of text.split('\n')) {
    const sec = /^\s*\[([^\]]*)\]\s*(#.*)?$/.exec(line)
    if (sec !== null) section = sec[1]!.trim()
    else if (section === '' || section === 'package' || section === 'project') {
      const m = /^(\s*version\s*=\s*)(["'])([^"']*)\2/.exec(line)
      if (m !== null) return { start: pos + m[1]!.length + 1, end: pos + m[1]!.length + 1 + m[3]!.length, value: m[3]! }
    }
    pos += line.length + 1
  }
  return undefined
}

function locate(text: string, path: string): Span {
  const lower = path.toLowerCase()
  if (!lower.endsWith('.json') && !lower.endsWith('.toml')) throw new Error(`${path}: only .json and .toml version files are supported`)
  const span = lower.endsWith('.json') ? jsonVersion(text) : tomlVersion(text)
  if (span === undefined) throw new Error(`${path}: no version key found`)
  return span
}

export const readVersion = (text: string, path: string): string => locate(text, path).value

export function setVersion(text: string, path: string, version: string): string {
  const s = locate(text, path)
  return text.slice(0, s.start) + version + text.slice(s.end)
}

// The body of "## [version] ..." up to the next "## " heading (or a link reference line), trimmed; undefined when
// the changelog has no such section. Used for the GitHub Release notes.
export function changelogSection(text: string, version: string): string | undefined {
  const lines = text.split('\n')
  const re = new RegExp(`^## \\[?v?${version.replaceAll('.', '\\.')}\\]?(\\s|$)`)
  const at = lines.findIndex(l => re.test(l))
  if (at < 0) return undefined
  let end = at + 1
  while (end < lines.length && !lines[end]!.startsWith('## ') && !isRef(lines[end]!)) end++
  return lines.slice(at + 1, end).join('\n').trim()
}
