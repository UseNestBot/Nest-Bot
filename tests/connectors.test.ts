// Connectors (the providers' own MCP servers and apps) and per-agent browser use, driven offline with fake CLIs.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_ACCESS, DEFAULT_PERMISSIONS, DEFAULT_SETTINGS, type AppSettings, type Connector, type ProviderId } from '@shared/types';
import {
  ConnectorService,
  claudeMcpArgs,
  claudeServersFromInit,
  claudeToolAllowed,
  claudeToolPrefix,
  codexConfigOverrides,
  codexConnectorsFromStatus,
  codexServerAllowed,
  mergeClaudeConnectors,
  parseClaudeMcpList,
  sanitizeAccess,
  type ConnectorPolicy,
} from '../src/main/connectors';
import { CLAUDE_IN_CHROME_EXTENSION_ID, claudeChromeSupport, detectClaudeChrome } from '../src/main/browser';
import { NestDb } from '../src/main/db';
import { ClaudeProvider } from '../src/main/providers/claude';
import { CodexProvider } from '../src/main/providers/codex';
import { RunManager, type ProviderRegistry } from '../src/main/runs';

const MCP_LIST = `Checking MCP server health…

claude.ai Claude Docs: https://api.anthropic.com/v1/pages/mcp - ✔ Connected
claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected
plugin:figma:figma: https://mcp.figma.com/mcp (HTTP) - ! Needs authentication
blender: C:/Users/me/.local/bin/blender-mcp.exe  - ✔ Connected
broken: node C:/x/server.mjs - ✗ Failed to connect
`;

const claudeKnown = parseClaudeMcpList(MCP_LIST);
const policy = (allowed: string[] | null, known: Connector[], browser = false): ConnectorPolicy => ({ allowed, known, browser });
const nest = { command: 'node', args: ['nest-mcp.mjs'], env: { NEST_TOKEN: 't' } };

describe('Claude Code connectors', () => {
  it('parses `claude mcp list`, including names with colons and every status', () => {
    expect(claudeKnown.map((c) => [c.id, c.name, c.source, c.status])).toEqual([
      ['claude.ai Claude Docs', 'Claude Docs', 'claude.ai', 'connected'],
      ['claude.ai Gmail', 'Gmail', 'claude.ai', 'connected'],
      ['plugin:figma:figma', 'figma', 'Claude Code plugin', 'needs-auth'],
      ['blender', 'blender', 'Claude Code config', 'connected'],
      ['broken', 'broken', 'Claude Code config', 'failed'],
    ]);
    expect(claudeKnown[3].detail).toBe('Connected · C:/Users/me/.local/bin/blender-mcp.exe');
  });

  it('reads the servers a session loaded from system/init, skipping Nest and dynamic ones', () => {
    const seen = claudeServersFromInit([
      { name: 'blender', status: 'connected', source: 'user' },
      { name: 'claude.ai Gmail', status: 'connected', source: 'claudeai' },
      { name: 'claude-in-chrome', status: 'connected', source: 'dynamic' },
      { name: 'nest', status: 'connected', source: 'dynamic' },
    ]);
    expect(seen.map((c) => [c.id, c.source])).toEqual([
      ['blender', 'Claude Code config'],
      ['claude.ai Gmail', 'claude.ai'],
    ]);
  });

  it('merges a session’s own server list with `claude mcp list` health', () => {
    const session = claudeServersFromInit([
      { name: 'claude.ai Gmail', status: 'pending', source: 'claudeai' },
      { name: 'claude.ai Figma', status: 'pending', source: 'claudeai' },
    ]);
    const merged = mergeClaudeConnectors(session, claudeKnown);
    expect(merged.map((c) => [c.id, c.status])).toEqual([
      ['claude.ai Gmail', 'connected'],
      ['claude.ai Figma', 'unknown'],
      ['claude.ai Claude Docs', 'connected'],
      ['plugin:figma:figma', 'needs-auth'],
      ['blender', 'connected'],
      ['broken', 'failed'],
    ]);
    expect(mergeClaudeConnectors(null, claudeKnown)).toBe(claudeKnown);
  });

  it('names tools the way Claude Code does', () => {
    expect(claudeToolPrefix('claude.ai Gmail')).toBe('mcp__claude_ai_Gmail');
    expect(claudeToolPrefix('plugin:figma:figma')).toBe('mcp__plugin_figma_figma');
    expect(claudeToolPrefix('claude-in-chrome')).toBe('mcp__claude-in-chrome');
  });

  it('leaves the provider configuration alone when nothing is restricted', () => {
    expect(claudeMcpArgs(null, null)).toEqual({ args: [], disallowedTools: [] });
    const { args, disallowedTools } = claudeMcpArgs(policy(null, claudeKnown), nest);
    expect(args).toEqual(['--mcp-config', JSON.stringify({ mcpServers: { nest: { type: 'stdio', ...nest } } }), '--allowedTools', 'mcp__nest', '--no-chrome']);
    expect(disallowedTools).toEqual([]);
  });

  it('uses --strict-mcp-config for "no connectors", keeping Nest and the browser', () => {
    const withNest = claudeMcpArgs(policy([], claudeKnown, true), nest);
    expect(withNest.args).toContain('--strict-mcp-config');
    expect(withNest.args).toContain('--chrome');
    expect(JSON.parse(withNest.args[withNest.args.indexOf('--mcp-config') + 1])).toEqual({ mcpServers: { nest: { type: 'stdio', ...nest } } });
    const alone = claudeMcpArgs(policy([], claudeKnown), null);
    expect(alone.args).toEqual(['--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config', '--no-chrome']);
  });

  it('removes every other server’s tools when only some connectors are allowed', () => {
    const known = [...claudeKnown, { provider: 'claude', id: 'nest', name: 'nest', source: 'x', status: 'connected', detail: null }] as Connector[];
    const { args, disallowedTools } = claudeMcpArgs(policy(['claude.ai Gmail'], known), nest);
    expect(args).not.toContain('--strict-mcp-config');
    expect(disallowedTools).toEqual(['mcp__claude_ai_Claude_Docs', 'mcp__plugin_figma_figma', 'mcp__blender', 'mcp__broken']);
  });

  it('refuses permission prompts for tools from servers that are not allowed', () => {
    const p = policy(['claude.ai Gmail'], claudeKnown);
    expect(claudeToolAllowed('mcp__claude_ai_Gmail__search_threads', p)).toBe(true);
    expect(claudeToolAllowed('mcp__blender__render', p)).toBe(false);
    expect(claudeToolAllowed('mcp__nest__remember', p)).toBe(true);
    expect(claudeToolAllowed('Bash', p)).toBe(true);
    expect(claudeToolAllowed('mcp__claude-in-chrome__navigate', p)).toBe(false);
    expect(claudeToolAllowed('mcp__claude-in-chrome__navigate', { ...p, browser: true })).toBe(true);
    expect(claudeToolAllowed('mcp__blender__render', null)).toBe(true);
  });
});

const CODEX_STATUS = [
  {
    name: 'codex_apps',
    authStatus: 'bearerToken',
    tools: {
      'gmail.search': { name: 'gmail.search', _meta: { connector_id: 'connector_gmail', connector_name: 'Gmail' } },
      'gmail.read': { name: 'gmail.read', _meta: { connector_id: 'connector_gmail', connector_name: 'Gmail' } },
      'gcal.list': { name: 'gcal.list', _meta: { connector_id: 'connector_gcal', connector_name: 'Google Calendar' } },
    },
  },
  { name: 'nest', authStatus: 'unsupported', tools: { remember: {} } },
  { name: 'docs', authStatus: 'unsupported', tools: { fetch: {} } },
  { name: 'linear', authStatus: 'notLoggedIn', tools: {} },
  { name: 'security', authStatus: 'unsupported', pluginId: 'sec@market', runtimeStatus: 'failed', tools: {} },
];
const codexKnown = codexConnectorsFromStatus(CODEX_STATUS);

describe('Codex connectors', () => {
  it('lists ChatGPT apps one per app and other servers by name, without Nest', () => {
    expect(codexKnown.map((c) => [c.id, c.name, c.source, c.status, c.detail])).toEqual([
      ['app:connector_gmail', 'Gmail', 'ChatGPT app', 'connected', '2 tools'],
      ['app:connector_gcal', 'Google Calendar', 'ChatGPT app', 'connected', '1 tool'],
      ['server:docs', 'docs', 'Codex config', 'connected', '1 tool'],
      ['server:linear', 'linear', 'Codex config', 'needs-auth', 'Needs sign-in'],
      ['server:security', 'security', 'Codex plugin sec@market', 'failed', 'No tools reported (not running, or needs sign-in)'],
    ]);
  });

  it('adds no overrides when nothing is restricted', () => {
    expect(codexConfigOverrides(null)).toEqual({});
    expect(codexConfigOverrides(policy(null, codexKnown))).toEqual({});
  });

  it('allowlists apps and disables every other server by name', () => {
    expect(codexConfigOverrides(policy(['app:connector_gmail'], codexKnown))).toEqual({
      'apps._default.enabled': false,
      'apps.connector_gmail.enabled': true,
      'mcp_servers.docs.enabled': false,
      'mcp_servers.linear.enabled': false,
      'plugins.sec@market.mcp_servers.security.enabled': false,
    });
    expect(codexConfigOverrides(policy(['server:docs'], codexKnown))).toEqual({
      'apps._default.enabled': false,
      'mcp_servers.linear.enabled': false,
      'plugins.sec@market.mcp_servers.security.enabled': false,
    });
  });

  it('refuses MCP approvals for servers that are not allowed', () => {
    const p = policy(['app:connector_gmail'], codexKnown);
    expect(codexServerAllowed('codex_apps', p)).toBe(true);
    expect(codexServerAllowed('docs', p)).toBe(false);
    expect(codexServerAllowed('nest', p)).toBe(true);
    expect(codexServerAllowed('codex_apps', policy(['server:docs'], codexKnown))).toBe(false);
    expect(codexServerAllowed('docs', null)).toBe(true);
  });
});

describe('browser readiness', () => {
  it('says exactly what is missing for Claude in Chrome', () => {
    expect(claudeChromeSupport({ chromeInstalled: true, extensionInstalled: true, hostRegistered: true })).toMatchObject({ available: true, ready: true, missing: [] });
    const none = claudeChromeSupport({ chromeInstalled: false, extensionInstalled: false, hostRegistered: false });
    expect(none.ready).toBe(false);
    expect(none.missing).toEqual(['Install Google Chrome.', 'Install the Claude in Chrome extension (https://claude.ai/chrome) and sign in with your Claude account.']);
    // The native host is registered by Claude Code on first use, so it is only a note, not a blocker.
    const firstUse = claudeChromeSupport({ chromeInstalled: true, extensionInstalled: true, hostRegistered: false });
    expect(firstUse.ready).toBe(true);
    expect(firstUse.note).toContain('first time');
    expect(claudeChromeSupport({ chromeInstalled: null, extensionInstalled: null, hostRegistered: null }).ready).toBeNull();
  });

  it.skipIf(process.platform !== 'win32')('finds Chrome and the extension in any Chrome profile', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nest-chrome-'));
    const env = { PROGRAMFILES: path.join(root, 'pf'), LOCALAPPDATA: path.join(root, 'local') };
    expect(await detectClaudeChrome(env)).toMatchObject({ chromeInstalled: false, extensionInstalled: false });
    mkdirSync(path.join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application'), { recursive: true });
    writeFileSync(path.join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'), '');
    mkdirSync(path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data', 'Profile 3', 'Extensions', 'someotherextension'), { recursive: true });
    expect(await detectClaudeChrome(env)).toMatchObject({ chromeInstalled: true, extensionInstalled: false });
    mkdirSync(path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data', 'Profile 3', 'Extensions', CLAUDE_IN_CHROME_EXTENSION_ID), { recursive: true });
    expect(await detectClaudeChrome(env)).toMatchObject({ chromeInstalled: true, extensionInstalled: true });
  });
});

describe('agent access', () => {
  it('sanitizes untrusted input', () => {
    expect(sanitizeAccess(undefined)).toEqual(DEFAULT_AGENT_ACCESS);
    expect(sanitizeAccess({ claudeConnectors: ['a', 'a', 3 as unknown as string, ''], codexConnectors: 'x' as unknown as string[], browser: 'yes' as unknown as boolean })).toEqual({
      claudeConnectors: ['a'],
      codexConnectors: null,
      browser: false,
      browserMode: 'nest',
      terminal: false,
    });
    expect(sanitizeAccess({ browser: true, browserMode: 'chrome' }).browserMode).toBe('chrome');
    expect(sanitizeAccess({ browser: true, browserMode: 'evil' as unknown as 'nest' }).browserMode).toBe('nest');
  });
});

// ---------------------------------------------------------------------------
// Through the real provider adapters and RunManager, with fake CLIs.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function boot() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nest-connectors-'));
  const db = new NestDb(path.join(dir, 'n.sqlite'));
  const settings = (): AppSettings => ({ ...DEFAULT_SETTINGS, claudePath: path.resolve('tests/fixtures/fake-claude.mjs'), codexPath: path.resolve('tests/fixtures/fake-codex.mjs') });
  const claude = new ClaudeProvider(settings, () => {});
  const codex = new CodexProvider(settings, () => {}, () => {}, 'test');
  const registry: ProviderRegistry = { get: (id) => (id === 'claude' ? claude : codex) };
  const runs = new RunManager(db, registry, () => {}, () => path.join(dir, 'work'));
  const connectors = new ConnectorService((p) => registry.get(p), (id) => db.getAgentAccess(id));
  runs.connectorPolicy = (agentId, provider) => connectors.policyFor(agentId, provider);
  claude.onServersSeen = (seen) => connectors.noteSeen('claude', seen);
  cleanups.push(async () => {
    await claude.dispose();
    await codex.dispose();
    db.close();
  });
  return { db, runs, connectors };
}

const makeAgent = (db: NestDb, provider: ProviderId) =>
  db.createAgent({ name: `Agent ${provider}`, avatar: { shape: 'blob', color: '#4cbe6c', eyes: 'dots' }, instructions: '', provider, model: null, workspace: null, projectId: null, pinned: false, permissions: DEFAULT_PERMISSIONS });

async function reply(db: NestDb, runs: RunManager, conversationId: string, text: string): Promise<string> {
  const { runId } = await runs.send(conversationId, text, []);
  const start = Date.now();
  while (Date.now() - start < 15000) {
    const run = db.getRun(runId);
    if (run && run.status !== 'running') {
      expect(run.status).toBe('completed');
      return db.listMessages(conversationId).filter((m) => m.runId === runId && m.role === 'assistant').at(-1)?.content ?? '';
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('run did not finish');
}

describe('connectors end to end (fake CLIs)', () => {
  it('lists each provider’s connectors through its own command', async () => {
    const { connectors } = boot();
    const claude = await connectors.list('claude');
    // The session's own list leads (it includes claude.ai Figma); `mcp list` adds health and the figma plugin.
    expect(claude.connectors.map((c) => [c.id, c.status])).toEqual([
      ['blender', 'connected'],
      ['claude.ai Gmail', 'connected'],
      ['claude.ai Figma', 'unknown'],
      ['plugin:figma:figma', 'needs-auth'],
    ]);
    expect(JSON.stringify(claude)).not.toContain('not-for-nest');
    expect(claude.browser.available).toBe(true);
    const codex = await connectors.list('codex');
    expect(codex.connectors.map((c) => c.id)).toEqual(['app:connector_gmail', 'app:connector_gcal', 'server:docs', 'server:security']);
    expect(codex.browser.available).toBe(false);
  });

  it('keeps access separate from the agent record, so editing the agent keeps it', () => {
    const { db } = boot();
    const a = makeAgent(db, 'claude');
    expect(db.getAgentAccess(a.id)).toEqual(DEFAULT_AGENT_ACCESS);
    db.setAgentAccess(a.id, { claudeConnectors: ['claude.ai Gmail'], codexConnectors: null, browser: true, browserMode: 'chrome', terminal: false });
    db.updateAgent(a.id, { ...a, name: 'Renamed' });
    expect(db.getAgentAccess(a.id)).toEqual({ claudeConnectors: ['claude.ai Gmail'], codexConnectors: null, browser: true, browserMode: 'chrome', terminal: false });
  });

  it('restricts a Claude agent to one connector and gives it the browser', async () => {
    const { db, runs } = boot();
    const a = makeAgent(db, 'claude');
    db.setAgentAccess(a.id, { claudeConnectors: ['claude.ai Gmail'], codexConnectors: null, browser: true, browserMode: 'chrome', terminal: false });
    const conv = db.createConversation(a);
    // The connector list is fetched before the first restricted turn.
    const report = JSON.parse(await reply(db, runs, conv.id, '[args]'));
    expect(report.strict).toBe(false);
    expect(report.chrome).toBe(true);
    expect(report.disallowed.split(',')).toEqual(['AskUserQuestion', 'mcp__blender', 'mcp__claude_ai_Figma', 'mcp__plugin_figma_figma']);
    const context = db.listActivities(conv.id).find((x) => x.id === 'ctx-connectors');
    expect(context?.title).toBe('Connectors: Gmail');
    expect(context?.detail).toContain('Browser: Claude in Chrome');
  });

  it('runs a Claude agent with no connectors under --strict-mcp-config and without the browser', async () => {
    const { db, runs } = boot();
    const a = makeAgent(db, 'claude');
    db.setAgentAccess(a.id, { claudeConnectors: [], codexConnectors: null, browser: false, browserMode: 'nest', terminal: false });
    const report = JSON.parse(await reply(db, runs, db.createConversation(a).id, '[args]'));
    expect(report).toMatchObject({ strict: true, chrome: false, disallowed: 'AskUserQuestion', mcpConfig: '{"mcpServers":{}}' });
  });

  it('refuses a disallowed server’s tool without asking the user', async () => {
    const { db, runs } = boot();
    const a = makeAgent(db, 'claude');
    db.setAgentAccess(a.id, { claudeConnectors: ['claude.ai Gmail'], codexConnectors: null, browser: false, browserMode: 'nest', terminal: false });
    const conv = db.createConversation(a);
    expect(await reply(db, runs, conv.id, '[mcp-call]')).toBe('mcp:deny');
    expect(db.listApprovals(conv.id)).toEqual([]);
    expect(db.listActivities(conv.id).some((x) => x.title.startsWith('Blocked mcp__blender__render'))).toBe(true);
  });

  it('sends a Codex agent’s connector choice as thread config, and reloads the thread when it changes', async () => {
    const { db, runs } = boot();
    const a = makeAgent(db, 'codex');
    const conv = db.createConversation(a);
    expect(JSON.parse(await reply(db, runs, conv.id, '[config]'))).toBeNull();
    db.setAgentAccess(a.id, { claudeConnectors: null, codexConnectors: ['app:connector_gmail'], browser: true, browserMode: 'chrome', terminal: false });
    expect(JSON.parse(await reply(db, runs, conv.id, '[config]'))).toEqual({
      'apps._default.enabled': false,
      'apps.connector_gmail.enabled': true,
      'mcp_servers.docs.enabled': false,
      'plugins.sec@market.mcp_servers.security.enabled': false,
    });
  });
});
