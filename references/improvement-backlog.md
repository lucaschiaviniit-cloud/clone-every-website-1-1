# Miglioramenti da valutare per clone-site

Note storiche dal 2026-10-13; lo stato operativo aggiornato è indicato qui sotto. Le proposte storiche non provano che una funzione sia ancora assente: verificare il codice e la validazione corrente.

## Stato operativo — 2026-10-18

- Scelta iniziale esplicita fra asset originali e segnaposto foto/video. L'agente attende la scelta, salvo preferenza già espressa nella sessione; il wrapper richiede un'opzione/config espliciti anche in preparazione offline.
- Preflight locale di spazio, bind ed esecuzione reale del browser prima della cattura. Ricevuta con fase/categoria del blocco; nessun retry automatico. La riserva minima non stima lo spazio finale.
- Controllo breve del replay appena costruito, prima dell'indice: viewport configurate, primo gruppo di interazioni con prerequisiti, immagini/font, errori, risorse locali e probe wheel diagnostico. Ricevuta legata al corpus/build; non sostituisce confronto completo o approvazione.
- Cache limitata allo stesso contesto per risposte image/media esplicitamente fresche e riutilizzabili; identità URL/query/intestazioni/range. Bypass di cookie/auth, risposte private/non cacheabili, compressione e range incompleti. Provenienza di riuso conservata nei record/HAR; contatori distinti dal traffico effettivo. Disattivabile con `captureMediaCache:false`.
- Scrittura dei corpi deduplicata per hash nel recorder; indice dei nodi per calcolare le differenze conservando la semantica del primo match.
- Dossier e mappa asset esistenti diventano la base dei contratti di ricostruzione descritti nella guida. `--component` usa le mappature d'impatto revisionate; `--mode full` esplicito mantiene il confronto completo.

Già disponibili prima di questo intervento: wheel/swipe/resize, visibilità con opacity/antenati, inventario e copertura, dossier su richiesta, risoluzione HLS, verifiche mirate, identità delle prove e consegna da pacchetto fresco. Le liste seguenti conservano il ragionamento storico, non sono una lista di funzioni tutte da implementare.

Restano da misurare l'accelerazione su siti reali e l'efficacia dei contratti nella ricostruzione. L'eventuale prefetch di route opzionali non viene soppresso con un'euristica generale: serve una classificazione dimostrata prima di cambiarne il trattamento.

Leggere quando si lavora al miglioramento della skill. Questo documento conserva lezioni generalizzate dall'uso: non contiene soluzioni, asset, selettori o risultati di uno specifico sito. Non serve come contesto per clonare un nuovo target.

## Valutazione del pacchetto

Al momento dell'analisi, i 60 file del pacchetto estratto corrispondevano byte per byte a quelli nello ZIP fornito; nessun file mancava. Dipendenze npm e browser richiedono l'installazione prevista. La completezza del pacchetto non dimostra la qualità di una ricostruzione.

Le istruzioni già richiedono controlli su interazioni, scroll, media, animazioni e indipendenza. Il problema principale è trasformare tali requisiti in verifiche eseguibili e in condizioni concrete per dichiarare il lavoro completato. Anche l'esecuzione dell'agente deve rispettarli: una lacuna nella verifica non prova che mancasse la relativa istruzione.

## Priorità di qualità

1. **Input reali per lo scroll.** In `tools/lab/src/browser/scenarios.ts` lo scenario scroll usa `window.scrollTo()`. Conservare questo strumento per raggiungere stati ripetibili, aggiungendo wheel, swipe e tastiera quando pertinenti. Verificare avanzamento e ritorno, inclusi gli stati dopo la chiusura degli overlay. Un overlay può bloccare l'input senza impedire lo scroll programmatico.

2. **Media effettivamente visibili.** In `tools/lab/src/extractors/snapshot.ts` il campo `visible` considera display, visibility e dimensioni, ma non opacity. Distinguere risorsa presente, decodificata, attivata e resa visibile. Considerare gli antenati e distinguere immagini DOM intenzionalmente nascoste perché sostituite da WebGL. Integrare controlli visivi sul canvas; per i video verificare decodifica e avanzamento quando previsti. Nessun singolo attributo DOM prova che un contenuto sia stato disegnato correttamente.

3. **Copertura dell'intera pagina.** Generare durante l'ispezione un inventario delle sezioni e dei meccanismi osservati. Per ciascuno registrare viewport pertinente, stato iniziale, attivazione, comportamento successivo e confronto con il riferimento. Includere caroselli fino all'ultima slide, loghi, contenuti lazy, hover, reverse scroll e resize quando presenti. Distinguere passato, fallito, saltato e non verificato.

4. **Risorse relative e streaming.** Verificare il trattamento delle playlist HLS e degli altri documenti con riferimenti relativi. Body identici provenienti da URL diversi possono risolvere riferimenti verso risorse diverse. Separare deduplicazione dei byte, identità dell'URL e identità dei file adattati; mantenere provenienza e controllare ricorsivamente le dipendenze locali.

5. **Chiusura verificabile.** Progettare un comando di verifica della ricostruzione, distinto dai controlli di approvazione del replay. Collegare risultati, configurazione e copertura all'identità della build effettivamente consegnata. Impedire una dichiarazione automatica di completamento se falliscono controlli obbligatori o mancano prove richieste. Non riciclare risultati di build precedenti come prove correnti. Conservare fallimenti e limiti.

## Velocizzare senza ridurre la qualità

- **Inventario prima della ricostruzione.** Una ricognizione completa ma mirata deve identificare sezioni, media, overlay e meccanismi. Produce il piano di lavoro e gli scenari, riducendo il rischio di scoprire interi sottosistemi a fine progetto.
- **Automatizzare le operazioni ripetute.** Preferire helper riutilizzabili per mappatura degli asset, dipendenze HLS, readiness dei media, screenshot per sezione, verifica degli input e generazione dei report. Automatizzare la raccolta delle prove; mantenere l'analisi visiva dove la macchina non basta.
- **Ciclo breve, verifica finale completa.** Eseguire presto controlli rapidi ad alto valore: scroll reale, un media per meccanismo, rendering WebGL, scorrimento dei caroselli, apertura/chiusura degli overlay e resize, quando presenti. Dopo modifiche circoscritte rieseguire i controlli interessati e quelli dei sistemi condivisi coinvolti. Fare la verifica completa sulla build finale, ripetendola se emergono regressioni o cambiamenti trasversali.
- **Riutilizzo controllato.** Riutilizzare dipendenze, browser installati e risorse immutabili verificate. Evitare catture, download e copie fisiche duplicati. Cache dei risultati solo con identità degli input e invalidazione corretta; mai riutilizzare una soluzione di un altro target come evidenza. Non sacrificare l'indipendenza del prodotto consegnato per risparmiare spazio.
- **Contesto selettivo.** Cercare simboli e moduli pertinenti, estrarre piccoli frammenti con provenienza, mantenere inventari e handoff sintetici. Non caricare interi bundle, corpus, SVG o risultati già riassunti.
- **Parallelismo con confini chiari.** Quando previsto e disponibile, delegare componenti o analisi con file separati. Integrare le modifiche condivise in sequenza. Limitare browser concorrenti che competono per CPU/GPU: un confronto alterato dal carico causa diagnosi e ripetizioni inutili.
- **Misurare prima di promettere.** Registrare tempi per acquisizione, analisi, implementazione, verifica e correzione; distinguere tempo macchina e lavoro dell'agente. Confrontare anche difetti sfuggiti e copertura. Queste proposte non hanno ancora una misura affidabile del risparmio ottenibile.

Il beneficio principale atteso è ridurre diagnosi ripetute e correzioni tardive. Dare priorità all'inventario iniziale, all'automazione delle verifiche ripetitive e alla verifica precoce dei meccanismi delicati. Valutare il miglioramento sul tempo necessario a ottenere un risultato verificato, insieme a copertura e difetti sfuggiti; un tempo inferiore ottenuto omettendo controlli non dimostra un processo migliore.

## Ordine proposto per il prossimo intervento

1. Input reali e controlli dei media, con fixture che riproducano overlay bloccanti, immagini trasparenti e fallback WebGL.
2. Inventario delle sezioni e copertura esplicita, usati dai report e dalla verifica finale della build.
3. Test di risoluzione delle risorse relative e delle playlist con body identici ma URL di origine diversi.
4. Helper per report, verifiche mirate e cache; misurare il risparmio senza diminuire copertura o aumentare difetti sfuggiti.

Questa lista è una proposta da implementare e validare. Non modifica i vincoli di approvazione, pubblicazione o accesso della skill e non certifica che i controlli descritti esistano già.

## Aggiornamento 2026-10-17 — ridurre attese e rilavorazioni

**Stato: considerazioni da implementare successivamente.** Nessuna modifica operativa a istruzioni, engine o gate viene introdotta con questi appunti. Le osservazioni specifiche dei progetti e i loro tempi restano fuori dalla skill; qui si conservano soltanto proposte generalizzate. Coordinare eventuali modifiche condivise con il progetto Design Fusion, distribuito separatamente.

| Priorità | Proposta | Problema da ridurre | Criterio di verifica futuro |
| --- | --- | --- | --- |
| P0 | Preflight operativo all'inizio: browser avviabile, bind locale, spazio per corpus/build/estrazione e strumenti già installati. Riutilizzare controlli disponibili. | Scoprire i limiti dell'ambiente dopo la ricostruzione o durante il confezionamento. | I blocchi sono classificati prima delle operazioni che ne dipendono; il report distingue permessi, spazio e dipendenze. |
| P0 | Conservare la firma del blocco e lo stato dell'ambiente. Un diniego di permessi deterministico non autorizza tentativi equivalenti su altre porte o tramite altri launcher. Riprovare solo con una causa concreta cambiata. | Ripetizioni prive di nuove informazioni e richieste reiterate all'utente. | Stesso errore/stessa configurazione non produce altri tentativi; liberare spazio non viene trattato come soluzione a un diniego di permessi. |
| P0 | Rendere verificabile la distinzione replay / sorgenti ricostruiti / adattamento, con inventario dei componenti richiesti e motion associato. | Assemblare troppo presto o chiamare componenti una semplice riproduzione del bundle. | Ogni componente richiesto ha file sorgenti, meccanismi e stato delle prove; nessuna sostituzione silenziosa con una versione statica. Restano necessari i consensi previsti dalla skill. |
| P0 | Registrare eventi di fase, tool, attese, errori e rilavorazioni fin dall'avvio. | Non poter attribuire i ritardi a cause verificabili. | Report per acquisizione, analisi, sorgenti, verifica e confezionamento; tempo tool distinto da tempo trascorso e attese. Il lavoro attivo dell'agente resta sconosciuto se l'ambiente non lo misura. |
| P1 | Verificare l'identità semantica delle risorse oltre all'hash: URL completa, query, ruolo e descrittore responsive. | File integri ma immagine o variante sbagliata, con correzioni tardive. | Fixture con stesso pathname e query diverse non collidono; hash, origine e variante sono controllati separatamente. |
| P1 | Verificare presto i contratti dei testi animati: righe esplicite, markup inline, nodi live dopo le mutazioni e resize. | Reveal che perdono a-capo o formattazione durante la conversione. | Fixture con testo semplice/rich text e cambi viewport conservano contenuto e struttura attesi; verifica browser quando disponibile. |
| P1 | Consolidare launcher, standalone, raccolta prove e confezionamento in helper riutilizzabili, evitando tooling ad hoc per ogni progetto. | Impiegare una parte eccessiva del lavoro a costruire strumenti di supporto. | Un nuovo run configura gli helper esistenti; font/maschere locali e JavaScript inline sono verificati senza riscrivere i generatori. |
| P1 | Riutilizzare solo risultati con input e ambito invariati; controlli mirati dopo modifiche locali, verifica completa al termine. Pianificare spazio e copie temporanee. | Build/capture/installazioni/coperture ripetute senza una modifica che le giustifichi. | Cache invalidata per hash e dipendenze; le verifiche dei sistemi condivisi si ampliano quando necessario. Consegna indipendente sempre ricontrollata. |
| P1 | Richiedere ricevuta di esecuzione: output atteso presente, identità e ambito corretti, non soltanto exit code0. | Comandi che terminano senza aver eseguito il lavoro, anche con entrypoint installati tramite symlink. | Test di invocazione diretta/symlink e controllo degli artefatti distinguono successo reale da no-op. |

### Sequenza di implementazione da valutare

1. Preflight ambiente, classificazione dei blocchi e registrazione dei tempi.
2. Inventario degli artefatti/componenti e verifica dell'ordine di lavoro già richiesto.
3. Helper condivisi e ricevute di esecuzione.
4. Controlli mirati su identità asset e contratti del testo/motion, poi cache e verifiche incrementali.

Misurare sui prossimi run il tempo fino a un risultato verificato, il numero di tentativi ripetuti, le sezioni rifatte e i difetti sfuggiti. Non fissare percentuali di risparmio senza dati. Un browser non disponibile resta una verifica non eseguita: nessun fallback statico certifica fedeltà o finalizza la consegna.
