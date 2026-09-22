import type { Scored } from './types.ts';

/**
 * Reciprocal Rank Fusion.
 *
 *   score(d) = Σ  1 / (k + rank_r(d))     over the rankings r that contain d
 *
 * Deliberately no score normalization. BM25 scores are unbounded sums of idf
 * terms; cosine similarities sit in [-1, 1] and bunch up near the top. Mapping
 * both onto a common scale means picking a mapping, and every choice is a
 * tuning knob that breaks on the next corpus. RRF only reads the ordering,
 * which is the part both retrievers agree on the meaning of.
 *
 * k dampens the top of each list: with k = 60 the gap between rank 1 and rank 2
 * is small, so one retriever cannot carry a document on its own confidence —
 * agreement across retrievers outweighs certainty within one.
 */

export const RRF_K = 60;

export function fuseRrf(
  rankings: readonly (readonly Scored[])[],
  { k = RRF_K, topK = 30 }: { k?: number; topK?: number } = {},
): Scored[] {
  const fused = new Map<string, number>();

  for (const ranking of rankings) {
    for (const [position, hit] of ranking.entries()) {
      fused.set(hit.chunkId, (fused.get(hit.chunkId) ?? 0) + 1 / (k + position + 1));
    }
  }

  return [...fused]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)) // id breaks ties, so runs are reproducible
    .slice(0, topK)
    .map(([chunkId, score]) => ({ chunkId, score }));
}
