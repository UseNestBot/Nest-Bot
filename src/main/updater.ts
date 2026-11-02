import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ReleaseChannel } from '@shared/build';
import type { UpdateState } from '@shared/types';
import { pickUpdate, type GithubRelease, type UpdateCandidate } from './updateFeed';

export const UPDATE_REPO = 'UseNestBot/Nest-Bot';
const FIRST_CHECK_MS = 20_000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

export interface UpdaterOptions {
  version: string;
  build: number;
  channel: ReleaseChannel;
  /** Where installers are downloaded (under userData; older ones are cleared). */
  dir: string;
  /** Null when this build can self-update; otherwise the reason shown in Settings. */
  unsupportedReason: string | null;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  onState: (state: UpdateState) => void;
  /** Quit the app (graceful shutdown); index.ts calls `runPendingInstall` on the way out. */
  quit: () => void;
}

/**
 * Checks GitHub releases, downloads the NSIS installer in the background and
 * verifies it, then runs it silently (/S) when Nest restarts or quits. All of
 * the UI is Nest's own: no installer window is ever shown.
 */
export class Updater {
  private state: UpdateState;
  private ready: UpdateCandidate | null = null;
  private relaunch = false;
  private timers: NodeJS.Timeout[] = [];
  private checking: Promise<UpdateState> | null = null;

  constructor(private readonly opts: UpdaterOptions) {
    this.state = opts.unsupportedReason ? { status: 'unsupported', reason: opts.unsupportedReason } : { status: 'idle', checkedAt: null };
  }

  getState(): UpdateState {
    return this.state;
  }

  start(): void {
    if (this.state.status === 'unsupported') return;
    this.timers.push(setTimeout(() => void this.check(), FIRST_CHECK_MS), setInterval(() => void this.check(), CHECK_EVERY_MS));
    for (const t of this.timers) t.unref();
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  check(): Promise<UpdateState> {
    const s = this.state.status;
    if (s === 'unsupported' || s === 'downloading' || s === 'ready') return Promise.resolve(this.state);
    this.checking ??= this.runCheck().finally(() => (this.checking = null));
    return this.checking;
  }

  /** Restart now: quit, run the installer silently, and let it reopen Nest. */
  install(): void {
    if (!this.ready) throw new Error('No update has been downloaded yet.');
    this.relaunch = true;
    this.opts.quit();
  }

  /** Called as the app quits. A downloaded update installs then, even without "Restart". */
  runPendingInstall(): void {
    if (!this.ready) return;
    const file = path.join(this.opts.dir, this.ready.fileName);
    this.ready = null;
    // --updated marks this as an update for electron-builder's installer; --force-run reopens Nest after a silent install.
    const args = ['/S', '--updated', ...(this.relaunch ? ['--force-run'] : [])];
    try {
      spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch (err) {
      console.error('[nest] could not start the update installer:', (err as Error).message);
    }
  }

  private set(state: UpdateState): void {
    this.state = state;
    this.opts.onState(state);
  }

  private async runCheck(): Promise<UpdateState> {
    this.set({ status: 'checking' });
    try {
      const res = await this.opts.fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=30`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Nest/${this.opts.version}` },
      });
      if (!res.ok) throw new Error(res.status === 403 || res.status === 429 ? 'GitHub is rate limiting update checks. Try again later.' : `GitHub answered ${res.status}.`);
      const candidate = pickUpdate((await res.json()) as GithubRelease[], { version: this.opts.version, build: this.opts.build }, this.opts.channel);
      if (!candidate) {
        this.set({ status: 'idle', checkedAt: Date.now() });
        return this.state;
      }
      await this.download(candidate);
      this.ready = candidate;
      this.set({ status: 'ready', release: candidate.release });
    } catch (err) {
      this.set({ status: 'error', message: errorText(err), checkedAt: Date.now() });
    }
    return this.state;
  }

  private async download(c: UpdateCandidate): Promise<void> {
    mkdirSync(this.opts.dir, { recursive: true });
    const file = path.join(this.opts.dir, c.fileName);
    for (const name of readdirSync(this.opts.dir)) if (name !== c.fileName) rmSync(path.join(this.opts.dir, name), { force: true });

    // Already downloaded on an earlier run.
    if (sizeOf(file) === c.release.bytes && (await this.matches(file, c))) return;

    const partial = `${file}.partial`;
    const total = c.release.bytes;
    this.set({ status: 'downloading', release: c.release, received: 0, total });
    const res = await this.opts.fetch(c.downloadUrl, { headers: { 'User-Agent': `Nest/${this.opts.version}` } });
    if (!res.ok || !res.body) throw new Error(`The download failed (${res.status}).`);

    const hash = createHash('sha256');
    const out = createWriteStream(partial);
    let received = 0;
    let lastSent = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        received += value.byteLength;
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
        const now = Date.now();
        if (now - lastSent > 150) {
          lastSent = now;
          this.set({ status: 'downloading', release: c.release, received, total });
        }
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
      if (total && received !== total) throw new Error('The download was incomplete.');
      if (c.sha256 && hash.digest('hex') !== c.sha256) throw new Error('The downloaded installer did not match its checksum.');
    } catch (err) {
      out.destroy();
      rmSync(partial, { force: true });
      throw err;
    }
    renameSync(partial, file);
  }

  private async matches(file: string, c: UpdateCandidate): Promise<boolean> {
    if (!c.sha256) return true;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
    return hash.digest('hex') === c.sha256;
  }
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return -1;
  }
}

function errorText(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err);
  return /fetch failed|ENOTFOUND|ECONNRE|ETIMEDOUT|net::/i.test(msg) ? 'Couldn’t reach GitHub. Check your connection.' : msg;
}
