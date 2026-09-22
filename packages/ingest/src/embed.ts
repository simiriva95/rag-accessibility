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

/** Workers AI caps a batch; 50 keeps requests small enough to retry cheaply. */
const BATCH = 50;

type Credentials = { accountId: string; apiToken: string };

export function credentialsFromEnv(env: NodeJS.ProcessEnv = process.env): Credentials {
  const accountId = env['CLOUDFLARE_ACCOUNT_ID'];
  const apiToken = env['CLOUDFLARE_API_TOKEN'];
  if (!accountId || !apiToken) {
    throw new Error(
      'Missing Workers AI credentials.\n' +
        '  CLOUDFLARE_ACCOUNT_ID  — dash.cloudflare.com, in the URL or the sidebar\n' +
        '  CLOUDFLARE_API_TOKEN   — a token with the "Workers AI: Read" permission\n' +
        'Put both in .env at the repo root, or export them.',
    );
  }
  return { accountId, apiToken };
}

type RunResponse = {
  success: boolean;
  errors?: { code: number; message: string }[];
  result?: { data: number[][] };
};

async function runBatch(texts: string[], { accountId, apiToken }: Credentials): Promise<Float32Array[]> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${EMBEDDING_MODEL}`;

  // Free-tier quota is per minute, so a 429 is worth waiting out rather than
  // failing the whole ingest after an hour of work.
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: texts }),
    });

    if (response.status === 429 || response.status >= 500) {
      if (attempt >= 5) throw new Error(`Workers AI kept returning ${response.status}`);
      const wait = 2 ** attempt * 1000;
      process.stderr.write(`  ${response.status} from Workers AI, retrying in ${wait / 1000}s\n`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }

    const body = (await response.json()) as RunResponse;
    if (!response.ok || !body.success || !body.result) {
      const detail = body.errors?.map((e) => `${e.code} ${e.message}`).join('; ') ?? response.statusText;
      throw new Error(`Workers AI request failed: ${detail}`);
    }

    return body.result.data.map((vector) => {
      if (vector.length !== EMBEDDING_DIMS) {
        throw new Error(`expected ${EMBEDDING_DIMS} dims, got ${vector.length}`);
      }
      return Float32Array.from(vector);
    });
  }
}

/** Embeds in order; the returned array lines up with the input. */
export async function embedTexts(
  texts: readonly string[],
  credentials: Credentials = credentialsFromEnv(),
  onProgress?: (done: number, total: number) => void,
): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    out.push(...(await runBatch(texts.slice(i, i + BATCH), credentials)));
    onProgress?.(Math.min(i + BATCH, texts.length), texts.length);
  }
  return out;
}

export const embedQuery = async (query: string, credentials?: Credentials): Promise<Float32Array> =>
  (await embedTexts([QUERY_PREFIX + query], credentials))[0]!;

/**
 * What actually gets embedded for a chunk. The heading path goes in because a
 * criterion's number lives in its heading, not in its prose — a chunk about
 * 2.4.11 that never writes "2.4.11" would otherwise be unreachable by meaning.
 */
export const documentText = (chunk: { headingPath: string[]; text: string }): string =>
  `${chunk.headingPath.join(' > ')}\n${chunk.text}`;
