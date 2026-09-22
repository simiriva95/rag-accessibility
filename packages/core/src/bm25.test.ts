import { describe, expect, it } from 'vitest';
import { BM25_DEFAULTS, buildBm25Index, searchBm25 } from './bm25.ts';
import { tokenize } from './tokenize.ts';

const corpus = [
  { id: 'a', text: 'The focus indicator must remain visible when a component receives keyboard focus.' },
  { id: 'b', text: 'Use aria-describedby to associate a hint with an input.' },
  { id: 'c', text: 'Success Criterion 2.4.11 Focus Not Obscured (Minimum) is a Level AA requirement.' },
  { id: 'd', text: 'Colour contrast of text must meet a ratio of 4.5 to 1.' },
];

const ranked = (query: string) => searchBm25(buildBm25Index(corpus), query).map((s) => s.chunkId);

describe('searchBm25', () => {
  it('ranks the document containing the query term first', () => {
    expect(ranked('contrast ratio')[0]).toBe('d');
    expect(ranked('keyboard')[0]).toBe('a');
  });

  it('finds an identifier that dense retrieval would blur', () => {
    expect(ranked('aria-describedby')).toEqual(['b']);
  });

  it('finds a criterion by its number alone', () => {
    expect(ranked('2.4.11')).toEqual(['c']);
  });

  it('matches a partial identifier through the split parts', () => {
    expect(ranked('describedby')).toEqual(['b']);
  });

  it('returns nothing rather than noise for an absent term', () => {
    expect(ranked('kubernetes')).toEqual([]);
  });

  it('prefers the shorter document when the term appears in both', () => {
    const index = buildBm25Index([
      { id: 'short', text: 'focus order' },
      { id: 'long', text: `focus order ${'padding words '.repeat(50)}` },
    ]);
    expect(searchBm25(index, 'focus order')[0]!.chunkId).toBe('short');
  });

  it('does not let a term present in every document dominate', () => {
    const index = buildBm25Index([
      { id: 'x', text: 'focus focus focus focus' },
      { id: 'y', text: 'focus keyboard' },
    ]);
    // "focus" is in both, so its idf is small; "keyboard" decides the ranking.
    expect(searchBm25(index, 'focus keyboard')[0]!.chunkId).toBe('y');
  });

  it('counts a repeated query term once', () => {
    const index = buildBm25Index(corpus);
    expect(searchBm25(index, 'keyboard keyboard keyboard')).toEqual(searchBm25(index, 'keyboard'));
  });

  it('honours topK', () => {
    expect(searchBm25(buildBm25Index(corpus), 'focus', 1)).toHaveLength(1);
  });

  it('agrees with the formula computed by hand', () => {
    const index = buildBm25Index(corpus);
    const [top] = searchBm25(index, 'keyboard');

    const { k1, b } = BM25_DEFAULTS;
    const docIndex = index.docIds.indexOf('a');
    const length = index.lengths[docIndex]!;
    const idf = Math.log(1 + (corpus.length - 1 + 0.5) / (1 + 0.5)); // df = 1
    const expected = (idf * (1 * (k1 + 1))) / (1 + k1 * (1 - b + (b * length) / index.avgdl));

    expect(top!.score).toBeCloseTo(expected, 10);
  });
});

describe('buildBm25Index', () => {
  it('records document lengths in tokens, compounds included', () => {
    const index = buildBm25Index([corpus[1]!]);
    expect(index.lengths[0]).toBe(tokenize(corpus[1]!.text).length);
    expect(index.avgdl).toBe(index.lengths[0]);
  });

  it('survives a JSON round trip, since it ships as a static asset', () => {
    const index = buildBm25Index(corpus);
    const shipped = JSON.parse(JSON.stringify(index)) as typeof index;
    expect(searchBm25(shipped, 'focus indicator')).toEqual(searchBm25(index, 'focus indicator'));
  });

  it('handles an empty corpus without dividing by zero', () => {
    const index = buildBm25Index([]);
    expect(index.avgdl).toBe(0);
    expect(searchBm25(index, 'focus')).toEqual([]);
  });
});
