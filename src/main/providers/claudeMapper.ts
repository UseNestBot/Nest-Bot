import type { ActivityKind, ApprovalChoice } from '@shared/types';
import { truncate, type ProviderEvent } from './types';

/**
 * Pure translation of Claude Code `--output-format stream-json` records into
 * provider-neutral events. Stateful only for correlating streamed deltas,
 * final messages and tool results.
 */
export class ClaudeStreamMapper {
  private toolNames = new Map<string, string>();
  /** message id -> (content block index -> text ordinal) for streamed deltas. */
  private streamOrdinals = new Map<string, Map<number, number>>();
  private streamTextCount = new Map<string, number>();
  private finalTextCount = new Map<string, number>();
  private currentStreamMessageId: string | null = null;
  sessionId: string | null = null;
  resultSeen = false;

  map(record: unknown): ProviderEvent[] {
    if (!isObject(record)) return [];
    const type = record.type;
    if (typeof record.session_id === 'string' && record.session_id && record.session_id !== this.sessionId) {
      this.sessionId = record.session_id;
    }
    switch (type) {
      case 'system':
        return this.mapSystem(record);
      case 'stream_event':
        return record.parent_tool_use_id ? [] : this.mapStreamEvent(record.event);
      case 'assistant':
        return this.mapAssistant(record);
      case 'user':
        return this.mapUser(record);
      case 'result':
        return this.mapResult(record);
      case 'rate_limit_event':
        return this.mapRateLimit(record.rate_limit_info);
      default:
        return [];
    }
  }

  private mapSystem(record: Record<string, unknown>): ProviderEvent[] {
    switch (record.subtype) {
      case 'init':
        return typeof record.session_id === 'string'
          ? [{ type: 'session', sessionId: record.session_id, model: typeof record.model === 'string' ? record.model : null }]
          : [];
      case 'api_retry': {
        const attempt = num(record.attempt);
        const max = num(record.max_retries);
        const reason = str(record.error) ?? 'error';
        const events: ProviderEvent[] = [
          {
            type: 'activity',
            id: `retry-${str(record.uuid) ?? attempt}`,
            kind: 'info',
            title: `Retrying request (${reason.replace(/_/g, ' ')})${attempt ? `, attempt ${attempt}${max ? ` of ${max}` : ''}` : ''}`,
            status: 'done',
          },
        ];
        if (reason === 'rate_limit') events.push({ type: 'rate-limit', windows: [], limited: true, message: 'Claude rate limit reached; Claude Code is retrying.' });
        return events;
      }
      case 'permission_denied':
        return [
          {
            type: 'activity',
            id: `denied-${str(record.uuid) ?? Math.random().toString(36).slice(2)}`,
            kind: 'approval',
            title: `Permission denied: ${str(record.tool_name) ?? 'tool'}`,
            detail: str(record.message) ?? null,
            status: 'declined',
          },
        ];
      case 'compact_boundary':
        return [{ type: 'activity', id: `compact-${str(record.uuid) ?? Date.now()}`, kind: 'info', title: 'Context compacted', status: 'done' }];
      default:
        return [];
    }
  }

  private mapStreamEvent(event: unknown): ProviderEvent[] {
    if (!isObject(event)) return [];
    if (event.type === 'message_start' && isObject(event.message) && typeof event.message.id === 'string') {
      this.currentStreamMessageId = event.message.id;
      return [];
    }
    const messageId = this.currentStreamMessageId;
    if (!messageId) return [];
    if (event.type === 'content_block_start' && isObject(event.content_block) && event.content_block.type === 'text') {
      const index = num(event.index) ?? 0;
      const count = this.streamTextCount.get(messageId) ?? 0;
      this.streamTextCount.set(messageId, count + 1);
      let ordinals = this.streamOrdinals.get(messageId);
      if (!ordinals) this.streamOrdinals.set(messageId, (ordinals = new Map()));
      ordinals.set(index, count);
      return [];
    }
    if (event.type === 'content_block_delta' && isObject(event.delta) && event.delta.type === 'text_delta') {
      const ordinal = this.streamOrdinals.get(messageId)?.get(num(event.index) ?? 0);
      if (ordinal === undefined || typeof event.delta.text !== 'string') return [];
      return [{ type: 'text-delta', segmentId: `${messageId}:${ordinal}`, text: event.delta.text }];
    }
    return [];
  }

  private mapAssistant(record: Record<string, unknown>): ProviderEvent[] {
    const message = record.message;
    if (!isObject(message) || !Array.isArray(message.content)) return [];
    const events: ProviderEvent[] = [];
    const fromSubagent = Boolean(record.parent_tool_use_id);
    const messageId = str(message.id) ?? str(record.uuid) ?? 'msg';
    for (const block of message.content) {
      if (!isObject(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string' && !fromSubagent) {
        const ordinal = this.finalTextCount.get(messageId) ?? 0;
        this.finalTextCount.set(messageId, ordinal + 1);
        events.push({ type: 'text-final', segmentId: `${messageId}:${ordinal}`, text: block.text });
      } else if (block.type === 'tool_use' && typeof block.id === 'string') {
        const name = str(block.name) ?? 'tool';
        this.toolNames.set(block.id, name);
        const described = describeToolUse(name, isObject(block.input) ? block.input : {});
        events.push({
          type: 'activity',
          id: block.id,
          kind: described.kind,
          title: fromSubagent ? `${described.title} (subagent)` : described.title,
          detail: described.detail,
          status: 'running',
        });
      }
    }
    // Claude Code marks synthetic error replies (auth, billing, rate limit) with `error`.
    const error = str(record.error);
    if (error && !fromSubagent) {
      const text = message.content
        .map((b) => (isObject(b) && typeof b.text === 'string' ? b.text : ''))
        .join('')
        .trim();
      events.push({ type: 'error', code: error, message: friendlyClaudeError(error, text), fatal: true });
      if (error === 'rate_limit') events.push({ type: 'rate-limit', windows: [], limited: true, message: text || 'Rate limit reached' });
    }
    return events;
  }

  private mapUser(record: Record<string, unknown>): ProviderEvent[] {
    const message = record.message;
    if (!isObject(message) || !Array.isArray(message.content)) return [];
    const events: ProviderEvent[] = [];
    for (const block of message.content) {
      if (!isObject(block) || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
      const name = this.toolNames.get(block.tool_use_id) ?? 'tool';
      const output = toolResultText(block.content);
      const isError = block.is_error === true;
      const declined = isError && /permission|denied|declined|rejected/i.test(output.slice(0, 300));
      events.push({
        type: 'activity',
        id: block.tool_use_id,
        kind: describeToolUse(name, {}).kind,
        title: '',
        output: truncate(output, 6000),
        status: declined ? 'declined' : isError ? 'failed' : 'done',
      });
    }
    return events;
  }

  private mapResult(record: Record<string, unknown>): ProviderEvent[] {
    this.resultSeen = true;
    const events: ProviderEvent[] = [];
    const usage = record.usage;
    if (isObject(usage)) {
      const input = (num(usage.input_tokens) ?? 0) + (num(usage.cache_read_input_tokens) ?? 0) + (num(usage.cache_creation_input_tokens) ?? 0);
      events.push({
        type: 'usage',
        usage: { inputTokens: input, cachedInputTokens: num(usage.cache_read_input_tokens) ?? 0, outputTokens: num(usage.output_tokens) ?? 0 },
      });
    }
    if (record.is_error === true || (typeof record.subtype === 'string' && record.subtype.startsWith('error'))) {
      const errors = Array.isArray(record.errors) ? record.errors.filter((e) => typeof e === 'string').join('\n') : '';
      const text = str(record.result) || errors || `Claude Code ended with ${String(record.subtype ?? 'an error')}`;
      if (/no conversation found/i.test(text)) events.push({ type: 'error', code: 'session-missing', message: text, fatal: true });
      events.push({ type: 'completed', status: 'failed', error: text });
    } else {
      events.push({ type: 'completed', status: 'completed' });
    }
    return events;
  }

  private mapRateLimit(info: unknown): ProviderEvent[] {
    if (!isObject(info)) return [];
    const status = str(info.status);
    const label = (str(info.rateLimitType) ?? 'usage').replace(/_/g, ' ');
    const utilization = num(info.utilization);
    const resetsAt = num(info.resetsAt);
    return [
      {
        type: 'rate-limit',
        windows: [{ label, usedPercent: utilization !== undefined ? Math.round(utilization * (utilization <= 1 ? 100 : 1)) : null, resetsAt: resetsAt ? resetsAt * 1000 : null }],
        limited: status === 'rejected',
        message: status === 'rejected' ? `Claude ${label} limit reached${resetsAt ? `; resets ${new Date(resetsAt * 1000).toLocaleString()}` : ''}.` : undefined,
      },
    ];
  }
}

export function friendlyClaudeError(code: string, text: string): string {
  switch (code) {
    case 'authentication_failed':
      return `${text || 'Claude Code is not signed in.'} Sign in from Settings (runs \`claude auth login\`), then retry.`;
    case 'billing_error':
      return text || 'Claude reported a billing problem with this account.';
    case 'rate_limit':
      return text || 'Claude usage limit reached. Wait for the limit to reset.';
    default:
      return text || `Claude Code error: ${code}`;
  }
}

export interface ToolDescription {
  kind: ActivityKind;
  title: string;
  detail: string | null;
}

export function describeToolUse(name: string, input: Record<string, unknown>): ToolDescription {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  const firstLine = (t: string) => t.split('\n')[0].slice(0, 160);
  const json = Object.keys(input).length ? truncate(JSON.stringify(input, null, 2), 3000) : null;
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return { kind: 'command', title: firstLine(s('command')) || name, detail: s('description') || (s('command').includes('\n') ? s('command') : null) };
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { kind: 'file', title: `${name} ${s('file_path') || s('notebook_path')}`.trim(), detail: name === 'Read' ? null : json };
    case 'Glob':
    case 'Grep':
      return { kind: 'search', title: `${name} ${s('pattern')}`.trim(), detail: s('path') || null };
    case 'WebFetch':
      return { kind: 'search', title: `Fetch ${s('url')}`.trim(), detail: s('prompt') || null };
    case 'WebSearch':
      return { kind: 'search', title: `Search “${s('query')}”`, detail: null };
    default:
      if (name.startsWith('mcp__')) return { kind: 'mcp', title: name.replace(/^mcp__/, '').replace(/__/g, ' · '), detail: json };
      return { kind: 'tool', title: name, detail: json };
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (isObject(c) && typeof c.text === 'string' ? c.text : isObject(c) && c.type === 'image' ? '[image]' : ''))
      .join('\n');
  }
  return '';
}

// ---------------------------------------------------------------------------
// Permission requests (control_request subtype can_use_tool)

export interface ClaudeApprovalSpec {
  title: string;
  action: string;
  target: string | null;
  reason: string | null;
  detail: string | null;
  choices: ApprovalChoice[];
}

export function describeClaudePermission(request: Record<string, unknown>): ClaudeApprovalSpec {
  const toolName = str(request.tool_name) ?? 'tool';
  const input = isObject(request.input) ? request.input : {};
  const described = describeToolUse(toolName, input);
  const target =
    str(request.blocked_path) ??
    (typeof input.file_path === 'string' ? input.file_path : null) ??
    (typeof input.url === 'string' ? input.url : null) ??
    (typeof input.path === 'string' ? input.path : null);
  const choices: ApprovalChoice[] = [{ id: 'allow', label: 'Allow once', tone: 'primary' }];
  if (Array.isArray(request.permission_suggestions) && request.permission_suggestions.length && request.suppress_always_allow_rule !== true) {
    choices.push({ id: 'allow-session', label: 'Allow for this session', tone: 'neutral' });
  }
  choices.push({ id: 'deny', label: 'Deny', tone: 'neutral' }, { id: 'deny-stop', label: 'Deny and stop', tone: 'danger' });
  return {
    title: `Claude wants to use ${toolName}`,
    action: toolName === 'Bash' || toolName === 'PowerShell' ? str(input.command) ?? described.title : described.title,
    target,
    reason: sanitize(str(request.decision_reason) ?? str(request.description) ?? null),
    detail: truncate(JSON.stringify(input, null, 2), 4000),
    choices,
  };
}

/** Build the control_response payload for a permission decision. */
export function claudePermissionResponse(request: Record<string, unknown>, choiceId: string): Record<string, unknown> {
  const input = isObject(request.input) ? request.input : {};
  const toolUseID = str(request.tool_use_id);
  switch (choiceId) {
    case 'allow':
      return { behavior: 'allow', updatedInput: input, ...(toolUseID ? { toolUseID } : {}) };
    case 'allow-session': {
      // Only ever widen permissions for this session, never persist into settings files.
      const suggestions = Array.isArray(request.permission_suggestions) ? request.permission_suggestions : [];
      const updatedPermissions = suggestions.filter(isObject).map((s) => ({ ...s, destination: 'session' }));
      return { behavior: 'allow', updatedInput: input, updatedPermissions, ...(toolUseID ? { toolUseID } : {}) };
    }
    case 'deny-stop':
      return { behavior: 'deny', message: 'The user denied this action and stopped the turn.', interrupt: true, ...(toolUseID ? { toolUseID } : {}) };
    default:
      return { behavior: 'deny', message: 'The user denied this action.', ...(toolUseID ? { toolUseID } : {}) };
  }
}

function sanitize(text: string | null): string | null {
  // Strip ANSI escape sequences before display.
  // eslint-disable-next-line no-control-regex
  return text ? text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '') : null;
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
