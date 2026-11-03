// Git and forge tools as an agent sees them: drafts go to the source control
// panel, reading is free, and opening or commenting always asks the user.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSIONS, DEFAULT_SETTINGS, type AppSettings, type ForgePullDetail, type GitDraft } from '@shared/types';
import { NestDb } from '../src/main/db';
import { GIT_TOOL_DEFS, NestTools, describePull, type ForgeTools } from '../src/main/mcp/tools';
import { ClaudeProvider } from '../src/main/providers/claude';
import { CodexProvider } from '../src/main/providers/codex';
import { RunManager, type ProviderRegistry } from '../src/main/runs';
import { Scheduler } from '../src/main/scheduler';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const PULL: ForgePullDetail = {
  number: 7,
  title: 'Fix the thing',
  state: 'open',
  draft: false,
  author: 'ann',
  head: 'fix',
  base: 'main',
  url: 'https://github.com/o/r/pull/7',
  updatedAt: 0,
  checks: 'failure',
  review: 'changes-requested',
  body: 'Fixes it.',
  headSha: 'abc',
  checkList: [{ id: 'run:11', name: 'build', state: 'failure', url: 'https://ci', hasLog: true }],
  comments: [{ id: 'line:3', author: 'rev', body: 'Off by one', createdAt: 1, path: 'src/a.ts', line: 42, url: null, review: null }],
};

class FakeForge implements ForgeTools {
  calls: string[] = [];
  async lookup() {
    return { repo: null, unknownHost: null, error: null };
  }
  async listPulls(_f: string, state: string) {
    this.calls.push(`list ${state}`);
    return [PULL];
  }
  async getPull(_f: string, n: number) {
    this.calls.push(`get ${n}`);
    return PULL;
  }
  async checkLog(_f: string, id: string) {
    this.calls.push(`log ${id}`);
    return 'Error: boom';
  }
  async createPull() {
    this.calls.push('create');
    return PULL;
  }
  async comment(_f: string, n: number) {
    this.calls.push(`comment ${n}`);
  }
}

function boot() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nest-gittools-'));
  const db = new NestDb(path.join(dir, 'n.sqlite'));
  const settings = (): AppSettings => ({ ...DEFAULT_SETTINGS, claudePath: path.resolve('tests/fixtures/fake-claude.mjs'), codexPath: path.resolve('tests/fixtures/fake-codex.mjs') });
  const claude = new ClaudeProvider(settings, () => {});
  const codex = new CodexProvider(settings, () => {}, () => {}, 'test');
  const registry = { get: (id: string) => (id === 'claude' ? claude : codex) } as unknown as ProviderRegistry;
  const runs = new RunManager(db, registry, () => {}, () => path.join(dir, 'work'));
  const forge = new FakeForge();
  const drafts: Array<{ conversationId: string; draft: GitDraft }> = [];
  const tools = new NestTools(db, runs, new Scheduler(db, runs, () => {}), () => {}, undefined, undefined, { forge, onDraft: (conversationId, draft) => drafts.push({ conversationId, draft }) });
  const agent = db.createAgent({ name: 'Builder', avatar: { shape: 'blob', color: '#4cbe6c', eyes: 'dots' }, instructions: '', provider: 'claude', model: null, workspace: null, projectId: null, pinned: false, permissions: DEFAULT_PERMISSIONS });
  const conv = db.createConversation(agent);
  cleanups.push(async () => {
    await claude.dispose();
    await codex.dispose();
    db.close();
  });
  return { tools, forge, drafts, conv };
}

describe('git tools', () => {
  it('are offered when forges are wired up', () => {
    const { tools, conv } = boot();
    const names = tools.listFor(conv.id).map((t) => t.name);
    for (const t of GIT_TOOL_DEFS) expect(names).toContain(t.name);
  });

  it('send drafts to the source control panel without committing or opening anything', async () => {
    const { tools, forge, drafts, conv } = boot();
    expect((await tools.call(conv.id, 'draft_commit_message', { message: 'Fix the thing\n\nBecause.' })).ok).toBe(true);
    expect((await tools.call(conv.id, 'draft_pull_request', { title: 'Fix', body: 'Body', base: 'dev' })).ok).toBe(true);
    expect(drafts).toEqual([
      { conversationId: conv.id, draft: { kind: 'commit', message: 'Fix the thing\n\nBecause.' } },
      { conversationId: conv.id, draft: { kind: 'pull-request', title: 'Fix', body: 'Body', base: 'dev' } },
    ]);
    expect((await tools.call(conv.id, 'draft_commit_message', { message: '  ' })).ok).toBe(false);
    expect(forge.calls).toEqual([]);
  });

  it('read pull requests, checks and logs', async () => {
    const { tools, forge, conv } = boot();
    expect((await tools.call(conv.id, 'list_pull_requests', {})).text).toContain('#7 Fix the thing [open; checks failure, changes-requested] fix → main');
    const read = await tools.call(conv.id, 'get_pull_request', { number: 7 });
    expect(read.text).toContain('[failure] build (id: run:11, log available)');
    expect(read.text).toContain('rev on src/a.ts:42: Off by one');
    expect((await tools.call(conv.id, 'get_check_log', { check_id: 'run:11' })).text).toBe('Error: boom');
    // Without a number and no pull request for the branch, it says so.
    expect((await tools.call(conv.id, 'get_pull_request', {})).ok).toBe(false);
    expect(forge.calls).toEqual(['list open', 'get 7', 'log run:11']);
  });

  it('ask before opening a pull request or commenting, so nothing happens outside a turn', async () => {
    const { tools, forge, conv } = boot();
    // No run is active, so the approval can't be shown and counts as declined.
    expect(await tools.call(conv.id, 'create_pull_request', { title: 'T', body: 'B' })).toEqual({ ok: false, text: 'The user declined opening this pull request.' });
    expect(await tools.call(conv.id, 'comment_on_pull_request', { number: 7, body: 'Done' })).toEqual({ ok: false, text: 'The user declined posting this comment.' });
    expect(forge.calls).toEqual([]);
  });

  it('describe a pull request for the agent', () => {
    const text = describePull(PULL);
    expect(text.split('\n')[0]).toBe('#7 Fix the thing (open) by ann: fix → main');
    expect(text).toContain('Checks: failure · Review: changes-requested');
  });
});
