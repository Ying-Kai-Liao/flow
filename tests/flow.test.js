import { expect, mock, test } from 'claude-code/testing';
const PANE = { component: 'Pane', props: { title: 'Flow' }, requestId: 'flow' };
const PR = { state: 'OPEN', isDraft: false, headRefOid: 'abc1234def5678', headRefName: 'flow/csv', title: 'Export orders as CSV' };
test('a handed-over PR starts one merge queue, which works through it', async ($, on) => {
    mock.clock(on, { now: 1_000_000 });
    const agents = [
        { id: 'm1', name: 'csv-export', description: 'csv export', type: 'flow:manager', status: 'running' },
    ];
    const spawned = [];
    on('agent.list', () => ({ value: agents }));
    on('agent.spawn', ($, e) => {
        // The kit hands the spawn on as the Agent tool's input.
        const input = e;
        const type = input.subagent_type ?? input.subagentType ?? '';
        spawned.push(type);
        agents.push({ id: 'q1', name: input.name, description: input.description, type, status: 'running' });
        return { model: 'sonnet', agentId: 'q1' };
    });
    on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(PR), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }));
    on('ui.open', () => ({ value: { isPlaced: true } }));
    on('ui.status', () => ({ value: undefined }));
    on('ui.toast', () => ({ value: undefined }));
    const first = await $.tool.call({ tool: 'mcp__flow__handover', pr: 7, verified: 'npm test', report_to: 'csv-export', agentId: 'm1' });
    expect(String(first.result)).toContain('Started merge queue');
    expect(spawned).toEqual(['flow:queue']);
    // A second handover while the queue runs doesn't start another.
    const second = await $.tool.call({ tool: 'mcp__flow__handover', pr: 8, verified: 'npm test', report_to: 'csv-export', agentId: 'm1' });
    expect(String(second.result)).toContain('running merge queue');
    expect(spawned.length).toBe(1);
    const list = await $.tool.call({ tool: 'mcp__flow__queue', action: 'list', agentId: 'q1' });
    expect(String(list.result)).toContain('#7 pending');
    expect(String(list.result)).toContain('report_to: csv-export');
    await $.tool.call({ tool: 'mcp__flow__queue', action: 'done', pr: 7, sha: 'abc1234', report: 'full check: 12 passed', agentId: 'q1' });
    await $.tool.call({ tool: 'mcp__flow__queue', action: 'back', pr: 8, reason: 'head moved', agentId: 'q1' });
    const after = await $.tool.call({ tool: 'mcp__flow__queue', action: 'list', agentId: 'q1' });
    expect(String(after.result)).toBe('No pending handovers.');
    const status = await $.tool.call({ tool: 'mcp__flow__status' });
    expect(String(status.result)).toContain('#7 done');
    expect(String(status.result)).toContain('returned: head moved');
});
test('a draft PR is refused', async ($, on) => {
    on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify({ ...PR, isDraft: true }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }));
    const r = await $.tool.call({ tool: 'mcp__flow__handover', pr: 9, verified: 'x', report_to: 'm' });
    expect(String(r.result)).toContain('is a draft');
});
test('managers cannot edit code; workers can', async ($, on) => {
    mock.clock(on, { now: 0 });
    on('agent.list', () => ({ value: [
            { id: 'm1', name: 'csv-export', description: 'm', type: 'flow:manager', status: 'running' },
            { id: 'w1', name: 'csv', description: 'w', type: 'flow:worker', status: 'running', parentId: 'm1' },
        ] }));
    on('tool.call', () => ({ result: 'edited' }));
    const byManager = await $.tool.call({ tool: 'Edit', file_path: 'a.ts', old_string: 'a', new_string: 'b', agentId: 'm1' });
    expect(JSON.stringify(byManager)).toContain("managers don't edit code");
    const byWorker = await $.tool.call({ tool: 'Edit', file_path: 'a.ts', old_string: 'a', new_string: 'b', agentId: 'w1' });
    expect(byWorker.result).toBe('edited');
});
test('the pane draws workers under their manager, and the queue', async ($, on) => {
    mock.clock(on, { now: 0 });
    on('agent.list', () => ({ value: [
            { id: 'm1', name: 'csv-export', description: 'm', type: 'flow:manager', status: 'running' },
            { id: 'w1', name: 'csv', description: 'w', type: 'flow:worker', status: 'running', parentId: 'm1' },
        ] }));
    on('agent.spawn', () => ({ model: 'sonnet', agentId: 'w1' }));
    on('ui.open', () => ({ value: { isPlaced: true } }));
    on('ui.status', () => ({ value: undefined }));
    on('ui.toast', () => ({ value: undefined }));
    await $.agent.spawn({ prompt: 'brief', description: 'csv', subagentType: 'flow:worker' });
    for (const surface of ['terminal', 'desktop']) {
        const ui = await $.ui.mount({ plugin: 'flow', surface, ...PANE });
        expect(await ui.find({ text: /manager csv-export/ })).toBeDefined();
        expect(await ui.find({ text: /worker csv/ })).toBeDefined();
        await ui.press({ key: 'm1' });
        expect(await ui.find({ type: 'Text', text: /1 under it/ })).toBeDefined();
        await ui.press({ key: 'back' });
        await ui.unmount();
    }
});
