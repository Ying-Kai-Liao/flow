import type { EnvChange, Handover, LogEvent } from '../types'
import type { settingsOf } from './settings'
import type { Ran } from './session-run'
import { checkEvidence, evidenceRefusal } from './evidence'
import { guardTestsFor } from './guardtests'
import { autoRefused, effectiveMode, labelSpec, parseMode } from './mergemode'
import { isBump } from './release'
import { parseEnvInput } from './deploy'
import type { Draft } from './deploy'
import { mirror } from './core'

type Settings = ReturnType<typeof settingsOf>

// The handover tool: records an approved PR for the reviewer. The engine refuses `$` across an
// import, so register.tsx builds a HandoverIo of closures over the calls this needs.
export type HandoverIo = {
  run: (argv: string[]) => Promise<Ran>
  now: () => Promise<number>
  handovers: () => Promise<Record<string, Handover>>
  putHandover: (pr: string, h: Handover) => Promise<void>
  resolveReportTo: (given: unknown, callerId: string | undefined) => Promise<{ name: string; note?: string } | { refuse: string }>
  openEnv: (h: Handover, drafts: Draft[], prev: EnvChange[], at: number) => Promise<string>
  best: (what: string, fn: () => Promise<void>) => Promise<void>
  saveHandover: (h: Handover) => Promise<void>
  appendLog: (event: Omit<LogEvent, 'ts'>) => Promise<void>
  toast: (text: string) => void
  refresh: () => Promise<unknown>
  ensureQueue: () => Promise<string>
}

export async function handoverTool(io: HandoverIo, settings: Settings, input: Record<string, unknown>, agentId: string | undefined): Promise<{ result: string }> {
        const pr = Number(input.pr)
    if (!Number.isInteger(pr) || pr <= 0) return { result: 'Refused: pr must be a PR number.' }
    if (!settings.useReviewer) {
      return { result: `Refused: this repo has no reviewer (the plugin's reviewer option is off). Merge it yourself: full check, then gh pr merge ${pr} --${settings.mergeMethod} --delete-branch.` }
    }
    const setMode = parseMode(settings.mergeMode)
    const asked = input.mode === 'confirm' || input.mode === 'auto' ? input.mode : undefined
    if (autoRefused(asked, setMode)) {
      return { result: 'Refused: the merge_mode setting is confirm, so a manager cannot mark a PR auto. Only the user lowers it, by adding the flow:auto label to the PR by hand.' }
    }
    const view = await io.run(['gh', 'pr', 'view', String(pr), '--json', 'state,isDraft,headRefOid,headRefName,title,body,labels'])
    if (view.exitCode !== 0) return { result: `Refused: gh pr view ${pr} failed: ${view.stderr.trim().slice(0, 300)}` }
    const info = JSON.parse(view.stdout) as { state: string; isDraft: boolean; headRefOid: string; headRefName: string; title: string; body?: string; labels?: { name: string }[] }
    if (info.state !== 'OPEN') return { result: `Refused: PR #${pr} is ${info.state}.` }
    if (info.isDraft) return { result: `Refused: PR #${pr} is a draft. Mark it ready (gh pr ready ${pr}) first.` }
    if ((await io.handovers())[String(pr)]?.status === 'ready') {
      return { result: `Refused: PR #${pr} is in a batch that awaits the user's /flow push. Leave it alone; if the user sends it back you hear so.` }
    }
    const dest = await io.resolveReportTo(input.report_to, agentId)
    if ('refuse' in dest) return { result: dest.refuse }
    const envParsed = parseEnvInput(input.env, mirror.deployInfos)
    if ('error' in envParsed) return { result: `Refused: ${envParsed.error}` }
    // Guard tests: from the PR's changed files (`gh pr diff` has no file-count cap). Never fail open, never block for good.
    let guard: ReturnType<typeof guardTestsFor> = []
    if (Object.keys(settings.guardTests).length > 0) {
      const diff = await io.run(['gh', 'pr', 'diff', String(pr), '--name-only'])
      if (diff.exitCode !== 0) return { result: `Refused: gh pr diff ${pr} --name-only failed, so the guard tests cannot be checked: ${diff.stderr.trim().slice(0, 300)}` }
      guard = guardTestsFor(diff.stdout.split('\n').map(l => l.trim()).filter(Boolean), settings.guardTests)
    }
    const checked = checkEvidence(info.body ?? '', [...settings.workerChecks, ...settings.alwaysTests], guard)
    if ('problems' in checked) return { result: evidenceRefusal(pr, checked.problems) }
    const t = await io.now()
    const h: Handover = {
      pr, title: info.title, head: info.headRefOid, branch: info.headRefName,
      reportTo: dest.name, verified: String(input.verified ?? ''),
      pending: String(input.pending ?? 'none'), afterDeploy: String(input.after_deploy ?? 'none'),
      ...(typeof input.verify_command === 'string' && input.verify_command.trim() !== '' ? { verifyCommand: input.verify_command.trim() } : {}),
      evidence: checked.evidence, status: 'pending', at: t, ...(asked !== undefined ? { mode: asked } : {}),
      ...(isBump(input.release) ? { release: input.release } : {}),
    }
    // A labelling failure is reported, not fatal: the stored mode still gates the reviewer.
    let labelNote = ''
    const labels = (info.labels ?? []).map(l => l.name)
    if (asked !== undefined) {
      const spec = labelSpec(asked)
      const made = await io.run(['gh', 'label', 'create', spec.name, '--force', '--color', spec.color, '--description', spec.description])
      const added = made.exitCode === 0 ? await io.run(['gh', 'pr', 'edit', String(pr), '--add-label', spec.name]) : made
      if (added.exitCode === 0) labels.push(spec.name)
      else labelNote = ` Could not add the ${spec.name} label (${added.stderr.trim().slice(0, 200)}); the mode is stored anyway.`
    }
    const hold = effectiveMode(labels, h.mode, setMode) === 'confirm'
    if (hold) h.status = 'awaiting'
    const envNote = await io.openEnv(h, envParsed.drafts, (await io.handovers())[String(pr)]?.env ?? [], t)
    await io.putHandover(String(pr), h)
    await io.best('saving a handover', async () => {
      await io.saveHandover(h)
      await io.appendLog({ event: 'handover', owner: h.reportTo, pr, branch: h.branch, text: h.title })
    })
    if (hold) {
      void io.toast(`PR #${pr} awaits your approval: /flow approve ${pr}`)
      await io.refresh()
      return { result: `Handed over PR #${pr} at ${info.headRefOid.slice(0, 8)}, but it awaits the user's approval: the reviewer will not merge it until the user runs /flow approve ${pr}. Tell the user so in your report.${labelNote}${envNote}` }
    }
    const queue = await io.ensureQueue()
    await io.refresh()
    return { result: `Handed over PR #${pr} at ${info.headRefOid.slice(0, 8)}. ${queue} The reviewer reports back to ${h.reportTo} by message.${dest.note ?? ''}${labelNote}${envNote}` }
}
