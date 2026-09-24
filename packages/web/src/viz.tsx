import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useLang } from './i18n.tsx';

/**
 * The charts, hand-built: a few dozen lines of HTML and SVG each, against a
 * charting library that would be most of the bundle.
 *
 * Every chart follows the same contract. The marks are aria-hidden decoration
 * over a real table: the table is the accessible and the exact form, one
 * click away, so nothing is available only as a shape on a screen. Values are
 * direct-labelled at the bar tip, text wears text tokens and never the series
 * colour, and a mark grows from its baseline once, when it scrolls into view.
 * Under prefers-reduced-motion it is simply there.
 */

/** True once the element has been on screen. One-shot: a chart animates once, not on every scroll past. */
export function useInView<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element || seen) return;
    // No observer (or a test environment): show it rather than leave it at scale 0.
    if (typeof IntersectionObserver === 'undefined') return setSeen(true);

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setSeen(true);
          observer.disconnect();
        }
      },
      { threshold: 0.2 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [seen]);

  return [ref, seen];
}

export type Series = 'dense' | 'lexical' | 'hybrid' | 'rerank';

export const SERIES_LABEL: Record<Series, string> = {
  dense: 'Dense',
  lexical: 'BM25',
  hybrid: 'Hybrid (RRF)',
  rerank: 'Hybrid + rerank',
};

const SERIES_LABEL_IT: Record<Series, string> = {
  dense: 'Semantico',
  lexical: 'BM25',
  hybrid: 'Ibrido (RRF)',
  rerank: 'Ibrido + rerank',
};

export type Tone = Series | 'ink' | 'muted';

const fill: Record<Tone, string> = {
  ink: 'bg-ink',
  muted: 'bg-line-strong',
  dense: 'bg-dense',
  lexical: 'bg-lexical',
  hybrid: 'bg-hybrid',
  rerank: 'bg-rerank',
};

const index = (i: number) => ({ '--i': i }) as CSSProperties;

/** A chart with its title, a caption that says what to read off it, and its table. */
export function Figure({
  title,
  caption,
  table,
  legend,
  children,
}: {
  title: string;
  caption?: ReactNode;
  table: { head: string[]; rows: ReactNode[][] };
  legend?: Series[];
  children: ReactNode;
}) {
  const [ref, seen] = useInView<HTMLElement>();
  const { t } = useLang();

  return (
    <figure ref={ref} className={`min-w-0 rounded-2xl border border-line bg-paper p-5 ${seen ? 'viz-in' : ''}`}>
      <figcaption>
        <span className="block font-medium">{title}</span>
        {caption && <span className="mt-1 block max-w-[65ch] text-sm text-ink-2">{caption}</span>}
      </figcaption>
      {legend && legend.length > 1 && <Legend series={legend} />}
      <div aria-hidden="true" className="mt-4">
        {children}
      </div>
      <details className="mt-4 text-sm">
        <summary className="cursor-pointer text-ink-2 hover:text-ink">{t('Table view', 'Vista tabella')}</summary>
        <DataTable head={table.head} rows={table.rows} label={title} />
      </details>
    </figure>
  );
}

export function Legend({ series }: { series: Series[] }) {
  const { t } = useLang();
  return (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2" aria-label={t('Legend', 'Legenda')}>
      {series.map((name) => (
        <li key={name} className="flex items-center gap-1.5">
          <span className={`inline-block size-2.5 rounded-sm ${fill[name]}`} />
          {t(SERIES_LABEL[name], SERIES_LABEL_IT[name])}
        </li>
      ))}
    </ul>
  );
}

export function DataTable({ head, rows, label = 'Table' }: { head: string[]; rows: ReactNode[][]; label?: string }) {
  return (
    // Focusable because it can scroll sideways on a phone, and a region the
    // keyboard cannot reach cannot be scrolled without a pointer (2.1.1).
    <div className="mt-2 overflow-x-auto" tabIndex={0} role="region" aria-label={label}>
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-line-strong">
            {head.map((cell, i) => (
              <th key={cell} scope="col" className={`py-1.5 pr-3 font-medium ${i > 0 ? 'text-right' : ''}`}>
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, i) => (
                <td key={i} className={`py-1.5 pr-3 align-top ${i > 0 ? 'text-right font-mono text-xs tabular-nums' : ''}`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Horizontal bars, one series. The label sits above its bar rather than beside
 * it, so long chunk titles wrap instead of squeezing the plot on a phone.
 */
export function Bars({
  rows,
  series,
  format,
  max,
}: {
  rows: { label: ReactNode; value: number; note?: ReactNode; series?: Tone }[];
  series: Tone;
  format: (value: number) => string;
  max?: number;
}) {
  const top = max ?? Math.max(...rows.map((row) => row.value), Number.EPSILON);

  return (
    <ol className="space-y-2.5">
      {rows.map((row, i) => (
        <li key={i}>
          <div className="flex items-baseline gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate">{row.label}</span>
            {row.note && <span className="shrink-0 text-xs text-muted">{row.note}</span>}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <div className="h-3 flex-1">
              <div
                className={`grow-x h-3 rounded-r ${fill[row.series ?? series]}`}
                style={{ ...index(i), width: `${(row.value / top) * 100}%` }}
              />
            </div>
            <span className="w-16 shrink-0 text-right font-mono text-xs tabular-nums text-ink-2">
              {format(row.value)}
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Two-part stacked bars: how much of each total came from which source. */
export function StackedBars({
  rows,
  format,
}: {
  rows: { label: ReactNode; parts: { series: Series; value: number }[]; total: number }[];
  format: (value: number) => string;
}) {
  const top = Math.max(...rows.map((row) => row.total), Number.EPSILON);

  return (
    <ol className="space-y-2.5">
      {rows.map((row, i) => (
        <li key={i}>
          <span className="block truncate text-sm">{row.label}</span>
          <div className="mt-1 flex items-center gap-2">
            <div className="h-3 flex-1">
              <div className="grow-x flex h-3 gap-0.5" style={{ ...index(i), width: `${(row.total / top) * 100}%` }}>
                {row.parts
                  .filter((part) => part.value > 0)
                  .map((part, p, all) => (
                    <div
                      key={part.series}
                      className={`h-3 ${fill[part.series]} ${p === all.length - 1 ? 'rounded-r' : ''}`}
                      style={{ width: `${(part.value / row.total) * 100}%` }}
                    />
                  ))}
              </div>
            </div>
            <span className="w-16 shrink-0 text-right font-mono text-xs tabular-nums text-ink-2">
              {format(row.total)}
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Columns in groups: one group per category, one column per series, same order everywhere. */
export function GroupedColumns({
  groups,
  series,
  format,
}: {
  groups: { label: string; values: Record<Series, number> }[];
  series: Series[];
  format: (value: number) => string;
}) {
  const top = Math.max(...groups.flatMap((group) => series.map((name) => group.values[name])));
  let i = 0;

  return (
    <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${groups.length}, minmax(0, 1fr))` }}>
      {groups.map((group) => (
        <div key={group.label}>
          <div className="flex h-48 items-end justify-center gap-1 border-b border-line-strong">
            {series.map((name) => {
              const value = group.values[name];
              return (
                <div key={name} className="flex h-full w-full max-w-6 flex-col items-center justify-end">
                  <span className="mb-1 font-mono text-[10px] tabular-nums text-ink-2">{format(value)}</span>
                  <div
                    className={`grow-y w-full rounded-t ${fill[name]}`}
                    style={{ ...index(i++), height: `${(value / top) * 82}%` }}
                  />
                </div>
              );
            })}
          </div>
          <span className="mt-2 block text-center text-xs text-ink-2">{group.label}</span>
        </div>
      ))}
    </div>
  );
}

/** A 384-dimensional vector as a barcode around zero: the shape of a query in embedding space. */
export function VectorStrip({ vector }: { vector: number[] }) {
  const peak = Math.max(...vector.map(Math.abs), Number.EPSILON);
  const width = vector.length * 3;
  const mid = 40;

  return (
    <svg viewBox={`0 0 ${width} 80`} preserveAspectRatio="none" className="h-20 w-full" focusable="false">
      <line x1={0} x2={width} y1={mid} y2={mid} className="stroke-line-strong" strokeWidth={0.5} />
      {vector.map((v, i) => {
        const h = (Math.abs(v) / peak) * (mid - 2);
        return (
          <rect
            key={i}
            x={i * 3}
            y={v >= 0 ? mid - h : mid}
            width={2}
            height={Math.max(h, 0.5)}
            className="grow-y fill-dense"
            style={{
              transformOrigin: v >= 0 ? 'center bottom' : 'center top',
              animationDelay: `${i * 2}ms`,
            }}
          />
        );
      })}
    </svg>
  );
}

/**
 * Where the reranker moved each passage: fused rank on the left, final rank on
 * the right, a line for each of the eight it kept. Lines that climbed are
 * drawn in the rerank colour; the rest stay neutral, so the eye goes to the
 * moves that changed what the generator reads first.
 */
export function Slope({
  rows,
  fusedCount,
}: {
  rows: { label: string; from: number; to: number }[];
  fusedCount: number;
}) {
  const { t } = useLang();
  const height = 280;
  const left = 56;
  const right = 280;
  const y = (rank: number, count: number) => 28 + ((rank - 1) / Math.max(count - 1, 1)) * (height - 40);

  return (
    <div className="grid gap-4 sm:grid-cols-[minmax(0,320px)_1fr]">
      <svg viewBox={`0 0 ${right + 24} ${height}`} className="w-full max-w-[320px]" focusable="false">
        <text x={left} y={10} textAnchor="middle" className="fill-muted text-[10px]">
          {t('fused', 'fusi')}
        </text>
        <text x={right} y={10} textAnchor="middle" className="fill-muted text-[10px]">
          {t('final', 'finali')}
        </text>
        <line x1={left} x2={left} y1={28} y2={height - 12} className="stroke-line" />
        <line x1={right} x2={right} y1={28} y2={height - 12} className="stroke-line" />
        {rows.map((row, i) => {
          const y1 = y(row.from, fusedCount);
          const y2 = y(row.to, rows.length);
          const climbed = row.from > row.to;
          return (
            <g key={row.label + i}>
              <path
                d={`M ${left} ${y1} C ${(left + right) / 2} ${y1}, ${(left + right) / 2} ${y2}, ${right} ${y2}`}
                pathLength={1}
                fill="none"
                strokeWidth={2}
                strokeLinecap="round"
                className={`draw ${climbed ? 'stroke-rerank' : 'stroke-line-strong'}`}
                style={index(i)}
              />
              <circle cx={left} cy={y1} r={4} className="fill-hybrid stroke-paper" strokeWidth={2} />
              <circle cx={right} cy={y2} r={4} className="fill-rerank stroke-paper" strokeWidth={2} />
              <text x={left - 8} y={y1 + 3} textAnchor="end" className="fill-ink-2 font-mono text-[10px]">
                #{row.from}
              </text>
              <text x={right + 8} y={y2 + 3} className="fill-ink-2 font-mono text-[10px]">
                #{row.to}
              </text>
            </g>
          );
        })}
      </svg>
      <ol className="space-y-1.5 text-sm">
        {rows.map((row, i) => (
          <li key={row.label + i} className="fade-up flex gap-2" style={index(i)}>
            <span className="w-6 shrink-0 font-mono text-xs tabular-nums text-muted">#{row.to}</span>
            <span className="min-w-0 flex-1">{row.label}</span>
            <span className="shrink-0 font-mono text-xs tabular-nums text-ink-2">
              {row.from === row.to
                ? t('held', 'fermo')
                : row.from > row.to
                  ? `${t('up', 'su')} ${row.from - row.to}`
                  : `${t('down', 'giù')} ${row.to - row.from}`}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
