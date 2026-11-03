// Stand-in for `codex app-server` (JSON-RPC over JSONL), used by offline tests.
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('codex-cli 9.9.9');
  process.exit(0);
}

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
let buf = '';
let threadSeq = 0;
let serverReqId = 100;
const waiting = new Map();
const activeTurns = new Map();
/** [steerable] turns waiting for turn/steer, by turn id. */
const steerable = new Map();

function notify(method, params) {
  out({ method, params });
}

const threadPerms = new Map();

async function runTurn(threadId, turnId, text) {
  if (text.includes('[perms]')) {
    notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress', items: [] } });
    notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: 'p1', text: `perms:${threadPerms.get(threadId)}` } });
    notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', items: [] } });
    return;
  }
  if (text.includes('[config]')) {
    // Report the per-thread config Nest sent, so tests can check connector overrides.
    const reply = JSON.stringify(threadConfigs.get(threadId) ?? null);
    notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: 'a1', text: reply } });
    notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', items: [] } });
    return;
  }
  notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress', items: [] } });
  if (text.includes('[approval]')) {
    notify('item/started', { threadId, turnId, item: { type: 'commandExecution', id: 'cmd1', command: 'touch x', cwd: '/w', status: 'inProgress', exitCode: null, aggregatedOutput: null } });
    const id = serverReqId++;
    out({ id, method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'cmd1', command: 'touch x', cwd: '/w', reason: 'needs write' } });
    const decision = await new Promise((r) => waiting.set(id, r));
    notify('serverRequest/resolved', { threadId, requestId: id });
    const ok = decision.decision === 'accept';
    notify('item/completed', { threadId, turnId, item: { type: 'commandExecution', id: 'cmd1', command: 'touch x', cwd: '/w', status: ok ? 'completed' : 'declined', exitCode: ok ? 0 : null, aggregatedOutput: ok ? '' : null } });
    notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: 'a1', text: `decision:${decision.decision}` } });
    notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', items: [] } });
    return;
  }
  if (text.includes('[narrate]')) {
    notify('item/agentMessage/delta', { threadId, turnId, itemId: 'n1', delta: 'Let me check.' });
    notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: 'n1', text: 'Let me check.' } });
    notify('item/started', { threadId, turnId, item: { type: 'commandExecution', id: 'cmd-n', command: 'ls', cwd: '/w', status: 'inProgress', exitCode: null, aggregatedOutput: null } });
    notify('item/completed', { threadId, turnId, item: { type: 'commandExecution', id: 'cmd-n', command: 'ls', cwd: '/w', status: 'completed', exitCode: 0, aggregatedOutput: 'a.txt' } });
    if (!text.includes('[ends-on-step]')) notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: 'n2', text: 'Found a.txt.' } });
    notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', items: [] } });
    return;
  }
  if (text.includes('[steerable]')) {
    notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: 'a1', text: 'working on it' } });
    const steer = await new Promise((r) => steerable.set(turnId, r));
    notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: 'a2', text: `steered:${steer}` } });
    notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', items: [] } });
    return;
  }
  if (text.includes('[slow]')) {
    notify('item/agentMessage/delta', { threadId, turnId, itemId: 'a1', delta: 'working' });
    activeTurns.set(turnId, threadId);
    return; // completes on turn/interrupt
  }
  if (text.includes('[fail]')) {
    notify('error', { threadId, turnId, willRetry: false, error: { message: '{"type":"error","error":{"message":"The model is not supported"}}', codexErrorInfo: 'badRequest' } });
    notify('turn/completed', { threadId, turn: { id: turnId, status: 'failed', error: { message: 'The model is not supported', codexErrorInfo: 'badRequest' } } });
    return;
  }
  for (const piece of ['Hel', 'lo ', 'there']) notify('item/agentMessage/delta', { threadId, turnId, itemId: 'a1', delta: piece });
  notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: 'a1', text: 'Hello there' } });
  notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { last: { inputTokens: 7, cachedInputTokens: 1, outputTokens: 3 }, total: {}, modelContextWindow: 1000 } });
  // A notification for another thread must be ignored.
  notify('item/agentMessage/delta', { threadId: 'other', turnId: 'x', itemId: 'zz', delta: 'LEAK' });
  notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', items: [] } });
}

const threadConfigs = new Map();
const MCP_STATUS = [
  { name: 'codex_apps', authStatus: 'bearerToken', runtimeStatus: null, pluginId: null, resources: [], resourceTemplates: [], tools: {
    'gmail.search': { name: 'gmail.search', inputSchema: {}, _meta: { connector_id: 'connector_gmail', connector_name: 'Gmail' } },
    'gmail.read': { name: 'gmail.read', inputSchema: {}, _meta: { connector_id: 'connector_gmail', connector_name: 'Gmail' } },
    'gcal.list': { name: 'gcal.list', inputSchema: {}, _meta: { connector_id: 'connector_gcal', connector_name: 'Google Calendar' } },
  } },
  { name: 'docs', authStatus: 'unsupported', runtimeStatus: null, pluginId: null, resources: [], resourceTemplates: [], tools: { fetch: { name: 'fetch', inputSchema: {} } } },
  { name: 'security', authStatus: 'unsupported', runtimeStatus: null, pluginId: 'sec@market', resources: [], resourceTemplates: [], tools: {} },
];

function handle(msg) {
  if (msg.method === undefined && msg.id !== undefined) {
    waiting.get(msg.id)?.(msg.result);
    return;
  }
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return out({ id, result: { userAgent: 'fake' } });
    case 'initialized':
      return;
    case 'account/read':
      return out({ id, result: { account: process.env.FAKE_API_KEY ? { type: 'apiKey' } : { type: 'chatgpt', email: null, planType: 'plus' }, requiresOpenaiAuth: true } });
    case 'account/rateLimits/read':
      return out({ id, result: { rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 2000000000 }, secondary: null, rateLimitReachedType: null, planType: 'plus' } } });
    case 'windowsSandbox/readiness':
      return out({ id, result: { status: 'ready' } });
    case 'model/list':
      return out({ id, result: { data: [{ id: 'm-a', model: 'model-a', displayName: 'Model A', hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }, { reasoningEffort: 'high', description: '' }], defaultReasoningEffort: 'low' }], nextCursor: null } });
    case 'thread/start': {
      const threadId = `thr_${++threadSeq}`;
      threadConfigs.set(threadId, params.config ?? null);
      threadPerms.set(threadId, `${params.sandbox}/${params.approvalPolicy}`);
      return out({ id, result: { thread: { id: threadId }, model: params.model ?? 'model-a' } });
    }
    case 'thread/resume':
      if (params.threadId === 'thr_missing') return out({ id, error: { code: -32600, message: 'no rollout found' } });
      threadConfigs.set(params.threadId, params.config ?? null);
      return out({ id, result: { thread: { id: params.threadId }, model: 'model-a' } });
    case 'thread/unsubscribe':
      return out({ id, result: { status: 'unsubscribed' } });
    case 'mcpServerStatus/list':
      // Two pages, to exercise cursor handling.
      return out({ id, result: params.cursor ? { data: MCP_STATUS.slice(2), nextCursor: null } : { data: MCP_STATUS.slice(0, 2), nextCursor: 'p2' } });
    case 'turn/start': {
      const turnId = `turn_${Date.now()}`;
      out({ id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
      void runTurn(params.threadId, turnId, params.input[0].text);
      return;
    }
    case 'turn/steer': {
      const resume = steerable.get(params.expectedTurnId);
      if (!resume) return out({ id, error: { code: -32600, message: 'no active turn to steer' } });
      steerable.delete(params.expectedTurnId);
      out({ id, result: { turnId: params.expectedTurnId } });
      resume(params.input[0].text);
      return;
    }
    case 'turn/interrupt': {
      out({ id, result: {} });
      if (activeTurns.has(params.turnId)) {
        activeTurns.delete(params.turnId);
        notify('turn/completed', { threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted', items: [] } });
      }
      return;
    }
    default:
      return out({ id, error: { code: -32601, message: `unknown ${method}` } });
  }
}

process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => process.exit(0));
