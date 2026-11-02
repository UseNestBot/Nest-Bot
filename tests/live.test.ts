// Live integration tests against the real, locally signed-in provider CLIs.
// Skipped unless NEST_LIVE=codex or NEST_LIVE=claude (or "codex,claude").
// They consume a small amount of your subscription usage.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type NestEvent, type ProviderId } from '@shared/types';
import { NestDb } from '../src/main/db';
import { ClaudeProvider } from '../src/main/providers/claude';
import { CodexProvider } from '../src/main/providers/codex';
import { RunManager, type ProviderRegistry } from '../src/main/runs';
import { NestBridge } from '../src/main/mcp/bridge';
import { NestTools } from '../src/main/mcp/tools';
import { Scheduler } from '../src/main/scheduler';
import { ConnectorService } from '../src/main/connectors';

const MCP_SERVER = path.resolve('out/main/nest-mcp.mjs');

const live = (process.env.NEST_LIVE ?? '').split(',').filter(Boolean) as ProviderId[];
const dir = mkdtempSync(path.join(os.tmpdir(), 'nest-live-'));
const workspace = mkdtempSync(path.join(os.tmpdir(), 'nest-ws-'));

function boot(file: string) {
  const db = new NestDb(file);
  db.recoverAfterRestart();
  const events: NestEvent[] = [];
  const claude = new ClaudeProvider(() => ({ ...DEFAULT_SETTINGS }), () => {});
  const codex = new CodexProvider(() => ({ ...DEFAULT_SETTINGS }), () => {}, () => {}, 'test');
  const registry: ProviderRegistry = { get: (id) => (id === 'claude' ? claude : codex) };
  const runs = new RunManager(db, registry, (e) => events.push(e), () => path.join(dir, 'scratch'));
  runs.onRunFinished = (cid, run, msg) => runs.handleHandoffCompletion(cid, run, msg);
  const connectors = new ConnectorService((id) => registry.get(id), (id) => db.getAgentAccess(id));
  runs.connectorPolicy = (agentId, p) => connectors.policyFor(agentId, p);
  claude.onServersSeen = (seen) => connectors.noteSeen('claude', seen);
  return { db, runs, events, connectors, dispose: async () => { await claude.dispose(); await codex.dispose(); db.close(); } };
}

/** Boot with Nest's agent tools available (requires `npm run build` for the MCP server script). */
async function bootWithTools(file: string) {
  const app = boot(file);
  const scheduler = new Scheduler(app.db, app.runs, () => {});
  const bridge = new NestBridge(new NestTools(app.db, app.runs, scheduler, () => {}), MCP_SERVER, process.execPath);
  await bridge.start();
  app.runs.mcpLauncher = (cid) => bridge.launchFor(cid);
  return { ...app, dispose: async () => { await app.dispose(); bridge.stop(); } };
}

async function waitForRun(db: NestDb, runId: string, timeoutMs = 240_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const run = db.getRun(runId);
    if (run && run.status !== 'running') return run;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('run did not finish');
}

afterAll(() => {
  for (const d of [dir, workspace]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows may still hold a handle briefly */
    }
  }
});

for (const provider of (['codex', 'claude'] as ProviderId[])) {
  describe.skipIf(!live.includes(provider))(`live ${provider}`, () => {
    const file = path.join(dir, `${provider}.sqlite`);
    let conversationId = '';
    let firstSession: string | null = null;

    it('sends a message, streams a response and records the native session', { timeout: 300_000 }, async () => {
      const app = boot(file);
      const agent = app.db.createAgent({
        name: 'Live test',
        avatar: { shape: 'blob', color: '#5fb87a', eyes: 'dots' },
        instructions: 'You are terse. Never use tools unless asked.',
        provider,
        model: null,
        workspace,
        projectId: null,
        pinned: false,
        permissions: { claudeMode: 'default', codexSandbox: 'read-only', codexApproval: 'on-request' },
      });
      app.db.createMemory('agent', agent.id, 'The secret code word is HERON.');
      conversationId = app.db.createConversation(agent).id;
      const { runId } = await app.runs.send(conversationId, 'Reply with exactly the word: pong', []);
      const run = await waitForRun(app.db, runId);
      if (run.error) console.log('RUN ERROR', run.error, JSON.stringify(app.db.listActivities(conversationId)));
      expect(run.error).toBeNull();
      expect(run.status).toBe('completed');
      expect(run.sessionId).toBeTruthy();
      expect(run.includedNoteIds.length).toBe(1);
      firstSession = run.sessionId;
      const assistant = app.db.listMessages(conversationId).find((m) => m.runId === runId)!;
      expect(assistant.status).toBe('complete');
      expect(assistant.content.toLowerCase()).toContain('pong');
      // Deltas were broadcast while streaming.
      expect(app.events.filter((e) => e.type === 'message' && e.message.status === 'streaming').length).toBeGreaterThan(0);
      await app.dispose();
    });

    it('resumes the same native session after a restart and does not resend memory', { timeout: 300_000 }, async () => {
      const app = boot(file);
      const { runId } = await app.runs.send(conversationId, 'What is the secret code word from your notes? One word.', []);
      const run = await waitForRun(app.db, runId);
      expect(run.status).toBe('completed');
      expect(run.sessionId).toBe(firstSession);
      expect(run.includedNoteIds.length).toBe(0);
      const assistant = app.db.listMessages(conversationId).find((m) => m.runId === runId)!;
      expect(assistant.content.toUpperCase()).toContain('HERON');
      await app.dispose();
    });

    it('cancels a running turn cleanly and keeps the transcript usable', { timeout: 300_000 }, async () => {
      const app = boot(file);
      const { runId } = await app.runs.send(conversationId, 'Count slowly from 1 to 400, one number per line, with no other text.', []);
      const started = Date.now();
      while (Date.now() - started < 60_000) {
        const msg = app.db.listMessages(conversationId).find((m) => m.runId === runId);
        if (msg && msg.content.length > 0) break;
        if (app.events.some((e) => e.type === 'message' && e.message.runId === runId && e.message.content.length > 0)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      await app.runs.cancel(conversationId);
      const run = await waitForRun(app.db, runId, 30_000);
      expect(run.status).toBe('interrupted');
      const msg = app.db.listMessages(conversationId).find((m) => m.runId === runId)!;
      expect(msg.status).toBe('interrupted');
      // The conversation still works after a cancel.
      const next = await app.runs.send(conversationId, 'Reply with exactly the word: ok', []);
      const run2 = await waitForRun(app.db, next.runId);
      expect(run2.status).toBe('completed');
      expect(run2.sessionId).toBe(firstSession);
      await app.dispose();
    });

    it('surfaces an approval request and a decline lets the turn finish', { timeout: 300_000 }, async () => {
      const app = boot(file);
      app.db.updateConversation(conversationId, { permissions: { claudeMode: 'default', codexSandbox: 'read-only', codexApproval: 'on-request' } });
      const { runId } = await app.runs.send(conversationId, 'Create a file named hello.txt in the current folder containing the word hi. Use a shell command, do not ask me first.', []);
      let approvalId: string | null = null;
      const started = Date.now();
      while (!approvalId && Date.now() - started < 120_000) {
        approvalId = app.db.listApprovals(conversationId).find((a) => a.runId === runId && a.status === 'pending')?.id ?? null;
        if (app.db.getRun(runId)?.status !== 'running') break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(approvalId).toBeTruthy();
      const approval = app.db.getApproval(approvalId!)!;
      expect(approval.action.length).toBeGreaterThan(0);
      app.runs.respondApproval(approvalId!, provider === 'claude' ? 'deny' : 'decline');
      const run = await waitForRun(app.db, runId);
      expect(run.status).toBe('completed');
      expect(app.db.getApproval(approvalId!)!.status).toBe('resolved');
      expect(existsSync(path.join(workspace, 'hello.txt'))).toBe(false);
      await app.dispose();
    });

    it('skip permissions: writes a file with no approval prompt', { timeout: 300_000 }, async () => {
      const app = boot(path.join(dir, `${provider}-skip.sqlite`));
      app.db.updateSettings({ allowSkipPermissions: true });
      const ws = mkdtempSync(path.join(os.tmpdir(), 'nest-skip-ws-'));
      const agent = app.db.createAgent({
        name: 'Skipper',
        avatar: { shape: 'blob', color: '#4cbe6c', eyes: 'dots' },
        instructions: 'Do exactly what is asked.',
        provider,
        model: null,
        workspace: ws,
        projectId: null,
        pinned: false,
        permissions: { claudeMode: 'default', codexSandbox: 'read-only', codexApproval: 'on-request', skipPermissions: true },
      });
      const conv = app.db.createConversation(agent);
      const { runId } = await app.runs.send(conv.id, 'Create a file named skip-check.txt in the current folder containing the word ok, using a shell command. Do not ask me first.', []);
      const run = await waitForRun(app.db, runId);
      if (run.status !== 'completed') console.log('SKIP RUN', run.error, JSON.stringify(app.db.listActivities(conv.id)));
      expect(run.status).toBe('completed');
      expect(app.db.listApprovals(conv.id).filter((x) => x.status === 'pending')).toEqual([]);
      expect(existsSync(path.join(ws, 'skip-check.txt'))).toBe(true);
      await app.dispose();
    });

    it('skip by default: still asks before deleting data, and respects a decline', { timeout: 300_000 }, async () => {
      const app = await bootWithTools(path.join(dir, `${provider}-ask.sqlite`));
      app.db.updateSettings({ allowSkipPermissions: true, skipPermissionsByDefault: true });
      const ws = mkdtempSync(path.join(os.tmpdir(), 'nest-ask-ws-'));
      writeFileSync(path.join(ws, 'customers.csv'), ['name,email', 'Ada,ada@example.com', ''].join(String.fromCharCode(10)));
      const agent = app.db.createAgent({
        name: 'Pipeline',
        avatar: { shape: 'blob', color: '#4cbe6c', eyes: 'dots' },
        instructions: 'You maintain the customer list.',
        provider,
        model: null,
        workspace: ws,
        projectId: null,
        pinned: false,
        permissions: { claudeMode: 'default', codexSandbox: 'workspace-write', codexApproval: 'on-request' },
      });
      const conv = app.db.createConversation(agent);
      const { runId } = await app.runs.send(conv.id, 'Delete customers.csv from the current folder.', []);
      let approval;
      const start = Date.now();
      while (!approval && Date.now() - start < 180_000 && app.db.getRun(runId)?.status === 'running') {
        approval = app.db.listApprovals(conv.id).find((x) => x.status === 'pending');
        if (!approval) await new Promise((r) => setTimeout(r, 300));
      }
      expect(approval?.title).toMatch(/asks permission/);
      app.runs.respondApproval(approval!.id, 'deny');
      const run = await waitForRun(app.db, runId);
      expect(run.status).toBe('completed');
      expect(existsSync(path.join(ws, 'customers.csv'))).toBe(true);
      expect(app.db.listActivities(conv.id).some((x) => x.id === 'ctx-skip')).toBe(true);
      await app.dispose();
    });

    it('calls Nest tools over MCP: reads its own profile', { timeout: 300_000 }, async () => {
      const app = await bootWithTools(path.join(dir, `${provider}-tools.sqlite`));
      const me = app.db.createAgent({
        name: 'Kestrel Scout',
        avatar: { shape: 'blob', color: '#4cbe6c', eyes: 'dots' },
        instructions: 'You scout ahead. Your codeword is MAGPIE.',
        provider,
        model: null,
        workspace,
        projectId: null,
        pinned: false,
        permissions: { claudeMode: 'default', codexSandbox: 'read-only', codexApproval: 'on-request' },
      });
      const conv = app.db.createConversation(me);
      const { runId } = await app.runs.send(conv.id, 'Call your get_my_profile tool, then reply with only your name and codeword from it.', []);
      const run = await waitForRun(app.db, runId);
      const text = app.db.listMessages(conv.id).find((m) => m.runId === runId)!.content;
      const acts = app.db.listActivities(conv.id).filter((x) => x.runId === runId);
      if (run.status !== 'completed') console.log('TOOLS RUN', run.error, JSON.stringify(acts));
      expect(run.status).toBe('completed');
      expect(text).toContain('Kestrel Scout');
      expect(text.toUpperCase()).toContain('MAGPIE');
      expect(acts.some((x) => x.kind === 'mcp' && /get_my_profile/.test(x.title))).toBe(true);
      await app.dispose();
    });
  });
}

// Uses whatever connectors are set up in the provider on this computer; needs at least two.
describe.skipIf(!live.length)('live connectors', () => {
  const base = { avatar: { shape: 'blob' as const, color: '#4cbe6c', eyes: 'dots' as const }, instructions: 'You are terse.', model: null, workspace, projectId: null, pinned: false, permissions: { claudeMode: 'default' as const, codexSandbox: 'read-only' as const, codexApproval: 'on-request' as const } };

  it.skipIf(!live.includes('claude'))('a Claude agent restricted to one connector only gets that one', { timeout: 300_000 }, async () => {
    const app = boot(path.join(dir, 'connectors-claude.sqlite'));
    const inv = await app.connectors.list('claude');
    const connected = inv.connectors.filter((c) => c.status === 'connected');
    expect(connected.length).toBeGreaterThan(1);
    const only = connected.find((c) => c.name === 'Gmail') ?? connected[0];
    // Every other server a session loads, including ones `claude mcp list` doesn't report.
    const others = inv.connectors.filter((c) => c !== only && !c.id.startsWith('plugin:'));
    const agent = app.db.createAgent({ ...base, name: 'Restricted', provider: 'claude' });
    app.db.setAgentAccess(agent.id, { claudeConnectors: [only.id], codexConnectors: null, browser: false, browserMode: 'nest' });
    const conv = app.db.createConversation(agent);
    const names = [only, ...others].map((c) => c.id);
    const prompt = `Use your tool search to look for tools from each of these MCP servers: ${names.join(', ')}. Do NOT call any of the tools you find. Reply with only a JSON object mapping each of those exact server names to true if you found at least one of its tools, false otherwise.`;
    const { runId } = await app.runs.send(conv.id, prompt, []);
    const run = await waitForRun(app.db, runId);
    expect(run.status).toBe('completed');
    const text = app.db.listMessages(conv.id).find((m) => m.runId === runId)!.content;
    const found = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as Record<string, boolean>;
    expect(found[only.id]).toBe(true);
    for (const o of others) expect(found[o.id]).toBe(false);
    expect(app.db.listActivities(conv.id).find((a) => a.runId === runId && a.id === 'ctx-connectors')?.title).toContain(only.name);
    await app.dispose();
  });

  // Drives your real Chrome (opens example.com in a new tab). Needs the Claude in Chrome extension.
  it.skipIf(!live.includes('claude'))('a Claude agent with the browser on reads a web page through Claude in Chrome', { timeout: 300_000 }, async () => {
    const app = boot(path.join(dir, 'browser-claude.sqlite'));
    const agent = app.db.createAgent({ ...base, name: 'Browser', provider: 'claude' });
    app.db.setAgentAccess(agent.id, { claudeConnectors: [], codexConnectors: null, browser: true, browserMode: 'chrome' });
    const conv = app.db.createConversation(agent);
    const { runId } = await app.runs.send(conv.id, 'Using the browser (Claude in Chrome), open https://example.com in a new tab and reply with only the main heading text on the page. Do not use any other tool to fetch it.', []);
    const approved = new Set<string>();
    const started = Date.now();
    while (app.db.getRun(runId)?.status === 'running' && Date.now() - started < 240_000) {
      for (const a of app.db.listApprovals(conv.id)) {
        if (a.status === 'pending' && !approved.has(a.id)) {
          approved.add(a.id);
          app.runs.respondApproval(a.id, 'allow');
        }
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    const run = await waitForRun(app.db, runId);
    const text = app.db.listMessages(conv.id).find((m) => m.runId === runId)!.content;
    const acts = app.db.listActivities(conv.id).filter((x) => x.runId === runId);
    if (!/example domain/i.test(text)) console.log('BROWSER RUN', run.status, run.error, text, JSON.stringify(acts.map((a) => [a.kind, a.title, a.status, (a.output ?? '').slice(0, 200)])));
    expect(run.status).toBe('completed');
    expect(acts.some((a) => /claude-in-chrome/.test(a.title) || /navigate|tabs/i.test(a.title))).toBe(true);
    expect(text).toMatch(/example domain/i);
    await app.dispose();
  });

  it.skipIf(!live.includes('codex'))('a Codex agent restricted to one connector only finds that one', { timeout: 400_000 }, async () => {
    const app = boot(path.join(dir, 'connectors-codex.sqlite'));
    const inv = await app.connectors.list('codex');
    const apps = inv.connectors.filter((c) => c.id.startsWith('app:'));
    const servers = inv.connectors.filter((c) => c.id.startsWith('server:') && c.status === 'connected' && !c.plugin);
    expect(apps.length).toBeGreaterThan(1);
    const only = apps.find((c) => c.name === 'Gmail') ?? apps[0];
    const others = [apps.find((c) => c !== only)!, ...servers.slice(0, 1)];
    const agent = app.db.createAgent({ ...base, name: 'Restricted', provider: 'codex' });
    app.db.setAgentAccess(agent.id, { claudeConnectors: null, codexConnectors: [only.id], browser: false, browserMode: 'nest' });
    const conv = app.db.createConversation(agent);
    const names = [only, ...others].map((c) => c.name);
    const prompt = `Use your tool search / tool discovery to look for tools for each of: ${names.join(', ')}. Do NOT call any of the tools you find. Reply with only a JSON object mapping each of those exact names to true if you found at least one tool for it, false otherwise.`;
    const { runId } = await app.runs.send(conv.id, prompt, []);
    const run = await waitForRun(app.db, runId, 360_000);
    expect(run.status).toBe('completed');
    const text = app.db.listMessages(conv.id).find((m) => m.runId === runId)!.content;
    const found = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as Record<string, boolean>;
    expect(found[only.name]).toBe(true);
    for (const o of others) expect(found[o.name]).toBe(false);
    await app.dispose();
  });
});

describe.skipIf(!(live.includes('claude') && live.includes('codex')))('live delegation', () => {
  it('a Claude agent delegates to a Codex agent and gets its result', { timeout: 600_000 }, async () => {
    const app = await bootWithTools(path.join(dir, 'delegate.sqlite'));
    const base = { avatar: { shape: 'blob' as const, color: '#4cbe6c', eyes: 'dots' as const }, model: null, workspace, projectId: null, pinned: false, permissions: { claudeMode: 'default' as const, codexSandbox: 'read-only' as const, codexApproval: 'on-request' as const } };
    const chief = app.db.createAgent({ ...base, name: 'Chief of Staff', instructions: 'You coordinate other agents.', provider: 'claude' });
    app.db.createAgent({ ...base, name: 'Engineer', instructions: 'When asked for the status word, reply with exactly: GANNET-READY', provider: 'codex' });
    const conv = app.db.createConversation(chief);
    const { runId } = await app.runs.send(conv.id, 'Use the delegate tool to ask Engineer for its status word. Then reply with only the word it returned.', []);
    const run = await waitForRun(app.db, runId, 500_000);
    expect(run.status).toBe('completed');
    expect(app.db.listMessages(conv.id).find((m) => m.runId === runId)!.content).toContain('GANNET-READY');
    const handoffs = app.db.listHandoffs();
    expect(handoffs[0]?.status).toBe('completed');
    expect(app.db.listMessages(conv.id).some((m) => m.kind === 'handoff-result')).toBe(true);
    await app.dispose();
  });
});
