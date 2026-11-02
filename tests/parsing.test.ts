import { describe, expect, it } from 'vitest';
import { JsonlReader } from '../src/main/providers/jsonl';
import { ClaudeStreamMapper, claudePermissionResponse, describeClaudePermission } from '../src/main/providers/claudeMapper';
import { CodexTurnMapper, codexApprovalResult, codexRateLimitWindows, planCodexServerRequest, readableCodexMessage } from '../src/main/providers/codexMapper';

describe('JsonlReader', () => {
  it('reassembles records split across chunks, including inside multi-byte characters', () => {
    const records: unknown[] = [];
    const reader = new JsonlReader((r) => records.push(r));
    const bytes = Buffer.from(`${JSON.stringify({ a: 'héllo 👋' })}\n${JSON.stringify({ b: 2 })}\r\n`, 'utf8');
    for (let i = 0; i < bytes.length; i += 3) reader.push(bytes.subarray(i, i + 3));
    expect(records).toEqual([{ a: 'héllo 👋' }, { b: 2 }]);
  });

  it('skips malformed lines without losing the rest of the stream', () => {
    const records: unknown[] = [];
    const bad: string[] = [];
    const reader = new JsonlReader((r) => records.push(r), (line) => bad.push(line));
    reader.push('{"ok":1}\n{broken\n\n{"ok":2}\n{"ok":3}');
    expect(records).toEqual([{ ok: 1 }, { ok: 2 }]);
    reader.end(); // trailing record without newline is flushed at exit
    expect(records).toEqual([{ ok: 1 }, { ok: 2 }, { ok: 3 }]);
    expect(bad).toEqual(['{broken']);
  });

  it('drops a runaway line instead of growing without bound', () => {
    const bad: string[] = [];
    const reader = new JsonlReader(() => {}, (l) => bad.push(l), 100);
    reader.push('x'.repeat(150));
    expect(bad.length).toBe(1);
    const records: unknown[] = [];
    const r2 = new JsonlReader((r) => records.push(r), () => {}, 100);
    r2.push('x'.repeat(150));
    r2.push('\n{"after":true}\n');
    expect(records).toEqual([{ after: true }]);
  });
});

describe('ClaudeStreamMapper', () => {
  it('streams deltas and finalizes the same segment from the full assistant message', () => {
    const m = new ClaudeStreamMapper();
    const ev = [
      { type: 'system', subtype: 'init', session_id: 's1', model: 'opus' },
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg1' } } },
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi ' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'there' } } },
      { type: 'assistant', message: { id: 'msg1', content: [{ type: 'text', text: 'Hi there' }] } },
    ].flatMap((r) => m.map(r));
    expect(ev[0]).toEqual({ type: 'session', sessionId: 's1', model: 'opus' });
    expect(ev.filter((e) => e.type === 'text-delta').map((e) => (e as { segmentId: string }).segmentId)).toEqual(['msg1:0', 'msg1:0']);
    expect(ev.at(-1)).toEqual({ type: 'text-final', segmentId: 'msg1:0', text: 'Hi there' });
  });

  it('turns tool use and results into one activity and never surfaces subagent text', () => {
    const m = new ClaudeStreamMapper();
    const start = m.map({ type: 'assistant', message: { id: 'a', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la\necho 2' } }] } });
    expect(start[0]).toMatchObject({ type: 'activity', id: 't1', kind: 'command', title: 'ls -la', status: 'running' });
    const done = m.map({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'file.txt' }] }] } });
    expect(done[0]).toMatchObject({ id: 't1', status: 'done', output: 'file.txt' });
    const denied = m.map({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Permission denied', is_error: true }] } });
    expect(denied[0]).toMatchObject({ status: 'declined' });
    expect(m.map({ type: 'assistant', parent_tool_use_id: 'x', message: { id: 'b', content: [{ type: 'text', text: 'sub' }] } })).toEqual([]);
  });

  it('maps auth errors, rate limits, missing sessions and results', () => {
    const m = new ClaudeStreamMapper();
    const auth = m.map({ type: 'assistant', error: 'authentication_failed', message: { id: 'x', content: [{ type: 'text', text: 'Failed to authenticate' }] } });
    expect(auth.find((e) => e.type === 'error')).toMatchObject({ code: 'authentication_failed', fatal: true });
    const rl = m.map({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', utilization: 1, resetsAt: 2000000000 } });
    expect(rl[0]).toMatchObject({ type: 'rate-limit', limited: true });
    const missing = m.map({ type: 'result', is_error: true, result: 'No conversation found with session ID: abc' });
    expect(missing.map((e) => e.type)).toEqual(['error', 'completed']);
    expect(missing[0]).toMatchObject({ code: 'session-missing' });
    const ok = new ClaudeStreamMapper().map({ type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 5, cache_read_input_tokens: 10, output_tokens: 2 }, total_cost_usd: 1.23 });
    expect(ok[0]).toEqual({ type: 'usage', usage: { inputTokens: 15, cachedInputTokens: 10, outputTokens: 2 } });
    expect(ok[1]).toEqual({ type: 'completed', status: 'completed' });
  });

  it('ignores unknown record types', () => {
    expect(new ClaudeStreamMapper().map({ type: 'something_new', x: 1 })).toEqual([]);
    expect(new ClaudeStreamMapper().map('nope')).toEqual([]);
  });
});

describe('Claude permissions', () => {
  const request = {
    subtype: 'can_use_tool',
    tool_name: 'Edit',
    tool_use_id: 'tu9',
    input: { file_path: 'C:\\w\\a.ts', old_string: 'a', new_string: 'b' },
    decision_reason: '\u001b[1mEdits need approval\u001b[0m',
    permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Edit' }], behavior: 'allow', destination: 'projectSettings' }],
  };

  it('describes the action, target and choices, stripping ANSI codes', () => {
    const spec = describeClaudePermission(request);
    expect(spec.target).toBe('C:\\w\\a.ts');
    expect(spec.reason).toBe('Edits need approval');
    expect(spec.choices.map((c) => c.id)).toEqual(['allow', 'allow-session', 'deny', 'deny-stop']);
    expect(describeClaudePermission({ ...request, suppress_always_allow_rule: true }).choices.map((c) => c.id)).not.toContain('allow-session');
  });

  it('never persists permission rules beyond the session', () => {
    const res = claudePermissionResponse(request, 'allow-session') as { updatedPermissions: Array<{ destination: string }> };
    expect(res.updatedPermissions.every((p) => p.destination === 'session')).toBe(true);
    expect(claudePermissionResponse(request, 'deny-stop')).toMatchObject({ behavior: 'deny', interrupt: true });
    expect(claudePermissionResponse(request, 'unknown-choice')).toMatchObject({ behavior: 'deny' });
  });
});

describe('CodexTurnMapper', () => {
  it('maps streamed agent text, commands, file changes and usage', () => {
    const m = new CodexTurnMapper();
    const ev = [
      ['turn/started', { threadId: 't', turn: { id: 'u1' } }],
      ['item/agentMessage/delta', { threadId: 't', itemId: 'a1', delta: 'He' }],
      ['item/completed', { threadId: 't', item: { type: 'agentMessage', id: 'a1', text: 'Hello' } }],
      ['item/started', { item: { type: 'commandExecution', id: 'c1', command: 'npm test', cwd: '/w', status: 'inProgress', exitCode: null } }],
      ['item/commandExecution/outputDelta', { itemId: 'c1', delta: 'ok\n' }],
      ['item/completed', { item: { type: 'commandExecution', id: 'c1', command: 'npm test', cwd: '/w', status: 'completed', exitCode: 1, aggregatedOutput: 'FAIL' } }],
      ['item/completed', { item: { type: 'fileChange', id: 'f1', status: 'completed', changes: [{ path: 'a.ts', kind: { type: 'update' }, diff: '+x' }] } }],
      ['thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 9, cachedInputTokens: 4, outputTokens: 2 }, modelContextWindow: 100 } }],
      ['item/completed', { item: { type: 'reasoning', id: 'r1', summary: ['secret'], content: [] } }],
    ].flatMap(([method, params]) => m.map(method as string, params as Record<string, unknown>));
    expect(m.turnId).toBe('u1');
    expect(ev[0]).toEqual({ type: 'text-delta', segmentId: 'a1', text: 'He' });
    expect(ev[1]).toEqual({ type: 'text-final', segmentId: 'a1', text: 'Hello' });
    const cmdDone = ev.filter((e) => e.type === 'activity' && e.id === 'c1').at(-1);
    expect(cmdDone).toMatchObject({ status: 'failed', output: 'FAIL' }); // non-zero exit
    expect(ev.find((e) => e.type === 'activity' && e.id === 'f1')).toMatchObject({ kind: 'file', title: 'Edit a.ts' });
    expect(ev.find((e) => e.type === 'usage')).toEqual({ type: 'usage', usage: { inputTokens: 9, cachedInputTokens: 4, outputTokens: 2, contextWindow: 100 } });
    // Reasoning is never surfaced.
    expect(JSON.stringify(ev)).not.toContain('secret');
  });

  it('reports failures with readable messages and rate limits', () => {
    const m = new CodexTurnMapper();
    const ev = m.map('turn/completed', { turn: { id: 'u', status: 'failed', error: { message: '{"type":"error","error":{"message":"Usage limit reached"}}', codexErrorInfo: 'usageLimitExceeded' } } });
    expect(ev.map((e) => e.type)).toEqual(['rate-limit', 'error', 'completed']);
    expect(ev[2]).toMatchObject({ status: 'failed', error: 'Usage limit reached' });
    expect(m.map('error', { willRetry: true, error: { message: 'stream disconnected' } })[0]).toMatchObject({ type: 'activity', kind: 'info' });
    expect(readableCodexMessage('plain')).toBe('plain');
  });

  it('plans approvals and auto-answers requests Nest cannot present', () => {
    const files = new Map([['f1', { changes: [{ path: 'x.ts', diff: '+1' }] }]]);
    const plan = planCodexServerRequest('item/fileChange/requestApproval', { itemId: 'f1', reason: 'write' }, files);
    expect(plan).toMatchObject({ kind: 'approval', action: 'Edit x.ts' });
    expect(planCodexServerRequest('mcpServer/elicitation/request', {}, files)).toMatchObject({ kind: 'auto', result: { action: 'decline' } });
    expect(planCodexServerRequest('attestation/generate', {}, files)).toMatchObject({ kind: 'auto', error: { code: -32601 } });
    expect(codexApprovalResult('item/commandExecution/requestApproval', {}, 'acceptForSession')).toEqual({ decision: 'acceptForSession' });
    expect(codexApprovalResult('item/commandExecution/requestApproval', {}, 'bogus')).toEqual({ decision: 'decline' });
    expect(codexApprovalResult('execCommandApproval', {}, 'decline')).toEqual({ decision: { denied: { rejection: 'The user declined.' } } });
    expect(codexApprovalResult('item/permissions/requestApproval', { permissions: { network: { enabled: true }, fileSystem: null } }, 'grant-turn')).toEqual({ permissions: { network: { enabled: true } }, scope: 'turn' });
  });

  it('summarizes rate-limit windows', () => {
    const r = codexRateLimitWindows({ primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: 10 }, secondary: { usedPercent: 5, windowDurationMins: 10080 }, rateLimitReachedType: null, planType: 'plus' });
    expect(r.windows.map((w) => w.label)).toEqual(['5-hour', 'weekly']);
    expect(r.windows[0].resetsAt).toBe(10000);
    expect(r.limited).toBe(false);
  });
});
