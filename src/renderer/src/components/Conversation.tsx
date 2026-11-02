import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowLeftToLine, ArrowRightToLine, BookmarkPlus, Check, Copy, CornerDownRight, ExternalLink, FileText, GripVertical, Image as ImageIcon, Info, MoreHorizontal, PanelRight, Send, SquareTerminal, Trash2, X } from 'lucide-react';
import type { Agent, Attachment, ConversationDetail, Message, Run } from '@shared/types';
import { PROVIDER_LABEL } from '@shared/types';
import { api, IS_REMOTE } from '../api';
import { useStore } from '../store';
import { compactNumber, duration, stampTime, statusLabel } from '../format';
import { ActivityGroup, ApprovalCard } from './Activity';
import { Avatar } from './Avatar';
import { BrowserViewport } from './BrowserViewport';
import { Composer } from './Composer';
import { DetailsPanel } from './DetailsPanel';
import { Markdown } from './Markdown';
import { TerminalPanel, useTerminalPanel } from './TerminalPanel';
import { Button, Field, IconButton, MenuItem, Modal, Popover, Segmented, Tooltip, cx, inputClass } from './ui';
import { confirmDialog } from './confirm';
import { MobileBack, useMediaQuery } from './MobileBack';
import { dragChat } from './Projects';

const DETAILS_KEY = 'nest:details-open';
/** Below this width the details panel floats over the transcript (see DetailsPanel). */
const NARROW_QUERY = '(max-width: 1119px)';

/**
 * On wide windows the details panel sits beside the chat and remembers whether it was open.
 * On narrow ones, and in a split pane, it floats over the chat, so it starts closed and the choice isn't saved.
 */
function useDetailsOpen(conversationId: string, split: boolean): [boolean, (open: boolean) => void, boolean] {
  const narrow = useMediaQuery(NARROW_QUERY) || split;
  const [docked, setDocked] = useState(() => {
    try {
      const saved = localStorage.getItem(DETAILS_KEY);
      if (saved !== null) return saved === '1';
    } catch {
      /* storage unavailable */
    }
    return true;
  });
  const [floating, setFloating] = useState(false);
  useEffect(() => setFloating(false), [conversationId, narrow]);
  const set = (v: boolean) => {
    if (narrow) return setFloating(v);
    setDocked(v);
    try {
      localStorage.setItem(DETAILS_KEY, v ? '1' : '0');
    } catch {
      /* ignore */
    }
  };
  return [narrow ? floating : docked, set, narrow];
}

/** Where a conversation sits among the chats open side by side. */
export interface PaneInfo {
  split: boolean;
  focused: boolean;
  first: boolean;
  last: boolean;
}

const SOLO: PaneInfo = { split: false, focused: true, first: true, last: true };

export function ConversationView({ detail, pane = SOLO }: { detail: ConversationDetail; pane?: PaneInfo }) {
  const { state } = useStore();
  const { conversation } = detail;
  const agent = state.agents.find((a) => a.id === conversation.agentId) ?? null;
  const running = detail.runs.some((r) => r.status === 'running');
  const status = state.statuses[conversation.provider];
  const disabledReason =
    status && status.state !== 'ready' && status.state !== 'checking'
      ? `${PROVIDER_LABEL[conversation.provider]}: ${statusLabel(status)}. See Settings.`
      : null;
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [remember, setRemember] = useState<Message | null>(null);
  const [detailsOpen, setDetailsOpen, detailsFloat] = useDetailsOpen(conversation.id, pane.split);
  const [terminalOpen, setTerminalOpen] = useTerminalPanel(conversation.id);

  return (
    <div className="relative flex h-full min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <ConversationHeader detail={detail} agent={agent} pane={pane} onHandoff={() => setHandoffOpen(true)} detailsOpen={detailsOpen} detailsFloat={detailsFloat} onToggleDetails={() => setDetailsOpen(!detailsOpen)} terminalOpen={terminalOpen} onToggleTerminal={() => setTerminalOpen(!terminalOpen)} />
        <Transcript detail={detail} agent={agent} onRemember={setRemember} />
        {terminalOpen && <TerminalPanel conversationId={conversation.id} onClose={() => setTerminalOpen(false)} />}
        <Composer conversation={conversation} running={running} active={pane.focused} disabledReason={disabledReason} placeholder={`Message ${agent?.name ?? 'agent'}`} />
      </div>
      {detailsOpen && agent && <DetailsPanel agent={agent} conversation={conversation} floating={detailsFloat} titlebar={pane.last} onClose={() => setDetailsOpen(false)} />}
      {handoffOpen && <HandoffDialog detail={detail} onClose={() => setHandoffOpen(false)} />}
      {remember && agent && <RememberDialog message={remember} agent={agent} onClose={() => setRemember(null)} />}
    </div>
  );
}

function ConversationHeader({
  detail,
  agent,
  pane,
  onHandoff,
  detailsOpen,
  detailsFloat,
  onToggleDetails,
  terminalOpen,
  onToggleTerminal,
}: {
  detail: ConversationDetail;
  agent: Agent | null;
  pane: PaneInfo;
  onHandoff: () => void;
  detailsOpen: boolean;
  /** The details panel floats over the chat rather than taking the header's right edge. */
  detailsFloat: boolean;
  onToggleDetails: () => void;
  terminalOpen: boolean;
  onToggleTerminal: () => void;
}) {
  const { state, attempt, navigate, removeConversation, closePane, movePane } = useStore();
  const { conversation } = detail;
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState(conversation.title);
  useEffect(() => setTitle(conversation.title), [conversation.title]);

  const status = state.statuses[conversation.provider];
  // Connection state is only shown when it needs attention.
  const problem = status && status.state !== 'ready' && status.state !== 'checking' ? status : status?.rateLimited ? status : null;

  return (
    <header className="app-drag flex h-14 shrink-0 items-center gap-2 border-b border-line pl-5 pr-3 max-[640px]:gap-1 max-[640px]:pl-4 max-[640px]:pr-2">
      <MobileBack />
      {pane.split && (
        <Tooltip label="Drag to dock somewhere else" align="start">
          <button
            draggable
            onDragStart={(e) => dragChat(e, conversation.id)}
            aria-label="Drag to dock somewhere else"
            className="-ml-3 flex h-7 w-4 shrink-0 cursor-grab items-center justify-center rounded text-faint hover:text-ink active:cursor-grabbing"
          >
            <GripVertical size={14} />
          </button>
        </Tooltip>
      )}
      <Tooltip label={detailsOpen ? 'Hide details' : 'Show details'} align="start">
        <button onClick={onToggleDetails} className="flex shrink-0 items-center gap-2.5 rounded-xl py-1 pr-1.5">
          {agent && <Avatar spec={agent.avatar} size={28} working={Boolean(state.running[conversation.id])} reaction={state.reactions[conversation.id]} />}
          <span className="max-w-[240px] truncate text-[15px] font-semibold max-[640px]:max-w-[130px]">{agent?.name ?? 'Agent'}</span>
        </button>
      </Tooltip>
      <div className="min-w-0 flex-1">
        {editingTitle ? (
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => {
              setEditingTitle(false);
              if (title.trim() && title !== conversation.title) void attempt(() => api.updateConversation(conversation.id, { title }));
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') {
                setTitle(conversation.title);
                setEditingTitle(false);
              }
            }}
            aria-label="Conversation title"
            className="w-full max-w-md rounded-lg border border-line-strong bg-panel px-2 py-0.5 text-[13px] text-ink outline-none focus:border-accent"
          />
        ) : (
          <Tooltip label="Double-click to rename" align="start">
            <button onDoubleClick={() => setEditingTitle(true)} className="inline-block max-w-full truncate text-left align-middle text-[13px] text-faint max-[640px]:hidden">
              {conversation.title}
            </button>
          </Tooltip>
        )}
      </div>

      {problem && (
        <Tooltip label={problem.action}>
          <button
            onClick={() => navigate({ name: 'settings', section: 'providers' })}
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-warn-line bg-warn-bg px-2.5 text-[12px] text-warn-ink"
          >
            <AlertTriangle size={13} />
            {PROVIDER_LABEL[conversation.provider]}: {statusLabel(problem)}
          </button>
        </Tooltip>
      )}

      <IconButton label="Hand a task to another agent" onClick={onHandoff}>
        <Send size={16} strokeWidth={1.8} />
      </IconButton>
      {!IS_REMOTE && (
        <IconButton label={terminalOpen ? 'Hide terminal' : 'Show terminal'} tip={terminalOpen ? 'Hide terminal' : 'Terminal (shared with the agent)'} onClick={onToggleTerminal} className={cx(terminalOpen && 'bg-hover text-ink')} aria-pressed={terminalOpen}>
          <SquareTerminal size={16} strokeWidth={1.8} />
        </IconButton>
      )}
      <IconButton label={detailsOpen ? 'Hide details' : 'Show details'} onClick={onToggleDetails} className={cx(detailsOpen && 'bg-hover text-ink')} aria-pressed={detailsOpen}>
        <PanelRight size={17} strokeWidth={1.8} />
      </IconButton>
      <Popover
        align="right"
        width={210}
        trigger={({ toggle }) => (
          <IconButton label="More" onClick={toggle}>
            <MoreHorizontal size={17} />
          </IconButton>
        )}
      >
        {(close) => (
          <>
            <MenuItem
              onClick={() => {
                close();
                setEditingTitle(true);
              }}
            >
              Rename
            </MenuItem>
            {agent && (
              <MenuItem
                onClick={() => {
                  close();
                  navigate({ name: 'library', agentId: agent.id });
                }}
              >
                Edit agent
              </MenuItem>
            )}
            {pane.split && !pane.first && (
              <MenuItem
                onClick={() => {
                  close();
                  movePane(conversation.id, -1);
                }}
              >
                <ArrowLeftToLine size={14} /> Move left
              </MenuItem>
            )}
            {pane.split && !pane.last && (
              <MenuItem
                onClick={() => {
                  close();
                  movePane(conversation.id, 1);
                }}
              >
                <ArrowRightToLine size={14} /> Move right
              </MenuItem>
            )}
            <MenuItem
              onClick={async () => {
                close();
                if (!(await confirmDialog({ title: 'Delete this conversation?', message: 'Its history is removed from Nest. Provider-side session files are not touched.', confirmLabel: 'Delete', tone: 'danger' }))) return;
                await attempt(() => api.deleteConversation(conversation.id));
                removeConversation(conversation.id);
              }}
            >
              <Trash2 size={14} className="text-bad" />
              <span className="text-bad">Delete conversation</span>
            </MenuItem>
          </>
        )}
      </Popover>
      {pane.split && (
        <IconButton label="Close pane" onClick={() => closePane(conversation.id)}>
          <X size={16} strokeWidth={1.8} />
        </IconButton>
      )}
      {pane.last && (!detailsOpen || detailsFloat) && <div className="titlebar-spacer" />}
    </header>
  );
}

/** A centered timestamp goes above the first message and after any half-hour pause. */
const STAMP_GAP_MS = 30 * 60_000;

function Transcript({ detail, agent, onRemember }: { detail: ConversationDetail; agent: Agent | null; onRemember: (m: Message) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const runs = useMemo(() => new Map(detail.runs.map((r) => [r.id, r])), [detail.runs]);
  const lastContent = detail.messages[detail.messages.length - 1]?.content.length ?? 0;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.messages.length, lastContent, detail.activities.length, detail.approvals.length]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    setAtBottom(true);
  }, [detail.conversation.id]);

  return (
    <div className="relative min-h-0 flex-1">
      <BrowserViewport conversationId={detail.conversation.id} />
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
        }}
        className="scroll-quiet h-full overflow-y-auto"
      >
        <div className="chat-column px-5 pb-6 pt-2 max-[640px]:px-3">
          {detail.messages.length === 0 && <EmptyConversation agent={agent} conversation={detail.conversation} />}
          {detail.messages.map((m, i) => {
            const prev = detail.messages[i - 1];
            const stamp = !prev || m.createdAt - prev.createdAt > STAMP_GAP_MS;
            const sameSide = prev && !stamp && prev.kind === 'chat' && m.kind === 'chat' && prev.role === m.role;
            return (
              <Fragment key={m.id}>
                {stamp && <div className="pb-1 pt-5 text-center text-[12px] text-faint">{stampTime(m.createdAt)}</div>}
                <div className={sameSide ? 'mt-1.5' : 'mt-4'}>
                  <MessageView message={m} run={m.runId ? runs.get(m.runId) : undefined} detail={detail} onRemember={onRemember} />
                </div>
              </Fragment>
            );
          })}
        </div>
      </div>
      {!atBottom && (
        <button
          onClick={() => {
            const el = scroller.current;
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
          }}
          className="absolute bottom-3 left-1/2 inline-flex h-8 -translate-x-1/2 items-center gap-1 rounded-full border border-line bg-panel px-3 text-[12px] text-ink-2 shadow-float hover:bg-hover"
        >
          <ArrowDown size={13} /> Latest
        </button>
      )}
    </div>
  );
}

function EmptyConversation({ agent, conversation }: { agent: Agent | null; conversation: ConversationDetail['conversation'] }) {
  const { state } = useStore();
  const status = state.statuses[conversation.provider];
  const project = state.projects.find((p) => p.id === conversation.projectId);
  return (
    <div className="flex flex-col items-center pt-[14vh] text-center">
      {agent && <Avatar spec={agent.avatar} size={84} working={Boolean(state.running[conversation.id])} />}
      <div className="mt-4 font-display text-[20px] font-semibold tracking-[-0.01em]">{agent?.name ?? 'Agent'}</div>
      <div className="mt-1 max-w-md text-[13px] text-muted">
        {PROVIDER_LABEL[conversation.provider]}
        {conversation.workspace
          ? ` · works in ${conversation.workspace}`
          : project
            ? ` · works in the ${project.name} folder`
            : ' · works in your default folder'}
      </div>
      {agent?.instructions && (
        <div className="mt-4 max-w-md text-[13.5px] leading-relaxed text-ink-2">
          {agent.instructions.slice(0, 220)}
          {agent.instructions.length > 220 ? '…' : ''}
        </div>
      )}
      {status && status.state !== 'ready' && status.action && <div className="mt-5 max-w-md rounded-2xl border border-warn-line bg-warn-bg px-4 py-3 text-left text-[12.5px] text-warn-ink">{status.action}</div>}
    </div>
  );
}

function MessageView({ message, run, detail, onRemember }: { message: Message; run?: Run; detail: ConversationDetail; onRemember: (m: Message) => void }) {
  const { state, openConversation } = useStore();
  const [copied, setCopied] = useState(false);

  if (message.kind === 'notice') {
    return (
      <div className="my-2 flex items-center justify-center gap-1.5 text-[12px] text-muted">
        <CornerDownRight size={12} />
        <span>{message.content}</span>
        {message.linkConversationId && (
          <button onClick={() => void openConversation(message.linkConversationId!)} className="text-accent hover:underline">
            Open
          </button>
        )}
      </div>
    );
  }

  if (message.kind === 'handoff-result') {
    return (
      <div className="max-w-[88%] rounded-[20px] border border-line bg-panel px-4 py-3 max-[640px]:max-w-full">
        <div className="mb-2 flex items-center justify-between gap-3 text-[12px] text-muted">
          <span className="font-medium text-ink-2">{message.status === 'error' ? 'Handoff failed' : 'Handoff result'}</span>
          {message.linkConversationId && (
            <button onClick={() => void openConversation(message.linkConversationId!)} className="inline-flex items-center gap-1 text-accent hover:underline">
              Open conversation <ExternalLink size={11} />
            </button>
          )}
        </div>
        <Markdown text={message.content} />
      </div>
    );
  }

  if (message.role === 'user') {
    return (
      <div className="flex flex-col items-end gap-1.5">
        {message.attachments.map((a) => (
          <AttachmentCard key={a.path} attachment={a} />
        ))}
        {message.content && <div className="max-w-[78%] max-[640px]:max-w-[85%] whitespace-pre-wrap break-words rounded-[20px] bg-user px-4 py-2.5 text-[15px] leading-[1.5] text-on-user">{message.content}</div>}
      </div>
    );
  }

  // A message sent while the agent worked splits its run into several replies; each shows the steps taken during it.
  const replies = run ? detail.messages.filter((m) => m.runId === run.id && m.role === 'assistant') : [];
  const index = replies.findIndex((m) => m.id === message.id);
  const from = index > 0 ? message.createdAt : -Infinity;
  const until = index >= 0 && index < replies.length - 1 ? replies[index + 1].createdAt : Infinity;
  const activities = run ? detail.activities.filter((a) => a.runId === run.id && a.createdAt >= from && a.createdAt < until) : [];
  const approvals = run && until === Infinity ? detail.approvals.filter((a) => a.runId === run.id && a.status === 'pending') : [];
  const streaming = message.status === 'streaming';
  const usage = run?.usage;
  // Run facts live in a tooltip so the transcript stays as clean as a chat thread.
  const info = [
    run?.endedAt ? duration(run.endedAt - run.startedAt) : null,
    run ? `${PROVIDER_LABEL[run.provider]}${run.model ? ` · ${run.model}` : ''}` : null,
    state.settings.showUsage && usage && (usage.inputTokens || usage.outputTokens) ? `${compactNumber(usage.inputTokens ?? 0)} in · ${compactNumber(usage.outputTokens ?? 0)} out tokens` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="flex flex-col items-start">
      {activities.length > 0 && (
        <div className="w-full pl-1">
          <ActivityGroup activities={activities} running={streaming} defaultOpen={state.settings.expandActivity} />
        </div>
      )}
      {approvals.map((a) => (
        <div key={a.id} className="w-full max-w-[88%] max-[640px]:max-w-full">
          <ApprovalCard approval={a} />
        </div>
      ))}
      {message.content ? (
        <div className="group flex w-full items-end gap-1 max-[640px]:flex-col max-[640px]:items-start max-[640px]:gap-0">
          <div className="min-w-0 max-w-[88%] rounded-[20px] bg-bubble px-4 py-2.5 max-[640px]:max-w-full">
            <Markdown text={message.content} streaming={streaming} />
            {streaming && <span className="caret" aria-hidden="true" />}
          </div>
          {!streaming && (
            <div className="flex shrink-0 items-center pb-1 text-faint opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 max-[640px]:pb-0 max-[640px]:pl-1.5 max-[640px]:pt-0.5 max-[640px]:opacity-100">
              <Tooltip label={copied ? 'Copied' : 'Copy'}>
                <button
                  onClick={() => {
                    void navigator.clipboard.writeText(message.content);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1200);
                  }}
                  className="rounded-md p-1 hover:bg-hover hover:text-ink"
                  aria-label="Copy message"
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </Tooltip>
              <Tooltip label="Remember this">
                <button onClick={() => onRemember(message)} className="rounded-md p-1 hover:bg-hover hover:text-ink" aria-label="Remember this">
                  <BookmarkPlus size={14} />
                </button>
              </Tooltip>
              {info && (
                <Tooltip label={info} align="end">
                  <span className="rounded-md p-1 hover:text-ink" aria-label={info} tabIndex={0}>
                    <Info size={14} />
                  </span>
                </Tooltip>
              )}
            </div>
          )}
        </div>
      ) : streaming ? (
        <div className="flex items-center gap-2.5">
          <div className="rounded-[20px] bg-bubble px-4 py-2" aria-label="Working">
            <span className="typing" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </div>
          {approvals.length > 0 && <span className="text-[12.5px] text-muted">Waiting for your approval</span>}
        </div>
      ) : null}
      {message.status === 'error' && message.error && (
        <div className="mt-1.5 max-w-[88%] whitespace-pre-wrap rounded-2xl border border-bad-line max-[640px]:max-w-full bg-bad-bg px-3.5 py-2.5 text-[12.5px] text-bad-ink">{message.error}</div>
      )}
      {message.status === 'interrupted' && <div className="mt-1 px-1 text-[12px] text-muted">{message.error ?? 'Stopped.'}</div>}
    </div>
  );
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|heic)$/i;

/** File card shown with a sent message, like a chat app's attachment bubble. */
function AttachmentCard({ attachment }: { attachment: Attachment }) {
  const ext = attachment.name.includes('.') ? attachment.name.split('.').pop()!.toUpperCase() : '';
  const isPdf = ext === 'PDF';
  const isImage = attachment.isImage || IMAGE_EXT.test(attachment.name);
  return (
    <Tooltip label={attachment.path} align="start">
      <div className="flex w-[264px] max-w-[78%] items-center gap-3 rounded-2xl border border-line bg-panel px-3 py-2.5">
        <span
          className={cx(
            'flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-xl',
            isPdf ? 'bg-bad-bg text-bad' : isImage ? 'bg-accent/10 text-accent' : 'bg-hover text-muted',
          )}
        >
          {isImage ? <ImageIcon size={17} /> : <FileText size={17} />}
          {isPdf && <span className="text-[8.5px] font-bold leading-none">PDF</span>}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-medium text-ink">{attachment.name}</span>
          <span className="block text-[12px] text-muted">{isPdf ? 'PDF document' : isImage ? 'Image' : ext ? `${ext} file` : 'File'}</span>
        </span>
      </div>
    </Tooltip>
  );
}

function RememberDialog({ message, agent, onClose }: { message: Message; agent: Agent; onClose: () => void }) {
  const { attempt, toast } = useStore();
  const [content, setContent] = useState(message.content.slice(0, 2000));
  const [scope, setScope] = useState<'agent' | 'shared'>('agent');
  return (
    <Modal
      title="Remember this"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!content.trim()}
            onClick={async () => {
              const note = await attempt(() => api.createMemory(scope, scope === 'agent' ? agent.id : null, content, message.id));
              if (note) {
                toast('Saved to memory. It will be included on the next turn.', 'info');
                onClose();
              }
            }}
          >
            Save note
          </Button>
        </>
      }
    >
      <p className="mb-3 text-[12.5px] text-muted">Edit this down to the fact worth keeping. Notes are plain text, stored locally, and sent to the agent only when they change.</p>
      <div className="mb-3">
        <Segmented
          value={scope}
          onChange={setScope}
          options={[
            { value: 'agent', label: `Only ${agent.name}` },
            { value: 'shared', label: 'All agents (shared)' },
          ]}
        />
      </div>
      <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={8} className={cx(inputClass, 'resize-y leading-relaxed')} />
    </Modal>
  );
}

function HandoffDialog({ detail, onClose }: { detail: ConversationDetail; onClose: () => void }) {
  const { state, attempt, toast } = useStore();
  const others = state.agents.filter((a) => a.id !== detail.conversation.agentId);
  const [targetId, setTargetId] = useState(others[0]?.id ?? state.agents[0]?.id ?? '');
  const [task, setTask] = useState('');
  const lastAssistant = [...detail.messages].reverse().find((m) => m.role === 'assistant' && m.content.trim());
  const recent = detail.messages
    .filter((m) => m.kind === 'chat' && m.content.trim())
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.trim().slice(0, 1200)}`)
    .join('\n\n');
  const [mode, setMode] = useState<'none' | 'last' | 'recent'>(lastAssistant ? 'last' : 'none');
  const [context, setContext] = useState(lastAssistant?.content ?? '');
  const [busy, setBusy] = useState(false);

  const pick = (m: 'none' | 'last' | 'recent') => {
    setMode(m);
    setContext(m === 'none' ? '' : m === 'last' ? lastAssistant?.content ?? '' : recent);
  };

  return (
    <Modal
      title="Hand off to another agent"
      onClose={onClose}
      width={600}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!task.trim() || !targetId || busy}
            onClick={async () => {
              setBusy(true);
              const h = await attempt(() => api.startHandoff({ sourceConversationId: detail.conversation.id, targetAgentId: targetId, task, context }));
              setBusy(false);
              if (h) {
                toast('Handoff started. The result will appear here and in your Inbox.', 'info');
                onClose();
              }
            }}
          >
            {busy ? 'Starting…' : 'Start handoff'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Agent">
          <div className="flex flex-wrap gap-1.5">
            {state.agents.map((a) => (
              <button
                key={a.id}
                onClick={() => setTargetId(a.id)}
                className={cx(
                  'inline-flex items-center gap-1.5 rounded-full border py-1 pl-1 pr-2.5 text-[12.5px]',
                  targetId === a.id ? 'border-accent bg-accent/10 font-medium text-ink' : 'border-line bg-panel text-ink-2 hover:bg-hover',
                )}
              >
                <Avatar spec={a.avatar} size={20} />
                {a.name}
                <span className="text-faint">· {PROVIDER_LABEL[a.provider]}</span>
              </button>
            ))}
          </div>
        </Field>
        <Field label="Task">
          <textarea value={task} onChange={(e) => setTask(e.target.value)} rows={3} placeholder="What should this agent do?" className={cx(inputClass, 'resize-y')} autoFocus />
        </Field>
        <Field label="Context to share" hint="Only this text is sent. Edit it freely.">
          <div className="mb-2">
            <Segmented
              value={mode}
              onChange={pick}
              options={[
                { value: 'none', label: 'None' },
                { value: 'last', label: 'Last response' },
                { value: 'recent', label: 'Recent messages' },
              ]}
            />
          </div>
          <textarea value={context} onChange={(e) => setContext(e.target.value)} rows={7} className={cx(inputClass, 'resize-y font-mono text-[12px]')} />
        </Field>
      </div>
    </Modal>
  );
}
