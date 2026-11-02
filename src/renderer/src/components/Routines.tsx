import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Pause, Play, Plus, SkipForward, Trash2 } from 'lucide-react';
import type { Schedule, ScheduleCadence, ScheduleDraft } from '@shared/types';
import { describeCadence } from '@shared/schedule';
import { api } from '../api';
import { useStore } from '../store';
import { Button, Field, Modal, Segmented, Select, Toggle, Tooltip, cx, inputClass } from './ui';
import { confirmDialog } from './confirm';

/** Live list of schedules, optionally filtered to one agent. Reloads on 'schedules-changed'. */
export function useSchedules(agentId?: string): Schedule[] | null {
  const [list, setList] = useState<Schedule[] | null>(null);
  const load = useCallback(() => void api.listSchedules().then(setList).catch(() => setList([])), []);
  useEffect(() => {
    load();
    return api.onEvent((e) => {
      if (e.type === 'schedules-changed') load();
    });
  }, [load]);
  return list && agentId ? list.filter((s) => s.agentId === agentId) : list;
}

function whenLabel(ts: number | null): string {
  if (!ts) return 'Paused';
  const d = new Date(ts);
  const today = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `Today ${time}`;
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow ${time}`;
  return `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`;
}

/**
 * Routines (schedules) for one agent, or all of them. Self-contained: includes
 * its own editor, so it can be mounted anywhere.
 */
export function RoutinesList({ agentId, compact = false }: { agentId?: string; compact?: boolean }) {
  const { state, attempt, openConversation } = useStore();
  const schedules = useSchedules(agentId);
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null);
  const agentName = (id: string) => state.agents.find((a) => a.id === id)?.name ?? 'Removed agent';
  const projectName = (id: string | null) => (id && state.projects.find((p) => p.id === id)?.name) || null;

  return (
    <div>
      {schedules === null ? null : schedules.length === 0 ? (
        <div className={cx('text-[12.5px] text-muted', compact ? 'py-1' : 'py-6 text-center')}>No routines yet. A routine runs an agent on a schedule while Nest is open.</div>
      ) : (
        <ul className="space-y-1.5">
          {schedules.map((s) => (
            <li key={s.id} className="group rounded-xl border border-line bg-panel px-3 py-2.5">
              <div className="flex items-start gap-2.5">
                <CalendarClock size={15} className={cx('mt-0.5 shrink-0', s.enabled ? 'text-ink-2' : 'text-faint')} />
                <Tooltip label="Edit routine" align="start">
                  <button className="min-w-0 flex-1 text-left" onClick={() => setEditing(s)}>
                    <div className={cx('truncate text-[13px] font-medium', !s.enabled && 'text-muted')}>{s.title}</div>
                    <div className="truncate text-[12px] text-muted">
                      {describeCadence(s.cadence)}
                      {!agentId && ` · ${agentName(s.agentId)}`}
                    </div>
                    <div className="truncate text-[11.5px] text-faint">{projectName(s.projectId) ? `In ${projectName(s.projectId)}` : 'No project'}</div>
                    <div className="truncate text-[11.5px] text-faint">{s.enabled ? `Next: ${whenLabel(s.nextRunAt)}` : 'Paused'}</div>
                    {s.lastStatus && s.lastStatus !== 'Started' && <div className="mt-0.5 text-[11.5px] text-warn-ink">{s.lastStatus}</div>}
                  </button>
                </Tooltip>
                <div className="flex shrink-0 items-center gap-0.5">
                  <Tooltip label="Run now">
                    <button
                      className="rounded-md p-1 text-faint hover:bg-hover hover:text-ink"
                      aria-label={`Run ${s.title} now`}
                      onClick={() => void attempt(() => api.runScheduleNow(s.id))}
                    >
                      <SkipForward size={13} />
                    </button>
                  </Tooltip>
                  <Tooltip label={s.enabled ? 'Pause' : 'Resume'}>
                    <button
                      className="rounded-md p-1 text-faint hover:bg-hover hover:text-ink"
                      aria-label={s.enabled ? `Pause ${s.title}` : `Resume ${s.title}`}
                      onClick={() => void attempt(() => api.updateSchedule(s.id, { agentId: s.agentId, title: s.title, prompt: s.prompt, cadence: s.cadence, target: s.target, enabled: !s.enabled }))}
                    >
                      {s.enabled ? <Pause size={13} /> : <Play size={13} />}
                    </button>
                  </Tooltip>
                </div>
              </div>
              {s.lastConversationId && (
                <button className="ml-[25px] mt-1 text-[11.5px] text-accent hover:underline" onClick={() => void openConversation(s.lastConversationId!)}>
                  Open last run
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <Button size="sm" variant="ghost" className="mt-2" onClick={() => setEditing('new')} disabled={!state.agents.length}>
        <Plus size={13} /> New routine
      </Button>
      {editing && <RoutineEditor schedule={editing === 'new' ? null : editing} defaultAgentId={agentId} onClose={() => setEditing(null)} />}
    </div>
  );
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const INTERVALS = [15, 30, 60, 120, 240, 480, 720];

export function RoutineEditor({ schedule, defaultAgentId, initial, onClose }: { schedule: Schedule | null; defaultAgentId?: string; initial?: Partial<ScheduleDraft>; onClose: () => void }) {
  const { state, attempt, toast } = useStore();
  const [draft, setDraft] = useState<ScheduleDraft>(() => ({
    agentId: schedule?.agentId ?? initial?.agentId ?? defaultAgentId ?? state.agents[0]?.id ?? '',
    title: schedule?.title ?? initial?.title ?? '',
    prompt: schedule?.prompt ?? initial?.prompt ?? '',
    cadence: schedule?.cadence ?? initial?.cadence ?? { kind: 'weekdays', time: '08:30' },
    target: schedule?.target ?? initial?.target ?? 'new',
    enabled: schedule?.enabled ?? true,
    projectId:
      schedule?.projectId ??
      (schedule ? null : initial?.projectId !== undefined ? initial.projectId : (state.agents.find((a) => a.id === (initial?.agentId ?? defaultAgentId ?? state.agents[0]?.id))?.projectId ?? null)),
  }));
  // A new routine works in its agent's project until the user picks one.
  const [projectPicked, setProjectPicked] = useState(Boolean(schedule) || initial?.projectId !== undefined);
  const agent = state.agents.find((a) => a.id === draft.agentId) ?? null;
  const project = draft.projectId ? (state.projects.find((p) => p.id === draft.projectId) ?? null) : null;
  const folder = agent?.workspace
    ? `${agent.name}’s own folder, ${agent.workspace}`
    : project
      ? (project.workspace ?? 'Nest’s default working folder (this project has no folder set)')
      : 'Nest’s default working folder';
  const set = <K extends keyof ScheduleDraft>(k: K, v: ScheduleDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const c = draft.cadence;
  const time = c.kind === 'interval' ? '09:00' : c.time;
  const setKind = (kind: ScheduleCadence['kind']) =>
    set('cadence', kind === 'interval' ? { kind, minutes: 60 } : kind === 'weekly' ? { kind, time, weekday: 1 } : { kind, time });

  const save = async () => {
    const res = await attempt(() => (schedule ? api.updateSchedule(schedule.id, draft) : api.createSchedule(draft)));
    if (res) {
      toast(schedule ? 'Routine saved.' : `Routine created. Next run ${res.nextRunAt ? new Date(res.nextRunAt).toLocaleString() : 'when resumed'}.`, 'info');
      onClose();
    }
  };

  return (
    <Modal
      title={schedule ? 'Edit routine' : 'New routine'}
      onClose={onClose}
      width={560}
      footer={
        <div className="flex w-full items-center justify-between">
          {schedule ? (
            <Button
              variant="danger"
              onClick={async () => {
                if (!(await confirmDialog({ title: `Delete “${schedule.title}”?`, message: 'The routine stops running. Past conversations stay.', confirmLabel: 'Delete', tone: 'danger' }))) return;
                await attempt(() => api.deleteSchedule(schedule.id));
                onClose();
              }}
            >
              <Trash2 size={14} /> Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={save} disabled={!draft.title.trim() || !draft.prompt.trim() || !draft.agentId}>
              {schedule ? 'Save' : 'Create routine'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label="Name">
          <input value={draft.title} onChange={(e) => set('title', e.target.value)} placeholder="Morning brief" className={inputClass} autoFocus />
        </Field>
        <Field label="Agent">
          <Select
            label="Agent"
            className="w-full"
            value={draft.agentId}
            onChange={(agentId) =>
              setDraft((d) => ({ ...d, agentId, projectId: projectPicked ? d.projectId : (state.agents.find((a) => a.id === agentId)?.projectId ?? null) }))
            }
            options={state.agents.map((a) => ({ value: a.id, label: a.name, hint: state.projects.find((p) => p.id === a.projectId)?.name }))}
          />
        </Field>
        <Field
          label="Works in"
          hint={
            project
              ? `Each run’s chat appears in ${project.name} with its brief, memory and teammates, and works in ${folder}.`
              : `Each run’s chat appears on its own, outside any project, and works in ${folder}.`
          }
        >
          <Select
            label="Project"
            className="w-full"
            value={draft.projectId ?? 'none'}
            onChange={(v) => {
              setProjectPicked(true);
              set('projectId', v === 'none' ? null : v);
            }}
            options={[
              ...state.projects.map((p) => ({ value: p.id, label: p.name, hint: p.id === agent?.projectId ? `${agent.name}’s project` : undefined })),
              { value: 'none', label: 'No project' },
            ]}
          />
        </Field>
        <Field label="What should it do each time?">
          <textarea value={draft.prompt} onChange={(e) => set('prompt', e.target.value)} rows={4} placeholder="Summarise what changed in my project folder since yesterday and list anything that needs my attention." className={cx(inputClass, 'resize-y')} />
        </Field>
        <Field label="When">
          <div className="space-y-2">
            <Segmented
              value={c.kind}
              onChange={setKind}
              options={[
                { value: 'daily', label: 'Daily' },
                { value: 'weekdays', label: 'Weekdays' },
                { value: 'weekly', label: 'Weekly' },
                { value: 'interval', label: 'Every…' },
              ]}
            />
            <div className="flex flex-wrap items-center gap-2">
              {c.kind === 'weekly' && (
                <Select
                  label="Day of week"
                  value={String(c.weekday)}
                  onChange={(v) => set('cadence', { ...c, weekday: Number(v) })}
                  options={DAYS.map((d, i) => ({ value: String(i), label: d }))}
                />
              )}
              {c.kind === 'interval' ? (
                <Select
                  label="Interval"
                  value={String(c.minutes)}
                  onChange={(v) => set('cadence', { kind: 'interval', minutes: Number(v) })}
                  options={INTERVALS.map((m) => ({ value: String(m), label: m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? '' : 's'}` }))}
                />
              ) : (
                <input type="time" value={c.time} onChange={(e) => set('cadence', { ...c, time: e.target.value || '09:00' })} className={cx(inputClass, 'w-32')} aria-label="Time" />
              )}
              <span className="text-[12px] text-muted">{describeCadence(c)}</span>
            </div>
          </div>
        </Field>
        <Field label="Where results go">
          <Segmented
            value={draft.target}
            onChange={(target) => set('target', target)}
            options={[
              { value: 'new', label: 'New conversation each run' },
              { value: 'same', label: 'One ongoing conversation' },
            ]}
          />
        </Field>
        <div className="flex items-center justify-between rounded-lg border border-line px-3 py-2.5">
          <div>
            <div className="text-[13px] font-medium">Active</div>
            <div className="text-[12px] text-muted">Runs only while Nest is open. A run missed while Nest was closed happens at the next launch.</div>
          </div>
          <Toggle checked={draft.enabled} onChange={(v) => set('enabled', v)} label="Active" />
        </div>
      </div>
    </Modal>
  );
}
