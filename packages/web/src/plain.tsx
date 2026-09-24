import { RRF_K, tokenize, type Scored } from '@rag/core';
import type { ReactNode } from 'react';
import type { ChunkMeta } from './retrieval.worker.ts';
import type { AnswerState } from './use-answer.ts';
import type { Run } from './use-retrieval.ts';

/**
 * Every stage explained twice: once as it would be to someone meeting the
 * idea for the first time, then technically.
 *
 * The plain half has two parts. An analogy, which is the same for every
 * question. And what happened to this question, written as sentences built
 * from the run's own numbers, so the simple version is exact rather than
 * approximate: "colour is in 34 of 1,592 chunks" is both easy to read and
 * true.
 */

export type Plain = { analogy: ReactNode; yours: ReactNode[] };

const n = (value: number) => value.toLocaleString('en-GB');
const q = (text: string) => <strong className="font-medium text-ink">“{text}”</strong>;
const word = (text: string) => <code className="rounded bg-paper px-1 font-mono text-[0.9em]">{text}</code>;

const rankIn = (hits: Scored[] | undefined, id: string) => {
  const index = hits?.findIndex((hit) => hit.chunkId === id) ?? -1;
  return index === -1 ? undefined : index + 1;
};

type Ctx = { run: Run; meta: Map<string, ChunkMeta>; title: (id: string) => string };

export function tokenizePlain({ run }: Ctx): Plain {
  const tokens = [...new Set(tokenize(run.query))];
  const df = new Map(run.bm25.terms.map((t) => [t.term, t.df]));
  const found = tokens.filter((t) => (df.get(t) ?? 0) > 0);
  const missing = tokens.filter((t) => (df.get(t) ?? 0) === 0);
  const rare = [...found].sort((a, b) => df.get(a)! - df.get(b)!)[0];
  const common = [...found].sort((a, b) => df.get(b)! - df.get(a)!)[0];
  const compound = tokens.find((t) => /[-_.]/.test(t) && !/^\d+(\.\d+)+$/.test(t));
  const dotted = tokens.find((t) => /^\d+(\.\d+)+$/.test(t));
  const total = run.bm25.docCount;

  const yours: ReactNode[] = [
    <>
      Your question was cut into {tokens.length} word cards: {tokens.map((t, i) => <span key={t}>{i > 0 && ', '}{word(t)}</span>)}.
      Capital letters were dropped, so {word('Colour')} and {word('colour')} are the same card.
    </>,
  ];
  if (rare && common && rare !== common) {
    // "Everywhere" only when it is: a word in 29 of 1,592 chunks is rare too, just less rare.
    const everywhere = df.get(common)! / total > 0.2;
    yours.push(
      everywhere ? (
        <>
          Some cards are everywhere: {word(common)} is in {n(df.get(common)!)} of the {n(total)} chunks, so finding it
          tells us very little. Some are rare: {word(rare)} is in only {n(df.get(rare)!)}, so finding it is a strong clue.
        </>
      ) : (
        <>
          All your cards are fairly rare, which makes them good clues. The rarest, {word(rare)}, is in only{' '}
          {n(df.get(rare)!)} of the {n(total)} chunks; the most common, {word(common)}, is in {n(df.get(common)!)}. The
          rarer the card, the more a match counts.
        </>
      ),
    );
  }
  if (missing.length > 0) {
    yours.push(
      <>
        {missing.map((t, i) => <span key={t}>{i > 0 && ', '}{word(t)}</span>)} {missing.length === 1 ? 'is' : 'are'} in no
        chunk at all, so {missing.length === 1 ? 'it' : 'they'} cannot help the word search.
      </>,
    );
  }
  if (compound) {
    yours.push(<>{word(compound)} was kept as one card and also split into its parts, so a search for either one finds it.</>);
  }
  if (dotted) {
    yours.push(<>{word(dotted)} was kept whole on purpose: split into its numbers, it would match every numbered criterion.</>);
  }

  return {
    analogy: (
      <>
        Before a computer can look for words, it has to know what the words are. So the question is cut into small
        cards, one per word, like cutting a sentence out of a newspaper word by word. Each card is then looked up in an
        index, the way you look a word up at the back of a textbook to see which pages mention it.
      </>
    ),
    yours,
  };
}

export function bm25Plain({ run, title }: Ctx): Plain {
  const { bm25 } = run;
  const lexical = run.stages.find((s) => s.name === 'lexical')?.hits ?? [];
  const yours: ReactNode[] = [];

  if (!bm25.chunkId || lexical.length === 0) {
    yours.push(<>None of your words appear in the index, so the word search found nothing. The meaning search still ran.</>);
  } else {
    const total = bm25.terms.reduce((sum, t) => sum + t.score, 0);
    const present = bm25.terms.filter((t) => t.tf > 0).sort((a, b) => b.score - a.score);
    const absent = bm25.terms.filter((t) => t.tf === 0 && t.df > 0);
    const best = present[0];
    const weak = present.length > 1 ? present.at(-1) : undefined;
    const ratio = (bm25.docLength ?? bm25.avgdl) / bm25.avgdl;

    yours.push(
      <>
        Every chunk containing at least one of your words got a score. The winner was {q(title(bm25.chunkId))}, with{' '}
        {total.toFixed(2)} points.
      </>,
    );
    if (best) {
      yours.push(
        <>
          Most of those points came from {word(best.term)}: it appears {best.tf} {best.tf === 1 ? 'time' : 'times'} in
          that chunk, and only {n(best.df)} chunks contain it at all, so it was worth {best.score.toFixed(2)}.
        </>,
      );
    }
    if (weak && weak !== best) {
      yours.push(
        <>
          {word(weak.term)} is in the chunk too, but it is in {n(weak.df)} chunks overall, so it was worth only{' '}
          {weak.score.toFixed(2)}. The more chunks a word is in, the less it proves.
        </>,
      );
    }
    if (absent.length > 0) {
      yours.push(
        <>
          {absent.map((t, i) => <span key={t.term}>{i > 0 && ', '}{word(t.term)}</span>)} {absent.length === 1 ? 'is' : 'are'} not
          in that chunk, so {absent.length === 1 ? 'it' : 'they'} added nothing to its score.
        </>,
      );
    }
    yours.push(
      ratio > 1.3 ? (
        <>The chunk is longer than average ({bm25.docLength} tokens against {bm25.avgdl.toFixed(0)}), so each match counted a little less: a long page mentions many things.</>
      ) : ratio < 0.77 ? (
        <>The chunk is shorter than average ({bm25.docLength} tokens against {bm25.avgdl.toFixed(0)}), so each match counted a little more: a short page that mentions your word is probably about it.</>
      ) : (
        <>The chunk is about average length ({bm25.docLength} tokens against {bm25.avgdl.toFixed(0)}), so its length neither helped nor hurt.</>
      ),
    );
    yours.push(<>The best {lexical.length} were kept and passed on.</>);
  }

  return {
    analogy: (
      <>
        Imagine a librarian with the index of every book. For each page, they count how many of your words it contains.
        Two rules make it clever. A rare word is worth much more than a common one: “the” is on every page, “contrast” is
        not. And saying a word ten times is not ten times better: each extra mention counts less than the one before. Long pages
        are handicapped a little, because they mention everything.
      </>
    ),
    yours,
  };
}

export function densePlain({ run, meta, title }: Ctx): Plain {
  const dense = run.stages.find((s) => s.name === 'dense')?.hits ?? [];
  const lexical = run.stages.find((s) => s.name === 'lexical')?.hits;
  const yours: ReactNode[] = [];

  if (dense.length === 0) {
    yours.push(<>The meaning search did not run for this question, so only the word search was used.</>);
  } else {
    const top = dense[0]!;
    const lexicalRank = rankIn(lexical, top.chunkId);
    const missedByWords = dense.slice(0, 10).filter((hit) => rankIn(lexical, hit.chunkId) === undefined).length;
    yours.push(
      <>
        Your question was turned into a point in a space with {run.vector?.length ?? 384} directions. Every chunk already
        had its point, computed once when the site was built.
      </>,
    );
    yours.push(
      <>
        The nearest point was {q(title(top.chunkId))}, with a similarity of {top.score.toFixed(3)}. 1.000 would mean
        pointing the exact same way; unrelated text sits much lower.
      </>,
    );
    // Near in meaning is not the same as right. A criterion number carries
    // almost no meaning for an embedding, so say so when it shows.
    const asked = run.query.match(/\b\d+\.\d+\.\d+\b/)?.[0];
    const found = meta.get(top.chunkId)?.scRef;
    const wrongCriterion = asked !== undefined && found !== undefined && found !== asked;

    if (wrongCriterion) {
      yours.push(
        <>
          But that chunk is about {word(found)}, not the {word(asked)} you asked about. To this search a number like{' '}
          {word(asked)} means almost nothing, so it found text that sounds similar instead. This is exactly the gap the
          word search fills.
        </>,
      );
    } else {
      yours.push(
        lexicalRank === undefined ? (
          <>The word search did not find that chunk at all, so it shares few of your exact words.</>
        ) : lexicalRank > 5 ? (
          <>The word search had ranked that same chunk only #{lexicalRank}: it uses fewer of your exact words.</>
        ) : (
          <>The word search agreed: it ranked the same chunk #{lexicalRank}.</>
        ),
      );
    }
    if (missedByWords > 0) {
      yours.push(
        <>
          {missedByWords} of the 10 nearest in meaning were not among the word search’s {lexical?.length ?? 30} results.
          The two searches notice different things, which is why both are used and then combined.
        </>,
      );
    }
  }

  return {
    analogy: (
      <>
        Imagine a huge map where every passage is a pin, placed by what it means rather than by the words it uses.
        Passages about the same idea sit close together, even if one says “colour contrast” and another says “text that
        is hard to see”. Your question gets a pin too, and we look for the pins nearest to it. The map was drawn by a
        neural network that read millions of sentences and learned which ones mean similar things.
      </>
    ),
    yours,
  };
}

export function rrfPlain({ run, title }: Ctx): Plain {
  const dense = run.stages.find((s) => s.name === 'dense')?.hits;
  const lexical = run.stages.find((s) => s.name === 'lexical')?.hits;
  const fused = run.stages.find((s) => s.name === 'fused')?.hits ?? [];
  const yours: ReactNode[] = [];
  const vote = (rank: number | undefined) => (rank === undefined ? 0 : 1 / (RRF_K + rank));

  const top = fused[0];
  if (top) {
    const d = rankIn(dense, top.chunkId);
    const l = rankIn(lexical, top.chunkId);
    yours.push(
      <>
        The winner was {q(title(top.chunkId))}:{' '}
        {d !== undefined && l !== undefined ? (
          <>
            #{d} by meaning and #{l} by words, so 1/(60+{d}) + 1/(60+{l}) = {top.score.toFixed(4)}.
          </>
        ) : (
          <>on one list only, with {top.score.toFixed(4)}.</>
        )}
      </>,
    );
    const both = fused.filter((hit) => rankIn(dense, hit.chunkId) !== undefined && rankIn(lexical, hit.chunkId) !== undefined).length;
    yours.push(<>{both} of the {fused.length} passages kept were on both lists.</>);

    // The clearest lesson: something first on one list that fusion still ranked below a double-listed one.
    const soloFirst = [dense?.[0], lexical?.[0]].find(
      (hit) => hit && (rankIn(dense, hit.chunkId) === undefined || rankIn(lexical, hit.chunkId) === undefined),
    );
    if (soloFirst) {
      const fusedRank = rankIn(fused, soloFirst.chunkId);
      yours.push(
        <>
          {q(title(soloFirst.chunkId))} was first on one list but missing from the other, so it got only{' '}
          {vote(1).toFixed(4)} and ended at #{fusedRank ?? 'below 30'}. Being liked by both beats being loved by one.
        </>,
      );
    }
  }

  return {
    analogy: (
      <>
        Two friends each give you their top 30 list: one picked by words, one by meaning. Their scores cannot be
        compared, like marks out of 10 and marks out of 100. So we ignore the scores and use only the positions: being
        first on a list is worth a little more than being second, and so on. A passage that appears on both lists
        collects points from both, so passages both friends agree on rise to the top.
      </>
    ),
    yours,
  };
}

export function rerankPlain({ run, title }: Ctx): Plain {
  const fused = run.stages.find((s) => s.name === 'fused')?.hits ?? [];
  const yours: ReactNode[] = [];
  const moves = run.final.map((hit, i) => ({ hit, from: rankIn(fused, hit.chunkId) ?? fused.length, to: i + 1 }));
  const biggest = [...moves].sort((a, b) => b.from - b.to - (a.from - a.to))[0];
  const stayed = moves.filter((m) => m.from <= run.final.length).length;

  if (run.degraded.some((d) => d.stage === 'rerank')) {
    yours.push(<>The careful reader was not available this time, so the first 8 of the combined list were used as they were.</>);
  } else {
    yours.push(<>It read {fused.length} passages next to your question and kept the best {run.final.length}.</>);
    if (biggest && biggest.from > biggest.to) {
      yours.push(
        <>
          The biggest jump was {q(title(biggest.hit.chunkId))}: #{biggest.from} before, #{biggest.to} after. The fast
          searches had underrated it.
        </>,
      );
    }
    yours.push(<>{stayed} of the final {run.final.length} were already in the combined top {run.final.length}; the rest were rescued from further down.</>);
  }

  return {
    analogy: (
      <>
        The first searches are like skimming book titles in a shop: fast, and good enough to fill a basket. This step is
        like sitting down and reading the question and each passage side by side, carefully, to decide which really
        answer it. It is too slow to do for all 1,592 passages, so it only reads the 30 in the basket.
      </>
    ),
    yours,
  };
}

export function generatePlain({ answer, run }: { answer: AnswerState; run: Run }): Plain {
  const yours: ReactNode[] = [];
  if (answer.phase === 'idle' || answer.phase === 'generating') yours.push(<>The model is still writing.</>);
  else if (answer.phase === 'unavailable') yours.push(<>No model could answer this time, so only the sources are shown.</>);
  else {
    const generated = answer.phase === 'verifying' ? answer.answer : answer.result.answer;
    const model = answer.phase === 'answered' ? answer.result.model : undefined;
    yours.push(
      <>
        {model ? <>{word(model)} </> : 'The model '}read the {run.final.length} passages and your question, and nothing
        else.
      </>,
    );
    yours.push(
      generated.answerable ? (
        <>
          It wrote {generated.sentences.length} {generated.sentences.length === 1 ? 'sentence' : 'sentences'} and{' '}
          {generated.claims.length} {generated.claims.length === 1 ? 'citation' : 'citations'}, each with a quote it says it
          copied from a passage.
        </>
      ) : (
        <>It said the passages do not answer the question. Saying “I don’t know” is counted as a correct answer here.</>
      ),
    );
  }

  return {
    analogy: (
      <>
        Think of an open-book exam with a strict rule. The student may only use the 8 pages on the desk, and every
        sentence they write must come with a quotation copied word for word from one of those pages, like a footnote.
        If the pages do not contain the answer, the student must say so instead of guessing.
      </>
    ),
    yours,
  };
}

export function verifyPlain({ answer }: { answer: AnswerState }): Plain {
  const yours: ReactNode[] = [];
  if (answer.phase !== 'answered') {
    yours.push(answer.phase === 'unavailable' ? <>There was no answer to check.</> : <>Waiting for the answer to check.</>);
  } else {
    const { claims } = answer.result;
    const found = claims.filter((c) => c.quoteMatch).length;
    const count = (status: string) => claims.filter((c) => c.status === status).length;
    const levels = claims.filter((c) => c.levelOmitted).length;
    yours.push(
      <>
        Of {claims.length} {claims.length === 1 ? 'quotation' : 'quotations'}, {found} {found === 1 ? 'was' : 'were'} really
        in the cited passage{claims.length - found > 0 ? <>, and {claims.length - found} {claims.length - found === 1 ? 'was' : 'were'} not: invented or misquoted</> : ''}.
      </>,
    );
    yours.push(
      <>
        After reading them, {count('verified')} {count('verified') === 1 ? 'sentence is' : 'sentences are'} verified,{' '}
        {count('partial')} partly supported, {count('unsupported')} unsupported
        {count('unverified') > 0 ? <>, and {count('unverified')} could not be checked because the judge was unavailable</> : ''}.
      </>,
    );
    if (levels > 0) {
      yours.push(<>{levels} {levels === 1 ? 'sentence gave' : 'sentences gave'} a WCAG number without saying which level it belongs to, so it was held at partial.</>);
    }
  }

  return {
    analogy: (
      <>
        Now the teacher marks the exam. First, for every quotation, they search the page for those exact words, like
        pressing Ctrl+F. If the words are not there, the quotation was invented, and the sentence fails. Only for the
        quotations that are really there does the teacher do the slower part: read the page and ask whether it actually
        backs up what the student wrote.
      </>
    ),
    yours,
  };
}

/** The block itself: the analogy, then this question's own story. */
export function PlainWords({ plain }: { plain: Plain }) {
  return (
    <div className="rounded-2xl bg-raised p-5">
      <h4 className="font-medium">In plain words</h4>
      <p className="mt-2 max-w-[65ch] text-lg leading-relaxed">{plain.analogy}</p>
      {plain.yours.length > 0 && (
        <>
          <h4 className="mt-5 font-medium">What happened to your question</h4>
          <ul className="mt-2 max-w-[65ch] list-disc space-y-2 pl-5 leading-relaxed text-ink-2">
            {plain.yours.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
