/**
 * The reference material behind the walkthrough: the retrieval paradigms this
 * system combines, the metrics it is judged by, and the ablation that judged
 * it. Plain data, so the view decides how it looks and this file decides only
 * what is true.
 *
 * Every figure here is measured — they are the numbers in docs/ABLATION.md,
 * produced by packages/eval/src/harness.ts over the 60-question golden set.
 * Nothing is illustrative.
 */

/** Mirrors packages/worker/src/worker.ts. The web package does not depend on the worker. */
export const MODELS = {
  embedding: '@cf/baai/bge-small-en-v1.5',
  reranker: '@cf/baai/bge-reranker-base',
  generationChain: ['gemini-3.6-flash', 'gemini-2.5-flash', '@cf/meta/llama-4-scout-17b-16e-instruct', '@cf/meta/llama-3.1-8b-instruct-fast'],
  queryPrefix: 'Represent this sentence for searching relevant passages: ',
} as const;

export const PIPELINE_CONSTANTS = {
  candidates: 30,
  final: 8,
  verifiedAt: 0.7,
  partialAt: 0.4,
  chunk: { targetTokens: 400, minTokens: 250, maxTokens: 480, overlap: 0.15 },
} as const;

export type Reference = { authors: string; year: number; title: string; venue: string; url: string };

export type Paradigm = {
  id: string;
  name: string;
  family: string;
  /** The same idea for someone meeting it for the first time: an everyday analogy and a tiny example. */
  plain: string;
  /** One paragraph: what it does, at the level of a lecture. */
  idea: string;
  /** The defining formula, written in plain text so it reads without a maths renderer. */
  formula: string;
  cost: string;
  strengths: string[];
  failures: string[];
  /** Which ablation row measures it, when one does. */
  ablationRow?: AblationRow['retriever'];
  references: Reference[];
};

const REF = {
  robertson2009: {
    authors: 'Robertson, S. & Zaragoza, H.',
    year: 2009,
    title: 'The Probabilistic Relevance Framework: BM25 and Beyond',
    venue: 'Foundations and Trends in Information Retrieval 3(4)',
    url: 'https://doi.org/10.1561/1500000019',
  },
  karpukhin2020: {
    authors: 'Karpukhin, V. et al.',
    year: 2020,
    title: 'Dense Passage Retrieval for Open-Domain Question Answering',
    venue: 'EMNLP 2020',
    url: 'https://aclanthology.org/2020.emnlp-main.550/',
  },
  xiao2023: {
    authors: 'Xiao, S. et al.',
    year: 2023,
    title: 'C-Pack: Packaged Resources To Advance General Chinese Embedding (the BGE models)',
    venue: 'arXiv:2309.07597',
    url: 'https://arxiv.org/abs/2309.07597',
  },
  cormack2009: {
    authors: 'Cormack, G. V., Clarke, C. L. A. & Büttcher, S.',
    year: 2009,
    title: 'Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods',
    venue: 'SIGIR 2009',
    url: 'https://doi.org/10.1145/1571941.1572114',
  },
  nogueira2019: {
    authors: 'Nogueira, R. & Cho, K.',
    year: 2019,
    title: 'Passage Re-ranking with BERT',
    venue: 'arXiv:1901.04085',
    url: 'https://arxiv.org/abs/1901.04085',
  },
  lewis2020: {
    authors: 'Lewis, P. et al.',
    year: 2020,
    title: 'Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks',
    venue: 'NeurIPS 2020',
    url: 'https://arxiv.org/abs/2005.11401',
  },
  gao2023: {
    authors: 'Gao, T., Yen, H., Yu, J. & Chen, D.',
    year: 2023,
    title: 'Enabling Large Language Models to Generate Text with Citations',
    venue: 'EMNLP 2023',
    url: 'https://arxiv.org/abs/2305.14627',
  },
  rashkin2023: {
    authors: 'Rashkin, H. et al.',
    year: 2023,
    title: 'Measuring Attribution in Natural Language Generation Models',
    venue: 'Computational Linguistics 49(4)',
    url: 'https://doi.org/10.1162/coli_a_00486',
  },
  jarvelin2002: {
    authors: 'Järvelin, K. & Kekäläinen, J.',
    year: 2002,
    title: 'Cumulated gain-based evaluation of IR techniques',
    venue: 'ACM TOIS 20(4)',
    url: 'https://doi.org/10.1145/582415.582418',
  },
} satisfies Record<string, Reference>;

export const PARADIGMS: Paradigm[] = [
  {
    id: 'sparse',
    plain:
      'Like the index at the back of a textbook. You look up each word of your question and see which pages mention it. A page that mentions a rare word of yours, like “contrast”, scores much higher than one that only mentions a common word, like “how”. It is fast and completely predictable, but it only sees words: if the page says “hard to read” and you asked “low contrast”, it will not connect them.',
    name: 'Sparse lexical retrieval',
    family: 'BM25 · bag of words',
    idea:
      'A document is represented by the terms it contains and how often. Relevance is estimated ' +
      'from the probabilistic relevance framework: a query term counts for more the rarer it is ' +
      'across the corpus (inverse document frequency), and a document gains from repeating it ' +
      'with diminishing returns, normalised by the document’s length. Nothing is learned; the ' +
      'index is an inverted list of postings.',
    formula:
      'score(D, Q) = Σ_{q ∈ Q} idf(q) · f(q,D)·(k1+1) / ( f(q,D) + k1·(1 − b + b·|D|/avgdl) )\n' +
      'idf(q) = ln( 1 + (N − df(q) + 0.5) / (df(q) + 0.5) )',
    cost: 'Proportional to the postings of the query terms. Here: 2-3 ms in the browser.',
    strengths: [
      'Exact identifiers survive: 2.4.11, aria-describedby, 4.5:1.',
      'Fully explainable: every point of the score is a term you can name.',
      'No model, no GPU, no drift: the same index gives the same answer in five years.',
    ],
    failures: [
      'Vocabulary mismatch: a paraphrase that shares no term with its answer scores zero.',
      'No notion of meaning, word order or negation.',
    ],
    ablationRow: 'BM25 only',
    references: [REF.robertson2009],
  },
  {
    id: 'dense',
    plain:
      'Like a map of meanings. A neural network has read millions of sentences and learned to place each passage as a point, so that passages about the same idea land close together even when they use different words. Your question becomes a point too, and the search picks the nearest points. It understands “hard to read” and “low contrast” as neighbours, but it is fuzzy about exact names and numbers such as 2.4.11.',
    name: 'Dense retrieval',
    family: 'Bi-encoder · embeddings',
    idea:
      'A neural encoder maps the query and each passage, independently, to a point in a ' +
      'shared vector space trained so that a question lands near the passages that answer it. ' +
      'Because the passages are encoded once, ahead of time, only the query is encoded at ' +
      'search time and relevance becomes a dot product. It captures paraphrase and synonymy, ' +
      'which is exactly what lexical matching cannot.',
    formula:
      'score(D, Q) = cos(E_q(Q), E_d(D)) = ⟨u, v⟩ / (‖u‖·‖v‖)\n' +
      'with u, v ∈ ℝ³⁸⁴ from bge-small-en-v1.5, the query prefixed by an instruction',
    cost:
      'One encoder call for the query at the edge, then a linear scan: 1,592 × 384 ≈ 611k ' +
      'multiply-adds, a few milliseconds in a Web Worker.',
    strengths: [
      'Robust to paraphrase and synonymy: the question need not share a word with its answer.',
      'A single fixed-size vector per passage, cheap to store and to scan.',
    ],
    failures: [
      'Identifiers blur: a criterion number like 2.4.11 carries little signal in an embedding.',
      'The whole passage is squeezed into one vector before the query is seen.',
      'Opaque: a cosine cannot be broken down term by term.',
    ],
    ablationRow: 'Dense only',
    references: [REF.karpukhin2020, REF.xiao2023],
  },
  {
    id: 'hybrid',
    plain:
      'Like asking two friends for their top 30 and combining the lists. One friend judges by words, the other by meaning, and their scores are on different scales, so only the positions are used. Every passage earns points for how high it sits on each list. One that both friends put reasonably high beats one that only one friend put first. That is how the strengths of the two searches add up.',
    name: 'Hybrid retrieval by rank fusion',
    family: 'Reciprocal Rank Fusion',
    idea:
      'Run both retrievers and merge their lists. The scores cannot be merged directly (BM25 is ' +
      'an unbounded sum, cosine lives in [−1, 1]), and any normalisation is a tuning knob that ' +
      'breaks on the next corpus. RRF reads only the ranks: each list gives a document a vote ' +
      'that decays with its position, and the constant k keeps a single confident list from ' +
      'carrying a document alone. Agreement outweighs certainty.',
    formula: 'RRF(d) = Σ_{r ∈ rankings} 1 / (k + rank_r(d)),   k = 60',
    cost: 'A hash map over at most 60 candidates. Well under a millisecond.',
    strengths: [
      'No score calibration, no training, no parameters to fit per corpus.',
      'Keeps most of BM25’s identifier recall and most of dense’s conceptual recall.',
    ],
    failures: [
      'Can only reorder what one of the retrievers already found.',
      'Treats both lists as equally trustworthy for every query.',
    ],
    ablationRow: 'Hybrid (RRF)',
    references: [REF.cormack2009],
  },
  {
    id: 'rerank',
    plain:
      'Like a second, careful reading. The first searches skim quickly through all 1,592 passages to fill a basket of 30. Then a slower model reads your question and each of the 30 passages together, word against word, and reorders them. It is much more accurate, but far too slow to run on everything, so it only sees the basket, and it keeps the best 8.',
    name: 'Retrieve, then rerank',
    family: 'Cross-encoder',
    idea:
      'A second, more expensive model reads the query and one candidate passage together, in a ' +
      'single transformer pass, so every query token can attend to every passage token. That ' +
      'joint reading is far more accurate than comparing two independent vectors, and far too ' +
      'slow to run over a whole corpus, so it runs only over the 30 fused candidates, and ' +
      'keeps the best 8 for the generator.',
    formula: 'score(D, Q) = w · h_[CLS]( Enc( [CLS] Q [SEP] D [SEP] ) ),   applied to the top 30 only',
    cost: 'One model call over 30 (query, passage) pairs at the edge: the slowest retrieval stage.',
    strengths: [
      'Full cross-attention between query and passage.',
      'Decides what the generator reads first, which is what Success@5 and MRR measure.',
    ],
    failures: [
      'Cost grows linearly with the number of candidates, so recall is capped by stage one.',
      'Cannot recover a passage the first stage missed.',
    ],
    ablationRow: 'Hybrid + rerank',
    references: [REF.nogueira2019],
  },
  {
    id: 'rag',
    plain:
      'Like an open-book exam. Instead of answering from memory, the language model is handed the 8 best passages and told to answer only from them. This keeps the answer about this corpus and lets us check it, because we know exactly what the model was shown. Its weakness is that a model can still claim a page says something it does not.',
    name: 'Retrieval-augmented generation',
    family: 'Generator conditioned on evidence',
    idea:
      'A language model answers from the retrieved passages instead of from its parameters. ' +
      'This makes the answer current, scoped to a corpus and, in principle, checkable, ' +
      'because the evidence is known. In practice a model will still cite a passage for a claim ' +
      'it does not contain, which is why generation here is constrained to a schema and ' +
      'followed by verification.',
    formula: 'p(y | x) ≈ p_θ(y | x, z_1..z_8),   z = the reranked passages',
    cost: 'One generation call, the dominant latency of the whole pipeline.',
    strengths: ['Answers in prose, scoped to the corpus.', 'Can decline when the sources do not answer.'],
    failures: ['Can fabricate a citation that looks real.', 'Depends on a third-party model staying available.'],
    references: [REF.lewis2020],
  },
  {
    id: 'attribution',
    plain:
      'Like a teacher marking the exam. For every sentence, the model had to copy a quotation from a page. The teacher first searches the page for those exact words, like pressing Ctrl+F: if they are not there, the quotation was invented. Only if they are there does the teacher read the page and decide whether it really supports the sentence. Checking the easy thing first means most made-up citations are caught without any model at all.',
    name: 'Attributed generation, verified',
    family: 'Quote match · span · entailment',
    idea:
      'The model does not write footnotes, it writes claims: a sentence, the sources it cites, ' +
      'and a quote that must appear verbatim in one of them. Verification then runs cheapest ' +
      'first: an exact substring test, the mapping of the quote back to offsets in the source ' +
      'document, and only then an entailment judgement of whether the evidence supports the ' +
      'sentence. It is the “attributable to identified sources” property made operational.',
    formula:
      'verified ⇔ quote ⊑ chunk ∧ entail(chunk ⇒ sentence) ≥ 0.7 ∧ level(chunk) named\n' +
      'partial ⇔ quote ⊑ chunk ∧ (0.4 ≤ entail < 0.7 ∨ level(chunk) not named)\n' +
      'unsupported ⇔ quote ⋢ chunk ∨ entail < 0.4\n' +
      'unverified ⇔ quote ⊑ chunk ∧ judge unavailable',
    cost: 'Substring search in the browser (free), then one batched judge call.',
    strengths: [
      'A fabricated quote is caught by a substring test, with no model at all.',
      '189 probe citations from the real corpus: 0 wrong accepts, 0 wrong rejects.',
    ],
    failures: [
      'A real quote can still be attached to a sentence it does not support, hence the judge.',
      'The judge is itself a model, and says so when it could not run.',
    ],
    references: [REF.rashkin2023, REF.gao2023],
  },
];

export type AblationRow = {
  retriever: 'BM25 only' | 'Dense only' | 'Hybrid (RRF)' | 'Hybrid + rerank';
  recall5: number;
  recall10: number;
  recall30: number;
  success5: number;
  ndcg10: number;
  mrr: number;
  /** Recall@10 by question kind. */
  byKind: { identifier: number; conceptual: number; design: number };
};

export const ABLATION: AblationRow[] = [
  {
    retriever: 'BM25 only',
    recall5: 0.395, recall10: 0.569, recall30: 0.739, success5: 0.717, ndcg10: 0.475, mrr: 0.53,
    byKind: { identifier: 0.693, conceptual: 0.455, design: 0.634 },
  },
  {
    retriever: 'Dense only',
    recall5: 0.475, recall10: 0.648, recall30: 0.799, success5: 0.736, ndcg10: 0.541, mrr: 0.594,
    byKind: { identifier: 0.541, conceptual: 0.697, design: 0.716 },
  },
  {
    retriever: 'Hybrid (RRF)',
    recall5: 0.521, recall10: 0.652, recall30: 0.842, success5: 0.849, ndcg10: 0.55, mrr: 0.629,
    byKind: { identifier: 0.661, conceptual: 0.618, design: 0.719 },
  },
  {
    retriever: 'Hybrid + rerank',
    recall5: 0.604, recall10: 0.665, recall30: 0.661, success5: 0.943, ndcg10: 0.536, mrr: 0.733,
    byKind: { identifier: 0.788, conceptual: 0.597, design: 0.612 },
  },
];

export const QUESTION_KINDS = { identifier: 18, conceptual: 25, design: 10 } as const;

export type Metric = { name: string; formula: string; reads: string; plain: string; reference?: Reference };

export const METRICS: Metric[] = [
  {
    name: 'Recall@k',
    plain: 'Of the passages that really answer the question, how many are in the first k results? If three passages answer it and two are in the top 10, Recall@10 is 2 out of 3, about 67%.',
    formula: '|primary ∩ top_k| / min(|primary|, k)',
    reads: 'How much of what answers the question made it into the first k. The denominator is capped at k.',
  },
  {
    name: 'Success@k',
    plain: 'Is at least one right passage in the first k? Yes counts as 1, no as 0, averaged over all questions. Success@5 of 94% means that for 94 questions in 100, something useful is in the top five.',
    formula: '1 if primary ∩ top_k ≠ ∅, else 0',
    reads: 'Whether anything that answers the question is in the first k at all.',
  },
  {
    name: 'MRR',
    plain: 'How far down do you have to go to meet the first right answer? First place scores 1, second 1/2, third 1/3, and so on. An average of 0.73 means the first right answer is usually first or second.',
    formula: 'mean over questions of 1 / rank of the first primary chunk',
    reads: 'How far down the first right answer sits. 1.0 means always first.',
  },
  {
    name: 'nDCG@10',
    plain: 'Like Recall, but it cares about order and gives half credit to near misses. A right passage at the top earns the most, lower down it earns less, and a passage from the right document but not the right section earns a little.',
    formula: 'DCG / IDCG,   DCG = Σ_i (2^grade_i − 1) / log2(i + 1)',
    reads: 'Graded ordering quality: primary chunks score 2, same-document context 1.',
    reference: REF.jarvelin2002,
  },
];

export const CORPUS = [
  { source: 'WCAG 2.2 Understanding', documents: 100, characters: 1_219_463 },
  { source: 'GOV.UK Design System', documents: 92, characters: 405_406 },
  { source: 'WCAG 2.2 specification', documents: 1, characters: 121_898 },
] as const;

/**
 * The build-time half: every algorithm that turns 193 web pages into the four
 * files the browser loads. Each names the ablation group that measures it, in
 * ingest-ablation.json, produced by packages/eval/src/ingest-ablation.ts.
 *
 * The verdicts are written against those numbers, intervals included. With 53
 * questions one question moves Success@5 by 1.9 points, so a difference inside
 * the intervals is reported as no difference.
 */
export type IngestStage = {
  id: string;
  /** For someone meeting the idea for the first time. */
  plain: string;
  name: string;
  /** Tab label. */
  short: string;
  family: string;
  idea: string;
  how: string[];
  strengths: string[];
  tradeoffs: string[];
  /** Ablation group in ingest-ablation.json, when one measures this stage. */
  group?: string;
  verdict: string;
  references?: Reference[];
};

export const INGEST: IngestStage[] = [
  {
    id: 'normalize',
    plain:
      'A web page is full of things that are not the text: menus, buttons, footers, code examples. This step throws those away and keeps the words, in order, with the headings marked. Think of photocopying only the chapter you need, not the cover and the adverts. Everything later points into this clean copy by character position, like “characters 1,200 to 1,450”, so it has to stay exactly the same forever.',
    short: 'Normalise',
    name: 'HTML normalisation',
    family: 'Parsing · boilerplate removal',
    idea:
      'Each page is parsed and reduced to a canonical plain text: one block per line, headings ' +
      'kept as "### Heading", blocks separated by a blank line. Navigation, footers, tables of ' +
      'contents and repeated code examples are dropped by tag, class and id. This text is the ' +
      'single source of truth: chunk offsets, highlights and quote checks all resolve against it.',
    how: [
      'Parse with linkedom, walk the DOM, skip furniture (nav, footer, doclinks, GOV.UK example wrappers).',
      'Take block elements whole (p, li, dt, dd, pre, tr), collapse whitespace, keep heading levels.',
      'Apply Unicode NFC once, so every later offset refers to the same characters.',
    ],
    strengths: [
      'Plain text the UI can render verbatim, so a highlighted quote sits exactly where it was found.',
      'Headings survive as structure the chunker can use.',
      'Cached HTML makes re-runs offline and reproducible.',
    ],
    tradeoffs: [
      'Rules are per source: a new site needs its own skip list.',
      'Tables become one line per row, which loses column alignment.',
      'Anything rendered by JavaScript is invisible to it.',
    ],
    verdict:
      '193 documents, 1,746,767 characters. Every chunk of every chunker tested reproduces its ' +
      'source slice exactly (100% of offsets exact), which is the invariant verification depends on.',
  },
  {
    id: 'chunk',
    plain:
      'A whole page is too big to search or to give to the model, so it is cut into pieces of about a page of a paperback each (around 400 tokens, roughly 250 words). The cut is made carefully: never in the middle of a paragraph, preferably where a new heading starts, and each piece repeats the end of the previous one a little (15%) so an idea split across the cut is not lost. Cutting blindly every N characters is simpler, but then most pieces end mid-sentence.',
    short: 'Chunking',
    name: 'Structure-aware chunking',
    family: 'Segmentation',
    idea:
      'Documents are cut into passages small enough to embed and specific enough to retrieve. ' +
      'The shipped chunker never cuts a block, opens a new chunk at a section heading once the ' +
      'current one is worth retrieving on its own, targets 400 tokens with a hard cap of 480 ' +
      '(inside the encoder’s 512-token window), and carries 15% of the previous chunk forward.',
    how: [
      'Parse blocks with exact offsets; split an oversized block on sentence boundaries.',
      'Flush at 400 tokens, at a section heading past 250 tokens, or before exceeding 480.',
      'Carry trailing blocks as overlap, never across a section boundary.',
      'Content-addressed ids, so annotations survive a re-index.',
    ],
    strengths: [
      '75% of chunks end on a sentence or block boundary, against 15% for fixed windows.',
      '95% start on a block boundary, so a passage reads as a unit.',
      'The criterion number in a heading reaches every chunk under it.',
    ],
    tradeoffs: [
      'More code, and more ways to be wrong: three chunker defects were caught by tests before launch.',
      'Token counts are estimated (3.5 characters per token), not measured by the real tokenizer.',
      'On recall alone it did not beat fixed windows here.',
    ],
    group: 'chunking',
    verdict:
      'Halving the chunk size clearly hurts: hybrid Recall@10 falls from 66.6% to 54.9%. Overlap ' +
      'moves nothing measurable. Fixed windows score as well on recall (69.9%, inside the ' +
      'interval) but cut 85% of chunks mid-sentence, which is what the generator and the quote ' +
      'check then have to read. Part of their recall may also be an annotation effect: a window ' +
      'spanning several headings matches more gold anchors.',
  },
  {
    id: 'header',
    plain:
      'Each piece is labelled with the headings it sits under before it is indexed, like writing the chapter and section title at the top of a torn-out page: “2.4 Navigable > 2.4.11 Focus Not Obscured > Intent”. The hope is that a piece which never says “2.4.11” can still be found by that number. The measurement below says the hope did not fully come true for the meaning search.',
    short: 'Chunk header',
    name: 'Contextual chunk header',
    family: 'What text is indexed',
    idea:
      'Before a chunk is embedded and indexed, its heading path is prepended: "2.4 Navigable > ' +
      '2.4.11 Focus Not Obscured > Intent", then the text. The idea is that a chunk about 2.4.11 ' +
      'which never writes "2.4.11" should still be findable by its number.',
    how: ['documentText(chunk) = headingPath.join(" > ") + "\\n" + chunk.text, for both BM25 and the encoder.'],
    strengths: ['Criterion numbers and section names become searchable in every chunk beneath them.'],
    tradeoffs: [
      'The same header repeats across every chunk of a section, which blurs them for the encoder.',
      'Spends part of the 512-token window on text that is not the passage.',
    ],
    group: 'header',
    verdict:
      'The measurement does not support it. Without the header, dense Success@5 is 92.5% against ' +
      '86.8% with it. For BM25 the header leaves recall level and lifts nDCG from 0.434 to 0.475. The intervals overlap, so this is a lead ' +
      'rather than a result, and it was measured with the local encoder; re-embedding without ' +
      'the header through production is the check before changing what ships.',
  },
  {
    id: 'tokenize',
    plain:
      'The word search needs to know what counts as one word. “aria-describedby” is kept as one word and also as “aria” and “describedby”, so both kinds of search find it. “2.4.11” is always kept whole, because cut into 2, 4 and 11 it would match every numbered rule in WCAG.',
    short: 'Tokenizer',
    name: 'Lexical tokenization',
    family: 'BM25 vocabulary',
    idea:
      'BM25 can only match what the tokenizer emits. Compounds are emitted whole and split ' +
      '(aria-describedby, aria, describedby; errorMessage, error, message), while dotted ' +
      'criterion numbers stay whole, because 2, 4 and 11 on their own match every criterion.',
    how: [
      'Match runs of letters and digits joined by - _ or .; lowercase after NFC.',
      'Emit the whole run, then its kebab, snake and camelCase parts.',
      'Never split a dotted number such as 1.4.3.',
    ],
    strengths: ['An exact identifier query matches the whole token and scores high.', 'A partial query still reaches the document through the parts.'],
    tradeoffs: ['Every compound is indexed several times, which inflates the postings.', 'No stemming: "focused" and "focus" are different terms.'],
    group: 'tokenizer',
    verdict:
      'Against a plain alphanumeric tokenizer: Recall@10 56.9% against 55.4%, MRR 0.530 against ' +
      '0.503. A small, consistent gain, inside the intervals.',
  },
  {
    id: 'bm25',
    plain:
      'This builds the index at the back of the book: for every word, the list of pieces that contain it and how many times. Two dials set how the scoring behaves. k1 decides how quickly repeating a word stops helping; b decides how much long pieces are handicapped. The textbook values were used, and the measurement shows that tuning them would barely matter.',
    short: 'BM25',
    name: 'BM25 index and parameters',
    family: 'Inverted index · Okapi BM25',
    idea:
      'An inverted index maps each term to the chunks containing it and how often. At query time ' +
      'BM25 sums, over the query terms, an idf weight times a saturating term frequency ' +
      'normalised by chunk length. k1 sets how fast repetition saturates; b sets how much a long ' +
      'chunk is penalised.',
    how: ['Postings stored as flat [docIndex, tf] pairs to keep the JSON small (1.28 MB, 379 KB gzipped).', 'k1 = 1.2, b = 0.75: the textbook defaults, chosen before any tuning.'],
    strengths: ['Built once, queried in 2 to 3 ms in the browser.', 'Every point of a score can be traced to a term.'],
    tradeoffs: ['Two parameters that are corpus-dependent.', 'The index is the largest file the site ships.'],
    group: 'bm25',
    verdict:
      'The defaults are not the optimum, but nothing beats them by more than the noise: k1 = 2 ' +
      'gives 58.4% against 56.9%. Tuning on the same 53 questions the table reports would be ' +
      'fitting the test set, so the defaults stay.',
    references: [REF.robertson2009],
  },
  {
    id: 'encode',
    plain:
      'Every piece is turned into a list of 384 numbers by a small neural network, like giving each piece coordinates on the map of meanings. It is done once, when the site is built. At question time only your question is turned into numbers. The question gets a short instruction in front, “Represent this sentence for searching relevant passages”, because that is how the model was trained to tell questions from answers.',
    short: 'Encoding',
    name: 'Dense encoding',
    family: 'bge-small-en-v1.5 · bi-encoder',
    idea:
      'Each chunk is mapped by a 33M-parameter BERT-style encoder to a 384-dimensional vector, ' +
      'pooled on the [CLS] token and L2-normalised. The model is asymmetric: queries carry an ' +
      'instruction prefix and passages do not, because that is how it was trained.',
    how: [
      'Passages: embedded once at build time through Workers AI, 100 per request.',
      `Queries: embedded per question at the edge, prefixed with “${MODELS.queryPrefix.trim()}”.`,
    ],
    strengths: ['Small enough to embed the whole corpus on a free tier.', 'Matches meaning, not only words.'],
    tradeoffs: ['512-token window caps chunk size.', 'An English-only model.', 'A remote call per question.'],
    group: 'query',
    verdict:
      'The prefix is worth keeping: without it Success@5 falls from 86.8% to 71.7%, the largest ' +
      'single effect in the ingest ablation. The local ONNX encoder used for the chunking rows ' +
      'agrees with Workers AI at a mean cosine of 0.904: the same model, not bit-identical output.',
    references: [REF.xiao2023],
  },
  {
    id: 'quantize',
    plain:
      'Each of the 384 numbers is a precise decimal. Storing them as whole numbers from -127 to 127 instead makes the file four times smaller, like rounding prices to the nearest euro. You lose a tiny bit of precision, and the measurement shows the search finds the same things either way.',
    short: 'int8',
    name: 'int8 quantization',
    family: 'Vector storage',
    idea:
      'Each vector is scaled by its own largest component and rounded to 8-bit integers, with ' +
      'one float scale per vector kept to undo it. A per-vector scale rather than a global one, ' +
      'because the components of a unit vector in 384 dimensions sit well inside [-1, 1].',
    how: ['scale = max|vᵢ| / 127, codeᵢ = round(vᵢ / scale).', 'Scored against a float32 query: one dot product per chunk, times its scale.'],
    strengths: ['4× smaller: 0.6 MB against 2.4 MB, and one binary file instead of JSON.', 'A scan of 1,592 vectors in a few milliseconds.'],
    tradeoffs: ['Lossy: scores move in the third decimal.', 'Ranking ties can reorder.'],
    group: 'storage',
    verdict:
      'Free at this scale. Recall@10 and Success@5 are identical to float32, MRR 0.594 against ' +
      '0.604, and the two share 99.2% of their top 10.',
  },
  {
    id: 'fusion',
    plain:
      'When the two lists are combined, each position is worth 1/(k + position). The constant k decides how much being first matters. With a small k, first place on one list almost wins alone; with a large k, all positions are worth nearly the same and agreement between the two lists decides. 60 is the value from the original paper.',
    short: 'Fusion k',
    name: 'Fusion constant',
    family: 'Reciprocal Rank Fusion, k',
    idea:
      'RRF adds 1/(k + rank) from each list. A small k lets the top of one list dominate; a large ' +
      'k flattens every rank toward the same vote, so agreement between lists decides.',
    how: ['k = 60, the value from the original paper, over two lists of 30.'],
    strengths: ['No tuning needed across corpora.'],
    tradeoffs: ['Treats both retrievers as equally reliable for every query.'],
    group: 'fusion',
    verdict:
      'Flat from k = 10 to k = 200 (Recall@10 65.2% to 65.8%). Only k = 1 is worse, at 81.1% ' +
      'Success@5 against 84.9%: letting one list’s first place win outright loses.',
    references: [REF.cormack2009],
  },
];
