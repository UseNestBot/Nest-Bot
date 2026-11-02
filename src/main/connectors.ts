import type { AgentAccess, BrowserSupport, Connector, ConnectorInventory, ConnectorStatus, ProviderId } from '@shared/types';
import { DEFAULT_AGENT_ACCESS } from '@shared/types';
import type { McpLaunch } from './providers/types';

/**
 * Connectors are the MCP servers and apps Codex and Claude Code already load
 * from their own configuration (claude.ai connectors, ChatGPT apps, config
 * files). Nest never sees their credentials: it lists them through the
 * providers' own commands and narrows what one agent may use with the
 * providers' own switches.
 */

/** What a provider needs to apply one agent's choices to a turn. */
export interface ConnectorPolicy {
  /** null: no restriction. Otherwise only these connector ids. */
  allowed: string[] | null;
  /** The provider's connectors as last listed; the ones not allowed are switched off by name. */
  known: Connector[];
  browser: boolean;
}

/** Nest's own server and the browser server are governed separately, never by the connector allowlist. */
const NEST_SERVER = 'nest';
export const CLAUDE_CHROME_SERVER = 'claude-in-chrome';

export const BROWSER_SUPPORT: Record<ProviderId, BrowserSupport> = {
  // Until the local check has run (see browser.ts).
  claude: {
    available: true,
    ready: null,
    missing: [],
    note: 'Claude in Chrome (claude --chrome): the agent drives your Chrome through the Claude in Chrome extension, signed in to the same Claude account. Each browser action asks for approval unless you allow it.',
  },
  codex: {
    available: false,
    ready: false,
    missing: ['Run this agent on Claude Code to browse, or add a browser MCP server to Codex (codex mcp add) and allow it under Codex connectors.'],
    note: 'Codex can’t control a browser under Nest: its Browser and Chrome plugins need a browser host that only the Codex desktop app provides, and under codex app-server they fail with “The browser access host is unavailable”. Codex agents still have Codex’s built-in web search.',
  },
  ...(Object.fromEntries(
    (['cursor', 'gemini', 'grok', 'openrouter', 'openai-api', 'anthropic-api', 'gemini-api', 'xai-api'] as const).map((p) => [
      p,
      { available: false, ready: false, missing: [], note: 'Only Claude Code agents can drive your own Chrome.' },
    ]),
  ) as unknown as Record<Exclude<ProviderId, 'claude' | 'codex'>, BrowserSupport>),
};

// ---------------------------------------------------------------------------
// Claude Code

/** Claude Code names a server's tools `mcp__<name>__<tool>` with anything outside [A-Za-z0-9_-] replaced. */
export function claudeToolPrefix(serverName: string): string {
  return `mcp__${serverName.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

function claudeSource(name: string): string {
  if (name.startsWith('claude.ai ')) return 'claude.ai';
  if (name.startsWith('plugin:')) return 'Claude Code plugin';
  return 'Claude Code config';
}

function claudeDisplayName(name: string): string {
  if (name.startsWith('claude.ai ')) return name.slice('claude.ai '.length);
  if (name.startsWith('plugin:')) return name.split(':')[1] ?? name;
  return name;
}

function statusFromText(text: string): ConnectorStatus {
  if (/connected/i.test(text) && !/not connected|disconnected/i.test(text)) return 'connected';
  if (/auth/i.test(text)) return 'needs-auth';
  if (/pending|approval/i.test(text)) return 'pending';
  if (/fail|error/i.test(text)) return 'failed';
  return 'unknown';
}

/**
 * Parse `claude mcp list`, one server per line:
 * `claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected`.
 * Names may contain colons (`plugin:figma:figma`) but never ": ", and the status follows the last " - ".
 */
export function parseClaudeMcpList(stdout: string): Connector[] {
  const out: Connector[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    const sep = line.indexOf(': ');
    const dash = line.lastIndexOf(' - ');
    if (sep <= 0 || dash <= sep) continue;
    const name = line.slice(0, sep).trim();
    const target = line.slice(sep + 2, dash).trim();
    const statusText = line.slice(dash + 3).replace(/^[^\p{L}]+/u, '').trim();
    out.push({
      provider: 'claude',
      id: name,
      name: claudeDisplayName(name),
      source: claudeSource(name),
      status: statusFromText(statusText),
      detail: name.startsWith('claude.ai ') ? statusText : `${statusText} · ${target}`,
    });
  }
  return out;
}

/** The `mcp_servers` of a `system/init` record, or `mcpServers` of an `mcp_status` reply: what a session loads. */
export function claudeServersFromInit(mcpServers: unknown): Connector[] {
  if (!Array.isArray(mcpServers)) return [];
  const out: Connector[] = [];
  for (const s of mcpServers) {
    if (!s || typeof s !== 'object') continue;
    const { name, status, source } = s as { name?: unknown; status?: unknown; source?: unknown };
    if (typeof name !== 'string' || source === 'dynamic' || name === NEST_SERVER) continue;
    out.push({
      provider: 'claude',
      id: name,
      name: claudeDisplayName(name),
      source: source === 'claudeai' ? 'claude.ai' : claudeSource(name),
      status: statusFromText(String(status ?? '')),
      detail: null,
    });
  }
  return out;
}

/**
 * A session's own server list is authoritative for what a run loads (it can differ
 * from `claude mcp list`, e.g. claude.ai connectors); the listing adds health.
 * Servers only the listing knows are kept, so restrictions cover them too.
 */
export function mergeClaudeConnectors(session: Connector[] | null, listed: Connector[]): Connector[] {
  if (!session) return listed;
  const merged = session.map((c) => {
    const l = listed.find((x) => x.id === c.id);
    return l ? { ...c, status: l.status, detail: l.detail } : { ...c, status: 'unknown' as const, detail: null };
  });
  return [...merged, ...listed.filter((l) => !session.some((c) => c.id === l.id))];
}

/**
 * MCP-related arguments for one Claude Code turn.
 *
 * - Nest's own server always comes in through `--mcp-config`.
 * - "No connectors" uses `--strict-mcp-config`, which drops every other source
 *   (config files and claude.ai connectors alike).
 * - "Only these" keeps the provider's configuration and removes every other
 *   server's tools with `--disallowedTools mcp__<server>`. claude.ai connectors
 *   cannot be re-declared in `--mcp-config` (their OAuth belongs to Claude), so
 *   this is the only way to keep one of them while dropping the rest.
 * - The browser is Claude in Chrome: `--chrome` / `--no-chrome`.
 */
export function claudeMcpArgs(policy: ConnectorPolicy | null, nest: McpLaunch | null): { args: string[]; disallowedTools: string[] } {
  const args: string[] = [];
  const disallowedTools: string[] = [];
  const servers: Record<string, unknown> = {};
  if (nest) servers[NEST_SERVER] = { type: 'stdio', command: nest.command, args: nest.args, env: nest.env };
  const strict = policy?.allowed !== null && policy?.allowed !== undefined && policy.allowed.length === 0;
  if (nest || strict) args.push('--mcp-config', JSON.stringify({ mcpServers: servers }));
  if (strict) args.push('--strict-mcp-config');
  // Nest's own tools are allowed here; the ones that change anything ask the user inside Nest.
  if (nest) args.push('--allowedTools', `mcp__${NEST_SERVER}`);
  if (policy?.allowed && policy.allowed.length) {
    const allowed = new Set(policy.allowed);
    for (const c of policy.known) {
      if (c.id === NEST_SERVER || c.id === CLAUDE_CHROME_SERVER || allowed.has(c.id)) continue;
      disallowedTools.push(claudeToolPrefix(c.id));
    }
  }
  if (policy) args.push(policy.browser ? '--chrome' : '--no-chrome');
  return { args, disallowedTools: [...new Set(disallowedTools)] };
}

/** Second line of defence for permission prompts: a tool from a server this agent may not use is refused. */
export function claudeToolAllowed(toolName: string, policy: ConnectorPolicy | null): boolean {
  if (!policy || !toolName.startsWith('mcp__')) return true;
  if (toolName.startsWith(`${claudeToolPrefix(CLAUDE_CHROME_SERVER)}__`)) return policy.browser;
  if (policy.allowed === null || toolName.startsWith(`mcp__${NEST_SERVER}__`)) return true;
  return policy.allowed.some((id) => toolName.startsWith(`${claudeToolPrefix(id)}__`));
}

// ---------------------------------------------------------------------------
// Codex

/** The server through which Codex exposes ChatGPT apps (Gmail, Google Calendar, Slack, …). */
export const CODEX_APPS_SERVER = 'codex_apps';

/**
 * Map `mcpServerStatus/list` to connectors. ChatGPT apps all live inside one
 * server (`codex_apps`); they are listed one per app, keyed by connector id,
 * because Codex can switch them on and off individually (`apps.<id>.enabled`).
 */
export function codexConnectorsFromStatus(data: unknown): Connector[] {
  if (!Array.isArray(data)) return [];
  const servers: Connector[] = [];
  const apps = new Map<string, { name: string; tools: number }>();
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as { name?: unknown; authStatus?: unknown; runtimeStatus?: unknown; pluginId?: unknown; tools?: unknown };
    if (typeof s.name !== 'string' || s.name === NEST_SERVER) continue;
    const tools = s.tools && typeof s.tools === 'object' ? Object.values(s.tools as Record<string, unknown>) : [];
    if (s.name === CODEX_APPS_SERVER) {
      for (const t of tools) {
        const meta = t && typeof t === 'object' ? ((t as { _meta?: unknown })._meta as Record<string, unknown> | undefined) : undefined;
        const id = typeof meta?.connector_id === 'string' ? meta.connector_id : null;
        if (!id) continue;
        const entry = apps.get(id) ?? { name: typeof meta?.connector_name === 'string' ? meta.connector_name : id, tools: 0 };
        entry.tools++;
        apps.set(id, entry);
      }
      continue;
    }
    const plugin = typeof s.pluginId === 'string' ? s.pluginId : null;
    const status: ConnectorStatus =
      s.authStatus === 'notLoggedIn' || s.runtimeStatus === 'authenticationRequired' ? 'needs-auth' :
      s.runtimeStatus === 'failed' ? 'failed' :
      tools.length > 0 || s.runtimeStatus === 'connected' ? 'connected' :
      'unknown';
    servers.push({
      provider: 'codex',
      id: `server:${s.name}`,
      name: s.name,
      source: plugin ? `Codex plugin ${plugin}` : 'Codex config',
      status,
      detail: tools.length ? `${tools.length} tool${tools.length === 1 ? '' : 's'}` : status === 'needs-auth' ? 'Needs sign-in' : 'No tools reported (not running, or needs sign-in)',
      plugin,
    });
  }
  const appList: Connector[] = [...apps].map(([id, a]) => ({
    provider: 'codex',
    id: `app:${id}`,
    name: a.name,
    source: 'ChatGPT app',
    status: 'connected',
    detail: `${a.tools} tool${a.tools === 1 ? '' : 's'}`,
  }));
  const byName = (a: Connector, b: Connector) => a.name.localeCompare(b.name);
  return [...appList.sort(byName), ...servers.sort(byName)];
}

/** Codex config keys are dotted paths; a segment containing a dot cannot be addressed. */
const plainSegment = (s: string) => /^[^.\s]+$/.test(s);

/**
 * Per-thread `config` overrides for one agent's connector choice.
 * Apps use Codex's own allowlist (`apps._default.enabled = false` plus
 * `apps.<id>.enabled = true`), so apps added later stay off. MCP servers have
 * no default switch, so each server not allowed is disabled by name.
 */
export function codexConfigOverrides(policy: ConnectorPolicy | null): Record<string, unknown> {
  if (!policy || policy.allowed === null) return {};
  const allowed = new Set(policy.allowed);
  const config: Record<string, unknown> = { 'apps._default.enabled': false };
  for (const id of allowed) {
    const app = id.startsWith('app:') ? id.slice(4) : null;
    if (app && plainSegment(app)) config[`apps.${app}.enabled`] = true;
  }
  for (const c of policy.known) {
    if (!c.id.startsWith('server:') || allowed.has(c.id)) continue;
    const name = c.id.slice('server:'.length);
    if (name === NEST_SERVER || !plainSegment(name)) continue;
    if (c.plugin) {
      if (plainSegment(c.plugin)) config[`plugins.${c.plugin}.mcp_servers.${name}.enabled`] = false;
    } else {
      config[`mcp_servers.${name}.enabled`] = false;
    }
  }
  return config;
}

/** Second line of defence for Codex's per-call MCP approval: refuse servers this agent may not use. */
export function codexServerAllowed(serverName: string, policy: ConnectorPolicy | null): boolean {
  if (!policy || policy.allowed === null || serverName === NEST_SERVER) return true;
  if (serverName === CODEX_APPS_SERVER) return policy.allowed.some((id) => id.startsWith('app:'));
  return policy.allowed.includes(`server:${serverName}`);
}

// ---------------------------------------------------------------------------

export function sanitizeAccess(a: Partial<AgentAccess> | null | undefined): AgentAccess {
  const list = (v: unknown): string[] | null =>
    Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 300))].slice(0, 500) : null;
  return {
    claudeConnectors: list(a?.claudeConnectors),
    codexConnectors: list(a?.codexConnectors),
    browser: typeof a?.browser === 'boolean' ? a.browser : DEFAULT_AGENT_ACCESS.browser,
    browserMode: a?.browserMode === 'chrome' ? 'chrome' : 'nest',
    terminal: a?.terminal === true,
  };
}

interface InventorySource {
  listConnectors(): Promise<ConnectorInventory>;
}

/** Caches each provider's connector list; listing starts every server, so it is not done per turn. */
export class ConnectorService {
  private cache = new Map<ProviderId, ConnectorInventory>();
  private inflight = new Map<ProviderId, Promise<ConnectorInventory>>();

  constructor(
    private readonly sources: (provider: ProviderId) => InventorySource,
    private readonly accessFor: (agentId: string) => AgentAccess,
  ) {}

  list(provider: ProviderId, refresh = false): Promise<ConnectorInventory> {
    const cached = this.cache.get(provider);
    if (cached && !refresh) return Promise.resolve(cached);
    let pending = this.inflight.get(provider);
    if (!pending) {
      pending = this.sources(provider)
        .listConnectors()
        .then((inv) => {
          // A failed listing keeps the last good one, so restrictions still know what to switch off.
          const prev = this.cache.get(provider);
          const next = inv.error && prev ? { ...prev, error: inv.error, checkedAt: inv.checkedAt } : inv;
          this.cache.set(provider, next);
          return next;
        })
        .finally(() => this.inflight.delete(provider));
      this.inflight.set(provider, pending);
    }
    return pending;
  }

  /** Remember servers a provider reported while running, so later restrictions cover them too. */
  noteSeen(provider: ProviderId, seen: Connector[]): void {
    const inv = this.cache.get(provider) ?? { provider, connectors: [], browser: BROWSER_SUPPORT[provider], error: null, checkedAt: Date.now() };
    const fresh = seen.filter((c) => !inv.connectors.some((k) => k.id === c.id));
    if (fresh.length) this.cache.set(provider, { ...inv, connectors: [...inv.connectors, ...fresh] });
  }

  /** A restricted agent waits for the first listing, so nothing slips through before Nest knows what to switch off. */
  async policyFor(agentId: string, provider: ProviderId): Promise<ConnectorPolicy> {
    const access = this.accessFor(agentId);
    // Only Claude Code and Codex connectors can be narrowed; other providers use their own configuration as is.
    const allowed = provider === 'claude' ? access.claudeConnectors : provider === 'codex' ? access.codexConnectors : null;
    if (allowed && allowed.length && !this.cache.has(provider)) await this.list(provider).catch(() => null);
    return {
      allowed,
      known: this.cache.get(provider)?.connectors ?? [],
      // Claude in Chrome only when the agent chose "My Chrome"; the Nest browser comes through Nest's own tools.
      browser: access.browser && access.browserMode === 'chrome' && BROWSER_SUPPORT[provider].available,
    };
  }
}
