import { readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import type { Chunk } from '@rag/core';
import { GOLDEN, type GoldAnchor, type GoldenQuestion } from './golden.ts';

/**
 * Turns the golden set's human-readable anchors into the graded chunk ids the
 * harness scores, and refuses to produce a silently empty annotation.
 */

const INDEX = resolvePath(import.meta.dirname, '../../../data/index');

export const loadChunks = (): Chunk[] =>
  JSON.parse(readFileSync(join(INDEX, 'chunks.json'), 'utf8')) as Chunk[];

export type Grade = 1 | 2;

export type ResolvedQuestion = GoldenQuestion & {
  /** Grade 2: the chunks that answer the question. */
  primaryIds: string[];
  /** chunkId -> grade, primary and related together. Absent means grade 0. */
  grades: Map<string, Grade>;
};

/**
 * A heading anchor matches a chunk that sits under that heading — which is
 * either of two things, because headingPath only holds ancestors:
 *
 *  - the heading is in the path, i.e. the chunk opened beneath it;
 *  - the heading is a line inside the chunk, i.e. a subsection short enough to
 *    have been merged in rather than opening a chunk of its own.
 *
 * Only checking the path silently loses the second case, which is most of the
 * WCAG criteria — their statements are three lines long and get merged.
 */
export function matches(chunk: Chunk, anchor: GoldAnchor): boolean {
  if (chunk.docId !== anchor.docId) return false;
  if (anchor.heading === undefined) return true;

  const needle = anchor.heading.toLowerCase();
  if (chunk.headingPath.some((heading) => heading.toLowerCase().includes(needle))) return true;

  return chunk.text
    .split('\n')
    .some((line) => line.startsWith('#') && line.toLowerCase().includes(needle));
}

export function resolveGolden(chunks: Chunk[] = loadChunks()): ResolvedQuestion[] {
  const problems: string[] = [];

  const resolveAnchors = (anchors: readonly GoldAnchor[], where: string): string[] => {
    const ids = new Set<string>();
    for (const anchor of anchors) {
      const hits = chunks.filter((chunk) => matches(chunk, anchor));
      // An anchor matching nothing means the corpus moved under the annotation.
      // Reporting it beats scoring against a gold set that quietly emptied.
      if (hits.length === 0) {
        problems.push(`${where}: ${anchor.docId}${anchor.heading ? ` / ${anchor.heading}` : ''} matches no chunk`);
      }
      for (const hit of hits) ids.add(hit.id);
    }
    return [...ids];
  };

  const resolved = GOLDEN.map((question) => {
    const primaryIds = resolveAnchors(question.primary, question.id).sort();

    // Related defaults to the rest of the documents the answer lives in.
    const relatedAnchors = question.related ?? question.primary.map(({ docId }) => ({ docId }));
    const relatedIds = resolveAnchors(relatedAnchors, question.id);

    const grades = new Map<string, Grade>();
    for (const id of relatedIds) grades.set(id, 1);
    for (const id of primaryIds) grades.set(id, 2); // primary wins the overlap

    if (question.kind === 'refusal' && question.primary.length > 0) {
      problems.push(`${question.id}: a refusal question must have no gold anchors`);
    }
    if (question.kind !== 'refusal' && primaryIds.length === 0) {
      problems.push(`${question.id}: resolved to no primary chunks`);
    }

    return { ...question, primaryIds, grades };
  });

  if (problems.length > 0) {
    throw new Error(`Golden set does not resolve against the current index:\n  ${problems.join('\n  ')}`);
  }
  return resolved;
}

if (import.meta.filename === process.argv[1]) {
  const chunks = loadChunks();
  const resolved = resolveGolden(chunks);
  const answerable = resolved.filter((q) => q.kind !== 'refusal');
  const sizes = answerable.map((q) => q.primaryIds.length).sort((a, b) => a - b);

  const byKind = new Map<string, number>();
  for (const q of resolved) byKind.set(q.kind, (byKind.get(q.kind) ?? 0) + 1);

  const share = (n: number) => `${((100 * n) / chunks.length).toFixed(2)}%`;
  const widest = Math.max(...answerable.map((q) => q.grades.size));

  process.stdout.write(
    `${resolved.length} questions (${[...byKind].map(([k, n]) => `${k} ${n}`).join(', ')}) ` +
      `over ${chunks.length} chunks\n` +
      `primary chunks per answerable question: min ${sizes[0]}, ` +
      `median ${sizes[Math.floor(sizes.length / 2)]}, max ${sizes.at(-1)}\n` +
      `widest graded set: ${widest} chunks, ${share(widest)} of the corpus\n\n`,
  );

  for (const q of resolved) {
    process.stdout.write(
      `  ${q.id.padEnd(26)} ${String(q.primaryIds.length).padStart(2)} primary` +
        ` ${String(q.grades.size - q.primaryIds.length).padStart(3)} related  ${q.question}\n`,
    );
  }
}
