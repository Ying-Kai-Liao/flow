// Dry run of the decision-API replay (hooks/decide-eval.ts): builds the four datasets from flow's own history, with the
// session transcripts as well (the engine tool cannot read files over 4 MiB, this script can), and prints their sizes and
// sample texts. No network, no key: the live run is the main-only `decide_eval` tool, which uses the key in /config.
//
//   node --experimental-strip-types scripts/decide-eval.mjs [--export] [--samples N] [--flow-dir <dir>] [--transcripts <dir>]
import { execFileSync } from 'node:child_process'
import { createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

// hooks/*.ts import each other without extensions (the plugin bundler resolves them); node needs the extension.
register('data:text/javascript,' + encodeURIComponent(
  'export async function resolve(s, c, n) { if ((s.startsWith("./") || s.startsWith("../")) && !/\\.[a-z]+$/.test(s)) { try { return await n(s + ".ts", c) } catch {} } return n(s, c) }',
))

const root = join(dirname(new URL(import.meta.url).pathname), '..')
const { EXPORT_FILE, exportJson, formatSize, formatSizeSplit, loadDatasets, managerCounterfactual, sizeBaselines, sizeSplit } = await import(pathToFileURL(join(root, 'hooks/decide-eval.ts')).href)

const argv = process.argv.slice(2)
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt }
const samples = Number(opt('samples', '2'))
const gitCommon = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim()
const flowDir = opt('flow-dir', join(gitCommon, 'flow'))
const transcriptDir = opt('transcripts', join(homedir(), '.claude', 'projects', dirname(gitCommon).replace(/[^A-Za-z0-9]/g, '-')))
const MAX_CONTINUES = 2 // the max_continues default (settings.ts)

const textBlocks = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => (typeof b === 'string' ? b : b?.text ?? '')).join('\n') : '')
// Pull requests by head branch, for the size labels (over = a large package whose PR is trivial). One gh call; without gh
// the size dataset just has no merged PRs and labels only the under-sized.
function pullRequests() {
  try {
    const out = execFileSync('gh', ['pr', 'list', '--state', 'all', '--limit', '1000', '--json', 'headRefName,state,files'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    const prs = {}
    for (const p of JSON.parse(out)) if (prs[p.headRefName] === undefined || p.state === 'MERGED') prs[p.headRefName] = { state: p.state, files: (p.files ?? []).map(f => ({ path: f.path, additions: f.additions, deletions: f.deletions })) }
    return prs
  } catch (err) {
    console.error(`gh pr list failed (${String(err.message).split('\n')[0]}); size labels will have no PRs`)
    return {}
  }
}

// A shell command that may change files counts as an edit between two test runs; a test run may redirect its output.
const MUTATING = /sed -i|python3?\b|node -e|\btee\b|git (?:checkout|stash|apply|commit|merge|rebase|pull|reset|restore|add)\b|\bpatch\b|\bmv\b|\bcp\b|cat\s*>|<<\s*'?EOF/
const isEdit = cmd => MUTATING.test(cmd) || (/(?:^|[^>])>{1,2}[^>&]/.test(cmd) && !/\btest\b|\bbun\b|\bnpm\b/.test(cmd))

// One ordered list of light events per transcript file, streamed line by line (the files are large).
async function transcriptEvents() {
  const files = []
  const walk = d => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : p.endsWith('.jsonl') && files.push(p) } }
  if (existsSync(transcriptDir)) walk(transcriptDir)
  const out = []
  for (const file of files) {
    const list = []
    const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
    for await (const line of rl) {
      if (!/CONFLICT \(|"name":"(Agent|Edit|Write|Bash)"|\(fail\)|\d+ pass\b/.test(line)) continue
      let j
      try { j = JSON.parse(line) } catch { continue }
      const c = j.message?.content
      if (!Array.isArray(c)) continue
      for (const b of c) {
        if (b.type === 'tool_use') {
          if (b.name === 'Agent') list.push({ t: 'agent', model: String(b.input?.model ?? ''), type: String(b.input?.subagent_type ?? ''), prompt: String(b.input?.prompt ?? '').slice(0, 12000), ...(typeof b.input?.name === 'string' ? { name: b.input.name } : {}) })
          else if (b.name === 'Edit' || b.name === 'Write') list.push({ t: 'edit' })
          else if (b.name === 'Bash' && isEdit(String(b.input?.command ?? ''))) list.push({ t: 'edit' })
        } else if (b.type === 'tool_result') list.push({ t: 'result', id: b.tool_use_id, text: textBlocks(b.content) })
      }
    }
    if (list.length > 0) out.push(list)
  }
  return out
}

const rd = async path => { try { return readFileSync(path, 'utf8') } catch { return undefined } }
const { datasets, units } = await loadDatasets({ read: rel => rd(join(flowDir, rel)), readAbs: rd, maxContinues: MAX_CONTINUES, transcripts: await transcriptEvents(), prs: pullRequests() })
console.log(`flow dir: ${flowDir}\ntranscripts: ${transcriptDir}`)
for (const d of datasets) {
  const labels = {}
  for (const r of d.records) labels[r.label] = (labels[r.label] ?? 0) + 1
  console.log(`\n== ${d.key}: ${d.records.length} records${d.guard ? ` (+${d.guard.length} must-not-auto-answer)` : ''}; labels ${JSON.stringify(labels)}`)
  for (const note of d.notes) console.log(`   ${note}`)
  if (d.key === 'size') console.log(`${formatSize(sizeBaselines(d.records))}\n\n${formatSizeSplit(sizeSplit(d.records), managerCounterfactual(d.records))}`)
  for (const r of d.records.slice(0, samples)) console.log(`--- sample ${r.id} (actual: ${r.label}) ---\n${r.text.slice(0, 1200)}${r.text.length > 1200 ? '\n[...]' : ''}`)
}

// --export: the built datasets (with texts) for the decide_eval tool, which cannot read transcripts. The tool's file read
// is capped at 4 MiB, so texts are cut harder until the file is under 3 MiB.
if (argv.includes('--export')) {
  const path = join(flowDir, EXPORT_FILE)
  let max = 4000
  let json = exportJson(datasets, units, new Date().toISOString(), max)
  while (json.length > 3 * 1024 * 1024 && max > 250) { max = Math.floor(max / 2); json = exportJson(datasets, units, new Date().toISOString(), max) }
  writeFileSync(path, json)
  console.log(`\nexported to ${path}: ${(Buffer.byteLength(json) / 1024).toFixed(0)} KiB, texts cut at ${max} chars; ${datasets.map(d => `${d.key} ${d.records.length}${d.guard ? `+${d.guard.length}` : ''}`).join(', ')}`)
}
