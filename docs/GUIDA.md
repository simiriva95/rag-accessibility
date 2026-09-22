# Guida al progetto — RAG ibrido con citazioni verificate

Questa guida spiega **cosa stiamo costruendo, perché, e come funziona ogni pezzo**.
È scritta per essere letta a distanza di mesi, quando i dettagli saranno svaniti.

Stato: **settimane 1 e 2 completate a livello di codice**. Embedding, reranker e
generazione girano solo con le credenziali (vedi §12), ma tutto il resto — retrieval,
verifica, metriche, Worker — è scritto e testato. 206 test. Nessuna UI.

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
  worker/    Cloudflare Worker — /embed, /rerank, /answer
  web/       Vite + React + Tailwind — la demo                     (non ancora creato)
  eval/      golden set, harness, generatore tabella ablation
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
Niente libreria di ricerca, niente tokenizer, niente client HTTP: 90 test, tutto scritto
a mano dove il brief lo chiede.

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

## 7. Retrieval lessicale — `packages/core/src/tokenize.ts`, `bm25.ts`

### Il tokenizer è il pezzo che conta

Gli embedding densi sono bravi col significato e pessimi con gli identificatori:
`aria-describedby`, `sr-only` e `2.4.11` finiscono tutti nello stesso quartiere
sfocato. BM25 li recupera, ma solo se il tokenizer li tiene interi.

Quindi ogni composto viene emesso **due volte**, intero e spezzato:

```
aria-describedby        -> aria-describedby, aria, describedby
prefers-reduced-motion  -> prefers-reduced-motion, prefers, reduced, motion
errorMessage            -> errormessage, error, message
gap-4                   -> gap-4, gap, 4
```

Una query esatta colpisce la forma intera e prende un punteggio alto; una query
parziale raggiunge comunque il documento attraverso le parti.

**Unica eccezione: i riferimenti ai criteri.** `2.4.11` non viene mai spezzato, perché
`2`, `4` e `11` sono rumore che farebbe combaciare ogni criterio numerato con ogni
altro.

Nessuno stemming, nessuna stopword list. Lo stemming danneggia gli identificatori, e
la morfologia è esattamente ciò di cui si occupa la metà densa: è il senso stesso del
retrieval ibrido. Se il golden set dimostrerà il contrario, si aggiunge.

### BM25

```
              f(q,D) * (k1 + 1)
  score = Σ  ───────────────────────────────── * idf(q)
              f(q,D) + k1 * (1 - b + b * |D|/avgdl)
```

k1=1.2, b=0.75. `idf` nella forma probabilistica smussata `ln(1 + (N-df+0.5)/(df+0.5))`:
l'`1 +` esterno la tiene positiva per un termine presente in ogni documento, dove la
forma grezza diventa negativa e inizia a **penalizzare** le corrispondenze.

Un termine ripetuto nella query conta una volta sola: BM25 satura sulla frequenza nel
documento, non su quante volte l'utente ha scritto la parola.

L'indice viaggia come asset statico, quindi le posting list sono coppie piatte
`[doc, tf]` invece di oggetti. Un test verifica il round-trip JSON, un altro confronta
il punteggio con la formula calcolata a mano.

**Sul corpus reale: 8.377 termini, avgdl 211, 1,22 MB.**

---

## 8. Retrieval denso — `packages/core/src/dense.ts`

### Quantizzazione int8

I vettori vengono normalizzati L2, poi ciascuno viene scalato per la sua componente
più grande prima di essere arrotondato a int8. **Scala per vettore, non globale**:
le componenti di un vettore unitario in 384 dimensioni stanno ben dentro `[-1, 1]` e
una scala globale butterebbe via quasi tutto l'intervallo. Costo: 4 byte per vettore.

Un test tiene la top-10 quantizzata ad almeno 9 elementi su 10 della top-10 float32
esatta. Serve a garantire che **non sia la quantizzazione a decidere i risultati**.

### Il formato binario

```
magic u32 | count u32 | dims u32 | scales f32[count] | codes i8[count*dims]
```

Un blob solo invece di JSON: 1600 × 384 int8 sono 600 KB grezzi contro ~1,6 MB come
array JSON di numeri. La decodifica **copia** invece di creare una vista, perché un
`Float32Array` richiede allineamento a 4 byte che un buffer scaricato non sempre ha —
c'è un test apposta per il caso disallineato.

---

## 9. Fusione — `packages/core/src/rrf.ts`

```
score(d) = Σ  1 / (k + rank_r(d))
```

**Nessuna normalizzazione dei punteggi, ed è il punto.** I punteggi BM25 sono somme
illimitate di termini idf; il coseno sta in `[-1, 1]` e si accalca vicino al massimo.
Mapparli su una scala comune significa scegliere una mappatura, e ogni scelta è una
manopola che si rompe al corpus successivo. RRF legge **solo l'ordinamento**, che è
l'unica cosa su cui i due retriever concordano sul significato.

`k = 60` smorza la testa di ogni lista: il divario fra rank 1 e rank 2 è piccolo, così
un retriever non può trascinare un documento sulla sola propria sicurezza. **L'accordo
fra retriever pesa più della certezza dentro uno solo.**

I pareggi si rompono per id, così una run è riproducibile.

---

## 10. Il golden set — `packages/eval/src/golden.ts`

40 domande, scritte **prima** di qualunque tuning.

### Perché ancore e non id

L'annotazione punta a `{docId, heading?}`, non a id di chunk grezzi. Gli id sono
content-addressed e sopravvivono a una re-indicizzazione, ma **non** a una modifica del
chunker: e riannotare 40 domande a mano ogni volta che si muove un parametro è il modo
in cui un golden set smette silenziosamente di essere mantenuto.

`resolve.ts` traduce le ancore in id e **solleva un errore** quando un'ancora smette di
combaciare. È successo otto volte mentre scrivevo questo set.

### Rilevanza graduata

La prima passata annotava ogni chunk del documento giusto. Risultato: fino al **2,8%
del corpus marcato rilevante per una sola domanda**, e Recall@5 avrebbe letto 1.0 per
un retriever che non aveva imparato niente.

```
grado 2  primary  — il chunk che risponde davvero
grado 1  related  — stesso documento, contesto utile, non la risposta
grado 0  tutto il resto
```

Recall e MRR si misurano sui soli primary; nDCG usa entrambi i gradi. Mediana: 3 chunk
primary per domanda. Un test fallisce se un insieme graduato supera il 5% del corpus.

### Due posti dove cercare un'ancora

`headingPath` contiene **solo gli antenati**. Un criterio abbastanza corto da essere
stato fuso dentro un chunk ha il proprio titolo nel *corpo* del chunk, non nel percorso
— ed è il caso della maggior parte dei criteri WCAG, le cui formulazioni sono lunghe
tre righe. Cercare solo nel percorso li perdeva in silenzio. Il testo del titolo che
compare come prosa, invece, non conta.

### Composizione

| Tipo | N | Perché |
|---|---:|---|
| identifier | 12 | `2.4.11`, `4.5:1`, `aria-describedby`, `prefers-reduced-motion`. Qui vive l'argomento per l'ibrido |
| conceptual | 17 | Parafrasi senza vocabolario condiviso, dove BM25 arranca |
| design | 6 | La risposta è in GOV.UK, non in WCAG |
| refusal | 5 | Domande a cui il corpus **non può** rispondere |

Le refusal vanno dal fuori-dominio totale (Kubernetes) ai quasi-centri: WCAG 3.0, il
costo di un audit. Un sistema che va bene ovunque e poi inventa una risposta qui ha
fallito proprio nella cosa di cui parla il progetto.

---

## 11. Metriche e ablation — `packages/eval/src/metrics.ts`, `harness.ts`

**Recall ha il denominatore limitato a k.** Una domanda la cui risposta occupa davvero
13 chunk non potrebbe superare 0.38 di Recall@5 nella forma non limitata: quel numero
misurerebbe quanto è ampia l'annotazione, non quanto ha fatto bene il retrieval.

**nDCG usa la forma a guadagno esponenziale** `(2^g - 1)/log2(rank+1)`. È ciò che rende
utile la rilevanza graduata: un chunk primary finisce nettamente sopra uno related,
non un gradino sopra.

Un retriever che non può girare viene riportato come **non disponibile, con il motivo**.
Mai eliminato in silenzio, mai sostituito coi numeri della riga accanto. L'unico valore
della tabella è che chi legge possa fidarsi di ciò che dichiara.

### Baseline attuale (solo metà lessicale)

| Retriever | Recall@5 | Recall@10 | Recall@30 | Success@5 | nDCG@10 | MRR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| BM25 only | 40.5% | 59.2% | 78.2% | 68.6% | 0.466 | 0.514 |

### Recall@10 per tipo di domanda — la metà interessante

| Retriever | identifier (12) | conceptual (17) | design (6) |
| --- | ---: | ---: | ---: |
| BM25 only | **66.5%** | **47.3%** | 78.3% |

Ecco l'argomento, già visibile: **BM25 prende 66,5% sugli identificatori e 47,3% sui
concetti**. Quel divario è esattamente ciò per cui esiste la metà densa. L'ablation
mostrerà se si chiude — o se la premessa era sbagliata.

La tabella viene rigenerata da `pnpm --filter @rag/eval ablation` e committata in
[ABLATION.md](ABLATION.md).

---

## 12. Come si esegue

```bash
pnpm install
```

Corpus, chunk e indice BM25 (la prima volta scarica ~290 pagine, poi è offline grazie
alla cache in `data/raw/`):

```bash
pnpm --filter @rag/ingest corpus
```

Interrogare da terminale:

```bash
pnpm --filter @rag/ingest ask "how much colour contrast does large text need"
```

Golden set e tabella di ablation:

```bash
pnpm --filter @rag/eval golden
pnpm --filter @rag/eval ablation
```

Typecheck e test:

```bash
pnpm typecheck && pnpm test
```

### Credenziali Cloudflare — il blocco attuale

Senza queste, embedding e metà densa non girano. Tutto il resto funziona.

1. Su `dash.cloudflare.com`, copiare l'**Account ID** (è nell'URL, o nella sidebar).
2. Creare un **API token** con il permesso `Workers AI: Read`.
3. Creare `.env` nella radice del repo:

```
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...
```

Poi rilanciare `pnpm --filter @rag/ingest corpus`: genera `data/index/vectors.bin` e
l'ablation si riempie da sola. I vettori sono cachati per id di chunk, quindi una
re-indicizzazione dopo una modifica al chunker non rispende la quota su tutto il corpus.

---

## 13. Cosa manca

### Settimana 1 — fatta

- [x] Scheletro workspace e tipi condivisi
- [x] Fetch e normalizzazione WCAG 2.2 + GOV.UK Design System
- [x] Chunker structure-aware con offset verificati
- [x] Tokenizer + BM25 Okapi scritti a mano
- [x] Indice denso int8 + formato binario
- [x] Fusione RRF
- [x] CLI che risponde da terminale
- [x] Golden set, 40 domande con rilevanza graduata
- [x] Metriche e harness di ablation
- [ ] Embedding del corpus — **bloccato sulle credenziali**

### Settimana 2 — in corso

- [x] Verificatore a tre livelli (§14)
- [x] Metriche di citazione (§15)
- [x] Sonda di fabbricazione: 189 casi avversari, 0 errori (§16)
- [x] Cloudflare Worker: `/embed`, `/rerank`, `/answer`, `/entail` con degradazione onesta (§17)
- [x] Giudice LLM concreto dietro `EntailmentJudge`, a batch (§18)
- [ ] Deploy del Worker — **credenziali**
- [ ] Tabella di ablation completa — **credenziali**

### Settimana 3

Retrieval debugger, evidenziazione delle citazioni, pass di accessibilità, deploy,
README.

---

## 14. Il layer di verifica — `packages/core/src/verify.ts`

Il modello non produce prosa con note a piè di pagina. Produce **claim**:

```ts
type Claim = {
  sentence: string;
  chunkIds: string[];
  quote: string;   // deve comparire alla lettera in almeno un chunk citato
};
```

### I tre controlli, dal più economico

**1. Quote match.** Nessun fallback fuzzy, nessuna soglia di similarità. Una citazione
che non è nel testo non è una citazione. Questa singola regola intercetta la maggior
parte delle invenzioni al costo di una ricerca di sottostringa.

**2. Span resolution.** La citazione trovata viene rimappata a offset nel documento
sorgente, così la UI può evidenziarla al suo posto.

**3. Entailment.** Viene chiesto **solo dopo** che una citazione ha combaciato: un
claim con citazione assente è già invalido, e valutarlo spenderebbe quota per non
cambiare niente. Dietro l'interfaccia `EntailmentJudge`, così un giudice LLM oggi e un
cross-encoder domani non toccano questo file.

### Cosa viene normalizzato, e cosa no

Una classe di equivalenza **finita ed esplicita**: forma Unicode, run di whitespace, e
le sostituzioni tipografiche che un modello fa da solo — virgolette curve, trattini,
ellissi. La prosa GOV.UK è piena di apostrofi U+2019: bocciare una citazione corretta
perché il modello ha scritto quello ASCII sarebbe un bug travestito da rigore.

**Il case non si normalizza.** "Verbatim" è l'affermazione che stiamo facendo.

### La normalizzazione deve essere reversibile

Altrimenti la citazione si può trovare ma non evidenziare, che è tutto l'esercizio.
Due bug, entrambi trovati dai test:

1. **Normalizzando carattere per carattere, NFC non compone.** `'e'` e `U+0301`
   normalizzano ciascuno a sé stessi, quindi il testo decomposto non eguagliava mai la
   sua forma composta — si perdeva esattamente l'equivalenza per cui NFC esiste. Ora si
   lavora per **cluster**: un code point più i suoi segni combinanti.
2. **Un cluster trasforma più caratteri sorgente in uno solo**, quindi un singolo
   offset per carattere normalizzato non basta a chiudere uno span. La mappa porta
   `starts` e `ends`, e la fine esclusiva si legge dalla mappa invece di calcolarla
   come `start + 1`.

Uno `stato` per frase:

```ts
type SentenceStatus = 'verified' | 'partial' | 'unsupported' | 'uncited';
```

Una frase vale quanto il suo claim migliore. Una frase **senza** claim è `uncited`, non
`unsupported`: potrebbe essere un connettivo, e confondere le due cose nasconderebbe
proprio le frasi che fanno un'affermazione fattuale non sostenuta.

**I claim non supportati si mostrano, non si nascondono.** Mostrarli è tutto il punto.

---

## 15. Metriche di citazione — `packages/eval/src/citation.ts`

Si calcolano sulle **frasi** della risposta, non solo sui claim. Un modello che cita
due frasi alla perfezione e ne lascia sei senza citazione prenderebbe 100% su
qualunque metrica basata solo sui claim, dicendo sei cose non sostenute.

| Metrica | Definizione |
|---|---|
| `coverage` | Frasi con almeno un claim, sul totale |
| `precision` | Di **ogni** chunk citato, la frazione che contiene davvero la citazione |
| `quoteFailureRate` | Claim la cui citazione non compare in nessun chunk citato |
| `unsupportedRate` | Frasi che fanno un claim e i cui claim sono tutti falliti |
| `uncitedRate` | Frasi che non fanno alcun claim |

`precision` ha richiesto una modifica al verificatore: prima si fermava al primo chunk
citato che conteneva la citazione. Basta per risolvere lo span, non per giudicare le
citazioni — **un claim che ne cita quattro ed è sorretto da uno ne ha fatte tre che non
reggono**. Ora vengono controllate tutte.

L'aggregazione fa la media **per risposta**, non mette in comune le frasi: altrimenti
una risposta lunga surclasserebbe una corta.

---

## 16. La sonda di fabbricazione — `packages/eval/src/fabrication.test.ts`

È la parte che rende l'affermazione verificabile. Il progetto sostiene che le citazioni
sono verificate invece che dichiarate: vale qualcosa solo se il controllo non accetta
mai una citazione sbagliata e non rifiuta mai una giusta.

Quindi se ne costruiscono **189 dal corpus vero**, su tutte e tre le fonti:

**65 che devono essere accettate**
- estratto alla lettera
- estratto col whitespace riformattato, come lo restituisce un modello
- estratto con gli apostrofi tipografici raddrizzati

**124 che devono essere rifiutate**
- una citazione vera, attribuita al chunk sbagliato
- un estratto con **una** parola sostituita
- due frammenti veri del chunk **cuciti insieme** (entrambi presenti, la giunzione no)
- una frase inventata nel registro del corpus

**Zero falsi accettati, zero falsi rifiutati.** Nessun modello, nessuna quota: è il
controllo 1 da solo, ed è il punto — il controllo economico regge quasi tutto il peso.

---

## 17. Il Cloudflare Worker — `packages/worker/src/index.ts`

Le tre cose che non si possono precalcolare. Tutto il resto è un file statico.

### Ogni endpoint sa cosa fare quando il modello non c'è

È il requisito che tiene in piedi la demo quando il free tier dice no. **Nessuno dei
tre finge di aver girato.**

| Endpoint | Se il modello non risponde |
|---|---|
| `/embed` | **503.** Non esiste fallback: senza vettore della query la metà densa non può girare, e il client degrada da solo a BM25 |
| `/rerank` | **200 con `degraded`.** Restituisce l'ordine ricevuto. I risultati sono *peggiori*, non diversi: la UI lo dice |
| `/answer` | **`degraded` con la ragione.** Mai una risposta inventata, mai una vuota travestita da rifiuto |
| `/entail` | **`null` per ogni coppia**, mai `0`. Zero è un verdetto; un rate limit no |

`/embed` rifiuta anche un vettore della larghezza sbagliata invece di restituirlo: un
vettore corto in silenzio corromperebbe ogni coseno dell'indice.

### Scelte

- **Workers AI via binding, non REST**: nessun API token vive dentro il Worker.
- **La chiave Gemini viaggia in un header, mai nell'URL.** C'è un test apposta: una
  chiave in query string finisce nei log.
- **Rate limiting col limiter nativo della piattaforma**, per IP. Niente Durable
  Object, niente KV, niente da tenere acceso. Dichiarato come `ratelimits` di primo
  livello e **non** sotto `unsafe`: funzionano entrambi oggi, ma i campi `unsafe` sono
  documentati come soggetti a cambiare senza preavviso, e l'unico requisito duro qui è
  che fra due anni giri ancora.
- **Binding mancante = richiesta permessa.** Una demo che deve stare su per anni non
  deve spegnersi per una svista di configurazione; i cap sugli input limitano comunque
  quanto può costare una singola chiamata.
- **Cap sugli input**: il rate limiting limita quante chiamate fa un chiamante, i cap
  limitano quanto costa una chiamata. Un chunk troppo lungo viene **troncato**, non
  rifiutato: è colpa del nostro chunker, non di chi chiama.

### Il contratto della risposta — `packages/core/src/answer.ts`

Sta in `core` perché Worker, UI ed eval ne condividano **una sola** definizione.

```ts
type ModelAnswer = {
  answerable: boolean;
  sentences: string[];
  claims: Claim[];
};
```

Due dettagli che contano:

- **I claim puntano alle frasi per indice**, non ripetendone il testo. Chiedere a un
  modello di scrivere la stessa frase due volte e poi accoppiarle per stringa è un modo
  affidabile di ritrovarsi con claim che non appartengono a nessuna frase.
- **`answerable` è esplicito.** Un rifiuto non è una risposta senza citazioni: le
  metriche lo leggerebbero come diverse frasi non citate, punendo il modello per aver
  correttamente declinato. Deve poterlo dire.

Lo schema JSON passato al generatore sta **accanto al parser**, così non possono
divergere: ciò che si chiede al modello e ciò che si accetta indietro sono una
definizione sola. L'output strutturato rende la forma probabile, non certa — per questo
il parser controlla comunque. Un claim malformato viene scartato **con la ragione**,
non in silenzio: perdere una citazione non deve far perdere la risposta, e uno scarto
muto nasconderebbe un modello che si comporta male.

### Deploy

```bash
cd packages/worker
npx wrangler secret put GEMINI_API_KEY   # chiave di ai.google.dev
npx wrangler deploy
```

Bundle: 10,98 KiB, 3,77 KiB gzip.

---

## 18. Il giudice di entailment — `packages/core/src/entailment.ts`

### Perché a batch

`EntailmentJudge` prende un **array** di coppie, non una alla volta. Il free tier è
misurato al minuto: una risposta da sei frasi giudicata un claim per volta spendeva
**sei delle quindici richieste** disponibili in quel minuto per una sola domanda.

Un cross-encoder fa batch altrettanto naturalmente, quindi la forma va bene anche per
il sostituto, non solo per la prima implementazione.

Di conseguenza `verifyClaims` è diventato **due fasi esplicite**, che è il modello di
costo messo per iscritto:

1. **Quote match** — locale e gratuito, gira per ogni claim.
2. **Entailment** — costa una chiamata, gira **una volta sola**, per i claim
   sopravvissuti.

### Tre etichette, non un numero

I modelli sono inaffidabili sui punteggi fini calibrati: se chiedi 0.73 te lo danno, e
non significa niente. Tre etichette sono qualcosa che un modello può davvero decidere,
e cadono ai due lati delle soglie già esistenti:

| Etichetta | Punteggio | Esito |
|---|---:|---|
| `supported` | 1.0 | ≥ 0.7 → **verified** |
| `partially_supported` | 0.5 | ≥ 0.4 → **partial** |
| `not_supported` | 0.0 | < 0.4 → **unsupported** |

L'interfaccia resta `0..1`, così un cross-encoder — che un punteggio continuo vero lo
produce — non richiede nessuna modifica a valle.

### `unverified`: lo stato che mancava

```ts
type ClaimStatus = 'verified' | 'partial' | 'unsupported' | 'unverified';
```

`unverified` = **la citazione regge, ma il controllo di entailment non ha potuto
girare**. Tenuto distinto da `partial` di proposito: *"il giudice dice che il supporto
è debole"* e *"non c'era nessun giudice"* sono due cose diverse da mostrare a chi
legge, e confonderle farebbe sembrare un risultato quello che è un disservizio.

Nell'ordinamento sta **sopra `unsupported` e sotto `partial`**: qualunque verdetto
batte una citazione non giudicata, tranne il rifiuto esplicito.

### Null, mai zero

Ovunque un punteggio non si possa ottenere, la risposta è `null`. **Zero è un verdetto;
un rate limit no**, e far leggere l'uno come l'altro mostrerebbe un disservizio come
un'invenzione.

Per lo stesso motivo il giudice remoto **non solleva mai eccezioni**: una risposta le
cui citazioni hanno retto tutte non deve sparire perché il giudice era occupato.

---

## 19. Test d'integrazione — `packages/eval/src/pipeline.test.ts`

Percorre l'intera catena di contratti sui chunk veri: cosa si chiede al modello, cosa
accetta il parser, cosa ne fa il verificatore, cosa dicono le metriche.

I test unitari tengono ciascuno un anello. Questo li tiene **insieme** — è il test che
fallisce quando due di loro divergono continuando entrambi a passare sulle proprie
fixture.

Distingue in particolare tre cose che è facile confondere:

- citazione **inventata** → `unsupported`, `quoteFailureRate` sale;
- citazione **vera ma attribuita al chunk sbagliato** → `unsupported`, e `precision`
  scende;
- citazione **valida ma non giudicata** → `unverified`, e `unsupportedRate` resta 0.

---

## 20. Decisioni prese, per memoria

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
