import { Fragment, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import type { Activity, FileEdit } from '@shared/types';
import { Tooltip, cx } from './ui';

/** The expanded view of one step: what went in, and what came out. */
export function StepDetail({ activity }: { activity: Activity }) {
  const { kind, meta, detail, output } = activity;
  if (kind === 'command' && meta?.command) return <CommandView activity={activity} />;
  if (kind === 'file' && meta?.edits?.length) {
    return (
      <div className="space-y-2">
        {meta.edits.map((e, i) => (
          <DiffView key={i} edit={e} showPath={meta.edits!.length > 1 || !meta.path} />
        ))}
        {activity.status === 'failed' && output && <OutputPane text={output} failed />}
      </div>
    );
  }
  const args = (kind === 'tool' || kind === 'mcp') && detail ? parseObject(detail) : null;
  return (
    <div className="space-y-1.5">
      {args ? <ArgsView args={args} /> : detail && <pre className="scroll-quiet max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-sunken p-2 font-mono text-[11.5px] leading-relaxed text-ink-2">{detail}</pre>}
      {output && <OutputPane text={prettyJson(output)} failed={activity.status === 'failed'} />}
    </div>
  );
}

/** Whether a step has anything to show when expanded. */
export function hasStepDetail(activity: Activity): boolean {
  return Boolean(activity.detail || activity.output || activity.meta?.command || activity.meta?.edits?.length);
}

/** The small facts shown at the end of a step's row: exit code, time taken, lines changed. */
export function StepChips({ activity }: { activity: Activity }) {
  const { meta } = activity;
  const counts = useMemo(() => (meta?.edits?.length ? editCounts(meta.edits) : null), [meta?.edits]);
  const chips: ReactNode[] = [];
  if (counts && (counts.added || counts.removed)) {
    chips.push(
      <span key="diff" className="font-mono text-[11.5px]">
        {counts.added > 0 && <span className="text-ok">+{counts.added}</span>}
        {counts.added > 0 && counts.removed > 0 && ' '}
        {counts.removed > 0 && <span className="text-bad">−{counts.removed}</span>}
      </span>,
    );
  }
  if (activity.kind === 'command') {
    if (meta?.exitCode !== undefined && meta.exitCode !== null && meta.exitCode !== 0) chips.push(<span key="exit" className="text-bad">exit {meta.exitCode}</span>);
    const ms = activity.updatedAt - activity.createdAt;
    if (activity.status !== 'running' && ms >= 1000) chips.push(<span key="time">{seconds(ms)}</span>);
  }
  if (!chips.length) return null;
  return <span className="flex shrink-0 items-center gap-2 text-[11.5px] tabular-nums text-faint">{chips}</span>;
}

function seconds(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

// ---- commands ---------------------------------------------------------------

function CommandView({ activity }: { activity: Activity }) {
  const meta = activity.meta!;
  const failed = activity.status === 'failed' || (meta.exitCode !== undefined && meta.exitCode !== null && meta.exitCode !== 0);
  const facts = [meta.cwd ? `in ${meta.cwd}` : null, meta.exitCode !== undefined && meta.exitCode !== null ? `exit code ${meta.exitCode}` : null].filter(Boolean).join(' · ');
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      {meta.description && <div className="border-b border-line px-2.5 py-1.5 text-[12px] text-muted">{meta.description}</div>}
      <div className="group/cmd relative bg-sunken px-2.5 py-2">
        <pre className="scroll-quiet max-h-48 overflow-auto whitespace-pre-wrap break-words pr-7 font-mono text-[12px] leading-relaxed text-ink">
          <span className="select-none text-faint">$ </span>
          <ShellText text={meta.command!} />
        </pre>
        <CopyButton text={meta.command!} label="Copy command" className="absolute right-1.5 top-1.5 opacity-0 group-hover/cmd:opacity-100" />
      </div>
      {activity.output ? (
        <OutputPane text={activity.output} failed={failed} flush />
      ) : (
        activity.status !== 'running' && <div className="border-t border-line px-2.5 py-1.5 text-[11.5px] italic text-faint">No output</div>
      )}
      {facts && <div className="border-t border-line px-2.5 py-1 font-mono text-[11px] text-faint">{facts}</div>}
    </div>
  );
}

/** Light shell colouring: the program, flags, strings, variables and operators. */
function ShellText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let expectProgram = true;
  for (const [i, token] of (text.match(/"(?:[^"\\]|\\.)*"?|'[^']*'?|&&|\|\||[|;&<>]+|\s+|[^\s|;&<>"']+/g) ?? []).entries()) {
    let cls: string | undefined;
    if (/^\s+$/.test(token)) {
      if (token.includes('\n')) expectProgram = true;
    } else if (/^(&&|\|\||[|;&]+)$/.test(token)) {
      cls = 'sh-op';
      expectProgram = true;
    } else if (/^[<>]+$/.test(token)) cls = 'sh-op';
    else if (/^["']/.test(token)) cls = 'sh-str';
    else if (/^\$/.test(token)) cls = 'sh-var';
    else if (expectProgram && !/^\w+=/.test(token)) {
      cls = 'sh-cmd';
      expectProgram = false;
    } else if (/^--?[\w-]/.test(token)) cls = 'sh-flag';
    parts.push(cls ? <span key={i} className={cls}>{token}</span> : token);
  }
  return <>{parts}</>;
}

// ---- output -----------------------------------------------------------------

const TAIL_LINES = 15;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

/** Command or tool output. Long output shows its last lines first; the end is usually what matters. */
function OutputPane({ text, failed = false, flush = false }: { text: string; failed?: boolean; flush?: boolean }) {
  const [all, setAll] = useState(false);
  const pre = useRef<HTMLPreElement>(null);
  const clean = text.replace(ANSI, '').replace(/\s+$/, '');
  const lines = clean.split('\n');
  const hidden = all ? 0 : Math.max(0, lines.length - TAIL_LINES);
  // Keep the end in view, as output grows and when the full output opens.
  useLayoutEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [clean, all]);
  return (
    <div className={cx('group/out relative', flush ? 'border-t border-line' : 'rounded-lg border border-line', failed && 'border-l-2 border-l-bad')}>
      {hidden > 0 && (
        <button onClick={() => setAll(true)} className="block w-full border-b border-line px-2.5 py-1 text-left text-[11.5px] text-muted hover:bg-hover hover:text-ink">
          Show all {lines.length} lines
        </button>
      )}
      <pre ref={pre} className={cx('scroll-quiet overflow-auto whitespace-pre-wrap break-words px-2.5 py-2 pr-8 font-mono text-[11.5px] leading-relaxed text-ink-2', all ? 'max-h-[28rem]' : 'max-h-80')}>
        {hidden ? lines.slice(hidden).join('\n') : clean}
      </pre>
      <CopyButton text={clean} label="Copy output" className="absolute right-1.5 top-1.5 opacity-0 group-hover/out:opacity-100" />
    </div>
  );
}

function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip label={copied ? 'Copied' : label} align="end">
      <button
        onClick={() => {
          void navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
        className={cx('rounded-md border border-line bg-panel/90 p-1 text-muted transition-opacity hover:text-ink focus:opacity-100', className)}
        aria-label={label}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </Tooltip>
  );
}

// ---- tool arguments ---------------------------------------------------------

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function prettyJson(text: string): string {
  const t = text.trim();
  if (!/^[[{]/.test(t)) return text;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return text;
  }
}

function ArgsView({ args }: { args: Record<string, unknown> }) {
  return (
    <div className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-lg bg-sunken px-2.5 py-2 text-[12px]">
      {Object.entries(args).map(([key, value]) => (
        <Fragment key={key}>
          <span className="truncate font-mono text-[11.5px] text-faint">{key}</span>
          <span className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] text-ink-2 scroll-quiet">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</span>
        </Fragment>
      ))}
    </div>
  );
}

// ---- diffs ------------------------------------------------------------------

type DiffLine = { type: 'add' | 'del' | 'same' | 'hunk'; text: string };

/** Line diff of two texts (longest common subsequence). Very large edits fall back to all-removed / all-added. */
function diffLines(before: string, after: string): DiffLine[] {
  const a = before ? before.split('\n') : [];
  const b = after ? after.split('\n') : [];
  if (a.length * b.length > 400_000) return [...a.map((text) => ({ type: 'del' as const, text })), ...b.map((text) => ({ type: 'add' as const, text }))];
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i++] });
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ type: 'del', text: a[i++] });
    else out.push({ type: 'add', text: b[j++] });
  }
  while (i < a.length) out.push({ type: 'del', text: a[i++] });
  while (j < b.length) out.push({ type: 'add', text: b[j++] });
  return out;
}

function parseUnifiedDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  for (const line of diff.replace(/\n$/, '').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) continue;
    if (line.startsWith('@@')) out.push({ type: 'hunk', text: line });
    else if (line.startsWith('+')) out.push({ type: 'add', text: line.slice(1) });
    else if (line.startsWith('-')) out.push({ type: 'del', text: line.slice(1) });
    else if (line.startsWith('\\')) continue;
    else out.push({ type: 'same', text: line.slice(1) });
  }
  return out;
}

const linesOf = (e: FileEdit) => (e.diff !== undefined ? parseUnifiedDiff(e.diff) : diffLines(e.before ?? '', e.after ?? ''));

function editCounts(edits: FileEdit[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const e of edits) {
    for (const l of linesOf(e)) {
      if (l.type === 'add') added++;
      else if (l.type === 'del') removed++;
    }
  }
  return { added, removed };
}

const CONTEXT = 3;

/** Unchanged lines more than a few lines from a change fold away. */
function fold(lines: DiffLine[]): Array<DiffLine | { type: 'fold'; count: number; at: number }> {
  const near = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.type === 'same') return;
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(lines.length - 1, i + CONTEXT); k++) near[k] = true;
  });
  const out: Array<DiffLine | { type: 'fold'; count: number; at: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (near[i]) {
      out.push(lines[i]);
      continue;
    }
    let j = i;
    while (j < lines.length && !near[j]) j++;
    out.push({ type: 'fold', count: j - i, at: i });
    i = j - 1;
  }
  return out;
}

function DiffView({ edit, showPath }: { edit: FileEdit; showPath: boolean }) {
  const [unfolded, setUnfolded] = useState(false);
  const lines = useMemo(() => linesOf(edit), [edit]);
  const rows = unfolded ? lines : fold(lines);
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      {showPath && edit.path && <div className="truncate border-b border-line bg-sunken px-2.5 py-1 font-mono text-[11.5px] text-muted">{edit.path}</div>}
      <div className="scroll-quiet max-h-96 overflow-auto font-mono text-[11.5px] leading-[1.6]">
        {rows.length === 0 && <div className="px-2.5 py-1.5 italic text-faint">No changes</div>}
        {rows.map((row, i) =>
          row.type === 'fold' ? (
            <button key={i} onClick={() => setUnfolded(true)} className="block w-full bg-sunken px-2.5 py-0.5 text-left text-faint hover:text-ink">
              ⋯ {row.count} unchanged line{row.count === 1 ? '' : 's'}
            </button>
          ) : row.type === 'hunk' ? (
            <div key={i} className="bg-sunken px-2.5 text-faint">
              {row.text}
            </div>
          ) : (
            <div key={i} className={cx('flex min-w-max', row.type === 'add' && 'diff-add', row.type === 'del' && 'diff-del')}>
              <span className={cx('w-6 shrink-0 select-none text-center', row.type === 'add' ? 'text-ok' : row.type === 'del' ? 'text-bad' : 'text-faint')}>{row.type === 'add' ? '+' : row.type === 'del' ? '−' : ''}</span>
              <span className="whitespace-pre pr-3 text-ink-2">{row.text || ' '}</span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
