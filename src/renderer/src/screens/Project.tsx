import { useCallback, useEffect, useMemo, useState } from 'react';
import { FolderOpen, MessageSquarePlus, Plus, Trash2, UserMinus, UserPlus } from 'lucide-react';
import { PROVIDER_LABEL, type Agent, type MemoryNote, type Project, type ProjectDraft } from '@shared/types';
import { api } from '../api';
import { useStore } from '../store';
import { listTime } from '../format';
import { Avatar } from '../components/Avatar';
import { ProjectMark, dragAgent, moveAgent, useProjectDrop } from '../components/Projects';
import { Button, EmptyState, Field, IconButton, MenuItem, MenuLabel, Popover, SectionLabel, Tooltip, cx, inputClass } from '../components/ui';
import { NoteRow } from './Memory';
import { confirmDialog } from '../components/confirm';
import { MobileBack } from '../components/MobileBack';

const toDraft = (p: Project): ProjectDraft => ({ name: p.name, brief: p.brief, workspace: p.workspace, color: p.color });

/** One project (bot family): its brief and folder, its members, what they share, and their recent chats. */
export function ProjectScreen({ id }: { id: string }) {
  const { state, navigate } = useStore();
  const project = state.projects.find((p) => p.id === id);
  useEffect(() => {
    if (state.ready && !project) navigate({ name: 'home' });
  }, [state.ready, project, navigate]);
  if (!project) return null;
  return <ProjectBody key={project.id} project={project} />;
}

function ProjectBody({ project }: { project: Project }) {
  const { state, attempt, toast, navigate, reloadProjects, openConversation, startConversation } = useStore();
  const [draft, setDraft] = useState<ProjectDraft>(() => toDraft(project));
  const [defaultFolder, setDefaultFolder] = useState<string | null>(null);
  const saved = toDraft(project);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const set = <K extends keyof ProjectDraft>(k: K, v: ProjectDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const projectChats = state.conversations.filter((c) => c.projectId === project.id);
  const chats = projectChats.slice(0, 12);
  // Members: agents in this project, plus agents with a chat here (e.g. a chief of staff).
  const guests = new Set(projectChats.map((c) => c.agentId));
  const members = state.agents.filter((a) => a.projectId === project.id || guests.has(a.id));
  const outsiders = state.agents.filter((a) => a.projectId !== project.id);
  const others = state.agents.filter((a) => !members.includes(a));
  const agentsById = new Map(state.agents.map((a) => [a.id, a]));
  const busy = new Set(state.conversations.filter((c) => state.running[c.id]).map((c) => c.agentId));
  const { over, props: dropProps } = useProjectDrop(project.id);
  const folder = draft.workspace ?? defaultFolder;

  useEffect(() => {
    if (!project.workspace) void api.getAppInfo().then((i) => setDefaultFolder(i.effectiveDefaultWorkspace)).catch(() => {});
  }, [project.workspace]);

  const save = async () => {
    const next = await attempt(() => api.updateProject(project.id, draft));
    if (!next) return;
    await reloadProjects();
    setDraft(toDraft(next));
    toast('Project saved. Members get the changes from their next message.', 'info');
  };

  const remove = async () => {
    if (!(await confirmDialog({ title: `Delete the “${project.name}” project?`, message: "Its agents and chats stay, outside any project; the project's brief and memory notes are deleted. Files in its folder are not touched.", confirmLabel: 'Delete project', tone: 'danger' }))) return;
    const ok = await attempt(async () => {
      await api.deleteProject(project.id);
      return true;
    });
    if (ok) navigate({ name: 'home' });
  };

  /** The agent's latest chat in this project, or a new one here. */
  const openAgent = (a: Agent) => {
    const latest = projectChats.find((c) => c.agentId === a.id);
    if (latest) void openConversation(latest.id);
    else void startConversation(a.id, project.id);
  };

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <div className="app-drag flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line pl-6 pr-3 max-[640px]:pl-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <MobileBack />
          <ProjectMark members={members.map((a) => a.avatar)} ids={members.map((a) => a.id)} size={32} />
          <div className="min-w-0">
            <h1 className="truncate font-display text-[16px] font-semibold">{project.name}</h1>
            <div className="truncate text-[12px] text-muted">
              Project · {members.length} agent{members.length === 1 ? '' : 's'}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {state.agents.length > 0 && (
            <Popover
              align="right"
              width={240}
              trigger={({ toggle }) => (
                <Button variant="primary" onClick={toggle}>
                  <MessageSquarePlus size={14} /> New chat
                </Button>
              )}
            >
              {(close) => {
                const item = (a: Agent) => (
                  <MenuItem
                    key={a.id}
                    onClick={() => {
                      close();
                      void startConversation(a.id, project.id);
                    }}
                  >
                    <Avatar spec={a.avatar} size={22} />
                    <span className="truncate">{a.name}</span>
                  </MenuItem>
                );
                return (
                  <div className="scroll-quiet max-h-80 overflow-y-auto">
                    {members.length > 0 && <MenuLabel>New chat in {project.name} with</MenuLabel>}
                    {members.map(item)}
                    {others.length > 0 && <MenuLabel>Bring in for one chat</MenuLabel>}
                    {others.map(item)}
                  </div>
                );
              }}
            </Popover>
          )}
          <div className="titlebar-spacer" />
        </div>
      </div>

      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[760px] space-y-8 px-6 py-6">
          {/* Members */}
          <section {...dropProps} className={cx('-mx-2 rounded-[22px] px-2 pb-2 transition-colors', over && 'bg-hover ring-2 ring-accent/60')}>
            <SectionLabel
              action={
                <Popover
                  align="right"
                  width={260}
                  trigger={({ toggle }) => (
                    <Button size="sm" onClick={toggle}>
                      <UserPlus size={13} /> Add agent
                    </Button>
                  )}
                >
                  {(close) => (
                    <>
                      {outsiders.length > 0 && <MenuLabel>Add to {project.name}</MenuLabel>}
                      <div className="scroll-quiet max-h-72 overflow-y-auto">
                        {outsiders.map((a) => (
                          <MenuItem
                            key={a.id}
                            hint={a.projectId ? state.projects.find((p) => p.id === a.projectId)?.name : undefined}
                            onClick={() => {
                              close();
                              void moveAgent(a.id, project.id, { state, attempt, toast });
                            }}
                          >
                            <Avatar spec={a.avatar} size={22} />
                            <span className="truncate">{a.name}</span>
                          </MenuItem>
                        ))}
                      </div>
                      {outsiders.length > 0 && <div className="my-1 border-t border-line" />}
                      <MenuItem
                        onClick={() => {
                          close();
                          navigate({ name: 'library', agentId: 'new', projectId: project.id });
                        }}
                      >
                        <Plus size={15} className="text-muted" />
                        New agent in this project…
                      </MenuItem>
                    </>
                  )}
                </Popover>
              }
            >
              Agents
            </SectionLabel>
            {members.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-line-strong px-4 py-8 text-center text-[13px] text-muted">
                {over ? 'Drop to move it into this project' : 'No agents yet. Drag an agent or a chat here from the sidebar, or use Add agent.'}
              </div>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
                {members.map((a) => (
                  <div
                    key={a.id}
                    draggable
                    onDragStart={(e) => dragAgent(e, a.id)}
                    className="group relative flex flex-col items-center gap-1.5 rounded-[20px] border border-line bg-panel px-3 pb-3.5 pt-4 transition-[border-color,box-shadow] hover:border-line-strong hover:shadow-float"
                  >
                    <button onClick={() => openAgent(a)} className="flex w-full flex-col items-center gap-1.5">
                      <Avatar spec={a.avatar} size={48} working={busy.has(a.id)} agentId={a.id} />
                      <span className="w-full truncate text-center text-[14px] font-semibold">{a.name}</span>
                      <span className="-mt-1 text-[12px] text-muted">{a.projectId === project.id ? PROVIDER_LABEL[a.provider] : `Visiting · ${PROVIDER_LABEL[a.provider]}`}</span>
                      <span className="line-clamp-2 min-h-[2.6em] w-full text-center text-[12px] leading-[1.3] text-faint">{a.instructions.trim().split('\n')[0] || 'No instructions'}</span>
                    </button>
                    {/* Visitors are here through their chats; move those to take them out. */}
                    {a.projectId === project.id && (
                      <div className="absolute right-1.5 top-1.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                        <IconButton label={`Remove ${a.name} from the project`} onClick={() => void moveAgent(a.id, null, { state, attempt, toast })} className="h-7 w-7 text-faint">
                          <UserMinus size={14} />
                        </IconButton>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* What every member shares */}
          <section className="space-y-4">
            <SectionLabel>Shared with every agent here</SectionLabel>
            <Field label="Name">
              <input value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder="Project name" className={cx(inputClass, 'max-w-[320px]')} />
            </Field>
            <Field label="Brief" hint="Goal, constraints, who does what, where things stand. Members receive it as standing context.">
              <textarea
                value={draft.brief}
                onChange={(e) => set('brief', e.target.value)}
                rows={5}
                placeholder="What is this project for? What should every agent on it know?"
                className={cx(inputClass, 'resize-y leading-relaxed')}
              />
            </Field>
            <Field label="Shared folder" hint="Members without a folder of their own work here, so they can pick up each other's files.">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1 truncate rounded-[10px] border border-line bg-sunken px-3 py-1.5 font-mono text-[12px] text-ink-2">{folder ?? '…'}</div>
                <Button
                  size="sm"
                  onClick={async () => {
                    const picked = await attempt(() => api.pickFolder());
                    if (picked) set('workspace', picked);
                  }}
                >
                  Change…
                </Button>
                {folder && (
                  <Tooltip label="Open in Explorer">
                    <IconButton label="Open folder" onClick={() => void attempt(() => api.openFolder(folder))}>
                      <FolderOpen size={15} />
                    </IconButton>
                  </Tooltip>
                )}
              </div>
            </Field>
            {dirty && (
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setDraft(saved)}>
                  Discard
                </Button>
                <Button variant="primary" onClick={() => void save()} disabled={!draft.name.trim()}>
                  Save project
                </Button>
              </div>
            )}
          </section>

          <ProjectMemory project={project} />

          {/* Recent work */}
          <section>
            <SectionLabel>Recent chats</SectionLabel>
            {chats.length === 0 ? (
              <p className="text-[13px] text-muted">No chats in this project yet.</p>
            ) : (
              <div className="divide-y divide-line rounded-2xl border border-line bg-panel">
                {chats.map((c) => {
                  const a = agentsById.get(c.agentId);
                  return (
                    <button key={c.id} onClick={() => void openConversation(c.id)} className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left first:rounded-t-2xl last:rounded-b-2xl hover:bg-hover">
                      {a && <Avatar spec={a.avatar} size={28} working={Boolean(state.running[c.id])} />}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13.5px] font-medium">{c.title}</span>
                        <span className="block truncate text-[12.5px] text-muted">
                          {a?.name}
                          {c.preview ? ` · ${c.preview}` : ''}
                        </span>
                      </span>
                      <span className="shrink-0 text-[12px] text-faint">{listTime(c.updatedAt)}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          <div className="border-t border-line pt-4">
            <Button variant="danger" onClick={() => void remove()}>
              <Trash2 size={14} /> Delete project
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Notes every member receives; agents add to it with remember(project: true). */
function ProjectMemory({ project }: { project: Project }) {
  const { attempt } = useStore();
  const [notes, setNotes] = useState<MemoryNote[] | null>(null);
  const [text, setText] = useState('');
  const load = useCallback(async () => setNotes((await attempt(() => api.listMemory())) ?? []), [attempt]);
  useEffect(() => {
    void load();
  }, [load]);
  const mine = useMemo(() => (notes ?? []).filter((n) => n.scope === 'project' && n.projectId === project.id), [notes, project.id]);

  const add = async () => {
    if (!text.trim()) return;
    const note = await attempt(() => api.createMemory('project', project.id, text));
    if (!note) return;
    setText('');
    await load();
  };

  return (
    <section>
      <SectionLabel>Project memory</SectionLabel>
      <div className="rounded-2xl border border-line bg-panel">
        {mine.length > 0 && (
          <div className="divide-y divide-line border-b border-line">
            {mine.map((n) => (
              <NoteRow key={n.id} note={n} onChange={load} />
            ))}
          </div>
        )}
        {notes && mine.length === 0 && (
          <div className="border-b border-line">
            <EmptyState title="Nothing remembered yet">Facts every agent here should know. Agents can add to it too.</EmptyState>
          </div>
        )}
        <div className="flex items-center gap-2 p-2">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void add()}
            placeholder="Add a note for the whole project"
            aria-label="New project note"
            className="min-w-0 flex-1 bg-transparent px-1.5 text-[13.5px] outline-none placeholder:text-faint"
          />
          <Button size="sm" variant="primary" disabled={!text.trim()} onClick={() => void add()}>
            <Plus size={13} /> Add
          </Button>
        </div>
      </div>
    </section>
  );
}
