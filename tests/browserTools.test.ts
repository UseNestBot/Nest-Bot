// Nest's built-in agent browser, as seen through the agent tools and the MCP server.
// The real browser needs Electron; here a fake stands in for AgentBrowserHost.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSIONS, DEFAULT_SETTINGS, type AppSettings } from '@shared/types';
import { NestDb } from '../src/main/db';
import { NestBridge } from '../src/main/mcp/bridge';
import { BROWSER_TOOL_DEFS, NestTools, type BrowserTools } from '../src/main/mcp/tools';
import { ClaudeProvider } from '../src/main/providers/claude';
import { CodexProvider } from '../src/main/providers/codex';
import { RunManager, type ProviderRegistry } from '../src/main/runs';
import { Scheduler } from '../src/main/scheduler';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

class FakeBrowser implements BrowserTools {
  calls: string[] = [];
  async open(agentId: string, url: string) {
    this.calls.push(`open ${agentId} ${url}`);
    return `URL: ${url}\nInteractive elements:\n[1] button “Sign in”`;
  }
  async snapshot(agentId: string) {
    this.calls.push(`snapshot ${agentId}`);
    return 'URL: https://example.com';
  }
  async click(agentId: string, ref: number) {
    this.calls.push(`click ${agentId} ${ref}`);
    return 'clicked';
  }
  async type(agentId: string, ref: number, text: string, submit: boolean) {
    this.calls.push(`type ${agentId} ${ref} ${text} ${submit}`);
    return 'typed';
  }
  async scroll() {
    return 'scrolled';
  }
  async history() {
    return 'moved';
  }
  async screenshot() {
    return { data: Buffer.from('fake-jpeg').toString('base64'), mimeType: 'image/jpeg' };
  }
}

function boot(skip: boolean, browserFor: (agentId: string) => boolean = () => true) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nest-browser-'));
  const db = new NestDb(path.join(dir, 'n.sqlite'));
  db.updateSettings({ allowSkipPermissions: true, skipPermissionsByDefault: skip });
  const settings = (): AppSettings => ({ ...DEFAULT_SETTINGS, claudePath: path.resolve('tests/fixtures/fake-claude.mjs'), codexPath: path.resolve('tests/fixtures/fake-codex.mjs') });
  const claude = new ClaudeProvider(settings, () => {});
  const codex = new CodexProvider(settings, () => {}, () => {}, 'test');
  const registry = { get: (id: string) => (id === 'claude' ? claude : codex) } as unknown as ProviderRegistry;
  const runs = new RunManager(db, registry, () => {}, () => path.join(dir, 'work'));
  const browser = new FakeBrowser();
  const tools = new NestTools(db, runs, new Scheduler(db, runs, () => {}), () => {}, { host: browser, enabledFor: browserFor });
  const agent = db.createAgent({ name: 'Scout', avatar: { shape: 'blob', color: '#4cbe6c', eyes: 'dots' }, instructions: '', provider: 'claude', model: null, workspace: null, projectId: null, pinned: false, permissions: DEFAULT_PERMISSIONS });
  const conv = db.createConversation(agent);
  cleanups.push(async () => {
    await claude.dispose();
    await codex.dispose();
    db.close();
  });
  return { db, runs, tools, browser, agent, conv };
}

describe('agent browser tools', () => {
  it('are listed only for agents whose browser is set to the Nest browser', () => {
    const on = boot(true, () => true);
    expect(on.tools.listFor(on.conv.id).map((t) => t.name)).toEqual(expect.arrayContaining(BROWSER_TOOL_DEFS.map((t) => t.name)));
    const off = boot(true, () => false);
    expect(off.tools.listFor(off.conv.id).some((t) => t.name.startsWith('browser_'))).toBe(false);
  });

  it('drive the agent’s own browser (keyed by agent), and refuse when the browser is off', async () => {
    const a = boot(true);
    await a.runs.send(a.conv.id, 'work [slow]', []);
    const opened = await a.tools.call(a.conv.id, 'browser_open', { url: 'https://example.com' });
    expect(opened.ok).toBe(true);
    expect(opened.text).toContain('[1] button');
    expect((await a.tools.call(a.conv.id, 'browser_click', { ref: 1 })).ok).toBe(true);
    expect((await a.tools.call(a.conv.id, 'browser_type', { ref: 2, text: 'hello', submit: true })).ok).toBe(true);
    expect(a.browser.calls).toEqual([`open ${a.agent.id} https://example.com`, `click ${a.agent.id} 1`, `type ${a.agent.id} 2 hello true`]);
    const shot = await a.tools.call(a.conv.id, 'browser_screenshot', {});
    expect(shot.image?.mimeType).toBe('image/jpeg');
    await a.runs.cancel(a.conv.id);

    const off = boot(true, () => false);
    const res = await off.tools.call(off.conv.id, 'browser_open', { url: 'https://example.com' });
    expect(res.ok).toBe(false);
    expect(res.text).toMatch(/turned off/);
  });

  it('asks before clicking or typing when the agent is not skipping permissions', async () => {
    const a = boot(false);
    await a.runs.send(a.conv.id, 'work [slow]', []);
    expect((await a.tools.call(a.conv.id, 'browser_open', { url: 'https://example.com' })).ok).toBe(true); // reading is free
    const pending = a.tools.call(a.conv.id, 'browser_click', { ref: 1 });
    let approval;
    for (let i = 0; i < 200 && !approval; i++) {
      approval = a.db.listApprovals(a.conv.id).find((x) => x.status === 'pending');
      if (!approval) await new Promise((r) => setTimeout(r, 25));
    }
    expect(approval?.title).toMatch(/click in its browser/);
    a.runs.respondApproval(approval!.id, 'deny');
    expect((await pending).ok).toBe(false);
    expect(a.browser.calls.some((c) => c.startsWith('click'))).toBe(false);
    await a.runs.cancel(a.conv.id);
  });
});

const SERVER = path.resolve('out/main/nest-mcp.mjs');

describe.skipIf(!existsSync(SERVER))('browser tools over MCP', () => {
  it('lists browser tools per conversation and returns screenshots as MCP image content', async () => {
    const a = boot(true);
    const bridge = new NestBridge(a.tools, SERVER, process.execPath);
    await bridge.start();
    cleanups.push(() => bridge.stop());
    await a.runs.send(a.conv.id, 'work [slow]', []);
    cleanups.push(() => a.runs.cancel(a.conv.id));
    const launch = bridge.launchFor(a.conv.id)!;
    const child = spawn(process.execPath, [SERVER], { env: { ...process.env, ...launch.env }, stdio: ['pipe', 'pipe', 'inherit'] });
    const lines: Array<Record<string, unknown>> = [];
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        lines.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
    });
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_screenshot', arguments: {} } });
    for (let i = 0; i < 200 && lines.length < 3; i++) await new Promise((r) => setTimeout(r, 25));
    child.stdin.end();
    const tools = (lines.find((l) => l.id === 2)!.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(tools).toContain('browser_open');
    const content = (lines.find((l) => l.id === 3)!.result as { content: Array<{ type: string; mimeType?: string }> }).content;
    expect(content.map((c) => c.type)).toEqual(['text', 'image']);
    expect(content[1].mimeType).toBe('image/jpeg');
  });
});
