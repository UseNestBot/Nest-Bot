import { app } from 'electron';
import path from 'node:path';
import type { NestDb } from './db';

/** The folder agents use when a conversation has no workspace: the user's setting, or Documents\Nest. */
export function effectiveDefaultWorkspace(db: NestDb): string {
  return db.getSettings().defaultWorkspace || path.join(app.getPath('documents'), 'Nest');
}
