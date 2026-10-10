import type { Handover } from '../types'
import type { Settings } from './prompts'
import { bumpVersion, changelogSection, cutChangelog, highestBump, labelBump, localDate, readVersion, setVersion } from './release'
import type { Bump } from './release'
import type { PushState } from './pushgate'

// The release tool: cutting a batch's release and publishing it. The engine refuses `$` across an
// import, so register.tsx builds a ReleaseIo of closures over the calls this needs.
export type ReleaseIo = {
  // Run a command; `cwd` only when the call set one.
  exec: (argv: string[], cwd?: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  sleep: (ms: number) => Promise<void>
  now: () => Promise<number>
  exists: (path: string) => Promise<boolean>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  stateDir: () => Promise<string | undefined>
  readJson: (path: string) => Promise<unknown>
  writeJsonAtomic: (path: string, obj: unknown) => Promise<boolean>
  // The last batch the release tool cut, so a retried push does not release twice.
  getLast: () => { key: string; version: string } | undefined
  setLast: (last: { key: string; version: string }) => void
  handovers: () => Promise<Record<string, Handover>>
  batch: () => Promise<PushState['batch']>
}

// Tag the release commit, push the tag and create the GitHub Release. Every step is idempotent and retried, and
// a failure is a returned line, never a throw: the release commit is already pushed and the batch stays done.
const PUBLISH_ATTEMPTS = 4
export async function publishRelease(io: ReleaseIo, settings: Settings, dir: string, wanted: string | undefined): Promise<string> {
  if (!settings.release) return 'Refused: the release setting is off, so nothing is published.'
  if (!settings.releaseGithub) return 'Refused: the release_github setting is off, so nothing is published.'
  if (!dir.startsWith('/')) return 'Refused: dir must be the absolute path of your worktree.'
  let version = wanted
  if (version === undefined) {
    let last = io.getLast()
    if (last === undefined) {
      const stateD = await io.stateDir()
      const disk = stateD === undefined ? undefined : await io.readJson(`${stateD}/release.json`) as { key?: string; version?: string } | undefined
      if (typeof disk?.version === 'string') last = { key: String(disk.key ?? ''), version: disk.version }
    }
    version = last?.version
  }
  if (version === undefined) return 'Refused: no version to publish; pass version or cut a release first.'
  const tag = `v${version}`
  const git = (...a: string[]) => io.exec(['git', '-C', dir, ...a])
  const tail = (r: { stderr: string; stdout: string }) => (r.stderr.trim() || r.stdout.trim()).split('\n').slice(-3).join(' ').slice(0, 300)
  const run = async (step: string, argv: string[]): Promise<{ ok: true } | { ok: false; line: string }> => {
    let last = ''
    for (let i = 0; i < PUBLISH_ATTEMPTS; i++) {
      if (i > 0) await io.sleep(2000 * 2 ** (i - 1))
      try {
        const r = await io.exec(argv, dir)
        if (r.exitCode === 0) return { ok: true }
        last = tail(r)
      } catch (err) { last = err instanceof Error ? err.message : String(err) }
    }
    return { ok: false, line: `Not published: ${step} failed: ${last}. The release commit is pushed; report this, the batch stays done.` }
  }
  try {
    // The release commit may sit below a merge commit (a rejected push is fetched, merged and pushed again).
    const log = await git('log', '--first-parent', '-n', '50', '--format=%H %s')
    if (log.exitCode !== 0) return `Not published: could not read the log of ${dir}: ${tail(log)}. The release commit is pushed; report this, the batch stays done.`
    const sha = log.stdout.split('\n').find(l => l.slice(41) === `Release ${version}`)?.slice(0, 40)
    if (sha === undefined) return `Refused: no commit "Release ${version}" in the last 50 first-parent commits of ${dir}. Publish only after the release commit is in HEAD.`
    const anc = await git('merge-base', '--is-ancestor', sha, 'HEAD')
    if (anc.exitCode !== 0) return `Refused: the commit "Release ${version}" is not an ancestor of HEAD in ${dir}.`
    const existing = await git('rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`)
    if (existing.exitCode === 0 && existing.stdout.trim() !== sha) return `Not published: tag ${tag} already exists at ${existing.stdout.trim().slice(0, 8)}, not at the release commit ${sha.slice(0, 8)}; it was not moved. The release commit is pushed; report this, the batch stays done.`
    if (existing.exitCode !== 0) {
      const t = await git('tag', '-a', tag, '-m', `Release ${version}`, sha)
      if (t.exitCode !== 0) return `Not published: tagging failed: ${tail(t)}. The release commit is pushed; report this, the batch stays done.`
    }
    const pushed = await run('pushing the tag', ['git', '-C', dir, 'push', 'origin', tag])
    if (!pushed.ok) return pushed.line
    const view = await io.exec(['gh', 'release', 'view', tag], dir)
    if (view.exitCode === 0) return `Published ${tag}: tag pushed, GitHub Release already existed.`
    const logName = settings.changelogFile || 'CHANGELOG.md'
    const section = await io.exists(`${dir}/${logName}`) ? changelogSection(await io.read(`${dir}/${logName}`), version) : undefined
    const stateD = await io.stateDir()
    const notes = `${stateD ?? '/tmp'}/release-notes-${tag}.md`
    await io.write(notes, section !== undefined && section !== '' ? section + '\n' : `Release ${version}\n`)
    const made = await run('gh release create', ['gh', 'release', 'create', tag, '--title', tag, '--notes-file', notes, '--verify-tag'])
    if (!made.ok) return made.line
    const url = await io.exec(['gh', 'release', 'view', tag, '--json', 'url', '--jq', '.url'], dir)
    return `Published ${tag}: tag pushed, GitHub Release created${url.exitCode === 0 && url.stdout.trim() !== '' ? ' ' + url.stdout.trim() : ''}.${section === undefined || section === '' ? ` The changelog has no ${version} section, so the notes are "Release ${version}".` : ''}`
  } catch (err) {
    return `Not published: ${err instanceof Error ? err.message : String(err)}. The release commit is pushed; report this, the batch stays done.`
  }
}

// The body of the mcp__flow__release tool call.
export async function releaseTool(io: ReleaseIo, settings: Settings, input: Record<string, unknown>): Promise<{ result: string }> {
  if (!settings.release) return { result: 'Refused: the release setting is off, so nothing is released. Skip the release step.' }
  const dir = String(input.dir ?? '').replace(/\/+$/, '')
  if (input.action === 'publish') return { result: await publishRelease(io, settings, dir, typeof input.version === 'string' ? input.version.replace(/^v/, '') : undefined) }
  const prs = Array.isArray(input.prs) ? input.prs.map(Number).filter(n => Number.isInteger(n) && n > 0) : []
  if (!dir.startsWith('/')) return { result: 'Refused: dir must be the absolute path of your worktree.' }
  if (prs.length === 0) return { result: 'Refused: prs must list the PR numbers merged in this batch.' }
  const key = [...new Set(prs)].sort((a, b) => a - b).join(',')
  const stateD = await io.stateDir()
  let last = io.getLast()
  if (last === undefined && stateD !== undefined) {
    const disk = await io.readJson(`${stateD}/release.json`) as { key?: string; version?: string } | undefined
    if (typeof disk?.key === 'string' && typeof disk.version === 'string') last = { key: disk.key, version: disk.version }
  }
  // A batch the user released that went stale (the base moved) is built and released again: that re-cut is allowed.
  const open = await io.batch()
  const recut = input.recut === true && open !== undefined && open.state !== 'ready'
  if (last?.key === key && !recut) return { result: `Refused: already released ${last.version} for PRs ${key.replaceAll(',', ', ')}. The release commit is in your worktree; go on to the push.` }
  let files = settings.releaseFiles ?? []
  if (files.length === 0 && await io.exists(`${dir}/package.json`)) files = ['package.json']
  if (files.length === 0) return { result: 'Refused: no version file. Set release_files (repo-relative JSON or TOML files) in .claude/flow.json, or add a package.json at the repo root; a release without a version is meaningless.' }
  const logName = settings.changelogFile || 'CHANGELOG.md'
  if (!(await io.exists(`${dir}/${logName}`))) return { result: `Refused: the changelog ${logName} does not exist in ${dir}; create it or set changelog_file.` }
  const all = await io.handovers()
  const asked: (Bump | undefined)[] = []
  const titles: string[] = []
  let ghNote = ''
  for (const pr of prs) {
    const h = all[String(pr)]
    asked.push(h?.release)
    titles.push(`- ${h?.title ?? 'PR'} (#${pr})`)
    const v = await io.exec(['gh', 'pr', 'view', String(pr), '--json', 'labels'])
    let names: string[] | undefined
    if (v.exitCode === 0) {
      try { names = ((JSON.parse(v.stdout) as { labels?: { name: string }[] }).labels ?? []).map(l => l.name) } catch { names = undefined }
    }
    if (names === undefined) ghNote = ' gh could not read some PR labels; those PRs counted by their handover release field only.'
    else asked.push(labelBump(names))
  }
  const kind = highestBump(asked)
  try {
    const texts = await Promise.all(files.map(f => io.read(`${dir}/${f}`)))
    const next = bumpVersion(readVersion(texts[0]!, files[0]!), kind)
    const date = localDate(await io.now())
    const log = cutChangelog(await io.read(`${dir}/${logName}`), next, date, titles)
    const updated = files.map((f, i) => setVersion(texts[i]!, f, next))
    for (const [i, f] of files.entries()) await io.write(`${dir}/${f}`, updated[i]!)
    await io.write(`${dir}/${logName}`, log)
    const cut = { key, version: next }
    io.setLast(cut)
    if (stateD !== undefined) await io.writeJsonAtomic(`${stateD}/release.json`, cut)
    return { result: `Released ${next} (${kind} bump from ${readVersion(texts[0]!, files[0]!)}). Changed: ${[...files, logName].join(', ')}.${ghNote} Now run: git -C ${dir} commit -am "Release ${next}" (add your attribution lines), then push as usual.` }
  } catch (err) {
    return { result: `Refused: ${err instanceof Error ? err.message : String(err)}` }
  }
}
