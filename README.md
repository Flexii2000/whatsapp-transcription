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
Das Transkribieren übernimmt deshalb **faster-whisper** auf dem Heimserver;
Claude bekommt anschließend den fertigen Text und macht daraus die
Stichpunkte.

Zweiter Grund für das Backend: Der Anthropic-API-Key liegt ausschließlich auf
dem Server. Die Extension kennt nur die Backend-Adresse und einen eigenen
Token — sie enthält kein einziges fremdes Secret.

```
   Chrome                        Heimserver
┌───────────────┐            ┌──────────────────────────┐
│ content.js    │  Audio     │  faster-whisper          │
│  findet <audio>├──────────► │      ↓ Transkript        │
│  zeigt Panel  │  Bearer    │  Claude (opus-5)         │
│               │ ◄──────────┤      ↓ Stichpunkte       │
│ background.js │  JSON      │  SQLite-Cache (sha256)   │
└───────────────┘            └──────────────────────────┘
```

---

## Teil 1 — Backend deployen

Läuft als Docker-Container. **Muss unter `~/services/` liegen**, nicht unter
`/opt`: der Docker-Daemon auf dem Server ist die Snap-Variante und lehnt
Bind-Mounts unterhalb von `/opt` ab (`read-only file system`).

```bash
ssh HeimServerLocal          # oder HeimServerRemote von außerhalb
git clone git@github.com:Flexii2000/whatsapp-transcription.git \
    ~/services/whatsapp-transcribe-repo
ln -s ~/services/whatsapp-transcribe-repo/server ~/services/whatsapp-transcribe

cd ~/services/whatsapp-transcribe
cp .env.example .env
openssl rand -hex 32          # → als AUTH_TOKEN in die .env
$EDITOR .env                  # AUTH_TOKEN + ANTHROPIC_API_KEY eintragen

cp deploy/update-whatsapp-transcribe.sh ~/scripts/
~/scripts/update-whatsapp-transcribe.sh
```

Der erste Start lädt das Whisper-Modell herunter (`large-v3-turbo`, ~1,6 GB)
— das dauert einige Minuten. Das Skript wartet darauf und zeigt am Ende die
`/health`-Antwort.

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
| `fherrmann.com/whisper` | Sprachmemo-Transkription (faster-whisper + Claude), Proxy auf `:8099` | `~/services/whatsapp-transcribe` (**nicht** `/opt` — Snap-Docker!) | `git@github.com:Flexii2000/whatsapp-transcription.git` — lokal: `~/Server-Projects/whatsapp-transcription`. Update: `~/scripts/update-whatsapp-transcribe.sh`. nginx: `snippets/whisper.conf` + `conf.d/whisper-limits.conf` |

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

WhatsApp Web hat keine stabilen CSS-Klassen. Die Extension hängt sich deshalb
an das, was ein Redesign überlebt: das `<audio>`-Element.

| Schritt | Wie |
|---|---|
| Sprachnachricht finden | Alle `<audio>` im DOM, per `MutationObserver` auch neu hinzukommende |
| Eingehend? | `.message-in`, ersatzweise `data-id`-Präfix `false_` |
| Identität | Das `data-id` der Blase (`<fromMe>_<chatId>_<msgId>`) — stabil über Reloads, dient als Cache-Schlüssel |
| Audiobytes | `audio.src` ist eine `blob:`-URL. Erst direkter `fetch` aus dem Isolated World, bei Fehlschlag über `page-bridge.js` im Seitenkontext |
| Einhängen | Vor der Zeitstempel-Zeile, damit die Uhrzeit unten rechts bleibt |
| Auslösen | `getBoundingClientRect` im Sekundentakt, **nicht** `IntersectionObserver` — der meldet in einem Hintergrundtab keine Sichtbarkeit, und genau dort steht WhatsApp meistens |

Alle Selektoren stehen gebündelt im `SELECTORS`-Block ganz oben in
`extension/src/content.js`. Wenn WhatsApp etwas umbaut, ist das die einzige
Stelle, die angefasst werden muss.

React baut Blasen beim Scrollen neu auf und wirft dabei fremde Kinder heraus.
Statt dagegen anzukämpfen hängt der Sekundentakt das Panel einfach wieder ein.

### Wenn eine Nachricht noch nicht geladen ist

WhatsApp legt die `blob:`-URL erst an, wenn das Medium entschlüsselt ist.
Passiert das nicht von allein, zeigt das Panel **„Laden & transkribieren"**.

Der Schalter *„Noch nicht geladene Memos automatisch nachladen"* erledigt das
ohne Nachfrage — **erzeugt dabei aber eine Abhör-Bestätigung**, der Absender
sieht das blaue Mikrofon. Deshalb ist er standardmäßig aus.

---

## Konfiguration

### Server (`.env`)

| Variable | Standard | Bedeutung |
|---|---|---|
| `AUTH_TOKEN` | — | **Pflicht.** Muss dem Token in der Extension entsprechen |
| `ANTHROPIC_API_KEY` | — | Leer ⇒ nur Transkript, keine Stichpunkte |
| `WHISPER_MODEL` | `large-v3-turbo` | Bei zu langsamem Server absteigend: `medium` → `small` → `base` |
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

Whisper läuft lokal und kostet nichts. Für Claude fallen pro Sprachnachricht
grob 300–800 Input- und 60–150 Output-Token an — bei Opus-5-Preisen etwa
**0,3–0,6 Cent pro Memo**. Der `sha256`-Cache auf dem Server sorgt dafür, dass
dieselbe Nachricht nie zweimal bezahlt wird.

> Ein claude.ai-Abo ist **kein** API-Zugang — API-Nutzung wird separat
> abgerechnet.

---

## Datenschutz & Sicherheit

### Wo die Daten liegen

| Was | Wohin | Wie lange |
|---|---|---|
| Audio | Nur in den Arbeitsspeicher des Containers. `faster-whisper` bekommt ein `BytesIO`, **keine Datei** | Bis der Request durch ist |
| Transkript + Stichpunkte | SQLite auf dem Heimserver (`data/cache.sqlite3`) | `CACHE_TTL_DAYS`, Standard unbegrenzt |
| Transkript + Stichpunkte | `chrome.storage.local` im Browser, max. 500 Einträge | Bis „Lokalen Cache leeren“ |
| **Transkript-Text** | **Anthropic-API**, für die Zusammenfassung | Nach deren API-Bedingungen |
| Audio | geht **nie** an Anthropic oder sonst irgendwohin | — |

Whisper läuft komplett lokal. Die einzige Übertragung nach außen ist der
fertige **Text** an Claude — und die schaltest du mit `SUMMARY_ENABLED=false`
komplett ab, dann verlässt gar nichts den Server.

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
  Dockerfile, docker-compose.yml     Container (Port 127.0.0.1:8099)
  .env.example                       Konfigurationsvorlage
  deploy/
    nginx-whisper-location.conf      location-Block → snippets/whisper.conf
    nginx-whisper-limits.conf        Rate-Limit-Zonen → conf.d/
    update-whatsapp-transcribe.sh    Deploy nach ~/scripts/

extension/
  manifest.json                      MV3
  src/content.js                     DOM-Anbindung, Warteschlange, Panel
  src/page-bridge.js                 Blob-Zugriff im Seitenkontext
  src/background.js                  Service-Worker, spricht mit dem Backend
  src/styles.css                     Panel-Design (folgt WhatsApps Theme)
  src/options.{html,css,js}          Einstellungen
```
