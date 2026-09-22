import { parseHTML } from 'linkedom';
import type { NormalizedDoc } from '@rag/core';

/**
 * HTML -> canonical plaintext.
 *
 * The output is markdown-lite: one block per line, headings as `### Text`,
 * blocks separated by a blank line. That is enough structure for the chunker
 * to rebuild a heading path, while staying plain text the UI can render
 * verbatim — which is what makes charStart/charEnd trustworthy.
 */

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NAV', 'ASIDE', 'FOOTER', 'HEADER',
  'FORM', 'BUTTON', 'SVG', 'NOSCRIPT', 'TEMPLATE',
]);

/** Navigation furniture that carries no corpus text. */
const SKIP_CLASS = /(?:^|\s)(?:self-link|doclinks|screenreader|skip-link|toc|sidebar|breadcrumb)(?:\s|$)/;
/** Boilerplate sections: no corpus value, and the name lists poison BM25. */
const SKIP_ID = /^(?:toc|table-of-contents|sotd|sidebar|navigation|changelog|acknowledgements|acknowledgments|references|ack_.*)$/;

/** Elements whose text is taken whole, without recursing into children. */
const BLOCK_TAGS = new Set(['P', 'LI', 'DT', 'DD', 'PRE', 'BLOCKQUOTE', 'FIGCAPTION', 'CAPTION', 'TR']);

const HEADING_LEVEL: Record<string, number> = { H1: 1, H2: 2, H3: 3, H4: 4, H5: 5, H6: 6 };

/** Structural subset of the DOM we use. Avoids pulling lib.dom into a Node-only package. */
type El = {
  tagName: string;
  textContent: string | null;
  children: readonly El[];
  getAttribute(name: string): string | null;
};

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

function headingLevel(el: El): number | undefined {
  const byTag = HEADING_LEVEL[el.tagName];
  if (byTag !== undefined) return byTag;
  if (el.getAttribute('role') === 'heading') {
    const level = Number(el.getAttribute('aria-level'));
    return Number.isInteger(level) && level >= 1 && level <= 6 ? level : 5;
  }
  return undefined;
}

function skip(el: El): boolean {
  if (SKIP_TAGS.has(el.tagName)) return true;
  if (el.getAttribute('hidden') !== null) return true;
  const cls = el.getAttribute('class');
  if (cls && SKIP_CLASS.test(cls)) return true;
  const id = el.getAttribute('id');
  if (id && SKIP_ID.test(id)) return true;
  return false;
}

function rowText(el: El): string {
  const cells = el.children.map((c) => collapse(c.textContent ?? ''));
  return cells.filter(Boolean).join(' | ');
}

function walk(el: El, out: string[]): void {
  if (skip(el)) return;

  const level = headingLevel(el);
  if (level !== undefined) {
    const text = collapse(el.textContent ?? '');
    if (text) out.push(`${'#'.repeat(level)} ${text}`);
    return;
  }

  if (BLOCK_TAGS.has(el.tagName)) {
    const text = el.tagName === 'TR' ? rowText(el) : collapse(el.textContent ?? '');
    if (text) out.push(el.tagName === 'LI' ? `- ${text}` : text);
    return;
  }

  for (const child of el.children) walk(child, out);
}

export function normalizeHtml(
  html: string,
  meta: { docId: string; sourceUrl: string; title?: string },
): NormalizedDoc {
  const { document } = parseHTML(html);
  const root = (document.querySelector('main') ?? document.body) as El | null;

  const blocks: string[] = [];
  if (root) walk(root, blocks);

  const docTitle =
    meta.title ||
    collapse(document.querySelector('h1')?.textContent ?? '') ||
    collapse(document.title ?? '') ||
    meta.docId;

  return {
    docId: meta.docId,
    docTitle: docTitle || meta.docId,
    sourceUrl: meta.sourceUrl,
    // NFC so that the quote-match check in the verifier compares like with like.
    text: blocks.join('\n\n').normalize('NFC'),
  };
}
