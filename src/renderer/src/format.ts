import type { ConnectionState, ProviderStatus } from '@shared/types';

export function relativeTime(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Calendar days between two timestamps in local time (0 = same day). */
function daysBetween(ts: number, now: number): number {
  const a = new Date(ts);
  a.setHours(0, 0, 0, 0);
  const b = new Date(now);
  b.setHours(0, 0, 0, 0);
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

const clock = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** Sidebar style: "7:34 PM", "Yesterday", "Tuesday", "Oct 3". */
export function listTime(ts: number, now = Date.now()): string {
  const days = daysBetween(ts, now);
  if (days <= 0) return clock(ts);
  if (days === 1) return 'Yesterday';
  if (days < 7) return new Date(ts).toLocaleDateString(undefined, { weekday: 'long' });
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Centered transcript separators: "9:41 AM", "Yesterday 9:41 AM", "Tuesday 9:41 AM", "Oct 3, 9:41 AM". */
export function stampTime(ts: number, now = Date.now()): string {
  const days = daysBetween(ts, now);
  if (days <= 0) return clock(ts);
  if (days === 1) return `Yesterday ${clock(ts)}`;
  if (days < 7) return `${new Date(ts).toLocaleDateString(undefined, { weekday: 'long' })} ${clock(ts)}`;
  const sameYear = new Date(ts).getFullYear() === new Date(now).getFullYear();
  return `${new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric' })}, ${clock(ts)}`;
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function compactNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function folderName(p: string | null): string | null {
  if (!p) return null;
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export const STATE_LABEL: Record<ConnectionState, string> = {
  checking: 'Checking…',
  'not-installed': 'Not installed',
  'signed-out': 'Sign-in required',
  'api-key': 'API billing blocked',
  ready: 'Connected',
  error: 'Unavailable',
};

export function stateTone(status: ProviderStatus | undefined): 'ok' | 'warn' | 'bad' | 'idle' {
  if (!status || status.state === 'checking') return 'idle';
  if (status.state === 'ready') return status.rateLimited ? 'warn' : 'ok';
  if (status.state === 'signed-out' || status.state === 'api-key') return 'warn';
  return 'bad';
}

export function statusLabel(status: ProviderStatus | undefined): string {
  if (!status) return 'Checking…';
  if (status.state === 'ready' && status.rateLimited) return 'Rate limited';
  return STATE_LABEL[status.state];
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
