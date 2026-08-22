# WhatsApp Sprachmemo-Transkription

Chrome-Extension für `web.whatsapp.com`: empfangene Sprachnachrichten werden
automatisch transkribiert, und Transkript plus Stichpunkt-Zusammenfassung
erscheinen als Untertext **innerhalb** der Nachrichtenblase — über der Uhrzeit,
im selben optischen Feld.

```
┌─────────────────────────────────────────┐
│  ◯  ▶  ▏▎▍▌▋▊▉█▉▊▋▌▍▎▏▎▍▌▋      0:38    │
│  ─────────────────────────────────────  │
│  ZUSAMMENFASSUNG            Volltext    │
│  • Heizungsablesung verschoben auf      │
│    Freitag, 8–12 Uhr                    │
│  • Vermieter kann die Uhrzeit nicht     │
│    weiter eingrenzen                    │
│  → Zähler im Keller freiräumen          │
│  → Rückmeldung, ob du Freitag da bist   │
│                                 14:32   │
└─────────────────────────────────────────┘
```

---

## Warum es ein Backend gibt

**Claude kann kein Audio.** Die Messages API nimmt `text`, `image`, `document`
(PDF/Text) und `search_result` entgegen — es gibt keinen Audio-Content-Block.
Transkribiert wird deshalb lokal mit **faster-whisper**; das Sprachmodell
bekommt nur noch fertigen Text.

Wer die Stichpunkte schreibt, ist umschaltbar (`SUMMARY_BACKEND`):

| | Kosten | Qualität | Daten |
|---|---|---|---|
| **`local`** (Standard) | keine | gut | nichts verlässt den Server |
| `claude` | ~1 ct/Memo | beste | Transkript-Text geht an Anthropic |
| `none` | keine | — | nur Transkript |

Zweiter Grund für das Backend: die Extension enthält kein einziges fremdes
Secret. Sie kennt nur die Backend-Adresse und einen eigenen Token.

```
   Chrome                     Heimserver
┌────────────────┐   Audio   ┌────────────────────────────────┐
│ content.js     │──────────►│  faster-whisper  (GPU/CPU)     │
│  findet <audio>│  Bearer   │        ↓ Transkript            │
│  zeigt Panel   │           │  Ollama  qwen3:4b  (GPU/CPU)   │──┐
│                │◄──────────│        ↓ Stichpunkte           │  │ eigener
│ background.js  │   JSON    │  SQLite-Cache (sha256)         │  │ Container,
└────────────────┘           └────────────────────────────────┘  │ Port 11500
                                          │                      │
                                          └── oder Anthropic-API ┘
```

Das Ollama läuft als **eigener** Container (`whatsapp-transcribe-llm`, Port
11500, eigener Modellspeicher) — unabhängig von einem eventuell schon
vorhandenen `ollama` auf demselben Host.

---

## Teil 1 — Backend deployen

Läuft als Docker-Container. **Muss unter `~/services/` liegen**, nicht unter
`/opt`: der Docker-Daemon auf dem Server ist die Snap-Variante und lehnt
Bind-Mounts unterhalb von `/opt` ab (`read-only file system`).

Das erledigt ein Skript. Einmal von Hand holen, danach macht es den Rest:

```bash
ssh HeimServerLocal          # oder HeimServerRemote von außerhalb

# Erstinstallation — OHNE sudo!
~/scripts/setup-whatsapp-transcribe.sh
```

> **Wer läuft mit welchen Rechten?** Die drei Skripte sind gegensätzlich, und
> beide Richtungen sind hart abgesichert:
>
> | Skript | Rechte | Warum |
> |---|---|---|
> | `setup-whatsapp-transcribe.sh` | **als `flexii`** | Der Clone braucht deinen GitHub-Key, den root nicht hat. Und was root anlegt, gehört danach root — spätere Updates ohne sudo wären unmöglich |
> | `update-whatsapp-transcribe.sh` | **als `flexii`** | dito |
> | `fix-docker-gpu.sh` | **mit `sudo`** | schreibt nach `/var/snap/docker/` |
>
> Docker läuft auf diesem Host ohne sudo, das ist also kein Grund dafür.

Das Skript prüft Docker, Port und Plattenplatz, klont das Repo nach
`~/services/whatsapp-transcribe`, erzeugt eine `.env` mit frischem
`AUTH_TOKEN`, fragt nach dem Anthropic-Key (Eingabe bleibt unsichtbar,
leer lassen ist erlaubt), baut den Container, wartet auf `/health` und
druckt am Ende Adresse und Token für die Extension aus.

Vorher nur schauen, ohne etwas zu verändern:

```bash
~/scripts/setup-whatsapp-transcribe.sh --check
```

Der erste Durchlauf dauert einige Minuten — Image bauen plus Whisper-Modell
herunterladen (`large-v3-turbo`, ~1,6 GB).

Gefahrlos wiederholbar: eine vorhandene `.env` wird nie überschrieben, ein
vorhandenes Repo nur nachgezogen.

**Später aktualisieren:**

```bash
~/scripts/update-whatsapp-transcribe.sh     # git pull + rebuild + Healthcheck
```

### GPU freischalten (einmalig, braucht Root)

Der Server hat eine GTX 1660 SUPER, die brachliegt. Whisper fällt damit von
~8 s auf ~2 s pro Memo, die Zusammenfassung von ~18 s auf ~5 s.

```bash
sudo ~/scripts/fix-docker-gpu.sh
~/scripts/setup-whatsapp-transcribe.sh      # erkennt die GPU und stellt um
```

**Warum das nötig ist:** Der Docker-Snap bringt das NVIDIA-Container-Toolkit
selbst mit, aber seine CDI-Spezifikation
(`/var/snap/docker/current/etc/cdi/nvidia.yaml`) enthält den
*revisionsgenauen* Snap-Pfad. Nach einem Snap-Update zeigt sie ins Leere und
jeder `--runtime=nvidia`-Start scheitert mit

```
error running createContainer hook #0:
fork/exec /snap/docker/3377/usr/bin/nvidia-ctk: no such file or directory
```

Das Skript schreibt die Pfade in der bestehenden Spec auf den stabilen
`/snap/docker/current/`-Symlink um — damit übersteht sie künftige
Snap-Updates. Der Docker-Daemon wird dabei **nicht** neu gestartet.

Die Spec wird bewusst *nicht* neu erzeugt: `nvidia-ctk cdi generate` stürzt
auf diesem Toolkit-Stand reproduzierbar beim Aufräumen ab
(`free(): invalid pointer` in `nvSandboxUtilsShutdown`). Nötig ist es auch
nicht — am Inhalt ist nichts veraltet, die Treiberversion stimmt und alle
referenzierten Treiberdateien existieren. Genau das prüft das Skript vorher,
und bricht ab, falls es doch mal nicht zutrifft.

`--check` prüft alles durch, ohne etwas zu ändern, und braucht kein Root:

```bash
~/scripts/fix-docker-gpu.sh --check
```

**VRAM-Rechnung** für die 6 GB der Karte:

| | |
|---|---|
| Whisper `large-v3-turbo` float16 | ~2,0 GB (dauerhaft geladen) |
| `qwen3:4b` in Q4 | ~2,8 GB |
| **zusammen** | **~4,8 GB** — passt mit Reserve |

Ein 7B/8B-Modell (~5 GB) passt **nicht** zusätzlich zu Whisper. Wer eins
will, setzt `WHISPER_DEVICE=cpu` und überlässt die Karte dem Sprachmodell.

### nginx — als Pfad unter `fherrmann.com`

Kein eigener Hostname, kein certbot, kein DNS: der Dienst haengt sich unter
`https://fherrmann.com/whisper/` in das vorhandene Zertifikat ein — dasselbe
Muster wie `/wahlen` und `/aspria/`.

Zwei Dateien kopieren und eine Zeile einfuegen (braucht Root, also selbst am
Terminal):

```bash
# Rate-Limit-Zonen — gehoeren in den http-Kontext, deshalb conf.d/
sudo cp deploy/nginx-whisper-limits.conf /etc/nginx/conf.d/whisper-limits.conf

# Der location-Block
sudo cp deploy/nginx-whisper-location.conf /etc/nginx/snippets/whisper.conf
```

Dann in `/etc/nginx/sites-available/fherrmann.com` **in den 443-Serverblock**,
direkt neben die schon vorhandene `wahlen`-Zeile:

```nginx
    include /etc/nginx/snippets/wahlen.conf;
    include /etc/nginx/snippets/whisper.conf;   # <- neu
```

```bash
sudo nginx -t && sudo systemctl reload nginx
curl -s https://fherrmann.com/whisper/health
```

Der `location`-Block benutzt an beiden Stellen einen abschliessenden Slash
(`location /whisper/` + `proxy_pass http://127.0.0.1:8099/;`). Damit
schneidet nginx das Praefix ab: aus `/whisper/transcribe` wird `/transcribe`.
Das ist der Unterschied zu `wahlen.conf`, wo der Pfad absichtlich stehen
bleibt, weil die Spring-App ihn als context-path selbst erwartet.

> Der Umweg ueber eine eigene Subdomain entfaellt damit vollstaendig. Das ist
> hier auch der robustere Weg: die Jellyfin-Configs fangen mit
> `server_name _;` unbekannte Hostnamen ab, und auf Port 80 antwortet dieser
> Server fuer unbekannte Hostnamen gar nichts — certbots HTTP-01-Challenge
> waere ohne Vorarbeit fehlgeschlagen.

### Nach dem Deploy: `SERVER-CONTEXT.md` nachziehen

In die Tabelle *fherrmann.com — eigene Projekte* gehoert dann:

| Domain | Was | Server-Pfad | Repo |
|---|---|---|---|
| `fherrmann.com/whisper` | Sprachmemo-Transkription (faster-whisper + Claude), Proxy auf `:8099` | `~/services/whatsapp-transcribe` (Repo-Wurzel; Compose liegt in `server/`, **nicht** `/opt` — Snap-Docker!) | `git@github.com:Flexii2000/whatsapp-transcription.git` — lokal: `~/Server-Projects/whatsapp-transcription`. Setup: `~/scripts/setup-whatsapp-transcribe.sh`, Update: `~/scripts/update-whatsapp-transcribe.sh`. nginx: `snippets/whisper.conf` + `conf.d/whisper-limits.conf` |

---

## Teil 2 — Extension installieren

Nicht im Chrome Web Store, also als entpackte Erweiterung:

1. `chrome://extensions` öffnen
2. **Entwicklermodus** oben rechts einschalten
3. **Entpackte Erweiterung laden** → Ordner `extension/` auswählen
4. Die Optionsseite öffnet sich automatisch. Eintragen:
   - **Adresse**: `https://fherrmann.com/whisper` (ohne Slash am Ende)
   - **Token**: derselbe Wert wie `AUTH_TOKEN` in der `.env`
5. **Zugriff erlauben** klicken — Chrome fragt nach der Berechtigung für
   `https://fherrmann.com/whisper/*`. Ohne das blockiert Chrome die Anfragen.
6. **Verbindung testen** — muss Modell und Claude-Status melden.
7. **Speichern**, dann `web.whatsapp.com` neu laden.

---

## Wie die WhatsApp-Anbindung funktioniert

**WhatsApp Web hat kein `<audio>`-Element für Sprachnachrichten.** Die
Wellenform ist ein `<canvas>`, abgespielt wird über die Web-Audio-API, und im
DOM steht nirgends eine `blob:`-URL. Aus dem DOM kommt man an die Audiodaten
also überhaupt nicht heran.

Erreichbar sind sie über WhatsApps eigenes Modulsystem. `window.require()`
nimmt im Seitenkontext Haste-Modulnamen entgegen:

| Modul | wofür |
|---|---|
| `WAWebMsgCollection` | Nachrichtenspeicher — liefert das Modell zu einer `data-id` |
| `WAWebDownloadManager` | Herunterladen und Entschlüsseln der Medien |

Damit ergibt sich die Arbeitsteilung:

| Schritt | Wo | Wie |
|---|---|---|
| Blasen finden | `content.js` | `[data-id]`, die ein `[data-icon="ptt-status"]` enthalten |
| Eingehend? Sprachnachricht? | `page-bridge.js` | aus WhatsApps Modell (`id.fromMe`, `type === "ptt"`) — **nicht** aus dem DOM |
| Audiodaten | `page-bridge.js` | `msg.downloadMedia()`, danach der Blob aus `mediaData` |
| Einhängen | `content.js` | vor die Zeitstempel-Zeile, damit die Uhrzeit unten rechts bleibt |
| Auslösen | `content.js` | `getBoundingClientRect` im Sekundentakt — **nicht** `IntersectionObserver`, der meldet in einem Hintergrundtab nichts |

### Was daran zerbrechlich ist

Das ist Reverse Engineering, und WhatsApp kann Modul- oder Feldnamen jederzeit
ändern. Zwei Vorkehrungen dagegen:

- `mediaBlobOf()` in `page-bridge.js` probiert **mehrere bekannte Ablageorte**
  des entschlüsselten Blobs durch und meldet im Debug-Modus, welcher getragen
  hat. Eine spätere Anpassung ist damit eine Frage von Minuten statt einer
  neuen Fehlersuche.
- Ein **Selbsttest** läuft beim Start, wenn Debug-Ausgaben eingeschaltet sind,
  und beantwortet sofort, ob der Zugriff überhaupt noch funktioniert:

```
[WA-Transkript] Selbsttest: {modulsystem: true, nachrichten: 1224,
                             sprachnachrichten: 7, davonEingehend: 5,
                             downloadManager: true}
```

Alle Klassennamen in WhatsApp Web sind obfuskiert (`x1n2onr6` & Co., Facebooks
Atomic-CSS) und wechseln ständig — deshalb hängt nichts an Klassen, sondern nur
an `data-id`, `data-icon` und der Struktur. Was sich ändern kann, steht
gebündelt im `SELECTORS`-Block oben in `content.js`.

React baut Blasen beim Scrollen neu auf und wirft dabei fremde Kinder heraus.
Statt dagegen anzukämpfen hängt der Sekundentakt das Panel einfach wieder ein.

---

## Konfiguration

### Server (`.env`)

| Variable | Standard | Bedeutung |
|---|---|---|
| `AUTH_TOKEN` | — | **Pflicht.** Muss dem Token in der Extension entsprechen |
| `SUMMARY_BACKEND` | `local` | `local` / `claude` / `none` |
| `LLM_MODEL` | `qwen3:4b` | Modell für `local`. Größer geht nur, wenn Whisper auf der CPU bleibt — siehe VRAM-Rechnung unten |
| `ANTHROPIC_API_KEY` | — | Nur für `claude` |
| `WHISPER_MODEL` | `large-v3-turbo` | Bei zu langsamem Server absteigend: `medium` → `small` → `base` |
| `WHISPER_DEVICE` | `cpu` | Setzt `docker-compose.gpu.yml` auf `cuda` |
| `WHISPER_LANGUAGE` | leer (auto) | `de` erzwingt Deutsch |
| `SUMMARY_MIN_WORDS` | `20` | Darunter keine Stichpunkte — „Ja passt, bis gleich" braucht keine Zusammenfassung. `0` ⇒ wirklich immer |
| `SUMMARY_MAX_BULLETS` | `5` | Obergrenze der Stichpunkte |
| `SUMMARY_EFFORT` | `low` | `low`/`medium`/`high` — für eine Zusammenfassung reicht `low` |
| `MAX_CONCURRENCY` | `1` | Parallele Transkriptionen auf dem Server |
| `CACHE_TTL_DAYS` | `0` | Tage bis zum automatischen Löschen der Transkripte. `0` = unbegrenzt |
| `CORS_ORIGINS` | leer | Leer lassen — die Extension braucht kein CORS |

Claude läuft mit `fallbacks: "default"` (Beta `server-side-fallback-2026-07-01`):
lehnt ein Sicherheitsklassifikator eine Anfrage ab, wiederholt die API sie
serverseitig auf einem Ausweichmodell, statt dir die Ablehnung zurückzugeben.

### Kosten

Mit `SUMMARY_BACKEND=local` (Standard): **nichts**. Whisper und das
Sprachmodell laufen beide auf dem eigenen Server.

Mit `SUMMARY_BACKEND=claude`: rund **1 Cent pro Sprachnachricht** — grob
300–800 Input- und 60–150 Output-Token, plus die Thinking-Token, die als
Output abgerechnet werden. Der `sha256`-Cache sorgt dafür, dass dieselbe
Nachricht nie zweimal bezahlt wird.

> Ein claude.ai-Abo ist **kein** API-Zugang — API-Nutzung wird separat
> abgerechnet.

---

## Statusboard

`status.fherrmann.com` zeigt eine Karte für den Dienst. Sie liest **direkt**
`https://fherrmann.com/whisper/stats` — kein Cron-Sammler dazwischen, gleiches
Muster wie die Sonntagsfrage-Karte. Ein erfolgreicher Abruf belegt damit
gleich mehreres: die Antwort enthält Zahlen aus der SQLite und den
Ladezustand beider Modelle.

Angezeigt werden Engine und Gerät (`large-v3-turbo · GPU (float16)`), das
Zusammenfassungs-Backend (`qwen3:4b · lokal`), der Durchsatz als Vielfaches
der Echtzeit, und wie viel insgesamt verarbeitet wurde.

Zwei bewusste Abweichungen von den übrigen Karten:

- **Keine Veraltet-Prüfung.** Der Dienst läuft nicht nach Zeitplan, sondern
  nur wenn eine Sprachnachricht eintrifft. Drei stille Tage sind normal.
  Der Zustand ergibt sich stattdessen aus Erreichbarkeit und Modell-Bereitschaft.
- **Keine Zeitstempel einzelner Nachrichten.** `/stats` liefert nur Summen und
  Mittelwerte. Die Seite ist öffentlich, und wann jemand Sprachnachrichten
  bekommt, gehört nicht dorthin. Aus demselben Grund filtert `/stats` die
  Modell-Liste des lokalen Ollama heraus, die in dessen `health()` steht.

`/stats` ist als einziger Endpunkt **ohne Token** erreichbar — es steht nur
drin, was ohnehin öffentlich angezeigt wird. `CORS_ORIGINS` steuert, wer es
im Browser lesen darf; leer bedeutet `https://status.fherrmann.com`, `none`
schaltet CORS ab.

Die Karte selbst liegt im Statusboard-Repo
(`~/Server-Projects/statusboard`, `web/index.html` + `web/app.js`).

---

## Datenschutz & Sicherheit

### Wo die Daten liegen

| Was | Wohin | Wie lange |
|---|---|---|
| Audio | Nur in den Arbeitsspeicher des Containers. `faster-whisper` bekommt ein `BytesIO`, **keine Datei** | Bis der Request durch ist |
| Transkript + Stichpunkte | SQLite auf dem Heimserver (`data/cache.sqlite3`) | `CACHE_TTL_DAYS`, Standard unbegrenzt |
| Transkript + Stichpunkte | `chrome.storage.local` im Browser, max. 500 Einträge | Bis „Lokalen Cache leeren“ |
| Transkript-Text | **nur bei `SUMMARY_BACKEND=claude`**: an die Anthropic-API | Nach deren API-Bedingungen |
| Audio | geht **nie** irgendwohin außer an deinen eigenen Server | — |

Im Standardbetrieb (`SUMMARY_BACKEND=local`) **verlässt kein einziges Byte
den Heimserver** — weder Audio noch Transkript. Whisper und das Sprachmodell
laufen beide in Containern auf deiner Maschine.

Nicht protokolliert werden: Transkript-Inhalte und die WhatsApp-`message_id`
(die enthält die Telefonnummer des Chatpartners). In den Logs stehen nur die
ersten 12 Zeichen des Audio-Hashes, Dauer, Wort- und Stichpunktzahl.

### Wie der Endpunkt geschützt ist

- **Bearer-Token**, verglichen mit `hmac.compare_digest` (laufzeitkonstant,
  nicht über Antwortzeiten erratbar).
- Die Prüfung läuft als ASGI-Middleware, **bevor der Body gelesen wird** —
  ein Unbefugter kann den Server nicht zwingen, erst 40 MB entgegenzunehmen
  und dann 401 zu antworten.
- Der Container lauscht auf `127.0.0.1:8099`, ist also nur über nginx
  erreichbar. TLS via Let's Encrypt.
- **Rate-Limit** in nginx: 30 Anfragen/Minute pro IP, Burst 10, max. 4
  gleichzeitige Verbindungen. Deckelt, was ein geleakter Token kosten kann.
- Ohne gesetztes `AUTH_TOKEN` **startet der Dienst nicht** — er kann nicht
  versehentlich offen im Netz stehen.
- Größenlimits doppelt: `client_max_body_size 48m` in nginx,
  `MAX_AUDIO_BYTES` in der App.
- `MAX_CONCURRENCY=1` serialisiert die Transkription — der natürliche
  Flaschenhals begrenzt zusätzlich, wie schnell Kosten entstehen können.

Der Cache-Schlüssel ist `sha256` der Audiodatei. Fremde Transkripte lassen
sich damit nicht erraten oder aufzählen: ohne die exakten Audiobytes gibt es
keinen Treffer, und es gibt keinen Endpunkt, der den Cache auflistet.

### Wenn du das an andere weitergibst

Davon würde ich in dieser Form abraten — nicht wegen der Technik, sondern
wegen der Rolle, in die dich das bringt:

- Fremde Sprachnachrichten landen auf **deinem** Server. Damit verarbeitest
  du personenbezogene Daten von Leuten, die davon nichts wissen — nämlich der
  **Absender** der Memos, nicht nur der Nutzer der Extension. Solange das rein
  privat läuft, greift die Haushaltsausnahme der DSGVO (Art. 2 Abs. 2 lit. c);
  sobald du es verteilst, greift sie nicht mehr.
- Sprachnachrichten enthalten oft besondere Kategorien nach Art. 9 (Gesundheit,
  Beziehungen) — dafür gelten strengere Anforderungen.
- Technisch fehlt dafür alles Nötige: **ein** gemeinsamer Token statt Konten,
  keine Mandantentrennung, kein Löschweg für Betroffene, keine
  Aufbewahrungsfrist im Standard.

Für den privaten Eigengebrauch ist der aktuelle Stand angemessen. Für mehr
als das bräuchte es Tokens pro Nutzer, `CACHE_TTL_DAYS`, einen Löschendpunkt
und eine Datenschutzerklärung.

---

## Fehlersuche

| Symptom | Ursache |
|---|---|
| „Backend nicht erreichbar" | Berechtigung fehlt → Optionen → **Zugriff erlauben**. Sonst nginx/Container prüfen |
| „Token abgelehnt (401)" | `AUTH_TOKEN` in `.env` ≠ Token in den Optionen |
| „Zeitüberschreitung" | Whisper zu langsam. Kleineres `WHISPER_MODEL`, oder `proxy_read_timeout` in nginx hoch |
| Stichpunkte fehlen, Transkript da | Kein `ANTHROPIC_API_KEY`, Memo unter `SUMMARY_MIN_WORDS`, oder Claude-Aufruf gescheitert → `docker compose logs` |
| Gar kein Panel | Debug-Ausgaben in den Optionen einschalten, Konsole auf `web.whatsapp.com` prüfen. Meist haben sich die Selektoren geändert |
| Panel verschwindet beim Scrollen | Sollte der Sekundentakt abfangen; wenn nicht, ist die Blasenstruktur umgebaut worden |

Serverseitig:

```bash
cd ~/services/whatsapp-transcribe
docker compose logs -f
curl -s localhost:8099/health
```

---

## Grenzen

- Nur `web.whatsapp.com`. Für iOS/Android siehe unten.
- Transkribiert **jedes** eingehende Audio, auch angehängte Audiodateien —
  nicht nur Push-to-Talk-Memos.
- Whisper erfindet bei sehr verrauschten oder fast stillen Aufnahmen
  gelegentlich Text. `vad_filter` und `condition_on_previous_text=False`
  dämpfen das, beseitigen es aber nicht.
- Die Extension ist ungesigniert und läuft im Entwicklermodus. Chrome zeigt
  dafür beim Start gelegentlich eine Warnung.

## Für das iPhone

Auf iOS gibt es keine Extension-Schnittstelle in WhatsApp. Zwei Wege, die
dasselbe Backend weiterverwenden:

- **iOS-Kurzbefehl über das Teilen-Menü** — Sprachmemo lange drücken →
  *Teilen* → Kurzbefehl, der die Datei an `/transcribe` schickt und das
  Ergebnis anzeigt. Zwei Taps pro Memo, aber sofort machbar.
- **Verknüpftes Gerät als Bot** — ein Client (Baileys o. ä.) auf dem Server
  empfängt jede Nachricht, transkribiert und schreibt das Ergebnis in den
  eigenen „Nachricht an mich"-Chat. Vollautomatisch und geräteunabhängig,
  aber deutlich mehr Aufwand, und inoffizielle Clients riskieren eine Sperre.

WhatsApp transkribiert auf iOS inzwischen auch selbst — kostenlos und
automatisch, allerdings ohne Zusammenfassung.

---

## Aufbau

```
server/
  app/main.py                        FastAPI: /health, /transcribe
  app/summarize.py                   Stichpunkte: local / claude / none
  Dockerfile                         CPU-Image
  Dockerfile.gpu                     CUDA-Image (cuBLAS + cuDNN als Wheels)
  docker-compose.yml                 Backend (:8099) + eigenes Ollama (:11500)
  docker-compose.gpu.yml             Overlay: runtime nvidia, cuda/float16
  .env.example                       Konfigurationsvorlage
  deploy/
    nginx-whisper-location.conf      location-Block → snippets/whisper.conf
    nginx-whisper-limits.conf        Rate-Limit-Zonen → conf.d/
    setup-whatsapp-transcribe.sh     Erstinstallation (--check für Trockenlauf)
    fix-docker-gpu.sh                repariert die GPU-Durchreichung (sudo)
    update-whatsapp-transcribe.sh    git pull + rebuild + Healthcheck

extension/
  manifest.json                      MV3
  src/content.js                     DOM-Anbindung, Warteschlange, Panel
  src/page-bridge.js                 Blob-Zugriff im Seitenkontext
  src/background.js                  Service-Worker, spricht mit dem Backend
  src/styles.css                     Panel-Design (folgt WhatsApps Theme)
  src/options.{html,css,js}          Einstellungen
```
