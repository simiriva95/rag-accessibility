import { describe, expect, it, vi } from 'vitest';
import {
  EMBEDDING_DIMS,
  EMBEDDING_MODEL,
  RERANKER_MODEL,
  answer,
  embed,
  embedDocuments,
  entail,
  handle,
  rerank,
  type Ai,
  type Env,
} from './index.ts';

/**
 * The bindings are stubbed rather than emulated. What is worth testing here is
 * the behaviour when a model misbehaves or is unavailable — which is exactly
 * what a real binding will not do on demand.
 */

const vector = (n = EMBEDDING_DIMS) => Array.from({ length: n }, (_, i) => i / n);

const aiReturning = (result: unknown): Ai => ({ run: async () => result });
const aiThrowing = (message: string): Ai => ({
  run: async () => {
    throw new Error(message);
  },
});

const candidates = [
  { id: 'a', text: 'Focus must remain visible.' },
  { id: 'b', text: 'Contrast must be at least 4.5:1.' },
  { id: 'c', text: 'Unrelated.' },
];

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://worker.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('embed', () => {
  it('applies the query prefix, since a client cannot be trusted to', async () => {
    const run = vi.fn(async () => ({ data: [vector()] }));
    await embed('how much contrast', { AI: { run } });

    expect(run).toHaveBeenCalledWith(EMBEDDING_MODEL, {
      text: ['Represent this sentence for searching relevant passages: how much contrast'],
    });
  });

  it('rejects a vector of the wrong width instead of returning it', async () => {
    // A silently short vector would corrupt every cosine in the index.
    await expect(embed('q', { AI: aiReturning({ data: [vector(128)] }) })).rejects.toThrow(/128 dimensions/);
    await expect(embed('q', { AI: aiReturning({}) })).rejects.toThrow(/0 vectors for 1 texts/);
  });

  it('fails when there is no binding, because there is no fallback', async () => {
    await expect(embed('q', {})).rejects.toThrow(/no Workers AI binding/);
  });
});

describe('embedDocuments', () => {
  it('sends the documents unprefixed, unlike a query', async () => {
    const run = vi.fn(async () => ({ data: [vector(), vector()] }));
    await embedDocuments(['first chunk', 'second chunk'], { AI: { run } });

    // Prefixing a document puts it in the query's space and costs recall.
    expect(run).toHaveBeenCalledWith(EMBEDDING_MODEL, { text: ['first chunk', 'second chunk'] });
  });

  it('refuses a short batch rather than misaligning vectors with chunks', async () => {
    // One vector for two texts would pair every later chunk with the wrong one.
    await expect(
      embedDocuments(['a', 'b'], { AI: aiReturning({ data: [vector()] }) }),
    ).rejects.toThrow(/1 vectors for 2 texts/);
  });

  it('refuses a vector of the wrong width', async () => {
    await expect(
      embedDocuments(['a'], { AI: aiReturning({ data: [vector(128)] }) }),
    ).rejects.toThrow(/128 dimensions/);
  });
});

describe('rerank', () => {
  it('reorders by the model score and maps indices back to ids', async () => {
    const result = await rerank('contrast', candidates, {
      AI: aiReturning({ response: [{ id: 1, score: 0.9 }, { id: 0, score: 0.4 }] }),
    });
    expect(result.results).toEqual([
      { id: 'b', score: 0.9 },
      { id: 'a', score: 0.4 },
    ]);
    expect(result.degraded).toBeUndefined();
  });

  it('honours topK', async () => {
    const result = await rerank(
      'q',
      candidates,
      { AI: aiReturning({ response: [{ id: 0, score: 1 }, { id: 1, score: 0.5 }] }) },
      1,
    );
    expect(result.results).toHaveLength(1);
  });

  it('falls back to the given order and says so when the model fails', async () => {
    const result = await rerank('q', candidates, { AI: aiThrowing('429 rate limited') });
    expect(result.results.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(result.degraded?.reason).toMatch(/429/);
  });

  it('degrades on an empty or unusable response rather than returning nothing', async () => {
    const empty = await rerank('q', candidates, { AI: aiReturning({ response: [] }) });
    expect(empty.results).toHaveLength(3);
    expect(empty.degraded).toBeDefined();

    const bogus = await rerank('q', candidates, { AI: aiReturning({ response: [{ id: 99, score: 1 }] }) });
    expect(bogus.results).toHaveLength(3);
    expect(bogus.degraded?.reason).toMatch(/usable indices/);
  });

  it('degrades when there is no binding at all', async () => {
    const result = await rerank('q', candidates, {});
    expect(result.degraded?.reason).toMatch(/no Workers AI binding/);
  });

  it('sends the candidate text, not the ids', async () => {
    const run = vi.fn(async () => ({ response: [{ id: 0, score: 1 }] }));
    await rerank('contrast', candidates, { AI: { run } });
    expect(run).toHaveBeenCalledWith(RERANKER_MODEL, {
      query: 'contrast',
      contexts: candidates.map((c) => ({ text: c.text })),
    });
  });
});

describe('answer', () => {
  const payload = {
    answerable: true,
    sentences: ['Focus must stay visible.'],
    claims: [{ sentenceIndex: 0, chunkIds: ['a'], quote: 'Focus must remain visible.' }],
  };

  const geminiReturning = (body: unknown, ok = true) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 }));

  it('parses a well-formed generation', async () => {
    const fetchMock = geminiReturning({
      candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }],
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await answer('q', candidates, { GEMINI_API_KEY: 'k' });
    expect('answer' in result && result.answer.claims[0]!.sentence).toBe('Focus must stay visible.');
    vi.unstubAllGlobals();
  });

  it('puts the key in a header, never in the URL', async () => {
    const fetchMock = geminiReturning({
      candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }],
    });
    vi.stubGlobal('fetch', fetchMock);

    await answer('q', candidates, { GEMINI_API_KEY: 'secret-key' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain('secret-key');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('secret-key');
    vi.unstubAllGlobals();
  });

  it('degrades rather than inventing when generation is unavailable', async () => {
    expect(await answer('q', candidates, {})).toEqual({
      degraded: { reason: 'no generation key configured' },
    });

    vi.stubGlobal('fetch', geminiReturning({}, false));
    expect(await answer('q', candidates, { GEMINI_API_KEY: 'k' })).toEqual({
      degraded: { reason: 'generation returned 500' },
    });
    vi.unstubAllGlobals();
  });

  it('degrades on unparseable output instead of throwing at the caller', async () => {
    vi.stubGlobal('fetch', geminiReturning({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] }));
    const result = await answer('q', candidates, { GEMINI_API_KEY: 'k' });
    expect('degraded' in result).toBe(true);
    vi.unstubAllGlobals();
  });

  it('includes every source with its id, so a claim can cite one', async () => {
    const fetchMock = geminiReturning({
      candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }],
    });
    vi.stubGlobal('fetch', fetchMock);

    await answer('q', candidates, { GEMINI_API_KEY: 'k' });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(init.body as string);
    const prompt = sent.contents[0].parts[0].text as string;
    for (const candidate of candidates) expect(prompt).toContain(`<source id="${candidate.id}">`);
    expect(sent.generationConfig.responseSchema.required).toContain('answerable');
    vi.unstubAllGlobals();
  });
});

describe('entail', () => {
  const verdicts = (body: unknown, ok = true) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status: ok ? 200 : 429 }));

  const pairs = [
    { sentence: 'Focus must stay visible.', evidence: 'The component is not entirely hidden.' },
    { sentence: 'Contrast must be 4.5:1.', evidence: 'Unrelated text about page titles.' },
  ];

  it('maps the three labels onto scores, positionally', async () => {
    vi.stubGlobal(
      'fetch',
      verdicts({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    verdicts: [
                      { index: 1, label: 'not_supported' },
                      { index: 0, label: 'supported' },
                    ],
                  }),
                },
              ],
            },
          },
        ],
      }),
    );

    expect(await entail(pairs, { GEMINI_API_KEY: 'k' })).toEqual([1, 0]);
    vi.unstubAllGlobals();
  });

  it('returns nulls, not zeroes, when it cannot judge', async () => {
    // A rate limit is not a verdict of "unsupported".
    expect(await entail(pairs, {})).toEqual([null, null]);

    vi.stubGlobal('fetch', verdicts({}, false));
    expect(await entail(pairs, { GEMINI_API_KEY: 'k' })).toEqual([null, null]);
    vi.unstubAllGlobals();

    vi.stubGlobal('fetch', verdicts({ candidates: [{ content: { parts: [{ text: 'nonsense' }] } }] }));
    expect(await entail(pairs, { GEMINI_API_KEY: 'k' })).toEqual([null, null]);
    vi.unstubAllGlobals();
  });

  it('numbers the pairs in the prompt so verdicts can be matched back', async () => {
    const fetchMock = verdicts({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ verdicts: [] }) }] } }],
    });
    vi.stubGlobal('fetch', fetchMock);

    await entail(pairs, { GEMINI_API_KEY: 'k' });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(init.body as string);
    const prompt = sent.contents[0].parts[0].text as string;

    expect(prompt).toContain('<pair index="0">');
    expect(prompt).toContain('<pair index="1">');
    expect(sent.generationConfig.responseSchema.required).toContain('verdicts');
    vi.unstubAllGlobals();
  });
});

describe('handle', () => {
  const ai: Env = { AI: aiReturning({ data: [vector()], response: [{ id: 0, score: 1 }] }) };

  it('answers a preflight without touching a model', async () => {
    const response = await handle(new Request('https://worker.test/embed', { method: 'OPTIONS' }), {});
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('rejects anything but POST, and unknown paths', async () => {
    expect((await handle(new Request('https://worker.test/embed'), {})).status).toBe(405);
    expect((await handle(post('/nope', {}), {})).status).toBe(404);
  });

  it('routes to the document mode when texts are given, not a query', async () => {
    const run = vi.fn(async (_model: string, _input: unknown) => ({ data: [vector(), vector()] }));
    const response = await handle(post('/embed', { texts: ['one', 'two'] }), { AI: { run } });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { vectors: number[][]; dims: number };
    expect(body.vectors).toHaveLength(2);
    expect(body.dims).toBe(EMBEDDING_DIMS);
    expect(run).toHaveBeenCalledWith(EMBEDDING_MODEL, { text: ['one', 'two'] });
  });

  it('caps a document batch so one call cannot embed the world', async () => {
    const many = Array.from({ length: 101 }, (_, i) => `chunk ${i}`);
    expect((await handle(post('/embed', { texts: many }), {})).status).toBe(400);
    expect((await handle(post('/embed', { texts: [] }), {})).status).toBe(400);
    expect((await handle(post('/embed', { texts: ['ok', 42] }), {})).status).toBe(400);
  });

  it('validates input before spending quota', async () => {
    const run = vi.fn();
    const env: Env = { AI: { run } };

    expect((await handle(post('/embed', {}), env)).status).toBe(400);
    expect((await handle(post('/embed', { query: '   ' }), env)).status).toBe(400);
    expect((await handle(post('/embed', { query: 'x'.repeat(513) }), env)).status).toBe(400);
    expect((await handle(post('/rerank', { query: 'q', candidates: [] }), env)).status).toBe(400);
    expect(
      (await handle(post('/rerank', { query: 'q', candidates: Array(31).fill({ id: 'a', text: 'b' }) }), env))
        .status,
    ).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects a body that is not JSON', async () => {
    const request = new Request('https://worker.test/embed', { method: 'POST', body: '{' });
    expect((await handle(request, {})).status).toBe(400);
  });

  it('caps the number of sources a single call can carry', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, text: 'x' }));
    const response = await handle(post('/answer', { question: 'q', sources: many }), {});
    expect(response.status).toBe(400);
  });

  it('truncates an oversized chunk rather than rejecting the call', async () => {
    const run = vi.fn(async () => ({ response: [{ id: 0, score: 1 }] }));
    await handle(
      post('/rerank', { query: 'q', candidates: [{ id: 'a', text: 'x'.repeat(5000) }] }),
      { AI: { run } },
    );
    const [, input] = run.mock.calls[0] as unknown as [string, { contexts: { text: string }[] }];
    expect(input.contexts[0]!.text).toHaveLength(2400);
  });

  it('returns 503 when embedding cannot run, since it has no fallback', async () => {
    const response = await handle(post('/embed', { query: 'q' }), {});
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'no Workers AI binding' });
  });

  it('returns 200 with a degraded flag when reranking cannot run', async () => {
    const response = await handle(post('/rerank', { query: 'q', candidates }), {});
    expect(response.status).toBe(200);
    const body = (await response.json()) as { degraded?: unknown; results: unknown[] };
    expect(body.degraded).toBeDefined();
    expect(body.results).toHaveLength(3);
  });

  it('embeds through the full route', async () => {
    const response = await handle(post('/embed', { query: 'q' }), ai);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ vector: vector(), dims: EMBEDDING_DIMS });
  });

  it('rate limits per IP and refuses before spending quota', async () => {
    const run = vi.fn();
    const limit = vi.fn(async () => ({ success: false }));
    const response = await handle(post('/embed', { query: 'q' }, { 'cf-connecting-ip': '203.0.113.9' }), {
      AI: { run },
      RATE_LIMITER: { limit },
    });

    expect(response.status).toBe(429);
    expect(limit).toHaveBeenCalledWith({ key: '203.0.113.9' });
    expect(run).not.toHaveBeenCalled();
  });

  it('serves the request when the limiter allows it', async () => {
    const response = await handle(post('/embed', { query: 'q' }), {
      ...ai,
      RATE_LIMITER: { limit: async () => ({ success: true }) },
    });
    expect(response.status).toBe(200);
  });

  it('allows the request when no limiter is configured, rather than going dark', async () => {
    expect((await handle(post('/embed', { query: 'q' }), ai)).status).toBe(200);
  });

  it('validates entailment pairs before spending quota', async () => {
    expect((await handle(post('/entail', { pairs: [] }), {})).status).toBe(400);
    expect((await handle(post('/entail', { pairs: [{ sentence: 'a' }] }), {})).status).toBe(400);
    expect(
      (await handle(post('/entail', { pairs: Array(13).fill({ sentence: 'a', evidence: 'b' }) }), {})).status,
    ).toBe(400);
  });

  it('answers /entail with nulls rather than failing when no key is set', async () => {
    const response = await handle(
      post('/entail', { pairs: [{ sentence: 'a', evidence: 'b' }] }),
      {},
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ scores: [null] });
  });

  it('puts CORS headers on every response, errors included', async () => {
    for (const response of [
      await handle(post('/embed', { query: 'q' }), ai),
      await handle(post('/embed', {}), ai),
      await handle(post('/nope', {}), ai),
    ]) {
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
    }
  });
});
