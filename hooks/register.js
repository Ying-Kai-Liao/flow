import { atom, read, update } from 'claude-code';
import { fill, MANAGER_PROMPT, NO_QUEUE_RULE, QUEUE_PROMPT, QUEUE_RULE, WORKER_PROMPT, } from './prompts';
// The orca-flow pattern inside one Claude Code session. The main session is the super manager
// (the `dispatch` skill); it starts `flow:manager` agents, which start
// `flow:worker` agents in worktrees of their own and hand approved PRs to the
// `flow:queue` agent through this plugin's tools. The pane in main shows the tree.
const PANE = 'flow';
const POLL_MS = 3000;
const LOG_MAX = 40;
const MANAGER = 'flow:manager';
const WORKER = 'flow:worker';
const QUEUE = 'flow:queue';
const ENDED = new Set(['completed', 'failed', 'killed']);
const LIVE = new Set(['pending', 'running', 'waiting']);
// Display order: what may need a person first, finished agents last.
const ORDER = ['waiting', 'idle', 'running', 'pending', 'failed', 'killed', 'completed'];
const GLYPH = {
    pending: '○', running: '●', waiting: '◐', idle: '◌', completed: '✓', failed: '✗', killed: '■',
};
const COLOR = {
    running: 'cyan', waiting: 'yellow', idle: 'yellow', completed: 'green', failed: 'red', killed: 'red',
};
const ROLE = { [MANAGER]: 'manager', [WORKER]: 'worker', [QUEUE]: 'queue' };
const ROOT_GLYPH = '◆';
const HANDOVER_GLYPH = {
    pending: '…', taken: '●', done: '✓', returned: '↩',
};
const roster = atom({ plugin: 'flow', key: 'roster' }, []);
const activity = atom({ plugin: 'flow', key: 'activity' }, {});
const selected = atom({ plugin: 'flow', key: 'selected' }, null);
const now = atom({ plugin: 'flow', key: 'now' }, 0);
const handovers = atom({ plugin: 'flow', key: 'handovers' }, {});
const queueRuns = atom({ plugin: 'flow', key: 'queueRuns' }, 0);
// One line for a tool call: the tool and its most telling argument.
function describeCall(e) {
    const tool = String(e.tool ?? '?').replace(/^mcp__flow__/, '');
    const arg = [e.file_path, e.command, e.pattern, e.path, e.url, e.description, e.action, e.prompt]
        .find(v => typeof v === 'string' && v.length > 0);
    const short = arg === undefined ? '' : ' ' + arg.replace(/\s+/g, ' ').slice(0, 90);
    return tool + short;
}
function ago(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60)
        return `${s}s`;
    const m = Math.round(s / 60);
    return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60}m`;
}
function labelOf(a) {
    return a.name ?? a.description ?? a.id.slice(0, 8);
}
function asksQuestion(answer) {
    const last = (answer ?? '').trim().split('\n').pop() ?? '';
    return /[?？][*_`'")\s]*$/.test(last);
}
function rank(status) {
    const i = ORDER.indexOf(status);
    return i === -1 ? ORDER.length : i;
}
function settingsOf(options, base) {
    const str = (k, d) => (typeof options[k] === 'string' && options[k] !== '' ? String(options[k]) : d);
    const num = (k, d) => (typeof options[k] === 'number' ? Number(options[k]) : d);
    return {
        base: str('base_branch', base),
        testCommand: str('test_command', ''),
        fullCheck: str('full_check_command', ''),
        deployCommand: str('deploy_command', ''),
        mergeMethod: str('merge_method', 'squash'),
        useQueue: options.merge_queue !== false,
        maxWorkers: num('max_workers', 3),
        workerModel: str('worker_model', 'sonnet'),
    };
}
// The roster as the board shows it: every agent of the session, with its role.
async function refresh($) {
    const [list, t, before, acts] = await Promise.all([
        $.agent.list(), $.clock.now(), read($, roster), read($, activity),
    ]);
    const rows = list.map(a => ({
        id: a.id, name: a.name, description: a.description, type: a.type,
        status: a.status, parentId: a.parentId,
    }));
    const was = new Map(before.map(a => [a.id, a.status]));
    for (const a of rows) {
        const prev = was.get(a.id);
        if (prev === undefined || prev === a.status || ENDED.has(prev))
            continue;
        if (ENDED.has(a.status) || a.status === 'idle') {
            const asks = asksQuestion(acts[a.id]?.answer);
            const role = ROLE[a.type] ? `${ROLE[a.type]} ` : '';
            void $.ui.toast(`${role}${labelOf(a)}: ${asks ? 'asks a question' : a.status === 'idle' ? 'finished its turn' : a.status}`);
        }
    }
    if (JSON.stringify(rows) !== JSON.stringify(before))
        await update($, roster, () => rows);
    await update($, now, () => t);
    const hs = Object.values(await read($, handovers));
    const live = rows.filter(a => !ENDED.has(a.status));
    const count = (type) => live.filter(a => a.type === type).length;
    const queued = hs.filter(h => h.status === 'pending' || h.status === 'taken').length;
    const parts = [
        count(MANAGER) && `${count(MANAGER)} managers`,
        count(WORKER) && `${count(WORKER)} workers`,
        queued && `queue: ${queued} PR${queued > 1 ? 's' : ''}`,
    ].filter(Boolean);
    $.ui.status(rows.length === 0 && hs.length === 0 ? undefined
        : `flow: ${parts.length ? parts.join(' · ') : `${live.length} live`} · /flow`);
    return rows;
}
async function openPane($) {
    const r = await $.ui.open({ id: PANE, title: 'Flow' });
    if (!r.isPlaced)
        void $.ui.toast('flow is running agents: type /flow to watch them');
}
// Starts a merge queue unless one is live. The queue drains every pending handover, then ends;
// the next handover, or a queue that ended with work left, starts a fresh one.
async function ensureQueue($) {
    const list = await $.agent.list();
    if (list.some(a => a.type === QUEUE && LIVE.has(a.status))) {
        return 'The running merge queue picks it up at its next list.';
    }
    const pending = Object.values(await read($, handovers)).filter(h => h.status === 'pending');
    if (pending.length === 0)
        return 'Nothing pending.';
    const n = (await read($, queueRuns)) + 1;
    await update($, queueRuns, () => n);
    const started = await $.agent.spawn({
        subagentType: QUEUE,
        name: `merge-queue-${n}`,
        description: 'merge queue',
        prompt: `Pending handovers: ${pending.map(h => `#${h.pr}`).join(', ')}. Start with mcp__flow__queue action "list".`,
    });
    if (started.deny !== undefined)
        return `Could not start a merge queue: ${started.deny}`;
    return `Started merge queue merge-queue-${n}.`;
}
function handoverLine(h) {
    const tail = h.status === 'done' ? ` ${h.sha ?? ''} ${h.report ?? ''}`
        : h.status === 'returned' ? ` returned: ${h.reason ?? ''}` : '';
    return `#${h.pr} ${h.status} (${h.branch} @ ${h.head.slice(0, 8)}, from ${h.reportTo})${tail} — ${h.title}`;
}
export const register = (on, options) => {
    let settings = settingsOf(options, 'main');
    on('session.start', async ($, e, next) => {
        // The base branch: the option, else the remote's default branch, else main.
        // A fresh clone may have no origin/HEAD, so ask the remote when the local ref is missing.
        try {
            const local = await $.process.run(['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
            let base = local.exitCode === 0 ? local.stdout.trim().replace(/^origin\//, '') : '';
            if (base === '') {
                const remote = await $.process.run(['git', 'ls-remote', '--symref', 'origin', 'HEAD'], { timeoutMs: 10_000 });
                base = /ref: refs\/heads\/(\S+)\s+HEAD/.exec(remote.stdout)?.[1] ?? '';
            }
            if (base !== '')
                settings = settingsOf(options, base);
        }
        catch {
            // Not a git repo, or no remote: keep "main".
        }
        await $.command.register({
            name: 'flow',
            description: 'Show the flow in a pane: managers, their workers, the merge queue and handed-over PRs',
        });
        await $.agent.register({
            name: 'manager',
            description: 'A flow manager: owns one task, writes briefs, starts flow:worker agents, reviews their PRs and hands them to the merge queue. ' +
                'Pass the task in the user\'s words as the prompt and a short task slug as the name; run it in the background.',
            prompt: fill(MANAGER_PROMPT.replace('{{QUEUE_RULE}}', settings.useQueue ? QUEUE_RULE : NO_QUEUE_RULE), settings),
            background: true,
        });
        await $.agent.register({
            name: 'worker',
            description: 'A flow worker: implements one brief in a git worktree of its own and opens a PR. ' +
                'Pass the whole brief as the prompt, its first line "Your name: <slug>", and the slug as the name.',
            prompt: fill(WORKER_PROMPT, settings),
            isolation: 'worktree',
            background: true,
        });
        await $.agent.register({
            name: 'queue',
            description: 'The flow merge queue. Started by the plugin when a PR is handed over; never start it yourself.',
            prompt: fill(QUEUE_PROMPT, settings),
            isolation: 'worktree',
            background: true,
        });
        await $.tool.register({
            name: 'handover',
            description: 'Hand an approved PR to the flow merge queue. Records the PR at its current head and starts a queue if none is running. ' +
                'Managers call this after reviewing a worker\'s PR; leave the branch alone afterwards.',
            inputSchema: {
                type: 'object',
                properties: {
                    pr: { type: 'number', description: 'The PR number' },
                    verified: { type: 'string', description: 'What the worker ran, and that the full check was not run' },
                    pending: { type: 'string', description: '"none", or decisions the user still has to make' },
                    after_deploy: { type: 'string', description: '"none", or what to check after deploy' },
                    report_to: { type: 'string', description: 'Your agent name, so the queue reports back to you' },
                },
                required: ['pr', 'verified', 'report_to'],
            },
            isDeferred: false,
        });
        await $.tool.register({
            name: 'queue',
            description: 'The merge queue\'s worklist. action "list": pending and taken handovers in arrival order. ' +
                '"take" (pr), "done" (pr, sha, report) or "back" (pr, reason) record what the queue did. Only the merge queue calls this.',
            inputSchema: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['list', 'take', 'done', 'back'] },
                    pr: { type: 'number' },
                    sha: { type: 'string' },
                    report: { type: 'string' },
                    reason: { type: 'string' },
                },
                required: ['action'],
            },
            isDeferred: false,
        });
        await $.tool.register({
            name: 'status',
            description: 'The flow at a glance: every manager, worker and queue of this session with its status and last report, and every handed-over PR.',
            inputSchema: { type: 'object', properties: {} },
            isDeferred: false,
        });
        $.clock.every(POLL_MS, () => void refresh($));
        return next(e);
    });
    on('command.run', { command: 'flow' }, async ($) => {
        await $.ui.open({ id: PANE, title: 'Flow', focus: true });
        return { text: 'Flow pane opened.' };
    });
    on('agent.spawn', async ($, e, next) => {
        const started = await next(e);
        if (started.agentId !== undefined) {
            const t = await $.clock.now();
            const id = started.agentId;
            await update($, activity, acts => ({
                ...acts, [id]: { startedAt: t, lastAt: t, log: [`started: ${e.description}`] },
            }));
            await refresh($);
            void openPane($);
        }
        return started;
    }).catch(($, e, next) => next(e));
    // Every subagent tool call: refuse code edits from managers (a change goes into a worker's
    // brief), then keep the call as a line of the agent's activity log. The guard judges before
    // `next`, so the catch passes the call on only when the hook failed before it ran.
    on('tool.call', async ($, e, next) => {
        const id = e.agentId;
        if (id !== undefined) {
            if (['Edit', 'Write', 'NotebookEdit', 'MultiEdit'].includes(e.tool)) {
                const me = (await $.agent.list()).find(a => a.id === id);
                if (me?.type === MANAGER) {
                    return { deny: 'flow: managers don\'t edit code. Put the change in a worker\'s brief, or send it to the worker that owns the file.' };
                }
            }
            const t = await $.clock.now();
            const line = describeCall(e);
            await update($, activity, acts => {
                const a = acts[id] ?? { startedAt: t, lastAt: t, log: [] };
                return { ...acts, [id]: { ...a, lastAt: t, log: [...a.log, line].slice(-LOG_MAX) } };
            });
        }
        return next(e);
    }).catch(($, e, next) => next(e));
    on('tool.call', { tool: 'mcp__flow__handover' }, async ($, e) => {
        const input = e;
        const pr = Number(input.pr);
        if (!Number.isInteger(pr) || pr <= 0)
            return { result: 'Refused: pr must be a PR number.' };
        if (!settings.useQueue) {
            return { result: `Refused: this repo has no merge queue (the plugin's merge_queue option is off). Merge it yourself: full check, then gh pr merge ${pr} --${settings.mergeMethod} --delete-branch.` };
        }
        const view = await $.process.run(['gh', 'pr', 'view', String(pr), '--json', 'state,isDraft,headRefOid,headRefName,title']);
        if (view.exitCode !== 0)
            return { result: `Refused: gh pr view ${pr} failed: ${view.stderr.trim().slice(0, 300)}` };
        const info = JSON.parse(view.stdout);
        if (info.state !== 'OPEN')
            return { result: `Refused: PR #${pr} is ${info.state}.` };
        if (info.isDraft)
            return { result: `Refused: PR #${pr} is a draft. Mark it ready (gh pr ready ${pr}) first.` };
        const t = await $.clock.now();
        const h = {
            pr, title: info.title, head: info.headRefOid, branch: info.headRefName,
            reportTo: String(input.report_to ?? 'main'), verified: String(input.verified ?? ''),
            pending: String(input.pending ?? 'none'), afterDeploy: String(input.after_deploy ?? 'none'),
            status: 'pending', at: t,
        };
        await update($, handovers, hs => ({ ...hs, [String(pr)]: h }));
        const queue = await ensureQueue($);
        await refresh($);
        return { result: `Handed over PR #${pr} at ${info.headRefOid.slice(0, 8)}. ${queue} The queue reports back to ${h.reportTo} by message.` };
    });
    on('tool.call', { tool: 'mcp__flow__queue' }, async ($, e) => {
        const input = e;
        const action = String(input.action);
        const all = await read($, handovers);
        if (action === 'list') {
            const open = Object.values(all).filter(h => h.status === 'pending' || h.status === 'taken').sort((a, b) => a.at - b.at);
            if (open.length === 0)
                return { result: 'No pending handovers.' };
            return {
                result: open.map(h => `#${h.pr} ${h.status}: "${h.title}" branch ${h.branch} head ${h.head} | report_to: ${h.reportTo} | verified: ${h.verified} | pending decisions: ${h.pending} | after deploy: ${h.afterDeploy}`).join('\n'),
            };
        }
        const key = String(Number(input.pr));
        const h = all[key];
        if (h === undefined)
            return { result: `No handover for PR #${key}.` };
        const next = action === 'take' ? { ...h, status: 'taken' }
            : action === 'done' ? { ...h, status: 'done', sha: String(input.sha ?? ''), report: String(input.report ?? '') }
                : action === 'back' ? { ...h, status: 'returned', reason: String(input.reason ?? '') }
                    : h;
        if (next === h)
            return { result: `Unknown action "${action}".` };
        await update($, handovers, hs => ({ ...hs, [key]: next }));
        if (action !== 'take')
            void $.ui.toast(`PR #${key} ${next.status === 'done' ? `merged ${next.sha ?? ''}` : `returned: ${next.reason ?? ''}`}`);
        await refresh($);
        return { result: `PR #${key}: ${next.status}.` };
    });
    on('tool.call', { tool: 'mcp__flow__status' }, async ($) => {
        const [rows, acts, hs] = await Promise.all([refresh($), read($, activity), read($, handovers)]);
        const lines = [];
        const byParent = new Map();
        for (const a of rows)
            byParent.set(a.parentId, [...(byParent.get(a.parentId) ?? []), a]);
        const ids = new Set(rows.map(a => a.id));
        const walk = (a, depth) => {
            const answer = (acts[a.id]?.answer ?? '').trim().split('\n').pop() ?? '';
            lines.push(`${'  '.repeat(depth)}- ${ROLE[a.type] ?? a.type} ${labelOf(a)}: ${a.status}${answer ? ` | last: ${answer.slice(0, 160)}` : ''}`);
            for (const c of byParent.get(a.id) ?? [])
                walk(c, depth + 1);
        };
        for (const a of rows.filter(r => r.parentId === undefined || !ids.has(r.parentId)))
            walk(a, 0);
        const list = Object.values(hs).sort((a, b) => a.at - b.at);
        return {
            result: [
                rows.length ? 'Agents:' : 'No agents in this session.', ...lines,
                list.length ? 'Handed-over PRs:' : 'No PRs handed over.', ...list.map(handoverLine),
            ].join('\n'),
        };
    });
    on('turn.complete', async ($, e, next) => {
        const id = e.agentId;
        if (id !== undefined) {
            const t = await $.clock.now();
            await update($, activity, acts => {
                const a = acts[id] ?? { startedAt: t, lastAt: t, log: [] };
                return { ...acts, [id]: { ...a, lastAt: t, answer: e.answer } };
            });
            // A queue that ended while PRs were still pending: start a fresh one for them.
            const me = (await refresh($)).find(a => a.id === id);
            if (me?.type === QUEUE)
                await ensureQueue($);
        }
        return next(e);
    });
    on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
        const { Box, Text, Button } = $.ui.resolve(e);
        const [list, acts, pick, t, hs] = await Promise.all([
            read($, roster), read($, activity), read($, selected), read($, now), read($, handovers),
        ]);
        const rows = e.viewport?.rows ?? 24;
        const agent = list.find(a => a.id === pick);
        if (agent !== undefined) {
            const act = acts[agent.id];
            const answer = (act?.answer ?? '').trim();
            const room = Math.max(3, rows - 12);
            const children = list.filter(a => a.parentId === agent.id).sort((a, b) => rank(a.status) - rank(b.status));
            // The parent chain is the history: Back climbs one level, an orphan or top-level agent goes to the tree.
            const parent = list.find(a => a.id === agent.parentId);
            return (<Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Button key="back" hotkey="b" onPress={() => update($, selected, () => parent?.id ?? null)}>Back</Button>
            <Button key="msg" hotkey="m" onPress={() => $.prompt.fill({
                    text: `Send a message to ${ROLE[agent.type] ?? 'agent'} "${labelOf(agent)}": `, mode: 'replace',
                })}>Message</Button>
          </Box>
          <Text bold color={COLOR[agent.status]}>
            {GLYPH[agent.status] ?? '?'} {labelOf(agent)} <Text dimColor>{ROLE[agent.type] ?? agent.type} · {agent.status}
            {act ? ` · started ${ago(t - act.startedAt)} ago` : ''}{children.length ? ` · ${children.length} under it` : ''}</Text>
          </Text>
          <Text dimColor>{agent.description}</Text>
          {children.length > 0 && <Text bold>Under it</Text>}
          {children.map(c => (<Button key={c.id} dimColor={ENDED.has(c.status)} onPress={() => update($, selected, () => c.id)}>
              <Text color={COLOR[c.status]}>{GLYPH[c.status] ?? '?'}</Text> {ROLE[c.type] ? `${ROLE[c.type]} ` : ''}{labelOf(c)}
              <Text dimColor> {c.status}</Text>
            </Button>))}
          <Text bold>Activity</Text>
          {(act?.log ?? []).length === 0 && <Text dimColor>Nothing seen yet.</Text>}
          {(act?.log ?? []).slice(-room).map(line => <Text wrap="truncate-end">{line}</Text>)}
          {answer !== '' && <Text bold color={asksQuestion(answer) ? 'yellow' : undefined}>
            {asksQuestion(answer) ? 'Asks' : 'Last report'}
          </Text>}
          {answer !== '' && <Text>{answer.length > 1200 ? '…' + answer.slice(-1200) : answer}</Text>}
        </Box>);
        }
        // The tree: each agent under the one that started it, what needs a person first.
        const ids = new Set(list.map(a => a.id));
        const kids = (id) => list
            .filter(a => (id === undefined ? a.parentId === undefined || !ids.has(a.parentId) : a.parentId === id))
            .sort((a, b) => rank(a.status) - rank(b.status));
        const flat = [];
        const walk = (a, depth) => {
            flat.push({ a, depth });
            for (const c of kids(a.id))
                walk(c, depth + 1);
        };
        for (const a of kids(undefined))
            walk(a, 0);
        const prs = Object.values(hs).sort((a, b) => b.at - a.at);
        const live = list.filter(a => !ENDED.has(a.status)).length;
        const room = Math.max(1, rows - 5 - Math.min(prs.length, 5));
        return (<Box flexDirection="column">
        <Text dimColor>{list.length} agents · {live} live{prs.length ? ` · ${prs.length} PRs handed over` : ''} · press one to see it</Text>
        <Text bold>{ROOT_GLYPH} main <Text dimColor>· super manager</Text></Text>
        {list.length === 0 && <Text dimColor>  Nothing running. Ask Claude to start managers or a worker, e.g. "start a manager for X".</Text>}
        {flat.slice(0, room).map(({ a, depth }) => {
                const act = acts[a.id];
                const last = asksQuestion(act?.answer) && !['running', 'pending'].includes(a.status)
                    ? 'asks: ' + (act?.answer ?? '').trim().split('\n').pop()
                    : act?.log[act.log.length - 1] ?? '';
                return (<Box key={`row-${a.id}`} paddingLeft={(depth + 1) * 2}>
              <Button key={a.id} dimColor={ENDED.has(a.status)} onPress={() => update($, selected, () => a.id)}>
                <Text color={COLOR[a.status]}>{GLYPH[a.status] ?? '?'}</Text> {ROLE[a.type] ? `${ROLE[a.type]} ` : ''}{labelOf(a)}
                <Text dimColor> {act ? ago(t - act.lastAt) : ''} {last.slice(0, 70)}</Text>
              </Button>
            </Box>);
            })}
        {prs.length > 0 && <Text bold>  Merge queue</Text>}
        {prs.slice(0, 5).map(h => (<Text key={`pr-${h.pr}`} dimColor={h.status === 'done'} wrap="truncate-end">
            {'    '}{HANDOVER_GLYPH[h.status]} #{h.pr} {h.status}{h.status === 'returned' ? `: ${h.reason ?? ''}` : ''} <Text dimColor>{h.title}</Text>
          </Text>))}
      </Box>);
    });
};
