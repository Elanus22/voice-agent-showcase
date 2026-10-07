// Erzeugt die Momentaufnahme fürs Kundinnen-Dashboard: liest das
// Betriebsprotokoll (protokoll/anrufe.jsonl), rechnet es auf Monate zusammen
// und schreibt daten.json + index.html nach dashboard/ausgabe/.
//
// Läuft als periodischer Job (systemd-Timer, siehe deploy/DASHBOARD.md), NICHT
// pro Seitenaufruf. Der ausliefernde Dienst (dashboard/server.js) kennt weder
// dieses Modul noch das Protokoll — er reicht nur durch, was hier entstanden
// ist. Das ist der Grund für die Zweiteilung: Ein öffentlich erreichbarer Port
// soll keinen Codepfad haben, der Dateien liest, rechnet oder rendert.
//
//   node dashboard/bauen.js

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LOG_DATEI } from "../server/anrufLog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUSGABE_DIR = path.join(__dirname, "ausgabe");

/* ─────────────────────────────── Preise ──────────────────────────────────
 *
 * Stand 19.08.2026 von ai.google.dev/gemini-api/docs/pricing für
 * gemini-3.1-flash-live-preview, Paid Tier, USD je 1 Mio. Token. Bewusst über
 * die .env änderbar: Preise eines Preview-Modells ändern sich, und dann soll
 * niemand dafür Code anfassen müssen.
 *
 * Das Verhältnis ist der eigentliche Punkt — gesprochene Antworten kosten das
 * Sechzehnfache von eingehendem Text. Deshalb wird nach Modalität getrennt
 * gerechnet und nicht über eine Gesamtsumme.
 */
const PREISE = {
  einText: Number(process.env.PREIS_EIN_TEXT_USD || 0.75),
  einAudio: Number(process.env.PREIS_EIN_AUDIO_USD || 3.0),
  ausText: Number(process.env.PREIS_AUS_TEXT_USD || 4.5),
  ausAudio: Number(process.env.PREIS_AUS_AUDIO_USD || 12.0),
};
const USD_EUR = Number(process.env.USD_EUR_KURS || 0.92);

export function kostenEuro(satz) {
  const usd =
    (satz.einText * PREISE.einText +
      satz.einAudio * PREISE.einAudio +
      satz.ausText * PREISE.ausText +
      satz.ausAudio * PREISE.ausAudio) /
    1e6;
  return usd * USD_EUR;
}

/* ──────────────────────────── Zusammenrechnen ────────────────────────────*/

const MONAT_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
});

/** ISO-Zeitstempel → "2026-08" in Berliner Zeit. */
function monatVon(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return MONAT_FMT.format(d).slice(0, 7);
}

const MONATSNAMEN = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

export function monatName(schluessel) {
  const [jahr, monat] = schluessel.split("-");
  return `${MONATSNAMEN[Number(monat) - 1]} ${jahr}`;
}

/**
 * Zeilen → Monatsblöcke, neuester zuerst. Unlesbare Zeilen werden übersprungen
 * statt den ganzen Lauf abzubrechen: Ein abgeschnittener Anhang (Absturz mitten
 * im Schreiben) darf nicht die Auswertung von zwei Jahren kosten.
 */
export function fasseZusammen(zeilen) {
  const monate = new Map();
  let uebersprungen = 0;

  for (const zeile of zeilen) {
    const text = zeile.trim();
    if (!text) continue;
    let s;
    try {
      s = JSON.parse(text);
    } catch {
      uebersprungen++;
      continue;
    }
    const monat = monatVon(s.zeit);
    if (!monat) {
      uebersprungen++;
      continue;
    }
    if (!monate.has(monat)) {
      monate.set(monat, {
        monat,
        name: monatName(monat),
        anrufe: 0,
        sekunden: 0,
        weiterleitungen: 0,
        kosten: 0,
        geschaetzteAnrufe: 0,
      });
    }
    const m = monate.get(monat);
    m.anrufe++;
    m.sekunden += Number(s.dauer) || 0;
    if (s.weitergeleitet === true) m.weiterleitungen++;
    if (s.geschaetzt === true) m.geschaetzteAnrufe++;
    m.kosten += kostenEuro({
      einText: Number(s.einText) || 0,
      einAudio: Number(s.einAudio) || 0,
      ausText: Number(s.ausText) || 0,
      ausAudio: Number(s.ausAudio) || 0,
    });
  }

  const liste = [...monate.values()].sort((a, b) => b.monat.localeCompare(a.monat));
  for (const m of liste) m.schnitt = m.anrufe ? m.sekunden / m.anrufe : 0;
  return { monate: liste, uebersprungen };
}

/* ──────────────────────────── Darstellung ────────────────────────────────*/

export function dauerText(sekunden) {
  const s = Math.round(sekunden);
  if (s < 60) return `${s} Sek.`;
  const min = Math.floor(s / 60);
  const rest = s % 60;
  if (min < 60) return rest ? `${min} Min. ${rest} Sek.` : `${min} Min.`;
  const std = Math.floor(min / 60);
  const restMin = min % 60;
  return restMin ? `${std} Std. ${restMin} Min.` : `${std} Std.`;
}

const euro = (n) => n.toLocaleString("de-DE", { style: "currency", currency: "EUR" });

// Die Seite bekommt ausschließlich Zahlen und feste Monatsnamen aus diesem
// Modul — keine Zeichenkette aus einem Anruf. Trotzdem maskieren: Es kostet
// nichts, und die Annahme „hier kommt nie Fremdtext an" ist genau die, die bei
// der nächsten Erweiterung stillschweigend verletzt wird.
const esc = (v) =>
  String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function kachel(bezeichnung, wert, zusatz = "") {
  return `<div class="kachel"><span class="bez">${esc(bezeichnung)}</span>` +
    `<strong>${esc(wert)}</strong>` +
    (zusatz ? `<span class="zusatz">${esc(zusatz)}</span>` : "") +
    "</div>";
}

export function baueHtml({ monate, uebersprungen }, stand) {
  const jetzt = monate[0];
  const standText = stand.toLocaleString("de-DE", {
    timeZone: "Europe/Berlin",
    dateStyle: "long",
    timeStyle: "short",
  });

  const kacheln = jetzt
    ? [
        kachel("Anrufe", String(jetzt.anrufe)),
        kachel("Gesamte Gesprächszeit", dauerText(jetzt.sekunden)),
        kachel("Durchschnitt je Anruf", dauerText(jetzt.schnitt)),
        kachel("Ans Büro weitergeleitet", String(jetzt.weiterleitungen)),
        kachel("Geschätzte Kosten", euro(jetzt.kosten), "Näherung, siehe unten"),
      ].join("")
    : '<p class="leer">Bisher wurden keine Anrufe aufgezeichnet.</p>';

  const zeilen = monate
    .map(
      (m) =>
        `<tr><th scope="row">${esc(m.name)}</th>` +
        `<td>${esc(m.anrufe)}</td>` +
        `<td>${esc(dauerText(m.sekunden))}</td>` +
        `<td>${esc(dauerText(m.schnitt))}</td>` +
        `<td>${esc(m.weiterleitungen)}</td>` +
        `<td>${esc(euro(m.kosten))}</td></tr>`,
    )
    .join("");

  const tabelle = monate.length
    ? `<div class="scroll"><table>
      <caption>Alle bisher erfassten Monate</caption>
      <thead><tr><th scope="col">Monat</th><th scope="col">Anrufe</th>
      <th scope="col">Gesprächszeit</th><th scope="col">Ø je Anruf</th>
      <th scope="col">Weitergeleitet</th><th scope="col">Kosten (ca.)</th></tr></thead>
      <tbody>${zeilen}</tbody></table></div>`
    : "";

  const hinweisGeschaetzt =
    jetzt && jetzt.geschaetzteAnrufe > 0
      ? `<li>Bei ${esc(jetzt.geschaetzteAnrufe)} von ${esc(jetzt.anrufe)} Anrufen ` +
        "dieses Monats ließ sich der genaue Verbrauch nicht ermitteln — dort wurde " +
        "aus der Gesprächsdauer hochgerechnet.</li>"
      : "";

  const hinweisUebersprungen = uebersprungen
    ? `<li>${esc(uebersprungen)} unlesbare Protokollzeile(n) wurden übergangen.</li>`
    : "";

  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Tanzschule Muster — Telefon-Assistentin</title>
<style>
  :root {
    --grund: #faf8f6; --karte: #ffffff; --text: #1e1b19; --leise: #6b625c;
    --linie: #e3ddd8; --akzent: #8a1c3b;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --grund: #171514; --karte: #201d1c; --text: #f2eeeb; --leise: #a9a09a;
      --linie: #35302e; --akzent: #e8859f;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 1.25rem 4rem;
    background: var(--grund); color: var(--text);
    font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  main { max-width: 60rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; letter-spacing: .01em; }
  h2 { font-size: 1.1rem; margin: 2.5rem 0 .75rem; font-weight: 600; }
  .stand { color: var(--leise); font-size: .875rem; margin: 0 0 2rem; }
  .kacheln { display: grid; gap: .75rem; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); }
  .kachel {
    background: var(--karte); border: 1px solid var(--linie); border-radius: .625rem;
    padding: 1rem; display: flex; flex-direction: column; gap: .25rem;
  }
  .kachel .bez { color: var(--leise); font-size: .8125rem; }
  .kachel strong { font-size: 1.65rem; font-weight: 650; line-height: 1.15; color: var(--akzent); }
  .kachel .zusatz { color: var(--leise); font-size: .75rem; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; min-width: 34rem; background: var(--karte); }
  caption { text-align: left; color: var(--leise); font-size: .8125rem; padding-bottom: .5rem; }
  th, td { padding: .6rem .75rem; text-align: right; border-bottom: 1px solid var(--linie); }
  thead th { text-align: right; font-size: .8125rem; color: var(--leise); font-weight: 600; }
  th[scope="row"], thead th:first-child { text-align: left; }
  tbody tr:first-child { font-weight: 600; }
  .fuss { color: var(--leise); font-size: .8125rem; margin-top: 2.5rem; padding-left: 1.1rem; }
  .fuss li { margin-bottom: .4rem; }
  .leer { color: var(--leise); }
</style>
</head>
<body>
<main>
  <h1>Telefon-Assistentin — Übersicht</h1>
  <p class="stand">Stand: ${esc(standText)} Uhr${jetzt ? " · Zahlen oben: " + esc(jetzt.name) : ""}</p>

  <div class="kacheln">${kacheln}</div>

  ${tabelle ? "<h2>Verlauf</h2>" + tabelle : ""}

  <ul class="fuss">
    <li>„Ans Büro weitergeleitet" zählt die Anrufe, bei denen die Assistentin an
        das Bürotelefon durchgestellt hat — auf Wunsch der anrufenden Person
        oder weil sie nicht weiterwusste.</li>
    <li>Die Kostenangabe ist eine <strong>Näherung</strong> aus den
        Gesprächszeiten, keine Rechnung. Der tatsächliche Betrag steht in der
        Abrechnung von Google und kann abweichen.</li>
    ${hinweisGeschaetzt}
    ${hinweisUebersprungen}
    <li>Diese Seite wird regelmäßig neu erzeugt und enthält keine Angaben zu
        einzelnen Anrufenden — weder Namen noch Rufnummern noch Gesprächsinhalte.</li>
  </ul>
</main>
</body>
</html>
`;
}

/* ─────────────────────────────── Ausführen ───────────────────────────────*/

function main() {
  let inhalt = "";
  try {
    inhalt = fs.readFileSync(LOG_DATEI, "utf8");
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
    console.warn(`[dashboard] ${LOG_DATEI} gibt es noch nicht — leere Seite erzeugt.`);
  }

  const stand = new Date();
  const ergebnis = fasseZusammen(inhalt.split("\n"));

  fs.mkdirSync(AUSGABE_DIR, { recursive: true, mode: 0o750 });
  fs.writeFileSync(
    path.join(AUSGABE_DIR, "daten.json"),
    JSON.stringify({ stand: stand.toISOString(), ...ergebnis }, null, 2),
    { encoding: "utf8", mode: 0o640 },
  );
  fs.writeFileSync(path.join(AUSGABE_DIR, "index.html"), baueHtml(ergebnis, stand), {
    encoding: "utf8",
    mode: 0o640,
  });

  const gesamt = ergebnis.monate.reduce((n, m) => n + m.anrufe, 0);
  console.log(
    `[dashboard] ${gesamt} Anrufe in ${ergebnis.monate.length} Monat(en) ausgewertet` +
      (ergebnis.uebersprungen ? `, ${ergebnis.uebersprungen} Zeile(n) übersprungen` : "") +
      ` → ${AUSGABE_DIR}`,
  );
}

// Nur ausführen, wenn direkt aufgerufen — die Prüfskripte importieren die
// Funktionen oben, ohne dass dabei Dateien entstehen sollen.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
