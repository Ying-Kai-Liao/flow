// The two guards the plugin's tool.call hook runs for every agent of the flow, the main
// session included: broad process kills, and writes to the repo's main checkout. Both were
// rules in the prompts first; a rule the model reads can be skipped, a hook can't.
//
// The shell parse follows orca-flow's process_guard.py: small and conservative. It looks at
// words in command position (after `;`, `&&`, `||`, `|`, newlines, inside `$(…)`/backticks,
// behind sudo/xargs/env and friends, and in `sh -c` / `eval` strings). A missed case is better
// than refusing `grep pkill file` or `echo "kill 0"`.

type Cmd = {
  // Quotes removed; a command substitution is left as a placeholder.
  words: string[]
  // Source of each $(…) / `…` / <(…) inside this command.
  subs: string[]
  // Targets of output redirections (`> f`, `>> f`, `&> f`, `2> f`).
  outputs: string[]
}

const KEYWORDS = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time', 'coproc'])
// Commands that run their arguments as a command; options are skipped up to the real command.
const WRAPPERS = new Set(['sudo', 'doas', 'nohup', 'exec', 'command', 'builtin', 'nice', 'caffeinate',
  'timeout', 'gtimeout', 'env', 'xargs', 'stdbuf'])
// Wrapper options that take a separate value, so the value isn't mistaken for the command.
const OPTS_WITH_VALUE: Record<string, Set<string>> = {
  sudo: new Set(['-u', '-g', '-p', '-C', '-h', '-U', '-r', '-t', '-D']),
  doas: new Set(['-u', '-C']),
  nice: new Set(['-n']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  gtimeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  env: new Set(['-u', '-C', '-S', '--unset', '--chdir']),
  xargs: new Set(['-I', '-J', '-L', '-n', '-P', '-s', '-E', '-R', '-S', '-d', '-a', '--delimiter',
    '--arg-file', '--max-args', '--max-procs', '--replace']),
  stdbuf: new Set(['-i', '-o', '-e']),
}
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const MAX_DEPTH = 5

const basename = (w: string) => w.split('/').pop() ?? w

// A heredoc operator at s[i] ('<<' or '<<-' plus its delimiter word).
function heredocStart(s: string, i: number): { delim: string; stripTabs: boolean; end: number } {
  i += 2
  const stripTabs = s.startsWith('-', i)
  if (stripTabs) i += 1
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i += 1
  const m = /^(['"]?)([^\s;&|<>()'"]*)\1/.exec(s.slice(i))!
  return { delim: m[2]!, stripTabs, end: i + m[0].length }
}

// From the start of the line after a heredoc operator, skips each body through its delimiter.
function skipHeredocBodies(s: string, i: number, heredocs: { delim: string; stripTabs: boolean }[]): number {
  const n = s.length
  for (const { delim, stripTabs } of heredocs) {
    while (i < n) {
      const j = s.indexOf('\n', i)
      const line = j < 0 ? s.slice(i) : s.slice(i, j)
      i = j < 0 ? n : j + 1
      if ((stripTabs ? line.replace(/^\t+/, '') : line) === delim) break
    }
  }
  return i
}

// Index of the ')' closing a '(' just before i; s.length when unbalanced.
function matchParen(s: string, i: number): number {
  let depth = 1
  const n = s.length
  let heredocs: { delim: string; stripTabs: boolean }[] = []
  while (i < n) {
    const c = s[i]!
    if (c === '\\') { i += 2; continue }
    // Heredoc bodies are prose (commit messages): an apostrophe in "don't" is not a quote.
    if (s.startsWith('<<', i) && !s.startsWith('<<<', i)) {
      const h = heredocStart(s, i)
      heredocs.push(h)
      i = h.end
      continue
    }
    if (c === '\n' && heredocs.length > 0) {
      i = skipHeredocBodies(s, i + 1, heredocs)
      heredocs = []
      continue
    }
    if (c === "'" || c === '"') {
      const j = s.indexOf(c, i + 1)
      i = j < 0 ? n : j + 1
      continue
    }
    if (c === '(') depth += 1
    else if (c === ')') {
      depth -= 1
      if (depth === 0) return i
    }
    i += 1
  }
  return n
}

// Splits a shell command line into pipelines of simple commands.
export function parse(s: string): Cmd[][] {
  const pipelines: Cmd[][] = []
  let pipe: Cmd[] = []
  let words: string[] = []
  let subs: string[] = []
  let outputs: string[] = []
  // null: no word in progress (so '' from "" still counts as a word).
  let word: string | null = null
  // The next word is a redirection target: an output's is kept, an input's dropped.
  let target: 'out' | 'in' | null = null
  let heredocs: { delim: string; stripTabs: boolean }[] = []
  let i = 0
  const n = s.length

  const endWord = () => {
    if (word !== null) {
      if (target === 'out') outputs.push(word)
      else if (target === null) words.push(word)
      target = null
    }
    word = null
  }
  const endCmd = () => {
    endWord()
    if (words.length || subs.length || outputs.length) pipe.push({ words, subs, outputs })
    words = []
    subs = []
    outputs = []
  }
  const endPipe = () => {
    endCmd()
    if (pipe.length) pipelines.push(pipe)
    pipe = []
  }

  while (i < n) {
    const c = s[i]!
    if (c === ' ' || c === '\t') {
      endWord()
      i += 1
    } else if (c === '\n') {
      endPipe()
      // Heredoc bodies are data, not commands: `cat <<EOF` … `pkill` … `EOF` is fine.
      i = skipHeredocBodies(s, i + 1, heredocs)
      heredocs = []
    } else if (c === '#' && word === null) {
      const j = s.indexOf('\n', i)
      i = j < 0 ? n : j
    } else if (c === "'") {
      let j = s.indexOf("'", i + 1)
      if (j < 0) j = n
      word = (word ?? '') + s.slice(i + 1, j)
      i = j + 1
    } else if (c === '"') {
      const buf: string[] = []
      i += 1
      while (i < n && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < n) {
          buf.push(s[i + 1]!)
          i += 2
        } else if (s.startsWith('$(', i)) {
          const j = matchParen(s, i + 2)
          if (!s.startsWith('$((', i)) subs.push(s.slice(i + 2, j))
          buf.push('$(…)')
          i = j + 1
        } else if (s[i] === '`') {
          let j = s.indexOf('`', i + 1)
          if (j < 0) j = n
          subs.push(s.slice(i + 1, j))
          buf.push('`…`')
          i = j + 1
        } else {
          buf.push(s[i]!)
          i += 1
        }
      }
      word = (word ?? '') + buf.join('')
      i += 1
    } else if (c === '\\') {
      // Backslash-newline is a line continuation.
      if (s[i + 1] !== '\n') word = (word ?? '') + (s[i + 1] ?? '')
      i += 2
    } else if (s.startsWith('$(', i)) {
      const j = matchParen(s, i + 2)
      // $((…)) is arithmetic, not a command.
      if (!s.startsWith('$((', i)) subs.push(s.slice(i + 2, j))
      word = (word ?? '') + '$(…)'
      i = j + 1
    } else if (s.startsWith('<(', i) || s.startsWith('>(', i)) {
      endWord()
      const j = matchParen(s, i + 2)
      subs.push(s.slice(i + 2, j))
      i = j + 1
    } else if (c === '`') {
      let j = s.indexOf('`', i + 1)
      if (j < 0) j = n
      subs.push(s.slice(i + 1, j))
      word = (word ?? '') + '`…`'
      i = j + 1
    } else if (s.startsWith('<<', i) && !s.startsWith('<<<', i)) {
      endWord()
      const h = heredocStart(s, i)
      heredocs.push(h)
      i = h.end
    } else if (c === '<' || c === '>') {
      // A redirection: drop the fd number before it, keep an output's target.
      if (word !== null && /^\d+$/.test(word)) word = null
      endWord()
      const m = /^[<>]+\|?(&(\d+|-)?)?/.exec(s.slice(i))!
      i += m[0].length
      // 2>&1 and >&- carry their target in the operator.
      if (!m[2]) target = m[0].includes('>') ? 'out' : 'in'
    } else if (c === '|') {
      if (s.startsWith('||', i)) {
        endPipe()
        i += 2
      } else {
        endCmd()
        i += s.startsWith('|&', i) ? 2 : 1
      }
    } else if (c === '&') {
      if (s.startsWith('&>', i)) {
        endWord()
        i += s.startsWith('&>>', i) ? 3 : 2
        target = 'out'
      } else {
        endPipe()
        i += s.startsWith('&&', i) ? 2 : 1
      }
    } else if (c === ';' || c === '(' || c === ')') {
      endPipe()
      i += 1
    } else {
      word = (word ?? '') + c
      i += 1
    }
  }
  endPipe()
  return pipelines
}

// The command words from the real command on, and whether it runs under xargs.
function resolve(words: string[]): { words: string[]; viaXargs: boolean } {
  let i = 0
  let viaXargs = false
  while (i < words.length) {
    const w = words[i]!
    if (KEYWORDS.has(w) || ASSIGNMENT.test(w)) { i += 1; continue }
    const name = basename(w)
    if (!WRAPPERS.has(name)) return { words: words.slice(i), viaXargs }
    viaXargs ||= name === 'xargs'
    const takesValue = OPTS_WITH_VALUE[name] ?? new Set<string>()
    i += 1
    while (i < words.length) {
      const o = words[i]!
      if (o === '--') { i += 1; break }
      if (name === 'env' && ASSIGNMENT.test(o)) i += 1
      else if (o.startsWith('-') && o.length > 1) i += takesValue.has(o) ? 2 : 1
      else if ((name === 'timeout' || name === 'gtimeout') && /^\d/.test(o)) { i += 1; break }
      else break
    }
  }
  return { words: [], viaXargs }
}

// The script a shell runs with -c, or eval's arguments.
function innerScript(name: string, args: string[]): string | undefined {
  if (name === 'eval') return args.join(' ')
  if (!SHELLS.has(name)) return undefined
  const k = args.findIndex(a => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a))
  return k >= 0 ? args[k + 1] : undefined
}

// --- Process guard -------------------------------------------------------------------------

const FIND_PID = 'Find the pid of the one process you started (`lsof -i :PORT`, `pgrep -fl <pattern>`) and `kill <pid>`.'

export const PKILL_REFUSAL = 'flow: pkill and killall are refused. Every flow agent runs in this one Claude Code session, ' +
  'and a kill by name or pattern reaches other agents\' processes and the session itself; on macOS pkill also reads ' +
  'options after the pattern as more patterns (`pkill -f X -n -u 501` once matched every session). ' +
  'Don\'t swap in `kill $(pgrep -f …)` either: same matching. ' + FIND_PID

export const PID_REFUSAL = 'flow: this kill is refused. Pid -1 signals every process you own (this session included), ' +
  '0 or a negative pid signals a whole process group, and 1 is launchd. ' + FIND_PID

export const LSOF_REFUSAL = 'flow: this kill is refused. lsof without -sTCP:LISTEN lists a port\'s clients as well as ' +
  'its server, so it can hit processes that aren\'t yours. Ask for the listening server only: ' +
  '`kill $(lsof -tiTCP:<port> -sTCP:LISTEN)`, or ' + FIND_PID.charAt(0).toLowerCase() + FIND_PID.slice(1)

function lsofWithoutListen(cmd: Cmd): boolean {
  const { words } = resolve(cmd.words)
  if (words.length === 0 || basename(words[0]!) !== 'lsof') return false
  // -sTCP:LISTEN, or -s TCP:LISTEN as two words.
  return !words.slice(1).some(w => w.toUpperCase().includes('TCP:LISTEN'))
}

// The pids a `kill` call signals; the signal spec and options are skipped.
function killTargets(args: string[]): string[] {
  if (args[0] === '-l' || args[0] === '-L') return []
  const pids: string[] = []
  let i = 0
  while (i < args.length) {
    const a = args[i]!
    if (a === '--') return [...pids, ...args.slice(i + 1)]
    if (i === 0 && (a === '-s' || a === '-n')) { i += 2; continue }
    // -9, -KILL, -SIGTERM: the signal; anything after it is a pid, -1 included.
    if (i === 0 && a.startsWith('-') && a.length > 1) { i += 1; continue }
    pids.push(a)
    i += 1
  }
  return pids
}

// Why a command line is refused as a broad process kill, or undefined.
export function killRefusal(command: string, depth = 0): string | undefined {
  if (depth > MAX_DEPTH) return undefined
  for (const pipeline of parse(command)) {
    for (const [idx, cmd] of pipeline.entries()) {
      for (const sub of cmd.subs) {
        const why = killRefusal(sub, depth + 1)
        if (why !== undefined) return why
      }
      const { words, viaXargs } = resolve(cmd.words)
      if (words.length === 0) continue
      const name = basename(words[0]!)
      const args = words.slice(1)
      if (name === 'pkill' || name === 'killall') return PKILL_REFUSAL
      const script = innerScript(name, args)
      if (script !== undefined) {
        const why = killRefusal(script, depth + 1)
        if (why !== undefined) return why
      }
      if (name !== 'kill') continue
      // A bare `kill -1` is HUP to no pid on some shells and every process on others: refuse it too.
      if (args.length === 1 && args[0] === '-1') return PID_REFUSAL
      if (killTargets(args).some(p => p === '0' || p === '1' || /^-\d+$/.test(p))) return PID_REFUSAL
      const fedBy = cmd.subs.flatMap(sub => parse(sub).flat())
      if (viaXargs) fedBy.push(...pipeline.slice(0, idx))
      if (fedBy.some(lsofWithoutListen)) return LSOF_REFUSAL
    }
  }
  return undefined
}

// --- Main-checkout guard -------------------------------------------------------------------

// A path a command writes: a file, or for git a directory whose checkout it changes.
export type WriteTarget = { path: string; git?: true }

// git subcommands that change the working tree or the checked-out branch. `pull` stays
// allowed: fast-forwarding the main checkout to its base is how it stays current. The plugin
// does that itself after a reviewer batch (hooks/mainff.ts), outside these guards.
const GIT_WRITES = new Set(['commit', 'merge', 'rebase', 'cherry-pick', 'revert', 'am', 'apply',
  'reset', 'restore', 'checkout', 'switch', 'stash'])
const GIT_STASH_READS = new Set(['list', 'show'])

export function normalize(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

// An absolute path for a word, or undefined when the shell would expand it or the base is unknown.
export function resolvePath(word: string, cwd: string | undefined): string | undefined {
  if (word === '' || /[$`…*?~]/.test(word)) return undefined
  if (word.startsWith('/')) return normalize(word)
  return cwd === undefined ? undefined : normalize(`${cwd}/${word}`)
}

const options = (args: string[]) => args.filter(a => a.startsWith('-') && a !== '-')
const operands = (args: string[]) => args.filter(a => !a.startsWith('-') || a === '-')

// The files a sed or perl call edits in place; none when it doesn't edit in place.
function inPlaceTargets(args: string[]): string[] {
  const inPlace = args.some(a => a === '--in-place' || a.startsWith('--in-place=') || /^-[a-zA-Z]*i/.test(a))
  if (!inPlace) return []
  const files: string[] = []
  let script = false
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!
    // An -e/-f option takes the next word as the script (perl's -pe too).
    if (/^-[a-zA-Z]*[ef]$/.test(a)) { k += 1; script = true; continue }
    if (a.startsWith('-')) continue
    // macOS `sed -i '' …`: the empty backup suffix.
    if (a === '') continue
    files.push(a)
  }
  return script ? files : files.slice(1)
}

// The paths a command line writes, resolved against cwd as `cd` moves it; relative paths are
// dropped when cwd is unknown.
export function writeTargets(command: string, cwd: string | undefined, depth = 0): WriteTarget[] {
  if (depth > MAX_DEPTH) return []
  const found: WriteTarget[] = []
  const add = (word: string, base: string | undefined, git?: true) => {
    const path = resolvePath(word, base)
    if (path !== undefined && !path.startsWith('/dev/')) found.push(git ? { path, git } : { path })
  }
  for (const pipeline of parse(command)) {
    for (const cmd of pipeline) {
      for (const sub of cmd.subs) found.push(...writeTargets(sub, cwd, depth + 1))
      for (const out of cmd.outputs) add(out, cwd)
      const { words } = resolve(cmd.words)
      if (words.length === 0) continue
      const name = basename(words[0]!)
      const args = words.slice(1)
      const script = innerScript(name, args)
      if (script !== undefined) found.push(...writeTargets(script, cwd, depth + 1))
      switch (name) {
        case 'cd': {
          const to = args.find(a => a !== '-P' && a !== '-L')
          cwd = to === undefined || to === '-' ? undefined : resolvePath(to, cwd)
          break
        }
        case 'tee': case 'rm': case 'touch':
          for (const a of operands(args)) add(a, cwd)
          break
        case 'cp': case 'mv': case 'install': {
          const ops = operands(args)
          if (ops.length >= 2 && !options(args).some(o => o === '-t' || o.startsWith('--target-directory'))) add(ops.at(-1)!, cwd)
          break
        }
        case 'sed': case 'gsed': case 'perl':
          for (const f of inPlaceTargets(args)) add(f, cwd)
          break
        case 'git': {
          let dir = cwd
          let k = 0
          while (k < args.length && args[k]!.startsWith('-')) {
            const o = args[k]!
            if (o === '-C') { dir = args[k + 1] === undefined ? undefined : resolvePath(args[k + 1]!, dir); k += 2 }
            else if (o === '-c' || o === '--git-dir' || o === '--work-tree') { k += 2 }
            else k += 1
          }
          const sub = args[k]
          if (sub === undefined || !GIT_WRITES.has(sub)) break
          if (sub === 'stash' && GIT_STASH_READS.has(args[k + 1] ?? '')) break
          if (dir !== undefined) found.push({ path: dir, git: true })
          break
        }
      }
    }
  }
  return found
}

// The repo's checkouts as `git worktree list --porcelain` gives them: the main one first.
export type Checkouts = { main: string; worktrees: string[] }

export function parseWorktrees(porcelain: string): Checkouts | undefined {
  const paths = porcelain.split('\n\n')
    .filter(block => !/^bare$/m.test(block))
    .map(block => /^worktree (.+)$/m.exec(block)?.[1])
    .filter((p): p is string => p !== undefined)
    .map(normalize)
  if (paths.length === 0) return undefined
  return { main: paths[0]!, worktrees: paths.slice(1) }
}

const under = (path: string, dir: string) => path === dir || path.startsWith(dir === '/' ? '/' : `${dir}/`)

// The path relative to the main checkout when it lies there; undefined in a linked worktree,
// in .git/, or outside the repo.
export function mainRelative(path: string, co: Checkouts): string | undefined {
  const p = normalize(path)
  if (!under(p, co.main) || under(p, `${co.main}/.git`)) return undefined
  if (co.worktrees.some(w => w !== co.main && under(p, w))) return undefined
  return p === co.main ? '' : p.slice(co.main.length + 1)
}

// `main_checkout_allow` as a list: comma or newline separated, each a file or, ending in `/`,
// a directory, relative to the main checkout.
export function allowList(setting: string): string[] {
  return setting.split(/[,\n]/).map(s => s.trim().replace(/^\.\//, '')).filter(s => s !== '')
}

export function allowed(rel: string, allow: string[]): boolean {
  return allow.some(a => a.endsWith('/') ? rel.startsWith(a) : rel === a || rel.startsWith(`${a}/`))
}

export function mainCheckoutRefusal(main: string, what: string, allow: string[]): string {
  return `flow: ${what} is in ${main}, the repo's main checkout, and nothing in the flow changes it. ` +
    'Build the change in a worktree: put it in a flow:worker\'s brief, or send it to the worker whose worktree owns the file. ' +
    `Still writable there: ${allow.length ? allow.join(', ') : 'nothing'}. ` +
    'Don\'t route around this through another tool or a shell command. If the user wants the main checkout changed, ' +
    'tell them; the main_checkout_guard and main_checkout_allow settings are theirs to change.'
}
