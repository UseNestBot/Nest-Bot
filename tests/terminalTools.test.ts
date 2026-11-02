// The shared terminal as the agent sees it: opt-in per agent, and asking before
// commands even when permissions are skipped unless the user turns that off.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_ACCESS, DEFAULT_PERMISSIONS, DEFAULT_SETTINGS, type AppSettings } from '@shared/types';
import { sanitizeAccess } from '../src/main/connectors';
import { NestDb } from '../src/main/db';
import { NestTools, TERMINAL_TOOL_DEFS, type TerminalTools } from '../src/main/mcp/tools';
import { ClaudeProvider } from '../src/main/providers/claude';
import { CodexProvider } from '../src/main/providers/codex';
import { keepTerminalAccess } from '../src/main/remote/server';
import { RunManager, type ProviderRegistry } from '../src/main/runs';
import { Scheduler } from '../src/main/scheduler';
import { sanitizeSettings } from '../src/main/settings';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

class FakeTerminal implements TerminalTools {
  calls: string[] = [];
  async run(_c: string, command: string) {
    this.calls.push(`run ${command}`);
    return { ok: true, text: 'Exit code 0\n\nok' };
  }
  read() {
    this.calls.push('read');
    return 'Idle at the prompt.';
  }
  sendKeys(_c: string, keys: string) {
    this.calls.push(`keys ${JSON.stringify(keys)}`);
    return 'Sent.';
  }
}

function boot(opts: { skip: boolean; terminal: boolean; alwaysAsk?: boolean }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nest-termtools-'));
  const db = new NestDb(path.join(dir, 'n.sqlite'));
  db.updateSettings({ allowSkipPermissions: true, skipPermissionsByDefault: opts.skip, ...(opts.alwaysAsk === undefined ? {} : { terminalAlwaysAsk: opts.alwaysAsk }) });
  const settings = (): AppSettings => ({ ...DEFAULT_SETTINGS, claudePath: path.resolve('tests/fixtures/fake-claude.mjs'), codexPath: path.resolve('tests/fixtures/fake-codex.mjs') });
  const claude = new ClaudeProvider(settings, () => {});
  const codex = new CodexProvider(settings, () => {}, () => {}, 'test');
  const registry = { get: (id: string) => (id === 'claude' ? claude : codex) } as unknown as ProviderRegistry;
  const runs = new RunManager(db, registry, () => {}, () => path.join(dir, 'work'));
  const term = new FakeTerminal();
  const tools = new NestTools(db, runs, new Scheduler(db, runs, () => {}), () => {}, undefined, { host: term, enabledFor: (id) => db.getAgentAccess(id).terminal });
  const agent = db.createAgent({ name: 'Builder', avatar: { shape: 'blob', color: '#4cbe6c', eyes: 'dots' }, instructions: '', provider: 'claude', model: null, workspace: null, projectId: null, pinned: false, permissions: DEFAULT_PERMISSIONS });
  if (opts.terminal) db.setAgentAccess(agent.id, { ...db.getAgentAccess(agent.id), terminal: true });
  const conv = db.createConversation(agent);
  cleanups.push(async () => {
    await claude.dispose();
    await codex.dispose();
    db.close();
  });
  return { db, runs, tools, term, agent, conv };
}

async function pendingApproval(db: NestDb, conversationId: string) {
  for (let i = 0; i < 200; i++) {
    const a = db.listApprovals(conversationId).find((x) => x.status === 'pending');
    if (a) return a;
    await new Promise((r) => setTimeout(r, 25));
  }
  return undefined;
}

describe('terminal tools', () => {
  it('are off by default and only listed for agents that have the terminal turned on', async () => {
    expect(DEFAULT_AGENT_ACCESS.terminal).toBe(false);
    expect(sanitizeAccess({}).terminal).toBe(false);
    expect(sanitizeAccess({ terminal: 'yes' as unknown as boolean }).terminal).toBe(false);
    const names = TERMINAL_TOOL_DEFS.map((t) => t.name);

    const off = boot({ skip: true, terminal: false });
    expect(off.tools.listFor(off.conv.id).map((t) => t.name)).not.toEqual(expect.arrayContaining([names[0]]));
    const refused = await off.tools.call(off.conv.id, 'terminal_run', { command: 'echo hi' });
    expect(refused.ok).toBe(false);
    expect(refused.text).toMatch(/turned off/);
    expect(off.term.calls).toEqual([]);

    const on = boot({ skip: true, terminal: true });
    expect(on.tools.listFor(on.conv.id).map((t) => t.name)).toEqual(expect.arrayContaining(names));
  });

  it('asks before a command even when the agent skips permissions (the default)', async () => {
    const a = boot({ skip: true, terminal: true });
    expect(a.db.getSettings().terminalAlwaysAsk).toBe(true);
    await a.runs.send(a.conv.id, 'work [slow]', []);
    const pending = a.tools.call(a.conv.id, 'terminal_run', { command: 'rm -rf build' });
    const approval = await pendingApproval(a.db, a.conv.id);
    expect(approval?.action).toBe('rm -rf build');
    a.runs.respondApproval(approval!.id, 'deny');
    expect((await pending).ok).toBe(false);
    expect(a.term.calls).toEqual([]);
    // Reading and Ctrl-C never ask.
    expect((await a.tools.call(a.conv.id, 'terminal_read', {})).ok).toBe(true);
    expect((await a.tools.call(a.conv.id, 'terminal_send_keys', { keys: '\u0003' })).ok).toBe(true);
    expect(a.term.calls).toEqual(['read', `keys ${JSON.stringify('\u0003')}`]);
    await a.runs.cancel(a.conv.id);
  });

  it('runs unasked only when the user turned "always ask" off and the agent skips permissions', async () => {
    const skipping = boot({ skip: true, terminal: true, alwaysAsk: false });
    await skipping.runs.send(skipping.conv.id, 'work [slow]', []);
    expect((await skipping.tools.call(skipping.conv.id, 'terminal_run', { command: 'npm test' })).ok).toBe(true);
    expect(skipping.term.calls).toEqual(['run npm test']);
    await skipping.runs.cancel(skipping.conv.id);

    const asking = boot({ skip: false, terminal: true, alwaysAsk: false });
    await asking.runs.send(asking.conv.id, 'work [slow]', []);
    const pending = asking.tools.call(asking.conv.id, 'terminal_run', { command: 'npm test' });
    const approval = await pendingApproval(asking.db, asking.conv.id);
    expect(approval).toBeDefined();
    asking.runs.respondApproval(approval!.id, 'allow');
    expect((await pending).ok).toBe(true);
    await asking.runs.cancel(asking.conv.id);
  });

  it('a paired phone can’t change terminal access or the always-ask setting', () => {
    const current = () => ({ ...DEFAULT_AGENT_ACCESS, terminal: false });
    const [, access] = keepTerminalAccess(['a1', { ...DEFAULT_AGENT_ACCESS, browser: true, terminal: true }], current) as [string, typeof DEFAULT_AGENT_ACCESS];
    expect(access).toMatchObject({ browser: true, terminal: false });
    expect(sanitizeSettings({ terminalAlwaysAsk: false })).toEqual({ terminalAlwaysAsk: false });
  });
});
