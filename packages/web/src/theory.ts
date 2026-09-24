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

/** Mirrors packages/worker/src/index.ts. The web package does not depend on the worker. */
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
    name: 'Attributed generation, verified',
    family: 'Quote match · span · entailment',
    idea:
      'The model does not write footnotes, it writes claims: a sentence, the sources it cites, ' +
      'and a quote that must appear verbatim in one of them. Verification then runs cheapest ' +
      'first: an exact substring test, the mapping of the quote back to offsets in the source ' +
      'document, and only then an entailment judgement of whether the evidence supports the ' +
      'sentence. It is the “attributable to identified sources” property made operational.',
    formula:
      'verified ⇔ quote ⊑ chunk ∧ entail(chunk ⇒ sentence) ≥ 0.7\n' +
      'partial ⇔ quote ⊑ chunk ∧ 0.4 ≤ entail < 0.7\n' +
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

export type Metric = { name: string; formula: string; reads: string; reference?: Reference };

export const METRICS: Metric[] = [
  {
    name: 'Recall@k',
    formula: '|primary ∩ top_k| / min(|primary|, k)',
    reads: 'How much of what answers the question made it into the first k. The denominator is capped at k.',
  },
  {
    name: 'Success@k',
    formula: '1 if primary ∩ top_k ≠ ∅, else 0',
    reads: 'Whether anything that answers the question is in the first k at all.',
  },
  {
    name: 'MRR',
    formula: 'mean over questions of 1 / rank of the first primary chunk',
    reads: 'How far down the first right answer sits. 1.0 means always first.',
  },
  {
    name: 'nDCG@10',
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
