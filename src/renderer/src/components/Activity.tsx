import { useState } from 'react';
import { BookOpen, Check, ChevronRight, CircleAlert, FileText, Globe, Info, Loader2, MessageSquareText, Plug, ShieldCheck, Terminal, Wrench, X } from 'lucide-react';
import type { Activity, ActivityKind, Approval } from '@shared/types';
import { cx } from './ui';
import { api } from '../api';
import { useStore } from '../store';
import { Markdown } from './Markdown';
import { StepChips, StepDetail, hasStepDetail } from './StepDetail';

const KIND_ICON: Record<ActivityKind, typeof Terminal> = {
  command: Terminal,
  file: FileText,
  tool: Wrench,
  search: Globe,
  mcp: Plug,
  context: BookOpen,
  info: Info,
  approval: ShieldCheck,
  note: MessageSquareText,
};

type TimelineItem = { type: 'note'; activity: Activity } | { type: 'steps'; activities: Activity[] };

/** Notes stay where the agent wrote them; the steps between two notes form one group. */
function timeline(activities: Activity[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const a of activities) {
    const last = items[items.length - 1];
    if (a.kind === 'note') items.push({ type: 'note', activity: a });
    else if (last?.type === 'steps') last.activities.push(a);
    else items.push({ type: 'steps', activities: [a] });
  }
  return items;
}

const isStep = (a: Activity) => a.kind !== 'note' && a.kind !== 'context' && a.kind !== 'info';
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Ran 3 commands, read 2 files, edited 1 file" for a group of steps. */
function describeSteps(activities: Activity[]): string {
  const steps = activities.filter(isStep);
  const count = (test: (a: Activity) => boolean) => steps.filter(test).length;
  const reads = count((a) => a.kind === 'file' && /^(Read|View)\b/.test(a.title));
  const parts = [
    [count((a) => a.kind === 'command'), (n: number) => `ran ${plural(n, 'command')}`],
    [reads, (n: number) => `read ${plural(n, 'file')}`],
    [count((a) => a.kind === 'file') - reads, (n: number) => `edited ${plural(n, 'file')}`],
    [count((a) => a.kind === 'search'), (n: number) => plural(n, 'search', 'searches')],
    [count((a) => a.kind === 'tool' || a.kind === 'mcp'), (n: number) => `used ${plural(n, 'tool')}`],
    [count((a) => a.kind === 'approval'), (n: number) => plural(n, 'approval')],
  ] as const;
  const text = parts
    .filter(([n]) => n > 0)
    .map(([n, say]) => say(n))
    .join(', ');
  const summary = text || activities[0]?.title || '';
  return summary.charAt(0).toUpperCase() + summary.slice(1);
}

/**
 * One reply's work: steps and the notes the agent wrote between them, in order.
 * While the agent works the timeline is open; once it is done it folds to one line above the answer.
 * Never shows model reasoning.
 */
export function RunTimeline({
  activities,
  running,
  answer,
  elapsed,
  defaultOpen = false,
}: {
  activities: Activity[];
  running: boolean;
  /** The reply's own text. A run that ends on a step promotes its last note to the answer, so that note isn't repeated. */
  answer: string;
  /** How long this reply took, once known. */
  elapsed: string | null;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  let sorted = [...activities].sort((a, b) => a.seq - b.seq);
  const notes = sorted.filter((a) => a.kind === 'note');
  const promoted = !running && answer.trim() ? notes[notes.length - 1] : undefined;
  if (promoted && promoted.detail?.trim() === answer.trim()) sorted = sorted.filter((a) => a !== promoted);
  if (!sorted.length) return null;
  const items = timeline(sorted);
  const body = (
    <div className="space-y-1.5">
      {items.map((item, i) =>
        item.type === 'note' ? (
          <Markdown key={item.activity.id} text={item.activity.detail ?? item.activity.title} className="md-note px-1 py-0.5" />
        ) : (
          <StepGroup key={item.activities[0].id} activities={item.activities} live={running && i === items.length - 1} />
        ),
      )}
    </div>
  );
  if (running) return <div className="mb-2">{body}</div>;

  const steps = sorted.filter(isStep);
  const failed = steps.filter((a) => a.status === 'failed').length;
  const worked = steps.length || sorted.some((a) => a.kind === 'note');
  const summary = worked
    ? [elapsed ? `Worked for ${elapsed}` : 'Worked', steps.length ? plural(steps.length, 'step') : null, failed ? `${failed} failed` : null].filter(Boolean).join(' · ')
    : sorted[0].title;
  return (
    <div className="mb-1.5">
      <button onClick={() => setOpen((o) => !o)} className="flex max-w-full items-center gap-1.5 rounded-full bg-sunken py-1 pl-2 pr-3 text-[12.5px] text-muted transition-colors hover:bg-hover hover:text-ink" aria-expanded={open}>
        <ChevronRight size={13} className={cx('shrink-0 transition-transform', open && 'rotate-90')} />
        <span className="truncate">{summary}</span>
      </button>
      {open && <div className="mb-1 ml-3 mt-2 border-l border-line pl-3">{body}</div>}
    </div>
  );
}

/** A run of consecutive steps, folded to a summary. A single step is shown as its own row. */
function StepGroup({ activities, live }: { activities: Activity[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  if (activities.length === 1) return <ActivityRow activity={activities[0]} />;
  const current = live ? [...activities].reverse().find((a) => a.status === 'running') : undefined;
  const failed = activities.filter((a) => a.status === 'failed').length;
  return (
    <div>
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 rounded-md py-0.5 text-left text-[12.5px] text-muted hover:text-ink" aria-expanded={open}>
        <ChevronRight size={13} className={cx('shrink-0 text-faint transition-transform', open && 'rotate-90')} />
        <span className={cx('min-w-0 flex-1 truncate', current?.kind === 'command' && 'font-mono text-[12px]')}>{current ? current.title : describeSteps(activities)}</span>
        {current ? <Loader2 size={12} className="shrink-0 animate-spin text-faint" aria-label="Running" /> : failed > 0 && <span className="shrink-0 text-[12px] text-bad">{failed} failed</span>}
      </button>
      {open && (
        <div className="mb-1 ml-1.5 mt-1 space-y-1 border-l border-line pl-3">
          {activities.map((a) => (
            <ActivityRow key={`${a.runId}:${a.id}`} activity={a} />
          ))}
        </div>
      )}
    </div>
  );
}

function ActivityRow({ activity }: { activity: Activity }) {
  const [open, setOpen] = useState(false);
  const Icon = KIND_ICON[activity.kind] ?? Wrench;
  const expandable = hasStepDetail(activity);
  return (
    <div className="text-[12.5px]">
      <button
        disabled={!expandable}
        onClick={() => setOpen((o) => !o)}
        className="group/row flex w-full items-start gap-2 rounded-md py-0.5 text-left text-ink-2 enabled:hover:text-ink"
        aria-expanded={expandable ? open : undefined}
      >
        <Icon size={13} className="mt-[3px] shrink-0 text-faint" />
        <span className={cx('min-w-0 flex-1 truncate', activity.kind === 'command' && 'font-mono text-[12px]')}>{activity.title}</span>
        <span className="mt-px">
          <StepChips activity={activity} />
        </span>
        <StatusIcon status={activity.status} />
        {expandable && <ChevronRight size={12} className={cx('mt-[3px] shrink-0 text-faint opacity-0 transition group-hover/row:opacity-100', open && 'rotate-90 opacity-100')} />}
      </button>
      {open && (
        <div className="mb-2 ml-5 mt-1">
          <StepDetail activity={activity} />
        </div>
      )}
    </div>
  );
}

function StatusIcon({ status }: { status: Activity['status'] }) {
  if (status === 'running') return <Loader2 size={12} className="mt-[3px] shrink-0 animate-spin text-faint" aria-label="Running" />;
  if (status === 'failed') return <CircleAlert size={12} className="mt-[3px] shrink-0 text-bad" aria-label="Failed" />;
  if (status === 'declined') return <X size={12} className="mt-[3px] shrink-0 text-warn" aria-label="Declined" />;
  return <Check size={12} className="mt-[3px] shrink-0 text-ok" aria-label="Done" />;
}

export function ApprovalCard({ approval }: { approval: Approval }) {
  const { attempt } = useStore();
  const [busy, setBusy] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  return (
    <div className="my-1.5 rounded-[20px] border border-warn-line bg-warn-bg p-4">
      <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
        <ShieldCheck size={15} className="text-warn" />
        {approval.title}
      </div>
      <pre className="scroll-quiet mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-xl border border-line bg-panel px-3 py-2 font-mono text-[12px] text-ink">{approval.action}</pre>
      {approval.target && (
        <div className="mt-1.5 text-[12px] text-muted">
          <span className="text-faint">Target </span>
          <span className="break-all font-mono">{approval.target}</span>
        </div>
      )}
      {approval.reason && <div className="mt-1.5 text-[12.5px] text-ink-2">{approval.reason}</div>}
      {approval.detail && (
        <>
          <button onClick={() => setShowDetail((s) => !s)} className="mt-1.5 text-[12px] text-muted underline-offset-2 hover:text-ink hover:underline">
            {showDetail ? 'Hide details' : 'Show details'}
          </button>
          {showDetail && <pre className="scroll-quiet mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-xl bg-panel p-2 font-mono text-[11.5px] text-ink-2">{approval.detail}</pre>}
        </>
      )}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {approval.choices.map((c) => (
          <button
            key={c.id}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await attempt(() => api.respondApproval(approval.id, c.id));
              setBusy(false);
            }}
            className={cx(
              'h-8 rounded-full px-3.5 text-[12.5px] font-medium transition-colors disabled:opacity-50',
              c.tone === 'primary' && 'bg-primary text-on-primary hover:bg-primary-hover',
              c.tone === 'neutral' && 'border border-line bg-panel text-ink hover:bg-hover',
              c.tone === 'danger' && 'border border-line bg-panel text-bad hover:bg-bad-bg',
            )}
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}
