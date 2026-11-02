import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type { ActivityKind, ActivityStatus, Attachment, Conversation, Handoff, Message, NestEvent, ProviderId, ProviderStatus, RateLimitWindow, Run, Usage } from '@shared/types';
import { PROVIDER_LABEL, effectivePermissions, resolveSkip } from '@shared/types';
import type { HandoffRequest } from '@shared/ipc';
import type { NestDb } from './db';
import { agentSystemPrompt, attachmentsNote, composePrompt, digest, instructionsUpdateBlock, memoryBlock, memoryDigest, transferSummary } from './context';
import type { McpLaunch } from './providers/types';
import type { ConnectorPolicy } from './connectors';
import type { ProviderAdapter, ProviderEvent, TurnHandle } from './providers/types';

export interface ProviderRegistry {
  get(id: ProviderId): ProviderAdapter & {
    getStatus(): ProviderStatus;
    detect(): Promise<ProviderStatus>;
    noteRateLimit?(windows: RateLimitWindow[], limited: boolean): void;
  };
}

interface ActiveRun {
  run: Run;
  handle: TurnHandle | null;
  conversationId: string;
  /** Skip permissions is in effect: every approval is answered automatically. */
  skipped: boolean;
  /** Hand a user message to the running turn. Resolves false when the turn could not take it. */
  steer: ((text: string, attachments: Attachment[]) => Promise<boolean>) | null;
  /** The run is being stopped to make way for a message the user sent while it worked. */
  steeredAway?: boolean;
}

export class UserFacingError extends Error {}

/**
 * Orchestrates turns: builds context, drives a provider adapter, and persists
 * every event so the transcript survives cancellation, failure and restart.
 */
export class RunManager {
  private active = new Map<string, ActiveRun>(); // by conversation id

  constructor(
    private readonly db: NestDb,
    private readonly providers: ProviderRegistry,
    private readonly broadcast: (event: NestEvent) => void,
    /** Folder used when a conversation has no workspace, so agents never roam the home folder. */
    private readonly defaultWorkspace: () => string,
  ) {}

  /** Something the user may want to hear about while Nest is in the background. */
  onAttention: ((e: { kind: 'approval' | 'finished' | 'failed'; conversationId: string; title: string; body: string }) => void) | null = null;

  isRunning(conversationId: string): boolean {
    return this.active.has(conversationId);
  }

  async send(conversationId: string, text: string, attachments: Attachment[]): Promise<{ runId: string }> {
    const conversation = this.db.getConversation(conversationId);
    if (!conversation) throw new UserFacingError('Conversation not found.');
    if (this.active.has(conversationId)) throw new UserFacingError('A response is already in progress. Stop it or wait for it to finish.');
    if (!text.trim() && !attachments.length) throw new UserFacingError('Message is empty.');
    await this.assertProviderReady(conversation.provider);

    const userMessage = this.db.insertMessage({
      conversationId,
      runId: null,
      role: 'user',
      kind: 'chat',
      content: text,
      status: 'complete',
      error: null,
      attachments,
      linkConversationId: null,
    });
    this.broadcast({ type: 'message', message: userMessage });
    if (conversation.title === 'New conversation' && text.trim()) {
      const title = text.trim().replace(/\s+/g, ' ').slice(0, 60);
      this.emitConversation(this.db.updateConversation(conversationId, { title }));
    } else {
      this.emitConversation(this.db.getConversation(conversationId)!);
    }
    return this.startRun(conversation, userMessage, false);
  }

  /**
   * Send a message while the agent is working. Providers that can take input mid-turn get it at
   * the agent's next step; the others are interrupted and the message starts a new turn.
   */
  async steer(conversationId: string, text: string, attachments: Attachment[]): Promise<{ runId: string }> {
    const active = this.active.get(conversationId);
    if (!active) return this.send(conversationId, text, attachments);
    if (!text.trim() && !attachments.length) throw new UserFacingError('Message is empty.');
    if (await active.steer?.(text, attachments)) return { runId: active.run.id };
    if (this.active.get(conversationId) === active && active.handle) {
      if (active.handle.steer) {
        // The turn is already wrapping up; the message goes out as soon as it ends.
        await active.handle.done;
      } else {
        active.steeredAway = true;
        await active.handle.cancel();
      }
    }
    return this.send(conversationId, text, attachments);
  }

  private async assertProviderReady(provider: ProviderId): Promise<void> {
    const adapter = this.providers.get(provider);
    let status = adapter.getStatus();
    if (status.state !== 'ready') status = await adapter.detect();
    else if (Date.now() - status.checkedAt > 5 * 60_000) void adapter.detect().catch(() => {}); // refresh without delaying the send
    if (status.state !== 'ready') {
      const label = PROVIDER_LABEL[provider];
      const what =
        status.state === 'not-installed' ? `${label} is not installed.` :
        status.state === 'signed-out' ? `${label} is not signed in.` :
        status.state === 'api-key' ? `${label} is using API-billed credentials, so Nest will not send this message.` :
        `${label} is not available.`;
      throw new UserFacingError(`${what} ${status.action ?? ''}`.trim());
    }
  }

  private startRun(conversation: Conversation, userMessage: Message, isRetry: boolean): { runId: string } {
    const agent = this.db.getAgent(conversation.agentId, true);
    if (!agent) throw new UserFacingError('The agent for this conversation no longer exists.');
    const provider = conversation.provider;
    const adapter = this.providers.get(provider);
    const settings = this.db.getSettings();

    // --- Context assembly --------------------------------------------------
    const session = this.db.getProviderSession(conversation.id, provider);
    const notes = this.db.memoryForAgent(agent.id, conversation.projectId);
    const memDigest = memoryDigest(notes);
    const project = conversation.projectId ? this.db.getProject(conversation.projectId) : null;
    const cwd = this.workspaceFor(conversation);
    const mcp = this.mcpLauncher?.(conversation.id) ?? null;
    const skip = resolveSkip(conversation.permissions, agent.permissions, settings);
    const projectContext = project
      ? {
          name: project.name,
          brief: project.brief,
          teammates: this.db
            .projectMembers(project.id)
            .filter((a) => a.id !== agent.id)
            .map((a) => ({ name: a.name, provider: PROVIDER_LABEL[a.provider], role: a.instructions.trim().split('\n')[0].slice(0, 160) })),
        }
      : null;
    const systemPrompt = agentSystemPrompt(agent, cwd, Boolean(mcp), skip, projectContext);
    const instrDigest = digest(systemPrompt);
    const includeMemory = notes.length > 0 ? session?.memoryDigest !== memDigest : Boolean(session?.memoryDigest && session.memoryDigest !== memDigest);
    const instructionsChanged = Boolean(session && session.instructionsDigest && session.instructionsDigest !== instrDigest);

    // Visible transcript this native session has not seen (other provider, handoff results, failed resume).
    const userSeq = this.db.seqOfMessage(userMessage.id);
    const runProviders = new Map(this.db.listRuns(conversation.id).map((r) => [r.id, r.provider]));
    const unseen = this.db
      .listMessagesWithSeq(conversation.id, session?.syncedSeq ?? 0)
      .filter((m) => m.seq < userSeq)
      .map((m) => ({ ...m, providerLabel: m.runId ? PROVIDER_LABEL[runProviders.get(m.runId) ?? provider] : undefined }));
    const transfer = transferSummary(unseen, settings.transferBudgetChars, session ? 'messages since this session last ran' : isRetry ? 'previous session could not be resumed' : 'new native session for an existing conversation');

    const prompt = composePrompt([
      transfer?.text,
      includeMemory ? memoryBlock(notes, agent.name) : null,
      instructionsChanged ? instructionsUpdateBlock(systemPrompt) : null,
      userMessage.content,
      attachmentsNote(userMessage.attachments),
    ]);

    const run = this.db.createRun({
      conversationId: conversation.id,
      provider,
      model: conversation.model,
      sessionId: session?.sessionId ?? null,
      includedNoteIds: includeMemory ? notes.map((n) => n.id) : [],
    });
    this.broadcast({ type: 'run', run });
    const newReply = () => {
      const message = this.db.insertMessage({
        conversationId: conversation.id,
        runId: run.id,
        role: 'assistant',
        kind: 'chat',
        content: '',
        status: 'streaming',
        error: null,
        attachments: [],
        linkConversationId: null,
      });
      this.broadcast({ type: 'message', message });
      return message;
    };
    let assistant = newReply();

    if (includeMemory) {
      this.activity(conversation.id, run.id, {
        id: 'ctx-memory',
        kind: 'context',
        title: notes.length ? `Included ${notes.length} memory note${notes.length === 1 ? '' : 's'}` : 'Told the agent memory notes were cleared',
        detail: notes.map((n) => `${n.scope === 'shared' ? 'Shared' : n.scope === 'project' ? (project?.name ?? 'Project') : agent.name}: ${n.content}`).join('\n') || null,
        status: 'done',
      });
    }
    if (instructionsChanged) this.activity(conversation.id, run.id, { id: 'ctx-instructions', kind: 'context', title: 'Sent updated agent instructions', status: 'done' });
    if (transfer) {
      this.activity(conversation.id, run.id, {
        id: 'ctx-transfer',
        kind: 'context',
        title: `Transferred ${transfer.included} earlier message${transfer.included === 1 ? '' : 's'} as a summary${transfer.omitted ? ` (${transfer.omitted} omitted)` : ''}`,
        detail: transfer.text,
        status: 'done',
      });
    }

    const permissions = effectivePermissions(conversation.permissions, skip);
    if (permissions.skipped) {
      this.activity(conversation.id, run.id, {
        id: 'ctx-skip',
        kind: 'approval',
        title: 'Permissions skipped: full access, approvals answered automatically',
        status: 'done',
      });
    }

    // --- Drive the provider -------------------------------------------------
    const active: ActiveRun = { run, handle: null, conversationId: conversation.id, skipped: permissions.skipped, steer: null };
    this.active.set(conversation.id, active);

    let segments = new Map<string, string>();
    let order: string[] = [];
    /** Text segments that belong to a reply before a steering message; late updates to them are dropped. */
    const retired = new Set<string>();
    let content = '';
    let lastError: string | null = null;
    let sessionMissing = false;
    let usage: Usage | null = null;
    let flushTimer: NodeJS.Timeout | null = null;
    let lastBroadcast = 0;
    let sessionId = session?.sessionId ?? null;

    const flush = (final = false) => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (!final) this.db.updateMessage(assistant.id, { content });
    };
    const scheduleFlush = () => {
      const now = Date.now();
      if (now - lastBroadcast > 50) {
        lastBroadcast = now;
        this.broadcast({ type: 'message', message: { ...assistant, content, status: 'streaming' } });
      }
      if (!flushTimer) flushTimer = setTimeout(() => flush(), 400);
    };
    const setSegment = (id: string, text: string) => {
      if (retired.has(id)) return;
      if (!segments.has(id)) order.push(id);
      segments.set(id, text);
      content = order.map((k) => segments.get(k) ?? '').filter((t) => t.trim()).join('\n\n');
      scheduleFlush();
    };

    const onEvent = (event: ProviderEvent) => {
      switch (event.type) {
        case 'session':
          sessionId = event.sessionId;
          this.db.upsertProviderSession(conversation.id, provider, { sessionId: event.sessionId, syncedSeq: session?.sessionId === event.sessionId ? session.syncedSeq : 0 });
          this.broadcast({ type: 'run', run: this.db.updateRun(run.id, { sessionId: event.sessionId, ...(event.model ? { model: event.model } : {}) }) });
          break;
        case 'text-delta':
          setSegment(event.segmentId, (segments.get(event.segmentId) ?? '') + event.text);
          break;
        case 'text-final':
          setSegment(event.segmentId, event.text);
          break;
        case 'activity':
          this.activity(conversation.id, run.id, event);
          break;
        case 'approval-request': {
          if (active.skipped) {
            // Anything that still asks (e.g. actions no provider mode auto-approves) is approved here.
            const choice = event.choices.find((c) => c.tone === 'primary') ?? event.choices[0];
            active.handle?.respondApproval(event.requestId, choice.id);
            this.activity(conversation.id, run.id, {
              id: `auto-${event.requestId}`,
              kind: 'approval',
              title: `Auto-approved (permissions skipped): ${event.action.split('\n')[0].slice(0, 140)}`,
              status: 'done',
            });
            break;
          }
          const approval = this.db.createApproval({
            runId: run.id,
            conversationId: conversation.id,
            provider,
            requestId: event.requestId,
            title: event.title,
            action: event.action,
            target: event.target,
            reason: event.reason,
            detail: event.detail,
            choices: event.choices,
          });
          this.broadcast({ type: 'approval', approval });
          this.db.addInbox({ kind: 'approval', conversationId: conversation.id, refId: approval.id, title: `${agent.name} needs approval`, body: `${event.title}: ${event.action.slice(0, 200)}` });
          this.broadcast({ type: 'inbox-changed' });
          this.onAttention?.({ kind: 'approval', conversationId: conversation.id, title: `${agent.name} needs approval`, body: event.action.split('\n')[0].slice(0, 120) });
          break;
        }
        case 'approval-cancelled': {
          const approval = this.db.findApprovalByRequest(run.id, event.requestId);
          if (approval) {
            this.broadcast({ type: 'approval', approval: this.db.resolveApproval(approval.id, 'expired', null) });
            this.broadcast({ type: 'inbox-changed' });
          }
          break;
        }
        case 'usage':
          usage = { ...(usage ?? {}), ...event.usage };
          break;
        case 'rate-limit':
          if (event.message) this.activity(conversation.id, run.id, { id: `rate-${Date.now()}`, kind: 'info', title: event.message, status: event.limited ? 'failed' : 'done' });
          adapter.noteRateLimit?.(event.windows, event.limited);
          break;
        case 'error':
          lastError = event.message;
          if (event.code === 'session-missing') sessionMissing = true;
          break;
        case 'completed':
          void finalize(event.status, lastError ?? event.error ?? null);
          break;
      }
    };

    const finalize = async (status: 'completed' | 'interrupted' | 'failed', error: string | null) => {
      flush(true);
      this.active.delete(conversation.id);
      if (status === 'failed' && sessionMissing && !isRetry) {
        this.db.clearProviderSession(conversation.id, provider);
        const msg = this.db.updateMessage(assistant.id, { content, status: 'error', error: `${error ?? 'Session unavailable.'}\nStarting a new ${PROVIDER_LABEL[provider]} session with a transferred summary.` });
        this.broadcast({ type: 'message', message: msg });
        this.closeRun(run.id, 'failed', error, usage);
        try {
          this.startRun(this.db.getConversation(conversation.id)!, userMessage, true);
        } catch (err) {
          lastError = (err as Error).message;
        }
        return;
      }
      const messageStatus = status === 'completed' ? 'complete' : status === 'interrupted' ? 'interrupted' : 'error';
      const msg = this.db.updateMessage(assistant.id, {
        content,
        status: messageStatus,
        error: status === 'failed' ? error ?? 'The run failed.' : status === 'interrupted' ? (active.steeredAway ? 'Stopped for your new message.' : 'Stopped.') : null,
      });
      this.broadcast({ type: 'message', message: msg });
      const finalRun = this.closeRun(run.id, status, status === 'failed' ? error ?? 'The run failed.' : null, usage);
      if (sessionId) {
        this.db.upsertProviderSession(conversation.id, provider, {
          sessionId,
          memoryDigest: memDigest,
          instructionsDigest: instrDigest,
          syncedSeq: this.db.maxMessageSeq(conversation.id),
        });
      }
      this.emitConversation(this.db.getConversation(conversation.id)!);
      if (status === 'failed') {
        this.db.addInbox({ kind: 'failure', conversationId: conversation.id, refId: run.id, title: `${agent.name}: run failed`, body: (error ?? 'The run failed.').slice(0, 400) });
        this.broadcast({ type: 'inbox-changed' });
      }
      this.onRunFinished?.(conversation.id, finalRun, msg);
      if (status !== 'interrupted') {
        this.onAttention?.({
          kind: status === 'failed' ? 'failed' : 'finished',
          conversationId: conversation.id,
          title: status === 'failed' ? `${agent.name}: run failed` : `${agent.name} replied`,
          body: (status === 'failed' ? error ?? 'The run failed.' : content).replace(/\s+/g, ' ').slice(0, 140),
        });
      }
    };

    // A message sent mid-turn closes the reply so far, and the agent's answer continues below it.
    active.steer = async (text, attachments) => {
      const handle = active.handle;
      if (!handle?.steer || this.active.get(conversation.id) !== active) return false;
      if (!(await handle.steer(composePrompt([text, attachmentsNote(attachments)]), attachments))) return false;
      if (this.active.get(conversation.id) !== active) return false;
      flush(true);
      this.broadcast({ type: 'message', message: this.db.updateMessage(assistant.id, { content, status: 'complete' }) });
      const steerMessage = this.db.insertMessage({
        conversationId: conversation.id,
        runId: null,
        role: 'user',
        kind: 'chat',
        content: text,
        status: 'complete',
        error: null,
        attachments,
        linkConversationId: null,
      });
      this.broadcast({ type: 'message', message: steerMessage });
      for (const id of order) retired.add(id);
      segments = new Map();
      order = [];
      content = '';
      assistant = newReply();
      return true;
    };

    try {
      active.handle = adapter.startTurn(
        {
          runId: run.id,
          sessionId: session?.sessionId ?? null,
          cwd,
          model: conversation.model,
          effort: conversation.effort,
          instructions: systemPrompt,
          mcp,
          connectors: this.connectorPolicy?.(agent.id, provider) ?? null,
          prompt,
          attachments: userMessage.attachments,
          permissions,
        },
        (event) => {
          try {
            onEvent(event);
          } catch (err) {
            console.error('Failed to handle provider event', event.type, err);
          }
        },
      );
    } catch (err) {
      void finalize('failed', (err as Error).message);
    }
    return { runId: run.id };
  }


  /** The folder a conversation's agent (and its terminal) works in, created if needed. */
  workspaceFor(conversation: Conversation): string {
    const project = conversation.projectId ? this.db.getProject(conversation.projectId) : null;
    return conversation.workspace ?? this.ensureFolder(project?.workspace ?? this.defaultWorkspace());
  }

  private ensureFolder(dir: string): string {
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private closeRun(runId: string, status: Run['status'], error: string | null, usage: Usage | null): Run {
    const activityStatus = status === 'completed' ? 'done' : status === 'interrupted' ? 'declined' : 'failed';
    const run = this.db.getRun(runId)!;
    // Nest tool approvals die with their run.
    for (const a of this.db.listApprovals(run.conversationId)) {
      if (a.runId !== runId || a.status !== 'pending') continue;
      this.localApprovals.get(a.id)?.('deny');
      this.localApprovals.delete(a.id);
      this.broadcast({ type: 'approval', approval: this.db.resolveApproval(a.id, 'expired', null) });
    }
    for (const a of this.db.failRunningActivities(runId, activityStatus)) this.broadcast({ type: 'activity', activity: a, conversationId: run.conversationId });
    const finalRun = this.db.updateRun(runId, { status, error, usage, endedAt: Date.now() });
    this.broadcast({ type: 'run', run: finalRun });
    return finalRun;
  }

  private activity(conversationId: string, runId: string, a: { id: string; kind: ActivityKind; title?: string; detail?: string | null; output?: string | null; status: ActivityStatus }): void {
    const activity = this.db.upsertActivity(conversationId, { ...a, runId });
    this.broadcast({ type: 'activity', activity, conversationId });
  }

  private emitConversation(conversation: Conversation): void {
    this.broadcast({ type: 'conversation', conversation });
  }

  onRunFinished: ((conversationId: string, run: Run, message: Message) => void) | null = null;

  async cancel(conversationId: string): Promise<void> {
    const active = this.active.get(conversationId);
    if (!active?.handle) return;
    await active.handle.cancel();
  }

  respondApproval(approvalId: string, choiceId: string): void {
    const approval = this.db.getApproval(approvalId);
    if (!approval || approval.status !== 'pending') throw new UserFacingError('This approval is no longer pending.');
    const choice = approval.choices.find((c) => c.id === choiceId);
    if (!choice) throw new UserFacingError('Unknown choice.');
    const local = this.localApprovals.get(approvalId);
    const active = this.active.get(approval.conversationId);
    if (local) {
      this.localApprovals.delete(approvalId);
      local(choiceId);
    } else if (!active || active.run.id !== approval.runId || !active.handle) {
      this.broadcast({ type: 'approval', approval: this.db.resolveApproval(approvalId, 'expired', null) });
      throw new UserFacingError('The run that asked for this approval has ended.');
    } else {
      active.handle.respondApproval(approval.requestId, choiceId);
    }
    this.broadcast({ type: 'approval', approval: this.db.resolveApproval(approvalId, 'resolved', choice.label) });
    this.activity(approval.conversationId, approval.runId, {
      id: `approval-${approval.id}`,
      kind: 'approval',
      title: `${choice.label}: ${approval.action.split('\n')[0].slice(0, 140)}`,
      status: choice.id.startsWith('accept') || choice.id.startsWith('allow') || choice.id.startsWith('grant') ? 'done' : 'declined',
    });
    this.broadcast({ type: 'inbox-changed' });
  }

  // --- Approvals raised by Nest's own agent tools -----------------------------

  private localApprovals = new Map<string, (choiceId: string) => void>();

  /** Ask the user to approve an action an agent requested through a Nest tool. Resolves with the choice id. */
  requestLocalApproval(
    conversationId: string,
    spec: { title: string; action: string; target: string | null; reason: string | null; detail: string | null; approveLabel: string },
    /** Ask even when permissions are skipped (the agent explicitly asked via ask_permission). */
    force = false,
  ): Promise<string> {
    const active = this.active.get(conversationId);
    if (!active) return Promise.resolve('deny');
    if (active.skipped && !force) {
      this.activity(conversationId, active.run.id, { id: `auto-nest-${randomUUID()}`, kind: 'approval', title: `Auto-approved (permissions skipped): ${spec.title}`, status: 'done' });
      return Promise.resolve('allow');
    }
    const agent = this.db.getAgent(this.db.getConversation(conversationId)?.agentId ?? '', true);
    const approval = this.db.createApproval({
      runId: active.run.id,
      conversationId,
      provider: active.run.provider,
      requestId: `nest:${randomUUID()}`,
      title: spec.title,
      action: spec.action,
      target: spec.target,
      reason: spec.reason,
      detail: spec.detail,
      choices: [
        { id: 'allow', label: spec.approveLabel, tone: 'primary' },
        { id: 'deny', label: 'Decline', tone: 'neutral' },
      ],
    });
    this.broadcast({ type: 'approval', approval });
    this.db.addInbox({ kind: 'approval', conversationId, refId: approval.id, title: `${agent?.name ?? 'Agent'} needs approval`, body: `${spec.title}: ${spec.action.slice(0, 200)}` });
    this.broadcast({ type: 'inbox-changed' });
    this.onAttention?.({ kind: 'approval', conversationId, title: `${agent?.name ?? 'Agent'} needs approval`, body: spec.title });
    return new Promise((resolve) => this.localApprovals.set(approval.id, resolve));
  }

  /** Supplies the Nest MCP server launch spec for a conversation, or null when unavailable. */
  mcpLauncher: ((conversationId: string) => McpLaunch | null) | null = null;

  /** Supplies an agent's connector and browser choices for a provider. */
  connectorPolicy: ((agentId: string, provider: ProviderId) => Promise<ConnectorPolicy>) | null = null;

  // --- Delegation -------------------------------------------------------------

  private handoffWaiters = new Map<string, Array<(r: { status: string; result: string }) => void>>();

  waitForHandoff(handoffId: string, timeoutMs: number): Promise<{ status: string; result: string }> {
    const existing = this.db.getHandoff(handoffId);
    if (existing && existing.status !== 'running') return Promise.resolve({ status: existing.status, result: existing.result ?? '' });
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ status: 'running', result: 'Still working; the result will be posted to your conversation when it finishes.' }), timeoutMs);
      const list = this.handoffWaiters.get(handoffId) ?? [];
      list.push((r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.handoffWaiters.set(handoffId, list);
    });
  }

  private notifyHandoff(handoffId: string, r: { status: string; result: string }): void {
    for (const cb of this.handoffWaiters.get(handoffId) ?? []) cb(r);
    this.handoffWaiters.delete(handoffId);
  }

  /** How many handoffs deep a conversation is (0 for a conversation the user started). */
  handoffDepth(conversationId: string): number {
    let depth = 0;
    let conv = this.db.getConversation(conversationId);
    while (conv?.handoffId && depth < 10) {
      depth++;
      conv = this.db.getConversation(this.db.getHandoff(conv.handoffId)?.sourceConversationId ?? '');
    }
    return depth;
  }

  async cancelAll(): Promise<void> {
    await Promise.all([...this.active.values()].map((a) => a.handle?.cancel()));
  }

  // --- Handoffs --------------------------------------------------------------

  async startHandoff(req: HandoffRequest): Promise<Handoff> {
    const source = this.db.getConversation(req.sourceConversationId);
    const target = this.db.getAgent(req.targetAgentId);
    if (!source || !target) throw new UserFacingError('Handoff source or target not found.');
    if (!req.task.trim()) throw new UserFacingError('Describe the task to hand off.');
    await this.assertProviderReady(target.provider);
    const sourceAgent = this.db.getAgent(source.agentId, true);
    const handoffId = randomUUID();
    // Delegated work happens in the project it was delegated from.
    const conversation = this.db.createConversation(target, { title: `Handoff: ${req.task.trim().slice(0, 50)}`, handoffId, projectId: source.projectId });
    const handoff = this.db.createHandoff({ id: handoffId, sourceConversationId: source.id, targetAgentId: target.id, targetConversationId: conversation.id, task: req.task, context: req.context });
    const notice = this.db.insertMessage({
      conversationId: source.id,
      runId: null,
      role: 'system',
      kind: 'notice',
      content: `Handed off to ${target.name}: ${req.task.trim()}`,
      status: 'complete',
      error: null,
      attachments: [],
      linkConversationId: conversation.id,
    });
    this.broadcast({ type: 'message', message: notice });
    this.emitConversation(conversation);
    this.broadcast({ type: 'handoff', handoff });
    const text = composePrompt([
      req.task.trim(),
      req.context.trim() ? `<handoff-context from="${sourceAgent?.name ?? 'another agent'}">\n${req.context.trim()}\n</handoff-context>` : null,
      'When you finish, reply with a concise result the requesting agent can use.',
    ]);
    await this.send(conversation.id, text, []);
    return handoff;
  }

  /** Called for every finished run; completes handoffs and links results back. */
  handleHandoffCompletion(conversationId: string, run: Run, message: Message): void {
    const conversation = this.db.getConversation(conversationId);
    if (!conversation?.handoffId) return;
    const handoff = this.db.getHandoff(conversation.handoffId);
    if (!handoff || handoff.status !== 'running') return;
    if (run.status === 'interrupted') {
      // The user may continue the handoff conversation; a waiting delegator is told it stopped.
      this.notifyHandoff(handoff.id, { status: 'interrupted', result: 'The user stopped this delegated run.' });
      return;
    }
    const agent = this.db.getAgent(conversation.agentId, true);
    const ok = run.status === 'completed';
    const result = ok ? message.content.trim().slice(0, 12000) || '(no text result)' : run.error ?? 'The handoff run failed.';
    const done = this.db.completeHandoff(handoff.id, ok ? 'completed' : 'failed', result);
    this.notifyHandoff(handoff.id, { status: done.status, result });
    const back = this.db.insertMessage({
      conversationId: handoff.sourceConversationId,
      runId: null,
      role: 'system',
      kind: 'handoff-result',
      content: ok ? result : `Handoff failed: ${result}`,
      status: ok ? 'complete' : 'error',
      error: null,
      attachments: [],
      linkConversationId: conversation.id,
    });
    this.broadcast({ type: 'message', message: back });
    this.emitConversation(this.db.getConversation(handoff.sourceConversationId)!);
    this.broadcast({ type: 'handoff', handoff: done });
    this.db.addInbox({
      kind: 'handoff',
      conversationId: handoff.sourceConversationId,
      refId: handoff.id,
      title: `${agent?.name ?? 'Agent'} ${ok ? 'finished' : 'could not finish'} a handoff`,
      body: `${handoff.task.slice(0, 120)}\n\n${result.slice(0, 300)}`,
    });
    this.broadcast({ type: 'inbox-changed' });
  }
}

