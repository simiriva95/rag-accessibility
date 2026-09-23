import { createRemoteJudge, type EntailmentJudge } from '@rag/core';

/**
 * Client for the Cloudflare Worker.
 *
 * Every call returns a `degraded` reason instead of throwing. The three things
 * the edge does are the three things that can be unavailable — quota, outage,
 * no deployment at all during local development — and none of them should stop
 * the app. The lexical half of retrieval is entirely local and always works.
 */

const ENDPOINT = (import.meta.env['VITE_WORKER_URL'] ?? '').replace(/\/$/, '');

export type Degraded = { reason: string };
export type Edge<T> = { ok: T } | { degraded: Degraded };

export const isDegraded = <T>(result: Edge<T>): result is { degraded: Degraded } => 'degraded' in result;

const NOT_DEPLOYED: Edge<never> = {
  degraded: { reason: 'no worker configured (VITE_WORKER_URL)' },
};

async function call<T>(path: string, body: unknown): Promise<Edge<T>> {
  if (!ENDPOINT) return NOT_DEPLOYED;

  try {
    const response = await fetch(`${ENDPOINT}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (response.status === 429) return { degraded: { reason: 'rate limited — try again in a moment' } };
    if (!response.ok) return { degraded: { reason: `${path} returned ${response.status}` } };

    return { ok: (await response.json()) as T };
  } catch (error) {
    return { degraded: { reason: (error as Error).message } };
  }
}

export const embedQuery = (query: string): Promise<Edge<{ vector: number[] }>> =>
  call('/embed', { query });

export const rerank = (
  query: string,
  candidates: { id: string; text: string }[],
): Promise<Edge<{ results: { id: string; score: number }[]; degraded?: Degraded }>> =>
  call('/rerank', { query, candidates });

export const generate = (
  question: string,
  sources: { id: string; text: string }[],
): Promise<Edge<unknown>> => call('/answer', { question, sources });

/** The entailment judge, pointed at the worker. Returns nulls when it cannot run. */
export const judge: EntailmentJudge = ENDPOINT
  ? createRemoteJudge({ endpoint: `${ENDPOINT}/entail` })
  : async (pairs) => pairs.map(() => null);
