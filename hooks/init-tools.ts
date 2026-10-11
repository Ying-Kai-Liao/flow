// MCP tool specs for /flow init (like tools.ts: pure data, the register calls stay in register.tsx).
import type { ToolSpec } from 'claude-code'

export const SETTINGS_TOOL: ToolSpec = {
  name: 'settings',
  description: 'Main only. flow settings, for /flow init. action "show": what init detected (base branch, remote, gh, test and check command candidates from the repo) and the Core settings in each layer (/config, the repo file, the personal file). ' +
    'action "write": layer "repo" (.claude/flow.json, committed, shared) or "personal" (uncommitted), values {key: value}; merges into the file, null removes a key. ' +
    'Plain settings only (strings, numbers, booleans, lists); keys and secrets are refused, they never go in settings. A file that is not valid JSON is never overwritten.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['show', 'write'] },
      layer: { type: 'string', enum: ['repo', 'personal'], description: 'write: which file' },
      values: { type: 'object', description: 'write: setting names to values; null removes a key', additionalProperties: true },
    },
    required: ['action'],
  },
  isDeferred: true,
}

export const DEMO_TOOL: ToolSpec = {
  name: 'demo',
  description: 'Main only. The /flow init demo. action "start": the free replay in the Flow pane (canned agents, no model calls, nothing written); "stop" ends it. ' +
    '"cleanup": after a real demo, removes its worktree and branch (only flow/flow-demo* names; refused while a demo agent is running). "status": whether the replay runs and which demo agents exist.',
  inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['start', 'stop', 'cleanup', 'status'] } }, required: ['action'] },
  isDeferred: true,
}
