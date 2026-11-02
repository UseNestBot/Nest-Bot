import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { AppSettings, Connector, ConnectorInventory, LoginStart, ModelOption, ProviderStatus } from '@shared/types';
import { BROWSER_SUPPORT, claudeMcpArgs, claudeServersFromInit, claudeToolAllowed, claudeToolPrefix, mergeClaudeConnectors, parseClaudeMcpList, type ConnectorPolicy } from '../connectors';
import { claudeChromeSupport, detectClaudeChrome } from '../browser';
import { JsonlReader } from './jsonl';
import { ClaudeStreamMapper, claudePermissionResponse, describeClaudePermission, isObject } from './claudeMapper';
import {
  buildChildEnv,
  claudeExecutableSpec,
  killTree,
  resolveExecutable,
  runCapture,
  spawnProvider,
  waitForExit,
  type ResolvedExecutable,
} from './process';
import { emptyStatus, type ProviderAdapter, type ProviderEvent, type TurnHandle, type TurnInput } from './types';

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Claude Code adapter. Each turn runs the unmodified `claude` binary in print
 * mode with stream-json input/output. Tool permission prompts are routed to
 * us over the same stdio channel (`--permission-prompt-tool stdio`), the
 * mechanism the official Agent SDK uses for its `canUseTool` callback, so a
 * prompt can never block on a terminal we do not own.
 */
export class ClaudeProvider implements ProviderAdapter {
  readonly id = 'claude' as const;
  readonly capabilities = { modelListing: 'aliases', approvals: true, images: true, permissionControls: 'claude-modes' } as const;
  private status: ProviderStatus = emptyStatus('claude');
  private exe: ResolvedExecutable | null = null;
  private readonly active = new Set<ChildProcess>();

  constructor(
    private readonly getSettings: () => AppSettings,
    private readonly onStatus: (status: ProviderStatus) => void,
  ) {}

  /** Servers a session reported in its `system/init` record; lets Nest notice ones added since the last listing. */
  onServersSeen: ((servers: Connector[]) => void) | null = null;

  getStatus(): ProviderStatus {
    return this.status;
  }

  async detect(): Promise<ProviderStatus> {
    const settings = this.getSettings();
    const status = emptyStatus('claude');
    this.exe = resolveExecutable(claudeExecutableSpec(settings.claudePath));
    if (!this.exe) {
      status.state = 'not-installed';
      status.action = 'Install Claude Code (npm install -g @anthropic-ai/claude-code, or the native installer), then press Recheck. You can also set its path in Settings.';
      return this.setStatus(status);
    }
    status.executable = this.exe.command;
    const { env, removedBillingVars } = buildChildEnv('claude');
    if (removedBillingVars.length) status.notes.push(`Ignoring ${removedBillingVars.join(', ')} from the environment so runs use your Claude login, not API billing.`);
    const version = await runCapture(this.exe, ['--version'], env);
    status.version = version.stdout.trim().split(/\s+/)[0] || null;
    if (version.code !== 0 && !status.version) {
      status.state = 'error';
      status.detail = (version.stderr || version.stdout).trim().slice(0, 500);
      status.action = 'Claude Code is installed but failed to start. Run `claude --version` in a terminal to see the problem.';
      return this.setStatus(status);
    }
    const auth = await runCapture(this.exe, ['auth', 'status'], env);
    let parsed: Record<string, unknown> | null = null;
    try {
      const json = JSON.parse(auth.stdout);
      if (isObject(json)) parsed = json;
    } catch {
      /* older versions print text */
    }
    if (!parsed) {
      status.state = 'error';
      status.detail = (auth.stdout || auth.stderr).trim().slice(0, 500);
      status.action = 'Could not read Claude Code sign-in state. Update Claude Code (`claude update`) and press Recheck.';
      return this.setStatus(status);
    }
    const method = typeof parsed.authMethod === 'string' ? parsed.authMethod : null;
    const apiProvider = typeof parsed.apiProvider === 'string' ? parsed.apiProvider : 'firstParty';
    status.authMethod = method;
    const plan = typeof parsed.subscriptionType === 'string' ? parsed.subscriptionType : null;
    status.account = plan ? `Claude ${plan[0].toUpperCase()}${plan.slice(1)}` : method && method !== 'none' ? method : null;
    if (parsed.loggedIn !== true) {
      status.state = 'signed-out';
      status.action = 'Sign in with your Claude subscription: press Sign in (opens a console running `claude auth login`) and finish in the browser, then press Recheck.';
    } else if (apiProvider !== 'firstParty' || (method && /api|console|key/i.test(method))) {
      status.state = settings.allowApiKeyBilling ? 'ready' : 'api-key';
      status.account = apiProvider !== 'firstParty' ? `${apiProvider} credentials` : 'Anthropic API key';
      if (!settings.allowApiKeyBilling) {
        status.action = 'Claude Code is using API-billed credentials, not a Claude subscription. Run `claude auth login --claudeai` to switch, or allow API billing in Settings.';
      }
    } else {
      status.state = 'ready';
    }
    status.rateLimits = this.status.rateLimits;
    status.rateLimited = this.status.rateLimited;
    return this.setStatus(status);
  }

  noteRateLimit(windows: ProviderStatus['rateLimits'], limited: boolean): void {
    const merged = [...this.status.rateLimits.filter((w) => !windows.some((n) => n.label === w.label)), ...windows];
    this.setStatus({ ...this.status, rateLimits: merged, rateLimited: limited });
  }

  private setStatus(status: ProviderStatus): ProviderStatus {
    status.checkedAt = Date.now();
    this.status = status;
    this.onStatus(status);
    return status;
  }

  async listModels(): Promise<ModelOption[]> {
    // Claude Code accepts aliases that always track the latest model of a family.
    // Effort levels are the documented values of `--effort`.
    // Cost is relative per-token price within the family, cheapest (1) to priciest (4).
    const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
    return [
      { id: '', label: 'Default', isDefault: true, efforts, defaultEffort: null },
      { id: 'fable', label: 'Fable', isDefault: false, efforts, defaultEffort: null, cost: 4 },
      { id: 'opus', label: 'Opus', isDefault: false, efforts, defaultEffort: null, cost: 3 },
      { id: 'sonnet', label: 'Sonnet', isDefault: false, efforts, defaultEffort: null, cost: 2 },
      { id: 'haiku', label: 'Haiku', isDefault: false, efforts: [], defaultEffort: null, cost: 1 },
    ];
  }

  async startLogin(): Promise<LoginStart> {
    if (!this.exe) await this.detect();
    const exe = this.exe;
    const command = 'claude auth login --claudeai';
    if (!exe) return { kind: 'terminal', message: 'Claude Code is not installed.', command };
    const { env } = buildChildEnv('claude');
    // A detached console program gets its own visible console window on Windows,
    // where Claude Code's own sign-in flow runs unmodified.
    const child = spawn(exe.command, [...exe.prefixArgs, 'auth', 'login', '--claudeai'], { detached: true, stdio: 'ignore', windowsHide: false, env, shell: false });
    child.on('error', () => {});
    child.unref();
    return {
      kind: 'terminal',
      message: 'A console window opened running Claude Code’s sign-in. Complete it in your browser, then press Recheck.',
      command,
    };
  }

  async signOut(): Promise<void> {
    if (!this.exe) await this.detect();
    if (this.exe) await runCapture(this.exe, ['auth', 'logout'], buildChildEnv('claude').env);
    await this.detect();
  }

  startTurn(input: TurnInput, emit: (event: ProviderEvent) => void): TurnHandle {
    let finished = false;
    let cancelRequested = false;
    let child: ChildProcess | null = null;
    const pendingApprovals = new Map<string, Record<string, unknown>>();
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    let resultResolve: (() => void) | null = null;
    /** The last result of the turn: no steering message is still waiting to be read. */
    const resultSeen = new Promise<void>((r) => (resultResolve = r));
    let resultFinal = false;
    let policy: ConnectorPolicy | null = null;
    /** Steering messages Claude Code has not read yet, by uuid; it echoes each one back when it does. */
    const unread = new Set<string>();
    /** Steering messages sent before the process started. */
    const queued: unknown[] = [];

    const finish = (status: 'completed' | 'interrupted' | 'failed', error?: string) => {
      if (finished) return;
      finished = true;
      for (const id of pendingApprovals.keys()) emit({ type: 'approval-cancelled', requestId: id });
      pendingApprovals.clear();
      emit({ type: 'completed', status, error });
      resolveDone();
    };

    const send = (payload: unknown) => {
      if (child?.stdin && !child.stdin.destroyed && child.stdin.writable) child.stdin.write(`${JSON.stringify(payload)}\n`);
    };

    const start = async () => {
      if (!this.exe) await this.detect();
      const exe = this.exe;
      if (!exe) {
        emit({ type: 'error', message: 'Claude Code is not installed.', code: 'not-installed', fatal: true });
        finish('failed', 'Claude Code is not installed.');
        return;
      }
      const sessionId = input.sessionId ?? randomUUID();
      if (!input.sessionId) emit({ type: 'session', sessionId });
      const args = [
        '-p',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--replay-user-messages',
        '--permission-prompt-tool', 'stdio',
        '--permission-mode', input.permissions.claudeMode,
      ];
      args.push(...(input.sessionId ? ['--resume', input.sessionId] : ['--session-id', sessionId]));
      if (input.model) args.push('--model', input.model);
      if (input.effort) args.push('--effort', input.effort);
      if (input.instructions.trim()) args.push('--append-system-prompt', input.instructions);
      policy = input.connectors ? await input.connectors : null;
      const mcpArgs = claudeMcpArgs(policy, input.mcp ?? null);
      args.push(...mcpArgs.args);
      // Nest cannot render Claude's multiple-choice question UI; Claude asks in plain text instead.
      args.push('--disallowedTools', ['AskUserQuestion', ...mcpArgs.disallowedTools].join(','));

      const { env } = buildChildEnv('claude');
      if (input.mcp) env.MCP_TOOL_TIMEOUT = String(30 * 60_000); // delegate waits for another agent
      try {
        child = spawnProvider(exe, args, { cwd: input.cwd ?? undefined, env });
      } catch (err) {
        emit({ type: 'error', message: `Could not start Claude Code: ${(err as Error).message}`, fatal: true });
        finish('failed', (err as Error).message);
        return;
      }
      this.active.add(child);
      const mapper = new ClaudeStreamMapper();
      let stderrTail = '';
      let failure: string | undefined;

      const reader = new JsonlReader(
        (record) => {
          if (!isObject(record)) return;
          if (record.type === 'control_request') {
            handleControlRequest(record);
            return;
          }
          if (record.type === 'control_cancel_request' && typeof record.request_id === 'string') {
            if (pendingApprovals.delete(record.request_id)) emit({ type: 'approval-cancelled', requestId: record.request_id });
            return;
          }
          if (record.type === 'control_response') return;
          if (record.type === 'user' && record.isReplay === true) {
            if (typeof record.uuid === 'string') unread.delete(record.uuid);
            return;
          }
          if (record.type === 'system' && record.subtype === 'init') noteInit(record);
          for (const event of mapper.map(record)) {
            if (event.type === 'completed') {
              failure = event.status === 'failed' ? event.error : undefined;
              // A steering message that arrived after the agent's last step starts another turn in this process.
              if (unread.size && !cancelRequested && event.status !== 'failed') continue;
              resultFinal = true;
              resultResolve?.();
              continue; // finish once the process has wound down
            }
            if (event.type === 'session' && input.sessionId) continue;
            emit(event);
          }
        },
        (line, err) => emit({ type: 'activity', id: `parse-${Date.now()}-${Math.random()}`, kind: 'info', title: 'Skipped an unreadable output line', detail: `${err.message}: ${line.slice(0, 200)}`, status: 'failed' }),
      );

      // Show which connectors this session really has, and keep the inventory current.
      const noteInit = (record: Record<string, unknown>) => {
        const servers = claudeServersFromInit(record.mcp_servers);
        if (servers.length) this.onServersSeen?.(servers);
        // With streamed input, init arrives while servers are still connecting (no MCP tools listed yet),
        // so the usable set is the servers Claude loaded minus the ones Nest switched off.
        const denied = new Set(mcpArgs.disallowedTools);
        const usable = servers.filter((c) => !denied.has(claudeToolPrefix(c.id)));
        const chrome = Boolean(policy?.browser);
        if (!policy || (policy.allowed === null && !chrome)) return;
        emit({
          type: 'activity',
          id: 'ctx-connectors',
          kind: 'context',
          title: usable.length ? `Connectors: ${usable.map((c) => c.name).join(', ')}` : 'No connectors',
          detail: [chrome ? 'Browser: Claude in Chrome' : null, ...usable.map((c) => `${c.name} (${c.source})`)].filter(Boolean).join('\n') || null,
          status: 'done',
        });
      };

      const handleControlRequest = (record: Record<string, unknown>) => {
        const requestId = typeof record.request_id === 'string' ? record.request_id : null;
        const request = isObject(record.request) ? record.request : null;
        if (!requestId || !request) return;
        if (request.subtype === 'can_use_tool') {
          const toolName = typeof request.tool_name === 'string' ? request.tool_name : '';
          if (!claudeToolAllowed(toolName, policy)) {
            emit({ type: 'activity', id: `blocked-${requestId}`, kind: 'mcp', title: `Blocked ${toolName}: this agent isn’t allowed that connector`, status: 'declined' });
            send({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { behavior: 'deny', message: 'This agent is not allowed to use that connector in Nest.' } } });
            return;
          }
          pendingApprovals.set(requestId, request);
          const spec = describeClaudePermission(request);
          emit({ type: 'approval-request', requestId, ...spec });
          return;
        }
        // Anything else we cannot service is answered immediately so the CLI never waits on us.
        send({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: `Nest does not support ${String(request.subtype)}` } });
      };

      child.stdout?.on('data', (chunk: Buffer) => reader.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000);
      });
      child.stdin?.on('error', () => {});
      child.on('error', (err) => {
        emit({ type: 'error', message: `Claude Code process error: ${err.message}`, fatal: true });
      });
      child.on('exit', (code) => {
        reader.end();
        if (child) this.active.delete(child);
        if (cancelRequested) finish('interrupted');
        else if (mapper.resultSeen) finish(failure ? 'failed' : 'completed', failure);
        else {
          const tail = stderrTail.trim().split('\n').slice(-6).join('\n');
          const message = `Claude Code exited unexpectedly (code ${code ?? 'unknown'}).${tail ? `\n${tail}` : ''}`;
          emit({ type: 'error', message, fatal: true });
          finish('failed', message);
        }
      });

      send({ type: 'user', session_id: '', message: { role: 'user', content: buildContent(input) }, parent_tool_use_id: null });
      for (const message of queued.splice(0)) send(message);

      // Print mode with streamed input keeps reading stdin; close it once the turn's result arrives.
      void resultSeen.then(async () => {
        child?.stdin?.end();
        if (child) await waitForExit(child, 15000);
      });
    };

    const respondApproval = (requestId: string, choiceId: string) => {
      const request = pendingApprovals.get(requestId);
      if (!request) return;
      pendingApprovals.delete(requestId);
      send({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: claudePermissionResponse(request, choiceId) } });
    };

    // Claude Code reads a message sent mid-turn at its next step (after the running tool returns).
    const steer = async (prompt: string, attachments: TurnInput['attachments']) => {
      if (finished || cancelRequested || resultFinal) return false;
      const uuid = randomUUID();
      const message = { type: 'user', session_id: '', uuid, message: { role: 'user', content: buildContent({ prompt, attachments }) }, parent_tool_use_id: null };
      unread.add(uuid);
      if (child) send(message);
      else queued.push(message);
      return true;
    };

    const cancel = async () => {
      if (finished) return;
      cancelRequested = true;
      for (const id of [...pendingApprovals.keys()]) respondApproval(id, 'deny-stop');
      if (!child) {
        finish('interrupted');
        return;
      }
      send({ type: 'control_request', request_id: `nest-interrupt-${randomUUID()}`, request: { subtype: 'interrupt' } });
      const settled = await Promise.race([resultSeen.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 8000))]);
      child.stdin?.end();
      if (!settled) await killTree(child);
      await waitForExit(child, 5000);
      finish('interrupted');
    };

    void start().catch((err: Error) => {
      emit({ type: 'error', message: err.message, fatal: true });
      finish('failed', err.message);
    });
    return { cancel, respondApproval, steer, done };
  }

  async listConnectors(): Promise<ConnectorInventory> {
    const base = { provider: 'claude' as const, browser: BROWSER_SUPPORT.claude };
    if (!this.exe) await this.detect();
    if (!this.exe) return { ...base, connectors: [], error: 'Claude Code is not installed.', checkedAt: Date.now() };
    // `claude mcp list` health-checks every server (slow); a session's own server list says what a run really loads.
    const [res, session, chrome] = await Promise.all([
      runCapture(this.exe, ['mcp', 'list'], buildChildEnv('claude').env, 90_000),
      this.sessionServers(this.exe),
      detectClaudeChrome().catch(() => null),
    ]);
    const connectors = mergeClaudeConnectors(session, parseClaudeMcpList(res.stdout));
    const error = res.code !== 0 && !connectors.length ? (res.stderr || res.stdout).trim().slice(0, 500) || 'claude mcp list failed.' : null;
    return { ...base, browser: chrome ? claudeChromeSupport(chrome) : base.browser, connectors, error, checkedAt: Date.now() };
  }

  /**
   * The servers a session loads, from the `mcp_status` control request (what the Agent SDK's
   * mcpServerStatus() uses). Sent before any user message, so no model request is made.
   * Only names, status and source are read; server configs in the reply are ignored.
   */
  private sessionServers(exe: ResolvedExecutable): Promise<Connector[] | null> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawnProvider(exe, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], { env: buildChildEnv('claude').env });
      } catch {
        resolve(null);
        return;
      }
      let settled = false;
      const finish = (servers: Connector[] | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdin?.end();
        void killTree(child);
        resolve(servers);
      };
      const timer = setTimeout(() => finish(null), 30_000);
      const reader = new JsonlReader(
        (record) => {
          if (!isObject(record) || record.type !== 'control_response' || !isObject(record.response)) return;
          const response = isObject(record.response.response) ? record.response.response : null;
          finish(response ? claudeServersFromInit(response.mcpServers) : null);
        },
        () => {},
      );
      child.stdout?.on('data', (c: Buffer) => reader.push(c));
      child.stdin?.on('error', () => {});
      child.on('error', () => finish(null));
      child.on('exit', () => finish(null));
      child.stdin?.write(`${JSON.stringify({ type: 'control_request', request_id: `nest-mcp-status-${randomUUID()}`, request: { subtype: 'mcp_status' } })}\n`);
    });
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.active].map((c) => killTree(c)));
    this.active.clear();
  }
}

function buildContent(input: Pick<TurnInput, 'prompt' | 'attachments'>): unknown[] {
  const content: unknown[] = [{ type: 'text', text: input.prompt }];
  for (const att of input.attachments) {
    if (!att.isImage) continue;
    const mediaType = IMAGE_TYPES[path.extname(att.path).toLowerCase()];
    if (!mediaType) continue;
    try {
      if (statSync(att.path).size > MAX_INLINE_IMAGE_BYTES) continue;
      content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: readFileSync(att.path).toString('base64') } });
    } catch {
      /* unreadable attachments are listed in the prompt text instead */
    }
  }
  return content;
}
