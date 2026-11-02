#!/usr/bin/env node
// A fake ACP agent (Agent Client Protocol over stdio) for offline tests.
// Behaviour is chosen by the prompt text:
//   "tool"   → runs a command after a permission request
//   "hang"   → streams, then waits until session/cancel
//   anything → replies "echo: <prompt>"
// Sessions are remembered in FAKE_ACP_STATE (a JSON file) so session/load works across processes.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const stateFile = process.env.FAKE_ACP_STATE;
const load = () => (stateFile && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { sessions: {} });
const save = (s) => stateFile && writeFileSync(stateFile, JSON.stringify(s));

if (process.argv.includes('--version')) {
  process.stdout.write('fake-acp 1.2.3\n');
  process.exit(0);
}
if (!process.argv.includes('acp')) {
  process.stderr.write('expected the acp subcommand\n');
  process.exit(2);
}

let nextId = 1000;
const waiting = new Map();
let cancelled = null;
const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });

const MODES = { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'autoEdit', name: 'Auto edit' }, { id: 'plan', name: 'Plan' }, { id: 'yolo', name: 'YOLO' }] };
const MODELS = { currentModelId: 'fast-1', availableModels: [{ modelId: 'fast-1', name: 'Fast 1' }, { modelId: 'smart-2', name: 'Smart 2' }] };

async function prompt(id, params) {
  const { sessionId } = params;
  const text = params.prompt.find((b) => b.type === 'text')?.text ?? '';
  const state = load();
  const session = state.sessions[sessionId];
  session.prompts.push(text);
  save(state);
  if (/\bhang\b/.test(text)) {
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } });
    await new Promise((resolve) => (cancelled = resolve));
    send({ id, result: { stopReason: 'cancelled' } });
    return;
  }
  if (/\btool\b/.test(text)) {
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Running it.' } });
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't1', title: '`echo hi`', kind: 'execute', status: 'pending', rawInput: { command: 'echo hi' } });
    const res = await ask('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: 't1', title: '`echo hi`', kind: 'execute', status: 'pending', rawInput: { command: 'echo hi' } },
      options: [
        { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'always', name: 'Allow always', kind: 'allow_always' },
        { optionId: 'no', name: 'Reject', kind: 'reject_once' },
      ],
    });
    const allowed = res.outcome?.outcome === 'selected' && res.outcome.optionId === 'yes';
    update(sessionId, allowed
      ? { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', rawOutput: { exitCode: 0, stdout: 'hi\n', stderr: '' } }
      : { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed' });
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: allowed ? 'Output: hi' : 'Not allowed.' } });
    send({ id, result: { stopReason: 'end_turn' } });
    return;
  }
  update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } });
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'echo: ' } });
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${text.split('\n').pop()} [mode=${session.mode} model=${session.model}]` } });
  send({ id, result: { stopReason: 'end_turn', usage: { inputTokens: 12, outputTokens: 5 } } });
}

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (line) void handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => process.exit(0));

async function handle(m) {
  if (m.id !== undefined && !m.method) {
    waiting.get(m.id)?.(m.result ?? {});
    waiting.delete(m.id);
    return;
  }
  const state = load();
  switch (m.method) {
    case 'initialize':
      send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: false } }, authMethods: [{ id: 'fake_login', name: 'Fake' }] } });
      break;
    case 'authenticate':
      if (process.env.FAKE_ACP_SIGNED_OUT) send({ id: m.id, error: { code: -32000, message: 'Authentication required' } });
      else send({ id: m.id, result: {} });
      break;
    case 'session/new': {
      const sessionId = `s-${Object.keys(state.sessions).length + 1}`;
      state.sessions[sessionId] = { cwd: m.params.cwd, mcp: m.params.mcpServers.map((s) => s.name), prompts: [], mode: 'default', model: 'fast-1' };
      save(state);
      send({ id: m.id, result: { sessionId, modes: MODES, models: MODELS } });
      break;
    }
    case 'session/load': {
      const s = state.sessions[m.params.sessionId];
      if (!s) {
        send({ id: m.id, error: { code: -32002, message: 'Session not found' } });
        break;
      }
      for (const p of s.prompts) update(m.params.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: p } }), update(m.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAYED' } });
      send({ id: m.id, result: { modes: { ...MODES, currentModeId: s.mode }, models: { ...MODELS, currentModelId: s.model } } });
      break;
    }
    case 'session/set_mode':
      state.sessions[m.params.sessionId].mode = m.params.modeId;
      save(state);
      send({ id: m.id, result: {} });
      break;
    case 'session/set_model':
      state.sessions[m.params.sessionId].model = m.params.modelId;
      save(state);
      send({ id: m.id, result: {} });
      break;
    case 'session/prompt':
      void prompt(m.id, m.params);
      break;
    case 'session/cancel':
      cancelled?.();
      break;
    default:
      if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: `unknown ${m.method}` } });
  }
}
