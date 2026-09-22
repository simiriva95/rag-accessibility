import { statusOf, type SentenceStatus, type VerifiedClaim } from '@rag/core';

/**
 * Citation metrics.
 *
 * Retrieval metrics ask whether the right text was found. These ask whether the
 * answer built on top of it is honest — which is the part the project is about,
 * and the part a demo can fake most easily.
 *
 * They are computed over an answer's sentences, not only over its claims. A
 * model that cites two sentences perfectly and leaves six uncited would score
 * 100% on any claim-only metric while saying six unbacked things.
 */

export type Answer = {
  /** Every sentence of the answer, in order. */
  sentences: string[];
  claims: VerifiedClaim[];
};

export type CitationMetrics = {
  /** Sentences carrying at least one claim. */
  coverage: number;
  /**
   * Of every chunk the model cited, the fraction that actually contains the
   * quote. A claim citing four chunks and carried by one has made three
   * citations that do not hold, and this is where that shows.
   */
  precision: number;
  /** Claims whose quote appears in no cited chunk. The fabrication signal. */
  quoteFailureRate: number;
  /** Sentences that make a claim and whose every claim failed. */
  unsupportedRate: number;
  /** Sentences that make no claim at all. */
  uncitedRate: number;
  /** Sentence counts by status, for the report. */
  sentences: Record<SentenceStatus, number>;
  totals: { sentences: number; claims: number; citations: number };
};

const ratio = (part: number, whole: number) => (whole === 0 ? 0 : part / whole);

export function citationMetrics(answer: Answer): CitationMetrics {
  const { sentences, claims } = answer;

  const byStatus: Record<SentenceStatus, number> = {
    verified: 0,
    partial: 0,
    unsupported: 0,
    uncited: 0,
  };
  for (const sentence of sentences) byStatus[statusOf(sentence, claims)]++;

  const citations = claims.reduce((n, claim) => n + claim.chunkIds.length, 0);
  const supporting = claims.reduce((n, claim) => n + claim.supportingChunkIds.length, 0);

  return {
    coverage: ratio(sentences.length - byStatus.uncited, sentences.length),
    precision: ratio(supporting, citations),
    quoteFailureRate: ratio(claims.filter((claim) => !claim.quoteMatch).length, claims.length),
    unsupportedRate: ratio(byStatus.unsupported, sentences.length),
    uncitedRate: ratio(byStatus.uncited, sentences.length),
    sentences: byStatus,
    totals: { sentences: sentences.length, claims: claims.length, citations },
  };
}

/**
 * Aggregates over a run.
 *
 * Averaged per answer rather than pooled over all sentences, so a long answer
 * cannot outvote a short one. The run is a set of questions, and each question
 * counts once.
 */
export function aggregateCitationMetrics(answers: readonly Answer[]): CitationMetrics {
  const each = answers.map(citationMetrics);
  const avg = (pick: (m: CitationMetrics) => number) =>
    each.length === 0 ? 0 : each.reduce((n, m) => n + pick(m), 0) / each.length;

  const sum = (pick: (m: CitationMetrics) => number) => each.reduce((n, m) => n + pick(m), 0);

  return {
    coverage: avg((m) => m.coverage),
    precision: avg((m) => m.precision),
    quoteFailureRate: avg((m) => m.quoteFailureRate),
    unsupportedRate: avg((m) => m.unsupportedRate),
    uncitedRate: avg((m) => m.uncitedRate),
    sentences: {
      verified: sum((m) => m.sentences.verified),
      partial: sum((m) => m.sentences.partial),
      unsupported: sum((m) => m.sentences.unsupported),
      uncited: sum((m) => m.sentences.uncited),
    },
    totals: {
      sentences: sum((m) => m.totals.sentences),
      claims: sum((m) => m.totals.claims),
      citations: sum((m) => m.totals.citations),
    },
  };
}
