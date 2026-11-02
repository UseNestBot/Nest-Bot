import type { ApiMethod } from '@shared/ipc';
import type { NestEvent, RemoteDevice, RemoteState } from '@shared/types';
import { RemoteServer, type CallResult } from './server';
import { RemoteStore, validPort } from './store';
import { serveOnTailnet, tailscaleStatus } from './tailscale';
import { sendPush } from './webpush';

export interface RemoteHostOptions {
  file: string;
  staticDir: string;
  uploadsDir: string;
  call: (method: ApiMethod, args: unknown[], device: RemoteDevice) => Promise<CallResult>;
  /** Tell the desktop window remote access changed. */
  onChange: () => void;
}

/** Remote access: the settings, the local server and push notifications, behind the API's remote methods. */
export class RemoteHost {
  readonly store: RemoteStore;
  private readonly server: RemoteServer;

  constructor(private readonly opts: RemoteHostOptions) {
    this.store = new RemoteStore(opts.file);
    this.server = new RemoteServer({ store: this.store, staticDir: opts.staticDir, uploadsDir: opts.uploadsDir, call: opts.call, onChange: opts.onChange });
  }

  async start(): Promise<void> {
    if (this.store.enabled) await this.server.start(this.store.port);
  }

  stop(): Promise<void> {
    return this.server.stop();
  }

  broadcast(event: NestEvent): void {
    this.server.broadcast(event);
  }

  async state(): Promise<RemoteState> {
    const port = this.store.port;
    return {
      enabled: this.store.enabled,
      port,
      running: this.server.running,
      error: this.store.enabled ? this.server.error : null,
      localUrl: `http://127.0.0.1:${port}`,
      tailscale: await tailscaleStatus(port),
      devices: this.store.devices(),
      pairing: this.store.pairingInfo(),
    };
  }

  async update(patch: { enabled?: boolean; port?: number }): Promise<RemoteState> {
    if (patch.port !== undefined && !validPort(patch.port)) throw new Error('Pick a port between 1024 and 65535.');
    const restart = (patch.enabled !== undefined && patch.enabled !== this.store.enabled) || (patch.port !== undefined && patch.port !== this.store.port);
    this.store.update(patch);
    if (restart) {
      if (this.store.enabled) await this.server.start(this.store.port);
      else await this.server.stop();
    }
    return this.state();
  }

  startPairing(): Promise<RemoteState> {
    if (!this.store.enabled) throw new Error('Turn on remote access first.');
    this.store.startPairing();
    return this.state();
  }

  revoke(id: string): Promise<RemoteState> {
    this.store.revoke(id);
    this.server.disconnect(id);
    return this.state();
  }

  async setUpTailscale(): Promise<RemoteState> {
    await serveOnTailnet(this.store.port);
    return this.state();
  }

  /** Push to every subscribed device; forget subscriptions the push service says are gone. */
  async notify(payload: { title: string; body: string; conversationId?: string; kind?: string }, onlyDevice?: string): Promise<number> {
    if (!this.store.enabled) return 0;
    const keys = this.store.vapidKeys();
    const targets = this.store.pushTargets().filter((t) => !onlyDevice || t.id === onlyDevice);
    const results = await Promise.all(targets.map(async (t) => ({ t, result: await sendPush(t.sub, payload, keys) })));
    let sent = 0;
    for (const { t, result } of results) {
      if (result === 'sent') sent++;
      if (result === 'gone') this.store.setPush(t.id, null);
    }
    if (results.some((r) => r.result === 'gone')) this.opts.onChange();
    return sent;
  }
}
