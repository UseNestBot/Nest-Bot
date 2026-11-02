// Projects (bot families): migration from agent groups, shared memory, prompts and the project tools.
import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSIONS, type ProviderId } from '@shared/types';
import { agentSystemPrompt } from '../src/main/context';
import { NestDb } from '../src/main/db';
import { NestTools } from '../src/main/mcp/tools';
import type { RunManager } from '../src/main/runs';
import type { Scheduler } from '../src/main/scheduler';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const tmpFile = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'nest-projects-')), 'n.sqlite');

function open(file = tmpFile()) {
  const db = new NestDb(file);
  cleanups.push(() => db.close());
  return db;
}

const agent = (db: NestDb, name: string, projectId: string | null = null, provider: ProviderId = 'claude', instructions = 'Be brief.') =>
  db.createAgent({ name, avatar: { shape: 'blob', color: '#4cbe6c', eyes: 'dots' }, instructions, provider, model: null, workspace: null, projectId, pinned: false, permissions: DEFAULT_PERMISSIONS });

const project = (db: NestDb, name: string, brief = '') => db.createProject({ name, brief, workspace: null, color: '#3b82f6' });

describe('projects', () => {
  it('turns existing agent groups into projects when upgrading', () => {
    const file = tmpFile();
    const first = new NestDb(file);
    const a = agent(first, 'Writer');
    const b = agent(first, 'Editor');
    agent(first, 'Loner');
    first.close();
    // Roll the file back to the schema before projects, with two agents in the "Launch" group.
    const raw = new DatabaseSync(file);
    raw.exec('DROP TABLE projects; ALTER TABLE agents DROP COLUMN project_id; ALTER TABLE memory_notes DROP COLUMN project_id; ALTER TABLE conversations DROP COLUMN project_id; ALTER TABLE schedules DROP COLUMN project_id; PRAGMA user_version = 4;');
    raw.prepare(`UPDATE agents SET group_name = ' Launch ' WHERE id IN (?, ?)`).run(a.id, b.id);
    raw.close();

    const db = open(file);
    const projects = db.listProjects();
    expect(projects.map((p) => p.name)).toEqual(['Launch']);
    expect(db.projectMembers(projects[0].id).map((x) => x.name)).toEqual(['Editor', 'Writer']);
    expect(db.listAgents().find((x) => x.name === 'Loner')!.projectId).toBeNull();
  });

  it('repairs a database whose version came from another build and skipped a migration', () => {
    const file = tmpFile();
    const first = new NestDb(file);
    const p = project(first, 'Launch');
    const a = agent(first, 'Writer', p.id);
    const chat = first.createConversation(a, { projectId: p.id });
    first.close();
    // Another branch's build numbered its migrations differently: version 7, but no conversations.project_id.
    const raw = new DatabaseSync(file);
    raw.exec('ALTER TABLE conversations DROP COLUMN project_id; DROP TABLE schedules; PRAGMA user_version = 7;');
    raw.close();

    const db = open(file);
    expect(db.getConversation(chat.id)!.projectId).toBe(p.id);
    expect(db.createConversation(a).agentId).toBe(a.id);
    expect(db.listSchedules()).toEqual([]);
  });

  it('gives members the project memory, and only them', () => {
    const db = open();
    const p = project(db, 'Launch');
    const writer = agent(db, 'Writer', p.id);
    const outsider = agent(db, 'Outsider');
    db.createMemory('project', p.id, 'Launch is on Friday');
    db.createMemory('shared', null, 'User is in Lisbon');
    db.createMemory('agent', writer.id, 'Writer uses British spelling');
    expect(db.memoryForAgent(writer.id).map((n) => n.content)).toEqual(['User is in Lisbon', 'Launch is on Friday', 'Writer uses British spelling']);
    expect(db.memoryForAgent(outsider.id).map((n) => n.content)).toEqual(['User is in Lisbon']);

    // Moving an agent in or out changes what it receives.
    db.setAgentProject(outsider.id, p.id);
    expect(db.memoryForAgent(outsider.id).map((n) => n.content)).toContain('Launch is on Friday');
    db.setAgentProject(outsider.id, null);
    expect(db.memoryForAgent(outsider.id).map((n) => n.content)).not.toContain('Launch is on Friday');
    // An unknown project id is not stored.
    expect(db.setAgentProject(outsider.id, 'nope').projectId).toBeNull();
  });

  it('keeps the agents and chats when a project is deleted, but drops its notes', () => {
    const db = open();
    const p = project(db, 'Launch');
    const writer = agent(db, 'Writer', p.id);
    const chat = db.createConversation(writer, { projectId: p.id });
    db.createMemory('project', p.id, 'Launch is on Friday');
    db.deleteProject(p.id);
    expect(db.listProjects()).toEqual([]);
    expect(db.getAgent(writer.id)!.projectId).toBeNull();
    expect(db.getConversation(chat.id)!.projectId).toBeNull();
    expect(db.listMemory()).toEqual([]);
  });

  it('lets one agent work in several projects through its chats', () => {
    const db = open();
    const gtm = project(db, 'GTM');
    const hiring = project(db, 'Hiring');
    const chief = agent(db, 'Chief of Staff', gtm.id);
    const recruiter = agent(db, 'Recruiter', hiring.id);
    db.createMemory('project', gtm.id, 'GTM launches in March');
    db.createMemory('project', hiring.id, 'Hiring two engineers');

    // New chats start outside any project, even for an agent that belongs to one.
    expect(db.createConversation(chief).projectId).toBeNull();
    const home = db.createConversation(chief, { projectId: gtm.id });
    const away = db.createConversation(chief, { projectId: hiring.id });
    const loose = db.createConversation(chief, { projectId: null });
    expect([home.projectId, away.projectId, loose.projectId]).toEqual([gtm.id, hiring.id, null]);

    // Each chat gets its own project's notes; the agent appears in both projects.
    expect(db.memoryForAgent(chief.id, away.projectId).map((n) => n.content)).toEqual(['Hiring two engineers']);
    expect(db.memoryForAgent(chief.id, home.projectId).map((n) => n.content)).toEqual(['GTM launches in March']);
    expect(db.memoryForAgent(chief.id, null)).toEqual([]);
    expect(db.projectMembers(hiring.id).map((a) => a.name)).toEqual(['Chief of Staff', 'Recruiter']);
    expect(db.projectMembers(gtm.id).map((a) => a.name)).toEqual(['Chief of Staff']);

    // Moving a chat moves only that chat.
    db.updateConversation(loose.id, { projectId: gtm.id });
    expect(db.getConversation(loose.id)!.projectId).toBe(gtm.id);
    expect(db.getAgent(chief.id)!.projectId).toBe(gtm.id);
    expect(db.getConversation(away.id)!.projectId).toBe(hiring.id);
    expect(db.getAgent(recruiter.id)!.projectId).toBe(hiring.id);
  });

  it('puts existing chats in their agent’s project when upgrading', () => {
    const file = tmpFile();
    const first = new NestDb(file);
    const p = project(first, 'GTM');
    const chief = agent(first, 'Chief of Staff', p.id);
    const chat = first.createConversation(chief);
    const lonely = first.createConversation(agent(first, 'Loner'));
    first.close();
    const raw = new DatabaseSync(file);
    raw.exec('ALTER TABLE conversations DROP COLUMN project_id; ALTER TABLE schedules DROP COLUMN project_id; PRAGMA user_version = 5;');
    raw.close();

    const db = open(file);
    expect(db.getConversation(chat.id)!.projectId).toBe(p.id);
    expect(db.getConversation(lonely.id)!.projectId).toBeNull();
  });

  it('tells members about the project, its brief and their teammates', () => {
    const team = { name: 'Launch', brief: 'Ship the pricing page by Friday.', teammates: [{ name: 'Editor', provider: 'Codex', role: 'Edits copy' }] };
    const p = agentSystemPrompt({ name: 'Writer', instructions: 'Write copy.' }, 'C:\\work\\Launch', true, false, team);
    expect(p).toContain('This chat is part of the "Launch" project');
    expect(p).toContain('Ship the pricing page by Friday.');
    expect(p).toContain('- Editor (Codex): Edits copy');
    expect(p).toContain('get_project');
    expect(agentSystemPrompt({ name: 'Writer', instructions: '' }, 'C:\\w', true)).not.toContain('part of the');
  });
});

describe('project tools', () => {
  // Project notes ask the user first; these tests approve.
  const approve = { requestLocalApproval: async () => 'allow' } as unknown as RunManager;
  const tools = (db: NestDb, runs = approve) => new NestTools(db, runs, {} as Scheduler, () => {});

  it('shows the project, lists teammates first, and remembers for the whole project', async () => {
    const db = open();
    const p = project(db, 'Launch', 'Ship it.');
    const writer = agent(db, 'Writer', p.id);
    const editor = agent(db, 'Editor', p.id, 'codex', 'Edits copy');
    agent(db, 'Accountant', null, 'claude', 'Does the books');
    const mine = db.createConversation(writer, { projectId: p.id });
    const theirs = db.createConversation(editor, { projectId: p.id });
    db.insertMessage({ conversationId: theirs.id, runId: null, role: 'assistant', kind: 'chat', content: 'Draft 2 is in draft.md', status: 'complete', error: null, attachments: [], linkConversationId: null });
    const t = tools(db);

    const info = JSON.parse((await t.call(mine.id, 'get_project', {})).text);
    expect(info).toMatchObject({ name: 'Launch', brief: 'Ship it.' });
    expect(info.members.map((m: { name: string }) => m.name)).toEqual(['Editor', 'Writer']);
    expect(info.recentWork).toEqual([expect.objectContaining({ agent: 'Editor', lastMessage: 'Draft 2 is in draft.md' })]);

    const list = (await t.call(mine.id, 'list_agents', {})).text.split('\n');
    expect(list[0]).toMatch(/^- Editor \(Codex, teammate in Launch\)/);
    expect(list[1]).toMatch(/^- Accountant/);

    expect((await t.call(mine.id, 'remember', { note: 'Use the blue palette', project: true })).text).toMatch(/project memory note/);
    expect(db.memoryForAgent(editor.id).map((n) => n.content)).toEqual(['Use the blue palette']);

    const declining = tools(db, { requestLocalApproval: async () => 'deny' } as unknown as RunManager);
    expect((await declining.call(mine.id, 'remember', { note: 'Use red', project: true })).ok).toBe(false);
    expect((await declining.call(mine.id, 'remember', { note: 'I prefer short drafts' })).ok).toBe(true);
    expect(db.memoryForAgent(editor.id).map((n) => n.content)).toEqual(['Use the blue palette']);
  });

  it('follows the chat’s project, and can look at any project by name', async () => {
    const db = open();
    const gtm = project(db, 'GTM', 'Sell more.');
    const hiring = project(db, 'Hiring', 'Hire two engineers.');
    const chief = agent(db, 'Chief of Staff', gtm.id);
    const recruiter = agent(db, 'Recruiter', hiring.id);
    const inHiring = db.createConversation(chief, { projectId: hiring.id });
    const t = tools(db);

    const info = JSON.parse((await t.call(inHiring.id, 'get_project', {})).text);
    expect(info).toMatchObject({ name: 'Hiring', brief: 'Hire two engineers.' });
    expect((await t.call(inHiring.id, 'list_agents', {})).text).toMatch(/^- Recruiter \(Claude Code, teammate in Hiring\)/);
    await t.call(inHiring.id, 'remember', { note: 'Interviews on Tuesdays', project: true });
    expect(db.memoryForAgent(recruiter.id).map((n) => n.content)).toEqual(['Interviews on Tuesdays']);
    expect(JSON.parse((await t.call(inHiring.id, 'get_my_profile', {})).text).project).toBe('Hiring');

    // From a chat outside every project, by name.
    const loose = db.createConversation(chief, { projectId: null });
    expect(JSON.parse((await t.call(loose.id, 'get_project', { project: 'gtm' })).text).brief).toBe('Sell more.');
    expect((await t.call(loose.id, 'get_project', {})).text).toMatch(/Projects: GTM, Hiring/);
  });

  it('says so when the agent has no project', async () => {
    const db = open();
    const conv = db.createConversation(agent(db, 'Loner'));
    const t = tools(db);
    expect((await t.call(conv.id, 'get_project', {})).text).toMatch(/not in a project/);
    expect((await t.call(conv.id, 'remember', { note: 'x', project: true })).ok).toBe(false);
  });
});
