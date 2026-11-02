import type { AppSettings, ConnectorInventory, LoginStart, ModelOption, ProviderStatus } from '@shared/types';
import { BROWSER_SUPPORT, codexConfigOverrides, codexConnectorsFromStatus, codexServerAllowed, type ConnectorPolicy } from '../connectors';
import { CodexTurnMapper, codexApprovalResult, codexRateLimitWindows, planCodexServerRequest } from './codexMapper';
import { CodexRpc, RpcError, type ServerRequest } from './codexRpc';
import { buildChildEnv, codexExecutableSpec, resolveExecutable, runCapture, type ResolvedExecutable } from './process';
import { emptyStatus, type ProviderAdapter, type ProviderEvent, type TurnHandle, type TurnInput } from './types';

interface ActiveTurn {
  threadId: string;
  mapper: CodexTurnMapper;
  emit: (event: ProviderEvent) => void;
  approvals: Map<string, ServerRequest>;
  onCompleted: () => void;
  policy: ConnectorPolicy | null;
}

/**
 * Codex adapter over the official `codex app-server` JSON-RPC protocol.
 * Codex owns sign-in and token refresh; we only read account state and start
 * its managed ChatGPT login when asked.
 */
export class CodexProvider implements ProviderAdapter {
  readonly id = 'codex' as const;
  readonly capabilities = { modelListing: 'dynamic', approvals: true, images: true, permissionControls: 'codex-sandbox' } as const;
  private status: ProviderStatus = emptyStatus('codex');
  private exe: ResolvedExecutable | null = null;
  private rpc: CodexRpc | null = null;
  /** Threads loaded in the app-server, with the connector config they were loaded with. */
  private loadedThreads = new Map<string, string>();
  private turns = new Map<string, ActiveTurn>();
  private catalogDefault: string | null = null;
  private modelsCache: { at: number; models: ModelOption[] } | null = null;

  constructor(
    private readonly getSettings: () => AppSettings,
    private readonly onStatus: (status: ProviderStatus) => void,
    private readonly openExternal: (url: string) => void,
    private readonly appVersion: string,
  ) {}

  getStatus(): ProviderStatus {
    return this.status;
  }

  private async client(): Promise<CodexRpc> {
    if (!this.exe) {
      this.exe = resolveExecutable(codexExecutableSpec(this.getSettings().codexPath));
      if (!this.exe) throw new RpcError('Codex is not installed', -32000);
    }
    if (!this.rpc || this.rpc.alive === false) {
      if (this.rpc) await this.rpc.stop();
      const rpc = new CodexRpc(this.exe, this.appVersion);
      rpc.onNotification((method, params) => this.onNotification(method, params));
      rpc.setRequestHandler((req) => this.onServerRequest(req));
      rpc.onExit((reason) => {
        this.loadedThreads.clear();
        for (const turn of this.turns.values()) {
          turn.emit({ type: 'error', message: reason, fatal: true });
          turn.emit({ type: 'completed', status: 'failed', error: reason });
          turn.onCompleted();
        }
        this.turns.clear();
      });
      this.rpc = rpc;
    }
    await this.rpc.ensureStarted();
    return this.rpc;
  }

  async detect(): Promise<ProviderStatus> {
    const status = emptyStatus('codex');
    const configured = this.getSettings().codexPath;
    const exe = resolveExecutable(codexExecutableSpec(configured));
    if (!exe) {
      status.state = 'not-installed';
      status.action = 'Install the Codex CLI (npm install -g @openai/codex, or the Codex installer), then press Recheck. You can also set its path in Settings.';
      return this.setStatus(status);
    }
    if (this.exe && this.exe.command !== exe.command) await this.rpc?.stop();
    this.exe = exe;
    status.executable = exe.command;
    const { env, removedBillingVars } = buildChildEnv('codex');
    if (removedBillingVars.length) status.notes.push(`Ignoring ${removedBillingVars.join(', ')} from the environment so runs use your ChatGPT sign-in.`);
    const version = await runCapture(exe, ['--version'], env);
    status.version = version.stdout.trim().replace(/^codex-cli\s*/, '') || null;
    try {
      const rpc = await this.client();
      const account = await rpc.request<{ account: Record<string, unknown> | null; requiresOpenaiAuth: boolean }>('account/read', {});
      const acct = account.account;
      if (!acct) {
        status.state = 'signed-out';
        status.action = 'Sign in with ChatGPT: press Sign in to open Codex’s official login page in your browser.';
      } else if (acct.type === 'chatgpt') {
        status.state = 'ready';
        status.authMethod = 'ChatGPT';
        const plan = typeof acct.planType === 'string' ? acct.planType : null;
        status.account = plan ? `ChatGPT ${plan[0].toUpperCase()}${plan.slice(1)}` : 'ChatGPT';
      } else {
        const allow = this.getSettings().allowApiKeyBilling;
        status.state = allow ? 'ready' : 'api-key';
        status.authMethod = String(acct.type);
        status.account = acct.type === 'apiKey' ? 'OpenAI API key' : String(acct.type);
        if (!allow) status.action = 'Codex is signed in with API-billed credentials. Run `codex login` and choose “Sign in with ChatGPT”, or allow API billing in Settings.';
      }
      if (status.state === 'ready' || status.state === 'api-key') {
        try {
          const rl = await rpc.request<{ rateLimits: unknown }>('account/rateLimits/read', {}, 15000);
          const parsed = codexRateLimitWindows(rl.rateLimits);
          status.rateLimits = parsed.windows;
          status.rateLimited = parsed.limited;
          if (parsed.limited) status.action = 'Codex usage limit reached. Wait for the window to reset.';
        } catch {
          /* rate limits are informational */
        }
      }
      if (process.platform === 'win32') {
        try {
          const ready = await rpc.request<{ status: string }>('windowsSandbox/readiness', {}, 10000);
          if (ready.status !== 'ready') status.notes.push(`Codex Windows sandbox: ${ready.status}. Codex may request approval for commands it would otherwise sandbox.`);
        } catch {
          /* older servers */
        }
      }
    } catch (err) {
      status.state = 'error';
      status.detail = (err as Error).message;
      status.action = 'Codex app-server could not start. Run `codex app-server --help` in a terminal to check the installation.';
    }
    return this.setStatus(status);
  }

  private setStatus(status: ProviderStatus): ProviderStatus {
    status.checkedAt = Date.now();
    this.status = status;
    this.onStatus(status);
    return status;
  }

  async listModels(): Promise<ModelOption[]> {
    if (this.modelsCache && Date.now() - this.modelsCache.at < 10 * 60_000) return this.modelsCache.models;
    try {
      const rpc = await this.client();
      const res = await rpc.request<{ data: Array<Record<string, unknown>> }>('model/list', {}, 20000);
      const models: ModelOption[] = res.data
        .filter((m) => m.hidden !== true)
        .map((m) => ({
          id: String(m.model ?? m.id),
          label: String(m.displayName ?? m.model ?? m.id),
          isDefault: m.isDefault === true,
          efforts: Array.isArray(m.supportedReasoningEfforts)
            ? m.supportedReasoningEfforts.map((e: unknown) => (e && typeof e === 'object' && 'reasoningEffort' in e ? String(e.reasoningEffort) : String(e)))
            : [],
          defaultEffort: typeof m.defaultReasoningEffort === 'string' ? m.defaultReasoningEffort : null,
        }));
      const def = models.find((m) => m.isDefault) ?? models[0];
      this.catalogDefault = def?.id ?? null;
      const head: ModelOption = def
        ? { ...def, id: '', label: `Default (${def.label})`, isDefault: true }
        : { id: '', label: 'Default', isDefault: true, efforts: [], defaultEffort: null };
      const list = [head, ...models.map((m) => ({ ...m, isDefault: false }))];
      this.modelsCache = { at: Date.now(), models: list };
      return list;
    } catch {
      return [{ id: '', label: 'Default', isDefault: true, efforts: [], defaultEffort: null }];
    }
  }

  /**
   * "Default" means the default of Codex's model catalog for the signed-in
   * account. A model pinned in config.toml may not be available on a ChatGPT
   * plan, so we resolve the catalog default explicitly.
   */
  private async resolveModel(model: string | null): Promise<string | undefined> {
    if (model) return model;
    if (!this.catalogDefault) await this.listModels();
    return this.catalogDefault ?? undefined;
  }

  async startLogin(): Promise<LoginStart> {
    const rpc = await this.client();
    const res = await rpc.request<{ type: string; authUrl?: string }>('account/login/start', { type: 'chatgpt' });
    if (res.authUrl) this.openExternal(res.authUrl);
    return { kind: 'browser', message: 'Codex opened its ChatGPT sign-in page in your browser. Nest will update when sign-in completes.', command: null };
  }

  async signOut(): Promise<void> {
    const rpc = await this.client();
    await rpc.request('account/logout', {});
    await this.detect();
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    if (method === 'account/login/completed' || method === 'account/updated') {
      void this.detect();
      return;
    }
    if (method === 'account/rateLimits/updated') {
      const parsed = codexRateLimitWindows(params.rateLimits);
      if (parsed.windows.length) this.setStatus({ ...this.status, rateLimits: parsed.windows, rateLimited: parsed.limited });
      return;
    }
    if (method === 'serverRequest/resolved') {
      for (const turn of this.turns.values()) {
        const id = String(params.requestId ?? '');
        if (turn.approvals.delete(id)) turn.emit({ type: 'approval-cancelled', requestId: id });
      }
      return;
    }
    const threadId = typeof params.threadId === 'string' ? params.threadId : null;
    const turn = threadId ? this.turns.get(threadId) : undefined;
    if (!turn) return;
    // Notifications from a different (e.g. earlier, interrupted) turn on this thread are ignored.
    if (turn.mapper.turnId && typeof params.turnId === 'string' && params.turnId !== turn.mapper.turnId) return;
    for (const event of turn.mapper.map(method, params)) {
      if (event.type === 'rate-limit' && event.limited) this.setStatus({ ...this.status, rateLimited: true });
      turn.emit(event);
      if (event.type === 'completed') {
        for (const id of turn.approvals.keys()) turn.emit({ type: 'approval-cancelled', requestId: id });
        this.turns.delete(turn.threadId);
        turn.onCompleted();
      }
    }
  }

  private onServerRequest(req: ServerRequest): void {
    const rpc = this.rpc;
    if (!rpc) return;
    const threadId = typeof req.params.threadId === 'string' ? req.params.threadId : typeof req.params.conversationId === 'string' ? req.params.conversationId : null;
    const turn = threadId ? this.turns.get(threadId) : this.turns.size === 1 ? [...this.turns.values()][0] : undefined;
    // Codex asks before every MCP tool call. Nest's own tools are approved here;
    // the ones that change anything ask the user inside Nest itself.
    const meta = req.params._meta && typeof req.params._meta === 'object' ? (req.params._meta as Record<string, unknown>) : {};
    if (req.method === 'mcpServer/elicitation/request' && meta.codex_approval_kind === 'mcp_tool_call' && req.params.serverName === 'nest') {
      rpc.respond(req.id, { action: 'accept', content: {}, _meta: null });
      return;
    }
    // A server this agent may not use is refused without asking (the thread config already switches it off).
    if (req.method === 'mcpServer/elicitation/request' && meta.codex_approval_kind === 'mcp_tool_call' && turn && !codexServerAllowed(String(req.params.serverName ?? ''), turn.policy)) {
      turn.emit({ type: 'activity', id: `blocked-${String(req.id)}`, kind: 'mcp', title: `Blocked ${String(req.params.serverName)}: this agent isn’t allowed that connector`, status: 'declined' });
      rpc.respond(req.id, { action: 'decline', content: null, _meta: null });
      return;
    }
    const plan = planCodexServerRequest(req.method, req.params, turn?.mapper.fileChanges ?? new Map());
    if (plan.kind === 'auto' || !turn) {
      if (plan.kind === 'auto' && plan.note && turn) turn.emit({ type: 'activity', id: `req-${String(req.id)}`, kind: 'info', title: plan.note, status: 'done' });
      if (plan.kind === 'auto' && plan.result !== undefined) rpc.respond(req.id, plan.result);
      else if (plan.kind === 'auto' && plan.error) rpc.respondError(req.id, plan.error.code, plan.error.message);
      else rpc.respond(req.id, codexApprovalResult(req.method, req.params, 'decline')); // no visible turn: decline safely
      return;
    }
    const requestId = String(req.id);
    turn.approvals.set(requestId, req);
    turn.emit({ type: 'approval-request', requestId, title: plan.title, action: plan.action, target: plan.target, reason: plan.reason, detail: plan.detail, choices: plan.choices });
  }

  startTurn(input: TurnInput, emit: (event: ProviderEvent) => void): TurnHandle {
    let finished = false;
    let cancelRequested = false;
    let threadId: string | null = input.sessionId;
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    const mapper = new CodexTurnMapper();
    let turnStarted: Promise<void> = Promise.resolve();

    const turn: ActiveTurn = {
      threadId: '',
      mapper,
      approvals: new Map(),
      emit: (event) => {
        if (finished) return;
        if (event.type === 'completed') {
          finished = true;
          emit(cancelRequested && event.status !== 'failed' ? { ...event, status: 'interrupted' } : event);
          resolveDone();
          return;
        }
        emit(event);
      },
      onCompleted: () => {},
      policy: null,
    };

    const fail = (message: string, code?: string) => {
      turn.emit({ type: 'error', message, code, fatal: true });
      turn.emit({ type: 'completed', status: 'failed', error: message });
      if (threadId) this.turns.delete(threadId);
    };

    const threadConfig = {
      config: undefined as Record<string, unknown> | undefined,
      cwd: input.cwd ?? undefined,
      model: undefined as string | undefined,
      approvalPolicy: input.permissions.codexApproval,
      sandbox: input.permissions.codexSandbox,
      developerInstructions: input.instructions.trim() || undefined,
    };

    const start = async () => {
      let rpc: CodexRpc;
      try {
        rpc = await this.client();
      } catch (err) {
        fail((err as Error).message, 'not-installed');
        return;
      }
      threadConfig.model = await this.resolveModel(input.model);
      turn.policy = input.connectors ? await input.connectors : null;
      const config: Record<string, unknown> = {
        // The agent's connector choice, as Codex's own per-thread config overrides.
        ...codexConfigOverrides(turn.policy),
        // Nest's own MCP server, scoped to this thread. Long timeout because delegate waits for another agent.
        ...(input.mcp ? { 'mcp_servers.nest': { command: input.mcp.command, args: input.mcp.args, env: input.mcp.env, tool_timeout_sec: 1800, startup_timeout_sec: 20 } } : {}),
      };
      threadConfig.config = Object.keys(config).length ? config : undefined;
      const signature = JSON.stringify(codexConfigOverrides(turn.policy));
      if (!threadId) {
        const res = await rpc.request<{ thread: { id: string }; model: string }>('thread/start', { ...threadConfig, serviceName: 'nest' });
        threadId = res.thread.id;
        this.loadedThreads.set(threadId, signature);
        emit({ type: 'session', sessionId: threadId, model: res.model });
      } else if (this.loadedThreads.get(threadId) !== signature) {
        try {
          // Connector choices changed since the thread was loaded: reload it so the new config applies.
          if (this.loadedThreads.has(threadId)) {
            await rpc.request('thread/unsubscribe', { threadId }, 15000).catch(() => {});
            this.loadedThreads.delete(threadId);
          }
          await rpc.request('thread/resume', { threadId, ...threadConfig, excludeTurns: true });
          this.loadedThreads.set(threadId, signature);
        } catch (err) {
          fail(`Could not resume Codex thread ${threadId}: ${(err as Error).message}`, 'session-missing');
          return;
        }
      }
      if (cancelRequested) {
        turn.emit({ type: 'completed', status: 'interrupted' });
        return;
      }
      turn.threadId = threadId;
      this.turns.set(threadId, turn);
      const res = await rpc.request<{ turn: { id: string } }>('turn/start', {
        threadId,
        input: userInput(input.prompt, input.attachments),
        ...(threadConfig.model ? { model: threadConfig.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
      });
      mapper.turnId = res.turn.id;
    };

    turnStarted = start().catch((err: Error) => {
      if (!finished) fail(err.message);
    });

    const respondApproval = (requestId: string, choiceId: string) => {
      const req = turn.approvals.get(requestId);
      if (!req || !this.rpc) return;
      turn.approvals.delete(requestId);
      this.rpc.respond(req.id, codexApprovalResult(req.method, req.params, choiceId));
    };

    // Codex adds the message to the running turn; the agent reads it at its next step.
    const steer = async (prompt: string, attachments: TurnInput['attachments']) => {
      if (finished || cancelRequested) return false;
      await turnStarted;
      if (finished || cancelRequested || !this.rpc || !threadId || !mapper.turnId) return false;
      try {
        await this.rpc.request('turn/steer', { threadId, expectedTurnId: mapper.turnId, input: userInput(prompt, attachments) }, 15000);
        return !finished;
      } catch {
        return false; // the turn ended in the meantime
      }
    };

    const cancel = async () => {
      if (finished) return;
      cancelRequested = true;
      for (const id of [...turn.approvals.keys()]) respondApproval(id, 'cancel');
      await turnStarted;
      if (finished) return;
      if (this.rpc && threadId && mapper.turnId) {
        try {
          await this.rpc.request('turn/interrupt', { threadId, turnId: mapper.turnId }, 10000);
        } catch {
          /* fall through to the timeout below */
        }
      }
      const settled = await Promise.race([done.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 10000))]);
      if (!settled) {
        if (threadId) this.turns.delete(threadId);
        turn.emit({ type: 'completed', status: 'interrupted' });
      }
    };

    return { cancel, respondApproval, steer, done };
  }

  async listConnectors(): Promise<ConnectorInventory> {
    const base = { provider: 'codex' as const, browser: BROWSER_SUPPORT.codex };
    try {
      const rpc = await this.client();
      const data: unknown[] = [];
      let cursor: string | null = null;
      // Listing starts every configured server, so allow it time; pages are followed to the end.
      for (let page = 0; page < 20; page++) {
        const res: { data: unknown[]; nextCursor?: string | null } = await rpc.request('mcpServerStatus/list', { detail: 'toolsAndAuthOnly', cursor }, 120_000);
        data.push(...res.data);
        cursor = res.nextCursor ?? null;
        if (!cursor) break;
      }
      return { ...base, connectors: codexConnectorsFromStatus(data), error: null, checkedAt: Date.now() };
    } catch (err) {
      return { ...base, connectors: [], error: (err as Error).message, checkedAt: Date.now() };
    }
  }

  async dispose(): Promise<void> {
    await this.rpc?.stop();
    this.rpc = null;
  }
}

function userInput(prompt: string, attachments: TurnInput['attachments']): unknown[] {
  const items: unknown[] = [{ type: 'text', text: prompt, text_elements: [] }];
  for (const att of attachments) if (att.isImage) items.push({ type: 'localImage', path: att.path });
  return items;
}
