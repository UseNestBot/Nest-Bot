import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSIONS } from '@shared/types';
import { BACKUPS_KEPT, backupDatabase } from '../src/main/backup';
import { NestDb } from '../src/main/db';
import { textMenuTemplate } from '../src/main/spelling';

const tempDir = () => mkdtempSync(path.join(os.tmpdir(), 'nest-backup-'));
const backupsIn = (dir: string) => {
  try {
    return readdirSync(path.join(dir, 'backups')).sort();
  } catch {
    return [];
  }
};

describe('database backups', () => {
  it('skips a brand-new database, then snapshots an existing one at most daily', () => {
    const dir = tempDir();
    const file = path.join(dir, 'nest.sqlite');
    const first = new NestDb(file);
    first.createAgent({ name: 'Keeper', avatar: { shape: 'blob', color: '#3b82f6', eyes: 'dots' }, instructions: '', provider: 'claude', model: null, workspace: null, projectId: null, pinned: false, permissions: DEFAULT_PERMISSIONS });
    first.close();
    expect(backupsIn(dir)).toEqual([]);

    new NestDb(file).close();
    const after = backupsIn(dir);
    expect(after).toHaveLength(1);
    // The snapshot is a complete database, WAL contents included.
    const copy = new DatabaseSync(path.join(dir, 'backups', after[0]), { readOnly: true });
    expect(copy.prepare(`SELECT name FROM agents WHERE name = 'Keeper'`).get()).toEqual({ name: 'Keeper' });
    copy.close();

    new NestDb(file).close();
    expect(backupsIn(dir)).toHaveLength(1);
  });

  it('always snapshots before a schema upgrade and keeps only the newest', () => {
    const dir = tempDir();
    const file = path.join(dir, 'nest.sqlite');
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE t (x); INSERT INTO t VALUES (1); PRAGMA user_version = 3;`);
    const start = Date.UTC(2026, 10, 1, 12);
    for (let i = 0; i < BACKUPS_KEPT + 2; i++) backupDatabase(db, file, 3, 4, start + i * 1000);
    db.close();
    const kept = backupsIn(dir);
    expect(kept).toHaveLength(BACKUPS_KEPT);
    expect(kept.every((f) => f.endsWith('-v3-before-upgrade.sqlite'))).toBe(true);
    expect(kept[0]).toContain('-02-000'); // the two oldest (…-00-000, …-01-000) were pruned
  });

  it('never throws when the backups folder cannot be created', () => {
    const dir = tempDir();
    const file = path.join(dir, 'nest.sqlite');
    writeFileSync(path.join(dir, 'backups'), 'a file where the folder should be');
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE t (x); PRAGMA user_version = 1;`);
    expect(backupDatabase(db, file, 1, 2)).toBeNull();
    db.close();
  });
});

describe('right-click text menu', () => {
  const flags = { canCut: true, canCopy: true, canPaste: true, canUndo: false, canRedo: false, canDelete: true, canSelectAll: true, canEditRichly: false };
  const actions = { replace: () => {}, learn: () => {} };

  it('offers up to five corrections and Add to dictionary for a misspelled word', () => {
    const items = textMenuTemplate({ misspelledWord: 'speling', dictionarySuggestions: ['spelling', 'spieling', 'spewing', 'sapling', 'spiling', 'splint'], isEditable: true, selectionText: '', editFlags: flags }, actions)!;
    expect(items.slice(0, 5).map((i) => i.label)).toEqual(['spelling', 'spieling', 'spewing', 'sapling', 'spiling']);
    expect(items.map((i) => i.label ?? i.role ?? i.type)).toEqual([
      'spelling', 'spieling', 'spewing', 'sapling', 'spiling', 'separator', 'Add to dictionary', 'separator', 'cut', 'copy', 'paste', 'separator', 'selectAll',
    ]);
  });

  it('says so when there are no suggestions, offers Copy for selected text, and nothing on empty space', () => {
    const none = textMenuTemplate({ misspelledWord: 'qwzx', dictionarySuggestions: [], isEditable: true, selectionText: '', editFlags: flags }, actions)!;
    expect(none[0]).toMatchObject({ label: 'No suggestions', enabled: false });
    expect(textMenuTemplate({ misspelledWord: '', dictionarySuggestions: [], isEditable: false, selectionText: 'some reply', editFlags: flags }, actions)).toEqual([{ role: 'copy' }]);
    expect(textMenuTemplate({ misspelledWord: '', dictionarySuggestions: [], isEditable: false, selectionText: '  ', editFlags: flags }, actions)).toBeNull();
  });
});
