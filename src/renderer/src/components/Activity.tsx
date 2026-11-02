import { useState } from 'react';
import { BookOpen, Check, ChevronRight, CircleAlert, FileText, Globe, Info, Loader2, Plug, ShieldCheck, Terminal, Wrench, X } from 'lucide-react';
import type { Activity, ActivityKind, Approval } from '@shared/types';
import { cx } from './ui';
import { api } from '../api';
import { useStore } from '../store';

const KIND_ICON: Record<ActivityKind, typeof Terminal> = {
  command: Terminal,
  file: FileText,
  tool: Wrench,
  search: Globe,
  mcp: Plug,
  context: BookOpen,
  info: Info,
  approval: ShieldCheck,
};

/** Collapsible list of real tool events for one run. Never shows model reasoning. */
export function ActivityGroup({ activities, running, defaultOpen = false }: { activities: Activity[]; running: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  if (!activities.length) return null;
  const sorted = [...activities].sort((a, b) => a.seq - b.seq);
  const tools = sorted.filter((a) => a.kind !== 'context' && a.kind !== 'info');
  const failed = sorted.filter((a) => a.status === 'failed').length;
  const current = running ? [...sorted].reverse().find((a) => a.status === 'running') : undefined;
  const summary = current
    ? current.title
    : tools.length
      ? `${tools.length} step${tools.length === 1 ? '' : 's'}${failed ? ` · ${failed} failed` : ''}`
      : sorted.map((a) => a.title).slice(0, 1).join('');
  return (
    <div className="mb-1.5">
      <button onClick={() => setOpen((o) => !o)} className="flex max-w-full items-center gap-1.5 rounded-full bg-sunken py-1 pl-2 pr-3 text-[12.5px] text-muted transition-colors hover:bg-hover hover:text-ink" aria-expanded={open}>
        <ChevronRight size={13} className={cx('shrink-0 transition-transform', open && 'rotate-90')} />
        <span className="font-medium">Activity</span>
        {running && <Loader2 size={12} className="animate-spin" />}
        <span className="truncate text-faint">{summary}</span>
      </button>
      {open && (
        <div className="mb-1 ml-3 mt-2 space-y-1 border-l border-line pl-3">
          {sorted.map((a) => (
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
  const expandable = Boolean(activity.detail || activity.output);
  return (
    <div className="text-[12.5px]">
      <button
        disabled={!expandable}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-start gap-2 rounded-md py-0.5 text-left text-ink-2 enabled:hover:text-ink"
      >
        <Icon size={13} className="mt-[3px] shrink-0 text-faint" />
        <span className={cx('min-w-0 flex-1', activity.kind === 'command' && 'font-mono text-[12px]', !open && 'truncate')}>{activity.title}</span>
        <StatusIcon status={activity.status} />
      </button>
      {open && (
        <div className="mb-1.5 ml-5 space-y-1.5">
          {activity.detail && <pre className="scroll-quiet max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-sunken p-2 font-mono text-[11.5px] leading-relaxed text-ink-2">{activity.detail}</pre>}
          {activity.output && <pre className="scroll-quiet max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-panel p-2 font-mono text-[11.5px] leading-relaxed text-ink-2">{activity.output}</pre>}
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
