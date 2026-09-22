import { describe, expect, it, vi } from 'vitest';
import type { Chunk } from './types.ts';
import {
  locateQuote,
  normalizeForMatch,
  statusOf,
  verifyClaim,
  verifyClaims,
  type Claim,
  type EntailmentJudge,
  type VerifiedClaim,
} from './verify.ts';

/** A document the chunk is a slice of, so spans can be checked against it. */
const DOC =
  'Some earlier text.\n\n' +
  '#### Success Criterion 2.4.11 Focus Not Obscured (Minimum)\n\n' +
  'When a user interface component receives keyboard focus, the component is not ' +
  'entirely hidden due to author-created content.';

const START = DOC.indexOf('#### Success');

const chunk = (over: Partial<Chunk> = {}): Chunk => ({
  id: 'c1',
  docId: 'wcag22',
  docTitle: 'WCAG 2.2',
  sourceUrl: 'https://www.w3.org/TR/WCAG22/',
  headingPath: ['WCAG 2.2'],
  text: DOC.slice(START),
  charStart: START,
  charEnd: DOC.length,
  tokenCount: 30,
  ...over,
});

const chunks = (...list: Chunk[]) => new Map(list.map((c) => [c.id, c]));

const judgeReturning = (score: number | null): EntailmentJudge => async (pairs) => pairs.map(() => score);
const neverCalled: EntailmentJudge = async () => {
  throw new Error('the judge should not have been asked');
};

const claimOf = (sentence: string, status: VerifiedClaim['status']): VerifiedClaim => ({
  sentence,
  chunkIds: ['c1'],
  quote: 'a quote',
  quoteMatch: status !== 'unsupported',
  supportingChunkIds: status === 'unsupported' ? [] : ['c1'],
  entailment: status === 'verified' ? 0.9 : status === 'partial' ? 0.5 : status === 'unverified' ? null : 0,
  status,
});

const claim = (over: Partial<Claim> = {}): Claim => ({
  sentence: 'A focused component must not be entirely hidden.',
  chunkIds: ['c1'],
  quote: 'the component is not entirely hidden',
  ...over,
});

describe('normalizeForMatch', () => {
  it('collapses whitespace runs to a single space', () => {
    expect(normalizeForMatch('a  \n\t b').text).toBe('a b');
  });

  it('trims the edges', () => {
    expect(normalizeForMatch('  a  ').text).toBe('a');
  });

  it('folds the typographic characters a model swaps without asking', () => {
    expect(normalizeForMatch('don’t “quote” me — please…').text).toBe(
      'don\'t "quote" me - please...',
    );
  });

  it('normalizes Unicode composition', () => {
    expect(normalizeForMatch('é').text).toBe('é');
  });

  it('does not fold case, because verbatim means verbatim', () => {
    expect(normalizeForMatch('Focus').text).toBe('Focus');
  });

  it('maps every normalized character back to the source range it came from', () => {
    const { text, starts, ends } = normalizeForMatch('a  b’c');
    expect(text).toBe("a b'c");
    // The collapsed space covers the whole whitespace run.
    expect(starts).toEqual([0, 1, 3, 4, 5]);
    expect(ends).toEqual([1, 3, 4, 5, 6]);
  });

  it('keeps the map aligned when one character expands to several', () => {
    const { text, starts, ends } = normalizeForMatch('a…b');
    expect(text).toBe('a...b');
    expect(starts).toEqual([0, 1, 1, 1, 2]);
    expect(ends).toEqual([1, 2, 2, 2, 3]);
  });

  it('maps a composed character back over both source characters', () => {
    const { text, starts, ends } = normalizeForMatch('é');
    expect(text).toBe('é');
    expect(starts).toEqual([0]);
    expect(ends).toEqual([2]);
  });
});

describe('locateQuote', () => {
  it('finds a verbatim quote and returns document offsets', () => {
    const span = locateQuote('the component is not entirely hidden', chunk())!;
    expect(DOC.slice(span.start, span.end)).toBe('the component is not entirely hidden');
  });

  it('finds a quote whose whitespace the model reflowed', () => {
    const span = locateQuote('Success Criterion 2.4.11\n   Focus Not Obscured', chunk())!;
    expect(DOC.slice(span.start, span.end)).toBe('Success Criterion 2.4.11 Focus Not Obscured');
  });

  it('finds a quote across a paragraph break in the source', () => {
    const span = locateQuote('(Minimum) When a user interface component', chunk())!;
    expect(normalizeForMatch(DOC.slice(span.start, span.end)).text).toBe(
      '(Minimum) When a user interface component',
    );
  });

  it('finds a quote whose apostrophe style differs from the source', () => {
    const source = 'Select all that apply, then choose ‘none’ if unsure.';
    const c = chunk({ text: source, charStart: 0, charEnd: source.length });
    const span = locateQuote("choose 'none' if unsure", c)!;
    expect(source.slice(span.start, span.end)).toBe('choose ‘none’ if unsure');
  });

  it('returns nothing for a quote that is not there', () => {
    expect(locateQuote('the component must blink', chunk())).toBeUndefined();
  });

  it('returns nothing for a quote that differs only in case', () => {
    expect(locateQuote('The Component Is Not Entirely Hidden', chunk())).toBeUndefined();
  });

  it('returns nothing for an empty quote', () => {
    expect(locateQuote('   ', chunk())).toBeUndefined();
  });
});

describe('statusOf', () => {
  const verified = claimOf('One.', 'verified');
  const weak = claimOf('One.', 'unsupported');

  it('takes a sentence to be as good as its best claim', () => {
    expect(statusOf('One.', [weak, verified])).toBe('verified');
    expect(statusOf('One.', [verified, weak])).toBe('verified');
  });

  it('calls a sentence with no claim uncited, not unsupported', () => {
    expect(statusOf('Here is what it says:', [verified])).toBe('uncited');
  });

  it('reports the only claim it has', () => {
    expect(statusOf('One.', [claimOf('One.', 'partial')])).toBe('partial');
    expect(statusOf('One.', [claimOf('One.', 'unverified')])).toBe('unverified');
  });

  it('ranks any verdict above an unjudged quote, except outright rejection', () => {
    expect(statusOf('One.', [claimOf('One.', 'unverified'), claimOf('One.', 'partial')])).toBe('partial');
    expect(statusOf('One.', [claimOf('One.', 'unverified'), claimOf('One.', 'unsupported')])).toBe('unverified');
  });
});

describe('verifyClaim', () => {
  it('marks a matched quote with a high entailment as verified', async () => {
    const result = await verifyClaim(claim(), chunks(chunk()), judgeReturning(0.9));
    expect(result.quoteMatch).toBe(true);
    expect(result.status).toBe('verified');
    expect(result.span?.chunkId).toBe('c1');
  });

  it('marks a matched quote with a middling entailment as partial', async () => {
    const result = await verifyClaim(claim(), chunks(chunk()), judgeReturning(0.5));
    expect(result.status).toBe('partial');
  });

  it('marks a matched quote the evidence does not support as unsupported', async () => {
    const result = await verifyClaim(claim(), chunks(chunk()), judgeReturning(0.1));
    expect(result.quoteMatch).toBe(true);
    expect(result.status).toBe('unsupported');
  });

  it('rejects a fabricated quote without asking the judge', async () => {
    const result = await verifyClaim(
      claim({ quote: 'the component must blink twice' }),
      chunks(chunk()),
      neverCalled,
    );
    expect(result.quoteMatch).toBe(false);
    expect(result.status).toBe('unsupported');
    expect(result.span).toBeUndefined();
  });

  it('rejects a citation to a chunk that does not exist', async () => {
    const result = await verifyClaim(claim({ chunkIds: ['nope'] }), chunks(chunk()), neverCalled);
    expect(result.status).toBe('unsupported');
  });

  it('falls through to the cited chunk that actually contains the quote', async () => {
    const other = chunk({ id: 'c0', text: 'Unrelated text.', charStart: 0, charEnd: 15 });
    const result = await verifyClaim(
      claim({ chunkIds: ['c0', 'c1'] }),
      chunks(other, chunk()),
      judgeReturning(0.9),
    );
    expect(result.span?.chunkId).toBe('c1');
  });

  it('honours custom thresholds', async () => {
    const strict = await verifyClaim(claim(), chunks(chunk()), judgeReturning(0.8), {
      verifiedAt: 0.95,
      partialAt: 0.9,
    });
    expect(strict.status).toBe('unsupported');
  });

  it('records every cited chunk that holds the quote, not just the first', async () => {
    const twin = chunk({ id: 'c2' }); // same text, so the quote is in both
    const result = await verifyClaim(
      claim({ chunkIds: ['c1', 'c2'] }),
      chunks(chunk(), twin),
      judgeReturning(0.9),
    );
    expect(result.supportingChunkIds).toEqual(['c1', 'c2']);
    // The span still comes from the first, so the highlight is deterministic.
    expect(result.span?.chunkId).toBe('c1');
  });

  it('leaves a citation that does not hold out of the supporting list', async () => {
    const other = chunk({ id: 'c0', text: 'Unrelated text.', charStart: 0, charEnd: 15 });
    const result = await verifyClaim(
      claim({ chunkIds: ['c0', 'c1', 'missing'] }),
      chunks(other, chunk()),
      judgeReturning(0.9),
    );
    expect(result.supportingChunkIds).toEqual(['c1']);
    // Three citations were made and one held: that is what precision measures.
    expect(result.chunkIds).toHaveLength(3);
  });

  it('marks a quote-matched claim unverified when no judge was available', async () => {
    const result = await verifyClaim(claim(), chunks(chunk()), judgeReturning(null));
    // Not 'partial': an outage must not read as a verdict.
    expect(result.status).toBe('unverified');
    expect(result.quoteMatch).toBe(true);
    expect(result.entailment).toBeNull();
    expect(result.span).toBeDefined();
  });

  it('judges the whole batch in one call', async () => {
    const calls: number[] = [];
    const judge: EntailmentJudge = async (pairs) => {
      calls.push(pairs.length);
      return pairs.map(() => 0.9);
    };

    await verifyClaims([claim(), claim({ sentence: 'Another.' })], chunks(chunk()), judge);
    expect(calls).toEqual([2]);
  });

  it('leaves quote failures out of the batch sent to the judge', async () => {
    const judge = vi.fn(async (pairs: readonly { sentence: string }[]) => pairs.map(() => 0.9));
    const results = await verifyClaims(
      [claim({ quote: 'invented' }), claim({ sentence: 'Real.' })],
      chunks(chunk()),
      judge,
    );

    expect(judge.mock.calls[0]![0]).toHaveLength(1);
    expect(results[0]!.status).toBe('unsupported');
    expect(results[1]!.status).toBe('verified');
  });

  it('does not call the judge at all when nothing survived the quote check', async () => {
    const results = await verifyClaims([claim({ quote: 'invented' })], chunks(chunk()), neverCalled);
    expect(results[0]!.status).toBe('unsupported');
  });

  it('marks a claim unverified when the judge returns a short batch', async () => {
    const short: EntailmentJudge = async () => [];
    const results = await verifyClaims([claim()], chunks(chunk()), short);
    expect(results[0]!.status).toBe('unverified');
  });

  it('keeps unsupported claims in the output rather than dropping them', async () => {
    const results = await verifyClaims(
      [claim(), claim({ quote: 'invented text' })],
      chunks(chunk()),
      judgeReturning(0.9),
    );
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.status)).toEqual(['verified', 'unsupported']);
  });
});
