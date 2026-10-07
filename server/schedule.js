// findeKurse-Tool: Suchlogik über den Stundenplan.
//
// Die DATEN liegen nicht mehr hier, sondern in daten/kurse.csv und
// daten/ferien.csv (siehe daten.js) — pflegbar ohne Deployment. In diesem
// Modul steht nur noch, wie gesucht und wie geantwortet wird.
//
// Zwei Regeln, die den Ausschlag geben:
//   · Kurszeiten stehen NICHT im System-Prompt. Das Modell ruft dieses Tool
//     auf und liest ausschließlich vor, was zurückkommt — sonst erfindet es
//     Zeiten.
//   · Ist der Stundenplan abgelaufen (stundenplan_gueltig_bis), liefert das
//     Tool KEINE Zeiten mehr. Ein veralteter Plan klingt für den Anrufer
//     völlig richtig und ist damit gefährlicher als gar kein Plan.

import { getKurse, getFerien, getEinstellungen, planStatus } from "./daten.js";

const TAGE = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];

/** Heutiges Datum in Europe/Berlin als "YYYY-MM-DD" (Server-Zeitzone egal). */
export function heuteBerlinISO() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date());
}

/** Ferien-/Feiertagseintrag, in den das Datum (ISO) fällt — sonst null. */
export function ferienAm(isoDatum) {
  return getFerien().find((f) => isoDatum >= f.von && isoDatum <= f.bis) || null;
}

/** "YYYY-MM-DD" → "Montag, 3. August 2026" (für Sprachausgabe/Prompt). */
export function datumDeutsch(isoDatum) {
  const [j, m, t] = isoDatum.split("-").map(Number);
  return new Intl.DateTimeFormat("de-DE", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(Date.UTC(j, m - 1, t)));
}

/** Erster Tag nach einem Ferieneintrag als ISO-Datum. */
export function tagNachFerien(ferien) {
  const [j, m, t] = ferien.bis.split("-").map(Number);
  return new Date(Date.UTC(j, m - 1, t + 1)).toISOString().slice(0, 10);
}

/** Kommende unterrichtsfreie Zeiten ab heute, chronologisch. */
export function kommendeFerien(heuteIso) {
  return getFerien()
    .filter((f) => f.von > heuteIso)
    .sort((a, b) => a.von.localeCompare(b.von));
}

/** Gültigkeitsstatus des Stundenplans für heute. */
export function stundenplanStatus() {
  return planStatus(heuteBerlinISO());
}

// Anrufer-Wortwahl → Schema-Tanzart. Reihenfolge zählt: erste Regex, die
// passt, gewinnt (z. B. „Urban Dance" vor Contemporary).
const ART_SYNONYME = [
  [/hip\s*.?hop|breakdance|popping|locking|krump|new\s*style/i, "HipHop"],
  [/urban/i, "Urban"],
  [/contemporary|zeitgen|modern/i, "Contemporary"],
  [/spitze|ballett|ballet/i, "Ballett"],
  [/früherziehung|frueherziehung|tfe/i, "TFE"],
  [/jazz/i, "Jazz"],
];

export function normalisiereArt(input) {
  if (!input) return null;
  const treffer = ART_SYNONYME.find(([re]) => re.test(String(input)));
  return treffer ? treffer[1] : null;
}

function normalisiereTag(input) {
  if (!input) return null;
  const t = String(input).trim().toLowerCase();
  return TAGE.find((tag) => tag.toLowerCase() === t) || null;
}

// Dezimal-Alter mit deutschem Komma, damit die Sprachausgabe „sieben Komma
// fünf" statt „sieben Punkt fünf" vorliest.
const alterZahl = (n) => String(n).replace(".", ",");

function alterText(k) {
  if (k.altBis == null) return `ab ${alterZahl(k.altVon)} Jahren${k.erwachsene ? " (Erwachsene)" : ""}`;
  if (k.altVon === k.altBis) return `${alterZahl(k.altVon)} Jahre`;
  return `${alterZahl(k.altVon)} bis ${alterZahl(k.altBis)} Jahre`;
}

/**
 * Sucht Kurse im Stundenplan. Alle Filter optional, UND-verknüpft.
 * @param {number|string} [alter] Alter in Jahren
 * @param {string} [art] Tanzart (Anrufer-Wortwahl, wird gemappt)
 * @param {string} [tag] Wochentag
 */
export function findeKurse(alter, art, tag) {
  const alterNum = alter == null || alter === "" ? null : Number(alter);
  const artNorm = normalisiereArt(art);
  const tagNorm = normalisiereTag(tag);

  return getKurse().filter((k) => {
    if (alterNum != null && !Number.isNaN(alterNum)) {
      if (alterNum < k.altVon) return false;
      if (k.altBis != null && alterNum > k.altBis) return false;
    }
    if (artNorm && !k.arten.includes(artNorm)) return false;
    if (tagNorm && k.tag !== tagNorm) return false;
    return true;
  });
}

// Antwort für einen abgelaufenen/fehlenden Stundenplan. Bewusst ohne jede
// Zeitangabe — inklusive der Anweisung, stattdessen weiterzuverbinden.
function planAbgelaufenAntwort(status) {
  return {
    kurse: [],
    stundenplan_verfuegbar: false,
    hinweis:
      "ACHTUNG: Der hinterlegte Stundenplan ist nicht mehr gültig" +
      (status.gueltigBis ? ` (galt bis ${datumDeutsch(status.gueltigBis)})` : "") +
      ". Du darfst JETZT KEINE Kurszeiten, Wochentage oder Altersgruppen nennen — auch keine aus " +
      "dem bisherigen Gesprächsverlauf. Sage dem Anrufer freundlich, dass der Stundenplan gerade " +
      "aktualisiert wird und du ihm die Zeiten deshalb nicht verlässlich sagen kannst. Biete an, " +
      "ihn mit einer Mitarbeiterin zu verbinden (Tool menschVerbinden) oder seine Nummer für einen " +
      "Rückruf aufzunehmen. Alternativ: Telefon 01234 567890 oder buero@tanzschule-muster.example.",
  };
}

/**
 * Tool-Einstiegspunkt: nimmt die Function-Call-Args von Gemini und liefert
 * das Response-Objekt, das dem Modell zurückgegeben wird. Unbekannte
 * Tanzarten/Tage werden NICHT stillschweigend ignoriert (sonst käme der
 * komplette Plan zurück und das Modell würde daraus etwas Falsches bauen).
 */
export function findeKurseTool({ alter, art, tag } = {}) {
  const heute = heuteBerlinISO();

  // Gültigkeit zuerst: ein abgelaufener Plan darf gar nicht erst durchsucht werden.
  const status = planStatus(heute);
  if (status.abgelaufen) return planAbgelaufenAntwort(status);

  // Ebenso, wenn die Kursdatei leer/kaputt ist — dann lieber ehrlich abbrechen.
  if (!getKurse().length) {
    return {
      kurse: [],
      stundenplan_verfuegbar: false,
      hinweis:
        "Der Stundenplan ist im Moment nicht abrufbar. Nenne KEINE Zeiten. Sage das freundlich, " +
        "biete an weiterzuverbinden (Tool menschVerbinden) oder verweise auf 01234 567890.",
    };
  }

  if (art && !normalisiereArt(art)) {
    return {
      kurse: [],
      hinweis:
        `Die Tanzart "${art}" gibt es nicht im Angebot. Angeboten werden: Ballett (inkl. Spitze), ` +
        `Tänzerische Früherziehung (TFE), Jazz, Contemporary, Urban Dance und Hip Hop.`,
    };
  }
  if (tag && !normalisiereTag(tag)) {
    return {
      kurse: [],
      hinweis: `Am Tag "${tag}" findet kein Unterricht statt. Unterricht gibt es Montag bis Samstag (samstags nur Tänzerische Früherziehung).`,
    };
  }

  const treffer = findeKurse(alter, art, tag);
  if (!treffer.length) {
    return {
      kurse: [],
      hinweis:
        "Kein passender Kurs im Stundenplan gefunden. Ehrlich sagen und auf Telefon 01234 567890 " +
        "oder buero@tanzschule-muster.example verweisen.",
    };
  }

  const hinweise = [];

  // Laufen gerade Ferien, gilt der Stundenplan erst wieder ab Ferienende.
  const ferien = ferienAm(heute);
  if (ferien) {
    hinweise.push(
      `Aktuell ist unterrichtsfrei (${ferien.name}, bis einschließlich ${datumDeutsch(ferien.bis)}) — ` +
        `es findet KEIN Unterricht statt. Schnupperstunden frühestens ab ${datumDeutsch(tagNachFerien(ferien))} anbieten.`,
    );
  }

  // Steht die nächste unterrichtsfreie Zeit kurz bevor, aktiv erwähnen —
  // sonst wird eine Schnupperstunde in eine geschlossene Woche gelegt.
  const naechste = kommendeFerien(heute)[0];
  if (naechste) {
    const tageHin = Math.round((Date.parse(naechste.von) - Date.parse(heute)) / 86400000);
    if (tageHin <= 21) {
      hinweise.push(
        `Bald unterrichtsfrei: ${naechste.name} von ${datumDeutsch(naechste.von)} bis einschließlich ` +
          `${datumDeutsch(naechste.bis)}. In diesem Zeitraum KEINEN Termin vereinbaren — bei einer ` +
          `Terminabsprache aktiv darauf hinweisen.`,
      );
    }
  }

  // Läuft der Plan demnächst aus, soll die KI nicht weit in die Zukunft planen.
  if (status.tageBisAblauf != null && status.tageBisAblauf <= 30) {
    hinweise.push(
      `Der aktuelle Stundenplan gilt nur noch bis ${datumDeutsch(status.gueltigBis)}. Vereinbare keine ` +
        `Termine nach diesem Datum — für die Zeit danach steht der neue Plan noch nicht fest.`,
    );
  }

  return {
    kurse: treffer.map((k) => ({
      kurs: k.kurs,
      tag: k.tag,
      von: k.von,
      bis: k.bis,
      alter: alterText(k),
      // Ausgebuchte Kurse: Zeiten nennen, aber Aufnahme aktuell nur über die
      // Warteliste — die gerne aktiv anbieten.
      ...(k.voll
        ? { belegung: "ausgebucht – Aufnahme aktuell nur über die Warteliste (Warteliste aktiv anbieten, Name + Rückrufnummer oder E-Mail notieren)" }
        : {}),
    })),
    ...(hinweise.length ? { hinweis: hinweise.join(" ") } : {}),
  };
}

// Function-Declaration für Gemini (Live API und generateContent).
export const KURSE_TOOL_DECLARATION = {
  name: "findeKurse",
  description:
    "Sucht Kurse im offiziellen Stundenplan der Tanzschule Muster. " +
    "Die EINZIGE zulässige Quelle für Kurszeiten — bei jeder Frage zu Kursen, Tagen oder Uhrzeiten aufrufen. " +
    "Alle Filter sind optional und werden UND-verknüpft.",
  parameters: {
    type: "object",
    properties: {
      alter: {
        type: "integer",
        description: "Alter der Person, die tanzen möchte, in Jahren",
      },
      art: {
        type: "string",
        description:
          "Gewünschte Tanzart in den Worten des Anrufers (z. B. Ballett, Spitze, Hip Hop, Breakdance, " +
          "Jazz, Contemporary, zeitgenössisch, modern, Urban, Früherziehung). Wird serverseitig gemappt.",
      },
      tag: {
        type: "string",
        enum: TAGE,
        description: "Gewünschter Wochentag (samstags nur Tänzerische Früherziehung)",
      },
    },
  },
};

/** Kurzer Statusbericht für den Startup-Log. */
export function datenBericht() {
  const heute = heuteBerlinISO();
  const status = planStatus(heute);
  const e = getEinstellungen();
  return {
    kurse: getKurse().length,
    ferien: getFerien().length,
    schuljahr: e.schuljahr || "—",
    ...status,
  };
}
