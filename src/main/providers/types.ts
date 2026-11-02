import type { ConnectorPolicy } from '../connectors';
import type {
  ActivityKind,
  ActivityStatus,
  ApprovalChoice,
  Attachment,
  ConnectorInventory,
  LoginStart,
  ModelOption,
  EffectivePermissions,
  ProviderId,
  ProviderStatus,
  RateLimitWindow,
  Usage,
} from '@shared/types';

/** Provider-neutral stream emitted while a turn runs. */
export type ProviderEvent =
  /** The native session/thread id; emitted as soon as it is known. */
  | { type: 'session'; sessionId: string; model?: string | null }
  /** Incremental assistant text for one text segment (a provider message/item). */
  | { type: 'text-delta'; segmentId: string; text: string }
  /** Authoritative full text for a segment; replaces accumulated deltas. */
  | { type: 'text-final'; segmentId: string; text: string }
  | {
      type: 'activity';
      id: string;
      kind: ActivityKind;
      title: string;
      detail?: string | null;
      output?: string | null;
      status: ActivityStatus;
    }
  | {
      type: 'approval-request';
      requestId: string;
      title: string;
      action: string;
      target: string | null;
      reason: string | null;
      detail: string | null;
      choices: ApprovalChoice[];
    }
  /** The provider withdrew a pending approval (e.g. the turn ended). */
  | { type: 'approval-cancelled'; requestId: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'rate-limit'; windows: RateLimitWindow[]; limited: boolean; message?: string }
  | { type: 'error'; message: string; code?: string; fatal: boolean }
  | { type: 'completed'; status: 'completed' | 'interrupted' | 'failed'; error?: string };

/** How to launch Nest's MCP server for one conversation. */
export interface McpLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface TurnInput {
  runId: string;
  /** Existing native session to continue, or null to create one. */
  sessionId: string | null;
  cwd: string | null;
  model: string | null;
  effort: string | null;
  /** Agent instructions, supplied through the provider's system/developer instruction mechanism. */
  instructions: string;
  /** The user prompt, already including any context blocks (memory, transfer summary). */
  prompt: string;
  attachments: Attachment[];
  permissions: EffectivePermissions;
  /** Nest's own tool server, when available. */
  mcp?: McpLaunch | null;
  /** The agent's connector and browser choices; resolved before the provider starts. */
  connectors?: Promise<ConnectorPolicy> | null;
}

export interface TurnHandle {
  /** Request a clean stop. Resolves once the provider acknowledged or was force-stopped. */
  cancel(): Promise<void>;
  respondApproval(requestId: string, choiceId: string): void;
  /** Resolves when the turn is fully over (never rejects). */
  done: Promise<void>;
}

export interface ProviderCapabilities {
  /** Model choices come from the provider (Codex) or are free-form aliases (Claude). */
  modelListing: 'dynamic' | 'aliases';
  approvals: true;
  /** Images can be sent inline. */
  images: boolean;
  permissionControls: 'claude-modes' | 'codex-sandbox' | 'none';
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities;
  detect(): Promise<ProviderStatus>;
  listModels(): Promise<ModelOption[]>;
  startLogin(): Promise<LoginStart>;
  /** Sign out through the provider's own command; credentials stay with the provider. */
  signOut(): Promise<void>;
  startTurn(input: TurnInput, emit: (event: ProviderEvent) => void): TurnHandle;
  /** MCP servers and apps from the provider's own configuration, as the provider reports them. */
  listConnectors(): Promise<ConnectorInventory>;
  dispose(): Promise<void>;
}

export function emptyStatus(provider: ProviderId): ProviderStatus {
  return {
    provider,
    state: 'checking',
    executable: null,
    version: null,
    account: null,
    authMethod: null,
    action: null,
    detail: null,
    rateLimits: [],
    rateLimited: false,
    notes: [],
    checkedAt: Date.now(),
  };
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [${text.length - max} more characters]`;
}
