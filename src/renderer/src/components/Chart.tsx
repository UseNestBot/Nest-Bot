import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChartNoAxesColumn, Table2 } from 'lucide-react';
import { formatValue, niceTicks, parseChart, type ChartSpec } from '@shared/chart';
import { Tooltip } from './ui';

// Charts that agents write as ```chart blocks. Every chart shares one card, one
// type scale and the --nest-series-* palette, so whatever the model asks for it
// looks like part of Nest rather than a pasted image.

const color = (i: number) => `var(--nest-series-${(i % 6) + 1})`;
const PLOT_H = 168;

export function ChartBlock({ source, streaming }: { source: string; streaming: boolean }) {
  const parsed = useMemo(() => parseChart(source), [source]);
  const [table, setTable] = useState(false);

  if (!parsed.ok) {
    // A half-written block is normal while the reply streams in.
    if (streaming) {
      return (
        <div className="chart-card">
          <div className="flex h-[200px] items-center justify-center gap-2 text-[12.5px] text-faint">
            <ChartNoAxesColumn size={15} className="animate-pulse" /> Drawing chart…
          </div>
        </div>
      );
    }
    return (
      <div className="chart-card">
        <div className="mb-2 text-[12.5px] text-muted">Couldn’t draw this chart: {parsed.error}</div>
        <pre className="!mb-0 max-h-48">
          <code>{source}</code>
        </pre>
      </div>
    );
  }

  const spec = parsed.spec;
  return (
    <figure className="chart-card group/chart">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {spec.title && <div className="text-[14.5px] font-semibold leading-snug text-ink">{spec.title}</div>}
          {spec.subtitle && <div className="mt-0.5 text-[12.5px] leading-snug text-muted">{spec.subtitle}</div>}
        </div>
        <Tooltip label={table ? 'Show chart' : 'Show data'} align="end">
          <button
            onClick={() => setTable((t) => !t)}
            className={`-mr-1 -mt-0.5 rounded-md p-1 text-faint transition-opacity hover:bg-hover hover:text-ink focus-visible:opacity-100 ${table ? 'opacity-100' : 'opacity-0 group-hover/chart:opacity-100'}`}
            aria-label={table ? 'Show chart' : 'Show data'}
          >
            {table ? <ChartNoAxesColumn size={14} /> : <Table2 size={14} />}
          </button>
        </Tooltip>
      </div>
      {spec.series.length > 1 && spec.type !== 'donut' && !table && <Legend spec={spec} />}
      <div className="mt-3">
        {table ? (
          <DataTable spec={spec} />
        ) : spec.type === 'donut' ? (
          <Donut spec={spec} />
        ) : spec.type === 'hbar' ? (
          <HBars spec={spec} />
        ) : (
          <Measured>{(width) => <XYChart spec={spec} width={width} />}</Measured>
        )}
      </div>
      {spec.note && <figcaption className="mt-2.5 text-[11.5px] leading-snug text-muted">{spec.note}</figcaption>}
    </figure>
  );
}

function Legend({ spec }: { spec: ChartSpec }) {
  const line = spec.type === 'line';
  return (
    <div className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1 text-[12px] text-ink-2">
      {spec.series.map((s, i) => (
        <span key={i} className="inline-flex items-center gap-1.5">
          <span className={line ? 'h-[2px] w-3 rounded-full' : 'size-2 rounded-[3px]'} style={{ background: color(i) }} />
          {s.name}
        </span>
      ))}
    </div>
  );
}

function Measured({ children }: { children: (width: number) => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className="relative" style={{ height: PLOT_H }}>
      {width > 0 && children(width)}
    </div>
  );
}

function HoverCard({ x, gap, width, title, rows }: { x: number; gap: number; width: number; title: string; rows: Array<{ i: number; name: string; value: string }> }) {
  const right = x > width / 2;
  return (
    <div
      className="pointer-events-none absolute top-1 z-10 min-w-[120px] rounded-[10px] border border-line bg-panel px-2.5 py-1.5 text-[12px] shadow-pop"
      style={right ? { right: width - x + gap } : { left: x + gap }}
    >
      <div className="mb-0.5 text-muted">{title}</div>
      {rows.map((r) => (
        <div key={r.i} className="flex items-center gap-1.5 leading-[1.55]">
          <span className="size-2 shrink-0 rounded-[3px]" style={{ background: color(r.i) }} />
          {rows.length > 1 && <span className="truncate text-ink-2">{r.name}</span>}
          <span className="ml-auto pl-3 font-medium tabular-nums text-ink">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

/** Line, area and column charts share an x axis of labels and a y axis of values. */
function XYChart({ spec, width }: { spec: ChartSpec; width: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const n = spec.labels.length;
  const isBar = spec.type === 'bar';
  const stacked = spec.stacked;

  const { ticks, lo, hi } = useMemo(() => {
    const values: number[] = [];
    for (let i = 0; i < n; i++) {
      if (stacked) {
        let pos = 0;
        let neg = 0;
        for (const s of spec.series) {
          const v = s.data[i] ?? 0;
          if (v >= 0) pos += v;
          else neg += v;
        }
        values.push(pos, neg);
      } else for (const s of spec.series) if (s.data[i] !== null) values.push(s.data[i]!);
    }
    let min = Math.min(...values);
    let max = Math.max(...values);
    // Bars and areas measure from zero; a line may zoom in on its range.
    if (spec.type !== 'line') {
      min = Math.min(0, min);
      max = Math.max(0, max);
    }
    const t = niceTicks(min, max, 4);
    return { ticks: t, lo: t[0], hi: t[t.length - 1] };
  }, [spec, n, stacked]);

  const top = spec.markers.length ? 22 : 8;
  const bottom = 22;
  const plotH = PLOT_H - top - bottom;
  const y = (v: number) => top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
  const step = ticks[1] - ticks[0];
  const fmt = (v: number) => formatValue(v, spec, step);
  // Value labels get a right-aligned gutter so they never collide with the data.
  const left = Math.ceil(Math.max(...ticks.map((t) => fmt(t).length)) * 6 + 10);
  const plotW = Math.max(40, width - left);
  const band = plotW / n;
  const x = (i: number) => left + (isBar ? band * (i + 0.5) : n === 1 ? plotW / 2 : 4 + (i / (n - 1)) * (plotW - 8));

  // Show as many x labels as fit without colliding.
  const longest = Math.max(...spec.labels.map((l) => l.length));
  const fit = Math.max(2, Math.floor(plotW / (longest * 6.4 + 18)));
  const every = Math.max(1, Math.ceil(n / fit));
  const xLabels = spec.labels
    .map((l, i) => ({ l, i }))
    .filter(({ i }) => (isBar ? i % every === 0 : i % every === 0 && (i === n - 1 || n - 1 - i >= every * 0.6)) || (!isBar && i === n - 1));

  const pick = (clientX: number, rect: DOMRect) => {
    const px = clientX - rect.left - left;
    const i = isBar ? Math.floor(px / band) : Math.round(((px - 4) / (plotW - 8)) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  const zero = y(Math.max(lo, Math.min(hi, 0)));
  const hoverRows =
    hover === null
      ? []
      : spec.series.map((s, i) => ({ i, name: s.name, value: s.data[hover] === null ? '–' : formatValue(s.data[hover]!, spec) })).filter((r) => spec.series[r.i].data[hover!] !== null || spec.series.length > 1);

  return (
    <>
      <svg width={width} height={PLOT_H} className="block overflow-visible" onPointerMove={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())} onPointerLeave={() => setHover(null)} role="img" aria-label={spec.title || 'Chart'}>
        {ticks.map((t) => (
          <line key={t} x1={left} x2={width} y1={y(t)} y2={y(t)} stroke={t === 0 && lo < 0 ? 'var(--nest-line-strong)' : 'var(--nest-line)'} strokeWidth={1} shapeRendering="crispEdges" />
        ))}

        {hover !== null &&
          (isBar ? (
            <rect x={left + band * hover} y={top} width={band} height={plotH} fill="var(--nest-hover)" />
          ) : (
            <line x1={x(hover)} x2={x(hover)} y1={top} y2={top + plotH} stroke="var(--nest-line-strong)" strokeWidth={1} />
          ))}

        {spec.markers.map((m, k) => (
          <g key={k}>
            <line x1={x(m.index)} x2={x(m.index)} y1={top - 4} y2={top + plotH} stroke="var(--nest-faint)" strokeWidth={1} strokeDasharray="3 3" />
            <text x={x(m.index)} y={top - 9} textAnchor={x(m.index) > width - 60 ? 'end' : x(m.index) < left + 60 ? 'start' : 'middle'} className="chart-marker">
              {m.label}
            </text>
          </g>
        ))}

        {isBar ? <Bars spec={spec} left={left} band={band} y={y} zero={zero} /> : <Lines spec={spec} x={x} y={y} zero={zero} hover={hover} />}

        {ticks.map((t) => (
          <text key={t} x={left - 8} y={y(t) + 3.5} textAnchor="end" className="chart-tick">
            {fmt(t)}
          </text>
        ))}

        {xLabels.map(({ l, i }) => (
          <text key={i} x={x(i)} y={PLOT_H - 6} textAnchor={isBar ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} className="chart-tick">
            {l}
          </text>
        ))}
      </svg>
      {hover !== null && hoverRows.length > 0 && <HoverCard x={x(hover)} gap={isBar ? band / 2 + 4 : 10} width={width} title={spec.labels[hover]} rows={hoverRows} />}
    </>
  );
}

function Lines({ spec, x, y, zero, hover }: { spec: ChartSpec; x: (i: number) => number; y: (v: number) => number; zero: number; hover: number | null }) {
  const area = spec.type === 'area';
  const n = spec.labels.length;
  // Stacked areas draw each series on top of the ones before it.
  const base = Array.from({ length: n }, () => 0);
  const layers = spec.series.map((s) => {
    const lower = [...base];
    const upper = s.data.map((v, i) => (spec.stacked ? lower[i] + (v ?? 0) : (v ?? NaN)));
    if (spec.stacked) upper.forEach((v, i) => (base[i] = v));
    return { lower, upper };
  });

  return (
    <>
      {layers.map(({ lower, upper }, si) => {
        const segments: Array<Array<number>> = [];
        let cur: number[] = [];
        upper.forEach((v, i) => {
          if (Number.isNaN(v)) {
            if (cur.length) segments.push(cur);
            cur = [];
          } else cur.push(i);
        });
        if (cur.length) segments.push(cur);
        return (
          <g key={si}>
            {segments.map((seg, k) => {
              const line = seg.map((i, j) => `${j ? 'L' : 'M'}${x(i)},${y(upper[i])}`).join('');
              const fill = area
                ? `${line}${[...seg]
                    .reverse()
                    .map((i) => `L${x(i)},${spec.stacked ? y(lower[i]) : zero}`)
                    .join('')}Z`
                : null;
              return (
                <g key={k}>
                  {fill && <path d={fill} fill={color(si)} fillOpacity={spec.stacked ? 0.22 : 0.12} />}
                  <path d={line} fill="none" stroke={color(si)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                  {seg.length === 1 && <circle cx={x(seg[0])} cy={y(upper[seg[0]])} r={3} fill={color(si)} />}
                </g>
              );
            })}
          </g>
        );
      })}
      {hover !== null && (
        <g>
          {layers.map(({ upper }, si) =>
            Number.isNaN(upper[hover]) ? null : <circle key={si} cx={x(hover)} cy={y(upper[hover])} r={4} fill={color(si)} stroke="var(--nest-panel)" strokeWidth={2} />,
          )}
        </g>
      )}
    </>
  );
}

/** A column with a 4px rounded data end and a square foot on the baseline. */
function column(x: number, w: number, from: number, to: number, round: boolean): string {
  const h = Math.abs(to - from);
  const r = round ? Math.min(4, w / 2, h) : 0;
  if (to <= from) return `M${x},${from}V${to + r}Q${x},${to} ${x + r},${to}H${x + w - r}Q${x + w},${to} ${x + w},${to + r}V${from}Z`;
  return `M${x},${from}V${to - r}Q${x},${to} ${x + r},${to}H${x + w - r}Q${x + w},${to} ${x + w},${to - r}V${from}Z`;
}

function Bars({ spec, left, band, y, zero }: { spec: ChartSpec; left: number; band: number; y: (v: number) => number; zero: number }) {
  const k = spec.stacked ? 1 : spec.series.length;
  const gap = 2;
  const w = Math.max(2, Math.min(24, (band * 0.72 - gap * (k - 1)) / k));
  const groupW = w * k + gap * (k - 1);
  return (
    <>
      {spec.labels.map((_, i) => {
        const x0 = left + band * i + (band - groupW) / 2;
        if (spec.stacked) {
          let pos = 0;
          let neg = 0;
          const segs = spec.series.map((s, si) => {
            const v = s.data[i] ?? 0;
            const from = v >= 0 ? pos : neg;
            const to = from + v;
            if (v >= 0) pos = to;
            else neg = to;
            return { si, from, to, v };
          });
          const lastPos = segs.filter((s) => s.v > 0).pop()?.si;
          const lastNeg = segs.filter((s) => s.v < 0).pop()?.si;
          return (
            <g key={i}>
              {segs.map(({ si, from, to, v }) => {
                if (!v) return null;
                // The 2px surface gap separates stacked segments.
                const a = y(from) + (from === 0 ? 0 : v > 0 ? -gap / 2 : gap / 2);
                const b = y(to) + (v > 0 ? gap / 2 : -gap / 2) * (si === (v > 0 ? lastPos : lastNeg) ? 0 : 1);
                return <path key={si} d={column(x0, w, a, b, si === (v > 0 ? lastPos : lastNeg))} fill={color(si)} />;
              })}
            </g>
          );
        }
        return (
          <g key={i}>
            {spec.series.map((s, si) => {
              const v = s.data[i];
              if (v === null || v === 0) return null;
              return <path key={si} d={column(x0 + si * (w + gap), w, zero, y(v), true)} fill={color(si)} />;
            })}
          </g>
        );
      })}
    </>
  );
}

/** Horizontal bars are laid out in HTML so long category names truncate cleanly. */
function HBars({ spec }: { spec: ChartSpec }) {
  const [hover, setHover] = useState<number | null>(null);
  const totals = spec.labels.map((_, i) => (spec.stacked ? spec.series.reduce((a, s) => a + Math.max(0, s.data[i] ?? 0), 0) : Math.max(0, ...spec.series.map((s) => s.data[i] ?? 0))));
  const max = Math.max(...totals) || 1;
  const multi = spec.series.length > 1 && !spec.stacked;
  return (
    <div className="grid grid-cols-[minmax(0,34%)_1fr] items-center gap-x-3 gap-y-1.5 text-[12.5px]" onPointerLeave={() => setHover(null)}>
      {spec.labels.map((label, i) => (
        <div key={i} className="contents" onPointerEnter={() => setHover(i)}>
          <div className={`truncate ${hover === i ? 'text-ink' : 'text-ink-2'}`} title={label}>
            {label}
          </div>
          <div className="relative flex min-w-0 flex-col gap-[2px]">
            {(spec.stacked ? [null] : spec.series.map((_, si) => si)).map((si) => (
              <div key={si ?? 'stack'} className="flex min-w-0 items-center gap-2">
                <div className="flex gap-[2px]" style={{ width: `calc((100% - 56px) * ${(si === null ? totals[i] : Math.max(0, spec.series[si].data[i] ?? 0)) / max})`, minWidth: 2 }}>
                  {(si === null ? spec.series.map((_, k) => k) : [si]).map((k, j, all) => {
                    const v = Math.max(0, spec.series[k].data[i] ?? 0);
                    const share = si === null ? v / (totals[i] || 1) : 1;
                    if (!v && si === null) return null;
                    return <div key={k} className={`${multi ? 'h-2' : 'h-3.5'} ${j === all.length - 1 ? 'rounded-r-[4px]' : ''}`} style={{ flexGrow: share, flexBasis: 0, minWidth: 2, background: color(k), opacity: hover === null || hover === i ? 1 : 0.55 }} />;
                  })}
                </div>
                <span className={`shrink-0 tabular-nums ${multi ? 'text-[11px]' : ''} text-ink-2`}>{formatValue(si === null ? totals[i] : (spec.series[si].data[i] ?? 0), spec)}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Donut({ spec }: { spec: ChartSpec }) {
  const [hover, setHover] = useState<number | null>(null);
  // Past five slices the tail folds into "Other" rather than inventing new colours.
  const raw = spec.labels.map((label, i) => ({ label, value: Math.max(0, spec.series[0].data[i] ?? 0), c: color(i) })).filter((s) => s.value > 0);
  const sorted = raw.length > 6 ? [...raw].sort((a, b) => b.value - a.value) : raw;
  const slices = sorted.length > 6 ? [...sorted.slice(0, 5).map((s, i) => ({ ...s, c: color(i) })), { label: 'Other', value: sorted.slice(5).reduce((a, s) => a + s.value, 0), c: 'var(--nest-faint)' }] : sorted;
  const total = slices.reduce((a, s) => a + s.value, 0);

  const size = 136;
  const r = 56;
  const stroke = 18;
  const circ = 2 * Math.PI * r;
  let acc = 0;
  const shown = hover === null ? null : slices[hover];

  return (
    <div className="flex items-center gap-5" onPointerLeave={() => setHover(null)}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0" role="img" aria-label={spec.title || 'Chart'}>
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          {slices.map((s, i) => {
            const len = (s.value / total) * circ;
            // The 2px surface gap between slices.
            const gap = slices.length > 1 ? Math.min(2, len / 2) : 0;
            const el = (
              <circle
                key={i}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={s.c}
                strokeWidth={hover === i ? stroke + 4 : stroke}
                strokeDasharray={`${Math.max(0, len - gap)} ${circ}`}
                strokeDashoffset={-acc}
                opacity={hover === null || hover === i ? 1 : 0.45}
                onPointerEnter={() => setHover(i)}
                style={{ transition: 'opacity 120ms, stroke-width 120ms' }}
              />
            );
            acc += len;
            return el;
          })}
        </g>
        <text x={size / 2} y={size / 2 - 2} textAnchor="middle" className="chart-donut-value">
          {shown ? `${Math.round((shown.value / total) * 100)}%` : formatValue(total, spec)}
        </text>
        <text x={size / 2} y={size / 2 + 15} textAnchor="middle" className="chart-tick">
          {shown ? truncate(shown.label, 16) : 'Total'}
        </text>
      </svg>
      <div className="flex min-w-0 flex-1 flex-col gap-1 text-[12.5px]">
        {slices.map((s, i) => (
          <div key={i} className={`flex min-w-0 items-center gap-2 rounded-md ${hover === i ? 'text-ink' : 'text-ink-2'}`} onPointerEnter={() => setHover(i)}>
            <span className="size-2 shrink-0 rounded-[3px]" style={{ background: s.c }} />
            <span className="truncate">{s.label}</span>
            <span className="ml-auto shrink-0 pl-2 tabular-nums text-muted">{formatValue(s.value, spec)}</span>
            <span className="w-9 shrink-0 text-right tabular-nums text-ink">{Math.round((s.value / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function DataTable({ spec }: { spec: ChartSpec }) {
  return (
    <div className="max-h-[220px] overflow-auto">
      <table className="!m-0 w-full text-[12.5px]">
        <thead>
          <tr>
            <th />
            {spec.series.map((s, i) => (
              <th key={i} className="!text-right">
                {spec.series.length > 1 || spec.type === 'donut' ? s.name : 'Value'}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {spec.labels.map((l, i) => (
            <tr key={i}>
              <td>{l}</td>
              {spec.series.map((s, si) => (
                <td key={si} className="!text-right tabular-nums">
                  {s.data[i] === null ? '–' : formatValue(s.data[i]!, spec)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
