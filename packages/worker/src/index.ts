import {
  ANSWER_SCHEMA,
  ENTAILMENT_SCHEMA,
  parseModelAnswer,
  parseVerdicts,
  type EntailmentPair,
  type ParsedAnswer,
} from '@rag/core';

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
  pairs: 12,
  sentence: 1000,
  chunkChars: 2400,
  /**
   * Documents per embedding request. 1,592 chunks in batches of this size is
   * 16 requests, which fits inside one rate-limit window — the ingest finishes
   * without ever being throttled.
   */
  documents: 100,
} as const;

const RERANK_OUT = 8;

/** Minimal shapes of the bindings, so the worker needs no type dependency. */
export type Ai = { run(model: string, input: unknown): Promise<unknown> };
export type RateLimiter = { limit(options: { key: string }): Promise<{ success: boolean }> };

export type Env = {
  AI?: Ai;
  RATE_LIMITER?: RateLimiter;
  GEMINI_API_KEY?: string;
  /** Comma-separated, tried in order. The first that answers wins. */
  GEMINI_MODEL?: string;
};

/**
 * Generation models, in preference order.
 *
 * More than one because a free tier answers "this model is currently
 * experiencing high demand" on an ordinary afternoon, and a demo that has to
 * keep working for years cannot rest on a single model staying popular and
 * uncongested. The fallback is smaller and faster; a worse answer beats no
 * answer, and the verification layer judges either the same way.
 */
const DEFAULT_MODELS = ['gemini-3.6-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];

export function modelsOf(env: Env): string[] {
  const configured = (env.GEMINI_MODEL ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  // An empty array is truthy, so `|| DEFAULT_MODELS` would have silently left
  // the list empty and reported that no model was tried.
  return configured.length > 0 ? configured : DEFAULT_MODELS;
}

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

/** Document texts for the batch embedding mode. Truncated, not rejected. */
function documents(value: unknown): string[] {
  if (!Array.isArray(value)) throw new BadRequest('texts must be an array');
  if (value.length === 0) throw new BadRequest('texts must not be empty');
  if (value.length > LIMITS.documents) {
    throw new BadRequest(`texts must hold at most ${LIMITS.documents} items`);
  }

  return value.map((item, i) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new BadRequest(`texts[${i}] must be a non-empty string`);
    }
    return item.slice(0, LIMITS.chunkChars);
  });
}

// ── embedding ───────────────────────────────────────────────────────────────

async function runEmbedding(texts: string[], env: Env): Promise<number[][]> {
  if (!env.AI) throw new Error('no Workers AI binding');

  const result = (await env.AI.run(EMBEDDING_MODEL, { text: texts })) as { data?: number[][] };
  const vectors = result?.data;

  if (!Array.isArray(vectors) || vectors.length !== texts.length) {
    throw new Error(`embedding returned ${vectors?.length ?? 0} vectors for ${texts.length} texts`);
  }
  for (const vector of vectors) {
    // A silently short vector would corrupt every cosine in the index.
    if (vector?.length !== EMBEDDING_DIMS) {
      throw new Error(`embedding returned ${vector?.length ?? 0} dimensions, expected ${EMBEDDING_DIMS}`);
    }
  }
  return vectors;
}

/** One query, carrying the instruction prefix bge-v1.5 expects. */
export async function embed(query: string, env: Env): Promise<number[]> {
  return (await runEmbedding([QUERY_PREFIX + query], env))[0]!;
}

/**
 * Documents, deliberately without the prefix.
 *
 * bge-v1.5 is asymmetric: prefixing a document puts it in the query's space and
 * quietly costs recall. Keeping the two modes as separate shapes — `query` for
 * one, `texts` for many — means a caller cannot pick the wrong one by accident.
 *
 * This exists so the build-time ingest can index the corpus through the binding
 * rather than needing a second credential. It does widen what the worker will
 * do for an anonymous caller; the batch cap, the per-text cap and the per-IP
 * rate limit are what bound that.
 */
export async function embedDocuments(texts: string[], env: Env): Promise<number[][]> {
  return runEmbedding(texts, env);
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

/**
 * The generation key, trimmed.
 *
 * A secret pasted into a form or piped from a file arrives with a trailing
 * newline more often than not, and whitespace in a header value is rejected
 * before the request reaches anyone who could explain why.
 */
const apiKey = (env: Env): string | undefined => env.GEMINI_API_KEY?.trim() || undefined;

/**
 * Asks each model in turn, retrying the ones that are merely busy.
 *
 * 429 and 503 mean "not now", not "no" — a single attempt turns a passing
 * spike into a visible failure. Two short retries, then the next model. The
 * waits are deliberately small: this runs inside a request someone is waiting
 * on, so the budget is a few seconds, not the minute an offline ingest can
 * afford.
 */
async function generateWith(
  env: Env,
  key: string,
  body: (model: string) => unknown,
): Promise<{ response: Response; model: string } | { failed: string }> {
  const failures: string[] = [];

  for (const model of modelsOf(env)) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify(body(model)),
        },
      );

      if (response.ok) return { response, model };

      const busy = response.status === 429 || response.status === 503;
      if (attempt === 0 || !busy) failures.push(`${model}: ${await upstreamError(response, 'generation')}`);
      if (!busy) break; // a real refusal: try the next model rather than repeat

      if (attempt < 2) await new Promise((r) => setTimeout(r, 2 ** attempt * 800));
    }
  }

  // Every model's own reason, not just the last one's. Reporting only the last
  // blamed a retired model for an outage whose actual cause was the first two
  // being busy — which sends whoever reads it after entirely the wrong thing.
  return { failed: failures.join(' · ') || 'no model was tried' };
}

/**
 * The upstream's own words, not just its status code.
 *
 * "generation returned 400" says a request was malformed without saying which
 * part, which is the difference between a five-minute fix and an afternoon of
 * guessing. The message is truncated and carries no request content, so a
 * degraded reason shown in the UI cannot leak a key or a prompt.
 */
async function upstreamError(response: Response, stage: string): Promise<string> {
  let detail = '';
  try {
    const body = (await response.json()) as { error?: { message?: string; status?: string } };
    detail = body.error?.message ?? body.error?.status ?? '';
  } catch {
    // A non-JSON error body tells us nothing worth surfacing.
  }
  return `${stage} returned ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`;
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

/** `model` names whichever model in the chain actually answered, so the UI can say which one did. */
export type AnswerResult = (ParsedAnswer & { model: string }) | { degraded: { reason: string } };

/**
 * Generates an answer, or reports why it could not.
 *
 * Generation is the one part of the pipeline the project can live without: the
 * retrieval is most of the value, and an app that shows sources with no prose
 * is still an app. So a failure here returns a reason, never a fabricated
 * answer and never an empty one dressed up as a refusal.
 */
export async function answer(question: string, sources: Chunkish[], env: Env): Promise<AnswerResult> {
  const key = apiKey(env);
  if (!key) return { degraded: { reason: 'no generation key configured' } };

  try {
    const attempt = await generateWith(env, key, () => ({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ parts: [{ text: `${sourceBlock(sources)}\n\nQuestion: ${question}` }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: ANSWER_SCHEMA,
        temperature: 0,
      },
    }));

    if ('failed' in attempt) return { degraded: { reason: attempt.failed } };
    const { response, model } = attempt;

    const body = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const raw = body.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return { degraded: { reason: 'generation returned no content' } };

    return { ...parseModelAnswer(JSON.parse(raw)), model };
  } catch (error) {
    return { degraded: { reason: (error as Error).message } };
  }
}

// ── entailment ──────────────────────────────────────────────────────────────

const ENTAILMENT_PROMPT = `You are checking whether a piece of evidence supports a claim. You are not judging whether the claim is true in general — only whether this evidence establishes it.

For each numbered pair, return one verdict:
- supported: the evidence states the claim, or states something the claim follows from directly.
- partially_supported: the evidence is about the same thing and does not contradict the claim, but does not establish it. Use this when the claim adds a detail, a number or a condition the evidence does not give.
- not_supported: the evidence does not establish the claim, or contradicts it.

Return a verdict for every pair, using its index. Do not explain.`;

const pairBlock = (pairs: EntailmentPair[]) =>
  pairs
    .map((pair, i) => `<pair index="${i}">\n<evidence>\n${pair.evidence}\n</evidence>\n<claim>${pair.sentence}</claim>\n</pair>`)
    .join('\n\n');

/**
 * Grades a batch of claim/evidence pairs.
 *
 * A pair that could not be graded comes back null rather than zero. Zero is a
 * verdict; an outage is not, and letting one read as the other would show a
 * rate limit as a fabrication.
 */
export async function entail(pairs: EntailmentPair[], env: Env): Promise<(number | null)[]> {
  const unjudged = () => pairs.map(() => null);
  const key = apiKey(env);
  if (!key) return unjudged();

  try {
    const attempt = await generateWith(env, key, () => ({
      systemInstruction: { parts: [{ text: ENTAILMENT_PROMPT }] },
      contents: [{ parts: [{ text: pairBlock(pairs) }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: ENTAILMENT_SCHEMA,
        temperature: 0,
      },
    }));

    if ('failed' in attempt) {
      console.error(attempt.failed);
      return unjudged();
    }
    const { response } = attempt;

    const body = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const raw = body.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return unjudged();

    return parseVerdicts(JSON.parse(raw), pairs.length);
  } catch {
    return unjudged();
  }
}

function entailmentPairs(value: unknown): EntailmentPair[] {
  if (!Array.isArray(value)) throw new BadRequest('pairs must be an array');
  if (value.length === 0) throw new BadRequest('pairs must not be empty');
  if (value.length > LIMITS.pairs) throw new BadRequest(`pairs must hold at most ${LIMITS.pairs} items`);

  return value.map((item, i) => {
    if (typeof item !== 'object' || item === null) throw new BadRequest(`pairs[${i}] must be an object`);
    const { sentence, evidence } = item as Record<string, unknown>;
    if (typeof sentence !== 'string' || sentence.trim() === '') {
      throw new BadRequest(`pairs[${i}].sentence must be a non-empty string`);
    }
    if (typeof evidence !== 'string' || evidence.trim() === '') {
      throw new BadRequest(`pairs[${i}].evidence must be a non-empty string`);
    }
    return {
      sentence: sentence.slice(0, LIMITS.sentence),
      evidence: evidence.slice(0, LIMITS.chunkChars),
    };
  });
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
  if (!['/embed', '/rerank', '/answer', '/entail'].includes(pathname)) return fail(404, 'no such endpoint');

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
        if (input['texts'] !== undefined) {
          const texts = documents(input['texts']);
          return json({ vectors: await embedDocuments(texts, env), dims: EMBEDDING_DIMS });
        }
        const query = text(input['query'], 'query', LIMITS.query);
        return json({ vector: await embed(query, env), dims: EMBEDDING_DIMS });
      }
      case '/rerank': {
        const query = text(input['query'], 'query', LIMITS.query);
        const candidates = chunks(input['candidates'], 'candidates', LIMITS.candidates);
        const topK = Math.min(Number(input['topK']) || RERANK_OUT, RERANK_OUT);
        return json(await rerank(query, candidates, env, topK));
      }
      case '/entail': {
        const pairs = entailmentPairs(input['pairs']);
        return json({ scores: await entail(pairs, env) });
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
