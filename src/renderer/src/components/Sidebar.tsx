import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Brain, ChevronRight, FolderMinus, FolderPlus, Inbox, Pin, PinOff, Plus, Search, Settings, Trash2, UserPlus, X } from 'lucide-react';
import { RELEASE_CHANNEL, versionLabel } from '@shared/build';
import type { Agent, Conversation, Project } from '@shared/types';
import { IS_REMOTE, api } from '../api';
import { useStore, type Reaction } from '../store';
import { listTime } from '../format';
import { Avatar } from './Avatar';
import { NewProjectDialog, ProjectMark, dragAgent, dragChat, dragged, moveChat, useProjectDrop, type Dragged } from './Projects';
import { IconButton, MenuItem, MenuLabel, Popover, Tooltip, cx } from './ui';
import { UpdateCard } from './Update';
import { confirmDialog } from './confirm';

const BETA = RELEASE_CHANNEL === 'beta';

export function Sidebar() {
  const { state, navigate, openConversation, startConversation } = useStore();
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<RowMenuTarget | null>(null);
  /** Open the new-project dialog; a string is a chat that moves into it. */
  const [newProject, setNewProject] = useState<true | string | null>(null);
  /** The chat or agent being dragged, so the "no project" drop zone can appear. */
  const [dragging, setDragging] = useState<Dragged | null>(null);
  const agentsById = useMemo(() => new Map(state.agents.map((a) => [a.id, a])), [state.agents]);
  const pinned = state.agents.filter((a) => a.pinned).slice(0, 8);
  const activeId = state.view.name === 'conversation' ? state.view.id : null;
  const inboxCount = state.inbox.filter((i) => (i.kind === 'approval' ? !i.resolved : !i.readAt)).length;

  // A dot marks conversations with an unresolved approval or an unread handoff/failure.
  const needsAttention = useMemo(
    () => new Set(state.inbox.filter((i) => i.conversationId && (i.kind === 'approval' ? !i.resolved : !i.readAt)).map((i) => i.conversationId as string)),
    [state.inbox],
  );

  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      q
        ? state.conversations.filter((c) => [agentsById.get(c.agentId)?.name, c.title, c.preview].some((s) => s?.toLowerCase().includes(q)))
        : state.conversations,
    [q, state.conversations, agentsById],
  );

  // Conversations whose agent belongs to a project are collected in that project's folder.
  // Every project shows, even before its agents have chats; while searching, only matches do.
  const { groups, loose } = useMemo(() => {
    const byProject = new Map<string, Conversation[]>();
    const loose: Conversation[] = [];
    for (const c of visible) {
      const p = c.projectId;
      if (p) byProject.set(p, [...(byProject.get(p) ?? []), c]);
      else loose.push(c);
    }
    const groups = state.projects
      .filter((p) => !q || byProject.has(p.id) || p.name.toLowerCase().includes(q))
      .map((project) => {
        // Agents in the project, plus any agent with a chat here (e.g. a chief of staff working across projects).
        const guests = new Set(state.conversations.filter((c) => c.projectId === project.id).map((c) => c.agentId));
        return { project, members: state.agents.filter((a) => a.projectId === project.id || guests.has(a.id)), conversations: byProject.get(project.id) ?? [] };
      });
    return { groups, loose };
  }, [visible, state.projects, state.agents, state.conversations, q]);
  const draggingFromProject = Boolean(
    dragging && (dragging.kind === 'chat' ? state.conversations.find((c) => c.id === dragging.id)?.projectId : agentsById.get(dragging.id)?.projectId),
  );

  // Pinned agents open their latest chat outside any project, like a new chat would; project chats live in their folders.
  const openAgent = (agent: Agent) => {
    const latest = state.conversations.find((c) => c.agentId === agent.id && !c.projectId);
    if (latest) void openConversation(latest.id);
    else void startConversation(agent.id);
  };

  // Agents with any chat in progress look busy wherever they appear.
  const busyAgents = useMemo(() => new Set(state.conversations.filter((c) => state.running[c.id]).map((c) => c.agentId)), [state.conversations, state.running]);
  // An agent's latest reaction across its chats, for the pinned row.
  const agentReaction = (agentId: string): Reaction | undefined => {
    let latest: Reaction | undefined;
    for (const c of state.conversations) {
      const r = c.agentId === agentId ? state.reactions[c.id] : undefined;
      if (r && (!latest || r.at > latest.at)) latest = r;
    }
    return latest;
  };

  const onMenu = (conversation: Conversation, e: React.MouseEvent) => {
    e.preventDefault();
    // The ContextMenu key and Shift+F10 report no pointer position: anchor to the row instead.
    const r = e.currentTarget.getBoundingClientRect();
    const fromKeyboard = e.clientX === 0 && e.clientY === 0;
    setMenu({ conversation, x: fromKeyboard ? r.left + 24 : e.clientX, y: fromKeyboard ? r.bottom : e.clientY });
  };
  const rowProps = { agentsById, activeId, needsAttention, running: state.running, reactions: state.reactions, onOpen: openConversation, onMenu };

  return (
    <aside className="flex h-full w-[288px] shrink-0 flex-col border-r border-line bg-sidebar max-[900px]:w-[248px] max-[640px]:w-full max-[640px]:border-r-0 max-[640px]:pb-[env(safe-area-inset-bottom)]">
      <div className={cx('app-drag flex h-14 shrink-0 items-center justify-between pl-5 pr-3', BETA && 'galaxy-banner')}>
        <span className="flex items-center gap-2">
          <span className="font-display text-[17px] font-semibold tracking-[-0.01em]">Nest</span>
          {BETA && <span className="galaxy-chip">Beta</span>}
        </span>
        <Popover
          align="right"
          width={240}
          trigger={({ toggle }) => (
            <IconButton label="New chat" onClick={toggle} className={BETA ? 'text-white/85 hover:bg-white/12! hover:text-white!' : 'text-ink-2'}>
              <Plus size={19} strokeWidth={1.8} />
            </IconButton>
          )}
        >
          {(close) => (
            <>
              <MenuLabel>New chat with</MenuLabel>
              <div className="scroll-quiet max-h-72 overflow-y-auto">
                {state.agents.map((a) => (
                  <MenuItem
                    key={a.id}
                    onClick={() => {
                      close();
                      void startConversation(a.id);
                    }}
                  >
                    <Avatar spec={a.avatar} size={22} />
                    <span className="truncate">{a.name}</span>
                  </MenuItem>
                ))}
              </div>
              <div className="my-1 border-t border-line" />
              <MenuItem
                onClick={() => {
                  close();
                  navigate({ name: 'library', agentId: 'new' });
                }}
              >
                <UserPlus size={15} className="text-muted" />
                New agent…
              </MenuItem>
              <MenuItem
                onClick={() => {
                  close();
                  setNewProject(true);
                }}
              >
                <FolderPlus size={15} className="text-muted" />
                New project…
              </MenuItem>
            </>
          )}
        </Popover>
      </div>

      <div className="px-3 pb-2">
        <label className="flex h-9 items-center gap-2 rounded-[10px] bg-active/70 px-2.5 text-muted transition-colors focus-within:bg-active">
          <Search size={15} className="shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
            placeholder="Search"
            aria-label="Search conversations"
            className="min-w-0 flex-1 bg-transparent text-[13.5px] text-ink outline-none placeholder:text-muted"
          />
          {query && (
            <button onClick={() => setQuery('')} aria-label="Clear search" className="rounded p-0.5 hover:text-ink">
              <X size={13} />
            </button>
          )}
        </label>
      </div>

      {!q && pinned.length > 0 && (
        <div className="scroll-quiet flex gap-0.5 overflow-x-auto px-2 pb-2">
          {pinned.map((a) => (
            <Tooltip key={a.id} label={`Open ${a.name}`} side="bottom">
              <button
                onClick={() => openAgent(a)}
                draggable
                onDragStart={(e) => {
                  dragAgent(e, a.id);
                  setDragging({ kind: 'agent', id: a.id });
                }}
                onDragEnd={() => setDragging(null)}
                className="flex w-[72px] shrink-0 flex-col items-center gap-1 rounded-xl px-1 py-1.5 transition-colors hover:bg-hover">
                <Avatar spec={a.avatar} size={40} working={busyAgents.has(a.id)} reaction={agentReaction(a.id)} agentId={a.id} />
                <span className="w-full truncate text-center text-[11.5px] text-ink-2">{a.name}</span>
              </button>
            </Tooltip>
          ))}
        </div>
      )}

      <nav
        className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-2 pb-2"
        aria-label="Conversations"
        onDragStart={(e) => setDragging(dragged(e))}
        onDragEnd={() => setDragging(null)}
        onDrop={() => setDragging(null)}
      >
        {groups.map(({ project, members, conversations }) => (
          <ProjectFolder
            key={project.id}
            project={project}
            members={members}
            conversations={conversations}
            forceOpen={Boolean(q)}
            viewing={state.view.name === 'project' && state.view.id === project.id}
            onView={() => navigate({ name: 'project', id: project.id })}
            {...rowProps}
          />
        ))}
        {draggingFromProject && <LeaveProjectZone />}
        {loose.map((c) => (
          <ConversationRow key={c.id} conversation={c} agent={agentsById.get(c.agentId)} active={c.id === activeId} attention={needsAttention.has(c.id)} working={Boolean(state.running[c.id])} reaction={state.reactions[c.id]} onOpen={openConversation} onMenu={onMenu} />
        ))}
        {state.ready && visible.length === 0 && groups.length === 0 && (
          <div className="px-4 py-10 text-center text-[13px] text-muted">{q ? 'No matches' : 'No chats yet'}</div>
        )}
      </nav>
      {menu && (
        <RowMenu
          target={menu}
          agent={agentsById.get(menu.conversation.agentId)}
          active={menu.conversation.id === activeId}
          onClose={() => setMenu(null)}
          onNewProject={(conversationId) => setNewProject(conversationId)}
        />
      )}
      {newProject && <NewProjectDialog onClose={() => setNewProject(null)} withChat={typeof newProject === 'string' ? newProject : undefined} />}

      {!IS_REMOTE && <UpdateCard />}
      <div className="border-t border-line p-2">
        <NavItem icon={<Inbox size={16} />} label="Inbox" active={state.view.name === 'inbox'} onClick={() => navigate({ name: 'inbox' })} badge={inboxCount} />
        <NavItem icon={<Bot size={16} />} label="Agents" active={state.view.name === 'library'} onClick={() => navigate({ name: 'library' })} />
        <NavItem icon={<Brain size={16} />} label="Memory" active={state.view.name === 'memory'} onClick={() => navigate({ name: 'memory' })} />
        <NavItem icon={<Settings size={16} />} label="Settings" active={state.view.name === 'settings'} onClick={() => navigate({ name: 'settings' })} />
        <Tooltip label="About this build" side="top">
          <button
            onClick={() => navigate({ name: 'settings', section: 'about' })}
            className="mt-1 block w-full px-3 text-left text-[11px] tabular-nums text-faint transition-colors hover:text-muted"
          >
            {versionLabel()}
            {BETA && ' · beta'}
          </button>
        </Tooltip>
      </div>
    </aside>
  );
}

/** A project's folder: its chats, a drop target for chats and agents, and the way into the project view. */
function ProjectFolder({
  project,
  members,
  conversations,
  agentsById,
  activeId,
  needsAttention,
  running,
  reactions,
  forceOpen,
  viewing,
  onView,
  onOpen,
  onMenu,
}: {
  project: Project;
  members: Agent[];
  conversations: Conversation[];
  agentsById: Map<string, Agent>;
  activeId: string | null;
  needsAttention: Set<string>;
  running: Record<string, true>;
  reactions: Record<string, Reaction>;
  forceOpen: boolean;
  viewing: boolean;
  onView: () => void;
  onOpen: (id: string) => void;
  onMenu: (c: Conversation, e: React.MouseEvent) => void;
}) {
  const containsActive = conversations.some((c) => c.id === activeId);
  const [open, setOpen] = useState(containsActive);
  const expanded = open || containsActive || forceOpen;
  const { over, props: dropProps } = useProjectDrop(project.id);
  const attention = conversations.some((c) => needsAttention.has(c.id));
  const busy = conversations.filter((c) => running[c.id]);
  return (
    <div className={cx('mb-0.5 rounded-2xl transition-colors', over && 'bg-hover ring-2 ring-accent/60')} {...dropProps}>
      <div className={cx('group/folder flex w-full items-center gap-1 rounded-2xl pr-1 transition-colors', viewing ? 'bg-active' : 'hover:bg-hover')}>
        <button
          onClick={() => {
            onView();
            setOpen(true);
          }}
          aria-current={viewing ? 'page' : undefined}
          className="flex min-w-0 flex-1 items-center gap-3 py-2 pl-2.5 text-left"
        >
          <span className="flex h-11 w-11 shrink-0 items-center justify-center">
            <ProjectMark members={members.map((a) => a.avatar)} ids={members.map((a) => a.id)} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1 text-[14.5px] font-semibold text-ink">
              <span className="truncate">{project.name}</span>
              <span className="ml-auto text-[12px] font-normal text-faint">{conversations.length || ''}</span>
            </span>
            <span className="flex items-center gap-2">
              <span className="truncate text-[13px] text-muted">{over ? 'Drop to move it into this project' : members.length ? members.map((a) => a.name).join(', ') : 'Drag chats or agents here'}</span>
              {!expanded && busy.length > 0 && <TypingDots className="ml-auto" />}
              {attention && !expanded && <span className={cx('dot-pop h-2 w-2 shrink-0 rounded-full bg-accent', !busy.length && 'ml-auto')} aria-label="Needs attention" />}
            </span>
          </span>
        </button>
        {conversations.length > 0 && (
          <IconButton label={expanded ? 'Collapse' : 'Expand'} onClick={() => setOpen((o) => !o)} aria-expanded={expanded} className="h-7 w-7 shrink-0 text-faint">
            <ChevronRight size={14} className={cx('transition-transform', expanded && 'rotate-90')} />
          </IconButton>
        )}
      </div>
      {expanded && conversations.length > 0 && (
        <div className="fade-in ml-[34px] border-l border-line pl-1.5">
          {conversations.map((c) => (
            <ConversationRow
              key={c.id}
              conversation={c}
              agent={agentsById.get(c.agentId)}
              active={c.id === activeId}
              attention={needsAttention.has(c.id)}
              working={Boolean(running[c.id])}
              reaction={reactions[c.id]}
              onOpen={onOpen}
              onMenu={onMenu}
              compact
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Shown while a chat or agent from a project is dragged: drop it here to take it out. */
function LeaveProjectZone() {
  const { over, props } = useProjectDrop(null);
  return (
    <div
      {...props}
      className={cx(
        'fade-in mb-1 flex h-11 items-center justify-center gap-2 rounded-2xl border border-dashed text-[13px] transition-colors',
        over ? 'border-accent bg-hover text-ink' : 'border-line-strong text-muted',
      )}
    >
      <FolderMinus size={15} /> Drop here to take it out of its project
    </div>
  );
}

function ConversationRow({
  conversation,
  agent,
  active,
  attention,
  working,
  reaction,
  onOpen,
  onMenu,
  compact,
}: {
  conversation: Conversation;
  agent?: Agent;
  active: boolean;
  attention: boolean;
  working: boolean;
  reaction?: Reaction;
  onOpen: (id: string) => void;
  onMenu: (c: Conversation, e: React.MouseEvent) => void;
  compact?: boolean;
}) {
  return (
    <Tooltip label={conversation.title} side="right" align="start">
      <button
        onClick={() => onOpen(conversation.id)}
        onContextMenu={(e) => onMenu(conversation, e)}
        draggable
        onDragStart={(e) => dragChat(e, conversation.id)}
        aria-current={active ? 'page' : undefined}
        className={cx('mb-0.5 flex w-full items-center gap-3 rounded-2xl text-left transition-colors', compact ? 'px-2 py-1.5' : 'px-2.5 py-2.5', active ? 'bg-active' : 'hover:bg-hover')}
      >
        {agent && <Avatar spec={agent.avatar} size={compact ? 28 : 44} working={working} reaction={reaction} agentId={agent.id} className="shrink-0" />}
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className={cx('min-w-0 flex-1 truncate text-ink', compact ? 'text-[13.5px] font-medium' : 'text-[14.5px] font-semibold')}>{compact ? conversation.title : agent ? agent.name : <span className="text-muted">Removed agent</span>}</span>
            <span className="shrink-0 text-[12px] text-faint">{listTime(conversation.updatedAt)}</span>
          </span>
          <span className="flex items-center gap-2">
            <span className={cx('min-w-0 flex-1 truncate text-muted', compact ? 'text-[12.5px]' : 'text-[13px]')}>{conversation.preview || 'No messages yet'}</span>
            {working && <TypingDots />}
            {attention && <span className="dot-pop h-2 w-2 shrink-0 rounded-full bg-accent" aria-label="Needs attention" />}
          </span>
        </span>
      </button>
    </Tooltip>
  );
}

function TypingDots({ className }: { className?: string }) {
  return (
    <span className={cx('typing typing-sm shrink-0', className)} role="status" aria-label="Working">
      <span />
      <span />
      <span />
    </span>
  );
}

type RowMenuTarget = { conversation: Conversation; x: number; y: number };

/** Right-click menu for a sidebar row. Closes on outside click, Escape, scroll or resize. */
function RowMenu({
  target,
  agent,
  active,
  onClose,
  onNewProject,
}: {
  target: RowMenuTarget;
  agent?: Agent;
  active: boolean;
  onClose: () => void;
  onNewProject: (conversationId: string) => void;
}) {
  const { state, navigate, attempt, removeConversation, reloadAgents, toast } = useStore();
  const move = (projectId: string | null) => {
    onClose();
    void moveChat(target.conversation.id, projectId, { state, attempt, toast });
  };
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector('button')?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onClose);
    document.addEventListener('keydown', onKey);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    document.addEventListener('scroll', onClose, true);
    return () => {
      document.removeEventListener('mousedown', onClose);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
      document.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);

  const remove = async () => {
    onClose();
    if (!(await confirmDialog({ title: `Delete “${target.conversation.title}”?`, message: 'Its history is removed from Nest. Provider-side session files are not touched.', confirmLabel: 'Delete', tone: 'danger' }))) return;
    const ok = await attempt(async () => {
      await api.deleteConversation(target.conversation.id);
      return true;
    });
    if (!ok) return;
    removeConversation(target.conversation.id);
    if (active) navigate({ name: 'home' });
  };

  const togglePin = async () => {
    onClose();
    if (!agent) return;
    const { id, createdAt: _c, updatedAt: _u, ...draft } = agent;
    const ok = await attempt(() => api.updateAgent(id, { ...draft, pinned: !agent.pinned }));
    if (ok) await reloadAgents();
  };

  const width = 220;
  const chatProject = target.conversation.projectId;
  const others = state.projects.filter((p) => p.id !== chatProject);
  // Rough height so the menu stays on screen: pin + label + one row per project + extras + delete.
  const height = (agent ? 90 : 56) + (others.length + (chatProject ? 2 : 1)) * 34 + 30;
  return (
    <div
      ref={ref}
      role="menu"
      onMouseDown={(e) => e.stopPropagation()}
      className="fixed z-50 rounded-2xl border border-line bg-panel p-1.5 shadow-pop"
      style={{ width, left: Math.min(target.x, window.innerWidth - width - 8), top: Math.max(8, Math.min(target.y, window.innerHeight - height)) }}
    >
      {agent && (
        <>
          <MenuItem onClick={() => void togglePin()}>
            {agent.pinned ? <PinOff size={14} className="text-muted" /> : <Pin size={14} className="text-muted" />}
            <span className="truncate">{agent.pinned ? 'Unpin from sidebar' : 'Pin to sidebar'}</span>
          </MenuItem>
          <div className="my-1 border-t border-line" />
        </>
      )}
      <MenuLabel>Move chat to</MenuLabel>
      <div className="scroll-quiet max-h-56 overflow-y-auto">
        {others.map((p) => (
          <MenuItem key={p.id} onClick={() => move(p.id)}>
            <span className="truncate">{p.name}</span>
          </MenuItem>
        ))}
      </div>
      <MenuItem
        onClick={() => {
          onClose();
          onNewProject(target.conversation.id);
        }}
      >
        <FolderPlus size={14} className="text-muted" />
        New project…
      </MenuItem>
      {chatProject && (
        <MenuItem onClick={() => move(null)}>
          <FolderMinus size={14} className="text-muted" />
          No project
        </MenuItem>
      )}
      <div className="my-1 border-t border-line" />
      <MenuItem onClick={() => void remove()}>
        <Trash2 size={14} className="text-bad" />
        <span className="text-bad">Delete chat</span>
      </MenuItem>
    </div>
  );
}

function NavItem({ icon, label, active, onClick, badge }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void; badge?: number }) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cx('flex h-9 w-full items-center gap-3 rounded-[10px] px-3 text-[13.5px] transition-colors', active ? 'bg-active font-medium text-ink' : 'text-ink-2 hover:bg-hover hover:text-ink')}
    >
      <span className={active ? 'text-ink' : 'text-muted'}>{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      {badge ? <span className="min-w-[20px] rounded-full bg-accent px-1.5 text-center text-[11px] font-semibold leading-[20px] text-white">{badge}</span> : null}
    </button>
  );
}
