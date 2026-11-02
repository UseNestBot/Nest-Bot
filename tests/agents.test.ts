// Schedules, Nest agent tools, and the MCP bridge, driven offline with fake CLIs.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSIONS, DEFAULT_SETTINGS, type AppSettings, type ProviderId } from '@shared/types';
import { computeNextRun, describeCadence, sanitizeCadence } from '@shared/schedule';
import { agentSystemPrompt } from '../src/main/context';
import { NestDb } from '../src/main/db';
import { NestBridge } from '../src/main/mcp/bridge';
import { NestTools } from '../src/main/mcp/tools';
import { ClaudeProvider } from '../src/main/providers/claude';
import { CodexProvider } from '../src/main/providers/codex';
import { RunManager, type ProviderRegistry } from '../src/main/runs';
import { Scheduler } from '../src/main/scheduler';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function boot() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nest-agents-'));
  const db = new NestDb(path.join(dir, 'n.sqlite'));
  const settings = (): AppSettings => ({ ...DEFAULT_SETTINGS, claudePath: path.resolve('tests/fixtures/fake-claude.mjs'), codexPath: path.resolve('tests/fixtures/fake-codex.mjs') });
  const claude = new ClaudeProvider(settings, () => {});
  const codex = new CodexProvider(settings, () => {}, () => {}, 'test');
  const registry: ProviderRegistry = { get: (id) => (id === 'claude' ? claude : codex) };
  const runs = new RunManager(db, registry, () => {}, () => path.join(dir, 'work'));
  runs.onRunFinished = (cid, run, msg) => runs.handleHandoffCompletion(cid, run, msg);
  const scheduler = new Scheduler(db, runs, () => {});
  let agentsChanged = 0;
  const tools = new NestTools(db, runs, scheduler, () => agentsChanged++);
  cleanups.push(async () => {
    scheduler.stop();
    await claude.dispose();
    await codex.dispose();
    db.close();
  });
  return { db, runs, scheduler, tools, dir, changed: () => agentsChanged };
}

const agent = (db: NestDb, name: string, provider: ProviderId = 'claude', instructions = 'Be brief.') =>
  db.createAgent({ name, avatar: { shape: 'blob', color: '#4cbe6c', eyes: 'dots' }, instructions, provider, model: null, workspace: null, projectId: null, pinned: false, permissions: DEFAULT_PERMISSIONS });

async function until<T>(fn: () => T | null | undefined | false, timeout = 15000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out');
}

describe('schedule timing', () => {
  it('computes the next run for each cadence', () => {
    const wed = new Date(2026, 10, 4, 10, 0); // Wednesday 10:00
    expect(computeNextRun({ kind: 'daily', time: '09:00' }, wed)).toEqual(new Date(2026, 10, 5, 9, 0));
    expect(computeNextRun({ kind: 'daily', time: '11:30' }, wed)).toEqual(new Date(2026, 10, 4, 11, 30));
    const fri = new Date(2026, 10, 6, 18, 0);
    expect(computeNextRun({ kind: 'weekdays', time: '08:30' }, fri)).toEqual(new Date(2026, 10, 9, 8, 30)); // Monday
    expect(computeNextRun({ kind: 'weekly', time: '09:00', weekday: 1 }, wed)).toEqual(new Date(2026, 10, 9, 9, 0));
    expect(computeNextRun({ kind: 'interval', minutes: 90 }, wed)).toEqual(new Date(2026, 10, 4, 11, 30));
  });

  it('sanitizes untrusted cadences and describes them', () => {
    expect(sanitizeCadence({ kind: 'interval', minutes: 1 })).toEqual({ kind: 'interval', minutes: 15 });
    expect(sanitizeCadence({ kind: 'weekly', time: '7:05', weekday: 9 })).toEqual({ kind: 'weekly', time: '07:05', weekday: 6 });
    expect(sanitizeCadence({ kind: 'nonsense' })).toEqual({ kind: 'daily', time: '09:00' });
    expect(describeCadence({ kind: 'weekdays', time: '08:30' })).toBe('Weekdays at 08:30');
    expect(describeCadence({ kind: 'interval', minutes: 120 })).toBe('Every 2 hours');
  });
});

describe('scheduler', () => {
  it('fires due schedules into a new conversation and reschedules', async () => {
    const a = boot();
    const bot = agent(a.db, 'Briefer');
    const s = a.scheduler.create({ agentId: bot.id, title: 'Brief', prompt: 'brief me', cadence: { kind: 'daily', time: '09:00' }, target: 'new', enabled: true });
    expect(s.nextRunAt).toBeGreaterThan(Date.now());
    a.db.updateSchedule(s.id, { nextRunAt: Date.now() - 1000 }); // missed while closed
    await a.scheduler.tick();
    const after = a.db.getSchedule(s.id)!;
    expect(after.lastConversationId).toBeTruthy();
    expect(after.nextRunAt).toBeGreaterThan(Date.now());
    const run = await until(() => a.db.listRuns(after.lastConversationId!).find((r) => r.status !== 'running'));
    expect(run.status).toBe('completed');
    expect(a.db.getConversation(after.lastConversationId!)!.title).toMatch(/^Brief · /);
  });

  it('keeps one conversation for "same" target and skips while it is busy', async () => {
    const a = boot();
    const bot = agent(a.db, 'Watcher');
    const s = a.scheduler.create({ agentId: bot.id, title: 'Watch', prompt: 'check [slow]', cadence: { kind: 'interval', minutes: 15 }, target: 'same', enabled: true });
    await a.scheduler.runNow(s.id);
    const conv = a.db.getSchedule(s.id)!.conversationId!;
    expect(a.runs.isRunning(conv)).toBe(true);
    await a.scheduler.runNow(s.id);
    expect(a.db.getSchedule(s.id)!.lastStatus).toMatch(/Skipped/);
    expect(a.db.listRuns(conv).length).toBe(1);
    await a.runs.cancel(conv);
  });

  it('rejects invalid drafts and pauses schedules whose agent is gone', async () => {
    const a = boot();
    expect(() => a.scheduler.create({ agentId: 'nope', title: 'x', prompt: 'y', cadence: { kind: 'daily', time: '09:00' }, target: 'new', enabled: true })).toThrow(/Pick an agent/);
    const bot = agent(a.db, 'Temp');
    const s = a.scheduler.create({ agentId: bot.id, title: 'T', prompt: 'p', cadence: { kind: 'daily', time: '09:00' }, target: 'new', enabled: true });
    a.db.deleteAgent(bot.id);
    await a.scheduler.runNow(s.id);
    expect(a.db.getSchedule(s.id)!.enabled).toBe(false);
  });
});

describe('agent identity', () => {
  it('puts the agent name, instructions and working folder in the system prompt', () => {
    const p = agentSystemPrompt({ name: 'Builder', instructions: 'Ship small changes.' }, 'C:\\work', true);
    expect(p).toContain('You are "Builder"');
    expect(p).toContain('Ship small changes.');
    expect(p).toContain('C:\\work');
    expect(p).toContain('get_my_profile');
  });
});

describe('Nest tools', () => {
  it('reports the calling agent’s own profile and remembers notes', async () => {
    const a = boot();
    const me = agent(a.db, 'Planner', 'claude', 'Plan carefully.');
    const conv = a.db.createConversation(me);
    const profile = JSON.parse((await a.tools.call(conv.id, 'get_my_profile', {})).text);
    expect(profile).toMatchObject({ name: 'Planner', instructions: 'Plan carefully.' });
    expect((await a.tools.call(conv.id, 'remember', { note: 'User prefers tables' })).ok).toBe(true);
    expect(a.db.memoryForAgent(me.id).map((n) => n.content)).toEqual(['User prefers tables']);
    expect((await a.tools.call(conv.id, 'remember', {})).ok).toBe(false);
  });

  it('delegates to another agent and returns its result', async () => {
    const a = boot();
    const me = agent(a.db, 'Chief of Staff');
    agent(a.db, 'Engineer', 'codex');
    const conv = a.db.createConversation(me);
    expect((await a.tools.call(conv.id, 'list_agents', {})).text).toContain('Engineer');
    const res = await a.tools.call(conv.id, 'delegate', { agent: 'engineer', task: 'build it', context: 'ctx' });
    expect(res.ok).toBe(true);
    expect(res.text).toContain('Engineer finished');
    expect(res.text).toContain('Hello there');
    expect((await a.tools.call(conv.id, 'delegate', { agent: 'Chief of Staff', task: 'x' })).text).toMatch(/yourself/);
    expect((await a.tools.call(conv.id, 'delegate', { agent: 'Nobody', task: 'x' })).ok).toBe(false);
  });

  it('asks the user before creating an agent, and respects a decline', async () => {
    const a = boot();
    const me = agent(a.db, 'Chief');
    const conv = a.db.createConversation(me);
    await a.runs.send(conv.id, 'work [slow]', []); // tools are called during a run
    const pending = a.tools.call(conv.id, 'create_agent', { name: 'Outreach', instructions: 'Find leads', provider: 'codex' });
    const approval = await until(() => a.db.listApprovals(conv.id).find((x) => x.status === 'pending'));
    expect(approval.title).toMatch(/create an agent/);
    a.runs.respondApproval(approval.id, 'allow');
    const res = await pending;
    expect(res.ok).toBe(true);
    expect(a.db.listAgents().find((x) => x.name === 'Outreach')?.provider).toBe('codex');
    expect(a.changed()).toBe(1);

    const declined = a.tools.call(conv.id, 'update_my_instructions', { instructions: 'new', reason: 'test' });
    const ap2 = await until(() => a.db.listApprovals(conv.id).find((x) => x.status === 'pending'));
    a.runs.respondApproval(ap2.id, 'deny');
    expect((await declined).ok).toBe(false);
    expect(a.db.getAgent(me.id)!.instructions).toBe('Be brief.');
    await a.runs.cancel(conv.id);
  });

  it('expires a tool approval when its run ends', async () => {
    const a = boot();
    const me = agent(a.db, 'Chief');
    const conv = a.db.createConversation(me);
    await a.runs.send(conv.id, 'work [slow]', []);
    const pending = a.tools.call(conv.id, 'create_schedule', { title: 'Brief', prompt: 'p', cadence: 'daily', time: '08:00' });
    await until(() => a.db.listApprovals(conv.id).find((x) => x.status === 'pending'));
    await a.runs.cancel(conv.id);
    expect((await pending).ok).toBe(false);
    expect(a.db.listSchedules()).toEqual([]);
    expect(a.db.listApprovals(conv.id)[0].status).toBe('expired');
  });
});

const SERVER = path.resolve('out/main/nest-mcp.mjs');

describe.skipIf(!existsSync(SERVER))('MCP server ↔ bridge', () => {
  it('serves tools/list and tools/call for the conversation it was launched for, and rejects bad tokens', async () => {
    const a = boot();
    const me = agent(a.db, 'Scout', 'claude', 'Scout ahead.');
    const conv = a.db.createConversation(me);
    const bridge = new NestBridge(a.tools, SERVER, process.execPath);
    await bridge.start();
    cleanups.push(() => bridge.stop());

    const talk = async (env: Record<string, string>) => {
      const child = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
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
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_my_profile', arguments: {} } });
      await until(() => lines.length >= 3);
      child.stdin.end();
      return lines;
    };

    const launch = bridge.launchFor(conv.id)!;
    const ok = await talk(launch.env);
    const list = ok.find((l) => l.id === 2)!.result as { tools: Array<{ name: string }> };
    expect(list.tools.map((t) => t.name)).toContain('delegate');
    const call = ok.find((l) => l.id === 3)!.result as { content: Array<{ text: string }>; isError: boolean };
    expect(call.isError).toBe(false);
    expect(JSON.parse(call.content[0].text).name).toBe('Scout');

    const bad = await talk({ ...launch.env, NEST_TOKEN: 'forged' });
    const denied = bad.find((l) => l.id === 3)!.result as { content: Array<{ text: string }>; isError: boolean };
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toMatch(/Not authorised/);
  });
});
