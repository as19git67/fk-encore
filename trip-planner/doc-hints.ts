/**
 * What a document says about a trip (§3.4).
 *
 * The documents service already has OCR, classification and semantic
 * search, so a hotel confirmation, a train ticket, a rental agreement
 * and a museum slot are **in the house and machine-readable**. §3.4
 * wants the plan built around those real fixed points instead of around
 * guesses.
 *
 * This module is the reading, and only the reading. It takes the
 * fields a document already carries and answers two questions:
 *
 *   - **Does this look like travel paperwork, and of what sort?**
 *     (`travelRoleOf`)
 *   - **Which hard times does it state?** (`hardTimesIn`)
 *
 * Both answers are *proposals*. Nothing here writes a fixpoint, and
 * that is deliberate: OCR misreads a 7 as a 1 often enough, and a
 * departure invented from a misread line would send a family to a
 * platform at the wrong hour — the one failure §8.6 says is expensive
 * exactly because it surfaces too late. So the app shows what was read,
 * next to the line it was read from, and a person says yes.
 *
 * Pure on purpose: strings in, findings out. No database, no clock, no
 * network — the same document read twice reads the same both times, and
 * every case below is a unit test.
 */

import type { FixpointKind } from "./fixpoints";

/**
 * The four sorts of travel paperwork §3.4 names, plus "none of them".
 * The role is not a category in the documents taxonomy — it is what
 * this document does *for a trip*, which is a different question from
 * what kind of paperwork it is.
 */
export type TravelRole = "lodging" | "transport" | "rental" | "ticket";

/** The fields a reading works from. All optional: OCR fails, too. */
export interface DocumentFacts {
  title?: string | null;
  sender?: string | null;
  summary?: string | null;
  filename?: string | null;
  /** The full OCR text, when the caller has it. */
  text?: string | null;
  /**
   * The date printed on the document, ISO. Kept out of the searchable
   * text on purpose: it is a fact *about* the paper, and mixing it in
   * would make every document "mention" its own date.
   */
  docDate?: string | null;
}

/**
 * Words that mark a role. German first, because that is the corpus,
 * with the English a booking confirmation usually arrives in.
 *
 * Deliberately no brand names: a vocabulary of hotel chains and airlines
 * is a maintenance burden that ages badly, and the generic words are
 * what actually appear on the paper.
 */
const ROLE_WORDS: Record<TravelRole, readonly string[]> = {
  lodging: [
    "hotel", "pension", "gasthof", "ferienwohnung", "ferienhaus", "apartment",
    "appartement", "hostel", "übernachtung", "uebernachtung", "zimmerreservierung",
    "unterkunft", "booking confirmation", "reservation confirmation", "check-in",
    "check in", "anreise", "abreise",
  ],
  transport: [
    "fahrkarte", "fahrschein", "bahnticket", "zugbindung", "sitzplatzreservierung",
    "abfahrt", "abflug", "ankunft", "bordkarte", "boarding pass", "flugticket",
    "flugschein", "buchungsnummer flug", "fähre", "faehre", "ferry", "reisetag",
    "hinfahrt", "rückfahrt", "rueckfahrt", "departure", "flight",
  ],
  rental: [
    "mietwagen", "autovermietung", "mietvertrag fahrzeug", "car rental",
    "rental agreement", "fahrzeugübernahme", "fahrzeuganmietung", "anmietung",
    "rückgabe fahrzeug", "leihwagen",
  ],
  ticket: [
    "eintrittskarte", "eintritt", "einlass", "führung", "fuehrung", "guided tour",
    "zeitfenster", "zeitfensterticket", "museumsticket", "städtepass", "staedtepass",
    "city pass", "konzertkarte", "veranstaltung", "vorstellung", "admission",
  ],
};

/**
 * Which sort of travel paperwork this is, or null when it is none.
 *
 * Counts word hits per role and takes the clearest. A tie goes to
 * nobody: a document that reads equally as a hotel booking and a train
 * ticket is one a person should look at, and guessing at random would
 * put the wrong label on the suggestion screen.
 */
export function travelRoleOf(doc: DocumentFacts): TravelRole | null {
  const hay = haystack(doc);
  if (!hay) return null;

  let best: TravelRole | null = null;
  let bestHits = 0;
  let tied = false;
  for (const role of Object.keys(ROLE_WORDS) as TravelRole[]) {
    const hits = ROLE_WORDS[role].filter((word) => hay.includes(word)).length;
    if (hits === 0) continue;
    if (hits > bestHits) {
      best = role;
      bestHits = hits;
      tied = false;
    } else if (hits === bestHits) {
      tied = true;
    }
  }
  return tied ? null : best;
}

/**
 * A hard time read off a document — a proposal for §4.4's fixpoint, not
 * a fixpoint.
 */
export interface TimeHint {
  /** "Check-in", "Abfahrt" — the word the document itself used. */
  label: string;
  /**
   * A departure is the kind you do not come back from (§4.4), and
   * getting this wrong plans an evening behind a train that has left.
   */
  kind: FixpointKind;
  /** Minutes past midnight. 18:40 is 1120. */
  minutes: number;
  /** The line it was read from, so a person can check the reading. */
  evidence: string;
}

interface Cue {
  /** What to look for; matched case-insensitively. */
  word: string;
  label: string;
  kind: FixpointKind;
}

/**
 * The cues, most specific first — "Rückgabe" before "Rückfahrt" and
 * "letzter Zug" before "Zug", because the first match on a line wins
 * and the more specific one carries more meaning.
 *
 * Only `departure` cues describe leaving for good. A check-out is not
 * one: the group is out of the room by ten and the day carries on.
 */
const CUES: readonly Cue[] = [
  { word: "letzter zug", label: "Letzter Zug", kind: "departure" },
  { word: "abfahrt", label: "Abfahrt", kind: "departure" },
  { word: "abflug", label: "Abflug", kind: "departure" },
  { word: "boarding", label: "Boarding", kind: "departure" },
  { word: "departure", label: "Abfahrt", kind: "departure" },
  { word: "ankunft", label: "Ankunft", kind: "appointment" },
  { word: "check-in", label: "Check-in", kind: "appointment" },
  { word: "check in", label: "Check-in", kind: "appointment" },
  { word: "check-out", label: "Check-out", kind: "appointment" },
  { word: "check out", label: "Check-out", kind: "appointment" },
  { word: "rückgabe", label: "Rückgabe", kind: "appointment" },
  { word: "rueckgabe", label: "Rückgabe", kind: "appointment" },
  { word: "übernahme", label: "Übernahme", kind: "appointment" },
  { word: "einlass", label: "Einlass", kind: "appointment" },
  { word: "führung", label: "Führung", kind: "appointment" },
  { word: "fuehrung", label: "Führung", kind: "appointment" },
  { word: "zeitfenster", label: "Zeitfenster", kind: "appointment" },
  { word: "beginn", label: "Beginn", kind: "appointment" },
  { word: "termin", label: "Termin", kind: "appointment" },
];

/**
 * How far past a cue a time may stand and still belong to it. Long
 * enough for "Check-in ab dem Vortag jederzeit ab 15:00", short enough
 * that the next sentence's time is not stolen.
 */
const CUE_REACH = 40;

/** How many findings one document may contribute. */
const MAX_HINTS = 8;

/**
 * Every hard time the document states, earliest first.
 *
 * Line by line rather than over the whole text: OCR keeps lines even
 * when it loses layout, and a line is the unit on which "Abfahrt" and
 * "07:42" actually belong together. A line with two cues yields the
 * first one only — "Abfahrt 07:42, Ankunft 11:03" is one departure and
 * one arrival, and pairing the wrong halves is worse than reading less.
 */
export function hardTimesIn(text: string | null | undefined): TimeHint[] {
  if (!text) return [];
  const found: TimeHint[] = [];
  const seen = new Set<string>();

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.length > 300) continue;
    const lower = line.toLowerCase();

    for (const cue of CUES) {
      const at = lower.indexOf(cue.word);
      if (at < 0) continue;
      const minutes = firstTimeIn(line.slice(at, at + cue.word.length + CUE_REACH));
      if (minutes === null) continue;
      const key = `${cue.label}|${minutes}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ label: cue.label, kind: cue.kind, minutes, evidence: line });
      break; // one reading per line, see above
    }
    if (found.length >= MAX_HINTS) break;
  }

  return found.sort((a, b) => a.minutes - b.minutes);
}

/**
 * The first clock time in a piece of text, as minutes past midnight.
 *
 * Accepts 7:42, 07:42 and 07.42 — the last because German documents
 * write it that way and OCR turns colons into dots anyway. A bare
 * "15 Uhr" counts too; a bare number does not, because a booking
 * reference is also a number.
 */
function firstTimeIn(text: string): number | null {
  const colon = /(\d{1,2})[:.](\d{2})\s*(?:uhr)?/i.exec(text);
  if (colon) {
    const h = Number(colon[1]);
    const m = Number(colon[2]);
    if (h <= 23 && m <= 59) return h * 60 + m;
  }
  const bare = /(\d{1,2})\s*uhr/i.exec(text);
  if (bare) {
    const h = Number(bare[1]);
    if (h <= 23) return h * 60;
  }
  return null;
}

/**
 * Why a document was suggested for a trip — the sentence §8.2 promises
 * ("Ich habe eine Hotelbuchung für diesen Zeitraum gefunden"). Reasons
 * are shown, never summed into a hidden score: a suggestion nobody can
 * argue with is one nobody trusts.
 */
export interface TripMatch {
  role: TravelRole;
  reasons: string[];
}

export interface TripHints {
  /** Every date the trip covers, ISO, so a mention can be recognised. */
  dates: readonly string[];
  /** What the trip calls its places — leg titles and anchor labels. */
  places: readonly string[];
  /**
   * The trip's own days, widened a little by the caller. A ticket
   * bought the evening before carries neither the destination nor a
   * date in its title, and this is the only thing that finds it.
   */
  window?: { from: string; to: string } | null;
}

/** Shorter than this a place name matches half the corpus ("Bad", "Ulm"). */
const MIN_PLACE_LENGTH = 4;

/**
 * Does this document look like it belongs to this trip?
 *
 * Three independent signals, and any one alone is enough: it names one
 * of the trip's dates, it names one of its places, or its own date
 * falls in the trip's window. What it must always be is travel
 * paperwork — a phone bill from the week of the holiday carries the
 * date too, and offering it would teach people to ignore the list.
 */
export function matchesTrip(doc: DocumentFacts, trip: TripHints): TripMatch | null {
  const role = travelRoleOf(doc);
  if (role === null) return null;

  const hay = haystack(doc);
  const reasons: string[] = [];

  for (const date of trip.dates) {
    if (writtenForms(date).some((form) => hay.includes(form))) {
      reasons.push(`nennt den ${germanDate(date)}`);
      break;
    }
  }
  for (const place of trip.places) {
    const needle = place.trim().toLowerCase();
    if (needle.length >= MIN_PLACE_LENGTH && hay.includes(needle)) {
      reasons.push(`nennt ${place.trim()}`);
      break;
    }
  }

  const window = trip.window;
  if (window && doc.docDate && doc.docDate >= window.from && doc.docDate <= window.to) {
    reasons.push(`ist vom ${germanDate(doc.docDate)}, also aus der Reisezeit`);
  }

  if (reasons.length === 0) return null;
  return { role, reasons };
}

/** The ways "2026-07-12" appears on paper. */
export function writtenForms(iso: string): string[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return [];
  const [, y, mo, d] = m;
  const shortDay = String(Number(d));
  const shortMonth = String(Number(mo));
  return [
    iso,
    `${d}.${mo}.${y}`,
    `${d}.${mo}.${y.slice(2)}`,
    `${shortDay}.${shortMonth}.${y}`,
    `${d}/${mo}/${y}`,
    `${shortDay}. ${MONTHS[Number(mo) - 1]} ${y}`.toLowerCase(),
  ];
}

const MONTHS = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

/** "2026-07-12" → "12.07.2026", for a sentence a person reads. */
export function germanDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

/** Everything the reading may look at, lowercased once. */
function haystack(doc: DocumentFacts): string {
  return [doc.title, doc.sender, doc.summary, doc.filename, doc.text]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n")
    .toLowerCase();
}
