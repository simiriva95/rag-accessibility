import type { Lang } from './i18n.tsx';
import { INGEST, METRICS, PARADIGMS, type IngestStage, type Metric, type Paradigm } from './theory.ts';

/**
 * The Italian text of theory.ts, as overlays keyed by id. The English file
 * stays the source of every number, formula and reference; this file holds
 * only words, so a change to a measurement cannot drift between languages.
 */

type ParadigmText = Pick<Paradigm, 'name' | 'family' | 'plain' | 'idea' | 'cost' | 'strengths' | 'failures'>;

const PARADIGMS_IT: Record<string, ParadigmText> = {
  sparse: {
    name: 'Retrieval lessicale sparso',
    family: 'BM25 · bag of words',
    plain:
      'Come l’indice analitico in fondo a un libro. Cerchi ogni parola della tua domanda e vedi quali pagine la nominano. Una pagina che contiene una tua parola rara, come “contrast”, vale molto più di una che contiene solo una parola comune, come “how”. È veloce e del tutto prevedibile, ma vede solo le parole: se la pagina dice “hard to read” e tu hai chiesto “low contrast”, non le collega.',
    idea:
      'Un documento è rappresentato dai termini che contiene e da quante volte li contiene. La rilevanza è stimata con il probabilistic relevance framework: un termine della domanda conta di più quanto più è raro nel corpus (inverse document frequency), e un documento guadagna se lo ripete, ma con rendimenti decrescenti e normalizzati per la lunghezza del documento. Non si impara nulla: l’indice è una lista invertita di posting.',
    cost: 'Proporzionale ai posting dei termini della domanda. Qui: 2-3 ms nel browser.',
    strengths: [
      'Gli identificatori esatti sopravvivono: 2.4.11, aria-describedby, 4.5:1.',
      'Completamente spiegabile: ogni punto del punteggio è un termine che si può nominare.',
      'Nessun modello, nessuna GPU, nessuna deriva: lo stesso indice dà la stessa risposta fra cinque anni.',
    ],
    failures: [
      'Vocabolario diverso: una parafrasi che non condivide termini con la risposta prende zero.',
      'Nessuna nozione di significato, ordine delle parole o negazione.',
    ],
  },
  dense: {
    name: 'Retrieval semantico (dense)',
    family: 'Bi-encoder · embedding',
    plain:
      'Come una mappa dei significati. Una rete neurale ha letto milioni di frasi e ha imparato a mettere ogni passaggio come un punto, in modo che i passaggi sulla stessa idea finiscano vicini anche se usano parole diverse. Anche la tua domanda diventa un punto, e la ricerca prende i punti più vicini. Capisce che “hard to read” e “low contrast” sono vicini, ma è vaga sui nomi e sui numeri esatti come 2.4.11.',
    idea:
      'Un encoder neurale trasforma la domanda e ogni passaggio, separatamente, in un punto di uno spazio vettoriale comune, addestrato perché una domanda cada vicino ai passaggi che la rispondono. I passaggi sono codificati una volta sola, in anticipo, quindi a ogni ricerca si codifica solo la domanda e la rilevanza diventa un prodotto scalare. Cattura parafrasi e sinonimi, cioè proprio quello che la ricerca lessicale non può fare.',
    cost:
      'Una chiamata all’encoder per la domanda all’edge, poi una scansione lineare: 1.592 × 384 ≈ 611 mila moltiplicazioni, pochi millisecondi in un Web Worker.',
    strengths: [
      'Robusto a parafrasi e sinonimi: la domanda non deve condividere parole con la risposta.',
      'Un solo vettore di dimensione fissa per passaggio: economico da salvare e da scansionare.',
    ],
    failures: [
      'Gli identificatori si sfumano: un numero di criterio come 2.4.11 porta pochissimo segnale in un embedding.',
      'L’intero passaggio viene compresso in un vettore prima di vedere la domanda.',
      'Opaco: un coseno non si può scomporre termine per termine.',
    ],
  },
  hybrid: {
    name: 'Retrieval ibrido per fusione dei ranking',
    family: 'Reciprocal Rank Fusion',
    plain:
      'Come chiedere a due amici la loro top 30 e unire le liste. Un amico giudica dalle parole, l’altro dal significato, e i loro punteggi sono su scale diverse, quindi si usano solo le posizioni. Ogni passaggio guadagna punti per quanto è in alto in ciascuna lista. Uno che entrambi gli amici mettono abbastanza in alto batte uno che solo un amico mette primo. Così i punti di forza delle due ricerche si sommano.',
    idea:
      'Si eseguono entrambi i retriever e si uniscono le liste. I punteggi non si possono unire direttamente (BM25 è una somma illimitata, il coseno sta in [−1, 1]) e ogni normalizzazione è una manopola da tarare che si rompe sul prossimo corpus. RRF legge solo i ranking: ogni lista dà a un documento un voto che cala con la posizione, e la costante k impedisce a una sola lista molto sicura di portare un documento da sola. L’accordo conta più della certezza.',
    cost: 'Una hash map su al massimo 60 candidati. Molto meno di un millisecondo.',
    strengths: [
      'Nessuna calibrazione dei punteggi, nessun addestramento, nessun parametro da adattare al corpus.',
      'Tiene gran parte del recall di BM25 sugli identificatori e gran parte di quello semantico sui concetti.',
    ],
    failures: [
      'Può solo riordinare ciò che uno dei due retriever ha già trovato.',
      'Tratta le due liste come ugualmente affidabili per ogni domanda.',
    ],
  },
  rerank: {
    name: 'Retrieve, poi rerank',
    family: 'Cross-encoder',
    plain:
      'Come una seconda lettura attenta. Le prime ricerche sfogliano in fretta tutti i 1.592 passaggi per riempire un cestino di 30. Poi un modello più lento legge la tua domanda e ciascuno dei 30 passaggi insieme, parola contro parola, e li riordina. È molto più preciso, ma troppo lento per farlo su tutto, quindi vede solo il cestino e tiene i migliori 8.',
    idea:
      'Un secondo modello, più costoso, legge la domanda e un passaggio candidato insieme, in un unico passaggio del transformer, così ogni token della domanda può fare attenzione a ogni token del passaggio. Questa lettura congiunta è molto più accurata del confronto fra due vettori indipendenti, e troppo lenta per l’intero corpus: per questo gira solo sui 30 candidati fusi e tiene i migliori 8 per il generatore.',
    cost: 'Una chiamata al modello su 30 coppie (domanda, passaggio) all’edge: la fase di retrieval più lenta.',
    strengths: [
      'Attenzione incrociata completa fra domanda e passaggio.',
      'Decide cosa legge per primo il generatore, che è ciò che misurano Success@5 e MRR.',
    ],
    failures: [
      'Il costo cresce con il numero di candidati, quindi il recall è limitato dalla prima fase.',
      'Non può recuperare un passaggio che la prima fase ha perso.',
    ],
  },
  rag: {
    name: 'Generazione aumentata dal retrieval',
    family: 'Generatore condizionato dalle prove',
    plain:
      'Come un compito a libro aperto. Invece di rispondere a memoria, il modello linguistico riceve gli 8 passaggi migliori e deve rispondere solo da quelli. Così la risposta resta su questo corpus e si può controllare, perché sappiamo esattamente cosa ha visto il modello. Il suo punto debole è che un modello può comunque dire che una pagina dice qualcosa che non dice.',
    idea:
      'Un modello linguistico risponde a partire dai passaggi trovati invece che dai suoi parametri. La risposta diventa attuale, limitata a un corpus e, in linea di principio, controllabile, perché le prove sono note. In pratica un modello cita comunque un passaggio per un’affermazione che il passaggio non contiene: per questo qui la generazione è vincolata a uno schema e seguita dalla verifica.',
    cost: 'Una chiamata di generazione, la latenza dominante di tutta la pipeline.',
    strengths: ['Risponde in prosa, limitato al corpus.', 'Può rifiutarsi quando le fonti non rispondono.'],
    failures: ['Può inventare una citazione che sembra vera.', 'Dipende da un modello di terzi che resti disponibile.'],
  },
  attribution: {
    name: 'Generazione con citazioni, verificata',
    family: 'Confronto citazione · span · entailment',
    plain:
      'Come un insegnante che corregge il compito. Per ogni frase il modello ha dovuto copiare una citazione da una pagina. L’insegnante prima cerca nella pagina quelle parole esatte, come premere Ctrl+F: se non ci sono, la citazione è inventata. Solo se ci sono, legge la pagina e decide se supporta davvero la frase. Controllare prima la cosa facile significa che quasi tutte le citazioni inventate vengono prese senza alcun modello.',
    idea:
      'Il modello non scrive note a piè di pagina, scrive affermazioni: una frase, le fonti che cita e una citazione che deve comparire verbatim in una di esse. La verifica procede dal controllo più economico: un test di sottostringa esatta, la mappatura della citazione alle posizioni nel documento sorgente, e solo alla fine un giudizio di entailment sul fatto che la prova sostenga la frase. È la proprietà di “attribuibilità a fonti identificate” resa operativa.',
    cost: 'Ricerca di sottostringa nel browser (gratis), poi una chiamata al giudice per tutto il lotto.',
    strengths: [
      'Una citazione inventata viene presa con un test di sottostringa, senza nessun modello.',
      '189 citazioni di prova dal corpus reale: 0 accettate per errore, 0 rifiutate per errore.',
    ],
    failures: [
      'Una citazione vera può comunque essere attaccata a una frase che non sostiene: per questo c’è il giudice.',
      'Il giudice è a sua volta un modello, e lo dice quando non ha potuto lavorare.',
    ],
  },
};

type IngestText = Pick<IngestStage, 'name' | 'short' | 'family' | 'plain' | 'idea' | 'how' | 'strengths' | 'tradeoffs' | 'verdict'>;

const INGEST_IT: Record<string, IngestText> = {
  normalize: {
    name: 'Normalizzazione dell’HTML',
    short: 'Normalizzazione',
    family: 'Parsing · rimozione del superfluo',
    plain:
      'Una pagina web è piena di cose che non sono il testo: menu, pulsanti, piè di pagina, esempi di codice. Questa fase le butta via e tiene le parole, in ordine, con i titoli segnati. È come fotocopiare solo il capitolo che serve, senza copertina e pubblicità. Tutto ciò che viene dopo punta a questa copia pulita per posizione dei caratteri, tipo “caratteri da 1.200 a 1.450”, quindi deve restare identica per sempre.',
    idea:
      'Ogni pagina viene analizzata e ridotta a un testo semplice canonico: un blocco per riga, i titoli tenuti come “### Titolo”, i blocchi separati da una riga vuota. Navigazione, piè di pagina, indici e esempi di codice ripetuti vengono scartati per tag, classe e id. Questo testo è l’unica fonte di verità: posizioni dei chunk, evidenziazioni e controllo delle citazioni puntano tutti qui.',
    how: [
      'Parsing con linkedom, visita del DOM, salto degli elementi superflui (nav, footer, doclinks, contenitori degli esempi GOV.UK).',
      'Blocchi presi interi (p, li, dt, dd, pre, tr), spazi compressi, livelli dei titoli conservati.',
      'Unicode NFC applicato una volta, così ogni posizione successiva si riferisce agli stessi caratteri.',
    ],
    strengths: [
      'Testo semplice che l’interfaccia mostra così com’è, quindi una citazione evidenziata sta esattamente dove è stata trovata.',
      'I titoli sopravvivono come struttura che il chunker può usare.',
      'L’HTML in cache rende le riesecuzioni offline e riproducibili.',
    ],
    tradeoffs: [
      'Le regole sono per sito: un sito nuovo ha bisogno della sua lista di esclusioni.',
      'Le tabelle diventano una riga per riga, perdendo l’allineamento delle colonne.',
      'Tutto ciò che viene disegnato da JavaScript è invisibile.',
    ],
    verdict:
      '193 documenti, 1.746.767 caratteri. Ogni chunk di ogni chunker provato riproduce esattamente la sua porzione di sorgente (100% di posizioni esatte), che è l’invariante su cui si regge la verifica.',
  },
  chunk: {
    name: 'Chunking che rispetta la struttura',
    short: 'Chunking',
    family: 'Segmentazione',
    plain:
      'Una pagina intera è troppo grande da cercare o da dare al modello, quindi viene tagliata in pezzi grandi circa come una pagina di tascabile (circa 400 token, più o meno 250 parole). Il taglio è fatto con cura: mai a metà paragrafo, preferibilmente dove inizia un nuovo titolo, e ogni pezzo ripete un po’ la fine del precedente (15%) così un’idea spezzata dal taglio non si perde. Tagliare alla cieca ogni N caratteri è più semplice, ma poi quasi tutti i pezzi finiscono a metà frase.',
    idea:
      'I documenti vengono tagliati in passaggi abbastanza piccoli da essere codificati e abbastanza specifici da essere trovati. Il chunker pubblicato non taglia mai un blocco, apre un nuovo chunk a un titolo di sezione quando quello corrente vale già la pena di essere trovato da solo, punta a 400 token con un limite rigido di 480 (dentro la finestra di 512 dell’encoder) e riporta avanti il 15% del chunk precedente.',
    how: [
      'Parsing dei blocchi con posizioni esatte; un blocco troppo grande viene diviso sui confini di frase.',
      'Chiusura a 400 token, a un titolo di sezione oltre i 250 token, o prima di superare 480.',
      'I blocchi finali vengono riportati come sovrapposizione, mai oltre un confine di sezione.',
      'Id calcolati sul contenuto, così le annotazioni sopravvivono a una nuova indicizzazione.',
    ],
    strengths: [
      'Il 75% dei chunk finisce su un confine di frase o di blocco, contro il 15% delle finestre fisse.',
      'Il 95% inizia su un confine di blocco, quindi un passaggio si legge come un’unità.',
      'Il numero di criterio in un titolo arriva a ogni chunk sotto di esso.',
    ],
    tradeoffs: [
      'Più codice, e più modi di sbagliare: tre difetti del chunker sono stati presi dai test prima del lancio.',
      'I token sono stimati (3,5 caratteri per token), non contati dal tokenizer vero.',
      'Sul solo recall, qui non ha battuto le finestre fisse.',
    ],
    verdict:
      'Dimezzare la dimensione dei chunk peggiora chiaramente: il Recall@10 ibrido scende dal 66,6% al 54,9%. La sovrapposizione non cambia nulla di misurabile. Le finestre fisse ottengono lo stesso recall (69,9%, dentro l’intervallo) ma tagliano l’85% dei chunk a metà frase, ed è quello che poi devono leggere il generatore e il controllo delle citazioni. Parte del loro recall può anche essere un effetto dell’annotazione: una finestra che attraversa più titoli combacia con più ancore.',
  },
  header: {
    name: 'Intestazione contestuale dei chunk',
    short: 'Intestazione',
    family: 'Quale testo viene indicizzato',
    plain:
      'Prima di essere indicizzato, ogni pezzo viene etichettato con i titoli sotto cui si trova, come scrivere capitolo e sezione in cima a una pagina strappata: “2.4 Navigable > 2.4.11 Focus Not Obscured > Intent”. La speranza è che un pezzo che non scrive mai “2.4.11” si possa comunque trovare con quel numero. La misura qui sotto dice che per la ricerca semantica la speranza non si è avverata del tutto.',
    idea:
      'Prima che un chunk venga codificato e indicizzato, gli si antepone il percorso dei titoli: “2.4 Navigable > 2.4.11 Focus Not Obscured > Intent”, poi il testo. L’idea è che un chunk su 2.4.11 che non scrive mai “2.4.11” si possa comunque trovare con il suo numero.',
    how: ['documentText(chunk) = headingPath.join(" > ") + "\\n" + chunk.text, sia per BM25 sia per l’encoder.'],
    strengths: ['Numeri di criterio e nomi di sezione diventano cercabili in ogni chunk sotto di loro.'],
    tradeoffs: [
      'La stessa intestazione si ripete in ogni chunk di una sezione, e per l’encoder li rende più simili fra loro.',
      'Consuma parte della finestra di 512 token con testo che non è il passaggio.',
    ],
    verdict:
      'La misura non la sostiene. Senza intestazione il Success@5 semantico è 92,5% contro 86,8% con. Per BM25 l’intestazione lascia il recall uguale e alza l’nDCG da 0,434 a 0,475. Gli intervalli si sovrappongono, quindi è una pista più che un risultato, ed è stata misurata con l’encoder locale: ricodificare senza intestazione in produzione è il controllo da fare prima di cambiare ciò che è pubblicato.',
  },
  tokenize: {
    name: 'Tokenizzazione lessicale',
    short: 'Tokenizer',
    family: 'Vocabolario di BM25',
    plain:
      'La ricerca per parole deve sapere che cosa conta come una parola. “aria-describedby” viene tenuta come una parola sola e anche come “aria” e “describedby”, così la trovano entrambi i tipi di ricerca. “2.4.11” resta sempre intera, perché divisa in 2, 4 e 11 combacerebbe con ogni regola numerata di WCAG.',
    idea:
      'BM25 trova solo ciò che il tokenizer emette. Le parole composte vengono emesse intere e divise (aria-describedby, aria, describedby; errorMessage, error, message), mentre i numeri di criterio col punto restano interi, perché 2, 4 e 11 da soli combaciano con ogni criterio.',
    how: [
      'Sequenze di lettere e cifre unite da - _ o . ; minuscolo dopo NFC.',
      'Si emette la sequenza intera, poi le sue parti kebab, snake e camelCase.',
      'Un numero col punto come 1.4.3 non viene mai diviso.',
    ],
    strengths: [
      'Una domanda con un identificatore esatto combacia con il token intero e prende un punteggio alto.',
      'Una domanda parziale arriva comunque al documento tramite le parti.',
    ],
    tradeoffs: [
      'Ogni parola composta è indicizzata più volte, e i posting si gonfiano.',
      'Nessuno stemming: “focused” e “focus” sono termini diversi.',
    ],
    verdict:
      'Contro un tokenizer alfanumerico semplice: Recall@10 56,9% contro 55,4%, MRR 0,530 contro 0,503. Un guadagno piccolo e costante, dentro gli intervalli.',
  },
  bm25: {
    name: 'Indice BM25 e parametri',
    short: 'BM25',
    family: 'Indice invertito · Okapi BM25',
    plain:
      'Qui si costruisce l’indice in fondo al libro: per ogni parola, la lista dei pezzi che la contengono e quante volte. Due manopole decidono come si comporta il punteggio. k1 decide quanto in fretta ripetere una parola smette di aiutare; b decide quanto vengono penalizzati i pezzi lunghi. Sono stati usati i valori dei manuali, e la misura mostra che tararli cambierebbe pochissimo.',
    idea:
      'Un indice invertito associa a ogni termine i chunk che lo contengono e quante volte. Al momento della domanda BM25 somma, sui termini della domanda, un peso idf per una frequenza che satura, normalizzata per la lunghezza del chunk. k1 decide quanto in fretta la ripetizione satura; b quanto viene penalizzato un chunk lungo.',
    how: [
      'Posting salvati come coppie piatte [docIndex, tf] per tenere piccolo il JSON (1,28 MB, 379 KB compresso).',
      'k1 = 1,2, b = 0,75: i valori di default dei manuali, scelti prima di qualsiasi taratura.',
    ],
    strengths: ['Costruito una volta, interrogato in 2-3 ms nel browser.', 'Ogni punto di un punteggio si può ricondurre a un termine.'],
    tradeoffs: ['Due parametri che dipendono dal corpus.', 'L’indice è il file più grande che il sito pubblica.'],
    verdict:
      'I valori di default non sono l’ottimo, ma niente li batte di più del rumore: k1 = 2 dà 58,4% contro 56,9%. Tararli sulle stesse 53 domande che la tabella riporta vorrebbe dire adattarsi al test, quindi i default restano.',
  },
  encode: {
    name: 'Codifica semantica',
    short: 'Codifica',
    family: 'bge-small-en-v1.5 · bi-encoder',
    plain:
      'Ogni pezzo viene trasformato in una lista di 384 numeri da una piccola rete neurale, come dare a ogni pezzo delle coordinate sulla mappa dei significati. Si fa una volta sola, quando il sito viene costruito. Al momento della domanda si trasforma solo la tua domanda. La domanda riceve davanti una breve istruzione, “Represent this sentence for searching relevant passages”, perché il modello è stato addestrato così a distinguere le domande dalle risposte.',
    idea:
      'Ogni chunk viene trasformato da un encoder in stile BERT da 33 milioni di parametri in un vettore di 384 dimensioni, raggruppato sul token [CLS] e normalizzato L2. Il modello è asimmetrico: le domande portano un prefisso di istruzione e i passaggi no, perché è stato addestrato così.',
    how: [
      'Passaggi: codificati una volta in fase di build tramite Workers AI, 100 per richiesta.',
      'Domande: codificate a ogni domanda all’edge, con il prefisso “Represent this sentence for searching relevant passages:”.',
    ],
    strengths: ['Abbastanza piccolo da codificare tutto il corpus in un piano gratuito.', 'Confronta significati, non solo parole.'],
    tradeoffs: ['La finestra di 512 token limita la dimensione dei chunk.', 'Un modello solo per l’inglese.', 'Una chiamata remota per ogni domanda.'],
    verdict:
      'Il prefisso vale la pena: senza, il Success@5 scende dall’86,8% al 71,7%, l’effetto singolo più grande di tutta l’ablation di ingestione. L’encoder ONNX locale usato per le righe del chunking coincide con Workers AI a un coseno medio di 0,904: lo stesso modello, non un output identico bit per bit.',
  },
  quantize: {
    name: 'Quantizzazione int8',
    short: 'int8',
    family: 'Salvataggio dei vettori',
    plain:
      'Ognuno dei 384 numeri è un decimale preciso. Salvarli invece come numeri interi da -127 a 127 rende il file quattro volte più piccolo, come arrotondare i prezzi all’euro. Si perde un pochino di precisione, e la misura mostra che la ricerca trova le stesse cose in entrambi i casi.',
    idea:
      'Ogni vettore viene scalato per la sua componente più grande e arrotondato a interi a 8 bit, con una scala float per vettore conservata per tornare indietro. Una scala per vettore e non una globale, perché le componenti di un vettore unitario a 384 dimensioni stanno ben dentro [-1, 1].',
    how: ['scala = max|vᵢ| / 127, codiceᵢ = round(vᵢ / scala).', 'Confrontato con una domanda float32: un prodotto scalare per chunk, per la sua scala.'],
    strengths: ['4 volte più piccolo: 0,6 MB contro 2,4 MB, e un file binario invece di JSON.', 'Una scansione di 1.592 vettori in pochi millisecondi.'],
    tradeoffs: ['Con perdita: i punteggi si spostano alla terza cifra decimale.', 'I pareggi nel ranking possono cambiare ordine.'],
    verdict:
      'Gratis a questa scala. Recall@10 e Success@5 identici a float32, MRR 0,594 contro 0,604, e le due versioni condividono il 99,2% della top 10.',
  },
  fusion: {
    name: 'Costante di fusione',
    short: 'Fusione k',
    family: 'Reciprocal Rank Fusion, k',
    plain:
      'Quando le due liste vengono unite, ogni posizione vale 1/(k + posizione). La costante k decide quanto conta essere primi. Con un k piccolo, il primo posto in una lista quasi vince da solo; con un k grande, tutte le posizioni valgono quasi lo stesso e decide l’accordo fra le due liste. 60 è il valore dell’articolo originale.',
    idea:
      'RRF somma 1/(k + posizione) da ogni lista. Un k piccolo lascia dominare la cima di una lista; un k grande appiattisce ogni posizione verso lo stesso voto, così decide l’accordo fra le liste.',
    how: ['k = 60, il valore dell’articolo originale, su due liste di 30.'],
    strengths: ['Nessuna taratura necessaria fra corpus diversi.'],
    tradeoffs: ['Tratta i due retriever come ugualmente affidabili per ogni domanda.'],
    verdict:
      'Piatto da k = 10 a k = 200 (Recall@10 da 65,2% a 65,8%). Solo k = 1 è peggio, con 81,1% di Success@5 contro 84,9%: lasciare che il primo posto di una sola lista vinca da solo fa perdere.',
  },
};

const METRICS_IT: Record<string, Pick<Metric, 'plain' | 'reads'> & { formula?: string }> = {
  'Recall@k': {
    plain:
      'Fra i passaggi che rispondono davvero alla domanda, quanti sono nei primi k risultati? Se tre passaggi rispondono e due sono nella top 10, il Recall@10 è 2 su 3, circa il 67%.',
    reads: 'Quanta parte di ciò che risponde è arrivata nei primi k. Il denominatore è limitato a k.',
  },
  'Success@k': {
    plain:
      'C’è almeno un passaggio giusto nei primi k? Sì vale 1, no vale 0, in media su tutte le domande. Un Success@5 del 94% vuol dire che in 94 domande su 100 c’è qualcosa di utile fra i primi cinque.',
    reads: 'Se nei primi k c’è almeno qualcosa che risponde alla domanda.',
  },
  MRR: {
    formula: 'media sulle domande di 1 / posizione del primo chunk primario',
    plain:
      'Quanto devi scendere per incontrare la prima risposta giusta? Il primo posto vale 1, il secondo 1/2, il terzo 1/3, e così via. Una media di 0,73 vuol dire che la prima risposta giusta di solito è prima o seconda.',
    reads: 'Quanto in basso sta la prima risposta giusta. 1,0 vuol dire sempre prima.',
  },
  'nDCG@10': {
    plain:
      'Come il Recall, ma tiene conto dell’ordine e dà mezzo punto ai quasi centri. Un passaggio giusto in cima guadagna di più, più in basso guadagna meno, e un passaggio del documento giusto ma della sezione sbagliata guadagna un po’.',
    reads: 'Qualità dell’ordine con rilevanza graduata: i chunk primari valgono 2, il contesto dello stesso documento 1.',
  },
};

/** The theory data in the reader's language. Numbers, formulas and references come from theory.ts either way. */
export function localized(lang: Lang) {
  if (lang === 'en') return { paradigms: PARADIGMS, ingest: INGEST, metrics: METRICS };
  return {
    paradigms: PARADIGMS.map((p) => ({ ...p, ...PARADIGMS_IT[p.id] })),
    ingest: INGEST.map((s) => ({ ...s, ...INGEST_IT[s.id] })),
    metrics: METRICS.map((m) => ({ ...m, ...METRICS_IT[m.name] })),
  };
}
