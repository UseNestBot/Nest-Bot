import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ActivityKind, ActivityStatus, AppSettings, ApprovalChoice, ConnectorInventory, LoginStart, ModelOption, ProviderStatus } from '@shared/types';
import { PROVIDER_LABEL } from '@shared/types';
import { JsonlReader } from './jsonl';
import { isObject } from './claudeMapper';
import { buildChildEnv, killTree, runCapture, spawnProvider, waitForExit, type ResolvedExecutable } from './process';
import { emptyStatus, truncate, type ProviderAdapter, type ProviderEvent, type TurnHandle, type TurnInput } from './types';

/**
 * Agent Client Protocol (https://agentclientprotocol.com): JSON-RPC 2.0 over the
 * agent's stdio. Cursor (`agent acp`), Gemini CLI (`gemini --experimental-acp`)
 * and xAI's Grok CLI (`grok agent stdio`) all speak it, so one adapter drives
 * the three. Permission prompts arrive as `session/request_permission`
 * requests and become Nest approval cards, so a run never waits on a terminal
 * Nest can't see.
 */

export type AcpProviderId = 'cursor' | 'gemini' | 'grok';

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

export class AcpError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
  ) {
    super(message);
  }
}

/** One JSON-RPC connection to an ACP agent process. */
export class AcpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private stderrTail = '';
  private exited = false;
  readonly exit: Promise<number | null>;
  onNotification: (method: string, params: Record<string, unknown>) => void = () => {};
  /** Requests from the agent; throw to answer with an error. */
  onRequest: (method: string, params: Record<string, unknown>, id: number | string) => Promise<unknown> | 'defer' = () => {
    throw new AcpError('Method not supported by Nest', -32601);
  };
  onBadLine: (line: string, err: Error) => void = () => {};

  constructor(readonly child: ChildProcess) {
    const reader = new JsonlReader((m) => this.handle(m), (line, err) => this.onBadLine(line, err));
    child.stdout?.on('data', (c: Buffer) => reader.push(c));
    child.stderr?.on('data', (c: Buffer) => {
      this.stderrTail = (this.stderrTail + c.toString('utf8')).slice(-4000);
    });
    child.stdin?.on('error', () => {});
    this.exit = new Promise((resolve) => {
      const done = (code: number | null) => {
        if (this.exited) return;
        this.exited = true;
        reader.end();
        const err = new AcpError(`${this.describeExit(code)}`, null);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        resolve(code);
      };
      child.on('exit', (code) => done(code));
      child.on('error', () => done(null));
    });
  }

  describeExit(code: number | null): string {
    const tail = this.stderrTail.trim().split('\n').slice(-6).join('\n');
    return `The agent process exited (code ${code ?? 'unknown'}).${tail ? `\n${tail}` : ''}`;
  }

  get stderr(): string {
    return this.stderrTail;
  }

  request<T = Record<string, unknown>>(method: string, params: unknown, timeoutMs = 0): Promise<T> {
    if (this.exited) return Promise.reject(new AcpError('The agent process is not running.', null));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      if (timeoutMs) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new AcpError(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`, null));
        }, timeoutMs);
      }
      this.pending.set(id, {
        resolve: (v) => {
          if (timer) clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  respond(id: number | string, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  respondError(id: number | string, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private write(payload: unknown): void {
    const stdin = this.child.stdin;
    if (stdin && !stdin.destroyed && stdin.writable) stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private handle(m: unknown): void {
    if (!isObject(m)) return;
    const hasId = typeof m.id === 'number' || typeof m.id === 'string';
    if (typeof m.method === 'string') {
      const params = isObject(m.params) ? m.params : {};
      if (!hasId) {
        this.onNotification(m.method, params);
        return;
      }
      const id = m.id as number | string;
      try {
        const out = this.onRequest(m.method, params, id);
        if (out === 'defer') return;
        void Promise.resolve(out).then(
          (result) => this.respond(id, result ?? null),
          (err: Error) => this.respondError(id, err instanceof AcpError && err.code !== null ? err.code : -32603, err.message),
        );
      } catch (err) {
        this.respondError(id, err instanceof AcpError && err.code !== null ? err.code : -32603, (err as Error).message);
      }
      return;
    }
    if (!hasId || typeof m.id !== 'number') return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (isObject(m.error)) p.reject(new AcpError(typeof m.error.message === 'string' ? m.error.message : 'Agent error', typeof m.error.code === 'number' ? m.error.code : null));
    else p.resolve(isObject(m.result) ? m.result : {});
  }

  /** Close stdin, then make sure the process tree is gone. */
  async close(graceMs = 3000): Promise<void> {
    this.child.stdin?.end();
    if (!this.exited) await waitForExit(this.child, graceMs);
  }
}

// ---------------------------------------------------------------------------
// session/update → ProviderEvent

const ACP_KIND: Record<string, ActivityKind> = {
  execute: 'command',
  edit: 'file',
  delete: 'file',
  move: 'file',
  read: 'file',
  search: 'search',
  fetch: 'search',
  think: 'info',
};

function toolStatus(status: unknown): ActivityStatus | null {
  if (status === 'pending' || status === 'in_progress') return 'running';
  if (status === 'completed') return 'done';
  if (status === 'failed') return 'failed';
  return null;
}

/** Text out of an ACP content block list (tool call content, rawOutput). */
function contentText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const item of content) {
    if (!isObject(item)) continue;
    if (item.type === 'content' && isObject(item.content) && typeof item.content.text === 'string') parts.push(item.content.text);
    else if (item.type === 'diff' && typeof item.path === 'string') parts.push(`Edited ${item.path}`);
    else if (item.type === 'terminal') parts.push('(terminal output)');
  }
  return parts.length ? parts.join('\n') : null;
}

function rawOutputText(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === 'string') return raw;
  if (isObject(raw)) {
    const out = [raw.stdout, raw.stderr, raw.output, raw.content].filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (out.length) return out.join('\n');
  }
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return null;
  }
}

function inputDetail(raw: unknown): string | null {
  if (raw == null) return null;
  if (isObject(raw) && typeof raw.command === 'string') return raw.command;
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return null;
  }
}

export class AcpUpdateMapper {
  private segment = 0;
  private textInSegment = false;
  private readonly tools = new Map<string, { title: string; kind: ActivityKind; detail: string | null }>();

  map(update: Record<string, unknown>): ProviderEvent[] {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const content = isObject(update.content) ? update.content : null;
        if (content?.type !== 'text' || typeof content.text !== 'string') return [];
        this.textInSegment = true;
        return [{ type: 'text-delta', segmentId: `acp-${this.segment}`, text: content.text }];
      }
      case 'tool_call': {
        const id = typeof update.toolCallId === 'string' ? update.toolCallId : `tool-${this.tools.size}`;
        if (this.textInSegment) {
          // Text after a tool call is its own paragraph.
          this.segment++;
          this.textInSegment = false;
        }
        const kind = (typeof update.kind === 'string' && ACP_KIND[update.kind]) || (/^mcp/i.test(String(update.title ?? '')) ? 'mcp' : 'tool');
        const title = typeof update.title === 'string' && update.title.trim() ? update.title.trim() : 'Tool call';
        const detail = inputDetail(update.rawInput);
        this.tools.set(id, { title, kind, detail });
        return [{ type: 'activity', id, kind, title: truncate(title, 300), detail: detail ? truncate(detail, 4000) : null, output: contentText(update.content), status: toolStatus(update.status) ?? 'running' }];
      }
      case 'tool_call_update': {
        const id = typeof update.toolCallId === 'string' ? update.toolCallId : null;
        if (!id) return [];
        const known = this.tools.get(id) ?? { title: 'Tool call', kind: 'tool' as ActivityKind, detail: null };
        if (typeof update.title === 'string' && update.title.trim()) known.title = update.title.trim();
        if (update.rawInput !== undefined) known.detail = inputDetail(update.rawInput);
        this.tools.set(id, known);
        const output = contentText(update.content) ?? rawOutputText(update.rawOutput);
        return [{ type: 'activity', id, kind: known.kind, title: truncate(known.title, 300), detail: known.detail ? truncate(known.detail, 4000) : null, output: output ? truncate(output, 20000) : null, status: toolStatus(update.status) ?? 'running' }];
      }
      case 'plan': {
        const entries = Array.isArray(update.entries) ? update.entries.filter(isObject) : [];
        if (!entries.length) return [];
        const done = entries.filter((e) => e.status === 'completed').length;
        return [{
          type: 'activity',
          id: 'acp-plan',
          kind: 'info',
          title: `Plan: ${done}/${entries.length} done`,
          detail: entries.map((e) => `${e.status === 'completed' ? '✓' : e.status === 'in_progress' ? '→' : '·'} ${String(e.content ?? '')}`).join('\n'),
          status: done === entries.length ? 'done' : 'running',
        }];
      }
      default:
        // Thoughts, user message replays, command lists, titles and mode changes aren't shown.
        return [];
    }
  }
}

/** ACP permission options → Nest approval choices. "Allow always" is left out: it can write permanent rules in the agent's own config. */
export function acpPermissionChoices(options: unknown): { choices: ApprovalChoice[]; optionFor: Record<string, string | null> } {
  const list = Array.isArray(options) ? options.filter(isObject) : [];
  const find = (kind: string) => {
    const o = list.find((x) => x.kind === kind);
    return o && typeof o.optionId === 'string' ? o.optionId : null;
  };
  const allow = find('allow_once');
  const reject = find('reject_once') ?? find('reject_always');
  const choices: ApprovalChoice[] = [];
  if (allow) choices.push({ id: 'allow', label: 'Allow once', tone: 'primary' });
  choices.push({ id: 'deny', label: 'Deny', tone: 'neutral' }, { id: 'deny-stop', label: 'Deny and stop', tone: 'danger' });
  return { choices, optionFor: { allow, deny: reject, 'deny-stop': reject } };
}

function promptBlocks(input: TurnInput, text: string, images: boolean): unknown[] {
  const blocks: unknown[] = [{ type: 'text', text }];
  if (!images) return blocks;
  for (const att of input.attachments) {
    if (!att.isImage) continue;
    const mimeType = IMAGE_TYPES[path.extname(att.path).toLowerCase()];
    if (!mimeType) continue;
    try {
      if (statSync(att.path).size > MAX_INLINE_IMAGE_BYTES) continue;
      blocks.push({ type: 'image', mimeType, data: readFileSync(att.path).toString('base64') });
    } catch {
      /* unreadable attachments are listed in the prompt text instead */
    }
  }
  return blocks;
}

/** The ACP mode that matches Nest's permission choice, if the agent offers one. */
export function pickMode(modes: Array<{ id: string; name?: string }>, permissions: TurnInput['permissions']): string | null {
  const find = (re: RegExp) => modes.find((m) => re.test(m.id) || re.test(m.name ?? ''))?.id ?? null;
  if (permissions.skipped) return find(/yolo|bypass|full.?access/i);
  switch (permissions.claudeMode) {
    case 'plan':
      return find(/^plan$/i) ?? find(/plan/i);
    case 'acceptEdits':
      return find(/auto.?edit|accept.?edit/i);
    default:
      return find(/^(default|agent)$/i);
  }
}

// ---------------------------------------------------------------------------
// Provider definitions

export interface AuthCheck {
  /** null: can't tell without starting a session. */
  signedIn: boolean | null;
  account: string | null;
  /** Signed in with an API key rather than an account. */
  apiKey: boolean;
}

export interface AcpDefinition {
  id: AcpProviderId;
  resolve(settings: AppSettings): ResolvedExecutable | null;
  installHint: string;
  /** Arguments that start the agent in ACP mode; may depend on the installed version. */
  acpArgs(exe: ResolvedExecutable, env: NodeJS.ProcessEnv): Promise<string[]>;
  /** Extra launch arguments for a turn (e.g. a model flag the agent only takes at startup). */
  launchArgs?(input: TurnInput): string[];
  /** `authenticate` method to call after initialize, chosen from what the agent offers. */
  authMethod?(offered: string[]): string | null;
  checkAuth?(exe: ResolvedExecutable, env: NodeJS.ProcessEnv): Promise<AuthCheck>;
  login: { display: string; args: string[] };
  logoutArgs: string[] | null;
  signedOutAction: string;
  /** Used when the agent doesn't list its models. */
  fallbackModels: ModelOption[];
}

const DEFAULT_MODEL: ModelOption = { id: '', label: 'Default', isDefault: true, efforts: [], defaultEffort: null };

interface SessionInfo {
  sessionId: string;
  models: Array<{ modelId: string; name: string }>;
  currentModelId: string | null;
  modes: Array<{ id: string; name?: string }>;
  currentModeId: string | null;
}

function sessionInfo(result: Record<string, unknown>, sessionId: string): SessionInfo {
  const models = isObject(result.models) ? result.models : {};
  const modes = isObject(result.modes) ? result.modes : {};
  return {
    sessionId,
    models: (Array.isArray(models.availableModels) ? models.availableModels : [])
      .filter(isObject)
      .filter((m) => typeof m.modelId === 'string')
      .map((m) => ({ modelId: String(m.modelId), name: typeof m.name === 'string' ? m.name : String(m.modelId) })),
    currentModelId: typeof models.currentModelId === 'string' ? models.currentModelId : null,
    modes: (Array.isArray(modes.availableModes) ? modes.availableModes : [])
      .filter(isObject)
      .filter((m) => typeof m.id === 'string')
      .map((m) => ({ id: String(m.id), name: typeof m.name === 'string' ? m.name : undefined })),
    currentModeId: typeof modes.currentModeId === 'string' ? modes.currentModeId : null,
  };
}

export class AcpProvider implements ProviderAdapter {
  readonly capabilities = { modelListing: 'dynamic', approvals: true, images: true, permissionControls: 'claude-modes' } as const;
  private status: ProviderStatus;
  private exe: ResolvedExecutable | null = null;
  private args: string[] | null = null;
  private models: ModelOption[] | null = null;
  private readonly active = new Set<AcpConnection>();

  constructor(
    private readonly def: AcpDefinition,
    private readonly getSettings: () => AppSettings,
    private readonly onStatus: (status: ProviderStatus) => void,
    /** Folder used to open throwaway sessions when listing models. */
    private readonly probeDir: () => string,
  ) {
    this.status = emptyStatus(def.id);
  }

  get id(): AcpProviderId {
    return this.def.id;
  }

  getStatus(): ProviderStatus {
    return this.status;
  }

  private env(): NodeJS.ProcessEnv {
    // With API billing allowed, a key in the environment may be how the user signs this agent in.
    return buildChildEnv(this.def.id, process.env, { keepBillingVars: this.getSettings().allowApiKeyBilling }).env;
  }

  private setStatus(status: ProviderStatus): ProviderStatus {
    status.checkedAt = Date.now();
    this.status = status;
    this.onStatus(status);
    return status;
  }

  async detect(): Promise<ProviderStatus> {
    const settings = this.getSettings();
    const label = PROVIDER_LABEL[this.def.id];
    const status = emptyStatus(this.def.id);
    this.exe = this.def.resolve(settings);
    if (!this.exe) {
      status.state = 'not-installed';
      status.action = this.def.installHint;
      return this.setStatus(status);
    }
    status.executable = this.exe.prefixArgs[0] ?? this.exe.command;
    const env = this.env();
    const version = await runCapture(this.exe, ['--version'], env);
    status.version = version.stdout.trim().split(/\s+/).find((w) => /\d/.test(w)) ?? null;
    if (version.code !== 0 && !status.version) {
      status.state = 'error';
      status.detail = (version.stderr || version.stdout).trim().slice(0, 500);
      status.action = `${label} is installed but failed to start. Run it in a terminal to see the problem.`;
      return this.setStatus(status);
    }
    this.args = await this.def.acpArgs(this.exe, env);
    let auth: AuthCheck = { signedIn: null, account: null, apiKey: false };
    if (this.def.checkAuth) auth = await this.def.checkAuth(this.exe, env).catch(() => auth);
    if (auth.signedIn === null) auth = { ...auth, signedIn: await this.handshake().then(() => true, () => false) };
    status.account = auth.account;
    if (!auth.signedIn) {
      status.state = 'signed-out';
      status.action = this.def.signedOutAction;
    } else if (auth.apiKey && !settings.allowApiKeyBilling) {
      status.state = 'api-key';
      status.action = `${label} is signed in with an API key, which bills per token. Sign in with your account instead, or allow API billing in Settings.`;
    } else {
      status.state = 'ready';
    }
    return this.setStatus(status);
  }

  /** Start the agent, initialize and authenticate. The caller owns the returned connection. */
  private async open(cwd: string | undefined, extraArgs: string[] = []): Promise<{ conn: AcpConnection; init: Record<string, unknown> }> {
    if (!this.exe || !this.args) await this.detect();
    const exe = this.exe;
    if (!exe || !this.args) throw new AcpError(`${PROVIDER_LABEL[this.def.id]} is not installed.`, null);
    const child = spawnProvider(exe, [...extraArgs, ...this.args], { cwd, env: this.env() });
    const conn = new AcpConnection(child);
    this.active.add(conn);
    void conn.exit.then(() => this.active.delete(conn));
    try {
      const init = await conn.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, 60_000);
      const offered = (Array.isArray(init.authMethods) ? init.authMethods : []).filter(isObject).map((m) => String(m.id));
      const method = this.def.authMethod?.(offered) ?? null;
      if (method) await conn.request('authenticate', { methodId: method }, 60_000);
      return { conn, init };
    } catch (err) {
      await killTree(child);
      throw err;
    }
  }

  private async handshake(): Promise<void> {
    const { conn } = await this.open(this.probeDir());
    await killTree(conn.child);
  }

  async listModels(): Promise<ModelOption[]> {
    if (this.models) return this.models;
    if (this.status.state !== 'ready') return [DEFAULT_MODEL, ...this.def.fallbackModels];
    try {
      const cwd = this.probeDir();
      const { conn } = await this.open(cwd);
      try {
        const result = await conn.request('session/new', { cwd, mcpServers: [] }, 60_000);
        const info = sessionInfo(result, String(result.sessionId ?? ''));
        this.models = info.models.length
          ? [DEFAULT_MODEL, ...info.models.filter((m) => !/^default(\[\])?$/i.test(m.modelId)).map((m) => ({ id: m.modelId, label: m.name, isDefault: false, efforts: [], defaultEffort: null }))]
          : [DEFAULT_MODEL, ...this.def.fallbackModels];
      } finally {
        await killTree(conn.child);
      }
    } catch {
      return [DEFAULT_MODEL, ...this.def.fallbackModels];
    }
    return this.models;
  }

  async startLogin(): Promise<LoginStart> {
    if (!this.exe) await this.detect();
    const exe = this.exe;
    const label = PROVIDER_LABEL[this.def.id];
    if (!exe) return { kind: 'terminal', message: `${label} is not installed.`, command: this.def.login.display };
    // A detached console program gets its own console window, where the agent's own sign-in runs unmodified.
    const child = spawn(exe.command, [...exe.prefixArgs, ...this.def.login.args], { detached: true, stdio: 'ignore', windowsHide: false, env: this.env(), shell: false });
    child.on('error', () => {});
    child.unref();
    this.models = null;
    return { kind: 'terminal', message: `A console window opened running ${label}’s sign-in. Finish it there (and in your browser if it opens one), then press Recheck.`, command: this.def.login.display };
  }

  async signOut(): Promise<void> {
    if (!this.exe) await this.detect();
    if (this.exe && this.def.logoutArgs) await runCapture(this.exe, this.def.logoutArgs, this.env());
    this.models = null;
    await this.detect();
  }

  async listConnectors(): Promise<ConnectorInventory> {
    return {
      provider: this.def.id,
      connectors: [],
      browser: { available: false, ready: false, missing: [], note: `${PROVIDER_LABEL[this.def.id]} uses the MCP servers in its own configuration; Nest doesn’t list or restrict them yet.` },
      error: null,
      checkedAt: Date.now(),
    };
  }

  startTurn(input: TurnInput, emit: (event: ProviderEvent) => void): TurnHandle {
    const label = PROVIDER_LABEL[this.def.id];
    let finished = false;
    let cancelRequested = false;
    let conn: AcpConnection | null = null;
    let sessionId: string | null = null;
    let promptSettled: Promise<unknown> | null = null;
    const pending = new Map<string, { rpcId: number | string; optionFor: Record<string, string | null> }>();
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));

    const finish = (status: 'completed' | 'interrupted' | 'failed', error?: string) => {
      if (finished) return;
      finished = true;
      for (const [id, p] of pending) {
        conn?.respond(p.rpcId, { outcome: { outcome: 'cancelled' } });
        emit({ type: 'approval-cancelled', requestId: id });
      }
      pending.clear();
      if (error) emit({ type: 'error', message: error, fatal: true });
      emit({ type: 'completed', status, error });
      resolveDone();
      if (conn) void conn.close();
    };

    const start = async () => {
      const cwd = input.cwd ?? undefined;
      const opened = await this.open(cwd, this.def.launchArgs?.(input) ?? []);
      conn = opened.conn;
      if (cancelRequested) {
        finish('interrupted');
        return;
      }
      const caps = isObject(opened.init.agentCapabilities) ? opened.init.agentCapabilities : {};
      const promptCaps = isObject(caps.promptCapabilities) ? caps.promptCapabilities : {};
      const mapper = new AcpUpdateMapper();
      let replaying = false;

      conn.onBadLine = (line, err) => emit({ type: 'activity', id: `parse-${Date.now()}-${Math.random()}`, kind: 'info', title: 'Skipped an unreadable output line', detail: `${err.message}: ${line.slice(0, 200)}`, status: 'failed' });
      conn.onNotification = (method, params) => {
        if (method !== 'session/update' || replaying || !isObject(params.update)) return;
        for (const event of mapper.map(params.update)) emit(event);
      };
      conn.onRequest = (method, params, rpcId) => {
        if (method !== 'session/request_permission') throw new AcpError(`Nest does not provide ${method}`, -32601);
        const tool = isObject(params.toolCall) ? params.toolCall : {};
        const requestId = typeof tool.toolCallId === 'string' ? `${tool.toolCallId}#${String(rpcId)}` : `perm-${String(rpcId)}`;
        const { choices, optionFor } = acpPermissionChoices(params.options);
        pending.set(requestId, { rpcId, optionFor });
        const title = typeof tool.title === 'string' && tool.title.trim() ? tool.title.trim() : 'Use a tool';
        const raw = isObject(tool.rawInput) ? tool.rawInput : null;
        emit({
          type: 'approval-request',
          requestId,
          title: tool.kind === 'execute' ? 'Run a command' : tool.kind === 'edit' || tool.kind === 'delete' || tool.kind === 'move' ? 'Change files' : `${label} wants to use a tool`,
          action: typeof raw?.command === 'string' ? raw.command : title,
          target: Array.isArray(tool.locations) && isObject(tool.locations[0]) && typeof tool.locations[0].path === 'string' ? tool.locations[0].path : null,
          reason: contentText(tool.content),
          detail: raw ? truncate(JSON.stringify(raw, null, 2), 4000) : null,
          choices,
        });
        return 'defer';
      };

      const mcpServers = input.mcp
        ? [{ name: 'nest', command: input.mcp.command, args: input.mcp.args, env: Object.entries(input.mcp.env).map(([name, value]) => ({ name, value })) }]
        : [];
      const sessionCwd = path.resolve(input.cwd ?? this.probeDir());
      let info: SessionInfo;
      let fresh = false;
      if (input.sessionId) {
        if (caps.loadSession !== true) {
          emit({ type: 'error', message: `${label} can’t reopen earlier sessions.`, code: 'session-missing', fatal: true });
          finish('failed', `${label} can’t reopen earlier sessions.`);
          return;
        }
        replaying = true; // session/load replays the history as updates
        try {
          const result = await conn.request('session/load', { sessionId: input.sessionId, cwd: sessionCwd, mcpServers });
          info = sessionInfo(result, input.sessionId);
        } catch (err) {
          emit({ type: 'error', message: `Could not reopen the ${label} session: ${(err as Error).message}`, code: 'session-missing', fatal: true });
          finish('failed', `Could not reopen the ${label} session: ${(err as Error).message}`);
          return;
        } finally {
          replaying = false;
        }
      } else {
        const result = await conn.request('session/new', { cwd: sessionCwd, mcpServers });
        if (typeof result.sessionId !== 'string') throw new AcpError(`${label} did not return a session id.`, null);
        info = sessionInfo(result, result.sessionId);
        fresh = true;
        emit({ type: 'session', sessionId: result.sessionId });
      }
      sessionId = info.sessionId;

      if (input.model && info.models.length && info.currentModelId !== input.model) {
        await conn.request('session/set_model', { sessionId, modelId: input.model }).catch((err: Error) => {
          emit({ type: 'activity', id: 'acp-model', kind: 'info', title: `Couldn’t switch to ${input.model}; using ${label}’s default`, detail: err.message, status: 'failed' });
        });
      }
      const mode = pickMode(info.modes, input.permissions);
      if (mode && mode !== info.currentModeId) await conn.request('session/set_mode', { sessionId, modeId: mode }).catch(() => {});

      // ACP has no system prompt field, so a new session gets the agent's instructions with its first message.
      const text = fresh && input.instructions.trim() ? `<nest-agent-instructions>\n${input.instructions.trim()}\n</nest-agent-instructions>\n\n${input.prompt}` : input.prompt;
      const prompt = conn.request('session/prompt', { sessionId, prompt: promptBlocks(input, text, promptCaps.image === true) });
      promptSettled = prompt.catch(() => null);
      const result = await prompt;
      const usage = isObject(result.usage) ? result.usage : null;
      if (usage) {
        const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
        emit({ type: 'usage', usage: { inputTokens: num(usage.inputTokens), outputTokens: num(usage.outputTokens), cachedInputTokens: num(usage.cachedReadTokens) } });
      }
      const stop = result.stopReason;
      if (stop === 'cancelled' || cancelRequested) finish('interrupted');
      else if (stop === 'refusal') finish('failed', `${label} declined to continue.`);
      else {
        if (stop === 'max_tokens' || stop === 'max_turn_requests') emit({ type: 'activity', id: 'acp-stop', kind: 'info', title: stop === 'max_tokens' ? 'Stopped at the model’s output limit' : 'Stopped at the agent’s turn limit', status: 'done' });
        finish('completed');
      }
    };

    const respondApproval = (requestId: string, choiceId: string) => {
      const p = pending.get(requestId);
      if (!p || !conn) return;
      pending.delete(requestId);
      const optionId = p.optionFor[choiceId] ?? null;
      conn.respond(p.rpcId, optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } });
      if (choiceId === 'deny-stop') void cancel();
    };

    const cancel = async () => {
      if (finished) return;
      cancelRequested = true;
      for (const [id, p] of pending) {
        conn?.respond(p.rpcId, { outcome: { outcome: 'cancelled' } });
        emit({ type: 'approval-cancelled', requestId: id });
      }
      pending.clear();
      if (!conn) {
        finish('interrupted');
        return;
      }
      if (sessionId) conn.notify('session/cancel', { sessionId });
      const settled = await Promise.race([(promptSettled ?? Promise.resolve()).then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 8000))]);
      if (!settled) await killTree(conn.child);
      finish('interrupted');
    };

    void start().catch((err: Error) => {
      if (cancelRequested) {
        finish('interrupted');
        return;
      }
      const auth = err instanceof AcpError && err.code === -32000;
      finish('failed', auth ? `${label} is not signed in. ${this.def.signedOutAction}` : err.message);
    });
    return { cancel, respondApproval, done };
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.active].map((c) => killTree(c.child)));
    this.active.clear();
  }
}
