import type { Scored } from './types.ts';

/**
 * Dense retrieval over an int8-quantized vector index.
 *
 * At this corpus size an ANN index is premature: a linear scan of ~1600
 * vectors is ~600k multiply-adds, which is a couple of milliseconds in a Web
 * Worker. ANN would trade recall for a speedup nobody can perceive.
 *
 * Quantization: vectors are L2-normalized, then each is scaled by its own
 * largest component before being rounded to int8. A per-vector scale rather
 * than a global one, because the components of a unit vector in 384 dimensions
 * cluster well inside [-1, 1] and a global scale would throw away most of the
 * range. Cost is 4 bytes per vector; the index still lands around a quarter of
 * its float32 size.
 */

export const DENSE_MAGIC = 0x52414756; // "RAGV"

/** Vectors as shipped: ids come from chunks.meta.json, which is in the same order. */
export type DenseVectors = {
  dims: number;
  /** Per-vector dequantization scale. */
  scales: Float32Array;
  /** count * dims int8 components, row-major. */
  codes: Int8Array;
};

export type DenseIndex = DenseVectors & { docIds: readonly string[] };

export function l2Normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const v of vector) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vector;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = vector[i]! / norm;
  return out;
}

export function quantize(vectors: readonly Float32Array[], dims: number): DenseVectors {
  const scales = new Float32Array(vectors.length);
  const codes = new Int8Array(vectors.length * dims);

  for (const [row, raw] of vectors.entries()) {
    if (raw.length !== dims) throw new Error(`vector ${row} has ${raw.length} dims, expected ${dims}`);
    const vector = l2Normalize(raw);

    let peak = 0;
    for (const v of vector) peak = Math.max(peak, Math.abs(v));

    scales[row] = peak / 127;
    const offset = row * dims;
    for (let i = 0; i < dims; i++) {
      codes[offset + i] = peak === 0 ? 0 : Math.round((vector[i]! / peak) * 127);
    }
  }

  return { dims, scales, codes };
}

/**
 * Cosine similarity against every vector.
 *
 * The query stays in float32 — there is one of it, and keeping it exact costs
 * nothing. Each document's dot product is scaled by its own factor, which is
 * what makes the ranking comparable across vectors quantized differently.
 */
export function searchDense(index: DenseIndex, query: Float32Array, topK = 30): Scored[] {
  const { dims, scales, codes, docIds } = index;
  if (query.length !== dims) throw new Error(`query has ${query.length} dims, expected ${dims}`);

  const unit = l2Normalize(query);
  const scored: Scored[] = [];

  for (let row = 0; row < docIds.length; row++) {
    const offset = row * dims;
    let dot = 0;
    for (let i = 0; i < dims; i++) dot += unit[i]! * codes[offset + i]!;
    scored.push({ chunkId: docIds[row]!, score: dot * scales[row]! });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, topK);
}

/**
 * One binary blob rather than JSON: 1600 x 384 int8 is 600 KB raw and about
 * 1.6 MB as a JSON array of numbers.
 *
 * Layout: magic u32 | count u32 | dims u32 | scales f32[count] | codes i8[count*dims]
 */
export function encodeDenseVectors(vectors: DenseVectors): ArrayBuffer {
  const count = vectors.scales.length;
  const header = 12;
  const buffer = new ArrayBuffer(header + count * 4 + count * vectors.dims);

  const view = new DataView(buffer);
  view.setUint32(0, DENSE_MAGIC, true);
  view.setUint32(4, count, true);
  view.setUint32(8, vectors.dims, true);

  new Float32Array(buffer, header, count).set(vectors.scales);
  new Int8Array(buffer, header + count * 4).set(vectors.codes);
  return buffer;
}

export function decodeDenseVectors(buffer: ArrayBuffer): DenseVectors {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== DENSE_MAGIC) throw new Error('not a dense vector index');

  const count = view.getUint32(4, true);
  const dims = view.getUint32(8, true);
  const header = 12;

  return {
    dims,
    // Copied rather than viewed: a Float32Array view needs 4-byte alignment,
    // which a slice of a fetched buffer does not always have.
    scales: new Float32Array(buffer.slice(header, header + count * 4)),
    codes: new Int8Array(buffer.slice(header + count * 4)),
  };
}
