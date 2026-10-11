// The answer for a flow tool whose tool.call hook did not finish. Without a `.catch` handler the host
// leaves a failed hook out, nothing else answers a plugin-registered tool, and the caller gets
// "no tool.call hook answered this call" with no hint what to do. This is the handler that answers in
// its place. Pure: the host gives a catch handler one second and rejects its `$` calls on re-entry.

// Tools that only read. A retry of these is always safe.
const READ_ONLY = new Set(['mcp__flow__status', 'mcp__flow__guard_tests', 'mcp__flow__migrations'])

/** A tool the plugin registers: its hook answers the call, and nothing beneath does. */
export const isFlowTool = (tool: string): boolean => tool.startsWith('mcp__flow__')

/** The part of the host's `next` a catch handler reads. */
export type FailedCall = { error: { kind: 'throw' | 'timeout' | 're-entry'; message?: string; cause?: 'lent' }; called: boolean }

/** Why the hook did not finish, in a few words for the caller. */
export function failReason(error: FailedCall['error']): string {
  if (error.kind === 're-entry') return 'the call arrived while another flow hook was running'
  if (error.kind === 'timeout') return 'it took longer than the host allows a hook'
  const m = (error.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
  return m === '' ? 'the hook failed' : `the hook failed: ${m}`
}

/**
 * The text a caller gets for a flow tool whose hook did not finish. Says whether the call could have
 * had an effect: a re-entry never ran the handler; a throw or a timeout may have stopped it after
 * some of its work, so a tool that writes says to look before repeating.
 */
export function toolFailText(tool: string, failed: FailedCall): string {
  const name = tool.replace(/^mcp__flow__/, '')
  const why = failReason(failed.error)
  if (failed.error.kind === 're-entry') return `flow: ${name} did not run (${why}). Nothing was recorded. Call it again.`
  if (READ_ONLY.has(tool)) return `flow: ${name} did not finish (${why}). It only reads, so nothing changed. Call it again.`
  return `flow: ${name} did not finish (${why}). It may have been recorded in part: call it again, and if it records something (a PR handover, a note, a queue action), check mcp__flow__status first when a repeat would matter.`
}

/** The `.catch` handler of every flow tool's `tool.call` hook: the caller is told to retry, never left without an answer. */
export function toolCatch(_: unknown, e: { tool: string }, next: FailedCall): { result: string } {
  return { result: toolFailText(e.tool, next) }
}

/**
 * The generic tool.call hook's catch. A flow tool that did not run (`next` not called) is answered with
 * the retry text; one whose `next` was called replays what it settled to, and a replay that rejects again
 * becomes the retry text too. Any other tool is passed on untouched. A failure before `next` on a flow
 * tool cannot be told apart from one beneath it, so the tool does not run then either.
 */
export function flowCatch<R>(e: { tool: string }, next: FailedCall & ((e: never) => R | PromiseLike<R>)): R | { result: string } | Promise<R | { result: string }> {
  if (!isFlowTool(e.tool)) return Promise.resolve(next(e as never))
  const text = { result: toolFailText(e.tool, next) }
  if (!next.called) return text
  return Promise.resolve(next(e as never)).catch(() => text)
}
