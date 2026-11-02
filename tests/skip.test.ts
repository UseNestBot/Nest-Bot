// "Skip permissions": opt-in, enforced at run time, mapped to each provider's own modes.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSIONS, DEFAULT_SETTINGS, effectivePermissions, resolveSkip, type AppSettings, type ProviderId } from '@shared/types';
import { NestDb } from '../src/main/db';
import { NestTools } from '../src/main/mcp/tools';
import { ClaudeProvider } from '../src/main/providers/claude';
import { CodexProvider } from '../src/main/providers/codex';
import { RunManager, type ProviderRegistry } from '../src/main/runs';
import { Scheduler } from '../src/main/scheduler';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function boot(allowSkipPermissions: boolean, skipPermissionsByDefault = false) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nest-skip-'));
  const db = new NestDb(path.join(dir, 'n.sqlite'));
  const settings = (): AppSettings => ({
    ...DEFAULT_SETTINGS,
    allowSkipPermissions,
    claudePath: path.resolve('tests/fixtures/fake-claude.mjs'),
    codexPath: path.resolve('tests/fixtures/fake-codex.mjs'),
  });
  db.updateSettings({ allowSkipPermissions, skipPermissionsByDefault });
  const claude = new ClaudeProvider(settings, () => {});
  const codex = new CodexProvider(settings, () => {}, () => {}, 'test');
  const registry: ProviderRegistry = { get: (id) => (id === 'claude' ? claude : codex) };
  const runs = new RunManager(db, registry, () => {}, () => path.join(dir, 'work'));
  const tools = new NestTools(db, runs, new Scheduler(db, runs, () => {}), () => {});
  cleanups.push(async () => {
    await claude.dispose();
    await codex.dispose();
    db.close();
  });
  return { db, runs, tools };
}

function conversation(db: NestDb, provider: ProviderId, skip: boolean | undefined) {
  const agent = db.createAgent({
    name: `Agent ${provider}`,
    avatar: { shape: 'blob', color: '#4cbe6c', eyes: 'dots' },
    instructions: '',
    provider,
    model: null,
    workspace: null,
    projectId: null,
    pinned: false,
    permissions: skip === undefined ? DEFAULT_PERMISSIONS : { ...DEFAULT_PERMISSIONS, skipPermissions: skip },
  });
  return db.createConversation(agent);
}

async function finish(db: NestDb, runId: string) {
  for (let i = 0; i < 600; i++) {
    const run = db.getRun(runId);
    if (run && run.status !== 'running') return run;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('run did not finish');
}

const reply = (db: NestDb, cid: string, runId: string) => db.listMessages(cid).find((m) => m.runId === runId)!.content;

describe('resolveSkip / effectivePermissions', () => {
  const allow = { allowSkipPermissions: true, skipPermissionsByDefault: false };
  it('maps skip to each provider’s bypass modes', () => {
    expect(effectivePermissions(DEFAULT_PERMISSIONS, true)).toEqual({ claudeMode: 'bypassPermissions', codexSandbox: 'danger-full-access', codexApproval: 'never', skipped: true });
    expect(effectivePermissions(DEFAULT_PERMISSIONS, false)).toMatchObject({ claudeMode: 'default', codexSandbox: 'workspace-write', codexApproval: 'on-request', skipped: false });
  });
  it('resolves conversation → agent → global default, and never without the master switch', () => {
    const skip = { ...DEFAULT_PERMISSIONS, skipPermissions: true };
    const ask = { ...DEFAULT_PERMISSIONS, skipPermissions: false };
    expect(resolveSkip(DEFAULT_PERMISSIONS, skip, allow)).toBe(true); // agent says skip
    expect(resolveSkip(ask, skip, allow)).toBe(false); // conversation overrides agent
    expect(resolveSkip(DEFAULT_PERMISSIONS, DEFAULT_PERMISSIONS, allow)).toBe(false);
    expect(resolveSkip(DEFAULT_PERMISSIONS, DEFAULT_PERMISSIONS, { ...allow, skipPermissionsByDefault: true })).toBe(true);
    expect(resolveSkip(DEFAULT_PERMISSIONS, ask, { ...allow, skipPermissionsByDefault: true })).toBe(false); // agent "always ask"
    expect(resolveSkip(skip, skip, { allowSkipPermissions: false, skipPermissionsByDefault: true })).toBe(false);
  });
});

describe('skip permissions through RunManager', () => {
  it('launches Claude Code with bypassPermissions only when Settings allows it', async () => {
    for (const [allow, expected] of [[true, 'bypassPermissions'], [false, 'default']] as const) {
      const a = boot(allow);
      const conv = conversation(a.db, 'claude', true);
      const { runId } = await a.runs.send(conv.id, 'which mode [perms]', []);
      await finish(a.db, runId);
      expect(reply(a.db, conv.id, runId)).toBe(`perms:${expected}`);
      expect(a.db.listActivities(conv.id).some((x) => x.id === 'ctx-skip')).toBe(allow);
    }
  });

  it('starts Codex threads with full access and no approvals when skipping', async () => {
    const a = boot(true);
    const conv = conversation(a.db, 'codex', true);
    const { runId } = await a.runs.send(conv.id, 'which mode [perms]', []);
    await finish(a.db, runId);
    expect(reply(a.db, conv.id, runId)).toBe('perms:danger-full-access/never');

    const normal = conversation(a.db, 'codex', false);
    const second = await a.runs.send(normal.id, 'which mode [perms]', []);
    await finish(a.db, second.runId);
    expect(reply(a.db, normal.id, second.runId)).toBe('perms:workspace-write/on-request');
  });

  it('answers a provider approval request automatically, leaving nothing pending', async () => {
    const a = boot(true);
    const conv = conversation(a.db, 'claude', true);
    const { runId } = await a.runs.send(conv.id, 'do it [approval]', []);
    const run = await finish(a.db, runId);
    expect(run.status).toBe('completed');
    expect(reply(a.db, conv.id, runId)).toContain('decision:allow');
    expect(a.db.listApprovals(conv.id)).toEqual([]);
    expect(a.db.listActivities(conv.id).some((x) => x.title.startsWith('Auto-approved'))).toBe(true);
  });

  it('auto-approves Nest tool requests while skipping, but always asks before changing agents', async () => {
    const a = boot(true);
    const conv = conversation(a.db, 'claude', true);
    await a.runs.send(conv.id, 'work [slow]', []);
    const shared = await a.tools.call(conv.id, 'remember', { note: 'Ship on Fridays', shared: true });
    expect(shared.ok).toBe(true);
    expect(a.db.listApprovals(conv.id)).toHaveLength(0);

    // Skipping must not spread to other agents: creating one still asks.
    const pending = a.tools.call(conv.id, 'create_agent', { name: 'Helper', instructions: 'Help.' });
    const approval = await pendingApproval(a.db, conv.id);
    expect(approval.title).toMatch(/create an agent/);
    a.runs.respondApproval(approval.id, 'allow');
    expect((await pending).ok).toBe(true);
    expect(a.db.listAgents().some((x) => x.name === 'Helper')).toBe(true);
    await a.runs.cancel(conv.id);

    const careful = conversation(a.db, 'claude', false);
    await a.runs.send(careful.id, 'work [slow]', []);
    const remembered = a.tools.call(careful.id, 'remember', { note: 'x', shared: true });
    expect((await pendingApproval(a.db, careful.id)).status).toBe('pending');
    await a.runs.cancel(careful.id);
    expect((await remembered).ok).toBe(false);
  });

  it('skips by default for agents with no choice of their own, but not those set to always ask', async () => {
    const a = boot(true, true);
    const free = conversation(a.db, 'claude', undefined);
    const r1 = await a.runs.send(free.id, 'which mode [perms]', []);
    await finish(a.db, r1.runId);
    expect(reply(a.db, free.id, r1.runId)).toBe('perms:bypassPermissions');
    const careful = conversation(a.db, 'claude', false);
    const r2 = await a.runs.send(careful.id, 'which mode [perms]', []);
    await finish(a.db, r2.runId);
    expect(reply(a.db, careful.id, r2.runId)).toBe('perms:default');
  });

  it('existing conversations follow later changes to their agent', async () => {
    const a = boot(true);
    const conv = conversation(a.db, 'claude', undefined);
    const r1 = await a.runs.send(conv.id, 'which mode [perms]', []);
    await finish(a.db, r1.runId);
    expect(reply(a.db, conv.id, r1.runId)).toBe('perms:default');
    const agent = a.db.getAgent(conv.agentId)!;
    const { id: _i, createdAt: _c, updatedAt: _u, ...draft } = agent;
    a.db.updateAgent(agent.id, { ...draft, permissions: { ...agent.permissions, skipPermissions: true } });
    const r2 = await a.runs.send(conv.id, 'which mode [perms]', []);
    await finish(a.db, r2.runId);
    expect(reply(a.db, conv.id, r2.runId)).toBe('perms:bypassPermissions');
  });

  it('update_agent sets another agent’s permissions, asking even when the caller skips', async () => {
    const a = boot(true);
    const chief = conversation(a.db, 'claude', true);
    const target = conversation(a.db, 'codex', undefined);
    const targetAgent = a.db.getAgent(target.agentId)!;
    await a.runs.send(chief.id, 'work [slow]', []);
    const approved = async (args: Record<string, unknown>) => {
      const pending = a.tools.call(chief.id, 'update_agent', args);
      a.runs.respondApproval((await pendingApproval(a.db, chief.id)).id, 'allow');
      return pending;
    };
    const res = await approved({ agent: targetAgent.name, skip_permissions: true, reason: 'user asked' });
    expect(res.ok).toBe(true);
    expect(a.db.getAgent(targetAgent.id)!.permissions.skipPermissions).toBe(true);
    const reset = await approved({ agent: targetAgent.name, skip_permissions: 'default' });
    expect(reset.ok).toBe(true);
    expect(a.db.getAgent(targetAgent.id)!.permissions.skipPermissions).toBeUndefined();
    await a.runs.cancel(chief.id);
  });

  it('update_agent refuses to grant skipping when Settings does not allow it', async () => {
    const a = boot(false);
    const chief = conversation(a.db, 'claude', undefined);
    const other = conversation(a.db, 'codex', undefined);
    await a.runs.send(chief.id, 'work [slow]', []);
    const res = await a.tools.call(chief.id, 'update_agent', { agent: a.db.getAgent(other.agentId)!.name, skip_permissions: true });
    expect(res.ok).toBe(false);
    expect(res.text).toMatch(/Allow skipping permissions/);
    await a.runs.cancel(chief.id);
  });

  it('ask_permission shows a card even while skipping, and reports the answer', async () => {
    const a = boot(true);
    const conv = conversation(a.db, 'claude', true);
    await a.runs.send(conv.id, 'work [slow]', []);
    const pending = a.tools.call(conv.id, 'ask_permission', { action: 'Send 12 emails to prospects', reason: 'campaign' });
    let approval;
    for (let i = 0; i < 200 && !approval; i++) {
      approval = a.db.listApprovals(conv.id).find((x) => x.status === 'pending');
      if (!approval) await new Promise((r) => setTimeout(r, 25));
    }
    expect(approval?.action).toBe('Send 12 emails to prospects');
    a.runs.respondApproval(approval!.id, 'deny');
    expect((await pending).text).toMatch(/declined/);
    await a.runs.cancel(conv.id);
  });
});

/** The conversation's pending approval card, once it appears. */
async function pendingApproval(db: NestDb, conversationId: string) {
  for (let i = 0; i < 200; i++) {
    const found = db.listApprovals(conversationId).find((x) => x.status === 'pending');
    if (found) return found;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('No pending approval appeared');
}
