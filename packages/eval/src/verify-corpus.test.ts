import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { locateQuote, normalizeForMatch, type Chunk } from '@rag/core';
import { loadChunks } from './resolve.ts';

/**
 * Span resolution against the real corpus.
 *
 * The unit tests prove the mapping is consistent with itself. This one proves
 * it is consistent with the documents the UI will render: a quote found in a
 * chunk has to highlight the same words in the source file, or every citation
 * in the demo points at the wrong text while claiming to be verified.
 */

const CORPUS = resolve(import.meta.dirname, '../../../data/corpus');
const chunks = loadChunks();

const documents = new Map<string, string>();
const documentFor = (chunk: Chunk): string => {
  let text = documents.get(chunk.docId);
  if (text === undefined) {
    text = readFileSync(join(CORPUS, `${chunk.docId}.txt`), 'utf8');
    documents.set(chunk.docId, text);
  }
  return text;
};

/** Every 37th chunk — a spread across all three sources without reading 1600 files. */
const sample = chunks.filter((_, i) => i % 37 === 0);

/** A quote a model might plausibly pull: a run of words from the middle. */
function excerpt(chunk: Chunk): string {
  const words = chunk.text.split(/\s+/).filter(Boolean);
  return words.slice(Math.floor(words.length / 3), Math.floor(words.length / 3) + 12).join(' ');
}

describe('span resolution over the real corpus', () => {
  it('has a sample worth testing', () => {
    expect(sample.length).toBeGreaterThan(30);
  });

  it('highlights the quoted words in the source document', () => {
    for (const chunk of sample) {
      const quote = excerpt(chunk);
      if (quote.length < 20) continue;

      const span = locateQuote(quote, chunk);
      expect(span, `${chunk.id} in ${chunk.docId}`).toBeDefined();

      const highlighted = documentFor(chunk).slice(span!.start, span!.end);
      expect(normalizeForMatch(highlighted).text, `${chunk.id} in ${chunk.docId}`).toBe(
        normalizeForMatch(quote).text,
      );
    }
  });

  it('resolves a quote whose whitespace has been reflowed, as a model returns it', () => {
    for (const chunk of sample.slice(0, 20)) {
      const quote = excerpt(chunk);
      if (quote.length < 20) continue;

      // Models reflow. The span must still land on the original characters.
      const reflowed = quote.replace(/ /g, '\n  ');
      const span = locateQuote(reflowed, chunk);
      expect(span, `${chunk.id}`).toBeDefined();
      expect(normalizeForMatch(documentFor(chunk).slice(span!.start, span!.end)).text).toBe(
        normalizeForMatch(quote).text,
      );
    }
  });

  it('refuses a quote that is not in the chunk it cites', () => {
    for (const chunk of sample.slice(0, 20)) {
      expect(locateQuote('this sentence appears in no accessibility document', chunk)).toBeUndefined();
    }
  });

  it('keeps the span inside the chunk it was found in', () => {
    for (const chunk of sample) {
      const quote = excerpt(chunk);
      if (quote.length < 20) continue;

      const span = locateQuote(quote, chunk)!;
      expect(span.start, chunk.id).toBeGreaterThanOrEqual(chunk.charStart);
      expect(span.end, chunk.id).toBeLessThanOrEqual(chunk.charEnd);
    }
  });
});
