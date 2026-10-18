# Media segnaposto per adattare un sito

Usare quando l'utente vuole riutilizzare struttura e interazioni sostituendo foto e video.

```sh
node scripts/clone.mjs https://example.test/ --media placeholders --out /absolute/fresh-run
node scripts/clone.mjs https://example.test/ --media original --out /absolute/other-run
```

All’inizio di una nuova sessione Clone l’agente chiede se l’utente vuole una copia fedele con gli asset originali oppure segnaposto al posto di foto e video per ridurre i download e potenzialmente il tempo. Attendere la risposta prima di aprire il target. Una scelta già espressa nella richiesta/sessione non va richiesta di nuovo. Il wrapper richiede `--media original|placeholders` oppure `mediaMode` esplicito nel config, anche con `--prepare-only`: nessun default implicito. Il config e lo stato registrano la scelta. Il motore diretto mantiene `original` come default per compatibilità con gli altri chiamanti.

## Contratto

- Le richieste di foto raster vengono soddisfatte localmente con un SVG neutro prima di qualsiasi richiesta upstream. Vale per `img`, `picture/srcset`, sfondi CSS e fetch di immagini riconoscibili dall'estensione. URL senza estensione sono riconosciuti se il browser li classifica come immagini.
- I video a file vengono sostituiti da **un solo MP4 procedurale**, incluso nel pacchetto: 8 secondi, 720×1280, H.264, senza audio, creato da colori e forme geometriche. Hash e dimensione sono registrati in `tools/lab/assets/media/provenance.json`; il generatore è `scripts/generate-placeholder-video.mjs`. Non si cercano stock e non si genera un nuovo video per ogni sito.
- Si mantengono elementi, attributi, CSS, codice applicativo e collegamenti agli URL del sito. Il browser carica risposte locali valide: `load`, `decode`, `loadedmetadata`, `play`, `pause`, tempo di riproduzione e richieste range funzionano realmente. Non si falsificano gli eventi o le proprietà dei media.
- SVG, ICO, font, audio e risorse riconoscibili come logo/icon/favicon rimangono originali. Per eccezioni non riconoscibili usare `preserveUrls`.
- La sostituzione passa dopo i normali controlli su host, navigazione e GET: non abilita tracker, form, API estranee o chiamate AI.
- Nel corpus e nella mappa degli asset, `substitution.originalBodyDownloaded:false` distingue i byte locali dalle risposte originali. I record HAR sintetici sono marcati esplicitamente. Uno stato 200 sintetico non è una risposta misurata dal sito originale.

## Geometria e comportamento

Preservare CSS e attributi dimensionali. Per le immagini si usano prima le dimensioni configurate, poi `width`/`height` dichiarati nel markup; senza questi dati il segnaposto è 640×360 e il limite viene registrato. Per immagini la cui geometria dipende esclusivamente dalle dimensioni intrinseche originali, specificare il rapporto corretto: non è ricavabile con certezza senza scaricare o ispezionare il file. Il clip video condiviso ha il proprio rapporto intrinseco; verificare che il contenitore/CSS mantenga quello del layout originale, adattandolo se necessario.

```json
{
  "mediaMode": "placeholders",
  "mediaPlaceholders": {
    "preserveUrls": ["https://example.test/essential-logo.png"],
    "imageDimensions": {
      "https://example.test/photo.jpg": {"width": 1600, "height": 1000}
    }
  }
}
```

Conservare e verificare menu, FAQ, hover, slider, scroll, resize, attivazione video e uso come texture canvas quando presenti. I controlli dei media rimangono utili: verificano i segnaposto realmente caricati. La durata di 8 secondi, l'assenza di audio e la sostituzione dei fotogrammi escludono equivalenza di montaggio, sincronizzazione, sottotitoli e timeline basate sul contenuto originale. Per tali meccanismi serve un adattamento esplicito; non dichiarare comportamento universale equivalente.

Streaming HLS/DASH e segmenti non hanno ancora un adattatore segnaposto: vengono bloccati senza scaricarli e l'acquisizione termina con errore esplicito, anziché risultare completa con player rotto. Un'eccezione `preserveUrls` scarica esplicitamente le risorse indicate; non costituisce modalità senza media per quelle risorse. Foto/video incorporati direttamente in HTML/CSS come data URL, blob creati dall'applicazione e media via URL API indistinguibili da dati non sono riscritti automaticamente.

## Verifica e misurazione

Usare un nuovo run per la modalità scelta e approvare quel baseline. Le schermate con segnaposto non dimostrano fedeltà fotografica al sito originale; il confronto successivo dei componenti usa il replay approvato con gli stessi segnaposto.

I test verificano zero richieste ai media originali, dimensioni dichiarate e responsive, riproduzione/pausa reali, menu, replay offline e byte range. I contatori includono numero delle risposte sostitutive e corpi unici; non si stima il volume originale evitato senza averlo misurato. Il risparmio di tempo e token richiede un confronto separato: la riduzione dei download non prova una percentuale di accelerazione dell'intero processo.
