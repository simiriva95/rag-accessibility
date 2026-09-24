import { useCallback, useEffect, useRef, useState } from 'react';
import { verifyClaims, type Chunk, type ModelAnswer, type VerifiedClaim } from '@rag/core';
import { generate, isDegraded, judge } from './edge.ts';
import type { Retrieval } from './use-retrieval.ts';

/**
 * Generation, then verification.
 *
 * The order matters and is the point of the project: the model writes claims,
 * and only afterwards does the client check whether the quotes it gave are
 * really in the chunks it cited. The check runs here, in the browser, against
 * the same chunk text the model was shown — nothing about it is taken on trust
 * from the service that produced the answer.
 *
 * Quote matching and span resolution are local and free. Only entailment costs
 * a call, and it is batched into one.
 */

export type Answered = {
  answer: ModelAnswer;
  claims: VerifiedClaim[];
  /** Claims the generator emitted that were not well formed. Shown, not hidden. */
  dropped: string[];
  /** The chunks the answer was written from, in the order they were given. */
  sources: Chunk[];
  /** Which model in the chain answered, when the worker reports it. */
  model?: string;
};

export type AnswerState =
  | { phase: 'idle' }
  | { phase: 'generating' }
  | { phase: 'verifying'; answer: ModelAnswer }
  | { phase: 'answered'; result: Answered }
  | { phase: 'unavailable'; reason: string };

export function useAnswer(retrieval: Retrieval): AnswerState {
  const [state, setState] = useState<AnswerState>({ phase: 'idle' });
  const generation = useRef(0);
  const { run, meta, text } = retrieval;

  const chunksFor = useCallback(
    (ids: string[]): Chunk[] => {
      const out: Chunk[] = [];
      for (const id of ids) {
        const info = meta.get(id);
        const body = text(id);
        if (info && body !== undefined) out.push({ ...info, text: body });
      }
      return out;
    },
    [meta, text],
  );

  useEffect(() => {
    if (!run) return setState({ phase: 'idle' });

    const id = ++generation.current;
    const sources = chunksFor(run.final.map((hit) => hit.chunkId));

    if (sources.length === 0) {
      return setState({ phase: 'unavailable', reason: 'the chunk text has not finished loading' });
    }

    setState({ phase: 'generating' });

    void (async () => {
      const response = await generate(
        run.query,
        sources.map(({ id: chunkId, text: body }) => ({ id: chunkId, text: body })),
      );
      if (id !== generation.current) return;

      if (isDegraded(response)) {
        return setState({ phase: 'unavailable', reason: response.degraded.reason });
      }
      const payload = response.ok;
      if ('degraded' in payload) {
        return setState({ phase: 'unavailable', reason: payload.degraded.reason });
      }

      setState({ phase: 'verifying', answer: payload.answer });

      // Verified against the very chunks handed to the generator, so a citation
      // to something it was never shown cannot quietly pass.
      const byId = new Map(sources.map((chunk) => [chunk.id, chunk]));
      const claims = await verifyClaims(payload.answer.claims, byId, judge);
      if (id !== generation.current) return;

      setState({
        phase: 'answered',
        result: {
          answer: payload.answer,
          claims,
          dropped: payload.dropped,
          sources,
          ...(payload.model ? { model: payload.model } : {}),
        },
      });
    })();
  }, [run, chunksFor]);

  return state;
}
