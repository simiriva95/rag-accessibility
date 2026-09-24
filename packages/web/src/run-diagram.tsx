import { tokenize } from '@rag/core';
import type { CSSProperties, ReactNode } from 'react';
import type { AnswerState } from './use-answer.ts';
import type { Run } from './use-retrieval.ts';
import { useLang } from './i18n.tsx';
import { useInView, type Series } from './viz.tsx';

/**
 * The structure of one run, drawn as the graph it actually is.
 *
 * Retrieval is not a line: the query forks into a lexical and a semantic
 * branch that run on different machines, and the two lists meet at fusion.
 * Each node carries what it received and what it passed on, for this question
 * — so the funnel from 1,592 chunks to 8 sources to a handful of verified
 * claims is read off the run, not described.
 *
 * The drawing is a list of nodes in pipeline order, so it reads in sequence
 * to a screen reader as well; the arrows and the branch are aria-hidden.
 */

export type Node = {
  title: string;
  where: string;
  series?: Series;
  facts: [string, ReactNode][];
  time?: number | undefined;
  missing?: string | undefined;
  pending?: boolean;
};

const ring: Record<Series, string> = {
  dense: 'border-t-dense',
  lexical: 'border-t-lexical',
  hybrid: 'border-t-hybrid',
  rerank: 'border-t-rerank',
};

const ms = (value: number | undefined) =>
  value === undefined ? '' : value < 10 ? `${value.toFixed(1)} ms` : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;

export function RunDiagram({ run, answer, total }: { run: Run; answer: AnswerState; total: number }) {
  const [ref, seen] = useInView<HTMLElement>();
  const { t, num } = useLang();
  const stage = (name: 'dense' | 'lexical' | 'fused') => run.stages.find((s) => s.name === name);
  const reason = (name: string) => run.degraded.find((d) => d.stage === name)?.reason;

  const tokens = tokenize(run.query);
  const known = run.bm25.terms.filter((t) => t.df > 0).length;
  const lexical = stage('lexical')?.hits ?? [];
  const dense = stage('dense')?.hits ?? [];
  const fused = stage('fused')?.hits ?? [];
  const lexicalIds = new Set(lexical.map((h) => h.chunkId));
  const overlap = dense.filter((h) => lexicalIds.has(h.chunkId)).length;
  const union = new Set([...lexicalIds, ...dense.map((h) => h.chunkId)]).size;
  const fusedRank = new Map(fused.map((h, i) => [h.chunkId, i]));
  const promoted = run.final.filter((h, i) => (fusedRank.get(h.chunkId) ?? i) > i).length;
  const fromOutside = run.final.filter((h) => (fusedRank.get(h.chunkId) ?? 0) >= run.final.length).length;

  const result = answer.phase === 'answered' ? answer.result : undefined;
  const generated = answer.phase === 'verifying' ? answer.answer : result?.answer;
  const claims = result?.claims ?? [];
  const pendingAnswer = answer.phase === 'generating' || answer.phase === 'verifying';

  const lexicalLane: Node[] = [
    {
      title: t('Tokenize', 'Tokenizza'),
      where: 'Browser',
      facts: [
        ['token', tokens.length],
        [t('indexed', 'indicizzati'), `${known}/${new Set(tokens).size}`],
      ],
    },
    {
      title: 'BM25',
      where: 'Browser',
      series: 'lexical',
      time: stage('lexical')?.ms,
      facts: [
        [t('scored', 'valutati'), num(total)],
        [t('kept', 'tenuti'), lexical.length],
        [t('top score', 'punteggio max'), lexical[0]?.score.toFixed(2) ?? t('none', 'nessuno')],
      ],
    },
  ];

  const denseLane: Node[] = [
    {
      title: 'Embedding',
      where: 'Edge',
      time: run.timings.embed,
      missing: reason('embed'),
      facts: [
        [t('model', 'modello'), 'bge-small'],
        [t('dims', 'dimensioni'), run.vector?.length ?? 0],
      ],
    },
    {
      title: t('Dense scan', 'Scansione semantica'),
      where: 'Browser',
      series: 'dense',
      time: stage('dense')?.ms,
      missing: reason('dense'),
      facts: [
        [t('scored', 'valutati'), num(total)],
        [t('kept', 'tenuti'), dense.length],
        [t('top cosine', 'coseno max'), dense[0]?.score.toFixed(3) ?? t('none', 'nessuno')],
      ],
    },
  ];

  const tail: Node[] = [
    {
      title: t('Rank fusion', 'Fusione'),
      where: 'Browser',
      series: 'hybrid',
      time: stage('fused')?.ms,
      facts: [
        [t('in both lists', 'in entrambe'), `${overlap} ${t('of', 'su')} ${Math.max(dense.length, lexical.length)}`],
        [t('distinct', 'distinti'), union],
        [t('kept', 'tenuti'), fused.length],
      ],
    },
    {
      title: 'Rerank',
      where: 'Edge',
      series: 'rerank',
      time: run.timings.rerank,
      missing: reason('rerank'),
      facts: [
        [t('read', 'letti'), fused.length],
        [t('kept', 'tenuti'), run.final.length],
        [t('moved up', 'saliti'), promoted],
        [t('from below #8', 'da sotto il #8'), fromOutside],
      ],
    },
    {
      title: t('Generate', 'Generazione'),
      where: 'Edge',
      time: result?.timings.generate,
      pending: answer.phase === 'generating',
      missing: answer.phase === 'unavailable' ? answer.reason : undefined,
      facts: generated
        ? [
            [t('model', 'modello'), result?.model?.replace(/^@cf\/[^/]+\//, '') ?? t('answering', 'in corso')],
            [t('sources in', 'fonti lette'), run.final.length],
            [t('sentences', 'frasi'), generated.sentences.length],
            [t('claims', 'citazioni'), generated.claims.length],
          ]
        : [[t('sources in', 'fonti lette'), run.final.length]],
    },
    {
      title: t('Verify', 'Verifica'),
      where: t('Both', 'Entrambi'),
      time: result?.timings.verify,
      pending: pendingAnswer,
      missing: answer.phase === 'unavailable' ? t('nothing to verify', 'niente da verificare') : undefined,
      facts: result
        ? [
            [t('claims', 'citazioni'), claims.length],
            [t('quote found', 'trovate'), claims.filter((c) => c.quoteMatch).length],
            [t('verified', 'verificate'), claims.filter((c) => c.status === 'verified').length],
            [t('unsupported', 'non supportate'), claims.filter((c) => c.status === 'unsupported').length],
          ]
        : [],
    },
  ];

  let i = 0;
  const next = () => i++;

  return (
    <figure ref={ref} className={`min-w-0 rounded-2xl border border-line bg-paper p-5 ${seen ? 'viz-in' : ''}`}>
      <figcaption>
        <span className="block font-medium">{t('What happened, structurally', 'Cosa è successo, nella struttura')}</span>
        <span className="mt-1 block max-w-[65ch] text-sm text-ink-2">
          {t(
            'The query forks into a lexical and a semantic branch, which meet at fusion; from there one list narrows to the sources the answer was written from. Every number is this question’s.',
            'La domanda si divide in un ramo lessicale e uno semantico, che si riuniscono nella fusione; da lì un’unica lista si restringe fino alle fonti da cui è scritta la risposta. Ogni numero è di questa domanda.',
          )}
        </span>
      </figcaption>

      <ol className="mx-auto mt-6 flex max-w-2xl flex-col items-stretch gap-2 xl:max-w-none xl:flex-row xl:items-center">
        <li className="contents">
          <Card
            node={{ title: t('Question', 'Domanda'), where: 'Browser', facts: [[t('characters', 'caratteri'), run.query.length]] }}
            i={next()}
          />
        </li>
        <Arrow i={next()} />
        <li className="min-w-0 xl:flex-[2]">
          <span className="sr-only">{t('Two branches run for the same question:', 'Due rami lavorano sulla stessa domanda:')}</span>
          <ol className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-1">
            <Lane label={t('Lexical branch', 'Ramo lessicale')} nodes={lexicalLane} next={next} />
            <Lane label={t('Semantic branch', 'Ramo semantico')} nodes={denseLane} next={next} />
          </ol>
        </li>
        {tail.map((node) => (
          <FragmentPair key={node.title}>
            <Arrow i={next()} />
            <li className="min-w-0 xl:flex-1">
              <Card node={node} i={next()} />
            </li>
          </FragmentPair>
        ))}
      </ol>
    </figure>
  );
}

export const FragmentPair = ({ children }: { children: ReactNode }) => <>{children}</>;

export function Lane({ label, nodes, next }: { label: string; nodes: Node[]; next: () => number }) {
  return (
    <li className="rounded-xl bg-raised p-2">
      <span className="block px-1 pb-1.5 text-xs text-muted">{label}</span>
      <ol className="flex items-stretch gap-1.5">
        {nodes.map((node, index) => (
          <FragmentPair key={node.title}>
            {index > 0 && <Arrow i={next()} inline />}
            <li className="min-w-0 flex-1">
              <Card node={node} i={next()} compact />
            </li>
          </FragmentPair>
        ))}
      </ol>
    </li>
  );
}

export function Card({ node, i, compact = false }: { node: Node; i: number; compact?: boolean }) {
  const { t } = useLang();
  const state = node.missing ? 'border-dashed border-partial' : 'border-line';
  return (
    <div
      className={`fade-up h-full rounded-xl border bg-paper p-3 ${state} ${node.series ? `border-t-4 ${ring[node.series]}` : ''}`}
      style={{ '--i': i } as CSSProperties}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{node.title}</span>
        <span className="shrink-0 font-mono text-[11px] text-muted">{node.pending ? t('running', 'in corso') : ms(node.time)}</span>
      </div>
      <span className="text-[11px] text-muted">{node.where}</span>
      {node.missing ? (
        <p className="mt-2 line-clamp-3 text-xs text-ink-2">{t('Did not run:', 'Non eseguita:')} {node.missing}</p>
      ) : (
        <dl className={`mt-2 space-y-0.5 text-xs ${compact ? '' : ''}`}>
          {node.facts.map(([term, value]) => (
            <div key={term} className="flex flex-wrap justify-between gap-x-2">
              <dt className="text-ink-2">{term}</dt>
              <dd className="ml-auto text-right font-mono tabular-nums break-words">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/** Direction of flow. Down when the graph stacks, right when it spreads out. */
export function Arrow({ i, inline = false }: { i: number; inline?: boolean }) {
  return (
    <li aria-hidden="true" className={`flex shrink-0 items-center justify-center ${inline ? 'w-3' : 'h-5 xl:h-auto xl:w-5'}`}>
      <svg viewBox="0 0 16 16" className={`size-3.5 text-line-strong ${inline ? '' : 'rotate-90 xl:rotate-0'}`} focusable="false">
        <path
          d="M2 8 H13 M9 4 L13 8 L9 12"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          pathLength={1}
          className="draw"
          style={{ '--i': i } as CSSProperties}
        />
      </svg>
    </li>
  );
}
