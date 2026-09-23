import { useCallback, useEffect, useRef, useState } from 'react';
import type { Scored } from '@rag/core';
import { embedQuery, isDegraded, rerank, type Degraded } from './edge.ts';
import type { ChunkMeta, Stage, WorkerRequest, WorkerResponse } from './retrieval.worker.ts';

/**
 * Drives the retrieval pipeline: edge embedding, the worker's three candidate
 * lists, then the edge reranker.
 *
 * Each stage records what it did and, when it could not run, why. The debugger
 * renders that record directly — it is not a separate instrumentation path, it
 * is the same object the pipeline produced.
 */

export type Status = 'loading' | 'ready' | 'failed';

export type Run = {
  query: string;
  stages: Stage[];
  /** The reranked top 8, or the fused head when reranking did not run. */
  final: Scored[];
  timings: { embed?: number; rerank?: number; total: number };
  /** One entry per stage that could not run, in pipeline order. */
  degraded: (Degraded & { stage: string })[];
};

export type DegradedStage = Degraded & { stage: string };

export type Retrieval = {
  status: Status;
  error?: string;
  /** Chunk metadata by id. Text arrives separately. */
  meta: Map<string, ChunkMeta>;
  hasVectors: boolean;
  loadMs?: number;
  running: boolean;
  run?: Run;
  ask: (query: string) => void;
  /** Chunk text, once it has arrived. Undefined while still loading. */
  text: (id: string) => string | undefined;
};

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
const CANDIDATES = 30;
const FINAL = 8;

export function useRetrieval(): Retrieval {
  const workerRef = useRef<Worker | null>(null);
  const textsRef = useRef<Record<string, string>>({});
  const pending = useRef(0);

  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string>();
  const [meta, setMeta] = useState<Map<string, ChunkMeta>>(new Map());
  const [hasVectors, setHasVectors] = useState(false);
  const [loadMs, setLoadMs] = useState<number>();
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<Run>();
  // The text itself lives in a ref — it is two megabytes and never changes —
  // while this flag is what tells React that reading it is now worthwhile.
  const [textsReady, setTextsReady] = useState(false);

  useEffect(() => {
    const worker = new Worker(new URL('./retrieval.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;

    worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
      if (data.type === 'error') {
        setError(data.message);
        setStatus('failed');
      }
      if (data.type === 'ready') {
        setHasVectors(data.hasVectors);
        setLoadMs(data.ms);
        setStatus('ready');
      }
      if (data.type === 'results') handleResults(data);
    };

    const send = (message: WorkerRequest) => worker.postMessage(message);
    send({ type: 'load', base: BASE });

    // Metadata comes back through the worker's ready message, but the app also
    // needs it to render; fetching it here costs nothing, the browser cache
    // already holds the response the worker asked for.
    void fetch(`${BASE}/index/chunks.meta.json`)
      .then((r) => r.json() as Promise<ChunkMeta[]>)
      .then((list) => setMeta(new Map(list.map((chunk) => [chunk.id, chunk]))))
      .catch(() => undefined);

    // Chunk text is only needed once a result is shown, so it loads alongside
    // rather than gating the first query.
    void fetch(`${BASE}/index/chunks.text.json`)
      .then((r) => r.json() as Promise<Record<string, string>>)
      .then((texts) => {
        textsRef.current = texts;
        setTextsReady(true);
      })
      .catch(() => undefined);

    return () => worker.terminate();
  }, []);

  const inFlight = useRef<{
    query: string;
    started: number;
    embedMs?: number;
    degraded: DegradedStage[];
  } | null>(null);

  const handleResults = useCallback(async (data: Extract<WorkerResponse, { type: 'results' }>) => {
    const context = inFlight.current;
    if (!context || data.id !== pending.current) return;

    if (data.denseSkipped) context.degraded.push({ stage: 'dense', reason: data.denseSkipped });

    const fused = data.stages.find((stage) => stage.name === 'fused')?.hits ?? [];
    let final = fused.slice(0, FINAL);
    let rerankMs: number | undefined;

    const texts = textsRef.current;
    const candidates = fused
      .map((hit) => ({ id: hit.chunkId, text: texts[hit.chunkId] ?? '' }))
      .filter((candidate) => candidate.text !== '');

    if (candidates.length > 0) {
      const started = performance.now();
      const response = await rerank(context.query, candidates);
      rerankMs = performance.now() - started;

      if (isDegraded(response)) {
        context.degraded.push({ stage: 'rerank', ...response.degraded });
      } else {
        if (response.ok.degraded) context.degraded.push({ stage: 'rerank', ...response.ok.degraded });
        final = response.ok.results.map(({ id, score }) => ({ chunkId: id, score }));
      }
    } else {
      context.degraded.push({ stage: 'rerank', reason: 'chunk text not loaded yet' });
    }

    setRun({
      query: context.query,
      stages: data.stages,
      final,
      timings: {
        ...(context.embedMs !== undefined ? { embed: context.embedMs } : {}),
        ...(rerankMs !== undefined ? { rerank: rerankMs } : {}),
        total: performance.now() - context.started,
      },
      degraded: context.degraded,
    });
    setRunning(false);
  }, []);

  const ask = useCallback((query: string) => {
    const trimmed = query.trim();
    if (!trimmed || !workerRef.current) return;

    const id = ++pending.current;
    inFlight.current = { query: trimmed, started: performance.now(), degraded: [] };
    setRunning(true);

    void (async () => {
      const started = performance.now();
      const embedded = await embedQuery(trimmed);
      const context = inFlight.current;
      if (!context || id !== pending.current) return;

      context.embedMs = performance.now() - started;
      if (isDegraded(embedded)) context.degraded.push({ stage: 'embed', ...embedded.degraded });

      workerRef.current?.postMessage({
        type: 'search',
        id,
        query: trimmed,
        candidates: CANDIDATES,
        ...(isDegraded(embedded) ? {} : { vector: embedded.ok.vector }),
      } satisfies WorkerRequest);
    })();
  }, []);

  return {
    status,
    ...(error !== undefined ? { error } : {}),
    meta,
    hasVectors,
    ...(loadMs !== undefined ? { loadMs } : {}),
    running,
    ...(run !== undefined ? { run } : {}),
    ask,
    text: useCallback((id: string) => (textsReady ? textsRef.current[id] : undefined), [textsReady]),
  };
}
