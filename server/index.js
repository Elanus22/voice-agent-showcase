// Einstiegspunkt: Express (Browser-Test-UI) + WebSocket-Bridge zur Gemini
// Live API + Telefon-Server (Asterisk AudioSocket, phone.js).
//
// Die Browser-UI unter http://<host>:3000 ist die Test-Oberfläche für
// Prompt, Stundenplan-Tool und Mail-Versand — sie nutzt dieselbe Gemini-
// Live-Session wie der echte Telefonweg.

import "dotenv/config";
import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

import { extractCallData, notfallExtraktion, pruefeGeminiKonfiguration } from "./gemini.js";
import { createLiveSession, liveModelName } from "./live.js";
import { KICKOFF_PROMPT } from "./systemPrompt.js";
import { findeKurseTool, datenBericht, datumDeutsch } from "./schedule.js";
import { datenFehler } from "./daten.js";
import { deliverCallSummary, pruefeMailKonfiguration, raeumeOutboxAuf } from "./mailer.js";
import { startPhoneServer, setPendingCallerId, nimmAbschluss } from "./phone.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
// NUR localhost. Auf dem VPS hängt an diesem Port die Test-UI ohne jede
// Authentifizierung: wer sie erreicht, kann beliebig Gemini-Live-Sessions auf
// unseren Key starten und Mails ans Büro auslösen. Asterisk erreicht
// /phone/callerid weiterhin, weil es auf demselben VPS läuft.
// Zum Testen von außen: SSH-Tunnel (ssh -L 3000:127.0.0.1:3000 user@vps),
// NICHT diesen Wert aufmachen.
const HTTP_HOST = process.env.HTTP_HOST || "127.0.0.1";

/* ── Browser-Demo: standardmäßig AUS ────────────────────────────────────────
 *
 * Die Demo teilt mit dem Telefonweg den System-Prompt, das Stundenplan-Tool,
 * die Live-Session, die Extraktion und den Mailversand — aber nichts von der
 * Sprachmechanik (kein Resampling, kein Tiefpass, kein Pacer, kein
 * Begrüßungsschutz, kein Zeitlimit, kein Durchstellen). Als Prüfwerkzeug ist
 * sie damit von `pruef/anruf.mjs` abgelöst, das die echte Telefonkette spricht.
 *
 * Ihr Wert liegt im Zeigen: bei der Kundin, im Akquisegespräch, auf einem
 * Laptop. Das ist ein lokaler Vorgang. **Auf dem Produktivserver hat sie nichts
 * zu suchen** — dort war sie der Grund für Befund F2 (WebSocket ohne
 * Origin-Prüfung: eine fremde Webseite im Browser konnte über den SSH-Tunnel
 * eine bezahlte Live-Sitzung auf dem Kundenschlüssel starten und eine
 * inhaltlich fremdbestimmte Mail ans Büro auslösen — ohne Zeitlimit, weil das
 * in phone.js sitzt).
 *
 * Deshalb: nicht abgesichert, sondern im Produktivbetrieb gar nicht erst
 * vorhanden. Ohne Schalter kein `public/`, kein `/config`, kein WebSocket.
 *
 * Der Default ist bewusst AUS und nicht AN: Auf dem VPS entsteht die .env per
 * `cp .env.example .env` — eine Sicherung, die man erst einschalten muss, ist
 * dort keine. Lokal: `npm run demo` (oder DEMO_UI=on).
 */
const DEMO_UI =
  /^(1|true|on|ja|yes)$/i.test(process.env.DEMO_UI || "") || process.argv.includes("--demo");

/* Wenn die Demo läuft: Nur Verbindungen von der eigenen Seite annehmen.
 *
 * Den `Origin`-Kopf setzt der Browser selbst, JavaScript einer fremden Seite
 * kann ihn nicht fälschen — genau deshalb trägt die Prüfung. Sie schützt NICHT
 * gegen einen lokalen Prozess mit curl; der kann sich jeden Origin ausdenken.
 * Das ist Absicht und dieselbe Angreiferklasse wie bei N6/N7: Wer schon einen
 * Prozess auf der Maschine hat, ist ohnehin drin.
 *
 * Läuft die Demo über einen abweichenden Port oder Hostnamen (SSH-Tunnel mit
 * anderer lokaler Portnummer), hier ergänzen: DEMO_ORIGINS als Komma-Liste.
 */
const DEMO_ORIGINS = (
  process.env.DEMO_ORIGINS || `http://localhost:${PORT},http://127.0.0.1:${PORT}`
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!process.env.GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY fehlt in .env — ohne Key kein Dialog. Abbruch.");
  process.exit(1);
}

const app = express();
// Statische Demo-Seite nur, wenn die Demo überhaupt an ist. Sonst liefert der
// Server ausschließlich /phone/callerid — mehr braucht der Telefonbetrieb nicht.
if (DEMO_UI) app.use(express.static(path.join(__dirname, "..", "public")));

// Rufnummer-Meldung von Asterisk (Dialplan-CURL direkt vor dem Anruf).
// Nur von localhost akzeptieren — Asterisk läuft auf demselben VPS.
//
// `uuid` ist Pflicht: Es ist dieselbe UUID, die der Dialplan gleich darauf an
// AudioSocket() übergibt, und damit der einzige eindeutige Bezug zwischen
// Meldung und Anruf. Ohne sie wäre die Zuordnung wieder zeitlich geraten
// (siehe phone.js) — und eine falsch zugeordnete Rufnummer schickt das Büro zu
// einem Rückruf bei einem Unbeteiligten.
app.get("/phone/callerid", (req, res) => {
  const ip = req.socket.remoteAddress || "";
  if (!ip.includes("127.0.0.1") && ip !== "::1" && !ip.endsWith(":127.0.0.1")) {
    return res.status(403).type("text/plain").send("nur lokal");
  }
  const uebernommen = setPendingCallerId(
    typeof req.query.num === "string" ? req.query.num : null,
    typeof req.query.uuid === "string" ? req.query.uuid : null,
  );
  // Immer 200: Der Dialplan wertet die Antwort nicht aus, und ein Fehler darf
  // den Anruf auf keinen Fall aufhalten.
  res.type("text/plain").send(uebernommen ? "ok" : "ignoriert");
});

/*
 * Rückfrage des Dialplans nach dem Gesprächsende (seit 14.08.2026).
 *
 * Antwortet "ende" → der Dialplan legt auf. Alles andere → er wählt das
 * Festnetz-Telefon. Der Hintergrund steht in deploy/asterisk/extensions.conf
 * und bei nimmAbschluss() in phone.js: Seit dem Umbau auf
 * Dial(AudioSocket/…,,g) läuft der Dialplan nach JEDEM Gesprächsende weiter,
 * und nur dieser Prozess hier weiß, ob durchgestellt werden soll.
 *
 * Diese Route ist die einzige, die im reinen Telefonbetrieb neben
 * /phone/callerid existiert — beide nur von localhost, beide unauthentifiziert,
 * beide deshalb bewusst ohne Nebenwirkung außer dem Verbrauch eines Eintrags.
 */
app.get("/phone/abschluss", (req, res) => {
  const ip = req.socket.remoteAddress || "";
  if (!ip.includes("127.0.0.1") && ip !== "::1" && !ip.endsWith(":127.0.0.1")) {
    return res.status(403).type("text/plain").send("nur lokal");
  }
  const wert = nimmAbschluss(typeof req.query.uuid === "string" ? req.query.uuid : null);
  res.type("text/plain").send(wert);
});

// Kleine Config-API fürs Frontend (Anzeige des Mail-Empfängers). Gehört zur
// Demo und verschwindet mit ihr — sie verrät sonst ohne Not die Büro-Adresse.
if (DEMO_UI) {
  app.get("/config", (_req, res) => {
    res.json({ mailTo: process.env.MAIL_TO || "buero@tanzschule-muster.example" });
  });
}

const server = http.createServer(app);

/* ✅ F2 gelöst — zwei Ebenen, die wichtigere ist die erste.
 *
 * 1. Ohne DEMO_UI entsteht hier gar kein WebSocket-Server. Auf dem
 *    Produktivsystem gibt es den Endpunkt also nicht — er ist nicht
 *    abgesichert, sondern abwesend. Dieselbe Bewegung wie bei Punkt 5
 *    (ICS-Anhang entfernt statt escaped): Eine Funktion, die dort niemand
 *    braucht, ist ihre Angriffsfläche nicht wert.
 *
 * 2. Läuft die Demo lokal, prüft `verifyClient` den Origin. WebSockets
 *    unterliegen NICHT der Same-Origin-Policy — ohne diese Prüfung könnte eine
 *    beliebige Webseite, die nebenbei im Browser offen ist, eine bezahlte
 *    Live-Sitzung auf dem Kundenschlüssel öffnen, über `user_text` beliebige
 *    Inhalte einspeisen und per `end_call` eine fremdbestimmte Mail ans Büro
 *    auslösen. Den Origin setzt der Browser, fremdes JavaScript kann ihn nicht
 *    fälschen; deshalb trägt die Prüfung genau gegen diesen Fall.
 *
 * Was Ebene 2 NICHT leistet: Ein lokaler Prozess (curl) kann jeden Origin
 * behaupten. Bewusst so — das ist die Angreiferklasse von N6/N7, und wer einen
 * Prozess auf der Maschine hat, ist ohnehin drin.
 *
 * → REVIEW.md, Teil 3
 */
const wss = DEMO_UI
  ? new WebSocketServer({
      server,
      path: "/ws",
      verifyClient: ({ origin }, erlauben) => {
        // Kein Origin = kein Browser (curl, Skript). Nicht der Fall, gegen den
        // diese Prüfung gebaut ist, aber es gibt auch keinen Grund, ihn
        // durchzulassen: Die Demo wird ausschließlich im Browser bedient.
        if (DEMO_ORIGINS.includes(origin)) return erlauben(true);
        console.warn(
          `[demo] WebSocket abgewiesen — Origin ${origin || "(keiner)"} steht nicht auf der Liste.` +
            `\n       Erlaubt: ${DEMO_ORIGINS.join(", ")}   (anpassen über DEMO_ORIGINS)`,
        );
        erlauben(false, 403, "Forbidden origin");
      },
    })
  : null;

// Browser-Test-UI: Gemini Live API — Audio in beide Richtungen, VAD,
// Barge-in und Transkription macht das Modell selbst.
// `?.` — ohne DEMO_UI gibt es keinen Server, an den sich das hängen ließe.
wss?.on("connection", (ws) => {
  const transcript = []; // { role: "Anrufer" | "Assistent", text }
  let lastExtraction = null;

  let session = null;
  let starting = false; // Schutz gegen doppeltes "start"
  let gen = 0;
  let userBuf = ""; // laufende Transkription des Anrufers
  let modelBuf = ""; // laufende Transkription der Assistentin
  let modelTurnOpen = false;

  const send = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };

  send({ type: "config" });

  function transcriptText() {
    return transcript.map((t) => `${t.role}: ${t.text}`).join("\n");
  }

  // Schritt 1 (Auflegen): nur extrahieren — Versand erst nach Klick im UI.
  async function runExtraction() {
    send({ type: "processing" });
    if (transcript.length <= 1) {
      send({ type: "extraction", extraction: null });
      return;
    }
    try {
      lastExtraction = await extractCallData(transcriptText());
    } catch (err) {
      // Wie am Telefon: lieber das Transkript ohne Auswertung als gar nichts.
      console.error("[extraction]", err);
      lastExtraction = notfallExtraktion(err?.message || String(err));
      send({ type: "error", message: "Auswertung fehlgeschlagen — Transkript kann trotzdem versendet werden." });
    }
    send({ type: "extraction", extraction: lastExtraction });
  }

  // Schritt 2 (Button „E-Mail absenden"): Notiz ans Büro verschicken.
  async function sendEmail() {
    if (!lastExtraction) {
      send({ type: "email_result", delivery: null });
      return;
    }
    try {
      const delivery = await deliverCallSummary(lastExtraction, transcriptText());
      send({ type: "email_result", delivery });
    } catch (err) {
      console.error("[send_email]", err);
      send({ type: "error", message: "E-Mail-Versand fehlgeschlagen: " + (err.message || err) });
    }
  }

  function finalizeUser() {
    const text = userBuf.trim();
    userBuf = "";
    if (text) {
      transcript.push({ role: "Anrufer", text });
      send({ type: "user_final", text });
    }
  }

  function openModelTurn() {
    if (modelTurnOpen) return;
    modelTurnOpen = true;
    gen++;
    finalizeUser();
    send({ type: "assistant_start", gen });
  }

  function closeModelTurn() {
    if (!modelTurnOpen) return;
    const text = modelBuf.trim();
    modelBuf = "";
    modelTurnOpen = false;
    if (text) transcript.push({ role: "Assistent", text });
    send({ type: "assistant_end", gen, text });
  }

  function onLiveMessage(msg) {
    // Tool-Call der Live API (kommt außerhalb von serverContent):
    // findeKurse ausführen und das Ergebnis sofort zurückschicken,
    // damit das Modell die Zeiten daraus vorliest.
    if (msg.toolCall?.functionCalls?.length) {
      const functionResponses = msg.toolCall.functionCalls.map((fc) => ({
        id: fc.id,
        name: fc.name,
        response:
          fc.name === "findeKurse"
            ? findeKurseTool(fc.args ?? {})
            : { error: `Unbekanntes Tool: ${fc.name}` },
      }));
      if (session && !session.sendToolResponse({ functionResponses })) {
        console.warn("[live] Tool-Antwort ging im Verbindungswechsel verloren");
      }
      return;
    }

    const sc = msg.serverContent;
    if (!sc) return;

    if (sc.inputTranscription?.text) {
      userBuf += sc.inputTranscription.text;
      send({ type: "user_partial", text: userBuf });
    }
    if (sc.outputTranscription?.text) {
      openModelTurn();
      modelBuf += sc.outputTranscription.text;
      send({ type: "assistant_delta", gen, text: sc.outputTranscription.text });
    }
    for (const part of sc.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) {
        openModelTurn();
        send({ type: "audio_out", data: part.inlineData.data });
      }
    }
    if (sc.interrupted) {
      send({ type: "interrupted" });
      closeModelTurn();
    }
    if (sc.turnComplete) {
      closeModelTurn();
    }
  }

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case "start":
        if (session || starting) break;
        starting = true;
        try {
          // Dieselbe resiliente Session wie am Telefon — die Test-UI soll
          // denselben Weg gehen, damit sich der Reconnect hier prüfen lässt.
          session = await createLiveSession({
            onMessage: onLiveMessage,
            onError: (err) => {
              console.error("[live]", err?.message || err);
              send({ type: "error", message: "Live-Verbindung: " + (err?.message || err) });
            },
            onWiederverbunden: (grund) => console.log(`[live] neu verbunden (${grund})`),
            onAufgegeben: (grund) => {
              console.error("[live] endgültig abgebrochen:", grund);
              closeModelTurn();
              send({ type: "error", message: "Verbindung zu Gemini verloren: " + grund });
            },
          });
          send({ type: "live_ready" });
          // Kickoff: derselbe wörtliche Begrüßungssatz wie am Telefon
          // (systemPrompt.js). Die Demo soll zeigen, was Anrufer hören —
          // inklusive des KI-Hinweises, der hier vorher fehlte.
          session.sendClientContent({
            turns: [{ role: "user", parts: [{ text: KICKOFF_PROMPT }] }],
            turnComplete: true,
          });
        } catch (err) {
          console.error("[live connect]", err);
          send({ type: "error", message: "Live-Session fehlgeschlagen: " + (err.message || err) });
        } finally {
          starting = false;
        }
        break;

      case "audio_in":
        if (session && typeof msg.data === "string") {
          try {
            session.sendRealtimeInput({
              audio: { data: msg.data, mimeType: "audio/pcm;rate=16000" },
            });
          } catch (err) {
            console.error("[live audio_in]", err?.message || err);
          }
        }
        break;

      case "user_text":
        if (session && typeof msg.text === "string" && msg.text.trim()) {
          const text = msg.text.trim();
          finalizeUser();
          transcript.push({ role: "Anrufer", text });
          try {
            session.sendClientContent({
              turns: [{ role: "user", parts: [{ text }] }],
              turnComplete: true,
            });
          } catch (err) {
            console.error("[live user_text]", err?.message || err);
          }
        }
        break;

      case "end_call":
        finalizeUser();
        closeModelTurn();
        try { session?.close(); } catch {}
        session = null;
        await runExtraction();
        break;

      case "send_email":
        await sendEmail();
        break;
    }
  });

  ws.on("close", () => {
    try { session?.close(); } catch {}
    session = null;
  });
});

server.listen(PORT, HTTP_HOST, () => {
  console.log(`\n  Tanzschule Muster Voice-Agent`);
  if (DEMO_UI) {
    console.log(`  Browser-Demo  : AN → http://${HTTP_HOST}:${PORT}`);
    console.log(`                  erlaubte Origins: ${DEMO_ORIGINS.join(", ")}`);
    if (HTTP_HOST !== "127.0.0.1" && HTTP_HOST !== "localhost") {
      console.warn(
        `  ⚠  ACHTUNG: Die Demo lauscht auf ${HTTP_HOST} und hat KEINE Anmeldung.\n` +
          "     Auf einem Produktivserver gehört sie ausgeschaltet (DEMO_UI weglassen).",
      );
    }
  } else {
    // Kein Fehler, sondern der vorgesehene Produktivzustand — deshalb als
    // normale Zeile und nicht als Warnung.
    console.log(`  Browser-Demo  : aus (Produktivbetrieb) — einschalten mit "npm run demo"`);
  }
  console.log(`  HTTP          : ${HTTP_HOST}:${PORT} (Rufnummer-Meldung von Asterisk)`);
  console.log(`  Modell        : Gemini Live API (${liveModelName()})`);
  console.log(`  Extraktion    : ${process.env.GEMINI_MODEL || "gemini-3.6-flash"}`);
  console.log(`  E-Mail        : ${process.env.SMTP_HOST ? "SMTP → " + (process.env.MAIL_TO || "buero@tanzschule-muster.example") : "kein SMTP — Ablage in outbox/"}`);

  // ── Stundenplan-Status ──
  const b = datenBericht();
  console.log(`  Stundenplan   : ${b.kurse} Kurse, ${b.ferien} unterrichtsfreie Zeiträume (Schuljahr ${b.schuljahr})`);
  if (b.abgelaufen) {
    console.error(
      "\n  ✖  STUNDENPLAN ABGELAUFEN" +
        (b.gueltigBis ? ` (galt bis ${datumDeutsch(b.gueltigBis)})` : " — kein Gültigkeitsdatum gesetzt") +
        "\n     Die KI nennt KEINE Kurszeiten mehr und verbindet stattdessen weiter." +
        "\n     Beheben: daten/kurse.csv aktualisieren, dann stundenplan_gueltig_bis" +
        "\n     in daten/einstellungen.csv hochsetzen.\n",
    );
  } else if (b.tageBisAblauf != null && b.tageBisAblauf <= 45) {
    console.warn(
      `\n  ⚠  Stundenplan läuft in ${b.tageBisAblauf} Tagen ab (${datumDeutsch(b.gueltigBis)}).` +
        "\n     Rechtzeitig daten/kurse.csv + daten/einstellungen.csv aktualisieren.\n",
    );
  }
  const fehler = datenFehler();
  if (fehler.length) {
    console.warn(`  ⚠  ${fehler.length} fehlerhafte Zeile(n) in den Datendateien — Details siehe oben.`);
  }

  // ── Gemini-Zugang prüfen. Ohne diesen Check fällt ein ungültiger Key erst
  // beim ersten echten Anruf auf — und dort lautlos, weil der Dialplan in die
  // Dial()-Zeile fällt und es nach einem Telefonproblem aussieht. ──
  pruefeGeminiKonfiguration().then((g) => {
    (g.warnungen || []).forEach((w) => console.warn("  ⚠  " + w));
    if (g.ok) {
      console.log(`  Gemini-Zugang : geprüft ✓ (${g.modelle} Modelle verfügbar)`);
    } else {
      console.error(
        `\n  ✖  GEMINI NICHT ERREICHBAR: ${g.grund}` +
          "\n     Die KI kann KEINE Anrufe annehmen. Anrufer landen über den" +
          "\n     Dialplan-Fallback am Festnetz-Telefon — ab 18 Uhr klingelt das" +
          "\n     ins Leere.\n",
      );
    }
  });

  // ── SMTP-Zugangsdaten prüfen, bevor der erste Anruf davon abhängt ──
  pruefeMailKonfiguration().then((m) => {
    (m.warnungen || []).forEach((w) => console.warn("  ⚠  " + w));
    if (!m.ok && process.env.SMTP_HOST) {
      console.error(
        `\n  ✖  SMTP NICHT ERREICHBAR: ${m.grund}` +
          "\n     Anfragen landen nur in outbox/ und werden NICHT zugestellt.\n",
      );
    } else if (m.ok) {
      console.log("  SMTP-Login    : geprüft ✓");
    }
  });

  // ── Löschkonzept: alte outbox-Kopien wegräumen. Beim Start und danach
  // täglich, damit ein Dienst, der monatelang durchläuft, nicht endlos
  // Transkripte sammelt. UNZUSTELLBAR-* bleibt unangetastet. ──
  const aufraeumen = () => {
    const r = raeumeOutboxAuf();
    if (r.geloescht) console.log(`  [outbox] ${r.geloescht} Datei(en) älter als ${r.aus} Tage gelöscht`);
  };
  aufraeumen();
  setInterval(aufraeumen, 24 * 60 * 60 * 1000).unref();

  // Telefon-Anbindung (Asterisk AudioSocket). Mit PHONE_ENABLED=false
  // abschaltbar (z. B. für reine Browser-Demo ohne Asterisk).
  if (process.env.PHONE_ENABLED !== "false") {
    startPhoneServer();
  }
  console.log("");
});
