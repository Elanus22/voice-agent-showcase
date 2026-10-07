// A/B-Hörtest für den Anti-Aliasing-Tiefpass (Review-Punkt 11).
//
// Holt einen gesprochenen Satz von der echten Live-API (24 kHz) und schreibt
// drei WAV-Dateien in pruef/audio/:
//
//   1-original-24k.wav   was Gemini liefert (Referenz, volle Bandbreite)
//   2-ohne-filter-8k.wav wie es VOR dem Fix am Telefon klang
//   3-mit-filter-8k.wav  wie es JETZT klingt
//
// Hör 2 und 3 direkt hintereinander. Achte auf Zischlaute („Schnupperstunde",
// „Sie"): 2 klingt blechern/rau, 3 soll runder klingen. Klingt 3 dumpf und
// matschig, ist der Filter zu scharf — dann Grenzfrequenz in audio.js von
// 3400 auf 3800 Hz hoch.
//
// ACHTUNG: ruft die echte API, kostet ein paar Cent pro Lauf.
//
//   node pruef/klang.mjs
//   node pruef/klang.mjs "Ein eigener Satz zum Vorlesen"

import "./_env.mjs";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { connectLive } from "../server/live.js";
import { bufToInt16, int16ToBuf, resampleLinear, createTelefonTiefpass } from "../server/audio.js";

const AUSGABE = path.join(path.dirname(fileURLToPath(import.meta.url)), "audio");

const SATZ =
  process.argv[2] ||
  "(Sprich bitte genau diesen Satz, ohne Zusatz: Herzlich willkommen bei der Tanzschule " +
    "Muster. Sie erreichen unsere Schnupperstunden immer samstags, und für " +
    "Fragen zu Kursen sind wir gerne für Sie da.)";

/** Minimaler WAV-Kopf für 16-bit Mono PCM. */
function schreibeWav(datei, samples, rate) {
  const daten = int16ToBuf(samples);
  const kopf = Buffer.alloc(44);
  kopf.write("RIFF", 0);
  kopf.writeUInt32LE(36 + daten.length, 4);
  kopf.write("WAVEfmt ", 8);
  kopf.writeUInt32LE(16, 16); // fmt-Chunk-Länge
  kopf.writeUInt16LE(1, 20); // PCM
  kopf.writeUInt16LE(1, 22); // mono
  kopf.writeUInt32LE(rate, 24);
  kopf.writeUInt32LE(rate * 2, 28); // Byte pro Sekunde
  kopf.writeUInt16LE(2, 32); // Blockgröße
  kopf.writeUInt16LE(16, 34); // Bit pro Sample
  kopf.write("data", 36);
  kopf.writeUInt32LE(daten.length, 40);
  fs.writeFileSync(datei, Buffer.concat([kopf, daten]));
  return daten.length / 2 / rate;
}

const stuecke = [];

const session = await connectLive({
  onMessage: (msg) => {
    for (const part of msg.serverContent?.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) stuecke.push(bufToInt16(Buffer.from(part.inlineData.data, "base64")));
    }
    if (msg.serverContent?.turnComplete) fertig();
  },
  onError: (err) => {
    console.error("Live-Fehler:", err?.message || err);
    process.exit(1);
  },
});

console.log("Session offen, lasse den Satz sprechen …");
session.sendClientContent({ turns: [{ role: "user", parts: [{ text: SATZ }] }], turnComplete: true });

// Notausstieg, falls turnComplete nie kommt.
const notaus = setTimeout(() => {
  console.error("Timeout: keine vollständige Antwort nach 60 s");
  process.exit(1);
}, 60000);

function fertig() {
  clearTimeout(notaus);
  try { session.close(); } catch {}

  const gesamt = new Int16Array(stuecke.reduce((n, s) => n + s.length, 0));
  let pos = 0;
  for (const s of stuecke) { gesamt.set(s, pos); pos += s.length; }

  if (!gesamt.length) {
    console.error("Das Modell hat kein Audio geliefert.");
    process.exit(1);
  }

  fs.mkdirSync(AUSGABE, { recursive: true });
  const sek = schreibeWav(path.join(AUSGABE, "1-original-24k.wav"), gesamt, 24000);
  schreibeWav(path.join(AUSGABE, "2-ohne-filter-8k.wav"), resampleLinear(gesamt, 24000, 8000), 8000);
  schreibeWav(
    path.join(AUSGABE, "3-mit-filter-8k.wav"),
    resampleLinear(createTelefonTiefpass(24000)(gesamt), 24000, 8000),
    8000,
  );

  console.log(`\n${sek.toFixed(1)} s Sprache geschrieben nach ${AUSGABE}`);
  console.log("Vergleiche 2-ohne-filter-8k.wav gegen 3-mit-filter-8k.wav.");
  process.exit(0);
}
