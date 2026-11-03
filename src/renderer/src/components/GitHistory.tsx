import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Copy, Loader2, RefreshCw, Tag } from 'lucide-react';
import { layoutGraph, type GraphRow } from '@shared/gitGraph';
import type { GitCommit, GitCommitDetail, GitCommitFile, GitDiff, GitRef, GitScope } from '@shared/types';
import { api } from '../api';
import { relativeTime } from '../format';
import { DiffText, LETTER, TONE } from './gitUi';
import { Button, IconButton, Modal, cx } from './ui';

const PAGE = 200;
const ROW_H = 30;
const LANE_W = 12;
/** Lanes drawn before the graph is cut off, so the subject keeps some room. */
const MAX_LANES = 10;
const LANE_COLORS = ['#5b8def', '#e5a03a', '#4cbe6c', '#d9534f', '#a66bd6', '#36b0b0', '#e06fa5', '#8a8f98'];
const laneColor = (i: number) => LANE_COLORS[i % LANE_COLORS.length];


/** The repository's history as a graph: every branch and tag, newest first. `version` changes when the repository does. */
export function GitHistory({ scope, version }: { scope: GitScope; version: string }) {
  const [commits, setCommits] = useState<GitCommit[] | null>(null);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const { kind, id } = scope;

  const load = useCallback(
    (skip: number, keep: GitCommit[]) => {
      setLoading(true);
      void api
        .gitLog({ kind, id }, skip, PAGE)
        .then((page) => {
          setCommits([...keep, ...page.commits]);
          setMore(page.more);
          setError(null);
        })
        .catch((e: Error) => setError(e.message))
        .finally(() => setLoading(false));
    },
    [kind, id],
  );
  // Start over whenever the repository moves; older pages load again on request.
  useEffect(() => load(0, []), [load, version]);

  const layout = useMemo(() => layoutGraph(commits ?? []), [commits]);
  const lanes = Math.min(layout.width, MAX_LANES);

  if (error && !commits) return <p className="text-[13px] text-bad-ink">{error}</p>;
  if (!commits) {
    return (
      <div className="flex items-center gap-2 py-6 text-[13px] text-muted">
        <Loader2 size={14} className="animate-spin" /> Reading history…
      </div>
    );
  }
  if (!commits.length) return <p className="py-4 text-center text-[13px] text-muted">No commits yet.</p>;

  return (
    <div>
      <div className="mb-1 flex items-center px-1">
        <span className="flex-1 text-[12px] font-medium text-faint">
          {commits.length}
          {more ? '+' : ''} commits
        </span>
        <IconButton label="Refresh history" onClick={() => load(0, [])} className="h-6! w-6! text-faint">
          <RefreshCw size={13} className={cx(loading && 'animate-spin')} />
        </IconButton>
      </div>
      <ul className="-mx-1">
        {commits.map((c, i) => (
          <li key={c.hash}>
            <button onClick={() => setOpen(c.hash)} className="flex w-full items-center gap-1.5 rounded-lg pr-2 text-left hover:bg-hover" style={{ height: ROW_H }} title={`${c.subject}\n${c.author} · ${new Date(c.date).toLocaleString()}\n${c.hash.slice(0, 10)}`}>
              <GraphCell row={layout.rows[i]} lanes={lanes} />
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                {c.refs.map((r) => (
                  <RefBadge key={`${r.kind}:${r.name}`} r={r} />
                ))}
                <span className="min-w-0 truncate text-[12.5px] text-ink">{c.subject}</span>
              </span>
              <span className="shrink-0 text-[11px] text-faint">{relativeTime(c.date)}</span>
            </button>
          </li>
        ))}
      </ul>
      {more && (
        <Button size="sm" variant="ghost" className="mt-2 w-full" disabled={loading} onClick={() => load(commits.length, commits)}>
          {loading ? <Loader2 size={13} className="animate-spin" /> : null} Show older commits
        </Button>
      )}
      {open && <CommitDialog scope={scope} hash={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function GraphCell({ row, lanes }: { row: GraphRow; lanes: number }) {
  const x = (c: number) => c * LANE_W + LANE_W / 2 + 2;
  const mid = ROW_H / 2;
  const curve = (a: number, b: number, y0: number, y1: number) => (a === b ? `M${x(a)} ${y0}V${y1}` : `M${x(a)} ${y0}C${x(a)} ${(y0 + y1) / 2} ${x(b)} ${(y0 + y1) / 2} ${x(b)} ${y1}`);
  return (
    <svg width={lanes * LANE_W + 4} height={ROW_H} className="shrink-0 overflow-hidden" aria-hidden>
      {row.up.map(([a, b]) => (
        <path key={`u${a}-${b}`} d={curve(a, b, 0, mid)} stroke={laneColor(a)} strokeWidth={1.6} fill="none" />
      ))}
      {row.down.map(([a, b]) => (
        <path key={`d${a}-${b}`} d={curve(a, b, mid, ROW_H)} stroke={laneColor(b)} strokeWidth={1.6} fill="none" />
      ))}
      {row.col < lanes && <circle cx={x(row.col)} cy={mid} r={3.6} fill={laneColor(row.col)} stroke="var(--color-canvas, #fff)" strokeWidth={1.5} />}
    </svg>
  );
}

function RefBadge({ r }: { r: GitRef }) {
  if (r.kind === 'head') return null;
  return (
    <span
      className={cx(
        'inline-flex max-w-[120px] shrink-0 items-center gap-0.5 truncate rounded px-1 py-px font-mono text-[10.5px] leading-tight',
        r.kind === 'branch' && 'bg-accent/15 text-accent',
        r.kind === 'remote' && 'bg-sunken text-muted',
        r.kind === 'tag' && 'bg-warn-bg text-warn-ink',
      )}
      title={r.name}
    >
      {r.kind === 'tag' && <Tag size={9} className="shrink-0" />}
      <span className="truncate">{r.name}</span>
    </span>
  );
}

function CommitDialog({ scope, hash, onClose }: { scope: GitScope; hash: string; onClose: () => void }) {
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<GitCommitFile | null>(null);
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [copied, setCopied] = useState(false);
  const { kind, id } = scope;
  useEffect(() => {
    void api
      .gitShowCommit({ kind, id }, hash)
      .then(setDetail)
      .catch((e: Error) => setError(e.message));
  }, [kind, id, hash]);
  useEffect(() => {
    setDiff(null);
    if (!file) return;
    void api
      .gitCommitDiff({ kind, id }, hash, file.path)
      .then(setDiff)
      .catch((e: Error) => setError(e.message));
  }, [kind, id, hash, file]);

  const [subject, ...rest] = (detail?.message ?? '').split('\n');
  const body = rest.join('\n').trim();
  return (
    <Modal title={detail ? subject : 'Commit'} onClose={onClose} width={960}>
      {error && <p className="mb-2 text-[13px] text-bad-ink">{error}</p>}
      {!detail && !error && (
        <div className="flex items-center gap-2 py-4 text-[13px] text-muted">
          <Loader2 size={14} className="animate-spin" /> Loading commit…
        </div>
      )}
      {detail && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-muted">
            <span>
              <span className="text-ink">{detail.author}</span> {detail.email && <span className="text-faint">&lt;{detail.email}&gt;</span>}
            </span>
            <span>{new Date(detail.date).toLocaleString()}</span>
            <button
              className="inline-flex items-center gap-1 font-mono text-[11.5px] hover:text-ink"
              onClick={() => {
                void navigator.clipboard.writeText(detail.hash);
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              }}
              title="Copy the full hash"
            >
              {detail.hash.slice(0, 10)} {copied ? <Check size={11} /> : <Copy size={11} />}
            </button>
            {detail.parents.length > 1 && <span>Merge of {detail.parents.map((p) => p.slice(0, 7)).join(' and ')}</span>}
            {detail.committer && detail.committer !== detail.author && <span>Committed by {detail.committer}</span>}
          </div>
          {detail.refs.some((r) => r.kind !== 'head') && (
            <div className="flex flex-wrap gap-1">
              {detail.refs.map((r) => (
                <RefBadge key={`${r.kind}:${r.name}`} r={r} />
              ))}
            </div>
          )}
          {body && <pre className="whitespace-pre-wrap rounded-xl bg-sunken px-3 py-2 font-[inherit] text-[13px] text-ink-2">{body}</pre>}
          <div>
            <div className="mb-1 px-1 text-[12px] font-medium text-faint">
              {detail.files.length} file{detail.files.length === 1 ? '' : 's'} changed{detail.parents.length > 1 ? ' (against the first parent)' : ''}
            </div>
            <ul className="max-h-[220px] overflow-y-auto">
              {detail.files.map((f) => (
                <li key={f.path}>
                  <button onClick={() => setFile(file?.path === f.path ? null : f)} className={cx('flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-hover', file?.path === f.path && 'bg-hover')} title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}>
                    <span className={cx('w-4 shrink-0 text-center font-mono text-[11.5px] font-semibold', TONE[f.change])}>{LETTER[f.change]}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">{f.path}</span>
                    {f.additions === null ? (
                      <span className="text-[11px] text-faint">binary</span>
                    ) : (
                      <span className="shrink-0 font-mono text-[11px]">
                        <span className="text-ok">+{f.additions}</span> <span className="text-bad">−{f.deletions}</span>
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
          {file && !diff && (
            <div className="flex items-center gap-2 text-[13px] text-muted">
              <Loader2 size={14} className="animate-spin" /> Loading diff…
            </div>
          )}
          {file && diff && (diff.binary ? <p className="text-[13px] text-muted">Binary file, no text diff.</p> : !diff.text.trim() ? <p className="text-[13px] text-muted">No textual changes.</p> : <DiffText text={diff.text} />)}
          {diff?.truncated && <p className="text-[12px] text-faint">The diff is long, so only the start is shown.</p>}
        </div>
      )}
    </Modal>
  );
}
