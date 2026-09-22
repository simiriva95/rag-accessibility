import { ANSWER_SCHEMA, parseModelAnswer, type ParsedAnswer } from '@rag/core';

/**
 * The three things that cannot be precomputed: query embedding, reranking,
 * generation. Everything else is a static file.
 *
 * Every endpoint has a defined behaviour when its model is unavailable, because
 * the demo has to stay useful when the free tier says no. Reranking falls back
 * to the order it was given; generation falls back to nothing and the app shows
 * retrieval only. Neither silently pretends to have run.
 */

export const EMBEDDING_MODEL = '@cf/baai/bge-small-en-v1.5';
export const RERANKER_MODEL = '@cf/baai/bge-reranker-base';
export const EMBEDDING_DIMS = 384;

/** bge-v1.5 is asymmetric. Applied here so a client cannot get it wrong. */
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

/**
 * Input caps. Rate limiting bounds how often someone can call this; these bound
 * what one call can cost. Without them a single request can spend more quota
 * than a day of honest use.
 */
const LIMITS = {
  query: 512,
  candidates: 30,
  sources: 8,
  chunkChars: 2400,
} as const;

const RERANK_OUT = 8;

/** Minimal shapes of the bindings, so the worker needs no type dependency. */
export type Ai = { run(model: string, input: unknown): Promise<unknown> };
export type RateLimiter = { limit(options: { key: string }): Promise<{ success: boolean }> };

export type Env = {
  AI?: Ai;
  RATE_LIMITER?: RateLimiter;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
};

export type Chunkish = { id: string; text: string };

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS },
  });

const fail = (status: number, reason: string) => json({ error: reason }, status);

class BadRequest extends Error {}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new BadRequest(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed === '') throw new BadRequest(`${field} must not be empty`);
  if (trimmed.length > max) throw new BadRequest(`${field} must be at most ${max} characters`);
  return trimmed;
}

/** Chunks are truncated rather than rejected: a long one is our fault, not the caller's. */
function chunks(value: unknown, field: string, max: number): Chunkish[] {
  if (!Array.isArray(value)) throw new BadRequest(`${field} must be an array`);
  if (value.length === 0) throw new BadRequest(`${field} must not be empty`);
  if (value.length > max) throw new BadRequest(`${field} must hold at most ${max} items`);

  return value.map((item, i) => {
    if (typeof item !== 'object' || item === null) throw new BadRequest(`${field}[${i}] must be an object`);
    const { id, text: body } = item as Record<string, unknown>;
    if (typeof id !== 'string' || id === '') throw new BadRequest(`${field}[${i}].id must be a string`);
    if (typeof body !== 'string') throw new BadRequest(`${field}[${i}].text must be a string`);
    return { id, text: body.slice(0, LIMITS.chunkChars) };
  });
}

// ── embedding ───────────────────────────────────────────────────────────────

export async function embed(query: string, env: Env): Promise<number[]> {
  if (!env.AI) throw new Error('no Workers AI binding');

  const result = (await env.AI.run(EMBEDDING_MODEL, { text: [QUERY_PREFIX + query] })) as {
    data?: number[][];
  };
  const vector = result?.data?.[0];
  if (!vector || vector.length !== EMBEDDING_DIMS) {
    throw new Error(`embedding returned ${vector?.length ?? 0} dimensions, expected ${EMBEDDING_DIMS}`);
  }
  return vector;
}

// ── reranking ───────────────────────────────────────────────────────────────

export type RerankResult = {
  results: { id: string; score: number }[];
  /** Present when the reranker did not run. The UI says so rather than hiding it. */
  degraded?: { reason: string };
};

/**
 * Reranks, or returns the given order untouched.
 *
 * Reranking burns far more of the free quota than embedding, so it is the first
 * thing to fail. Falling back to the fused order is a real degradation — the
 * results are worse, not different — and saying so is the only honest option.
 */
export async function rerank(
  query: string,
  candidates: Chunkish[],
  env: Env,
  topK = RERANK_OUT,
): Promise<RerankResult> {
  const untouched = candidates.slice(0, topK).map((c, i) => ({ id: c.id, score: 1 - i / candidates.length }));

  if (!env.AI) return { results: untouched, degraded: { reason: 'no Workers AI binding' } };

  try {
    const result = (await env.AI.run(RERANKER_MODEL, {
      query,
      contexts: candidates.map((c) => ({ text: c.text })),
    })) as { response?: { id: number; score: number }[] };

    const ranked = result?.response;
    if (!Array.isArray(ranked) || ranked.length === 0) throw new Error('reranker returned nothing');

    const results = ranked
      .filter((item) => candidates[item.id] !== undefined)
      .slice(0, topK)
      .map((item) => ({ id: candidates[item.id]!.id, score: item.score }));

    if (results.length === 0) throw new Error('reranker returned no usable indices');
    return { results };
  } catch (error) {
    return { results: untouched, degraded: { reason: (error as Error).message } };
  }
}

// ── generation ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You answer questions about web accessibility using only the sources provided.

Rules:
- Use only the sources below. Do not use anything you know from elsewhere.
- If the sources do not answer the question, set answerable to false and explain what is missing. Do not guess. Declining is a correct answer.
- Write the answer as separate sentences, one per item in "sentences".
- For every sentence that states a fact, add a claim citing the sources it came from.
- "quote" must be copied character for character from one of the chunks you cite. Do not paraphrase it, do not shorten it with an ellipsis, do not join two separate passages. A quote that is not in the source is treated as a fabrication.
- Prefer a short exact quote over a long approximate one.`;

const sourceBlock = (sources: Chunkish[]) =>
  sources.map((source) => `<source id="${source.id}">\n${source.text}\n</source>`).join('\n\n');

export type AnswerResult = ParsedAnswer | { degraded: { reason: string } };

/**
 * Generates an answer, or reports why it could not.
 *
 * Generation is the one part of the pipeline the project can live without: the
 * retrieval is most of the value, and an app that shows sources with no prose
 * is still an app. So a failure here returns a reason, never a fabricated
 * answer and never an empty one dressed up as a refusal.
 */
export async function answer(question: string, sources: Chunkish[], env: Env): Promise<AnswerResult> {
  if (!env.GEMINI_API_KEY) return { degraded: { reason: 'no generation key configured' } };

  const model = env.GEMINI_MODEL ?? 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ parts: [{ text: `${sourceBlock(sources)}\n\nQuestion: ${question}` }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: ANSWER_SCHEMA,
          temperature: 0,
        },
      }),
    });

    if (!response.ok) {
      return { degraded: { reason: `generation returned ${response.status}` } };
    }

    const body = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const raw = body.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return { degraded: { reason: 'generation returned no content' } };

    return parseModelAnswer(JSON.parse(raw));
  } catch (error) {
    return { degraded: { reason: (error as Error).message } };
  }
}

// ── routing ─────────────────────────────────────────────────────────────────

/**
 * Per-IP rate limiting through the platform's own binding — no Durable Object,
 * no KV, nothing to keep running. A missing binding allows the request: a demo
 * that must stay up for years should not go dark over a configuration slip,
 * and the input caps still bound what any single call can cost.
 */
async function allowed(request: Request, env: Env): Promise<boolean> {
  if (!env.RATE_LIMITER) return true;
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const { success } = await env.RATE_LIMITER.limit({ key: ip });
  return success;
}

export async function handle(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return fail(405, 'use POST');

  const { pathname } = new URL(request.url);
  if (!['/embed', '/rerank', '/answer'].includes(pathname)) return fail(404, 'no such endpoint');

  if (!(await allowed(request, env))) return fail(429, 'rate limit exceeded, try again shortly');

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'body is not valid JSON');
  }
  const input = (body ?? {}) as Record<string, unknown>;

  try {
    switch (pathname) {
      case '/embed': {
        const query = text(input['query'], 'query', LIMITS.query);
        return json({ vector: await embed(query, env), dims: EMBEDDING_DIMS });
      }
      case '/rerank': {
        const query = text(input['query'], 'query', LIMITS.query);
        const candidates = chunks(input['candidates'], 'candidates', LIMITS.candidates);
        const topK = Math.min(Number(input['topK']) || RERANK_OUT, RERANK_OUT);
        return json(await rerank(query, candidates, env, topK));
      }
      default: {
        const question = text(input['question'], 'question', LIMITS.query);
        const sources = chunks(input['sources'], 'sources', LIMITS.sources);
        return json(await answer(question, sources, env));
      }
    }
  } catch (error) {
    if (error instanceof BadRequest) return fail(400, error.message);
    // Embedding has no fallback: without a query vector the dense half simply
    // cannot run, and the client degrades to lexical retrieval on its own.
    return fail(503, (error as Error).message);
  }
}

export default { fetch: handle } satisfies { fetch: (r: Request, e: Env) => Promise<Response> };
