// The ACP adapter (Cursor, Gemini CLI, Grok CLI) against a fake ACP agent, and the
// API-key adapter against a fake HTTP stream. No real provider is contacted.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSIONS, DEFAULT_SETTINGS, type AppSettings, type NestEvent, type ProviderId } from '@shared/types';
import { NestDb } from '../src/main/db';
import { AcpProvider, acpPermissionChoices, pickMode, type AcpDefinition } from '../src/main/providers/acp';
import { API_DEFINITIONS, ApiProvider, SseParser, trimHistory } from '../src/main/providers/api';
import { ApiKeyStore, type SecretCipher } from '../src/main/apiKeys';
import { buildChildEnv } from '../src/main/providers/process';
import { ClaudeProvider } from '../src/main/providers/claude';
import { RunManager, type ProviderRegistry } from '../src/main/runs';
import type { ProviderEvent } from '../src/main/providers/types';

const FAKE_ACP = path.resolve('tests/fixtures/fake-acp.mjs');

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  delete process.env.FAKE_ACP_STATE;
  delete process.env.FAKE_ACP_SIGNED_OUT;
});

const FAKE_DEF: AcpDefinition = {
  id: 'cursor',
  resolve: () => ({ command: process.execPath, prefixArgs: [FAKE_ACP], source: 'test' }),
  installHint: 'install it',
  acpArgs: async () => ['acp'],
  authMethod: (offered) => (offered.includes('fake_login') ? 'fake_login' : null),
  login: { display: 'fake login', args: ['login'] },
  logoutArgs: null,
  signedOutAction: 'Sign in to the fake.',
  fallbackModels: [],
};

/** A reversible stand-in for safeStorage; the "ciphertext" must never equal the key. */
const fakeCipher: SecretCipher = {
  available: () => true,
  encrypt: (t) => Buffer.from(`enc:${Buffer.from(t).toString('hex')}`),
  decrypt: (b) => Buffer.from(b.toString().slice(4), 'hex').toString(),
};

function tmp(prefix: string) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join('');
  const bytes = new TextEncoder().encode(body);
  // Split mid-line to exercise the parser's buffering.
  const parts = [bytes.slice(0, 17), bytes.slice(17)];
  return new Response(new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function boot(settingsPatch: Partial<AppSettings> = {}, fetchFn?: typeof fetch) {
  const dir = tmp('nest-prov-');
  process.env.FAKE_ACP_STATE = path.join(dir, 'acp-state.json');
  const db = new NestDb(path.join(dir, 'nest.sqlite'));
  const settings = (): AppSettings => ({ ...DEFAULT_SETTINGS, ...settingsPatch });
  db.updateSettings(settingsPatch);
  const events: NestEvent[] = [];
  const acp = new AcpProvider(FAKE_DEF, settings, () => {}, () => dir);
  const keys = new ApiKeyStore(path.join(dir, 'api-keys.json'), fakeCipher);
  const apiProvider = new ApiProvider(API_DEFINITIONS.openrouter, keys, path.join(dir, 'api-sessions'), () => {}, () => {}, fetchFn);
  const registry: ProviderRegistry = { get: (id: ProviderId) => (id === 'cursor' ? acp : apiProvider) as never };
  const runs = new RunManager(db, registry, (e) => events.push(e), () => path.join(dir, 'work'));
  cleanups.push(async () => {
    await acp.dispose();
    await apiProvider.dispose();
    db.close();
  });
  return { dir, db, runs, events, acp, keys, apiProvider };
}

function makeAgent(db: NestDb, provider: ProviderId) {
  return db.createAgent({ name: 'Tester', avatar: { shape: 'blob', color: '#5fb87a', eyes: 'dots' }, instructions: 'Be brief.', provider, model: null, workspace: null, projectId: null, pinned: false, permissions: DEFAULT_PERMISSIONS });
}

async function until<T>(fn: () => T | undefined | null | false, timeout = 15000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out');
}

const finished = (db: NestDb, runId: string) => until(() => {
  const r = db.getRun(runId);
  return r && r.status !== 'running' ? r : null;
});

const lastAssistant = (db: NestDb, conversationId: string) => db.listMessages(conversationId).filter((m) => m.role === 'assistant').pop()!;

describe('ACP providers (Cursor, Gemini CLI, Grok CLI)', () => {
  it('detects a signed-in agent and lists its models', async () => {
    const { acp } = boot();
    const status = await acp.detect();
    expect(status.state).toBe('ready');
    expect(status.version).toBe('1.2.3');
    const models = await acp.listModels();
    expect(models.map((m) => m.id)).toEqual(['', 'fast-1', 'smart-2']);
  });

  it('reports signed-out when authentication fails', async () => {
    const { acp } = boot();
    process.env.FAKE_ACP_SIGNED_OUT = '1';
    const status = await acp.detect();
    expect(status.state).toBe('signed-out');
    expect(status.action).toContain('Sign in');
  });

  it('streams a reply, then reopens the same session without replaying history', async () => {
    const { db, runs, dir } = boot();
    const conv = db.createConversation(makeAgent(db, 'cursor'));
    const first = await runs.send(conv.id, 'hello', []);
    expect((await finished(db, first.runId)).status).toBe('completed');
    expect(lastAssistant(db, conv.id).content).toBe('echo: hello [mode=default model=fast-1]');
    const run = db.getRun(first.runId)!;
    expect(run.sessionId).toBe('s-1');
    expect(run.usage).toMatchObject({ inputTokens: 12, outputTokens: 5 });

    db.updateConversation(conv.id, { model: 'smart-2' });
    const second = await runs.send(conv.id, 'again', []);
    expect((await finished(db, second.runId)).status).toBe('completed');
    const reply = lastAssistant(db, conv.id).content;
    expect(reply).toBe('echo: again [mode=default model=smart-2]');
    expect(reply).not.toContain('REPLAYED');

    const state = JSON.parse(readFileSync(path.join(dir, 'acp-state.json'), 'utf8'));
    expect(Object.keys(state.sessions)).toEqual(['s-1']);
    // Instructions go with the first message of a new session only.
    expect(state.sessions['s-1'].prompts[0]).toContain('<nest-agent-instructions>');
    expect(state.sessions['s-1'].prompts[1]).not.toContain('<nest-agent-instructions>');
  });

  it('turns permission requests into approval cards and never offers "allow always"', async () => {
    const { db, runs } = boot();
    const conv = db.createConversation(makeAgent(db, 'cursor'));
    const { runId } = await runs.send(conv.id, 'please use a tool', []);
    const approval = await until(() => db.listApprovals(conv.id).find((a) => a.status === 'pending'));
    expect(approval.action).toBe('echo hi');
    expect(approval.choices.map((c) => c.id)).toEqual(['allow', 'deny', 'deny-stop']);
    runs.respondApproval(approval.id, 'allow');
    expect((await finished(db, runId)).status).toBe('completed');
    // Text before the tool is a note between steps; the reply is what came after.
    expect(lastAssistant(db, conv.id).content).toBe('Output: hi');
    expect(db.listActivities(conv.id).find((a) => a.kind === 'note')?.detail).toBe('Running it.');
    const activity = db.listActivities(conv.id).find((a) => a.id === 't1');
    expect(activity).toMatchObject({ kind: 'command', status: 'done', detail: 'echo hi' });
    expect(activity?.output).toContain('hi');
  });

  it('a denied request is reported to the agent', async () => {
    const { db, runs } = boot();
    const conv = db.createConversation(makeAgent(db, 'cursor'));
    const { runId } = await runs.send(conv.id, 'tool please', []);
    const approval = await until(() => db.listApprovals(conv.id).find((a) => a.status === 'pending'));
    runs.respondApproval(approval.id, 'deny');
    expect((await finished(db, runId)).status).toBe('completed');
    expect(lastAssistant(db, conv.id).content).toContain('Not allowed.');
  });

  it('skip permissions selects the agent’s yolo mode and auto-approves', async () => {
    const { db, runs } = boot({ allowSkipPermissions: true, skipPermissionsByDefault: true });
    const conv = db.createConversation(makeAgent(db, 'cursor'));
    const a = await runs.send(conv.id, 'tool now', []);
    expect((await finished(db, a.runId)).status).toBe('completed');
    expect(lastAssistant(db, conv.id).content).toContain('Output: hi');
    expect(db.listApprovals(conv.id)).toHaveLength(0);
    const b = await runs.send(conv.id, 'which mode', []);
    await finished(db, b.runId);
    expect(lastAssistant(db, conv.id).content).toContain('mode=yolo');
  });

  it('cancels a running turn with session/cancel', async () => {
    const { db, runs } = boot();
    const conv = db.createConversation(makeAgent(db, 'cursor'));
    const { runId } = await runs.send(conv.id, 'hang please', []);
    await until(() => lastAssistant(db, conv.id).content === 'working' || runs.isRunning(conv.id));
    await new Promise((r) => setTimeout(r, 300));
    await runs.cancel(conv.id);
    const run = await finished(db, runId);
    expect(run.status).toBe('interrupted');
  });

  it('starts a new session with a summary when the old one is gone', async () => {
    const { db, runs, dir } = boot();
    const conv = db.createConversation(makeAgent(db, 'cursor'));
    const first = await runs.send(conv.id, 'one', []);
    await finished(db, first.runId);
    writeFileSync(path.join(dir, 'acp-state.json'), JSON.stringify({ sessions: {} })); // the agent forgot it
    const second = await runs.send(conv.id, 'two', []);
    await finished(db, second.runId);
    const done = await until(() => {
      const runsList = db.listRuns(conv.id);
      const last = runsList[runsList.length - 1];
      return runsList.length === 3 && last.status !== 'running' ? last : null;
    });
    expect(done.status).toBe('completed');
    const state = JSON.parse(readFileSync(path.join(dir, 'acp-state.json'), 'utf8'));
    expect(state.sessions['s-1'].prompts[0]).toContain('<nest-transferred-context');
  });
});

describe('ACP helpers', () => {
  it('maps Nest permission choices to agent modes', () => {
    const modes = [{ id: 'default' }, { id: 'autoEdit' }, { id: 'plan' }, { id: 'yolo' }];
    const p = (claudeMode: 'default' | 'acceptEdits' | 'plan', skipped = false) => ({ claudeMode, codexSandbox: 'workspace-write' as const, codexApproval: 'on-request' as const, skipped });
    expect(pickMode(modes, p('plan'))).toBe('plan');
    expect(pickMode(modes, p('acceptEdits'))).toBe('autoEdit');
    expect(pickMode(modes, p('default', true))).toBe('yolo');
    expect(pickMode([{ id: 'agent' }, { id: 'plan' }, { id: 'ask' }], p('default'))).toBe('agent');
  });

  it('builds choices from permission options', () => {
    const { choices, optionFor } = acpPermissionChoices([{ optionId: 'a', kind: 'allow_once' }, { optionId: 'b', kind: 'allow_always' }, { optionId: 'c', kind: 'reject_once' }]);
    expect(choices.map((c) => c.id)).toEqual(['allow', 'deny', 'deny-stop']);
    expect(optionFor).toEqual({ allow: 'a', deny: 'c', 'deny-stop': 'c' });
  });

  it('strips each CLI’s API-key variables unless API billing is allowed', () => {
    const base = { PATH: 'x', CURSOR_API_KEY: 'k', XAI_API_KEY: 'k', GEMINI_API_KEY: 'k' };
    expect(buildChildEnv('cursor', base).removedBillingVars).toEqual(['CURSOR_API_KEY']);
    expect(buildChildEnv('grok', base).removedBillingVars).toEqual(['XAI_API_KEY']);
    expect(buildChildEnv('gemini', base).removedBillingVars).toEqual(['GEMINI_API_KEY']);
    expect(buildChildEnv('gemini', base, { keepBillingVars: true }).env.GEMINI_API_KEY).toBe('k');
  });
});

describe('API key providers', () => {
  it('stores keys encrypted and only exposes a masked hint', () => {
    const dir = tmp('nest-keys-');
    const store = new ApiKeyStore(path.join(dir, 'api-keys.json'), fakeCipher);
    store.set('openrouter', 'sk-or-v1-secretsecret1234');
    expect(readFileSync(path.join(dir, 'api-keys.json'), 'utf8')).not.toContain('secretsecret');
    expect(store.get('openrouter')).toBe('sk-or-v1-secretsecret1234');
    expect(store.state('openrouter')).toEqual({ provider: 'openrouter', set: true, hint: '…1234' });
    expect(store.state('xai-api')).toEqual({ provider: 'xai-api', set: false, hint: null });
    store.clear('openrouter');
    expect(store.get('openrouter')).toBeNull();
  });

  it('refuses to save when encryption is unavailable', () => {
    const store = new ApiKeyStore(path.join(tmp('nest-keys-'), 'k.json'), { ...fakeCipher, available: () => false });
    expect(() => store.set('openai-api', 'sk-abcdefgh')).toThrow(/encrypt/);
  });

  it('is signed-out without a key and ready once the key works', async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url} ${(init?.headers as Record<string, string>).Authorization}`);
      return new Response(JSON.stringify({ data: [{ id: 'z-model', name: 'Z' }, { id: 'a-model', name: 'A' }] }), { status: 200 });
    }) as typeof fetch;
    const { apiProvider, keys } = boot({}, fetchFn);
    expect((await apiProvider.detect()).state).toBe('signed-out');
    keys.set('openrouter', 'sk-or-test-abcdefgh');
    const status = await apiProvider.detect();
    expect(status.state).toBe('ready');
    expect(status.account).toBe('API key …efgh');
    expect(calls[0]).toBe('GET https://openrouter.ai/api/v1/models Bearer sk-or-test-abcdefgh');
    expect((await apiProvider.listModels()).map((m) => m.id)).toEqual(['', 'openrouter/auto', 'a-model', 'z-model']);
  });

  it('streams a chat, keeps the history itself and resends it next turn', async () => {
    const bodies: Array<{ model: string; messages: Array<{ role: string; content: unknown }> }> = [];
    let turn = 0;
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'a-model' }] }), { status: 200 });
      bodies.push(JSON.parse(String(init?.body)));
      turn++;
      return sse([{ choices: [{ delta: { content: `Hi ` } }] }, { choices: [{ delta: { content: `#${turn}` }, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } }, '[DONE]']);
    }) as typeof fetch;
    const { db, runs, keys } = boot({}, fetchFn);
    keys.set('openrouter', 'sk-or-test-abcdefgh');
    const conv = db.createConversation(makeAgent(db, 'openrouter'));
    const a = await runs.send(conv.id, 'first', []);
    expect((await finished(db, a.runId)).status).toBe('completed');
    expect(lastAssistant(db, conv.id).content).toBe('Hi #1');
    expect(db.getRun(a.runId)!.usage).toMatchObject({ inputTokens: 9, outputTokens: 2 });
    expect(db.getRun(a.runId)!.model).toBe('openrouter/auto');
    const b = await runs.send(conv.id, 'second', []);
    await finished(db, b.runId);
    expect(bodies[0].model).toBe('openrouter/auto');
    expect(bodies[0].messages[0]).toMatchObject({ role: 'system' });
    expect(bodies[1].messages.slice(1).map((m) => [m.role, m.content])).toEqual([
      ['user', 'first'],
      ['assistant', 'Hi #1'],
      ['user', 'second'],
    ]);
  });

  it('reports HTTP errors without echoing the key', async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ error: { message: 'Invalid key sk-or-test-abcdefgh' } }), { status: 401 })) as unknown as typeof fetch;
    const { apiProvider, keys } = boot({}, fetchFn);
    keys.set('openrouter', 'sk-or-test-abcdefgh');
    const events: ProviderEvent[] = [];
    const turn = apiProvider.startTurn({ runId: 'r', sessionId: null, cwd: null, model: 'x/y', effort: null, instructions: '', prompt: 'hi', attachments: [], permissions: { claudeMode: 'default', codexSandbox: 'workspace-write', codexApproval: 'on-request', skipped: false } }, (e) => events.push(e));
    await turn.done;
    const done = events.find((e) => e.type === 'completed');
    expect(done).toMatchObject({ status: 'failed' });
    expect(JSON.stringify(events)).not.toContain('abcdefgh');
    expect(JSON.stringify(events)).toContain('401');
  });

  it('parses SSE split across chunks and trims old history', () => {
    const got: string[] = [];
    const parser = new SseParser((d) => got.push(d));
    parser.push('data: {"a"');
    parser.push(':1}\n\ndata: [DONE]\n');
    expect(got).toEqual(['{"a":1}', '[DONE]']);
    const msgs = Array.from({ length: 6 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: 'x'.repeat(100) }));
    const trimmed = trimHistory(msgs, 250);
    expect(trimmed).toHaveLength(2);
    expect(trimmed[0].role).toBe('user');
  });
});

describe('Claude turn lifecycle', () => {
  const input = (connectors: Promise<never> | null = null) => ({
    runId: 'r', sessionId: null, cwd: null, model: null, effort: null, instructions: '', prompt: 'hi', attachments: [],
    permissions: { claudeMode: 'default' as const, codexSandbox: 'workspace-write' as const, codexApproval: 'on-request' as const, skipped: false },
    connectors,
  });

  it('does not start Claude Code when stopped before it launched', async () => {
    const claude = new ClaudeProvider(() => ({ ...DEFAULT_SETTINGS, claudePath: path.resolve('tests/fixtures/fake-claude.mjs') }), () => {});
    cleanups.push(() => claude.dispose());
    await claude.detect();
    let release!: () => void;
    const connectors = new Promise<never>((r) => (release = () => r(null as never)));
    const events: ProviderEvent[] = [];
    const turn = claude.startTurn(input(connectors), (e) => events.push(e));
    await turn.cancel();
    release();
    await turn.done;
    await new Promise((r) => setTimeout(r, 1500)); // a spawned CLI would have replied by now
    expect(events.filter((e) => e.type !== 'session')).toEqual([{ type: 'completed', status: 'interrupted', error: undefined }]);
  });

  it('fails the turn when Claude Code cannot be started', async () => {
    if (process.platform === 'win32') return; // no exec bit on Windows
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'nest-claude-')), 'claude');
    writeFileSync(file, '#!/bin/sh\n');
    chmodSync(file, 0o644);
    const claude = new ClaudeProvider(() => ({ ...DEFAULT_SETTINGS, claudePath: file }), () => {});
    cleanups.push(() => claude.dispose());
    const events: ProviderEvent[] = [];
    const turn = claude.startTurn(input(), (e) => events.push(e));
    await turn.done;
    expect(events.at(-1)).toMatchObject({ type: 'completed', status: 'failed' });
  }, 10_000);
});
