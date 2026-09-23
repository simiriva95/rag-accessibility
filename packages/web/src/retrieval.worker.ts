import {
  decodeDenseVectors,
  fuseRrf,
  searchBm25,
  searchDense,
  type Bm25Index,
  type Chunk,
  type DenseVectors,
  type Scored,
} from '@rag/core';

/**
 * Candidate retrieval, off the main thread.
 *
 * Scanning 1600 vectors is a few milliseconds, but the index arrives as a
 * megabyte of JSON and parsing that on the main thread drops frames on a phone.
 * The work moves here; the results come back as plain ids and scores.
 *
 * The worker does no network. The query vector is computed at the edge and
 * handed in, which keeps this a pure function of its inputs — and keeps the
 * lexical half working unchanged when the edge is unavailable.
 */

export type ChunkMeta = Omit<Chunk, 'text'>;

export type WorkerRequest =
  | { type: 'load'; base: string }
  | { type: 'search'; id: number; query: string; vector?: number[]; candidates?: number };

export type Stage = { name: 'dense' | 'lexical' | 'fused'; hits: Scored[]; ms: number };

export type WorkerResponse =
  | { type: 'ready'; chunks: number; hasVectors: boolean; ms: number }
  | { type: 'results'; id: number; stages: Stage[]; denseSkipped?: string }
  | { type: 'error'; message: string };

/**
 * The worker's own globals, declared rather than pulled in from the WebWorker
 * lib: that lib and the DOM lib both define `self` and cannot be loaded
 * together, and these two members are all this file uses.
 */
declare const self: {
  postMessage(message: WorkerResponse): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

const post = (message: WorkerResponse) => self.postMessage(message);

let meta: ChunkMeta[] = [];
let bm25: Bm25Index | undefined;
let vectors: DenseVectors | undefined;
let docIds: string[] = [];

async function json<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} for ${url}`);
  return (await response.json()) as T;
}

async function load(base: string): Promise<void> {
  const started = performance.now();

  // Metadata and the lexical index are both required; the vectors are not.
  // Without them the app runs on BM25 alone and says so, rather than refusing
  // to start because one asset is missing.
  const [loadedMeta, loadedBm25] = await Promise.all([
    json<ChunkMeta[]>(`${base}/index/chunks.meta.json`),
    json<Bm25Index>(`${base}/index/bm25.json`),
  ]);

  meta = loadedMeta;
  bm25 = loadedBm25;
  docIds = meta.map((chunk) => chunk.id);

  try {
    const response = await fetch(`${base}/index/vectors.bin`);
    if (response.ok) {
      const decoded = decodeDenseVectors(await response.arrayBuffer());
      // A vector file that does not match the chunk list would silently pair
      // every query with the wrong document. Better to run without it.
      if (decoded.scales.length !== meta.length) {
        throw new Error(`vectors.bin holds ${decoded.scales.length} rows for ${meta.length} chunks`);
      }
      vectors = decoded;
    }
  } catch (error) {
    console.warn('dense index unavailable:', (error as Error).message);
  }

  post({ type: 'ready', chunks: meta.length, hasVectors: vectors !== undefined, ms: performance.now() - started });
}

function search(request: Extract<WorkerRequest, { type: 'search' }>): void {
  if (!bm25) throw new Error('index not loaded');
  const topK = request.candidates ?? 30;

  const stages: Stage[] = [];

  const lexicalStart = performance.now();
  const lexical = searchBm25(bm25, request.query, topK);
  stages.push({ name: 'lexical', hits: lexical, ms: performance.now() - lexicalStart });

  let dense: Scored[] = [];
  let denseSkipped: string | undefined;

  if (!vectors) denseSkipped = 'no vector index';
  else if (!request.vector) denseSkipped = 'no query embedding';
  else {
    const denseStart = performance.now();
    dense = searchDense({ ...vectors, docIds }, Float32Array.from(request.vector), topK);
    stages.push({ name: 'dense', hits: dense, ms: performance.now() - denseStart });
  }

  const fuseStart = performance.now();
  const fused = fuseRrf(dense.length > 0 ? [dense, lexical] : [lexical], { topK });
  stages.push({ name: 'fused', hits: fused, ms: performance.now() - fuseStart });

  post({ type: 'results', id: request.id, stages, ...(denseSkipped ? { denseSkipped } : {}) });
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  try {
    if (event.data.type === 'load') await load(event.data.base);
    else search(event.data);
  } catch (error) {
    post({ type: 'error', message: (error as Error).message });
  }
};
