/**
 * Retrieval metrics.
 *
 * All of them take a ranked list of chunk ids and the annotation for one
 * question, and return a number in [0, 1]. Nothing here knows about retrievers.
 */

/**
 * Fraction of the relevant chunks found in the top k.
 *
 * The denominator is min(|relevant|, k), not |relevant|. A question whose
 * answer genuinely spans 13 chunks cannot have Recall@5 above 0.38 under the
 * uncapped form, so the uncapped number would measure how many chunks the
 * annotation happens to cover rather than how well retrieval did. Capping is
 * the usual convention and it is stated here because it changes the numbers.
 */
export function recallAt(ranked: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  if (relevant.size === 0) return 1;
  const found = ranked.slice(0, k).filter((id) => relevant.has(id)).length;
  return found / Math.min(relevant.size, k);
}

/** Whether anything relevant made it into the top k. For RAG, often what matters. */
export function successAt(ranked: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  if (relevant.size === 0) return 1;
  return ranked.slice(0, k).some((id) => relevant.has(id)) ? 1 : 0;
}

/** Reciprocal rank of the first relevant chunk; 0 when none was retrieved. */
export function reciprocalRank(ranked: readonly string[], relevant: ReadonlySet<string>): number {
  if (relevant.size === 0) return 1;
  const position = ranked.findIndex((id) => relevant.has(id));
  return position === -1 ? 0 : 1 / (position + 1);
}

/**
 * Normalized discounted cumulative gain, exponential gain form:
 *   DCG = Σ (2^grade - 1) / log2(rank + 1)
 *
 * The exponential form is what makes graded relevance worth having — it puts a
 * primary chunk well above a merely related one instead of one step above.
 */
export function ndcgAt(ranked: readonly string[], grades: ReadonlyMap<string, number>, k: number): number {
  if (grades.size === 0) return 1;

  const gain = (grade: number, position: number) => (2 ** grade - 1) / Math.log2(position + 2);

  const dcg = ranked.slice(0, k).reduce((sum, id, i) => sum + gain(grades.get(id) ?? 0, i), 0);

  const ideal = [...grades.values()]
    .sort((a, b) => b - a)
    .slice(0, k)
    .reduce((sum, grade, i) => sum + gain(grade, i), 0);

  return ideal === 0 ? 0 : dcg / ideal;
}

export const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
