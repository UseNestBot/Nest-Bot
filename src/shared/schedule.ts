import type { ScheduleCadence } from './types';

function parseTime(time: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return [9, 0];
  return [Math.min(23, Number(m[1])), Math.min(59, Number(m[2]))];
}

/** Next local time strictly after `from` at which the cadence fires. */
export function computeNextRun(cadence: ScheduleCadence, from: Date): Date {
  if (cadence.kind === 'interval') return new Date(from.getTime() + Math.max(5, cadence.minutes) * 60_000);
  const [h, min] = parseTime(cadence.time);
  const candidate = new Date(from);
  candidate.setHours(h, min, 0, 0);
  if (candidate <= from) candidate.setDate(candidate.getDate() + 1);
  for (let i = 0; i < 8; i++) {
    const day = candidate.getDay();
    if (cadence.kind === 'daily') break;
    if (cadence.kind === 'weekdays' && day >= 1 && day <= 5) break;
    if (cadence.kind === 'weekly' && day === cadence.weekday) break;
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function describeCadence(c: ScheduleCadence): string {
  switch (c.kind) {
    case 'daily':
      return `Every day at ${c.time}`;
    case 'weekdays':
      return `Weekdays at ${c.time}`;
    case 'weekly':
      return `Every ${DAYS[c.weekday] ?? 'week'} at ${c.time}`;
    case 'interval':
      return c.minutes % 60 === 0 ? `Every ${c.minutes / 60} hour${c.minutes === 60 ? '' : 's'}` : `Every ${c.minutes} minutes`;
  }
}

/** Validate untrusted cadence input (from the renderer or an agent tool call). */
export function sanitizeCadence(raw: unknown): ScheduleCadence {
  const c = (raw ?? {}) as Record<string, unknown>;
  const time = typeof c.time === 'string' && /^\d{1,2}:\d{2}$/.test(c.time) ? c.time.padStart(5, '0') : '09:00';
  switch (c.kind) {
    case 'weekdays':
      return { kind: 'weekdays', time };
    case 'weekly':
      return { kind: 'weekly', time, weekday: Math.min(6, Math.max(0, Math.round(Number(c.weekday) || 1))) };
    case 'interval':
      return { kind: 'interval', minutes: Math.min(7 * 24 * 60, Math.max(15, Math.round(Number(c.minutes) || 60))) };
    default:
      return { kind: 'daily', time };
  }
}
