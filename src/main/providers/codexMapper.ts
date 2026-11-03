import type { ActivityStatus, ApprovalChoice, FileEdit, RateLimitWindow } from '@shared/types';
import { isObject } from './claudeMapper';
import { truncate, type ProviderEvent } from './types';

/**
 * Pure translation of Codex app-server notifications for one turn into
 * provider-neutral events. Thread items arrive via item/started and
 * item/completed; agent text streams through item/agentMessage/delta.
 */
export class CodexTurnMapper {
  private commandOutput = new Map<string, string>();
  /** fileChange items by id, so approval prompts can name the files. */
  readonly fileChanges = new Map<string, Record<string, unknown>>();
  turnId: string | null = null;

  map(method: string, params: Record<string, unknown>): ProviderEvent[] {
    switch (method) {
      case 'turn/started':
        if (isObject(params.turn) && typeof params.turn.id === 'string') this.turnId = params.turn.id;
        return [];
      case 'item/agentMessage/delta':
        return typeof params.itemId === 'string' && typeof params.delta === 'string'
          ? [{ type: 'text-delta', segmentId: params.itemId, text: params.delta }]
          : [];
      case 'item/started':
      case 'item/completed':
        return isObject(params.item) ? this.mapItem(params.item, method === 'item/completed') : [];
      case 'item/commandExecution/outputDelta': {
        if (typeof params.itemId !== 'string' || typeof params.delta !== 'string') return [];
        const next = (this.commandOutput.get(params.itemId) ?? '') + params.delta;
        this.commandOutput.set(params.itemId, next.slice(-20000));
        return [{ type: 'activity', id: params.itemId, kind: 'command', title: '', output: truncate(next.slice(-6000), 6000), status: 'running' }];
      }
      case 'thread/tokenUsage/updated': {
        const usage = isObject(params.tokenUsage) ? params.tokenUsage : null;
        const last = usage && isObject(usage.last) ? usage.last : null;
        if (!last) return [];
        return [
          {
            type: 'usage',
            usage: {
              inputTokens: n(last.inputTokens),
              cachedInputTokens: n(last.cachedInputTokens),
              outputTokens: n(last.outputTokens),
              contextWindow: usage && typeof usage.modelContextWindow === 'number' ? usage.modelContextWindow : undefined,
            },
          },
        ];
      }
      case 'error': {
        const error = isObject(params.error) ? params.error : {};
        const message = typeof error.message === 'string' ? error.message : 'Codex reported an error';
        if (params.willRetry === true) {
          return [{ type: 'activity', id: `retry-${Date.now()}`, kind: 'info', title: `Retrying: ${message.slice(0, 160)}`, status: 'done' }];
        }
        return errorEvents(error, message);
      }
      case 'turn/completed': {
        const turn = isObject(params.turn) ? params.turn : {};
        const status = turn.status;
        if (status === 'interrupted') return [{ type: 'completed', status: 'interrupted' }];
        if (status === 'failed') {
          const error = isObject(turn.error) ? turn.error : {};
          const message = readableCodexMessage(typeof error.message === 'string' ? error.message : 'Codex turn failed');
          return [...errorEvents(error, message), { type: 'completed', status: 'failed', error: message }];
        }
        return [{ type: 'completed', status: 'completed' }];
      }
      default:
        return [];
    }
  }

  private mapItem(item: Record<string, unknown>, completed: boolean): ProviderEvent[] {
    const id = typeof item.id === 'string' ? item.id : null;
    if (!id) return [];
    const status = itemStatus(item.status, completed);
    switch (item.type) {
      case 'agentMessage':
        return completed && typeof item.text === 'string' ? [{ type: 'text-final', segmentId: id, text: item.text }] : [];
      case 'commandExecution': {
        const exit = typeof item.exitCode === 'number' ? item.exitCode : null;
        const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : this.commandOutput.get(id) ?? null;
        return [
          {
            type: 'activity',
            id,
            kind: 'command',
            title: String(item.command ?? 'command').split('\n')[0].slice(0, 200),
            meta: { command: truncate(String(item.command ?? ''), 6000), ...(typeof item.cwd === 'string' ? { cwd: item.cwd } : {}), ...(exit !== null ? { exitCode: exit } : {}) },
            detail: [typeof item.cwd === 'string' ? `in ${item.cwd}` : null, exit !== null ? `exit code ${exit}` : null].filter(Boolean).join(' · ') || null,
            output: output ? truncate(output, 6000) : null,
            status: completed && exit !== null && exit !== 0 && status === 'done' ? 'failed' : status,
          },
        ];
      }
      case 'fileChange': {
        this.fileChanges.set(id, item);
        const changes = Array.isArray(item.changes) ? item.changes.filter(isObject) : [];
        const paths = changes.map((c) => String(c.path ?? ''));
        return [
          {
            type: 'activity',
            id,
            kind: 'file',
            title: paths.length === 1 ? `Edit ${paths[0]}` : `Edit ${paths.length} files`,
            meta: { edits: changes.map((c) => codexEdit(c)) },
            detail: truncate(changes.map((c) => `${String(c.path)}\n${String(c.diff ?? '')}`).join('\n\n'), 6000),
            status,
          },
        ];
      }
      case 'mcpToolCall':
        return [
          {
            type: 'activity',
            id,
            kind: 'mcp',
            title: `${String(item.server)} · ${String(item.tool)}`,
            detail: item.arguments ? truncate(JSON.stringify(item.arguments, null, 2), 3000) : null,
            output: isObject(item.error) ? String(item.error.message ?? '') : item.result ? truncate(JSON.stringify(item.result), 3000) : null,
            status,
          },
        ];
      case 'webSearch':
        return [{ type: 'activity', id, kind: 'search', title: `Search “${String(item.query ?? '')}”`, status: completed ? 'done' : 'running' }];
      case 'dynamicToolCall':
        return [{ type: 'activity', id, kind: 'tool', title: String(item.tool ?? 'tool'), status }];
      case 'plan':
        return completed && typeof item.text === 'string' ? [{ type: 'activity', id, kind: 'info', title: 'Plan', detail: item.text, status: 'done' }] : [];
      case 'contextCompaction':
        return completed ? [{ type: 'activity', id, kind: 'info', title: 'Context compacted', status: 'done' }] : [];
      case 'imageView':
        return [{ type: 'activity', id, kind: 'file', title: `View image ${String(item.path ?? '')}`, status: completed ? 'done' : 'running' }];
      default:
        return [];
    }
  }
}

function itemStatus(status: unknown, completed: boolean): ActivityStatus {
  if (status === 'failed') return 'failed';
  if (status === 'declined') return 'declined';
  if (status === 'inProgress' && !completed) return 'running';
  return completed ? 'done' : 'running';
}

/** Upstream errors sometimes arrive as a JSON document inside `message`; surface the readable part. */
export function readableCodexMessage(message: string): string {
  const trimmed = message.trim();
  if (!trimmed.startsWith('{')) return message;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isObject(parsed)) {
      const inner = isObject(parsed.error) ? parsed.error : parsed;
      if (typeof inner.message === 'string') return inner.message;
    }
  } catch {
    /* not JSON after all */
  }
  return message;
}

function errorEvents(error: Record<string, unknown>, rawMessage: string): ProviderEvent[] {
  const message = readableCodexMessage(rawMessage);
  const info = error.codexErrorInfo;
  const code = typeof info === 'string' ? info : isObject(info) ? Object.keys(info)[0] : undefined;
  const events: ProviderEvent[] = [];
  if (code === 'usageLimitExceeded' || code === 'rateLimitExceeded') {
    events.push({ type: 'rate-limit', windows: [], limited: true, message });
  }
  const friendly = code === 'unauthorized' ? `${message} Sign in to Codex from Settings, then retry.` : message;
  events.push({ type: 'error', code, message: friendly, fatal: true });
  return events;
}

function n(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

// ---------------------------------------------------------------------------
// Server-initiated requests

export type CodexRequestPlan =
  | { kind: 'approval'; title: string; action: string; target: string | null; reason: string | null; detail: string | null; choices: ApprovalChoice[] }
  /** Requests Nest cannot present: answered immediately with a safe refusal. */
  | { kind: 'auto'; result?: unknown; error?: { code: number; message: string }; note: string | null };

const APPROVE_CHOICES: ApprovalChoice[] = [
  { id: 'accept', label: 'Approve once', tone: 'primary' },
  { id: 'acceptForSession', label: 'Approve for this session', tone: 'neutral' },
  { id: 'decline', label: 'Decline', tone: 'neutral' },
  { id: 'cancel', label: 'Decline and stop', tone: 'danger' },
];

export function planCodexServerRequest(method: string, params: Record<string, unknown>, fileChanges: Map<string, Record<string, unknown>>): CodexRequestPlan {
  switch (method) {
    case 'item/commandExecution/requestApproval': {
      const network = isObject(params.networkApprovalContext) ? params.networkApprovalContext : null;
      const isStdin = params.kind === 'writeStdin';
      return {
        kind: 'approval',
        title: network ? 'Codex wants network access' : isStdin ? 'Codex wants to send input to a running command' : 'Codex wants to run a command',
        action: typeof params.command === 'string' ? params.command : network ? JSON.stringify(network) : 'command',
        target: typeof params.cwd === 'string' ? params.cwd : null,
        reason: typeof params.reason === 'string' ? params.reason : null,
        detail: Array.isArray(params.commandActions) && params.commandActions.length ? truncate(JSON.stringify(params.commandActions, null, 2), 2000) : null,
        choices: APPROVE_CHOICES,
      };
    }
    case 'item/fileChange/requestApproval': {
      const item = typeof params.itemId === 'string' ? fileChanges.get(params.itemId) : undefined;
      const changes = item && Array.isArray(item.changes) ? item.changes.filter(isObject) : [];
      const paths = changes.map((c) => String(c.path ?? ''));
      return {
        kind: 'approval',
        title: 'Codex wants to change files',
        action: paths.length ? (paths.length === 1 ? `Edit ${paths[0]}` : `Edit ${paths.length} files`) : 'Apply a patch',
        target: typeof params.grantRoot === 'string' ? params.grantRoot : paths.join('\n') || null,
        reason: typeof params.reason === 'string' ? params.reason : null,
        detail: changes.length ? truncate(changes.map((c) => `${String(c.path)}\n${String(c.diff ?? '')}`).join('\n\n'), 6000) : null,
        choices: APPROVE_CHOICES.map((c) => (c.id === 'accept' ? { ...c, label: 'Apply once' } : c)),
      };
    }
    case 'item/permissions/requestApproval':
      return {
        kind: 'approval',
        title: 'Codex wants additional permissions',
        action: truncate(JSON.stringify(params.permissions ?? {}, null, 2), 1500),
        target: typeof params.cwd === 'string' ? params.cwd : null,
        reason: typeof params.reason === 'string' ? params.reason : null,
        detail: null,
        choices: [
          { id: 'grant-turn', label: 'Grant for this turn', tone: 'primary' },
          { id: 'decline', label: 'Decline', tone: 'neutral' },
        ],
      };
    case 'execCommandApproval':
      return {
        kind: 'approval',
        title: 'Codex wants to run a command',
        action: Array.isArray(params.command) ? params.command.join(' ') : String(params.command ?? 'command'),
        target: typeof params.cwd === 'string' ? params.cwd : null,
        reason: typeof params.reason === 'string' ? params.reason : null,
        detail: null,
        choices: APPROVE_CHOICES,
      };
    case 'applyPatchApproval':
      return {
        kind: 'approval',
        title: 'Codex wants to change files',
        action: isObject(params.fileChanges) ? Object.keys(params.fileChanges).join('\n') : 'Apply a patch',
        target: typeof params.grantRoot === 'string' ? params.grantRoot : null,
        reason: typeof params.reason === 'string' ? params.reason : null,
        detail: null,
        choices: APPROVE_CHOICES,
      };
    case 'mcpServer/elicitation/request': {
      const meta = params._meta && typeof params._meta === 'object' ? (params._meta as Record<string, unknown>) : {};
      if (meta.codex_approval_kind === 'mcp_tool_call') {
        return {
          kind: 'approval',
          title: `Codex wants to use a tool from ${String(params.serverName ?? 'an MCP server')}`,
          action: typeof params.message === 'string' ? params.message : String(meta.tool_name ?? 'MCP tool call'),
          target: typeof params.serverName === 'string' ? params.serverName : null,
          reason: null,
          detail: truncate(JSON.stringify(meta, null, 2), 3000),
          choices: [
            { id: 'accept', label: 'Allow', tone: 'primary' },
            { id: 'decline', label: 'Decline', tone: 'neutral' },
            { id: 'cancel', label: 'Decline and stop', tone: 'danger' },
          ],
        };
      }
      return { kind: 'auto', result: { action: 'decline', content: null, _meta: null }, note: 'Declined an MCP server input request (not supported in Nest yet).' };
    }
    case 'item/tool/requestUserInput':
      return { kind: 'auto', result: { answers: {} }, note: 'Codex asked a structured question; Nest answered with no selection. Reply in the chat instead.' };
    default:
      return { kind: 'auto', error: { code: -32601, message: `Nest does not support ${method}` }, note: null };
  }
}

export function codexApprovalResult(method: string, params: Record<string, unknown>, choiceId: string): unknown {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval': {
      const allowed = ['accept', 'acceptForSession', 'decline', 'cancel'];
      return { decision: allowed.includes(choiceId) ? choiceId : 'decline' };
    }
    case 'mcpServer/elicitation/request':
      return { action: choiceId === 'accept' ? 'accept' : choiceId === 'cancel' ? 'cancel' : 'decline', content: choiceId === 'accept' ? {} : null, _meta: null };
    case 'item/permissions/requestApproval': {
      if (choiceId === 'grant-turn' && isObject(params.permissions)) {
        const granted: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(params.permissions)) if (v !== null && v !== undefined) granted[k] = v;
        return { permissions: granted, scope: 'turn' };
      }
      return { permissions: {}, scope: 'turn' };
    }
    case 'execCommandApproval':
    case 'applyPatchApproval':
      switch (choiceId) {
        case 'accept':
          return { decision: 'approved' };
        case 'acceptForSession':
          return { decision: 'approved_for_session' };
        case 'cancel':
          return { decision: 'abort' };
        default:
          return { decision: { denied: { rejection: 'The user declined.' } } };
      }
    default:
      return {};
  }
}

export function codexRateLimitWindows(snapshot: unknown): { windows: RateLimitWindow[]; limited: boolean; plan: string | null } {
  if (!isObject(snapshot)) return { windows: [], limited: false, plan: null };
  const windows: RateLimitWindow[] = [];
  for (const key of ['primary', 'secondary'] as const) {
    const w = snapshot[key];
    if (!isObject(w)) continue;
    const mins = typeof w.windowDurationMins === 'number' ? w.windowDurationMins : null;
    windows.push({
      label: mins === null ? key : mins >= 10080 ? 'weekly' : mins >= 60 ? `${Math.round(mins / 60)}-hour` : `${mins}-minute`,
      usedPercent: typeof w.usedPercent === 'number' ? w.usedPercent : null,
      resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt * 1000 : null,
    });
  }
  const limited = snapshot.rateLimitReachedType !== null && snapshot.rateLimitReachedType !== undefined;
  return { windows, limited, plan: typeof snapshot.planType === 'string' ? snapshot.planType : null };
}

/** A Codex file change: updates carry a unified diff, while an added or deleted file carries its content. */
function codexEdit(change: Record<string, unknown>): FileEdit {
  const path = String(change.path ?? '');
  const diff = truncate(String(change.diff ?? ''), 8000);
  const kind = isObject(change.kind) ? change.kind.type : change.kind;
  if (kind === 'add') return { path, before: '', after: diff };
  if (kind === 'delete') return { path, before: diff, after: '' };
  return { path, diff };
}
