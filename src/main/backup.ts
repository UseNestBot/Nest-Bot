import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { BackupInfo } from '@shared/types';

/** How many snapshots to keep in the backups folder. */
export const BACKUPS_KEPT = 10;
const DAY_MS = 24 * 60 * 60_000;
const BACKUP_FILE = /^nest-.*\.sqlite$/;

/** Local time as 2026-11-01_13-45-02-123, so names sort chronologically. */
function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (v: number, w = 2) => String(v).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

export function backupsDir(file: string): string {
  return path.join(path.dirname(file), 'backups');
}

/** The snapshots beside a database file, oldest first. */
export function listBackupInfo(file: string): BackupInfo[] {
  const dir = backupsDir(file);
  return listBackups(dir).flatMap((name) => {
    try {
      const st = statSync(path.join(dir, name));
      return [{ name, path: path.join(dir, name), bytes: st.size, createdAt: st.mtimeMs }];
    } catch {
      return [];
    }
  });
}

function listBackups(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => BACKUP_FILE.test(f)).sort();
  } catch {
    return [];
  }
}

/**
 * Snapshot the database into `backups/` beside it before a new build upgrades
 * its schema, and otherwise at most once a day. VACUUM INTO reads through the
 * WAL, so the copy holds everything (copying nest.sqlite alone would not).
 * Never throws: a failed backup must not stop Nest from opening.
 */
export function backupDatabase(db: DatabaseSync, file: string, version: number, latestVersion: number, now = Date.now(), force = false): string | null {
  if (file === ':memory:' || version === 0) return null;
  try {
    const dir = backupsDir(file);
    const upgrading = version < latestVersion;
    const newest = listBackups(dir).at(-1);
    if (!force && !upgrading && newest && now - statSync(path.join(dir, newest)).mtimeMs < DAY_MS) return null;
    mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `nest-${stamp(now)}-v${version}${upgrading ? '-before-upgrade' : ''}.sqlite`);
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    for (const old of listBackups(dir).slice(0, -BACKUPS_KEPT)) rmSync(path.join(dir, old), { force: true });
    return target;
  } catch (err) {
    console.error('[nest] database backup skipped:', (err as Error).message);
    return null;
  }
}
