import { useEffect, useState, type ReactNode } from 'react';
import { CirclePause, Clock3, FolderOpen, MessageSquarePlus, PanelRightClose, Pause, Pencil, Play, Plus, Settings2 } from 'lucide-react';
import { PROVIDER_LABEL, type Agent, type Conversation, type MemoryNote, type Schedule, type ScheduleCadence } from '@shared/types';
import { describeCadence } from '@shared/schedule';
import { api } from '../api';
import { useStore } from '../store';
import { folderName, listTime } from '../format';
import { Avatar } from './Avatar';
import { RoutineEditor, useSchedules } from './Routines';
import { Button, IconButton, SectionLabel, Tooltip, cx } from './ui';

/** "Weekdays at 08:30" → "Weekdays at 8:30 AM" in the user's locale. */
function friendlyCadence(c: ScheduleCadence): string {
  return describeCadence(c).replace(/\b(\d{1,2}):(\d{2})\b/, (_, h: string, m: string) =>
    new Date(2000, 0, 1, Number(h), Number(m)).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
  );
}

/** Right-hand panel for the open conversation's agent: folder, routines, instructions, memory, other chats. */
/** floating: drawn over the chat instead of beside it (split panes; narrow windows do this through CSS). titlebar: reserve room for the window controls. */
export function DetailsPanel({ agent, conversation, floating, titlebar = true, onClose }: { agent: Agent; conversation: Conversation; floating?: boolean; titlebar?: boolean; onClose: () => void }) {
  const { state, navigate, openConversation, startConversation, attempt } = useStore();
  const [defaultFolder, setDefaultFolder] = useState<string | null>(null);
  const [notes, setNotes] = useState<MemoryNote[]>([]);

  useEffect(() => {
    void api.getAppInfo().then((i) => setDefaultFolder(i.effectiveDefaultWorkspace)).catch(() => {});
  }, []);
  useEffect(() => {
    let alive = true;
    void api
      .listMemory()
      .then((all) => alive && setNotes(all.filter((n) => n.enabled && (n.agentId === agent.id || n.scope === 'shared' || (n.scope === 'project' && n.projectId === conversation.projectId)))))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [agent.id, conversation.projectId, conversation.updatedAt]);

  const project = state.projects.find((p) => p.id === conversation.projectId);
  const folder = conversation.workspace ?? project?.workspace ?? defaultFolder;
  const chats = state.conversations.filter((c) => c.agentId === agent.id);
  const ownNotes = notes.filter((n) => n.agentId === agent.id);
  const sharedCount = notes.length - ownNotes.length;
  const editAgent = () => navigate({ name: 'library', agentId: agent.id });

  return (
    <aside
      className={cx(
        'panel-in flex h-full w-[340px] max-w-full shrink-0 flex-col border-l border-line bg-canvas max-[1120px]:absolute max-[1120px]:inset-y-0 max-[1120px]:right-0 max-[1120px]:z-30 max-[1120px]:shadow-pop max-[640px]:w-full',
        floating && 'absolute inset-y-0 right-0 z-30 shadow-pop',
      )}
      aria-label={`${agent.name} details`}
    >
      <div className="app-drag flex h-14 shrink-0 items-center gap-1 border-b border-line pl-5 pr-3">
        <span className="flex-1 text-[14px] font-semibold">Details</span>
        <IconButton label="Edit agent" onClick={editAgent}>
          <Settings2 size={16} strokeWidth={1.8} />
        </IconButton>
        <IconButton label="Close details" onClick={onClose}>
          <PanelRightClose size={17} strokeWidth={1.8} />
        </IconButton>
        {titlebar && <div className="titlebar-spacer" />}
      </div>

      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-5 pb-10">
        <div className="flex flex-col items-center pt-7 text-center">
          <Avatar spec={agent.avatar} size={88} working={Boolean(state.running[conversation.id])} reaction={state.reactions[conversation.id]} />
          <div className="mt-3 font-display text-[19px] font-semibold tracking-[-0.01em]">{agent.name}</div>
          <div className="mt-0.5 text-[12.5px] text-muted">
            {PROVIDER_LABEL[conversation.provider]}
            {conversation.model ? ` · ${conversation.model}` : ''}
          </div>
          <div className="mt-4 flex gap-2">
            <Button size="sm" onClick={() => void startConversation(agent.id)}>
              <MessageSquarePlus size={14} /> New chat
            </Button>
            <Button size="sm" onClick={editAgent}>
              <Pencil size={13} /> Edit
            </Button>
          </div>
        </div>

        <section className="mt-7">
          {/* No tooltip here: the card shows the path and swaps in "Open in Explorer" on hover. */}
          <button
            onClick={() => folder && void attempt(() => api.openFolder(folder))}
            disabled={!folder}
            className="group flex h-[118px] w-full flex-col items-center justify-center gap-1.5 rounded-2xl border border-line bg-sunken px-4 transition-colors hover:border-line-strong"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-panel text-ink-2 shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
              <FolderOpen size={19} strokeWidth={1.8} />
            </span>
            <span className="max-w-full truncate text-[13.5px] font-medium text-ink">{folderName(folder) ?? 'Working folder'}</span>
            <span className="max-w-full truncate font-mono text-[11px] text-faint group-hover:hidden">{folder ?? '…'}</span>
            <span className="hidden text-[11.5px] text-accent group-hover:block">Open in Explorer</span>
          </button>
          <div className="mt-2 text-center text-[13px] text-muted">{!conversation.workspace && project?.workspace ? `${project.name} project folder` : `${agent.name}’s folder`}</div>
        </section>

        <Routines agent={agent} />

        <Section
          title="Instructions"
          action={
            <button onClick={editAgent} className="text-[12.5px] text-accent hover:underline">
              Edit
            </button>
          }
        >
          {agent.instructions.trim() ? <Instructions text={agent.instructions} /> : <p className="text-[13px] text-muted">No instructions yet. Add some so {agent.name} knows its role.</p>}
        </Section>

        <Section
          title="Memory"
          action={
            <button onClick={() => navigate({ name: 'memory' })} className="text-[12.5px] text-accent hover:underline">
              Manage
            </button>
          }
        >
          {ownNotes.length === 0 ? (
            <p className="text-[13px] text-muted">Nothing remembered yet. Use “Remember this” under a reply.</p>
          ) : (
            <ul className="space-y-1.5">
              {ownNotes.slice(0, 4).map((n) => (
                <li key={n.id} className="line-clamp-2 rounded-xl bg-sunken px-3 py-2 text-[13px] leading-snug text-ink-2">
                  {n.content}
                </li>
              ))}
            </ul>
          )}
          {(ownNotes.length > 4 || sharedCount > 0) && (
            <p className="mt-2 text-[12px] text-faint">
              {ownNotes.length > 4 ? `${ownNotes.length - 4} more` : ''}
              {ownNotes.length > 4 && sharedCount > 0 ? ' · ' : ''}
              {sharedCount > 0 ? `${sharedCount} shared or project note${sharedCount === 1 ? '' : 's'} too` : ''}
            </p>
          )}
        </Section>

        <Section title={`Chats with ${agent.name}`}>
          <ul>
            {chats.slice(0, 8).map((c) => (
              <li key={c.id}>
                <button
                  onClick={() => void openConversation(c.id)}
                  aria-current={c.id === conversation.id ? 'page' : undefined}
                  className={cx('flex w-full items-baseline gap-3 rounded-xl px-2.5 py-2 text-left transition-colors', c.id === conversation.id ? 'bg-active' : 'hover:bg-hover')}
                >
                  <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{c.title}</span>
                  <span className="shrink-0 text-[12px] text-faint">{listTime(c.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
          {chats.length > 8 && <p className="mt-1 px-2.5 text-[12px] text-faint">{chats.length - 8} older chats are in the sidebar.</p>}
        </Section>
      </div>
    </aside>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-8">
      <SectionLabel action={action}>{title}</SectionLabel>
      {children}
    </section>
  );
}

function Instructions({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 280 || text.split('\n').length > 5;
  return (
    <div>
      <p className={cx('whitespace-pre-wrap text-[13px] leading-relaxed text-ink-2', !open && 'line-clamp-5')}>{text}</p>
      {long && (
        <button onClick={() => setOpen((o) => !o)} className="mt-1 text-[12.5px] text-muted hover:text-ink">
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

/** Routines for this agent, drawn as a plain list: a green clock when active, a pause mark when not. */
function Routines({ agent }: { agent: Agent }) {
  const { state, attempt, openConversation } = useStore();
  const schedules = useSchedules(agent.id);
  const projectName = (id: string | null) => (id && state.projects.find((p) => p.id === id)?.name) || null;
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null);
  const toggle = (s: Schedule) => void attempt(() => api.updateSchedule(s.id, { agentId: s.agentId, title: s.title, prompt: s.prompt, cadence: s.cadence, target: s.target, enabled: !s.enabled }));

  return (
    <Section
      title="Routines"
      action={
        <button onClick={() => setEditing('new')} className="inline-flex items-center gap-0.5 text-[12.5px] text-accent hover:underline">
          <Plus size={13} /> New
        </button>
      }
    >
      {schedules && schedules.length === 0 && <p className="text-[13px] text-muted">No routines yet. A routine runs {agent.name} on a schedule while Nest is open.</p>}
      <ul className="-mx-2.5">
        {(schedules ?? []).map((s) => (
          <li key={s.id} className="group flex items-start gap-3 rounded-xl px-2.5 py-2 transition-colors hover:bg-hover">
            {s.enabled ? <Clock3 size={18} strokeWidth={1.8} className="mt-0.5 shrink-0 text-ok" /> : <CirclePause size={18} strokeWidth={1.8} className="mt-0.5 shrink-0 text-faint" />}
            <div className="min-w-0 flex-1">
              <Tooltip label="Edit routine" align="start">
                <button onClick={() => setEditing(s)} className="block w-full text-left">
                  <span className="block truncate text-[14px] text-ink">{s.title}</span>
                  <span className="block truncate text-[13px] text-muted">{s.enabled ? friendlyCadence(s.cadence) : 'Paused'}</span>
                  <span className="block truncate text-[12px] text-faint">{projectName(s.projectId) ? `In ${projectName(s.projectId)}` : 'No project'}</span>
                </button>
              </Tooltip>
              {s.lastStatus && s.lastStatus !== 'Started' && <div className="mt-0.5 text-[12px] text-warn-ink">{s.lastStatus}</div>}
              {s.lastConversationId && (
                <button onClick={() => void openConversation(s.lastConversationId!)} className="mt-0.5 text-[12px] text-accent hover:underline">
                  Open last run
                </button>
              )}
            </div>
            <div className="flex shrink-0 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
              <IconButton label={`Run ${s.title} now`} onClick={() => void attempt(() => api.runScheduleNow(s.id))} className="h-7 w-7">
                <Play size={13} />
              </IconButton>
              <IconButton label={s.enabled ? `Pause ${s.title}` : `Resume ${s.title}`} onClick={() => toggle(s)} className="h-7 w-7">
                {s.enabled ? <Pause size={13} /> : <Clock3 size={13} />}
              </IconButton>
            </div>
          </li>
        ))}
      </ul>
      {editing && <RoutineEditor schedule={editing === 'new' ? null : editing} defaultAgentId={agent.id} onClose={() => setEditing(null)} />}
    </Section>
  );
}
