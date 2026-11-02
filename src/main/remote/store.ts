import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RemoteDevice } from '@shared/types';
import { generateVapidKeys, type PushSubscriptionJson, type VapidKeys } from './webpush';

export const DEFAULT_REMOTE_PORT = 8787;
const PAIRING_TTL_MS = 10 * 60_000;
const PAIRING_ATTEMPTS = 5;

interface StoredDevice {
  id: string;
  name: string;
  /** sha256 of the bearer token; the token itself is only ever shown to the device. */
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string | null;
  push: PushSubscriptionJson | null;
}

interface RemoteFile {
  enabled: boolean;
  port: number;
  devices: StoredDevice[];
  vapid: VapidKeys | null;
}

const hash = (token: string): string => createHash('sha256').update(token).digest('hex');

/**
 * Remote access state in userData/remote.json, kept apart from the database so
 * device tokens never end up in backups or exports of nest.sqlite.
 */
export class RemoteStore {
  private data: RemoteFile;
  private pairing: { code: string; expiresAt: number; attempts: number } | null = null;

  constructor(private readonly file: string) {
    this.data = { enabled: false, port: DEFAULT_REMOTE_PORT, devices: [], vapid: null };
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<RemoteFile>;
      this.data = {
        enabled: raw.enabled === true,
        port: validPort(raw.port) ? raw.port : DEFAULT_REMOTE_PORT,
        devices: Array.isArray(raw.devices) ? raw.devices.filter((d) => d && typeof d.tokenHash === 'string') : [],
        vapid: raw.vapid && typeof raw.vapid.publicKey === 'string' ? raw.vapid : null,
      };
    } catch {
      /* first run */
    }
  }

  private save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  get enabled(): boolean {
    return this.data.enabled;
  }

  get port(): number {
    return this.data.port;
  }

  update(patch: { enabled?: boolean; port?: number }): void {
    if (patch.enabled !== undefined) this.data.enabled = patch.enabled;
    if (patch.port !== undefined) this.data.port = patch.port;
    if (!this.data.enabled) this.pairing = null;
    this.save();
  }

  devices(): RemoteDevice[] {
    return this.data.devices.map((d) => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, push: Boolean(d.push) }));
  }

  /** Created on first use and kept, so existing push subscriptions stay valid. */
  vapidKeys(): VapidKeys {
    if (!this.data.vapid) {
      this.data.vapid = generateVapidKeys();
      this.save();
    }
    return this.data.vapid;
  }

  startPairing(now = Date.now()): { code: string; expiresAt: string } {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.pairing = { code, expiresAt: now + PAIRING_TTL_MS, attempts: 0 };
    return this.pairingInfo(now)!;
  }

  pairingInfo(now = Date.now()): { code: string; expiresAt: string } | null {
    if (!this.pairing || this.pairing.expiresAt <= now) return null;
    return { code: this.pairing.code, expiresAt: new Date(this.pairing.expiresAt).toISOString() };
  }

  /**
   * Trade the open pairing code for a device token. A code works once, and a few
   * wrong guesses close it, so it can't be brute-forced.
   */
  pair(code: string, name: string, now = Date.now()): { token: string; device: RemoteDevice } | null {
    const p = this.pairing;
    if (!p || p.expiresAt <= now) return null;
    const ok = code.length === p.code.length && timingSafeEqual(Buffer.from(code), Buffer.from(p.code));
    if (!ok) {
      if (++p.attempts >= PAIRING_ATTEMPTS) this.pairing = null;
      return null;
    }
    this.pairing = null;
    const token = randomBytes(32).toString('base64url');
    const stamp = new Date(now).toISOString();
    const device: StoredDevice = { id: randomUUID(), name: name.trim().slice(0, 60) || 'Phone', tokenHash: hash(token), createdAt: stamp, lastSeenAt: stamp, push: null };
    this.data.devices.push(device);
    this.save();
    return { token, device: this.devices().find((d) => d.id === device.id)! };
  }

  /** The device a bearer token belongs to, or null. */
  authenticate(token: string, now = Date.now()): RemoteDevice | null {
    if (!token) return null;
    const h = hash(token);
    const device = this.data.devices.find((d) => d.tokenHash.length === h.length && timingSafeEqual(Buffer.from(d.tokenHash), Buffer.from(h)));
    if (!device) return null;
    // Saved at most once a minute.
    if (!device.lastSeenAt || now - Date.parse(device.lastSeenAt) > 60_000) {
      device.lastSeenAt = new Date(now).toISOString();
      this.save();
    }
    return this.devices().find((d) => d.id === device.id)!;
  }

  revoke(id: string): boolean {
    const before = this.data.devices.length;
    this.data.devices = this.data.devices.filter((d) => d.id !== id);
    if (this.data.devices.length === before) return false;
    this.save();
    return true;
  }

  setPush(id: string, sub: PushSubscriptionJson | null): void {
    const device = this.data.devices.find((d) => d.id === id);
    if (!device) return;
    device.push = sub;
    this.save();
  }

  pushTargets(): Array<{ id: string; sub: PushSubscriptionJson }> {
    return this.data.devices.filter((d) => d.push).map((d) => ({ id: d.id, sub: d.push! }));
  }
}

export function validPort(p: unknown): p is number {
  return typeof p === 'number' && Number.isInteger(p) && p >= 1024 && p <= 65535;
}
