// Migration numbers across parallel PRs: which ones clash or sit at or below the base, and the next free
// number for each. Pure: the git and gh glue in register.tsx passes in path lists and file texts.

export type Status = 'ok' | 'clash' | 'at-or-below'

export type Ref = { file: string; line: number }

// One migration of a PR: the files that share a number and a name (a paired up/down, or a folder).
export type Migration = {
  number: bigint
  prefix: string
  key: string
  files: string[]
  status: Status
  clashWith?: string
  newNumber?: string
  moves?: Array<{ from: string; to: string }>
  refs?: Ref[]
}

export type PrReport = { pr: number; error?: string; migrations: Migration[]; unnumbered: string[] }

export type Report = { dir: string; baseHigh?: bigint; refHigh?: bigint; prs: PrReport[] }

export type PrInput = { pr: number; error?: string; added: string[] }

export type Inputs = { dir: string; baseFiles: string[]; refFiles: string[]; prs: PrInput[] }

type Entry = { file: string; n: bigint; key: string }

export function cleanDir(dir: string): string {
  return dir.trim().replace(/^\.\//, '').replace(/\/+$/, '')
}

// The first path segment under dir, split into its leading digits and the rest. The same rule serves
// `dir/0042_name.sql` and the folder style `dir/0042_name/up.sql`.
export function parseEntry(dir: string, path: string): { prefix: string; segment: string; rest: string; key: string } | undefined {
  const rel = path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : undefined
  if (rel === undefined || rel === '') return undefined
  const segment = rel.split('/')[0]!
  const prefix = /^\d+/.exec(segment)?.[0]
  if (prefix === undefined) return undefined
  // A paired 0042_x.up.sql / 0042_x.down.sql is one migration: the key drops the extension and the up/down marker.
  const stem = rel.includes('/') ? segment : segment.replace(/\.[^.]*$/, '').replace(/\.(up|down)$/, '')
  return { prefix, segment, rest: rel.slice(segment.length), key: stem }
}

function entries(dir: string, files: string[]): Entry[] {
  const out: Entry[] = []
  for (const file of files) {
    const e = parseEntry(dir, file)
    if (e !== undefined) out.push({ file, n: BigInt(e.prefix), key: e.key })
  }
  return out
}

const top = (es: Entry[]): bigint | undefined => es.reduce<bigint | undefined>((a, e) => a === undefined || e.n > a ? e.n : a, undefined)

export function analyze(input: Inputs): Report {
  const dir = cleanDir(input.dir)
  const base = entries(dir, input.baseFiles)
  const ref = entries(dir, input.refFiles)
  const baseHigh = top(base)
  const refHigh = top(ref)
  const landed = new Set([...input.baseFiles, ...input.refFiles])
  // Everything a new migration must not collide with, in the order the batch lands.
  const taken: Entry[] = [...base, ...ref]
  let high = top(taken)

  const prs: PrReport[] = []
  for (const p of input.prs) {
    const report: PrReport = { pr: p.pr, migrations: [], unnumbered: [] }
    prs.push(report)
    if (p.error !== undefined) { report.error = p.error; continue }
    const groups = new Map<string, Migration>()
    for (const file of [...p.added].sort()) {
      const e = parseEntry(dir, file)
      if (e === undefined) { report.unnumbered.push(file); continue }
      const id = `${e.prefix}\0${e.key}`
      const g = groups.get(id)
      if (g !== undefined) g.files.push(file)
      else groups.set(id, { number: BigInt(e.prefix), prefix: e.prefix, key: e.key, files: [file], status: 'ok' })
    }
    for (const m of groups.values()) {
      report.migrations.push(m)
      // Already on the base or at ref (the PR is part of the batch): nothing to renumber.
      const present = m.files.every(f => landed.has(f))
      const other = present ? undefined : taken.find(t => t.n === m.number && t.key !== m.key)
      if (other !== undefined) { m.status = 'clash'; m.clashWith = other.file }
      else if (!present && baseHigh !== undefined && m.number <= baseHigh) m.status = 'at-or-below'
      if (m.status === 'ok') {
        if (high === undefined || m.number > high) high = m.number
        for (const file of m.files) taken.push({ file, n: m.number, key: m.key })
        continue
      }
      // Highest + 1, never a gap fill; later flagged migrations get successive numbers.
      const next = (high ?? 0n) + 1n
      high = next
      m.newNumber = String(next).padStart(m.prefix.length, '0')
      m.moves = m.files.map(from => {
        const e = parseEntry(dir, from)!
        return { from, to: `${dir}/${m.newNumber}${e.segment.slice(e.prefix.length)}${e.rest}` }
      })
      for (const mv of m.moves) taken.push({ file: mv.to, n: next, key: m.key })
    }
  }
  return { dir, ...(baseHigh !== undefined && { baseHigh }), ...(refHigh !== undefined && { refHigh }), prs }
}

// Lines in the PR's own changed files that mention a flagged migration's number (a whole token) or its
// file or folder name, other than the migration's own files.
export function findRefs(m: Migration, files: Array<{ path: string; text: string }>): Ref[] {
  const names = new Set<string>()
  for (const f of m.files) for (const s of f.split('/')) if (s.startsWith(m.prefix) && s.length > m.prefix.length) names.add(s)
  const token = new RegExp(`(?<![0-9A-Za-z])${m.prefix}(?![0-9])`)
  const own = new Set(m.files)
  const out: Ref[] = []
  for (const f of files) {
    if (own.has(f.path)) continue
    f.text.split('\n').forEach((line, i) => {
      if (token.test(line) || [...names].some(n => line.includes(n))) out.push({ file: f.path, line: i + 1 })
    })
  }
  return out
}

export function render(report: Report): string {
  const show = (n: bigint | undefined) => n === undefined ? 'none' : String(n)
  const lines = [
    `Migrations in ${report.dir}`,
    `Highest on the base: ${show(report.baseHigh)}`,
    `Highest at ref: ${show(report.refHigh)}`,
  ]
  for (const p of report.prs) {
    lines.push('', `PR #${p.pr}`)
    if (p.error !== undefined) { lines.push(`  not checked: ${p.error}`); continue }
    if (p.migrations.length === 0 && p.unnumbered.length === 0) lines.push('  adds no migration')
    for (const m of p.migrations) {
      const label = m.files.join(', ')
      if (m.status === 'ok') { lines.push(`  ok: ${label} (number ${m.prefix})`); continue }
      lines.push(m.status === 'clash'
        ? `  clash: ${label} (number ${m.prefix}) has the same number as ${m.clashWith}`
        : `  at-or-below: ${label} (number ${m.prefix}) is not above the highest on the base (${show(report.baseHigh)})`)
      lines.push(`    next free number: ${m.newNumber}`)
      for (const mv of m.moves ?? []) lines.push(`    git mv ${mv.from} ${mv.to}`)
      for (const r of m.refs ?? []) lines.push(`    references its number in ${r.file}:${r.line}`)
    }
    for (const u of p.unnumbered) lines.push(`  unnumbered (ignored): ${u}`)
  }
  return lines.join('\n')
}

export const UNSET_TEXT = 'No migrations directory is set (the migrations_dir setting is empty): nothing checked.'
