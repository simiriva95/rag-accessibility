import { useEffect, useId, useRef, useState } from 'react';
import { AnswerView } from './answer-view.tsx';
import { RetrievalDebugger } from './debugger.tsx';
import { Tabs } from './tabs.tsx';
import { useRetrieval, type DegradedStage, type Retrieval, type Run } from './use-retrieval.ts';

const EXAMPLES = [
  'What does Success Criterion 2.4.11 require?',
  'How much colour contrast does large text need?',
  'prefers-reduced-motion',
  'Which clause of EN 301 549 covers web content?',
];

export function App() {
  const retrieval = useRetrieval();
  const [query, setQuery] = useState('');
  const inputId = useId();
  const announcement = useAnnouncement(retrieval);
  const [view, setView] = useState<'results' | 'retrieval'>('results');

  const submit = (value: string) => {
    setQuery(value);
    retrieval.ask(value);
  };

  return (
    <div className="min-h-dvh bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <a
        href="#results"
        className="sr-only focus:not-sr-only focus:absolute focus:m-3 focus:rounded focus:bg-slate-900 focus:px-3 focus:py-2 focus:text-white dark:focus:bg-white dark:focus:text-slate-900"
      >
        Skip to results
      </a>

      <p aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </p>

      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Hybrid retrieval, verified citations
          </h1>
          <p className="mt-2 max-w-2xl text-slate-600 dark:text-slate-400">
            Questions about WCAG 2.2 and the GOV.UK Design System. The retrieval is shown as it
            happens, and every quoted claim is checked against the text it cites.
          </p>
        </header>

        <main className="mt-8">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submit(query);
            }}
          >
            <label htmlFor={inputId} className="block text-sm font-medium">
              Your question
            </label>
            <div className="mt-2 flex gap-2">
              <input
                id={inputId}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                disabled={retrieval.status !== 'ready'}
                placeholder="How much colour contrast does large text need?"
                className="min-w-0 flex-1 rounded-md border border-slate-400 bg-white px-3 py-2 text-slate-900 placeholder:text-slate-500 disabled:opacity-60 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              />
              <button
                type="submit"
                disabled={retrieval.status !== 'ready' || retrieval.running}
                className="rounded-md bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-60 dark:bg-slate-100 dark:text-slate-900"
              >
                {retrieval.running ? 'Searching…' : 'Search'}
              </button>
            </div>
          </form>

          <ul className="mt-3 flex flex-wrap gap-2" aria-label="Example questions">
            {EXAMPLES.map((example) => (
              <li key={example}>
                <button
                  type="button"
                  onClick={() => submit(example)}
                  disabled={retrieval.status !== 'ready'}
                  className="rounded-full border border-slate-300 px-3 py-1 text-sm text-slate-700 hover:border-slate-500 disabled:opacity-60 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-500"
                >
                  {example}
                </button>
              </li>
            ))}
          </ul>

          <IndexStatus retrieval={retrieval} />
          {retrieval.run && <DegradedNotice degraded={retrieval.run.degraded} />}

          <div id="results" className="mt-8">
            <Tabs
              label="Views"
              selected={view}
              onSelect={setView}
              tabs={[
                { id: 'results' as const, label: 'Answer', panel: <AnswerView retrieval={retrieval} /> },
                {
                  id: 'retrieval' as const,
                  label: 'Retrieval',
                  panel: <RetrievalDebugger retrieval={retrieval} />,
                },
              ]}
            />
          </div>
        </main>
      </div>
    </div>
  );
}

/**
 * Text for the single live region.
 *
 * One region, mounted for the life of the page, whose text changes — not a
 * region per component. A live region that appears at the same moment as its
 * content is unreliable: several screen readers only watch regions that were
 * already in the accessibility tree when the change happened.
 *
 * It announces what changed, not what is on screen. A screen reader user gets
 * "8 results in 6 milliseconds", not the whole list read back at them.
 */
function useAnnouncement(retrieval: Retrieval): string {
  const [message, setMessage] = useState('');
  const lastRun = useRef<Run>(null);

  const { status, running, run, meta, hasVectors, error } = retrieval;

  useEffect(() => {
    if (status === 'failed') return setMessage(`The index could not be loaded. ${error ?? ''}`.trim());
    if (status === 'loading') return setMessage('Loading the index.');

    if (running) return setMessage('Searching.');

    if (run && run !== lastRun.current) {
      lastRun.current = run;
      const degraded =
        run.degraded.length > 0
          ? ` ${run.degraded.length} ${run.degraded.length === 1 ? 'stage' : 'stages'} did not run.`
          : '';
      return setMessage(
        `${run.final.length} ${run.final.length === 1 ? 'result' : 'results'} in ` +
          `${Math.round(run.timings.total)} milliseconds.${degraded}`,
      );
    }

    return setMessage(
      `Index ready. ${meta.size} chunks. ` +
        (hasVectors ? 'Dense and lexical retrieval available.' : 'Lexical retrieval only.'),
    );
  }, [status, running, run, meta.size, hasVectors, error]);

  return message;
}

function IndexStatus({ retrieval }: { retrieval: Retrieval }) {
  const { status, error, meta, hasVectors, loadMs } = retrieval;

  if (status === 'failed') {
    return (
      <p role="alert" className="mt-6 rounded-md border border-red-600 px-3 py-2 text-red-800 dark:text-red-300">
        The index could not be loaded: {error}
      </p>
    );
  }

  if (status === 'loading') {
    return (
      <p className="mt-6 text-sm text-slate-600 dark:text-slate-400">Loading the index…</p>
    );
  }

  return (
    <p className="mt-6 text-sm text-slate-600 dark:text-slate-400">
      {meta.size.toLocaleString('en-GB')} chunks indexed
      {loadMs !== undefined && ` in ${Math.round(loadMs)} ms`}.{' '}
      {hasVectors ? 'Dense and lexical retrieval available.' : 'Lexical retrieval only — no vector index is deployed.'}
    </p>
  );
}

const STAGE_LABEL: Record<string, string> = {
  embed: 'Query embedding',
  dense: 'Dense retrieval',
  rerank: 'Reranking',
};

function DegradedNotice({ degraded }: { degraded: DegradedStage[] }) {
  if (degraded.length === 0) return null;

  return (
    <div className="mt-6 rounded-md border border-amber-600 px-3 py-2 text-sm">
      <h2 className="font-medium">Some stages did not run</h2>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-slate-700 dark:text-slate-300">
        {degraded.map((entry) => (
          <li key={`${entry.stage}-${entry.reason}`}>
            <strong className="font-medium">{STAGE_LABEL[entry.stage] ?? entry.stage}:</strong>{' '}
            {entry.reason}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-slate-600 dark:text-slate-400">
        The results below are real, and worse than they would otherwise be.
      </p>
    </div>
  );
}
