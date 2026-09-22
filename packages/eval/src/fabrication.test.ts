import { describe, expect, it } from 'vitest';
import { locateQuote, type Chunk } from '@rag/core';
import { loadChunks } from './resolve.ts';

/**
 * Does the quote check actually catch fabrication?
 *
 * The claim the project makes is that citations are verified rather than
 * asserted. That claim is only worth anything if the check has no false
 * accepts on citations a model would plausibly get wrong, and no false
 * rejects on ones it would plausibly get right.
 *
 * So: build both kinds deliberately, from the real corpus, and count. This
 * measures check 1 on its own — no entailment, no model, no quota. It is the
 * cheap check, and the point is that the cheap check carries most of the load.
 */

const chunks = loadChunks();
/** Every 53rd chunk: a spread across all three sources, 30 of them. */
const sample = chunks.filter((_, i) => i % 53 === 0);

const words = (chunk: Chunk) => chunk.text.split(/\s+/).filter(Boolean);

/** A plausible excerpt: a run of words from the middle of the chunk. */
function excerpt(chunk: Chunk, length = 12): string {
  const all = words(chunk);
  return all.slice(Math.floor(all.length / 3), Math.floor(all.length / 3) + length).join(' ');
}

const usable = sample.filter((chunk) => excerpt(chunk).length >= 40);

type Probe = {
  name: string;
  /** Whether the quote check is supposed to accept it. */
  shouldMatch: boolean;
  build: (chunk: Chunk, index: number) => { quote: string; cited: Chunk } | undefined;
};

const PROBES: Probe[] = [
  {
    name: 'verbatim excerpt',
    shouldMatch: true,
    build: (chunk) => ({ quote: excerpt(chunk), cited: chunk }),
  },
  {
    name: 'excerpt with the whitespace reflowed',
    shouldMatch: true,
    build: (chunk) => ({ quote: excerpt(chunk).replace(/ /g, '\n   '), cited: chunk }),
  },
  {
    name: 'excerpt with the apostrophes straightened',
    shouldMatch: true,
    build: (chunk) => {
      const quote = excerpt(chunk);
      // Only meaningful where the source actually uses typographic characters.
      return /[‘’“”–—]/.test(quote)
        ? { quote: quote.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-'), cited: chunk }
        : undefined;
    },
  },
  {
    name: 'real quote, cited to a different chunk',
    shouldMatch: false,
    build: (chunk, i) => {
      const other = usable[(i + 7) % usable.length]!;
      return other.docId === chunk.docId ? undefined : { quote: excerpt(chunk), cited: other };
    },
  },
  {
    name: 'excerpt with one word replaced',
    shouldMatch: false,
    build: (chunk) => {
      const parts = excerpt(chunk).split(' ');
      parts[Math.floor(parts.length / 2)] = 'blancmange';
      return { quote: parts.join(' '), cited: chunk };
    },
  },
  {
    name: 'two real fragments stitched together',
    shouldMatch: false,
    build: (chunk) => {
      const all = words(chunk);
      if (all.length < 30) return undefined;
      // Both halves are genuinely in the chunk; their concatenation is not.
      return { quote: [...all.slice(0, 6), ...all.slice(-6)].join(' '), cited: chunk };
    },
  },
  {
    name: 'invented sentence in the register of the corpus',
    shouldMatch: false,
    build: (chunk) => ({
      quote: 'Authors must ensure the focus indicator blinks at least twice per second.',
      cited: chunk,
    }),
  },
];

describe('the quote check against deliberate fabrication', () => {
  it('has a sample worth measuring', () => {
    expect(usable.length).toBeGreaterThan(20);
  });

  for (const probe of PROBES) {
    it(`${probe.shouldMatch ? 'accepts' : 'rejects'}: ${probe.name}`, () => {
      const wrong: string[] = [];
      let tried = 0;

      for (const [i, chunk] of usable.entries()) {
        const built = probe.build(chunk, i);
        if (!built) continue;
        tried++;

        const matched = locateQuote(built.quote, built.cited) !== undefined;
        if (matched !== probe.shouldMatch) wrong.push(`${chunk.docId} (${chunk.id})`);
      }

      expect(tried, `${probe.name} produced no cases`).toBeGreaterThan(0);
      expect(wrong, `${wrong.length}/${tried} wrong for "${probe.name}"`).toEqual([]);
    });
  }

  it('accepts nothing it should reject, across every probe at once', () => {
    let falseAccepts = 0;
    let falseRejects = 0;
    let total = 0;

    for (const probe of PROBES) {
      for (const [i, chunk] of usable.entries()) {
        const built = probe.build(chunk, i);
        if (!built) continue;
        total++;

        const matched = locateQuote(built.quote, built.cited) !== undefined;
        if (matched && !probe.shouldMatch) falseAccepts++;
        if (!matched && probe.shouldMatch) falseRejects++;
      }
    }

    expect(total).toBeGreaterThan(100);
    expect({ falseAccepts, falseRejects }).toEqual({ falseAccepts: 0, falseRejects: 0 });
  });
});
