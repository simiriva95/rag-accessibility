import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import { AnswerView } from './answer-view.tsx';
import { RetrievalDebugger } from './debugger.tsx';
import { Tabs } from './tabs.tsx';
import { PipelineFigure } from './pipeline-figure.tsx';
import { useAnswer } from './use-answer.ts';
import { useRetrieval, type DegradedStage, type Retrieval, type Run } from './use-retrieval.ts';

const EXAMPLES = [
  'What does Success Criterion 2.4.11 require?',
  'How much colour contrast does large text need?',
  'prefers-reduced-motion',
  'Which clause of EN 301 549 covers web content?',
];

export function App() {
  const retrieval = useRetrieval();
  // Lifted here because two views read it: the answer, and the walkthrough of
  // how that answer was made. One generation per run, not one per view.
  const answer = useAnswer(retrieval);
  const [query, setQuery] = useState('');
  const inputId = useId();
  const announcement = useAnnouncement(retrieval);
  const [view, setView] = useState<View>('results');

  const submit = (value: string) => {
    setQuery(value);
    retrieval.ask(value);
  };

  /** The nav jumps to a section of the walkthrough, which lives in its own tab. */
  const jump = (id: string) => (event: React.MouseEvent) => {
    event.preventDefault();
    setView('explain');
    // The panel may still be loading its code, so wait for the target to exist.
    const started = performance.now();
    const scroll = () => {
      const target = document.getElementById(id);
      if (target) target.scrollIntoView({ block: 'start' });
      else if (performance.now() - started < 3000) requestAnimationFrame(scroll);
    };
    requestAnimationFrame(scroll);
  };

  return (
    <div className="min-h-dvh bg-paper text-ink">
      <a
        href="#results"
        className="sr-only focus:not-sr-only focus:absolute focus:m-3 focus:rounded-lg focus:bg-ink focus:px-3 focus:py-2 focus:text-paper"
      >
        Skip to results
      </a>

      <p aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </p>

      <header className="border-b border-line">
        <nav
          aria-label="Site"
          className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6"
        >
          <span className="font-medium tracking-tight">Hybrid RAG, verified</span>
          <ul className="flex gap-5 text-sm text-ink-2">
            <li>
              <a href="#method" onClick={jump('method')} className="hover:text-ink">
                Method
              </a>
            </li>
            <li>
              <a href="#evaluation" onClick={jump('evaluation')} className="hover:text-ink">
                Results
              </a>
            </li>
            <li>
              <a href="#design-system" onClick={jump('design-system')} className="hover:text-ink">
                Design
              </a>
            </li>
          </ul>
        </nav>
      </header>

      <main className="mx-auto max-w-7xl px-4 sm:px-6">
        <section
          aria-labelledby="hero-heading"
          className="grid gap-10 pt-12 pb-10 md:pt-20 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-16"
        >
          <div>
            <h1
              id="hero-heading"
              className="max-w-[18ch] text-4xl leading-[1.05] font-semibold tracking-tighter md:text-5xl lg:text-6xl"
            >
              Retrieval you can inspect. Citations that are checked.
            </h1>
            <p className="mt-5 max-w-[52ch] text-lg leading-relaxed text-ink-2">
              Ask about WCAG 2.2 or the GOV.UK Design System, then follow every stage your question
              went through.
            </p>

            <form
              className="mt-8"
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
                  className="min-w-0 flex-1 rounded-xl border border-line-strong bg-paper px-4 py-3 text-ink placeholder:text-muted disabled:opacity-60"
                />
                <button
                  type="submit"
                  disabled={retrieval.status !== 'ready' || retrieval.running}
                  className="rounded-xl bg-ink px-5 py-3 font-medium text-paper transition-transform active:scale-[0.98] disabled:opacity-60"
                >
                  {retrieval.running ? 'Searching…' : 'Search'}
                </button>
              </div>
            </form>

            <ul className="mt-4 flex flex-wrap gap-2" aria-label="Example questions">
              {EXAMPLES.map((example) => (
                <li key={example}>
                  <button
                    type="button"
                    onClick={() => submit(example)}
                    disabled={retrieval.status !== 'ready'}
                    className="rounded-full border border-line px-3 py-1 text-sm text-ink-2 transition-colors hover:border-line-strong hover:text-ink disabled:opacity-60"
                  >
                    {example}
                  </button>
                </li>
              ))}
            </ul>

            <IndexStatus retrieval={retrieval} />
          </div>

          <PipelineFigure retrieval={retrieval} answer={answer} />
        </section>

        {retrieval.run && <DegradedNotice degraded={retrieval.run.degraded} />}

        <div id="results" className="pb-24">
          <Tabs
            label="Views"
            sticky
            selected={view}
            onSelect={setView}
            tabs={[
              {
                id: 'results' as const,
                label: 'Answer',
                panel: <AnswerView retrieval={retrieval} state={answer} />,
              },
              {
                id: 'retrieval' as const,
                label: 'Retrieval',
                panel: <RetrievalDebugger retrieval={retrieval} />,
              },
              {
                id: 'explain' as const,
                label: 'How it works',
                panel: (
                  <Suspense fallback={<p className="mt-10 text-ink-2">Loading the walkthrough…</p>}>
                    <Explain retrieval={retrieval} answer={answer} />
                  </Suspense>
                ),
              },
            ]}
          />
        </div>
      </main>
    </div>
  );
}

type View = 'results' | 'retrieval' | 'explain';

/**
 * The walkthrough is most of the page's code and none of its first paint, so
 * it loads when its tab is first opened rather than gating the search box.
 */
const Explain = lazy(() => import('./explain.tsx').then((module) => ({ default: module.Explain })));

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
      <p role="alert" className="mt-6 rounded-xl border border-unsupported px-3 py-2 text-unsupported">
        The index could not be loaded: {error}
      </p>
    );
  }

  if (status === 'loading') {
    return (
      <p className="mt-6 text-sm text-ink-2">Loading the index…</p>
    );
  }

  return (
    <p className="mt-6 text-sm text-ink-2">
      {meta.size.toLocaleString('en-GB')} chunks indexed
      {loadMs !== undefined && ` in ${Math.round(loadMs)} ms`}.{' '}
      {hasVectors ? 'Dense and lexical retrieval available.' : 'Lexical retrieval only: no vector index is deployed.'}
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
    <div className="mb-8 rounded-xl border border-partial px-4 py-3 text-sm">
      <h2 className="font-medium">Some stages did not run</h2>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink-2">
        {degraded.map((entry) => (
          <li key={`${entry.stage}-${entry.reason}`}>
            <strong className="font-medium">{STAGE_LABEL[entry.stage] ?? entry.stage}:</strong>{' '}
            {entry.reason}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-ink-2">
        The results below are real, and worse than they would otherwise be.
      </p>
    </div>
  );
}
