import type { AgentInfo } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import { absolutePath, parseAttachments, rewriteAttachments } from '../hooks/attachments'

type On = Parameters<TestBody>[1]

const paths = (p: string) => parseAttachments(p).map(a => a.path)

test('a heading section lists bullets and bare lines until the next heading', () => {
  const p = '# Brief\n\n## Attachments\n- /a/one.png\n/a/two.png\n- shots/three.png\n\n## Reference\n- /not/this'
  expect(paths(p)).toEqual(['/a/one.png', '/a/two.png', 'shots/three.png'])
})

test('an Attachments: line form, with the first path inline or on the next lines', () => {
  expect(paths('Task\n\nAttachments:\n- /a/x.png\n- /a/y.log')).toEqual(['/a/x.png', '/a/y.log'])
  expect(paths('Attachments: /a/x.png')).toEqual(['/a/x.png'])
})

test('backticks and quotes are stripped; a path may hold spaces', () => {
  expect(paths('## Attachments\n- `/a/one.png`\n- "/a/my shot.png"\n- \'/a/b.png\'')).toEqual(['/a/one.png', '/a/my shot.png', '/a/b.png'])
})

test('after a blank line only list items continue; plain text ends the section', () => {
  expect(paths('Attachments:\n- /a/1.png\n\n- /a/2.png\n\nThen do the thing.\n- /a/3.png')).toEqual(['/a/1.png', '/a/2.png'])
})

test('none, n/a, a dash or (none) mean no attachments', () => {
  expect(paths('Attachments: none')).toEqual([])
  expect(paths('## Attachments\n- None')).toEqual([])
  expect(paths('## Attachments\n- n/a')).toEqual([])
  expect(paths('## Attachments\n- -')).toEqual([])
  expect(paths('## Attachments\n(none)')).toEqual([])
  expect(paths('## Attachments\n- `none`')).toEqual([])
})

test('no section means no attachments', () => {
  expect(paths('Your name: x\n\nBuild it. See attachments of the PR.')).toEqual([])
})

test('absolutePath expands ~ and resolves relative paths against the cwd', () => {
  expect(absolutePath('~/s.png', '/repo', '/home/u')).toBe('/home/u/s.png')
  expect(absolutePath('shots/a.png', '/repo/', '/home/u')).toBe('/repo/shots/a.png')
  expect(absolutePath('./a.png', '/repo', '/home/u')).toBe('/repo/a.png')
  expect(absolutePath('/x/a.png', '/repo', '/home/u')).toBe('/x/a.png')
})

test('rewriteAttachments keeps bullets, drops quotes and leaves absolute bare paths alone', () => {
  const p = '## Attachments\n- shots/a.png\n- `b.png`\n- /abs/c.png\n\n## Reference'
  const out = rewriteAttachments(p, parseAttachments(p), x => absolutePath(x, '/repo', '/h'))
  expect(out).toBe('## Attachments\n- /repo/shots/a.png\n- /repo/b.png\n- /abs/c.png\n\n## Reference')
  expect(rewriteAttachments(out, parseAttachments(out), x => absolutePath(x, '/repo', '/h'))).toBe(out)
})

// The spawn hook: `present` maps a path to 'file' or 'dir'; anything else does not exist.
function world(on: On, present: Record<string, 'file' | 'dir'>) {
  mock.clock(on, { now: 1 })
  const spawned: string[] = []
  const agents: AgentInfo[] = [{ id: 'm1', name: 'task', description: 't', type: 'flow:manager', status: 'running' }]
  on('agent.list', () => ({ value: agents }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('agent.spawn', (_, e) => { spawned.push(String((e as { prompt: string }).prompt)); return { model: 'sonnet', agentId: 'n1' } })
  on('process.run', (_, e) => {
    const [cmd, flag, path] = e.argv
    const res = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (cmd === 'sh') return res(0, '/home/u')
    if (cmd !== 'test') return res(1)
    const kind = present[path ?? '']
    return res(kind === undefined ? 1 : flag === '-d' ? (kind === 'dir' ? 0 : 1) : flag === '-f' ? (kind === 'file' ? 0 : 1) : 0)
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  return spawned
}

const brief = (list: string) => `Your name: w\n\nGo.\n\n## Attachments\n${list}\n`

test('a worker spawn with a missing attachment is denied, naming the path', async ($, on) => {
  const spawned = world(on, { '/repo/ok.png': 'file' })
  const r = await $.agent.spawn({ prompt: brief('- ok.png\n- /nope/gone.png'), description: 'w', subagentType: 'flow:worker', parentAgentId: 'm1' } as never)
  expect(JSON.stringify(r)).toContain('/nope/gone.png')
  expect(JSON.stringify(r)).not.toContain('ok.png (')
  expect(spawned).toEqual([])
})

test('a directory is denied with a hint to list files', async ($, on) => {
  const spawned = world(on, { '/repo/shots': 'dir' })
  const r = await $.agent.spawn({ prompt: brief('- shots'), description: 'w', subagentType: 'flow:worker', parentAgentId: 'm1' } as never)
  expect(JSON.stringify(r)).toContain('/repo/shots (a directory')
  expect(spawned).toEqual([])
})

test('a relative path is rewritten to absolute; an absolute one passes unchanged', async ($, on) => {
  const spawned = world(on, { '/repo/shots/a.png': 'file', '/abs/b.png': 'file', '/home/u/c.png': 'file' })
  await $.agent.spawn({ prompt: brief('- shots/a.png\n- /abs/b.png\n- ~/c.png'), description: 'w', subagentType: 'flow:worker', parentAgentId: 'm1' } as never)
  expect(spawned).toHaveLength(1)
  expect(spawned[0]).toContain('- /repo/shots/a.png\n- /abs/b.png\n- /home/u/c.png')
})

test('a manager spawn is validated too; other agents and briefs without the section are not', async ($, on) => {
  const spawned = world(on, {})
  const denied = await $.agent.spawn({ prompt: brief('- /nope.png'), description: 'm', subagentType: 'flow:manager' } as never)
  expect(JSON.stringify(denied)).toContain('/nope.png')
  await $.agent.spawn({ prompt: brief('- /nope.png'), description: 'e', subagentType: 'Explore' } as never)
  await $.agent.spawn({ prompt: 'Your name: w\n\nGo.', description: 'w', subagentType: 'flow:worker', parentAgentId: 'm1' } as never)
  expect(spawned).toHaveLength(2)
})
