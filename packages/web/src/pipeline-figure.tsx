import type { AnswerState } from './use-answer.ts';
import type { Retrieval } from './use-retrieval.ts';
import { useLang } from './i18n.tsx';
import { DataTable, useInView } from './viz.tsx';

/**
 * The hero's figure: the seven stages as a latency waterfall, for the question
 * just asked.
 *
 * Before a question it is the pipeline's outline; while one runs, the stages
 * in flight say so; afterwards each bar is that stage's own wall-clock time,
 * laid end to end in the order they ran. It is a real chart of a real run,
 * not a picture of one. The stages run in sequence, so the offsets are
 * cumulative; BM25, the dense scan and fusion share one worker round trip.
 */

type Row = { label: string; where: string; ms?: number | undefined; state: 'idle' | 'running' | 'done' | 'skipped' };

export function PipelineFigure({ retrieval, answer }: { retrieval: Retrieval; answer: AnswerState }) {
  const [ref, seen] = useInView<HTMLElement>();
  const { t } = useLang();
  const { run, running } = retrieval;
  const EDGE = 'Edge';
  const BROWSER = 'Browser';
  const BOTH = t('Both', 'Entrambi');
  const stage = (name: 'dense' | 'lexical' | 'fused') => run?.stages.find((s) => s.name === name)?.ms;
  const failed = (name: string) => run?.degraded.some((d) => d.stage === name) ?? false;

  const retrievalState = (ms: number | undefined, skipped = false): Row['state'] =>
    running ? 'running' : !run ? 'idle' : skipped || ms === undefined ? 'skipped' : 'done';

  const timings = answer.phase === 'answered' ? answer.result.timings : undefined;
  const answerState = (phase: 'generating' | 'verifying'): Row['state'] => {
    if (running || answer.phase === 'idle') return 'idle';
    if (answer.phase === 'unavailable') return 'skipped';
    if (answer.phase === 'answered') return 'done';
    if (answer.phase === phase) return 'running';
    return phase === 'verifying' ? 'idle' : 'done';
  };

  const rows: Row[] = [
    { label: t('Embed the query', 'Embedding della domanda'), where: EDGE, ms: run?.timings.embed, state: retrievalState(run?.timings.embed, failed('embed')) },
    { label: 'BM25', where: BROWSER, ms: stage('lexical'), state: retrievalState(stage('lexical')) },
    { label: t('Dense scan', 'Scansione semantica'), where: BROWSER, ms: stage('dense'), state: retrievalState(stage('dense')) },
    { label: t('Rank fusion', 'Fusione dei ranking'), where: BROWSER, ms: stage('fused'), state: retrievalState(stage('fused')) },
    { label: 'Rerank', where: EDGE, ms: run?.timings.rerank, state: retrievalState(run?.timings.rerank, failed('rerank')) },
    { label: t('Generate', 'Generazione'), where: EDGE, ms: timings?.generate, state: answerState('generating') },
    { label: t('Verify', 'Verifica'), where: BOTH, ms: timings?.verify, state: answerState('verifying') },
  ];

  const total = rows.reduce((sum, row) => sum + (row.state === 'done' ? (row.ms ?? 0) : 0), 0);
  let offset = 0;

  return (
    <figure
      ref={ref}
      className={`self-start rounded-2xl border border-line bg-raised p-5 ${seen ? 'viz-in' : ''}`}
    >
      <figcaption className="flex items-baseline justify-between gap-3">
        <span className="font-medium">{run ? t('This question, stage by stage', 'Questa domanda, fase per fase') : t('Seven stages per question', 'Sette fasi per ogni domanda')}</span>
        {total > 0 && <span className="font-mono text-sm tabular-nums text-ink-2">{fmt(total)}</span>}
      </figcaption>

      <ol aria-hidden="true" className="mt-5 space-y-3">
        {rows.map((row, i) => {
          const start = offset;
          if (row.state === 'done') offset += row.ms ?? 0;
          const left = total > 0 ? (start / total) * 100 : 0;
          const width = total > 0 ? ((row.ms ?? 0) / total) * 100 : 0;

          return (
            <li key={row.label} className="grid grid-cols-[9.5rem_1fr_4rem] items-center gap-3 text-sm">
              <span className="truncate">
                {row.label}
                <span className="block text-xs text-muted">{row.where}</span>
              </span>
              <span className="relative h-2.5">
                {row.state === 'done' && (
                  <span
                    key={run?.query}
                    className="grow-x absolute inset-y-0 rounded-r bg-ink"
                    style={{ left: `${left}%`, width: `max(3px, ${width}%)`, ['--i' as string]: i }}
                  />
                )}
                {row.state === 'running' && (
                  <svg className="absolute inset-0 h-full w-full" preserveAspectRatio="none" viewBox="0 0 100 10">
                    <line x1={0} x2={100} y1={5} y2={5} strokeWidth={2} className="flowing stroke-ink-2" />
                  </svg>
                )}
                {(row.state === 'idle' || row.state === 'skipped') && (
                  <span className="absolute inset-x-0 top-1/2 h-px bg-line-strong" />
                )}
              </span>
              <span className="text-right font-mono text-xs tabular-nums text-ink-2">
                {row.state === 'done' ? fmt(row.ms) : row.state === 'running' ? t('running', 'in corso') : row.state === 'skipped' ? t('skipped', 'saltata') : ''}
              </span>
            </li>
          );
        })}
      </ol>

      <details className="mt-5 text-sm">
        <summary className="cursor-pointer text-ink-2 hover:text-ink">{t('Table view', 'Vista tabella')}</summary>
        <DataTable
          label={t('Stage timings', 'Tempi delle fasi')}
          head={[t('Stage', 'Fase'), t('Runs in', 'Dove'), t('Time', 'Tempo')]}
          rows={rows.map((row) => [row.label, row.where, row.state === 'done' ? fmt(row.ms) : row.state])}
        />
      </details>
    </figure>
  );
}

const fmt = (ms: number | undefined) =>
  ms === undefined ? '' : ms < 10 ? `${ms.toFixed(1)} ms` : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
