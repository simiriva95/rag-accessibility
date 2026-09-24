export type { Chunk, NormalizedDoc, Scored } from './types.ts';
export { tokenize } from './tokenize.ts';
export {
  BM25_DEFAULTS,
  bm25Idf,
  buildBm25Index,
  explainBm25,
  searchBm25,
  type Bm25Index,
  type Bm25Params,
  type TermContribution,
} from './bm25.ts';
export {
  DENSE_MAGIC,
  decodeDenseVectors,
  encodeDenseVectors,
  l2Normalize,
  quantize,
  searchDense,
  type DenseIndex,
  type DenseVectors,
} from './dense.ts';
export { RRF_K, fuseRrf } from './rrf.ts';
export {
  locateQuote,
  normalizeForMatch,
  statusOf,
  verifyClaim,
  verifyClaims,
  type Claim,
  type ClaimStatus,
  type EntailmentJudge,
  type EntailmentPair,
  type Normalized,
  type SentenceStatus,
  type VerifiedClaim,
  type VerifyOptions,
} from './verify.ts';
export {
  ANSWER_SCHEMA,
  parseModelAnswer,
  type ModelAnswer,
  type ParsedAnswer,
} from './answer.ts';
export {
  ENTAILMENT_LABELS,
  ENTAILMENT_SCHEMA,
  createRemoteJudge,
  parseVerdicts,
  type EntailmentLabel,
  type RemoteJudgeOptions,
} from './entailment.ts';
