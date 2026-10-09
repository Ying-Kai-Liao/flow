// Attachments in a brief: file paths (screenshots, mockups, logs) a worker opens at start. The
// spawn hook checks that each exists and rewrites relative paths to absolute ones, because a
// worker runs in another worktree where an untracked file of the manager's checkout is missing.
// Pure text handling; the file checks are the hook's.

export type Attachment = { line: number; path: string }

const HEADING = /^#{1,6}\s+Attachments\s*:?\s*$/i
const LABEL = /^Attachments:\s*(.*)$/i
const ANY_HEADING = /^#{1,6}\s/

// A bullet or bare line, with one layer of quotes or backticks removed.
function entry(line: string): string | undefined {
  let t = line.trim().replace(/^[-*]\s+/, '').trim()
  if (t === '') return undefined
  const q = /^(["'`])(.*)\1$/.exec(t)
  if (q) t = q[2]!.trim()
  return t === '' ? undefined : t
}

// The paths listed under a `## Attachments` heading or an `Attachments:` line, with the index of
// their line. The list ends at the next heading, or at a blank line followed by text that is not a
// list item. A path on the `Attachments:` line itself counts.
export function parseAttachments(prompt: string): Attachment[] {
  const lines = prompt.split('\n')
  const out: Attachment[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const label = LABEL.exec(line)
    if (!HEADING.test(line) && !label) continue
    if (label && label[1]!.trim() !== '') {
      const p = entry(label[1]!)
      if (p !== undefined) out.push({ line: i, path: p })
    }
    let blank = false
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!
      if (ANY_HEADING.test(l)) break
      if (l.trim() === '') { blank = true; continue }
      // After a blank line only list items continue the section.
      if (blank && !/^\s*[-*]\s/.test(l)) break
      const p = entry(l)
      if (p !== undefined) out.push({ line: j, path: p })
    }
    break
  }
  return out
}

// `~` and relative paths made absolute: `home` for `~`, `cwd` for the rest.
export function absolutePath(path: string, cwd: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/')) return `${home.replace(/\/$/, '')}/${path.slice(2)}`
  if (path.startsWith('/')) return path
  return `${cwd.replace(/\/$/, '')}/${path.replace(/^\.\//, '')}`
}

// The prompt with each listed path replaced by its absolute form. Quotes around a path are
// dropped; an absolute path written bare stays as it was.
export function rewriteAttachments(prompt: string, items: Attachment[], abs: (path: string) => string): string {
  if (items.length === 0) return prompt
  const lines = prompt.split('\n')
  for (const { line, path } of items) {
    const l = lines[line]!
    const at = l.lastIndexOf(path)
    const quoted = at > 0 && /["'`]/.test(l[at - 1]!)
    const start = quoted ? at - 1 : at
    const end = at + path.length + (quoted ? 1 : 0)
    lines[line] = l.slice(0, start) + abs(path) + l.slice(end)
  }
  return lines.join('\n')
}
