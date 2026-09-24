import { RRF_K, tokenize, type Scored, type VerifiedClaim } from '@rag/core';
import type { ReactNode } from 'react';
import type { ChunkMeta } from './retrieval.worker.ts';
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

/**
 * How this answer was made, step by step, with this run's own numbers.
 *
 * Every figure in the walkthrough is read off the run the user just made — the
 * tokens, the idf of each term, the ranks that went into each RRF sum, the
 * model that answered, what verification found. Nothing is recomputed on a
 * different path and nothing is illustrative: the explanation is the same
 * object the pipeline produced, rendered a second way.
 *
 * The reference half (paradigms, metrics, ablation) does not depend on the run
 * and is shown before the first question too.
 */

export function Explain({ retrieval, answer }: { retrieval: Retrieval; answer: AnswerState }) {
  const { run, meta } = retrieval;

  return (
    <div className="mt-6 space-y-12">
      {run ? (
        <Walkthrough run={run} meta={meta} answer={answer} />
      ) : (
        <p className="text-slate-600 dark:text-slate-400">
          Ask a question and this view walks through every stage it went through, with that
          question’s own numbers. The reference material below is always available.
        </p>
      )}
      <Paradigms />
      <Evaluation />
      <SystemDesign />
    </div>
  );
}

// ── the walkthrough ─────────────────────────────────────────────────────────

/** A heading alone is ambiguous — every criterion has an "Intent" — so the source goes with it. */
const title = (meta: Map<string, ChunkMeta>, id: string) => {
  const chunk = meta.get(id);
  if (!chunk) return id;
  const heading = chunk.headingPath.at(-1) ?? chunk.docTitle;
  const source = chunk.scRef ? `SC ${chunk.scRef}` : chunk.docId;
  return heading.includes(source.replace('SC ', '')) ? heading : `${heading} · ${source}`;
};
const rankOf = (hits: Scored[] | undefined, id: string) => {
  const index = hits?.findIndex((hit) => hit.chunkId === id) ?? -1;
  return index === -1 ? undefined : index + 1;
};
const ms = (value: number | undefined) =>
  value === undefined ? '—' : value < 10 ? `${value.toFixed(1)} ms` : `${Math.round(value)} ms`;

function Walkthrough({ run, meta, answer }: { run: Run; meta: Map<string, ChunkMeta>; answer: AnswerState }) {
  const stage = (name: 'dense' | 'lexical' | 'fused') => run.stages.find((s) => s.name === name);
  const degraded = (name: string) => run.degraded.find((d) => d.stage === name)?.reason;

  return (
    <section aria-labelledby="walkthrough-heading" className="space-y-10">
      <header>
        <h2 id="walkthrough-heading" className="text-xl font-semibold">
          What happened to “{run.query}”
        </h2>
        <p className="mt-2 max-w-3xl text-slate-600 dark:text-slate-400">
          Seven stages, in the order they ran. Each says what it computed, with which model or
          formula, where it ran, and why it is there at all.
        </p>
        <Timeline run={run} answer={answer} />
      </header>

      <Step n={1} title="Tokenization" where="Browser · Web Worker" why={WHY.tokenize}>
        <Tokens query={run.query} terms={run.bm25.terms} />
      </Step>

      <Step n={2} title="Sparse retrieval — Okapi BM25" where="Browser · Web Worker" time={stage('lexical')?.ms} why={WHY.bm25}>
        <Bm25Step run={run} meta={meta} />
      </Step>

      <Step
        n={3}
        title="Dense retrieval — bi-encoder embeddings"
        where="Edge (embedding) · Browser (scan)"
        time={(run.timings.embed ?? 0) + (stage('dense')?.ms ?? 0) || undefined}
        why={WHY.dense}
        missing={degraded('embed') ?? degraded('dense')}
      >
        <DenseStep run={run} meta={meta} />
      </Step>

      <Step n={4} title="Fusion — Reciprocal Rank Fusion" where="Browser · Web Worker" time={stage('fused')?.ms} why={WHY.rrf}>
        <RrfStep run={run} meta={meta} />
      </Step>

      <Step
        n={5}
        title="Reranking — cross-encoder"
        where="Edge · Workers AI"
        time={run.timings.rerank}
        why={WHY.rerank}
        missing={degraded('rerank')}
      >
        <RerankStep run={run} meta={meta} />
      </Step>

      <Step n={6} title="Generation — schema-constrained answer" where="Edge · Gemini API" why={WHY.generate}>
        <GenerateStep answer={answer} />
      </Step>

      <Step n={7} title="Verification — quote, span, entailment" where="Browser (checks 1–2) · Edge (check 3)" why={WHY.verify}>
        <VerifyStep answer={answer} meta={meta} />
      </Step>
    </section>
  );
}

const WHY = {
  tokenize:
    'BM25 matches tokens, so the tokenizer decides what is findable. Compounds are kept whole and ' +
    'also split — aria-describedby is indexed as itself and as aria, describedby — while dotted ' +
    'criterion numbers stay whole, because 2, 4 and 11 alone would match every numbered criterion.',
  bm25:
    'The lexical half is what finds identifiers exactly. It runs entirely in the browser, needs no ' +
    'model, and keeps working when the edge is down — the app always has at least this.',
  dense:
    'The semantic half finds passages that answer the question without sharing its words. Only ' +
    'the query is embedded at search time; the 1,592 passages were embedded once, at build time, ' +
    'and ship as a 600 KB int8 file.',
  rrf:
    'BM25 and cosine scores live on incompatible scales. Fusing on rank avoids choosing a ' +
    'normalisation, which would be a tuning knob that breaks on the next corpus.',
  rerank:
    'The first stage optimises recall over 1,592 passages; this stage optimises precision over 30. ' +
    'A cross-encoder reads query and passage together, which a bi-encoder cannot, and decides ' +
    'which 8 passages the generator sees and in what order.',
  generate:
    'The model is asked for claims, not prose with footnotes: each sentence points at its sources ' +
    'by id and carries a quote that must be verbatim. Structured output makes that shape likely; ' +
    'the parser still refuses anything malformed.',
  verify:
    'A citation is only as good as the check behind it. The cheap check runs first and catches ' +
    'most fabrication with no model at all; the expensive one runs only for quotes that held.',
};

function Step({
  n,
  title: heading,
  where,
  time,
  why,
  missing,
  children,
}: {
  n: number;
  title: string;
  where: string;
  time?: number | undefined;
  why: string;
  missing?: string | undefined;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={`step-${n}`} className="border-l-2 border-slate-200 pl-4 dark:border-slate-800">
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Step {n} · {where}
        {time !== undefined && ` · ${ms(time)}`}
      </p>
      <h3 id={`step-${n}`} className="mt-1 text-lg font-semibold">
        {heading}
      </h3>
      <p className="mt-2 max-w-3xl text-sm text-slate-700 dark:text-slate-300">
        <strong className="font-medium">Why this stage: </strong>
        {why}
      </p>
      {missing && (
        <p className="mt-3 rounded border border-amber-600 px-2 py-1 text-sm">Did not run on this query: {missing}</p>
      )}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Timeline({ run, answer }: { run: Run; answer: AnswerState }) {
  const stage = (name: 'dense' | 'lexical' | 'fused') => run.stages.find((s) => s.name === name);
  const answered = answer.phase === 'answered';

  const rows: { label: string; time?: number | undefined; state: string }[] = [
    { label: 'Query embedding', time: run.timings.embed, state: run.degraded.some((d) => d.stage === 'embed') ? 'did not run' : 'ran' },
    { label: 'BM25', time: stage('lexical')?.ms, state: 'ran' },
    { label: 'Dense scan', time: stage('dense')?.ms, state: stage('dense') ? 'ran' : 'did not run' },
    { label: 'RRF fusion', time: stage('fused')?.ms, state: 'ran' },
    { label: 'Rerank', time: run.timings.rerank, state: run.degraded.some((d) => d.stage === 'rerank') ? 'fell back' : 'ran' },
    {
      label: 'Generation + verification',
      state: answered ? 'ran' : answer.phase === 'unavailable' ? 'did not run' : answer.phase === 'idle' ? '—' : 'running',
    },
  ];

  return (
    <ol className="mt-4 grid gap-2 text-sm sm:grid-cols-3 lg:grid-cols-6">
      {rows.map((row, index) => (
        <li key={row.label} className="rounded border border-slate-200 px-2 py-1.5 dark:border-slate-800">
          <span className="text-slate-500 dark:text-slate-400">{index + 1}.</span> {row.label}
          <span className="block tabular-nums text-slate-600 dark:text-slate-400">
            {row.time !== undefined ? ms(row.time) : row.state}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Tokens({ query, terms }: { query: string; terms: Run['bm25']['terms'] }) {
  const all = tokenize(query);
  const known = new Map(terms.map((term) => [term.term, term.df]));

  return (
    <>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        {all.length} tokens, {known.size} distinct. A token found in no chunk contributes nothing.
      </p>
      <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Query tokens">
        {[...new Set(all)].map((token) => {
          const df = known.get(token) ?? 0;
          return (
            <li
              key={token}
              className={`rounded border px-2 py-0.5 font-mono text-sm ${
                df === 0 ? 'border-dashed border-slate-300 text-slate-500 dark:border-slate-700' : 'border-slate-400 dark:border-slate-600'
              }`}
            >
              {token}
              <span className="ml-1.5 text-xs text-slate-500 dark:text-slate-400">
                {df === 0 ? 'not in index' : `in ${df} chunks`}
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function Formula({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded bg-slate-100 px-3 py-2 font-mono text-sm whitespace-pre-wrap dark:bg-slate-900">
      {children}
    </pre>
  );
}

function Table({ caption, head, rows }: { caption: string; head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-md text-left text-sm">
        <caption className="mb-1 text-left text-slate-600 dark:text-slate-400">{caption}</caption>
        <thead>
          <tr className="border-b border-slate-300 dark:border-slate-700">
            {head.map((cell, index) => (
              <th key={cell} scope="col" className={`py-1 pr-3 font-medium ${index > 0 ? 'text-right' : ''}`}>
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} className="border-b border-slate-200 dark:border-slate-800">
              {row.map((cell, index) => (
                <td key={index} className={`py-1 pr-3 ${index > 0 ? 'text-right tabular-nums' : ''}`}>
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

function Bm25Step({ run, meta }: { run: Run; meta: Map<string, ChunkMeta> }) {
  const { bm25 } = run;
  const lexical = run.stages.find((s) => s.name === 'lexical')?.hits ?? [];
  const total = bm25.terms.reduce((sum, term) => sum + term.score, 0);

  return (
    <>
      <Formula>{PARADIGMS[0]!.formula}</Formula>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
        With k1 = {bm25.k1}, b = {bm25.b}, N = {bm25.docCount.toLocaleString('en-GB')} chunks and an
        average chunk length of {bm25.avgdl.toFixed(1)} tokens.
      </p>

      {bm25.chunkId ? (
        <Table
          caption={`Why the top result, “${title(meta, bm25.chunkId)}” (${bm25.docLength} tokens), scored ${total.toFixed(3)}`}
          head={['Term', 'df', 'idf', 'tf in chunk', 'Contribution']}
          rows={bm25.terms.map((term) => [
            <code key="t">{term.term}</code>,
            term.df,
            term.idf.toFixed(3),
            term.tf,
            term.score.toFixed(3),
          ])}
        />
      ) : (
        <p className="mt-3 text-sm">No query term appears in the index, so BM25 returned nothing.</p>
      )}

      <Table
        caption="Top five by BM25"
        head={['Chunk', 'Score']}
        rows={lexical.slice(0, 5).map((hit) => [title(meta, hit.chunkId), hit.score.toFixed(3)])}
      />
    </>
  );
}

function DenseStep({ run, meta }: { run: Run; meta: Map<string, ChunkMeta> }) {
  const dense = run.stages.find((s) => s.name === 'dense')?.hits ?? [];
  const vector = run.vector;
  const norm = vector ? Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) : 0;

  return (
    <>
      <Formula>{PARADIGMS[1]!.formula}</Formula>
      <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
        <dt className="text-slate-500 dark:text-slate-400">Encoder</dt>
        <dd>
          <code>{MODELS.embedding}</code> — BAAI General Embedding, small, English; 384 dimensions,
          512-token window. Run on Cloudflare Workers AI.
        </dd>
        <dt className="text-slate-500 dark:text-slate-400">Asymmetric input</dt>
        <dd>
          The query is prefixed with “{MODELS.queryPrefix.trim()}”; passages are not. bge-v1.5 is
          trained that way, and prefixing a passage would cost recall.
        </dd>
        <dt className="text-slate-500 dark:text-slate-400">Index</dt>
        <dd>
          Each passage vector is L2-normalised and quantised to int8 with its own scale
          (scale = max|vᵢ| / 127). The query stays float32, so cosine is one dot product per
          passage, rescaled.
        </dd>
        {vector && (
          <>
            <dt className="text-slate-500 dark:text-slate-400">This query</dt>
            <dd className="tabular-nums">
              {vector.length} components, ‖u‖ = {norm.toFixed(4)}, first five:{' '}
              {vector
                .slice(0, 5)
                .map((v) => v.toFixed(4))
                .join(', ')}
              …
            </dd>
          </>
        )}
      </dl>
      {dense.length > 0 && (
        <Table
          caption="Top five by cosine similarity"
          head={['Chunk', 'Cosine', 'BM25 rank']}
          rows={dense
            .slice(0, 5)
            .map((hit) => [
              title(meta, hit.chunkId),
              hit.score.toFixed(3),
              rankOf(run.stages.find((s) => s.name === 'lexical')?.hits, hit.chunkId) ?? 'not in top 30',
            ])}
        />
      )}
    </>
  );
}

function RrfStep({ run, meta }: { run: Run; meta: Map<string, ChunkMeta> }) {
  const lists = {
    dense: run.stages.find((s) => s.name === 'dense')?.hits,
    lexical: run.stages.find((s) => s.name === 'lexical')?.hits,
  };
  const fused = run.stages.find((s) => s.name === 'fused')?.hits ?? [];
  const part = (rank: number | undefined) => (rank === undefined ? 0 : 1 / (RRF_K + rank));
  const cell = (rank: number | undefined) =>
    rank === undefined ? '—' : `#${rank} → ${part(rank).toFixed(4)}`;

  return (
    <>
      <Formula>{PARADIGMS[2]!.formula}</Formula>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
        Each list contributes 1/(60 + rank). The best a single list can give is 1/61 ≈ 0.0164; a
        chunk ranked by both lists, even modestly, outscores one ranked first by only one of them.
      </p>
      <Table
        caption={`The top ${PIPELINE_CONSTANTS.final} fused candidates, with the arithmetic`}
        head={['Chunk', 'Dense', 'BM25', 'RRF']}
        rows={fused.slice(0, PIPELINE_CONSTANTS.final).map((hit) => {
          const d = rankOf(lists.dense, hit.chunkId);
          const l = rankOf(lists.lexical, hit.chunkId);
          return [title(meta, hit.chunkId), cell(d), cell(l), hit.score.toFixed(4)];
        })}
      />
    </>
  );
}

function RerankStep({ run, meta }: { run: Run; meta: Map<string, ChunkMeta> }) {
  const fused = run.stages.find((s) => s.name === 'fused')?.hits;

  return (
    <>
      <Formula>{PARADIGMS[3]!.formula}</Formula>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
        <code>{MODELS.reranker}</code> — a cross-encoder on an XLM-RoBERTa base. It scores the{' '}
        {PIPELINE_CONSTANTS.candidates} fused candidates as (query, passage) pairs and keeps the
        best {PIPELINE_CONSTANTS.final}. Its scores are relevance estimates, not comparable to
        either score above.
      </p>
      <Table
        caption="Where the reranker moved each passage"
        head={['Chunk', 'Fused rank', 'Final rank', 'Score']}
        rows={run.final.map((hit, index) => [
          title(meta, hit.chunkId),
          `#${rankOf(fused, hit.chunkId) ?? '—'}`,
          `#${index + 1}`,
          hit.score.toFixed(3),
        ])}
      />
    </>
  );
}

function GenerateStep({ answer }: { answer: AnswerState }) {
  if (answer.phase === 'idle' || answer.phase === 'generating') {
    return <p className="text-sm text-slate-600 dark:text-slate-400">Waiting for the generator…</p>;
  }
  if (answer.phase === 'unavailable') {
    return <p className="text-sm">No answer was generated: {answer.reason}</p>;
  }

  const generated = answer.phase === 'verifying' ? answer.answer : answer.result.answer;
  const model = answer.phase === 'answered' ? answer.result.model : undefined;

  return (
    <>
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
        <dt className="text-slate-500 dark:text-slate-400">Model</dt>
        <dd>
          {model ? <code>{model}</code> : 'not reported by this worker deployment'} — first of the
          chain <code>{MODELS.generationChain.join(' → ')}</code> to answer. A busy model (429, 503)
          is retried twice, then the next is tried.
        </dd>
        <dt className="text-slate-500 dark:text-slate-400">Decoding</dt>
        <dd>temperature 0, response constrained to a JSON schema</dd>
        <dt className="text-slate-500 dark:text-slate-400">Context</dt>
        <dd>
          the {PIPELINE_CONSTANTS.final} reranked passages, each wrapped as{' '}
          <code>{'<source id="…">'}</code>, then the question
        </dd>
        <dt className="text-slate-500 dark:text-slate-400">Rules</dt>
        <dd>
          answer only from the sources; decline when they do not answer; one claim per factual
          sentence; the quote copied character for character, never shortened or stitched
        </dd>
      </dl>
      <p className="mt-3 text-sm text-slate-600 dark:text-slate-400">
        The schema, and what this model returned for it:
      </p>
      <Formula>
        {`{ answerable: boolean,\n  sentences: string[],\n  claims: { sentenceIndex: int, chunkIds: string[], quote: string }[] }`}
      </Formula>
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer">
          Raw output: {generated.sentences.length} sentences, {generated.claims.length} claims,
          answerable = {String(generated.answerable)}
        </summary>
        <Formula>{JSON.stringify(generated, null, 2)}</Formula>
      </details>
    </>
  );
}

const STATUS_WORD: Record<VerifiedClaim['status'], string> = {
  verified: '✓ verified',
  partial: '≈ partial',
  unsupported: '✕ unsupported',
  unverified: '? unverified',
};

function VerifyStep({ answer, meta }: { answer: AnswerState; meta: Map<string, ChunkMeta> }) {
  if (answer.phase !== 'answered') {
    return (
      <p className="text-sm text-slate-600 dark:text-slate-400">
        {answer.phase === 'unavailable' ? 'Nothing to verify: no answer was generated.' : 'Waiting for the answer…'}
      </p>
    );
  }

  const { claims } = answer.result;

  return (
    <>
      <Formula>{PARADIGMS[5]!.formula}</Formula>
      <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm">
        <li>
          <strong className="font-medium">Quote match</strong> — the quote must be a literal substring
          of a cited chunk, after a fixed normalisation (Unicode NFC, whitespace runs, curly quotes,
          dashes, ellipses). Case is not normalised.
        </li>
        <li>
          <strong className="font-medium">Span resolution</strong> — the match is mapped back to
          character offsets in the source document, so it can be highlighted where it sits.
        </li>
        <li>
          <strong className="font-medium">Entailment</strong> — an LLM judge labels each (evidence,
          sentence) pair supported (1), partially supported (0.5) or not supported (0), in one
          batched call. Verified at ≥ {PIPELINE_CONSTANTS.verifiedAt}, partial at ≥{' '}
          {PIPELINE_CONSTANTS.partialAt}.
        </li>
      </ol>
      {claims.length === 0 ? (
        <p className="mt-3 text-sm">The answer made no claims to verify.</p>
      ) : (
        <Table
          caption="Every claim in this answer, and what each check found"
          head={['Sentence', 'Quote found', 'Span', 'Entailment', 'Status']}
          rows={claims.map((claim) => [
            <span key="s" className="block max-w-sm">
              {claim.sentence}
            </span>,
            claim.quoteMatch
              ? `in ${claim.supportingChunkIds.length} of ${claim.chunkIds.length} cited`
              : 'no',
            claim.span ? (
              <span key="p" title={title(meta, claim.span.chunkId)}>
                {claim.span.start}–{claim.span.end}
              </span>
            ) : (
              '—'
            ),
            claim.entailment === null ? 'judge unavailable' : claim.entailment.toFixed(1),
            STATUS_WORD[claim.status],
          ])}
        />
      )}
    </>
  );
}

// ── the reference half ──────────────────────────────────────────────────────

function Paradigms() {
  return (
    <section aria-labelledby="paradigms-heading">
      <h2 id="paradigms-heading" className="text-xl font-semibold">
        The six techniques, and what each one does
      </h2>
      <p className="mt-2 max-w-3xl text-slate-600 dark:text-slate-400">
        “RAG” names a family, not one method. This system composes six: two first-stage retrievers,
        a fusion rule, a second-stage reranker, a generator, and a verifier. Each is described as it
        would be in a lecture, with its defining formula, its cost here, and the paper it comes from.
      </p>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {PARADIGMS.map((paradigm) => (
          <ParadigmCard key={paradigm.id} paradigm={paradigm} />
        ))}
      </div>
    </section>
  );
}

function ParadigmCard({ paradigm }: { paradigm: Paradigm }) {
  const row = ABLATION.find((entry) => entry.retriever === paradigm.ablationRow);
  const id = `paradigm-${paradigm.id}`;

  return (
    <article aria-labelledby={id} className="rounded-md border border-slate-200 p-4 dark:border-slate-800">
      <p className="text-sm text-slate-500 dark:text-slate-400">{paradigm.family}</p>
      <h3 id={id} className="mt-1 font-semibold">
        {paradigm.name}
      </h3>
      <p className="mt-2 text-sm leading-relaxed">{paradigm.idea}</p>
      <div className="mt-3">
        <Formula>{paradigm.formula}</Formula>
      </div>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
        <strong className="font-medium">Cost here: </strong>
        {paradigm.cost}
      </p>
      <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <h4 className="font-medium">Strengths</h4>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {paradigm.strengths.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <div>
          <h4 className="font-medium">Failure modes</h4>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {paradigm.failures.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </div>
      {row && (
        <p className="mt-3 text-sm tabular-nums">
          <strong className="font-medium">Measured alone on this corpus: </strong>
          Recall@10 {pct(row.recall10)}, Success@5 {pct(row.success5)}, MRR {row.mrr.toFixed(3)}
        </p>
      )}
      <ul className="mt-3 space-y-0.5 text-sm text-slate-600 dark:text-slate-400">
        {paradigm.references.map((ref) => (
          <li key={ref.url}>
            {ref.authors} ({ref.year}).{' '}
            <a href={ref.url} className="underline underline-offset-2" rel="noreferrer">
              {ref.title}
            </a>
            . <i>{ref.venue}</i>.
          </li>
        ))}
      </ul>
    </article>
  );
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

function Evaluation() {
  return (
    <section aria-labelledby="evaluation-heading">
      <h2 id="evaluation-heading" className="text-xl font-semibold">
        How the combination was justified
      </h2>
      <p className="mt-2 max-w-3xl text-slate-600 dark:text-slate-400">
        An ablation over 60 hand-annotated questions and 1,592 chunks: each retriever alone, then
        fused, then reranked. Relevance is graded — primary chunks answer the question, context
        chunks come from the same document.
      </p>

      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        {METRICS.map((metric) => (
          <div key={metric.name} className="rounded border border-slate-200 p-3 dark:border-slate-800">
            <dt className="font-medium">{metric.name}</dt>
            <dd className="mt-1 font-mono text-xs">{metric.formula}</dd>
            <dd className="mt-1 text-slate-600 dark:text-slate-400">{metric.reads}</dd>
          </div>
        ))}
      </dl>

      <Table
        caption="Ablation, all 55 answerable questions"
        head={['Retriever', 'Recall@5', 'Recall@10', 'Success@5', 'nDCG@10', 'MRR']}
        rows={ABLATION.map((row) => [
          row.retriever,
          pct(row.recall5),
          pct(row.recall10),
          pct(row.success5),
          row.ndcg10.toFixed(3),
          row.mrr.toFixed(3),
        ])}
      />
      <Table
        caption="Recall@10 by question kind — the finding the design rests on"
        head={[
          'Retriever',
          `Identifier (${QUESTION_KINDS.identifier})`,
          `Conceptual (${QUESTION_KINDS.conceptual})`,
          `Design (${QUESTION_KINDS.design})`,
        ]}
        rows={ABLATION.map((row) => [
          row.retriever,
          pct(row.byKind.identifier),
          pct(row.byKind.conceptual),
          pct(row.byKind.design),
        ])}
      />
      <p className="mt-3 max-w-3xl text-sm">
        BM25 is strongest on identifiers and weakest on paraphrase; dense retrieval is the mirror
        image. Neither is good at both, which is the case for fusing them. The reranked row returns 8
        results rather than 30, so compare it on Recall@5, Success@5 and MRR.
      </p>
    </section>
  );
}

function SystemDesign() {
  return (
    <section aria-labelledby="design-heading">
      <h2 id="design-heading" className="text-xl font-semibold">
        System design
      </h2>
      <p className="mt-2 max-w-3xl text-slate-600 dark:text-slate-400">
        Static index in the client, models at the edge, no server. Only three things cannot be
        precomputed — the query embedding, the reranking and the generation — so only those leave
        the browser.
      </p>
      <Table
        caption="Where each part runs"
        head={['Part', 'Runs in', 'Built']}
        rows={[
          ['Normalisation, chunking, BM25 index, passage embeddings', 'Node, at build time', 'once'],
          ['Tokenization, BM25, dense scan, RRF', 'Browser, Web Worker', 'per query'],
          ['Query embedding, reranking, generation, entailment', 'Cloudflare Worker', 'per query'],
          ['Quote match and span resolution', 'Browser, main thread', 'per answer'],
        ]}
      />
      <Table
        caption="The corpus"
        head={['Source', 'Documents', 'Characters']}
        rows={CORPUS.map((row) => [row.source, row.documents, row.characters.toLocaleString('en-GB')])}
      />
      <p className="mt-3 max-w-3xl text-sm">
        Chunking is structure-aware: a chunk targets {PIPELINE_CONSTANTS.chunk.targetTokens} tokens,
        never exceeds {PIPELINE_CONSTANTS.chunk.maxTokens}, carries{' '}
        {PIPELINE_CONSTANTS.chunk.overlap * 100}% of its predecessor, and is always a contiguous slice
        of the normalised document — so its offsets hold by construction and a verified quote can be
        highlighted exactly where it sits.
      </p>
    </section>
  );
}
