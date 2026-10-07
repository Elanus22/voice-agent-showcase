// Datenschicht: lädt Stundenplan, Ferien und Einstellungen aus den CSV-
// Dateien in daten/ — den einzigen Dateien, die die Tanzschule selbst pflegt.
//
// Warum CSV und nicht im Code: Kurszeiten und Ferien ändern sich jedes
// Schuljahr. Standen sie im Code, wäre für jede Änderung ein Deployment
// nötig — und genau deshalb veralten sie. Die CSVs lassen sich in Excel
// öffnen und per SFTP zurückspielen.
//
// Drei Eigenschaften, auf die es hier ankommt:
//   1. HOT-RELOAD  — geänderte Dateien werden beim nächsten Zugriff neu
//      gelesen (Vergleich der mtime). Kein Neustart nötig.
//   2. LAST-GOOD   — ist eine Datei kaputt (Excel-Unfall, halb hochgeladen),
//      bleibt der zuletzt gültige Stand aktiv. Ein Anruf darf nie an einer
//      verunglückten CSV scheitern.
//   3. GÜLTIGKEIT  — der Stundenplan hat ein Ablaufdatum. Danach nennt die
//      KI KEINE Zeiten mehr, sondern verbindet weiter. Ein veralteter Plan
//      klingt für den Anrufer völlig richtig und ist deshalb gefährlicher
//      als gar kein Plan (siehe schedule.js).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATEN_DIR = path.join(__dirname, "..", "daten");

const TAGE = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];

// Erlaubte Tanzarten. Steht eine Art in der CSV, die hier fehlt, ist das ein
// Tippfehler — die Zeile wird abgewiesen statt still ins Leere zu laufen.
const ARTEN = ["Ballett", "TFE", "Jazz", "Contemporary", "Urban", "HipHop"];

const ZEIT_RE = /^(\d{1,2}):(\d{2})(?::\d{2})?$/; // 15:45 und Excels 15:45:00
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const DE_DATUM_RE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/; // Excels 03.08.2026

/* ─────────────────────────── CSV-Parser ─────────────────────────── */

/**
 * Minimaler CSV-Parser für das, was Excel tatsächlich produziert:
 * Semikolon als Trenner, "..." als Quotierung, "" als escaptes Anführungs-
 * zeichen, CRLF oder LF. Leerzeilen und #-Kommentarzeilen fallen raus.
 *
 * Eine Quotierung endet spätestens am Zeilenende — siehe die Begründung unten
 * im Schleifenrumpf. Exportiert, damit sich das ohne Dateizugriff prüfen lässt
 * (pruef/technik.test.mjs).
 */
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM (Excel)
  const zeilen = [];
  let feld = "";
  let zeile = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      // Ein Zeilenumbruch INNERHALB einer Quotierung bedeutet hier immer:
      // Das Anführungszeichen war überzählig — ein Zoll-Zeichen (5" ), ein aus
      // Word kopiertes typografisches Zeichen, ein Tippfehler.
      //
      // Ohne diesen Zweig verschluckte ein einziges solches Zeichen den
      // gesamten Rest der Datei: Gemessen wurden aus sechs Kurszeilen zwei,
      // gemeldet als ein einziger Fehler in der falschen Zeile und mit dem
      // falschen Grund. Das Last-Good-Netz weiter unten greift dabei NICHT,
      // weil es nur bei null gültigen Zeilen anspringt — der Teilausfall
      // rutscht als gültiger Stand durch, und die KI liest den Rest des
      // Stundenplans als vollständigen Plan vor.
      //
      // daten/ANLEITUNG.md sagt der Kundin zu: "Wenn eine Zeile nicht stimmt,
      // wird nur diese eine Zeile übersprungen." Also hier die Quotierung
      // beenden und die Zeile normal abschließen — sie scheitert dann an der
      // Validierung, mit der richtigen Zeilennummer im Fehlertext.
      //
      // Preis: Ein Feld darf keinen echten Zeilenumbruch mehr enthalten. Keine
      // Spalte in kurse.csv, ferien.csv oder einstellungen.csv braucht das.
      if (c === "\n") {
        inQuotes = false;
        zeile.push(feld); zeilen.push(zeile); zeile = []; feld = "";
        continue;
      }
      if (c === '"') {
        if (text[i + 1] === '"') { feld += '"'; i++; }
        else inQuotes = false;
      } else feld += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ";") { zeile.push(feld); feld = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { zeile.push(feld); zeilen.push(zeile); zeile = []; feld = ""; continue; }
    feld += c;
  }
  zeile.push(feld);
  zeilen.push(zeile);

  return zeilen
    .map((z) => z.map((f) => f.trim()))
    .filter((z) => z.some((f) => f !== "") && !z[0].startsWith("#"));
}

/** CSV mit Kopfzeile → Array von Objekten (Spaltennamen kleingeschrieben). */
function parseCsvMitKopf(text) {
  const zeilen = parseCsv(text);
  if (!zeilen.length) return [];
  const kopf = zeilen[0].map((h) => h.toLowerCase());
  return zeilen.slice(1).map((z, i) => {
    const obj = { _zeile: i + 2 }; // +2: Kopfzeile + 1-basiert, passt zu Excel
    kopf.forEach((h, j) => { obj[h] = z[j] ?? ""; });
    return obj;
  });
}

/* ─────────────────────── Feld-Umwandlungen ──────────────────────── */

// "ja" / "x" / "1" / "wahr" → true. Alles andere (auch leer) → false.
const jaNein = (v) => /^(ja|j|x|1|true|wahr)$/i.test(String(v || "").trim());

// Akzeptiert deutsches Komma ("7,5") wie auch "7.5" — Excel schreibt je nach
// Ländereinstellung das eine oder das andere.
function zahl(v) {
  const s = String(v || "").trim().replace(",", ".");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

// "15:45" → "15:45"; "9:15" → "09:15"; "15:45:00" → "15:45".
// Die Sekunden-Variante schreibt Excel, wenn es die Spalte als Uhrzeit
// formatiert hat — sie darf die Datei nicht unbrauchbar machen.
function zeit(v) {
  const t = ZEIT_RE.exec(String(v || "").trim());
  if (!t) return null;
  const h = Number(t[1]);
  const m = Number(t[2]);
  if (h > 23 || m > 59) return null;
  return `${String(h).padStart(2, "0")}:${t[2]}`;
}

// Datum → ISO "JJJJ-MM-TT". Akzeptiert zusätzlich das deutsche Format
// "03.08.2026", weil Excel mit deutscher Ländereinstellung ISO-Datümer beim
// Speichern genau dorthin umschreibt.
//
// Geprüft wird der KALENDER, nicht nur die Form — und das ist kein Feinschliff:
// Der wahrscheinlichste Tippfehler beim Schuljahreswechsel ist der Dreher
// "2026-14-09" statt "2026-09-14". Der passt auf ISO_RE, macht in planStatus()
// aus tageBisAblauf ein NaN (womit JEDE numerische Warnschwelle stillschweigend
// nicht mehr feuert: index.js, schedule.js, systemPrompt.js) und gilt im
// lexikalischen Vergleich bis 2027-01-01 als gültig. Die Ablaufsperre des
// Stundenplans wäre damit lautlos abgeschaltet, und die KI nennt Kurszeiten
// eines Plans, den es nicht mehr gibt — genau der Fall, gegen den die Sperre
// überhaupt gebaut wurde.
//
// Unbrauchbares gibt null zurück; planStatus() behandelt ein fehlendes Datum
// bereits als abgelaufen, der sichere Ausgang ist also schon da.
export function datum(v) {
  const s = String(v || "").trim();
  let iso = null;
  if (ISO_RE.test(s)) iso = s;
  else {
    const d = DE_DATUM_RE.exec(s);
    if (d) iso = `${d[3]}-${d[2].padStart(2, "0")}-${d[1].padStart(2, "0")}`;
  }
  if (!iso) return null;

  // Date.UTC rollt Unmögliches klaglos weiter (31.02. → 03.03., Monat 14 → ins
  // Folgejahr). Wer zurückformatiert und vergleicht, merkt genau das.
  const [j, m, t] = iso.split("-").map(Number);
  const probe = new Date(Date.UTC(j, m - 1, t));
  if (!Number.isFinite(probe.getTime())) return null;
  return probe.toISOString().slice(0, 10) === iso ? iso : null;
}

/* ─────────────────────── Validierung je Datei ───────────────────── */

// Fehler notieren und die Zeile verwerfen. Bewusst über diesen Helfer statt
// direkt über ein `return fehler.push(...)`: push() liefert die neue Array-
// LÄNGE zurück, also eine truthy Zahl — das anschließende filter(Boolean)
// würde die verworfene Zeile als Zahl in den Datenbestand durchlassen.
function verwirf(fehler, text) {
  fehler.push(text);
  return null;
}

function validiereKurs(r, fehler) {
  const wo = `kurse.csv Zeile ${r._zeile}`;
  const tag = TAGE.find((t) => t.toLowerCase() === String(r.tag || "").trim().toLowerCase());
  if (!tag) return verwirf(fehler, `${wo}: Wochentag "${r.tag}" unbekannt (erlaubt: ${TAGE.join(", ")})`);

  const von = zeit(r.von);
  const bis = zeit(r.bis);
  if (!von) return verwirf(fehler, `${wo}: Uhrzeit "von" = "${r.von}" ist nicht im Format HH:MM`);
  if (!bis) return verwirf(fehler, `${wo}: Uhrzeit "bis" = "${r.bis}" ist nicht im Format HH:MM`);
  if (bis <= von) return verwirf(fehler, `${wo}: "bis" (${bis}) liegt nicht nach "von" (${von})`);

  const kurs = String(r.kurs || "").trim();
  if (!kurs) return verwirf(fehler, `${wo}: Spalte "kurs" ist leer`);

  const arten = String(r.tanzarten || "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  if (!arten.length) return verwirf(fehler, `${wo}: Spalte "tanzarten" ist leer`);
  const unbekannt = arten.filter((a) => !ARTEN.includes(a));
  if (unbekannt.length)
    return verwirf(fehler, `${wo}: Tanzart "${unbekannt.join(", ")}" unbekannt (erlaubt: ${ARTEN.join(", ")})`);

  const altVon = zahl(r.alter_von);
  const altBis = zahl(r.alter_bis);
  if (altVon === null || Number.isNaN(altVon))
    return verwirf(fehler, `${wo}: "alter_von" = "${r.alter_von}" ist keine Zahl`);
  if (Number.isNaN(altBis)) return verwirf(fehler, `${wo}: "alter_bis" = "${r.alter_bis}" ist keine Zahl`);
  if (altBis !== null && altBis < altVon)
    return verwirf(fehler, `${wo}: "alter_bis" (${altBis}) ist kleiner als "alter_von" (${altVon})`);

  return {
    tag, von, bis, kurs, arten,
    altVon, altBis,
    erwachsene: jaNein(r.nur_erwachsene),
    voll: jaNein(r.ausgebucht),
  };
}

function validiereFerien(r, fehler) {
  const wo = `ferien.csv Zeile ${r._zeile}`;
  const name = String(r.name || "").trim();
  const von = datum(r.von);
  const bis = datum(r.bis);
  if (!name) return verwirf(fehler, `${wo}: Spalte "name" ist leer`);
  if (!von) return verwirf(fehler, `${wo}: "von" = "${r.von}" ist kein Datum (JJJJ-MM-TT oder TT.MM.JJJJ)`);
  if (!bis) return verwirf(fehler, `${wo}: "bis" = "${r.bis}" ist kein Datum (JJJJ-MM-TT oder TT.MM.JJJJ)`);
  if (bis < von) return verwirf(fehler, `${wo}: "bis" (${bis}) liegt vor "von" (${von})`);
  return { name, von, bis };
}

/* ────────────────── Laden mit Cache und Last-Good ────────────────── */

const cache = new Map(); // datei → { mtimeMs, werte, fehler }

/**
 * Liest eine CSV, wenn sie sich geändert hat. Bei Parse-/Validierungsfehlern
 * bleibt der letzte gültige Stand aktiv (und die Fehler werden gemeldet) —
 * eine kaputte Datei darf keinen Anruf abbrechen.
 */
function ladeDatei(datei, validiere) {
  const pfad = path.join(DATEN_DIR, datei);
  const bisher = cache.get(datei);

  let stat;
  try {
    stat = fs.statSync(pfad);
  } catch {
    const eintrag = { mtimeMs: 0, werte: bisher?.werte ?? [], fehler: [`${datei} nicht gefunden (erwartet in daten/)`] };
    cache.set(datei, eintrag);
    return eintrag;
  }

  if (bisher && bisher.mtimeMs === stat.mtimeMs) return bisher;

  const fehler = [];
  let werte = [];
  try {
    const rohzeilen = parseCsvMitKopf(fs.readFileSync(pfad, "utf8"));
    werte = rohzeilen.map((r) => validiere(r, fehler)).filter(Boolean);
  } catch (err) {
    fehler.push(`${datei} konnte nicht gelesen werden: ${err.message}`);
  }

  // Komplett leer trotz vorhandener Datei = vermutlich kaputt → alten Stand halten.
  if (!werte.length && bisher?.werte?.length) {
    console.error(`[daten] ${datei} liefert keine gültigen Zeilen — behalte den letzten funktionierenden Stand.`);
    fehler.forEach((f) => console.error("[daten]  · " + f));
    const eintrag = { mtimeMs: stat.mtimeMs, werte: bisher.werte, fehler };
    cache.set(datei, eintrag);
    return eintrag;
  }

  if (fehler.length) {
    console.error(`[daten] ${datei}: ${fehler.length} Zeile(n) übersprungen —`);
    fehler.forEach((f) => console.error("[daten]  · " + f));
  }

  const eintrag = { mtimeMs: stat.mtimeMs, werte, fehler };
  cache.set(datei, eintrag);
  return eintrag;
}

/* ───────────────────────── Öffentliche API ──────────────────────── */

export function getKurse() {
  return ladeDatei("kurse.csv", validiereKurs).werte;
}

export function getFerien() {
  return ladeDatei("ferien.csv", validiereFerien).werte;
}

/** einstellungen.csv → Map schluessel → wert. */
export function getEinstellungen() {
  const eintrag = ladeDatei("einstellungen.csv", (r, fehler) => {
    const schluessel = String(r.schluessel || "").trim().toLowerCase();
    if (!schluessel) return verwirf(fehler, `einstellungen.csv Zeile ${r._zeile}: "schluessel" ist leer`);
    return { schluessel, wert: String(r.wert || "").trim() };
  });
  return Object.fromEntries(eintrag.werte.map((e) => [e.schluessel, e.wert]));
}

/**
 * Gültigkeitsstatus des Stundenplans. `abgelaufen` ist die Angabe, auf die
 * es ankommt: ab dann darf die KI keine Kurszeiten mehr nennen.
 */
export function planStatus(heuteIso) {
  const gueltigBis = datum(getEinstellungen().stundenplan_gueltig_bis);
  if (!gueltigBis) {
    // Fehlt das Datum, behandeln wir den Plan als abgelaufen. Lieber ehrlich
    // "kann ich gerade nicht nachsehen" als selbstbewusst falsche Zeiten.
    return { gueltigBis: null, abgelaufen: true, tageBisAblauf: null, grund: "kein_datum" };
  }
  const tage = Math.round((Date.parse(gueltigBis + "T00:00:00Z") - Date.parse(heuteIso + "T00:00:00Z")) / 86400000);
  return { gueltigBis, abgelaufen: heuteIso > gueltigBis, tageBisAblauf: tage, grund: null };
}

/** Sammelt alle offenen Datenfehler (für den Startup-Check). */
export function datenFehler() {
  return [
    ...ladeDatei("kurse.csv", validiereKurs).fehler,
    ...ladeDatei("ferien.csv", validiereFerien).fehler,
  ];
}
