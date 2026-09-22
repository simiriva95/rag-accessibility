import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { buildBm25Index, type NormalizedDoc } from '@rag/core';
import { chunkDocument } from './chunk.ts';
import { normalizeHtml } from './normalize.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
const RAW = join(ROOT, 'data/raw');
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

async function main() {
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
  await writeFile(join(INDEX, 'chunks.json'), JSON.stringify(chunks) + '\n');

  // The chunk's heading path is indexed with its body: a criterion's number
  // lives in the heading, and that is exactly what identifier queries ask for.
  const bm25 = buildBm25Index(
    chunks.map((c) => ({ id: c.id, text: `${c.headingPath.join(' ')}\n${c.text}` })),
  );
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

  const bytes = (await readFile(join(INDEX, 'bm25.json'))).byteLength;
  process.stdout.write(
    `BM25: ${Object.keys(bm25.postings).length.toLocaleString('en-US')} terms, ` +
      `avgdl ${bm25.avgdl.toFixed(0)}, ${(bytes / 1024 / 1024).toFixed(2)} MB\n`,
  );
}

await main();
