// The size_ab A/B report (hooks/size-ab.ts) from the files of the flow state dir. Read-only, no network.
//
//   node --experimental-strip-types scripts/size-ab.mjs [--flow-dir <dir>]
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

// hooks/*.ts import each other without extensions (the plugin bundler resolves them); node needs the extension.
register('data:text/javascript,' + encodeURIComponent(
  'export async function resolve(s, c, n) { if ((s.startsWith("./") || s.startsWith("../")) && !/\\.[a-z]+$/.test(s)) { try { return await n(s + ".ts", c) } catch {} } return n(s, c) }',
))

const root = join(dirname(new URL(import.meta.url).pathname), '..')
const { reportFrom } = await import(pathToFileURL(join(root, 'hooks/size-ab.ts')).href)

const argv = process.argv.slice(2)
const i = argv.indexOf('--flow-dir')
const gitCommon = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim()
const flowDir = i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : join(gitCommon, 'flow')
const rd = name => { try { return readFileSync(join(flowDir, name), 'utf8') } catch { return undefined } }
console.log(reportFrom(rd('ledger.json'), rd('log.jsonl')))
