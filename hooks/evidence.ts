// The `## Verification` section of a PR description: what the worker ran, how the change was exercised for
// real, and what was not verified. `handover` refuses a PR without it; the parsed record travels with the
// handover into the queue report and the status file. Pure, so it is tested without the plugin runtime.

export type Evidence = { ran: string[]; exercised: string; notVerified: string[] }

export const EVIDENCE_FORMAT = [
  '## Verification',
  'Ran:',
  '- `<command>`: pass (<short result, e.g. 42 tests>)',
  'Exercised: <how the change was run for real: app launched and what was seen, screenshot path, curl output, or "n/a: <reason>" for docs/prompt-only changes>',
  'Not verified:',
  '- <what you did not check>   (or one line "Not verified: none, because <reason>")',
].join('\n')

const LABELS = { ran: /^ran$/i, exercised: /^exercised$/i, notVerified: /^not verified$/i }
type Key = keyof typeof LABELS

const bullet = /^\s*[-*]\s+/
const label = /^\s*(ran|exercised|not verified)\s*:\s*(.*)$/i

// The text of the section, or undefined when the body has none. Case-insensitive heading, ends at the next `## `.
export function verificationSection(body: string): string | undefined {
  const lines = body.replace(/\r\n?/g, '\n').split('\n')
  const start = lines.findIndex(l => /^##\s+verification\s*$/i.test(l.trim()))
  if (start < 0) return undefined
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(l => /^##\s/.test(l))
  return (end < 0 ? rest : rest.slice(0, end)).join('\n')
}

// Labels may stand alone with bullets below, or carry text after the colon. Bullets are entries; any other
// text under Ran or Not verified is one entry per line; Exercised joins its lines.
export function parseVerification(section: string): Partial<Evidence> {
  const out: Evidence = { ran: [], exercised: '', notVerified: [] }
  const seen = new Set<Key>()
  let cur: Key | undefined
  const add = (key: Key, text: string) => {
    const t = text.trim()
    if (!t) return
    if (key === 'exercised') out.exercised = out.exercised ? `${out.exercised} ${t}` : t
    else out[key].push(t)
  }
  for (const raw of section.split('\n')) {
    const m = label.exec(raw)
    if (m && !bullet.test(raw)) {
      cur = (Object.keys(LABELS) as Key[]).find(k => LABELS[k].test(m[1]!.trim()))!
      seen.add(cur)
      add(cur, m[2]!)
    } else if (cur) {
      add(cur, raw.replace(bullet, ''))
    }
  }
  return {
    ...(seen.has('ran') ? { ran: out.ran } : {}),
    ...(seen.has('exercised') ? { exercised: out.exercised } : {}),
    ...(seen.has('notVerified') ? { notVerified: out.notVerified } : {}),
  }
}

const unticked = (s: string) => s.replace(/`/g, '')

// Evidence when the body qualifies, else every reason it does not. `required` are the settings' workerChecks
// and alwaysTests: each must appear (backticks optional) in some Ran entry.
export function checkEvidence(body: string, required: string[]): { evidence: Evidence } | { problems: string[] } {
  const section = verificationSection(body)
  if (section === undefined) return { problems: ['the PR description has no `## Verification` section'] }
  if (!section.trim()) return { problems: ['the `## Verification` section is empty'] }
  const p = parseVerification(section)
  const problems: string[] = []
  if (!p.ran?.length) problems.push('`Ran:` has no entries')
  if (!p.exercised) problems.push('`Exercised:` is missing or empty')
  else if (/^n\/a:?$/i.test(p.exercised.trim())) problems.push('`Exercised: n/a` needs a reason ("n/a: <reason>")')
  if (!p.notVerified?.length) problems.push('`Not verified:` is missing or empty')
  else if (p.notVerified.length === 1 && /^(nothing|none|n\/a|-)\.?$/i.test(unticked(p.notVerified[0]!).trim())) {
    problems.push('`Not verified:` must name at least one honest item, or say "none, because <reason>"')
  }
  if (p.ran?.length) {
    const ran = p.ran.map(unticked)
    for (const cmd of required) {
      if (!ran.some(r => r.includes(unticked(cmd)))) problems.push(`required command \`${cmd}\` does not appear under \`Ran:\``)
    }
  }
  if (problems.length) return { problems }
  return { evidence: { ran: p.ran!, exercised: p.exercised!, notVerified: p.notVerified! } }
}

export function evidenceRefusal(pr: number, problems: string[]): string {
  return [
    `Refused: PR #${pr} does not carry the proof handover requires:`,
    ...problems.map(p => `- ${p}`),
    'The PR description must contain this section:',
    EVIDENCE_FORMAT,
    `Have the worker fix the PR description (gh pr edit ${pr} --body-file <file>), then call handover again.`,
  ].join('\n')
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// Full text, for the queue's list.
export function evidenceText(e: Evidence | undefined): string {
  if (!e) return 'no evidence recorded'
  return `ran: ${e.ran.join('; ')} | exercised: ${e.exercised} | not verified: ${e.notVerified.join('; ')}`
}

// Short, for the status line.
export function evidenceSummary(e: Evidence | undefined): string {
  if (!e) return 'no evidence recorded'
  return `${e.ran.length} ran, exercised: ${clip(e.exercised, 60)}, ${e.notVerified.length} not verified`
}
