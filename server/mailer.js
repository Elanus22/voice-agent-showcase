// Zustellung der Gesprächszusammenfassung ans Büro: immer erst nach outbox/,
// dann per SMTP.
//
// BEWUSST OHNE .ics-ANHANG. Der Ablauf im Büro ist: Mail lesen, Termin von Hand
// prüfen, von Hand zurückschreiben. Ein Kalendereintrag hätte in diesem Ablauf
// keinen Empfänger — er müsste ein Datum behaupten, das erst im Rückruf
// entsteht (der Agent kennt nur den Wochentag, nicht das Datum). Dazu kommt:
// Jeder Wert im .ics stammt aus einem vom Anrufer diktierten Transkript; ein
// CRLF im Namen schleust eigene Kalenderkomponenten ein (Review-Punkt 5). Ein
// Feature, das niemand nutzt, ist die Angriffsfläche nicht wert — deshalb ist
// es raus statt abgesichert. Wieder einbauen nur mit Escaping nach RFC 5545.

import nodemailer from "nodemailer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTBOX_DIR = path.join(__dirname, "..", "outbox");

const MAIL_TO = process.env.MAIL_TO || "buero@tanzschule-muster.example";
const MAIL_FROM = process.env.MAIL_FROM || "voice-agent@tanzschule-muster.example";

/* ───────────────────── Datensparsamkeit / Löschkonzept ──────────────────── */

// Wie lange die technische Kopie in outbox/ liegen bleibt. NICHT zu verwechseln
// mit der Aufbewahrung im Büropostfach — die ist organisatorisch (6 Monate) und
// von hier aus nicht steuerbar. outbox/ ist nur der Zwischenspeicher, der
// verhindert, dass eine Anfrage bei einem Mailfehler verloren geht.
const OUTBOX_TAGE = Number(process.env.OUTBOX_AUFBEWAHRUNG_TAGE || 30);

// "fehlerfall" (Default) = Volltranskript nur, wenn die Auswertung scheiterte.
// "immer" = wie früher, jedes Wort jedes Gesprächs geht ins Büropostfach.
//
// Der Wortlaut eines kompletten Telefonats ist der mit Abstand größte
// personenbezogene Datenbestand im ganzen System — und im Normalfall liest ihn
// niemand, weil oben schon alles Nötige steht. Scheitert die Extraktion, ist er
// dagegen das Einzige, was die Anfrage rettet (Review-Punkt 4).
const TRANSKRIPT_MODUS = (process.env.MAIL_TRANSKRIPT || "fehlerfall").toLowerCase();

/**
 * Löscht zugestellte Altlasten aus outbox/. `UNZUSTELLBAR-*` wird NIEMALS
 * angefasst — das sind Anfragen, die nie beim Büro ankamen; sie zu löschen
 * würde genau den Schaden anrichten, gegen den outbox/ gebaut wurde.
 */
export function raeumeOutboxAuf() {
  if (!Number.isFinite(OUTBOX_TAGE) || OUTBOX_TAGE <= 0) return { geloescht: 0, aus: null };
  let geloescht = 0;
  const grenze = Date.now() - OUTBOX_TAGE * 86400000;
  try {
    for (const name of fs.readdirSync(OUTBOX_DIR)) {
      if (!name.startsWith("anruf-")) continue; // schützt UNZUSTELLBAR-*
      const pfad = path.join(OUTBOX_DIR, name);
      try {
        if (fs.statSync(pfad).mtimeMs < grenze) {
          fs.unlinkSync(pfad);
          geloescht++;
        }
      } catch { /* Datei war schon weg */ }
    }
  } catch (err) {
    if (err?.code !== "ENOENT") console.error("[mail] outbox-Aufräumen:", err?.message || err);
  }
  return { geloescht, aus: OUTBOX_TAGE };
}

function formatBody(data, transcriptText, pruefhinweise = []) {
  const line = (label, value) => `${label}: ${value ?? "—"}`;
  return [
    "Neue Anfrage über den Tanzschule Muster Voice-Agent",
    "=".repeat(46),
    "",
    line("Anliegen", data.intent),
    line("Anrufer:in", data.caller_name),
    line("Teilnehmer:in", data.participant_name),
    line("Alter", data.participant_age),
    line("Kurs", data.course),
    line(
      "Wunschtermin",
      data.weekday
        ? `${data.weekday} ${data.time_start ?? ""}${data.time_end ? "–" + data.time_end : ""}`.trim()
        : null,
    ),
    line("E-Mail", data.email),
    line("Telefon", data.phone),
    line("Buchung gewünscht", data.booking_requested ? "Ja" : "Nein"),
    "",
    "Zusammenfassung:",
    data.summary || "—",
    "",
    "Nächster Schritt:",
    data.follow_up || "—",
    // Was die automatische Prüfung verworfen hat, muss das Büro sehen — sonst
    // fehlt ein Feld kommentarlos und niemand schaut ins Transkript.
    ...(pruefhinweise.length
      ? ["", "Automatische Prüfung:", ...pruefhinweise.map((h) => "  ! " + h)]
      : []),
    "",
    "-".repeat(46),
    ...(transcriptText
      ? ["Vollständiges Transkript:", "", transcriptText]
      : [
          "Das wörtliche Transkript wird bewusst nicht mitgeschickt — oben steht",
          "alles, was für den Rückruf gebraucht wird (Datensparsamkeit).",
        ]),
  ].join("\n");
}

/* ───────────────────────── SMTP-Transport ───────────────────────── */

// Einmal anlegen und wiederverwenden. Ohne explizite Timeouts hängt
// nodemailer bei einem stummen Mailserver minutenlang — und blockiert damit
// die Zustellung des nächsten Anrufs.
let transporter = null;
function getTransporter() {
  if (!process.env.SMTP_HOST) return null;
  if (!transporter) {
    const port = Number(process.env.SMTP_PORT || 587);

    /* N8 (erledigt 11.08.2026): `requireTLS` erzwingt den STARTTLS-Upgrade.
     *
     * Ohne die Option hängt der TLS-Aufbau allein daran, dass der Server
     * STARTTLS im EHLO ankündigt (nodemailer, smtp-connection/index.js:1506).
     * Streicht jemand auf dem Pfad die Ankündigung, überspringt nodemailer den
     * Upgrade kommentarlos und schickt AUTH LOGIN mit SMTP_PASS im Klartext —
     * und danach die Gesprächsnotiz gleich mit. Mit `requireTLS` bricht
     * nodemailer stattdessen ab, die Anfrage landet in outbox/ statt im Klartext
     * auf der Leitung.
     *
     * Auf Port 465 (der dokumentierte Normalfall) ist die Option wirkungslos:
     * `secure: true` baut TLS von der ersten Sekunde an auf, ein Downgrade ist
     * dort gar nicht möglich. Sie greift erst, wenn jemand auf den in
     * .env.example genannten Ausweichport 587 wechselt — genau der Fall, für
     * den sie hier steht. `minVersion` schließt zusätzlich TLS 1.0/1.1 aus.
     */
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      requireTLS: true,
      tls: { minVersion: "TLSv1.2" },
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    });
  }
  return transporter;
}

const schlafe = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Versendet mit bis zu drei Versuchen. Zwischen den Versuchen wird gewartet
 * (2 s, 6 s) — deckt die häufigen Fälle ab: kurzer Netzausfall, Greylisting,
 * Ratelimit des Providers.
 */
async function sendeMitWiederholung(nachricht) {
  const t = getTransporter();
  let letzterFehler = null;
  for (let versuch = 1; versuch <= 3; versuch++) {
    try {
      await t.sendMail(nachricht);
      return { ok: true, versuche: versuch };
    } catch (err) {
      letzterFehler = err;
      console.error(`[mail] Versuch ${versuch}/3 fehlgeschlagen: ${err?.message || err}`);
      if (versuch < 3) await schlafe(versuch * 2000);
    }
  }
  return { ok: false, fehler: letzterFehler };
}

/* ───────────────────────── Zustellung ───────────────────────────── */

/**
 * Verschickt die Gesprächszusammenfassung ans Büro.
 *
 * Reihenfolge ist Absicht: Es wird IMMER zuerst nach outbox/ geschrieben,
 * auch wenn SMTP konfiguriert ist. Vorher galt der outbox-Zweig nur ohne
 * SMTP — schlug im Produktivbetrieb der Versand fehl (Timeout, falsches
 * Passwort, volles Postfach), war die Anfrage restlos verloren, ohne dass
 * es jemand gemerkt hätte. Eine verlorene Anfrage ist bares Geld.
 *
 * Rückgabe: { sent, to, outboxPath, fehlgeschlagen?, fehler? }
 */
export async function deliverCallSummary(data, transcriptText, { urgent = false, callerNum = null } = {}) {
  // Kopie statt Mutation — der Aufrufer hält dasselbe Objekt evtl. noch fest.
  const daten = { ...data };

  // Automatisch von der Telefonanlage erfasste Rufnummer als Fallback, falls
  // die KI keine (oder eine falsch verstandene) Nummer notiert hat.
  if (callerNum && !daten.phone) daten.phone = callerNum;

  // Volltranskript nur, wenn es gebraucht wird: bei gescheiterter Auswertung
  // ist es die einzige Rettung der Anfrage, sonst ist es reiner Datenballast,
  // der dauerhaft im Büropostfach liegen bleibt.
  const transkriptNoetig = TRANSKRIPT_MODUS === "immer" || daten._notfall === true;
  const transkriptFuerMail = transkriptNoetig ? transcriptText : "";

  // Extrahierte Felder können vom Modell kommen → keine Zeilenumbrüche im Header.
  const oneLine = (s) => String(s).replace(/[\r\n]+/g, " ").trim();
  const subject = oneLine(
    `${urgent ? "[DRINGENDER RÜCKRUF] " : ""}[Voice-Agent] ${
      daten.intent === "schnupperstunde" ? "Schnupperstunde" : "Anfrage"
    }: ${daten.participant_name || daten.caller_name || "Unbekannt"}${
      daten.course ? " – " + daten.course : ""
    }`,
  );
  const autoNum = callerNum
    ? `Automatisch erfasste Rufnummer (Anschluss): ${callerNum}\n` +
      "(direkt von der Telefonanlage – unabhängig davon, was im Gespräch genannt wurde)\n\n"
    : "";
  const pruefhinweise = daten._pruefung || [];
  const body = (urgent
    ? "!! DRINGENDER RÜCKRUFWUNSCH — der Anrufer wollte eine Person sprechen, es war\n" +
      "   aber niemand erreichbar. Bitte zeitnah zurückrufen.\n\n"
    : "") + autoNum + formatBody(daten, transkriptFuerMail, pruefhinweise);

  /* N5 (Teil 3 von 3, erledigt 11.08.2026): explizite `mode` an allen
   * Schreibpfaden.
   *
   * In die .json geht das Volltranskript mit Klarnamen, Kindernamen, Alter und
   * Rufnummer. Ohne `mode` entstünden die Dateien unter der Standard-Umask
   * 0022 als 0644 und wären für jedes lokale Konto lesbar, insbesondere für den
   * netzexponierten `asterisk`-Dienst.
   *
   * `UMask=0077` in der systemd-Unit (Teil 1) deckt denselben Fall bereits ab.
   * Die Angaben hier sind trotzdem kein Dekor: Sie gelten auch, wenn der Dienst
   * NICHT unter systemd läuft — beim Testen von Hand, in pruef/anruf.mjs, oder
   * wenn jemand die Unit ersetzt. Der Schutz der Anruferdaten soll nicht davon
   * abhängen, wie der Prozess gestartet wurde.
   *
   * `mode` wirkt nur bei Neuanlage und wird zusätzlich von der Umask
   * beschnitten — deshalb die drei Teile zusammen, nicht einer davon allein.
   */

  // ── Schritt 1: immer auf Platte sichern ──
  fs.mkdirSync(OUTBOX_DIR, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let base = path.join(OUTBOX_DIR, `anruf-${stamp}`);
  const schreibe = (pfad) => {
    // .txt = exakt das, was das Büro bekommen hat.
    fs.writeFileSync(`${pfad}.txt`, `An: ${MAIL_TO}\nBetreff: ${subject}\n\n${body}`, {
      encoding: "utf8",
      mode: 0o600,
    });
    // .json = der Entwickler-Blick: Extraktionsergebnis UND das vollständige
    // Transkript, auch wenn es nicht mit in die Mail ging. Das ist die
    // Datengrundlage fürs Prompt-Tuning und für eine spätere Auswertung
    // („was hat das Modell aus diesem Gespräch gemacht?"). Bleibt auf dem
    // Server, wird nach OUTBOX_AUFBEWAHRUNG_TAGE automatisch gelöscht und
    // geht nie in ein Postfach, das niemand aufräumt.
    fs.writeFileSync(
      `${pfad}.json`,
      JSON.stringify({ ...daten, transkript: transcriptText }, null, 2),
      { encoding: "utf8", mode: 0o600 },
    );
  };
  schreibe(base);

  // ── Schritt 2: kein SMTP → Demo-/Testbetrieb, hier ist Schluss ──
  if (!process.env.SMTP_HOST) {
    return { sent: false, to: MAIL_TO, outboxPath: `${base}.txt` };
  }

  // ── Schritt 3: versenden ──
  const ergebnis = await sendeMitWiederholung({
    from: MAIL_FROM,
    to: MAIL_TO,
    subject,
    text: body,
  });

  if (ergebnis.ok) return { sent: true, to: MAIL_TO, outboxPath: `${base}.txt` };

  // ── Schritt 4: endgültig gescheitert → Datei umbenennen, damit sie beim
  // Draufschauen sofort auffällt, und Alarm schlagen ──
  const meldung = ergebnis.fehler?.message || String(ergebnis.fehler);
  const alarmBase = path.join(OUTBOX_DIR, `UNZUSTELLBAR-anruf-${stamp}`);
  try {
    schreibe(alarmBase);
    for (const ext of [".txt", ".json"]) {
      if (fs.existsSync(`${base}${ext}`)) fs.unlinkSync(`${base}${ext}`);
    }
    base = alarmBase;
  } catch (err) {
    console.error("[mail] Umbenennen der outbox-Datei fehlgeschlagen:", err?.message || err);
  }

  console.error(
    "\n!!! MAILVERSAND ENDGÜLTIG FEHLGESCHLAGEN !!!\n" +
      `    Grund     : ${meldung}\n` +
      `    Anfrage   : ${base}.txt\n` +
      "    Diese Anfrage wurde dem Büro NICHT zugestellt und muss von Hand\n" +
      "    nachgereicht werden.\n",
  );

  await sendeAlarm(subject, meldung, `${base}.txt`);
  return { sent: false, to: MAIL_TO, outboxPath: `${base}.txt`, fehlgeschlagen: true, fehler: meldung };
}

/**
 * Bester-Versuch-Benachrichtigung an die Betreuung (ALERT_MAIL_TO), wenn die
 * Zustellung ans Büro scheitert. Deckt den realistischsten Fall ab: der
 * SMTP-Relay funktioniert, aber das Zielpostfach lehnt ab (Quota, Tippfehler
 * in MAIL_TO). Ein Versuch, keine Wiederholung — scheitert auch der, bleibt
 * es beim Log und der Datei in outbox/.
 */
async function sendeAlarm(betreff, grund, pfad) {
  const an = process.env.ALERT_MAIL_TO;
  if (!an) return;
  try {
    await getTransporter().sendMail({
      from: MAIL_FROM,
      to: an,
      subject: "[Voice-Agent] Mailversand fehlgeschlagen",
      text:
        "Der Voice-Agent konnte eine Gesprächszusammenfassung nicht zustellen.\n\n" +
        `Betreff der Original-Mail : ${betreff}\n` +
        `Empfänger                 : ${MAIL_TO}\n` +
        `Fehler                    : ${grund}\n` +
        `Datei auf dem Server      : ${pfad}\n\n` +
        "Die Anfrage liegt vollständig in dieser Datei und muss von Hand nachgereicht werden.",
    });
  } catch (err) {
    console.error("[mail] Auch die Alarm-Mail ging nicht raus:", err?.message || err);
  }
}

/**
 * Startup-Check: prüft die SMTP-Zugangsdaten, bevor der erste echte Anruf
 * darauf angewiesen ist. Ohne diesen Check fällt ein Tippfehler im Passwort
 * erst auf, wenn die erste Anfrage schon verloren ist.
 */
export async function pruefeMailKonfiguration() {
  if (!process.env.SMTP_HOST) {
    return { ok: false, grund: "kein SMTP konfiguriert — Ablage in outbox/" };
  }

  // Häufigste Ursache für Ablehnungen bei einer eigenen Geschäftsdomain:
  // Der Provider lässt als Absender nur die Adresse zu, mit der man sich
  // authentifiziert (der Mail-Hoster macht das so). Ein Domain-Vergleich reicht dafür
  // NICHT — buero@ und voice-agent@ liegen auf derselben Domain, und genau
  // diese Verwechslung wird trotzdem mit "550 sender address rejected"
  // abgewiesen. Deshalb auf Adressgleichheit prüfen.
  const warnungen = [];
  const user = (process.env.SMTP_USER || "").trim().toLowerCase();
  const from = MAIL_FROM.trim().toLowerCase();

  if (user && !user.includes("@")) {
    warnungen.push(
      `SMTP_USER ist "${process.env.SMTP_USER}" — als Benutzername wird die ` +
        "VOLLSTÄNDIGE E-Mail-Adresse erwartet (z. B. voice-agent@tanzschule-muster.example).",
    );
  }
  if (user && from && user !== from) {
    const gleicheDomain = user.split("@")[1] === from.split("@")[1];
    warnungen.push(
      `MAIL_FROM (${MAIL_FROM}) ist nicht die Adresse, mit der wir uns anmelden ` +
        `(SMTP_USER = ${process.env.SMTP_USER}).` +
        (gleicheDomain
          ? " Gleiche Domain reicht nicht: Der Absender muss zum angemeldeten Postfach gehören"
          : " Verschiedene Domains") +
        ' — sonst kommt "550 sender address rejected". Nur ok, wenn MAIL_FROM ein' +
        " beim Provider eingerichteter Alias des Postfachs ist.",
    );
  }
  if (MAIL_TO.trim().toLowerCase() === from) {
    warnungen.push(
      `MAIL_TO und MAIL_FROM sind identisch (${MAIL_TO}) — der Assistent würde ` +
        "sich die Notizen selbst schicken statt dem Büro.",
    );
  }

  try {
    await getTransporter().verify();
    return { ok: true, warnungen };
  } catch (err) {
    return { ok: false, grund: err?.message || String(err), warnungen };
  }
}
