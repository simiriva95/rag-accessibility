import { describe, expect, it } from 'vitest';
import type { VerifiedClaim } from '@rag/core';
import { aggregateCitationMetrics, citationMetrics, type Answer } from './citation.ts';

const claim = (over: Partial<VerifiedClaim> & { sentence: string }): VerifiedClaim => ({
  chunkIds: ['c1'],
  quote: 'a quote',
  quoteMatch: true,
  supportingChunkIds: ['c1'],
  entailment: 0.9,
  status: 'verified',
  ...over,
});

const fabricated = (sentence: string, chunkIds = ['c1']): VerifiedClaim =>
  claim({ sentence, chunkIds, quoteMatch: false, supportingChunkIds: [], entailment: 0, status: 'unsupported' });

describe('citationMetrics', () => {
  it('scores a fully cited, fully verified answer at one', () => {
    const answer: Answer = {
      sentences: ['One.', 'Two.'],
      claims: [claim({ sentence: 'One.' }), claim({ sentence: 'Two.' })],
    };
    const m = citationMetrics(answer);
    expect(m.coverage).toBe(1);
    expect(m.precision).toBe(1);
    expect(m.unsupportedRate).toBe(0);
    expect(m.uncitedRate).toBe(0);
  });

  it('counts a sentence with no claim as uncited, not unsupported', () => {
    // Conflating the two would hide the sentences that do make an unbacked claim.
    const m = citationMetrics({ sentences: ['Here is what it says:', 'Two.'], claims: [claim({ sentence: 'Two.' })] });
    expect(m.uncitedRate).toBe(0.5);
    expect(m.unsupportedRate).toBe(0);
    expect(m.coverage).toBe(0.5);
    expect(m.sentences).toEqual({ verified: 1, partial: 0, unsupported: 0, uncited: 1 });
  });

  it('does not let a perfectly cited sentence hide six uncited ones', () => {
    const sentences = ['Cited.', ...Array.from({ length: 6 }, (_, i) => `Uncited ${i}.`)];
    const m = citationMetrics({ sentences, claims: [claim({ sentence: 'Cited.' })] });
    // Claim-only metrics would read 100% here.
    expect(m.precision).toBe(1);
    expect(m.coverage).toBeCloseTo(1 / 7);
  });

  it('penalises the citations that did not hold, not just the claim', () => {
    const m = citationMetrics({
      sentences: ['One.'],
      claims: [claim({ sentence: 'One.', chunkIds: ['c1', 'c2', 'c3', 'c4'], supportingChunkIds: ['c1'] })],
    });
    expect(m.precision).toBe(0.25);
    // The claim itself still stands: one citation carried it.
    expect(m.sentences.verified).toBe(1);
  });

  it('reports the quote failure rate separately from entailment', () => {
    const m = citationMetrics({
      sentences: ['One.', 'Two.'],
      claims: [
        claim({ sentence: 'One.', entailment: 0.1, status: 'unsupported' }), // quote held, evidence did not
        fabricated('Two.'),
      ],
    });
    expect(m.quoteFailureRate).toBe(0.5);
    expect(m.unsupportedRate).toBe(1);
  });

  it('takes a sentence to be as good as its best claim', () => {
    const m = citationMetrics({
      sentences: ['One.'],
      claims: [fabricated('One.'), claim({ sentence: 'One.' })],
    });
    expect(m.sentences.verified).toBe(1);
    expect(m.unsupportedRate).toBe(0);
    // The failed citation still shows in precision.
    expect(m.precision).toBe(0.5);
  });

  it('counts a partial sentence as neither verified nor unsupported', () => {
    const m = citationMetrics({
      sentences: ['One.'],
      claims: [claim({ sentence: 'One.', entailment: 0.5, status: 'partial' })],
    });
    expect(m.sentences).toEqual({ verified: 0, partial: 1, unsupported: 0, uncited: 0 });
    expect(m.coverage).toBe(1);
    expect(m.unsupportedRate).toBe(0);
  });

  it('handles an empty answer without dividing by zero', () => {
    const m = citationMetrics({ sentences: [], claims: [] });
    expect(m.coverage).toBe(0);
    expect(m.precision).toBe(0);
    expect(m.quoteFailureRate).toBe(0);
  });
});

describe('aggregateCitationMetrics', () => {
  it('averages per answer, so a long answer cannot outvote a short one', () => {
    const perfect: Answer = { sentences: ['One.'], claims: [claim({ sentence: 'One.' })] };
    const sloppy: Answer = {
      sentences: Array.from({ length: 20 }, (_, i) => `S${i}.`),
      claims: [],
    };

    const m = aggregateCitationMetrics([perfect, sloppy]);
    // Pooled over sentences this would be 1/21; averaged per answer it is 1/2.
    expect(m.coverage).toBeCloseTo(0.5);
  });

  it('sums the raw counts while averaging the rates', () => {
    const answer: Answer = { sentences: ['One.', 'Two.'], claims: [claim({ sentence: 'One.' })] };
    const m = aggregateCitationMetrics([answer, answer]);
    expect(m.totals).toEqual({ sentences: 4, claims: 2, citations: 2 });
    expect(m.sentences).toEqual({ verified: 2, partial: 0, unsupported: 0, uncited: 2 });
    expect(m.coverage).toBe(0.5);
  });

  it('returns zeroes for an empty run', () => {
    expect(aggregateCitationMetrics([]).coverage).toBe(0);
  });
});
