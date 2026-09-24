import { createHash } from 'node:crypto';
import type { Chunk, NormalizedDoc } from '@rag/core';

/**
 * Structure-aware chunking over the markdown-lite normalized form.
 *
 * A chunk is always a contiguous slice of the normalized document, never a
 * reassembly of parts, so the invariant holds by construction:
 *   doc.text.slice(chunk.charStart, chunk.charEnd) === chunk.text
 * That is what lets the UI highlight a verified quote in the source later.
 *
 * Heading text is never copied into a chunk that does not physically contain
 * it — ancestor headings travel in headingPath instead.
 */

export type ChunkOptions = {
  /** Soft target: a chunk is flushed once it is reached. */
  targetTokens?: number;
  /** A section heading below this size does not start a new chunk. */
  minTokens?: number;
  /** Hard cap. Stays inside bge-small's 512-token window with room to spare. */
  maxTokens?: number;
  /** Fraction of a chunk carried into the next one. */
  overlapRatio?: number;
};

const DEFAULTS = { targetTokens: 400, minTokens: 250, maxTokens: 480, overlapRatio: 0.15 } as const;

/**
 * ponytail: character heuristic instead of a real tokenizer. 3.5 chars/token
 * deliberately overestimates for English prose, so the hard cap keeps us inside
 * the embedding window even on identifier-dense text. Swap in the real count if
 * the ingest ever needs exact budgeting.
 */
export const estimateTokens = (s: string): number => Math.ceil(s.length / 3.5);

const HEADING = /^(#{1,6}) (.+)$/;

/**
 * A success criterion reference as WCAG headings write it:
 * "Success Criterion 2.4.11 ...", "Understanding SC 2.4.11 ...", "2.4.11 ...".
 */
const SC_REF = /(?:Success Criterion|SC)\s+(\d+\.\d+\.\d+)\b|^(\d+\.\d+\.\d+)(?=\s)/;

/** Headings at this level or above start a fresh chunk with no overlap. */
const SECTION_LEVEL = 3;

type Block = {
  text: string;
  /** Absolute offsets into the normalized document. */
  start: number;
  end: number;
  /** Heading level, when this block is a heading. */
  level?: number;
};

/** Cut a piece that is long even as a single sentence. */
function hardSplit(block: Block, maxTokens: number): Block[] {
  const size = Math.floor(maxTokens * 3.5);
  const out: Block[] = [];
  for (let i = 0; i < block.text.length; i += size) {
    out.push({
      text: block.text.slice(i, i + size),
      start: block.start + i,
      end: block.start + Math.min(i + size, block.text.length),
    });
  }
  return out;
}

/**
 * Split an oversized block on sentence boundaries. Splitting with a captured
 * separator keeps every offset exact: the parts, separators included, sum back
 * to the original text.
 */
function splitOversized(block: Block, maxTokens: number): Block[] {
  if (estimateTokens(block.text) <= maxTokens) return [block];

  const parts = block.text.split(/((?<=[.!?:;])\s+)/);
  const pieces: Block[] = [];
  let offset = 0;
  let startRel = 0;
  let endRel = 0;
  let tokens = 0;

  const push = () => {
    if (endRel > startRel) {
      pieces.push({
        text: block.text.slice(startRel, endRel),
        start: block.start + startRel,
        end: block.start + endRel,
      });
    }
  };

  for (const [i, part] of parts.entries()) {
    if (i % 2 === 1) {
      offset += part.length; // separator: advances the cursor, joins nothing
      continue;
    }
    const partTokens = estimateTokens(part);
    if (tokens > 0 && tokens + partTokens > maxTokens) {
      push();
      startRel = offset;
      tokens = 0;
    }
    endRel = offset + part.length;
    offset += part.length;
    tokens += partTokens;
  }
  push();

  return pieces.flatMap((p) => (estimateTokens(p.text) > maxTokens ? hardSplit(p, maxTokens) : [p]));
}

function parseBlocks(text: string, maxTokens: number): Block[] {
  const blocks: Block[] = [];
  let pos = 0;
  for (const raw of text.split('\n\n')) {
    const start = pos;
    pos += raw.length + 2; // the separator we split on
    if (!raw) continue;

    const heading = HEADING.exec(raw);
    if (heading) {
      blocks.push({ text: raw, start, end: start + raw.length, level: heading[1]!.length });
    } else {
      blocks.push(...splitOversized({ text: raw, start, end: start + raw.length }, maxTokens));
    }
  }
  return blocks;
}

/** Deepest heading wins: the criterion beats the guideline it sits under. */
export function scRefOf(headingPath: string[]): string | undefined {
  for (let i = headingPath.length - 1; i >= 0; i--) {
    const m = SC_REF.exec(headingPath[i]!);
    if (m) return m[1] ?? m[2];
  }
  return undefined;
}

export function chunkDocument(doc: NormalizedDoc, options: ChunkOptions = {}): Chunk[] {
  const { targetTokens, minTokens, maxTokens, overlapRatio } = { ...DEFAULTS, ...options };
  const blocks = parseBlocks(doc.text, maxTokens);

  const chunks: Omit<Chunk, 'id'>[] = [];
  const stack: { level: number; text: string }[] = [];
  let current: Block[] = [];
  let headingPath: string[] = [];
  /** True once the chunk holds something other than its leading headings. */
  let hasBody = false;

  /**
   * Size is measured on the slice, not on the sum of the blocks, because the
   * slice is what gets embedded — separators and all. Measuring anything else
   * lets the real token count drift past the cap.
   */
  const sizeOf = (blocks: Block[]) =>
    blocks.length === 0 ? 0 : estimateTokens(doc.text.slice(blocks[0]!.start, blocks.at(-1)!.end));

  const flush = (): Block[] => {
    if (current.length === 0) return [];
    const first = current[0]!;
    const last = current.at(-1)!;
    const text = doc.text.slice(first.start, last.end);
    const scRef = scRefOf(headingPath);

    chunks.push({
      docId: doc.docId,
      docTitle: doc.docTitle,
      sourceUrl: doc.sourceUrl,
      headingPath,
      ...(scRef !== undefined ? { scRef } : {}),
      text,
      charStart: first.start,
      charEnd: last.end,
      tokenCount: estimateTokens(text),
    });

    const flushed = current;
    current = [];
    hasBody = false;
    return flushed;
  };

  /**
   * Trailing blocks of the previous chunk, to open the next one with.
   *
   * The overlap is resolved against the block that will follow it rather than
   * at flush time. That way it can never produce a chunk made of overlap alone,
   * and never pushes the chunk it joins past the cap. One block is always
   * carried when it fits at all, even if it is larger than the nominal budget:
   * most blocks in this corpus are around the budget's size, and a strict
   * budget means no overlap ever happens.
   */
  const overlapFor = (next: Block, previous: Block[]): Block[] => {
    const budget = targetTokens * overlapRatio;
    const carried: Block[] = [];
    // i > 0: never carry a whole chunk, or the walk stops making progress.
    for (let i = previous.length - 1; i > 0; i--) {
      const candidate = [previous[i]!, ...carried];
      if (carried.length > 0 && sizeOf(candidate) > budget) break;
      if (sizeOf([...candidate, next]) > maxTokens) break;
      carried.unshift(previous[i]!);
    }
    return carried;
  };

  const add = (block: Block) => {
    if (block.level !== undefined) {
      while (stack.length && stack.at(-1)!.level >= block.level) stack.pop();
      stack.push({ level: block.level, text: block.text.replace(HEADING, '$2') });
    } else {
      hasBody = true;
    }
    // The leading run of headings belongs to the chunk that opens on it, so the
    // path keeps growing until the first body block arrives.
    if (!hasBody || current.length === 0) headingPath = stack.map((h) => h.text);
    current.push(block);
  };

  /** The chunk just flushed, still available to overlap into the next one. */
  let previous: Block[] = [];

  for (const block of blocks) {
    // A new section opens a clean chunk — but only once the current one is
    // worth retrieving on its own. These documents are full of two-line
    // subsections; splitting on every heading buries the useful ones among
    // fragments that carry no context.
    if (block.level !== undefined && block.level <= SECTION_LEVEL) {
      if (sizeOf(current) >= minTokens) flush();
      // Cleared whether or not we flushed here: a chunk that happened to reach
      // its target on the block before the heading must not overlap past it.
      previous = [];
    }

    if (current.length > 0 && sizeOf([...current, block]) > maxTokens) previous = flush();

    if (current.length === 0) for (const carried of overlapFor(block, previous)) add(carried);

    add(block);

    if (sizeOf(current) >= targetTokens) previous = flush();
  }
  flush();

  return assignIds(chunks);
}

/**
 * Content-addressed ids: they depend on what a chunk says, not where it sits,
 * so golden-set annotations survive a re-index that shifts offsets. Identical
 * text under an identical heading path is disambiguated by a counter rather
 * than by position, which preserves that property.
 */
function assignIds(chunks: Omit<Chunk, 'id'>[]): Chunk[] {
  const seen = new Map<string, number>();
  return chunks.map((chunk) => {
    const key = createHash('sha256')
      .update(`${chunk.docId}\n${chunk.headingPath.join(' > ')}\n${chunk.text}`)
      .digest('hex')
      .slice(0, 16);
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return { ...chunk, id: n === 0 ? key : `${key}-${n}` };
  });
}
