import { RRF_K, tokenize, type Scored, type VerifiedClaim } from '@rag/core';
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import type { ChunkMeta } from './retrieval.worker.ts';
import { IngestView } from './ingest-view.tsx';
import {
  PlainWords,
  bm25Plain,
  densePlain,
  generatePlain,
  rerankPlain,
  rrfPlain,
  tokenizePlain,
  verifyPlain,
  type Plain,
} from './plain.tsx';
import { useLang } from './i18n.tsx';
import { RunDiagram } from './run-diagram.tsx';
import { localized } from './theory-it.ts';
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
  { id: 'step-tokenize', label: 'Tokenization', it: 'Tokenizzazione' },
  { id: 'step-bm25', label: 'BM25', it: 'BM25' },
  { id: 'step-dense', label: 'Dense retrieval', it: 'Retrieval semantico' },
  { id: 'step-rrf', label: 'Rank fusion', it: 'Fusione dei ranking' },
  { id: 'step-rerank', label: 'Reranking', it: 'Reranking' },
  { id: 'step-generate', label: 'Generation', it: 'Generazione' },
  { id: 'step-verify', label: 'Verification', it: 'Verifica' },
];

const REFERENCE = [
  { id: 'ingestion', label: 'How the index was built', it: 'Come è stato costruito l’indice' },
  { id: 'method', label: 'The six techniques', it: 'Le sei tecniche' },
  { id: 'evaluation', label: 'Evaluation', it: 'Valutazione' },
  { id: 'system', label: 'System design', it: 'Architettura' },
  { id: 'design-system', label: 'Design system', it: 'Design system' },
];

export function Explain({ retrieval, answer }: { retrieval: Retrieval; answer: AnswerState }) {
  const { run, meta } = retrieval;
  const { t } = useLang();
  const sections = run ? [...STEPS, ...REFERENCE] : REFERENCE;
  // A new run remounts the steps, so the observer has to be rebuilt with it.
  const current = useScrollSpy(sections.map((section) => section.id), run?.timings.total);

  return (
    <div className="mt-10 grid gap-12 lg:grid-cols-[13rem_minmax(0,1fr)]">
      <nav aria-label={t('On this page', 'In questa pagina')} className="hidden lg:block">
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
                {t(section.label, section.it)}
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
            {t(
              'Ask a question and this view walks through the seven stages it went through, with that question’s own numbers. The reference material below is always here.',
              'Fai una domanda e questa vista ripercorre le sette fasi che ha attraversato, con i numeri di quella domanda. Il materiale di riferimento qui sotto c’è sempre.',
            )}
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
  const { t, lang, num } = useLang();
  const ctx = { run, meta, title: (id: string) => title(meta, id), t, num };
  const why = lang === 'it' ? WHY_IT : WHY;

  return (
    <section aria-labelledby="walkthrough-heading">
      <SectionHeading
        id="walkthrough-heading"
        lead={t(
          'Seven stages, in the order they ran. Each one is explained twice: first in plain words, with what it did to your question, then technically, with the model or formula behind it.',
          'Sette fasi, nell’ordine in cui sono state eseguite. Ognuna è spiegata due volte: prima a parole semplici, con quello che ha fatto alla tua domanda, poi tecnicamente, con il modello o la formula che c’è dietro.',
        )}
      >
        {t('What happened to', 'Cosa è successo a')} “{run.query}”
      </SectionHeading>

      <div className="mt-8">
        <RunDiagram key={run.query + run.timings.total} run={run} answer={answer} total={meta.size} />
      </div>

      {/* Keyed on the run, so a new question replays the charts rather than jumping to new values. */}
      <ol key={run.query + run.timings.total} className="mt-12 border-l border-line">
        <Step id="step-tokenize" title={t('Tokenization', 'Tokenizzazione')} where="Browser, Web Worker" why={why.tokenize} plain={tokenizePlain(ctx)}>
          <Tokens query={run.query} terms={run.bm25.terms} />
        </Step>

        <Step
          id="step-bm25"
          title={t('Sparse retrieval with Okapi BM25', 'Retrieval lessicale con Okapi BM25')}
          where="Browser, Web Worker"
          time={stage('lexical')?.ms}
          why={why.bm25}
          plain={bm25Plain(ctx)}
        >
          <Bm25Step run={run} meta={meta} />
        </Step>

        <Step
          id="step-dense"
          title={t('Dense retrieval with a bi-encoder', 'Retrieval semantico con un bi-encoder')}
          where={t('Edge embeds, browser scans', 'L’edge codifica, il browser scansiona')}
          time={(run.timings.embed ?? 0) + (stage('dense')?.ms ?? 0) || undefined}
          why={why.dense}
          plain={densePlain(ctx)}
          missing={degraded('embed') ?? degraded('dense')}
        >
          <DenseStep run={run} meta={meta} />
        </Step>

        <Step id="step-rrf" title="Reciprocal Rank Fusion" where="Browser, Web Worker" time={stage('fused')?.ms} why={why.rrf} plain={rrfPlain(ctx)}>
          <RrfStep run={run} meta={meta} />
        </Step>

        <Step
          id="step-rerank"
          title={t('Reranking with a cross-encoder', 'Reranking con un cross-encoder')}
          where="Edge, Workers AI"
          time={run.timings.rerank}
          why={why.rerank}
          plain={rerankPlain(ctx)}
          missing={degraded('rerank')}
        >
          <RerankStep run={run} meta={meta} />
        </Step>

        <Step
          id="step-generate"
          title={t('Schema-constrained generation', 'Generazione vincolata da uno schema')}
          where={t('Edge, Gemini or Workers AI', 'Edge, Gemini o Workers AI')}
          time={timings?.generate}
          why={why.generate}
          plain={generatePlain({ answer, run, t })}
        >
          <GenerateStep answer={answer} />
        </Step>

        <Step
          id="step-verify"
          title={t('Verification: quote, span, entailment', 'Verifica: citazione, span, entailment')}
          where={t('Browser, then edge', 'Browser, poi edge')}
          time={timings?.verify}
          why={why.verify}
          plain={verifyPlain({ answer, t })}
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

const WHY_IT: typeof WHY = {
  tokenize:
    'BM25 confronta token, quindi è il tokenizer a decidere cosa si può trovare. Le parole composte vengono tenute intere e anche divise: aria-describedby è indicizzata come se stessa e come aria e describedby. I numeri di criterio col punto restano interi, perché 2, 4 e 11 da soli combacerebbero con ogni criterio numerato.',
  bm25:
    'La metà lessicale trova gli identificatori in modo esatto. Gira tutta nel browser, non ha bisogno di un modello e continua a funzionare quando l’edge non risponde, quindi l’app ha sempre almeno questa.',
  dense:
    'La metà semantica trova passaggi che rispondono alla domanda senza condividerne le parole. Al momento della ricerca si codifica solo la domanda. I 1.592 passaggi sono stati codificati una volta, in fase di build, e sono pubblicati come un file int8 da 600 KB.',
  rrf:
    'I punteggi di BM25 e del coseno stanno su scale incompatibili. Fondere sui ranking evita di scegliere una normalizzazione, che sarebbe una manopola da tarare destinata a rompersi sul prossimo corpus.',
  rerank:
    'La prima fase ottimizza il recall su 1.592 passaggi; questa ottimizza la precisione su 30. Un cross-encoder legge domanda e passaggio insieme, cosa che un bi-encoder non può fare, e decide quali 8 passaggi vede il generatore, e in che ordine.',
  generate:
    'Al modello si chiedono affermazioni, non prosa con note. Ogni frase indica le sue fonti per id e porta una citazione che deve essere verbatim. L’output strutturato rende probabile questa forma; il parser rifiuta comunque tutto ciò che è malformato.',
  verify:
    'Una citazione vale quanto il controllo che c’è dietro. Il controllo economico viene prima e prende la maggior parte delle invenzioni senza alcun modello. Quello costoso gira solo per le citazioni che hanno retto.',
};

function Step({
  id,
  title: heading,
  where,
  time,
  why,
  plain,
  missing,
  children,
}: {
  id: string;
  title: string;
  where: string;
  time?: number | undefined;
  why: string;
  plain: Plain;
  missing?: string | undefined;
  children: ReactNode;
}) {
  const { t } = useLang();
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
        {missing && (
          <p className="mt-4 rounded-xl border border-partial px-3 py-2 text-sm">
            {t('Did not run on this query:', 'Non eseguita per questa domanda:')} {missing}
          </p>
        )}
        <div className="mt-5">
          <PlainWords plain={plain} />
        </div>
        <h4 className="mt-8 font-medium">{t('The technical version', 'La versione tecnica')}</h4>
        <p className="mt-2 max-w-[65ch] leading-relaxed text-ink-2">
          <span className="text-ink">{t('Why this stage exists. ', 'Perché esiste questa fase. ')}</span>
          {why}
        </p>
        <div className="mt-6 space-y-6">{children}</div>
      </section>
    </li>
  );
}

function Tokens({ query, terms }: { query: string; terms: Run['bm25']['terms'] }) {
  const all = tokenize(query);
  const known = new Map(terms.map((term) => [term.term, term.df]));
  const distinct = [...new Set(all)];
  const { t } = useLang();

  return (
    <div className="viz-in">
      <p className="text-sm text-ink-2">
        {t(
          `“${query}” becomes ${all.length} tokens, ${distinct.length} distinct. A token that appears in no chunk contributes nothing.`,
          `“${query}” diventa ${all.length} token, ${distinct.length} distinti. Un token che non compare in nessun chunk non contribuisce.`,
        )}
      </p>
      <ul className="mt-4 flex flex-wrap gap-2" aria-label={t('Query tokens', 'Token della domanda')}>
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
              <span className="ml-2 text-xs text-muted">{df === 0 ? t('not in index', 'non nell’indice') : `${df} chunk`}</span>
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
  const { t, num } = useLang();

  return (
    <>
      <Formula label={t('Okapi BM25, with smoothed idf', 'Okapi BM25, con idf smussato')}>{PARADIGMS[0]!.formula}</Formula>
      <p className="text-sm text-ink-2">
        {t(
          `Here k1 = ${bm25.k1}, b = ${bm25.b}, N = ${num(bm25.docCount)} chunks, and the average chunk is ${bm25.avgdl.toFixed(1)} tokens long.`,
          `Qui k1 = ${bm25.k1}, b = ${bm25.b}, N = ${num(bm25.docCount)} chunk, e il chunk medio è lungo ${num(bm25.avgdl, 1)} token.`,
        )}
      </p>

      {bm25.chunkId ? (
        <Figure
          title={t(`Why the top result scored ${total.toFixed(2)}`, `Perché il primo risultato ha preso ${total.toFixed(2)}`)}
          caption={t(
            `“${title(meta, bm25.chunkId)}”, ${bm25.docLength} tokens. Each bar is one query term’s share of the sum. A frequent term (low idf) adds little even when repeated.`,
            `“${title(meta, bm25.chunkId)}”, ${bm25.docLength} token. Ogni barra è la quota della somma di un termine della domanda. Un termine frequente (idf basso) aggiunge poco anche se ripetuto.`,
          )}
          table={{
            head: [t('Term', 'Termine'), 'df', 'idf', 'tf', t('Contribution', 'Contributo')],
            rows: bm25.terms.map((term) => [<code key="t">{term.term}</code>, term.df, term.idf.toFixed(3), term.tf, term.score.toFixed(3)]),
          }}
        >
          <Bars
            series="lexical"
            format={(v) => v.toFixed(2)}
            rows={terms.map((term) => ({
              label: <code>{term.term}</code>,
              value: term.score,
              note: term.tf === 0 ? t('absent from chunk', 'assente dal chunk') : `tf ${term.tf}, idf ${term.idf.toFixed(2)}`,
            }))}
          />
        </Figure>
      ) : (
        <p className="text-sm">
          {t('No query term appears in the index, so BM25 returned nothing.', 'Nessun termine della domanda è nell’indice, quindi BM25 non ha restituito nulla.')}
        </p>
      )}

      <Figure
        title={t('Top five by BM25', 'I primi cinque per BM25')}
        caption={t(
          'Scores are unbounded sums of idf terms, meaningful only within this one ranking.',
          'I punteggi sono somme illimitate di termini idf, con senso solo dentro questo ranking.',
        )}
        table={{
          head: ['Chunk', t('Score', 'Punteggio')],
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
  const { t } = useLang();

  return (
    <>
      <Formula label={t('Cosine similarity in embedding space', 'Similarità del coseno nello spazio degli embedding')}>
        {PARADIGMS[1]!.formula}
      </Formula>
      <Spec
        items={[
          [
            'Encoder',
            <>
              <code>{MODELS.embedding}</code>.{' '}
              {t(
                'BAAI General Embedding, small, English: 384 dimensions, a 512-token window, run on Cloudflare Workers AI.',
                'BAAI General Embedding, small, inglese: 384 dimensioni, una finestra di 512 token, eseguito su Cloudflare Workers AI.',
              )}
            </>,
          ],
          [
            t('Asymmetric input', 'Input asimmetrico'),
            t(
              `The query is prefixed with “${MODELS.queryPrefix.trim()}”. Passages are not. bge-v1.5 is trained that way, and prefixing a passage would cost recall.`,
              `Alla domanda si antepone “${MODELS.queryPrefix.trim()}”. Ai passaggi no. bge-v1.5 è addestrato così, e aggiungere il prefisso a un passaggio costerebbe recall.`,
            ),
          ],
          [
            t('Index', 'Indice'),
            t(
              'Each passage vector is L2-normalised, then quantised to int8 with its own scale (max|vᵢ| / 127). The query stays float32, so cosine is one dot product per passage, rescaled.',
              'Ogni vettore di passaggio è normalizzato L2, poi quantizzato in int8 con la propria scala (max|vᵢ| / 127). La domanda resta float32, quindi il coseno è un prodotto scalare per passaggio, riscalato.',
            ),
          ],
        ]}
      />
      {vector && (
        <Figure
          title={t('This question, as 384 numbers', 'Questa domanda, come 384 numeri')}
          caption={t(
            `The query embedding as the encoder returned it, one bar per dimension, ‖u‖ = ${norm.toFixed(4)}. No single dimension means anything; the direction of the whole vector does.`,
            `L’embedding della domanda come l’ha restituito l’encoder, una barra per dimensione, ‖u‖ = ${norm.toFixed(4)}. Nessuna dimensione significa qualcosa da sola; conta la direzione del vettore intero.`,
          )}
          table={{ head: [t('Dimension', 'Dimensione'), t('Value', 'Valore')], rows: vector.map((v, i) => [i, v.toFixed(5)]) }}
        >
          <VectorStrip vector={vector} />
        </Figure>
      )}
      {dense.length > 0 && (
        <Figure
          title={t('Top five by cosine similarity', 'I primi cinque per similarità del coseno')}
          caption={t(
            'Next to each, where BM25 ranked the same chunk. The two retrievers often disagree.',
            'Accanto a ciascuno, dove BM25 ha messo lo stesso chunk. I due retriever spesso non sono d’accordo.',
          )}
          table={{
            head: ['Chunk', t('Cosine', 'Coseno'), t('BM25 rank', 'Posizione BM25')],
            rows: dense
              .slice(0, 5)
              .map((hit) => [title(meta, hit.chunkId), hit.score.toFixed(3), rankOf(lexical, hit.chunkId) ?? t('not in top 30', 'non nei primi 30')]),
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
                note: lexicalRank ? `BM25 #${lexicalRank}` : t('BM25 missed it', 'BM25 non l’ha trovato'),
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
  const { t } = useLang();
  const cell = (rank: number | undefined) => (rank === undefined ? t('absent', 'assente') : `#${rank}, ${part(rank).toFixed(4)}`);

  return (
    <>
      <Formula label="Reciprocal Rank Fusion">{PARADIGMS[2]!.formula}</Formula>
      <p className="max-w-[65ch] text-sm leading-relaxed text-ink-2">
        {t(
          'Each list contributes 1/(60 + rank). The most a single list can give is 1/61 ≈ 0.0164, so a chunk that both lists ranked, even modestly, outscores one that only a single list put first.',
          'Ogni lista contribuisce 1/(60 + posizione). Il massimo che una sola lista può dare è 1/61 ≈ 0,0164, quindi un chunk messo in classifica da entrambe le liste, anche in modo modesto, supera uno che una sola lista ha messo primo.',
        )}
      </p>
      <Figure
        title={t(
          `The top ${fused.length} fused candidates, and where each score came from`,
          `I primi ${fused.length} candidati fusi, e da dove viene ogni punteggio`,
        )}
        caption={t('Each bar is the RRF sum, split into the dense vote and the BM25 vote.', 'Ogni barra è la somma RRF, divisa fra il voto semantico e il voto BM25.')}
        legend={['dense', 'lexical']}
        table={{
          head: ['Chunk', t('Dense', 'Semantico'), 'BM25', 'RRF'],
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
  const { t } = useLang();

  return (
    <>
      <Formula label={t('Cross-encoder relevance', 'Rilevanza del cross-encoder')}>{PARADIGMS[3]!.formula}</Formula>
      <p className="max-w-[65ch] text-sm leading-relaxed text-ink-2">
        <code>{MODELS.reranker}</code>{' '}
        {t(
          `is a cross-encoder on an XLM-RoBERTa base. It scores the ${PIPELINE_CONSTANTS.candidates} fused candidates as (query, passage) pairs and keeps the best ${PIPELINE_CONSTANTS.final}. Its scores are relevance estimates, comparable to neither score above.`,
          `è un cross-encoder su base XLM-RoBERTa. Valuta i ${PIPELINE_CONSTANTS.candidates} candidati fusi come coppie (domanda, passaggio) e tiene i migliori ${PIPELINE_CONSTANTS.final}. I suoi punteggi sono stime di rilevanza, non confrontabili con nessuno dei punteggi sopra.`,
        )}
      </p>
      <Figure
        title={t('Where the reranker moved each passage', 'Dove il reranker ha spostato ogni passaggio')}
        caption={t(
          `Left, the fused rank among ${fused.length}; right, the final rank among ${run.final.length}. Highlighted lines climbed.`,
          `A sinistra la posizione fusa su ${fused.length}; a destra la posizione finale su ${run.final.length}. Le linee evidenziate sono salite.`,
        )}
        table={{
          head: ['Chunk', t('Fused rank', 'Posizione fusa'), t('Final rank', 'Posizione finale'), t('Score', 'Punteggio')],
          rows: run.final.map((hit, i) => [
            title(meta, hit.chunkId),
            `#${rankOf(fused, hit.chunkId) ?? t('absent', 'assente')}`,
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
  const { t } = useLang();
  if (answer.phase === 'idle' || answer.phase === 'generating') {
    return (
      <Pending>
        {t(
          'Waiting for the generator. A busy model is retried before the next one is tried, so this can take a while.',
          'Aspetto il generatore. Un modello occupato viene riprovato prima di passare al successivo, quindi può volerci un po’.',
        )}
      </Pending>
    );
  }
  if (answer.phase === 'unavailable') {
    return (
      <p className="rounded-xl border border-partial px-3 py-2 text-sm">
        {t('No answer was generated:', 'Nessuna risposta generata:')} {answer.reason}
      </p>
    );
  }

  const generated = answer.phase === 'verifying' ? answer.answer : answer.result.answer;
  const model = answer.phase === 'answered' ? answer.result.model : undefined;

  return (
    <>
      <Spec
        items={[
          [
            t('Model', 'Modello'),
            <>
              {model ? <code>{model}</code> : t('Not reported by this worker deployment', 'Non indicato da questa versione del worker')}
              {t(', the first of ', ', il primo di ')}
              <code>{MODELS.generationChain.join(' → ')}</code>
              {t(
                ' to answer. A busy Gemini model (429, 503) is retried twice, then the next one is tried. The last two run on Workers AI, a separate free quota that needs no key, so one provider running dry is not an outage.',
                ' a rispondere. Un modello Gemini occupato (429, 503) viene riprovato due volte, poi si passa al successivo. Gli ultimi due girano su Workers AI, una quota gratuita separata che non richiede chiavi, quindi se un fornitore resta senza quota il sito non si ferma.',
              )}
            </>,
          ],
          [
            t('Decoding', 'Decodifica'),
            t(
              'Temperature 0, output constrained to a JSON schema (Gemini structured output, or Workers AI JSON mode).',
              'Temperatura 0, output vincolato a uno schema JSON (structured output di Gemini, o JSON mode di Workers AI).',
            ),
          ],
          [
            t('Context', 'Contesto'),
            <>
              {t(`The ${PIPELINE_CONSTANTS.final} reranked passages, each wrapped as `, `Gli ${PIPELINE_CONSTANTS.final} passaggi riordinati, ognuno racchiuso in `)}
              <code>{'<source id="…">'}</code>
              {t(', then the question.', ', poi la domanda.')}
            </>,
          ],
          [
            t('Rules', 'Regole'),
            t(
              'Answer only from the sources. Decline when they do not answer. One claim per factual sentence. The quote copied character for character, never shortened or stitched. Each WCAG threshold with its level.',
              'Rispondere solo dalle fonti. Rifiutarsi quando non rispondono. Una citazione per ogni frase fattuale. La citazione copiata carattere per carattere, mai accorciata o cucita. Ogni soglia WCAG con il suo livello. In italiano le frasi sono tradotte, le citazioni restano in inglese.',
            ),
          ],
        ]}
      />
      <Formula label={t('The schema the model must fill', 'Lo schema che il modello deve riempire')}>
        {`{ answerable: boolean,\n  sentences: string[],\n  claims: { sentenceIndex: int, chunkIds: string[], quote: string }[] }`}
      </Formula>
      <details className="rounded-xl border border-line px-4 py-3 text-sm">
        <summary className="cursor-pointer">
          {t(
            `What the model returned: ${generated.sentences.length} sentences, ${generated.claims.length} claims, answerable = ${String(generated.answerable)}`,
            `Cosa ha restituito il modello: ${generated.sentences.length} frasi, ${generated.claims.length} citazioni, answerable = ${String(generated.answerable)}`,
          )}
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

const STATUS_IT: Record<VerifiedClaim['status'], string> = {
  verified: 'verificata',
  partial: 'parziale',
  unsupported: 'non supportata',
  unverified: 'non verificata',
};

const STATUS: Record<VerifiedClaim['status'], { mark: string; className: string }> = {
  verified: { mark: '✓', className: 'text-verified' },
  partial: { mark: '≈', className: 'text-partial' },
  unsupported: { mark: '✕', className: 'text-unsupported' },
  unverified: { mark: '?', className: 'text-unverified' },
};

function VerifyStep({ answer, meta }: { answer: AnswerState; meta: Map<string, ChunkMeta> }) {
  const { t } = useLang();
  if (answer.phase !== 'answered') {
    return answer.phase === 'unavailable' ? (
      <p className="text-sm text-ink-2">{t('Nothing to verify: no answer was generated.', 'Niente da verificare: nessuna risposta generata.')}</p>
    ) : (
      <Pending>{t('Waiting for the answer.', 'Aspetto la risposta.')}</Pending>
    );
  }

  const { claims } = answer.result;
  const found = claims.filter((claim) => claim.quoteMatch).length;
  const judged = claims.filter((claim) => claim.quoteMatch && claim.entailment !== null).length;
  const verified = claims.filter((claim) => claim.status === 'verified').length;

  return (
    <>
      <Formula label={t('The four outcomes', 'I quattro esiti')}>{PARADIGMS[5]!.formula}</Formula>
      <ol className="grid gap-4 text-sm md:grid-cols-3">
        {[
          [
            t('Quote match', 'Confronto della citazione'),
            t(
              'The quote must be a literal substring of a cited chunk, after a fixed normalisation: Unicode NFC, whitespace runs, curly quotes, dashes, ellipses. Case is not normalised.',
              'La citazione deve essere una sottostringa letterale di un chunk citato, dopo una normalizzazione fissa: Unicode NFC, spazi ripetuti, virgolette curve, trattini, puntini di sospensione. Maiuscole e minuscole non vengono normalizzate.',
            ),
          ],
          [
            t('Span resolution', 'Risoluzione dello span'),
            t(
              'The match is mapped back to character offsets in the source document, so it can be highlighted exactly where it sits.',
              'La corrispondenza viene riportata alle posizioni dei caratteri nel documento sorgente, così si può evidenziare esattamente dove si trova.',
            ),
          ],
          [
            'Entailment',
            t(
              `An LLM judge labels each (evidence, sentence) pair supported (1), partially supported (0.5) or not supported (0), in one batched call. Verified at ≥ ${PIPELINE_CONSTANTS.verifiedAt}, partial at ≥ ${PIPELINE_CONSTANTS.partialAt}. Then one rule no model is trusted with: a threshold whose source states a conformance level (A, AA, AAA) is held at partial unless the sentence names that level or criterion.`,
              `Un giudice LLM etichetta ogni coppia (prova, frase) come supportata (1), parzialmente supportata (0,5) o non supportata (0), in un’unica chiamata. Verificata da ${PIPELINE_CONSTANTS.verifiedAt}, parziale da ${PIPELINE_CONSTANTS.partialAt}. Poi una regola che non si affida a nessun modello: una soglia la cui fonte indica un livello di conformità (A, AA, AAA) resta parziale se la frase non nomina quel livello o il criterio.`,
            ),
          ],
        ].map(([name, text]) => (
          <li key={name} className="rounded-xl bg-raised p-4">
            <span className="font-medium">{name}</span>
            <p className="mt-1 leading-relaxed text-ink-2">{text}</p>
          </li>
        ))}
      </ol>

      {claims.length === 0 ? (
        <p className="text-sm">{t('The answer made no claims to verify.', 'La risposta non contiene citazioni da verificare.')}</p>
      ) : (
        <>
          <Figure
            title={t('How many claims survived each check', 'Quante citazioni hanno superato ogni controllo')}
            caption={t(
              'A claim that fails the quote check is never sent to the judge: grading it would spend quota to change nothing.',
              'Una citazione che non supera il confronto non viene mai mandata al giudice: valutarla consumerebbe quota senza cambiare nulla.',
            )}
            table={{
              head: [t('Check', 'Controllo'), t('Claims', 'Citazioni')],
              rows: [
                [t('Made', 'Fatte'), claims.length],
                [t('Quote found', 'Citazione trovata'), found],
                [t('Judged', 'Giudicate'), judged],
                [t('Verified', 'Verificate'), verified],
              ],
            }}
          >
            <Bars
              series="ink"
              format={(v) => String(v)}
              max={claims.length}
              rows={[
                { label: t('Claims made', 'Citazioni fatte'), value: claims.length },
                { label: t('Quote found in a cited chunk', 'Citazione trovata in un chunk citato'), value: found },
                { label: t('Judged by the entailment model', 'Giudicate dal modello di entailment'), value: judged },
                { label: t('Verified', 'Verificate'), value: verified },
              ]}
            />
          </Figure>
          <DataTable
            label={t('Every claim and what each check found', 'Ogni citazione e cosa ha trovato ogni controllo')}
            head={[t('Claim', 'Frase'), t('Quote', 'Citazione'), 'Span', 'Entailment', t('Status', 'Stato')]}
            rows={claims.map((claim) => [
              <span key="s" className="block max-w-sm">
                {claim.sentence}
              </span>,
              claim.quoteMatch
                ? t(`in ${claim.supportingChunkIds.length} of ${claim.chunkIds.length}`, `in ${claim.supportingChunkIds.length} su ${claim.chunkIds.length}`)
                : t('not found', 'non trovata'),
              claim.span ? (
                <span key="p" title={title(meta, claim.span.chunkId)}>
                  {claim.span.start}-{claim.span.end}
                </span>
              ) : (
                t('none', 'nessuno')
              ),
              claim.entailment === null ? t('judge unavailable', 'giudice non disponibile') : claim.entailment.toFixed(1),
              <span key="st" className={STATUS[claim.status].className}>
                <span aria-hidden="true">{STATUS[claim.status].mark} </span>
                {t(claim.status, STATUS_IT[claim.status])}
                {claim.levelOmitted && t(`, Level ${claim.levelOmitted} not stated`, `, Livello ${claim.levelOmitted} non indicato`)}
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
const SHORT: Record<string, [string, string]> = {
  sparse: ['BM25', 'BM25'],
  dense: ['Dense', 'Semantico'],
  hybrid: ['Rank fusion', 'Fusione'],
  rerank: ['Rerank', 'Rerank'],
  rag: ['Generation', 'Generazione'],
  attribution: ['Verification', 'Verifica'],
};

const RETRIEVER_IT: Record<string, string> = {
  'BM25 only': 'Solo BM25',
  'Dense only': 'Solo semantico',
  'Hybrid (RRF)': 'Ibrido (RRF)',
  'Hybrid + rerank': 'Ibrido + rerank',
};

function References({ refs }: { refs: Paradigm['references'] }) {
  return (
    <ul className="mt-2 space-y-2 text-sm text-ink-2" lang="en">
      {refs.map((ref) => (
        <li key={ref.url}>
          {ref.authors} ({ref.year}).{' '}
          <a href={ref.url} className="text-ink underline underline-offset-2" rel="noreferrer">
            {ref.title}
          </a>
          . <i>{ref.venue}</i>.
        </li>
      ))}
    </ul>
  );
}

function Paradigms() {
  const { t, lang } = useLang();
  const paradigms = localized(lang).paradigms;
  const [selected, setSelected] = useState(paradigms[0]!.id);

  return (
    <section aria-labelledby="method">
      <SectionHeading
        id="method"
        lead={t(
          '“RAG” names a family, not one method. This system composes six techniques: two first-stage retrievers, a fusion rule, a second-stage reranker, a generator, and a verifier. Each is set out as it would be in a lecture.',
          '“RAG” è il nome di una famiglia, non di un metodo solo. Questo sistema ne combina sei: due retriever di primo livello, una regola di fusione, un reranker di secondo livello, un generatore e un verificatore. Ognuna è presentata come a lezione.',
        )}
      >
        {t('The six techniques', 'Le sei tecniche')}
      </SectionHeading>
      <div className="mt-8">
        <Tabs
          label={t('Techniques', 'Tecniche')}
          selected={selected}
          onSelect={setSelected}
          tabs={paradigms.map((paradigm) => ({
            id: paradigm.id,
            label: SHORT[paradigm.id] ? t(SHORT[paradigm.id]![0], SHORT[paradigm.id]![1]) : paradigm.name,
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
  const { t } = useLang();

  return (
    <div className="grid gap-10 pt-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="space-y-6">
        <div>
          <h3 className="text-2xl font-semibold tracking-tight">{paradigm.name}</h3>
          <p className="mt-1 text-sm text-muted">{paradigm.family}</p>
        </div>
        <PlainWords plain={{ analogy: paradigm.plain, yours: [] }} />
        <h4 className="font-medium">{t('The technical version', 'La versione tecnica')}</h4>
        <p className="max-w-[65ch] leading-relaxed">{paradigm.idea}</p>
        <Formula label={t('Definition', 'Definizione')}>{paradigm.formula}</Formula>
        <div className="grid gap-6 text-sm sm:grid-cols-2">
          <div>
            <h4 className="font-medium">{t('Strengths', 'Punti di forza')}</h4>
            <ul className="mt-2 list-disc space-y-1.5 pl-5 leading-relaxed text-ink-2">
              {paradigm.strengths.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div>
            <h4 className="font-medium">{t('Failure modes', 'Dove sbaglia')}</h4>
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
          <span className="font-medium">{t('Cost here', 'Costo qui')}</span>
          <p className="mt-1 leading-relaxed text-ink-2">{paradigm.cost}</p>
        </div>
        {row && series && (
          <Figure
            title={t('Measured on this corpus', 'Misurato su questo corpus')}
            caption={t(
              'This configuration alone, over the 53 answerable golden questions.',
              'Questa configurazione da sola, sulle 53 domande del golden set con una risposta.',
            )}
            table={{
              head: [t('Metric', 'Metrica'), t('Value', 'Valore')],
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
          <h4 className="text-sm font-medium">{t('Read further', 'Per approfondire')}</h4>
          <References refs={paradigm.references} />
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
  const { t, lang } = useLang();
  const metrics = localized(lang).metrics;
  const name = (retriever: string) => t(retriever, RETRIEVER_IT[retriever] ?? retriever);
  const by = (series: Series) => ABLATION.find((row) => RETRIEVER_SERIES[row.retriever] === series)!;
  const kind = (key: keyof typeof QUESTION_KINDS) =>
    Object.fromEntries(ORDER.map((series) => [series, by(series).byKind[key]])) as Record<Series, number>;

  const metric = (label: string, read: (row: (typeof ABLATION)[number]) => number, format: (v: number) => string) => (
    <Figure title={label} table={{ head: ['Retriever', label], rows: ABLATION.map((row) => [name(row.retriever), format(read(row))]) }}>
      <Bars
        series="ink"
        max={1}
        format={format}
        rows={ORDER.map((series) => ({ label: name(by(series).retriever), value: read(by(series)), series }))}
      />
    </Figure>
  );

  return (
    <section aria-labelledby="evaluation">
      <SectionHeading
        id="evaluation"
        lead={t(
          'An ablation means taking a recipe apart to see what each ingredient adds: run each search alone, then combined, then reranked, and compare. The test is a golden set of 60 questions whose right answers were marked by hand beforehand, like an answer key. Seven have no answer in the corpus and are excluded, leaving 53.',
          'Un’ablation è come smontare una ricetta per vedere cosa aggiunge ogni ingrediente: ogni ricerca da sola, poi combinate, poi riordinate, e si confronta. Il test è un golden set di 60 domande le cui risposte giuste sono state segnate a mano in anticipo, come le soluzioni di un compito. Sette non hanno risposta nel corpus e sono escluse, quindi ne restano 53.',
        )}
      >
        {t('How the combination was justified', 'Come è stata giustificata la combinazione')}
      </SectionHeading>

      <dl className="mt-10 grid gap-x-10 gap-y-6 sm:grid-cols-2">
        {metrics.map((m) => (
          <div key={m.name}>
            <dt className="font-medium">{m.name}</dt>
            <dd className="mt-1 leading-relaxed">{m.plain}</dd>
            <dd className="mt-2 font-mono text-xs text-ink-2">{m.formula}</dd>
            <dd className="mt-1 text-sm leading-relaxed text-ink-2">{m.reads}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-12">
        <Figure
          title={t(
            'Recall@10 by kind of question: the finding the design rests on',
            'Recall@10 per tipo di domanda: il risultato su cui si regge il progetto',
          )}
          caption={t(
            'Alone, BM25 beats dense retrieval on identifiers and loses to it on conceptual questions. Neither is good at both, which is the case for fusing them; reranking then lifts identifiers furthest.',
            'Da solo, BM25 batte il retrieval semantico sugli identificatori e perde sulle domande concettuali. Nessuno dei due è bravo in entrambe, ed è questo il motivo per fonderli; il reranking poi alza soprattutto gli identificatori.',
          )}
          legend={ORDER}
          table={{
            head: [
              'Retriever',
              `${t('Identifier', 'Identificatore')} (${QUESTION_KINDS.identifier})`,
              `${t('Conceptual', 'Concettuale')} (${QUESTION_KINDS.conceptual})`,
              `${t('Design', 'Design')} (${QUESTION_KINDS.design})`,
            ],
            rows: ABLATION.map((row) => [name(row.retriever), pct(row.byKind.identifier), pct(row.byKind.conceptual), pct(row.byKind.design)]),
          }}
        >
          <GroupedColumns
            series={ORDER}
            format={(v) => `${Math.round(v * 100)}`}
            groups={[
              { label: `${t('Identifier', 'Identificatore')}, ${QUESTION_KINDS.identifier}`, values: kind('identifier') },
              { label: `${t('Conceptual', 'Concettuale')}, ${QUESTION_KINDS.conceptual}`, values: kind('conceptual') },
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
        {t(
          'The reranked configuration returns 8 results rather than 30, so it is compared on the measures that look at the top of the list. There it is best on all three: the first right answer moves from an MRR of 0.530 for BM25 alone to 0.733.',
          'La configurazione con reranking restituisce 8 risultati invece di 30, quindi si confronta sulle misure che guardano la cima della lista. Lì è la migliore su tutte e tre: la prima risposta giusta passa da un MRR di 0,530 con il solo BM25 a 0,733.',
        )}
      </p>
    </section>
  );
}

function SystemDesign() {
  const { t, num } = useLang();
  const lanes = [
    {
      name: t('Build time', 'In fase di build'),
      where: t('Node, once', 'Node, una volta'),
      items: [
        t('Fetch and normalise 193 documents', 'Scaricare e normalizzare 193 documenti'),
        t('Chunk with exact offsets', 'Dividere in chunk con posizioni esatte'),
        t('Embed 1,592 passages, quantise to int8', 'Codificare 1.592 passaggi, quantizzare in int8'),
        t('Build the BM25 postings', 'Costruire i posting di BM25'),
      ],
    },
    {
      name: 'Browser',
      where: t('Web Worker and main thread', 'Web Worker e thread principale'),
      items: [
        t('Tokenize the query', 'Tokenizzare la domanda'),
        t('BM25 over the postings', 'BM25 sui posting'),
        t('Dense scan of 1,592 vectors', 'Scansione semantica di 1.592 vettori'),
        t('Rank fusion', 'Fusione dei ranking'),
        t('Quote match and span resolution', 'Confronto delle citazioni e risoluzione degli span'),
      ],
    },
    {
      name: 'Edge',
      where: 'Cloudflare Worker',
      items: [
        t('Embed the query', 'Codificare la domanda'),
        t('Rerank 30 candidates', 'Riordinare 30 candidati'),
        t('Generate the answer', 'Generare la risposta'),
        t('Judge entailment', 'Giudicare l’entailment'),
      ],
    },
  ];
  const source: Record<string, string> = {
    'WCAG 2.2 Understanding': 'WCAG 2.2 Understanding',
    'GOV.UK Design System': 'GOV.UK Design System',
    'WCAG 2.2 specification': t('WCAG 2.2 specification', 'Specifica WCAG 2.2'),
  };

  return (
    <section aria-labelledby="system">
      <SectionHeading
        id="system"
        lead={t(
          'Static index in the client, models at the edge, no server. Only three things cannot be precomputed: the query embedding, the reranking and the generation. Only those leave the browser.',
          'Indice statico nel client, modelli all’edge, nessun server. Solo tre cose non si possono calcolare in anticipo: l’embedding della domanda, il reranking e la generazione. Solo quelle escono dal browser.',
        )}
      >
        {t('System design', 'Architettura')}
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
          title={t('The corpus, by source', 'Il corpus, per fonte')}
          caption={t('193 documents, 1,746,767 characters of normalised text.', '193 documenti, 1.746.767 caratteri di testo normalizzato.')}
          table={{
            head: [t('Source', 'Fonte'), t('Documents', 'Documenti'), t('Characters', 'Caratteri')],
            rows: CORPUS.map((row) => [source[row.source] ?? row.source, row.documents, num(row.characters)]),
          }}
        >
          <Bars
            series="ink"
            format={(v) => `${Math.round(v / 1000)}k`}
            rows={CORPUS.map((row) => ({
              label: source[row.source] ?? row.source,
              value: row.characters,
              note: `${row.documents} ${t('docs', 'doc')}`,
            }))}
          />
        </Figure>
        <div className="min-w-0 rounded-2xl border border-line p-5 text-sm leading-relaxed">
          <span className="font-medium">Chunking</span>
          <p className="mt-2 text-ink-2">
            {t(
              `Structure-aware. A chunk targets ${PIPELINE_CONSTANTS.chunk.targetTokens} tokens, never exceeds ${PIPELINE_CONSTANTS.chunk.maxTokens}, carries ${PIPELINE_CONSTANTS.chunk.overlap * 100}% of its predecessor, and is always a contiguous slice of the normalised document. Its offsets therefore hold by construction, which is what lets a verified quote be highlighted exactly where it sits:`,
              `Rispetta la struttura. Un chunk punta a ${PIPELINE_CONSTANTS.chunk.targetTokens} token, non supera mai ${PIPELINE_CONSTANTS.chunk.maxTokens}, riporta il ${PIPELINE_CONSTANTS.chunk.overlap * 100}% del precedente ed è sempre una porzione contigua del documento normalizzato. Le sue posizioni quindi valgono per costruzione, ed è questo che permette di evidenziare una citazione verificata esattamente dove si trova:`,
            )}
          </p>
          <pre className="mt-3 rounded-lg bg-raised px-3 py-2 font-mono text-xs break-all whitespace-pre-wrap">
            doc.text.slice(chunk.charStart, chunk.charEnd) === chunk.text
          </pre>
          <p className="mt-3 text-ink-2">
            {t('Asserted over all 193 documents on every test run.', 'Controllato su tutti i 193 documenti a ogni esecuzione dei test.')}
          </p>
        </div>
      </div>
    </section>
  );
}

function DesignSystem() {
  const { t } = useLang();
  const surfaces = [
    ['paper', 'bg-paper', t('Page surface', 'Sfondo della pagina')],
    ['raised', 'bg-raised', t('Formulas, figures', 'Formule, figure')],
    ['line', 'bg-line', t('Hairlines', 'Linee sottili')],
    ['ink-2', 'bg-ink-2', t('Secondary text', 'Testo secondario')],
    ['ink', 'bg-ink', t('Text and the only accent', 'Testo e unico accento')],
  ] as const;
  const series = [
    ['dense', 'bg-dense', t('Dense retrieval', 'Retrieval semantico')],
    ['lexical', 'bg-lexical', 'BM25'],
    ['hybrid', 'bg-hybrid', t('Hybrid (RRF)', 'Ibrido (RRF)')],
    ['rerank', 'bg-rerank', t('Hybrid + rerank', 'Ibrido + rerank')],
  ] as const;
  const states = [
    ['✓', 'text-verified', t('verified', 'verificata'), t('solid underline', 'sottolineatura continua')],
    ['≈', 'text-partial', t('partial', 'parziale'), t('dashed underline', 'sottolineatura tratteggiata')],
    ['✕', 'text-unsupported', t('unsupported', 'non supportata'), t('wavy underline', 'sottolineatura ondulata')],
    ['?', 'text-unverified', t('unverified', 'non verificata'), t('dotted underline', 'sottolineatura a puntini')],
  ] as const;

  return (
    <section aria-labelledby="design-system">
      <SectionHeading
        id="design-system"
        lead={t(
          'A tool about accessibility is held to WCAG 2.2 AA itself. The system is small on purpose: one neutral family, one typeface, colour only where it carries meaning, and motion only where something changed.',
          'Uno strumento sull’accessibilità deve rispettare esso stesso WCAG 2.2 AA. Il sistema è piccolo di proposito: una famiglia di neutri, un solo carattere, il colore solo dove ha un significato e il movimento solo dove qualcosa è cambiato.',
        )}
      >
        Design system
      </SectionHeading>

      <div className="mt-10 grid gap-10 lg:grid-cols-2">
        <div>
          <h3 className="font-medium">{t('Colour, by role', 'Colore, per ruolo')}</h3>
          <p className="mt-1 text-sm text-ink-2">
            {t('Cool neutrals, redefined for dark mode rather than inverted.', 'Neutri freddi, ridefiniti per il tema scuro invece che invertiti.')}
          </p>
          <ul className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-5">
            {surfaces.map(([name, swatch, role]) => (
              <li key={name}>
                <span className={`block h-14 rounded-lg border border-line ${swatch}`} />
                <span className="mt-2 block font-mono text-xs">{name}</span>
                <span className="block text-xs text-muted">{role}</span>
              </li>
            ))}
          </ul>

          <h3 className="mt-8 font-medium">{t('Series colours follow the entity', 'I colori delle serie seguono l’entità')}</h3>
          <p className="mt-1 text-sm text-ink-2">
            {t(
              'A retriever keeps its colour in every chart. The set is validated for colour-vision deficiency in both modes, and every chart is also direct-labelled and has a table view.',
              'Un retriever ha lo stesso colore in ogni grafico. L’insieme è validato per i difetti della visione dei colori in entrambi i temi, e ogni grafico ha anche etichette dirette e una vista tabella.',
            )}
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

          <h3 className="mt-8 font-medium">{t('Citation states never rely on colour', 'Gli stati delle citazioni non dipendono mai dal colore')}</h3>
          <p className="mt-1 text-sm text-ink-2">
            {t(
              'A symbol and an underline style carry the meaning; colour is the third signal. There are two colour sets, because one cannot clear 4.5:1 on both white and near-black.',
              'Il significato lo portano un simbolo e uno stile di sottolineatura; il colore è il terzo segnale. Ci sono due insiemi di colori, perché uno solo non raggiunge 4.5:1 sia sul bianco sia sul quasi nero.',
            )}
          </p>
          <ul className="mt-4 space-y-2 text-sm">
            {states.map(([mark, color, name, underline]) => (
              <li key={name} className="flex items-baseline gap-3">
                <span aria-hidden="true" className={`w-4 font-semibold ${color}`}>
                  {mark}
                </span>
                <span className={`w-32 ${color}`}>{name}</span>
                <span className="text-ink-2">{underline}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="space-y-8">
          <div>
            <h3 className="font-medium">{t('Type', 'Tipografia')}</h3>
            <div className="mt-4 rounded-xl bg-raised p-5">
              <p className="text-4xl font-semibold tracking-tighter">Geist, 600</p>
              <p className="mt-2 text-lg text-ink-2">
                {t('Geist 400 for reading, set at 65 characters a line.', 'Geist 400 per la lettura, a 65 caratteri per riga.')}
              </p>
              <p className="mt-3 font-mono text-sm">{t('Geist Mono for numbers', 'Geist Mono per i numeri')}: 0.0164, #17, 945 ms</p>
            </div>
            <p className="mt-2 text-sm text-ink-2">
              {t(
                'Self-hosted, so no third-party request stands between a visitor and the first paint.',
                'Ospitato dal sito stesso, così nessuna richiesta a terzi si mette fra il visitatore e il primo rendering.',
              )}
            </p>
          </div>

          <div>
            <h3 className="font-medium">{t('Motion', 'Movimento')}</h3>
            <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-ink-2">
              <li>
                {t(
                  'A chart grows from its baseline when it comes into view, and again for each new question.',
                  'Un grafico cresce dalla sua base quando entra in vista, e di nuovo a ogni nuova domanda.',
                )}
              </li>
              <li>
                {t(
                  'A dashed line flows only while a request is in flight: motion as state, not decoration.',
                  'Una linea tratteggiata scorre solo mentre una richiesta è in corso: il movimento è uno stato, non una decorazione.',
                )}
              </li>
              <li>
                {t(
                  'Only transform and opacity animate. Under prefers-reduced-motion every mark is simply at rest.',
                  'Si animano solo transform e opacity. Con prefers-reduced-motion ogni elemento è semplicemente fermo.',
                )}
              </li>
            </ul>
          </div>

          <div>
            <h3 className="font-medium">{t('Accessibility rules', 'Regole di accessibilità')}</h3>
            <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-ink-2">
              <li>
                {t(
                  'Every chart is hidden from assistive technology over a real table one click away.',
                  'Ogni grafico è nascosto alle tecnologie assistive, sopra una vera tabella a un clic di distanza.',
                )}
              </li>
              <li>
                {t(
                  'Tabs follow the APG pattern: roving tabindex, arrow keys, Home and End.',
                  'Le tab seguono il pattern APG: roving tabindex, frecce, Home e End.',
                )}
              </li>
              <li>
                {t(
                  'One live region for the life of the page, announcing what changed.',
                  'Una sola live region per tutta la vita della pagina, che annuncia cosa è cambiato.',
                )}
              </li>
              <li>
                {t(
                  'Focus is a 3px outline with an offset, restyled but never removed.',
                  'Il focus è un contorno di 3px con uno scostamento, ridisegnato ma mai rimosso.',
                )}
              </li>
              <li>
                {t(
                  'The interface is in English or Italian; the corpus and every quote stay English and are marked lang="en".',
                  'L’interfaccia è in inglese o in italiano; il corpus e ogni citazione restano in inglese e sono marcati lang="en".',
                )}
              </li>
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
