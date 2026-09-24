# Hybrid retrieval with verified citations

Question answering over WCAG 2.2 and the GOV.UK Design System, where the retrieval is shown as it
happens and **every quoted claim is checked against the text it cites** — not asserted, checked.

**[Live demo](https://rag-accessibility.pages.dev)** · [Ablation](docs/ABLATION.md) ·
[Guida in italiano](docs/GUIDA.md)

> **388 ms** to first paint, **696 ms** to load 1,592 chunks and their vectors, **78.9 KB** of
> JavaScript. **No axe violations** across four states, with contrast measured by reading painted
> pixels because the tooling could not. Static index on Cloudflare Pages, models on a Cloudflare
> Worker, no server anywhere. Every number here was measured on this corpus, on the deployed site.

---

## The retrieval debugger

![The retrieval debugger: four columns — dense, BM25, fused, reranked — filling in for the question
"how much colour contrast does large text need", with the reranker's movement drawn as curves, and
a selected candidate showing its rank at every stage.](docs/media/retrieval-debugger.gif)

Four columns, left to right in the order the pipeline runs them, each with its own latency. The
recording above is the live demo, unedited.

**Select a candidate and it tells you where every stage put it.** In the last frame, Success
Criterion 1.4.3 Contrast (Minimum) — the correct answer — sits at:

| BM25 | Dense | Fused | Reranked |
| ---: | ---: | ---: | ---: |
| #17 | **#1** | #3 | #4 |

That single row is the argument for hybrid retrieval. The lexical half buried the right criterion
at rank 17; the dense half put it first. Neither is reliable alone, and the fusion recovers it.

The scores are shown in their real units and **never put on a common scale**. Cosine sits in
[0, 1]; BM25 is an unbounded sum of idf terms; RRF is a sum of reciprocal ranks clustered around
0.016. Three incompatible scales side by side is the argument for fusing on rank instead of on
score, made visible rather than claimed.

Selecting a candidate highlights it in every column it reached and shows its rank at each stage.
The movement from the fused column to the final set is drawn as curves — and also written, because
the drawing is decoration: it is `aria-hidden`, it disappears once the columns stack, and every
final row states in words the rank it came from (`▲ 3 from #7`, `held #1`).

A stage that could not run keeps its column and says why, rather than vanishing.

---

## How it works, with your question's own numbers

A third view walks through the seven stages a question just went through, and every figure in it
is read off that run: the tokens and how many chunks contain each, the BM25 sum for the top result
broken down term by term (tested to add up to the score it ranked with), the 384 numbers of the
query embedding, each fused candidate's RRF score split into its dense and BM25 votes, the
reranker's movement as a slope chart, the model that answered and its raw JSON, and what each
verification check found per claim.

Below the walkthrough sit the reference sections: the six techniques the system composes, each
with its definition, cost here, failure modes, measured performance and the paper it comes from;
the metrics and the ablation as charts; the system design; and the design system itself.

Every chart is hand-built HTML and SVG, hidden from assistive technology over a real table one
click away, and grows from its baseline once per question. The view loads on demand, so it adds
nothing to first paint. axe-core reports no violations on it, light and dark, desktop and phone.

---

## What it costs to load

Measured on the deployed demo, not locally.

| | |
| --- | ---: |
| First paint | **388 ms** |
| 1,592 chunks + their vectors, ready to query | **696 ms** |
| JavaScript | **78.9 KB** gzipped |
| CSS | 4.35 KB gzipped |
| A query, lexical half, in the browser | 2–3 ms |

The budget in the brief was two seconds to interactive. Getting there took three decisions:

**The chunk file is split at build time.** Everything but the chunk text — which is what retrieval
and a result list actually need — gzips to **54 KB against 502 KB** for the whole file. The text
loads alongside instead of gating first paint.

**Retrieval runs in a Web Worker.** Scanning 1,592 vectors is a couple of milliseconds; parsing a
megabyte of index JSON on the main thread is what drops frames on a phone. The worker does no
network, so it stays a pure function of its inputs.

**The vector index is a binary blob, int8.** 1,592 × 384 is 600 KB raw against about 1.6 MB as a
JSON array of numbers. Per-asset figures are under [what ships](#what-ships).

---

## Accessibility, measured

A RAG about accessibility with an inaccessible UI is disqualifying, so the demo is held to WCAG 2.2
AA itself — and checked rather than asserted.

- **axe-core 4.13 across four states** (idle, answer, retrieval, open dialog): **no violations**.
- **Contrast measured by reading painted pixels**, because axe cannot resolve it wherever the
  connector overlay crosses a card: 112 text elements in the debugger, none below its threshold,
  **minimum ratio 7.66**. Citation states clear 4.5:1 in both schemes — 5.58–6.85 light,
  7.53–11.42 dark.
- **Citation states never depend on colour.** A symbol and an underline style carry the meaning,
  and every state is in the button's accessible name.
- **Keyboard**: 28 focus stops, all reachable, order follows the page. Tabs follow the APG pattern
  with roving tabindex, verified in the browser rather than assumed.
- **One live region** for the life of the page, announcing what changed rather than re-reading the
  results.
- `prefers-reduced-motion` collapses the connector animation; the resting state is the finished
  line, so nothing is lost by never seeing it move.

### Three defects the pass found, none of them visible on screen

**A closed `<dialog>` was still keyboard reachable.** A layout utility on the element overrode the
user-agent `dialog:not([open]) { display: none }` rule, so Tab walked into invisible content — two
stops at the end of every page.

**`aria-labelledby` pointed at an id that did not exist** whenever the dialog was closed, because
its contents are conditional.

**One status colour cannot clear 4.5:1 against both white and near-black.** Measured, a single set
left `partial` at 4.37 on white and `unsupported` at 3.78 on dark. There are two sets now.

### Two measurements that were wrong before they were right

axe reported thirty contrast results as *unable to determine*. It looked like `oklch`, which is
Tailwind v4's whole palette. It was not: the browser pane was at zero width, so every element had a
degenerate box. At a real viewport they resolve.

The contrast figures themselves took three attempts, because `getComputedStyle` hands back
`oklch()` unresolved and so does `canvas.fillStyle`. Painting the pixel and reading it back with
`getImageData` is the method that cannot lie.

**Not done:** a real screen reader pass. That needs a human with VoiceOver or NVDA, and the README
says so rather than implying coverage it does not have.

---

## Why the citations can be trusted

The model does not write prose with footnotes. It writes **claims**:

```ts
type Claim = {
  sentence: string;
  chunkIds: string[];
  quote: string; // must appear verbatim in a cited chunk
};
```

Three checks run in order, cheapest first:

1. **Quote match.** The quote must be a literal substring of a cited chunk. No fuzzy fallback, no
   similarity threshold. A quote that is not in the text is not a quote.
2. **Span resolution.** The match is mapped back to character offsets in the source document, so
   the UI can highlight it where it actually sits.
3. **Entailment.** Only then does a model judge whether the evidence supports the sentence — it is
   the expensive check, and a claim whose quote is absent is already invalid.

### Does the cheap check actually work?

189 citations built from the real corpus and run through check 1 alone — no model, no quota:

| | cases | wrong |
| --- | ---: | ---: |
| Should be accepted — verbatim, whitespace reflowed, apostrophes straightened | 65 | **0** |
| Should be rejected — wrong chunk, one word swapped, two real fragments stitched, invented sentence | 124 | **0** |

The stitched case is the interesting one: both halves are genuinely in the chunk, only their
junction is not. `packages/eval/src/fabrication.test.ts` runs this on every `pnpm test`.

### What is normalized, and what is not

An explicit, finite equivalence class: Unicode form, whitespace runs, and the typographic
substitutions a model makes unasked — curly quotes, dashes, ellipses. GOV.UK prose is full of
U+2019 apostrophes, and failing a correct citation because the model typed an ASCII one would be a
bug wearing the costume of rigour.

**Case is not normalized.** "Verbatim" is the claim being made.

Normalization also has to be *reversible*, or a quote can be matched and never highlighted. Two
bugs found by tests while building that: normalizing per character cannot compose (`e` + U+0301
never equals `é`, losing the one equivalence NFC exists to provide), and because composing turns
several source characters into one, a single offset per character is not enough to end a span.

### Four states, and one of them is an outage

| | meaning |
| --- | --- |
| `verified` | the quote is in the cited source and the evidence supports the sentence |
| `partial` | the quote is real, the support is weak |
| `unsupported` | the quote is not in any cited source, or the evidence contradicts it |
| `unverified` | the quote is real, the entailment check **could not run** |

`unverified` is deliberately distinct from `partial`. "The judge said the support is weak" and "no
judge was available" are different things to show a reader, and collapsing them would let an outage
look like a result. Everywhere a score cannot be obtained the answer is `null`, never `0` — zero is
a verdict, a rate limit is not.

**Unsupported sentences are shown, not hidden.** Hiding them would make this a demonstration that
the model never fails, which is not the claim.

### When the model is simply busy

A free tier answers *"this model is currently experiencing high demand"* on an ordinary afternoon,
and a demo that has to keep working for years cannot rest on one model staying uncongested. So
generation tries a short chain of models and retries the ones that are merely busy — 429 and 503
mean *not now*, not *no*. The waits are small, because this runs inside a request someone is
waiting on. A refusal that will not change, like a bad key, moves straight on rather than being
asked again.

The chain also crosses providers. After the Gemini models come two that run on Workers AI through
the binding the embedding already uses — no key, and a separate daily allowance — so an exhausted
Gemini quota is a slower answer rather than no answer. They were picked by running the claim schema
against the real corpus: Llama 4 Scout quotes verbatim; gpt-oss-20b returned nothing in JSON mode
and qwen3-30b left schema debris inside its quotes. Scout also costs a third of the 70B's output
price, which matters because that allowance is shared with the embedding and the reranker.

A worse model is still a worse answer, not a wrong one: the verification layer judges whichever
model replied by exactly the same rule.

When every model in the chain fails, the banner names each one with its own reason. An earlier
version reported only the last failure, which blamed a retired model for an outage whose actual
cause was the first two being busy — the sort of message that sends a reader after the wrong
thing entirely.

---

## The ablation

Generated by `packages/eval/src/harness.ts` over 60 hand-annotated questions and 1,592 chunks.
Recall counts the chunks annotated as *primary* — the ones that actually answer the question — with
the denominator capped at k. nDCG@10 uses graded relevance: primary chunks score 2, same-document
context scores 1.

| Retriever | Recall@5 | Recall@10 | Recall@30 | Success@5 | nDCG@10 | MRR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| BM25 only | 39.5% | 56.9% | 73.9% | 71.7% | 0.475 | 0.530 |
| Dense only | 47.5% | 64.8% | 79.9% | 73.6% | 0.541 | 0.594 |
| Hybrid (RRF) | 52.1% | 65.2% | **84.2%** | 84.9% | **0.550** | 0.629 |
| Hybrid + rerank | **60.4%** | **66.5%** | 66.1%\* | **94.3%** | 0.536\* | **0.733** |

\* *The reranked row returns 8 results, not 30, so those two columns are bounded by the cut rather
than by the reranker. Recall@5, Success@5 and MRR compare like with like.*

### Recall@10 by question kind — the interesting half

| Retriever | identifier (18) | conceptual (25) | design (10) |
| --- | ---: | ---: | ---: |
| BM25 only | **69.3%** | 45.5% | 63.4% |
| Dense only | 54.1% | **69.7%** | 71.6% |
| Hybrid (RRF) | 66.1% | 61.8% | **71.9%** |
| Hybrid + rerank | **78.8%** | 59.7% | 61.2% |

**This is the whole argument, and it held.** BM25 is strong on identifiers (`2.4.11`,
`aria-describedby`, `4.5:1`) and weak on paraphrase. Dense retrieval is the mirror image —
69.3/45.5 against 54.1/69.7. Neither is good at both.

The set was grown from 40 questions to 60 after these numbers were first taken, which is the
check that matters: the gap got **wider**, not narrower — BM25's identifier-to-conceptual spread
went from 19.2 points to 23.8. A larger sample that confirms rather than erodes a finding is the
reason to trust it.

Fusing keeps most of BM25's identifier performance *and* most of dense's conceptual performance,
and the headline effect is on whether anything useful reaches the top at all: **Success@5 goes from
71.7% and 73.6% alone to 84.9% fused, and 94.3% after reranking.** MRR — how far down the first
right answer sits — goes from 0.530 to 0.733.

### The ingest ablation

The retrieval ablation holds the index fixed and varies the retriever. A second one,
`packages/eval/src/ingest-ablation.ts`, holds the retriever fixed and varies how the index was built:
the chunker, what text is embedded, how vectors are stored, how BM25 tokenizes and weighs, how fusion
is damped. The golden set is anchored to documents and headings rather than chunk ids, so it
resolves afresh against every chunking. New chunkings are embedded with the same model run locally
(ONNX), so the comparison does not spend the live site's quota; it agrees with the production
vectors at a mean cosine of 0.904, and every row says which encoder produced it.
Full tables with 95% bootstrap intervals: [docs/INGEST-ABLATION.md](docs/INGEST-ABLATION.md).

| Change | Effect | Reading |
| --- | --- | --- |
| Chunks of 200 tokens instead of 400 | hybrid Recall@10 66.6% → 54.9% | clearly worse |
| No instruction prefix on the query | dense Success@5 86.8% → 71.7% | the largest single effect |
| float32 instead of int8 | Recall@10 identical, 99.2% of the top 10 shared | int8 is free here, at a quarter of the size |
| No overlap between chunks | within a point | no measurable effect |
| Fixed windows instead of structure-aware | Recall@10 69.9% vs 66.6%, but 85% of chunks end mid-sentence | recall level; the boundaries are what differ |
| No heading path in the embedded text | dense Success@5 92.5% vs 86.8% | a lead against a shipped choice, inside the intervals |

With 53 questions one question moves Success@5 by 1.9 points, so most of these are reported as no
difference. Two are not, and one is a result that argues against what ships; it is written down
rather than tuned away.

---

## How this was built

The code here was written by an AI agent working from my brief. What I contributed is what the
`git log` shows: the architecture and its rejected alternatives, the constraints that shaped it
(zero running cost, nothing that rots, WCAG 2.2 AA on the demo itself), the call on every
trade-off, and a review at each increment. I take that to be the interesting part of the job now.

One coherent change per commit, each with its reasoning written down. The `git log` is meant to be
read: the messages say *why*, not what the diff already shows.

### The tests found the things a browser never would

Seven defects were caught before any of this had been rendered once. They are the kind that do not
look like anything on screen:

- **Chunks drifted past their cap** — size was measured as the sum of the blocks while the token
  count was measured on the slice, and one chunk reached 740 tokens against a 480 limit. Both
  measure the slice now, which is what actually gets embedded.
- **The overlap between chunks carried whole trailing blocks** with no room check, then added the
  next block without re-checking the cap.
- **A chunk that reached its target just before a section heading** dragged its overlap across it.
- **Normalizing per character cannot compose.** `e` + U+0301 never equalled `é`, which loses the
  one equivalence NFC exists to provide — so a correct citation in decomposed text would have been
  reported as a fabrication.
- **One offset per character cannot end a span**, because composing turns several source characters
  into one. The map carries a start and an end now.
- **A short embedding batch would have misaligned every vector** with the wrong chunk. One vector
  returned for two texts is now refused rather than zipped up hopefully.
- **Eight golden-set anchors stopped matching** when the chunker changed. The resolver refuses to
  score against an annotation that quietly emptied.

### The browser found the rest

Seven more only showed up in a real page, and two of those are invisible even there:

- **A closed `<dialog>` was still keyboard reachable** — a layout utility overrode the user-agent
  rule that hides it, so Tab walked into invisible content.
- **`aria-labelledby` pointed at an id that did not exist** while the dialog was closed.
- **Escape did not close the dialog.** A trusted keydown arrived, nothing called `preventDefault`,
  and no `cancel` or `close` event ever fired — the CloseWatcher path a native dialog relies on
  simply did not run in that engine. It is handled explicitly now.
- **The debugger's connectors never drew at all.** The check compared a *container* width against
  `1024`, which is the *viewport* breakpoint; inside a max-width container the two never agree. It
  reads the layout directly now instead of trusting two constants to stay in step.
- **The connector overlay painted over the column text** instead of behind it, because an
  absolutely positioned SVG paints above its static siblings.
- **`body` had no background**, so the overscroll area fell back to white behind a dark page.
- **Heading order skipped** from `h1` to `h3`.

### Three numbers that were wrong before they were right

Measuring badly is worse than not measuring, because it produces a confident answer.

**axe reported thirty contrast results as undeterminable.** The obvious culprit was `oklch` —
Tailwind v4's entire palette. It was not: the browser pane was at zero width, so every element had
a degenerate box. At a real viewport they resolve.

**The contrast figures took three attempts.** `getComputedStyle` hands back `oklch()` unresolved,
and so does `canvas.fillStyle`. Painting the pixel and reading it back with `getImageData` is the
method that cannot lie.

**A README illustration carried invented reranker scores** — 0.94, 0.71 — for a stage that had
never run, written to make the picture look complete. That is precisely the failure this project
exists to catch, committed while describing it. The rule it cost: in this repository a number is
either measured or it is not written.

### What was cut, and when

The brief was three weeks of evenings. Two things went early and were not quietly restored:
**EN 301 549** (ETSI publishes it as PDF, and PDF-to-offsets is the most fragile job in the
pipeline) and **a golden set of sixty questions**, started at forty so the annotation could be done
after seeing real retrieval output. The forty became sixty later, once the harness was fast — and
the point of growing it was to find out whether the conclusion survived a bigger sample. It did,
and sharpened.

**Still not done**, and said so rather than implied: a screen reader pass, which needs a human with
VoiceOver or NVDA.

---

## Architecture

Static index in the client, models at the edge.

```
  build time (Node)              browser                    edge
  ─────────────────              ───────                    ────
  fetch + normalize    ──►  data/corpus/*.txt
  chunk with offsets   ──►  chunks.meta.json  ──┐
  embed + quantize     ──►  vectors.bin        ──┤   Web Worker        Cloudflare Worker
  build BM25           ──►  bm25.json          ──┘   dense scan   ◄──► /embed   query vector
                                                     BM25              /rerank  bge-reranker-base
                                                     RRF fusion        /answer  Gemini, then Llama
                                                        │              /entail  the NLI judge
                                                        ▼
                                                     React UI
                                                     verification runs here
```

Only three things cannot be precomputed: the query embedding, reranking and generation. Everything
else is a static file on a CDN. **Verification runs in the browser**, against the same chunk text
the model was shown — nothing about the check is taken on trust from the service that produced the
answer.

### Alternatives rejected

**Everything client-side**, embedding and reranker in WASM: roughly 70 MB of model downloads on
first visit. Unacceptable for a demo opened from a phone.

**A real backend** (Postgres/pgvector, Qdrant): cold starts, credentials to rotate, free tiers that
pause. The demo dies quietly six months after the last person looked at it. The hard requirement
here is that the link still works in two years.

### Why a linear scan and not an ANN index

1,592 vectors × 384 dimensions is about 600k multiply-adds — a couple of milliseconds in a Web
Worker. An ANN index would trade recall for a speedup nobody can perceive. At ten times this corpus
the answer changes; at this size it is premature.

### What ships

| Asset | Raw | Gzipped | When it is needed |
| --- | ---: | ---: | --- |
| `chunks.meta.json` | 550 KB | **54 KB** | first paint |
| `bm25.json` | 1,247 KB | 379 KB | first query |
| `vectors.bin` | 600 KB | 600 KB | first query (binary, already dense) |
| `chunks.text.json` | 1,967 KB | 445 KB | first result rendered |

There is no combined chunk file. `data/` is the site's public directory, so anything written there
is published — a third file holding both halves would have been 2.5 MB fetched by nobody. The two
tools that want whole chunks join the halves themselves.

---

## The corpus

| Source | Documents | Characters |
| --- | ---: | ---: |
| WCAG 2.2 Understanding | 100 | 1,219,463 |
| GOV.UK Design System | 92 | 405,406 |
| WCAG 2.2 specification | 1 | 121,898 |
| **Total** | **193** | **1,746,767** |

1,592 chunks, median 372 tokens (p10 231, p90 457), 1,108 carrying a success-criterion reference.

Chunking is structure-aware, and a chunk is always a **contiguous slice** of the normalized
document — never a reassembly — so the offset invariant holds by construction:

```ts
doc.text.slice(chunk.charStart, chunk.charEnd) === chunk.text
```

It is asserted over all 193 real documents on every test run. If it drifts, every highlighted
citation points at the wrong text while still claiming to be verified.

**EN 301 549 was cut.** ETSI publishes it as PDF and ODT with no clean HTML, PDF-to-offsets is the
most fragile job in the pipeline, and redistributing the text is legally grey. The loader stays
extensible; the differentiator here is verification, not corpus breadth.

---

## Running it

```bash
pnpm install
pnpm --filter @rag/ingest corpus   # fetches ~290 pages once, then works offline
pnpm --filter @rag/web dev
```

```bash
pnpm typecheck && pnpm test
pnpm --filter @rag/ingest ask "how much colour contrast does large text need"
pnpm --filter @rag/eval ablation   # regenerates docs/ABLATION.md
```

Without credentials the app runs on BM25 alone and says so, listing each stage that did not run and
why. To enable the rest, put an Account ID and a token with `Workers AI: Read` in `.env`:

```bash
printf 'CLOUDFLARE_ACCOUNT_ID=…\nCLOUDFLARE_API_TOKEN=…\n' > .env
```

Then deploy the worker and point the site at it:

```bash
cd packages/worker && npx wrangler secret put GEMINI_API_KEY && npx wrangler deploy
```

Then point the site at it and publish:

```bash
echo "VITE_WORKER_URL=https://<your-worker>.workers.dev" > packages/web/.env
pnpm --filter @rag/web build
npx wrangler pages deploy packages/web/dist --project-name=<your-project> --branch=main
```

Paste a secret into the dashboard and it arrives with a trailing newline; whitespace in a header
value is refused upstream, and the error you get back says the key is invalid. The worker trims it
and reports the upstream's own message, which is the only reason that was findable.

With no REST token the ingest embeds the corpus through the deployed worker instead — `/embed`
takes `texts` for documents as well as `query` for one query. 1,592 chunks in 16 requests, 16
seconds, no throttling.

---

## Dependencies

Fourteen, across five packages — `react`, `react-dom`, `vite`, `@vitejs/plugin-react`,
`tailwindcss`, `@tailwindcss/vite`, `typescript`, `vitest`, `@types/*`, `linkedom`, `wrangler`,
`axe-core`.

No search library, no tokenizer, no HTTP client, no test framework beyond vitest, no ANN library,
no state manager. BM25, the tokenizer, RRF, int8 quantization, the binary index format and the
verifier are written out — they are short, and they are the part being demonstrated. Node 24 runs
TypeScript natively, so there is no build step for any of the CLIs.

---

## If this ran on AWS

Out of scope here — the point of the architecture is that it costs nothing and cannot rot — but the
mapping is direct:

| This project | AWS equivalent |
| --- | --- |
| `vectors.bin` on a CDN | **S3 Vectors** |
| Workers AI `bge-small-en-v1.5` | **Bedrock** embeddings (Titan Text Embeddings, Cohere Embed) |
| Workers AI `bge-reranker-base` | **Bedrock Rerank** |
| Gemini Flash | **Bedrock** with a small Claude model |
| Cloudflare Worker | **Lambda** behind API Gateway or a Function URL |
| Static site on Pages | **S3 + CloudFront** |

The cost shape, rather than figures I have not verified against current pricing: vector storage for
1,592 × 384 int8 is negligible — kilobytes. Embedding the corpus is a **one-off** of about
557k tokens across the 1,592 chunks — more than the corpus itself, because of the 15% overlap. Everything recurring is **per query**: one embedding, one rerank over 30 candidates, one
generation over 8 chunks, and one batched entailment call. Generation dominates, so the lever is
the answer's length and how many claims it makes — not the retrieval.

The thing that would actually change is operational, not architectural: S3 Vectors and Lambda have
no free tier that lasts forever, so the demo would need a budget alarm and would stop being
something a stranger can click in three years' time.

---

## Layout

```
packages/
  core/     pure TypeScript — types, tokenizer, BM25, RRF, int8 index, verification
  ingest/   Node CLI — fetch, normalize, chunk, embed, emit the static indexes
  worker/   Cloudflare Worker — /embed, /rerank, /answer, /entail
  web/      Vite + React + Tailwind — the demo
  eval/     golden set, metrics, ablation harness, fabrication probe
data/
  corpus/   normalized source documents (committed — offsets resolve against these)
  index/    generated static assets
```

All retrieval and verification logic lives in `core` and is unit-tested. Components contain no
scoring logic.

[The Italian guide](docs/GUIDA.md) covers every decision in depth, including the ones that turned
out to be wrong first.
