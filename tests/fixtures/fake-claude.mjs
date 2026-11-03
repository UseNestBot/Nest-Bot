// Stand-in for the Claude Code CLI speaking stream-json, used by offline tests.
// Behaviour is selected by the prompt text so one script covers several scenarios.
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('9.9.9 (Claude Code)');
  process.exit(0);
}
if (args[0] === 'mcp' && args[1] === 'list') {
  console.log('Checking MCP server health…\n');
  console.log('claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected');
  console.log('plugin:figma:figma: https://mcp.figma.com/mcp (HTTP) - ! Needs authentication');
  console.log('blender: C:/tools/blender-mcp.exe  - ✔ Connected');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  console.log(JSON.stringify({ loggedIn: process.env.FAKE_LOGGED_OUT ? false : true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' }));
  process.exit(0);
}

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sessionIdx = args.indexOf('--session-id');
const resumeIdx = args.indexOf('--resume');
const sessionId = sessionIdx >= 0 ? args[sessionIdx + 1] : resumeIdx >= 0 ? args[resumeIdx + 1] : randomUUID();
let buf = '';
const pending = new Map();
let interrupted = false;
/** Set while a [steerable] turn waits for a message sent mid-turn. */
let steerWaiter = null;

function result(text, isError = false) {
  out({ type: 'result', subtype: 'success', is_error: isError, result: text, session_id: sessionId, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 } });
}

function assistantText(id, text) {
  out({ type: 'stream_event', event: { type: 'message_start', message: { id } }, session_id: sessionId, parent_tool_use_id: null });
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, session_id: sessionId, parent_tool_use_id: null });
  // Split one record across two writes to exercise the JSONL reader.
  const line = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, 3) } }, session_id: sessionId, parent_tool_use_id: null });
  process.stdout.write(line.slice(0, 20));
  setTimeout(() => {
    process.stdout.write(`${line.slice(20)}\n`);
    process.stdout.write('{this is not json}\n');
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(3) } }, session_id: sessionId, parent_tool_use_id: null });
    out({ type: 'assistant', message: { id, content: [{ type: 'text', text }] }, session_id: sessionId, parent_tool_use_id: null });
  }, 20);
}

async function handleUser(prompt) {
  // Like the real CLI: configured servers are listed, and disallowed or strict-excluded tools are absent.
  const strict = args.includes('--strict-mcp-config');
  const disallowed = (args.includes('--disallowedTools') ? args[args.indexOf('--disallowedTools') + 1] : '').split(',');
  const servers = strict ? [] : [{ name: 'blender', status: 'connected', source: 'user' }, { name: 'claude.ai Gmail', status: 'connected', source: 'claudeai' }];
  const tools = ['Bash', ...(strict ? [] : ['mcp__blender__render', 'mcp__claude_ai_Gmail__search']), ...(args.includes('--chrome') ? ['mcp__claude-in-chrome__navigate'] : [])]
    .filter((t) => !disallowed.some((d) => d && (t === d || t.startsWith(`${d}__`))));
  out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake-model', mcp_servers: servers, tools });
  if (prompt.includes('[mcp-call]')) {
    // A permission prompt for a server's tool; Nest should refuse it without asking when the server isn't allowed.
    const requestId = 'perm-mcp';
    out({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: 'mcp__blender__render', input: {}, tool_use_id: 'tu9' } });
    const decision = await new Promise((r) => pending.set(requestId, r));
    assistantText('m1', `mcp:${decision.behavior}`);
    setTimeout(() => result('done'), 60);
    return;
  }
  if (prompt.includes('[approval]')) {
    out({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'echo hi > out.txt' } }] }, session_id: sessionId, parent_tool_use_id: null });
    const requestId = 'perm-1';
    out({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo hi > out.txt' }, tool_use_id: 'tu1', permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'localSettings' }] } });
    const decision = await new Promise((r) => pending.set(requestId, r));
    const allowed = decision.behavior === 'allow';
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: allowed ? 'ok' : 'Permission denied by user', is_error: !allowed }] }, session_id: sessionId, parent_tool_use_id: null });
    assistantText('m2', `decision:${decision.behavior}:${decision.updatedPermissions?.[0]?.destination ?? 'none'}`);
    setTimeout(() => result('done'), 60);
    return;
  }
  if (prompt.includes('[narrate]')) {
    // Text before a tool is a note on the way; the text after the last tool is the answer.
    out({ type: 'stream_event', event: { type: 'message_start', message: { id: 'n1' } }, session_id: sessionId, parent_tool_use_id: null });
    out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, session_id: sessionId, parent_tool_use_id: null });
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me check.' } }, session_id: sessionId, parent_tool_use_id: null });
    out({ type: 'assistant', message: { id: 'n1', content: [{ type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: 'tu-n', name: 'Bash', input: { command: 'ls' } }] }, session_id: sessionId, parent_tool_use_id: null });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-n', content: 'a.txt', is_error: false }] }, session_id: sessionId, parent_tool_use_id: null });
    if (prompt.includes('[ends-on-step]')) {
      out({ type: 'assistant', message: { id: 'n2', content: [{ type: 'tool_use', id: 'tu-n2', name: 'Bash', input: { command: 'pwd' } }] }, session_id: sessionId, parent_tool_use_id: null });
      out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-n2', content: '/w', is_error: false }] }, session_id: sessionId, parent_tool_use_id: null });
      setTimeout(() => result('done'), 20);
      return;
    }
    assistantText('n2', 'Found a.txt.');
    setTimeout(() => result('done'), 60);
    return;
  }
  if (prompt.includes('[steerable]')) {
    // A tool runs; a message sent meanwhile is echoed back (--replay-user-messages) and answered in the same turn.
    out({ type: 'assistant', message: { id: 's1', content: [{ type: 'text', text: 'working on it' }, { type: 'tool_use', id: 'tu-s', name: 'Bash', input: { command: 'sleep 1' } }] }, session_id: sessionId, parent_tool_use_id: null });
    const steer = await new Promise((r) => (steerWaiter = r));
    steerWaiter = null;
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-s', content: 'ok', is_error: false }] }, session_id: sessionId, parent_tool_use_id: null });
    out({ type: 'user', message: steer.message, uuid: steer.uuid, isReplay: true, session_id: sessionId, parent_tool_use_id: null });
    assistantText('s2', `steered:${steer.message.content[0].text}`);
    setTimeout(() => result('done'), 60);
    return;
  }
  if (prompt.includes('[slow]')) {
    assistantText('m1', 'starting slow work');
    const timer = setInterval(() => {
      if (interrupted) {
        clearInterval(timer);
        out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Interrupted', session_id: sessionId });
      }
    }, 20);
    return;
  }
  if (prompt.includes('[args]')) {
    // Report the MCP-related arguments Nest passed, so tests can check connector restrictions.
    const pick = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] ?? true : null);
    const report = { strict: args.includes('--strict-mcp-config'), chrome: args.includes('--chrome') ? true : args.includes('--no-chrome') ? false : null, disallowed: pick('--disallowedTools'), mcpConfig: pick('--mcp-config') };
    assistantText('m1', JSON.stringify(report));
    setTimeout(() => result('ok'), 60);
    return;
  }
  if (prompt.includes('[perms]')) {
    const i = args.indexOf('--permission-mode');
    assistantText('m1', `perms:${i >= 0 ? args[i + 1] : 'none'}`);
    setTimeout(() => result('ok'), 60);
    return;
  }
  if (prompt.includes('[system]')) {
    const i = args.indexOf('--append-system-prompt');
    assistantText('m1', i >= 0 ? args[i + 1] : 'none');
    setTimeout(() => result('ok'), 60);
    return;
  }
  if (prompt.includes('[cwd]')) {
    assistantText('m1', `cwd:${process.cwd()}`);
    setTimeout(() => result('ok'), 60);
    return;
  }
  if (prompt.includes('[hang]')) return; // never answers; only killTree ends it
  if (prompt.includes('[crash]')) {
    process.stderr.write('fatal: simulated crash\n');
    process.exit(3);
  }
  if (prompt.includes('[auth]')) {
    out({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Failed to authenticate' }] }, error: 'authentication_failed', session_id: sessionId, parent_tool_use_id: null });
    result('Failed to authenticate', true);
    return;
  }
  assistantText('m1', `echo:${resumeIdx >= 0 ? 'resumed' : 'new'}:${prompt.slice(-40)}`);
  setTimeout(() => result('ok'), 60);
}

process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.type === 'user' && steerWaiter) steerWaiter(msg);
    else if (msg.type === 'user') void handleUser(msg.message.content[0].text);
    else if (msg.type === 'control_response') pending.get(msg.response.request_id)?.(msg.response.response);
    else if (msg.type === 'control_request' && msg.request.subtype === 'mcp_status') {
      // What a session loads; differs from `mcp list` (a claude.ai Figma connector, no figma plugin), like the real CLI can.
      const mcpServers = ['blender:user', 'claude.ai Gmail:claudeai', 'claude.ai Figma:claudeai'].map((x) => ({ name: x.split(':')[0], status: 'pending', source: x.split(':')[1], config: { type: 'stdio', env: { SECRET: 'not-for-nest' } } }));
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { mcpServers } } });
    } else if (msg.type === 'control_request' && msg.request.subtype === 'interrupt') {
      interrupted = true;
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } });
    }
  }
});
process.stdin.on('end', () => setTimeout(() => process.exit(0), 10));
