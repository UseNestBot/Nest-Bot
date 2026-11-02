/**
 * Charts in chat: an agent writes a ```chart fenced block holding JSON and the
 * renderer draws it as a card. This module is the contract: it turns whatever
 * the model wrote into a bounded, validated spec, or explains why it can't.
 */

export const CHART_TYPES = ['line', 'area', 'bar', 'hbar', 'donut'] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export const MAX_SERIES = 6;
const MAX_POINTS = 400;
const MAX_TEXT = 140;

export interface ChartSeries {
  name: string;
  data: Array<number | null>;
}

export interface ChartMarker {
  /** Index into labels. */
  index: number;
  label: string;
}

export interface ChartSpec {
  type: ChartType;
  title: string;
  subtitle: string;
  labels: string[];
  series: ChartSeries[];
  prefix: string;
  unit: string;
  stacked: boolean;
  markers: ChartMarker[];
  note: string;
}

export type ChartParse = { ok: true; spec: ChartSpec } | { ok: false; error: string };

function text(v: unknown, max = MAX_TEXT): string {
  if (typeof v === 'number') return String(v);
  if (typeof v !== 'string') return '';
  const t = v.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() ? Number(v.replace(/[,%$€£\s]/g, '')) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

export function parseChart(source: string): ChartParse {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return { ok: false, error: 'The chart data is not valid JSON.' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'The chart data must be a JSON object.' };
  const r = raw as Record<string, unknown>;

  const type = (typeof r.type === 'string' ? r.type.toLowerCase() : 'line') as ChartType;
  if (!CHART_TYPES.includes(type)) return { ok: false, error: `Unknown chart type "${text(r.type)}".` };

  let series: ChartSeries[] = (Array.isArray(r.series) ? r.series : [])
    .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === 'object')
    .map((s, i) => ({ name: text(s.name, 60) || `Series ${i + 1}`, data: (Array.isArray(s.data) ? s.data : []).slice(0, MAX_POINTS).map(num) }));
  // A bare "data" array is the common one-series shorthand.
  if (!series.length && Array.isArray(r.data)) series = [{ name: text(r.title, 60) || 'Value', data: r.data.slice(0, MAX_POINTS).map(num) }];
  series = series.filter((s) => s.data.some((v) => v !== null));
  if (!series.length) return { ok: false, error: 'The chart has no numeric data.' };
  if (type === 'donut') series = series.slice(0, 1);
  series = series.slice(0, MAX_SERIES);

  const length = Math.max(...series.map((s) => s.data.length));
  const given = Array.isArray(r.labels) ? r.labels.slice(0, MAX_POINTS).map((l) => text(l, 40)) : [];
  const labels = Array.from({ length }, (_, i) => given[i] ?? String(i + 1));
  for (const s of series) while (s.data.length < length) s.data.push(null);

  if (type === 'donut') {
    const d = series[0].data;
    if (d.some((v) => v !== null && v < 0)) return { ok: false, error: 'A donut chart cannot show negative values.' };
    if (!d.some((v) => (v ?? 0) > 0)) return { ok: false, error: 'The chart has no numeric data.' };
  }

  const markers: ChartMarker[] = (Array.isArray(r.markers) ? r.markers : [])
    .filter((m): m is Record<string, unknown> => Boolean(m) && typeof m === 'object')
    .map((m) => {
      const at = m.at ?? m.x;
      const index = typeof at === 'number' && Number.isInteger(at) && !labels.includes(String(at)) ? at : labels.indexOf(text(at, 40));
      return { index, label: text(m.label, 40) };
    })
    .filter((m) => m.index >= 0 && m.index < length)
    .slice(0, 4);

  return {
    ok: true,
    spec: {
      type,
      title: text(r.title),
      subtitle: text(r.subtitle),
      labels,
      series,
      prefix: text(r.prefix, 4),
      unit: text(r.unit, 12),
      stacked: r.stacked === true && (type === 'bar' || type === 'hbar' || type === 'area') && series.length > 1,
      markers: type === 'line' || type === 'area' || type === 'bar' ? markers : [],
      note: text(r.note, 200),
    },
  };
}

/** Round axis bounds and 3–5 ticks that land on clean numbers. */
export function niceTicks(min: number, max: number, target = 4): number[] {
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1;
    min -= pad;
    max += pad;
  }
  const rough = (max - min) / target;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= rough) ?? 10 * mag;
  const lo = Math.floor(min / step + 1e-9) * step;
  const hi = Math.ceil(max / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

/** 1,284 → 1.3K, keeping enough decimals to tell neighbouring ticks apart. */
export function formatValue(v: number, spec: Pick<ChartSpec, 'prefix' | 'unit'>, step?: number): string {
  const abs = Math.abs(v);
  let body: string;
  if (abs >= 1e9) body = `${trim(v / 1e9)}B`;
  else if (abs >= 1e6) body = `${trim(v / 1e6)}M`;
  else if (abs >= 1e4) body = `${trim(v / 1e3)}K`;
  else {
    const decimals = step !== undefined && step > 0 ? Math.min(3, Math.max(0, -Math.floor(Math.log10(step) + 1e-9))) : abs < 10 && abs % 1 ? 2 : abs % 1 ? 1 : 0;
    body = v.toLocaleString('en-US', { minimumFractionDigits: step !== undefined ? decimals : 0, maximumFractionDigits: decimals });
  }
  const sign = body.startsWith('-') ? '-' : '';
  const unit = spec.unit && !/^[%°]/.test(spec.unit) ? ` ${spec.unit}` : spec.unit;
  return `${sign}${spec.prefix}${body.replace(/^-/, '')}${unit}`;
}

function trim(n: number): string {
  return (Math.abs(n) >= 100 ? n.toFixed(0) : Math.abs(n) >= 10 ? n.toFixed(1) : n.toFixed(2)).replace(/\.?0+$/, '');
}
