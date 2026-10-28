/**
 * The assistant benchmark's cases (documentation/plans/ki-assistent.md,
 * "Benchmark"). Each case is one question the real agent loop answers with
 * the real system prompt and the real tool catalog; only the tools' results
 * are canned, so the case measures the model, not the data.
 *
 * Every name, address, number and amount is made up. "Today" is fixed so the
 * expected dates never drift.
 *
 * Expectations compare loosely (case, whitespace, `2025` vs `"2025"`). A key
 * may name a nested argument (`yield.investment_group`); an array argument is
 * compared as its JSON text, so `$contains` finds an element in it.
 */

import type { ChatMessage, RefType } from "../types";
import { summarizedTurn as replaySummarized, summaryNote } from "../summary";
import { factsLeftOut, leftOutNote } from "../tools/letters";

export const BENCH_TODAY = "2026-10-15";

/** A literal, or one of the operators `scoring.ts` knows. */
export type Expected =
  | string
  | number
  | boolean
  | { $contains: string }
  | { $in: Array<string | number> }
  | { $present: true }
  | { $absent: true }
  | { $all: Expected[] };

export interface ExpectedCall {
  tool: string;
  args?: Record<string, Expected>;
  /**
   * Alternatives to `args`: the call matches when its arguments match
   * `args` or any one of these sets. For a question with two right roads
   * (a depot by its id, or by its name in q).
   */
  anyOf?: Record<string, Expected>[];
}

export interface BenchCase {
  id: string;
  /** What the case checks, for the results table. */
  title: string;
  question: string;
  /** Earlier turns, as the assistant replays them (with the tool notes behind each answer). */
  history?: ChatMessage[];
  /** The latest earlier result per type, for `from_previous_result`. */
  previous?: Partial<Record<RefType, number[]>>;
  /** A working set handed to the conversation: refs and the brief of each. */
  context?: { refs: Array<{ type: RefType; id: number }>; briefs: string[] };
  /** Every one of these calls must occur, in any order; extra read calls are fine. */
  expect: ExpectedCall[];
  /**
   * Tools the first call of the turn may be, for the path metric (stage 6 of
   * assistent-wegfindung.md). Default: any expected tool. Named where a
   * lookup before the real call is fine (`list_categories` before a search).
   */
  firstTools?: string[];
  /** Fails on any tool call at all. */
  forbidTools?: boolean;
  /** Runs as a user holding only these permissions; the catalog shrinks with them. */
  permissions?: string[];
  /** The answer must match this (case-insensitive regular expression). */
  answerMatches?: string;
  /** Canned results by tool name; a tool without one gets "no data in the benchmark". */
  results: Record<string, unknown>;
}

const METERS = { rows: [{ id: 3, name: "Strom Haus" }, { id: 4, name: "Wasser Haus" }] };

const INVOICE_BRIEFS = [
  'document 201: "Rechnung Heizungswartung"\n  from: Musterfirma Haustechnik GmbH; dated: 2026-09-02; type: Rechnung\n  reference numbers: invoice RE-2026-0101\n  amount (read from the text): 120,50 €',
  'document 202: "Rechnung Ersatzteil"\n  from: Musterfirma Haustechnik GmbH; dated: 2026-09-09; type: Rechnung\n  reference numbers: invoice RE-2026-0102\n  amount (read from the text): 89,90 €',
  'document 203: "Rechnung Anfahrt"\n  from: Musterfirma Haustechnik GmbH; dated: 2026-09-16; type: Rechnung\n  reference numbers: invoice RE-2026-0103\n  amount (read from the text): 45,00 €',
];

/** An earlier turn as the assistant replays it: question, tool call with its digest, answer. */
function earlierTurn(question: string, tool: string, args: Record<string, unknown>, digest: string, answer: string): ChatMessage[] {
  const id = `h-${tool}`;
  return [
    { role: "user", content: question },
    { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] },
    { role: "tool", tool_call_id: id, content: digest },
    { role: "assistant", content: answer },
  ];
}

const PURCHASE_HISTORY = earlierTurn(
  "Zeig mir die Unterlagen zum Kauf der Wohnung in Musterstadt.",
  "search_documents", { q: "Kauf Wohnung Musterstadt" },
  "[earlier result of search_documents: 3 rows, ids 301,302,303]",
  "Ich habe drei Unterlagen zum Kauf gefunden: den Kaufvertrag, den Grundbuchauszug und die Notarrechnung.",
);

const PHOTO_HISTORY = earlierTurn(
  "Zeig meine Favoriten von 2025.",
  "list_photos", { favorite: true, date_from: "2025-01-01", date_to: "2025-12-31" },
  "[earlier result of list_photos: 3 rows, ids 1201,1202,1203]",
  "Du hast 3 Favoriten aus 2025.",
);

const BOOKINGS_HISTORY = earlierTurn(
  "Zeig mir die Buchungen vom Baumarkt im September.",
  "list_transactions", { q: "Baumarkt", from: "2026-09-01", to: "2026-09-30" },
  "[earlier result of list_transactions: 3 rows, ids 9401,9402,9403]",
  "Im September gab es drei Buchungen beim Baumarkt.",
);

/** The same rows, but the answer asked in words whether to tag them — no card was made. */
const ASKED_IN_WORDS_HISTORY = [
  ...BOOKINGS_HISTORY,
  { role: "user" as const, content: "Gib denen den Tag Renovierung." },
  { role: "assistant" as const, content: "Soll ich den drei Buchungen den Tag „Renovierung“ hinzufügen? Bitte bestätige die Änderung." },
];

const METER_HISTORY = earlierTurn(
  "Wie viel Strom haben wir 2025 verbraucht?",
  "consumption_report", { meter_id: 3, from: "2025-01-01", to: "2025-12-31" },
  "[earlier result of consumption_report: meter 3, 2025-01-01..2025-12-31, total 3.412 kWh]",
  "Der Zähler „Strom Haus“ zeigt für 2025 einen Verbrauch von 3.412 kWh.",
);

/**
 * An older turn as the assistant replays it once its summary is written
 * (stage 4 of assistent-wegfindung.md): the question, then the summary with
 * the note of the tools behind it — no tool calls, no rows.
 */
function summarizedTurn(question: string, summary: string, tools: Array<{ tool: string; digest: string | null }>): ChatMessage[] {
  return replaySummarized(question, summary, summaryNote(tools));
}

/**
 * Two turns back the user asked for the hardware-store bookings; that turn
 * is a summary by now, the meter question after it went whole.
 */
const OLDER_BOOKINGS_HISTORY: ChatMessage[] = [
  ...summarizedTurn(
    "Zeig mir die Buchungen vom Baumarkt im September.",
    "Gefragt waren die Buchungen beim Baumarkt im September 2026. Es gab drei Buchungen über zusammen 412,30 €, die größte am 12.09.2026 über 250,00 €.",
    [{ tool: "list_transactions", digest: "[earlier result of list_transactions: 3 rows, ids 9401,9402,9403]" }],
  ),
  ...METER_HISTORY,
];

const PROPOSAL = (summary: string) => ({ proposal: { id: 1, summary, status: "pending — the user confirms on the card" } });

const MAHNUNG_TEXT = "Beispiel Versand GmbH · Beispielstraße 1 · 12345 Musterstadt\n\nMahnung\n\nZu unserer Rechnung BV-77-0042 vom 01.09.2026 über 59,90 € konnten wir noch keinen Zahlungseingang feststellen. Bitte überweisen Sie den Betrag bis zum 30.10.2026.";

export const BENCH_CASES: BenchCase[] = [
  // ── reading (stage 2) ───────────────────────────────────────────────────
  {
    id: "debits-this-month",
    title: "Lastschriften bis Monatsende",
    question: "Welche Lastschriften muss ich in diesem Monat noch erwarten?",
    expect: [{ tool: "upcoming_payments", args: { until: { $in: ["2026-10-31"] }, channel: "direct_debit" } }],
    results: { upcoming_payments: { rows: [{ date: "2026-10-20", counterparty: "Stadtwerke Musterstadt", amount: -84.0 }, { date: "2026-10-28", counterparty: "Beispiel Versicherung AG", amount: -32.5 }], total: -116.5 } },
  },
  {
    id: "debits-until-november",
    title: "Abbuchungen bis Ende November",
    question: "Welche Abbuchungen kommen bis Ende November noch auf mich zu?",
    expect: [{ tool: "upcoming_payments", args: { until: "2026-11-30" } }],
    results: { upcoming_payments: { rows: [{ date: "2026-11-02", counterparty: "Muster Telekom", amount: -39.99 }], total: -39.99 } },
  },
  {
    id: "owners-meeting-minutes",
    title: "Dokumente einer Kategorie suchen",
    question: "Gib mir alle Protokolle der Eigentümerversammlung der Immobilie in Musterstadt.",
    firstTools: ["list_categories", "search_documents"],
    expect: [{ tool: "search_documents", args: { q: { $contains: "eigentümerversammlung" }, category: "kapitalanlage-immobilie-musterstadt" } }],
    results: {
      list_categories: { rows: [{ slug: "kapitalanlage-immobilie-musterstadt", path: "Kapitalanlage › Immobilie Musterstadt" }, { slug: "kapitalanlage-immobilie-beispielheim", path: "Kapitalanlage › Immobilie Beispielheim" }, { slug: "versicherung", path: "Versicherung" }] },
      search_documents: { rows: [{ id: 101, title: "Protokoll Eigentümerversammlung 2025", date: "2025-06-12" }, { id: 87, title: "Protokoll Eigentümerversammlung 2024", date: "2024-06-20" }], total: 2 },
    },
  },
  {
    id: "insurer-documents-by-subject",
    title: "Dokumente eines Absenders zu einem Thema",
    question: "Such mir die Dokumente der TK, in denen es um das Einlösen der Gesundheitsdividende geht.",
    firstTools: ["list_categories", "search_documents"],
    expect: [{ tool: "search_documents", args: { q: { $contains: "gesundheitsdividende" }, correspondent: { $present: true } } }],
    results: {
      list_categories: { rows: [{ slug: "versicherung", path: "Versicherung" }] },
      search_documents: { rows: [{ id: 61, title: "Gesundheitsdividende: Auszahlung beantragen", date: "2026-02-10", from: "TK" }], total: 1 },
    },
  },
  {
    id: "tax-documents-year",
    title: "Steuerunterlagen eines Jahres",
    question: "Welche Dokumente sind für meine Steuererklärung 2025 relevant?",
    expect: [{ tool: "tax_documents", args: { year: 2025 } }],
    results: {
      tax_documents: { summary: "4 documents for the tax return of 2025, in 2 Anlagen", rows: [{ id: 71, title: "Lohnsteuerbescheinigung 2025", section: "Anlage N" }, { id: 72, title: "Jahressteuerbescheinigung Depot", section: "Anlage KAP" }] },
    },
  },
  {
    id: "tax-bundle",
    title: "Steuermappe anlegen",
    question: "Erstelle eine Mappe mit allen Unterlagen für die Steuererklärung 2025.",
    firstTools: ["tax_documents", "tax_return_bundle"],
    expect: [{ tool: "tax_return_bundle", args: { year: 2025 } }],
    results: {
      tax_documents: { summary: "4 documents for the tax return of 2025, in 2 Anlagen", rows: [{ id: 71, title: "Lohnsteuerbescheinigung 2025", section: "Anlage N" }] },
      tax_return_bundle: PROPOSAL("Sammelmappe „Steuererklärung 2025“ mit 4 Dokumenten in 2 Anlagen (Anlage N 2, Anlage KAP 2) und 3 steuerrelevanten Buchungen"),
    },
  },
  {
    id: "tax-worksheet",
    title: "Ausfüllhilfe für die Steuererklärung",
    question: "Hilf mir beim Ausfüllen der Steuererklärung 2025: Was trage ich wo ein?",
    expect: [{ tool: "tax_worksheet", args: { year: 2025 } }],
    results: {
      tax_worksheet: {
        summary: "Worksheet for the tax return of 2025: 3 flagged document(s) in 2 Anlage(n), 4 tax-relevant booking(s).\n== Values by form field (single assessment; form 2025) ==\n  Anlage N — Nichtselbstständige Arbeit — Sie\n    Zeile 5 · Kz 110 | Bruttoarbeitslohn | 48200.00 EUR | 1 unconfirmed | prefilled by the Finanzamt, check only\n      from document 71 (Lohnsteuerbescheinigung 2025, Lohnsteuerbescheinigung): Bruttoarbeitslohn 48200.00 EUR, unconfirmed, page 1\n  Haushaltsnahe Aufwendungen — Erklärung\n    Zeile 9 · Kz 214 | Handwerkerleistungen (Arbeits-, Fahrt- und Maschinenkosten) | 640.00 EUR | all confirmed\n      from document 74 (Rechnung Schornsteinfeger, Handwerkerrechnung): Arbeits-, Fahrt- und Maschinenkosten (Lohnanteil) 640.00 EUR, confirmed\n== Flagged documents by Anlage ==\n== Anlage N (anlage-n) ==\n  71 | 2026-01-20 | Lohnsteuerbescheinigung 2025 | Beispiel GmbH\n== Haushaltsnahe Aufwendungen / §35a (haushaltsnahe) ==\n  73 | 2025-06-02 | Rechnung Gartenpflege | Beispiel Gartenbau\n  74 | 2025-11-14 | Rechnung Schornsteinfeger | Muster Kaminkehrer\n== Tax-relevant bookings of 2025 by tag ==\n  Handwerker: 3 booking(s), -1180.00 EUR\n  Spende: 1 booking(s), -200.00 EUR",
        rows: [{ section: "Anlage N", title: "Lohnsteuerbescheinigung 2025" }, { section: "Haushaltsnahe Aufwendungen / §35a", title: "Rechnung Gartenpflege" }],
      },
    },
  },
  {
    id: "tax-worksheet-pdf",
    title: "Ausfüllhilfe als PDF",
    question: "Leg mir die Ausfüllhilfe für die Steuer 2025 als PDF ab.",
    expect: [{ tool: "tax_worksheet_pdf", args: { year: 2025 } }],
    results: { tax_worksheet_pdf: PROPOSAL("Ausfüllhilfe Steuer 2025 als PDF: 3 Dokumente in 2 Anlagen, 4 steuerrelevante Buchungen, Depotzahlen des Jahres") },
  },
  {
    id: "tax-bookings-year",
    title: "Steuerrelevante Buchungen",
    question: "Zeig mir die steuerrelevanten Buchungen von 2025.",
    expect: [{ tool: "list_transactions", args: { tax_relevant: true, from: "2025-01-01", to: "2025-12-31" } }],
    results: { list_transactions: { rows: [{ id: 9301, date: "2025-03-10", amount: "-480.00", counterparty: "Beispiel Handwerk GmbH", purpose: "Rechnung 2025-017", tax: "yes" }], total: 3 } },
  },
  {
    id: "utility-statements",
    title: "Dokumente frei suchen",
    question: "Such mir die Nebenkostenabrechnungen raus.",
    expect: [{ tool: "search_documents", args: { q: { $contains: "nebenkosten" } } }],
    results: { search_documents: { rows: [{ id: 55, title: "Nebenkostenabrechnung 2025", date: "2026-03-01" }], total: 1 } },
  },
  {
    id: "trips-last-year",
    title: "Reisen letztes Jahr",
    question: "Welche Urlaubsreisen haben wir letztes Jahr gemacht?",
    firstTools: ["list_recaps", "list_trip_plans", "list_albums"],
    expect: [{ tool: "list_recaps", args: { kind: "trip", year: 2025 } }],
    results: {
      list_recaps: { rows: [{ id: 7, title: "Sommer am Gardasee", from: "2025-08-02", to: "2025-08-16" }, { id: 9, title: "Herbst in Wien", from: "2025-10-10", to: "2025-10-13" }] },
      list_trip_plans: { rows: [] },
      list_albums: { rows: [{ id: 31, name: "Gardasee 2025", event: "Sommerurlaub" }] },
    },
  },
  {
    id: "trips-2024",
    title: "Reisen eines Jahres",
    question: "Wo waren wir 2024 überall im Urlaub?",
    firstTools: ["list_recaps", "list_trip_plans", "list_albums"],
    expect: [{ tool: "list_recaps", args: { kind: "trip", year: 2024 } }],
    results: { list_recaps: { rows: [{ id: 3, title: "Ostsee", from: "2024-07-20", to: "2024-08-03" }] }, list_trip_plans: { rows: [] }, list_albums: { rows: [] } },
  },
  {
    id: "photos-at-place",
    title: "Fotos an einem Ort",
    question: "Welche Fotos habe ich in Musterstadt gemacht?",
    expect: [{ tool: "list_photos", args: { place: { $contains: "musterstadt" } } }],
    results: { list_photos: { rows: [{ id: 901, taken: "2019-05-01", place: "Musterstadt, Deutschland" }], total: 1 } },
  },
  {
    id: "best-photos-in-country",
    title: "Beste Fotos eines Landes",
    question: "Zeige mir die 20 besten Fotos aus Beispielland.",
    expect: [{ tool: "list_photos", args: { place: { $contains: "beispielland" }, rank_by: "quality", direction: "desc" } }],
    results: { list_photos: { rows: [{ id: 902, taken: "2023-04-02", place: "Beispielstadt, Beispielland" }], total: 312 } },
  },
  {
    id: "photos-with-description",
    title: "Fotos nach Metadaten",
    question: "Zeige mir 50 Fotos, bei denen die Beschreibung einen Inhalt hat.",
    expect: [{ tool: "list_photos", args: { has_description: true, limit: 50 } }],
    results: { list_photos: { rows: [{ id: 903, taken: "2022-08-14", place: "Musterstadt, Deutschland", description: "Sommerfest im Garten" }], total: 84 } },
  },
  {
    id: "photos-leave-hidden-out",
    title: "Ausgeblendete Fotos bleiben draußen",
    question: "Zeig mir alle Fotos aus dem Jahr 2024.",
    expect: [{ tool: "list_photos", args: { date_from: "2024-01-01", date_to: "2024-12-31", hidden: { $absent: true } } }],
    results: { list_photos: { rows: [{ id: 905, taken: "2024-06-01", place: "Musterstadt, Deutschland" }], total: 640 } },
  },
  {
    id: "photos-with-hidden-on-request",
    title: "Ausgeblendete Fotos nur auf Wunsch",
    question: "Zeig mir alle Fotos aus dem Jahr 2024, auch die ausgeblendeten.",
    expect: [{ tool: "list_photos", args: { date_from: "2024-01-01", date_to: "2024-12-31", hidden: "include" } }],
    results: { list_photos: { rows: [{ id: 906, taken: "2024-06-02", place: "Musterstadt, Deutschland" }], total: 702 } },
  },
  {
    id: "photo-metadata",
    title: "Alles über ein Foto",
    question: "Was weißt du über das Foto 904?",
    expect: [{ tool: "photo_details", args: { ids: [904] } }],
    results: { photo_details: { rows: [{ id: 904, taken: "2021-05-03", place: "Beispielstadt", keywords: "Hafen" }], total: 1 } },
  },
  {
    id: "oldest-photo",
    title: "Ältestes Foto",
    question: "Was ist das älteste Foto in meiner Bibliothek?",
    expect: [{ tool: "list_photos", args: { direction: "asc" } }],
    results: { list_photos: { rows: [{ id: 1, taken: "2003-07-14", place: "Beispielheim" }], total: 48210 } },
  },
  {
    id: "best-photo-per-year-into-album",
    title: "Je Jahr ein Foto einer Person ins Album",
    question: "Such für jedes Jahr das Foto mit Max mit den meisten Likes und füge es dem Album \"Beste Kinder\" hinzu.",
    expect: [
      { tool: "list_persons" },
      { tool: "list_photos", args: { person_ids: { $contains: "41" }, rank_by: "favorites_count", direction: "desc", group_by: "year" } },
      { tool: "add_photos_to_album", args: { album_id: 7, from_previous_result: true } },
    ],
    results: {
      list_persons: { rows: [{ id: 41, name: "Max", faces: 318 }], total: 1 },
      list_albums: { rows: [{ id: 7, name: "Beste Kinder", photos: 12 }], total: 1 },
      list_photos: { rows: [{ group: "2024", id: 911, taken: "2024-07-02", favorites_count: 4 }, { group: "2023", id: 877, taken: "2023-05-19", favorites_count: 3 }], total: 2, note: "ordered by favorites_count descending, the first row of each year (2 groups)" },
      add_photos_to_album: { proposal: "2 Fotos zum Album „Beste Kinder“ hinzufügen", status: "proposed" },
    },
  },
  {
    id: "fewest-comments-per-year",
    title: "Je Jahr das Foto mit den wenigsten Kommentaren",
    question: "Welches Foto mit Max hat in jedem Jahr die wenigsten Kommentare?",
    expect: [
      { tool: "list_persons" },
      { tool: "list_photos", args: { person_ids: { $contains: "41" }, rank_by: "comments_count", direction: "asc", group_by: "year" } },
    ],
    results: {
      list_persons: { rows: [{ id: 41, name: "Max", faces: 318 }], total: 1 },
      list_photos: { rows: [{ group: "2024", id: 912, taken: "2024-03-02", comments_count: 0 }], total: 1 },
    },
  },
  {
    id: "largest-booking-per-month",
    title: "Größte Buchung je Monat",
    question: "Was war dieses Jahr in jedem Monat meine größte Ausgabe?",
    expect: [{ tool: "list_transactions", args: { direction: "out", rank_by: "amount", order: "desc", group_by: "month", from: "2026-01-01" } }],
    results: { list_transactions: { rows: [{ group: "2026-09", id: 9501, date: "2026-09-03", amount: "-1250.00", counterparty: "Beispiel Vermietung", purpose: "Miete" }], total: 1 } },
  },
  {
    id: "largest-document-per-sender",
    title: "Größtes Dokument je Absender",
    question: "Zeig mir je Absender das größte Dokument.",
    expect: [{ tool: "search_documents", args: { rank_by: "size_bytes", direction: "desc", group_by: "correspondent", q: { $absent: true } } }],
    results: { search_documents: { rows: [{ group: "Beispielkasse", id: 310, date: "2025-02-01", size_bytes: 4820000, title: "Jahresbericht" }], total: 1 } },
  },
  {
    id: "beach-photos",
    title: "Fotos nach Inhalt suchen",
    question: "Zeig mir die Fotos vom Strand in Italien.",
    expect: [{ tool: "search_photos", args: { query: { $contains: "strand" } } }],
    results: { search_photos: { ids: [501, 502], total: 2 } },
  },
  {
    id: "groceries-last-month",
    title: "Ausgaben einer Kategorie",
    question: "Wie viel habe ich letzten Monat für Lebensmittel ausgegeben?",
    expect: [{ tool: "transaction_totals", args: { from: "2026-09-01", to: "2026-09-30", direction: "out" } }],
    results: { transaction_totals: { total: -412.37, count: 23, period: "2026-09-01..2026-09-30" } },
  },
  {
    id: "expenses-by-tag",
    title: "Ausgaben mit einem Tag",
    question: "Zeig mir die Ausgaben mit dem Tag Urlaub.",
    firstTools: ["list_transactions", "transaction_totals"],
    expect: [{ tool: "list_transactions", args: { tags: { $contains: "urlaub" }, direction: "out" } }],
    results: {
      list_transactions: { rows: [{ id: 9201, date: "2026-08-12", counterparty: "Beispiel Hotel", purpose: "Übernachtung", amount: -310.0, tags: "Urlaub" }], total: 1 },
      transaction_totals: { total: -310.0, count: 1 },
    },
  },
  {
    id: "bookings-by-counterparty",
    title: "Buchungen eines Händlers",
    question: "Zeig mir alle Buchungen von Musterhandel im September.",
    expect: [{ tool: "list_transactions", args: { q: { $contains: "musterhandel" }, from: "2026-09-01", to: "2026-09-30" } }],
    results: { list_transactions: { rows: [{ id: 9001, date: "2026-09-05", counterparty: "Musterhandel GmbH", amount: -23.9 }], total: -23.9, count: 1 } },
  },
  {
    // Stage 2 of assistent-wegfindung.md: the empty result says which filter
    // shut the rows out; the right road is one more call with that filter
    // dropped (the sender is the question, the month was the guess).
    id: "empty-then-loosen-period",
    title: "Leeres Ergebnis, dann Filter lockern",
    question: "Was habe ich im September an die Musterfirma Haustechnik gezahlt?",
    expect: [
      { tool: "list_transactions", args: { q: { $contains: "musterfirma" }, from: "2026-09-01" } },
      { tool: "list_transactions", args: { q: { $contains: "musterfirma" }, from: { $absent: true }, to: { $absent: true } } },
    ],
    answerMatches: "august|2026-08|12\\.08\\.|nicht im september|keine .*september",
    results: {
      list_transactions: {
        $sequence: [
          {
            rows: [],
            hint: 'No bookings match. The same call with one filter dropped: without q "Musterfirma Haustechnik": 212; without the period 2026-09-01..2026-09-30: 1. Call again with the period 2026-09-01..2026-09-30 dropped and every other filter kept: that brings the 1 row closest to the question. Dropping q "Musterfirma Haustechnik" instead would bring rows the user did not ask for. Say which filter you dropped; if the question needs every filter, tell the user nothing matches.',
            loosen: { drop: ["from", "to"], keep: ["q"], label: "the period 2026-09-01..2026-09-30" },
          },
          { rows: [{ id: 9101, date: "2026-08-12", counterparty: "Musterfirma Haustechnik GmbH", purpose: "Rechnung RE-2026-0101", amount: -120.5 }], total: -120.5, count: 1 },
        ],
      },
    },
  },
  {
    // The hint says that no single filter brings rows: the right road is
    // telling the user so, not a second search with the same arguments.
    id: "empty-nothing-to-loosen",
    title: "Leeres Ergebnis ohne lockerbaren Filter",
    question: "Welche Buchungen von Beispielreisen gab es?",
    expect: [{ tool: "list_transactions", args: { q: { $contains: "beispielreisen" } } }],
    answerMatches: "keine|nicht gefunden|nichts",
    results: {
      list_transactions: {
        rows: [],
        hint: 'No bookings match q "Beispielreisen" (without it: 212, which is everything). Tell the user nothing matches; search once more only with another spelling or a broader word the user\'s own wording allows. Do not repeat the same call.',
      },
    },
  },
  {
    id: "latest-bookings",
    title: "Neueste Buchungen nicht erfinden",
    question: "Zeige mir die 10 neuesten Buchungen.",
    expect: [{ tool: "list_transactions", args: { limit: 10 } }],
    results: {
      list_transactions: {
        rows: [
          { id: 9101, date: "2026-10-14", counterparty: "Beispiel Markt", purpose: "Einkauf", amount: -23.4 },
          { id: 9102, date: "2026-10-13", counterparty: "Muster Tankstelle", purpose: "Tanken", amount: -61.0 },
        ],
        count: 2,
      },
    },
  },
  {
    id: "which-meters",
    title: "Welche Zähler es gibt",
    question: "Welche Zähler haben wir eigentlich?",
    expect: [{ tool: "list_meters" }],
    results: { list_meters: METERS },
  },
  {
    id: "no-meters",
    title: "Keine Zähler im System",
    question: "Was war der letzte Stand vom Gaszähler?",
    expect: [{ tool: "list_meters" }],
    results: { list_meters: { rows: [], note: "No meter is registered in the system." } },
  },
  {
    id: "electricity-last-year",
    title: "Verbrauch eines Zählers",
    question: "Wie hoch war unser Stromverbrauch im letzten Jahr?",
    firstTools: ["list_meters", "consumption_report"],
    expect: [{ tool: "consumption_report", args: { meter_id: 3, from: "2025-01-01", to: "2025-12-31" } }],
    results: { list_meters: METERS, consumption_report: { meter_id: 3, consumption: 3412, unit: "kWh", formula: "reading 2025-12-31 minus reading 2025-01-01" } },
  },
  {
    id: "farm-depreciation",
    title: "AfA der Landwirtschaft",
    question: "Wie hoch ist die AfA für die verpachtete Landwirtschaft im Jahr 2025, und welche Flächen gehören dazu?",
    firstTools: ["list_businesses", "business_assets"],
    expect: [{ tool: "business_assets", args: { business_id: 2, year: 2025 } }],
    results: {
      list_businesses: { rows: [{ id: 1, name: "PV-Anlage Dach", kind: "photovoltaik" }, { id: 2, name: "Landwirtschaft Musterhof", kind: "landwirtschaft" }] },
      business_assets: {
        year: 2025,
        assets: [{ id: 7, name: "Stallgebäude", kind: "gebaeude", acquisition_cost: 120000, afa_rate_pct: 2, afa_2025: 2400, book_value_end_2025: 106200 }],
        parcels: [{ id: 3, parcel: "Musterfeld Flst. 12/3", usage: "acker", area_m2: 21500, lessee: "Beispiel Agrar GbR", annual_rent: 860 }],
        totals: { afa: 2400, book_value: 106200, annual_rent: 860 },
      },
    },
  },
  {
    id: "farm-euer",
    title: "EÜR der Landwirtschaft",
    question: "Wie sieht die Einnahmen-Überschuss-Rechnung der Landwirtschaft für 2025 aus?",
    firstTools: ["list_businesses", "euer_report"],
    expect: [{ tool: "euer_report", args: { business_id: 2, year: 2025 } }],
    results: {
      list_businesses: { rows: [{ id: 1, name: "PV-Anlage Dach", kind: "photovoltaik" }, { id: 2, name: "Landwirtschaft Musterhof", kind: "landwirtschaft" }] },
      euer_report: { year: 2025, income: [{ name: "Pachteinnahmen", sum: 860 }], expenses: [{ name: "Grundsteuer", sum: 96.4 }], afa: 2400, total_income: 860, total_expenses: 2496.4, result: -1636.4 },
    },
  },
  {
    id: "pv-tax-exempt",
    title: "PV-Anlage steuerfrei?",
    question: "Ist meine PV-Anlage eigentlich steuerfrei?",
    firstTools: ["list_businesses", "business_assets"],
    expect: [{ tool: "business_assets", args: { business_id: 1 } }],
    results: {
      list_businesses: { rows: [{ id: 1, name: "PV-Anlage Dach", kind: "photovoltaik" }, { id: 2, name: "Landwirtschaft Musterhof", kind: "landwirtschaft" }] },
      business_assets: { year: 2026, assets: [{ id: 9, name: "PV-Anlage", kind: "pv_anlage", acquisition_cost: 18000, afa_rate_pct: 5 }], pv: { capacity_kwp: 9.8, status: "tax-exempt (§ 3 Nr. 72 EStG): no EÜR, no Anlage G", reason: "9,8 kWp, höchstens 30 kWp" } },
    },
  },
  {
    id: "farm-lease-contracts",
    title: "Pachtverträge der Landwirtschaft",
    question: "Wo sind die Pachtverträge der Landwirtschaft?",
    firstTools: ["list_businesses", "business_documents"],
    expect: [{ tool: "business_documents", args: { business_id: 2 } }],
    results: {
      list_businesses: { rows: [{ id: 1, name: "PV-Anlage Dach", kind: "photovoltaik" }, { id: 2, name: "Landwirtschaft Musterhof", kind: "landwirtschaft" }] },
      business_documents: { rows: [{ document_id: 71, title: "Pachtvertrag Musterfeld", date: "2025-03-01", from: "Beispiel Agrar GbR", linked_to: "parcel Musterfeld Flst. 12/3" }] },
    },
  },
  {
    id: "farm-euer-pdf",
    title: "EÜR als PDF",
    question: "Erstell mir die EÜR 2025 der Landwirtschaft als PDF.",
    firstTools: ["list_businesses", "euer_report", "euer_pdf"],
    expect: [{ tool: "euer_pdf", args: { business_id: 2, year: 2025 } }],
    results: {
      list_businesses: { rows: [{ id: 2, name: "Landwirtschaft Musterhof", kind: "landwirtschaft" }] },
      euer_report: { year: 2025, total_income: 860, total_expenses: 2496.4, result: -1636.4 },
      euer_pdf: { proposal: "EÜR 2025 Landwirtschaft Musterhof als PDF", status: "pending" },
    },
  },
  {
    id: "latest-water-reading",
    title: "Letzter Zählerstand",
    question: "Was war der letzte Stand vom Wasserzähler?",
    firstTools: ["list_meters", "latest_readings"],
    expect: [{ tool: "latest_readings", args: { meter_id: 4 } }],
    results: { list_meters: METERS, latest_readings: { rows: [{ date: "2026-10-01", value: 1234.5, unit: "m³" }] } },
  },
  {
    id: "accounts",
    title: "Konten",
    question: "Welche Konten habe ich eigentlich alle?",
    expect: [{ tool: "list_accounts" }],
    results: { list_accounts: { rows: [{ id: 1, label: "Girokonto" }, { id: 2, label: "Depot" }] } },
  },
  {
    id: "portfolio-gain",
    title: "Depotentwicklung",
    question: "Wie steht mein Depot, und wie viel Gewinn habe ich bisher gemacht?",
    expect: [{ tool: "portfolio_overview" }],
    results: {
      portfolio_overview: {
        summary: "market value 12500.00 EUR; cost basis 10000.00; unrealized gain 2500.00 (25.00 %); realized gain 300.00; income 120.00",
        rows: [{ key: "DE0000000001", name: "Beispiel AG", value: "7500.00", unrealized_gain: "1500.00" }, { key: "DE0000000002", name: "Muster ETF", value: "5000.00", unrealized_gain: "1000.00" }],
      },
    },
  },
  {
    id: "dividends-this-year",
    title: "Dividenden dieses Jahr",
    question: "Welche Dividenden habe ich dieses Jahr bekommen?",
    expect: [{ tool: "depot_transactions", args: { kind: "dividend", from: "2026-01-01", to: "2026-12-31" } }],
    results: {
      depot_transactions: { rows: [{ id: 31, date: "2026-05-12", kind: "dividend", name: "Beispiel AG", net: "48.20" }], total: 1, sums: { net_amount: "48.20", fees: "0.00", taxes: "12.70" } },
    },
  },
  {
    id: "quote-of-security",
    title: "Kurs eines Wertpapiers",
    question: "Wie steht die Beispiel AG gerade, und was gibt es Neues dazu?",
    firstTools: ["portfolio_overview", "quotes", "position_news"],
    // position_news takes the key the quotes row printed; a name is looked
    // up by the tool since the runs of 2026-10-27, so it passes as well.
    expect: [{ tool: "quotes", args: { q: { $contains: "beispiel" } } }, { tool: "position_news", args: { key: "DE0000000001" }, anyOf: [{ key: { $contains: "beispiel ag" } }] }],
    results: {
      portfolio_overview: { rows: [{ key: "DE0000000001", name: "Beispiel AG", value: "7500.00" }] },
      quotes: { rows: [{ key: "DE0000000001", name: "Beispiel AG", "last price": "75.10", at: "2026-10-16 15:30", value: "7510.00", "change 1m": "2.30", "%": "3.16", "unread news": 2 }] },
      position_news: { rows: [{ date: "2026-10-15", source: "Beispiel Wirtschaft", title: "Beispiel AG hebt Prognose an", sentiment: 0.6 }] },
    },
  },
  {
    id: "sales-last-year",
    title: "Verkäufe letztes Jahr",
    question: "Was habe ich letztes Jahr im Depot verkauft, und mit welchem Ergebnis?",
    firstTools: ["portfolio_overview", "depot_transactions"],
    expect: [{ tool: "depot_transactions", args: { kind: "sell", from: "2025-01-01", to: "2025-12-31" } }],
    results: {
      depot_transactions: { rows: [{ id: 22, date: "2025-03-03", kind: "sell", name: "Muster ETF", amount: "10", net: "1210.00" }], total: 1, sums: { net_amount: "1210.00", fees: "4.90", taxes: "0.00" } },
      portfolio_overview: { rows: [{ key: "DE0000000002", name: "Muster ETF", realized: "210.00" }] },
    },
  },
  {
    id: "security-depot",
    title: "In welchem Depot liegt ein Wertpapier",
    question: "In welchem Depot liegt die Beispiel AG?",
    expect: [{ tool: "portfolio_overview", args: { q: { $contains: "beispiel" } } }],
    results: { portfolio_overview: { rows: [{ key: "DE0000000001", name: "Beispiel AG", depot: "Depot Bank A", value: "7500.00" }] } },
  },
  {
    id: "securities-in-depot",
    title: "Wertpapiere eines Depots",
    question: "Welche Wertpapiere liegen im Depot bei der Beispielbank?",
    // The depot by its id from list_accounts, or by its name in q, which
    // portfolio_overview reads as the depot when no security matches it.
    firstTools: ["list_accounts", "portfolio_overview"],
    expect: [{ tool: "portfolio_overview", args: { account_ids: { $present: true } }, anyOf: [{ q: { $contains: "beispielbank" } }] }],
    results: {
      list_accounts: { rows: [{ id: 1, section: "Täglich", label: "Girokonto", type: "Girokonto" }, { id: 2, section: "Sparen", label: "Depot Beispielbank", type: "Depot", balance: "12500.00 EUR (as of 2026-10-15)" }] },
      portfolio_overview: { rows: [{ key: "DE0000000001", name: "Beispiel AG", depot: "Depot Beispielbank", value: "7500.00" }, { key: "DE0000000002", name: "Muster ETF", depot: "Depot Beispielbank", value: "5000.00" }] },
    },
  },
  {
    id: "gain-today",
    title: "Gewinn heute",
    question: "Habe ich heute mit meinen Aktien Gewinn gemacht?",
    expect: [{ tool: "quotes", args: { range: "1d" } }],
    results: { quotes: { summary: "Total value of the 2 priced holdings: 12510.00; change since yesterday: +82.30 (2 with a comparison price). Positive = gain.", rows: [{ key: "DE0000000001", name: "Beispiel AG", "last price": "75.10", "change 1d": "0.60", "%": "0.81" }] } },
  },
  {
    id: "photo-discussions",
    title: "Diskussionen zu Fotos",
    question: "Was wurde zuletzt zu unseren Fotos kommentiert?",
    expect: [{ tool: "photo_activity", args: { kind: "photo_commented" } }],
    results: { photo_activity: { rows: [{ id: 501, at: "2026-10-15 19:02", kind: "comment", who: "Erika Beispiel", album: "Gardasee 2025", photo: 1203, what: "Was für ein Sonnenuntergang!", unread: "yes" }] } },
  },
  {
    id: "account-balance",
    title: "Saldo eines Kontos",
    question: "Wie viel ist gerade auf meinem Girokonto?",
    expect: [{ tool: "list_accounts" }],
    results: {
      list_accounts: {
        rows: [
          { id: 1, section: "Täglich", label: "Girokonto", type: "Girokonto", balance: "1234.56 EUR (as of 2026-10-14)" },
          { id: 3, section: "Täglich", label: "Portemonnaie", type: "Bargeld", balance: "none (cash account)" },
        ],
      },
    },
  },
  {
    id: "shared-albums-participants",
    title: "Freigegebene Alben mit Teilnehmern",
    question: "Erstelle mir eine Liste der Alben, die freigegeben sind, und schreibe jeweils die Teilnehmer dazu.",
    firstTools: ["list_albums", "list_album_shares"],
    expect: [{ tool: "list_album_shares" }],
    results: {
      list_albums: { rows: [{ id: 1, name: "Gardasee 2025", shared: "yes", owner: "me" }], total: 1 },
      list_album_shares: { rows: [{ id: 1, name: "Gardasee 2025", event: "Sommerurlaub", owner: "me", "shared with": "Erika Beispiel, Max Muster", "public link": "no" }] },
    },
  },
  {
    id: "trip-plans",
    title: "Reisen in Planung",
    question: "Welche Reisen haben wir gerade in Planung?",
    expect: [{ tool: "list_trip_plans", args: { year: { $absent: true } } }],
    results: { list_trip_plans: { rows: [{ id: 12, destination: "Musterinsel", from: "2027-05-01", to: "2027-05-14" }] } },
  },
  {
    id: "property-purchase",
    title: "Zwei Module verbinden",
    question: "Zeige mir alles, was beim Kauf der Immobilie in Musterstadt relevant war.",
    firstTools: ["list_categories", "search_documents", "list_transactions"],
    // Two right roads to the documents: a search word, or the property's category from list_categories.
    expect: [{ tool: "search_documents", args: { q: { $present: true } }, anyOf: [{ category: { $present: true } }] }, { tool: "list_transactions" }],
    results: {
      list_categories: { rows: [{ slug: "kapitalanlage-immobilie-musterstadt", path: "Kapitalanlage › Immobilie Musterstadt" }] },
      search_documents: { rows: [{ id: 40, title: "Kaufvertrag Wohnung", date: "2019-04-02" }, { id: 41, title: "Grundbuchauszug", date: "2019-06-10" }], total: 2 },
      list_transactions: { rows: [{ id: 700, date: "2019-05-15", counterparty: "Notariat Muster", amount: -2380.0 }], count: 1 },
    },
  },
  {
    id: "thanks-no-tool",
    title: "Kein Werkzeug, wo keins nötig ist",
    question: "Danke, das war's schon.",
    expect: [],
    forbidTools: true,
    results: {},
  },
  {
    id: "balance-without-finance",
    title: "Fehlende Berechtigung statt „keine Daten“",
    question: "Wie ist mein Kontostand?",
    permissions: ["module.assistant", "module.meters", "meters.view"],
    expect: [],
    forbidTools: true,
    answerMatches: "berechtigung",
    results: {},
  },

  // ── proposals (stage 4) ─────────────────────────────────────────────────
  {
    id: "favorites-album-2025",
    title: "Album aus Filter vorschlagen",
    question: "Mach mir ein Album mit allen favorisierten Bildern von 2025.",
    firstTools: ["list_photos", "create_album"],
    expect: [{ tool: "create_album", args: { name: { $present: true } } }],
    results: {
      list_photos: { ids: [1201, 1202, 1203], total: 143, note: "143 photos; ids truncated" },
      create_album: PROPOSAL("Album „Favoriten 2025“ anlegen und 143 Fotos hinzufügen"),
    },
  },
  {
    id: "photo-collage-caption",
    title: "Collage mit Text vorschlagen",
    question: "Mach aus den Fotos 1201, 1202, 1203 und 1204 eine Collage mit dem Text „Sommer 2025“ unten.",
    expect: [{ tool: "create_photo_collage", args: { photo_ids: [1201, 1202, 1203, 1204], text: { $contains: "sommer 2025" }, text_position: "bottom" } }],
    results: {
      create_photo_collage: PROPOSAL("Collage aus 4 Fotos (Raster 2×2) mit dem Text „Sommer 2025“ unten als neues Foto ablegen"),
    },
  },

  {
    id: "tag-bookings",
    title: "Tag an Buchungen vorschlagen, ohne in Worten nachzufragen",
    question: "Gib denen den Tag Renovierung.",
    history: BOOKINGS_HISTORY,
    previous: { transaction: [9401, 9402, 9403] },
    expect: [{ tool: "tag_transactions", args: { from_previous_result: true, add: { $contains: "renovierung" } } }],
    results: { tag_transactions: PROPOSAL("Bei 3 Buchungen „Renovierung“ setzen") },
  },
  {
    id: "tag-bookings-after-yes",
    title: "„Ja“ auf eine Frage in Worten legt die Karte an",
    question: "Ja.",
    history: ASKED_IN_WORDS_HISTORY,
    previous: { transaction: [9401, 9402, 9403] },
    expect: [{ tool: "tag_transactions", args: { add: { $contains: "renovierung" } } }],
    results: { tag_transactions: PROPOSAL("Bei 3 Buchungen „Renovierung“ setzen") },
  },

  // ── follow-ups on an older, summarized turn (assistent-wegfindung.md, stage 4) ──
  {
    id: "older-turn-tag-bookings",
    title: "Rückfrage auf eine ältere Runde, die nur als Zusammenfassung vorliegt: Tag vorschlagen",
    question: "Gib den Baumarkt-Buchungen von vorhin den Tag Renovierung.",
    history: OLDER_BOOKINGS_HISTORY,
    previous: { transaction: [9401, 9402, 9403] },
    expect: [{ tool: "tag_transactions", args: { from_previous_result: true, add: { $contains: "renovierung" } } }],
    results: { tag_transactions: PROPOSAL("Bei 3 Buchungen „Renovierung“ setzen") },
  },
  {
    id: "older-turn-largest-booking",
    title: "Rückfrage auf eine ältere Runde: die Buchungen aus der Zusammenfassung neu lesen, nicht aus ihr antworten",
    question: "Welche der Baumarkt-Buchungen war die größte, und wann war sie?",
    history: OLDER_BOOKINGS_HISTORY,
    previous: { transaction: [9401, 9402, 9403] },
    expect: [{ tool: "list_transactions", args: { q: { $contains: "baumarkt" }, rank_by: "amount", order: { $present: true } } }],
    results: {
      list_transactions: { rows: [
        { id: 9402, date: "2026-09-12", amount: "-250.00", counterparty: "Baumarkt Musterstadt", purpose: "Fliesen" },
        { id: 9401, date: "2026-09-03", amount: "-98.40", counterparty: "Baumarkt Musterstadt", purpose: "Farbe" },
        { id: 9403, date: "2026-09-27", amount: "-63.90", counterparty: "Baumarkt Musterstadt", purpose: "Schrauben" },
      ], total: 3 },
    },
  },

  // ── follow-ups (stage 5) ────────────────────────────────────────────────
  {
    id: "followup-photos-album",
    title: "Rückfrage: frühere Fotos eingrenzen, Album daraus",
    question: "Nur die aus München, und mach daraus ein Album.",
    history: PHOTO_HISTORY,
    previous: { photo: [1201, 1202, 1203] },
    expect: [
      { tool: "list_photos", args: { from_previous_result: true, place: { $contains: "münchen" } } },
      { tool: "create_album", args: { name: { $present: true }, from_previous_result: true } },
    ],
    results: {
      list_photos: { ids: [1201, 1203], total: 2 },
      create_album: PROPOSAL("Album „München 2025“ anlegen und 2 Fotos hinzufügen"),
    },
  },

  // ── redacted bundles (stage 6, #1532) ───────────────────────────────────
  {
    id: "find-price-in-contract",
    title: "Wert in Dokumenten finden",
    question: "Auf welchen Seiten der Kaufunterlagen steht der Kaufpreis von 450.000,00 €?",
    history: PURCHASE_HISTORY,
    previous: { document: [301, 302, 303] },
    expect: [{ tool: "find_text_in_document", args: { query: { $contains: "450" } } }],
    results: { find_text_in_document: { rows: [{ document: 301, result: "pages 2, 5" }, { document: 302, result: "not found" }, { document: 303, result: "pages 1" }] } },
  },
  {
    id: "redact-price-bundle",
    title: "Geschwärzte Sammelmappe vorschlagen",
    question: "Schwärze darin den Kaufpreis von 450.000,00 € und mach mir ein PDF daraus.",
    history: PURCHASE_HISTORY,
    previous: { document: [301, 302, 303] },
    expect: [{ tool: "create_collection", args: { name: { $present: true }, redact: { $contains: "450.000" } } }],
    results: { create_collection: PROPOSAL("Sammelmappe „Kauf Wohnung“ mit 3 Dokumenten, „450.000,00“ auf 3 Seiten geschwärzt, PDF wird erzeugt") },
  },
  {
    id: "build-collection-pdf",
    title: "PDF einer Sammelmappe",
    question: "Erzeuge bitte das PDF der Sammelmappe 12.",
    expect: [{ tool: "build_collection_pdf", args: { collection_id: 12 } }],
    results: { build_collection_pdf: PROPOSAL("PDF der Sammelmappe „Steuer 2025“ erzeugen") },
  },

  // ── grouped reports (stage 6, #1533) ────────────────────────────────────
  {
    id: "report-with-yield",
    title: "Bericht mit Gruppen und Rendite",
    question: "Liste alle Buchungen zur Wohnung Beispielweg mit Zwischensummen für Kauf, Reparatur und Mieteinnahmen und ermittle die Rendite.",
    firstTools: ["list_transactions", "transaction_report"],
    expect: [{
      tool: "transaction_report",
      args: {
        title: { $present: true },
        groups: { $all: [{ $contains: "kauf" }, { $contains: "reparatur" }, { $contains: "miete" }] },
        "yield.investment_group": { $contains: "kauf" },
      },
    }],
    results: {
      list_transactions: {
        rows: [
          { id: 801, date: "2023-02-01", counterparty: "Notariat Muster", purpose: "Kaufpreis Wohnung Beispielweg", amount: -450000 },
          { id: 802, date: "2023-02-10", counterparty: "Finanzamt Musterstadt", purpose: "Grunderwerbsteuer", amount: -15750 },
          { id: 803, date: "2024-05-03", counterparty: "Musterfirma Haustechnik GmbH", purpose: "Reparatur Heizung Beispielweg", amount: -1200 },
          { id: 804, date: "2026-09-01", counterparty: "Erika Beispiel", purpose: "Miete Beispielweg September", amount: 900 },
          { id: 805, date: "2026-10-01", counterparty: "Erika Beispiel", purpose: "Miete Beispielweg Oktober", amount: 900 },
        ],
        count: 5,
      },
      transaction_report: {
        ...PROPOSAL("Bericht „Wohnung Beispielweg“ als PDF: Kauf 2, Reparatur 1, Mieteinnahmen 2; 5 Buchungen, mit Rendite"),
        figures: "Kauf: 2 bookings, −465.750,00 €\nReparatur: 1 booking, −1.200,00 €\nMieteinnahmen: 2 bookings, 1.800,00 €\nRendite = (1.800,00 € + −1.200,00 €) ÷ 465.750,00 € = 0,13 %",
      },
    },
  },
  {
    id: "report-by-tags",
    title: "Bericht nach Tags",
    question: "Mach mir einen Bericht über meine Wohnungsbuchungen mit je einer Gruppe für die Tags Miete und Hausgeld.",
    firstTools: ["list_transactions", "transaction_report"],
    expect: [{ tool: "transaction_report", args: { groups: { $all: [{ $contains: "miete" }, { $contains: "hausgeld" }] } } }],
    results: {
      // Looking at the bookings first is fine; only the report is scored.
      list_transactions: {
        rows: [
          { id: 811, date: "2026-10-01", counterparty: "Erika Beispiel", purpose: "Miete Oktober", amount: 900, tags: ["Miete"] },
          { id: 812, date: "2026-10-05", counterparty: "Hausverwaltung Muster", purpose: "Hausgeld Oktober", amount: -310, tags: ["Hausgeld"] },
        ],
        count: 36,
      },
      transaction_report: PROPOSAL("Bericht „Wohnung“ als PDF: Miete 24, Hausgeld 12; 36 Buchungen"),
    },
  },
  {
    id: "rule-folder-by-month",
    title: "Regel-Sammelmappe mit Zwischensummen",
    question: "Leg mir eine Sammelmappe für alle Buchungen von Musterfirma Haustechnik seit Januar an, mit Zwischensummen pro Monat.",
    firstTools: ["transaction_totals", "create_transaction_folder"],
    expect: [{
      tool: "create_transaction_folder",
      args: { name: { $present: true }, q: { $contains: "musterfirma" }, from: "2026-01-01", group_by: "month" },
    }],
    results: {
      transaction_totals: { total: -1250.4, count: 9 },
      // The sixth run listed first and, with no rows for the tool, declared
      // there were none: the detour finds rows too.
      list_transactions: { rows: [{ id: 9101, date: "2026-08-12", counterparty: "Musterfirma Haustechnik GmbH", purpose: "Rechnung RE-2026-0101", amount: -120.5 }, { id: 9044, date: "2026-05-03", counterparty: "Musterfirma Haustechnik GmbH", purpose: "Wartung", amount: -180.0 }], total: 9, note: "2 of 9 rows shown" },
      create_transaction_folder: PROPOSAL("Regel-Sammelmappe „Haustechnik 2026“ für Buchungen: Suche „Musterfirma Haustechnik“, ab 01.01.2026; jetzt 9 Buchungen, Summe −1.250,40 €; Zwischensummen je Monat"),
    },
  },

  // ── letters (stage 7, #1534) ────────────────────────────────────────────
  {
    id: "letter-paid-invoices",
    title: "Brief aus drei Rechnungen, Lücke für das Unbekannte",
    question: "Schreib der Musterfirma, dass ich die drei Rechnungen bezahlt habe.",
    context: {
      refs: [{ type: "document", id: 201 }, { type: "document", id: 202 }, { type: "document", id: 203 }],
      briefs: INVOICE_BRIEFS,
    },
    expect: [{
      tool: "render_letter",
      args: {
        body: { $all: [{ $contains: "RE-2026-0101" }, { $contains: "RE-2026-0102" }, { $contains: "89,90" }, { $contains: "[[" }] },
      },
    }],
    results: { render_letter: PROPOSAL("Brief „Ihre Rechnungen“ an Musterfirma Haustechnik GmbH, 3 Anlagen, 1 Lücke zum Ausfüllen") },
  },
  {
    id: "letter-reply-reads-text",
    title: "Antwort entwerfen, Volltext nachlesen",
    question: "Entwirf eine Antwort, in der ich der Mahnung widerspreche. Nenne die Rechnungsnummer und die Frist aus dem Schreiben.",
    context: {
      refs: [{ type: "document", id: 401 }],
      briefs: ['document 401: "Mahnung"\n  from: Beispiel Versand GmbH; dated: 2026-10-01; type: Mahnung\n  reference numbers: none recognised\n  summary: Zahlungserinnerung zu einer offenen Rechnung.'],
    },
    expect: [
      { tool: "get_document_text", args: { id: 401 } },
      { tool: "render_letter", args: { body: { $all: [{ $contains: "BV-77-0042" }, { $contains: "30.10.2026" }] } } },
    ],
    results: {
      get_document_text: {
        text: MAHNUNG_TEXT,
      },
      // The note the real tool adds when the letter leaves out what the text read this turn names.
      render_letter: {
        ...PROPOSAL("Brief „Ihre Mahnung zur Rechnung BV-77-0042“ an Beispiel Versand GmbH"),
        hint: (args: Record<string, unknown>) => leftOutNote(factsLeftOut([MAHNUNG_TEXT], `${String(args.subject ?? "")}\n${String(args.body ?? "")}`)),
      },
    },
  },
  {
    id: "letter-from-bookings",
    title: "Brief aus Buchungen im Arbeitskontext",
    question: "Schreib dem Vermieter, dass die Miete für September und Oktober überwiesen ist, mit Datum und Betrag.",
    context: {
      refs: [{ type: "transaction", id: 901 }, { type: "transaction", id: 902 }],
      briefs: [
        "booking 901: 2026-09-01, −850,00 €, Max Mustermann\n  purpose: Miete September Beispielweg 5",
        "booking 902: 2026-10-01, −850,00 €, Max Mustermann\n  purpose: Miete Oktober Beispielweg 5",
      ],
    },
    expect: [{ tool: "render_letter", args: { body: { $all: [{ $contains: "850,00" }, { $contains: "september" }, { $contains: "oktober" }] } } }],
    results: { render_letter: PROPOSAL("Brief „Mietzahlungen September und Oktober“ an Max Mustermann") },
  },
  {
    id: "keep-answer-as-text-document",
    title: "Antwort als Textdokument ablegen",
    question: "Speichere das als Dokument.",
    history: METER_HISTORY,
    expect: [{
      tool: "create_text_document",
      args: { title: { $present: true }, markdown: { $contains: "3.412" } },
    }],
    results: { create_text_document: PROPOSAL("Textdokument „Stromverbrauch 2025“ ablegen") },
  },

  // ── photo books (fotobuch.md, stage 5) ──────────────────────────────────
  {
    id: "followup-photo-book",
    title: "Rückfrage: Fotobuch aus den früheren Fotos, eingegrenzt im Werkzeug",
    question: "Mach daraus ein Fotobuch mit höchstens 80 Bildern und mehr Landschaft.",
    history: PHOTO_HISTORY,
    previous: { photo: [1201, 1202, 1203] },
    firstTools: ["create_photo_book"],
    expect: [{ tool: "create_photo_book", args: { title: { $present: true }, from_previous_result: true, max_photos: 80 } }],
    results: {
      create_photo_book: PROPOSAL("Fotobuch „Sommer 2025“ aus 3 Fotos gestalten (A4 quer, höchstens 80 Fotos, mehr Landschaft)"),
    },
  },

  // ── multi-step questions (assistent-wegfindung.md, stage 3) ─────────────
  // Two areas, or a chain in words: the router flags the question, the loop
  // asks for a plan first and follows it. A case passes when every step's
  // tool ran; the summary counts these cases apart (multi_area_pass_rate).
  {
    id: "multi-invoices-paid",
    title: "Zwei Bereiche: Rechnungen eines Absenders und ihre Zahlungen",
    question: "Welche Rechnungen der Musterfirma Haustechnik liegen vor, und sind sie alle bezahlt?",
    firstTools: ["search_documents", "list_transactions", "list_correspondents"],
    expect: [
      { tool: "search_documents" },
      { tool: "list_transactions", args: { q: { $contains: "musterfirma" } } },
    ],
    results: {
      search_documents: { rows: [
        { id: 201, title: "Rechnung Heizungswartung", date: "2026-09-02", from: "Musterfirma Haustechnik GmbH", amount: "120,50 €" },
        { id: 202, title: "Rechnung Ersatzteil", date: "2026-09-09", from: "Musterfirma Haustechnik GmbH", amount: "89,90 €" },
      ], total: 2 },
      list_transactions: { rows: [
        { id: 9, date: "2026-09-10", amount: -120.5, counterparty: "Musterfirma Haustechnik GmbH", purpose: "RE-2026-0101" },
      ], total: 1 },
    },
  },
  {
    id: "multi-consumption-and-bill",
    title: "Zwei Bereiche: Stromverbrauch und die Rechnung dazu",
    question: "Wie viel Strom haben wir 2025 verbraucht, und wo ist die Stromrechnung dazu?",
    firstTools: ["list_meters", "consumption_report", "search_documents"],
    expect: [
      { tool: "consumption_report", args: { meter_id: 3, from: "2025-01-01", to: "2025-12-31" } },
      { tool: "search_documents", args: { q: { $contains: "strom" } } },
    ],
    results: {
      list_meters: METERS,
      consumption_report: { meter_id: 3, consumption: 3412, unit: "kWh", formula: "reading 2025-12-31 minus reading 2025-01-01" },
      search_documents: { rows: [{ id: 310, title: "Stromrechnung 2025", date: "2026-02-03", from: "Stadtwerke Musterstadt" }], total: 1 },
    },
  },
  {
    id: "chain-photos-into-album",
    title: "Kette in Worten: Fotos suchen und dann ins Album legen",
    question: "Such die Fotos aus Musterstadt von 2025 raus und leg sie dann in ein Album.",
    firstTools: ["list_photos"],
    expect: [
      { tool: "list_photos", args: { place: { $contains: "musterstadt" }, date_from: "2025-01-01" } },
      { tool: "create_album", args: { name: { $present: true } } },
    ],
    results: {
      list_photos: { ids: [1301, 1302, 1303], total: 27, note: "27 photos; ids truncated" },
      create_album: PROPOSAL("Album „Musterstadt 2025“ anlegen und 27 Fotos hinzufügen"),
    },
  },
];
