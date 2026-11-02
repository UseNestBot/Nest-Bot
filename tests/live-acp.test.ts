// Live checks for the ACP providers against the real CLIs (a few tiny prompts each).
// NEST_LIVE=cursor,gemini,grok npx vitest run tests/live-acp.test.ts
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSIONS, DEFAULT_SETTINGS, type ProviderId } from '@shared/types';
import { NestDb } from '../src/main/db';
import { AcpProvider } from '../src/main/providers/acp';
import { CURSOR, GEMINI, GROK } from '../src/main/providers/acpProviders';
import { RunManager } from '../src/main/runs';

const live = (process.env.NEST_LIVE ?? '').split(',');
const disposers: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const d of disposers) await d();
});

for (const def of [CURSOR, GEMINI, GROK]) {
  describe.skipIf(!live.includes(def.id))(`live ${def.id}`, () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), `nest-live-${def.id}-`));
    const db = new NestDb(path.join(dir, 'nest.sqlite'));
    const provider = new AcpProvider(def, () => DEFAULT_SETTINGS, () => {}, () => dir);
    const runs = new RunManager(db, { get: () => provider as never }, () => {}, () => dir);
    disposers.push(async () => {
      await provider.dispose();
      db.close();
    });
    const agent = db.createAgent({ name: 'Live', avatar: { shape: 'blob', color: '#5fb87a', eyes: 'dots' }, instructions: 'Answer in as few words as possible.', provider: def.id as ProviderId, model: null, workspace: dir, projectId: null, pinned: false, permissions: DEFAULT_PERMISSIONS });
    const conv = db.createConversation(agent);

    const wait = async (runId: string) => {
      for (let i = 0; i < 1200; i++) {
        const pending = db.listApprovals(conv.id).find((a) => a.status === 'pending');
        if (pending) runs.respondApproval(pending.id, 'allow');
        const r = db.getRun(runId);
        if (r && r.status !== 'running') return r;
        await new Promise((res) => setTimeout(res, 100));
      }
      throw new Error('run did not finish');
    };
    const reply = () => db.listMessages(conv.id).filter((m) => m.role === 'assistant').pop()!.content;

    it('is signed in and lists models', async () => {
      expect((await provider.detect()).state).toBe('ready');
      expect((await provider.listModels()).length).toBeGreaterThan(1);
    }, 120_000);

    it('runs a command after approval, then remembers it in the next turn', async () => {
      const a = await runs.send(conv.id, 'Run the shell command `echo nest-live-7` and reply with only its output.', []);
      const runA = await wait(a.runId);
      expect(runA.status, runA.error ?? '').toBe('completed');
      expect(reply()).toContain('nest-live-7');
      expect(db.listApprovals(conv.id).length).toBeGreaterThan(0);
      const b = await runs.send(conv.id, 'What did that command print? Reply with only the text.', []);
      const runB = await wait(b.runId);
      expect(runB.status, runB.error ?? '').toBe('completed');
      expect(runB.sessionId).toBe(runA.sessionId);
      expect(reply()).toContain('nest-live-7');
    }, 300_000);
  });
}
