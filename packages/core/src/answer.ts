import type { Claim } from './verify.ts';

/**
 * The shape the generator must produce, and the parser that refuses to trust it.
 *
 * Claims point at sentences by index rather than repeating their text. Asking a
 * model to write the same sentence twice and matching on the strings is a
 * reliable way to end up with claims that belong to no sentence.
 *
 * `answerable` is explicit. A refusal is not an answer with no citations — the
 * citation metrics would read it as several uncited sentences, punishing the
 * model for correctly declining. It has to be able to say so.
 */

export type ModelAnswer = {
  answerable: boolean;
  /** The answer, split into sentences. On a refusal, the reason. */
  sentences: string[];
  claims: Claim[];
};

export type ParsedAnswer = {
  answer: ModelAnswer;
  /** Claims discarded as malformed, with the reason. Reported, never hidden. */
  dropped: string[];
};

/**
 * JSON schema handed to the generator.
 *
 * Kept next to the parser so the two cannot drift: what the model is asked for
 * and what is accepted back are one definition. Structured output makes the
 * shape likely, not certain, which is why the parser below still checks.
 */
export const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    answerable: {
      type: 'boolean',
      description: 'False when the provided sources do not answer the question.',
    },
    sentences: {
      type: 'array',
      description: 'The answer, one sentence per item. On a refusal, the reason.',
      items: { type: 'string' },
    },
    claims: {
      type: 'array',
      description: 'One per factual sentence. A sentence with no claim will be shown as uncited.',
      items: {
        type: 'object',
        properties: {
          sentenceIndex: { type: 'integer', description: 'Index into sentences.' },
          chunkIds: {
            type: 'array',
            description: 'Ids of the provided sources supporting the sentence.',
            items: { type: 'string' },
          },
          quote: {
            type: 'string',
            description: 'Text copied character for character from one of the cited sources.',
          },
        },
        required: ['sentenceIndex', 'chunkIds', 'quote'],
      },
    },
  },
  required: ['answerable', 'sentences', 'claims'],
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/**
 * Parses a generated answer.
 *
 * Structurally invalid output throws — there is nothing to show. Individual
 * malformed claims are dropped with a reason instead, because losing one
 * citation should not lose the answer, and a silent drop would hide a model
 * that is misbehaving.
 */
export function parseModelAnswer(raw: unknown): ParsedAnswer {
  if (!isRecord(raw)) throw new Error('answer is not an object');
  if (typeof raw['answerable'] !== 'boolean') throw new Error('answer.answerable is not a boolean');
  if (!isStringArray(raw['sentences'])) throw new Error('answer.sentences is not an array of strings');

  const sentences = raw['sentences'].map((sentence) => stripMarkers(sentence).trim()).filter(Boolean);
  if (sentences.length === 0) throw new Error('answer.sentences is empty');

  const rawClaims = raw['claims'];
  if (!Array.isArray(rawClaims)) throw new Error('answer.claims is not an array');

  const claims: Claim[] = [];
  const dropped: string[] = [];

  for (const [i, candidate] of rawClaims.entries()) {
    const reason = claimProblem(candidate, sentences.length);
    if (reason) {
      dropped.push(`claim ${i}: ${reason}`);
      continue;
    }
    const claim = candidate as { sentenceIndex: number; chunkIds: string[]; quote: string };
    claims.push({
      sentence: sentences[claim.sentenceIndex]!,
      chunkIds: [...new Set(claim.chunkIds)],
      quote: claim.quote,
    });
  }

  return { answer: { answerable: raw['answerable'], sentences: byLevel(sentences), claims }, dropped };
}

/**
 * Citation markers some models append to a sentence despite the schema:
 * "[claim 0]", or the cited chunk ids in brackets. The citation already lives
 * in the claim, so the marker is noise in the prose. Only a trailing bracket
 * holding nothing but those is removed; any other bracketed text is the
 * model's words and stays.
 */
const MARKER =
  /\s*\[(?:(?:claims?|citazion[ei]|cita|fonte|source|sources)\s+)?(?:\d+(?:,\s*\d+)*|[0-9a-f]{16}(?:,\s*[0-9a-f]{16})*)\]\s*$/i;

const stripMarkers = (sentence: string): string => {
  let out = sentence;
  while (MARKER.test(out)) out = out.replace(MARKER, '');
  return out;
};

const LEVEL_RANK: Record<string, number> = { A: 0, AA: 1, AAA: 2 };

/** The lowest conformance level a sentence names, if it names one. */
const levelRank = (sentence: string): number | undefined => {
  const ranks = [...sentence.matchAll(/\b(?:Level|Livello)\s+(A{1,3})\b|\b(AAA?)\b/g)].map((m) => LEVEL_RANK[m[1] ?? m[2]!]!);
  return ranks.length > 0 ? Math.min(...ranks) : undefined;
};

/**
 * Sentences that state a requirement at a conformance level, reordered from
 * the lowest level up — A, then AA, then AAA — within the slots they already
 * occupy. Every other sentence keeps its place, so the prose around them is
 * untouched. AA is the level most requirements are held to, so it is what a
 * reader should meet first; a model asked for that order does not reliably
 * give it. Claims refer to their sentence by text, so reordering cannot
 * detach one.
 */
function byLevel(sentences: string[]): string[] {
  const slots = sentences.flatMap((sentence, i) => (levelRank(sentence) !== undefined ? [i] : []));
  if (slots.length < 2) return sentences;
  const ordered = slots.map((i) => sentences[i]!).sort((a, b) => levelRank(a)! - levelRank(b)!);
  const out = [...sentences];
  slots.forEach((slot, n) => (out[slot] = ordered[n]!));
  return out;
}

function claimProblem(candidate: unknown, sentenceCount: number): string | undefined {
  if (!isRecord(candidate)) return 'not an object';

  const index = candidate['sentenceIndex'];
  if (typeof index !== 'number' || !Number.isInteger(index)) return 'sentenceIndex is not an integer';
  if (index < 0 || index >= sentenceCount) return `sentenceIndex ${index} is out of range`;

  const chunkIds = candidate['chunkIds'];
  if (!isStringArray(chunkIds)) return 'chunkIds is not an array of strings';
  if (chunkIds.length === 0) return 'chunkIds is empty';

  const quote = candidate['quote'];
  if (typeof quote !== 'string') return 'quote is not a string';
  if (quote.trim() === '') return 'quote is empty';

  return undefined;
}
