import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { NormalizedDoc } from '@rag/core';
import { chunkDocument, estimateTokens } from './chunk.ts';

const doc = (text: string): NormalizedDoc => ({
  docId: 'd',
  docTitle: 'D',
  sourceUrl: 'https://example.test/d',
  text,
});

/** Repeatable filler of a requested rough token size. */
const prose = (tokens: number, word = 'guidance') =>
  Array.from({ length: Math.ceil((tokens * 3.5) / (word.length + 1)) }, () => word).join(' ');

describe('chunkDocument', () => {
  it('holds the offset invariant: every chunk is a slice of the document', () => {
    const d = doc(['# Title', '## 2.4 Navigable', prose(300), prose(300), '## 3.1 Readable', prose(200)].join('\n\n'));
    for (const chunk of chunkDocument(d)) {
      expect(d.text.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.text);
    }
  });

  it('builds the heading path from ancestors, the chunk owning its own heading', () => {
    const d = doc(['# WCAG', '## 2.4 Navigable', '#### 2.4.11 Focus Not Obscured', 'Body text.'].join('\n\n'));
    const chunks = chunkDocument(d);
    expect(chunks.at(-1)!.headingPath).toEqual(['WCAG', '2.4 Navigable', '2.4.11 Focus Not Obscured']);
  });

  it('pops sibling headings off the path instead of nesting them', () => {
    const d = doc(['## 2.4 Navigable', prose(300), '## 3.1 Readable', prose(300)].join('\n\n'));
    expect(chunkDocument(d).at(-1)!.headingPath).toEqual(['3.1 Readable']);
  });

  it('never splits a success criterion away from its identifier', () => {
    const d = doc(
      ['## 2.4 Navigable', '#### Success Criterion 2.4.11 Focus Not Obscured (Minimum)', prose(400), prose(400)].join('\n\n'),
    );
    const chunks = chunkDocument(d);
    // Every chunk of the criterion's body still resolves to the criterion.
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.scRef).toBe('2.4.11');
  });

  it('reads the criterion from the deepest heading that carries one', () => {
    const sc = (h: string) => chunkDocument(doc([h, 'body'].join('\n\n'))).at(-1)!.scRef;
    expect(sc('# Understanding SC 1.4.3 Contrast (Minimum)')).toBe('1.4.3');
    expect(sc('#### 2.4.11 Focus Not Obscured')).toBe('2.4.11');
    expect(sc('## Checkboxes')).toBeUndefined();
  });

  it('keeps every chunk under the hard cap', () => {
    const d = doc(['## Section', prose(2000)].join('\n\n'));
    const chunks = chunkDocument(d);
    expect(chunks.length).toBeGreaterThan(4);
    for (const chunk of chunks) expect(chunk.tokenCount).toBeLessThanOrEqual(480);
  });

  it('splits an oversized block on sentence boundaries, offsets intact', () => {
    const sentences = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} about focus order.`).join(' ');
    const d = doc(['## Section', sentences].join('\n\n'));
    const chunks = chunkDocument(d);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(d.text.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.text);
  });

  it('overlaps consecutive chunks inside a section', () => {
    const d = doc(['## Section', ...Array.from({ length: 24 }, (_, i) => `Block ${i}. ${prose(60)}`)].join('\n\n'));
    const chunks = chunkDocument(d);
    expect(chunks.length).toBeGreaterThan(2);
    // A later chunk starts before the previous one ended.
    expect(chunks[1]!.charStart).toBeLessThan(chunks[0]!.charEnd);
  });

  it('does not drag overlap across a section heading', () => {
    const d = doc(['## One', prose(400), prose(400), '## Two', prose(300)].join('\n\n'));
    const chunks = chunkDocument(d);
    const two = chunks.find((c) => c.headingPath.includes('Two'))!;
    expect(two.text.startsWith('## Two')).toBe(true);
  });

  it('gives ids that depend on content, not on position', () => {
    // An earlier sibling section grows; the later chunk's text and path do not.
    const tail = ['## Two', `The focus indicator must be visible. ${prose(300)}`];
    const a = chunkDocument(doc(['## One', prose(300), ...tail].join('\n\n')));
    const b = chunkDocument(doc(['## One', prose(300), prose(300), ...tail].join('\n\n')));

    const before = a.at(-1)!;
    const after = b.at(-1)!;
    expect(after.text).toBe(before.text);
    expect(after.charStart).not.toBe(before.charStart);
    expect(after.id).toBe(before.id);
  });

  it('disambiguates repeated text without falling back on position', () => {
    const d = doc(['## Section', 'Same text.', 'Filler.', 'Same text.'].join('\n\n'));
    const ids = chunkDocument(doc(d.text + '\n\n' + prose(10))).map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('estimateTokens', () => {
  it('overestimates rather than under, to stay inside the embedding window', () => {
    const text = 'The focus indicator must remain visible when a component receives keyboard focus.';
    expect(estimateTokens(text)).toBeGreaterThan(text.split(/\s+/).length);
  });
});

/**
 * The invariant that matters is the one that holds on the real corpus, not on
 * fixtures: if it drifts here, every highlighted citation in the UI is wrong.
 */
describe('the real corpus', () => {
  const CORPUS = resolve(import.meta.dirname, '../../../data/corpus');

  const docs = (): NormalizedDoc[] => {
    const manifest = JSON.parse(readFileSync(join(CORPUS, 'manifest.json'), 'utf8')) as {
      docId: string;
      docTitle: string;
      sourceUrl: string;
    }[];
    return manifest.map((m) => ({ ...m, text: readFileSync(join(CORPUS, `${m.docId}.txt`), 'utf8') }));
  };

  it('is present — run `pnpm --filter @rag/ingest corpus` first', () => {
    expect(readdirSync(CORPUS).length).toBeGreaterThan(1);
  });

  it('chunks every document without breaking the offset invariant', () => {
    for (const doc of docs()) {
      for (const chunk of chunkDocument(doc)) {
        expect(doc.text.slice(chunk.charStart, chunk.charEnd), `${chunk.id} in ${doc.docId}`).toBe(chunk.text);
      }
    }
  });

  it('gives every chunk a unique id and keeps it inside the embedding window', () => {
    const ids = new Set<string>();
    for (const doc of docs()) {
      for (const chunk of chunkDocument(doc)) {
        expect(ids.has(chunk.id), `duplicate id ${chunk.id}`).toBe(false);
        ids.add(chunk.id);
        expect(chunk.tokenCount, `${chunk.id} in ${doc.docId}`).toBeLessThanOrEqual(480);
      }
    }
  });
});
