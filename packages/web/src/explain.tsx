import { RRF_K, tokenize, type Scored, type VerifiedClaim } from '@rag/core';
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import type { ChunkMeta } from './retrieval.worker.ts';
import { IngestView } from './ingest-view.tsx';
import { RunDiagram } from './run-diagram.tsx';
import { Tabs } from './tabs.tsx';
import {
  ABLATION,
  CORPUS,
  METRICS,
  MODELS,
  PARADIGMS,
  PIPELINE_CONSTANTS,
  QUESTION_KINDS,
  type Paradigm,
} from './theory.ts';
import type { AnswerState } from './use-answer.ts';
import type { Retrieval, Run } from './use-retrieval.ts';
import { Bars, DataTable, Figure, GroupedColumns, Slope, StackedBars, VectorStrip, type Series } from './viz.tsx';

/**
 * How this answer was made, step by step, with this run's own numbers.
 *
 * Every figure in the walkthrough is read off the run the user just made: the
 * tokens, the idf of each term, the ranks that went into each RRF sum, the
 * model that answered, what verification found. Nothing is recomputed on a
 * different path and nothing is illustrative. The explanation is the same
 * object the pipeline produced, rendered a second way.
 *
 * The reference half (techniques, evaluation, system and design system) does
 * not depend on the run and is shown before the first question too.
 */

const STEPS = [
  { id: 'step-tokenize', label: 'Tokenization' },
  { id: 'step-bm25', label: 'BM25' },
  { id: 'step-dense', label: 'Dense retrieval' },
  { id: 'step-rrf', label: 'Rank fusion' },
  { id: 'step-rerank', label: 'Reranking' },
  { id: 'step-generate', label: 'Generation' },
  { id: 'step-verify', label: 'Verification' },
];

const REFERENCE = [
  { id: 'ingestion', label: 'How the index was built' },
  { id: 'method', label: 'The six techniques' },
  { id: 'evaluation', label: 'Evaluation' },
  { id: 'system', label: 'System design' },
  { id: 'design-system', label: 'Design system' },
];

export function Explain({ retrieval, answer }: { retrieval: Retrieval; answer: AnswerState }) {
  const { run, meta } = retrieval;
  const sections = run ? [...STEPS, ...REFERENCE] : REFERENCE;
  // A new run remounts the steps, so the observer has to be rebuilt with it.
  const current = useScrollSpy(sections.map((section) => section.id), run?.timings.total);

  return (
    <div className="mt-10 grid gap-12 lg:grid-cols-[13rem_minmax(0,1fr)]">
      <nav aria-label="On this page" className="hidden lg:block">
        <ol className="sticky top-20 space-y-1 border-l border-line text-sm">
          {sections.map((section) => (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                aria-current={current === section.id ? 'location' : undefined}
                className={`-ml-px block border-l-2 py-1 pl-3 transition-colors ${
                  current === section.id ? 'border-ink text-ink' : 'border-transparent text-ink-2 hover:text-ink'
                }`}
              >
                {section.label}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      <div className="min-w-0 space-y-24">
        {run ? (
          <Walkthrough run={run} meta={meta} answer={answer} />
        ) : (
          <p className="max-w-[60ch] text-lg text-ink-2">
            Ask a question and this view walks through the seven stages it went through, with that
            question’s own numbers. The reference material below is always here.
          </p>
        )}
        <IngestView />
        <Paradigms />
        <Evaluation />
        <SystemDesign />
        <DesignSystem />
      </div>
    </div>
  );
}

/** The section nearest the top of the viewport. Orientation for a long page, nothing more. */
function useScrollSpy(ids: string[], version: unknown): string | undefined {
  const [current, setCurrent] = useState<string>();
  const key = ids.join(' ');

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset['spy'] ?? entry.target.id;
          if (entry.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        const first = key.split(' ').find((id) => visible.has(id));
        if (first) setCurrent(first);
      },
      { rootMargin: '-20% 0px -60% 0px' },
    );
    for (const id of key.split(' ')) {
      // The heading carries the id; its section is what occupies the screen.
      const element = document.getElementById(id);
      const section = element?.closest('section');
      if (section) section.dataset['spy'] = id;
      if (section ?? element) observer.observe((section ?? element)!);
    }
    return () => observer.disconnect();
  }, [key, version]);

  return current;
}

// ── shared pieces ───────────────────────────────────────────────────────────

/** A heading alone is ambiguous (every criterion has an "Intent"), so the source goes with it. */
const title = (meta: Map<string, ChunkMeta>, id: string) => {
  const chunk = meta.get(id);
  if (!chunk) return id;
  const heading = chunk.headingPath.at(-1) ?? chunk.docTitle;
  const source = chunk.scRef ? `SC ${chunk.scRef}` : chunk.docId;
  return heading.includes(source.replace('SC ', '')) ? heading : `${heading}, ${source}`;
};

const rankOf = (hits: Scored[] | undefined, id: string) => {
  const index = hits?.findIndex((hit) => hit.chunkId === id) ?? -1;
  return index === -1 ? undefined : index + 1;
};

const ms = (value: number | undefined) =>
  value === undefined
    ? ''
    : value < 10
      ? `${value.toFixed(1)} ms`
      : value < 1000
        ? `${Math.round(value)} ms`
        : `${(value / 1000).toFixed(2)} s`;

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

function Formula({ children, label }: { children: string; label?: string }) {
  return (
    <div className="rounded-xl bg-raised px-4 py-3">
      {label && <span className="block text-xs text-muted">{label}</span>}
      <pre className="overflow-x-auto font-mono text-sm leading-relaxed whitespace-pre-wrap">{children}</pre>
    </div>
  );
}

function SectionHeading({ id, children, lead }: { id: string; children: ReactNode; lead?: ReactNode }) {
  return (
    <header>
      <h2 id={id} className="scroll-mt-20 text-3xl font-semibold tracking-tight md:text-4xl">
        {children}
      </h2>
      {lead && <p className="mt-4 max-w-[65ch] text-lg leading-relaxed text-ink-2">{lead}</p>}
    </header>
  );
}

function Spec({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-[9rem_minmax(0,1fr)]">
      {items.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-muted">{term}</dt>
          <dd className="leading-relaxed">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ── the walkthrough ─────────────────────────────────────────────────────────

function Walkthrough({ run, meta, answer }: { run: Run; meta: Map<string, ChunkMeta>; answer: AnswerState }) {
  const stage = (name: 'dense' | 'lexical' | 'fused') => run.stages.find((s) => s.name === name);
  const degraded = (name: string) => run.degraded.find((d) => d.stage === name)?.reason;
  const timings = answer.phase === 'answered' ? answer.result.timings : undefined;

  return (
    <section aria-labelledby="walkthrough-heading">
      <SectionHeading
        id="walkthrough-heading"
        lead="Seven stages, in the order they ran. Each one names what it computed, with which model or formula, where it ran, and why it is in the pipeline at all."
      >
        What happened to “{run.query}”
      </SectionHeading>

      <div className="mt-8">
        <RunDiagram key={run.query + run.timings.total} run={run} answer={answer} total={meta.size} />
      </div>

      {/* Keyed on the run, so a new question replays the charts rather than jumping to new values. */}
      <ol key={run.query + run.timings.total} className="mt-12 border-l border-line">
        <Step id="step-tokenize" title="Tokenization" where="Browser, Web Worker" why={WHY.tokenize}>
          <Tokens query={run.query} terms={run.bm25.terms} />
        </Step>

        <Step
          id="step-bm25"
          title="Sparse retrieval with Okapi BM25"
          where="Browser, Web Worker"
          time={stage('lexical')?.ms}
          why={WHY.bm25}
        >
          <Bm25Step run={run} meta={meta} />
        </Step>

        <Step
          id="step-dense"
          title="Dense retrieval with a bi-encoder"
          where="Edge embeds, browser scans"
          time={(run.timings.embed ?? 0) + (stage('dense')?.ms ?? 0) || undefined}
          why={WHY.dense}
          missing={degraded('embed') ?? degraded('dense')}
        >
          <DenseStep run={run} meta={meta} />
        </Step>

        <Step id="step-rrf" title="Reciprocal Rank Fusion" where="Browser, Web Worker" time={stage('fused')?.ms} why={WHY.rrf}>
          <RrfStep run={run} meta={meta} />
        </Step>

        <Step
          id="step-rerank"
          title="Reranking with a cross-encoder"
          where="Edge, Workers AI"
          time={run.timings.rerank}
          why={WHY.rerank}
          missing={degraded('rerank')}
        >
          <RerankStep run={run} meta={meta} />
        </Step>

        <Step
          id="step-generate"
          title="Schema-constrained generation"
          where="Edge, Gemini or Workers AI"
          time={timings?.generate}
          why={WHY.generate}
        >
          <GenerateStep answer={answer} />
        </Step>

        <Step
          id="step-verify"
          title="Verification: quote, span, entailment"
          where="Browser, then edge"
          time={timings?.verify}
          why={WHY.verify}
        >
          <VerifyStep answer={answer} meta={meta} />
        </Step>
      </ol>
    </section>
  );
}

const WHY = {
  tokenize:
    'BM25 matches tokens, so the tokenizer decides what is findable. Compounds are kept whole and ' +
    'also split: aria-describedby is indexed as itself and as aria and describedby. Dotted ' +
    'criterion numbers stay whole, because 2, 4 and 11 alone would match every numbered criterion.',
  bm25:
    'The lexical half finds identifiers exactly. It runs entirely in the browser, needs no model, ' +
    'and keeps working when the edge is down, so the app always has at least this.',
  dense:
    'The semantic half finds passages that answer the question without sharing its words. Only ' +
    'the query is embedded at search time. The 1,592 passages were embedded once, at build time, ' +
    'and ship as a 600 KB int8 file.',
  rrf:
    'BM25 and cosine scores live on incompatible scales. Fusing on rank avoids choosing a ' +
    'normalisation, which would be a tuning knob that breaks on the next corpus.',
  rerank:
    'The first stage optimises recall over 1,592 passages; this one optimises precision over 30. ' +
    'A cross-encoder reads query and passage together, which a bi-encoder cannot, and decides ' +
    'which 8 passages the generator sees, and in what order.',
  generate:
    'The model is asked for claims, not prose with footnotes. Each sentence points at its sources ' +
    'by id and carries a quote that must be verbatim. Structured output makes that shape likely; ' +
    'the parser still refuses anything malformed.',
  verify:
    'A citation is only as good as the check behind it. The cheap check runs first and catches ' +
    'most fabrication with no model at all. The expensive one runs only for quotes that held.',
};

function Step({
  id,
  title: heading,
  where,
  time,
  why,
  missing,
  children,
}: {
  id: string;
  title: string;
  where: string;
  time?: number | undefined;
  why: string;
  missing?: string | undefined;
  children: ReactNode;
}) {
  return (
    <li className="relative pb-20 pl-8 last:pb-0 md:pl-12">
      <span aria-hidden="true" className="absolute top-2 -left-[5px] size-2.5 rounded-full bg-ink ring-4 ring-paper" />
      <section aria-labelledby={id}>
        <p className="font-mono text-xs text-muted">
          {where}
          {time !== undefined && <span className="text-ink-2">, {ms(time)}</span>}
        </p>
        <h3 id={id} className="mt-2 scroll-mt-20 text-2xl font-semibold tracking-tight">
          {heading}
        </h3>
        <p className="mt-3 max-w-[65ch] leading-relaxed text-ink-2">{why}</p>
        {missing && (
          <p className="mt-4 rounded-xl border border-partial px-3 py-2 text-sm">Did not run on this query: {missing}</p>
        )}
        <div className="mt-6 space-y-6">{children}</div>
      </section>
    </li>
  );
}

function Tokens({ query, terms }: { query: string; terms: Run['bm25']['terms'] }) {
  const all = tokenize(query);
  const known = new Map(terms.map((term) => [term.term, term.df]));
  const distinct = [...new Set(all)];

  return (
    <div className="viz-in">
      <p className="text-sm text-ink-2">
        “{query}” becomes {all.length} tokens, {distinct.length} distinct. A token that appears in no
        chunk contributes nothing.
      </p>
      <ul className="mt-4 flex flex-wrap gap-2" aria-label="Query tokens">
        {distinct.map((token, i) => {
          const df = known.get(token) ?? 0;
          return (
            <li
              key={token}
              style={{ '--i': i } as CSSProperties}
              className={`fade-up rounded-lg border px-3 py-1.5 ${
                df === 0 ? 'border-dashed border-line-strong' : 'border-line-strong bg-raised'
              }`}
            >
              <span className="font-mono text-sm">{token}</span>
              <span className="ml-2 text-xs text-muted">{df === 0 ? 'not in index' : `${df} chunks`}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Bm25Step({ run, meta }: { run: Run; meta: Map<string, ChunkMeta> }) {
  const { bm25 } = run;
  const lexical = run.stages.find((s) => s.name === 'lexical')?.hits ?? [];
  const total = bm25.terms.reduce((sum, term) => sum + term.score, 0);
  const terms = [...bm25.terms].sort((a, b) => b.score - a.score);

  return (
    <>
      <Formula label="Okapi BM25, with smoothed idf">{PARADIGMS[0]!.formula}</Formula>
      <p className="text-sm text-ink-2">
        Here k1 = {bm25.k1}, b = {bm25.b}, N = {bm25.docCount.toLocaleString('en-GB')} chunks, and the
        average chunk is {bm25.avgdl.toFixed(1)} tokens long.
      </p>

      {bm25.chunkId ? (
        <Figure
          title={`Why the top result scored ${total.toFixed(2)}`}
          caption={`“${title(meta, bm25.chunkId)}”, ${bm25.docLength} tokens. Each bar is one query term’s share of the sum. A frequent term (low idf) adds little even when repeated.`}
          table={{
            head: ['Term', 'df', 'idf', 'tf', 'Contribution'],
            rows: bm25.terms.map((t) => [<code key="t">{t.term}</code>, t.df, t.idf.toFixed(3), t.tf, t.score.toFixed(3)]),
          }}
        >
          <Bars
            series="lexical"
            format={(v) => v.toFixed(2)}
            rows={terms.map((t) => ({
              label: <code>{t.term}</code>,
              value: t.score,
              note: t.tf === 0 ? 'absent from chunk' : `tf ${t.tf}, idf ${t.idf.toFixed(2)}`,
            }))}
          />
        </Figure>
      ) : (
        <p className="text-sm">No query term appears in the index, so BM25 returned nothing.</p>
      )}

      <Figure
        title="Top five by BM25"
        caption="Scores are unbounded sums of idf terms, meaningful only within this one ranking."
        table={{
          head: ['Chunk', 'Score'],
          rows: lexical.slice(0, 5).map((hit) => [title(meta, hit.chunkId), hit.score.toFixed(3)]),
        }}
      >
        <Bars
          series="lexical"
          format={(v) => v.toFixed(2)}
          rows={lexical.slice(0, 5).map((hit) => ({ label: title(meta, hit.chunkId), value: hit.score }))}
        />
      </Figure>
    </>
  );
}

function DenseStep({ run, meta }: { run: Run; meta: Map<string, ChunkMeta> }) {
  const dense = run.stages.find((s) => s.name === 'dense')?.hits ?? [];
  const lexical = run.stages.find((s) => s.name === 'lexical')?.hits;
  const vector = run.vector;
  const norm = vector ? Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) : 0;

  return (
    <>
      <Formula label="Cosine similarity in embedding space">{PARADIGMS[1]!.formula}</Formula>
      <Spec
        items={[
          [
            'Encoder',
            <>
              <code>{MODELS.embedding}</code>. BAAI General Embedding, small, English: 384 dimensions, a
              512-token window, run on Cloudflare Workers AI.
            </>,
          ],
          [
            'Asymmetric input',
            <>
              The query is prefixed with “{MODELS.queryPrefix.trim()}”. Passages are not. bge-v1.5 is
              trained that way, and prefixing a passage would cost recall.
            </>,
          ],
          [
            'Index',
            <>
              Each passage vector is L2-normalised, then quantised to int8 with its own scale (max|vᵢ| /
              127). The query stays float32, so cosine is one dot product per passage, rescaled.
            </>,
          ],
        ]}
      />
      {vector && (
        <Figure
          title="This question, as 384 numbers"
          caption={`The query embedding as the encoder returned it, one bar per dimension, ‖u‖ = ${norm.toFixed(4)}. No single dimension means anything; the direction of the whole vector does.`}
          table={{ head: ['Dimension', 'Value'], rows: vector.map((v, i) => [i, v.toFixed(5)]) }}
        >
          <VectorStrip vector={vector} />
        </Figure>
      )}
      {dense.length > 0 && (
        <Figure
          title="Top five by cosine similarity"
          caption="Next to each, where BM25 ranked the same chunk. The two retrievers often disagree."
          table={{
            head: ['Chunk', 'Cosine', 'BM25 rank'],
            rows: dense
              .slice(0, 5)
              .map((hit) => [title(meta, hit.chunkId), hit.score.toFixed(3), rankOf(lexical, hit.chunkId) ?? 'not in top 30']),
          }}
        >
          <Bars
            series="dense"
            format={(v) => v.toFixed(3)}
            rows={dense.slice(0, 5).map((hit) => {
              const lexicalRank = rankOf(lexical, hit.chunkId);
              return {
                label: title(meta, hit.chunkId),
                value: hit.score,
                note: lexicalRank ? `BM25 #${lexicalRank}` : 'BM25 missed it',
              };
            })}
          />
        </Figure>
      )}
    </>
  );
}

function RrfStep({ run, meta }: { run: Run; meta: Map<string, ChunkMeta> }) {
  const dense = run.stages.find((s) => s.name === 'dense')?.hits;
  const lexical = run.stages.find((s) => s.name === 'lexical')?.hits;
  const fused = (run.stages.find((s) => s.name === 'fused')?.hits ?? []).slice(0, PIPELINE_CONSTANTS.final);
  const part = (rank: number | undefined) => (rank === undefined ? 0 : 1 / (RRF_K + rank));
  const cell = (rank: number | undefined) => (rank === undefined ? 'absent' : `#${rank}, ${part(rank).toFixed(4)}`);

  return (
    <>
      <Formula label="Reciprocal Rank Fusion">{PARADIGMS[2]!.formula}</Formula>
      <p className="max-w-[65ch] text-sm leading-relaxed text-ink-2">
        Each list contributes 1/(60 + rank). The most a single list can give is 1/61 ≈ 0.0164, so a
        chunk that both lists ranked, even modestly, outscores one that only a single list put first.
      </p>
      <Figure
        title={`The top ${fused.length} fused candidates, and where each score came from`}
        caption="Each bar is the RRF sum, split into the dense vote and the BM25 vote."
        legend={['dense', 'lexical']}
        table={{
          head: ['Chunk', 'Dense', 'BM25', 'RRF'],
          rows: fused.map((hit) => [
            title(meta, hit.chunkId),
            cell(rankOf(dense, hit.chunkId)),
            cell(rankOf(lexical, hit.chunkId)),
            hit.score.toFixed(4),
          ]),
        }}
      >
        <StackedBars
          format={(v) => v.toFixed(4)}
          rows={fused.map((hit) => ({
            label: title(meta, hit.chunkId),
            total: hit.score,
            parts: [
              { series: 'dense', value: part(rankOf(dense, hit.chunkId)) },
              { series: 'lexical', value: part(rankOf(lexical, hit.chunkId)) },
            ],
          }))}
        />
      </Figure>
    </>
  );
}

function RerankStep({ run, meta }: { run: Run; meta: Map<string, ChunkMeta> }) {
  const fused = run.stages.find((s) => s.name === 'fused')?.hits ?? [];

  return (
    <>
      <Formula label="Cross-encoder relevance">{PARADIGMS[3]!.formula}</Formula>
      <p className="max-w-[65ch] text-sm leading-relaxed text-ink-2">
        <code>{MODELS.reranker}</code> is a cross-encoder on an XLM-RoBERTa base. It scores the{' '}
        {PIPELINE_CONSTANTS.candidates} fused candidates as (query, passage) pairs and keeps the best{' '}
        {PIPELINE_CONSTANTS.final}. Its scores are relevance estimates, comparable to neither score above.
      </p>
      <Figure
        title="Where the reranker moved each passage"
        caption={`Left, the fused rank among ${fused.length}; right, the final rank among ${run.final.length}. Highlighted lines climbed.`}
        table={{
          head: ['Chunk', 'Fused rank', 'Final rank', 'Score'],
          rows: run.final.map((hit, i) => [
            title(meta, hit.chunkId),
            `#${rankOf(fused, hit.chunkId) ?? 'absent'}`,
            `#${i + 1}`,
            hit.score.toFixed(3),
          ]),
        }}
      >
        <Slope
          fusedCount={Math.max(fused.length, 1)}
          rows={run.final.map((hit, i) => ({
            label: title(meta, hit.chunkId),
            from: rankOf(fused, hit.chunkId) ?? fused.length,
            to: i + 1,
          }))}
        />
      </Figure>
    </>
  );
}

function GenerateStep({ answer }: { answer: AnswerState }) {
  if (answer.phase === 'idle' || answer.phase === 'generating') {
    return (
      <Pending>
        Waiting for the generator. A busy model is retried before the next one is tried, so this can
        take a while.
      </Pending>
    );
  }
  if (answer.phase === 'unavailable') {
    return <p className="rounded-xl border border-partial px-3 py-2 text-sm">No answer was generated: {answer.reason}</p>;
  }

  const generated = answer.phase === 'verifying' ? answer.answer : answer.result.answer;
  const model = answer.phase === 'answered' ? answer.result.model : undefined;

  return (
    <>
      <Spec
        items={[
          [
            'Model',
            <>
              {model ? <code>{model}</code> : 'Not reported by this worker deployment'}, the first of{' '}
              <code>{MODELS.generationChain.join(' → ')}</code> to answer. A busy Gemini model (429, 503) is
              retried twice, then the next one is tried. The last two run on Workers AI, a separate free
              quota that needs no key, so one provider running dry is not an outage.
            </>,
          ],
          ['Decoding', 'Temperature 0, output constrained to a JSON schema (Gemini structured output, or Workers AI JSON mode).'],
          [
            'Context',
            <>
              The {PIPELINE_CONSTANTS.final} reranked passages, each wrapped as <code>{'<source id="…">'}</code>,
              then the question.
            </>,
          ],
          [
            'Rules',
            'Answer only from the sources. Decline when they do not answer. One claim per factual sentence. The quote copied character for character, never shortened or stitched.',
          ],
        ]}
      />
      <Formula label="The schema the model must fill">
        {`{ answerable: boolean,\n  sentences: string[],\n  claims: { sentenceIndex: int, chunkIds: string[], quote: string }[] }`}
      </Formula>
      <details className="rounded-xl border border-line px-4 py-3 text-sm">
        <summary className="cursor-pointer">
          What the model returned: {generated.sentences.length} sentences, {generated.claims.length} claims,
          answerable = {String(generated.answerable)}
        </summary>
        <pre className="mt-3 overflow-x-auto font-mono text-xs leading-relaxed whitespace-pre-wrap">
          {JSON.stringify(generated, null, 2)}
        </pre>
      </details>
    </>
  );
}

const Pending = ({ children }: { children: ReactNode }) => (
  <p className="flex items-center gap-3 text-sm text-ink-2">
    <svg aria-hidden="true" viewBox="0 0 40 4" className="h-1 w-10 shrink-0">
      <line x1={0} x2={40} y1={2} y2={2} strokeWidth={2} className="flowing stroke-ink-2" />
    </svg>
    <span>{children}</span>
  </p>
);

const STATUS: Record<VerifiedClaim['status'], { mark: string; className: string }> = {
  verified: { mark: '✓', className: 'text-verified' },
  partial: { mark: '≈', className: 'text-partial' },
  unsupported: { mark: '✕', className: 'text-unsupported' },
  unverified: { mark: '?', className: 'text-unverified' },
};

function VerifyStep({ answer, meta }: { answer: AnswerState; meta: Map<string, ChunkMeta> }) {
  if (answer.phase !== 'answered') {
    return answer.phase === 'unavailable' ? (
      <p className="text-sm text-ink-2">Nothing to verify: no answer was generated.</p>
    ) : (
      <Pending>Waiting for the answer.</Pending>
    );
  }

  const { claims } = answer.result;
  const found = claims.filter((claim) => claim.quoteMatch).length;
  const judged = claims.filter((claim) => claim.quoteMatch && claim.entailment !== null).length;
  const verified = claims.filter((claim) => claim.status === 'verified').length;

  return (
    <>
      <Formula label="The four outcomes">{PARADIGMS[5]!.formula}</Formula>
      <ol className="grid gap-4 text-sm md:grid-cols-3">
        {[
          [
            'Quote match',
            'The quote must be a literal substring of a cited chunk, after a fixed normalisation: Unicode NFC, whitespace runs, curly quotes, dashes, ellipses. Case is not normalised.',
          ],
          [
            'Span resolution',
            'The match is mapped back to character offsets in the source document, so it can be highlighted exactly where it sits.',
          ],
          [
            'Entailment',
            `An LLM judge labels each (evidence, sentence) pair supported (1), partially supported (0.5) or not supported (0), in one batched call. Verified at ≥ ${PIPELINE_CONSTANTS.verifiedAt}, partial at ≥ ${PIPELINE_CONSTANTS.partialAt}. Then one rule no model is trusted with: a threshold whose source states a conformance level (A, AA, AAA) is held at partial unless the sentence names that level or criterion.`,
          ],
        ].map(([name, text]) => (
          <li key={name} className="rounded-xl bg-raised p-4">
            <span className="font-medium">{name}</span>
            <p className="mt-1 leading-relaxed text-ink-2">{text}</p>
          </li>
        ))}
      </ol>

      {claims.length === 0 ? (
        <p className="text-sm">The answer made no claims to verify.</p>
      ) : (
        <>
          <Figure
            title="How many claims survived each check"
            caption="A claim that fails the quote check is never sent to the judge: grading it would spend quota to change nothing."
            table={{
              head: ['Check', 'Claims'],
              rows: [
                ['Made', claims.length],
                ['Quote found', found],
                ['Judged', judged],
                ['Verified', verified],
              ],
            }}
          >
            <Bars
              series="ink"
              format={(v) => String(v)}
              max={claims.length}
              rows={[
                { label: 'Claims made', value: claims.length },
                { label: 'Quote found in a cited chunk', value: found },
                { label: 'Judged by the entailment model', value: judged },
                { label: 'Verified', value: verified },
              ]}
            />
          </Figure>
          <DataTable
            label="Every claim and what each check found"
            head={['Claim', 'Quote', 'Span', 'Entailment', 'Status']}
            rows={claims.map((claim) => [
              <span key="s" className="block max-w-sm">
                {claim.sentence}
              </span>,
              claim.quoteMatch ? `in ${claim.supportingChunkIds.length} of ${claim.chunkIds.length}` : 'not found',
              claim.span ? (
                <span key="p" title={title(meta, claim.span.chunkId)}>
                  {claim.span.start}-{claim.span.end}
                </span>
              ) : (
                'none'
              ),
              claim.entailment === null ? 'judge unavailable' : claim.entailment.toFixed(1),
              <span key="st" className={STATUS[claim.status].className}>
                <span aria-hidden="true">{STATUS[claim.status].mark} </span>
                {claim.status}
                {claim.levelOmitted && `, Level ${claim.levelOmitted} not stated`}
              </span>,
            ])}
          />
        </>
      )}
    </>
  );
}

// ── the reference half ──────────────────────────────────────────────────────

const PARADIGM_SERIES: Partial<Record<string, Series>> = {
  sparse: 'lexical',
  dense: 'dense',
  hybrid: 'hybrid',
  rerank: 'rerank',
};

/** Tab labels. The full name heads the panel. */
const SHORT: Record<string, string> = {
  sparse: 'BM25',
  dense: 'Dense',
  hybrid: 'Rank fusion',
  rerank: 'Rerank',
  rag: 'Generation',
  attribution: 'Verification',
};

function Paradigms() {
  const [selected, setSelected] = useState(PARADIGMS[0]!.id);

  return (
    <section aria-labelledby="method">
      <SectionHeading
        id="method"
        lead="“RAG” names a family, not one method. This system composes six techniques: two first-stage retrievers, a fusion rule, a second-stage reranker, a generator, and a verifier. Each is set out as it would be in a lecture."
      >
        The six techniques
      </SectionHeading>
      <div className="mt-8">
        <Tabs
          label="Techniques"
          selected={selected}
          onSelect={setSelected}
          tabs={PARADIGMS.map((paradigm) => ({
            id: paradigm.id,
            label: SHORT[paradigm.id] ?? paradigm.name,
            panel: <ParadigmPanel key={paradigm.id} paradigm={paradigm} />,
          }))}
        />
      </div>
    </section>
  );
}

function ParadigmPanel({ paradigm }: { paradigm: Paradigm }) {
  const row = ABLATION.find((entry) => entry.retriever === paradigm.ablationRow);
  const series = PARADIGM_SERIES[paradigm.id];

  return (
    <div className="grid gap-10 pt-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="space-y-6">
        <div>
          <h3 className="text-2xl font-semibold tracking-tight">{paradigm.name}</h3>
          <p className="mt-1 text-sm text-muted">{paradigm.family}</p>
        </div>
        <p className="max-w-[65ch] text-lg leading-relaxed">{paradigm.idea}</p>
        <Formula label="Definition">{paradigm.formula}</Formula>
        <div className="grid gap-6 text-sm sm:grid-cols-2">
          <div>
            <h4 className="font-medium">Strengths</h4>
            <ul className="mt-2 list-disc space-y-1.5 pl-5 leading-relaxed text-ink-2">
              {paradigm.strengths.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div>
            <h4 className="font-medium">Failure modes</h4>
            <ul className="mt-2 list-disc space-y-1.5 pl-5 leading-relaxed text-ink-2">
              {paradigm.failures.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <div className="space-y-6">
        <div className="rounded-xl bg-raised p-4 text-sm">
          <span className="font-medium">Cost here</span>
          <p className="mt-1 leading-relaxed text-ink-2">{paradigm.cost}</p>
        </div>
        {row && series && (
          <Figure
            title="Measured on this corpus"
            caption="This configuration alone, over the 53 answerable golden questions."
            table={{
              head: ['Metric', 'Value'],
              rows: [
                ['Recall@10', pct(row.recall10)],
                ['Success@5', pct(row.success5)],
                ['MRR', row.mrr.toFixed(3)],
              ],
            }}
          >
            <Bars
              series={series}
              max={1}
              format={(v) => v.toFixed(3)}
              rows={[
                { label: 'Recall@10', value: row.recall10 },
                { label: 'Success@5', value: row.success5 },
                { label: 'MRR', value: row.mrr },
              ]}
            />
          </Figure>
        )}
        <div>
          <h4 className="text-sm font-medium">Read further</h4>
          <ul className="mt-2 space-y-2 text-sm text-ink-2">
            {paradigm.references.map((ref) => (
              <li key={ref.url}>
                {ref.authors} ({ref.year}).{' '}
                <a href={ref.url} className="text-ink underline underline-offset-2" rel="noreferrer">
                  {ref.title}
                </a>
                . <i>{ref.venue}</i>.
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

const RETRIEVER_SERIES: Record<(typeof ABLATION)[number]['retriever'], Series> = {
  'BM25 only': 'lexical',
  'Dense only': 'dense',
  'Hybrid (RRF)': 'hybrid',
  'Hybrid + rerank': 'rerank',
};
const ORDER: Series[] = ['lexical', 'dense', 'hybrid', 'rerank'];

function Evaluation() {
  const by = (series: Series) => ABLATION.find((row) => RETRIEVER_SERIES[row.retriever] === series)!;
  const kind = (key: keyof typeof QUESTION_KINDS) =>
    Object.fromEntries(ORDER.map((series) => [series, by(series).byKind[key]])) as Record<Series, number>;

  const metric = (name: string, read: (row: (typeof ABLATION)[number]) => number, format: (v: number) => string) => (
    <Figure title={name} table={{ head: ['Retriever', name], rows: ABLATION.map((row) => [row.retriever, format(read(row))]) }}>
      <Bars
        series="ink"
        max={1}
        format={format}
        rows={ORDER.map((series) => ({ label: by(series).retriever, value: read(by(series)), series }))}
      />
    </Figure>
  );

  return (
    <section aria-labelledby="evaluation">
      <SectionHeading
        id="evaluation"
        lead="An ablation over 60 hand-annotated questions and 1,592 chunks: each retriever alone, then fused, then reranked. Seven questions have no answer in the corpus and are excluded, leaving 53."
      >
        How the combination was justified
      </SectionHeading>

      <dl className="mt-10 grid gap-x-10 gap-y-6 sm:grid-cols-2">
        {METRICS.map((m) => (
          <div key={m.name}>
            <dt className="font-medium">{m.name}</dt>
            <dd className="mt-1 font-mono text-xs text-ink-2">{m.formula}</dd>
            <dd className="mt-1 text-sm leading-relaxed text-ink-2">{m.reads}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-12">
        <Figure
          title="Recall@10 by kind of question: the finding the design rests on"
          caption="Alone, BM25 beats dense retrieval on identifiers and loses to it on conceptual questions. Neither is good at both, which is the case for fusing them; reranking then lifts identifiers furthest."
          legend={ORDER}
          table={{
            head: [
              'Retriever',
              `Identifier (${QUESTION_KINDS.identifier})`,
              `Conceptual (${QUESTION_KINDS.conceptual})`,
              `Design (${QUESTION_KINDS.design})`,
            ],
            rows: ABLATION.map((row) => [row.retriever, pct(row.byKind.identifier), pct(row.byKind.conceptual), pct(row.byKind.design)]),
          }}
        >
          <GroupedColumns
            series={ORDER}
            format={(v) => `${Math.round(v * 100)}`}
            groups={[
              { label: `Identifier, ${QUESTION_KINDS.identifier}`, values: kind('identifier') },
              { label: `Conceptual, ${QUESTION_KINDS.conceptual}`, values: kind('conceptual') },
              { label: `Design, ${QUESTION_KINDS.design}`, values: kind('design') },
            ]}
          />
        </Figure>
      </div>

      <div className="mt-6 grid gap-6 md:grid-cols-3">
        {metric('Success@5', (row) => row.success5, pct)}
        {metric('MRR', (row) => row.mrr, (v) => v.toFixed(3))}
        {metric('Recall@5', (row) => row.recall5, pct)}
      </div>
      <p className="mt-6 max-w-[65ch] text-sm leading-relaxed text-ink-2">
        The reranked configuration returns 8 results rather than 30, so it is compared on the measures
        that look at the top of the list. There it is best on all three: the first right answer moves
        from an MRR of 0.530 for BM25 alone to 0.733.
      </p>
    </section>
  );
}

function SystemDesign() {
  const lanes = [
    {
      name: 'Build time',
      where: 'Node, once',
      items: ['Fetch and normalise 193 documents', 'Chunk with exact offsets', 'Embed 1,592 passages, quantise to int8', 'Build the BM25 postings'],
    },
    {
      name: 'Browser',
      where: 'Web Worker and main thread',
      items: ['Tokenize the query', 'BM25 over the postings', 'Dense scan of 1,592 vectors', 'Rank fusion', 'Quote match and span resolution'],
    },
    {
      name: 'Edge',
      where: 'Cloudflare Worker',
      items: ['Embed the query', 'Rerank 30 candidates', 'Generate the answer', 'Judge entailment'],
    },
  ];

  return (
    <section aria-labelledby="system">
      <SectionHeading
        id="system"
        lead="Static index in the client, models at the edge, no server. Only three things cannot be precomputed: the query embedding, the reranking and the generation. Only those leave the browser."
      >
        System design
      </SectionHeading>
      <ol className="mt-10 grid gap-4 md:grid-cols-3">
        {lanes.map((lane) => (
          <li key={lane.name} className="rounded-2xl border border-line p-5">
            <h3 className="font-medium">{lane.name}</h3>
            <p className="text-xs text-muted">{lane.where}</p>
            <ul className="mt-4 space-y-2 text-sm">
              {lane.items.map((item) => (
                <li key={item} className="rounded-lg bg-raised px-3 py-2">
                  {item}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>

      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <Figure
          title="The corpus, by source"
          caption="193 documents, 1,746,767 characters of normalised text."
          table={{
            head: ['Source', 'Documents', 'Characters'],
            rows: CORPUS.map((row) => [row.source, row.documents, row.characters.toLocaleString('en-GB')]),
          }}
        >
          <Bars
            series="ink"
            format={(v) => `${Math.round(v / 1000)}k`}
            rows={CORPUS.map((row) => ({ label: row.source, value: row.characters, note: `${row.documents} docs` }))}
          />
        </Figure>
        <div className="min-w-0 rounded-2xl border border-line p-5 text-sm leading-relaxed">
          <span className="font-medium">Chunking</span>
          <p className="mt-2 text-ink-2">
            Structure-aware. A chunk targets {PIPELINE_CONSTANTS.chunk.targetTokens} tokens, never exceeds{' '}
            {PIPELINE_CONSTANTS.chunk.maxTokens}, carries {PIPELINE_CONSTANTS.chunk.overlap * 100}% of its
            predecessor, and is always a contiguous slice of the normalised document. Its offsets therefore
            hold by construction, which is what lets a verified quote be highlighted exactly where it sits:
          </p>
          <pre className="mt-3 rounded-lg bg-raised px-3 py-2 font-mono text-xs break-all whitespace-pre-wrap">
            doc.text.slice(chunk.charStart, chunk.charEnd) === chunk.text
          </pre>
          <p className="mt-3 text-ink-2">Asserted over all 193 documents on every test run.</p>
        </div>
      </div>
    </section>
  );
}

function DesignSystem() {
  const surfaces = [
    ['paper', 'bg-paper', 'Page surface'],
    ['raised', 'bg-raised', 'Formulas, figures'],
    ['line', 'bg-line', 'Hairlines'],
    ['ink-2', 'bg-ink-2', 'Secondary text'],
    ['ink', 'bg-ink', 'Text and the only accent'],
  ] as const;
  const series = [
    ['dense', 'bg-dense', 'Dense retrieval'],
    ['lexical', 'bg-lexical', 'BM25'],
    ['hybrid', 'bg-hybrid', 'Hybrid (RRF)'],
    ['rerank', 'bg-rerank', 'Hybrid + rerank'],
  ] as const;
  const states = [
    ['✓', 'text-verified', 'verified', 'solid underline'],
    ['≈', 'text-partial', 'partial', 'dashed underline'],
    ['✕', 'text-unsupported', 'unsupported', 'wavy underline'],
    ['?', 'text-unverified', 'unverified', 'dotted underline'],
  ] as const;

  return (
    <section aria-labelledby="design-system">
      <SectionHeading
        id="design-system"
        lead="A tool about accessibility is held to WCAG 2.2 AA itself. The system is small on purpose: one neutral family, one typeface, colour only where it carries meaning, and motion only where something changed."
      >
        Design system
      </SectionHeading>

      <div className="mt-10 grid gap-10 lg:grid-cols-2">
        <div>
          <h3 className="font-medium">Colour, by role</h3>
          <p className="mt-1 text-sm text-ink-2">Cool neutrals, redefined for dark mode rather than inverted.</p>
          <ul className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-5">
            {surfaces.map(([name, swatch, role]) => (
              <li key={name}>
                <span className={`block h-14 rounded-lg border border-line ${swatch}`} />
                <span className="mt-2 block font-mono text-xs">{name}</span>
                <span className="block text-xs text-muted">{role}</span>
              </li>
            ))}
          </ul>

          <h3 className="mt-8 font-medium">Series colours follow the entity</h3>
          <p className="mt-1 text-sm text-ink-2">
            A retriever keeps its colour in every chart. The set is validated for colour-vision deficiency
            in both modes, and every chart is also direct-labelled and has a table view.
          </p>
          <ul className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {series.map(([name, swatch, role]) => (
              <li key={name}>
                <span className={`block h-10 rounded-lg ${swatch}`} />
                <span className="mt-2 block font-mono text-xs">{name}</span>
                <span className="block text-xs text-muted">{role}</span>
              </li>
            ))}
          </ul>

          <h3 className="mt-8 font-medium">Citation states never rely on colour</h3>
          <p className="mt-1 text-sm text-ink-2">
            A symbol and an underline style carry the meaning; colour is the third signal. There are two
            colour sets, because one cannot clear 4.5:1 on both white and near-black.
          </p>
          <ul className="mt-4 space-y-2 text-sm">
            {states.map(([mark, color, name, underline]) => (
              <li key={name} className="flex items-baseline gap-3">
                <span aria-hidden="true" className={`w-4 font-semibold ${color}`}>
                  {mark}
                </span>
                <span className={`w-28 ${color}`}>{name}</span>
                <span className="text-ink-2">{underline}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="space-y-8">
          <div>
            <h3 className="font-medium">Type</h3>
            <div className="mt-4 rounded-xl bg-raised p-5">
              <p className="text-4xl font-semibold tracking-tighter">Geist, 600</p>
              <p className="mt-2 text-lg text-ink-2">Geist 400 for reading, set at 65 characters a line.</p>
              <p className="mt-3 font-mono text-sm">Geist Mono for numbers: 0.0164, #17, 945 ms</p>
            </div>
            <p className="mt-2 text-sm text-ink-2">
              Self-hosted, so no third-party request stands between a visitor and the first paint.
            </p>
          </div>

          <div>
            <h3 className="font-medium">Motion</h3>
            <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-ink-2">
              <li>A chart grows from its baseline when it comes into view, and again for each new question.</li>
              <li>A dashed line flows only while a request is in flight: motion as state, not decoration.</li>
              <li>Only transform and opacity animate. Under prefers-reduced-motion every mark is simply at rest.</li>
            </ul>
          </div>

          <div>
            <h3 className="font-medium">Accessibility rules</h3>
            <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-ink-2">
              <li>Every chart is hidden from assistive technology over a real table one click away.</li>
              <li>Tabs follow the APG pattern: roving tabindex, arrow keys, Home and End.</li>
              <li>One live region for the life of the page, announcing what changed.</li>
              <li>Focus is a 3px outline with an offset, restyled but never removed.</li>
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
