import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { API_PROVIDERS, type ApiKeyState, type ApiProviderId } from '@shared/types';

/** Electron's safeStorage (DPAPI on Windows), or a stand-in in tests. */
export interface SecretCipher {
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

interface KeyFile {
  version: 1;
  /** Encrypted keys, base64. Never plain text. */
  keys: Partial<Record<ApiProviderId, string>>;
}

/**
 * API keys the user pastes into Settings. They live encrypted in their own file
 * under the data folder, never in SQLite, settings, logs or the renderer: the
 * renderer only ever sees whether a key is set and its last four characters.
 */
export class ApiKeyStore {
  constructor(
    private readonly file: string,
    private readonly cipher: SecretCipher,
  ) {}

  private read(): KeyFile {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as KeyFile;
      if (parsed && parsed.version === 1 && parsed.keys && typeof parsed.keys === 'object') return parsed;
    } catch {
      /* missing or unreadable: no keys */
    }
    return { version: 1, keys: {} };
  }

  private write(data: KeyFile): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  get(provider: ApiProviderId): string | null {
    const blob = this.read().keys[provider];
    if (!blob || !this.cipher.available()) return null;
    try {
      return this.cipher.decrypt(Buffer.from(blob, 'base64')) || null;
    } catch {
      return null; // encrypted for another Windows user or machine
    }
  }

  set(provider: ApiProviderId, key: string): void {
    if (!this.cipher.available()) throw new Error('This computer can’t encrypt the key (Windows data protection is unavailable), so Nest won’t save it.');
    const data = this.read();
    data.keys[provider] = this.cipher.encrypt(key).toString('base64');
    this.write(data);
  }

  clear(provider: ApiProviderId): void {
    const data = this.read();
    if (!(provider in data.keys)) return;
    delete data.keys[provider];
    this.write(data);
  }

  state(provider: ApiProviderId): ApiKeyState {
    const key = this.get(provider);
    return { provider, set: Boolean(key), hint: key ? maskKey(key) : null };
  }

  states(): ApiKeyState[] {
    return API_PROVIDERS.map((p) => this.state(p));
  }
}

export function maskKey(key: string): string {
  return key.length > 8 ? `…${key.slice(-4)}` : '…';
}
