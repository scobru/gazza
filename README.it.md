# gazza

[English](README.md) · **Italiano**

*La gazza ruba le cose luccicanti e le nasconde dove nessuno guarda.*

Archivia file dentro un video, così una piattaforma che ospita video ospita i
tuoi byte. Il file diventa una griglia di celle colorate; la griglia sopravvive
alla ricompressione della piattaforma; il video torna indietro e il file ne esce
byte per byte.

```bash
gazza encode documento.pdf carrier.mp4 --encrypt
# carichi carrier.mp4 a mano, poi:
gazza decode https://youtu.be/VIDEO_ID
```

Verificato dall'inizio alla fine su YouTube, Instagram, WhatsApp e Telegram. I
numeri qui sotto sono misure, non stime, e dove qualcosa non è stato verificato
questo file lo dice.

## Quanto costa

| profilo | fotogramma | per fotogramma | portata | note |
| --- | --- | --- | --- | --- |
| `youtube` | 1920x1080 | 1114 B | ~16 KB per secondo di video | celle da 16 px, dimensionate per AV1 |
| `instagram` | 1080x1920 | 2031 B | ~30 KB per secondo di video | verticale, 90 s per post |
| `telegram` | 1920x1080 | 2011 B | ~29 KB per secondo di video | manda come video, non come documento |
| `whatsapp` | 1920x1080 | 2011 B | ~29 KB per secondo di video | come video; limiti di dimensione stretti |
| `googlephotos` | 1920x1080 | 1114 B | ~16 KB per secondo di video | risparmio spazio; scarica il file, i link non funzionano |

YouTube costa di più per byte perché è l'unico che ricomprime in AV1, e l'AV1
richiede celle più grandi. Gli altri tengono un bitrate generoso per la
risoluzione a cui riducono, quindi 12 px bastano.

Un file da 400 KB diventa 37 secondi di 1080p e circa 78 MB di mp4. È archivio
per documenti e piccoli pacchetti, non per una libreria multimediale.

## Come sta in piedi

Una piattaforma fa quattro cose a un caricamento, e ogni livello risponde a una.

| cosa fa la piattaforma | cosa risponde |
| --- | --- |
| ricomprime con perdita, sfoca i bordi, sposta i colori | celle grandi, quattro colori ben separati, striscia di calibrazione |
| corrompe pixel dentro un fotogramma | Hamming(7,4) per nibble, con interleaving sul fotogramma |
| scarta, fonde o ricampiona i fotogrammi | ogni chunk scritto due volte |
| perde comunque interi chunk | parità Reed-Solomon fra chunk |

**Striscia di calibrazione.** La prima e l'ultima riga di celle percorrono tutti
i colori della palette. Il decoder misura la palette *come è sopravvissuta* alla
ricompressione e classifica contro quella, non contro i colori nominali.

**Interleaving.** Una cella letta male corrompe tanti bit consecutivi quanti ne
porta, e Hamming(7,4) ne ripara uno solo per simbolo. Il bit *j* di ogni simbolo
viene scritto prima del bit *j+1* di qualsiasi altro, così un blocco di
compressione rovinato diventa un bit riparabile per simbolo invece di un simbolo
morto.

**Parità.** I chunk di dati sono raggruppati a 16 con 4 chunk di parità ciascuno,
quindi 4 su ogni 20 possono sparire del tutto. Senza, un solo chunk perso
perdeva il file. La matrice generatrice è di Cauchy, non di Vandermonde: la
decodifica inverte le righe che sono sopravvissute, e solo una matrice di Cauchy
è invertibile in *ogni* sottomatrice quadrata. Una di Vandermonde fallisce su
certi schemi di perdita con la parità lì presente.

## Misurato su piattaforme vere

| piattaforma | tornato come | correzioni | chunk persi | esito |
| --- | --- | --- | --- | --- |
| Telegram | 1280x720 h264, 5.8 Mbps | 0.0 per fotogramma | nessuno | identico |
| WhatsApp | 848x478 h264, 7.0 Mbps | 0.4 per fotogramma | nessuno | identico |
| YouTube | 1920x1080 av1, 4.0 Mbps | 6.8 per fotogramma | 9 su 280 | fallito, con celle da 12 px |
| YouTube | 1920x1080 h264, 3.2 Mbps | 0.0 per fotogramma | nessuno | identico, con celle da 16 px |
| YouTube | 1920x1080 h264, 2.1 Mbps | 0.0 per fotogramma | nessuno | identico, payload cifrato |
| Instagram | 720x1280 h264, 6.9 Mbps | 0.0 per fotogramma | nessuno | identico |
| Google Photos | risparmio spazio | non misurate | nessuno | identico, con celle da 16 px |

WhatsApp ha ridotto di 2.26 volte, ben oltre la dimensione di cella che i test
locali indicavano come necessaria, e il file è tornato lo stesso. Il
ridimensionamento è lineare, quindi la media di una cella sopravvive al
rimpicciolimento finché resta sopra i tre pixel circa: conta la dimensione della
cella al momento della codifica, non nel file che torna indietro.

YouTube è quello duro, e ha rotto il primo profilo. Un caricamento vero può
tornare in **AV1 a 4 Mbps**, e l'AV1 distrugge molto più del VP9 a parità di
bitrate — che è quello che le prime prove simulate stavano misurando. Con celle
da 12 px, 22 fotogrammi su 560 erano illeggibili, 9 chunk su 280 spariti, un
gruppo di parità aveva perso sia i dati sia la parità che doveva coprirli, e il
file non è tornato.

Rimisurato contro AV1 a 4 Mbps:

| celle | per fotogramma | correzioni | illeggibili |
| --- | --- | --- | --- |
| 12 px | 2011 B | 4.2 per fotogramma | 4 su 92 |
| 14 px | 1467 B | 2.8 per fotogramma | nessuno |
| 16 px | 1114 B | 0.5 per fotogramma | 4 su 172 |

Da qui i 16 px su YouTube, al 45% della capacità. Un secondo caricamento vero a
16 px è tornato byte per byte: 1104 fotogrammi, tutti leggibili, nessuna
correzione, parità mai servita. Un terzo, cifrato e servito a 2.1 Mbps, ha fatto
lo stesso — il bitrate più basso che YouTube abbia restituito finora, e la
correzione d'errore non ha comunque avuto niente da fare.

**Un codec non è un bitrate.** Misurare contro quello sbagliato ha gonfiato il
profilo di oltre il doppio.

Instagram limita un Reel a 720x1280, quindi un carrier 1080x1920 torna ridotto
di 1.5 volte — e decodifica lo stesso senza una singola correzione. Il primo
tentativo era fallito del tutto, ma la piattaforma non c'entrava: il downloader
chiedeva uno stream non più alto di 1080 px, che sembra ragionevole finché il
carrier non è verticale. La versione buona di Instagram è alta 1280, quindi il
limite la scartava e prendeva quella da 360x640, riducendo le celle da 12 px a 4.
Rileggendo lo stesso Reel senza quel limite il file è tornato byte per byte.

## Interfaccia web locale

Un frontend nel browser, se la riga di comando non fa per te. Sotto c'è la
stessa pipeline: stessi profili, stessa parità, stesso ffmpeg.

```bash
npm run web:dev      # http://127.0.0.1:4321
```

**Encode.** Scegli un file, la piattaforma, eventualmente una password, e ti dice
quanto durerà il video, quanto peserà all'incirca e quanti chunk servono *prima*
di codificare qualsiasi cosa. Se il risultato supera quello che una piattaforma
accetta per video, lo dice e propone di spezzarlo invece di lasciartelo scoprire
dopo il caricamento.

**Decode.** Incolli i link, uno per riga, oppure trascini i video — anche più
parti insieme. Se il primo tentativo non trova la griglia, riprova cercandola
dentro il fotogramma: copre una registrazione dello schermo o una piattaforma
che ha aggiunto bande nere. Un carrier cifrato chiede la password.

Il server ascolta solo su loopback: legge il contenuto dei file e lancia ffmpeg,
non ha motivo di essere raggiungibile dalla rete.

Entrambi i pannelli accettano una password. Viaggia in un header e non nella
query string, perché un URL resta nella cronologia del browser e finisce in
qualsiasi log lungo il percorso. In codifica la chiede due volte: un refuso non
è correggibile dopo.

## Comandi

```bash
gazza encode  <file> <out.mp4>   [--platform ...] [--encrypt] [--split 60] [--crf 14]
gazza decode  <video|url>...     [--out file] [--platform ...] [--crop auto|w:h:x:y]
gazza inspect <video|url>        [--platform ...] [--crop auto|w:h:x:y]
```

Codifica e decodifica devono usare lo stesso profilo di piattaforma (default:
`youtube`). Il nome originale del file e il tipo MIME viaggiano dentro i chunk,
quindi `decode` senza percorso di uscita ripristina il nome.

`decode` e `inspect` accettano URL e li scaricano con `yt-dlp`, prendendo lo
stream a risoluzione più alta e poi a bitrate più alto. Aggiungi
`--cookies-from-browser firefox` quando YouTube rifiuta una richiesta anonima,
cosa che fa per i video non elencati e sotto limitazione di frequenza.
`--stream <id>` forza un formato specifico.

### Cifratura

`--encrypt` sigilla il file con AES-256-GCM prima che diventi chunk. La password
non compare mai come argomento, dove la cronologia della shell e la lista dei
processi ne conserverebbero una copia: viene chiesta sul terminale senza eco,
oppure letta da `GAZZA_PASSWORD` per gli script.

Il nome del file e il tipo MIME viaggiano *dentro* il cifrato e i chunk portano
`sealed.dbfa` al loro posto, quindi un carrier su una piattaforma pubblica non
rivela né il contenuto né come si chiamava. La chiave è PBKDF2-HMAC-SHA256 su
600.000 giri: un carrier può essere scaricato da chiunque e attaccato offline
per tutto il tempo che si vuole, quindi l'unica difesa è rendere caro ogni
tentativo. GCM autentica, quindi password sbagliata e byte manomessi falliscono
allo stesso modo e non viene mai scritto niente di parziale.

Non c'è recupero. Persa la password, perso il file.

### Divisione in più video

`--split <secondi>` taglia il carrier in `carrier-001.mp4`, `carrier-002.mp4` e
così via, e il limite di 90 secondi di Instagram si divide da solo.

Nessun manifest, e non serve: ogni header di chunk porta già l'hash del file, il
proprio indice e il totale, quindi i pezzi si identificano da soli. Ridalli in
qualsiasi ordine, anche duplicati, e si rimettono insieme.

```bash
gazza encode archivio.zip carrier.mp4 --split 60
gazza decode https://youtu.be/AAA https://youtu.be/BBB --out archivio.zip
```

I chunk di un file diverso vengono rifiutati subito invece che ignorati in
silenzio: condividono gli stessi indici, quindi trattarli da duplicati farebbe
decodificare il file sbagliato senza dire niente.

### Diagnosticare un fallimento

`inspect` legge un video senza ricostruire niente e dice quanto vicino al bordo
è passato:

```
frames    168 read, 168 readable
hamming   1.9 corrections/frame average, 11 worst
chunks    80/84 data, 24 parity
missing   0, 1, 2, 3
verdict   file is recoverable
```

- Una **media di correzioni alta** significa che le celle erano troppo piccole
  per quella piattaforma: alza `cellSize`.
- **Chunk in `missing`** significa che sono spariti fotogrammi: alza
  `repeatFrames` o `parityPerGroup`. L'errore dice quale delle due cose è finita
  in un gruppo di parità.
- **`looks untouched`** sulla riga della sorgente significa che il bitrate è
  ancora vicino a quello del nostro encoder, quindi nessuna piattaforma ha mai
  ricompresso il file — un giro che non dimostra niente.
- **Niente decodificato affatto** di solito significa che la griglia non riempie
  il fotogramma. `--crop auto` la trova dentro una registrazione dello schermo,
  bande nere, o un player non a tutto schermo.

## Caricare

Google Photos è l'unico host dove l'involucro video ripaga il proprio costo: un
file cifrato lì non lo puoi archiviare affatto, un video sì. Ovunque i file
vengano conservati com'è — un drive condiviso, uno storage a oggetti —
l'involucro è puro spreco, circa 190 volte, e cifrare il file da solo è
strettamente meglio.

Caricare tocca a te, di proposito. Lo strumento scrive un mp4 e ne rilegge uno;
quello che succede in mezzo è una decisione su quale account, quale piattaforma
e quale rischio, e niente di tutto ciò appartiene a una libreria. Automatizzarlo
significherebbe anche pubblicare a ritmo regolare, che è il comportamento che fa
chiudere un account.

Carica il file com'è. Se la piattaforma offre ritaglio, filtri, musica o
stabilizzazione, salta tutto: un ritaglio sposta la griglia e nessuna correzione
d'errore la riporta indietro.

Aspetta che la versione a piena risoluzione finisca l'elaborazione prima di
rileggerla. Subito dopo un caricamento esiste solo una versione ridotta, e le
celle non le sopravvivono — `yt-dlp -F <url>` mostra cosa è pronto.

Su Instagram pubblica un **Reel**, non un video nel feed: il feed ritaglia a 4:5
mentre i Reel mantengono il 9:16 pieno. Pubblica da un account pubblico, o per
rileggerlo servono i cookie.

Su Telegram e WhatsApp manda il carrier **come video, dalla galleria** — non come
documento. Un documento viaggia intatto, il che sembra meglio e non lo è: niente
lo ricomprime, quindi niente di quel carrier viene messo alla prova, e WhatsApp
impone comunque limiti stretti sui video. Lì usa `--split`.

## Farla girare in un container

`ffmpeg`, `ffprobe` e `yt-dlp` sono tutti dentro l'immagine, quindi sull'host non
va installato niente.

```bash
docker compose up -d --build    # http://127.0.0.1:4321
```

Per [CapRover](https://caprover.com), il `captain-definition` nella radice punta
allo stesso Dockerfile:

```bash
caprover deploy
```

### Farla girare dove la raggiunge chiunque

`.env.example` elenca tutte le impostazioni con il loro scopo, e i default sono
già la postura sicura: copia le righe che ti servono, non tutte.

Un'istanza pubblica è un codificatore video messo in mano a sconosciuti, quindi
rifiuta più di quanto accetti. Tutte variabili d'ambiente:

| | default | cosa impedisce |
| --- | --- | --- |
| `GAZZA_MAX_FILE` | 8 MB | un file letto in memoria senza tetto |
| `GAZZA_MAX_VIDEO` | 256 MB | lo stesso dal lato decodifica, scritto su disco |
| `GAZZA_MAX_QUEUE` | 4 | richieste che si accumulano una sull'altra |
| `GAZZA_JOB_TTL_MS` | 30 min | carrier mai ritirati che riempiono il disco |
| `GAZZA_ALLOW_URLS` | spento | **quella che conta** — vedi sotto |
| `GAZZA_URL_HOSTS` | youtube, youtu.be, instagram | dove può puntare un link |
| `GAZZA_TOKEN` | non impostato | che la usi chiunque |

Una sola codifica per volta: ffmpeg è legato alla CPU e farne girare diverse non
le finisce prima, esaurisce solo i core.

**Lo scaricamento da link è spento di default**, ma accenderlo è una decisione
sulla banda che regali, non una scommessa. Un link significa che questo server
fa una richiesta scelta da chi chiama, e due cose la limitano: l'host dev'essere
fra quelli di `GAZZA_URL_HOSTS`, con confronto sul punto così che
`evil-youtube.com` non passi per `youtube.com`, e lo scaricamento è tagliato a
`GAZZA_MAX_VIDEO`, perché altrimenti un link a una registrazione di dieci ore
riempirebbe il disco. Né la rete privata né spazio illimitato sono raggiungibili
da lì.

**Leggi qui prima di esporla.** Il server ascolta su loopback quando gira su
una macchina normale e su tutte le interfacce dentro un container, cosa che
riconosce da solo; `HOST` ha comunque la precedenza. Il compose la pubblica solo
su `127.0.0.1`. È voluto: chi
raggiunge gazza può spendere la tua CPU in ffmpeg e leggere qualsiasi cosa
decodifichi. Mettici davanti un'autenticazione — quella base di CapRover basta —
prima di farla raggiungere da altri. Se la esponi oltre il loopback te lo scrive
lei stessa nei log.

I carrier stanno in `/tmp` e vengono cancellati una volta scaricati, quindi non
c'è nessun volume da montare e niente da salvare. Il compose lo monta come
tmpfs da 2 GB: un file da 400 KB diventa 78 MB di mp4 che esistono solo fino al
download, ed è meglio tenerli fuori dal disco.

## Perché non serverless

Vercel e simili non possono ospitarla. I corpi di richiesta e risposta sono
limitati attorno ai 4.5 MB mentre gazza sposta decine di megabyte per
operazione; un file da 400 KB richiede circa 40 secondi di x264, contro un
limite di 60 secondi per funzione; e ffmpeg, ffprobe e yt-dlp lì non ci sono
proprio. Un container è la forma giusta.

## Requisiti

Node 22 o superiore, e due programmi che non sono pacchetti npm: **ffmpeg**
(insieme a ffprobe, che arriva con lui) per tutto, e **yt-dlp** per leggere da
un URL. `npm install` non li porta — gazza non ha nessuna dipendenza a runtime,
li lancia e basta.

```bash
# Debian, Ubuntu
sudo apt install ffmpeg && sudo apt install yt-dlp     # oppure: pipx install yt-dlp

# Alpine
apk add ffmpeg yt-dlp

# macOS
brew install ffmpeg yt-dlp

# Windows
winget install Gyan.FFmpeg yt-dlp.yt-dlp
```

Senza ffmpeg non si codifica né si decodifica niente. Senza yt-dlp smettono di
funzionare solo i link, i file no. L'interfaccia web dice all'avvio quali ha
trovato, e lo scrive sulla pagina invece di aspettare che tu abbia già caricato
qualcosa. L'immagine del container li porta tutti e tre, quindi lì non serve
niente di tutto questo.

## Per iniziare

```bash
git clone https://github.com/scobru/gazza.git
cd gazza
npm install && npm run build && npm test
```

Poi la riga di comando:

```bash
node packages/cli/dist/index.js encode documento.pdf carrier.mp4 --encrypt
```

oppure la pagina:

```bash
npm run web:dev      # http://127.0.0.1:4321
```

## Struttura

```
packages/core/  chunk.ts     formato binario dei chunk, divisione e ricomposizione
                frame.ts     griglia ottica, calibrazione, interleaving
                profiles.ts  profili di piattaforma misurati
                groups.ts    Reed-Solomon fra chunk
                box.ts       cifratura AES-256-GCM
                crc32, hamming, reedsolomon, palette
packages/cli/   pipeline.ts  ffmpeg in streaming, ritaglio automatico, ispezione
                index.ts     la riga di comando
packages/web/   server.ts    server su loopback, stime e avanzamento
                index.html   la pagina, senza framework e senza build
```

## Limiti

- **Google Photos non si rilegge da un link.** Non esiste un estrattore yt-dlp,
  quindi il video va scaricato dall'album a mano e passato come file. Il giro in
  sé funziona: 1662 fotogrammi, nessuno illeggibile, parità mai servita. La
  dimensione delle celle è ereditata da YouTube e non misurata per lui, quindi
  il margine è ignoto, solo sufficiente.
- **Il profilo YouTube a 16 px non ha fatto un giro completo su AV1.** Viene
  dalla riproduzione locale di AV1 a 4 Mbps dopo che un caricamento vero era
  fallito a 12 px; il caricamento riuscito che è seguito è tornato in h264.
  YouTube genera le versioni AV1 in ritardo e non per ogni video.
- **Contro i termini di servizio** di queste piattaforme. L'account che porta i
  dati può essere chiuso, e con lui i dati.

---

Fatto da [scobru](https://github.com/scobru) · [github.com/scobru/gazza](https://github.com/scobru/gazza) · MIT
