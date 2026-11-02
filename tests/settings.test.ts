import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/types';
import { NestDb } from '../src/main/db';
import { applyConfigFile } from '../src/main/seed';
import { PROVIDER_SETTINGS, sanitizeSettings } from '../src/main/settings';

const tempDir = () => mkdtempSync(path.join(os.tmpdir(), 'nest-settings-'));

describe('sanitizeSettings', () => {
  it('drops unknown keys and falls back to defaults for unknown choices', () => {
    expect(sanitizeSettings({ theme: 'neon', accentColor: 'violet', density: 'huge', bogus: 1 })).toEqual({ theme: 'system', accentColor: 'violet', density: 'default' });
  });

  it('clamps numbers into range and onto their step', () => {
    expect(sanitizeSettings({ uiScale: 500 }).uiScale).toBe(130);
    expect(sanitizeSettings({ uiScale: 103 }).uiScale).toBe(105);
    expect(sanitizeSettings({ uiScale: 'x' }).uiScale).toBe(100);
    expect(sanitizeSettings({ transferBudgetChars: 50_000 }).transferBudgetChars).toBe(40_000);
  });

  it('rejects font values that could break out of the CSS value', () => {
    expect(sanitizeSettings({ uiFont: ' Inter, "Fira Sans" ' }).uiFont).toBe('Inter, "Fira Sans"');
    expect(() => sanitizeSettings({ codeFont: 'x; } body { display: none' })).toThrow();
  });

  it('keeps only known providers and non-empty models', () => {
    expect(sanitizeSettings({ defaultModels: { claude: ' opus ', codex: '', nope: 'x' } }).defaultModels).toEqual({ claude: 'opus' });
  });

  it('fills notification kinds that are missing or not booleans', () => {
    expect(sanitizeSettings({ notifyOn: { finished: false, failed: 'yes' } }).notifyOn).toEqual({ finished: false, failed: true, approval: true });
  });

  it('marks only provider-affecting keys for re-detection', () => {
    expect(PROVIDER_SETTINGS).toContain('claudePath');
    expect(PROVIDER_SETTINGS).not.toContain('theme');
  });
});

describe('stored settings', () => {
  it('maps the old text size onto the interface zoom', () => {
    const db = new NestDb(':memory:');
    db.db.prepare(`INSERT INTO settings(key, value) VALUES ('textSize', '"large"')`).run();
    expect(db.getSettings().uiScale).toBe(110);
    db.updateSettings({ uiScale: 95 });
    expect(db.getSettings().uiScale).toBe(95);
    db.close();
  });

  it('keeps the default for an unreadable value and fills new object fields', () => {
    const db = new NestDb(':memory:');
    db.db.prepare(`INSERT INTO settings(key, value) VALUES ('sendKey', 'not json')`).run();
    db.db.prepare(`INSERT INTO settings(key, value) VALUES ('notifyOn', '{"finished":false}')`).run();
    const s = db.getSettings();
    expect(s.sendKey).toBe(DEFAULT_SETTINGS.sendKey);
    expect(s.notifyOn).toEqual({ finished: false, failed: true, approval: true });
    db.close();
  });

  it('validates nest.config.json key by key', () => {
    const dir = tempDir();
    const file = path.join(dir, 'nest.config.json');
    writeFileSync(file, JSON.stringify({ theme: 'dark', uiScale: 999, codeFont: '}{', transferBudgetChars: 12_000 }));
    const db = new NestDb(':memory:');
    applyConfigFile(db, file);
    const s = db.getSettings();
    expect([s.theme, s.uiScale, s.codeFont, s.transferBudgetChars]).toEqual(['dark', 130, '', 12_000]);
    db.close();
  });

  it('backs up on demand and lists the snapshots', () => {
    const dir = tempDir();
    const db = new NestDb(path.join(dir, 'nest.sqlite'));
    expect(db.listBackups()).toEqual([]);
    expect(db.backUpNow()).toBe(true);
    const list = db.listBackups();
    expect(list).toHaveLength(1);
    expect(list[0].bytes).toBeGreaterThan(0);
    db.close();
  });
});
