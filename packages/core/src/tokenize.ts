/**
 * Lexical tokenizer for the BM25 index.
 *
 * The tokenizer is where hybrid retrieval earns its keep. Dense embeddings are
 * good at meaning and bad at identifiers: `aria-describedby`, `sr-only` and
 * `2.4.11` all land in roughly the same fuzzy neighbourhood. BM25 rescues them,
 * but only if the tokenizer keeps them intact.
 *
 * So compounds are emitted twice — whole, and split into parts:
 *   aria-describedby        -> aria-describedby, aria, describedby
 *   prefers-reduced-motion  -> prefers-reduced-motion, prefers, reduced, motion
 *   errorMessage            -> errormessage, error, message
 * An exact query matches the whole form and scores high; a partial query still
 * finds the document through its parts.
 *
 * Criterion references are the exception: 2.4.11 is emitted whole and never
 * split, because `2`, `4` and `11` are noise that would match every other
 * numbered criterion in the corpus.
 */

/** A run of alphanumerics, optionally joined by `-`, `_` or `.`. */
const WORD = /[\p{L}\p{N}]+(?:[-_.][\p{L}\p{N}]+)*/gu;

/** A dotted numeric reference: 2.4.11, 1.4.3. Kept whole. */
const DOTTED_NUMBER = /^\d+(?:\.\d+)+$/;

/** camelCase and PascalCase boundaries, including the ARIALabel -> aria|label case. */
const CAMEL = /(?<=\p{Ll}|\p{N})(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/gu;

export function tokenize(text: string): string[] {
  const tokens: string[] = [];

  for (const [word] of text.normalize('NFC').matchAll(WORD)) {
    tokens.push(word.toLowerCase());

    if (DOTTED_NUMBER.test(word)) continue;

    // kebab-case, snake_case, and dotted names like theme.colour.
    const parts = word.split(/[-_.]/).filter(Boolean);
    if (parts.length > 1) for (const part of parts) tokens.push(part.toLowerCase());

    // camelCase within each part, split on the original casing before it is lost.
    for (const part of parts) {
      const camel = part.split(CAMEL);
      if (camel.length > 1) for (const piece of camel) tokens.push(piece.toLowerCase());
    }
  }

  return tokens;
}
