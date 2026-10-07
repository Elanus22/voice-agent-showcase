// Telefon-Bridge über Asterisk AudioSocket.
//
// Asterisk nimmt den Festnetz-Anruf an (SIP an der Fritz!Box) und schiebt
// das Gespräch über einen simplen TCP-Stream (AudioSocket) an diesen
// Server: rohes 8-kHz-PCM rein und raus. Wir hängen daran dieselbe Gemini-
// Live-Session wie die Browser-Demo (server/live.js), rechnen die Sample-
// Raten um und lösen beim Auflegen Extraktion + Mail aus.
//
// Weiterverbinden an einen Menschen (Tool menschVerbinden):
//   • vor TRANSFER_UNTIL_HOUR (Default 18 Uhr) → durchstellen aufs reguläre
//     Festnetz-Telefon. Mechanik ohne AMI: die KI sagt „Ich verbinde Sie…",
//     danach legen wir die AudioSocket-Strecke mit einem Hangup-Frame auf und
//     hinterlegen „durchstellen"; der Asterisk-Dialplan fragt das ab und wählt
//     das Festnetz-Telefon. Details bei beendeAudioSocket() und nimmAbschluss().
//   • ab TRANSFER_UNTIL_HOUR → niemand erreichbar → die KI notiert einen
//     dringenden Rückrufwunsch, der beim Auflegen als [DRINGEND]-Mail rausgeht.
//
// Der Hangup-Frame ist nicht durch ein blosses Schliessen der Verbindung zu
// ersetzen — das war bis zum 14.08.2026 so und hat nie funktioniert.
//
// Bindet standardmäßig nur an 127.0.0.1 — Asterisk läuft auf demselben VPS.

import fs from "node:fs";
import net from "node:net";

import { createLiveSession } from "./live.js";
import { protokolliereAnruf, leereNutzung, verrechneNutzung } from "./anrufLog.js";
import { KICKOFF_PROMPT } from "./systemPrompt.js";
import { findeKurseTool } from "./schedule.js";
import { extractCallData, notfallExtraktion } from "./gemini.js";
import { deliverCallSummary } from "./mailer.js";
import { bufToInt16, int16ToBuf, resampleLinear, createTelefonTiefpass } from "./audio.js";

// AudioSocket-Frame-Typen (1 Byte Typ + 2 Byte Länge BE + Payload)
const TYPE_HANGUP = 0x00;
const TYPE_ID = 0x01;
const TYPE_ERROR = 0x03;
const TYPE_AUDIO = 0x10;

const PHONE_RATE = 8000; // AudioSocket slin
const GEMINI_IN_RATE = 16000; // Live-API-Eingang
const GEMINI_OUT_RATE = 24000; // Live-API-Ausgang
const FRAME_MS = 20;
const OUT_FRAME_BYTES = (PHONE_RATE / 1000) * FRAME_MS * 2; // 320 Byte / 20 ms

// So viele Frames darf der Pacer höchstens am Stück nachschieben, wenn er in
// Rückstand geraten ist (5 × 20 ms = 100 ms).
const PACER_MAX_AUFHOLEN = 5;

// Notdeckel für den Ausgabepuffer: 30 s Sprache. Gemini erzeugt schneller als
// Echtzeit, ein voller Antwortsatz im Puffer ist also normal — 30 s nicht mehr.
const MAX_OUT_QUEUE_BYTES = PHONE_RATE * 2 * 30;

/**
 * Wie viele 20-ms-Frames sind zu diesem Zeitpunkt fällig? Immer mindestens
 * einer; ein aufgelaufener Rückstand wird nachgeschoben, aber nur bis
 * PACER_MAX_AUFHOLEN. Als reine Funktion herausgezogen, damit sich die
 * Drift-Rechnung ohne Anruf prüfen lässt (pruef/technik.test.mjs).
 */
export function faelligeFrames(jetzt, deadline, max = PACER_MAX_AUFHOLEN) {
  return Math.min(max, 1 + Math.floor(Math.max(0, jetzt - deadline) / FRAME_MS));
}

// Vor dieser Stunde (Europe/Berlin) wird durchgestellt, danach nur noch
// Rückruf-Mail. Default 18 Uhr.
const TRANSFER_UNTIL_HOUR = Number(process.env.TRANSFER_UNTIL_HOUR || 18);

// Harte Gesprächsobergrenze. 0 schaltet sie ab (nicht empfohlen).
const MAX_GESPRAECH_MIN = Number(process.env.MAX_GESPRAECH_MIN || 10);
const MAX_GESPRAECH_MS = MAX_GESPRAECH_MIN * 60000;
const VORLAUF_MS = 60000; // so früh bekommt das Modell die Abschiedsanweisung
const NACHLAUF_MS = 30000; // danach greift die Notbremse mit Ausblendung
const AUSBLENDE_BYTES = (PHONE_RATE / 1000) * 300 * 2; // ~300 ms Rampe

// Wird eine Minute vor Schluss als Gesprächsbeitrag eingespielt. Bewusst als
// Regieanweisung in Klammern, wie KICKOFF_PROMPT — das Modell soll den Inhalt
// umsetzen, nicht den Text vorlesen.
const ABSCHIED_PROMPT =
  "(Das Gespräch erreicht gleich die maximale Länge. Bring es jetzt freundlich " +
  "zum Abschluss: Fasse in ein bis zwei Sätzen zusammen, was du notiert hast, " +
  "sage zu, dass sich das Büro meldet, und verabschiede dich. Stelle KEINE " +
  "neuen Fragen mehr.)";

// Der Begrüßungssatz steht wörtlich in systemPrompt.js — eine Quelle für
// Telefon und Browser-Demo. Wortlaut dort ändern, nicht hier.

// Telefon-spezifischer System-Prompt-Zusatz (Weiterverbinden).
const PHONE_SYSTEM_SUFFIX = `## Weiterverbinden an einen Menschen

Du hast das Tool menschVerbinden. Rufe es auf, wenn (a) der Anrufer
ausdrücklich eine Mitarbeiterin, die Leitung/Chefin oder „einen Menschen"
sprechen möchte, ODER (b) du eine Frage nicht aus deinem Wissen oder dem
findeKurse-Tool beantworten kannst. Nutze es NICHT für Kurszeiten — dafür ist
findeKurse da. Nach dem Aufruf bekommst du eine kurze Anweisung, was du sagen
sollst; halte dich genau daran.`;

// Function-Declaration für Gemini.
const MENSCH_TOOL_DECLARATION = {
  name: "menschVerbinden",
  description:
    "Verbindet den Anrufer mit einem Menschen bzw. hinterlegt einen " +
    "Rückrufwunsch. Aufrufen, wenn der Anrufer ausdrücklich eine Person/die " +
    "Leitung sprechen möchte ODER wenn du eine Frage nicht beantworten kannst. " +
    "NICHT für Kurszeiten verwenden (dafür findeKurse).",
  parameters: {
    type: "object",
    properties: {
      grund: {
        type: "string",
        description: "Kurzer Grund (z. B. 'möchte Leitung sprechen', 'Preisfrage nicht beantwortbar')",
      },
    },
  },
};

/** Aktuelle Stunde in Europe/Berlin (0–23), unabhängig von der Server-Zeitzone. */
function berlinHour() {
  const s = new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    hour: "2-digit",
    hour12: false,
  }).format(new Date());
  return parseInt(s, 10) % 24;
}

function encodeFrame(type, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(3);
  header.writeUInt8(type, 0);
  header.writeUInt16BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

/* ─────────────────── Rufnummer-Zuordnung über die Call-UUID ──────────────── */

// Asterisk meldet die Rufnummer des Anrufers unmittelbar vor dem Anruf per
// kurzem HTTP-Aufruf (CURL im Dialplan → /phone/callerid in index.js) und gibt
// dabei DIESELBE UUID mit, die es eine Zeile später an AudioSocket() übergibt.
// Diese UUID kommt hier als TYPE_ID-Frame wieder an und ist der Schlüssel.
//
// Vorher war die Zuordnung rein zeitlich (ein Modul-Scope-Wert, 8-s-Fenster).
// Zwei Anrufe in diesem Fenster und Anrufer B überschrieb A — A bekam B's
// Nummer in die Büro-Mail, ausdrücklich gelabelt als „direkt von der
// Telefonanlage". Das Büro ruft dann einen Dritten zurück: DSGVO Art. 5 Abs. 1
// lit. d (Richtigkeit) plus Offenlegung einer Rufnummer gegenüber Dritten.
// Nichts im Code erzwingt „ein Anruf gleichzeitig", also darf sich auch nichts
// darauf verlassen.
// Stillstand auf einer AudioSocket-Verbindung, ab dem sie als tot gilt (N6).
// Großzügig gewählt: Bei einem echten Anruf kommt alle 20 ms Audio, also kann
// er nur eine Verbindung treffen, auf der wirklich nichts mehr passiert.
const AUDIOSOCKET_IDLE_MS = 30000;

const RUFNUMMER_TTL_MS = 120000;
const RUFNUMMER_MAX = 50; // Notbremse gegen Wildwuchs, falls CURL ohne Anruf feuert
const wartendeRufnummern = new Map(); // UUID → { num, ts }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Bringt eine UUID auf die kanonische Form. Nötig, weil sie auf zwei Wegen
 * hereinkommt: als Text aus dem CURL-Aufruf ("40325ec2-5efd-…") und als
 * 16 rohe Bytes im AudioSocket-ID-Frame (→ 32 Hex-Zeichen ohne Bindestriche).
 */
function normalisiereUuid(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (UUID_RE.test(s)) return s;
  const hex = s.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * N7 (gelöst am 12.08.2026): Beim Überlauf wird der ÄLTESTE nach Zeitstempel
 * verworfen, nicht der zuerst eingefügte.
 *
 * Der Unterschied ist nicht akademisch: Vorher genügten 60 Fremdmeldungen mit
 * beliebigen UUIDs nach der echten Meldung, um den echten Eintrag aus der Map
 * zu drängen — der ID-Frame fand ihn dann nicht mehr und die Büro-Mail kam
 * ohne automatisch erfasste Rufnummer. Mit der Zeitstempel-Ordnung trifft es
 * zuerst die ältesten, und die echte Meldung ist im relevanten Moment stets
 * die jüngste (der ID-Frame folgt ihr binnen Millisekunden).
 */
function raeumeMapAuf(map, ttlMs, max) {
  const jetzt = Date.now();
  for (const [uuid, e] of map) {
    if (jetzt - e.ts > ttlMs) map.delete(uuid);
  }
  while (map.size > max) {
    let aeltesteUuid = null;
    let aeltesteZeit = Infinity;
    for (const [uuid, e] of map) {
      if (e.ts < aeltesteZeit) {
        aeltesteZeit = e.ts;
        aeltesteUuid = uuid;
      }
    }
    if (aeltesteUuid === null) break; // kann nicht eintreten, aber keine Endlosschleife riskieren
    map.delete(aeltesteUuid);
  }
}

function verfalleneAufraeumen() {
  raeumeMapAuf(wartendeRufnummern, RUFNUMMER_TTL_MS, RUFNUMMER_MAX);
}

/**
 * Meldung von Asterisk entgegennehmen. Ohne gültige UUID wird die Nummer
 * VERWORFEN — eine Nummer ohne sicheren Bezug zum Anruf ist schlimmer als
 * keine, weil sie in der Mail wie eine bestätigte Tatsache aussieht.
 * @returns {boolean} ob die Meldung übernommen wurde
 */
export function setPendingCallerId(num, uuid) {
  verfalleneAufraeumen();
  const key = normalisiereUuid(uuid);
  if (!key) {
    console.warn(
      "[phone] Rufnummer-Meldung ohne gültige UUID verworfen — Dialplan aktualisieren " +
        "(deploy/asterisk/extensions.conf: uuid=${AS_UUID} im CURL-Aufruf).",
    );
    return false;
  }
  const clean = typeof num === "string" ? num.trim() : "";
  if (!clean || /^(anonymous|unknown|restricted)$/i.test(clean)) return false;
  wartendeRufnummern.set(key, { num: clean, ts: Date.now() });
  return true;
}

/** Rufnummer zu dieser Call-UUID holen und den Eintrag verbrauchen. */
function nimmRufnummer(uuid) {
  verfalleneAufraeumen();
  if (!uuid) return null;
  const eintrag = wartendeRufnummern.get(uuid);
  if (!eintrag) return null;
  wartendeRufnummern.delete(uuid);
  return eintrag.num;
}

/* ────────────── Abschluss-Entscheidung für den Dialplan (14.08.2026) ─────── */

/*
 * Seit dem Umbau auf `Dial(AudioSocket/…,,g)` läuft der Asterisk-Dialplan nach
 * JEDEM Gesprächsende weiter — beim Durchstellen genauso wie beim normalen
 * Auflegen. Für den Kanaltreiber sieht beides identisch aus. Die Entscheidung
 * fällt hier im Node-Prozess, und der Dialplan holt sie sich unmittelbar
 * danach per CURL ab (→ /phone/abschluss in index.js).
 *
 * Warum dieser Umweg überhaupt nötig ist, steht ausführlich in
 * deploy/asterisk/extensions.conf: Ein geschlossener TCP-Socket ist für
 * Asterisk 20 kein Signal. Die frühere Annahme („socket.end() → Asterisk
 * verlässt AudioSocket() → Dial()") war falsch; der Anrufer bekam nach
 * „Ich verbinde Sie…" eine tote Leitung.
 *
 * REIHENFOLGE IST KRITISCH: Die Entscheidung muss hinterlegt sein, BEVOR der
 * Hangup-Frame rausgeht — Asterisk fragt binnen Millisekunden nach. Deshalb
 * gibt es beendeAudioSocket() und keine zwei getrennten Aufrufe an der
 * Aufrufstelle, die man versehentlich vertauschen könnte.
 */
const ABSCHLUSS_TTL_MS = 120000;
const ABSCHLUSS_MAX = 50;
const abschlussEntscheidungen = new Map(); // UUID → { wert, ts }

/*
 * Gesprächsenden, bei denen ans Bürotelefon durchgestellt wird statt aufzulegen.
 *
 * Gemeinsames Merkmal: Der Anrufer ist noch in der Leitung, aber die
 * Assistentin ist es nicht mehr. Ihn dann wegzudrücken kostet eine echte
 * Anfrage — deshalb übernimmt ein Mensch.
 *
 * Bewusst NICHT in dieser Liste:
 *   • "close" / "hangup" → der Anrufer hat aufgelegt, es ist niemand mehr da.
 *   • "zeitlimit" / "zeitlimit-hart" → gewolltes Ende nach dem Abschiedssatz.
 *   • "kein-id-frame" → am anderen Ende hängt gar kein Asterisk-Anruf (N6),
 *     es gibt also auch keinen Kanal, den man durchstellen könnte.
 */
const STOERUNGEN = new Set(["live-aufgegeben", "live-error"]);

/**
 * Was der Dialplan nach diesem Anruf tun soll.
 *
 * FAIL-SAFE: Nur ein ausdrückliches "ende" legt auf. Eine unbekannte UUID
 * liefert bewusst "durchstellen" — dann klingelt lieber einmal zu oft das
 * Bürotelefon, als dass ein Anrufer in einer toten Leitung sitzt. Dieselbe
 * Richtung gilt im Dialplan für Timeout und leere Antwort.
 */
export function nimmAbschluss(uuid) {
  raeumeMapAuf(abschlussEntscheidungen, ABSCHLUSS_TTL_MS, ABSCHLUSS_MAX);
  const key = normalisiereUuid(uuid);
  if (!key) return "durchstellen";
  const eintrag = abschlussEntscheidungen.get(key);
  if (!eintrag) return "durchstellen";
  abschlussEntscheidungen.delete(key);
  return eintrag.wert;
}

// Ein Anruf = eine TCP-Verbindung von Asterisk.
function handleCall(socket) {
  const peer = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`[phone] Anruf verbunden (${peer})`);

  // Beides wird erst durch den ID-Frame gesetzt, den Asterisk direkt nach dem
  // Verbindungsaufbau schickt.
  let callId = null;
  let callerNum = null;

  // Betriebsprotokoll fürs Dashboard (server/anrufLog.js) — ohne Personenbezug.
  const beginnMs = Date.now();
  let nutzung = leereNutzung();

  const transcript = []; // { role: "Anrufer"|"Assistent", text }
  let userBuf = "";
  let modelBuf = "";
  let modelTurnOpen = false;

  let session = null;
  let sitzungGestartet = false; // N6: Live-Sitzung erst nach gültigem ID-Frame
  let outQueue = Buffer.alloc(0); // gepufferte 8-kHz-Sprachausgabe an Asterisk
  let closed = false;

  // Anti-Aliasing vor dem Heruntertasten auf 8 kHz (siehe audio.js).
  const tiefpass = createTelefonTiefpass(GEMINI_OUT_RATE);

  let audioFrames = 0; // vom Anrufer empfangene Audio-Frames (Diagnose)
  let audioBytes = 0; // deren Nutzdaten gesamt
  let audioSpitze = 0; // größter Betrag darin, 0…32767
  let audioExtrem = 0; // Samples über 90 % Vollausschlag
  let audioQuadratsumme = 0; // für den Effektivwert
  let audioSamples = 0;

  /*
   * Mitschnitt des Anrufer-Tons — NUR wenn DIAG_AUDIO_MITSCHNITT gesetzt ist.
   *
   * Standardmäßig aus, und das ist keine Bequemlichkeit: Die Datei enthält das
   * gesprochene Wort des Anrufers in Rohform. Sie ist ein Werkzeug für genau
   * eine Frage — „ist das, was ankommt, überhaupt slin-PCM?" — und gehört nach
   * der Antwort gelöscht. Im Regelbetrieb hat sie auf der Platte nichts zu
   * suchen (DSGVO Art. 5 Abs. 1 lit. c, Datenminimierung).
   *
   * Auswerten:
   *   ffmpeg -f s16le -ar 8000 -ac 1 -i anrufer-<id>.raw probe-slin.wav
   *   ffmpeg -f alaw  -ar 8000 -ac 1 -i anrufer-<id>.raw probe-alaw.wav
   * Welche der beiden nach Sprache klingt, benennt das Format.
   */
  let audioMitschnitt = null;

  let urgentCallback = false; // ab 18 Uhr: dringenden Rückruf vermerken
  let pendingTransfer = false; // Durchstellen angefordert, wartet auf Ansage
  let readyToTransfer = false; // Ansage fertig → sobald Puffer leer, durchstellen
  let transferring = false; // Durchstellen läuft → keine Zusammenfassungs-Mail

  let abschiedLaeuft = false; // Zeitlimit erreicht: nur noch ausreden lassen
  const zeitgeber = []; // alle Timer dieses Anrufs, damit endCall sie abräumt

  // Die Begrüßung MUSS vollständig gesprochen werden, bevor der Anrufer zu
  // Wort kommt: In ihr steckt der Hinweis „Sie sprechen mit einem KI-
  // Assistenten" (EU AI Act Art. 50, Pflicht seit 02.08.2026).
  //
  // Ohne Schutz passiert genau das Gegenteil: Zwischen Abheben und erster
  // Silbe vergehen ein bis zwei Sekunden, in denen viele Anrufer reflexhaft
  // „Hallo? Hallo?" sagen. Dieses „Hallo" geht als Anrufer-Audio an Gemini,
  // die Sprecherkennung wertet es als Dazwischenreden und **bricht die
  // Begrüßung serverseitig ab** — der Rest wird gar nicht erst erzeugt. Der
  // Anrufer hört dann „Tanzschule Mus—" und Stille.
  //
  // Deshalb: Anrufer-Audio wird bis zum Ende der Begrüßung verworfen. Bewusst
  // verworfen und nicht gepuffert — nachgeschoben wäre es ein „Hallo? Hallo?",
  // das sich mit der Begrüßung überschneidet. Die Begrüßung endet mit „wie
  // kann ich helfen?", danach sagt es der Anrufer ohnehin neu.
  let begruessung = "wartet"; // wartet → laeuft → fertig

  // Ausgabe im Echtzeit-Takt (20 ms/Frame) an Asterisk schicken — nicht auf
  // einmal, sonst puffert Asterisk und Barge-in wird träge.
  //
  // Bewusst kein setInterval: Node garantiert nur „frühestens nach 20 ms",
  // nie „genau". Der Fehler ist einseitig und summiert sich — auf Windows
  // gemessen 500 Ticks = 15,5 s statt 10 s, auf dem Linux-VPS 1–5 %. Der
  // Puffer läuft dann nur noch voll, die Sprachausgabe hinkt der Echtzeit
  // hinterher, und fällt der Anrufer ins Wort, verwirft der Barge-in genau
  // den Teil, den er noch gar nicht gehört hat. Deshalb: gegen eine
  // mitlaufende Deadline takten und Rückstand nachschieben.
  let naechsteDeadline = Date.now() + FRAME_MS;
  let pacer = setTimeout(pacerTick, FRAME_MS);

  function pacerTick() {
    // Wie viele Frames sind inzwischen fällig? Gedeckelt, damit ein
    // Aussetzer (GC, Lastspitze) nicht eine halbe Sekunde Ton am Stück in
    // Asterisks Puffer kippt — genau die Trägheit, gegen die der Pacer da ist.
    const faellig = faelligeFrames(Date.now(), naechsteDeadline);
    if (faellig === PACER_MAX_AUFHOLEN) {
      naechsteDeadline = Date.now(); // Rest abschreiben, statt ewig hinterherzulaufen
    }

    if (!socket.destroyed) {
      for (let i = 0; i < faellig; i++) {
        if (!sendeFrame()) break;
      }
    }

    naechsteDeadline += faellig * FRAME_MS;
    // doTransfer()/endCall() können aus sendeFrame() heraus gelaufen sein —
    // dann ist der Anruf vorbei und es wird nicht neu getaktet.
    if (!closed && !transferring) {
      pacer = setTimeout(pacerTick, Math.max(0, naechsteDeadline - Date.now()));
    }
  }

  /** Schickt einen Frame. Rückgabe false, wenn nichts mehr auszuspielen war. */
  function sendeFrame() {
    if (outQueue.length >= OUT_FRAME_BYTES) {
      const frame = outQueue.subarray(0, OUT_FRAME_BYTES);
      outQueue = outQueue.subarray(OUT_FRAME_BYTES);
      socket.write(encodeFrame(TYPE_AUDIO, frame));
      return true;
    }
    // Restbytes unter einer Framegröße mit Stille auffüllen und rausschicken.
    // Ohne das bliebe ein Bruchstück liegen, `outQueue.length === 0` würde nie
    // wahr — und weder das Durchstellen noch das Auflegen käme je zustande.
    // Die Puffergröße ist beliebig, weil sie aus dem Resampling variabel
    // langer Chunks entsteht; ein solcher Rest ist eher die Regel als die
    // Ausnahme.
    if (outQueue.length > 0) {
      const frame = Buffer.alloc(OUT_FRAME_BYTES);
      outQueue.copy(frame);
      outQueue = Buffer.alloc(0);
      socket.write(encodeFrame(TYPE_AUDIO, frame));
      return true;
    }
    // Ausgabepuffer leer und der Begrüßungs-Turn zu Ende: ab jetzt hört die
    // Assistentin wieder zu.
    if (begruessung === "laeuft" && !modelTurnOpen) begruessung = "fertig";
    // Ausgabepuffer leer: wenn die „Ich verbinde Sie"-Ansage durch ist,
    // jetzt durchstellen (AudioSocket schließen → Dialplan wählt weiter).
    if (readyToTransfer) doTransfer();
    // Abschiedssatz zu Ende gesprochen → auflegen.
    else if (abschiedLaeuft && !modelTurnOpen) endCall("zeitlimit");
    return false;
  }

  function finalizeUser() {
    const text = userBuf.trim();
    userBuf = "";
    if (text) transcript.push({ role: "Anrufer", text });
  }

  function openModelTurn() {
    if (modelTurnOpen) return;
    modelTurnOpen = true;
    finalizeUser();
  }

  function closeModelTurn() {
    if (modelTurnOpen) {
      const text = modelBuf.trim();
      modelBuf = "";
      modelTurnOpen = false;
      if (text) transcript.push({ role: "Assistent", text });
    }
    // Ansage vor dem Durchstellen ist fertig gesprochen (Text-seitig).
    //
    // Bewusst AUSSERHALB des modelTurnOpen-Blocks: sagt das Modell nach dem
    // Tool-Aufruf gar nichts (kein Audio, keine Transkription), war der Turn
    // nie „offen" — mit einem Early Return oben bliebe pendingTransfer für
    // immer stehen und der Anrufer säße stumm in der Leitung, statt
    // durchgestellt zu werden.
    if (pendingTransfer) {
      pendingTransfer = false;
      readyToTransfer = true; // der Pacer stellt durch, sobald der Ton raus ist
    }
  }

  // Anrufer-Audio (8 kHz) → 16 kHz → Gemini
  function sendCallerAudio(payload) {
    if (!session || payload.length < 2) return;
    if (begruessung !== "fertig") return; // siehe oben: Begrüßung ausreden lassen
    const roh = bufToInt16(payload);

    /* Pegelmessung des Anrufer-Tons (15.08.2026).
     *
     * Beantwortet beim nächsten „sie hört mich nicht", WO es klemmt. Der
     * SPITZENWERT allein taugt dafür nicht — ein einziger geclippter Sample
     * ergibt schon 100 %. Entscheidend ist der EFFEKTIVWERT (RMS) zusammen mit
     * dem Anteil extremer Samples:
     *
     *   0 Frames                  → es kommt gar kein Ton von Asterisk
     *   RMS ~0 %                  → Ton kommt, ist aber stumm
     *   RMS 2–15 %, extrem <1 %   → normale Sprache, alles in Ordnung
     *   RMS >30 %, extrem >5 %    → kein slin-PCM. Genau so sieht A-law aus,
     *                               wenn man es als 16-Bit-PCM liest:
     *                               gleichverteiltes Rauschen über den ganzen
     *                               Wertebereich.
     *
     * Die Frame-Größe unterscheidet dieselben Fälle noch einmal unabhängig:
     * 320 Byte = 160 Samples slin bei 8 kHz, 160 Byte = A-law/µ-law.
     */
    audioFrames++;
    audioBytes += payload.length;
    for (let i = 0; i < roh.length; i++) {
      const a = Math.abs(roh[i]);
      if (a > audioSpitze) audioSpitze = a;
      if (a > 29490) audioExtrem++; // >90 % Vollausschlag
      audioQuadratsumme += a * a;
      audioSamples++;
    }
    if (audioMitschnitt) audioMitschnitt.write(payload);

    const up = resampleLinear(roh, PHONE_RATE, GEMINI_IN_RATE);
    try {
      session.sendRealtimeInput({
        audio: {
          data: int16ToBuf(up).toString("base64"),
          mimeType: `audio/pcm;rate=${GEMINI_IN_RATE}`,
        },
      });
    } catch (err) {
      console.error("[phone audio→live]", err?.message || err);
    }
  }

  // Gemini-Sprache (24 kHz) → Tiefpass → 8 kHz → Ausgabe-Puffer.
  // Der Tiefpass hat Zustand und gehört deshalb genau einmal pro Anruf angelegt.
  function enqueueModelAudio(base64) {
    if (begruessung === "wartet") begruessung = "laeuft";
    const pcm24 = bufToInt16(Buffer.from(base64, "base64"));
    const down = resampleLinear(tiefpass(pcm24), GEMINI_OUT_RATE, PHONE_RATE);
    // Notdeckel: Der Puffer wird im Echtzeit-Takt geleert, also kann er nur
    // volllaufen, wenn etwas grundsätzlich klemmt. Dann lieber den Satz
    // abschneiden als unbegrenzt Speicher halten und minutenlang Ton
    // nachspielen, den niemand mehr hören will.
    if (outQueue.length + down.length * 2 > MAX_OUT_QUEUE_BYTES) {
      console.warn("[phone] Ausgabepuffer über 30 s — überzähliges Audio verworfen");
      return;
    }
    outQueue = Buffer.concat([outQueue, int16ToBuf(down)]);
  }

  // Tool-Aufruf menschVerbinden auswerten und dem Modell die passende
  // Anweisung zurückgeben (durchstellen vs. Rückruf notieren).
  function handleMenschVerbinden() {
    if (berlinHour() < TRANSFER_UNTIL_HOUR) {
      pendingTransfer = true;
      return {
        status: "verbinde",
        anweisung:
          "Sag dem Anrufer in EINEM kurzen Satz, dass du ihn jetzt mit einer " +
          "Mitarbeiterin verbindest und er kurz am Apparat bleiben soll. Danach " +
          "nichts mehr sagen.",
      };
    }
    urgentCallback = true;
    return {
      status: "niemand_erreichbar",
      anweisung:
        "Entschuldige dich freundlich, dass gerade niemand persönlich " +
        "erreichbar ist. Biete an, einen dringenden Rückruf zu notieren, und " +
        "frage – falls noch nicht bekannt – nach Name und Telefonnummer für den " +
        "Rückruf. Sag zu, dass sich das Team schnellstmöglich meldet.",
    };
  }

  function onLiveMessage(msg) {
    if (msg.usageMetadata) nutzung = verrechneNutzung(nutzung, msg.usageMetadata);

    if (msg.toolCall?.functionCalls?.length) {
      const functionResponses = msg.toolCall.functionCalls.map((fc) => {
        let response;
        if (fc.name === "findeKurse") {
          response = findeKurseTool(fc.args ?? {});
          // Protokollieren, damit nach einem Testanruf nachweisbar ist, DASS
          // im Stundenplan nachgeschlagen wurde. Ohne diese Zeile lässt sich
          // eine korrekt geratene Uhrzeit nicht von einer nachgeschlagenen
          // unterscheiden — und genau das ist die Frage, die zählt.
          // Enthält keine personenbezogenen Daten: nur Alter, Tanzart, Tag.
          const a = fc.args ?? {};
          const filter =
            [a.alter != null && `alter=${a.alter}`, a.art && `art=${a.art}`, a.tag && `tag=${a.tag}`]
              .filter(Boolean).join(", ") || "ohne Filter";
          const voll = (response.kurse ?? []).filter((k) => k.belegung).length;
          console.log(
            `[phone] findeKurse(${filter}) → ${response.kurse?.length ?? 0} Treffer` +
              (voll ? `, davon ${voll} ausgebucht` : ""),
          );
        }
        else if (fc.name === "menschVerbinden") response = handleMenschVerbinden();
        else response = { error: `Unbekanntes Tool: ${fc.name}` };
        return { id: fc.id, name: fc.name, response };
      });
      // Fällt die Tool-Antwort in ein Reconnect-Fenster, kennt die Gegenstelle
      // die Call-ID danach nicht mehr — dann wartet das Modell vergeblich.
      // Beim Durchstellen wäre das fatal: lieber sofort durchstellen.
      if (session && !session.sendToolResponse({ functionResponses })) {
        console.warn("[phone] Tool-Antwort ging im Verbindungswechsel verloren:",
          functionResponses.map((f) => f.name).join(", "));
        if (pendingTransfer) {
          pendingTransfer = false;
          readyToTransfer = true;
        }
      }
      return;
    }

    const sc = msg.serverContent;
    if (!sc) return;

    if (sc.inputTranscription?.text) userBuf += sc.inputTranscription.text;
    if (sc.outputTranscription?.text) {
      openModelTurn();
      modelBuf += sc.outputTranscription.text;
    }
    for (const part of sc.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) {
        openModelTurn();
        enqueueModelAudio(part.inlineData.data);
      }
    }
    if (sc.interrupted) {
      // Barge-in: laufende Ausgabe verwerfen — ABER nicht während der
      // „Ich verbinde Sie…"-Ansage. Dort ist der leere Puffer genau das
      // Signal, an dem der Pacer durchstellt: Der Anrufer hörte
      // „Ich verbinde Sie—" *klick* und danach das Freizeichen.
      // Die Ansage dauert ein bis zwei Sekunden, in denen er einmal überhört
      // wird; direkt danach ist ein Mensch dran, dem er alles sagen kann.
      // Dasselbe gilt für die Begrüßung (siehe begruessung oben).
      if (!pendingTransfer && !readyToTransfer && begruessung === "fertig") {
        outQueue = Buffer.alloc(0);
      }
      closeModelTurn();
    }
    if (sc.turnComplete) closeModelTurn();
  }

  /* ─────────────────── Harte Gesprächsobergrenze (Punkt 7) ──────────────── */

  // Ohne Limit läuft eine offen gelassene Leitung, bis jemand auflegt — und
  // verbraucht dabei durchgehend Gemini-Minuten. Der Spend Cap deckelt zwar
  // die Rechnung, aber wenn er greift, pausieren ALLE Requests bis zum
  // nächsten Abrechnungszyklus: Das Telefon fällt komplett aus. Ein einzelnes
  // vergessenes Gespräch darf nicht den Dienst für den Rest des Monats kosten.
  //
  // Ablauf: Eine Minute vor Schluss bekommt das Modell die Anweisung, zum Ende
  // zu kommen. Bei Ablauf wird ausgeredet und dann aufgelegt; reagiert das
  // Modell nicht, blendet die Notbremse den Ton weich aus.
  function starteZeitlimit() {
    if (MAX_GESPRAECH_MS <= 0) return;

    zeitgeber.push(
      setTimeout(() => {
        if (closed || transferring || !session) return;
        console.log("[phone] Zeitlimit in 60 s — Modell soll zum Ende kommen");
        try {
          session.sendClientContent({
            turns: [{ role: "user", parts: [{ text: ABSCHIED_PROMPT }] }],
            turnComplete: true,
          });
        } catch (err) {
          console.error("[phone] Abschiedsanweisung:", err?.message || err);
        }
      }, Math.max(0, MAX_GESPRAECH_MS - VORLAUF_MS)),
    );

    zeitgeber.push(
      setTimeout(() => {
        if (closed || transferring) return;
        console.log(`[phone] Zeitlimit erreicht (${MAX_GESPRAECH_MIN} Min) — Gespräch wird beendet`);
        abschiedLaeuft = true;
        // Session zu: Sonst startet das Modell auf das nächste Wort des
        // Anrufers hin einen neuen Turn und das Gespräch läuft weiter. Bereits
        // empfangenes Audio liegt lokal in outQueue und wird noch ausgespielt.
        try { session?.close(); } catch {}
        session = null;
        // Turn abschließen, sonst bliebe modelTurnOpen ewig true (kein
        // turnComplete mehr) und der Pacer käme nie zum Auflegen.
        closeModelTurn();
      }, MAX_GESPRAECH_MS),
    );

    // Notbremse: Falls nach Ablauf noch Ton im Puffer liegt (langer Satz,
    // hängende Session), weich ausblenden statt mitten im Wort abzuschneiden.
    zeitgeber.push(
      setTimeout(() => {
        if (closed || transferring) return;
        console.warn("[phone] Nachlauf abgelaufen — Ton wird ausgeblendet");
        blendeAus();
        // Der Rampe Zeit zum Abspielen geben — sofortiges endCall würde den
        // Pacer stoppen und die Ausblendung damit wirkungslos machen.
        zeitgeber.push(setTimeout(() => endCall("zeitlimit-hart"), 400));
      }, MAX_GESPRAECH_MS + NACHLAUF_MS),
    );
  }

  /**
   * Rampt die letzten Millisekunden der Ausgabe auf Null. Ein harter Schnitt
   * im PCM-Strom erzeugt ein hörbares Knacken — bei einem Gespräch, das ohnehin
   * ungewollt endet, ist das der schlechteste mögliche letzte Eindruck.
   */
  function blendeAus() {
    const bytes = Math.min(outQueue.length, AUSBLENDE_BYTES);
    if (bytes < 2) {
      outQueue = Buffer.alloc(0);
      return;
    }
    const rest = Buffer.from(outQueue.subarray(0, bytes));
    const samples = Math.floor(bytes / 2);
    for (let i = 0; i < samples; i++) {
      const faktor = 1 - i / samples;
      rest.writeInt16LE(Math.round(rest.readInt16LE(i * 2) * faktor), i * 2);
    }
    outQueue = rest;
  }

  /**
   * Die AudioSocket-Strecke beenden und dem Dialplan sagen, wie es weitergeht.
   *
   * Beides gehört zusammen und in genau diese Reihenfolge (siehe den Kasten
   * bei nimmAbschluss): erst die Entscheidung hinterlegen, dann der
   * Hangup-Frame. Asterisk fragt sie binnen Millisekunden ab.
   *
   * Der Frame 0x00 ist nicht optional und nicht durch socket.end() zu
   * ersetzen: Ein geschlossener TCP-Socket beendet die Strecke NICHT — der
   * Kanal bliebe stehen und der Anrufer hörte Stille, bis er selbst auflegt.
   * Genau das war der Defekt vom 14.08.2026.
   *
   * @param {"durchstellen"|"ende"} entscheidung
   */
  function beendeAudioSocket(entscheidung) {
    if (callId) {
      abschlussEntscheidungen.set(callId, { wert: entscheidung, ts: Date.now() });
    } else if (entscheidung === "ende") {
      // Ohne UUID ist die Entscheidung nicht zustellbar: Der Dialplan bekommt
      // auf seine Rückfrage nichts Passendes und stellt vorsorglich durch.
      // Für "durchstellen" ist das genau richtig, für "ende" klingelt einmal
      // unnötig das Bürotelefon. Nicht eingreifen — die Alternative wäre, im
      // Zweifel aufzulegen, und das kostet echte Anfragen.
      console.warn("[phone] Gesprächsende ohne Call-UUID — Dialplan stellt vorsorglich durch");
    }
    if (!socket.destroyed && socket.writable) socket.write(encodeFrame(TYPE_HANGUP));
    socket.end();
  }

  // Durchstellen: Session beenden, die KI-Strecke auflegen, der Dialplan wählt
  // danach das Festnetz-Telefon. Der Kanal des Anrufers bleibt dabei stehen —
  // dafür sorgt die Option g in Dial(AudioSocket/…,,g).
  function doTransfer() {
    if (transferring || closed) return;
    transferring = true;
    clearTimeout(pacer);
    zeitgeber.forEach(clearTimeout); // durchgestellt → Zeitlimit gilt nicht mehr
    try { session?.close(); } catch {}
    session = null;
    console.log("[phone] Durchstellen ans Festnetz-Telefon (Dialplan übernimmt)");
    beendeAudioSocket("durchstellen");
  }

  // AudioSocket-Stream framen (TCP kann Frames zerteilen/zusammenlegen).
  let inbuf = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    inbuf = Buffer.concat([inbuf, chunk]);
    while (inbuf.length >= 3) {
      const type = inbuf.readUInt8(0);
      const len = inbuf.readUInt16BE(1);
      if (inbuf.length < 3 + len) break;
      const payload = inbuf.subarray(3, 3 + len);
      inbuf = inbuf.subarray(3 + len);

      if (type === TYPE_AUDIO) sendCallerAudio(payload);
      else if (type === TYPE_ID) {
        // 16 rohe Bytes = die UUID, mit der Asterisk AudioSocket() aufgerufen
        // hat. Erst damit lässt sich die vorher gemeldete Rufnummer sicher
        // diesem Anruf zuordnen.
        callId = normalisiereUuid(payload.toString("hex"));
        callerNum = nimmRufnummer(callId);
        if (process.env.DIAG_AUDIO_MITSCHNITT && callId) {
          const pfad = `/tmp/anrufer-${callId}.raw`;
          audioMitschnitt = fs.createWriteStream(pfad, { mode: 0o600 });
          audioMitschnitt.on("error", (err) => {
            console.error("[phone] Mitschnitt fehlgeschlagen:", err?.message || err);
            audioMitschnitt = null;
          });
          console.warn(`[phone] DIAGNOSE-MITSCHNITT aktiv → ${pfad} (nach der Auswertung löschen!)`);
        }
        // Rufnummer NICHT vollständig ins Log: journald hält Systemlogs je nach
        // Konfiguration monatelang vor, und dort hat eine Anruferkennung nichts
        // verloren. Für die Fehlersuche („kam eine Nummer an?") genügen die
        // ersten Stellen.
        const gekuerzt = callerNum ? callerNum.slice(0, 4) + "…" : null;
        // N6-Nebenbefund (gelöst am 12.08.2026): Der Hex-Fallback ist gedeckelt.
        // Ungekürzt wurde ein 65.535-Byte-ID-Frame zu einer 131.070 Zeichen
        // langen journald-Zeile — pro Verbindung. 32 Zeichen sind die Länge
        // einer echten UUID ohne Bindestriche; alles darüber ist ohnehin kein
        // gültiger Frame, sondern nur noch Beleg dafür, WAS ankam.
        const roh = payload.toString("hex");
        const idFuerLog = callId || `${roh.slice(0, 32)}${roh.length > 32 ? "… (ungültig)" : ""}`;
        console.log(
          `[phone] Call-ID ${idFuerLog}` +
            (gekuerzt ? ` → Rufnummer ${gekuerzt} erfasst` : " (keine Rufnummer gemeldet)"),
        );
        // N6: Erst JETZT die kostenpflichtige Live-Sitzung aufbauen. Ein
        // gültiger ID-Frame ist der einzige Beleg, dass am anderen Ende
        // wirklich Asterisk mit einem Anruf sitzt. Ohne ihn kostet jede
        // TCP-Verbindung eine Gemini-Sitzung auf Rechnung der Kundin.
        if (callId) starteLiveSitzung();
        else console.warn("[phone] ID-Frame ohne verwertbare UUID — keine Sitzung aufgebaut");
      } else if (type === TYPE_HANGUP) endCall("hangup");
      else if (type === TYPE_ERROR) console.error("[phone] AudioSocket-Fehler", payload);
    }
  });

  socket.on("error", (err) => console.error("[phone socket]", err?.message || err));
  socket.on("close", () => endCall("close"));

  // Gesprächsende: Session schließen, Extraktion + Mail auslösen.
  // Beim Durchstellen NICHT — dort übernimmt der Mensch live.
  async function endCall(reason) {
    if (closed) return;
    closed = true;
    clearTimeout(pacer);
    zeitgeber.forEach(clearTimeout);
    finalizeUser();
    closeModelTurn();
    try { session?.close(); } catch {}
    session = null;

    // Beim Durchstellen hat doTransfer() die Strecke schon beendet und
    // "durchstellen" hinterlegt — hier NICHT mit "ende" überschreiben, sonst
    // legt der Dialplan auf, statt das Bürotelefon zu wählen. (endCall läuft
    // gleich danach noch einmal, ausgelöst vom close-Ereignis des Sockets.)
    //
    // Sonst: Die Strecke sauber auflegen. Das ist auch dann nötig, wenn der
    // Anrufer längst aufgelegt hat — dann ist der Socket zu, es wird nichts
    // mehr geschrieben, und der Dialplan läuft ohnehin nicht weiter. Der Fall,
    // der hier wirklich zählt, ist das von der KI ausgelöste Ende: Vor dem
    // 14.08.2026 blieb der Anrufer danach in einer toten Leitung hängen, weil
    // socket.end() allein Asterisk nicht aus der AudioSocket-Strecke holt.
    //
    // STÖRUNGSFÄLLE gehen ans Bürotelefon statt aufzulegen. Das ist der
    // Ausfall-Fallback, den der alte Kommentar oben schon beschrieb (ohne dass
    // er je funktionierte): Bricht die Live-Session mitten im Gespräch
    // endgültig zusammen, sitzt der Anrufer vor einer stummen Assistentin.
    // Ihn dann wegzudrücken kostet eine echte Anfrage — ein Mensch kann
    // übernehmen. Die Zusammenfassungs-Mail geht hier trotzdem raus (anders
    // als beim gewollten Durchstellen), denn dem Menschen am Apparat fehlt
    // alles, was vorher gesprochen wurde.
    if (!transferring) beendeAudioSocket(STOERUNGEN.has(reason) ? "durchstellen" : "ende");

    console.log(`[phone] Anruf beendet (${reason}), ${transcript.length} Beiträge`);
    if (audioMitschnitt) {
      audioMitschnitt.end();
      audioMitschnitt = null;
    }
    const rms = audioSamples ? Math.sqrt(audioQuadratsumme / audioSamples) / 32767 : 0;
    const extremAnteil = audioSamples ? audioExtrem / audioSamples : 0;
    const proFrame = audioFrames ? Math.round(audioBytes / audioFrames) : 0;
    const pro = (x) => `${(x * 100).toFixed(1)} %`;

    /* Die FRAMEGRÖSSE ist das erste und härteste Kriterium — sie hat am
     * 15.08.2026 den Fehler gefunden, nachdem Pegelwerte in die Irre geführt
     * hatten. 20 ms bei 8 kHz sind 160 Samples: als slin 320 Byte, als
     * A-law/µ-law 160. Alles andere als 320 heißt, dass phone.js die Bytes
     * falsch deutet — dann ist jede Pegelaussage darunter wertlos. */
    const befund =
      audioFrames === 0
        ? " — es kam KEIN Ton von Asterisk an"
        : proFrame !== OUT_FRAME_BYTES
          ? ` — FALSCHES FORMAT: ${proFrame} statt ${OUT_FRAME_BYTES} Byte pro Frame.` +
            " Asterisk liefert kein slin-PCM (160 Byte = A-law/µ-law). Dialplan prüfen:" +
            " AudioSocket() als Applikation erzwingt slin, der Kanaltreiber nicht."
          : rms < 0.005
            ? " — praktisch stumm"
            : " — Format und Pegel plausibel";

    console.log(
      `[phone] Anrufer-Audio: ${audioFrames} Frames à ${proFrame} Byte, ` +
        `RMS ${pro(rms)}, Spitze ${pro(audioSpitze / 32767)}, ` +
        `extrem ${pro(extremAnteil)}${befund}`,
    );

    // Betriebsprotokoll fürs Dashboard. Nur bei einem echten Anruf: Ohne
    // Call-UUID sitzt am anderen Ende kein Asterisk-Kanal (N6), das wäre eine
    // Verbindung ohne Anrufer und würde die Statistik verfälschen.
    // VOR den beiden Abbrüchen unten, weil ein durchgestellter Anruf gerade
    // die Zahl ist, die das Büro interessiert.
    if (callId) {
      protokolliereAnruf({
        dauerSek: (Date.now() - beginnMs) / 1000,
        weitergeleitet: transferring || STOERUNGEN.has(reason),
        nutzung,
      });
    }

    if (transferring) return; // durchgestellt → keine Zusammenfassungs-Mail
    if (transcript.length <= 1) return; // nichts Verwertbares

    // Zweiter Versuch: War der CURL-Aufruf von Asterisk langsamer als der
    // Verbindungsaufbau, lag die Nummer beim ID-Frame noch nicht vor. Die
    // Zuordnung über die UUID bleibt dabei eindeutig.
    if (!callerNum && callId) callerNum = nimmRufnummer(callId);
    const transcriptText = transcript.map((t) => `${t.role}: ${t.text}`).join("\n");

    // Extraktion und Versand bewusst getrennt: scheitert die Auswertung,
    // geht das Transkript trotzdem raus. Vorher lagen beide in einem try —
    // ein Fehler in der Extraktion hat die Anfrage komplett verschluckt.
    let extraction;
    try {
      extraction = await extractCallData(transcriptText);
    } catch (err) {
      console.error("[phone] Extraktion fehlgeschlagen:", err?.message || err);
      extraction = notfallExtraktion(err?.message || String(err));
    }

    try {
      const delivery = await deliverCallSummary(extraction, transcriptText, {
        urgent: urgentCallback,
        callerNum,
      });
      const wohin = delivery.sent
        ? "per Mail an " + delivery.to
        : delivery.fehlgeschlagen
          ? `NICHT ZUGESTELLT — liegt in ${delivery.outboxPath}`
          : "in outbox/ abgelegt";
      console.log(`[phone] Zusammenfassung ${wohin}` + (urgentCallback ? " (DRINGEND)" : ""));
    } catch (err) {
      // Hierher kommen wir nur noch, wenn nicht einmal das Schreiben nach
      // outbox/ geklappt hat (Platte voll, Rechte). Dann bleibt der Log.
      console.error("[phone] Versand komplett fehlgeschlagen:", err?.message || err);
      console.error("[phone] Verlorenes Transkript:\n" + transcriptText);
    }
  }

  // Gemini-Live-Session für diesen Anruf öffnen und Begrüßung anstoßen.
  //
  // createLiveSession() überbrückt Verbindungsabbrüche selbst (goAway nach
  // ~10 Minuten Verbindungslaufzeit, Session-Resumption). Erst wenn auch der
  // Wiederaufbau scheitert, meldet es sich über onAufgegeben — dann endet der
  // Anruf über endCall(), und die Zusammenfassungs-Mail geht trotzdem raus.
  //
  // ACHTUNG, hier stand bis zum 14.08.2026 etwas Falsches: „AudioSocket ohne
  // Hangup-Frame schließen, der Dialplan fällt in die nächste Zeile (Dial →
  // Festnetz-Telefon klingelt)". Das hat nie funktioniert — ein geschlossener
  // Socket ist für Asterisk kein Signal, der Anrufer saß in einer toten
  // Leitung. Seither beendet endCall() die Strecke mit einem Hangup-Frame und
  // hinterlegt "ende"; wer hier das Bürotelefon klingeln lassen will, muss
  // stattdessen "durchstellen" hinterlegen.
  // Wird vom ID-Frame ausgelöst (N6), nicht mehr vom Verbindungsaufbau.
  // Auf localhost schickt Asterisk den Frame unmittelbar nach dem Connect —
  // die Begrüßungslatenz ändert sich dadurch nicht messbar.
  function starteLiveSitzung() {
    if (sitzungGestartet || closed) return;
    sitzungGestartet = true;
    createLiveSession(
    {
      onMessage: onLiveMessage,
      onError: (err) => console.error("[phone live]", err?.message || err),
      onWiederverbunden: (grund) => console.log(`[phone live] neu verbunden (${grund})`),
      onAufgegeben: (grund) => {
        console.error("[phone live] endgültig abgebrochen:", grund);
        if (!closed && !transferring) endCall("live-aufgegeben");
      },
    },
    {
      extraTools: [MENSCH_TOOL_DECLARATION],
      systemSuffix: PHONE_SYSTEM_SUFFIX,
      // Reconnect möglichst in eine Sprechpause legen: solange die
      // Assistentin redet oder noch Ton im Ausgabepuffer liegt, warten.
      istBeschaeftigt: () => modelTurnOpen || outQueue.length > 0,
    },
  )
    .then((s) => {
      if (closed) { try { s.close(); } catch {} return; } // Anrufer war schneller
      session = s;
      s.sendClientContent({
        turns: [{ role: "user", parts: [{ text: KICKOFF_PROMPT }] }],
        turnComplete: true,
      });
      // Erst ab hier zählen: Vor dem Session-Aufbau redet noch niemand.
      starteZeitlimit();
      // Notbremse zur Begrüßungssperre: Bleibt das Modell stumm (Fehler,
      // Quota), wäre der Anrufer sonst für den Rest des Gesprächs
      // stummgeschaltet und würde in eine Leitung reden, die nicht zuhört.
      zeitgeber.push(
        setTimeout(() => {
          if (begruessung !== "fertig") {
            console.warn("[phone] keine Begrüßung nach 12 s — Anrufer wird trotzdem freigeschaltet");
            begruessung = "fertig";
          }
        }, 12000),
      );
    })
      .catch((err) => {
        console.error("[phone] Live-Session fehlgeschlagen:", err?.message || err);
        endCall("live-error");
      });
  }

  // Notbremse zu N6: Bleibt der ID-Frame aus, sitzt am anderen Ende kein
  // Asterisk-Anruf. Verbindung verwerfen statt endlos offen halten — eine
  // Mail entsteht dabei nicht (endCall bricht bei leerem Transkript ab), und
  // für einen echten Anruf greift im Dialplan ohnehin Dial(${TRANSFER_TARGET}).
  zeitgeber.push(
    setTimeout(() => {
      if (!sitzungGestartet && !closed) {
        console.warn(`[phone] kein ID-Frame binnen 2 s (${peer}) — Verbindung verworfen`);
        endCall("kein-id-frame");
      }
    }, 2000),
  );
}

/**
 * Startet den AudioSocket-Server. Bindet per Default nur an localhost
 * (Asterisk läuft auf demselben VPS → kein Port ins Internet).
 */
export function startPhoneServer() {
  const port = Number(process.env.AUDIOSOCKET_PORT || 8090);
  const host = process.env.AUDIOSOCKET_HOST || "127.0.0.1";

  /**
   * N6 (gelöst am 12.08.2026), drei Sperren gegen denselben Befund:
   * 200 gleichzeitige Verbindungen wurden angenommen, jede startete sofort
   * eine kostenpflichtige Live-Sitzung — vor dem ID-Frame, ohne Prüfung, ob
   * überhaupt Asterisk am anderen Ende sitzt.
   *
   *   1. maxConnections — deploy/README.md nennt „ein Anruf gleichzeitig" als
   *      ausgelegten Betrieb. 3 lässt Luft für eine Überlappung beim
   *      Verbindungswechsel, ohne dass Sitzungen unbegrenzt auflaufen.
   *      Darüber hinausgehende Verbindungen weist der Kernel ab; für einen
   *      echten Anruf fällt der Dialplan dann auf Dial(${TRANSFER_TARGET}),
   *      das Bürotelefon klingelt also statt der KI.
   *   2. setTimeout — eine tote Verbindung hält sonst einen der drei Plätze
   *      dauerhaft besetzt. Während eines echten Anrufs kann er nicht
   *      auslösen: Asterisk schickt alle 20 ms Audio, auch bei Stille.
   *   3. Sitzungsaufbau erst nach gültigem ID-Frame (siehe starteLiveSitzung).
   */
  const server = net.createServer(handleCall);
  server.maxConnections = 3;
  server.on("connection", (socket) => {
    socket.setTimeout(AUDIOSOCKET_IDLE_MS, () => {
      console.warn(`[phone] AudioSocket ${AUDIOSOCKET_IDLE_MS / 1000} s ohne Daten — Verbindung getrennt`);
      socket.destroy();
    });
  });
  server.on("error", (err) => console.error("[phone server]", err?.message || err));
  server.listen(port, host, () => {
    console.log(`  Telefon       : AudioSocket ${host}:${port} (Asterisk → Gemini Live)`);
  });
  return server;
}
