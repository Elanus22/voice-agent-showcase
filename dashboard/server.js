// Liefert die vorbereitete Dashboard-Seite aus — und sonst nichts.
//
// Erreichbar ist der Dienst NUR über das WireGuard-Netz, das ohnehin für die
// Telefonie läuft (Transfernetz 10.0.0.0/24, VPS unter .201). Kein Port
// zeigt ins Internet, die Firewall bleibt bei TCP 22 + WireGuard. Wer die Seite
// sehen will, ist im Netz der Kundin — genau eine Person, ein Blick am Tag.
//
// Trotzdem so klein wie irgend möglich gehalten, denn „nur im LAN" ist eine
// Schicht und kein Freibrief:
//
//   • Kein Express, kein Router, keine statische Middleware. Ein exakter
//     Zeichenkettenvergleich auf den einen erlaubten Pfad — damit gibt es
//     keinen Pfad-Traversal, weil nie ein Pfad aus der Anfrage in einen
//     Dateinamen wandert.
//   • Genau eine Datei, deren Name im Code steht. Keine Parameter, keine
//     Formulare, keine Datenbank, kein Schreiben.
//   • Eigener systemd-Dienst, eigener Benutzer, eigener Port. Ein Absturz oder
//     eine Lücke hier rührt die Telefonie nicht an — die läuft in einem
//     anderen Prozess und hört ohnehin nur auf 127.0.0.1.
//
// Zwei Schichten also: erst das VPN, dann der nicht erratbare Pfad
// (DASHBOARD_PFAD). Kein Login — eine einzelne Nutzerin, aggregierte Zahlen,
// kein Personenbezug. Der Pfad ist damit nicht mehr der einzige Schutz, gehört
// aber weiterhin nicht in Chats, Tickets oder Screenshots.
//
// TLS braucht es hier nicht: WireGuard verschlüsselt die Strecke bereits, und
// ein zweites Zertifikat auf einer Maschine ohne Webserver wäre Aufwand ohne
// Gegenwert. Das war vor der Umstellung auf VPN-only ein offener Punkt.

import dotenv from "dotenv";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEITE = path.join(__dirname, "ausgabe", "index.html");

/* Die .env wird gelesen, aber NICHT nach process.env geschüttet. Dort stünden
 * sonst auch GEMINI_API_KEY (Abrechnung der Kundin) und SMTP_PASS — Werte, die
 * dieser Dienst nie braucht. Was er nie geladen hat, kann auch kein
 * Speicherabzug preisgeben: Am 20.08.2026 starb genau dieser Prozess mit
 * Core-Dump in einer Restart-Schleife (siehe deploy/voice-dashboard.service).
 * Übernommen werden ausschließlich die drei Namen unten; eine echte
 * Umgebungsvariable hat weiterhin Vorrang, damit die systemd-Unit oder ein
 * Testaufruf sie überschreiben kann. */
const AUS_DATEI = dotenv.config({ processEnv: {} }).parsed ?? {};
const konf = (name, standard) => process.env[name] ?? AUS_DATEI[name] ?? standard;

const PFAD = konf("DASHBOARD_PFAD", "");
const PORT = Number(konf("DASHBOARD_PORT", 8080));
// Voreinstellung ist der Loopback, nicht 0.0.0.0: Wer den Dienst weiter
// aufmachen will, muss das ausdrücklich hinschreiben. Im Betrieb steht hier die
// WireGuard-Adresse des VPS (10.0.0.201), damit ausschließlich das Netz der
// Kundin herankommt — siehe deploy/DASHBOARD.md.
const HOST = konf("DASHBOARD_HOST", "127.0.0.1");

// Die Länge ist der ganze Schutz — deshalb wird sie erzwungen und nicht
// gehofft. 22 Zeichen aus [A-Za-z0-9_-] sind rund 130 Bit; ein kurzer oder
// sprechender Pfad („/dashboard") wäre in Minuten gefunden.
if (!/^\/[A-Za-z0-9_-]{22,}$/.test(PFAD)) {
  console.error(
    "DASHBOARD_PFAD fehlt oder ist zu kurz. Erwartet wird ein Schrägstrich und\n" +
      "mindestens 22 Zeichen aus A-Z a-z 0-9 _ - . Erzeugen mit:\n" +
      "  node -e \"console.log('/'+require('crypto').randomBytes(24).toString('base64url'))\"",
  );
  process.exit(1);
}

function verweigere(res) {
  // Immer dieselbe Antwort, egal ob Methode, Pfad oder Datei das Problem war:
  // Wer den Pfad rät, soll aus der Antwort nicht ablesen können, ob er näher
  // dran ist.
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Nicht gefunden\n");
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") return verweigere(res);
  if (req.url !== PFAD) return verweigere(res);

  let html;
  try {
    html = fs.readFileSync(SEITE);
  } catch {
    // Der Bau-Job war noch nie dran. Kein 500 — für die Nutzerin ist das
    // dasselbe wie „noch nichts da", und ein 404 verrät weniger.
    return verweigere(res);
  }

  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": html.length,
    // Der geheime Pfad steht in der URL. Ohne diesen Kopf gäbe ihn der Browser
    // beim ersten Klick auf einen externen Link weiter.
    "referrer-policy": "no-referrer",
    // frame-ancestors fällt NICHT auf default-src zurück — das ist eine
    // Eigenheit der CSP-Spezifikation, kein Versehen. Ohne die Angabe (und ohne
    // X-Frame-Options) wäre die Seite einbettbar.
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  res.end(req.method === "HEAD" ? undefined : html);
});

server.listen(PORT, HOST, () => {
  // Der Pfad steht NICHT im Log. stdout landet unter systemd im Journal, und
  // `Restart=always` mit `RestartSec=3` schriebe ihn in einer Absturzschleife
  // im Sekundentakt dorthin. Ein journalctl-Auszug wandert beim Debuggen
  // schnell in ein Ticket oder einen Screenshot — genau der Weg, den der
  // Kopfkommentar oben ausschließen will. Länge und Herkunft genügen zur
  // Kontrolle, dass der richtige Wert geladen wurde.
  console.log(
    `  Dashboard : http://${HOST}:${PORT}/… ` +
      `(${Math.max(0, PFAD.length - 1)} Zeichen Pfad aus DASHBOARD_PFAD)`,
  );
  console.log(`  Quelle    : ${SEITE} (erzeugt von dashboard/bauen.js)`);
});
