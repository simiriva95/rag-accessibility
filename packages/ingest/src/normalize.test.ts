import { describe, expect, it } from 'vitest';
import { normalizeHtml } from './normalize.ts';

const norm = (html: string) =>
  normalizeHtml(html, { docId: 'd', sourceUrl: 'https://example.test/d' }).text;

describe('normalizeHtml', () => {
  it('emits headings with their level and blocks separated by a blank line', () => {
    expect(norm('<main><h2 id="a">Navigable</h2><p>Provide ways.</p></main>')).toBe(
      '## Navigable\n\nProvide ways.',
    );
  });

  it('keeps the success criterion number attached to its heading', () => {
    const html =
      '<main><div class="header-wrapper"><h4><bdi class="secno">Success Criterion 2.4.11 </bdi>Focus Not Obscured (Minimum)</h4>' +
      '<a class="self-link" href="#x">Permalink</a></div></main>';
    expect(norm(html)).toBe('#### Success Criterion 2.4.11 Focus Not Obscured (Minimum)');
  });

  it('collapses whitespace and normalizes to NFC', () => {
    expect(norm('<main><p>a \n\t b c</p></main>')).toBe('a b c');
    expect(norm('<main><p>é</p></main>')).toBe('é');
  });

  it('marks list items and flattens table rows', () => {
    expect(norm('<main><ul><li>one</li><li>two</li></ul></main>')).toBe('- one\n\n- two');
    expect(norm('<main><table><tr><td>4.1.2</td><td>A</td></tr></table></main>')).toBe('4.1.2 | A');
  });

  it('drops navigation furniture, scripts and hidden content', () => {
    const html =
      '<main><nav><a href="#">skip</a></nav><script>var x=1</script>' +
      '<div class="doclinks"><a href="#">Understanding</a></div>' +
      '<p hidden>invisible</p><section id="table-of-contents"><p>toc</p></section>' +
      '<p>kept</p></main>';
    expect(norm(html)).toBe('kept');
  });

  it('treats role=heading as a heading at its aria-level', () => {
    const html = '<main><div class="note"><div role="heading" aria-level="5"><span>Note 1</span></div><p>body</p></div></main>';
    expect(norm(html)).toBe('##### Note 1\n\nbody');
  });

  it('prefers main over the rest of the body', () => {
    expect(norm('<body><p>chrome</p><main><p>content</p></main></body>')).toBe('content');
  });

  it('does not emit a block twice when blocks nest', () => {
    expect(norm('<main><blockquote><p>quoted</p></blockquote></main>')).toBe('quoted');
  });
});

describe('boilerplate sections', () => {
  it('drops acknowledgements, change log and references', () => {
    const html =
      '<main><section id="acknowledgements"><p>Alice, Bob</p></section>' +
      '<section id="changelog"><p>edits</p></section>' +
      '<section id="references"><p>[RFC2119]</p></section>' +
      '<p>kept</p></main>';
    expect(norm(html)).toBe('kept');
  });
});
