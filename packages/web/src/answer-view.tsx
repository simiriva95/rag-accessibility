import { useState } from 'react';
import { statusOf, type Chunk, type SentenceStatus, type VerifiedClaim } from '@rag/core';
import { useLang } from './i18n.tsx';
import { RunDiagram } from './run-diagram.tsx';
import { SourceDialog, type SourceTarget } from './source-dialog.tsx';
import type { AnswerState, Answered } from './use-answer.ts';
import type { Retrieval } from './use-retrieval.ts';

/**
 * The answer, one sentence at a time, each carrying what verification found.
 *
 * The four states are distinguished by a symbol and an underline style before
 * they are distinguished by colour, and every one of them is also in the
 * button's accessible name. Colour is the last signal added, not the first.
 *
 * Unsupported sentences are shown. Hiding them would turn the demo into a
 * demonstration that the model never fails, which is not what is being claimed.
 */

const PRESENTATION: Record<SentenceStatus, { mark: string; label: string; it: string; name: string; className: string }> = {
  verified: {
    mark: '✓',
    label: 'verified: the quote is in the cited source',
    it: 'verificata: la citazione è nella fonte citata',
    name: 'verificata',
    className: 'decoration-solid decoration-2 text-verified',
  },
  partial: {
    mark: '≈',
    label: 'partial: the quote is real, the support is weak',
    it: 'parziale: la citazione è reale, il supporto è debole',
    name: 'parziale',
    className: 'decoration-dashed decoration-2 text-partial',
  },
  unsupported: {
    mark: '✕',
    label: 'unsupported: the quote is not in any cited source',
    it: 'non supportata: la citazione non è in nessuna fonte citata',
    name: 'non supportata',
    className: 'decoration-wavy decoration-2 text-unsupported',
  },
  unverified: {
    mark: '?',
    label: 'unverified: the quote is real, the support could not be checked',
    it: 'non verificata: la citazione è reale, il supporto non si è potuto controllare',
    name: 'non verificata',
    className: 'decoration-dotted decoration-2 text-unverified',
  },
  uncited: {
    mark: '·',
    label: 'uncited: this sentence claims nothing',
    it: 'senza citazione: questa frase non afferma nulla',
    name: 'senza citazione',
    className: 'decoration-dotted',
  },
};

export function AnswerView({ retrieval, state }: { retrieval: Retrieval; state: AnswerState }) {
  const [target, setTarget] = useState<SourceTarget>();
  const { t } = useLang();

  if (!retrieval.run) {
    return (
      <p className="mt-6 text-ink-2">
        {t('Ask a question to see an answer with every citation checked.', 'Fai una domanda per vedere una risposta con ogni citazione controllata.')}
      </p>
    );
  }

  const sources = state.phase === 'answered' ? state.result.sources : [];

  return (
    <div className="mt-6">
      {state.phase === 'generating' && <Working>{t('Writing an answer from the retrieved sources…', 'Scrivo una risposta dalle fonti trovate…')}</Working>}
      {state.phase === 'verifying' && <Working>{t('Checking each quote against the text it cites…', 'Controllo ogni citazione contro il testo che cita…')}</Working>}

      {state.phase === 'unavailable' && (
        <div className="rounded-xl border border-partial px-3 py-2 text-sm">
          <h2 className="font-medium">{t('No written answer', 'Nessuna risposta scritta')}</h2>
          <p className="mt-1 text-ink-2">{state.reason}</p>
          <p className="mt-2 text-ink-2">
            {t(
              'The retrieved sources are below. Retrieval is most of the value here, so the app keeps working without generation rather than showing nothing.',
              'Le fonti trovate sono qui sotto. Il retrieval è la parte più utile, quindi l’app continua a funzionare anche senza generazione invece di non mostrare nulla.',
            )}
          </p>
        </div>
      )}

      {state.phase === 'answered' && <Answer result={state.result} onInspect={setTarget} />}

      {/* Keyed on the run, so each new question draws its own graph from the start. */}
      <div className="mt-8">
        <RunDiagram
          key={retrieval.run.query + retrieval.run.timings.total}
          run={retrieval.run}
          answer={state}
          total={retrieval.meta.size}
        />
      </div>

      <Evidence
        chunks={sources.length > 0 ? sources : retrievedChunks(retrieval)}
        onInspect={setTarget}
      />

      <SourceDialog {...(target ? { target } : {})} onClose={() => setTarget(undefined)} />
    </div>
  );
}

const Working = ({ children }: { children: React.ReactNode }) => (
  <p className="text-ink-2">{children}</p>
);

function retrievedChunks(retrieval: Retrieval): Chunk[] {
  const out: Chunk[] = [];
  for (const hit of retrieval.run?.final ?? []) {
    const info = retrieval.meta.get(hit.chunkId);
    const body = retrieval.text(hit.chunkId);
    if (info) out.push({ ...info, text: body ?? '' });
  }
  return out;
}

function Answer({ result, onInspect }: { result: Answered; onInspect: (target: SourceTarget) => void }) {
  const { answer, claims, dropped, sources } = result;
  const byId = new Map(sources.map((chunk) => [chunk.id, chunk]));
  const { t } = useLang();

  if (!answer.answerable) {
    return (
      <section aria-labelledby="answer-heading">
        <h2 id="answer-heading" className="text-lg font-semibold">
          {t('No answer in these sources', 'Nessuna risposta in queste fonti')}
        </h2>
        <p className="mt-2 max-w-2xl" lang={result.language}>
          {answer.sentences.join(' ')}
        </p>
        <p className="mt-2 max-w-2xl text-sm text-ink-2">
          {t(
            'Declining is a correct answer. The corpus is WCAG 2.2 and the GOV.UK Design System, and nothing outside it was consulted.',
            'Rifiutarsi è una risposta corretta. Il corpus è WCAG 2.2 e il GOV.UK Design System, e nulla al di fuori è stato consultato.',
          )}
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="answer-heading">
      <h2 id="answer-heading" className="text-lg font-semibold">
        {t('Answer', 'Risposta')}
      </h2>

      <p className="mt-3 max-w-3xl text-lg leading-relaxed" lang={result.language}>
        {answer.sentences.map((sentence, index) => (
          <Sentence
            key={`${index}-${sentence}`}
            sentence={sentence}
            claims={claims.filter((claim) => claim.sentence === sentence)}
            chunkFor={(id) => byId.get(id)}
            onInspect={onInspect}
          />
        ))}
      </p>

      <Legend claims={claims} sentences={answer.sentences} />

      {dropped.length > 0 && (
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer">
            {t(
              `${dropped.length} malformed ${dropped.length === 1 ? 'claim was' : 'claims were'} discarded`,
              `${dropped.length} ${dropped.length === 1 ? 'citazione malformata scartata' : 'citazioni malformate scartate'}`,
            )}
          </summary>
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-ink-2">
            {dropped.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function Sentence({
  sentence,
  claims,
  chunkFor,
  onInspect,
}: {
  sentence: string;
  claims: VerifiedClaim[];
  chunkFor: (id: string) => Chunk | undefined;
  onInspect: (target: SourceTarget) => void;
}) {
  const status = statusOf(sentence, claims);
  const { t } = useLang();
  const { mark, className } = PRESENTATION[status];
  const label = t(PRESENTATION[status].label, PRESENTATION[status].it);

  // The claim that resolved to a span is the one with somewhere to go.
  const located = claims.find((claim) => claim.span !== undefined);
  const chunk = located?.span ? chunkFor(located.span.chunkId) : undefined;
  const openable = located?.span !== undefined && chunk !== undefined;
  // Held at partial because the sentence states a threshold its source ties to a level.
  const omitted = status === 'partial' ? claims.find((claim) => claim.levelOmitted)?.levelOmitted : undefined;

  if (status === 'uncited') return <span>{sentence} </span>;

  return (
    <>
      <button
        type="button"
        disabled={!openable}
        onClick={() => {
          if (!chunk || !located?.span) return;
          onInspect({ chunk, span: { start: located.span.start, end: located.span.end }, sentence });
        }}
        className={`text-left underline underline-offset-4 disabled:cursor-default ${className}`}
      >
        <span aria-hidden="true" className="mr-0.5 font-semibold">
          {mark}
        </span>
        <span className="text-ink">{sentence}</span>
        <span className="sr-only">
          , {label}
          {omitted
            ? t(
                `. The source states this at Level ${omitted}, and the sentence does not say so`,
                `. La fonte lo indica al Livello ${omitted}, e la frase non lo dice`,
              )
            : ''}
          {openable ? t('. Select to open the source.', '. Seleziona per aprire la fonte.') : ''}
        </span>
      </button>
      {omitted && (
        <span aria-hidden="true" className="ml-1 rounded-md border border-partial px-1.5 py-0.5 align-middle font-mono text-xs text-partial">
          {t(`Level ${omitted} not stated`, `Livello ${omitted} non indicato`)}
        </span>
      )}{' '}
    </>
  );
}

function Legend({ claims, sentences }: { claims: VerifiedClaim[]; sentences: string[] }) {
  const counts = new Map<SentenceStatus, number>();
  for (const sentence of sentences) {
    const status = statusOf(sentence, claims);
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }

  const present = [...counts].filter(([, n]) => n > 0);
  const { t } = useLang();

  return (
    <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-sm">
      {present.map(([status, count]) => (
        <div key={status} className="flex items-baseline gap-1.5">
          <dt className={`${PRESENTATION[status].className} underline underline-offset-4`}>
            <span aria-hidden="true" className="mr-1 font-semibold">
              {PRESENTATION[status].mark}
            </span>
            {t(status, PRESENTATION[status].name)}
          </dt>
          <dd className="tabular-nums text-ink-2">
            {count} {count === 1 ? t('sentence', 'frase') : t('sentences', 'frasi')}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Evidence({
  chunks,
  onInspect,
}: {
  chunks: Chunk[];
  onInspect: (target: SourceTarget) => void;
}) {
  const { t } = useLang();
  if (chunks.length === 0) return null;

  return (
    <section aria-labelledby="evidence-heading" className="mt-8">
      <h2 id="evidence-heading" className="text-lg font-semibold">
        {t('Sources', 'Fonti')}
      </h2>
      <ol className="mt-3 space-y-3">
        {chunks.map((chunk, index) => (
          <li key={chunk.id} className="rounded-xl border border-line p-4">
            {/* The corpus is English whatever the interface language: 3.1.2 Language of Parts. */}
            <p className="text-sm text-muted" lang="en">
              <span className="tabular-nums">{index + 1}.</span> {chunk.docTitle}
              {chunk.scRef && <> · SC {chunk.scRef}</>}
            </p>
            <h3 className="mt-1 font-medium" lang="en">
              {chunk.headingPath.at(-1) ?? chunk.docTitle}
            </h3>
            {chunk.text && (
              <p className="mt-2 line-clamp-3 text-sm text-ink-2" lang="en">
                {chunk.text
                  .split('\n\n')
                  .filter((block) => !block.startsWith('#'))
                  .join(' ')}
              </p>
            )}
            <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
              <button
                type="button"
                onClick={() =>
                  // With no claim to point at, the chunk highlights itself: the
                  // same offsets the chunker recorded, resolved against the same
                  // normalized text a citation would use.
                  onInspect({ chunk, span: { start: chunk.charStart, end: chunk.charEnd } })
                }
                className="py-1 underline underline-offset-2"
              >
                {t('Show this passage in the source', 'Mostra questo passaggio nella fonte')}
              </button>
              <a href={chunk.sourceUrl} className="py-1 underline underline-offset-2" rel="noreferrer">
                {chunk.docId}
              </a>
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}
