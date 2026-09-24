import { RRF_K, tokenize, type Scored } from '@rag/core';
import type { ReactNode } from 'react';
import { useLang } from './i18n.tsx';
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
 * true. Each sentence is written in both languages side by side, because the
 * numbers slot into different places in English and Italian.
 */

export type Plain = { analogy: ReactNode; yours: ReactNode[] };

type T = ReturnType<typeof useLang>['t'];
type Num = ReturnType<typeof useLang>['num'];

const q = (text: string) => (
  <strong className="font-medium text-ink" lang="en">
    “{text}”
  </strong>
);
const word = (text: string) => (
  <code className="rounded bg-paper px-1 font-mono text-[0.9em]" lang="en">
    {text}
  </code>
);
const words = (list: string[], and: string) =>
  list.map((w, i) => (
    <span key={w}>
      {i > 0 && (i === list.length - 1 ? ` ${and} ` : ', ')}
      {word(w)}
    </span>
  ));

const rankIn = (hits: Scored[] | undefined, id: string) => {
  const index = hits?.findIndex((hit) => hit.chunkId === id) ?? -1;
  return index === -1 ? undefined : index + 1;
};

type Ctx = { run: Run; meta: Map<string, ChunkMeta>; title: (id: string) => string; t: T; num: Num };

export function tokenizePlain({ run, t, num }: Ctx): Plain {
  const tokens = [...new Set(tokenize(run.query))];
  const df = new Map(run.bm25.terms.map((term) => [term.term, term.df]));
  const found = tokens.filter((token) => (df.get(token) ?? 0) > 0);
  const missing = tokens.filter((token) => (df.get(token) ?? 0) === 0);
  const rare = [...found].sort((a, b) => df.get(a)! - df.get(b)!)[0];
  const common = [...found].sort((a, b) => df.get(b)! - df.get(a)!)[0];
  const compound = tokens.find((token) => /[-_.]/.test(token) && !/^\d+(\.\d+)+$/.test(token));
  const dotted = tokens.find((token) => /^\d+(\.\d+)+$/.test(token));
  const total = run.bm25.docCount;

  const yours: ReactNode[] = [
    t(
      <>
        Your question was cut into {tokens.length} word cards: {words(tokens, 'and')}. Capital letters were dropped, so{' '}
        {word('Colour')} and {word('colour')} are the same card.
      </>,
      <>
        La tua domanda è stata tagliata in {tokens.length} cartellini, uno per parola: {words(tokens, 'e')}. Le maiuscole
        sono state tolte, quindi {word('Colour')} e {word('colour')} sono lo stesso cartellino.
      </>,
    ),
  ];
  if (rare && common && rare !== common) {
    // "Everywhere" only when it is: a word in 29 of 1,592 chunks is rare too, just less rare.
    const everywhere = df.get(common)! / total > 0.2;
    yours.push(
      everywhere
        ? t(
            <>
              Some cards are everywhere: {word(common)} is in {num(df.get(common)!)} of the {num(total)} chunks, so finding
              it tells us very little. Some are rare: {word(rare)} is in only {num(df.get(rare)!)}, so finding it is a strong
              clue.
            </>,
            <>
              Alcuni cartellini sono dappertutto: {word(common)} è in {num(df.get(common)!)} dei {num(total)} chunk, quindi
              trovarlo dice pochissimo. Altri sono rari: {word(rare)} è solo in {num(df.get(rare)!)}, quindi trovarlo è un
              indizio forte.
            </>,
          )
        : t(
            <>
              All your cards are fairly rare, which makes them good clues. The rarest, {word(rare)}, is in only{' '}
              {num(df.get(rare)!)} of the {num(total)} chunks; the most common, {word(common)}, is in {num(df.get(common)!)}.
              The rarer the card, the more a match counts.
            </>,
            <>
              Tutti i tuoi cartellini sono piuttosto rari, quindi sono buoni indizi. Il più raro, {word(rare)}, è solo in{' '}
              {num(df.get(rare)!)} dei {num(total)} chunk; il più comune, {word(common)}, è in {num(df.get(common)!)}. Più il
              cartellino è raro, più conta quando lo si trova.
            </>,
          ),
    );
  }
  if (missing.length > 0) {
    yours.push(
      t(
        <>
          {words(missing, 'and')} {missing.length === 1 ? 'is' : 'are'} in no chunk at all, so{' '}
          {missing.length === 1 ? 'it' : 'they'} cannot help the word search.
        </>,
        <>
          {words(missing, 'e')} non {missing.length === 1 ? 'compare' : 'compaiono'} in nessun chunk, quindi non{' '}
          {missing.length === 1 ? 'può' : 'possono'} aiutare la ricerca per parole.
        </>,
      ),
    );
  }
  if (compound) {
    yours.push(
      t(
        <>{word(compound)} was kept as one card and also split into its parts, so a search for either one finds it.</>,
        <>{word(compound)} è stato tenuto come un solo cartellino e anche diviso nelle sue parti, così lo trova una ricerca per l’intero o per una parte.</>,
      ),
    );
  }
  if (dotted) {
    yours.push(
      t(
        <>{word(dotted)} was kept whole on purpose: split into its numbers, it would match every numbered criterion.</>,
        <>{word(dotted)} è stato tenuto intero di proposito: diviso nei suoi numeri, combacerebbe con ogni criterio numerato.</>,
      ),
    );
  }

  return {
    analogy: t(
      <>
        Before a computer can look for words, it has to know what the words are. So the question is cut into small cards,
        one per word, like cutting a sentence out of a newspaper word by word. Each card is then looked up in an index, the
        way you look a word up at the back of a textbook to see which pages mention it.
      </>,
      <>
        Prima di cercare delle parole, il computer deve sapere quali sono. Quindi la domanda viene tagliata in piccoli
        cartellini, uno per parola, come ritagliare una frase da un giornale parola per parola. Poi ogni cartellino viene
        cercato in un indice, come quando cerchi una parola nell’indice in fondo al libro di scuola per vedere quali pagine
        ne parlano.
      </>,
    ),
    yours,
  };
}

export function bm25Plain({ run, title, t, num }: Ctx): Plain {
  const { bm25 } = run;
  const lexical = run.stages.find((s) => s.name === 'lexical')?.hits ?? [];
  const yours: ReactNode[] = [];

  if (!bm25.chunkId || lexical.length === 0) {
    yours.push(
      t(
        <>None of your words appear in the index, so the word search found nothing. The meaning search still ran.</>,
        <>Nessuna delle tue parole è nell’indice, quindi la ricerca per parole non ha trovato nulla. La ricerca per significato ha lavorato lo stesso.</>,
      ),
    );
  } else {
    const total = bm25.terms.reduce((sum, term) => sum + term.score, 0);
    const present = bm25.terms.filter((term) => term.tf > 0).sort((a, b) => b.score - a.score);
    const absent = bm25.terms.filter((term) => term.tf === 0 && term.df > 0);
    const best = present[0];
    const weak = present.length > 1 ? present.at(-1) : undefined;
    const ratio = (bm25.docLength ?? bm25.avgdl) / bm25.avgdl;
    const avg = num(Math.round(bm25.avgdl));

    yours.push(
      t(
        <>
          Every chunk containing at least one of your words got a score. The winner was {q(title(bm25.chunkId))}, with{' '}
          {num(total, 2)} points.
        </>,
        <>
          Ogni chunk che contiene almeno una delle tue parole ha preso un punteggio. Ha vinto {q(title(bm25.chunkId))}, con{' '}
          {num(total, 2)} punti.
        </>,
      ),
    );
    if (best) {
      yours.push(
        t(
          <>
            Most of those points came from {word(best.term)}: it appears {best.tf} {best.tf === 1 ? 'time' : 'times'} in
            that chunk, and only {num(best.df)} chunks contain it at all, so it was worth {num(best.score, 2)}.
          </>,
          <>
            La maggior parte di quei punti viene da {word(best.term)}: compare {best.tf} {best.tf === 1 ? 'volta' : 'volte'} in
            quel chunk, e in tutto solo {num(best.df)} chunk la contengono, quindi è valsa {num(best.score, 2)}.
          </>,
        ),
      );
    }
    if (weak && weak !== best) {
      yours.push(
        t(
          <>
            {word(weak.term)} is in the chunk too, but it is in {num(weak.df)} chunks overall, so it was worth only{' '}
            {num(weak.score, 2)}. The more chunks a word is in, the less it proves.
          </>,
          <>
            Anche {word(weak.term)} è nel chunk, ma compare in {num(weak.df)} chunk in tutto, quindi è valsa solo{' '}
            {num(weak.score, 2)}. Più chunk contengono una parola, meno quella parola dimostra.
          </>,
        ),
      );
    }
    if (absent.length > 0) {
      const list = absent.map((term) => term.term);
      yours.push(
        t(
          <>
            {words(list, 'and')} {list.length === 1 ? 'is' : 'are'} not in that chunk, so {list.length === 1 ? 'it' : 'they'}{' '}
            added nothing to its score.
          </>,
          <>
            {words(list, 'e')} non {list.length === 1 ? 'è' : 'sono'} in quel chunk, quindi non{' '}
            {list.length === 1 ? 'ha' : 'hanno'} aggiunto nulla al suo punteggio.
          </>,
        ),
      );
    }
    yours.push(
      ratio > 1.3
        ? t(
            <>The chunk is longer than average ({bm25.docLength} tokens against {avg}), so each match counted a little less: a long page mentions many things.</>,
            <>Il chunk è più lungo della media ({bm25.docLength} token contro {avg}), quindi ogni corrispondenza è contata un po’ meno: una pagina lunga parla di molte cose.</>,
          )
        : ratio < 0.77
          ? t(
              <>The chunk is shorter than average ({bm25.docLength} tokens against {avg}), so each match counted a little more: a short page that mentions your word is probably about it.</>,
              <>Il chunk è più corto della media ({bm25.docLength} token contro {avg}), quindi ogni corrispondenza è contata un po’ di più: una pagina corta che nomina la tua parola probabilmente parla proprio di quello.</>,
            )
          : t(
              <>The chunk is about average length ({bm25.docLength} tokens against {avg}), so its length neither helped nor hurt.</>,
              <>Il chunk ha una lunghezza nella media ({bm25.docLength} token contro {avg}), quindi la lunghezza non ha né aiutato né penalizzato.</>,
            ),
    );
    yours.push(t(<>The best {lexical.length} were kept and passed on.</>, <>I migliori {lexical.length} sono stati tenuti e passati avanti.</>));
  }

  return {
    analogy: t(
      <>
        Imagine a librarian with the index of every book. For each page, they count how many of your words it contains. Two
        rules make it clever. A rare word is worth much more than a common one: “the” is on every page, “contrast” is not.
        And saying a word ten times is not ten times better: each extra mention counts less than the one before. Long pages
        are handicapped a little, because they mention everything.
      </>,
      <>
        Immagina un bibliotecario con l’indice di ogni libro. Per ogni pagina conta quante delle tue parole contiene. Due
        regole lo rendono furbo. Una parola rara vale molto più di una comune: “the” è in ogni pagina, “contrast” no. E
        ripetere una parola dieci volte non vale dieci volte tanto: ogni menzione in più conta meno della precedente. Le
        pagine lunghe sono un po’ penalizzate, perché parlano di tutto.
      </>,
    ),
    yours,
  };
}

export function densePlain({ run, meta, title, t }: Ctx): Plain {
  const dense = run.stages.find((s) => s.name === 'dense')?.hits ?? [];
  const lexical = run.stages.find((s) => s.name === 'lexical')?.hits;
  const yours: ReactNode[] = [];

  if (dense.length === 0) {
    yours.push(
      t(
        <>The meaning search did not run for this question, so only the word search was used.</>,
        <>La ricerca per significato non ha lavorato per questa domanda, quindi è stata usata solo quella per parole.</>,
      ),
    );
  } else {
    const top = dense[0]!;
    const lexicalRank = rankIn(lexical, top.chunkId);
    const missedByWords = dense.slice(0, 10).filter((hit) => rankIn(lexical, hit.chunkId) === undefined).length;
    const dims = run.vector?.length ?? 384;
    yours.push(
      t(
        <>Your question was turned into a point in a space with {dims} directions. Every chunk already had its point, computed once when the site was built.</>,
        <>La tua domanda è stata trasformata in un punto in uno spazio con {dims} direzioni. Ogni chunk aveva già il suo punto, calcolato una volta sola quando il sito è stato costruito.</>,
      ),
    );
    yours.push(
      t(
        <>
          The nearest point was {q(title(top.chunkId))}, with a similarity of {top.score.toFixed(3)}. 1.000 would mean
          pointing the exact same way; unrelated text sits much lower.
        </>,
        <>
          Il punto più vicino era {q(title(top.chunkId))}, con una similarità di {top.score.toFixed(3).replace('.', ',')}. 1,000
          vorrebbe dire puntare esattamente nella stessa direzione; un testo che non c’entra sta molto più in basso.
        </>,
      ),
    );

    // Near in meaning is not the same as right. A criterion number carries
    // almost no meaning for an embedding, so say so when it shows.
    const asked = run.query.match(/\b\d+\.\d+\.\d+\b/)?.[0];
    const found = meta.get(top.chunkId)?.scRef;
    if (asked !== undefined && found !== undefined && found !== asked) {
      yours.push(
        t(
          <>
            But that chunk is about {word(found)}, not the {word(asked)} you asked about. To this search a number like{' '}
            {word(asked)} means almost nothing, so it found text that sounds similar instead. This is exactly the gap the
            word search fills.
          </>,
          <>
            Però quel chunk parla di {word(found)}, non del {word(asked)} che hai chiesto. Per questa ricerca un numero come{' '}
            {word(asked)} non significa quasi nulla, quindi ha trovato un testo che “suona” simile. È proprio il buco che
            copre la ricerca per parole.
          </>,
        ),
      );
    } else {
      yours.push(
        lexicalRank === undefined
          ? t(
              <>The word search did not find that chunk at all, so it shares few of your exact words.</>,
              <>La ricerca per parole non ha trovato affatto quel chunk, quindi condivide poche delle tue parole esatte.</>,
            )
          : lexicalRank > 5
            ? t(
                <>The word search had ranked that same chunk only #{lexicalRank}: it uses fewer of your exact words.</>,
                <>La ricerca per parole aveva messo quello stesso chunk solo al #{lexicalRank}: usa meno parole esatte della tua domanda.</>,
              )
            : t(
                <>The word search agreed: it ranked the same chunk #{lexicalRank}.</>,
                <>La ricerca per parole era d’accordo: ha messo lo stesso chunk al #{lexicalRank}.</>,
              ),
      );
    }
    if (missedByWords > 0) {
      yours.push(
        t(
          <>
            {missedByWords} of the 10 nearest in meaning were not among the word search’s {lexical?.length ?? 30} results.
            The two searches notice different things, which is why both are used and then combined.
          </>,
          <>
            {missedByWords} dei 10 più vicini per significato non erano fra i {lexical?.length ?? 30} risultati della ricerca
            per parole. Le due ricerche notano cose diverse, ed è per questo che si usano entrambe e poi si combinano.
          </>,
        ),
      );
    }
  }

  return {
    analogy: t(
      <>
        Imagine a huge map where every passage is a pin, placed by what it means rather than by the words it uses. Passages
        about the same idea sit close together, even if one says “colour contrast” and another says “text that is hard to
        see”. Your question gets a pin too, and we look for the pins nearest to it. The map was drawn by a neural network
        that read millions of sentences and learned which ones mean similar things.
      </>,
      <>
        Immagina una mappa enorme dove ogni passaggio è una puntina, messa in base a cosa significa e non alle parole che
        usa. I passaggi sulla stessa idea stanno vicini, anche se uno dice “colour contrast” e un altro “text that is hard to
        see”. Anche la tua domanda riceve una puntina, e cerchiamo le puntine più vicine. La mappa l’ha disegnata una rete
        neurale che ha letto milioni di frasi e ha imparato quali significano cose simili.
      </>,
    ),
    yours,
  };
}

export function rrfPlain({ run, title, t }: Ctx): Plain {
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
      d !== undefined && l !== undefined
        ? t(
            <>
              The winner was {q(title(top.chunkId))}: #{d} by meaning and #{l} by words, so 1/(60+{d}) + 1/(60+{l}) ={' '}
              {top.score.toFixed(4)}.
            </>,
            <>
              Ha vinto {q(title(top.chunkId))}: #{d} per significato e #{l} per parole, quindi 1/(60+{d}) + 1/(60+{l}) ={' '}
              {top.score.toFixed(4).replace('.', ',')}.
            </>,
          )
        : t(
            <>The winner was {q(title(top.chunkId))}, on one list only, with {top.score.toFixed(4)}.</>,
            <>Ha vinto {q(title(top.chunkId))}, presente in una sola lista, con {top.score.toFixed(4).replace('.', ',')}.</>,
          ),
    );
    const both = fused.filter((hit) => rankIn(dense, hit.chunkId) !== undefined && rankIn(lexical, hit.chunkId) !== undefined).length;
    yours.push(
      t(
        <>{both} of the {fused.length} passages kept were on both lists.</>,
        <>{both} dei {fused.length} passaggi tenuti erano in entrambe le liste.</>,
      ),
    );

    // The clearest lesson: something first on one list that fusion still ranked below a double-listed one.
    const soloFirst = [dense?.[0], lexical?.[0]].find(
      (hit) => hit && (rankIn(dense, hit.chunkId) === undefined || rankIn(lexical, hit.chunkId) === undefined),
    );
    if (soloFirst) {
      const fusedRank = rankIn(fused, soloFirst.chunkId);
      yours.push(
        t(
          <>
            {q(title(soloFirst.chunkId))} was first on one list but missing from the other, so it got only{' '}
            {vote(1).toFixed(4)} and ended at #{fusedRank ?? 'below 30'}. Being liked by both beats being loved by one.
          </>,
          <>
            {q(title(soloFirst.chunkId))} era primo in una lista ma mancava dall’altra, quindi ha preso solo{' '}
            {vote(1).toFixed(4).replace('.', ',')} ed è finito al #{fusedRank ?? 'oltre il 30'}. Piacere abbastanza a tutti e due
            batte piacere tantissimo a uno solo.
          </>,
        ),
      );
    }
  }

  return {
    analogy: t(
      <>
        Two friends each give you their top 30 list: one picked by words, one by meaning. Their scores cannot be compared,
        like marks out of 10 and marks out of 100. So we ignore the scores and use only the positions: being first on a list
        is worth a little more than being second, and so on. A passage that appears on both lists collects points from both,
        so passages both friends agree on rise to the top.
      </>,
      <>
        Due amici ti danno ciascuno la loro top 30: uno sceglie per parole, l’altro per significato. I loro punteggi non si
        possono confrontare, come voti in decimi e voti in centesimi. Allora ignoriamo i punteggi e usiamo solo le posizioni:
        essere primi in una lista vale un po’ più che essere secondi, e così via. Un passaggio che compare in entrambe le
        liste raccoglie punti da tutte e due, quindi salgono in cima i passaggi su cui i due amici sono d’accordo.
      </>,
    ),
    yours,
  };
}

export function rerankPlain({ run, title, t }: Ctx): Plain {
  const fused = run.stages.find((s) => s.name === 'fused')?.hits ?? [];
  const yours: ReactNode[] = [];
  const moves = run.final.map((hit, i) => ({ hit, from: rankIn(fused, hit.chunkId) ?? fused.length, to: i + 1 }));
  const biggest = [...moves].sort((a, b) => b.from - b.to - (a.from - a.to))[0];
  const stayed = moves.filter((m) => m.from <= run.final.length).length;
  const kept = run.final.length;

  if (run.degraded.some((d) => d.stage === 'rerank')) {
    yours.push(
      t(
        <>The careful reader was not available this time, so the first 8 of the combined list were used as they were.</>,
        <>Questa volta il lettore attento non era disponibile, quindi sono stati usati i primi 8 della lista combinata così com’erano.</>,
      ),
    );
  } else {
    yours.push(
      t(
        <>It read {fused.length} passages next to your question and kept the best {kept}.</>,
        <>Ha letto {fused.length} passaggi accanto alla tua domanda e ha tenuto i migliori {kept}.</>,
      ),
    );
    if (biggest && biggest.from > biggest.to) {
      yours.push(
        t(
          <>
            The biggest jump was {q(title(biggest.hit.chunkId))}: #{biggest.from} before, #{biggest.to} after. The fast
            searches had underrated it.
          </>,
          <>
            Il salto più grande l’ha fatto {q(title(biggest.hit.chunkId))}: #{biggest.from} prima, #{biggest.to} dopo. Le
            ricerche veloci l’avevano sottovalutato.
          </>,
        ),
      );
    }
    yours.push(
      t(
        <>{stayed} of the final {kept} were already in the combined top {kept}; the rest were rescued from further down.</>,
        <>{stayed} degli {kept} finali erano già nei primi {kept} della lista combinata; gli altri sono stati recuperati più in basso.</>,
      ),
    );
  }

  return {
    analogy: t(
      <>
        The first searches are like skimming book titles in a shop: fast, and good enough to fill a basket. This step is like
        sitting down and reading the question and each passage side by side, carefully, to decide which really answer it. It
        is too slow to do for all 1,592 passages, so it only reads the 30 in the basket.
      </>,
      <>
        Le prime ricerche sono come scorrere i titoli dei libri in una libreria: veloce, e basta per riempire un cestino.
        Questa fase è come sedersi e leggere con calma la domanda e ogni passaggio uno accanto all’altro, per decidere quali
        rispondono davvero. È troppo lenta per farla su tutti i 1.592 passaggi, quindi legge solo i 30 nel cestino.
      </>,
    ),
    yours,
  };
}

export function generatePlain({ answer, run, t }: { answer: AnswerState; run: Run; t: T }): Plain {
  const yours: ReactNode[] = [];
  if (answer.phase === 'idle' || answer.phase === 'generating') {
    yours.push(t(<>The model is still writing.</>, <>Il modello sta ancora scrivendo.</>));
  } else if (answer.phase === 'unavailable') {
    yours.push(t(<>No model could answer this time, so only the sources are shown.</>, <>Questa volta nessun modello ha potuto rispondere, quindi sono mostrate solo le fonti.</>));
  } else {
    const generated = answer.phase === 'verifying' ? answer.answer : answer.result.answer;
    const model = answer.phase === 'answered' ? answer.result.model : undefined;
    const sentences = generated.sentences.length;
    const claims = generated.claims.length;
    yours.push(
      t(
        <>
          {model ? <>{word(model)} </> : 'The model '}read the {run.final.length} passages and your question, and nothing
          else.
        </>,
        <>
          {model ? <>{word(model)} </> : 'Il modello '}ha letto gli {run.final.length} passaggi e la tua domanda, e
          nient’altro.
        </>,
      ),
    );
    yours.push(
      generated.answerable
        ? t(
            <>
              It wrote {sentences} {sentences === 1 ? 'sentence' : 'sentences'} and {claims}{' '}
              {claims === 1 ? 'citation' : 'citations'}, each with a quote it says it copied from a passage.
            </>,
            <>
              Ha scritto {sentences} {sentences === 1 ? 'frase' : 'frasi'} e {claims} {claims === 1 ? 'citazione' : 'citazioni'},
              ognuna con un brano che dice di aver copiato da un passaggio. I brani citati restano in inglese, come la fonte.
            </>,
          )
        : t(
            <>It said the passages do not answer the question. Saying “I don’t know” is counted as a correct answer here.</>,
            <>Ha detto che i passaggi non rispondono alla domanda. Qui dire “non lo so” conta come una risposta corretta.</>,
          ),
    );
  }

  return {
    analogy: t(
      <>
        Think of an open-book exam with a strict rule. The student may only use the 8 pages on the desk, and every sentence
        they write must come with a quotation copied word for word from one of those pages, like a footnote. If the pages do
        not contain the answer, the student must say so instead of guessing.
      </>,
      <>
        Pensa a un compito in classe a libro aperto con una regola severa. Lo studente può usare solo le 8 pagine sul banco,
        e ogni frase che scrive deve avere una citazione copiata parola per parola da una di quelle pagine, come una nota a
        piè di pagina. Se le pagine non contengono la risposta, deve dirlo invece di tirare a indovinare.
      </>,
    ),
    yours,
  };
}

export function verifyPlain({ answer, t }: { answer: AnswerState; t: T }): Plain {
  const yours: ReactNode[] = [];
  if (answer.phase !== 'answered') {
    yours.push(
      answer.phase === 'unavailable'
        ? t(<>There was no answer to check.</>, <>Non c’era nessuna risposta da controllare.</>)
        : t(<>Waiting for the answer to check.</>, <>Aspetto la risposta da controllare.</>),
    );
  } else {
    const { claims } = answer.result;
    const found = claims.filter((c) => c.quoteMatch).length;
    const missing = claims.length - found;
    const count = (status: string) => claims.filter((c) => c.status === status).length;
    const levels = claims.filter((c) => c.levelOmitted).length;
    yours.push(
      t(
        <>
          Of {claims.length} {claims.length === 1 ? 'quotation' : 'quotations'}, {found} {found === 1 ? 'was' : 'were'} really
          in the cited passage
          {missing > 0 ? <>, and {missing} {missing === 1 ? 'was' : 'were'} not: invented or misquoted</> : ''}.
        </>,
        <>
          Su {claims.length} {claims.length === 1 ? 'citazione' : 'citazioni'}, {found} {found === 1 ? 'era' : 'erano'}{' '}
          davvero nel passaggio citato
          {missing > 0 ? <>, e {missing} no: {missing === 1 ? 'inventata o sbagliata' : 'inventate o sbagliate'}</> : ''}.
        </>,
      ),
    );
    yours.push(
      t(
        <>
          After reading them, {count('verified')} {count('verified') === 1 ? 'sentence is' : 'sentences are'} verified,{' '}
          {count('partial')} partly supported, {count('unsupported')} unsupported
          {count('unverified') > 0 ? <>, and {count('unverified')} could not be checked because the judge was unavailable</> : ''}.
        </>,
        <>
          Dopo averle lette, {count('verified')} {count('verified') === 1 ? 'frase è verificata' : 'frasi sono verificate'},{' '}
          {count('partial')} supportate in parte, {count('unsupported')} non supportate
          {count('unverified') > 0 ? <>, e {count('unverified')} non si sono potute controllare perché il giudice non era disponibile</> : ''}.
        </>,
      ),
    );
    if (levels > 0) {
      yours.push(
        t(
          <>{levels} {levels === 1 ? 'sentence gave' : 'sentences gave'} a WCAG number without saying which level it belongs to, so it was held at partial.</>,
          <>{levels} {levels === 1 ? 'frase ha dato' : 'frasi hanno dato'} un numero WCAG senza dire a quale livello appartiene, quindi è rimasta parziale.</>,
        ),
      );
    }
  }

  return {
    analogy: t(
      <>
        Now the teacher marks the exam. First, for every quotation, they search the page for those exact words, like
        pressing Ctrl+F. If the words are not there, the quotation was invented, and the sentence fails. Only for the
        quotations that are really there does the teacher do the slower part: read the page and ask whether it actually
        backs up what the student wrote.
      </>,
      <>
        Ora l’insegnante corregge il compito. Prima, per ogni citazione, cerca nella pagina quelle parole esatte, come
        premere Ctrl+F. Se le parole non ci sono, la citazione è inventata e la frase è bocciata. Solo per le citazioni che
        ci sono davvero l’insegnante fa la parte più lenta: legge la pagina e si chiede se sostiene davvero quello che lo
        studente ha scritto.
      </>,
    ),
    yours,
  };
}

/** The block itself: the analogy, then this question's own story. */
export function PlainWords({ plain }: { plain: Plain }) {
  const { t } = useLang();
  return (
    <div className="rounded-2xl bg-raised p-5">
      <h4 className="font-medium">{t('In plain words', 'In parole semplici')}</h4>
      <p className="mt-2 max-w-[65ch] text-lg leading-relaxed">{plain.analogy}</p>
      {plain.yours.length > 0 && (
        <>
          <h4 className="mt-5 font-medium">{t('What happened to your question', 'Cosa è successo alla tua domanda')}</h4>
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
