import { describe, expect, it } from 'vitest';
import { formatValue, niceTicks, parseChart } from '../src/shared/chart';

describe('chart specs', () => {
  it('parses a line chart and resolves markers by label', () => {
    const r = parseChart(JSON.stringify({ type: 'line', title: 'T', labels: ['a', 'b', 'c'], series: [{ name: 'S', data: [1, '2', null] }], markers: [{ at: 'b', label: 'v2' }] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.series[0].data).toEqual([1, 2, null]);
    expect(r.spec.markers).toEqual([{ index: 1, label: 'v2' }]);
  });

  it('accepts the bare data shorthand and pads labels', () => {
    const r = parseChart('{"type":"bar","data":[3,4]}');
    expect(r.ok && r.spec.labels).toEqual(['1', '2']);
  });

  it('rejects bad input with a reason instead of throwing', () => {
    expect(parseChart('{"type":"line","series":[').ok).toBe(false);
    expect(parseChart('{"type":"radar","data":[1]}')).toEqual({ ok: false, error: 'Unknown chart type "radar".' });
    expect(parseChart('{"type":"donut","data":[1,-2]}').ok).toBe(false);
  });

  it('caps series and only stacks types that can stack', () => {
    const series = Array.from({ length: 9 }, (_, i) => ({ name: `s${i}`, data: [i + 1] }));
    const r = parseChart(JSON.stringify({ type: 'line', stacked: true, series }));
    expect(r.ok && r.spec.series.length).toBe(6);
    expect(r.ok && r.spec.stacked).toBe(false);
  });

  it('picks clean ticks and compact labels', () => {
    expect(niceTicks(24.1, 33.6)).toEqual([20, 25, 30, 35]);
    expect(niceTicks(0, 1284)).toEqual([0, 500, 1000, 1500]);
    expect(formatValue(12900, { prefix: '$', unit: '' })).toBe('$12.9K');
    expect(formatValue(33.6, { prefix: '', unit: '%' })).toBe('33.6%');
    expect(formatValue(-4.2e6, { prefix: '$', unit: '' })).toBe('-$4.2M');
    expect(formatValue(2, { prefix: '', unit: 'ms' }, 0.5)).toBe('2.0 ms');
  });
});
