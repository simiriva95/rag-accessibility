import type { Scored } from './types.ts';
import { tokenize } from './tokenize.ts';

/**
 * Okapi BM25, written out rather than pulled in.
 *
 * The implementation is short and it is part of what the project demonstrates;
 * a search library would also hide the tokenizer, which is the half that
 * actually decides whether `aria-describedby` is findable.
 *
 *              f(q,D) * (k1 + 1)
 *   score = Σ  ───────────────────────────────── * idf(q)
 *              f(q,D) + k1 * (1 - b + b * |D|/avgdl)
 */

export type Bm25Params = { k1: number; b: number };

export const BM25_DEFAULTS: Bm25Params = { k1: 1.2, b: 0.75 };

/**
 * Shipped as a static asset, so the shape is chosen for JSON size: postings are
 * flat [docIndex, termFrequency, ...] pairs rather than objects.
 */
export type Bm25Index = {
  params: Bm25Params;
  /** Chunk ids; a document's index into this array is its internal id. */
  docIds: string[];
  /** Token count per document, in the same order. */
  lengths: number[];
  avgdl: number;
  postings: Record<string, number[]>;
};

export function buildBm25Index(
  docs: readonly { id: string; text: string }[],
  params: Bm25Params = BM25_DEFAULTS,
): Bm25Index {
  const docIds: string[] = [];
  const lengths: number[] = [];
  const postings: Record<string, number[]> = {};

  for (const doc of docs) {
    const index = docIds.length;
    const tokens = tokenize(doc.text);

    const frequencies = new Map<string, number>();
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);

    for (const [term, tf] of frequencies) {
      (postings[term] ??= []).push(index, tf);
    }

    docIds.push(doc.id);
    lengths.push(tokens.length);
  }

  const total = lengths.reduce((n, l) => n + l, 0);
  return { params, docIds, lengths, avgdl: total / (lengths.length || 1), postings };
}

/**
 * Probabilistic idf in its smoothed form: ln(1 + (N - df + 0.5) / (df + 0.5)).
 * The outer 1 + keeps it positive for a term that appears in every document,
 * where the raw form goes negative and starts penalising matches.
 */
export const bm25Idf = (docCount: number, df: number) => Math.log(1 + (docCount - df + 0.5) / (df + 0.5));

export function searchBm25(index: Bm25Index, query: string, topK = 30): Scored[] {
  const { k1, b } = index.params;
  const docCount = index.docIds.length;
  const scores = new Map<number, number>();

  // A repeated query term counts once: BM25 saturates on document frequency,
  // not on how many times the user typed the word.
  for (const term of new Set(tokenize(query))) {
    const posting = index.postings[term];
    if (!posting) continue;

    const weight = bm25Idf(docCount, posting.length / 2);

    for (let i = 0; i < posting.length; i += 2) {
      const doc = posting[i]!;
      const tf = posting[i + 1]!;
      const norm = 1 - b + (b * index.lengths[doc]!) / index.avgdl;
      scores.set(doc, (scores.get(doc) ?? 0) + (weight * (tf * (k1 + 1))) / (tf + k1 * norm));
    }
  }

  return [...scores]
    .sort((x, y) => y[1] - x[1])
    .slice(0, topK)
    .map(([doc, score]) => ({ chunkId: index.docIds[doc]!, score }));
}

/** One query term's part in one document's score. */
export type TermContribution = { term: string; df: number; idf: number; tf: number; score: number };

/**
 * The BM25 sum for one document, term by term — the same arithmetic as
 * searchBm25, kept apart so the ranking loop stays a tight loop. It exists so
 * the UI can show why a document scored what it did rather than assert it.
 */
export function explainBm25(index: Bm25Index, query: string, chunkId: string): TermContribution[] {
  const { k1, b } = index.params;
  const docCount = index.docIds.length;
  const doc = index.docIds.indexOf(chunkId);

  return [...new Set(tokenize(query))].map((term) => {
    const posting = index.postings[term] ?? [];
    const df = posting.length / 2;
    const weight = df === 0 ? 0 : bm25Idf(docCount, df);

    let tf = 0;
    for (let i = 0; i < posting.length; i += 2) if (posting[i] === doc) tf = posting[i + 1]!;

    const norm = doc === -1 ? 1 : 1 - b + (b * index.lengths[doc]!) / index.avgdl;
    return { term, df, idf: weight, tf, score: tf === 0 ? 0 : (weight * (tf * (k1 + 1))) / (tf + k1 * norm) };
  });
}
