# Guida al progetto — RAG ibrido con citazioni verificate

Questa guida spiega **cosa stiamo costruendo, perché, e come funziona ogni pezzo**.
È scritta per essere letta a distanza di mesi, quando i dettagli saranno svaniti.

Stato al momento della scrittura: **incrementi 1–4 completati** (settimana 1, parte
retrieval). Nessuna UI, nessun modello ancora chiamato.

---

## 1. Cos'è

Un sistema di domande e risposte su un corpus di accessibilità (WCAG 2.2 +
GOV.UK Design System) con:

- **retrieval ibrido**: denso (embedding) + BM25 (lessicale) + fusione + reranking;
- **un layer di verifica** che dimostra, frase per frase, che ogni citazione è
  davvero supportata dal testo sorgente.

Il punto non è "ho costruito un RAG". Il punto è che **il retrieval è visibile** e
**le citazioni sono verificate invece che dichiarate**.

### Vincoli non negoziabili

| Vincolo | Conseguenza pratica |
|---|---|
| Costo zero | Solo free tier. Niente server sempre acceso, niente vector DB gestito |
| La demo deve restare in piedi per anni | Niente cold start, niente credenziali che scadono |
| Tre settimane di serate | Si taglia aggressivamente |
| La demo deve essere WCAG 2.2 AA | Un RAG sull'accessibilità con una UI inaccessibile è squalificante |

---

## 2. Architettura

**Indice statico nel client, modelli all'edge.**

```
  build time (Node)                 runtime (browser)              runtime (edge)
  ────────────────────              ─────────────────              ──────────────
  fetch HTML sorgenti
  normalizzazione        ─────►  data/corpus/*.txt
  chunking + offset      ─────►  data/index/chunks.json
  embedding (int8)       ─────►  data/index/vectors.bin
  indice BM25            ─────►  data/index/bm25.json
                                       │
                                       ▼
                                 Web Worker:
                                 - scan denso coseno          Cloudflare Worker:
                                 - BM25                  ◄──► - /embed  (query)
                                 - fusione RRF                - /rerank
                                       │                      - /answer
                                       ▼
                                 UI React
```

Solo tre cose non sono precalcolabili e girano sull'edge: **embedding della query**,
**reranking**, **generazione**. Tutto il resto è un file statico servito da CDN.

### Alternative scartate (e perché)

- **Tutto lato client**, embedding e reranker in WASM: ~70 MB di modelli al primo
  accesso. Inaccettabile per una demo aperta dal telefono.
- **Backend vero** (Postgres/pgvector, Qdrant): cold start, credenziali da ruotare,
  free tier che si sospendono. La demo muore in silenzio dopo sei mesi.

### Perché brute force e non un indice ANN

Con ~1600 chunk, uno scan lineare del coseno su 384 dimensioni sono ~600k
moltiplicazioni: millisecondi in un Web Worker. Un indice ANN qui **costa accuratezza
senza far guadagnare tempo percepibile**. È una scelta da motivare nel README, non una
mancanza.

---

## 3. Struttura del repository

```
packages/
  core/      TypeScript puro — tipi, BM25, RRF, verifica. Zero dipendenze runtime
  ingest/    CLI Node — fetch, parsing, normalizzazione, chunking, indici statici
  worker/    Cloudflare Worker — /embed, /rerank, /answer          (non ancora creato)
  web/       Vite + React + Tailwind — la demo                     (non ancora creato)
  eval/      golden set, harness, generatore tabella ablation      (non ancora creato)
data/
  raw/       HTML scaricato, cache locale                          (gitignored)
  corpus/    documenti normalizzati, committati
  index/     asset statici generati                                (gitignored)
```

I package si creano **quando hanno del codice dentro**. Niente cartelle vuote
"per dopo".

### Scelte di tooling

- **Node 24 esegue TypeScript nativamente** (type stripping). Quindi niente `tsx`,
  niente `ts-node`, nessuno step di build per le CLI: `node src/cli.ts` e basta.
- TypeScript serve **solo per il typecheck** (`noEmit`).
- Un solo `vitest.config.ts` alla radice per tutti i package.
- Dipendenze totali finora: `typescript`, `vitest`, `@types/node`, `linkedom`.

Due flag severi attivi, che vale la pena conoscere perché cambiano come si scrive il
codice:

- `noUncheckedIndexedAccess` — `array[i]` ha tipo `T | undefined`;
- `exactOptionalPropertyTypes` — una proprietà opzionale va **omessa**, non messa a
  `undefined`.

---

## 4. Il corpus

### Fonti

| Fonte | Documenti | Caratteri | Quota |
|---|---:|---:|---:|
| WCAG 2.2 Understanding | 100 | 1.219.463 | 70% |
| GOV.UK Design System | 92 | 405.406 | 23% |
| Specifica WCAG 2.2 | 1 | 121.898 | 7% |
| **Totale** | **193** | **1.746.767** | |

Le 100 pagine *Understanding* si scoprono dai link che la specifica stessa mette
accanto a ogni criterio (`doclinks`), non da una pagina indice: è la fonte di verità
più stabile.

### EN 301 549: tagliata

Era prevista dal brief. È stata **esclusa dalla v1** per due motivi:

1. ETSI la pubblica in PDF/ODT, senza HTML pulito. Il parsing PDF → offset
   normalizzati è il lavoro più fragile dell'intera pipeline.
2. La ridistribuzione del testo in un repo pubblico è giuridicamente grigia.

Il caricatore del corpus resta estendibile: aggiungerla è una voce di configurazione.
Il differenziatore del progetto è la verifica, non l'ampiezza del corpus.

---

## 5. Normalizzazione — `packages/ingest/src/normalize.ts`

### Il problema

Gli offset dei chunk devono risolvere contro **esattamente il testo che la UI
mostra**. Se la UI rende l'HTML originale e gli offset sono calcolati su un testo
diverso, l'evidenziazione della citazione scivola in silenzio. Non c'è errore, solo
il testo sbagliato evidenziato.

### La soluzione

Si normalizza l'HTML una volta sola in una forma canonica, la si **persiste**, e da
quel momento quella forma è l'unica verità. La UI renderà quella, non l'HTML.

Il formato è **markdown-lite**:

- un blocco per riga, blocchi separati da una riga vuota;
- i titoli diventano `### Testo` (il numero di `#` è il livello);
- gli elenchi puntati diventano `- voce`;
- le righe di tabella diventano `cella | cella | cella`;
- whitespace collassato, normalizzazione Unicode **NFC**.

È abbastanza struttura perché il chunker ricostruisca la gerarchia dei titoli, ma
resta testo semplice che la UI può mostrare così com'è.

**Perché NFC qui**: la verifica confronta una citazione carattere per carattere con
il testo del chunk. Se una parte è in NFC e l'altra in NFD, `é` e `é` non coincidono
e la citazione risulta falsamente non verificata. Si normalizza una volta, all'origine.

### Cosa viene scartato

- tag di navigazione (`nav`, `aside`, `footer`, `script`, …), elementi `hidden`;
- ringraziamenti, changelog, riferimenti bibliografici — nessun valore per il corpus,
  e gli elenchi di nomi dei partecipanti sporcano BM25;
- **gli esempi del Design System GOV.UK**.

Quest'ultima è la decisione meno ovvia. GOV.UK ripete **l'intera tabella delle opzioni
della macro dentro ogni esempio della pagina**. La pagina "Checkboxes" arriva a 76.000
caratteri di cui circa il 92% sono nove copie di una reference API più i tab di codice
HTML/Nunjucks. Scartando il wrapper dell'esempio la pagina scende a **6.800 caratteri
di sola guida sull'accessibilità** — e continua a nominare `<fieldset>` e `<legend>`.

Tenerla avrebbe reso il Design System tre volte più grande di WCAG, trasformando un
corpus sull'accessibilità in una lookup di API Nunjucks.

**Costo di questa scelta**: niente nomi di classe letterali tipo
`govuk-checkboxes__input` nel corpus. Se il golden set mostrerà che servono, si
recupera con una regex.

---

## 6. Chunking — `packages/ingest/src/chunk.ts`

È il pezzo più delicato della settimana 1.

### L'invariante

```ts
doc.text.slice(chunk.charStart, chunk.charEnd) === chunk.text
```

Vale **per costruzione**: un chunk è sempre una fetta contigua del documento
normalizzato, mai un riassemblaggio di parti. Per questo i titoli antenati **non
vengono copiati dentro il testo del chunk** — viaggiano in `headingPath` come
metadato. Copiarli avrebbe rotto l'invariante al primo chunk.

L'invariante è verificata **su tutti i 193 documenti reali**, non solo su fixture. Se
scivola, ogni citazione evidenziata nella UI punta al testo sbagliato.

### Come funziona

1. Il testo si spezza in blocchi sulla riga vuota, tracciando gli offset assoluti.
2. Un blocco più lungo del cap viene spezzato sui confini di frase. Lo split usa un
   separatore catturato (`split(/((?<=[.!?:;])\s+)/)`) così le parti, separatori
   inclusi, ricompongono esattamente l'originale e gli offset restano esatti.
3. Si accumulano blocchi mantenendo uno **stack dei titoli**: arrivato un titolo di
   livello *L*, si tolgono dallo stack tutti quelli di livello ≥ *L*, poi si mette
   il nuovo. Da lì si legge `headingPath`.
4. Si chiude il chunk quando raggiunge il target, o quando un titolo di sezione apre
   un blocco nuovo.

### I parametri

| Parametro | Valore | Motivo |
|---|---:|---|
| `targetTokens` | 400 | Target del brief (300–500) |
| `minTokens` | 250 | Sotto questa soglia un titolo **non** apre un chunk nuovo |
| `maxTokens` | 480 | Cap duro: sta dentro la finestra da 512 token di bge-small |
| `overlapRatio` | 0.15 | Sovrapposizione fra chunk consecutivi |

**`minTokens` è la correzione più importante.** Spezzando su ogni titolo la mediana
era **149 token, con un terzo dei chunk sotto i 100**: questi documenti sono pieni di
sottosezioni da due righe, e i frammenti senza contesto seppelliscono i chunk utili.
Ora un titolo apre un chunk nuovo solo quando quello corrente vale già da solo come
risultato di ricerca.

### `scRef` — il riferimento al criterio

Estratto dal **titolo più profondo** che ne contenga uno, con tre forme riconosciute:

```
Success Criterion 2.4.11 Focus Not Obscured (Minimum)
Understanding SC 1.4.3 Contrast (Minimum)
2.4.11 Focus Not Obscured
```

Il più profondo vince: il criterio batte la linea guida che lo contiene. Così **il
corpo di un criterio risolve sempre al suo identificatore**, comunque venga spezzato —
che è il requisito "mai separare un criterio dal suo identificatore" del brief.

### Gli id

```
sha256(docId + "\n" + headingPath + "\n" + text) → primi 16 hex
```

**Content-addressed**: dipendono da cosa dice il chunk, non da dove sta. Se un
documento a monte cambia e gli offset scorrono, un chunk il cui testo e contesto non
sono cambiati **mantiene lo stesso id** — e le annotazioni del golden set restano
valide. Testo identico sotto lo stesso percorso di titoli si disambigua con un
contatore, non con la posizione, per non perdere quella proprietà.

### Conteggio token

Euristica: `ceil(caratteri / 3.5)`. Deliberatamente **sovrastima** per l'inglese, così
il cap duro tiene dentro la finestra del modello anche su testo denso di
identificatori. Non serve un tokenizer vero per decidere dove tagliare.

### Tre bug trovati dai test

Vale la pena ricordarli perché sono il tipo di errore che non si vede a occhio:

1. **La dimensione era misurata come somma dei blocchi, `tokenCount` sulla fetta.**
   Le due cose divergono e i chunk sforavano il cap — uno era arrivato a **740 token
   contro un cap di 480**. Ora entrambe misurano la fetta, che è ciò che viene
   davvero mandato all'embedding.
2. **L'overlap copiava blocchi interi senza controllare lo spazio**, poi aggiungeva
   il blocco successivo senza ricontrollare il cap. Ora l'overlap si risolve
   *contro il blocco che lo seguirà*: non può né sforare il cap né produrre un chunk
   fatto di solo overlap.
3. **Un chunk che raggiungeva il target sul blocco prima di un titolo** si portava
   l'overlap oltre il titolo di sezione.

### Numeri attuali

```
1592 chunk
mediana 372 token   (p10 231, p90 457, max 480)
41 chunk sotto i 100 token (2.5%)
51% delle coppie adiacenti si sovrappone
1108 chunk portano un riferimento a un criterio
```

---

## 7. Come si esegue

Installazione:

```bash
pnpm install
```

Generare corpus e chunk (la prima volta scarica ~200 pagine, poi è offline grazie
alla cache in `data/raw/`):

```bash
pnpm --filter @rag/ingest corpus
```

Typecheck e test:

```bash
pnpm typecheck && pnpm test
```

---

## 8. Cosa manca

### Settimana 1 (in corso)

- [x] Scheletro workspace e tipi condivisi
- [x] Fetch e normalizzazione WCAG 2.2
- [x] Fetch e normalizzazione GOV.UK Design System
- [x] Chunker structure-aware con offset verificati
- [ ] **Tokenizer + BM25 Okapi** (k1=1.2, b=0.75), scritto a mano
- [ ] **Embedding in fase di build** via Workers AI, quantizzazione int8
- [ ] **Fusione RRF** (k=60) e CLI che risponde da terminale
- [ ] **Golden set**: 40 domande annotate a mano

### Settimana 2

Reranking (`bge-reranker-base`), verificatore a tre livelli, harness di valutazione,
tabella di ablation generata.

### Settimana 3

Retrieval debugger, evidenziazione delle citazioni, pass di accessibilità, deploy,
README.

---

## 9. Il layer di verifica (progetto, non ancora scritto)

Il modello non produce prosa con note a piè di pagina. Produce **claim**:

```ts
type Claim = {
  sentence: string;
  chunkIds: string[];
  quote: string;   // deve comparire alla lettera in almeno un chunk citato
};
```

Tre controlli, in ordine:

1. **Quote match** — normalizzati whitespace e Unicode, la citazione deve essere una
   sottostringa **letterale** di un chunk citato. Se non lo è, il claim è invalido:
   nessun fallback fuzzy, nessuna soglia di similarità. È il controllo più economico
   e intercetta la maggior parte delle invenzioni.
2. **Entailment** — il claim viene passato a un giudizio NLI. Si parte con un LLM
   come giudice, lasciando l'interfaccia aperta per un cross-encoder.
3. **Span resolution** — la citazione trovata viene rimappata a `charStart`/`charEnd`
   nel documento sorgente, così la UI può evidenziarla al suo posto.

```ts
type VerifiedClaim = Claim & {
  quoteMatch: boolean;
  span?: { chunkId: string; start: number; end: number };
  entailment: number;                              // 0..1
  status: 'verified' | 'partial' | 'unsupported';
};
```

**I claim non supportati si mostrano, non si nascondono.** Mostrarli è tutto il punto.

---

## 10. Decisioni prese, per memoria

| Decisione | Motivo |
|---|---|
| GOV.UK Design System invece di shadcn/ui | Prosa sull'accessibilità molto più ricca |
| EN 301 549 esclusa dalla v1 | Solo PDF, parsing fragile, ridistribuzione grigia |
| Golden set 40 domande, non 60 | 60 annotate a mano sono ~3 serate; si annota *dopo* aver visto i risultati |
| Niente project references TypeScript | Richiedono `composite`, in conflitto con `noEmit` |
| Il chunker sta in `ingest`, non in `core` | Usa `node:crypto`; `core` deve girare nel browser |
| Esempi GOV.UK scartati | 92% della pagina, nove copie della stessa tabella |
| Nessuna deduplicazione del boilerplate fra pagine | Non dovrebbe emergere per query reali; si rivaluta col golden set |

### Nota sulla dimensione del corpus

Il brief prevedeva 3.000–5.000 chunk. Con questo corpus siamo a **1.592**. Non è un
problema: rende più solido l'argomento "scan lineare invece di ANN" e riduce l'indice
int8 a poche centinaia di KB. Il README riporterà il numero reale.
