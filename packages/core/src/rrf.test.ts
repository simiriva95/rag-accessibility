import { describe, expect, it } from 'vitest';
import { RRF_K, fuseRrf } from './rrf.ts';
import type { Scored } from './types.ts';

/** Only the order matters to RRF, so the scores here are arbitrary. */
const ranking = (...ids: string[]): Scored[] => ids.map((chunkId, i) => ({ chunkId, score: 100 - i }));

const ids = (fused: Scored[]) => fused.map((s) => s.chunkId);

describe('fuseRrf', () => {
  it('puts a document both retrievers found above one only a single retriever ranked first', () => {
    const fused = fuseRrf([ranking('a', 'both'), ranking('b', 'both')]);
    expect(ids(fused)[0]).toBe('both');
  });

  it('preserves the order of a single ranking', () => {
    expect(ids(fuseRrf([ranking('a', 'b', 'c')]))).toEqual(['a', 'b', 'c']);
  });

  it('ignores the magnitude of the incoming scores', () => {
    const huge = [
      { chunkId: 'x', score: 1e6 },
      { chunkId: 'y', score: 0.0001 },
    ];
    const small = [
      { chunkId: 'x', score: 0.2 },
      { chunkId: 'y', score: 0.1 },
    ];
    expect(fuseRrf([huge])).toEqual(fuseRrf([small]));
  });

  it('dampens the top of each list, so rank 1 does not run away with it', () => {
    // 'solo' is first in one list; 'shared' is second in both. Agreement wins.
    const fused = fuseRrf([ranking('solo', 'shared'), ranking('other', 'shared')]);
    expect(ids(fused)[0]).toBe('shared');
  });

  it('lets a large k flatten the difference between adjacent ranks', () => {
    const [first, second] = fuseRrf([ranking('a', 'b')], { k: 10_000 });
    expect(second!.score / first!.score).toBeGreaterThan(0.999);
  });

  it('computes the documented score', () => {
    const [top] = fuseRrf([ranking('a'), ranking('a')]);
    expect(top!.score).toBeCloseTo(2 / (RRF_K + 1), 12);
  });

  it('breaks a genuine tie by id, so a run is reproducible', () => {
    // Both documents sit at rank 1 of their own list: the scores are equal.
    expect(ids(fuseRrf([ranking('b'), ranking('a')]))).toEqual(['a', 'b']);
    expect(ids(fuseRrf([ranking('a'), ranking('b')]))).toEqual(['a', 'b']);
  });

  it('honours topK and tolerates empty or missing rankings', () => {
    expect(fuseRrf([ranking('a', 'b', 'c')], { topK: 2 })).toHaveLength(2);
    expect(fuseRrf([])).toEqual([]);
    expect(ids(fuseRrf([[], ranking('a')]))).toEqual(['a']);
  });
});
