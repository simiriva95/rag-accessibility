import { useState } from 'react';
import results from './ingest-ablation.json';
import { Arrow, Card, FragmentPair, Lane, type Node } from './run-diagram.tsx';
import { Tabs } from './tabs.tsx';
import { INGEST, type IngestStage } from './theory.ts';
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

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const ci = ([lo, hi]: number[]) => `${Math.round(lo! * 100)}-${Math.round(hi! * 100)}`;
const shipped = (row: Row) => row.name.includes('(shipped)');

const ENCODER: Record<string, string> = {
  production: 'Workers AI vectors, as shipped',
  local: 'bge-small-en-v1.5 run locally (ONNX)',
  none: 'no encoder involved',
};

export function IngestView() {
  const [selected, setSelected] = useState(INGEST[0]!.id);

  return (
    <section aria-labelledby="ingestion">
      <header>
        <h2 id="ingestion" className="scroll-mt-20 text-3xl font-semibold tracking-tight md:text-4xl">
          How the index was built
        </h2>
        <p className="mt-4 max-w-[65ch] text-lg leading-relaxed text-ink-2">
          Everything the browser searches was computed once, at build time, by eight algorithms in
          sequence. Each was then changed on its own and the {results.questions} answerable golden
          questions re-run, to measure what it is worth.
        </p>
      </header>

      <div className="mt-8">
        <BuildDiagram />
      </div>

      <div className="mt-10">
        <Tabs
          label="Build-time algorithms"
          selected={selected}
          onSelect={setSelected}
          tabs={INGEST.map((stage) => ({
            id: stage.id,
            label: stage.short,
            panel: <StagePanel key={stage.id} stage={stage} />,
          }))}
        />
      </div>

      <p className="mt-8 max-w-[65ch] text-sm leading-relaxed text-ink-2">
        Intervals are 95% bootstrap intervals over questions. With {results.questions} questions a
        single question moves Success@5 by {(100 / results.questions).toFixed(1)} points, so two
        variants whose intervals overlap are reported as no different. Full tables:
        docs/INGEST-ABLATION.md.
      </p>
    </section>
  );
}

function BuildDiagram() {
  const [ref, seen] = useInView<HTMLElement>();
  const structure = results.chunking.find((c) => c.id === 'structure')!;
  let i = 0;
  const next = () => i++;

  const head: Node[] = [
    { title: 'Fetch', where: 'Node, cached', facts: [['pages', 193], ['sources', 'W3C, GOV.UK']] },
    { title: 'Normalise', where: 'Node', facts: [['characters', '1,746,767'], ['offsets exact', pct(structure.offsetsExact)]] },
    {
      title: 'Chunk',
      where: 'Node',
      series: 'hybrid',
      facts: [
        ['chunks', structure.chunks.toLocaleString('en-GB')],
        ['median', `${structure.medianTokens} tokens`],
        ['clean ends', pct(structure.cleanEnds)],
      ],
    },
  ];
  const lexical: Node[] = [
    { title: 'Tokenize', where: 'Node', facts: [['compounds', 'whole + parts']] },
    { title: 'BM25 index', where: 'Node', series: 'lexical', facts: [['bm25.json', '1.28 MB'], ['gzipped', '379 KB']] },
  ];
  const dense: Node[] = [
    { title: 'Embed', where: 'Workers AI', facts: [['vectors', '1,592 × 384'], ['batches', '16 × 100']] },
    { title: 'Quantise', where: 'Node', series: 'dense', facts: [['vectors.bin', '0.6 MB'], ['vs float32', '4× smaller']] },
  ];
  const tail: Node = {
    title: 'Ship',
    where: 'Cloudflare Pages',
    facts: [
      ['chunks.meta', '54 KB gz'],
      ['chunks.text', '445 KB gz'],
      ['index + vectors', '2 files'],
    ],
  };

  return (
    <figure ref={ref} className={`min-w-0 rounded-2xl border border-line bg-paper p-5 ${seen ? 'viz-in' : ''}`}>
      <figcaption>
        <span className="block font-medium">The build, structurally</span>
        <span className="mt-1 block max-w-[65ch] text-sm text-ink-2">
          One normalised text, one set of chunks, then two indexes built from the same chunks: the
          one BM25 reads and the one the dense scan reads.
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
          <span className="sr-only">Two indexes are built from the same chunks:</span>
          <ol className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-1">
            <Lane label="Lexical index" nodes={lexical} next={next} />
            <Lane label="Dense index" nodes={dense} next={next} />
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
  const rows = results.rows.filter((row) => row.group === stage.group);

  return (
    <div className="grid gap-10 pt-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="space-y-6">
        <div>
          <h3 className="text-2xl font-semibold tracking-tight">{stage.name}</h3>
          <p className="mt-1 text-sm text-muted">{stage.family}</p>
        </div>
        <p className="max-w-[65ch] text-lg leading-relaxed">{stage.idea}</p>
        <div>
          <h4 className="font-medium">How it runs</h4>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-ink-2">
            {stage.how.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ol>
        </div>
        <div className="grid gap-6 text-sm sm:grid-cols-2">
          <div>
            <h4 className="font-medium">Strengths</h4>
            <ul className="mt-2 list-disc space-y-1.5 pl-5 leading-relaxed text-ink-2">
              {stage.strengths.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div>
            <h4 className="font-medium">Trade-offs</h4>
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
          <span className="font-medium">What the measurement says</span>
          <p className="mt-1 leading-relaxed text-ink-2">{stage.verdict}</p>
        </div>
        {stage.group === 'chunking' ? <ChunkingFigures /> : rows.length > 0 && <VariantFigure rows={rows} />}
        {stage.references && (
          <ul className="space-y-2 text-sm text-ink-2">
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

const TABLE_HEAD = ['Variant', 'Recall@10', '95% CI', 'Success@5', '95% CI', 'MRR'];
const tableRows = (rows: Row[]) =>
  rows.map((row) => [row.name, pct(row.recall10), ci(row.recall10Ci), pct(row.success5), ci(row.success5Ci), row.mrr.toFixed(3)]);

/** One variant against another, on the two measures a reader asks about first. */
function VariantFigure({ rows }: { rows: Row[] }) {
  const encoders = [...new Set(rows.map((row) => ENCODER[row.encoder]))].join('; ');
  const bars = (read: (row: Row) => number, band: (row: Row) => number[]) =>
    rows.map((row) => ({
      label: row.name.replace(' (shipped)', ''),
      value: read(row),
      note: `${shipped(row) ? 'shipped, ' : ''}CI ${ci(band(row))}`,
      series: (shipped(row) ? 'ink' : 'muted') as Tone,
    }));

  return (
    <Figure
      title="Measured, variant by variant"
      caption={`Recall@10 then Success@5, the shipped choice in ink. Encoder: ${encoders}.`}
      table={{ head: TABLE_HEAD, rows: tableRows(rows) }}
    >
      <span className="mb-2 block text-xs text-muted">Recall@10</span>
      <Bars series="muted" max={1} format={pct} rows={bars((r) => r.recall10, (r) => r.recall10Ci)} />
      <span className="mt-6 mb-2 block text-xs text-muted">Success@5</span>
      <Bars series="muted" max={1} format={pct} rows={bars((r) => r.success5, (r) => r.success5Ci)} />
    </Figure>
  );
}

const CHUNKER_SHORT: Record<string, string> = {
  structure: 'Structure, 400',
  'structure-no-overlap': 'No overlap',
  'structure-small': 'Structure, 200',
  fixed: 'Fixed windows',
};

function ChunkingFigures() {
  const rows = results.rows.filter((row) => row.group === 'chunking');
  const value = (chunker: string, kind: string) => rows.find((row) => row.id === `${chunker}:${kind}`)!.recall10;
  const stats = results.chunking as ChunkingStats[];

  return (
    <>
      <Figure
        title="Recall@10 by chunking and retriever"
        caption="Local encoder throughout, so every chunking is embedded by the same model."
        legend={['lexical', 'dense', 'hybrid']}
        table={{ head: TABLE_HEAD, rows: tableRows(rows) }}
      >
        <GroupedColumns
          series={['lexical', 'dense', 'hybrid']}
          format={(v) => `${Math.round(v * 100)}`}
          groups={stats.map((c) => ({
            label: CHUNKER_SHORT[c.id] ?? c.id,
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
        title="How each chunking treats sentence boundaries"
        caption="Share of chunks that end on a sentence or block boundary. A cut mid-sentence splits a claim from its evidence."
        table={{
          head: ['Chunker', 'Chunks', 'Median tokens', 'p10-p90', 'Clean ends', 'Clean starts'],
          rows: stats.map((c) => [c.name, c.chunks, c.medianTokens, `${c.p10Tokens}-${c.p90Tokens}`, pct(c.cleanEnds), pct(c.cleanStarts)]),
        }}
      >
        <Bars
          series="ink"
          max={1}
          format={pct}
          rows={stats.map((c) => ({ label: CHUNKER_SHORT[c.id] ?? c.id, value: c.cleanEnds, note: `${c.chunks.toLocaleString('en-GB')} chunks` }))}
        />
      </Figure>
    </>
  );
}
