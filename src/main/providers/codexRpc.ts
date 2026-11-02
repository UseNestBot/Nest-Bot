import type { ChildProcess } from 'node:child_process';
import { JsonlReader } from './jsonl';
import { buildChildEnv, killTree, spawnProvider, type ResolvedExecutable } from './process';

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

type Id = number | string;

export interface ServerRequest {
  id: Id;
  method: string;
  params: Record<string, unknown>;
}

/**
 * JSON-RPC client for `codex app-server` over stdio (JSONL, `jsonrpc` field omitted).
 * One process serves every Codex thread in the app.
 */
export class CodexRpc {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<Id, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout | null }>();
  private notificationListeners = new Set<(method: string, params: Record<string, unknown>) => void>();
  private requestHandler: ((req: ServerRequest) => void) | null = null;
  private exitListeners = new Set<(reason: string) => void>();
  private starting: Promise<void> | null = null;
  private stderrTail = '';
  alive = false;

  constructor(
    private readonly exe: ResolvedExecutable,
    private readonly clientVersion: string,
  ) {}

  ensureStarted(): Promise<void> {
    if (this.alive) return Promise.resolve();
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private async start(): Promise<void> {
    const { env } = buildChildEnv('codex');
    const child = spawnProvider(this.exe, ['app-server'], { env });
    this.child = child;
    const reader = new JsonlReader(
      (record) => this.handle(record),
      () => {
        /* malformed line: skipped, other records continue */
      },
    );
    child.stdout?.on('data', (c: Buffer) => reader.push(c));
    child.stderr?.on('data', (c: Buffer) => {
      this.stderrTail = (this.stderrTail + c.toString('utf8')).slice(-4000);
    });
    child.stdin?.on('error', () => {});
    const exited = new Promise<string>((resolve) => {
      child.on('error', (err) => resolve(`Codex app-server failed to start: ${err.message}`));
      child.on('exit', (code) => resolve(`Codex app-server exited (code ${code ?? 'unknown'}). ${this.stderrTail.trim().split('\n').slice(-3).join(' ')}`.trim()));
    });
    void exited.then((reason) => {
      reader.end();
      this.alive = false;
      if (this.child === child) this.child = null;
      for (const [, p] of this.pending) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(new RpcError(reason, -32000));
      }
      this.pending.clear();
      for (const l of this.exitListeners) l(reason);
    });
    this.alive = true;
    try {
      await this.request('initialize', { clientInfo: { name: 'nest', title: 'Nest', version: this.clientVersion } }, 20000);
      this.notify('initialized', {});
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  private handle(record: unknown): void {
    if (typeof record !== 'object' || record === null) return;
    const msg = record as { id?: Id; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string; data?: unknown } };
    // Opt-in protocol trace: method names and ids only, never payloads.
    if (process.env.NEST_DEBUG_PROTOCOL) console.log(`[codex] <- ${msg.method ?? 'response'}${msg.id !== undefined ? ` #${String(msg.id)}` : ''}${msg.error ? ` error ${msg.error.code}` : ''}`);
    if (msg.method !== undefined && msg.id !== undefined) {
      const req: ServerRequest = { id: msg.id, method: msg.method, params: msg.params ?? {} };
      if (this.requestHandler) this.requestHandler(req);
      else this.respondError(req.id, -32601, `Unhandled request ${req.method}`);
      return;
    }
    if (msg.method !== undefined) {
      for (const l of this.notificationListeners) l(msg.method, msg.params ?? {});
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) p.reject(new RpcError(msg.error.message, msg.error.code, msg.error.data));
      else p.resolve(msg.result);
    }
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs: number | null = 60000): Promise<T> {
    if (!this.alive || !this.child?.stdin?.writable) return Promise.reject(new RpcError('Codex app-server is not running', -32000));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new RpcError(`${method} timed out after ${timeoutMs} ms`, -32001));
          }, timeoutMs)
        : null;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  respond(id: Id, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: Id, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  private write(payload: unknown): void {
    if (this.child?.stdin?.writable) this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  onNotification(listener: (method: string, params: Record<string, unknown>) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  setRequestHandler(handler: (req: ServerRequest) => void): void {
    this.requestHandler = handler;
  }

  onExit(listener: (reason: string) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.alive = false;
    if (!child) return;
    child.stdin?.end();
    await killTree(child);
  }
}
