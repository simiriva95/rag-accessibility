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
  modelsOf,
  rerank,
  type Ai,
  type Env,
} from './worker.ts';

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

  it('retries a busy model, then moves to the next one', async () => {
    const tried: string[] = [];
    const fetchMock = vi.fn(async (url: unknown) => {
      const model = String(url).match(/models\/([^:]+):/)?.[1] ?? '?';
      tried.push(model);
      // The first model is busy however often it is asked; the second answers.
      if (tried.filter((m) => m === model).length <= 3 && model === 'busy') {
        return new Response(JSON.stringify({ error: { message: 'high demand' } }), { status: 503 });
      }
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await answer('q', candidates, { GEMINI_API_KEY: 'k', GEMINI_MODEL: 'busy, spare' });

    expect('answer' in result && result.model).toBe('spare');
    expect(tried.filter((m) => m === 'busy')).toHaveLength(3); // tried, then retried twice
    expect(tried.at(-1)).toBe('spare');
    vi.unstubAllGlobals();
  }, 20_000);

  it('does not retry a refusal that will not change', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 400 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await answer('q', candidates, { GEMINI_API_KEY: 'k', GEMINI_MODEL: 'one, two' });

    // One attempt per model: a bad key is not going to become a good one.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect('degraded' in result && result.degraded.reason).toMatch(/API key not valid/);
    vi.unstubAllGlobals();
  });

  it('reports every model that failed, not just the last', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        const model = String(url).match(/models\/([^:]+):/)?.[1] ?? '?';
        return model === 'busy'
          ? new Response(JSON.stringify({ error: { message: 'high demand' } }), { status: 503 })
          : new Response(JSON.stringify({ error: { message: 'no longer available' } }), { status: 404 });
      }),
    );

    const result = await answer('q', candidates, { GEMINI_API_KEY: 'k', GEMINI_MODEL: 'busy, retired' });
    const reason = 'degraded' in result ? result.degraded.reason : '';

    // Naming only the last one blames a retired model for a congestion outage.
    expect(reason).toMatch(/busy:.*high demand/);
    expect(reason).toMatch(/retired:.*no longer available/);
    vi.unstubAllGlobals();
  }, 20_000);

  it('degrades rather than inventing when generation is unavailable', async () => {
    // No key and no binding: every model in the default chain says why it could not run.
    const nothing = await answer('q', candidates, {});
    expect('degraded' in nothing && nothing.degraded.reason).toMatch(/gemini-.*: no generation key configured/);
    expect('degraded' in nothing && nothing.degraded.reason).toMatch(/@cf\/.*: no Workers AI binding/);

    vi.stubGlobal('fetch', geminiReturning({}, false));
    const result = await answer('q', candidates, { GEMINI_API_KEY: 'k', GEMINI_MODEL: 'only' });
    // The reason now names the model, because several may have been tried.
    expect(result).toEqual({ degraded: { reason: 'only: generation returned 500' } });
    vi.unstubAllGlobals();
  });

  it('falls back to Workers AI when every Gemini model is out of quota', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), { status: 400 })),
    );
    const calls: { model: string; input: Record<string, unknown> }[] = [];
    const AI: Ai = {
      run: async (model, input) => {
        calls.push({ model, input: input as Record<string, unknown> });
        return { response: payload };
      },
    };

    const result = await answer('q', candidates, { GEMINI_API_KEY: 'k', GEMINI_MODEL: 'gemini-x, @cf/meta/llama', AI });

    expect('answer' in result && result.model).toBe('@cf/meta/llama');
    expect(calls[0]!.input['response_format']).toMatchObject({ type: 'json_schema' });
    // The platform default of 256 tokens would cut a cited answer mid-claim.
    expect(calls[0]!.input['max_tokens']).toBeGreaterThan(256);
    vi.unstubAllGlobals();
  });

  it('runs on Workers AI alone when no Gemini key is configured', async () => {
    const AI = aiReturning({ response: JSON.stringify(payload) });
    const result = await answer('q', candidates, { GEMINI_MODEL: '@cf/meta/llama', AI });
    expect('answer' in result && result.answer.claims[0]!.sentence).toBe('Focus must stay visible.');
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
  // 400, not 429: a 429 is now retried across the whole model chain, which is
  // the behaviour covered separately under `answer`.
  const verdicts = (body: unknown, ok = true) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status: ok ? 200 : 400 }));

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

describe('modelsOf', () => {
  it('falls back to the default chain when nothing is configured', () => {
    // An empty array is truthy: `|| DEFAULT` would leave the list empty.
    expect(modelsOf({})).toContain('gemini-2.5-flash');
    expect(modelsOf({ GEMINI_MODEL: '' })).toContain('gemini-2.5-flash');
    expect(modelsOf({ GEMINI_MODEL: ' , ' })).toContain('gemini-2.5-flash');
  });

  it('takes a comma-separated list in order', () => {
    expect(modelsOf({ GEMINI_MODEL: 'a, b ,c' })).toEqual(['a', 'b', 'c']);
  });

  it('offers more than one model by default', () => {
    // A free tier answers "high demand" on an ordinary afternoon.
    expect(modelsOf({}).length).toBeGreaterThan(1);
  });

  it('carries no model the provider has retired', () => {
    // gemini-2.0-flash was in the chain until Google answered 404 for it.
    expect(modelsOf({})).not.toContain('gemini-2.0-flash');
    // Google answers 404 for this one; Cloudflare deprecated the other on 2026-05-30.
    expect(modelsOf({})).not.toContain('gemini-2.5-flash-lite');
    expect(modelsOf({})).not.toContain('@cf/meta/llama-3.1-8b-instruct');
  });

  it('ends on a provider that needs no key, so an exhausted Gemini quota is not an outage', () => {
    expect(modelsOf({}).at(-1)).toMatch(/^@cf\//);
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
