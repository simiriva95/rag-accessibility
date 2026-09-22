import type { EntailmentJudge, EntailmentPair } from './verify.ts';

/**
 * The LLM entailment judge: its wire format, its parser, and the client that
 * calls it.
 *
 * The verdict is a three-way label rather than a number. Models are unreliable
 * at producing calibrated fine-grained scores — asked for 0.73 they will give
 * one, and it means nothing. Three labels are something a model can actually
 * decide, and they map onto the three statuses the UI shows. The interface
 * stays 0..1 so a cross-encoder, which does produce a real continuous score,
 * can replace this without changing anything downstream.
 */

export const ENTAILMENT_LABELS = {
  supported: 1,
  partially_supported: 0.5,
  not_supported: 0,
} as const;

export type EntailmentLabel = keyof typeof ENTAILMENT_LABELS;

/** Kept next to the parser, so what is asked for and what is accepted cannot drift. */
export const ENTAILMENT_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: 'Index of the pair being judged.' },
          label: {
            type: 'string',
            enum: Object.keys(ENTAILMENT_LABELS),
            description:
              'supported: the evidence states the claim. partially_supported: the evidence is ' +
              'related and consistent but does not state it. not_supported: the evidence does ' +
              'not establish the claim, or contradicts it.',
          },
        },
        required: ['index', 'label'],
      },
    },
  },
  required: ['verdicts'],
} as const;

const isLabel = (value: unknown): value is EntailmentLabel =>
  typeof value === 'string' && value in ENTAILMENT_LABELS;

/**
 * Turns verdicts into scores, positionally.
 *
 * A pair the model skipped, or labelled with something that is not a label,
 * comes back null — "not judged" — rather than zero. Zero is a verdict; the
 * absence of one is not, and letting a dropped item read as a rejection would
 * turn a model's sloppiness into an accusation of fabrication.
 */
export function parseVerdicts(raw: unknown, count: number): (number | null)[] {
  const scores: (number | null)[] = Array.from({ length: count }, () => null);
  if (typeof raw !== 'object' || raw === null) return scores;

  const verdicts = (raw as { verdicts?: unknown }).verdicts;
  if (!Array.isArray(verdicts)) return scores;

  for (const verdict of verdicts) {
    if (typeof verdict !== 'object' || verdict === null) continue;
    const { index, label } = verdict as { index?: unknown; label?: unknown };
    if (typeof index !== 'number' || !Number.isInteger(index)) continue;
    if (index < 0 || index >= count) continue;
    if (!isLabel(label)) continue;
    scores[index] = ENTAILMENT_LABELS[label];
  }

  return scores;
}

export type RemoteJudgeOptions = {
  /** Absolute URL of the worker's /entail endpoint. */
  endpoint: string;
  /** Injected for tests, and for runtimes with their own fetch. */
  fetch?: typeof globalThis.fetch;
  /** Pairs per request. The worker caps this too. */
  batchSize?: number;
};

/**
 * A judge that calls the worker.
 *
 * It never throws. Entailment is the one check that depends on a metered
 * service, and an answer whose quotes all verified should not disappear
 * because the judge was rate limited — the claims come back 'unverified' and
 * the UI says the check did not run.
 */
export function createRemoteJudge({
  endpoint,
  fetch: fetchImpl = globalThis.fetch,
  batchSize = 12,
}: RemoteJudgeOptions): EntailmentJudge {
  return async (pairs) => {
    const scores: (number | null)[] = [];

    for (let i = 0; i < pairs.length; i += batchSize) {
      const batch = pairs.slice(i, i + batchSize);
      scores.push(...(await judgeBatch(batch, endpoint, fetchImpl)));
    }
    return scores;
  };
}

async function judgeBatch(
  pairs: readonly EntailmentPair[],
  endpoint: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<(number | null)[]> {
  const unjudged = () => Array.from({ length: pairs.length }, () => null);

  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairs }),
    });
    if (!response.ok) return unjudged();

    const body = (await response.json()) as { scores?: unknown };
    const scores: unknown[] = Array.isArray(body.scores) ? body.scores : [];
    if (scores.length === 0) return unjudged();

    return Array.from({ length: pairs.length }, (_, i) => {
      const score = scores[i];
      return typeof score === 'number' && score >= 0 && score <= 1 ? score : null;
    });
  } catch {
    return unjudged();
  }
}
