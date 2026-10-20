import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { compact } from '../lib/format';

// Categorical slots validated for the dark surface (#12151f) with the dataviz palette validator:
// blue, orange, aqua – all checks pass (CVD ΔE 9.4, normal-vision ΔE 26.5, >= 3:1 contrast).
export const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)'];

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(320);
  // Measure synchronously before paint so the SVG never renders wider than its container.
  useLayoutEffect(() => {
    if (!ref.current) return;
    setW(Math.max(260, ref.current.getBoundingClientRect().width));
    const ro = new ResizeObserver(([e]) => e && setW(Math.max(260, e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Max of an axis with four equal integer tick steps (7 -> 0/2/4/6/8, 230 -> 0/100/200/300/400). */
function niceMax(v: number): number {
  const raw = Math.max(1, v) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  return Math.max(4, Math.ceil(step) * 4);
}

export interface Series { key: string; label: string; values: number[] }

/** Multi-series line chart: one y-axis, hairline grid, 2px lines, crosshair tooltip, legend + end labels, table view. */
export function LineChart({ labels, series, height = 240, title }: { labels: string[]; series: Series[]; height?: number; title: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const pad = { l: 36, r: 76, t: 12, b: 26 };
  const max = useMemo(() => niceMax(Math.max(1, ...series.flatMap((s) => s.values))), [series]);
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const x = (i: number) => pad.l + (labels.length <= 1 ? iw / 2 : (i / (labels.length - 1)) * iw);
  const y = (v: number) => pad.t + ih - (v / max) * ih;
  const ticks = [0, max / 4, max / 2, (3 * max) / 4, max];
  const labelEvery = Math.max(1, Math.ceil(labels.length / Math.max(2, Math.floor(iw / 70))));

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientX - rect.left) / rect.width;
    setHover(Math.max(0, Math.min(labels.length - 1, Math.round(rel * (labels.length - 1)))));
  };

  // End labels: nudge apart so they never collide.
  const ends = series.map((s, i) => ({ i, y: y(s.values[s.values.length - 1] ?? 0) })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k++) if (ends[k]!.y - ends[k - 1]!.y < 14) ends[k]!.y = ends[k - 1]!.y + 14;
  const endY = new Map(ends.map((e) => [e.i, e.y]));

  return (
    <div className="chart" ref={ref}>
      <div className="chart-head">
        {series.length > 1 && (
          <ul className="legend" aria-label="Jelmagyarázat">
            {series.map((s, i) => <li key={s.key}><i style={{ background: SERIES[i] }} />{s.label}</li>)}
          </ul>
        )}
        <button className="btn ghost sm" onClick={() => setTable((t) => !t)} aria-pressed={table}>{table ? 'Grafikon' : 'Táblázat'}</button>
      </div>
      {table ? (
        <div className="table-wrap"><table>
          <caption className="sr-only">{title}</caption>
          <thead><tr><th>Nap</th>{series.map((s) => <th key={s.key}>{s.label}</th>)}</tr></thead>
          <tbody>{labels.map((l, i) => <tr key={l}><td>{l}</td>{series.map((s) => <td key={s.key}>{s.values[i]}</td>)}</tr>)}</tbody>
        </table></div>
      ) : (
        <svg width={width} height={height} role="img" aria-label={title}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={pad.l + iw} y1={y(t)} y2={y(t)} className="gridline" />
              <text x={pad.l - 8} y={y(t) + 4} className="axis" textAnchor="end">{compact(Math.round(t))}</text>
            </g>
          ))}
          {labels.map((l, i) => (i % labelEvery === 0 || i === labels.length - 1 ? (
            <text key={l} x={x(i)} y={height - 6} className="axis" textAnchor="middle">{l.slice(5)}</text>
          ) : null))}
          {series.map((s, si) => (
            <g key={s.key}>
              <path d={`M${s.values.map((v, i) => `${x(i)},${y(v)}`).join('L')}L${x(s.values.length - 1)},${y(0)}L${x(0)},${y(0)}Z`} fill={SERIES[si]} opacity={0.08} />
              <polyline points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')} fill="none" stroke={SERIES[si]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              <circle cx={x(s.values.length - 1)} cy={y(s.values[s.values.length - 1] ?? 0)} r={4} fill={SERIES[si]} stroke="var(--panel)" strokeWidth={2} />
              {series.length <= 4 && (
                <text x={x(s.values.length - 1) + 9} y={(endY.get(si) ?? 0) + 4} className="end-label">{s.values[s.values.length - 1]} {series.length > 1 ? s.label.toLowerCase() : ''}</text>
              )}
            </g>
          ))}
          {hover !== null && (
            <g pointerEvents="none">
              <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} className="crosshair" />
              {series.map((s, si) => <circle key={s.key} cx={x(hover)} cy={y(s.values[hover] ?? 0)} r={4.5} fill={SERIES[si]} stroke="var(--panel)" strokeWidth={2} />)}
            </g>
          )}
          <rect x={pad.l} y={pad.t} width={iw} height={ih} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
        </svg>
      )}
      {hover !== null && !table && (
        <div className="tooltip" style={{ left: Math.min(width - 170, Math.max(0, x(hover) + 12)), top: 34 }}>
          <div className="tooltip-title">{labels[hover]}</div>
          {series.map((s, si) => (
            <div key={s.key} className="tooltip-row"><i style={{ background: SERIES[si] }} /><span>{s.label}</span><b>{s.values[hover]}</b></div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Horizontal bar list for ranked categories: one hue, value at the bar tip, hover title. */
export function BarList({ items, emptyText = 'Nincs adat.' }: { items: { label: React.ReactNode; key: string; value: number; sub?: string }[]; emptyText?: string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  if (!items.length) return <div className="muted small">{emptyText}</div>;
  return (
    <ul className="barlist">
      {items.map((i) => (
        <li key={i.key} title={`${typeof i.label === 'string' ? i.label : i.key}: ${i.value}${i.sub ? ` (${i.sub})` : ''}`}>
          <div className="barlist-label">{i.label}</div>
          <div className="barlist-track"><i style={{ width: `${(i.value / max) * 100}%` }} /></div>
          <div className="barlist-value">{i.value}{i.sub && <span className="muted small"> {i.sub}</span>}</div>
        </li>
      ))}
    </ul>
  );
}
