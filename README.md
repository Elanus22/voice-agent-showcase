# Voice-Agent für eine Tanzschule (anonymisierte Fassung)

Telefonassistent, gebaut für den Einsatz bei einer Tanzschule. Anrufer
sprechen mit einer KI-Assistentin (Gemini Live API), die live im Stundenplan
nachschaut, Schnupperstunden aufnimmt und bei Bedarf an einen Menschen
weiterverbindet. Nach dem Auflegen wird das Gespräch strukturiert ausgewertet
und als Notiz ans Büro geschickt.

**Anonymisiert:** Name, Adresse, Rufnummern, Postfächer und Team der
Tanzschule sind durch Platzhalter ersetzt, der Stundenplan ist verfremdet.
Betriebsinfrastruktur (Telefonanlage, VPN, Server-Deployment) und interne
Projektdokumente sind nicht enthalten. Die Codebasis entspricht sonst dem
produktiven Stand.

## Architektur

```
Festnetz-Anruf                          Browser-Test-UI (localhost:3000)
  → Router (Rufumleitung)                 → Mikrofon (Web Audio, PCM16)
  → Asterisk (VPS, via VPN)               → WebSocket /ws
  → AudioSocket                           │
  → server/phone.js                       → server/index.js
        └────────────┬────────────────────┘
                     ▼
        Gemini Live API (server/live.js)
          ├─ System-Prompt (systemPrompt.js)
          ├─ Tool findeKurse (schedule.js) → Stundenplan aus CSV
          └─ Tool menschVerbinden (nur Telefon) → durchstellen / Rückruf-Mail
                     ▼  (nach dem Auflegen)
        Structured Extraction (gemini.js, responseSchema + Validierung)
                     ▼
        Nodemailer → Notiz ans Büro (ohne SMTP: outbox/)
```

## Designentscheidungen

- **Fakten über ein Tool statt im Prompt.** Der Stundenplan steht nicht im
  System-Prompt, sondern wird bei Kursfragen per `findeKurse` abgefragt
  (Filter: Alter, Tanzstil, Wochentag). So kann das Modell keine Zeiten
  erfinden, und Belegung („ausgebucht“) entscheidet allein das Tool-Ergebnis.
- **Übergabe an einen Menschen.** `menschVerbinden` stellt während der
  Bürozeiten durch und nimmt sonst einen Rückrufwunsch auf. Der Prompt legt
  fest, wann die Assistentin aufgibt (z. B. nach drei gescheiterten
  Rückbestätigungen einer E-Mail-Adresse), statt den Anrufer im Kreis zu
  schicken.
- **Ablaufdatum für Wissen.** Nach `stundenplan_gueltig_bis` nennt die
  Assistentin keine Zeiten mehr, sondern verbindet weiter. Ein veralteter
  Plan klingt für den Anrufer völlig richtig, der Fehler fiele erst vor der
  verschlossenen Tür auf.
- **Kontext pro Gespräch.** Der Server injiziert Datum und Ferienstatus in
  den Prompt, damit keine Schnupperstunde in eine geschlossene Woche fällt.
- **Datenpflege ohne Deployment.** `daten/*.csv` sind in Excel bearbeitbar
  und werden bei Änderung neu eingelesen. Kaputte Dateien fallen auf den
  letzten funktionierenden Stand zurück.
- **Robuste Live-Sitzung.** Die Live API beendet Verbindungen nach etwa zehn
  Minuten. `server/live.js` fängt das über `goAway`, Session-Resumption und
  Kontext-Kompression ab und baut in einer Sprechpause neu auf.
- **Strukturierte Auswertung.** Nach dem Auflegen extrahiert Gemini per
  `responseSchema` Name, Kurs, Termin, Kontakt, Intent und Zusammenfassung.
  Das Ergebnis wird danach im Code validiert und normalisiert (Rufnummern,
  E-Mail, Uhrzeiten), statt der Modellausgabe zu vertrauen.

## Tests

```
npm install
npm test
```

40 Tests unter `pruef/`, u. a. für Extraktions-Validierung, Normalisierung
von Rufnummern und E-Mail-Adressen, Stundenplan-Suche, Datumsprüfung und
Kostenauswertung. `pruef/anruf.mjs` und `pruef/klang.mjs` spielen synthetische
Anrufe über die echte Telefonkette ab (siehe [pruef/README.md](pruef/README.md)).

## Lokal ausprobieren

```
copy .env.example .env      # mindestens GEMINI_API_KEY eintragen
npm run demo                # dann http://localhost:3000 öffnen
```

## Projektstruktur

```
daten/       Stundenplan, Ferien, Einstellungen (CSV, Beispieldaten)
server/
  index.js        Express (Test-UI) + WebSocket ↔ Gemini Live, Startup-Checks
  live.js         Live-Verbindung inkl. Wiederaufbau bei goAway
  phone.js        Telefon-Bridge Asterisk-AudioSocket ↔ Gemini Live
  audio.js        PCM-Resampling für die Telefon-Bridge
  daten.js        CSV-Laden mit Hot-Reload, Validierung, Last-Good-Fallback
  schedule.js     Tool findeKurse
  systemPrompt.js Wissen und Verhalten der Assistentin
  gemini.js       Strukturierte Extraktion + Validierung
  mailer.js       Notiz ans Büro
  anrufLog.js     Betriebsprotokoll ohne Personenbezug
dashboard/   Monatsauswertung (Anrufe, Kosten) für die Kundin
public/      Browser-Test-UI
pruef/       Tests und Prüfskripte
```
