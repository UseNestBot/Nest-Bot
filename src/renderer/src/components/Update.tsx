import { useEffect, useState } from 'react';
import { ArrowDownToLine, RefreshCw, Sparkles } from 'lucide-react';
import type { UpdateState } from '@shared/types';
import { versionLabel } from '@shared/build';
import { api } from '../api';
import { formatBytes } from '../format';
import { Button, cx } from './ui';

/** Live updater state from the main process. */
export function useUpdate(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    let live = true;
    void api.getUpdateState().then((s) => live && setState(s)).catch(() => {});
    const off = api.onEvent((e) => {
      if (e.type === 'update') setState(e.state);
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  return state;
}

const install = () => void api.installUpdate().catch(() => {});

function percent(received: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
}

/**
 * Sidebar card shown while an update downloads and once it's ready. Installing is
 * silent: Nest closes, the installer runs without a window, and Nest reopens.
 */
export function UpdateCard() {
  const state = useUpdate();
  if (!state || (state.status !== 'downloading' && state.status !== 'ready')) return null;
  const ready = state.status === 'ready';
  const pct = ready ? 100 : percent(state.received, state.total);
  return (
    <div className="fade-in mx-2 mb-2 overflow-hidden rounded-2xl border border-line bg-panel p-3 shadow-[0_1px_2px_rgba(0,0,0,0.06)]">
      <div className="flex items-start gap-2.5">
        <span className={cx('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full', ready ? 'bg-accent text-white' : 'bg-active text-ink-2')}>
          {ready ? <Sparkles size={14} /> : <ArrowDownToLine size={14} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-ink">{ready ? 'Update ready' : 'Downloading update'}</div>
          <div className="truncate text-[12px] text-muted">
            {state.release.label}
            {!ready && state.total > 0 && ` · ${pct}%`}
          </div>
        </div>
      </div>
      {ready ? (
        <Button variant="primary" size="sm" onClick={install} className="mt-2.5 w-full">
          <RefreshCw size={13} /> Restart to update
        </Button>
      ) : (
        <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-active" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Update download">
          <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

/** Status line + action for Settings → About. */
export function UpdateStatus() {
  const state = useUpdate();
  if (!state) return <span className="text-[13px] text-muted">—</span>;
  switch (state.status) {
    case 'unsupported':
      return <span className="max-w-[320px] text-right text-[12.5px] text-muted">{state.reason}</span>;
    case 'checking':
      return (
        <Button size="sm" disabled>
          <RefreshCw size={13} className="animate-spin" /> Checking…
        </Button>
      );
    case 'downloading': {
      const pct = percent(state.received, state.total);
      return (
        <div className="flex w-[220px] flex-col items-end gap-1.5">
          <span className="text-[12.5px] text-ink-2">
            Downloading {state.release.label} · {formatBytes(state.received)}
            {state.total ? ` of ${formatBytes(state.total)}` : ''}
          </span>
          <div className="h-1 w-full overflow-hidden rounded-full bg-active">
            <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${pct}%` }} />
          </div>
        </div>
      );
    }
    case 'ready':
      return (
        <Button variant="primary" size="sm" onClick={install}>
          <RefreshCw size={13} /> Restart to install {state.release.label}
        </Button>
      );
    case 'idle':
    case 'error':
      return (
        <div className="flex items-center gap-3">
          <span className={cx('max-w-[260px] text-right text-[12.5px]', state.status === 'error' ? 'text-bad' : 'text-muted')}>
            {state.status === 'error' ? state.message : state.checkedAt ? `${versionLabel()} is the latest` : ''}
          </span>
          <Button size="sm" onClick={() => void api.checkForUpdates().catch(() => {})}>
            Check for updates
          </Button>
        </div>
      );
  }
}
