import { describe, expect, it } from 'vitest';
import type { Chunk } from '@rag/core';
import { GOLDEN } from './golden.ts';
import { loadChunks, matches, resolveGolden } from './resolve.ts';

const chunks = loadChunks();
const resolved = resolveGolden(chunks);

const chunk = (over: Partial<Chunk> = {}): Chunk => ({
  id: 'x',
  docId: 'doc',
  docTitle: 'Doc',
  sourceUrl: 'https://example.test',
  headingPath: ['Doc'],
  text: 'body',
  charStart: 0,
  charEnd: 4,
  tokenCount: 1,
  ...over,
});

describe('the golden set', () => {
  it('has the questions it claims to have, with unique ids', () => {
    expect(GOLDEN).toHaveLength(60);
    expect(new Set(GOLDEN.map((q) => q.id)).size).toBe(60);
  });

  it('covers every kind, refusals included', () => {
    const counts = new Map<string, number>();
    for (const q of GOLDEN) counts.set(q.kind, (counts.get(q.kind) ?? 0) + 1);
    expect(counts.get('identifier')).toBeGreaterThanOrEqual(10);
    expect(counts.get('conceptual')).toBeGreaterThanOrEqual(10);
    expect(counts.get('design')).toBeGreaterThanOrEqual(5);
    expect(counts.get('refusal')).toBeGreaterThanOrEqual(5);
  });

  it('asks its questions in plain words, not by pasting a heading', () => {
    // A question that quotes its own answer's heading measures string matching.
    for (const q of resolved) {
      for (const id of q.primaryIds) {
        const heading = chunks.find((c) => c.id === id)!.headingPath.at(-1) ?? '';
        expect(q.question.toLowerCase()).not.toBe(heading.toLowerCase());
      }
    }
  });
});

describe('resolveGolden', () => {
  it('gives every answerable question at least one primary chunk', () => {
    for (const q of resolved) {
      if (q.kind === 'refusal') expect(q.primaryIds).toHaveLength(0);
      else expect(q.primaryIds.length, q.id).toBeGreaterThan(0);
    }
  });

  it('grades primary chunks above related ones', () => {
    for (const q of resolved) {
      for (const id of q.primaryIds) expect(q.grades.get(id)).toBe(2);
      const related = [...q.grades].filter(([id]) => !q.primaryIds.includes(id));
      for (const [, grade] of related) expect(grade).toBe(1);
    }
  });

  it('keeps the graded set small enough for Recall@k to mean something', () => {
    for (const q of resolved) {
      // At 10% of the corpus a retriever picking at random would score well.
      expect(q.grades.size / chunks.length, q.id).toBeLessThan(0.05);
    }
  });

  it('refuses to score against an anchor that matches nothing', () => {
    expect(() => resolveGolden([chunk()])).toThrow(/matches no chunk/);
  });
});

describe('anchor matching', () => {
  const anchor = { docId: 'doc', heading: 'Success Criterion 2.4.11' };

  it('matches a heading that is an ancestor of the chunk', () => {
    expect(matches(chunk({ headingPath: ['Doc', 'Success Criterion 2.4.11 Focus'] }), anchor)).toBe(true);
  });

  it('matches a heading merged into the chunk body', () => {
    expect(matches(chunk({ text: '#### Success Criterion 2.4.11 Focus\n\nBody.' }), anchor)).toBe(true);
  });

  it('does not match the same words as prose', () => {
    expect(matches(chunk({ text: 'See Success Criterion 2.4.11 for details.' }), anchor)).toBe(false);
  });

  it('matches the whole document when no heading is given', () => {
    expect(matches(chunk(), { docId: 'doc' })).toBe(true);
    expect(matches(chunk(), { docId: 'other' })).toBe(false);
  });
});
