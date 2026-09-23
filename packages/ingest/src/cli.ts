import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  buildBm25Index,
  encodeDenseVectors,
  quantize,
  type Chunk,
  type NormalizedDoc,
} from '@rag/core';
import { chunkDocument } from './chunk.ts';
import { EMBEDDING_DIMS, credentialsFromEnv, documentText, embedTexts } from './embed.ts';
import { normalizeHtml } from './normalize.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
const RAW = join(ROOT, '.cache/raw');
const CORPUS = join(ROOT, 'data/corpus');
const INDEX = join(ROOT, 'data/index');

const WCAG_URL = 'https://www.w3.org/TR/WCAG22/';
const UNDERSTANDING = /https:\/\/www\.w3\.org\/WAI\/WCAG22\/Understanding\/[a-z0-9-]+\.html/g;

const GOVUK = 'https://design-system.service.gov.uk';
/** Section landing pages; every content page is linked from their navigation. */
const GOVUK_SECTIONS = ['components', 'patterns', 'styles', 'accessibility', 'get-started'];
const GOVUK_LINK = /href="(\/(?:components|patterns|styles|accessibility|get-started)\/[a-z0-9/-]*)"/g;

/** Fetch with an on-disk cache, so re-runs are offline and free. */
async function fetchCached(url: string): Promise<string> {
  const file = join(RAW, url.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9.-]/g, '_') + '.html');
  try {
    return await readFile(file, 'utf8');
  } catch {
    process.stderr.write(`fetch ${url}\n`);
    const res = await fetch(url, { headers: { 'user-agent': 'hybrid-rag-ingest (portfolio project)' } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    const html = await res.text();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, html);
    await new Promise((r) => setTimeout(r, 200)); // be a polite guest on w3.org
    return html;
  }
}

async function wcagDocs(): Promise<NormalizedDoc[]> {
  const specHtml = await fetchCached(WCAG_URL);
  const docs = [
    normalizeHtml(specHtml, {
      docId: 'wcag22',
      sourceUrl: WCAG_URL,
      title: 'Web Content Accessibility Guidelines (WCAG) 2.2',
    }),
  ];

  // The spec links every Understanding page from its per-criterion doclinks.
  const urls = [...new Set(specHtml.match(UNDERSTANDING) ?? [])].sort();
  for (const url of urls) {
    const slug = url.slice(url.lastIndexOf('/') + 1, -'.html'.length);
    docs.push(normalizeHtml(await fetchCached(url), { docId: `understanding/${slug}`, sourceUrl: url }));
  }
  return docs;
}

async function govukDocs(): Promise<NormalizedDoc[]> {
  const paths = new Set<string>();
  for (const section of GOVUK_SECTIONS) {
    const html = await fetchCached(`${GOVUK}/${section}/`);
    for (const [, path] of html.matchAll(GOVUK_LINK)) paths.add(path!);
  }

  const docs: NormalizedDoc[] = [];
  for (const path of [...paths].sort()) {
    const slug = path.replace(/^\/|\/$/g, '');
    docs.push(normalizeHtml(await fetchCached(GOVUK + path), { docId: `govuk/${slug}`, sourceUrl: GOVUK + path }));
  }
  return docs;
}

/**
 * Embeddings are cached by chunk id across runs. The free tier is metered and
 * a re-index after a chunker change only moves a fraction of the chunks, so
 * re-embedding the whole corpus each time would waste most of the quota.
 */
async function embedChunks(chunks: Chunk[]): Promise<Float32Array[] | undefined> {
  let credentials;
  try {
    credentials = credentialsFromEnv();
  } catch (error) {
    process.stderr.write(`\nSkipping embeddings — ${(error as Error).message}\n`);
    return undefined;
  }

  const cacheFile = join(RAW, 'embeddings.json');
  const cache: Record<string, number[]> = await readFile(cacheFile, 'utf8')
    .then((json) => JSON.parse(json) as Record<string, number[]>)
    .catch(() => ({}));

  const missing = chunks.filter((c) => cache[c.id] === undefined);
  if (missing.length > 0) {
    process.stderr.write(`embedding ${missing.length} chunks (${chunks.length - missing.length} cached)\n`);
    const vectors = await embedTexts(missing.map(documentText), credentials, (done, total) =>
      process.stderr.write(`  ${done}/${total}\r`),
    );
    for (const [i, chunk] of missing.entries()) cache[chunk.id] = [...vectors[i]!];
    await mkdir(RAW, { recursive: true });
    await writeFile(cacheFile, JSON.stringify(cache));
    process.stderr.write('\n');
  }

  return chunks.map((c) => Float32Array.from(cache[c.id]!));
}

async function main() {
  try {
    process.loadEnvFile(join(ROOT, '.env'));
  } catch {
    // No .env is fine; the variables may already be exported.
  }

  const docs = [...(await wcagDocs()), ...(await govukDocs())].sort((a, b) =>
    a.docId < b.docId ? -1 : 1,
  );

  for (const doc of docs) {
    const file = join(CORPUS, `${doc.docId}.txt`);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, doc.text);
  }

  const manifest = docs.map(({ docId, docTitle, sourceUrl, text }) => ({
    docId,
    docTitle,
    sourceUrl,
    chars: text.length,
  }));
  await writeFile(join(CORPUS, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  const chunks = docs.flatMap((doc) => chunkDocument(doc));
  await mkdir(INDEX, { recursive: true });

  // Split, because the two halves are needed at different moments. Everything
  // but the text is what retrieval and rendering a result list need, and it
  // gzips to 54 KB against 502 KB for the whole file. The text is only wanted
  // once a result is shown or a quote is checked, so it loads alongside rather
  // than gating first paint.
  await writeFile(
    join(INDEX, 'chunks.meta.json'),
    JSON.stringify(chunks.map(({ text: _text, ...meta }) => meta)),
  );
  await writeFile(
    join(INDEX, 'chunks.text.json'),
    JSON.stringify(Object.fromEntries(chunks.map((c) => [c.id, c.text]))),
  );
  // Kept whole as well: the CLIs and the eval harness want one file.
  await writeFile(join(INDEX, 'chunks.json'), JSON.stringify(chunks) + '\n');

  // Indexed over the same text that gets embedded: the heading path carries
  // the criterion number, which is exactly what identifier queries ask for.
  const bm25 = buildBm25Index(chunks.map((c) => ({ id: c.id, text: documentText(c) })));
  await writeFile(join(INDEX, 'bm25.json'), JSON.stringify(bm25));

  const chars = manifest.reduce((n, d) => n + d.chars, 0);
  const bySource = new Map<string, number>();
  for (const d of manifest) {
    const source = d.docId.split('/')[0]!;
    bySource.set(source, (bySource.get(source) ?? 0) + 1);
  }
  const breakdown = [...bySource].map(([s, n]) => `${s} ${n}`).join(', ');
  process.stdout.write(
    `${docs.length} docs (${breakdown}), ${chars.toLocaleString('en-US')} chars -> data/corpus\n`,
  );

  const tokens = chunks.map((c) => c.tokenCount).sort((a, b) => a - b);
  const median = tokens[Math.floor(tokens.length / 2)]!;
  const withScRef = chunks.filter((c) => c.scRef !== undefined).length;
  process.stdout.write(
    `${chunks.length} chunks -> data/index/chunks.json ` +
      `(median ${median} tokens, max ${tokens.at(-1)}, ${withScRef} carry an SC ref)\n`,
  );

  const bm25Bytes = (await readFile(join(INDEX, 'bm25.json'))).byteLength;
  process.stdout.write(
    `BM25: ${Object.keys(bm25.postings).length.toLocaleString('en-US')} terms, ` +
      `avgdl ${bm25.avgdl.toFixed(0)}, ${(bm25Bytes / 1024 / 1024).toFixed(2)} MB\n`,
  );

  const vectors = await embedChunks(chunks);
  if (vectors) {
    const encoded = encodeDenseVectors(quantize(vectors, EMBEDDING_DIMS));
    await writeFile(join(INDEX, 'vectors.bin'), Buffer.from(encoded));
    process.stdout.write(
      `Dense: ${vectors.length} vectors x ${EMBEDDING_DIMS} int8, ` +
        `${(encoded.byteLength / 1024 / 1024).toFixed(2)} MB -> data/index/vectors.bin\n`,
    );
  }
}

await main();
