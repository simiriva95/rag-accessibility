import { describe, expect, it } from 'vitest';
import { tokenize } from './tokenize.ts';

const has = (text: string, ...expected: string[]) => {
  const tokens = new Set(tokenize(text));
  for (const token of expected) expect(tokens, `${text} -> ${token}`).toContain(token);
};

describe('tokenize', () => {
  it('keeps kebab-case whole and splits it', () => {
    has('aria-describedby', 'aria-describedby', 'aria', 'describedby');
    has('prefers-reduced-motion', 'prefers-reduced-motion', 'prefers', 'reduced', 'motion');
    has('sr-only', 'sr-only', 'sr', 'only');
  });

  it('keeps utility classes with a numeric suffix', () => {
    has('gap-4', 'gap-4', 'gap', '4');
    has('govuk-!-padding-top-7', 'govuk', 'padding', 'top', '7');
  });

  it('splits camelCase and PascalCase', () => {
    has('errorMessage', 'errormessage', 'error', 'message');
    has('describedBy', 'describedby', 'described', 'by');
    has('ARIALabel', 'arialabel', 'aria', 'label');
  });

  it('splits camelCase inside a kebab-case compound', () => {
    has('data-errorMessage', 'data-errormessage', 'data', 'errormessage', 'error', 'message');
  });

  it('keeps a criterion reference whole and never splits it into digits', () => {
    expect(tokenize('2.4.11')).toEqual(['2.4.11']);
    expect(tokenize('SC 1.4.3')).toEqual(['sc', '1.4.3']);
    // Splitting would make every numbered criterion match every other one.
    expect(tokenize('Success Criterion 2.4.11')).not.toContain('4');
  });

  it('keeps conformance levels as terms', () => {
    has('Level AA', 'level', 'aa');
    has('AAA', 'aaa');
  });

  it('drops sentence punctuation without eating the word', () => {
    expect(tokenize('The focus indicator must be visible.')).toEqual([
      'the', 'focus', 'indicator', 'must', 'be', 'visible',
    ]);
  });

  it('handles markup and accented text', () => {
    has('Group them in a <fieldset> with a <legend>', 'fieldset', 'legend');
    has('résumé', 'résumé');
  });

  it('is case-insensitive, so a query matches however it was typed', () => {
    expect(tokenize('ARIA-DESCRIBEDBY')).toEqual(tokenize('aria-describedby'));
  });
});
