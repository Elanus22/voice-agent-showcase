// Gemini Live API: bidirektionaler Audio-Stream (Mikrofon-PCM rein,
// Sprach-PCM raus) mit eingebauter Sprechpausen-Erkennung, Barge-in
// und Live-Transkription beider Seiten.
//
// ── Warum hier eine Wrapper-Schicht sitzt ────────────────────────────
// Die Live API begrenzt eine WebSocket-VERBINDUNG auf rund 10 Minuten und
// eine reine Audio-SESSION ohne Kompression auf 15 Minuten. Beides ist für
// ein Beratungsgespräch am Telefon erreichbar. Ohne Gegenmaßnahme bricht
// die Assistentin mitten im Satz ab.
//
// Drei Mechanismen der API fangen das ab — createLiveSession() unten setzt
// alle drei um, für den Aufrufer unsichtbar:
//   · contextWindowCompression  hebt das 15-Minuten-Sessionlimit auf und
//     deckelt gleichzeitig die Kosten (abgerechnet wird pro Turn über das
//     gesamte Kontextfenster, und Audio wächst mit ~25 Token/Sekunde).
//   · sessionResumption         der Server vergibt laufend Handles; damit
//     lässt sich die Verbindung ohne Kontextverlust neu aufbauen.
//   · goAway                    kommt ~60 s vor dem Verbindungsende. Wir
//     bauen dann proaktiv neu auf, bevorzugt in einer Sprechpause.

import { GoogleGenAI, Modality } from "@google/genai";
import { buildSystemPrompt } from "./systemPrompt.js";
import { KURSE_TOOL_DECLARATION } from "./schedule.js";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const LIVE_MODEL = process.env.LIVE_MODEL || "gemini-3.1-flash-live-preview";
const LIVE_VOICE = process.env.LIVE_VOICE || "Kore";

// Ab dieser Kontextgröße fasst die API ältere Turns zusammen und behält das
// Ziel-Budget. ~25 Token/Sekunde Audio: 12800 Token ≈ 8 Minuten Historie.
const KOMPRESSION_TRIGGER = process.env.LIVE_COMPRESS_TRIGGER || "12800";
const KOMPRESSION_ZIEL = process.env.LIVE_COMPRESS_TARGET || "6400";

// Wie lange gepuffertes Anrufer-Audio während eines Reconnects aufgehoben
// wird (20-ms-Häppchen). 250 ≈ 5 Sekunden — mehr hätte keinen Wert, weil
// das Gespräch dann ohnehin gerissen ist.
const MAX_PUFFER_CHUNKS = 250;

/* ─────────────── Notbremse gegen die Endlos-Reconnect-Schleife ─────────────
 *
 * Nimmt die Gegenstelle den Handshake AN und schließt die Verbindung gleich
 * wieder, läuft der Wiederaufbau ohne diese Bremse endlos. Der Grund ist die
 * Fehlerbuchhaltung in reconnect(): Die Drei-Versuche-Grenze dort zählt nur
 * Fehlschläge von verbinde() — hier gelingt verbinde() jedes Mal, der Abbruch
 * kommt erst danach über onclose, und der ruft reconnect() erneut auf.
 *
 * Gemessen (05.08.2026, ungültiger Key, eine gehaltene Telefonverbindung):
 * 85 Wiederaufbauten in 30 s, also 2,8/s ohne Ende, hochgerechnet rund 1.700
 * Sitzungsaufbauten je Anruf — und onAufgegeben feuerte kein einziges Mal.
 *
 * Das ist doppelt schlimm: MAX_GESPRAECH_MIN deckelt die Gesprächsdauer, nicht
 * die Zahl der Sitzungsaufbauten, und weil onAufgegeben ausbleibt, greift auch
 * der Dialplan-Fallback nicht — der Anrufer sitzt bis zum Zeitlimit in völliger
 * Stille, statt nach Sekunden am Festnetz-Telefon zu landen.
 *
 * Auslöser im Echtbetrieb, ganz ohne Angreifer: widerrufener oder abgelaufener
 * Key, erschöpftes Kontingent, erreichter Spend Cap — oder die Abkündigung des
 * Preview-Live-Modells (Review-Punkt 9).
 *
 * Die Schwelle liegt bewusst mit großem Abstand zwischen beiden Seiten: Ein
 * gesunder Betrieb baut etwa alle 10 Minuten einmal neu auf (goAway), die
 * kaputte Schleife schafft 168 Aufbauten pro Minute.
 */
const MAX_RECONNECTS_PRO_FENSTER = 4;
const RECONNECT_FENSTER_MS = 60000;

/**
 * Schreibt die Zeitstempel der jüngsten Wiederaufbauten fort und sagt, ob
 * aufzugeben ist. Als reine Funktion herausgezogen, damit sich die Notbremse
 * ohne Netz, ohne API-Key und ohne Kosten prüfen lässt (pruef/technik.test.mjs).
 */
export function reconnectBuchfuehrung(
  zeiten,
  jetzt,
  max = MAX_RECONNECTS_PRO_FENSTER,
  fensterMs = RECONNECT_FENSTER_MS,
) {
  const aktuell = [...zeiten.filter((t) => jetzt - t < fensterMs), jetzt];
  return { zeiten: aktuell, aufgeben: aktuell.length > max };
}

export function liveModelName() {
  return LIVE_MODEL;
}

// Zur Antwortzeit — damit das niemand ein zweites Mal ausmisst:
// Vom letzten Wort des Anrufers bis zur ersten Silbe der Antwort vergehen
// **1,6 s**, und dieser Wert ist erstaunlich unbeweglich. Gemessen mit je drei
// Läufen gegen die echte API:
//
//   voller System-Prompt + Tools      1,60 s
//   nackter Prompt, keine Tools       1,61 s
//   silenceDurationMs =  100 ms       1,61 s
//   silenceDurationMs = 2000 ms       1,61 s
//
// Heißt: Weder die Größe des Prompts noch die Tools noch die dokumentierten
// VAD-Stellschrauben (`realtimeInputConfig.automaticActivityDetection`)
// beeinflussen das — `gemini-3.1-flash-live-preview` ignoriert sie schlicht.
// Die 1,6 s sind ein Boden des Dienstes. Deshalb steht hier bewusst KEINE
// VAD-Konfiguration: Sie wäre wirkungslose Attrappe.
//
// Wenn das Preview-Modell abgelöst wird (Review-Punkt 9), ist das die erste
// Messung, die man wiederholen sollte — dann kann sich das ändern.
function baueConfig({ extraTools = [], systemSuffix = "", handle = null } = {}) {
  // Pro Verbindung bauen: enthält das heutige Datum, den Ferien-Status und
  // die Gültigkeit des Stundenplans.
  const systemPrompt = buildSystemPrompt();
  const config = {
    responseModalities: [Modality.AUDIO],
    systemInstruction: systemSuffix ? systemPrompt + "\n\n" + systemSuffix : systemPrompt,
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    // Kurszeiten kommen ausschließlich aus dem findeKurse-Tool (schedule.js),
    // nicht aus dem Prompt.
    tools: [{ functionDeclarations: [KURSE_TOOL_DECLARATION, ...extraTools] }],
    // Leeres Objekt beim Erstaufbau: schaltet die Handle-Vergabe überhaupt
    // erst ein. Ohne das gibt es später nichts, womit man wiederaufsetzen könnte.
    sessionResumption: handle ? { handle } : {},
    contextWindowCompression: {
      triggerTokens: KOMPRESSION_TRIGGER,
      slidingWindow: { targetTokens: KOMPRESSION_ZIEL },
    },
  };
  if (LIVE_VOICE) {
    config.speechConfig = {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: LIVE_VOICE } },
    };
  }
  return config;
}

/**
 * Öffnet eine einzelne Live-Session (ohne Wiederaufbau).
 * Für den Telefonbetrieb createLiveSession() verwenden.
 */
export async function connectLive(handlers, opts = {}) {
  return ai.live.connect({
    model: LIVE_MODEL,
    config: baueConfig(opts),
    callbacks: {
      onopen: () => handlers.onOpen?.(),
      onmessage: (msg) => handlers.onMessage(msg),
      onerror: (err) => handlers.onError?.(err),
      onclose: (evt) => handlers.onClose?.(evt),
    },
  });
}

/** "60s" / "12.5s" / "1.500s" → Millisekunden. Unlesbares → null. */
function dauerZuMs(wert) {
  if (wert == null) return null;
  if (typeof wert === "number") return wert * 1000;
  const m = /^([\d.]+)s?$/.exec(String(wert).trim());
  const sek = m ? Number(m[1]) : NaN;
  return Number.isFinite(sek) ? Math.round(sek * 1000) : null;
}

/**
 * Live-Session, die einen Verbindungsabbruch übersteht.
 *
 * Nach außen verhält sie sich wie eine normale Session (sendRealtimeInput,
 * sendClientContent, sendToolResponse, close). Intern baut sie bei goAway
 * oder unerwartetem Abbruch mit dem letzten Resumption-Handle neu auf und
 * schiebt zwischenzeitlich eingegangenes Anrufer-Audio nach.
 *
 * handlers:
 *   onMessage(msg)      wie gehabt — sessionResumptionUpdate und goAway
 *                       werden vorher herausgefiltert.
 *   onError(err)        Fehler der laufenden Verbindung (nicht fatal).
 *   onAufgegeben(grund) Wiederaufbau endgültig gescheitert. ERST hier darf
 *                       der Aufrufer das Gespräch beenden.
 *   onWiederverbunden(grund)  nur für den Log.
 *
 * opts:
 *   extraTools, systemSuffix  wie bei connectLive()
 *   istBeschaeftigt()         soll true liefern, solange das Modell spricht.
 *                             Der Reconnect wartet dann (bis zur Frist) auf
 *                             eine Sprechpause, damit die Lücke nicht mitten
 *                             in einen Satz fällt.
 */
export async function createLiveSession(handlers, opts = {}) {
  const { istBeschaeftigt = () => false } = opts;

  let roh = null;
  let handle = null;
  let generation = 0; // unterscheidet "alte" Verbindungen von der aktuellen
  let beendet = false;
  let baueAuf = false;
  let audioPuffer = [];
  let goAwayTimer = null;
  let reconnectZeiten = []; // Zeitstempel der jüngsten Wiederaufbauten

  function verarbeiteNachricht(msg, gen) {
    if (gen !== generation || beendet) return; // Nachzügler einer alten Verbindung

    // Handles nur mitschreiben, nicht durchreichen — der Aufrufer soll von
    // der Wiederaufbau-Mechanik nichts mitbekommen.
    if (msg.sessionResumptionUpdate) {
      const u = msg.sessionResumptionUpdate;
      if (u.resumable && u.newHandle) handle = u.newHandle;
      return;
    }
    // Vorwarnung, dass die Verbindung gleich zugemacht wird.
    if (msg.goAway) {
      planeReconnect(dauerZuMs(msg.goAway.timeLeft));
      return;
    }
    handlers.onMessage(msg);
  }

  async function verbinde() {
    const gen = ++generation;
    const session = await ai.live.connect({
      model: LIVE_MODEL,
      config: baueConfig({ ...opts, handle }),
      callbacks: {
        onopen: () => handlers.onOpen?.(),
        onmessage: (msg) => verarbeiteNachricht(msg, gen),
        onerror: (err) => {
          if (gen === generation && !beendet) handlers.onError?.(err);
        },
        onclose: () => {
          // Nur der Abbruch der AKTUELLEN Verbindung ist interessant, und
          // auch der nur, wenn wir ihn nicht selbst ausgelöst haben.
          if (gen !== generation || beendet || baueAuf) return;
          reconnect("Verbindung abgebrochen");
        },
      },
    });
    return session;
  }

  /**
   * Nach einem goAway: möglichst in einer Sprechpause neu verbinden, aber
   * spätestens kurz vor Ablauf der genannten Restzeit.
   */
  function planeReconnect(restMs) {
    if (goAwayTimer || beendet) return;
    const frist = Date.now() + Math.max(1000, (restMs ?? 10000) - 5000);
    goAwayTimer = setInterval(() => {
      if (beendet) return stopGoAwayTimer();
      if (!istBeschaeftigt() || Date.now() >= frist) {
        stopGoAwayTimer();
        reconnect("Verbindungslaufzeit erreicht (goAway)");
      }
    }, 250);
  }

  function stopGoAwayTimer() {
    if (goAwayTimer) clearInterval(goAwayTimer);
    goAwayTimer = null;
  }

  async function reconnect(grund) {
    if (beendet || baueAuf) return;

    // Notbremse (siehe oben): Häufen sich die Wiederaufbauten, nimmt die
    // Gegenstelle die Verbindung nur noch an, um sie sofort zu schließen.
    // Weiterversuchen hilft dann nicht — es kostet, und vor allem VERDECKT es
    // den Ausfall, statt ihn zu melden. Hier ist der Punkt, an dem der Anruf
    // in den Dialplan-Fallback gehört: AudioSocket zu, Festnetz klingelt.
    const b = reconnectBuchfuehrung(reconnectZeiten, Date.now());
    reconnectZeiten = b.zeiten;
    if (b.aufgeben) {
      beendet = true;
      stopGoAwayTimer();
      audioPuffer = [];
      const alt = roh;
      roh = null;
      try { alt?.close(); } catch {}
      handlers.onAufgegeben?.(
        `${grund} — ${b.zeiten.length} Wiederaufbauten in ${RECONNECT_FENSTER_MS / 1000} s: ` +
          "die Gegenstelle nimmt die Verbindung an und schließt sie sofort wieder " +
          "(Key widerrufen? Kontingent erschöpft? Live-Modell abgekündigt?)",
      );
      return;
    }

    baueAuf = true;
    stopGoAwayTimer();

    const alt = roh;
    roh = null;
    try { alt?.close(); } catch {}

    for (let versuch = 1; versuch <= 3; versuch++) {
      try {
        roh = await verbinde();
        // Was der Anrufer während der Lücke gesagt hat, nachschieben.
        for (const eingabe of audioPuffer) {
          try { roh.sendRealtimeInput(eingabe); } catch {}
        }
        audioPuffer = [];
        baueAuf = false;
        handlers.onWiederverbunden?.(grund);
        return;
      } catch (err) {
        if (versuch === 3) {
          baueAuf = false;
          beendet = true;
          audioPuffer = [];
          handlers.onAufgegeben?.(`${grund} — Wiederaufbau gescheitert: ${err?.message || err}`);
          return;
        }
        await new Promise((r) => setTimeout(r, 300 * versuch));
      }
    }
  }

  roh = await verbinde();

  return {
    /** Anrufer-Audio. Während eines Reconnects gepuffert statt verworfen. */
    sendRealtimeInput(eingabe) {
      if (beendet) return;
      if (!roh || baueAuf) {
        audioPuffer.push(eingabe);
        if (audioPuffer.length > MAX_PUFFER_CHUNKS) audioPuffer.shift();
        return;
      }
      try {
        roh.sendRealtimeInput(eingabe);
      } catch (err) {
        handlers.onError?.(err);
      }
    },

    sendClientContent(inhalt) {
      if (beendet || !roh) return;
      try {
        roh.sendClientContent(inhalt);
      } catch (err) {
        handlers.onError?.(err);
      }
    },

    /**
     * Tool-Antwort. Fällt sie in ein Reconnect-Fenster, ist sie verloren —
     * die Gegenstelle kennt die zugehörige Call-ID danach nicht mehr. Wir
     * melden das dem Aufrufer, statt es stillschweigend zu schlucken.
     */
    sendToolResponse(antwort) {
      if (beendet) return false;
      if (!roh || baueAuf) return false;
      try {
        roh.sendToolResponse(antwort);
        return true;
      } catch (err) {
        handlers.onError?.(err);
        return false;
      }
    },

    close() {
      beendet = true;
      stopGoAwayTimer();
      audioPuffer = [];
      try { roh?.close(); } catch {}
      roh = null;
    },

    get verbunden() {
      return !beendet && !!roh && !baueAuf;
    },
  };
}
