import type { Settings } from './prompts'
import type { Ran } from './session-run'
import { analyze, cleanDir, findRefs, render, UNSET_TEXT } from './migrations'
import type { PrInput } from './migrations'

// The migrations tool. The engine refuses `$` across an import, so register.tsx builds a MigrationsIo.
export type MigrationsIo = {
  runCmd: (argv: string[]) => Promise<Ran>
}

export async function migrationsTool(io: MigrationsIo, settings: Settings, input: Record<string, unknown>): Promise<{ result: string }> {
    const dir = cleanDir(settings.migrationsDir)
    if (dir === '') return { result: UNSET_TEXT }
    const ref = typeof input.ref === 'string' && input.ref.trim() !== '' ? input.ref.trim() : 'HEAD'
    const prs = Array.isArray(input.prs) ? input.prs.filter((n): n is number => Number.isInteger(n)) : []
    const base = settings.base
    const git = (...argv: string[]) => io.runCmd(['git', ...argv])
    const lines = async (...argv: string[]) => {
      const r = await git(...argv)
      return r.exitCode === 0 ? r.stdout.split('\n').filter(l => l !== '') : []
    }
    const fetched = await git('fetch', 'origin', base)
    if (fetched.exitCode !== 0) return { result: `Cannot read the base: git fetch origin ${base} failed: ${fetched.stderr.trim().split('\n')[0]?.slice(0, 200) ?? ''}` }
    const baseRef = `origin/${base}`
    // A dir missing on the base or at ref (a new repo) lists nothing: numbering starts from the PR's own.
    const baseFiles = await lines('ls-tree', '-r', '--name-only', baseRef, '--', dir)
    const refFiles = await lines('ls-tree', '-r', '--name-only', ref, '--', dir)

    const heads = new Map<number, string>()
    const inputs: PrInput[] = []
    for (const pr of prs) {
      const fail = (error: string) => inputs.push({ pr, added: [], error })
      const view = await io.runCmd(['gh', 'pr', 'view', String(pr), '--json', 'headRefOid'])
      const head = view.exitCode === 0 ? (JSON.parse(view.stdout || '{}') as { headRefOid?: string }).headRefOid : undefined
      if (head === undefined || head === '') { fail(`gh pr view failed: ${view.stderr.trim().split('\n')[0]?.slice(0, 200) || 'no head'}`); continue }
      const pull = await git('fetch', 'origin', `pull/${pr}/head`)
      if (pull.exitCode !== 0) { fail(`head ${head.slice(0, 9)} not fetchable: ${pull.stderr.trim().split('\n')[0]?.slice(0, 200) ?? ''}`); continue }
      heads.set(pr, head)
      inputs.push({ pr, added: await lines('diff', '--name-only', '--diff-filter=A', `${baseRef}...${head}`, '--', dir) })
    }

    const report = analyze({ dir, baseFiles, refFiles, prs: inputs })
    // Only a flagged migration needs the PR's own files read for mentions of its old number.
    for (const p of report.prs) {
      const head = heads.get(p.pr)
      if (head === undefined || p.migrations.every(m => m.status === 'ok')) continue
      const files: Array<{ path: string; text: string }> = []
      for (const path of (await lines('diff', '--name-only', '--diff-filter=AM', `${baseRef}...${head}`)).slice(0, 300)) {
        const shown = await git('show', `${head}:${path}`)
        if (shown.exitCode === 0) files.push({ path, text: shown.stdout })
      }
      for (const m of p.migrations) if (m.status !== 'ok') m.refs = findRefs(m, files)
    }
    return { result: render(report) }
}
