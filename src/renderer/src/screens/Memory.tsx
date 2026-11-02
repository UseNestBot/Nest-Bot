import { useCallback, useEffect, useMemo, useState } from 'react';
import { Brain, Plus, Trash2 } from 'lucide-react';
import type { MemoryNote } from '@shared/types';
import { api } from '../api';
import { useStore } from '../store';
import { Avatar } from '../components/Avatar';
import { Button, EmptyState, ScreenHeader, Select, Toggle, Tooltip, cx, inputClass } from '../components/ui';
import { confirmDialog } from '../components/confirm';

export function MemoryScreen() {
  const { state, attempt } = useStore();
  const [notes, setNotes] = useState<MemoryNote[] | null>(null);
  const [filter, setFilter] = useState<string>('all');
  const [newText, setNewText] = useState('');
  const [newScope, setNewScope] = useState<string>('shared');

  const load = useCallback(async () => setNotes((await attempt(() => api.listMemory())) ?? []), [attempt]);
  useEffect(() => {
    void load();
  }, [load]);

  // Filter and scope values: 'all', 'shared', an agent id, or 'project:<id>'.
  const shown = useMemo(
    () => (notes ?? []).filter((n) => filter === 'all' || (filter === 'shared' ? n.scope === 'shared' : filter.startsWith('project:') ? n.projectId === filter.slice(8) : n.agentId === filter)),
    [notes, filter],
  );
  const sections = useMemo(() => {
    const shared = shown.filter((n) => n.scope === 'shared');
    const byProject = state.projects.map((p) => ({ project: p, notes: shown.filter((n) => n.scope === 'project' && n.projectId === p.id) })).filter((s) => s.notes.length);
    const byAgent = state.agents.map((a) => ({ agent: a, notes: shown.filter((n) => n.agentId === a.id) })).filter((s) => s.notes.length);
    return { shared, byProject, byAgent };
  }, [shown, state.agents, state.projects]);

  const add = async () => {
    const scope = newScope === 'shared' ? 'shared' : newScope.startsWith('project:') ? 'project' : 'agent';
    const note = await attempt(() => api.createMemory(scope, scope === 'shared' ? null : scope === 'project' ? newScope.slice(8) : newScope, newText));
    if (note) {
      setNewText('');
      await load();
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <ScreenHeader title="Memory" subtitle="Plain-text notes stored on this computer. Sent to an agent only when they change." />
      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[760px] px-6 py-6 max-[640px]:px-4 max-[640px]:py-4">
          <div className="mb-6 rounded-2xl border border-line bg-panel p-3">
            <textarea value={newText} onChange={(e) => setNewText(e.target.value)} rows={2} placeholder="Add a note, e.g. “I prefer metric units” or “The repo uses pnpm”" className={cx(inputClass, 'resize-y border-none px-1 focus:border-none')} />
            <div className="mt-2 flex items-center gap-2">
              <Select
                label="Note scope"
                value={newScope}
                onChange={setNewScope}
                options={[
                  { value: 'shared', label: 'Shared with all agents', hint: 'Every agent sees it' },
                  ...state.projects.map((p) => ({ value: `project:${p.id}`, label: `Project: ${p.name}`, hint: 'Its members see it' })),
                  ...state.agents.map((a) => ({ value: a.id, label: `Only ${a.name}`, icon: <Avatar spec={a.avatar} size={16} /> })),
                ]}
              />
              <div className="flex-1" />
              <Button variant="primary" disabled={!newText.trim()} onClick={add}>
                <Plus size={14} /> Add note
              </Button>
            </div>
          </div>

          <div className="mb-4 flex flex-wrap gap-1.5">
            {[{ id: 'all', label: 'All' }, { id: 'shared', label: 'Shared' }, ...state.projects.map((p) => ({ id: `project:${p.id}`, label: p.name })), ...state.agents.map((a) => ({ id: a.id, label: a.name }))].map((f) => (
              <button key={f.id} onClick={() => setFilter(f.id)} className={cx('rounded-full border px-2.5 py-0.5 text-[12.5px]', filter === f.id ? 'border-primary bg-primary text-on-primary' : 'border-line bg-panel text-ink-2 hover:bg-hover')}>
                {f.label}
              </button>
            ))}
          </div>

          {notes && notes.length === 0 && (
            <EmptyState icon={<Brain size={28} />} title="No memory notes yet">
              Add one above, or use “Remember this” under any response.
            </EmptyState>
          )}

          {sections.shared.length > 0 && (
            <Section title="Shared notes" subtitle="Included for every agent">
              {sections.shared.map((n) => (
                <NoteRow key={n.id} note={n} onChange={load} />
              ))}
            </Section>
          )}
          {sections.byProject.map(({ project, notes: list }) => (
            <Section key={project.id} title={project.name} subtitle="Every agent in this project">
              {list.map((n) => (
                <NoteRow key={n.id} note={n} onChange={load} />
              ))}
            </Section>
          ))}
          {sections.byAgent.map(({ agent, notes: list }) => (
            <Section key={agent.id} title={agent.name} icon={<Avatar spec={agent.avatar} size={18} />} subtitle="Only this agent">
              {list.map((n) => (
                <NoteRow key={n.id} note={n} onChange={load} />
              ))}
            </Section>
          ))}
        </div>
      </div>
    </div>
  );
}

function Section({ title, subtitle, icon, children }: { title: string; subtitle: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center gap-2">
        {icon}
        <h2 className="text-[13.5px] font-semibold">{title}</h2>
        <span className="text-[12px] text-muted">{subtitle}</span>
      </div>
      <div className="divide-y divide-line rounded-2xl border border-line bg-panel">{children}</div>
    </section>
  );
}

export function NoteRow({ note, onChange }: { note: MemoryNote; onChange: () => Promise<void> }) {
  const { attempt } = useStore();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.content);
  useEffect(() => setText(note.content), [note.content]);
  return (
    <div className={cx('flex items-start gap-3 px-3.5 py-3', !note.enabled && 'opacity-55')}>
      <div className="min-w-0 flex-1">
        {editing ? (
          <>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} autoFocus className={cx(inputClass, 'resize-y')} />
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                variant="primary"
                disabled={!text.trim()}
                onClick={async () => {
                  await attempt(() => api.updateMemory(note.id, { content: text }));
                  setEditing(false);
                  await onChange();
                }}
              >
                Save
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setText(note.content);
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <Tooltip label="Click to edit" align="start">
            <button onClick={() => setEditing(true)} className="block w-full whitespace-pre-wrap break-words text-left text-[13.5px] leading-relaxed text-ink">
              {note.content}
            </button>
          </Tooltip>
        )}
        <div className="mt-1 text-[11.5px] text-faint">
          Updated {new Date(note.updatedAt).toLocaleString()}
          {note.sourceMessageId ? ' · saved from a message' : ''}
        </div>
      </div>
      <Toggle
        checked={note.enabled}
        label={note.enabled ? 'Included' : 'Excluded'}
        onChange={async (enabled) => {
          await attempt(() => api.updateMemory(note.id, { enabled }));
          await onChange();
        }}
      />
      <button
        onClick={async () => {
          if (!(await confirmDialog({ title: 'Delete this note?', message: 'Agents will no longer see it.', confirmLabel: 'Delete', tone: 'danger' }))) return;
          await attempt(() => api.deleteMemory(note.id));
          await onChange();
        }}
        className="rounded-md p-1 text-faint hover:bg-hover hover:text-bad"
        aria-label="Delete note"
        title="Delete note"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}
