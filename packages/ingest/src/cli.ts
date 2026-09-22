import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { NormalizedDoc } from '@rag/core';
import { normalizeHtml } from './normalize.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
const RAW = join(ROOT, 'data/raw');
const CORPUS = join(ROOT, 'data/corpus');

const WCAG_URL = 'https://www.w3.org/TR/WCAG22/';
const UNDERSTANDING = /https:\/\/www\.w3\.org\/WAI\/WCAG22\/Understanding\/[a-z0-9-]+\.html/g;

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

async function main() {
  const docs = (await wcagDocs()).sort((a, b) => (a.docId < b.docId ? -1 : 1));

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

  const chars = manifest.reduce((n, d) => n + d.chars, 0);
  process.stdout.write(`${docs.length} docs, ${chars.toLocaleString('en-US')} chars -> data/corpus\n`);
}

await main();
