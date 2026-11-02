import { existsSync, readFileSync } from 'node:fs';
import { DEFAULT_PERMISSIONS, DEFAULT_SETTINGS, type AppSettings } from '@shared/types';
import { AGENT_TEMPLATES } from '@shared/templates';
import type { NestDb } from './db';

/** Two starter agents on first launch only, so the app is usable immediately. */
export function seedIfEmpty(db: NestDb): void {
  const seeded = db.db.prepare(`SELECT value FROM settings WHERE key = '_seeded'`).get();
  if (seeded) return;
  if (db.listAgents().length === 0) {
    // First launch: a Chief of Staff to run the team, and an engineer on Codex.
    for (const id of ['chief-of-staff', 'engineer']) {
      const t = AGENT_TEMPLATES.find((x) => x.id === id)!;
      db.createAgent({ name: t.name, avatar: t.avatar, instructions: t.instructions, provider: t.provider, model: null, workspace: null, projectId: null, pinned: true, permissions: DEFAULT_PERMISSIONS });
    }
  }
  db.db.prepare(`INSERT INTO settings(key, value) VALUES ('_seeded', 'true')`).run();
}

/**
 * Optional `nest.config.json` in the data folder. Known keys override the
 * stored settings at startup; anything else (including any secret) is ignored.
 */
export function applyConfigFile(db: NestDb, file: string): void {
  if (!existsSync(file)) return;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const patch: Partial<AppSettings> = {};
    for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof AppSettings>) {
      if (!(key in raw)) continue;
      const value = raw[key];
      const expected = typeof DEFAULT_SETTINGS[key];
      if (value === null || typeof value === expected || (expected === 'object' && typeof value === 'string')) (patch as Record<string, unknown>)[key] = value;
    }
    db.updateSettings(patch);
  } catch (err) {
    console.error(`[nest] ignoring unreadable ${file}:`, (err as Error).message);
  }
}
