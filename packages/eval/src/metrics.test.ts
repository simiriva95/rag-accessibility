import { describe, expect, it } from 'vitest';
import { mean, ndcgAt, recallAt, reciprocalRank, successAt } from './metrics.ts';

const relevant = (...ids: string[]) => new Set(ids);

describe('recallAt', () => {
  it('is the fraction of relevant chunks inside k', () => {
    expect(recallAt(['a', 'x', 'b', 'y'], relevant('a', 'b', 'c'), 4)).toBeCloseTo(2 / 3);
  });

  it('caps the denominator at k, so a wide annotation is not an automatic loss', () => {
    // 10 relevant chunks, k = 2, both hits relevant: the best possible result.
    const wide = relevant(...Array.from({ length: 10 }, (_, i) => `r${i}`));
    expect(recallAt(['r0', 'r1'], wide, 2)).toBe(1);
  });

  it('ignores anything past k', () => {
    expect(recallAt(['x', 'a'], relevant('a'), 1)).toBe(0);
  });

  it('treats a question with nothing relevant as satisfied', () => {
    expect(recallAt(['x'], relevant(), 5)).toBe(1);
  });
});

describe('successAt', () => {
  it('is one when anything relevant is inside k, zero otherwise', () => {
    expect(successAt(['x', 'a'], relevant('a'), 2)).toBe(1);
    expect(successAt(['x', 'a'], relevant('a'), 1)).toBe(0);
  });
});

describe('reciprocalRank', () => {
  it('is the reciprocal of the first relevant position', () => {
    expect(reciprocalRank(['a'], relevant('a'))).toBe(1);
    expect(reciprocalRank(['x', 'a'], relevant('a'))).toBe(0.5);
    expect(reciprocalRank(['x', 'y', 'a'], relevant('a'))).toBeCloseTo(1 / 3);
  });

  it('is zero when nothing relevant was retrieved', () => {
    expect(reciprocalRank(['x'], relevant('a'))).toBe(0);
  });
});

describe('ndcgAt', () => {
  const grades = new Map([
    ['a', 2],
    ['b', 1],
  ]);

  it('is one for the ideal ordering', () => {
    expect(ndcgAt(['a', 'b'], grades, 10)).toBeCloseTo(1, 12);
  });

  it('drops when the grades are ordered badly', () => {
    expect(ndcgAt(['b', 'a'], grades, 10)).toBeLessThan(1);
  });

  it('agrees with the formula computed by hand', () => {
    // gain = 2^g - 1; discount = log2(rank + 1). Ranked b(1) then a(2):
    //   DCG  = 1/log2(2) + 3/log2(3)
    //   IDCG = 3/log2(2) + 1/log2(3)
    const dcg = 1 / Math.log2(2) + 3 / Math.log2(3);
    const ideal = 3 / Math.log2(2) + 1 / Math.log2(3);
    expect(ndcgAt(['b', 'a'], grades, 10)).toBeCloseTo(dcg / ideal, 12);
  });

  it('puts a primary chunk well above a related one, not one step above', () => {
    const primaryFirst = ndcgAt(['a', 'z'], grades, 2);
    const relatedFirst = ndcgAt(['b', 'z'], grades, 2);
    expect(primaryFirst / relatedFirst).toBeGreaterThan(2);
  });

  it('scores an empty result zero and an unannotated question one', () => {
    expect(ndcgAt([], grades, 10)).toBe(0);
    expect(ndcgAt(['x'], new Map(), 10)).toBe(1);
  });
});

describe('mean', () => {
  it('averages, and does not divide by zero on an empty run', () => {
    expect(mean([1, 0, 0.5])).toBeCloseTo(0.5);
    expect(mean([])).toBe(0);
  });
});
