# Prüfskripte

Vier Skripte, kein Test-Framework, keine zusätzliche Dependency. Alles läuft
mit dem Node, der ohnehin installiert ist.

| Skript | Kosten | Wofür |
|---|---|---|
| `technik.test.mjs` | **0 €** | Logik, die still kaputtgehen kann |
| `klang.mjs` | Cent | A/B-Hörtest des Anti-Aliasing-Filters |
| `anruf.mjs` | Cent | kompletter Testanruf ohne Asterisk und ohne Telefon |
| `normalisierung.mjs` | Cent | gesprochene E-Mails und Rufnummern (Punkt 13) |

---

## 1. Technikprüfung — nach jeder Code-Änderung

```bash
node --test "pruef/*.test.mjs"
```

Läuft in zwei Sekunden, braucht kein Internet und keinen API-Key. Geprüft
werden die Stellen, an denen ein Fehler **nicht auffällt**: die Validierung des
Modell-Outputs (an ihr hängt die Richtigkeit jeder Büro-Mail), der
Audio-Tiefpass, das Resampling, die Pacer-Rechnung und die Ladbarkeit der
CSV-Dateien in `daten/`.

## 2. Hörtest — wenn du am Klang etwas änderst

```bash
node pruef/klang.mjs
node pruef/klang.mjs "(Sprich diesen Satz: ...)"     # eigener Text
```

Schreibt nach `pruef/audio/`:

| Datei | Was |
|---|---|
| `1-original-24k.wav` | was Gemini liefert (Referenz) |
| `2-ohne-filter-8k.wav` | wie es **vor** dem Anti-Aliasing-Fix am Telefon klang |
| `3-mit-filter-8k.wav` | wie es **jetzt** klingt |

Hör 2 und 3 direkt hintereinander und achte auf Zischlaute
(„Schnupperstunde", „Sie"). 2 klingt blechern, 3 soll runder klingen. Klingt 3
dumpf und matschig, ist der Filter zu scharf → Grenzfrequenz in
[`server/audio.js`](../server/audio.js) von 3400 auf 3800 Hz.

## 3. Testanruf — vor jedem Deploy

Dieses Skript gibt sich gegenüber `phone.js` als Asterisk aus. Es spricht
dasselbe AudioSocket-Protokoll, meldet vorher eine Rufnummer wie der Dialplan
und spielt optional Anrufer-Sprache ein.

> **Vorsicht: Auflegen löst die echte Auswertung UND den Mailversand aus.**
> Deshalb den Server für Tests ohne SMTP starten — dann landet alles nur in
> `outbox/` und es geht nichts an die Kundin. Das Skript prüft das und bricht
> sonst ab.

**Terminal 1** (Server, ohne Mailversand):

```powershell
$env:SMTP_HOST=""; npm start
```

**Terminal 2** (der Anruf):

```powershell
$env:SMTP_HOST=""            # damit das Skript weiß, dass keine Mail rausgeht
node pruef/anruf.mjs                        # nur zuhören, 15 s
node pruef/anruf.mjs --dauer 30             # länger dranbleiben
node pruef/anruf.mjs --wav frage.wav        # Anrufer sagt etwas (ab Sekunde 6)
node pruef/anruf.mjs --wav frage.wav --ab 1 # Barge-in-Test mitten in die Begrüßung
```

Ausgabe: die empfangene Sprache als WAV in `pruef/audio/` plus ein Messbericht
(Verzögerung bis zur ersten Silbe, Echtzeit-Treue des Pacers, Sprechpausen).
Was der Anruf ausgelöst hat, steht danach in `outbox/`.

### Anrufer-Sprache erzeugen

`klang.mjs` kann auch den Anrufer sprechen — der Text ist frei:

```powershell
node pruef/klang.mjs "(Sprich als Anrufer, ohne Begruessung: Guten Tag, ich haette gerne eine Schnupperstunde fuer meine Tochter Lena, sie ist sechs. Meine E-Mail ist lena punkt schmidt at web punkt de.)"
copy pruef\audio\3-mit-filter-8k.wav pruef\audio\anrufer-frage.wav
node pruef/anruf.mjs --wav pruef/audio/anrufer-frage.wav --ab 11 --dauer 36
```

Das `--ab 11` gibt der Begrüßung Zeit. Mit `--ab 1` redet der Anrufer
absichtlich in die Begrüßung hinein — die muss trotzdem vollständig
durchlaufen (siehe `begruessung` in [`server/phone.js`](../server/phone.js)).

## 4. Normalisierung — wenn du am Extraktions-Prompt drehst

```bash
node pruef/normalisierung.mjs
```

Schickt zwei feste Transkripte an die **echte** Extraktion und prüft, ob
gesprochene Kontaktdaten richtig ankommen: „max punkt mueller at gmail punkt
de" → `max.mueller@gmail.de`, „null zwölf vierunddreißig, sechsundfünfzig
siebenundachtzig neunzig" → `01234567890`. Der zweite Fall enthält eine Korrektur beim
Zurücklesen („nein, mit o e") — dort muss die **zuletzt bestätigte** Fassung
gewinnen, nicht die erste.

Kostet Token und braucht `GEMINI_API_KEY`, läuft deshalb bewusst nicht in
`technik.test.mjs` mit. Von Hand starten nach Änderungen an `server/gemini.js`
oder am Rücklese-Verhalten in `server/systemPrompt.js`.

---

## Was diese Skripte **nicht** abdecken

Nur noch drei Dinge bleiben für den echten Testanruf auf dem VPS übrig:

- **SIP und WireGuard** — die Strecke Fritz!Box ↔ Asterisk
- **Der Dialplan** — `extensions.conf`, insbesondere die `Wait()`-Zeit und das
  Durchstellen per `Dial()`
- **Die letzten Meter Leitung** — Codec der Fritz!Box, Telefonhörer, Ohr

Alles davor ist hier am Schreibtisch prüfbar.

`pruef/audio/` ist in `.gitignore` — die WAV-Dateien sind Wegwerf-Material.
