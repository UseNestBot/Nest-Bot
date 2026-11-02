import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createWriteStream, mkdirSync, readFileSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { API_METHODS, type ApiMethod } from '@shared/ipc';
import type { Attachment, NestEvent, RemoteDevice } from '@shared/types';
import type { RemoteStore } from './store';
import { isPushSubscription } from './webpush';
import { SERVICE_WORKER, webManifest } from './web';

/**
 * What a paired device may not call. Native dialogs, the PC's file manager and
 * browser, updates, sign-in flows, API keys and remote access itself stay on the PC.
 */
export const REMOTE_BLOCKED: ReadonlySet<ApiMethod> = new Set<ApiMethod>([
  'pickFolder',
  'pickFiles',
  'savePastedImage',
  'openExternal',
  'openFolder',
  'startLogin',
  'signOut',
  'setApiKey',
  'clearApiKey',
  'checkForUpdates',
  'installUpdate',
  'listDictationModels',
  'deleteDictationModel',
  'getRemoteState',
  'setRemoteAccess',
  'startRemotePairing',
  'revokeRemoteDevice',
  'setUpTailscale',
  'testRemoteNotification',
]);

/** Settings a paired device can't change: which programs run, and how much they may do unasked. */
export const REMOTE_LOCKED_SETTINGS = ['claudePath', 'codexPath', 'cursorPath', 'geminiPath', 'grokPath', 'allowSkipPermissions', 'skipPermissionsByDefault', 'allowApiKeyBilling'] as const;

/** Drop locked settings from a remote updateSettings patch. */
export function remoteArgs(method: ApiMethod, args: unknown[]): unknown[] {
  if (method !== 'updateSettings') return args;
  const patch = { ...((args[0] ?? {}) as Record<string, unknown>) };
  for (const k of REMOTE_LOCKED_SETTINGS) delete patch[k];
  return [patch];
}

export type CallResult = { ok: true; value: unknown } | { ok: false; error: string };

export interface RemoteServerOptions {
  store: RemoteStore;
  /** The built renderer (out/renderer). */
  staticDir: string;
  /** Where uploaded attachments are saved. */
  uploadsDir: string;
  /** Run one API method on behalf of a paired device. */
  call: (method: ApiMethod, args: unknown[], device: RemoteDevice) => Promise<CallResult>;
  /** Devices or push subscriptions changed. */
  onChange: () => void;
}

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Nest's web app for phones. It listens on 127.0.0.1 only: `tailscale serve`
 * terminates HTTPS on the tailnet and forwards here, so nothing on the LAN or
 * the internet can reach it directly. Every API call needs a device token
 * obtained with a one-time pairing code shown on the PC.
 */
export class RemoteServer {
  private server: Server | null = null;
  private streams = new Map<ServerResponse, string>();
  private pairAttempts: number[] = [];
  private heartbeat: NodeJS.Timeout | null = null;
  error: string | null = null;

  constructor(private readonly opts: RemoteServerOptions) {}

  get running(): boolean {
    return this.server?.listening ?? false;
  }

  async start(port: number): Promise<void> {
    await this.stop();
    const server = createServer((req, res) => void this.handle(req, res));
    // Event streams stay open; requests otherwise finish quickly.
    server.requestTimeout = 0;
    server.headersTimeout = 30_000;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      this.error = code === 'EADDRINUSE' ? `Port ${port} is already in use. Pick another port.` : (err as Error).message;
      return;
    }
    this.error = null;
    this.server = server;
    this.heartbeat = setInterval(() => {
      for (const res of this.streams.keys()) res.write(': ping\n\n');
    }, 20_000);
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const res of this.streams.keys()) res.end();
    this.streams.clear();
    const server = this.server;
    this.server = null;
    if (server) {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      // Idle keep-alive connections would otherwise hold close() open.
      server.closeAllConnections();
      await closed;
    }
  }

  broadcast(event: NestEvent): void {
    if (!this.streams.size) return;
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of this.streams.keys()) res.write(line);
  }

  /** Close a revoked device's open event streams. */
  disconnect(deviceId: string): void {
    for (const [res, id] of this.streams) {
      if (id === deviceId) {
        res.end();
        this.streams.delete(res);
      }
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) await this.api(req, res, url);
      else if (req.method === 'GET' || req.method === 'HEAD') this.serveStatic(res, url.pathname);
      else throw new HttpError(405, 'Method not allowed');
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (!(err instanceof HttpError)) console.error('[nest] remote request failed', err);
      if (!res.headersSent) sendJson(res, status, { ok: false, error: err instanceof HttpError ? err.message : 'Something went wrong on the PC.' });
      else res.end();
    }
  }

  private async api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const route = url.pathname.slice('/api/'.length);
    res.setHeader('Cache-Control', 'no-store');

    if (route === 'pair' && req.method === 'POST') {
      const now = Date.now();
      this.pairAttempts = this.pairAttempts.filter((t) => now - t < 60_000);
      if (this.pairAttempts.length >= 10) throw new HttpError(429, 'Too many attempts. Wait a minute and try again.');
      this.pairAttempts.push(now);
      const body = (await readJson(req)) as { code?: unknown; name?: unknown };
      const paired = this.opts.store.pair(String(body.code ?? '').trim(), String(body.name ?? ''));
      if (!paired) throw new HttpError(401, 'That code didn’t work. Open Settings → Remote access on your PC for a new one.');
      this.opts.onChange();
      return sendJson(res, 200, { ok: true, value: { token: paired.token, deviceId: paired.device.id } });
    }

    const device = this.opts.store.authenticate(bearer(req));
    if (!device) throw new HttpError(401, 'This device isn’t paired with Nest any more.');

    if (route === 'events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(': connected\n\n');
      this.streams.set(res, device.id);
      req.on('close', () => this.streams.delete(res));
      return;
    }

    if (route === 'push' && req.method === 'GET') return sendJson(res, 200, { ok: true, value: { publicKey: this.opts.store.vapidKeys().publicKey, subscribed: device.push } });
    if (route === 'push' && req.method === 'POST') {
      const body = (await readJson(req)) as { subscription?: unknown };
      if (body.subscription !== null && !isPushSubscription(body.subscription)) throw new HttpError(400, 'Invalid push subscription');
      this.opts.store.setPush(device.id, body.subscription ?? null);
      this.opts.onChange();
      return sendJson(res, 200, { ok: true, value: null });
    }

    if (route === 'upload' && req.method === 'POST') return sendJson(res, 200, { ok: true, value: await this.upload(req) });

    if (route.startsWith('call/') && req.method === 'POST') {
      const method = route.slice('call/'.length) as ApiMethod;
      if (!(API_METHODS as readonly string[]).includes(method)) throw new HttpError(404, 'Unknown method');
      if (REMOTE_BLOCKED.has(method)) throw new HttpError(403, 'Do this on your PC.');
      const body = (await readJson(req)) as { args?: unknown };
      const args = Array.isArray(body.args) ? body.args : [];
      return sendJson(res, 200, await this.opts.call(method, remoteArgs(method, args), device));
    }

    throw new HttpError(404, 'Not found');
  }

  /** Save a request body as a file the agents can read by path. */
  private async upload(req: IncomingMessage): Promise<Attachment> {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_UPLOAD_BYTES) throw new HttpError(413, 'That file is too large (50 MB max).');
    let raw = '';
    try {
      raw = decodeURIComponent(String(req.headers['x-file-name'] ?? ''));
    } catch {
      raw = '';
    }
    const name = safeFileName(raw) || 'upload';
    mkdirSync(this.opts.uploadsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const file = path.join(this.opts.uploadsDir, `${stamp}-${randomBytes(3).toString('hex')}-${name}`);
    let size = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        cb(size > MAX_UPLOAD_BYTES ? new HttpError(413, 'That file is too large (50 MB max).') : null, chunk);
      },
    });
    await pipeline(req, limit, createWriteStream(file));
    if (!size) throw new HttpError(400, 'The file is empty.');
    return { path: file, name, isImage: IMAGE_EXT.test(name) };
  }

  private serveStatic(res: ServerResponse, pathname: string): void {
    if (pathname === '/manifest.webmanifest') return send(res, 200, 'application/manifest+json', webManifest(), 'no-cache');
    // At the root so it controls the whole app.
    if (pathname === '/sw.js') return send(res, 200, 'text/javascript; charset=utf-8', SERVICE_WORKER, 'no-cache');

    const root = path.resolve(this.opts.staticDir);
    let rel = '';
    try {
      rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    } catch {
      throw new HttpError(400, 'Bad path');
    }
    const file = path.resolve(root, rel);
    if (rel && file.startsWith(root + path.sep) && isFile(file)) {
      const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
      // Vite fingerprints everything under assets/.
      const cache = rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
      return send(res, 200, type, readFileSync(file), cache);
    }
    if (path.extname(rel)) throw new HttpError(404, 'Not found');
    // Any other path is the app itself.
    const indexFile = path.join(root, 'index.html');
    if (!isFile(indexFile)) throw new HttpError(503, 'Nest’s web app isn’t built. Run `npm run build` on the PC.');
    send(res, 200, TYPES['.html'], webIndex(readFileSync(indexFile, 'utf8')), 'no-cache');
  }
}

/** The desktop index.html, plus what makes it installable on a phone's home screen. */
export function webIndex(html: string): string {
  const head = [
    '<link rel="manifest" href="/manifest.webmanifest" />',
    '<link rel="apple-touch-icon" href="/icon-192.png" />',
    '<meta name="apple-mobile-web-app-capable" content="yes" />',
    '<meta name="mobile-web-app-capable" content="yes" />',
    '<meta name="apple-mobile-web-app-status-bar-style" content="default" />',
    '<meta name="apple-mobile-web-app-title" content="Nest" />',
  ].join('\n    ');
  return html
    .replace(/<meta name="viewport"[^>]*>/, '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />')
    .replace('</head>', `    ${head}\n  </head>`);
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function bearer(req: IncomingMessage): string {
  const h = req.headers.authorization ?? '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

function safeFileName(name: string): string {
  return path
    .basename(name.replace(/\\/g, '/'))
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/^\.+/, '')
    .slice(-120);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_JSON_BYTES) throw new HttpError(413, 'Request too large');
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, 'application/json', JSON.stringify(body), 'no-store');
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer, cache: string): void {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': cache });
  res.end(body);
}
