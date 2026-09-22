import { describe, expect, it } from 'vitest';
import { parseModelAnswer, verifyClaims, type Chunk, type EntailmentJudge } from '@rag/core';
import { citationMetrics } from './citation.ts';
import { loadChunks } from './resolve.ts';

/**
 * The whole contract chain over real chunks: what the model is asked to return,
 * what the parser accepts, what the verifier does with it, and what the metrics
 * say about the result.
 *
 * The unit tests each hold one link. This one holds them together — it is the
 * test that fails when two of them drift apart while both still pass on their
 * own fixtures.
 */

const chunks = loadChunks();
const byId = new Map<string, Chunk>(chunks.map((chunk) => [chunk.id, chunk]));

/** Three real chunks, and a genuine excerpt from each. */
const sources = chunks.filter((_, i) => i % 401 === 0).slice(0, 3);
const excerpt = (chunk: Chunk) => chunk.text.split(/\s+/).filter(Boolean).slice(4, 16).join(' ');

const judgeAll = (score: number | null): EntailmentJudge => async (pairs) => pairs.map(() => score);

describe('the answer pipeline over real chunks', () => {
  it('has three distinct sources to work with', () => {
    expect(new Set(sources.map((s) => s.id)).size).toBe(3);
    for (const source of sources) expect(excerpt(source).length).toBeGreaterThan(30);
  });

  it('carries an honest answer through to verified citations with spans', async () => {
    const { answer, dropped } = parseModelAnswer({
      answerable: true,
      sentences: sources.map((_, i) => `Sentence ${i} about accessibility.`),
      claims: sources.map((source, i) => ({
        sentenceIndex: i,
        chunkIds: [source.id],
        quote: excerpt(source),
      })),
    });
    expect(dropped).toEqual([]);

    const verified = await verifyClaims(answer.claims, byId, judgeAll(1));
    for (const claim of verified) {
      expect(claim.status).toBe('verified');
      expect(claim.span).toBeDefined();
      // The span has to land inside the chunk that was actually cited.
      const cited = byId.get(claim.span!.chunkId)!;
      expect(claim.span!.start).toBeGreaterThanOrEqual(cited.charStart);
      expect(claim.span!.end).toBeLessThanOrEqual(cited.charEnd);
    }

    const metrics = citationMetrics({ sentences: answer.sentences, claims: verified });
    expect(metrics).toMatchObject({ coverage: 1, precision: 1, quoteFailureRate: 0, unsupportedRate: 0 });
  });

  it('separates a fabricated quote from a misdirected one from an honest one', async () => {
    const [a, b, c] = sources as [Chunk, Chunk, Chunk];

    const { answer } = parseModelAnswer({
      answerable: true,
      sentences: ['Honest.', 'Fabricated.', 'Cited to the wrong chunk.'],
      claims: [
        { sentenceIndex: 0, chunkIds: [a.id], quote: excerpt(a) },
        { sentenceIndex: 1, chunkIds: [b.id], quote: 'Authors must ensure the focus indicator blinks.' },
        { sentenceIndex: 2, chunkIds: [c.id], quote: excerpt(a) },
      ],
    });

    const verified = await verifyClaims(answer.claims, byId, judgeAll(1));
    expect(verified.map((claim) => claim.status)).toEqual(['verified', 'unsupported', 'unsupported']);
    expect(verified.map((claim) => claim.quoteMatch)).toEqual([true, false, false]);

    const metrics = citationMetrics({ sentences: answer.sentences, claims: verified });
    expect(metrics.quoteFailureRate).toBeCloseTo(2 / 3);
    expect(metrics.precision).toBeCloseTo(1 / 3);
    expect(metrics.unsupportedRate).toBeCloseTo(2 / 3);
  });

  it('reports a citation to a chunk that was never retrieved', async () => {
    const { answer } = parseModelAnswer({
      answerable: true,
      sentences: ['One.'],
      claims: [{ sentenceIndex: 0, chunkIds: ['not-a-real-chunk-id'], quote: excerpt(sources[0]!) }],
    });

    const verified = await verifyClaims(answer.claims, byId, judgeAll(1));
    expect(verified[0]!.status).toBe('unsupported');
    expect(verified[0]!.supportingChunkIds).toEqual([]);
  });

  it('shows a quote that held but could not be judged as unverified, not as a failure', async () => {
    const { answer } = parseModelAnswer({
      answerable: true,
      sentences: ['One.'],
      claims: [{ sentenceIndex: 0, chunkIds: [sources[0]!.id], quote: excerpt(sources[0]!) }],
    });

    const verified = await verifyClaims(answer.claims, byId, judgeAll(null));
    expect(verified[0]!.status).toBe('unverified');
    expect(verified[0]!.quoteMatch).toBe(true);

    const metrics = citationMetrics({ sentences: answer.sentences, claims: verified });
    expect(metrics.unverifiedRate).toBe(1);
    // A judge outage must not look like a fabrication.
    expect(metrics.unsupportedRate).toBe(0);
    expect(metrics.quoteFailureRate).toBe(0);
  });

  it('treats a refusal as a refusal, not as an answer full of uncited sentences', async () => {
    const { answer } = parseModelAnswer({
      answerable: false,
      sentences: ['The provided sources do not cover EN 301 549.'],
      claims: [],
    });

    expect(answer.answerable).toBe(false);
    const verified = await verifyClaims(answer.claims, byId, judgeAll(1));
    expect(verified).toEqual([]);
    // The metrics still describe it honestly; the caller reads answerable first.
    expect(citationMetrics({ sentences: answer.sentences, claims: verified }).uncitedRate).toBe(1);
  });
});
