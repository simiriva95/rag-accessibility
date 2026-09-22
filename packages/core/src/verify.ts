import type { Chunk } from './types.ts';

/**
 * Citation verification.
 *
 * The model does not emit prose with footnotes. It emits claims: a sentence, the
 * chunks it cites, and a quote that must appear in one of them. Three checks run
 * in order, cheapest first.
 *
 *   1. Quote match     the quote is a literal substring of a cited chunk
 *   2. Span resolution the match is mapped back to offsets in the source document
 *   3. Entailment      the sentence is actually supported by the evidence
 *
 * Check 1 has no fuzzy fallback and no similarity threshold. A quote that is not
 * in the text is not a quote, and that single rule catches most fabrication for
 * the cost of a substring search.
 *
 * What it does normalize is an explicit, finite equivalence class: Unicode form,
 * whitespace runs, and the typographic substitutions a language model makes
 * without being asked — curly quotes, dashes, ellipses. GOV.UK prose is full of
 * U+2019 apostrophes, and failing a correct citation because the model typed an
 * ASCII one would be a bug wearing the costume of rigour. Case is *not*
 * normalized: "verbatim" is the claim being made.
 */

export type Claim = {
  sentence: string;
  chunkIds: string[];
  /** Must appear verbatim in at least one cited chunk. */
  quote: string;
};

export type VerifiedClaim = Claim & {
  quoteMatch: boolean;
  /** Offsets into the NORMALIZED source document, ready to highlight. */
  span?: { chunkId: string; start: number; end: number };
  entailment: number;
  status: 'verified' | 'partial' | 'unsupported';
};

/**
 * Judges whether the evidence supports the sentence, 0..1.
 *
 * An interface rather than a concrete check so the first implementation can be
 * an LLM judge and a cross-encoder can replace it without touching this file.
 */
export type EntailmentJudge = (input: {
  sentence: string;
  evidence: string;
}) => Promise<number>;

export type VerifyOptions = {
  /** At or above this, a quote-matched claim is 'verified'. */
  verifiedAt?: number;
  /** At or above this, it is 'partial'. Below, 'unsupported'. */
  partialAt?: number;
};

const DEFAULTS = { verifiedAt: 0.7, partialAt: 0.4 } as const;

/**
 * Typographic characters a model substitutes freely. A finite lookup, not a
 * similarity measure — every entry is a character a human would call the same
 * character. Whitespace is handled separately, so NBSP is not listed here.
 */
const EQUIVALENCES = new Map<string, string>([
  ...[...'\u2018\u2019\u201a\u201b\u2032'].map((c) => [c, "'"] as const),
  ...[...'\u201c\u201d\u201e\u201f\u2033'].map((c) => [c, '"'] as const),
  ...[...'\u2010\u2011\u2012\u2013\u2014\u2015\u2212'].map((c) => [c, '-'] as const),
  ['\u2026', '...'],
]);

/**
 * Normalized text plus the index map that makes it reversible. For normalized
 * character i, `starts[i]` and `ends[i]` bound the source characters it came
 * from — a range, not a point, because composing a base character with its
 * combining marks turns several source characters into one.
 */
export type Normalized = { text: string; starts: number[]; ends: number[] };

/** One code point with any combining marks that belong to it. */
const CLUSTER = /.\p{M}*/gsu;

/**
 * Normalizes for comparison while keeping every character traceable to where it
 * came from. Without the map a quote could be matched but never highlighted,
 * which is the entire point of the exercise.
 *
 * Normalization runs per cluster rather than per character. Per character it
 * cannot compose: 'e' and U+0301 each normalize to themselves, so decomposed
 * text would never equal its composed form — losing exactly the equivalence
 * NFC exists to provide.
 */
export function normalizeForMatch(source: string): Normalized {
  const text: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let pendingSpace: { start: number; end: number } | undefined;

  for (const match of source.matchAll(CLUSTER)) {
    const raw = match[0];
    const start = match.index;
    const end = start + raw.length;

    if (/^\s/.test(raw)) {
      // A whitespace run becomes one space covering the whole run. Leading
      // whitespace is dropped rather than held, which trims the edges.
      if (text.length > 0) pendingSpace = { start: pendingSpace?.start ?? start, end };
      continue;
    }

    const normalized = (EQUIVALENCES.get(raw) ?? raw).normalize('NFC');

    if (pendingSpace) {
      text.push(' ');
      starts.push(pendingSpace.start);
      ends.push(pendingSpace.end);
      pendingSpace = undefined;
    }
    for (const piece of normalized) {
      text.push(piece);
      starts.push(start);
      ends.push(end);
    }
  }

  return { text: text.join(''), starts, ends };
}

/**
 * Finds the quote in a chunk and maps it back to document offsets.
 * Returns undefined when the quote is not literally present.
 */
export function locateQuote(quote: string, chunk: Chunk): { start: number; end: number } | undefined {
  const needle = normalizeForMatch(quote).text;
  if (needle === '') return undefined;

  const haystack = normalizeForMatch(chunk.text);
  const at = haystack.text.indexOf(needle);
  if (at === -1) return undefined;

  // End is exclusive, and read from the map rather than computed, so a composed
  // character at the end of the match is covered in full.
  return {
    start: chunk.charStart + haystack.starts[at]!,
    end: chunk.charStart + haystack.ends[at + needle.length - 1]!,
  };
}

/**
 * Runs the three checks over one claim.
 *
 * Entailment is only asked for when the quote matched. It is the expensive
 * check, and a claim whose quote is absent is already invalid — paying a model
 * call to grade it would be spending quota to change nothing.
 */
export async function verifyClaim(
  claim: Claim,
  chunks: ReadonlyMap<string, Chunk>,
  judge: EntailmentJudge,
  options: VerifyOptions = {},
): Promise<VerifiedClaim> {
  const { verifiedAt, partialAt } = { ...DEFAULTS, ...options };

  for (const chunkId of claim.chunkIds) {
    const chunk = chunks.get(chunkId);
    if (!chunk) continue; // a cited chunk that does not exist cites nothing

    const span = locateQuote(claim.quote, chunk);
    if (!span) continue;

    const entailment = await judge({ sentence: claim.sentence, evidence: chunk.text });
    return {
      ...claim,
      quoteMatch: true,
      span: { chunkId, ...span },
      entailment,
      status: entailment >= verifiedAt ? 'verified' : entailment >= partialAt ? 'partial' : 'unsupported',
    };
  }

  return { ...claim, quoteMatch: false, entailment: 0, status: 'unsupported' };
}

export const verifyClaims = async (
  claims: readonly Claim[],
  chunks: ReadonlyMap<string, Chunk>,
  judge: EntailmentJudge,
  options?: VerifyOptions,
): Promise<VerifiedClaim[]> =>
  Promise.all(claims.map((claim) => verifyClaim(claim, chunks, judge, options)));
