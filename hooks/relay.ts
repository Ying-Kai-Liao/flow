// The disk relay for managers, the reviewer and claude workers that run in a terminal (Orca or tmux) as
// their own claude: that claude has its own copy of this plugin, which forwards every mcp__flow__* call to the
// main session through files in <state dir>/sessions/<name>/relay/, so the pane, inbox, test lock,
// handovers and roster stay in main's state. Main runs the call as that agent and writes the answer.
//
//   client (the plugin copy in the terminal)     server (main, a pump every ~500 ms)
//   call-<id>.json.tmp -> call-<id>.json   --->  rename call-<id>.json -> taken-<id>.json (the claim)
//   waits in ONE shell loop                      runs the call, writes answer-<id>.json.tmp -> .json
//   prints + removes answer-<id>.json      <---  removes taken-<id>.json
//
// This is the pure/IO-injected half. The engine handle `$` is never passed across an import, so
// register.tsx hands in a RelayIo; the same pattern as deliver.ts and session-run.ts.

export type Ran = { exitCode: number; stdout: string; stderr: string }

export type RelayIo = {
  // File names in a directory; [] when it is missing or unreadable.
  list: (dir: string) => Promise<string[]>
  readFile: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<unknown>
  // Atomic move; false when `from` is gone (someone else took it) or the move failed.
  rename: (from: string, to: string) => Promise<boolean>
  remove: (path: string) => Promise<unknown>
  mtime: (path: string) => Promise<number | undefined>
  now: () => Promise<number>
  // One process call. The client's wait is a single long one: the plugin hook clock stops while a
  // `$` call other than `$.clock` is in flight, so the wait can never be built from clock sleeps.
  run: (argv: string[], timeoutMs?: number) => Promise<Ran>
}

// One forwarded tool call.
export type RelayCall = {
  id: string
  tool: string
  input: Record<string, unknown>
  // The agent id the call runs as in main (`session:<name>`) and its name.
  from: string
  role: string
  by: string
  at: number
}

// What main answers: the tool's result or a refusal, the two shapes of a tool.call result.
export type RelayAnswer = { result?: unknown; deny?: string }

export const RELAY_STALE_MS = 15 * 60_000
// The client gives up when main picks the call up within this long (no taken file), or answers within this long.
export const RELAY_PICKUP_S = 30
export const RELAY_ANSWER_S = 600
const POLL_S = 0.2

export const NO_PICKUP = 'flow relay: the main Claude Code session did not pick up the call; is it running?'
export const NO_ANSWER = 'flow relay: main took the call but did not answer in 10 minutes'

// Keys tool.call carries beside a tool's own arguments (the engine strips them before the tool
// runs): they describe the call in the terminal's session and mean nothing in main.
const ENGINE_FIELDS = new Set(['tool', 'tool_use_id', 'consent', 'agentId', 'requestMeta'])

export function stripEngineFields(event: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(event).filter(([k]) => !ENGINE_FIELDS.has(k)))
}

const callFile = (dir: string, id: string): string => `${dir}/call-${id}.json`
const takenFile = (dir: string, id: string): string => `${dir}/taken-${id}.json`
const answerFile = (dir: string, id: string): string => `${dir}/answer-${id}.json`

// Ids are unique per call (clock plus randomness), so a retry after a timeout never reads an old answer.
const newId = (now: number): string => `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`

// Polls every POLL_S: prints and removes the answer; exit 3 when neither the answer nor the claim
// appeared in time, exit 4 when it was claimed but never answered. The answer is checked first, so
// the claim vanishing right after it is written cannot be mistaken for anything.
const WAIT_SCRIPT = `d="$1"; id="$2"; i=0; seen=0
while :; do
  if [ -f "$d/answer-$id.json" ]; then cat "$d/answer-$id.json"; rm -f "$d/answer-$id.json"; exit 0; fi
  [ -e "$d/taken-$id.json" ] && seen=1
  if [ "$seen" = 0 ] && [ "$i" -ge ${Math.round(RELAY_PICKUP_S / POLL_S)} ]; then exit 3; fi
  if [ "$i" -ge ${Math.round(RELAY_ANSWER_S / POLL_S)} ]; then exit 4; fi
  i=$((i+1)); sleep ${POLL_S}
done`

function answerOf(text: string): RelayAnswer {
  try {
    const v = JSON.parse(text) as unknown
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const r = v as Record<string, unknown>
      if (typeof r.deny === 'string') return { deny: r.deny }
      if ('result' in r) return { result: r.result }
    }
  } catch { /* falls through */ }
  return { deny: 'flow relay: unreadable answer from the main session' }
}

// The client: leave the call, wait for its answer. Never throws: a relay that cannot work is a
// result text the model reads. exit 3 and exit 4 are results, not refusals: nothing was decided.
export async function relayCall(io: RelayIo, dir: string, req: { tool: string; input: Record<string, unknown>; from: string; role: string; by: string }): Promise<RelayAnswer> {
  const at = await io.now()
  const id = newId(at)
  const call: RelayCall = { id, ...req, at }
  try {
    // Tmp then rename: the pump never reads a half-written call.
    await io.write(`${callFile(dir, id)}.tmp`, JSON.stringify(call))
    if (!await io.rename(`${callFile(dir, id)}.tmp`, callFile(dir, id))) return { result: 'flow relay: could not write the call file' }
  } catch (err) {
    return { result: `flow relay: could not write the call file (${err instanceof Error ? err.message : String(err)})` }
  }
  let r: Ran
  try {
    r = await io.run(['sh', '-c', WAIT_SCRIPT, 'sh', dir, id], (RELAY_ANSWER_S + 15) * 1000)
  } catch (err) {
    return { result: `flow relay: waiting failed (${err instanceof Error ? err.message : String(err)})` }
  }
  if (r.exitCode === 0) return answerOf(r.stdout)
  // A call nobody took must not run later, long after the model was told it did not.
  await io.remove(callFile(dir, id)).catch(() => undefined)
  return { result: r.exitCode === 3 ? NO_PICKUP : r.exitCode === 4 ? NO_ANSWER : `flow relay: waiting failed (exit ${r.exitCode})` }
}

// A session's relay directory as main knows it; `live` false for an ended or unknown session.
export type RelayDir = { name: string; dir: string; live: boolean }

export type PumpIo = RelayIo & { dirs: () => Promise<RelayDir[]> }

// Runs one call as the agent the call names; the answer is whatever the tool answered.
export type RelayExec = (call: RelayCall, name: string) => Promise<RelayAnswer>

// Calls claimed and not yet answered, by file path: two ticks racing on a call never run it twice
// (the claim rename is the dedupe across processes; this set covers a tick that lists before the rename lands).
const inflight = new Set<string>()

async function writeAnswer(io: RelayIo, dir: string, id: string, answer: RelayAnswer): Promise<void> {
  const file = answerFile(dir, id)
  await io.write(`${file}.tmp`, JSON.stringify(answer))
  await io.rename(`${file}.tmp`, file)
  await io.remove(takenFile(dir, id)).catch(() => undefined)
}

function parseCall(text: string, id: string): RelayCall | undefined {
  try {
    const v = JSON.parse(text) as Record<string, unknown>
    if (typeof v !== 'object' || v === null || Array.isArray(v) || typeof v.tool !== 'string') return undefined
    const input = typeof v.input === 'object' && v.input !== null && !Array.isArray(v.input) ? v.input as Record<string, unknown> : {}
    return {
      id, tool: v.tool, input, from: String(v.from ?? ''), role: String(v.role ?? ''), by: String(v.by ?? ''),
      at: typeof v.at === 'number' ? v.at : 0,
    }
  } catch {
    return undefined
  }
}

async function runClaimed(io: RelayIo, d: RelayDir, id: string, exec: RelayExec): Promise<void> {
  const key = callFile(d.dir, id)
  try {
    let answer: RelayAnswer
    const call = parseCall(await io.readFile(takenFile(d.dir, id)).catch(() => ''), id)
    if (call === undefined) answer = { deny: 'flow relay: the call file is not valid JSON with a tool name' }
    else if (!d.live) answer = { deny: `flow relay: session "${d.name}" is not running here; its flow tools are closed` }
    else {
      try { answer = await exec(call, d.name) } catch (err) {
        answer = { deny: `flow relay: the call failed in the main session (${err instanceof Error ? err.message : String(err)})` }
      }
    }
    await writeAnswer(io, d.dir, id, answer).catch(() => undefined)
  } finally {
    inflight.delete(key)
  }
}

// One tick. Claims the calls it finds, starts them (concurrently; a call may run for minutes, so
// the tick does not wait for them) and removes stale files. Returns the started calls, for tests.
export async function pumpRelay(io: PumpIo, exec: RelayExec): Promise<Promise<void>[]> {
  const started: Promise<void>[] = []
  const t = await io.now()
  for (const d of await io.dirs()) {
    const names = await io.list(d.dir).catch(() => [] as string[])
    for (const n of names) {
      const m = /^call-(.+)\.json$/.exec(n)
      if (m === null) continue
      const id = m[1]!
      const key = callFile(d.dir, id)
      if (inflight.has(key)) continue
      inflight.add(key)
      // The claim: only one renamer wins.
      if (!await io.rename(key, takenFile(d.dir, id)).catch(() => false)) { inflight.delete(key); continue }
      started.push(runClaimed(io, d, id, exec))
    }
    for (const n of names) {
      const m = /^(call|taken|answer)-(.+?)\.json(\.tmp)?$/.exec(n)
      if (m === null || inflight.has(callFile(d.dir, m[2]!))) continue
      const at = await io.mtime(`${d.dir}/${n}`).catch(() => undefined)
      if (at !== undefined && t - at > RELAY_STALE_MS) await io.remove(`${d.dir}/${n}`).catch(() => undefined)
    }
  }
  return started
}

// For tests: a tick that raced a stale in-flight mark must not leak into the next test.
export const resetRelay = (): void => inflight.clear()

// --- Who owns a role session ---------------------------------------------------------------------
// Two main sessions in one repo share <state dir>/sessions.json. Each role session records the main that
// started it (its session id and the pid of its claude process); a main pumps, watches and delivers only
// for the ones it owns. An owner whose pid is gone, or a record with no owner (older data), is taken over
// by the first main that sees it. Taking over needs no lock: the relay claim above is an atomic rename, so
// two mains that both adopt still run a call once; the loser's pump just finds the call already taken.
export type MainIdentity = { session: string; pid: number }

// mine: pump it. adopt: write yourself as the owner, then it is mine (a same-session main whose pid changed,
// e.g. after a resume, takes its own record back this way too). other: a live main owns it, leave it alone.
export function ownerVerdict(owner: Partial<MainIdentity> | undefined, me: MainIdentity, alive: (pid: number) => boolean): 'mine' | 'adopt' | 'other' {
  if (owner === undefined || typeof owner.session !== 'string' || owner.session === '') return 'adopt'
  if (owner.session === me.session) return owner.pid === me.pid ? 'mine' : 'adopt'
  return typeof owner.pid === 'number' && alive(owner.pid) ? 'other' : 'adopt'
}

// --- What a subagent of a terminal manager may call ----------------------------------------------------
// A subagent (Explore and the like) of a terminal manager reaches the relay with the manager's identity, so
// main cannot tell its call from the manager's. It may look but not write.
const SUBAGENT_READS = new Set(['status', 'guard_tests', 'migrations', 'test_slot'])
const SUBAGENT_LIST_ONLY = new Set(['plan', 'check', 'deploy', 'reviewer', 'queue'])

// undefined when the call is allowed; else the refusal text.
export function subagentRefusal(tool: string, input: Record<string, unknown>, manager: string): string | undefined {
  const t = tool.replace(/^mcp__flow__/, '')
  const ok = SUBAGENT_READS.has(t)
    || (SUBAGENT_LIST_ONLY.has(t) && input.action === 'list')
    || (t === 'note' && (input.text === undefined || String(input.text).trim() === ''))
  return ok ? undefined : `flow: a subagent of terminal manager ${manager} cannot call ${t}; report back to your manager and let it make the call.`
}

// --- What a worker session may call ---------------------------------------------------------------------
// A claude worker in a terminal relays the tools the worker rules use and nothing else; main refuses the rest,
// whatever the worker's copy registered.
export const WORKER_TOOLS = ['test_slot', 'guard_tests', 'ask', 'fyi', 'note', 'status'] as const

// undefined when the call is allowed; else the refusal text.
export function workerToolRefusal(tool: string, worker: string): string | undefined {
  const t = tool.replace(/^mcp__flow__/, '')
  return (WORKER_TOOLS as readonly string[]).includes(t) ? undefined : `flow: worker ${worker} cannot call ${t}; that is your manager's or the reviewer's. Put it in your report.`
}
