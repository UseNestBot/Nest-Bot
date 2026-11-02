// Scheduled runs work in a project: their chats appear there and use its folder.
// Regression: the scheduler used to create every run's chat outside any project.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSIONS, DEFAULT_SETTINGS, type AppSettings } from '@shared/types';
import { NestDb } from '../src/main/db';
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
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nest-schedproj-'));
  const db = new NestDb(path.join(dir, 'n.sqlite'));
  const settings = (): AppSettings => ({ ...DEFAULT_SETTINGS, claudePath: path.resolve('tests/fixtures/fake-claude.mjs'), codexPath: path.resolve('tests/fixtures/fake-codex.mjs') });
  const claude = new ClaudeProvider(settings, () => {});
  const codex = new CodexProvider(settings, () => {}, () => {}, 'test');
  const registry: ProviderRegistry = { get: (id) => (id === 'claude' ? claude : codex) };
  const runs = new RunManager(db, registry, () => {}, () => path.join(dir, 'default'));
  const scheduler = new Scheduler(db, runs, () => {});
  const changed: string[] = [];
  const tools = new NestTools(db, runs, scheduler, (what = 'agents') => changed.push(what));
  cleanups.push(async () => {
    scheduler.stop();
    await claude.dispose();
    await codex.dispose();
    db.close();
  });
  const gtm = db.createProject({ name: 'GTM', brief: 'Outreach', workspace: path.join(dir, 'gtm'), color: '#3b82f6' });
  const agent = (name: string, projectId: string | null) =>
    db.createAgent({ name, avatar: { shape: 'blob', color: '#4cbe6c', eyes: 'dots' }, instructions: '', provider: 'claude', model: null, workspace: null, projectId, pinned: false, permissions: DEFAULT_PERMISSIONS });
  return { db, runs, scheduler, tools, dir, gtm, agent, changed };
}

const daily = { kind: 'daily' as const, time: '08:00' };

async function nextApproval(db: NestDb, conversationId: string) {
  for (let i = 0; i < 400; i++) {
    const a = db.listApprovals(conversationId).find((x) => x.status === 'pending');
    if (a) return a;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('no approval');
}

describe('schedules and projects', () => {
  it('runs open inside the agent’s project and work in its folder', async () => {
    const a = boot();
    const pipeline = a.agent('Pipeline', a.gtm.id);
    const s = a.scheduler.create({ agentId: pipeline.id, title: 'Morning sweep', prompt: 'sweep', cadence: daily, target: 'new', enabled: true });
    expect(s.projectId).toBe(a.gtm.id);
    await a.scheduler.runNow(s.id);
    const chat = a.db.getConversation(a.db.getSchedule(s.id)!.lastConversationId!)!;
    expect(chat.projectId).toBe(a.gtm.id);
    expect(a.runs.workspaceFor(chat)).toBe(path.join(a.dir, 'gtm'));
  });

  it('honours an explicit project or none, and keeps it across edits that leave it out', async () => {
    const a = boot();
    const loner = a.agent('Loner', null);
    const s = a.scheduler.create({ agentId: loner.id, title: 'Digest', prompt: 'digest', cadence: daily, target: 'new', enabled: true, projectId: a.gtm.id });
    expect(s.projectId).toBe(a.gtm.id);
    // Pause/resume from the UI sends no projectId: the project stays.
    expect(a.scheduler.update(s.id, { agentId: loner.id, title: 'Digest', prompt: 'digest', cadence: daily, target: 'new', enabled: false }).projectId).toBe(a.gtm.id);
    expect(a.scheduler.update(s.id, { agentId: loner.id, title: 'Digest', prompt: 'digest', cadence: daily, target: 'new', enabled: true, projectId: null }).projectId).toBeNull();
    await a.scheduler.runNow(s.id);
    expect(a.db.getConversation(a.db.getSchedule(s.id)!.lastConversationId!)!.projectId).toBeNull();
  });

  it('moves a "same conversation" routine’s chat into the schedule’s project', async () => {
    const a = boot();
    const pipeline = a.agent('Pipeline', a.gtm.id);
    const s = a.scheduler.create({ agentId: pipeline.id, title: 'Pipeline', prompt: 'sweep', cadence: daily, target: 'same', enabled: true });
    await a.scheduler.runNow(s.id);
    const id = a.db.getSchedule(s.id)!.conversationId!;
    for (let i = 0; i < 400 && a.runs.isRunning(id); i++) await new Promise((r) => setTimeout(r, 25));
    a.db.updateConversation(id, { projectId: null }); // where the old scheduler left it
    await a.scheduler.runNow(s.id);
    expect(a.db.getSchedule(s.id)!.conversationId).toBe(id);
    expect(a.db.getConversation(id)!.projectId).toBe(a.gtm.id);
  });

  it('upgrades existing schedules to their agent’s project', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nest-schedmig-'));
    const file = path.join(dir, 'n.sqlite');
    const first = new NestDb(file);
    const project = first.createProject({ name: 'GTM', brief: '', workspace: null, color: '#3b82f6' });
    const agent = first.createAgent({ name: 'Pipeline', avatar: { shape: 'blob', color: '#4cbe6c', eyes: 'dots' }, instructions: '', provider: 'claude', model: null, workspace: null, projectId: project.id, pinned: false, permissions: DEFAULT_PERMISSIONS });
    const s = first.createSchedule({ agentId: agent.id, title: 'Sweep', prompt: 'sweep', cadence: daily, target: 'new', enabled: true }, null);
    // Roll the file back to before this change: no project_id column, one migration behind.
    const version = Number((first.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    first.db.exec(`ALTER TABLE schedules DROP COLUMN project_id; PRAGMA user_version = ${version - 1};`);
    first.close();
    const again = new NestDb(file);
    cleanups.push(() => again.close());
    expect(again.getSchedule(s.id)!.projectId).toBe(project.id);
  });
});

describe('schedule and project tools', () => {
  it('create_schedule and update_schedule set the project; update_project sets its folder, each with approval', async () => {
    const a = boot();
    const chief = a.agent('Chief of Staff', a.gtm.id);
    const pipeline = a.agent('Pipeline', null);
    const conv = a.db.createConversation(chief, { projectId: a.gtm.id });
    await a.runs.send(conv.id, 'work [slow]', []);

    const creating = a.tools.call(conv.id, 'create_schedule', { title: 'Sweep', prompt: 'sweep', cadence: 'weekdays', time: '08:00', agent: 'Pipeline', project: 'GTM' });
    const card = await nextApproval(a.db, conv.id);
    expect(card.target).toContain('in GTM');
    a.runs.respondApproval(card.id, 'allow');
    expect((await creating).ok).toBe(true);
    const s = a.db.listSchedules().find((x) => x.title === 'Sweep')!;
    expect(s.projectId).toBe(a.gtm.id);
    expect(s.agentId).toBe(pipeline.id);

    expect((await a.tools.call(conv.id, 'update_schedule', { schedule: 'Sweep', project: 'Nope' })).text).toMatch(/No project named/);
    expect((await a.tools.call(conv.id, 'update_schedule', { schedule: 'Missing' })).text).toMatch(/No schedule named/);
    const moving = a.tools.call(conv.id, 'update_schedule', { schedule: 'sweep', project: 'none' });
    a.runs.respondApproval((await nextApproval(a.db, conv.id)).id, 'allow');
    expect((await moving).ok).toBe(true);
    expect(a.db.getSchedule(s.id)!.projectId).toBeNull();
    expect((await a.tools.call(conv.id, 'list_schedules', {})).text).toContain('works in no project');

    const folder = path.join(a.dir, 'gtm-shared');
    expect((await a.tools.call(conv.id, 'update_project', { folder: path.join('relative', 'path') })).ok).toBe(false);
    const declined = a.tools.call(conv.id, 'update_project', { folder });
    a.runs.respondApproval((await nextApproval(a.db, conv.id)).id, 'deny');
    expect((await declined).ok).toBe(false);
    expect(a.db.getProject(a.gtm.id)!.workspace).toBe(path.join(a.dir, 'gtm'));
    const approved = a.tools.call(conv.id, 'update_project', { project: 'gtm', folder });
    a.runs.respondApproval((await nextApproval(a.db, conv.id)).id, 'allow');
    expect((await approved).ok).toBe(true);
    expect(a.db.getProject(a.gtm.id)!.workspace).toBe(folder);
    expect(a.changed).toContain('projects');
    await a.runs.cancel(conv.id);
  });
});
