// Technische Funktionsprüfung — OHNE API, ohne Netz, ohne Kosten.
// Läuft in Sekunden und prüft die Stellen, die still kaputtgehen können.
//
//   node --test pruef/
//
// Bewusst kein Test-Framework: node:test ist in Node eingebaut, es gibt keine
// Dependency und keine Config-Datei zu pflegen.

import "./_env.mjs"; // muss vor den server/-Importen stehen

import test from "node:test";
import assert from "node:assert/strict";

import { validiereExtraktion } from "../server/gemini.js";
import { createTelefonTiefpass, resampleLinear } from "../server/audio.js";
import { faelligeFrames, nimmAbschluss } from "../server/phone.js";
import { normalisiereArt, findeKurse, stundenplanStatus } from "../server/schedule.js";
import { datum, parseCsv } from "../server/daten.js";
import { reconnectBuchfuehrung } from "../server/live.js";
import { leereNutzung, verrechneNutzung, nutzungAusDauer } from "../server/anrufLog.js";
import { fasseZusammen, kostenEuro, dauerText } from "../dashboard/bauen.js";

/* ── Validierung der Extraktion ───────────────────────────────────────────
   Hier hängt die Richtigkeit JEDER Büro-Mail dran: Was diese Funktion
   durchlässt, liest Maria als Tatsache. */

test("E-Mail: gültige Adresse bleibt, wird kleingeschrieben", () => {
  const d = validiereExtraktion({ email: "Max.Mueller@GMail.de" });
  assert.equal(d.email, "max.mueller@gmail.de");
  assert.equal(d._pruefung, undefined);
});

test("E-Mail: unbrauchbares wird verworfen UND vermerkt", () => {
  const d = validiereExtraktion({ email: "max punkt mueller at gmail" });
  assert.equal(d.email, null);
  // Nicht stillschweigend schlucken — sonst fehlt das Feld kommentarlos.
  assert.match(d._pruefung.join(" "), /E-Mail/);
});

test("Telefon: Trennzeichen raus, Ziffernfolge bleibt", () => {
  assert.equal(validiereExtraktion({ phone: "01234 / 56 78 90" }).phone, "01234567890");
  assert.equal(validiereExtraktion({ phone: "0171-555 01 23" }).phone, "01715550123");
});

test("Telefon: (0) nach der Ländervorwahl fliegt raus", () => {
  // Bleibt es stehen, steht in der Mail eine Nummer, die sich nicht wählen lässt.
  assert.equal(validiereExtraktion({ phone: "+49 (0)9081 123456" }).phone, "+499081123456");
});

test("Telefon: Unplausibles wird verworfen und vermerkt", () => {
  const d = validiereExtraktion({ phone: "keine Ahnung" });
  assert.equal(d.phone, null);
  assert.match(d._pruefung.join(" "), /Telefonnummer/);
});

test("Uhrzeit: wird auf HH:MM normalisiert, Unsinn fällt raus", () => {
  assert.equal(validiereExtraktion({ time_start: "9.15" }).time_start, "09:15");
  assert.equal(validiereExtraktion({ time_start: "25:99" }).time_start, null);
});

test("Wochentag: nur echte Unterrichtstage", () => {
  assert.equal(validiereExtraktion({ weekday: "Montag" }).weekday, "Montag");
  assert.equal(validiereExtraktion({ weekday: "Sonntag" }).weekday, null);
});

test("Intent: Unbekanntes landet als sonstiges, mit Hinweis", () => {
  const d = validiereExtraktion({ intent: "erfundenes_anliegen" });
  assert.equal(d.intent, "sonstiges");
  assert.match(d._pruefung.join(" "), /Anliegen/);
});

test("Freitext: Steuerzeichen und Umbrüche fliegen aus Einzeilern", () => {
  // CRLF im Namen wäre der Einstieg für Header-Injection in der Mail.
  const d = validiereExtraktion({ caller_name: "Max\r\nBcc: fremd@example.com" });
  assert.ok(!d.caller_name.includes("\n"));
  assert.ok(!d.caller_name.includes("\r"));
});

test("Buchung ohne vollständigen Termin wird angemahnt", () => {
  const d = validiereExtraktion({ booking_requested: true, weekday: "Montag" });
  assert.match(d._pruefung.join(" "), /Termin/);
});

test("Modell-Output ohne Objekt wirft (→ Aufrufer nimmt notfallExtraktion)", () => {
  assert.throws(() => validiereExtraktion(null));
  assert.throws(() => validiereExtraktion(["nope"]));
});

/* ── Audio ──────────────────────────────────────────────────────────────── */

test("Tiefpass: Nutzband bleibt, Aliasing-Bereich wird gedämpft", () => {
  const sinus = (f, rate, n) => {
    const s = new Int16Array(n);
    for (let i = 0; i < n; i++) s[i] = Math.round(12000 * Math.sin((2 * Math.PI * f * i) / rate));
    return s;
  };
  const amp = (s) => {
    let max = 0;
    for (let i = s.length >> 1; i < s.length; i++) max = Math.max(max, Math.abs(s[i]));
    return max;
  };
  // 1 kHz (Sprache) muss praktisch unangetastet durch.
  assert.ok(amp(createTelefonTiefpass(24000)(sinus(1000, 24000, 24000))) > 11000);
  // 6 kHz würde sich auf 2 kHz falten — muss deutlich gedämpft sein.
  assert.ok(amp(createTelefonTiefpass(24000)(sinus(6000, 24000, 24000))) < 1500);
});

test("Tiefpass: Zustand überlebt Chunk-Grenzen", () => {
  // Wird der Filter pro Chunk neu angelegt, knackt es an jeder Grenze.
  const n = 4800;
  const roh = new Int16Array(n);
  for (let i = 0; i < n; i++) roh[i] = Math.round(9000 * Math.sin((2 * Math.PI * 1000 * i) / 24000));

  const amStueck = createTelefonTiefpass(24000)(roh);
  const chunkweise = createTelefonTiefpass(24000);
  const teile = [];
  for (let i = 0; i < n; i += 480) teile.push(...chunkweise(roh.subarray(i, i + 480)));

  for (let i = 0; i < n; i++) assert.equal(teile[i], amStueck[i]);
});

test("Resampling: Länge folgt dem Verhältnis der Raten", () => {
  const roh = new Int16Array(2400);
  assert.equal(resampleLinear(roh, 24000, 8000).length, 800);
  assert.equal(resampleLinear(roh, 8000, 16000).length, 4800);
  assert.equal(resampleLinear(roh, 8000, 8000).length, 2400); // Identität
});

/* ── Pacer-Drift (Punkt 10) ─────────────────────────────────────────────── */

test("Pacer: pünktlich = genau ein Frame", () => {
  assert.equal(faelligeFrames(1000, 1000), 1);
  assert.equal(faelligeFrames(1019, 1000), 1); // 19 ms Rückstand: noch kein Frame
});

test("Pacer: Rückstand wird nachgeschoben", () => {
  assert.equal(faelligeFrames(1040, 1000), 3); // 40 ms zu spät → 1 + 2
});

test("Pacer: Nachholen ist gedeckelt", () => {
  // Ohne Deckel würde ein Aussetzer eine halbe Sekunde Ton am Stück
  // rausschieben — Asterisk puffert das und Barge-in wird träge.
  assert.equal(faelligeFrames(5000, 1000), 5);
});

test("Pacer: zu früh gefeuert liefert trotzdem einen Frame", () => {
  assert.equal(faelligeFrames(990, 1000), 1);
});

/* ── Abschluss-Rückfrage des Dialplans ──────────────────────────────────────
 *
 * Der Asterisk-Dialplan fragt nach jedem Gesprächsende, ob aufgelegt oder ans
 * Bürotelefon durchgestellt werden soll. Aufgelegt wird NUR bei einem
 * ausdrücklichen "ende" — jede Unklarheit muss zum Telefon führen.
 *
 * Das ist der Ausfall-Fallback der ganzen Anlage: Dreht jemand diese Richtung
 * um, fällt der Defekt niemandem auf, weil im Normalbetrieb alles klappt. Erst
 * bei der nächsten Störung sitzt der Anrufer in einer toten Leitung — genau
 * das war der Befund vom 14.08.2026.
 */

test("Abschluss: unbekannte UUID führt zum Bürotelefon, nicht zum Auflegen", () => {
  assert.equal(nimmAbschluss("2f1c9a44-0000-4000-8000-000000000000"), "durchstellen");
});

test("Abschluss: fehlende oder unsinnige UUID führt zum Bürotelefon", () => {
  for (const eingabe of [null, undefined, "", "keine-uuid", "../../etc/passwd", 42]) {
    assert.equal(nimmAbschluss(eingabe), "durchstellen");
  }
});

/* ── Stundenplan ────────────────────────────────────────────────────────── */

test("Kursart-Normalisierung erkennt gesprochene Varianten", () => {
  assert.equal(normalisiereArt("Ballet"), normalisiereArt("Ballett"));
  assert.equal(normalisiereArt(""), null);
});

test("Stundenplan-Daten sind ladbar und plausibel", () => {
  // Fängt kaputte/verschobene CSV-Dateien ab, bevor es ein Anrufer tut.
  const status = stundenplanStatus();
  assert.equal(typeof status.abgelaufen, "boolean");
  const kurse = findeKurse(null, null, "Montag");
  assert.ok(Array.isArray(kurse));
  for (const k of kurse) assert.match(k.von, /^\d{2}:\d{2}$/);
});

/* ── Datumsprüfung (Sicherheitsnachprüfung N4) ───────────────────────────────
   An dieser Funktion hängt die Ablaufsperre des Stundenplans. Lässt sie ein
   unmögliches Datum durch, wird tageBisAblauf zu NaN, jede Warnschwelle
   schweigt und der Plan gilt lexikalisch bis ins Folgejahr weiter — die KI
   nennt dann Zeiten eines Plans, den es nicht mehr gibt. */

test("Datum: gültige Schreibweisen werden übernommen", () => {
  assert.equal(datum("2026-09-14"), "2026-09-14");
  assert.equal(datum("14.09.2026"), "2026-09-14"); // Excel, deutsch
  assert.equal(datum("3.8.2026"), "2026-08-03"); // einstellig
});

test("Datum: der Tag/Monat-Dreher wird abgewiesen", () => {
  // Der wahrscheinlichste Tippfehler beim Schuljahreswechsel: aus 2026-09-14
  // wird 2026-14-09. Vorher galt das als gültig — bis 2027.
  assert.equal(datum("2026-14-09"), null);
});

test("Datum: unmögliche Kalendertage werden abgewiesen", () => {
  assert.equal(datum("2026-02-31"), null); // Date.UTC rollt sonst auf den 3. März
  assert.equal(datum("2026-00-00"), null);
  assert.equal(datum("2026-99-99"), null);
  assert.equal(datum("32.13.2026"), null);
  assert.equal(datum(""), null);
  assert.equal(datum("bald"), null);
});

/* ── CSV-Parser (Sicherheitsnachprüfung N3) ──────────────────────────────────
   daten/ANLEITUNG.md sagt der Kundin zu: nur die fehlerhafte Zeile fällt weg.
   Vorher verschluckte ein einzelnes überzähliges Anführungszeichen alle
   Folgezeilen — und das Last-Good-Netz greift dabei nicht, weil es nur bei
   NULL gültigen Zeilen anspringt. */

test("CSV: normale Zeilen und echte Quotierung", () => {
  const z = parseCsv('a;b;c\n"x;y";z;w\n');
  assert.deepEqual(z[0], ["a", "b", "c"]);
  assert.deepEqual(z[1], ["x;y", "z", "w"]); // Semikolon in Quotes bleibt Text
});

test('CSV: ein überzähliges " frisst nicht den Rest der Datei', () => {
  const text = ["a1;b1;c1", 'a2;b2" kaputt;c2', "a3;b3;c3", "a4;b4;c4"].join("\n");
  const z = parseCsv(text);
  // Vier Zeilen rein, vier Zeilen raus — die kaputte ist dabei, aber
  // verstümmelt und scheitert danach an der Validierung.
  assert.equal(z.length, 4);
  assert.deepEqual(z[0], ["a1", "b1", "c1"]);
  assert.deepEqual(z[2], ["a3", "b3", "c3"]); // wäre vorher verschluckt worden
  assert.deepEqual(z[3], ["a4", "b4", "c4"]);
});

test("CSV: doppeltes Anführungszeichen bleibt ein Zeichen", () => {
  assert.deepEqual(parseCsv('"5"" Zoll";b\n')[0], ['5" Zoll', "b"]);
});

/* ── Reconnect-Notbremse (Sicherheitsnachprüfung N1) ─────────────────────────
   Nimmt Gemini den Handshake an und schließt sofort wieder, lief der
   Wiederaufbau endlos (gemessen: 2,8/s). onAufgegeben feuerte nie — und damit
   griff der Dialplan-Fallback nicht, der laut CLAUDE.md das Sicherheitsnetz
   des ganzen Projekts ist. */

test("Reconnect: normaler goAway-Rhythmus löst nichts aus", () => {
  // Gesunder Betrieb: etwa alle 10 Minuten ein Wiederaufbau.
  let zeiten = [];
  for (let i = 0; i < 20; i++) {
    const b = reconnectBuchfuehrung(zeiten, i * 600000);
    assert.equal(b.aufgeben, false);
    zeiten = b.zeiten;
  }
});

test("Reconnect: die Schleife wird abgebrochen", () => {
  // Kaputter Fall: mehrere Wiederaufbauten pro Sekunde.
  let zeiten = [];
  let aufgegebenNach = null;
  for (let i = 1; i <= 20 && aufgegebenNach === null; i++) {
    const b = reconnectBuchfuehrung(zeiten, i * 350);
    zeiten = b.zeiten;
    if (b.aufgeben) aufgegebenNach = i;
  }
  assert.equal(aufgegebenNach, 5); // vier sind erlaubt, der fünfte bricht ab
});

test("Reconnect: alte Zeitstempel fallen aus dem Fenster", () => {
  // Drei Aufbauten vor über einer Minute dürfen einen neuen nicht belasten.
  const alt = [0, 1000, 2000, 3000];
  assert.equal(reconnectBuchfuehrung(alt, 120000).aufgeben, false);
  assert.deepEqual(reconnectBuchfuehrung(alt, 120000).zeiten, [120000]);
});

/* ── Verbrauchszählung fürs Dashboard ────────────────────────────────────────
   Die Live API meldet KUMULATIV je Verbindung. Wer den zuletzt gemeldeten Stand
   einfach übernimmt, zählt nach einem Wiederaufbau alles Vorherige nicht mehr
   mit — und die Kostenschätzung sinkt ausgerechnet bei den langen Gesprächen. */

const meldung = (einTxt, einAud, ausTxt, ausAud) => ({
  promptTokensDetails: [
    { modality: "TEXT", tokenCount: einTxt },
    { modality: "AUDIO", tokenCount: einAud },
  ],
  responseTokensDetails: [
    { modality: "TEXT", tokenCount: ausTxt },
    { modality: "AUDIO", tokenCount: ausAud },
  ],
});

test("Verbrauch: kumulative Meldungen werden nicht doppelt gezählt", () => {
  let n = leereNutzung();
  n = verrechneNutzung(n, meldung(100, 1000, 0, 500));
  n = verrechneNutzung(n, meldung(180, 2500, 0, 1400));
  assert.equal(n.einText, 180);
  assert.equal(n.einAudio, 2500);
  assert.equal(n.ausAudio, 1400);
});

test("Verbrauch: nach einem Wiederaufbau zählt die Gegenstelle von vorn", () => {
  let n = leereNutzung();
  n = verrechneNutzung(n, meldung(0, 3000, 0, 1200));
  // goAway → neue Verbindung, Zähler beginnt wieder klein.
  n = verrechneNutzung(n, meldung(0, 400, 0, 100));
  n = verrechneNutzung(n, meldung(0, 900, 0, 250));
  assert.equal(n.einAudio, 3900); // 3000 + 900, nicht 900
  assert.equal(n.ausAudio, 1450);
});

test("Verbrauch: unbrauchbare Meldungen ändern nichts", () => {
  const n = verrechneNutzung(leereNutzung(), { promptTokensDetails: "kaputt" });
  assert.equal(n.einText + n.einAudio + n.ausText + n.ausAudio, 0);
});

test("Verbrauch: Ersatzschätzung aus der Dauer ist nicht null", () => {
  const n = nutzungAusDauer(120);
  assert.ok(n.einAudio > 0 && n.ausAudio > 0);
  assert.ok(n.ausAudio < n.einAudio); // die Assistentin redet weniger als sie hört
});

/* ── Auswertung fürs Dashboard ───────────────────────────────────────────────
   Was hier herauskommt, liest die Kundin als Tatsache — und die Kostenzeile
   landet in ihrer Betriebskostenrechnung. */

test("Kosten: Modalitäten werden unterschiedlich gewichtet", () => {
  // Gesprochene Antworten kosten das Sechzehnfache von eingehendem Text. Wer
  // über eine Gesamtsumme rechnet, liegt genau um diesen Faktor daneben.
  const nurText = kostenEuro({ einText: 1e6, einAudio: 0, ausText: 0, ausAudio: 0 });
  const nurAudio = kostenEuro({ einText: 0, einAudio: 0, ausText: 0, ausAudio: 1e6 });
  assert.ok(nurAudio > nurText * 10);
  assert.equal(kostenEuro({ einText: 0, einAudio: 0, ausText: 0, ausAudio: 0 }), 0);
});

test("Auswertung: Anrufe werden nach Monaten getrennt, neuester zuerst", () => {
  const zeilen = [
    '{"zeit":"2026-07-30T14:00:00.000Z","dauer":60,"weitergeleitet":false,"einText":0,"einAudio":1500,"ausText":0,"ausAudio":600,"geschaetzt":false}',
    '{"zeit":"2026-08-02T09:00:00.000Z","dauer":120,"weitergeleitet":true,"einText":0,"einAudio":3000,"ausText":0,"ausAudio":1200,"geschaetzt":false}',
    '{"zeit":"2026-08-03T09:00:00.000Z","dauer":180,"weitergeleitet":false,"einText":0,"einAudio":4500,"ausText":0,"ausAudio":1800,"geschaetzt":false}',
  ];
  const { monate } = fasseZusammen(zeilen);
  assert.equal(monate.length, 2);
  assert.equal(monate[0].monat, "2026-08"); // neuester zuerst
  assert.equal(monate[0].anrufe, 2);
  assert.equal(monate[0].sekunden, 300);
  assert.equal(monate[0].schnitt, 150);
  assert.equal(monate[0].weiterleitungen, 1);
  assert.ok(monate[0].kosten > 0);
});

test("Auswertung: ein Anruf um 00:30 Berliner Zeit zählt zum richtigen Monat", () => {
  // 31.08. 23:30 UTC ist in Berlin schon der 01.09. — würde nach UTC gruppiert,
  // landete der Anruf im falschen Monat und beide Monatssummen wären falsch.
  const { monate } = fasseZusammen([
    '{"zeit":"2026-08-31T23:30:00.000Z","dauer":30,"weitergeleitet":false,"einText":0,"einAudio":0,"ausText":0,"ausAudio":0}',
  ]);
  assert.equal(monate[0].monat, "2026-09");
});

test("Auswertung: eine abgeschnittene Zeile kostet nicht den ganzen Bestand", () => {
  const { monate, uebersprungen } = fasseZusammen([
    '{"zeit":"2026-08-02T09:00:00.000Z","dauer":60,"weitergeleitet":false,"einText":0,"einAudio":0,"ausText":0,"ausAudio":0}',
    '{"zeit":"2026-08-02T09:05:00.000Z","dauer":9', // Absturz beim Schreiben
    '{"zeit":"2026-08-02T09:10:00.000Z","dauer":90,"weitergeleitet":false,"einText":0,"einAudio":0,"ausText":0,"ausAudio":0}',
    "",
  ]);
  assert.equal(uebersprungen, 1);
  assert.equal(monate[0].anrufe, 2); // die beiden gültigen sind da
});

test("Dauer wird kundenfreundlich formuliert", () => {
  assert.equal(dauerText(45), "45 Sek.");
  assert.equal(dauerText(120), "2 Min.");
  assert.equal(dauerText(150), "2 Min. 30 Sek.");
  assert.equal(dauerText(3600), "1 Std.");
  assert.equal(dauerText(5400), "1 Std. 30 Min.");
});
