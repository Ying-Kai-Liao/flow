#!/usr/bin/env node
// Recompute the cost ledger's token and turn numbers from the agents' transcripts.
//
//   node scripts/ledger-rebuild.mjs [--ledger <path>] [--project <dir>] [--write]
//
// Before 0.6.70 every plugin reload added the disk ledger onto the in-memory one, so old totals are
// inflated. This keeps every entry (decide_eval and /flow status read names, sizes and manager links)
// and only replaces `models` and, where an entry already has it, `turns`, with what the transcripts
// say. Entries whose transcript is gone are kept as they are and flagged. Dry run unless --write;
// --write copies the old file to ledger-pre-rebuild-<date>[-N].json first. Run --write with flow
// idle, then restart the plugin: its in-memory ledger would overwrite the file on its next save.
// No dependencies. The logic is in ledger-rebuild-core.mjs; this file reads and writes the files.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { backupName, parseLines, rebuild, repliesOf, report } from './ledger-rebuild-core.mjs'

// The projects dir of a checkout: its path with / and . as -.
export const slugOf = dir => dir.replace(/[/.]/g, '-')

// The repo's common git dir, the same from any of its worktrees; the main checkout is its parent.
export function commonDir(cwd) {
  return execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8' }).trim()
}

// Every transcript under the project dir: root sessions (with the time of their first entry) and
// subagent files by agent id. Worktree slugs (<main slug>--claude-worktrees-*) are searched too.
export function discover(project) {
  const dirs = [project]
  const parent = path.dirname(project)
  const base = path.basename(project)
  if (fs.existsSync(parent)) {
    for (const d of fs.readdirSync(parent)) if (d.startsWith(`${base}--claude-worktrees-`)) dirs.push(path.join(parent, d))
  }
  const sessions = []
  const agents = new Map()
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f)
      if (f.endsWith('.jsonl')) {
        const text = fs.readFileSync(full, 'utf8')
        const first = parseLines(text).map(e => Date.parse(e.timestamp)).find(Number.isFinite)
        sessions.push({ file: full, first, replies: repliesOf([text]) })
        continue
      }
      const sub = path.join(full, 'subagents')
      if (!fs.statSync(full).isDirectory() || !fs.existsSync(sub)) continue
      for (const a of fs.readdirSync(sub)) {
        const m = /^agent-(.+)\.jsonl$/.exec(a)
        if (m) agents.set(m[1], [...(agents.get(m[1]) ?? []), path.join(sub, a)])
      }
    }
  }
  return { sessions, agents, agentTexts: key => agents.get(key)?.map(f => fs.readFileSync(f, 'utf8')) }
}

// Backs the old file up under a dated name (never over an existing backup), then replaces it atomically.
export function writeLedger(ledgerPath, ledger, date) {
  const dir = path.dirname(ledgerPath)
  const backup = path.join(dir, backupName(date, n => fs.existsSync(path.join(dir, n))))
  fs.copyFileSync(ledgerPath, backup, fs.constants.COPYFILE_EXCL)
  const tmp = `${ledgerPath}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`)
  fs.renameSync(tmp, ledgerPath)
  return backup
}

const localDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function main(argv) {
  const opt = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
  const cwd = process.cwd()
  const ledgerPath = opt('--ledger') ?? path.join(commonDir(cwd), 'flow', 'ledger.json')
  const project = opt('--project') ?? path.join(os.homedir(), '.claude/projects', slugOf(path.dirname(commonDir(cwd))))
  const raw = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))
  const found = discover(project)
  const { ledger, rows } = rebuild(raw, found)
  console.log(`ledger ${ledgerPath}\ntranscripts ${project} (${found.sessions.length} main sessions, ${found.agents.size} agents)\n`)
  console.log(report(rows))
  if (argv.includes('--write')) {
    const backup = writeLedger(ledgerPath, ledger, localDate(new Date()))
    console.log(`\nWrote ${ledgerPath}\nBackup ${backup}\nRestart the plugin (/reload or a new session) so its in-memory ledger does not overwrite this.`)
  } else {
    console.log('\nDry run: nothing written. Add --write (with flow idle) to apply.')
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main(process.argv.slice(2))
