// Kompletter Testanruf ohne Asterisk, ohne VPS, ohne Telefon.
//
// Dieses Skript gibt sich gegenüber phone.js als Asterisk aus: Es spricht das
// AudioSocket-Protokoll (1 Byte Typ, 2 Byte Länge, dann rohes 8-kHz-PCM),
// meldet vorher eine Rufnummer wie der Dialplan, spielt optional Anrufer-Audio
// ein und schreibt alles, was zurückkommt, als WAV.
//
// Damit lässt sich am Schreibtisch prüfen: Begrüßung, Klang, Pacer-Timing,
// Barge-in, Rufnummer-Erfassung, Auswertung. Übrig bleibt für den VPS nur
// noch SIP/WireGuard und die letzten Meter Leitung.
//
// VORHER in einem zweiten Terminal den Server starten:
//   npm start
//
// ┌───────────────────────────────────────────────────────────────────────┐
// │ ACHTUNG: Auflegen löst die echte Auswertung UND den Mailversand aus.  │
// │ Für Tests den Server OHNE SMTP starten, dann landet alles nur in      │
// │ outbox/ und es geht nichts an die Kundin:                             │
// │   PowerShell:  $env:SMTP_HOST=""; npm start                            │
// └───────────────────────────────────────────────────────────────────────┘
//
//   node pruef/anruf.mjs                          nur zuhören, 15 s
//   node pruef/anruf.mjs --dauer 25               länger dranbleiben
//   node pruef/anruf.mjs --wav frage.wav          Anrufer sagt etwas (nach 6 s)
//   node pruef/anruf.mjs --wav frage.wav --ab 2   Barge-in-Test: mitten rein

import "./_env.mjs";

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { bufToInt16, int16ToBuf, resampleLinear } from "../server/audio.js";

const HIER = path.dirname(fileURLToPath(import.meta.url));
const AUSGABE = path.join(HIER, "audio");

const TYPE_HANGUP = 0x00;
const TYPE_ID = 0x01;
const TYPE_AUDIO = 0x10;
const FRAME_BYTES = 320; // 20 ms @ 8 kHz, 16 bit

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const DAUER_S = Number(arg("dauer", 15));
const WAV = arg("wav");
const AB_S = Number(arg("ab", 6));
const NUMMER = arg("nummer", "01234123456");

/* ── Schutz vor der Mail ans echte Büro ─────────────────────────────────── */

const MAIL_TO = process.env.MAIL_TO || "buero@tanzschule-muster.example";
if (process.env.SMTP_HOST && arg("mail-an") !== MAIL_TO) {
  console.error(
    `\nIn der .env steht SMTP_HOST=${process.env.SMTP_HOST} und MAIL_TO=${MAIL_TO}.\n` +
      "Läuft der Server mit dieser Konfiguration, geht beim Auflegen eine ECHTE\n" +
      "Mail an diese Adresse raus.\n\n" +
      "Entweder den Server ohne SMTP starten (empfohlen):\n" +
      "    $env:SMTP_HOST=\"\"; npm start\n\n" +
      `oder den Versand hier bewusst bestätigen:\n    node pruef/anruf.mjs --mail-an ${MAIL_TO}\n`,
  );
  process.exit(1);
}

/* ── WAV lesen (16 bit PCM, Mono oder Stereo, beliebige Rate) ───────────── */

// Bewusst tolerant: Eigene Aufnahmen kommen typischerweise als 44,1-kHz-Stereo
// aus dem Windows-Sprachrekorder. Rate wird umgerechnet, aus Stereo nimmt der
// Leser den linken Kanal. Alles andere (MP3, M4A, 24/32 bit) vorher mit
// ffmpeg wandeln — Befehl steht in TESTANRUFE.md.
function leseWav(datei) {
  const buf = fs.readFileSync(datei);
  if (buf.toString("ascii", 0, 4) !== "RIFF") throw new Error(`${datei} ist keine WAV-Datei`);
  let rate = 8000;
  let kanaele = 1;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const len = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") {
      const format = buf.readUInt16LE(pos + 8);
      const bits = buf.readUInt16LE(pos + 22);
      if (format !== 1 || bits !== 16) {
        throw new Error(`${datei}: nur 16-bit PCM — siehe ffmpeg-Befehl in pruef/TESTANRUFE.md`);
      }
      kanaele = buf.readUInt16LE(pos + 10);
      rate = buf.readUInt32LE(pos + 12);
    } else if (id === "data") {
      let pcm = bufToInt16(buf.subarray(pos + 8, pos + 8 + len));
      if (kanaele > 1) {
        const mono = new Int16Array(Math.floor(pcm.length / kanaele));
        for (let i = 0; i < mono.length; i++) mono[i] = pcm[i * kanaele]; // linker Kanal
        pcm = mono;
      }
      return resampleLinear(pcm, rate, 8000);
    }
    pos += 8 + len + (len % 2);
  }
  throw new Error("kein data-Chunk gefunden");
}

function schreibeWav(datei, samples, rate) {
  const daten = int16ToBuf(samples);
  const kopf = Buffer.alloc(44);
  kopf.write("RIFF", 0);
  kopf.writeUInt32LE(36 + daten.length, 4);
  kopf.write("WAVEfmt ", 8);
  kopf.writeUInt32LE(16, 16);
  kopf.writeUInt16LE(1, 20);
  kopf.writeUInt16LE(1, 22);
  kopf.writeUInt32LE(rate, 24);
  kopf.writeUInt32LE(rate * 2, 28);
  kopf.writeUInt16LE(2, 32);
  kopf.writeUInt16LE(16, 34);
  kopf.write("data", 36);
  kopf.writeUInt32LE(daten.length, 40);
  fs.writeFileSync(datei, Buffer.concat([kopf, daten]));
}

const rahmen = (typ, payload = Buffer.alloc(0)) => {
  const kopf = Buffer.alloc(3);
  kopf.writeUInt8(typ, 0);
  kopf.writeUInt16BE(payload.length, 1);
  return Buffer.concat([kopf, payload]);
};

/* ── Anruf ──────────────────────────────────────────────────────────────── */

const uuid = crypto.randomUUID();
const anruferAudio = WAV ? leseWav(path.resolve(WAV)) : null;

// Wie der Dialplan: Rufnummer melden, bevor der Anruf aufgebaut wird.
const httpPort = process.env.PORT || 3000;
try {
  const antwort = await fetch(
    `http://127.0.0.1:${httpPort}/phone/callerid?num=${NUMMER}&uuid=${uuid}`,
  );
  console.log(`Rufnummer gemeldet: ${await antwort.text()}`);
} catch {
  console.log("Rufnummer-Meldung übersprungen (HTTP-Server nicht erreichbar)");
}

const empfangen = [];
const zeitpunkte = [];
const t0 = Date.now();
let anruferEndeAt = null; // wann der Anrufer zu Ende gesprochen hat

let takt = null; // Sendetakt; muss VOR dem Auflegen gestoppt werden

const sock = net.connect(Number(process.env.AUDIOSOCKET_PORT || 8090), "127.0.0.1", () => {
  console.log(`Verbunden, Call-UUID ${uuid}`);
  sock.write(rahmen(TYPE_ID, Buffer.from(uuid.replace(/-/g, ""), "hex")));

  // Anrufer-Audio im Echtzeit-Takt, wie Asterisk es täte: erst Stille,
  // ab AB_S dann die WAV-Datei (falls angegeben).
  let gesendet = 0;
  takt = setInterval(() => {
    if (sock.destroyed || sock.writableEnded) return clearInterval(takt);
    const abSample = Math.floor(((gesendet * 20) / 1000 - AB_S) * 8000);
    let frame = Buffer.alloc(FRAME_BYTES); // Stille
    if (anruferAudio && abSample >= 0 && abSample < anruferAudio.length) {
      frame = int16ToBuf(anruferAudio.subarray(abSample, abSample + FRAME_BYTES / 2));
      if (frame.length < FRAME_BYTES) frame = Buffer.concat([frame, Buffer.alloc(FRAME_BYTES - frame.length)]);
    } else if (anruferAudio && abSample >= anruferAudio.length && anruferEndeAt === null) {
      // Ab hier schweigt der Anrufer — der Startpunkt für die Antwortzeit.
      anruferEndeAt = Date.now();
    }
    sock.write(rahmen(TYPE_AUDIO, frame));
    gesendet++;
  }, 20);
});

sock.on("error", (err) => {
  console.error(
    err.code === "ECONNREFUSED"
      ? "Kein Server auf Port 8090 — läuft `npm start` in einem zweiten Terminal?"
      : `Socket-Fehler: ${err.message}`,
  );
  process.exit(1);
});

let inbuf = Buffer.alloc(0);
sock.on("data", (chunk) => {
  inbuf = Buffer.concat([inbuf, chunk]);
  while (inbuf.length >= 3) {
    const typ = inbuf.readUInt8(0);
    const len = inbuf.readUInt16BE(1);
    if (inbuf.length < 3 + len) break;
    if (typ === TYPE_AUDIO) {
      empfangen.push(bufToInt16(inbuf.subarray(3, 3 + len)));
      zeitpunkte.push(Date.now());
    }
    inbuf = inbuf.subarray(3 + len);
  }
});

setTimeout(() => {
  console.log("Lege auf …");
  clearInterval(takt); // erst den Sendetakt stoppen, sonst „write after end"
  sock.write(rahmen(TYPE_HANGUP));
  sock.end();
  setTimeout(bericht, 500);
}, DAUER_S * 1000);

function bericht() {
  if (!empfangen.length) {
    console.error("\nKein Audio vom Server empfangen — Logs im Server-Terminal ansehen.");
    process.exit(1);
  }

  const gesamt = new Int16Array(empfangen.reduce((n, s) => n + s.length, 0));
  let pos = 0;
  for (const s of empfangen) { gesamt.set(s, pos); pos += s.length; }

  fs.mkdirSync(AUSGABE, { recursive: true });
  const datei = path.join(AUSGABE, `anruf-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}.wav`);
  schreibeWav(datei, gesamt, 8000);

  // Echtzeit-Treue des Pacers (Review-Punkt 10): Wie viel Sprache ist
  // angekommen, gemessen an der Zeit, in der sie ankam?
  //
  // Bewusst NICHT über die Abstände einzelner Frames: TCP fasst Pakete
  // zusammen, mehrere Frames landen im selben data-Event und hätten damit
  // denselben Zeitstempel. Der Vergleich Audiolänge ↔ Wanduhr ist davon
  // unabhängig. 100 % = exakt Echtzeit, deutlich unter 100 % = der Pacer
  // hinkt hinterher und der Puffer läuft voll.
  const abstaende = zeitpunkte.slice(1).map((t, i) => t - zeitpunkte[i]);
  const pausenMs = abstaende.filter((d) => d > 100).reduce((a, b) => a + b, 0);
  const spanne = zeitpunkte[zeitpunkte.length - 1] - zeitpunkte[0];
  const audioMs = (gesamt.length / 8000) * 1000;
  const treue = spanne > pausenMs ? (audioMs / (spanne - pausenMs)) * 100 : NaN;

  // Antwortzeit: vom letzten Wort des Anrufers bis zur ersten Silbe der
  // Antwort. Darin steckt alles, was der Anrufer als Warten erlebt — auch die
  // Zeit, die Gemini braucht, um das Ende des Satzes überhaupt zu erkennen.
  const ersteAntwort = anruferEndeAt ? zeitpunkte.find((t) => t > anruferEndeAt) : null;
  const antwortzeile = ersteAntwort
    ? `Antwortzeit nach dem Anrufer     ${((ersteAntwort - anruferEndeAt) / 1000).toFixed(2)} s\n`
    : "";

  console.log(`
── Ergebnis ──────────────────────────────────────────────
Stille bis zur ersten KI-Silbe   ${((zeitpunkte[0] - t0) / 1000).toFixed(2)} s
  (im echten Anruf kommt die Wait()-Zeit aus dem Dialplan dazu)
${antwortzeile}Empfangene Sprache               ${(audioMs / 1000).toFixed(1)} s
Echtzeit-Treue des Pacers        ${treue.toFixed(1)} %   (Soll ~100)
Sprechpausen (> 100 ms)          ${abstaende.filter((d) => d > 100).length}, zusammen ${(pausenMs / 1000).toFixed(1)} s
WAV                              ${datei}
──────────────────────────────────────────────────────────
Anhören: klingt die Begrüßung vollständig und sauber?
Auswertung + Notiz: siehe outbox/ und das Server-Terminal.`);
  process.exit(0);
}
