/**
 * Retrieval from the terminal. The week-1 deliverable: no UI, no generation,
 * just the three candidate lists and what fusion does to them.
 *
 *   node src/ask.ts "how much contrast does large text need"
 *
 * Works without Workers AI credentials — it reports BM25 only and says so,
 * rather than pretending the hybrid ran.
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  fuseRrf,
  searchBm25,
  searchDense,
  decodeDenseVectors,
  type Bm25Index,
  type Chunk,
  type Scored,
} from '@rag/core';
import { backendFromEnv, embedQuery } from './embed.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
const INDEX = join(ROOT, 'data/index');
const CANDIDATES = 30;

const query = process.argv.slice(2).join(' ').trim();
if (!query) {
  process.stderr.write('usage: node src/ask.ts "<question>"\n');
  process.exit(1);
}

try {
  process.loadEnvFile(join(ROOT, '.env'));
} catch {
  // No .env is fine; the variables may already be exported.
}

// Rebuilt from the two published halves; there is no combined file on disk.
const meta: Omit<Chunk, 'text'>[] = JSON.parse(await readFile(join(INDEX, 'chunks.meta.json'), 'utf8'));
const texts: Record<string, string> = JSON.parse(await readFile(join(INDEX, 'chunks.text.json'), 'utf8'));
const chunks: Chunk[] = meta.map((chunk) => ({ ...chunk, text: texts[chunk.id] ?? '' }));
const byId = new Map(chunks.map((c) => [c.id, c]));
const bm25: Bm25Index = JSON.parse(await readFile(join(INDEX, 'bm25.json'), 'utf8'));

const timed = async <T>(fn: () => T | Promise<T>): Promise<[T, number]> => {
  const started = performance.now();
  const value = await fn();
  return [value, performance.now() - started];
};

const [lexical, lexicalMs] = await timed(() => searchBm25(bm25, query, CANDIDATES));

let dense: Scored[] = [];
let denseMs = 0;
let denseNote = '';

try {
  const buffer = await readFile(join(INDEX, 'vectors.bin'));
  const vectors = decodeDenseVectors(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
  );
  const [embedded, embedMs] = await timed(() => embedQuery(query, backendFromEnv()));
  const [hits, scanMs] = await timed(() =>
    searchDense({ ...vectors, docIds: chunks.map((c) => c.id) }, embedded, CANDIDATES),
  );
  dense = hits;
  denseMs = embedMs + scanMs;
  denseNote = `${embedMs.toFixed(0)}ms embed + ${scanMs.toFixed(0)}ms scan`;
} catch (error) {
  denseNote = `unavailable — ${(error as Error).message.split('\n')[0]}`;
}

const [fused, fuseMs] = await timed(() =>
  fuseRrf(dense.length ? [dense, lexical] : [lexical], { topK: 10 }),
);

const label = (hit: Scored, rank: number) => {
  const chunk = byId.get(hit.chunkId)!;
  const heading = chunk.headingPath.at(-1) ?? chunk.docTitle;
  return `${String(rank + 1).padStart(2)}. ${hit.score.toFixed(3).padStart(7)}  ${chunk.docId}\n` +
    `                  ${heading.slice(0, 70)}`;
};

const section = (title: string, hits: Scored[], note: string) => {
  process.stdout.write(`\n── ${title} ${'─'.repeat(Math.max(0, 40 - title.length))} ${note}\n`);
  if (hits.length === 0) process.stdout.write('    (none)\n');
  for (const [rank, hit] of hits.slice(0, 5).entries()) process.stdout.write(label(hit, rank) + '\n');
};

process.stdout.write(`\nquery: ${query}\n`);
section('BM25', lexical, `${lexicalMs.toFixed(0)}ms`);
section('dense', dense, denseNote || `${denseMs.toFixed(0)}ms`);
section('fused (RRF)', fused, `${fuseMs.toFixed(1)}ms`);

if (dense.length === 0) {
  process.stdout.write('\nRetrieval-only, lexical half. Fusion has nothing to fuse.\n');
} else {
  const lexicalOnly = fused.filter((f) => !dense.some((d) => d.chunkId === f.chunkId)).length;
  const denseOnly = fused.filter((f) => !lexical.some((l) => l.chunkId === f.chunkId)).length;
  process.stdout.write(
    `\ntop 10 fused: ${lexicalOnly} reached only by BM25, ${denseOnly} only by dense\n`,
  );
}

const top = fused[0] && byId.get(fused[0].chunkId);
if (top) {
  process.stdout.write(`\n${'─'.repeat(72)}\n${top.headingPath.join(' > ')}\n${top.sourceUrl}\n\n`);
  process.stdout.write(top.text.slice(0, 600).replace(/\n{2,}/g, '\n') + '\n');
}
