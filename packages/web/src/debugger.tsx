import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Scored } from '@rag/core';
import type { DegradedStage, Retrieval, Run } from './use-retrieval.ts';
import type { ChunkMeta } from './retrieval.worker.ts';

/**
 * The retrieval debugger.
 *
 * Four columns, left to right, in the order the pipeline runs them. The scores
 * are shown with their real units and deliberately not normalized: cosine sits
 * in [0, 1], BM25 is an unbounded sum of idf terms, RRF is a sum of reciprocal
 * ranks around 0.016. Seeing three incompatible scales side by side is the
 * argument for fusing on rank instead of on score.
 *
 * The movement between the fused column and the final set is drawn, and also
 * written: every final row states the rank it came from. The drawing is
 * decoration — aria-hidden, absent once the columns stack, and drawn instantly
 * rather than animated under prefers-reduced-motion. Nothing is available only
 * as a line on a screen.
 */

type ColumnId = 'dense' | 'lexical' | 'fused' | 'final';

type Column = {
  id: ColumnId;
  title: string;
  unit: string;
  hits: Scored[];
  ms?: number;
  /** Why this stage produced nothing. Shown in place of the list. */
  missing?: string;
};

const SHOWN = 10;

export function RetrievalDebugger({ retrieval }: { retrieval: Retrieval }) {
  const { run, meta } = retrieval;
  const [selected, setSelected] = useState<string>();

  useEffect(() => setSelected(undefined), [run]);

  if (!run) {
    return (
      <p className="mt-6 text-slate-600 dark:text-slate-400">
        Ask a question to see how the candidates are retrieved, fused and reranked.
      </p>
    );
  }

  const columns = buildColumns(run);

  return (
    <div className="mt-6" onKeyDown={(event) => event.key === 'Escape' && setSelected(undefined)}>
      <p className="max-w-3xl text-sm text-slate-600 dark:text-slate-400">
        Each column is a stage, in the order it runs. The scores are shown in their own units and
        are never put on a common scale — that is why fusion reads the ordering rather than the
        numbers.
      </p>

      <Columns columns={columns} meta={meta} selected={selected} onSelect={setSelected} />

      <Detail run={run} meta={meta} selected={selected} />
    </div>
  );
}

function buildColumns(run: Run): Column[] {
  const stage = (name: 'dense' | 'lexical' | 'fused') => run.stages.find((s) => s.name === name);
  const reasonFor = (name: string) => run.degraded.find((d: DegradedStage) => d.stage === name)?.reason;

  const dense = stage('dense');
  const fused = stage('fused');

  return [
    {
      id: 'dense',
      title: 'Dense',
      unit: 'cosine',
      hits: dense?.hits ?? [],
      ...(dense ? { ms: dense.ms } : {}),
      ...(dense ? {} : { missing: reasonFor('dense') ?? reasonFor('embed') ?? 'did not run' }),
    },
    {
      id: 'lexical',
      title: 'BM25',
      unit: 'idf sum',
      hits: stage('lexical')?.hits ?? [],
      ...(stage('lexical') ? { ms: stage('lexical')!.ms } : {}),
    },
    {
      id: 'fused',
      title: 'Fused',
      unit: 'RRF, k=60',
      hits: fused?.hits ?? [],
      ...(fused ? { ms: fused.ms } : {}),
    },
    {
      id: 'final',
      title: 'Reranked',
      unit: 'cross-encoder',
      hits: run.final,
      ...(run.timings.rerank !== undefined ? { ms: run.timings.rerank } : {}),
      ...(reasonFor('rerank') ? { missing: `${reasonFor('rerank')} — showing the fused order` } : {}),
    },
  ];
}

function Columns({
  columns,
  meta,
  selected,
  onSelect,
}: {
  columns: Column[];
  meta: Map<string, ChunkMeta>;
  selected: string | undefined;
  onSelect: (id: string | undefined) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rows = useRef(new Map<string, HTMLElement>());

  const register = useCallback((key: string, element: HTMLElement | null) => {
    if (element) rows.current.set(key, element);
    else rows.current.delete(key);
  }, []);

  const fused = columns.find((column) => column.id === 'fused')?.hits ?? [];
  const final = columns.find((column) => column.id === 'final')?.hits ?? [];

  return (
    <div ref={containerRef} className="relative mt-4">
      <Connectors containerRef={containerRef} rows={rows} fused={fused} final={final} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {columns.map((column) => (
          <ColumnView
            key={column.id}
            column={column}
            meta={meta}
            selected={selected}
            onSelect={onSelect}
            register={register}
            fused={fused}
          />
        ))}
      </div>
    </div>
  );
}

function ColumnView({
  column,
  meta,
  selected,
  onSelect,
  register,
  fused,
}: {
  column: Column;
  meta: Map<string, ChunkMeta>;
  selected: string | undefined;
  onSelect: (id: string | undefined) => void;
  register: (key: string, element: HTMLElement | null) => void;
  fused: Scored[];
}) {
  const fusedRank = new Map(fused.map((hit, index) => [hit.chunkId, index]));
  const headingId = `column-${column.id}`;

  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId} className="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold">
        {column.title}
        <span className="font-normal text-slate-500 dark:text-slate-400">{column.unit}</span>
        {column.ms !== undefined && (
          <span className="ml-auto font-normal tabular-nums text-slate-500 dark:text-slate-400">
            {column.ms < 10 ? column.ms.toFixed(1) : Math.round(column.ms)} ms
          </span>
        )}
      </h3>

      {column.missing && (
        <p className="mt-2 rounded border border-amber-600 px-2 py-1 text-xs text-slate-700 dark:text-slate-300">
          {column.missing}
        </p>
      )}

      {column.hits.length === 0 ? (
        !column.missing && <p className="mt-2 text-xs text-slate-500">No candidates.</p>
      ) : (
        <ol className="mt-2 space-y-1">
          {column.hits.slice(0, SHOWN).map((hit, index) => {
            const chunk = meta.get(hit.chunkId);
            const from = column.id === 'final' ? fusedRank.get(hit.chunkId) : undefined;

            return (
              <li key={hit.chunkId} ref={(element) => register(`${column.id}:${hit.chunkId}`, element)}>
                <button
                  type="button"
                  onClick={() => onSelect(selected === hit.chunkId ? undefined : hit.chunkId)}
                  aria-pressed={selected === hit.chunkId}
                  className={`w-full rounded border px-2 py-1.5 text-left text-xs ${
                    selected === hit.chunkId
                      ? 'border-slate-900 bg-slate-100 dark:border-slate-100 dark:bg-slate-800'
                      : 'border-slate-200 hover:border-slate-400 dark:border-slate-800 dark:hover:border-slate-600'
                  }`}
                >
                  <span className="flex items-baseline gap-1.5">
                    <span className="tabular-nums text-slate-500 dark:text-slate-400">{index + 1}</span>
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {chunk?.headingPath.at(-1) ?? hit.chunkId}
                    </span>
                    <span className="tabular-nums text-slate-500 dark:text-slate-400">
                      {hit.score.toFixed(3)}
                    </span>
                  </span>
                  <span className="mt-0.5 flex items-baseline gap-1.5 text-slate-500 dark:text-slate-400">
                    <span className="min-w-0 flex-1 truncate">{chunk?.docId ?? '—'}</span>
                    {from !== undefined && <RankDelta from={from} to={index} />}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/**
 * How far the reranker moved a result. Written out, because the drawn version
 * is decoration: it is hidden from assistive technology and gone entirely once
 * the columns stack.
 */
function RankDelta({ from, to }: { from: number; to: number }) {
  const moved = from - to;
  if (moved === 0) return <span className="shrink-0">held #{from + 1}</span>;

  return (
    <span className="shrink-0 font-medium">
      {moved > 0 ? '▲' : '▼'} {Math.abs(moved)} from #{from + 1}
    </span>
  );
}

/**
 * Curves from each fused candidate to where the reranker put it.
 *
 * Measured from the laid-out rows rather than computed from an assumed row
 * height, so it stays correct when a heading wraps, and redrawn on resize.
 */
function Connectors({
  containerRef,
  rows,
  fused,
  final,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  rows: React.RefObject<Map<string, HTMLElement>>;
  fused: Scored[];
  final: Scored[];
}) {
  const [paths, setPaths] = useState<{ id: string; d: string; moved: number }[]>([]);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const box = container.getBoundingClientRect();
    setSize({ width: box.width, height: box.height });

    const fusedRank = new Map(fused.map((hit, index) => [hit.chunkId, index]));
    const next: { id: string; d: string; moved: number }[] = [];

    for (const [index, hit] of final.slice(0, SHOWN).entries()) {
      const source = rows.current?.get(`fused:${hit.chunkId}`);
      const target = rows.current?.get(`final:${hit.chunkId}`);
      if (!source || !target) continue;

      const a = source.getBoundingClientRect();
      const b = target.getBoundingClientRect();

      // Whether the columns are side by side is read off the layout, not
      // guessed from a breakpoint: once they stack, a curve between two rows a
      // screenful apart means nothing, and the two numbers would disagree the
      // moment either the container width or the breakpoint moved.
      if (b.left < a.right) return setPaths([]);

      const x1 = a.right - box.left;
      const y1 = a.top + a.height / 2 - box.top;
      const x2 = b.left - box.left;
      const y2 = b.top + b.height / 2 - box.top;
      const bend = (x2 - x1) / 2;

      next.push({
        id: hit.chunkId,
        d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
        moved: (fusedRank.get(hit.chunkId) ?? index) - index,
      });
    }

    setPaths(next);
  }, [containerRef, rows, fused, final]);

  useLayoutEffect(measure, [measure]);

  useEffect(() => {
    const observer = new ResizeObserver(measure);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [containerRef, measure]);

  if (paths.length === 0) return null;

  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size.width}
      height={size.height}
      viewBox={`0 0 ${size.width} ${size.height}`}
      className="pointer-events-none absolute inset-0"
    >
      {paths.map((path) => (
        <path
          key={path.id}
          d={path.d}
          pathLength={1}
          fill="none"
          strokeWidth={path.moved === 0 ? 1 : 1.5}
          className={
            'connector ' +
            (path.moved > 0
              ? 'stroke-emerald-600/70'
              : path.moved < 0
                ? 'stroke-amber-600/70'
                : 'stroke-slate-400/50')
          }
        />
      ))}
    </svg>
  );
}

function Detail({
  run,
  meta,
  selected,
}: {
  run: Run;
  meta: Map<string, ChunkMeta>;
  selected: string | undefined;
}) {
  if (!selected) {
    return (
      <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
        Select a candidate to see where every stage ranked it.
      </p>
    );
  }

  const chunk = meta.get(selected);
  const rankIn = (hits: Scored[]) => {
    const index = hits.findIndex((hit) => hit.chunkId === selected);
    return index === -1 ? undefined : index + 1;
  };

  const places: { label: string; rank?: number }[] = [
    ...run.stages.map((stage) => ({
      label: stage.name === 'lexical' ? 'BM25' : stage.name === 'dense' ? 'Dense' : 'Fused',
      ...(rankIn(stage.hits) !== undefined ? { rank: rankIn(stage.hits)! } : {}),
    })),
    { label: 'Reranked', ...(rankIn(run.final) !== undefined ? { rank: rankIn(run.final)! } : {}) },
  ];

  return (
    <div className="mt-4 rounded-md border border-slate-200 p-4 dark:border-slate-800">
      <h3 className="font-medium">{chunk?.headingPath.join(' › ') ?? selected}</h3>
      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
        {places.map((place) => (
          <div key={place.label} className="flex gap-1.5">
            <dt className="text-slate-500 dark:text-slate-400">{place.label}</dt>
            <dd className="tabular-nums">{place.rank === undefined ? 'not retrieved' : `#${place.rank}`}</dd>
          </div>
        ))}
      </dl>
      {chunk && (
        <p className="mt-3 text-sm text-slate-600 dark:text-slate-400">
          {chunk.docId}
          {chunk.scRef && ` · SC ${chunk.scRef}`} · {chunk.tokenCount} tokens · characters{' '}
          {chunk.charStart.toLocaleString('en-GB')}–{chunk.charEnd.toLocaleString('en-GB')}
        </p>
      )}
    </div>
  );
}
