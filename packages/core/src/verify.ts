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

/**
 * 'unverified' is the degraded state: the quote held, but the entailment check
 * could not run. It is kept distinct from 'partial' on purpose — "the judge
 * said the support is weak" and "no judge was available" are different things
 * to show a reader, and collapsing them would let an outage look like a result.
 */
export type ClaimStatus = 'verified' | 'partial' | 'unsupported' | 'unverified';

export type VerifiedClaim = Claim & {
  quoteMatch: boolean;
  /**
   * The cited chunks that actually contain the quote, in the order cited.
   *
   * Every citation is checked, not just enough of them to find one that works:
   * a claim that cites four chunks and is carried by one has made three
   * citations that do not hold, and citation precision is the metric that says
   * so. The extra work is a substring search per citation.
   */
  supportingChunkIds: string[];
  /** Offsets into the NORMALIZED source document, ready to highlight. */
  span?: { chunkId: string; start: number; end: number };
  /** null when the judge could not be reached, which is not the same as zero. */
  entailment: number | null;
  status: ClaimStatus;
  /**
   * The conformance level the evidence states and the sentence leaves out,
   * when that is what kept a claim from 'verified'. See levelOmitted.
   */
  levelOmitted?: 'A' | 'AA' | 'AAA';
};

export type EntailmentPair = { sentence: string; evidence: string };

/**
 * Judges whether the evidence supports each sentence, 0..1, in order.
 *
 * Takes a batch rather than one pair. The free generation tier is metered per
 * minute, so a six-sentence answer judged one claim at a time spends six of the
 * fifteen requests available for that minute on a single question. A
 * cross-encoder batches just as naturally, so the shape suits the replacement
 * as well as the first implementation.
 *
 * Returning null for an entry means "could not judge" — an outage, a quota
 * refusal — and is deliberately not the same as returning 0.
 */
export type EntailmentJudge = (
  pairs: readonly EntailmentPair[],
) => Promise<readonly (number | null)[]>;

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

/** Phase one: which cited chunks hold the quote, and where the first one is. */
type QuoteMatch = {
  supportingChunkIds: string[];
  first?: { chunkId: string; chunk: Chunk; span: { start: number; end: number } };
};

function matchQuote(claim: Claim, chunks: ReadonlyMap<string, Chunk>): QuoteMatch {
  const supporting: NonNullable<QuoteMatch['first']>[] = [];

  for (const chunkId of claim.chunkIds) {
    // A cited chunk that does not exist cites nothing, and still counts as a
    // citation that failed.
    const chunk = chunks.get(chunkId);
    if (!chunk) continue;

    const span = locateQuote(claim.quote, chunk);
    if (span) supporting.push({ chunkId, chunk, span });
  }

  const first = supporting[0];
  return { supportingChunkIds: supporting.map((s) => s.chunkId), ...(first ? { first } : {}) };
}

function statusFor(score: number | null, verifiedAt: number, partialAt: number): ClaimStatus {
  if (score === null) return 'unverified';
  return score >= verifiedAt ? 'verified' : score >= partialAt ? 'partial' : 'unsupported';
}

/**
 * Runs the three checks over a set of claims.
 *
 * Two phases, and the split is the cost model made explicit. Quote matching is
 * local and free, so it runs for every claim. Entailment costs a model call, so
 * it runs once, for the claims that survived — a claim whose quote is absent is
 * already invalid, and grading it would spend quota to change nothing.
 */
export async function verifyClaims(
  claims: readonly Claim[],
  chunks: ReadonlyMap<string, Chunk>,
  judge: EntailmentJudge,
  options: VerifyOptions = {},
): Promise<VerifiedClaim[]> {
  const { verifiedAt, partialAt } = { ...DEFAULTS, ...options };

  const matches = claims.map((claim) => matchQuote(claim, chunks));
  const judged = matches
    .map((match, index) => ({ match, index }))
    .filter((entry): entry is { match: QuoteMatch & { first: NonNullable<QuoteMatch['first']> }; index: number } =>
      entry.match.first !== undefined,
    );

  const scores =
    judged.length === 0
      ? []
      : await judge(
          judged.map(({ match, index }) => ({
            sentence: claims[index]!.sentence,
            evidence: match.first.chunk.text,
          })),
        );

  const scoreByIndex = new Map<number, number | null>();
  for (const [position, entry] of judged.entries()) {
    const score = scores[position];
    scoreByIndex.set(entry.index, score === undefined ? null : score);
  }

  return claims.map((claim, index) => {
    const { supportingChunkIds, first } = matches[index]!;
    if (!first) {
      return { ...claim, quoteMatch: false, supportingChunkIds, entailment: 0, status: 'unsupported' };
    }
    const entailment = scoreByIndex.get(index) ?? null;
    const status = statusFor(entailment, verifiedAt, partialAt);
    const level = levelOf(first.chunk);
    // A threshold stated without its level is true of one level and false of
    // the others. The quote holds, so it is partial rather than unsupported.
    if (status === 'verified' && level && !namesLevel(claim.sentence, first.chunk, level)) {
      return {
        ...claim,
        quoteMatch: true,
        supportingChunkIds,
        span: { chunkId: first.chunkId, ...first.span },
        entailment,
        status: 'partial',
        levelOmitted: level,
      };
    }
    return {
      ...claim,
      quoteMatch: true,
      supportingChunkIds,
      span: { chunkId: first.chunkId, ...first.span },
      entailment,
      status,
    };
  });
}

/**
 * The conformance level a chunk's requirement is stated at, when it is
 * stated at exactly one.
 *
 * A WCAG threshold means nothing without its level: large text needs 3:1 at
 * AA and 4.5:1 at AAA, and both sentences quote real text. An LLM judge asked
 * whether "large text needs 4.5:1" follows from the AAA criterion says yes —
 * measured, with the rule spelled out in its prompt — so this is checked
 * deterministically instead. An Understanding page carries its level in its
 * title; a chunk of the specification carries it in its text, and is only
 * trusted when it names one level.
 */
export function levelOf(chunk: Pick<Chunk, 'docTitle' | 'text'>): 'A' | 'AA' | 'AAA' | undefined {
  const inTitle = chunk.docTitle.match(/\(Level (A{1,3})\)/)?.[1];
  if (inTitle) return inTitle as 'A' | 'AA' | 'AAA';
  const inText = new Set([...chunk.text.matchAll(/\(Level (A{1,3})\)/g)].map((m) => m[1]!));
  return inText.size === 1 ? ([...inText][0] as 'A' | 'AA' | 'AAA') : undefined;
}

/** Whether the sentence says which level, or which criterion, it is stating. */
export function namesLevel(sentence: string, chunk: Pick<Chunk, 'scRef'>, level: string): boolean {
  // "AA" and "AAA" stand alone; a bare "A" is the article, so it needs "Level".
  const pattern = level === 'A' ? /\bLevel\s+A\b/ : new RegExp(`\\b${level}\\b`);
  return pattern.test(sentence) || (chunk.scRef !== undefined && sentence.includes(chunk.scRef));
}

/** One claim, for callers that have only one. Judged in a batch of one. */
export const verifyClaim = async (
  claim: Claim,
  chunks: ReadonlyMap<string, Chunk>,
  judge: EntailmentJudge,
  options?: VerifyOptions,
): Promise<VerifiedClaim> => (await verifyClaims([claim], chunks, judge, options))[0]!;

/**
 * The status a sentence carries in the answer view.
 *
 * A sentence is as good as its best claim: one verified citation is enough to
 * show it as verified even if the model also attached a weaker one. A sentence
 * with no claim at all is 'uncited' rather than unsupported — it may be a
 * connective, and conflating the two would hide the sentences that do make an
 * unbacked factual claim.
 */
export type SentenceStatus = ClaimStatus | 'uncited';

/**
 * Any judged outcome outranks an unjudged one, except outright rejection: a
 * quote that held with no verdict is still better evidence than one the judge
 * looked at and refused.
 */
const RANK: Record<ClaimStatus, number> = { verified: 4, partial: 3, unverified: 2, unsupported: 1 };

export function statusOf(sentence: string, claims: readonly VerifiedClaim[]): SentenceStatus {
  const own = claims.filter((claim) => claim.sentence === sentence);
  if (own.length === 0) return 'uncited';
  return own.reduce((best, claim) => (RANK[claim.status] > RANK[best] ? claim.status : best), own[0]!.status);
}
