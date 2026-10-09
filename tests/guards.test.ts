import type { AgentInfo } from 'claude-code'
import { expect, mock } from 'claude-code/testing'
import { test } from './support'
import type { TestBody } from 'claude-code/testing'
import { killRefusal, mainRelative, parseWorktrees, writeTargets } from '../hooks/guards'

type On = Parameters<TestBody>[1]

const ROOT = '/repo'
const WT = '/repo/.claude/worktrees/agent-w1'
const ELSEWHERE = '/work/other-wt'
const PORCELAIN = [
  `worktree ${ROOT}\nHEAD abc\nbranch refs/heads/main`,
  `worktree ${WT}\nHEAD def\nbranch refs/heads/flow/csv`,
  `worktree ${ELSEWHERE}\nHEAD 123\nbranch refs/heads/flow/other`,
].join('\n\n') + '\n'

const AGENTS: AgentInfo[] = [
  { id: 'm1', name: 'csv-export', description: 'm', type: 'flow:manager', status: 'running' },
  { id: 'w1', name: 'csv', description: 'w', type: 'flow:worker', status: 'running', parentId: 'm1' },
]

// The repo at /repo with two linked worktrees; the session runs in the main checkout.
function repo(on: On) {
  mock.clock(on, { now: 0 })
  on('agent.list', () => ({ value: AGENTS }))
  on('session.cwd', () => ({ value: ROOT }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: PORCELAIN, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('tool.call', () => ({ result: 'ran' }))
}

const denied = (r: unknown) => JSON.stringify(r).includes('deny')

// --- Process guard ---

test('pkill and killall are refused in every form', async () => {
  for (const cmd of [
    'pkill node',
    'pkill -f "node --import tsx src/server.ts" -n -u 501',
    'killall -9 node',
    '/usr/bin/pkill -f vite',
    'sudo pkill -f vite',
    'npm test && pkill -f vite',
    'echo $(pkill vite)',
    'bash -c "pkill -f vite"',
    'pgrep -f vite | xargs pkill',
  ]) {
    expect([cmd, killRefusal(cmd)?.slice(0, 30)]).toEqual([cmd, 'flow: pkill and killall are re'])
  }
})

test('kill of -1, 0, 1 and process groups is refused', async () => {
  for (const cmd of ['kill -1', 'kill -9 -1', 'kill 0', 'kill -- -1', 'kill -9 -- -4242', 'kill -TERM -4242', 'kill -s KILL 0', 'kill 1']) {
    expect([cmd, killRefusal(cmd)?.includes('process group')]).toEqual([cmd, true])
  }
  expect(killRefusal('lsof -ti :3000 | xargs kill')).toContain('-sTCP:LISTEN')
})

test('kill of a specific pid and look-ups are allowed', async () => {
  for (const cmd of [
    'kill 4242',
    'kill -9 4242 4243',
    'kill -TERM 4242',
    'kill %1',
    'kill $(lsof -tiTCP:3000 -sTCP:LISTEN)',
    'lsof -i :3000',
    'pgrep -fl vite',
    'grep -n pkill README.md',
    'echo "never pkill"',
    'git commit -m "$(cat <<\'EOF\'\nDon\'t pkill; kill 0 is bad\nEOF\n)"',
  ]) {
    expect([cmd, killRefusal(cmd)]).toEqual([cmd, undefined])
  }
})

test('the hook refuses a broad kill from the main session and from a worker', async ($, on) => {
  repo(on)
  const main = await $.tool.call({ tool: 'Bash', command: 'pkill -f "next dev"' } as never)
  expect(JSON.stringify(main)).toContain('lsof -i :PORT')
  const worker = await $.tool.call({ tool: 'Bash', command: 'kill -9 -1', agentId: 'w1' } as never)
  expect(denied(worker)).toBe(true)
  const ok = await $.tool.call({ tool: 'Bash', command: 'kill 4242', agentId: 'w1' } as never)
  expect(ok.result).toBe('ran')
})

// --- Main-checkout guard: the parse ---

test('shell writes are found and resolved against cwd as cd moves it', async () => {
  const paths = (cmd: string, cwd?: string) => writeTargets(cmd, cwd).map(t => `${t.git ? 'git:' : ''}${t.path}`)
  expect(paths('echo hi > notes.txt', ROOT)).toEqual(['/repo/notes.txt'])
  expect(paths('echo hi >> /repo/a.md')).toEqual(['/repo/a.md'])
  expect(paths('npm test 2>&1 > /dev/null', ROOT)).toEqual([])
  expect(paths('cd /repo/src && sed -i \'\' \'s/a/b/\' app.ts')).toEqual(['/repo/src/app.ts'])
  expect(paths('sed -i.bak -e s/a/b/ x.ts y.ts', ROOT)).toEqual(['/repo/x.ts', '/repo/y.ts'])
  expect(paths('sed -n 1,5p x.ts', ROOT)).toEqual([])
  expect(paths('perl -pi -e "s/a/b/" x.ts', ROOT)).toEqual(['/repo/x.ts'])
  expect(paths('cat x | tee -a log.txt', ROOT)).toEqual(['/repo/log.txt'])
  expect(paths('cp a.ts b.ts && rm c.ts', ROOT)).toEqual(['/repo/b.ts', '/repo/c.ts'])
  expect(paths('git commit -m x', ROOT)).toEqual(['git:/repo'])
  expect(paths(`git -C ${WT} commit -m x`, ROOT)).toEqual([`git:${WT}`])
  expect(paths('git fetch origin && git log --oneline -5 && git stash list', ROOT)).toEqual([])
  // Unknown cwd: relative paths can't be placed, absolute ones still can.
  expect(paths('echo hi > notes.txt && git commit -m x')).toEqual([])
  expect(paths('echo hi > /repo/notes.txt')).toEqual(['/repo/notes.txt'])
  // A heredoc body is data.
  expect(paths('gh pr create --body "$(cat <<\'EOF\'\na > b\nEOF\n)"', ROOT)).toEqual([])
})

test('a path is in the main checkout unless it lies in a worktree or .git/', async () => {
  const co = parseWorktrees(PORCELAIN)!
  expect(co.main).toBe(ROOT)
  expect(mainRelative('/repo/src/app.ts', co)).toBe('src/app.ts')
  expect(mainRelative(`${WT}/src/app.ts`, co)).toBeUndefined()
  expect(mainRelative('/repo/.git/index', co)).toBeUndefined()
  expect(mainRelative(`${ELSEWHERE}/a.ts`, co)).toBeUndefined()
  expect(mainRelative('/repository/a.ts', co)).toBeUndefined()
  expect(mainRelative('/repo/src/../../etc/x', co)).toBeUndefined()
})

// --- Main-checkout guard: the hook ---

test('writes to the main checkout are refused, for the main session and every agent', async ($, on) => {
  repo(on)
  const edit = await $.tool.call({ tool: 'Edit', file_path: '/repo/src/app.ts', old_string: 'a', new_string: 'b', agentId: 'w1' } as never)
  expect(JSON.stringify(edit)).toContain('main checkout')
  const write = await $.tool.call({ tool: 'Write', file_path: '/repo/README.md', content: 'x' } as never)
  expect(denied(write)).toBe(true)
  const notebook = await $.tool.call({ tool: 'NotebookEdit', notebook_path: '/repo/a.ipynb', new_source: 'x' } as never)
  expect(denied(notebook)).toBe(true)
  for (const command of ['echo x > src/app.ts', 'sed -i "" s/a/b/ src/app.ts', 'git commit -am wip', `cd ${ROOT} && git merge flow/csv`]) {
    expect([command, denied(await $.tool.call({ tool: 'Bash', command } as never))]).toEqual([command, true])
  }
  // A worker's absolute write into the main checkout is refused too.
  const byWorker = await $.tool.call({ tool: 'Bash', command: 'echo x >> /repo/src/app.ts', agentId: 'w1' } as never)
  expect(denied(byWorker)).toBe(true)
})

test('worktrees, .git/, reads, fetch and gh stay allowed', async ($, on) => {
  repo(on)
  const allowed = [
    { tool: 'Edit', file_path: `${WT}/src/app.ts`, old_string: 'a', new_string: 'b', agentId: 'w1' },
    { tool: 'Write', file_path: `${ELSEWHERE}/a.ts`, content: 'x' },
    { tool: 'Write', file_path: '/repo/.claude/flow/sources/issues.md', content: 'x' },
    { tool: 'Write', file_path: '/tmp/scratch/notes.md', content: 'x' },
    { tool: 'Read', file_path: '/repo/src/app.ts' },
    { tool: 'Bash', command: 'cat src/app.ts && git status && git fetch origin && git log --oneline -5' },
    { tool: 'Bash', command: 'gh pr list --json number > /tmp/prs.json' },
    { tool: 'Bash', command: 'echo ref > .git/flow-note' },
    { tool: 'Bash', command: `cd ${WT} && echo x > a.ts && git commit -am wip` },
    { tool: 'Bash', command: `git -C ${WT} commit -m x` },
    // A worker's own relative writes land in its worktree.
    { tool: 'Bash', command: 'echo x > a.ts && git commit -am wip', agentId: 'w1' },
  ]
  for (const call of allowed) {
    const r = await $.tool.call(call as never)
    expect([JSON.stringify(call), r.result]).toEqual([JSON.stringify(call), 'ran'])
  }
})

test('a manager\'s shell write runs in the main checkout and is refused', async ($, on) => {
  repo(on)
  const r = await $.tool.call({ tool: 'Bash', command: 'echo x > src/app.ts', agentId: 'm1' } as never)
  expect(denied(r)).toBe(true)
})

test('main_checkout_allow keeps files writable', { options: { main_checkout_allow: 'CHANGELOG.md, docs/' } }, async ($, on) => {
  repo(on)
  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/CHANGELOG.md', content: 'x' } as never)).result).toBe('ran')
  expect((await $.tool.call({ tool: 'Bash', command: 'echo x > docs/a.md' } as never)).result).toBe('ran')
  expect(denied(await $.tool.call({ tool: 'Write', file_path: '/repo/README.md', content: 'x' } as never))).toBe(true)
  // The default .claude/ is replaced, not added to.
  expect(denied(await $.tool.call({ tool: 'Write', file_path: '/repo/.claude/x.md', content: 'x' } as never))).toBe(true)
  // A git command changes the whole checkout, whatever the list holds.
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'cd docs && git commit -am x' } as never))).toBe(true)
})

test('cleanup from the main checkout is not refused: worktree remove, prune, branch -D', async ($, on) => {
  repo(on)
  for (const command of [`git worktree remove ${WT}`, 'git worktree prune', 'git branch -D flow/x', `git worktree unlock ${WT}`]) {
    expect(writeTargets(command, ROOT)).toEqual([])
    expect([command, (await $.tool.call({ tool: 'Bash', command } as never)).result]).toEqual([command, 'ran'])
  }
})

test('main_checkout_guard off lets every write through', { options: { main_checkout_guard: false } }, async ($, on) => {
  repo(on)
  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/README.md', content: 'x' } as never)).result).toBe('ran')
  expect((await $.tool.call({ tool: 'Bash', command: 'git commit -am x' } as never)).result).toBe('ran')
  // The process guard has no switch.
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'killall node' } as never))).toBe(true)
})
