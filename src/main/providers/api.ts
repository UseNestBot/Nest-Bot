import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ApiProviderId, ConnectorInventory, LoginStart, ModelOption, ProviderStatus } from '@shared/types';
import { PROVIDER_LABEL } from '@shared/types';
import { maskKey } from '../apiKeys';
import { isObject } from './claudeMapper';
import { emptyStatus, type ProviderAdapter, type ProviderEvent, type TurnHandle, type TurnInput } from './types';

/**
 * Chat models reached over HTTPS with an API key the user saved in Nest. Every
 * one of these services offers the OpenAI-compatible Chat Completions API, so
 * one adapter covers them. They are chat only: no shell, files or tools.
 * Billing goes to the user's key, which is why they're labelled "API" everywhere.
 */

export interface ApiDefinition {
  id: ApiProviderId;
  baseUrl: string;
  /** Where to create a key. */
  keyUrl: string;
  extraHeaders?(key: string): Record<string, string>;
  /** Hide models that can't chat (embeddings, speech, images). */
  chatModel?(id: string): boolean;
  /** Picked when the conversation's model is Default. */
  preferred: RegExp;
  /** Always offered first, even if the listing leaves it out. */
  pinnedDefault?: ModelOption;
  /** The endpoint accepts stream_options.include_usage. */
  streamUsage: boolean;
}

const chat = (id: string, label = id): ModelOption => ({ id, label, isDefault: false, efforts: [], defaultEffort: null });

export const API_DEFINITIONS: Record<ApiProviderId, ApiDefinition> = {
  openrouter: {
    id: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/settings/keys',
    extraHeaders: () => ({ 'X-Title': 'Nest' }),
    preferred: /^openrouter\/auto$/,
    pinnedDefault: chat('openrouter/auto', 'Auto (OpenRouter picks)'),
    streamUsage: true,
  },
  'openai-api': {
    id: 'openai-api',
    baseUrl: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    chatModel: (id) => /^(gpt-|o\d|chatgpt-)/.test(id) && !/(audio|realtime|transcribe|tts|image|search|embedding|instruct|moderation)/.test(id),
    preferred: /^gpt-\d+(\.\d+)?$/,
    streamUsage: true,
  },
  'anthropic-api': {
    id: 'anthropic-api',
    baseUrl: 'https://api.anthropic.com/v1',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    // The model listing is Anthropic's own API; chat goes through its OpenAI-compatible endpoint.
    extraHeaders: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
    preferred: /sonnet/,
    streamUsage: false,
  },
  'gemini-api': {
    id: 'gemini-api',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyUrl: 'https://aistudio.google.com/apikey',
    chatModel: (id) => /gemini/.test(id) && !/(embedding|imagen|aqa|tts|image|live|audio)/.test(id),
    preferred: /^gemini-[\d.]+-pro$/,
    streamUsage: false,
  },
  'xai-api': {
    id: 'xai-api',
    baseUrl: 'https://api.x.ai/v1',
    keyUrl: 'https://console.x.ai',
    chatModel: (id) => /^grok/.test(id) && !/(image|imagine|video)/.test(id),
    preferred: /^grok-\d+(\.\d+)?$/,
    streamUsage: true,
  },
};

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface SessionFile {
  version: 1;
  messages: ChatMessage[];
}

/** API conversations are re-sent in full every turn, so very old turns are dropped past this size. */
const HISTORY_BUDGET_CHARS = 300_000;
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

/** Highest version first, so "gpt-5.2" beats "gpt-5". */
function byVersionDesc(a: string, b: string): number {
  return b.localeCompare(a, undefined, { numeric: true });
}

export function trimHistory(messages: ChatMessage[], budget = HISTORY_BUDGET_CHARS): ChatMessage[] {
  let total = messages.reduce((n, m) => n + m.content.length, 0);
  let start = 0;
  // Drop whole exchanges from the front, keeping at least the latest one.
  while (total > budget && start < messages.length - 2) {
    total -= messages[start].content.length;
    start++;
    if (messages[start]?.role === 'assistant') {
      total -= messages[start].content.length;
      start++;
    }
  }
  return messages.slice(start);
}

/** Parses an SSE byte stream into `data:` payloads. */
export class SseParser {
  private buffer = '';
  private readonly decoder = new TextDecoder('utf-8');
  constructor(private readonly onData: (data: string) => void) {}
  push(chunk: Uint8Array | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    let idx = this.buffer.indexOf('\n');
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      if (line.startsWith('data:')) this.onData(line.slice(5).trimStart());
      idx = this.buffer.indexOf('\n');
    }
  }
}

export class ApiProvider implements ProviderAdapter {
  readonly capabilities = { modelListing: 'dynamic', approvals: true, images: true, permissionControls: 'none' } as const;
  private status: ProviderStatus;
  private models: ModelOption[] | null = null;
  private readonly controllers = new Set<AbortController>();

  constructor(
    private readonly def: ApiDefinition,
    private readonly keys: { get(p: ApiProviderId): string | null; clear(p: ApiProviderId): void },
    private readonly sessionsDir: string,
    private readonly onStatus: (status: ProviderStatus) => void,
    private readonly openExternal: (url: string) => void,
    private readonly fetchFn: typeof fetch = (...args) => fetch(...args),
  ) {
    this.status = emptyStatus(def.id);
  }

  get id(): ApiProviderId {
    return this.def.id;
  }

  getStatus(): ProviderStatus {
    return this.status;
  }

  private setStatus(status: ProviderStatus): ProviderStatus {
    status.checkedAt = Date.now();
    this.status = status;
    this.onStatus(status);
    return status;
  }

  private headers(key: string): Record<string, string> {
    return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(this.def.extraHeaders?.(key) ?? {}) };
  }

  /** Error text from a failed response, with the key scrubbed in case a service echoes it. */
  private async describeFailure(res: Response, key: string): Promise<string> {
    let text = '';
    try {
      text = await res.text();
    } catch {
      /* no body */
    }
    let message = text.slice(0, 400);
    try {
      const body = JSON.parse(text) as unknown;
      const err = Array.isArray(body) ? body[0]?.error : isObject(body) ? body.error : null;
      if (isObject(err) && typeof err.message === 'string') message = err.message;
      else if (typeof err === 'string') message = err;
    } catch {
      /* not JSON */
    }
    return `${PROVIDER_LABEL[this.def.id]} returned ${res.status}${message ? `: ${message.split(key).join('…')}` : ''}`;
  }

  private async fetchModels(key: string): Promise<ModelOption[]> {
    const res = await this.fetchFn(`${this.def.baseUrl}/models`, { headers: this.headers(key), signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw Object.assign(new Error(await this.describeFailure(res, key)), { status: res.status });
    const body = (await res.json()) as unknown;
    const list = isObject(body) && Array.isArray(body.data) ? body.data : isObject(body) && Array.isArray(body.models) ? body.models : [];
    const seen = new Set<string>();
    const models: ModelOption[] = [];
    for (const m of list) {
      if (!isObject(m)) continue;
      const id = String(m.id ?? m.name ?? '').replace(/^models\//, '');
      if (!id || seen.has(id) || (this.def.chatModel && !this.def.chatModel(id))) continue;
      seen.add(id);
      const label = typeof m.display_name === 'string' ? m.display_name : typeof m.name === 'string' && m.name !== m.id && !m.name.startsWith('models/') ? m.name : id;
      models.push(chat(id, label));
    }
    if (this.def.id !== 'anthropic-api') models.sort((a, b) => a.label.localeCompare(b.label));
    const pinned = this.def.pinnedDefault;
    return [{ id: '', label: 'Default', isDefault: true, efforts: [], defaultEffort: null }, ...(pinned ? [pinned] : []), ...models.filter((m) => m.id !== pinned?.id)];
  }

  async detect(): Promise<ProviderStatus> {
    const label = PROVIDER_LABEL[this.def.id];
    const status = emptyStatus(this.def.id);
    status.authMethod = 'API key';
    const key = this.keys.get(this.def.id);
    if (!key) {
      status.state = 'signed-out';
      status.action = `Add a ${label} key in Settings → Providers to use it. Usage is billed to that key.`;
      this.models = null;
      return this.setStatus(status);
    }
    status.account = `API key ${maskKey(key)}`;
    status.notes.push('Billed per token to your API key. Chat only: these models can’t run commands or edit files.');
    try {
      this.models = await this.fetchModels(key);
      status.state = 'ready';
    } catch (err) {
      const code = (err as { status?: number }).status;
      status.state = 'error';
      status.detail = (err as Error).message.slice(0, 500);
      status.action = code === 401 || code === 403 ? `${label} rejected the saved key. Paste a new one in Settings → Providers.` : `Could not reach ${label}. Check your connection, then press Recheck.`;
    }
    return this.setStatus(status);
  }

  async listModels(): Promise<ModelOption[]> {
    if (this.models) return this.models;
    const key = this.keys.get(this.def.id);
    if (!key) return [{ id: '', label: 'Default', isDefault: true, efforts: [], defaultEffort: null }];
    try {
      this.models = await this.fetchModels(key);
      return this.models;
    } catch {
      return [{ id: '', label: 'Default', isDefault: true, efforts: [], defaultEffort: null }];
    }
  }

  private async defaultModel(): Promise<string | null> {
    const models = (await this.listModels()).filter((m) => m.id);
    const pinned = this.def.pinnedDefault?.id;
    if (pinned) return pinned;
    const preferred = models.map((m) => m.id).filter((id) => this.def.preferred.test(id)).sort(byVersionDesc)[0];
    return preferred ?? models[0]?.id ?? null;
  }

  async startLogin(): Promise<LoginStart> {
    this.openExternal(this.def.keyUrl);
    return { kind: 'browser', message: `Create a key on the ${PROVIDER_LABEL[this.def.id]} page that just opened, then paste it in Settings → Providers.`, command: null };
  }

  /** Forget the saved key. */
  async signOut(): Promise<void> {
    this.keys.clear(this.def.id);
    await this.detect();
  }

  async listConnectors(): Promise<ConnectorInventory> {
    return {
      provider: this.def.id,
      connectors: [],
      browser: { available: false, ready: false, missing: [], note: 'API models only chat: they have no tools, connectors or browser in Nest.' },
      error: null,
      checkedAt: Date.now(),
    };
  }

  private sessionFile(id: string): string {
    return path.join(this.sessionsDir, `${id.replace(/[^A-Za-z0-9-]/g, '')}.json`);
  }

  private loadSession(id: string): ChatMessage[] | null {
    try {
      const data = JSON.parse(readFileSync(this.sessionFile(id), 'utf8')) as SessionFile;
      return Array.isArray(data.messages) ? data.messages : null;
    } catch {
      return null;
    }
  }

  private saveSession(id: string, messages: ChatMessage[]): void {
    mkdirSync(this.sessionsDir, { recursive: true });
    const file = this.sessionFile(id);
    writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, messages: trimHistory(messages) } satisfies SessionFile));
    renameSync(`${file}.tmp`, file);
  }

  startTurn(input: TurnInput, emit: (event: ProviderEvent) => void): TurnHandle {
    const label = PROVIDER_LABEL[this.def.id];
    const controller = new AbortController();
    this.controllers.add(controller);
    let finished = false;
    let cancelled = false;
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    let text = '';
    let activeSession: string | null = null;

    const finish =(status: 'completed' | 'interrupted' | 'failed', error?: string) => {
      if (finished) return;
      finished = true;
      this.controllers.delete(controller);
      if (error) emit({ type: 'error', message: error, fatal: true });
      emit({ type: 'completed', status, error });
      resolveDone();
    };

    const run = async () => {
      const key = this.keys.get(this.def.id);
      if (!key) {
        finish('failed', `No ${label} key is saved. Add one in Settings → Providers.`);
        return;
      }
      let history: ChatMessage[] = [];
      let sessionId = input.sessionId;
      if (sessionId) {
        const loaded = this.loadSession(sessionId);
        if (!loaded) {
          emit({ type: 'error', message: `The saved ${label} conversation history is missing.`, code: 'session-missing', fatal: true });
          finish('failed', `The saved ${label} conversation history is missing.`);
          return;
        }
        history = loaded;
      } else {
        sessionId = randomUUID();
        this.saveSession(sessionId, []);
        emit({ type: 'session', sessionId });
      }
      activeSession = sessionId;
      const model =input.model || (await this.defaultModel());
      if (!model) {
        finish('failed', `${label} didn’t list any chat models for this key.`);
        return;
      }
      if (!input.model) emit({ type: 'session', sessionId, model });

      const userContent: unknown[] = [{ type: 'text', text: input.prompt }];
      for (const att of input.attachments) {
        const mime = att.isImage ? IMAGE_TYPES[path.extname(att.path).toLowerCase()] : undefined;
        if (!mime) continue;
        try {
          if (statSync(att.path).size > MAX_INLINE_IMAGE_BYTES) continue;
          userContent.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${readFileSync(att.path).toString('base64')}` } });
        } catch {
          /* listed in the prompt text instead */
        }
      }
      const body = {
        model,
        stream: true,
        ...(this.def.streamUsage ? { stream_options: { include_usage: true } } : {}),
        messages: [
          ...(input.instructions.trim() ? [{ role: 'system', content: input.instructions }] : []),
          ...history,
          { role: 'user', content: userContent.length === 1 ? input.prompt : userContent },
        ],
      };

      const res = await this.fetchFn(`${this.def.baseUrl}/chat/completions`, { method: 'POST', headers: this.headers(key), body: JSON.stringify(body), signal: controller.signal });
      if (!res.ok || !res.body) {
        finish('failed', await this.describeFailure(res, key));
        return;
      }
      let finishReason: string | null = null;
      let streamError: string | null = null;
      const parser = new SseParser((data) => {
        if (data === '[DONE]') return;
        let chunk: unknown;
        try {
          chunk = JSON.parse(data);
        } catch {
          return;
        }
        if (!isObject(chunk)) return;
        if (isObject(chunk.error)) streamError = typeof chunk.error.message === 'string' ? chunk.error.message : 'The stream reported an error.';
        const choice = Array.isArray(chunk.choices) && isObject(chunk.choices[0]) ? chunk.choices[0] : null;
        const delta = choice && isObject(choice.delta) ? choice.delta : null;
        if (delta && typeof delta.content === 'string' && delta.content) {
          text += delta.content;
          emit({ type: 'text-delta', segmentId: 'api', text: delta.content });
        }
        if (choice && typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
        if (isObject(chunk.usage)) {
          const u = chunk.usage;
          const details = isObject(u.prompt_tokens_details) ? u.prompt_tokens_details : {};
          emit({
            type: 'usage',
            usage: {
              inputTokens: typeof u.prompt_tokens === 'number' ? u.prompt_tokens : undefined,
              outputTokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : undefined,
              cachedInputTokens: typeof details.cached_tokens === 'number' ? details.cached_tokens : undefined,
            },
          });
        }
      });
      const reader = res.body.getReader();
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        parser.push(value);
      }
      parser.push('\n');

      history.push({ role: 'user', content: input.prompt }, { role: 'assistant', content: text });
      this.saveSession(sessionId, history);
      if (streamError) {
        finish('failed', `${label}: ${streamError}`);
        return;
      }
      if (finishReason === 'length') emit({ type: 'activity', id: 'api-length', kind: 'info', title: 'Stopped at the model’s output limit', status: 'done' });
      if (finishReason === 'content_filter') emit({ type: 'activity', id: 'api-filter', kind: 'info', title: `${label} filtered part of the reply`, status: 'failed' });
      finish('completed');
    };

    // Keep the stopped exchange, so the next turn knows what was asked.
    const saveInterrupted = () => {
      if (!activeSession) return;
      const history = this.loadSession(activeSession) ?? [];
      history.push({ role: 'user', content: input.prompt }, { role: 'assistant', content: `${text}\n[stopped by the user]` });
      this.saveSession(activeSession, history);
    };

    void run().catch((err: Error) => {
      if (cancelled) {
        saveInterrupted();
        finish('interrupted');
      } else finish('failed', `${label}: ${err.message}`);
    });

    return {
      cancel: async () => {
        if (finished) return;
        cancelled = true;
        controller.abort();
        await done;
      },
      // API chats never ask for approval.
      respondApproval: () => {},
      done,
    };
  }

  async dispose(): Promise<void> {
    for (const c of this.controllers) c.abort();
    this.controllers.clear();
  }
}
