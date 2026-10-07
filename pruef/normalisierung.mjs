// Verifikation für Review-Punkt 13 (Normalisierung gesprochener Kontaktdaten).
// Ruft die ECHTE Gemini-API, kostet Token, braucht GEMINI_API_KEY — läuft
// deshalb bewusst NICHT in technik.test.mjs mit, die soll kostenlos und ohne
// Netz durchlaufen. Von Hand starten, wenn sich am Extraktions-Prompt oder am
// Schema etwas ändert:
//   node pruef/normalisierung.mjs
import "dotenv/config";
import { extractCallData } from "../server/gemini.js";

const faelle = [
  {
    name: "Diktat ohne Rückfrage",
    erwartet: { email: "max.mueller@gmail.de", phone: "01234567890" },
    transkript: `
Assistent: Tanzschule Muster, wie kann ich helfen?
Anrufer: Hallo, ich wollte fragen wegen einer Schnupperstunde für meine Tochter, sie ist sechs.
Assistent: Gerne, dafür bräuchte ich noch Ihre Kontaktdaten.
Anrufer: Klar, meine E-Mail ist max punkt mueller at gmail punkt de.
Assistent: Und eine Telefonnummer für Rückfragen?
Anrufer: Null zwölf vierunddreißig, sechsundfünfzig siebenundachtzig neunzig.
Assistent: Danke, wir melden uns.`,
  },
  {
    name: "Umlaut + Rücklesen mit Korrektur",
    erwartet: { email: "a.schroeder@web.de", phone: "01715550123" },
    transkript: `
Assistent: Tanzschule Muster, wie kann ich helfen?
Anrufer: Ich hätte gern einen Schnuppertermin im Ballett für meine Tochter Lena.
Assistent: Darf ich Ihre E-Mail-Adresse notieren?
Anrufer: Ja, a punkt schröder at web punkt de.
Assistent: Ich lese kurz zurück: A Punkt S-C-H-R-Ö-D-E-R at web punkt de. Stimmt das so?
Anrufer: Fast, das ö schreibt sich o e, also s c h r o e d e r.
Assistent: Alles klar: A Punkt S-C-H-R-O-E-D-E-R at web punkt de. Und eine Rufnummer?
Anrufer: Null eins sieben eins, fünf fünf fünf null eins zwei drei.
Assistent: Null eins sieben eins, fünf fünf fünf, null eins zwei drei — richtig?
Anrufer: Genau.`,
  },
];

for (const fall of faelle) {
  const ergebnis = await extractCallData(fall.transkript.trim());
  const ok = (feld) => (ergebnis[feld] === fall.erwartet[feld] ? "✓" : `✗ erwartet ${fall.erwartet[feld]}`);
  console.log(`\n── ${fall.name} ──`);
  console.log(`email: ${ergebnis.email}  ${ok("email")}`);
  console.log(`phone: ${ergebnis.phone}  ${ok("phone")}`);
  if (ergebnis._pruefung) console.log("Prüfhinweise:", ergebnis._pruefung);
}
