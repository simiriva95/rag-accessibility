import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Scored } from '@rag/core';
import type { DegradedStage, Retrieval, Run } from './use-retrieval.ts';
import type { ChunkMeta } from './retrieval.worker.ts';
import { useLang } from './i18n.tsx';

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
  const { t } = useLang();

  useEffect(() => setSelected(undefined), [run]);

  if (!run) {
    return (
      <p className="mt-6 text-ink-2">
        {t(
          'Ask a question to see how the candidates are retrieved, fused and reranked.',
          'Fai una domanda per vedere come i candidati vengono trovati, fusi e riordinati.',
        )}
      </p>
    );
  }

  const columns = buildColumns(run, t);

  return (
    <div className="mt-6" onKeyDown={(event) => event.key === 'Escape' && setSelected(undefined)}>
      <h2 className="sr-only">{t('Retrieval stages', 'Fasi del retrieval')}</h2>
      <p className="max-w-3xl text-sm text-ink-2">
        {t(
          'Each column is a stage, in the order it runs. The scores are shown in their own units and are never put on a common scale. That is why fusion reads the ordering rather than the numbers.',
          'Ogni colonna è una fase, nell’ordine in cui viene eseguita. I punteggi sono mostrati nelle loro unità e mai portati su una scala comune: per questo la fusione legge l’ordine e non i numeri.',
        )}
      </p>

      <Columns columns={columns} meta={meta} selected={selected} onSelect={setSelected} />

      <p className="mt-3 text-sm text-ink-2">
        <span className="font-medium text-ink">
          {Math.round(run.timings.total)} ms
        </span>{' '}
        {t('end to end', 'in totale')}
        {run.timings.embed !== undefined &&
          t(`, of which ${Math.round(run.timings.embed)} ms embedding`, `, di cui ${Math.round(run.timings.embed)} ms di embedding`)}
        {run.timings.rerank !== undefined &&
          t(` and ${Math.round(run.timings.rerank)} ms reranking`, ` e ${Math.round(run.timings.rerank)} ms di reranking`)}
        .
      </p>

      <Detail run={run} meta={meta} selected={selected} />
    </div>
  );
}

function buildColumns(run: Run, t: ReturnType<typeof useLang>['t']): Column[] {
  const stage = (name: 'dense' | 'lexical' | 'fused') => run.stages.find((s) => s.name === name);
  const reasonFor = (name: string) => run.degraded.find((d: DegradedStage) => d.stage === name)?.reason;

  const dense = stage('dense');
  const fused = stage('fused');

  return [
    {
      id: 'dense',
      title: t('Dense', 'Semantico'),
      unit: t('cosine', 'coseno'),
      hits: dense?.hits ?? [],
      ...(dense ? { ms: dense.ms } : {}),
      ...(dense ? {} : { missing: reasonFor('dense') ?? reasonFor('embed') ?? t('did not run', 'non eseguita') }),
    },
    {
      id: 'lexical',
      title: 'BM25',
      unit: t('idf sum', 'somma idf'),
      hits: stage('lexical')?.hits ?? [],
      ...(stage('lexical') ? { ms: stage('lexical')!.ms } : {}),
    },
    {
      id: 'fused',
      title: t('Fused', 'Fusi'),
      unit: 'RRF, k=60',
      hits: fused?.hits ?? [],
      ...(fused ? { ms: fused.ms } : {}),
    },
    {
      id: 'final',
      title: t('Reranked', 'Riordinati'),
      unit: 'cross-encoder',
      hits: run.final,
      ...(run.timings.rerank !== undefined ? { ms: run.timings.rerank } : {}),
      ...(reasonFor('rerank') ? { missing: `${reasonFor('rerank')}, ${t('showing the fused order', 'mostro l’ordine fuso')}` } : {}),
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

      {/*
        * Above the connector overlay. An absolutely positioned SVG paints over
        * static siblings, so without this the curves are drawn across the card
        * text rather than behind it.
        */}
      <div className="relative grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
  const { t } = useLang();
  const fusedRank = new Map(fused.map((hit, index) => [hit.chunkId, index]));
  const headingId = `column-${column.id}`;

  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId} className="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold">
        {column.title}
        <span className="font-normal text-muted">{column.unit}</span>
        {column.ms !== undefined && (
          <span className="ml-auto font-normal tabular-nums text-muted">
            {column.ms < 10 ? column.ms.toFixed(1) : Math.round(column.ms)} ms
          </span>
        )}
      </h3>

      {column.missing && (
        <p className="mt-2 rounded-lg border border-partial px-2 py-1 text-xs text-ink-2">
          {column.missing}
        </p>
      )}

      {column.hits.length === 0 ? (
        !column.missing && <p className="mt-2 text-xs text-muted">{t('No candidates.', 'Nessun candidato.')}</p>
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
                  className={`w-full rounded-lg border px-2.5 py-1.5 text-left text-xs ${
                    selected === hit.chunkId
                      ? 'border-ink bg-raised'
                      : 'border-line hover:border-line-strong'
                  }`}
                >
                  <span className="flex items-baseline gap-1.5">
                    <span className="tabular-nums text-muted">{index + 1}</span>
                    <span className="min-w-0 flex-1 truncate font-medium" lang="en">
                      {chunk?.headingPath.at(-1) ?? hit.chunkId}
                    </span>
                    <span className="tabular-nums text-muted">
                      {hit.score.toFixed(3)}
                    </span>
                  </span>
                  <span className="mt-0.5 flex items-baseline gap-1.5 text-muted">
                    <span className="min-w-0 flex-1 truncate">{chunk?.docId ?? 'unknown'}</span>
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
  const { t } = useLang();
  const moved = from - to;
  if (moved === 0) return <span className="shrink-0">{t('held', 'fermo')} #{from + 1}</span>;

  return (
    <span className="shrink-0 font-medium">
      {moved > 0 ? '▲' : '▼'} {Math.abs(moved)} {t('from', 'da')} #{from + 1}
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
              ? 'stroke-hybrid'
              : path.moved < 0
                ? 'stroke-rerank'
                : 'stroke-line-strong')
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
  const { t, num } = useLang();
  if (!selected) {
    return (
      <p className="mt-4 text-sm text-muted">
        {t('Select a candidate to see where every stage ranked it.', 'Seleziona un candidato per vedere dove l’ha messo ogni fase.')}
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
      label: stage.name === 'lexical' ? 'BM25' : stage.name === 'dense' ? t('Dense', 'Semantico') : t('Fused', 'Fusi'),
      ...(rankIn(stage.hits) !== undefined ? { rank: rankIn(stage.hits)! } : {}),
    })),
    { label: t('Reranked', 'Riordinati'), ...(rankIn(run.final) !== undefined ? { rank: rankIn(run.final)! } : {}) },
  ];

  return (
    <div className="mt-4 rounded-xl border border-line p-4">
      <h3 className="font-medium" lang="en">
        {chunk?.headingPath.join(' › ') ?? selected}
      </h3>
      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
        {places.map((place) => (
          <div key={place.label} className="flex gap-1.5">
            <dt className="text-muted">{place.label}</dt>
            <dd className="tabular-nums">{place.rank === undefined ? t('not retrieved', 'non trovato') : `#${place.rank}`}</dd>
          </div>
        ))}
      </dl>
      {chunk && (
        <p className="mt-3 text-sm text-ink-2">
          {chunk.docId}
          {chunk.scRef && ` · SC ${chunk.scRef}`} · {chunk.tokenCount} token · {t('characters', 'caratteri')}{' '}
          {num(chunk.charStart)}-{num(chunk.charEnd)}
        </p>
      )}
    </div>
  );
}
