import { describe, expect, it } from 'vitest';
import {
  decodeDenseVectors,
  encodeDenseVectors,
  l2Normalize,
  quantize,
  searchDense,
  type DenseIndex,
} from './dense.ts';

const DIMS = 384;

/** Deterministic pseudo-random vectors, so a failure is reproducible. */
function randomVectors(count: number, dims = DIMS, seed = 1): Float32Array[] {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648 - 0.5;
  };
  return Array.from({ length: count }, () => Float32Array.from({ length: dims }, next));
}

const indexOf = (vectors: Float32Array[]): DenseIndex => ({
  ...quantize(vectors, DIMS),
  docIds: vectors.map((_, i) => `c${i}`),
});

/** Exact cosine, to measure the quantized ranking against. */
function cosine(a: Float32Array, b: Float32Array): number {
  const [x, y] = [l2Normalize(a), l2Normalize(b)];
  let dot = 0;
  for (let i = 0; i < x.length; i++) dot += x[i]! * y[i]!;
  return dot;
}

describe('l2Normalize', () => {
  it('produces a unit vector', () => {
    const unit = l2Normalize(Float32Array.from([3, 4]));
    expect(Math.hypot(...unit)).toBeCloseTo(1, 6);
  });

  it('leaves a zero vector alone rather than dividing by zero', () => {
    expect([...l2Normalize(new Float32Array(4))]).toEqual([0, 0, 0, 0]);
  });
});

describe('searchDense', () => {
  it('ranks a vector against itself first, at a similarity near 1', () => {
    const vectors = randomVectors(50);
    const [top] = searchDense(indexOf(vectors), vectors[7]!, 1);
    expect(top!.chunkId).toBe('c7');
    expect(top!.score).toBeCloseTo(1, 2);
  });

  it('keeps the ranking the float vectors would have given', () => {
    const vectors = randomVectors(200);
    const query = randomVectors(1, DIMS, 99)[0]!;

    const exact = vectors
      .map((v, i) => ({ chunkId: `c${i}`, score: cosine(query, v) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map((s) => s.chunkId);
    const quantized = searchDense(indexOf(vectors), query, 10).map((s) => s.chunkId);

    // int8 costs a little precision; losing more than one of the top 10 would
    // mean the quantization, not the retriever, is deciding the results.
    const kept = quantized.filter((id) => exact.includes(id)).length;
    expect(kept).toBeGreaterThanOrEqual(9);
    expect(quantized[0]).toBe(exact[0]);
  });

  it('stays close to the exact cosine value', () => {
    const vectors = randomVectors(20);
    const query = vectors[3]!;
    const scored = searchDense(indexOf(vectors), query, 20);

    for (const hit of scored) {
      const exact = cosine(query, vectors[Number(hit.chunkId.slice(1))]!);
      expect(hit.score).toBeCloseTo(exact, 2);
    }
  });

  it('honours topK and rejects a query of the wrong width', () => {
    const index = indexOf(randomVectors(10));
    expect(searchDense(index, randomVectors(1)[0]!, 3)).toHaveLength(3);
    expect(() => searchDense(index, new Float32Array(10))).toThrow(/dims/);
  });

  it('returns nothing for an empty index', () => {
    const index: DenseIndex = { ...quantize([], DIMS), docIds: [] };
    expect(searchDense(index, randomVectors(1)[0]!)).toEqual([]);
  });
});

describe('the binary format', () => {
  it('survives an encode/decode round trip', () => {
    const vectors = quantize(randomVectors(64), DIMS);
    const decoded = decodeDenseVectors(encodeDenseVectors(vectors));

    expect(decoded.dims).toBe(DIMS);
    expect([...decoded.scales]).toEqual([...vectors.scales]);
    expect([...decoded.codes]).toEqual([...vectors.codes]);
  });

  it('decodes correctly from an unaligned buffer, as a fetch may deliver one', () => {
    const encoded = encodeDenseVectors(quantize(randomVectors(8), DIMS));
    const shifted = new Uint8Array(encoded.byteLength + 1);
    shifted.set(new Uint8Array(encoded), 1);

    const decoded = decodeDenseVectors(shifted.buffer.slice(1));
    expect(decoded.scales).toHaveLength(8);
  });

  it('rejects a buffer that is not an index', () => {
    expect(() => decodeDenseVectors(new ArrayBuffer(16))).toThrow(/not a dense vector index/);
  });

  it('is about a quarter the size of float32', () => {
    const count = 1600;
    const bytes = encodeDenseVectors(quantize(randomVectors(count), DIMS)).byteLength;
    expect(bytes).toBeLessThan(count * DIMS * 4 * 0.3);
  });
});
