// End-to-end flows through RunManager + the real provider adapters, driven by
// fake CLIs (tests/fixtures) so no subscription usage is spent.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSIONS, DEFAULT_SETTINGS, type AppSettings, type NestEvent, type ProviderId } from '@shared/types';
import { NestDb } from '../src/main/db';
import { ClaudeProvider } from '../src/main/providers/claude';
import { CodexProvider } from '../src/main/providers/codex';
import { RunManager, type ProviderRegistry } from '../src/main/runs';

const FAKE_CLAUDE = path.resolve('tests/fixtures/fake-claude.mjs');
const FAKE_CODEX = path.resolve('tests/fixtures/fake-codex.mjs');

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function boot(file?: string, settingsPatch: Partial<AppSettings> = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nest-runs-'));
  const dbFile = file ?? path.join(dir, 'nest.sqlite');
  const db = new NestDb(dbFile);
  db.recoverAfterRestart();
  const settings = (): AppSettings => ({ ...DEFAULT_SETTINGS, claudePath: FAKE_CLAUDE, codexPath: FAKE_CODEX, ...settingsPatch });
  const events: NestEvent[] = [];
  const claude = new ClaudeProvider(settings, () => {});
  const codex = new CodexProvider(settings, () => {}, () => {}, 'test');
  const registry: ProviderRegistry = { get: (id) => (id === 'claude' ? claude : codex) };
  const runs = new RunManager(db, registry, (e) => events.push(e), () => path.join(dir, 'scratch'));
  runs.onRunFinished = (cid, run, msg) => runs.handleHandoffCompletion(cid, run, msg);
  const app = { db, runs, events, claude, codex, dbFile, dispose: async () => { await claude.dispose(); await codex.dispose(); db.close(); } };
  cleanups.push(app.dispose);
  return app;
}

function makeAgent(db: NestDb, provider: ProviderId, name = 'Tester') {
  return db.createAgent({ name, avatar: { shape: 'blob', color: '#5fb87a', eyes: 'dots' }, instructions: 'Be brief.', provider, model: null, workspace: null, projectId: null, pinned: false, permissions: DEFAULT_PERMISSIONS });
}

async function finished(db: NestDb, runId: string, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const r = db.getRun(runId);
    if (r && r.status !== 'running') return r;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`run ${runId} still running`);
}

async function pendingApproval(db: NestDb, conversationId: string, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const a = db.listApprovals(conversationId).find((x) => x.status === 'pending');
    if (a) return a;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error('no approval');
}

const assistantFor = (db: NestDb, cid: string, runId: string) => db.listMessages(cid).find((m) => m.runId === runId)!;

for (const provider of ['claude', 'codex'] as ProviderId[]) {
  describe(`${provider} through RunManager`, () => {
    it('streams, persists, and resumes the same native session after a restart', async () => {
      const a = boot();
      const agent = makeAgent(a.db, provider);
      const conv = a.db.createConversation(agent);
      const { runId } = await a.runs.send(conv.id, 'first', []);
      const run = await finished(a.db, runId);
      expect(run.status).toBe('completed');
      expect(run.sessionId).toBeTruthy();
      const msg = assistantFor(a.db, conv.id, runId);
      expect(msg.status).toBe('complete');
      expect(msg.content).toContain(provider === 'claude' ? 'echo:new' : 'Hello there');
      expect(msg.content).not.toContain('LEAK');
      expect(a.events.some((e) => e.type === 'message' && e.message.status === 'streaming')).toBe(true);
      expect(run.usage?.outputTokens).toBeGreaterThan(0);
      await a.dispose();
      cleanups.pop();

      const b = boot(a.dbFile);
      const second = await b.runs.send(conv.id, 'second', []);
      const run2 = await finished(b.db, second.runId);
      expect(run2.status).toBe('completed');
      expect(run2.sessionId).toBe(run.sessionId);
      if (provider === 'claude') expect(assistantFor(b.db, conv.id, second.runId).content).toContain('echo:resumed');
      expect(b.db.listMessages(conv.id).map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    });

    it('routes an approval to the user and applies the decision', async () => {
      const a = boot();
      const conv = a.db.createConversation(makeAgent(a.db, provider));
      const { runId } = await a.runs.send(conv.id, 'do it [approval]', []);
      const approval = await pendingApproval(a.db, conv.id);
      expect(approval.action).toContain(provider === 'claude' ? 'echo hi' : 'touch x');
      expect(a.db.listInbox().some((i) => i.kind === 'approval' && !i.resolved)).toBe(true);
      const choice = provider === 'claude' ? 'allow-session' : 'accept';
      a.runs.respondApproval(approval.id, choice);
      const run = await finished(a.db, runId);
      expect(run.status).toBe('completed');
      const text = assistantFor(a.db, conv.id, runId).content;
      expect(text).toContain(provider === 'claude' ? 'decision:allow:session' : 'decision:accept');
      expect(a.db.getApproval(approval.id)!.status).toBe('resolved');
      expect(a.db.listInbox().find((i) => i.refId === approval.id)!.resolved).toBe(true);
      expect(() => a.runs.respondApproval(approval.id, choice)).toThrow(/no longer pending/);
    });

    it('cancels a running turn, keeps partial text, and the next turn still works', async () => {
      const a = boot();
      const conv = a.db.createConversation(makeAgent(a.db, provider));
      const { runId } = await a.runs.send(conv.id, 'go [slow]', []);
      await new Promise((r) => setTimeout(r, 400));
      await a.runs.cancel(conv.id);
      const run = await finished(a.db, runId);
      expect(run.status).toBe('interrupted');
      const msg = assistantFor(a.db, conv.id, runId);
      expect(msg.status).toBe('interrupted');
      expect(msg.content.length).toBeGreaterThan(0);
      const next = await a.runs.send(conv.id, 'again', []);
      expect((await finished(a.db, next.runId)).status).toBe('completed');
    });

    it('rejects a second message while a turn is running', async () => {
      const a = boot();
      const conv = a.db.createConversation(makeAgent(a.db, provider));
      await a.runs.send(conv.id, 'go [slow]', []);
      await expect(a.runs.send(conv.id, 'too soon', [])).rejects.toThrow(/already in progress/);
      await a.runs.cancel(conv.id);
    });
  });
}

describe('failure handling', () => {
  it('Claude: a crashed process fails the run with stderr detail and no corrupted transcript', async () => {
    const a = boot();
    const conv = a.db.createConversation(makeAgent(a.db, 'claude'));
    const { runId } = await a.runs.send(conv.id, 'boom [crash]', []);
    const run = await finished(a.db, runId);
    expect(run.status).toBe('failed');
    expect(run.error).toContain('simulated crash');
    expect(assistantFor(a.db, conv.id, runId).status).toBe('error');
    expect(a.db.listInbox().some((i) => i.kind === 'failure')).toBe(true);
  });

  it('Claude: a process that ignores interrupt is force-stopped', async () => {
    const a = boot();
    const conv = a.db.createConversation(makeAgent(a.db, 'claude'));
    const { runId } = await a.runs.send(conv.id, 'wait [hang]', []);
    await new Promise((r) => setTimeout(r, 300));
    const started = Date.now();
    await a.runs.cancel(conv.id);
    expect((await finished(a.db, runId)).status).toBe('interrupted');
    expect(Date.now() - started).toBeLessThan(20000);
  }, 30000);

  it('Claude: authentication failures surface the sign-in action', async () => {
    const a = boot();
    const conv = a.db.createConversation(makeAgent(a.db, 'claude'));
    const { runId } = await a.runs.send(conv.id, 'hi [auth]', []);
    const run = await finished(a.db, runId);
    expect(run.status).toBe('failed');
    expect(assistantFor(a.db, conv.id, runId).error).toMatch(/claude auth login/);
  });

  it('Codex: turn failures show the readable upstream message', async () => {
    const a = boot();
    const conv = a.db.createConversation(makeAgent(a.db, 'codex'));
    const { runId } = await a.runs.send(conv.id, 'x [fail]', []);
    const run = await finished(a.db, runId);
    expect(run.status).toBe('failed');
    expect(run.error).toBe('The model is not supported');
  });

  it('Codex: an unresumable thread is replaced by a new one with a transferred summary', async () => {
    const a = boot();
    const conv = a.db.createConversation(makeAgent(a.db, 'codex'));
    const first = await a.runs.send(conv.id, 'remember the word KESTREL', []);
    await finished(a.db, first.runId);
    a.db.upsertProviderSession(conv.id, 'codex', { sessionId: 'thr_missing' });
    const second = await a.runs.send(conv.id, 'what word?', []);
    await finished(a.db, second.runId);
    // The retry is a separate run on a fresh thread that carries the visible transcript.
    const runs = a.db.listRuns(conv.id);
    await finished(a.db, runs.at(-1)!.id);
    const retry = a.db.getRun(runs.at(-1)!.id)!;
    expect(retry.status).toBe('completed');
    expect(retry.sessionId).not.toBe('thr_missing');
    const transfer = a.db.listActivities(conv.id).find((x) => x.runId === retry.id && x.id === 'ctx-transfer');
    expect(transfer?.detail).toContain('KESTREL');
  });

  it('refuses to send when a provider is using API-key billing, unless allowed', async () => {
    process.env.FAKE_API_KEY = '1';
    try {
      const a = boot();
      const conv = a.db.createConversation(makeAgent(a.db, 'codex'));
      await expect(a.runs.send(conv.id, 'hi', [])).rejects.toThrow(/API-billed/);
      expect(a.db.listMessages(conv.id)).toEqual([]);
      const b = boot(undefined, { allowApiKeyBilling: true });
      const conv2 = b.db.createConversation(makeAgent(b.db, 'codex'));
      const { runId } = await b.runs.send(conv2.id, 'hi', []);
      expect((await finished(b.db, runId)).status).toBe('completed');
    } finally {
      delete process.env.FAKE_API_KEY;
    }
  });

  it('refuses to send when Claude Code is signed out', async () => {
    process.env.FAKE_LOGGED_OUT = '1';
    try {
      const a = boot();
      const conv = a.db.createConversation(makeAgent(a.db, 'claude'));
      await expect(a.runs.send(conv.id, 'hi', [])).rejects.toThrow(/not signed in/);
    } finally {
      delete process.env.FAKE_LOGGED_OUT;
    }
  });
});

describe('working folder', () => {
  it('runs in the default working folder when the conversation has none, creating it if needed', async () => {
    const a = boot();
    const conv = a.db.createConversation(makeAgent(a.db, 'claude'));
    const { runId } = await a.runs.send(conv.id, 'where [cwd]', []);
    await finished(a.db, runId);
    const text = assistantFor(a.db, conv.id, runId).content;
    expect(path.basename(text.replace(/^cwd:/, '').trim())).toBe('scratch');
    const own = mkdtempSync(path.join(os.tmpdir(), 'nest-own-'));
    a.db.updateConversation(conv.id, { workspace: own });
    const second = await a.runs.send(conv.id, 'where [cwd]', []);
    await finished(a.db, second.runId);
    expect(assistantFor(a.db, conv.id, second.runId).content.toLowerCase()).toContain(path.basename(own).toLowerCase());
  });

  it('runs project members in the project folder with the brief and their teammates', async () => {
    const a = boot();
    const folder = path.join(mkdtempSync(path.join(os.tmpdir(), 'nest-proj-')), 'Launch');
    const project = a.db.createProject({ name: 'Launch', brief: 'Ship pricing by Friday.', workspace: folder, color: '#3b82f6' });
    const me = makeAgent(a.db, 'claude');
    a.db.setAgentProject(me.id, project.id);
    a.db.setAgentProject(makeAgent(a.db, 'codex', 'Editor').id, project.id);
    const conv = a.db.createConversation(a.db.getAgent(me.id)!, { projectId: project.id });
    const where = await a.runs.send(conv.id, 'where [cwd]', []);
    await finished(a.db, where.runId);
    expect(assistantFor(a.db, conv.id, where.runId).content.toLowerCase()).toContain(folder.toLowerCase());
    const sys = await a.runs.send(conv.id, 'show [system]', []);
    await finished(a.db, sys.runId);
    const prompt = assistantFor(a.db, conv.id, sys.runId).content;
    expect(prompt).toContain('part of the "Launch" project');
    expect(prompt).toContain('Ship pricing by Friday.');
    expect(prompt).toContain('- Editor (Codex)');
  });
});

describe('memory and context', () => {
  it('sends memory only when it changes, and records which notes were included', async () => {
    const a = boot();
    const agent = makeAgent(a.db, 'claude');
    const conv = a.db.createConversation(agent);
    const note = a.db.createMemory('agent', agent.id, 'Prefers metric units');
    a.db.createMemory('shared', null, 'Repo uses pnpm');
    const r1 = await a.runs.send(conv.id, 'one', []);
    expect((await finished(a.db, r1.runId)).includedNoteIds.length).toBe(2);
    const r2 = await a.runs.send(conv.id, 'two', []);
    expect((await finished(a.db, r2.runId)).includedNoteIds).toEqual([]);
    a.db.updateMemory(note.id, { content: 'Prefers imperial units' });
    const r3 = await a.runs.send(conv.id, 'three', []);
    expect((await finished(a.db, r3.runId)).includedNoteIds.length).toBe(2);
    const activity = a.db.listActivities(conv.id).find((x) => x.runId === r3.runId && x.id === 'ctx-memory');
    expect(activity?.detail).toContain('imperial');
  });

  it('switching provider keeps the transcript and transfers only unseen messages', async () => {
    const a = boot();
    const conv = a.db.createConversation(makeAgent(a.db, 'claude'));
    const r1 = await a.runs.send(conv.id, 'the code is OSPREY', []);
    await finished(a.db, r1.runId);
    a.db.updateConversation(conv.id, { provider: 'codex', model: null });
    const r2 = await a.runs.send(conv.id, 'what code?', []);
    const run2 = await finished(a.db, r2.runId);
    expect(run2.provider).toBe('codex');
    const transfer = a.db.listActivities(conv.id).find((x) => x.runId === r2.runId && x.id === 'ctx-transfer');
    expect(transfer?.detail).toContain('OSPREY');
    expect(transfer?.detail).not.toContain('what code?'); // the new prompt is sent normally, not duplicated
    // Back to Claude: its original session resumes and only the Codex exchange is transferred.
    a.db.updateConversation(conv.id, { provider: 'claude', model: null });
    const r3 = await a.runs.send(conv.id, 'and now?', []);
    const run3 = await finished(a.db, r3.runId);
    expect(run3.sessionId).toBe(a.db.getRun(r1.runId)!.sessionId);
    const back = a.db.listActivities(conv.id).find((x) => x.runId === r3.runId && x.id === 'ctx-transfer');
    expect(back?.detail).toContain('what code?');
    expect(back?.detail).not.toContain('OSPREY');
  });

  it('a handoff runs the target agent and links its result back to the source', async () => {
    const a = boot();
    const source = a.db.createConversation(makeAgent(a.db, 'claude', 'Planner'));
    const target = makeAgent(a.db, 'codex', 'Builder');
    const handoff = await a.runs.startHandoff({ sourceConversationId: source.id, targetAgentId: target.id, task: 'Write the summary', context: 'Context here' });
    const targetRun = a.db.listRuns(handoff.targetConversationId)[0];
    await finished(a.db, targetRun.id);
    const done = a.db.getHandoff(handoff.id)!;
    expect(done.status).toBe('completed');
    expect(done.result).toContain('Hello there');
    const back = a.db.listMessages(source.id);
    expect(back.map((m) => m.kind)).toEqual(['notice', 'handoff-result']);
    expect(back[1].linkConversationId).toBe(handoff.targetConversationId);
    expect(a.db.listInbox().some((i) => i.kind === 'handoff')).toBe(true);
  });
});

describe('restart recovery', () => {
  it('marks runs, messages and approvals left live by a crash as interrupted/expired', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nest-recover-'));
    const file = path.join(dir, 'n.sqlite');
    const db = new NestDb(file);
    const agent = makeAgent(db, 'claude');
    const conv = db.createConversation(agent);
    const run = db.createRun({ conversationId: conv.id, provider: 'claude', model: null, sessionId: 's', includedNoteIds: [] });
    db.insertMessage({ conversationId: conv.id, runId: run.id, role: 'assistant', kind: 'chat', content: 'partial', status: 'streaming', error: null, attachments: [], linkConversationId: null });
    db.createApproval({ runId: run.id, conversationId: conv.id, provider: 'claude', requestId: 'r', title: 't', action: 'a', target: null, reason: null, detail: null, choices: [] });
    db.upsertActivity(conv.id, { id: 'x', runId: run.id, kind: 'command', title: 'ls', status: 'running' });
    db.close();
    const db2 = new NestDb(file);
    db2.recoverAfterRestart();
    expect(db2.getRun(run.id)!.status).toBe('interrupted');
    const m = db2.listMessages(conv.id)[0];
    expect(m.status).toBe('interrupted');
    expect(m.content).toBe('partial');
    expect(db2.listApprovals(conv.id)[0].status).toBe('expired');
    expect(db2.listActivities(conv.id)[0].status).toBe('failed');
    db2.close();
  });
});
