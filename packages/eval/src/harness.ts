import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import {
  decodeDenseVectors,
  fuseRrf,
  searchBm25,
  searchDense,
  type Bm25Index,
  type Chunk,
  type DenseIndex,
} from '@rag/core';
import { mean, ndcgAt, recallAt, reciprocalRank, successAt } from './metrics.ts';
import { loadChunks, resolveGolden, type ResolvedQuestion } from './resolve.ts';

/**
 * Runs the golden set through each retrieval configuration and writes the
 * ablation table.
 *
 * A configuration that cannot run — no credentials, no vector index, no
 * reranker yet — is reported as unavailable. It is never quietly dropped and
 * never substituted with a neighbouring configuration's numbers, because the
 * whole point of the table is that a reader can trust what it claims.
 */

const ROOT = resolvePath(import.meta.dirname, '../../..');
const INDEX = join(ROOT, 'data/index');
const CANDIDATES = 30;

type Retriever = {
  name: string;
  description: string;
  run?: (question: ResolvedQuestion) => Promise<string[]>;
  /** Why it did not run, when it did not. */
  unavailable?: string;
};

const KINDS = ['identifier', 'conceptual', 'design'] as const;

type Row = {
  retriever: Retriever;
  recall: Record<number, number>;
  success: Record<number, number>;
  ndcg: number;
  mrr: number;
  /** Recall@10 split by kind — where the hybrid argument is actually visible. */
  byKind: Record<(typeof KINDS)[number], number>;
};

async function loadDense(chunks: Chunk[]): Promise<DenseIndex | undefined> {
  try {
    const file = await readFile(join(INDEX, 'vectors.bin'));
    const vectors = decodeDenseVectors(
      file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer,
    );
    return { ...vectors, docIds: chunks.map((c) => c.id) };
  } catch {
    return undefined;
  }
}

/**
 * Query vectors are cached on disk. Re-running the ablation while tuning
 * fusion should not spend the embedding quota again — the queries have not
 * changed, only what happens to their results.
 */
async function queryVectors(questions: ResolvedQuestion[]): Promise<Map<string, Float32Array> | undefined> {
  const cacheFile = join(ROOT, '.cache/raw/query-embeddings.json');
  const cache: Record<string, number[]> = await readFile(cacheFile, 'utf8')
    .then((json) => JSON.parse(json) as Record<string, number[]>)
    .catch(() => ({}));

  const missing = questions.filter((q) => cache[q.question] === undefined);
  if (missing.length > 0) {
    const { credentialsFromEnv, embedTexts, QUERY_PREFIX } = await import('@rag/ingest/embed');
    let credentials;
    try {
      credentials = credentialsFromEnv();
    } catch {
      return undefined;
    }
    const vectors = await embedTexts(
      missing.map((q) => QUERY_PREFIX + q.question),
      credentials,
    );
    for (const [i, q] of missing.entries()) cache[q.question] = [...vectors[i]!];
    await writeFile(cacheFile, JSON.stringify(cache));
  }

  return new Map(questions.map((q) => [q.question, Float32Array.from(cache[q.question]!)]));
}

async function score(retriever: Retriever, questions: ResolvedQuestion[]): Promise<Row> {
  const answerable = questions.filter((q) => q.kind !== 'refusal');

  const zeroes = Object.fromEntries(KINDS.map((k) => [k, 0])) as Row['byKind'];
  if (!retriever.run) {
    return {
      retriever,
      recall: { 5: 0, 10: 0, 30: 0 },
      success: { 5: 0, 10: 0, 30: 0 },
      ndcg: 0,
      mrr: 0,
      byKind: zeroes,
    };
  }

  const runs = await Promise.all(
    answerable.map(async (q) => ({ question: q, ranked: await retriever.run!(q) })),
  );

  const over = (subset: typeof runs, k: number, fn: typeof recallAt) =>
    mean(subset.map(({ question, ranked }) => fn(ranked, new Set(question.primaryIds), k)));
  const at = (k: number, fn: typeof recallAt) => over(runs, k, fn);

  return {
    retriever,
    recall: { 5: at(5, recallAt), 10: at(10, recallAt), 30: at(30, recallAt) },
    success: { 5: at(5, successAt), 10: at(10, successAt), 30: at(30, successAt) },
    ndcg: mean(runs.map(({ question, ranked }) => ndcgAt(ranked, question.grades, 10))),
    mrr: mean(runs.map(({ question, ranked }) => reciprocalRank(ranked, new Set(question.primaryIds)))),
    byKind: Object.fromEntries(
      KINDS.map((kind) => [kind, over(runs.filter((r) => r.question.kind === kind), 10, recallAt)]),
    ) as Row['byKind'],
  };
}

function table(rows: Row[]): string {
  const pct = (n: number) => `${(100 * n).toFixed(1)}%`;
  const cell = (row: Row, value: () => string) => (row.retriever.run ? value() : '—');

  const lines = [
    '| Retriever | Recall@5 | Recall@10 | Recall@30 | Success@5 | nDCG@10 | MRR |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.retriever.name} | ${cell(row, () => pct(row.recall[5]!))} | ` +
        `${cell(row, () => pct(row.recall[10]!))} | ${cell(row, () => pct(row.recall[30]!))} | ` +
        `${cell(row, () => pct(row.success[5]!))} | ${cell(row, () => row.ndcg.toFixed(3))} | ` +
        `${cell(row, () => row.mrr.toFixed(3))} |`,
    );
  }
  return lines.join('\n');
}

async function main() {
  try {
    process.loadEnvFile(join(ROOT, '.env'));
  } catch {
    // No .env is fine; the variables may already be exported.
  }

  const chunks = loadChunks();
  const questions = resolveGolden(chunks);
  const bm25: Bm25Index = JSON.parse(await readFile(join(INDEX, 'bm25.json'), 'utf8'));

  const dense = await loadDense(chunks);
  const vectors = dense ? await queryVectors(questions) : undefined;

  const lexical = (q: ResolvedQuestion) => searchBm25(bm25, q.question, CANDIDATES);
  const semantic = (q: ResolvedQuestion) => searchDense(dense!, vectors!.get(q.question)!, CANDIDATES);

  const denseUnavailable = !dense
    ? 'no data/index/vectors.bin — run the ingest with Workers AI credentials'
    : !vectors
      ? 'query embeddings need CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN'
      : undefined;

  const retrievers: Retriever[] = [
    {
      name: 'BM25 only',
      description: 'Lexical. Exact terms, identifiers, criterion numbers.',
      run: async (q) => lexical(q).map((s) => s.chunkId),
    },
    {
      name: 'Dense only',
      description: 'bge-small-en-v1.5, int8, brute-force cosine.',
      ...(denseUnavailable
        ? { unavailable: denseUnavailable }
        : { run: async (q: ResolvedQuestion) => semantic(q).map((s) => s.chunkId) }),
    },
    {
      name: 'Hybrid (RRF)',
      description: 'Both candidate lists fused by reciprocal rank, k = 60.',
      ...(denseUnavailable
        ? { unavailable: denseUnavailable }
        : {
            run: async (q: ResolvedQuestion) =>
              fuseRrf([semantic(q), lexical(q)], { topK: CANDIDATES }).map((s) => s.chunkId),
          }),
    },
    {
      name: 'Hybrid + rerank',
      description: 'bge-reranker-base over the fused top 30.',
      unavailable: 'the reranker is week 2 work and is not implemented yet',
    },
  ];

  const rows: Row[] = [];
  for (const retriever of retrievers) rows.push(await score(retriever, questions));

  const byKind = kindBreakdown(rows, questions);

  const report = [
    '# Ablation',
    '',
    `Generated by \`packages/eval/src/harness.ts\` over ${questions.length} golden questions ` +
      `and ${chunks.length} chunks.`,
    '',
    'Recall counts the chunks annotated as *primary* — the ones that actually answer the',
    'question — with the denominator capped at k, so a question whose answer spans more',
    'chunks than k is not penalised for it. nDCG@10 uses the graded annotation: primary',
    'chunks score 2, same-document context scores 1. The five refusal questions have no',
    'relevant chunk and are excluded from every column.',
    '',
    table(rows),
    '',
    ...rows
      .filter((row) => row.retriever.unavailable)
      .map((row) => `**${row.retriever.name}** did not run: ${row.retriever.unavailable}.`),
    '',
    byKind,
    '',
    '## What each row is',
    '',
    ...rows.map((row) => `- **${row.retriever.name}** — ${row.retriever.description}`),
    '',
  ].join('\n');

  await writeFile(join(ROOT, 'docs/ABLATION.md'), report);
  process.stdout.write(table(rows) + '\n\nwritten to docs/ABLATION.md\n');
}

/**
 * Recall@10 split by kind. The headline table can hide the whole point: a
 * hybrid that ties on average may be winning identifier queries outright and
 * losing nothing elsewhere, which is the claim worth making.
 */
function kindBreakdown(rows: Row[], questions: ResolvedQuestion[]): string {
  const pct = (n: number) => `${(100 * n).toFixed(1)}%`;
  const counts = KINDS.map((kind) => questions.filter((q) => q.kind === kind).length);

  return [
    '## Recall@10 by question kind',
    '',
    `| Retriever | ${KINDS.map((k, i) => `${k} (${counts[i]})`).join(' | ')} |`,
    `| --- | ${KINDS.map(() => '---:').join(' | ')} |`,
    ...rows.map(
      (row) =>
        `| ${row.retriever.name} | ` +
        KINDS.map((k) => (row.retriever.run ? pct(row.byKind[k]) : '—')).join(' | ') +
        ' |',
    ),
  ].join('\n');
}

await main();
