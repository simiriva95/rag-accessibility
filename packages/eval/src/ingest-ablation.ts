import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import {
  buildBm25Index,
  fuseRrf,
  l2Normalize,
  quantize,
  searchBm25,
  searchDense,
  type Bm25Index,
  type Chunk,
  type NormalizedDoc,
  type Scored,
} from '@rag/core';
import { chunkDocument, estimateTokens, scRefOf, type ChunkOptions } from '@rag/ingest/chunk';
import { QUERY_PREFIX, documentText } from '@rag/ingest/embed';
import { GOLDEN, type GoldAnchor } from './golden.ts';
import { mean, ndcgAt, recallAt, reciprocalRank, successAt } from './metrics.ts';
import { matches } from './resolve.ts';

/**
 * The ingest ablation: what each choice made at build time is worth.
 *
 * The retrieval ablation (harness.ts) holds the index fixed and varies the
 * retriever. This holds the retriever fixed and varies how the index was
 * built: the chunker, what text is embedded, how vectors are stored, how BM25
 * tokenizes and weighs, how fusion is damped. Every row is scored on the same
 * 60-question golden set, resolved afresh against each variant's chunks —
 * the annotation is anchored to documents and headings, not chunk ids, which
 * is what makes a chunking comparison possible at all.
 *
 * Two encoders, and the table says which produced each row:
 *
 *  - production: the Workers AI vectors the site ships, cached from the
 *    ingest. Used where the chunks are the shipped ones, so those rows are the
 *    deployed system's own numbers.
 *  - local: the same model, bge-small-en-v1.5, run in ONNX on this machine.
 *    A new chunking produces new chunks, and embedding three corpora through
 *    the free tier would spend the quota the live site needs. The local
 *    encoder is calibrated against production below, and every variant it
 *    scores is scored with it — including the baseline — so the comparison is
 *    like with like.
 *
 * Run: pnpm --filter @rag/eval ingest-ablation
 */

const ROOT = resolvePath(import.meta.dirname, '../../..');
const CORPUS = join(ROOT, 'data/corpus');
const CACHE = join(ROOT, '.cache');
const OUT_JSON = join(ROOT, 'packages/web/src/ingest-ablation.json');
const OUT_MD = join(ROOT, 'docs/INGEST-ABLATION.md');
const CANDIDATES = 30;

// ── corpus ──────────────────────────────────────────────────────────────────

async function loadDocs(): Promise<NormalizedDoc[]> {
  const manifest = JSON.parse(await readFile(join(CORPUS, 'manifest.json'), 'utf8')) as {
    docId: string;
    docTitle: string;
    sourceUrl: string;
  }[];
  return Promise.all(
    manifest.map(async (entry) => ({ ...entry, text: await readFile(join(CORPUS, `${entry.docId}.txt`), 'utf8') })),
  );
}

// ── chunkers ────────────────────────────────────────────────────────────────

/**
 * The naive baseline: fixed windows of characters, blind to structure.
 *
 * Windows are snapped back to the nearest whitespace so no word is cut, and
 * carry the heading path in force where they start, so they are embedded and
 * annotated on the same terms as the structure-aware chunks. That is the
 * fairest version of the baseline: it loses only what ignoring structure
 * loses.
 */
function fixedWindows(doc: NormalizedDoc, targetTokens = 400, overlapRatio = 0.15): Chunk[] {
  const size = Math.floor(targetTokens * 3.5);
  const step = Math.floor(size * (1 - overlapRatio));
  const text = doc.text;

  // Heading in force at each offset, rebuilt from the markdown-lite headings.
  const headings: { at: number; level: number; text: string }[] = [];
  for (const match of text.matchAll(/^(#{1,6}) (.+)$/gm)) {
    headings.push({ at: match.index!, level: match[1]!.length, text: match[2]! });
  }
  const pathAt = (offset: number) => {
    const stack: { level: number; text: string }[] = [];
    for (const heading of headings) {
      if (heading.at > offset) break;
      while (stack.length && stack.at(-1)!.level >= heading.level) stack.pop();
      stack.push(heading);
    }
    return stack.map((h) => h.text);
  };

  const chunks: Chunk[] = [];
  for (let start = 0; start < text.length; start += step) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const space = text.lastIndexOf(' ', end);
      if (space > start + size / 2) end = space;
    }
    let from = start;
    if (from > 0) {
      const space = text.indexOf(' ', from);
      if (space !== -1 && space < from + 40) from = space + 1;
    }
    const slice = text.slice(from, end);
    if (slice.trim() === '') continue;
    const headingPath = pathAt(from);
    const scRef = scRefOf(headingPath);
    chunks.push({
      id: createHash('sha256').update(`${doc.docId}\n${from}\n${slice}`).digest('hex').slice(0, 16),
      docId: doc.docId,
      docTitle: doc.docTitle,
      sourceUrl: doc.sourceUrl,
      headingPath,
      ...(scRef !== undefined ? { scRef } : {}),
      text: slice,
      charStart: from,
      charEnd: end,
      tokenCount: estimateTokens(slice),
    });
    if (end >= text.length) break;
  }
  return chunks;
}

type Chunker = { id: string; name: string; description: string; run: (doc: NormalizedDoc) => Chunk[] };

const structure = (options: ChunkOptions) => (doc: NormalizedDoc) => chunkDocument(doc, options);

const CHUNKERS: Chunker[] = [
  {
    id: 'structure',
    name: 'Structure-aware, 400 tokens, 15% overlap',
    description: 'The shipped chunker: blocks and headings respected, a section opens a new chunk once the current one is worth retrieving.',
    run: structure({}),
  },
  {
    id: 'structure-no-overlap',
    name: 'Structure-aware, no overlap',
    description: 'The same chunker with the overlap removed.',
    run: structure({ overlapRatio: 0 }),
  },
  {
    id: 'structure-small',
    name: 'Structure-aware, 200 tokens',
    description: 'Half the target size: more, narrower chunks.',
    run: structure({ targetTokens: 200, minTokens: 120, maxTokens: 240 }),
  },
  {
    id: 'fixed',
    name: 'Fixed windows, 400 tokens, 15% overlap',
    description: 'The naive baseline: character windows blind to headings and blocks.',
    run: (doc) => fixedWindows(doc),
  },
];

/** How a chunking treats the text's own boundaries. */
function chunkStats(chunks: Chunk[], docs: Map<string, NormalizedDoc>) {
  const tokens = chunks.map((c) => c.tokenCount).sort((a, b) => a - b);
  const q = (p: number) => tokens[Math.min(tokens.length - 1, Math.floor(p * tokens.length))]!;
  const invariant = chunks.filter((c) => docs.get(c.docId)!.text.slice(c.charStart, c.charEnd) === c.text).length;
  // A chunk that ends mid-sentence splits a claim from its own evidence.
  const cleanEnd = chunks.filter((c) => /[.!?:;)"'”’\]]\s*$|\n\s*$/.test(c.text) || c.charEnd === docs.get(c.docId)!.text.length).length;
  // A chunk that starts on a heading or a block boundary reads as a unit.
  const cleanStart = chunks.filter((c) => c.charStart === 0 || docs.get(c.docId)!.text[c.charStart - 1] === '\n').length;
  return {
    chunks: chunks.length,
    medianTokens: q(0.5),
    p10Tokens: q(0.1),
    p90Tokens: q(0.9),
    offsetsExact: invariant / chunks.length,
    cleanEnds: cleanEnd / chunks.length,
    cleanStarts: cleanStart / chunks.length,
    withScRef: chunks.filter((c) => c.scRef !== undefined).length / chunks.length,
  };
}

// ── golden set, resolved per variant ────────────────────────────────────────

type Question = {
  question: string;
  kind: string;
  primary: Set<string>;
  grades: Map<string, number>;
};

function resolveFor(chunks: Chunk[]): { questions: Question[]; unresolved: number } {
  let unresolved = 0;
  const ids = (anchors: readonly GoldAnchor[]) => {
    const out = new Set<string>();
    for (const anchor of anchors) for (const chunk of chunks) if (matches(chunk, anchor)) out.add(chunk.id);
    return out;
  };
  const questions = GOLDEN.filter((q) => q.kind !== 'refusal').map((q) => {
    const primary = ids(q.primary);
    if (primary.size === 0) unresolved++;
    const related = ids(q.related ?? q.primary.map(({ docId }) => ({ docId })));
    const grades = new Map<string, number>();
    for (const id of related) grades.set(id, 1);
    for (const id of primary) grades.set(id, 2);
    return { question: q.question, kind: q.kind, primary, grades };
  });
  return { questions, unresolved };
}

type Scores = {
  recall10: number;
  success5: number;
  mrr: number;
  ndcg10: number;
  identifier: number;
  conceptual: number;
  /** 95% bootstrap intervals over questions. 53 questions is a small sample, and the table should say how small. */
  recall10Ci: [number, number];
  success5Ci: [number, number];
};

/**
 * Percentile bootstrap over questions, seeded so reruns print the same
 * intervals. 2,000 resamples of 53 is milliseconds.
 */
function bootstrap(values: number[], resamples = 2000): [number, number] {
  let seed = 0x9e3779b9;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[Math.floor(random() * values.length)]!;
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(0.025 * resamples)]!, means[Math.floor(0.975 * resamples)]!];
}

function scoreRuns(questions: Question[], rank: (q: Question) => string[]): Scores {
  const ranked = questions.map((q) => ({ q, ids: rank(q) }));
  const kind = (k: string) =>
    mean(ranked.filter((r) => r.q.kind === k).map((r) => recallAt(r.ids, r.q.primary, 10)));
  const recall = ranked.map((r) => recallAt(r.ids, r.q.primary, 10));
  const success = ranked.map((r) => successAt(r.ids, r.q.primary, 5));
  return {
    recall10Ci: bootstrap(recall),
    success5Ci: bootstrap(success),
    recall10: mean(recall),
    success5: mean(success),
    mrr: mean(ranked.map((r) => reciprocalRank(r.ids, r.q.primary))),
    ndcg10: mean(ranked.map((r) => ndcgAt(r.ids, r.q.grades, 10))),
    identifier: kind('identifier'),
    conceptual: kind('conceptual'),
  };
}

const ids = (hits: Scored[]) => hits.map((hit) => hit.chunkId);

// ── encoders ────────────────────────────────────────────────────────────────

type Encode = (texts: string[]) => Promise<Float32Array[]>;

/** The local encoder, with an on-disk cache keyed by the exact text embedded. */
async function localEncoder(): Promise<{ encode: Encode; save: () => Promise<void> }> {
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = join(CACHE, 'models');
  const extractor = await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5', { dtype: 'fp32' });

  const file = join(CACHE, 'raw/local-embeddings.json');
  const cache: Record<string, number[]> = await readFile(file, 'utf8')
    .then((json) => JSON.parse(json) as Record<string, number[]>)
    .catch(() => ({}));
  const key = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 24);

  const encode: Encode = async (texts) => {
    const missing = [...new Set(texts.filter((t) => cache[key(t)] === undefined))];
    for (let i = 0; i < missing.length; i += 16) {
      const batch = missing.slice(i, i + 16);
      // bge pools on [CLS]; texts past the 512-token window are truncated, as Workers AI does.
      const output = await extractor(batch, { pooling: 'cls', normalize: true });
      const dims = output.dims.at(-1)!;
      for (const [j, text] of batch.entries()) {
        cache[key(text)] = Array.from(output.data.slice(j * dims, (j + 1) * dims) as Float32Array);
      }
      process.stderr.write(`  encoded ${Math.min(i + 16, missing.length)}/${missing.length}\r`);
    }
    if (missing.length > 0) process.stderr.write('\n');
    return texts.map((t) => Float32Array.from(cache[key(t)]!));
  };

  return {
    encode,
    save: async () => {
      await mkdir(join(CACHE, 'raw'), { recursive: true });
      await writeFile(file, JSON.stringify(cache));
    },
  };
}

const cosine = (a: Float32Array, b: Float32Array) => {
  const x = l2Normalize(a);
  const y = l2Normalize(b);
  let dot = 0;
  for (let i = 0; i < x.length; i++) dot += x[i]! * y[i]!;
  return dot;
};

/** Dense search over float32 vectors, for the rows that compare against int8. */
function searchFloat(vectors: Float32Array[], docIds: string[], query: Float32Array, k: number): Scored[] {
  const unit = l2Normalize(query);
  const normed = vectors.map(l2Normalize);
  return normed
    .map((v, row) => {
      let dot = 0;
      for (let i = 0; i < v.length; i++) dot += v[i]! * unit[i]!;
      return { chunkId: docIds[row]!, score: dot };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

const int8Index = (vectors: Float32Array[], docIds: string[]) => ({ ...quantize(vectors, 384), docIds });

// ── a lexical tokenizer without compound handling, for the tokenizer row ────

function buildPlainBm25(chunks: Chunk[]): { search: (q: string, k: number) => Scored[] } {
  const plain = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  // Rebuilt through the real index code, by feeding it pre-split text: the
  // shipped tokenizer leaves single alphanumeric runs unchanged.
  const index = buildBm25Index(chunks.map((c) => ({ id: c.id, text: plain(documentText(c)).join(' ') })));
  return { search: (q, k) => searchBm25(index, plain(q).join(' '), k) };
}

// ── the run ─────────────────────────────────────────────────────────────────

type Row = { id: string; name: string; group: string; encoder: 'production' | 'local' | 'none'; note?: string } & Scores;

async function main() {
  const docs = await loadDocs();
  const byDoc = new Map(docs.map((doc) => [doc.docId, doc]));
  const { encode, save } = await localEncoder();
  const rows: Row[] = [];
  const chunking: (ReturnType<typeof chunkStats> & { id: string; name: string; description: string; unresolved: number })[] = [];

  const goldenQueries = GOLDEN.filter((q) => q.kind !== 'refusal').map((q) => q.question);
  const localQueries = new Map(
    (await encode(goldenQueries.map((q) => QUERY_PREFIX + q))).map((v, i) => [goldenQueries[i]!, v]),
  );
  const localQueriesBare = new Map((await encode(goldenQueries)).map((v, i) => [goldenQueries[i]!, v]));

  // ── chunking variants, local encoder throughout ──
  let baseline: { chunks: Chunk[]; questions: Question[]; bm25: Bm25Index } | undefined;
  for (const chunker of CHUNKERS) {
    process.stderr.write(`${chunker.id}\n`);
    const chunks = docs.flatMap(chunker.run);
    const { questions, unresolved } = resolveFor(chunks);
    chunking.push({ id: chunker.id, name: chunker.name, description: chunker.description, unresolved, ...chunkStats(chunks, byDoc) });

    const bm25 = buildBm25Index(chunks.map((c) => ({ id: c.id, text: documentText(c) })));
    const vectors = await encode(chunks.map(documentText));
    const docIds = chunks.map((c) => c.id);
    const index = int8Index(vectors, docIds);

    const lexical = (q: Question) => ids(searchBm25(bm25, q.question, CANDIDATES));
    const dense = (q: Question) => ids(searchDense(index, localQueries.get(q.question)!, CANDIDATES));
    const hybrid = (q: Question) =>
      ids(
        fuseRrf([searchDense(index, localQueries.get(q.question)!, CANDIDATES), searchBm25(bm25, q.question, CANDIDATES)], {
          topK: CANDIDATES,
        }),
      );

    rows.push({ id: `${chunker.id}:bm25`, name: `${chunker.name}, BM25`, group: 'chunking', encoder: 'none', ...scoreRuns(questions, lexical) });
    rows.push({ id: `${chunker.id}:dense`, name: `${chunker.name}, dense`, group: 'chunking', encoder: 'local', ...scoreRuns(questions, dense) });
    rows.push({ id: `${chunker.id}:hybrid`, name: `${chunker.name}, hybrid`, group: 'chunking', encoder: 'local', ...scoreRuns(questions, hybrid) });

    if (chunker.id === 'structure') {
      baseline = { chunks, questions, bm25 };

      // What goes into the embedded text: the heading path, or the chunk alone.
      const bare = int8Index(await encode(chunks.map((c) => c.text)), docIds);
      rows.push({
        id: 'embed:no-heading',
        name: 'Dense, chunk text only',
        group: 'header',
        encoder: 'local',
        ...scoreRuns(questions, (q) => ids(searchDense(bare, localQueries.get(q.question)!, CANDIDATES))),
      });
      rows.push({ id: 'embed:heading', name: 'Dense, heading path + chunk text (shipped)', group: 'header', encoder: 'local', ...scoreRuns(questions, dense) });
      const bareBm25 = buildBm25Index(chunks.map((c) => ({ id: c.id, text: c.text })));
      rows.push({
        id: 'bm25:no-heading',
        name: 'BM25, chunk text only',
        group: 'header',
        encoder: 'none',
        ...scoreRuns(questions, (q) => ids(searchBm25(bareBm25, q.question, CANDIDATES))),
      });
      rows.push({ id: 'bm25:heading', name: 'BM25, heading path + chunk text (shipped)', group: 'header', encoder: 'none', ...scoreRuns(questions, lexical) });

      // The asymmetric instruction prefix, on the query side.
      rows.push({
        id: 'query:no-prefix',
        name: 'Query without the instruction prefix',
        group: 'query',
        encoder: 'local',
        ...scoreRuns(questions, (q) => ids(searchDense(index, localQueriesBare.get(q.question)!, CANDIDATES))),
      });
      rows.push({ id: 'query:prefix', name: 'Query with the instruction prefix (shipped)', group: 'query', encoder: 'local', ...scoreRuns(questions, dense) });
    }
  }
  await save();
  if (!baseline) throw new Error('the structure-aware chunker did not run');
  const { chunks, questions, bm25 } = baseline;
  const docIds = chunks.map((c) => c.id);

  // ── production vectors: calibration, and float32 against int8 ──
  const prodDocs: Record<string, number[]> = JSON.parse(await readFile(join(CACHE, 'raw/embeddings.json'), 'utf8'));
  const prodQueries: Record<string, number[]> = JSON.parse(await readFile(join(CACHE, 'raw/query-embeddings.json'), 'utf8'));
  const prodVectors = chunks.map((c) => Float32Array.from(prodDocs[c.id]!));
  const prodQuery = (q: string) => Float32Array.from(prodQueries[q]!);

  const localVectors = await encode(chunks.map(documentText));
  const agreement = mean(prodVectors.map((v, i) => cosine(v, localVectors[i]!)));

  const prodInt8 = int8Index(prodVectors, docIds);
  const floatRank = (q: Question) => ids(searchFloat(prodVectors, docIds, prodQuery(q.question), CANDIDATES));
  const int8Rank = (q: Question) => ids(searchDense(prodInt8, prodQuery(q.question), CANDIDATES));
  rows.push({ id: 'store:float32', name: 'float32 vectors, 2.4 MB', group: 'storage', encoder: 'production', ...scoreRuns(questions, floatRank) });
  rows.push({ id: 'store:int8', name: 'int8 vectors, 0.6 MB (shipped)', group: 'storage', encoder: 'production', ...scoreRuns(questions, int8Rank) });
  const top10Same = mean(
    questions.map((q) => {
      const a = new Set(floatRank(q).slice(0, 10));
      return int8Rank(q).slice(0, 10).filter((id) => a.has(id)).length / 10;
    }),
  );

  // ── lexical choices ──
  const plain = buildPlainBm25(chunks);
  rows.push({
    id: 'tokenizer:plain',
    name: 'Plain tokenizer: alphanumeric runs, 2.4.11 split into 2, 4, 11',
    group: 'tokenizer',
    encoder: 'none',
    ...scoreRuns(questions, (q) => ids(plain.search(q.question, CANDIDATES))),
  });
  rows.push({
    id: 'tokenizer:shipped',
    name: 'Shipped tokenizer: compounds whole and split, dotted numbers whole',
    group: 'tokenizer',
    encoder: 'none',
    ...scoreRuns(questions, (q) => ids(searchBm25(bm25, q.question, CANDIDATES))),
  });

  for (const [k1, b] of [[1.2, 0], [1.2, 0.75], [1.2, 1], [0.6, 0.75], [2.0, 0.75]] as const) {
    const index = { ...bm25, params: { k1, b } };
    rows.push({
      id: `bm25:k1=${k1},b=${b}`,
      name: `BM25 k1 = ${k1}, b = ${b}${k1 === 1.2 && b === 0.75 ? ' (shipped)' : ''}`,
      group: 'bm25',
      encoder: 'none',
      ...scoreRuns(questions, (q) => ids(searchBm25(index, q.question, CANDIDATES))),
    });
  }

  for (const k of [1, 10, 60, 200]) {
    rows.push({
      id: `rrf:k=${k}`,
      name: `RRF k = ${k}${k === 60 ? ' (shipped)' : ''}`,
      group: 'fusion',
      encoder: 'production',
      ...scoreRuns(questions, (q) =>
        ids(fuseRrf([searchDense(prodInt8, prodQuery(q.question), CANDIDATES), searchBm25(bm25, q.question, CANDIDATES)], { k, topK: CANDIDATES })),
      ),
    });
  }

  const result = {
    generated: new Date().toISOString().slice(0, 10),
    questions: questions.length,
    calibration: { meanCosineLocalVsProduction: agreement, int8Top10Agreement: top10Same },
    chunking,
    rows,
  };
  await writeFile(OUT_JSON, JSON.stringify(result, null, 2) + '\n');
  await writeFile(OUT_MD, markdown(result));
  process.stdout.write(markdown(result));
}

function markdown(result: {
  generated: string;
  questions: number;
  calibration: { meanCosineLocalVsProduction: number; int8Top10Agreement: number };
  chunking: (ReturnType<typeof chunkStats> & { name: string; unresolved: number })[];
  rows: Row[];
}): string {
  const pct = (n: number) => `${(100 * n).toFixed(1)}%`;
  const ci = ([lo, hi]: [number, number]) => `${(100 * lo).toFixed(0)}–${(100 * hi).toFixed(0)}`;
  const groups = [...new Set(result.rows.map((r) => r.group))];
  const lines = [
    '# Ingest ablation',
    '',
    `Generated by \`packages/eval/src/ingest-ablation.ts\` on ${result.generated}, over the ${result.questions} answerable golden questions, resolved afresh against each variant's chunks.`,
    '',
    `Encoder calibration: the local ONNX run of bge-small-en-v1.5 agrees with the Workers AI vectors at a mean cosine of ${result.calibration.meanCosineLocalVsProduction.toFixed(4)}. int8 and float32 share ${pct(result.calibration.int8Top10Agreement)} of their top 10.`,
    '',
    '## Chunkings',
    '',
    '| Chunker | Chunks | Median tokens | p10–p90 | Offsets exact | Clean ends | Clean starts | Unresolved anchors |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...result.chunking.map(
      (c) =>
        `| ${c.name} | ${c.chunks} | ${c.medianTokens} | ${c.p10Tokens}–${c.p90Tokens} | ${pct(c.offsetsExact)} | ${pct(c.cleanEnds)} | ${pct(c.cleanStarts)} | ${c.unresolved} |`,
    ),
  ];
  for (const group of groups) {
    lines.push('', `## ${group}`, '', '| Variant | Encoder | Recall@10 (95% CI) | Success@5 (95% CI) | MRR | nDCG@10 | Identifier R@10 | Conceptual R@10 |', '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const r of result.rows.filter((row) => row.group === group)) {
      lines.push(
        `| ${r.name} | ${r.encoder} | ${pct(r.recall10)} (${ci(r.recall10Ci)}) | ${pct(r.success5)} (${ci(r.success5Ci)}) | ${r.mrr.toFixed(3)} | ${r.ndcg10.toFixed(3)} | ${pct(r.identifier)} | ${pct(r.conceptual)} |`,
      );
    }
  }
  return lines.join('\n') + '\n';
}

await main();
