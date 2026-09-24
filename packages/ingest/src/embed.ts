/**
 * Query and document embeddings via Cloudflare Workers AI.
 *
 * The same model runs at build time and at query time — a different model on
 * either side puts the query in a different space from the index, which
 * degrades silently rather than failing.
 */

export const EMBEDDING_MODEL = '@cf/baai/bge-small-en-v1.5';
export const EMBEDDING_DIMS = 384;

/**
 * bge-v1.5 is trained with an asymmetric instruction: queries carry a prefix,
 * documents do not. Omitting it costs a few points of recall for no reason.
 */
export const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

/**
 * Two ways to reach the same model.
 *
 * The REST API needs its own token. The deployed worker already holds the
 * Workers AI binding, so pointing at it indexes the corpus without a second
 * credential — the worker is the thing that was going to serve queries anyway.
 */
export type Backend =
  | { kind: 'rest'; accountId: string; apiToken: string }
  | { kind: 'worker'; url: string };

/**
 * Batch size per request.
 *
 * Through the worker the batch is larger, because the worker rate-limits by
 * request: 1,592 chunks in batches of 100 is 16 requests, which fits inside one
 * window. Over REST the limit is on tokens, so smaller batches retry cheaply.
 */
const BATCH = { rest: 50, worker: 100 } as const;

export function backendFromEnv(env: NodeJS.ProcessEnv = process.env): Backend {
  const accountId = env['CLOUDFLARE_ACCOUNT_ID'];
  const apiToken = env['CLOUDFLARE_API_TOKEN'];
  if (accountId && apiToken) return { kind: 'rest', accountId, apiToken };

  const url = env['VITE_WORKER_URL'] ?? env['RAG_WORKER_URL'];
  if (url) return { kind: 'worker', url: url.replace(/\/$/, '') };

  throw new Error(
    'No way to reach the embedding model.\n' +
      '  Either CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN (a token with "Workers AI: Read"),\n' +
      '  or VITE_WORKER_URL pointing at a deployed worker.\n' +
      'Put them in .env at the repo root, or export them.',
  );
}

type RestResponse = {
  success: boolean;
  errors?: { code: number; message: string }[];
  result?: { data: number[][] };
};

const request = (backend: Backend, texts: string[]): [string, RequestInit] =>
  backend.kind === 'rest'
    ? [
        `https://api.cloudflare.com/client/v4/accounts/${backend.accountId}/ai/run/${EMBEDDING_MODEL}`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${backend.apiToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ text: texts }),
        },
      ]
    : [
        `${backend.url}/embed`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ texts }),
        },
      ];

/** Pulls the vectors out of whichever shape the backend answered with. */
async function vectorsFrom(backend: Backend, response: Response): Promise<number[][]> {
  if (backend.kind === 'worker') {
    const body = (await response.json()) as { vectors?: number[][]; error?: string };
    if (!response.ok || !body.vectors) throw new Error(body.error ?? `worker returned ${response.status}`);
    return body.vectors;
  }

  const body = (await response.json()) as RestResponse;
  if (!response.ok || !body.success || !body.result) {
    const detail = body.errors?.map((e) => `${e.code} ${e.message}`).join('; ') ?? response.statusText;
    throw new Error(`Workers AI request failed: ${detail}`);
  }
  return body.result.data;
}

/**
 * Retries a throttled or failing request.
 *
 * Both backends meter per minute, so a 429 is worth waiting out rather than
 * failing an ingest an hour in. The window is 60 seconds, so the backoff has to
 * be able to reach it — six attempts top out at 32 seconds each, 63 in total.
 *
 * Every caller goes through here. The first version had it only in the batch
 * path, which meant embedding the corpus survived a rate limit and evaluating
 * the golden set — forty separate queries — did not.
 */
async function withBackoff(send: () => Promise<Response>, what: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await send();
    if (response.status !== 429 && response.status < 500) return response;

    if (attempt >= 6) throw new Error(`${what} kept returning ${response.status}`);
    const wait = 2 ** attempt * 1000;
    process.stderr.write(`  ${response.status}, retrying in ${wait / 1000}s\n`);
    await new Promise((r) => setTimeout(r, wait));
  }
}

const asVector = (vector: number[]): Float32Array => {
  if (vector.length !== EMBEDDING_DIMS) {
    throw new Error(`expected ${EMBEDDING_DIMS} dims, got ${vector.length}`);
  }
  return Float32Array.from(vector);
};

async function runBatch(texts: string[], backend: Backend): Promise<Float32Array[]> {
  const response = await withBackoff(() => {
    const [url, init] = request(backend, texts);
    return fetch(url, init);
  }, backend.kind);

  return (await vectorsFrom(backend, response)).map(asVector);
}

/** Embeds in order; the returned array lines up with the input. */
export async function embedTexts(
  texts: readonly string[],
  backend: Backend = backendFromEnv(),
  onProgress?: (done: number, total: number) => void,
): Promise<Float32Array[]> {
  const size = BATCH[backend.kind];
  const out: Float32Array[] = [];

  for (let i = 0; i < texts.length; i += size) {
    out.push(...(await runBatch(texts.slice(i, i + size), backend)));
    onProgress?.(Math.min(i + size, texts.length), texts.length);
  }
  return out;
}

/**
 * A query, which needs the instruction prefix.
 *
 * Against the worker this goes through its `query` mode, which applies the
 * prefix itself — so the prefix is added here only for the REST path, and never
 * twice.
 */
export const embedQuery = async (query: string, backend: Backend = backendFromEnv()): Promise<Float32Array> => {
  if (backend.kind === 'rest') return (await embedTexts([QUERY_PREFIX + query], backend))[0]!;

  const response = await withBackoff(
    () =>
      fetch(`${backend.url}/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
      }),
    'worker',
  );

  const body = (await response.json()) as { vector?: number[]; error?: string };
  if (!response.ok || !body.vector) throw new Error(body.error ?? `worker returned ${response.status}`);
  return asVector(body.vector);
};

/**
 * What actually gets embedded for a chunk. The heading path goes in because a
 * criterion's number lives in its heading, not in its prose — a chunk about
 * 2.4.11 that never writes "2.4.11" would otherwise be unreachable by meaning.
 */
export const documentText = (chunk: { headingPath: string[]; text: string }): string =>
  `${chunk.headingPath.join(' > ')}\n${chunk.text}`;
