/** A chunk of a normalized source document, ready to index. */
export type Chunk = {
  /** Stable content hash. Must survive re-indexing so golden-set annotations stay valid. */
  id: string;
  docId: string;
  docTitle: string;
  sourceUrl: string;
  /** e.g. ["2.4 Navigable", "2.4.11 Focus Not Obscured (Minimum)"] */
  headingPath: string[];
  /** WCAG success criterion reference, e.g. "2.4.11", where applicable. */
  scRef?: string;
  text: string;
  /**
   * Offsets into the NORMALIZED source document — see NormalizedDoc.text.
   * Invariant: normalized.text.slice(charStart, charEnd) === chunk.text
   */
  charStart: number;
  charEnd: number;
  tokenCount: number;
};

/**
 * The canonical plaintext form of a source document. Persisted, and rendered
 * verbatim by the UI — offsets resolve against this and nothing else.
 */
export type NormalizedDoc = {
  docId: string;
  docTitle: string;
  sourceUrl: string;
  text: string;
};

/** One retrieval candidate, from any single retriever. */
export type Scored = { chunkId: string; score: number };
