import { describe, expect, it, vi } from 'vitest';
import { ENTAILMENT_SCHEMA, createRemoteJudge, parseVerdicts } from './entailment.ts';

const pairs = [
  { sentence: 'Focus must stay visible.', evidence: 'The component is not entirely hidden.' },
  { sentence: 'Contrast must be 4.5:1.', evidence: 'Text has a contrast ratio of at least 4.5:1.' },
];

const responding = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe('parseVerdicts', () => {
  it('maps labels to scores positionally', () => {
    const scores = parseVerdicts(
      {
        verdicts: [
          { index: 1, label: 'not_supported' },
          { index: 0, label: 'supported' },
        ],
      },
      2,
    );
    expect(scores).toEqual([1, 0]);
  });

  it('scores a middling label between the two thresholds', () => {
    // 0.5 sits below verifiedAt (0.7) and above partialAt (0.4), by design.
    expect(parseVerdicts({ verdicts: [{ index: 0, label: 'partially_supported' }] }, 1)).toEqual([0.5]);
  });

  it('returns null for a pair the model skipped, not zero', () => {
    // Zero is a verdict. Letting a dropped item read as one would turn the
    // model's sloppiness into an accusation of fabrication.
    expect(parseVerdicts({ verdicts: [{ index: 0, label: 'supported' }] }, 3)).toEqual([1, null, null]);
  });

  it('ignores verdicts that are malformed or out of range', () => {
    const scores = parseVerdicts(
      {
        verdicts: [
          { index: 0, label: 'very_supported' },
          { index: 9, label: 'supported' },
          { index: 1.5, label: 'supported' },
          'nonsense',
          null,
        ],
      },
      2,
    );
    expect(scores).toEqual([null, null]);
  });

  it('survives a response that is not the expected shape at all', () => {
    expect(parseVerdicts(null, 2)).toEqual([null, null]);
    expect(parseVerdicts({}, 2)).toEqual([null, null]);
    expect(parseVerdicts({ verdicts: 'no' }, 1)).toEqual([null]);
  });
});

describe('createRemoteJudge', () => {
  it('posts the pairs and returns the scores in order', async () => {
    const fetchImpl = responding({ scores: [1, 0.5] });
    const judge = createRemoteJudge({ endpoint: 'https://w.test/entail', fetch: fetchImpl });

    expect(await judge(pairs)).toEqual([1, 0.5]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://w.test/entail');
    expect(JSON.parse(init.body as string)).toEqual({ pairs });
  });

  it('returns nulls rather than throwing when the endpoint fails', async () => {
    for (const fetchImpl of [
      responding({}, 500),
      responding({ scores: 'nope' }),
      vi.fn(async () => {
        throw new Error('network down');
      }),
    ]) {
      const judge = createRemoteJudge({ endpoint: 'https://w.test/entail', fetch: fetchImpl });
      expect(await judge(pairs)).toEqual([null, null]);
    }
  });

  it('nulls a score that is missing or out of range', async () => {
    const judge = createRemoteJudge({
      endpoint: 'https://w.test/entail',
      fetch: responding({ scores: [1.7, undefined] }),
    });
    expect(await judge(pairs)).toEqual([null, null]);
  });

  it('splits a long run into batches and keeps the order', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ sentence: `s${i}`, evidence: `e${i}` }));
    const fetchImpl = vi.fn(async (_url: unknown, init: unknown) => {
      const sent = JSON.parse((init as RequestInit).body as string) as { pairs: { sentence: string }[] };
      return new Response(JSON.stringify({ scores: sent.pairs.map((p) => Number(p.sentence.slice(1)) / 10) }));
    });

    const judge = createRemoteJudge({
      endpoint: 'https://w.test/entail',
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      batchSize: 2,
    });

    expect(await judge(many)).toEqual([0, 0.1, 0.2, 0.3, 0.4]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('calls nothing for an empty batch', async () => {
    const fetchImpl = responding({ scores: [] });
    const judge = createRemoteJudge({ endpoint: 'https://w.test/entail', fetch: fetchImpl });
    expect(await judge([])).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('ENTAILMENT_SCHEMA', () => {
  it('offers exactly the labels the parser understands', () => {
    expect([...ENTAILMENT_SCHEMA.properties.verdicts.items.properties.label.enum]).toEqual([
      'supported',
      'partially_supported',
      'not_supported',
    ]);
  });
});
