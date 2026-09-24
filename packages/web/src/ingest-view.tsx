import { useState } from 'react';
import { useLang } from './i18n.tsx';
import results from './ingest-ablation.json';
import { PlainWords } from './plain.tsx';
import { Arrow, Card, FragmentPair, Lane, type Node } from './run-diagram.tsx';
import { Tabs } from './tabs.tsx';
import { localized } from './theory-it.ts';
import type { IngestStage } from './theory.ts';
import { Bars, Figure, GroupedColumns, useInView, type Tone } from './viz.tsx';

/**
 * How the index was built: the build-time half of the pipeline, drawn as a
 * graph, then each algorithm in it with what it does, what it costs, and what
 * the ingest ablation measured when it was changed.
 *
 * The numbers come from ingest-ablation.json, written by
 * packages/eval/src/ingest-ablation.ts. Nothing here is typed in by hand
 * except the verdicts, which are written against that file.
 */

type Row = (typeof results.rows)[number];
type ChunkingStats = (typeof results.chunking)[number];

const shipped = (row: Row) => row.name.includes('(shipped)');

/** Italian names for the ablation's variants, by id; the English ones come from the JSON. */
const VARIANT_IT: Record<string, string> = {
  'structure:bm25': 'A struttura, 400 token, 15% di sovrapposizione, BM25',
  'structure:dense': 'A struttura, 400 token, 15% di sovrapposizione, semantico',
  'structure:hybrid': 'A struttura, 400 token, 15% di sovrapposizione, ibrido',
  'embed:no-heading': 'Semantico, solo il testo del chunk',
  'embed:heading': 'Semantico, percorso dei titoli + testo (pubblicato)',
  'bm25:no-heading': 'BM25, solo il testo del chunk',
  'bm25:heading': 'BM25, percorso dei titoli + testo (pubblicato)',
  'query:no-prefix': 'Domanda senza il prefisso di istruzione',
  'query:prefix': 'Domanda con il prefisso di istruzione (pubblicato)',
  'structure-no-overlap:bm25': 'A struttura, senza sovrapposizione, BM25',
  'structure-no-overlap:dense': 'A struttura, senza sovrapposizione, semantico',
  'structure-no-overlap:hybrid': 'A struttura, senza sovrapposizione, ibrido',
  'structure-small:bm25': 'A struttura, 200 token, BM25',
  'structure-small:dense': 'A struttura, 200 token, semantico',
  'structure-small:hybrid': 'A struttura, 200 token, ibrido',
  'fixed:bm25': 'Finestre fisse, 400 token, 15% di sovrapposizione, BM25',
  'fixed:dense': 'Finestre fisse, 400 token, 15% di sovrapposizione, semantico',
  'fixed:hybrid': 'Finestre fisse, 400 token, 15% di sovrapposizione, ibrido',
  'store:float32': 'Vettori float32, 2,4 MB',
  'store:int8': 'Vettori int8, 0,6 MB (pubblicato)',
  'tokenizer:plain': 'Tokenizer semplice: sequenze alfanumeriche, 2.4.11 diviso in 2, 4, 11',
  'tokenizer:shipped': 'Tokenizer pubblicato: composti interi e divisi, numeri col punto interi',
  'bm25:k1=1.2,b=0': 'BM25 k1 = 1,2, b = 0',
  'bm25:k1=1.2,b=0.75': 'BM25 k1 = 1,2, b = 0,75 (pubblicato)',
  'bm25:k1=1.2,b=1': 'BM25 k1 = 1,2, b = 1',
  'bm25:k1=0.6,b=0.75': 'BM25 k1 = 0,6, b = 0,75',
  'bm25:k1=2,b=0.75': 'BM25 k1 = 2, b = 0,75',
  'rrf:k=1': 'RRF k = 1',
  'rrf:k=10': 'RRF k = 10',
  'rrf:k=60': 'RRF k = 60 (pubblicato)',
  'rrf:k=200': 'RRF k = 200',
};

const CHUNKER: Record<string, [string, string]> = {
  structure: ['Structure, 400', 'Struttura, 400'],
  'structure-no-overlap': ['No overlap', 'Senza sovrapp.'],
  'structure-small': ['Structure, 200', 'Struttura, 200'],
  fixed: ['Fixed windows', 'Finestre fisse'],
};

const CHUNKER_NAME_IT: Record<string, string> = {
  structure: 'A struttura, 400 token, 15% di sovrapposizione',
  'structure-no-overlap': 'A struttura, senza sovrapposizione',
  'structure-small': 'A struttura, 200 token',
  fixed: 'Finestre fisse, 400 token, 15% di sovrapposizione',
};

function useFormat() {
  const { t, num, lang } = useLang();
  return {
    t,
    num,
    pct: (n: number) => `${num(n * 100, 1)}%`,
    ci: ([lo, hi]: number[]) => `${Math.round(lo! * 100)}-${Math.round(hi! * 100)}`,
    variant: (row: Row) => (lang === 'it' ? (VARIANT_IT[row.id] ?? row.name) : row.name),
    encoder: (id: string) =>
      ({
        production: t('Workers AI vectors, as shipped', 'vettori Workers AI, come pubblicati'),
        local: t('bge-small-en-v1.5 run locally (ONNX)', 'bge-small-en-v1.5 eseguito in locale (ONNX)'),
        none: t('no encoder involved', 'nessun encoder coinvolto'),
      })[id] ?? id,
  };
}

export function IngestView() {
  const { t, lang } = useLang();
  const stages = localized(lang).ingest;
  const [selected, setSelected] = useState(stages[0]!.id);
  const step = (100 / results.questions).toFixed(1);

  return (
    <section aria-labelledby="ingestion">
      <header>
        <h2 id="ingestion" className="scroll-mt-20 text-3xl font-semibold tracking-tight md:text-4xl">
          {t('How the index was built', 'Come è stato costruito l’indice')}
        </h2>
        <p className="mt-4 max-w-[65ch] text-lg leading-relaxed text-ink-2">
          {t(
            `Before anyone asks anything, the site prepares its library: it downloads the pages, cleans them, cuts them into pieces and builds two indexes, one for words and one for meanings. Eight algorithms do this, once, when the site is built. To see what each one is worth, each was changed on its own and the ${results.questions} answer-key questions were asked again.`,
            `Prima che qualcuno chieda qualcosa, il sito prepara la sua biblioteca: scarica le pagine, le pulisce, le taglia in pezzi e costruisce due indici, uno per le parole e uno per i significati. Lo fanno otto algoritmi, una volta sola, quando il sito viene costruito. Per vedere quanto vale ciascuno, è stato cambiato da solo e le ${results.questions} domande con soluzione sono state rifatte.`,
          )}
        </p>
      </header>

      <div className="mt-8">
        <BuildDiagram />
      </div>

      <div className="mt-10">
        <Tabs
          label={t('Build-time algorithms', 'Algoritmi di costruzione')}
          selected={selected}
          onSelect={setSelected}
          tabs={stages.map((stage) => ({
            id: stage.id,
            label: stage.short,
            panel: <StagePanel key={stage.id} stage={stage} />,
          }))}
        />
      </div>

      <p className="mt-8 max-w-[65ch] text-sm leading-relaxed text-ink-2">
        {t(
          `Intervals are 95% bootstrap intervals over questions. With ${results.questions} questions a single question moves Success@5 by ${step} points, so two variants whose intervals overlap are reported as no different. Full tables: docs/INGEST-ABLATION.md.`,
          `Gli intervalli sono intervalli bootstrap al 95% sulle domande. Con ${results.questions} domande una sola domanda sposta il Success@5 di ${step.replace('.', ',')} punti, quindi due varianti con intervalli che si sovrappongono sono considerate uguali. Tabelle complete: docs/INGEST-ABLATION.md.`,
        )}
      </p>
    </section>
  );
}

function BuildDiagram() {
  const [ref, seen] = useInView<HTMLElement>();
  const { t, num, pct } = useFormat();
  const structure = results.chunking.find((c) => c.id === 'structure')!;
  let i = 0;
  const next = () => i++;

  const head: Node[] = [
    { title: t('Fetch', 'Scarica'), where: t('Node, cached', 'Node, in cache'), facts: [[t('pages', 'pagine'), 193], [t('sources', 'fonti'), 'W3C, GOV.UK']] },
    {
      title: t('Normalise', 'Normalizza'),
      where: 'Node',
      facts: [
        [t('characters', 'caratteri'), num(1_746_767)],
        [t('offsets exact', 'posizioni esatte'), pct(structure.offsetsExact)],
      ],
    },
    {
      title: 'Chunk',
      where: 'Node',
      series: 'hybrid',
      facts: [
        ['chunk', num(structure.chunks)],
        [t('median', 'mediana'), `${structure.medianTokens} token`],
        [t('clean ends', 'finali puliti'), pct(structure.cleanEnds)],
      ],
    },
  ];
  const lexical: Node[] = [
    { title: t('Tokenize', 'Tokenizza'), where: 'Node', facts: [[t('compounds', 'composti'), t('whole + parts', 'interi + parti')]] },
    { title: t('BM25 index', 'Indice BM25'), where: 'Node', series: 'lexical', facts: [['bm25.json', t('1.28 MB', '1,28 MB')], [t('gzipped', 'compresso'), '379 KB']] },
  ];
  const dense: Node[] = [
    { title: 'Embedding', where: 'Workers AI', facts: [[t('vectors', 'vettori'), `${num(1592)} × 384`], [t('batches', 'lotti'), '16 × 100']] },
    { title: t('Quantise', 'Quantizza'), where: 'Node', series: 'dense', facts: [['vectors.bin', t('0.6 MB', '0,6 MB')], [t('vs float32', 'vs float32'), t('4× smaller', '4× più piccolo')]] },
  ];
  const tail: Node = {
    title: t('Ship', 'Pubblica'),
    where: 'Cloudflare Pages',
    facts: [
      ['chunks.meta', '54 KB gz'],
      ['chunks.text', '445 KB gz'],
      [t('index + vectors', 'indice + vettori'), t('2 files', '2 file')],
    ],
  };

  return (
    <figure ref={ref} className={`min-w-0 rounded-2xl border border-line bg-paper p-5 ${seen ? 'viz-in' : ''}`}>
      <figcaption>
        <span className="block font-medium">{t('The build, structurally', 'La costruzione, nella struttura')}</span>
        <span className="mt-1 block max-w-[65ch] text-sm text-ink-2">
          {t(
            'One normalised text, one set of chunks, then two indexes built from the same chunks: the one BM25 reads and the one the dense scan reads.',
            'Un testo normalizzato, un insieme di chunk, poi due indici costruiti dagli stessi chunk: quello che legge BM25 e quello che legge la scansione semantica.',
          )}
        </span>
      </figcaption>
      <ol className="mx-auto mt-6 flex max-w-2xl flex-col items-stretch gap-2 xl:max-w-none xl:flex-row xl:items-center">
        {head.map((node, index) => (
          <FragmentPair key={node.title}>
            {index > 0 && <Arrow i={next()} />}
            <li className="min-w-0 xl:flex-1">
              <Card node={node} i={next()} />
            </li>
          </FragmentPair>
        ))}
        <Arrow i={next()} />
        <li className="min-w-0 xl:flex-[2]">
          <span className="sr-only">{t('Two indexes are built from the same chunks:', 'Dagli stessi chunk si costruiscono due indici:')}</span>
          <ol className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-1">
            <Lane label={t('Lexical index', 'Indice lessicale')} nodes={lexical} next={next} />
            <Lane label={t('Dense index', 'Indice semantico')} nodes={dense} next={next} />
          </ol>
        </li>
        <Arrow i={next()} />
        <li className="min-w-0 xl:flex-1">
          <Card node={tail} i={next()} />
        </li>
      </ol>
    </figure>
  );
}

function StagePanel({ stage }: { stage: IngestStage }) {
  const { t } = useLang();
  const rows = results.rows.filter((row) => row.group === stage.group);

  return (
    <div className="grid gap-10 pt-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="space-y-6">
        <div>
          <h3 className="text-2xl font-semibold tracking-tight">{stage.name}</h3>
          <p className="mt-1 text-sm text-muted">{stage.family}</p>
        </div>
        <PlainWords plain={{ analogy: stage.plain, yours: [] }} />
        <h4 className="font-medium">{t('The technical version', 'La versione tecnica')}</h4>
        <p className="max-w-[65ch] leading-relaxed">{stage.idea}</p>
        <div>
          <h4 className="font-medium">{t('How it runs', 'Come funziona')}</h4>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-ink-2">
            {stage.how.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ol>
        </div>
        <div className="grid gap-6 text-sm sm:grid-cols-2">
          <div>
            <h4 className="font-medium">{t('Strengths', 'Punti di forza')}</h4>
            <ul className="mt-2 list-disc space-y-1.5 pl-5 leading-relaxed text-ink-2">
              {stage.strengths.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div>
            <h4 className="font-medium">{t('Trade-offs', 'Compromessi')}</h4>
            <ul className="mt-2 list-disc space-y-1.5 pl-5 leading-relaxed text-ink-2">
              {stage.tradeoffs.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <div className="min-w-0 space-y-6">
        <div className="rounded-xl bg-raised p-4 text-sm">
          <span className="font-medium">{t('What the measurement says', 'Cosa dice la misura')}</span>
          <p className="mt-1 leading-relaxed text-ink-2">{stage.verdict}</p>
        </div>
        {stage.group === 'chunking' ? <ChunkingFigures /> : rows.length > 0 && <VariantFigure rows={rows} />}
        {stage.references && (
          <ul className="space-y-2 text-sm text-ink-2" lang="en">
            {stage.references.map((ref) => (
              <li key={ref.url}>
                {ref.authors} ({ref.year}).{' '}
                <a href={ref.url} className="text-ink underline underline-offset-2" rel="noreferrer">
                  {ref.title}
                </a>
                . <i>{ref.venue}</i>.
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function useTable() {
  const { t, pct, ci, variant } = useFormat();
  return {
    head: [t('Variant', 'Variante'), 'Recall@10', t('95% CI', 'IC 95%'), 'Success@5', t('95% CI', 'IC 95%'), 'MRR'],
    rows: (rows: Row[]) =>
      rows.map((row) => [variant(row), pct(row.recall10), ci(row.recall10Ci), pct(row.success5), ci(row.success5Ci), row.mrr.toFixed(3)]),
  };
}

/** One variant against another, on the two measures a reader asks about first. */
function VariantFigure({ rows }: { rows: Row[] }) {
  const { t, pct, ci, variant, encoder } = useFormat();
  const table = useTable();
  const encoders = [...new Set(rows.map((row) => encoder(row.encoder)))].join('; ');
  const bars = (read: (row: Row) => number, band: (row: Row) => number[]) =>
    rows.map((row) => ({
      label: variant(row).replace(/ \((shipped|pubblicato)\)$/, ''),
      value: read(row),
      note: `${shipped(row) ? t('shipped, ', 'pubblicato, ') : ''}${t('CI', 'IC')} ${ci(band(row))}`,
      series: (shipped(row) ? 'ink' : 'muted') as Tone,
    }));

  return (
    <Figure
      title={t('Measured, variant by variant', 'Misurato, variante per variante')}
      caption={t(
        `Recall@10 then Success@5, the shipped choice in ink. Encoder: ${encoders}.`,
        `Prima Recall@10 poi Success@5, la scelta pubblicata in nero. Encoder: ${encoders}.`,
      )}
      table={{ head: table.head, rows: table.rows(rows) }}
    >
      <span className="mb-2 block text-xs text-muted">Recall@10</span>
      <Bars series="muted" max={1} format={pct} rows={bars((r) => r.recall10, (r) => r.recall10Ci)} />
      <span className="mt-6 mb-2 block text-xs text-muted">Success@5</span>
      <Bars series="muted" max={1} format={pct} rows={bars((r) => r.success5, (r) => r.success5Ci)} />
    </Figure>
  );
}

function ChunkingFigures() {
  const { t, num, pct } = useFormat();
  const { lang } = useLang();
  const table = useTable();
  const rows = results.rows.filter((row) => row.group === 'chunking');
  const value = (chunker: string, kind: string) => rows.find((row) => row.id === `${chunker}:${kind}`)!.recall10;
  const stats = results.chunking as ChunkingStats[];
  const short = (id: string) => (CHUNKER[id] ? t(CHUNKER[id]![0], CHUNKER[id]![1]) : id);
  const full = (c: ChunkingStats) => (lang === 'it' ? (CHUNKER_NAME_IT[c.id] ?? c.name) : c.name);

  return (
    <>
      <Figure
        title={t('Recall@10 by chunking and retriever', 'Recall@10 per chunking e retriever')}
        caption={t(
          'Local encoder throughout, so every chunking is embedded by the same model.',
          'Encoder locale ovunque, così ogni chunking è codificato dallo stesso modello.',
        )}
        legend={['lexical', 'dense', 'hybrid']}
        table={{ head: table.head, rows: table.rows(rows) }}
      >
        <GroupedColumns
          series={['lexical', 'dense', 'hybrid']}
          format={(v) => `${Math.round(v * 100)}`}
          groups={stats.map((c) => ({
            label: short(c.id),
            values: {
              lexical: value(c.id, 'bm25'),
              dense: value(c.id, 'dense'),
              hybrid: value(c.id, 'hybrid'),
              rerank: 0,
            },
          }))}
        />
      </Figure>
      <Figure
        title={t('How each chunking treats sentence boundaries', 'Come ogni chunking tratta i confini delle frasi')}
        caption={t(
          'Share of chunks that end on a sentence or block boundary. A cut mid-sentence splits a claim from its evidence.',
          'Quota di chunk che finiscono su un confine di frase o di blocco. Un taglio a metà frase separa un’affermazione dalla sua prova.',
        )}
        table={{
          head: [
            'Chunker',
            'Chunk',
            t('Median tokens', 'Token mediani'),
            'p10-p90',
            t('Clean ends', 'Finali puliti'),
            t('Clean starts', 'Inizi puliti'),
          ],
          rows: stats.map((c) => [full(c), c.chunks, c.medianTokens, `${c.p10Tokens}-${c.p90Tokens}`, pct(c.cleanEnds), pct(c.cleanStarts)]),
        }}
      >
        <Bars
          series="ink"
          max={1}
          format={pct}
          rows={stats.map((c) => ({ label: short(c.id), value: c.cleanEnds, note: `${num(c.chunks)} chunk` }))}
        />
      </Figure>
    </>
  );
}
