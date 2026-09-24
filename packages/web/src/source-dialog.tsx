import { useEffect, useRef, useState } from 'react';
import type { Chunk } from '@rag/core';
import { useLang } from './i18n.tsx';

/**
 * The source document, with the verified quote highlighted where it sits.
 *
 * The text is rendered exactly as the pipeline normalized it — heading markers
 * and all. That is not laziness: charStart and charEnd are offsets into this
 * text, and prettifying it here by stripping characters is precisely how a
 * highlight starts pointing two words to the left of where it should. What the
 * reader sees is what the offsets were measured against.
 *
 * A native dialog, so focus is trapped and restored and the page behind is
 * inert without any of that being reimplemented.
 *
 * Escape is handled explicitly rather than left to the platform. A dialog's
 * Escape handling goes through CloseWatcher, which is recent enough to be
 * missing or inert in some engines — it does not fire at all in the browser
 * this was tested in, with a trusted keydown and nothing calling
 * preventDefault. For a demo that has to keep working for years, a three-line
 * handler is worth more than a platform feature behaving as documented.
 */

export type SourceTarget = {
  chunk: Chunk;
  /** Offsets into the normalized document, as resolved by the verifier. */
  span?: { start: number; end: number };
  /** The sentence whose citation is being inspected. */
  sentence?: string;
};

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

const prefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function SourceDialog({ target, onClose }: { target?: SourceTarget; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const { t, num } = useLang();
  const markRef = useRef<HTMLElement | null>(null);
  const [document_, setDocument] = useState<{ docId: string; text: string }>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (target && !dialog.open) dialog.showModal();
    if (!target && dialog.open) dialog.close();
  }, [target]);

  useEffect(() => {
    if (!target) return;
    const { docId } = target.chunk;
    if (document_?.docId === docId) return;

    setError(undefined);
    void fetch(`${BASE}/corpus/${docId}.txt`)
      .then((response) => {
        if (!response.ok) throw new Error(`${response.status}`);
        return response.text();
      })
      .then((text) => setDocument({ docId, text }))
      .catch((cause: Error) => setError(`Could not load ${docId}: ${cause.message}`));
  }, [target, document_?.docId]);

  useEffect(() => {
    if (!markRef.current) return;
    markRef.current.scrollIntoView({
      block: 'center',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  }, [document_, target]);

  const span = target?.span;
  const text = document_?.docId === target?.chunk.docId ? document_?.text : undefined;

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        // Taking the key outright keeps one path on every engine, instead of
        // closing twice where the native close request does fire.
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => event.target === dialogRef.current && onClose()}
      // Only while there is something to label: the contents are conditional,
      // so a constant aria-labelledby points at an id that does not exist for
      // as long as the dialog is closed.
      {...(target ? { 'aria-labelledby': 'source-title' } : {})}
      className="m-auto flex max-h-[85dvh] w-[min(56rem,92vw)] flex-col overflow-hidden rounded-2xl border border-line bg-paper p-0 text-ink backdrop:bg-zinc-950/60"
    >
      {target && (
        <>
          <div className="flex shrink-0 items-start gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <h2 id="source-title" className="font-semibold" lang="en">
                {target.chunk.docTitle}
              </h2>
              <p className="mt-1 truncate text-sm text-ink-2">
                {target.chunk.headingPath.join(' › ')}
              </p>
              {span && (
                <p className="mt-1 text-sm text-ink-2">
                  {t(
                    `Highlighted characters ${num(span.start)}-${num(span.end)} of the normalized document.`,
                    `Caratteri evidenziati ${num(span.start)}-${num(span.end)} del documento normalizzato.`,
                  )}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="ml-auto shrink-0 rounded-lg border border-line-strong px-3 py-1.5 text-sm"
            >
              {t('Close', 'Chiudi')}
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {error && <p role="alert">{error}</p>}

            {!error && text === undefined && (
              <p className="text-ink-2">{t('Loading the source document…', 'Carico il documento sorgente…')}</p>
            )}

            {text !== undefined && (
              <>
                <p className="mb-4 text-sm text-ink-2">
                  {t(
                    'This is the normalized text the offsets are measured against, shown unaltered.',
                    'Questo è il testo normalizzato su cui sono misurate le posizioni, mostrato senza modifiche.',
                  )}{' '}
                  <a href={target.chunk.sourceUrl} className="underline underline-offset-2" rel="noreferrer">
                    {t('Original document', 'Documento originale')}
                  </a>
                </p>
                <p className="text-sm leading-relaxed whitespace-pre-wrap" lang="en">
                  {span ? (
                    <>
                      {text.slice(0, span.start)}
                      <mark
                        ref={markRef}
                        // No outline: a highlight spanning several lines draws
                        // one box per line fragment, which reads as several
                        // separate marks rather than one continuous passage.
                        className="rounded-sm bg-yellow-200 font-medium text-zinc-900"
                      >
                        {text.slice(span.start, span.end)}
                      </mark>
                      {text.slice(span.end)}
                    </>
                  ) : (
                    text
                  )}
                </p>
              </>
            )}
          </div>
        </>
      )}
    </dialog>
  );
}
