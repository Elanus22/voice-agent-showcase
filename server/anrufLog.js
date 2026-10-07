// Betriebsprotokoll der Anrufe — die Datengrundlage des Kundinnen-Dashboards.
//
// Eine Zeile JSON je beendetem Anruf, angehängt an protokoll/anrufe.jsonl.
// Bewusst getrennt von outbox/: Dort liegen Gesprächsnotiz und Volltranskript
// mit Klarnamen und Rufnummer, deshalb dort die 30-Tage-Löschfrist. Hier steht
// NICHTS Personenbezogenes — kein Transkript, keine Rufnummer, kein Name, nur
// Zeitpunkt, Dauer, Weiterleitung ja/nein und der Tokenverbrauch. Genau
// deshalb darf diese Datei dauerhaft liegen bleiben, und nur deshalb sind
// Monat-zu-Monat-Vergleiche über Jahre hinweg überhaupt zulässig.
//
// JSONL statt einer Datenbank: Anhängen ist atomar genug für einen Anruf
// gleichzeitig, die Datei ist mit bloßem Auge lesbar, und ein kaputter Anhang
// kostet eine Zeile statt den ganzen Bestand.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const LOG_DATEI =
  process.env.ANRUF_LOG || path.join(__dirname, "..", "protokoll", "anrufe.jsonl");

const FELDER = ["einText", "einAudio", "ausText", "ausAudio"];

/* ─────────────────────────── Tokenverbrauch ──────────────────────────────
 *
 * Die Live API meldet den Verbrauch in `usageMetadata` — aufgeschlüsselt nach
 * Modalität, und das ist der Punkt: Ausgabe-Audio kostet das Sechzehnfache von
 * Eingabe-Text ($12 gegen $0,75 je Million). Eine einzelne Gesamtzahl ergäbe
 * eine Kostenschätzung, die um eine Größenordnung danebenliegen kann.
 *
 * Die Zahlen sind KUMULATIV je Verbindung, nicht je Nachricht. Nach einem
 * Wiederaufbau (goAway, siehe live.js) zählt die Gegenstelle wieder bei null —
 * deshalb wird hier der Zuwachs verrechnet und ein Rückfall als Neubeginn
 * gewertet, statt den zuletzt gesehenen Stand zu übernehmen.
 */

export function leereNutzung() {
  return { einText: 0, einAudio: 0, ausText: 0, ausAudio: 0, _stand: null };
}

function liesModalitaet(details, modalitaet) {
  if (!Array.isArray(details)) return 0;
  let summe = 0;
  for (const d of details) {
    if (String(d?.modality || "").toUpperCase() !== modalitaet) continue;
    const n = Number(d.tokenCount);
    if (Number.isFinite(n) && n > 0) summe += n;
  }
  return summe;
}

/** Eine `usageMetadata`-Meldung einrechnen. Reine Funktion (prüfbar ohne API). */
export function verrechneNutzung(nutzung, meldung) {
  const roh = {
    einText: liesModalitaet(meldung?.promptTokensDetails, "TEXT"),
    einAudio: liesModalitaet(meldung?.promptTokensDetails, "AUDIO"),
    ausText: liesModalitaet(meldung?.responseTokensDetails, "TEXT"),
    ausAudio: liesModalitaet(meldung?.responseTokensDetails, "AUDIO"),
  };
  const neu = { ...nutzung, _stand: roh };
  for (const feld of FELDER) {
    const vorher = nutzung._stand ? nutzung._stand[feld] : 0;
    neu[feld] += roh[feld] >= vorher ? roh[feld] - vorher : roh[feld];
  }
  return neu;
}

/**
 * Ersatzschätzung, wenn die API keine Aufschlüsselung geliefert hat. Grundlage
 * ist die dokumentierte Rate von 25 Token je Sekunde Audio: Der Anrufer wird
 * über die volle Gesprächsdauer eingelesen, die Assistentin spricht davon
 * erfahrungsgemäß knapp die Hälfte. Grob, aber besser als eine Null, die wie
 * ein kostenloser Anruf aussieht.
 */
export function nutzungAusDauer(dauerSek) {
  const s = Math.max(0, Number(dauerSek) || 0);
  return {
    einText: 0,
    einAudio: Math.round(s * 25),
    ausText: 0,
    ausAudio: Math.round(s * 25 * 0.4),
  };
}

/* ────────────────────────────── Schreiben ────────────────────────────────*/

/**
 * Hängt eine Zeile an. Wirft NIE — ein Protokollfehler darf einen Anruf nicht
 * beeinflussen, und an dieser Stelle (endCall) hängt der Mailversand dahinter.
 */
export function protokolliereAnruf({ dauerSek, weitergeleitet, nutzung }) {
  const gemessen = nutzung && FELDER.some((f) => nutzung[f] > 0);
  const werte = gemessen ? nutzung : nutzungAusDauer(dauerSek);
  const satz = {
    zeit: new Date().toISOString(),
    dauer: Math.max(0, Math.round(Number(dauerSek) || 0)),
    weitergeleitet: weitergeleitet === true,
    einText: werte.einText,
    einAudio: werte.einAudio,
    ausText: werte.ausText,
    ausAudio: werte.ausAudio,
    geschaetzt: !gemessen,
  };
  try {
    fs.mkdirSync(path.dirname(LOG_DATEI), { recursive: true, mode: 0o700 });
    fs.appendFileSync(LOG_DATEI, JSON.stringify(satz) + "\n", { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    console.error("[anrufLog] Zeile nicht geschrieben:", err?.message || err);
  }

  /* Woher die Zahlen stammen — bei JEDEM Anruf, ohne dass jemand etwas
   * einschalten muss.
   *
   * Der Grund steht in CLAUDE.md unter „Was die Erprobung gelehrt hat": Was
   * nicht protokolliert wird, ist nicht diagnostizierbar. Am 20.08.2026 lieferte
   * die Live API bei zwei Probeanrufen auf dem VPS keine Verbrauchsmeldung —
   * beide waren allerdings atypisch (kein Dialog, einmal ganz ohne Antwort des
   * Modells). Ob `usageMetadata` bei einem echten Gespräch kommt, ist damit
   * offen, und ohne diese Zeile bliebe es offen: Im Protokoll steht zwar
   * `geschaetzt`, aber niemand liest eine JSONL-Datei durch, um eine Frage zu
   * bemerken, die er noch gar nicht hat.
   *
   * Die Antwort entscheidet über die Güte der Kostenzeile im Dashboard. Die
   * Ersatzschätzung rechnet linear mit der Gesprächsdauer und liegt damit
   * vermutlich zu NIEDRIG: Abgerechnet wird pro Turn über das gesamte
   * Kontextfenster (siehe live.js), was mit der Gesprächslänge überproportional
   * wächst.
   */
  console.log(
    gemessen
      ? `[anrufLog] Verbrauch gemessen: ${satz.einAudio} + ${satz.einText} ein, ` +
          `${satz.ausAudio} + ${satz.ausText} aus`
      : "[anrufLog] Verbrauch aus der Dauer geschätzt — die Live API hat keine " +
          "Verbrauchsmeldung geschickt (Kostenzeile im Dashboard ist dann eher zu niedrig)",
  );
  return satz;
}
