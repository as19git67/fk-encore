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
  /** Fails on any tool call at all. */
  forbidTools?: boolean;
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

const PROPOSAL = (summary: string) => ({ proposal: { id: 1, summary, status: "pending — the user confirms on the card" } });

export const BENCH_CASES: BenchCase[] = [
  // ── reading (stage 2) ───────────────────────────────────────────────────
  {
    id: "debits-this-month",
    title: "Lastschriften bis Monatsende",
    question: "Welche Lastschriften muss ich in diesem Monat noch erwarten?",
    expect: [{ tool: "upcoming_direct_debits", args: { until: { $in: ["2026-10-31"] } } }],
    results: { upcoming_direct_debits: { rows: [{ date: "2026-10-20", counterparty: "Stadtwerke Musterstadt", amount: -84.0 }, { date: "2026-10-28", counterparty: "Beispiel Versicherung AG", amount: -32.5 }], total: -116.5 } },
  },
  {
    id: "debits-until-november",
    title: "Lastschriften bis Ende November",
    question: "Welche Abbuchungen kommen bis Ende November noch auf mich zu?",
    expect: [{ tool: "upcoming_direct_debits", args: { until: "2026-11-30" } }],
    results: { upcoming_direct_debits: { rows: [{ date: "2026-11-02", counterparty: "Muster Telekom", amount: -39.99 }], total: -39.99 } },
  },
  {
    id: "owners-meeting-minutes",
    title: "Dokumente einer Kategorie suchen",
    question: "Gib mir alle Protokolle der Eigentümerversammlung der Immobilie in Musterstadt.",
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
        summary: "Worksheet for the tax return of 2025: 3 flagged document(s) in 2 Anlage(n), 4 tax-relevant booking(s).\n== Anlage N (anlage-n) ==\n  71 | 2026-01-20 | Lohnsteuerbescheinigung 2025 | Beispiel GmbH | 48200.00 EUR\n  sum of recognised amounts: 48200.00 EUR\n== Haushaltsnahe Aufwendungen / §35a (haushaltsnahe) ==\n  73 | 2025-06-02 | Rechnung Gartenpflege | Beispiel Gartenbau | 640.00 EUR\n  74 | 2025-11-14 | Rechnung Schornsteinfeger | Muster Kaminkehrer | no amount recognised\n  sum of recognised amounts: 640.00 EUR (1 without amount)\n== Tax-relevant bookings of 2025 by tag ==\n  Handwerker: 3 booking(s), -1180.00 EUR\n  Spende: 1 booking(s), -200.00 EUR",
        rows: [{ section: "Anlage N", title: "Lohnsteuerbescheinigung 2025", amount: 48200 }, { section: "Haushaltsnahe Aufwendungen / §35a", title: "Rechnung Gartenpflege", amount: 640 }],
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
    id: "oldest-photo",
    title: "Ältestes Foto",
    question: "Was ist das älteste Foto in meiner Bibliothek?",
    expect: [{ tool: "list_photos", args: { order: "oldest" } }],
    results: { list_photos: { rows: [{ id: 1, taken: "2003-07-14", place: "Beispielheim" }], total: 48210 } },
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
    expect: [{ tool: "analyze_spending", args: { question: { $present: true } } }],
    results: { analyze_spending: { total: -412.37, formula: "sum of 23 bookings tagged Lebensmittel, 2026-09-01..2026-09-30" } },
  },
  {
    id: "bookings-by-counterparty",
    title: "Buchungen eines Händlers",
    question: "Zeig mir alle Buchungen von Musterhandel im September.",
    expect: [{ tool: "list_transactions", args: { q: { $contains: "musterhandel" }, from: "2026-09-01", to: "2026-09-30" } }],
    results: { list_transactions: { rows: [{ id: 9001, date: "2026-09-05", counterparty: "Musterhandel GmbH", amount: -23.9 }], total: -23.9, count: 1 } },
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
    expect: [{ tool: "consumption_report", args: { meter_id: 3, from: "2025-01-01", to: "2025-12-31" } }],
    results: { list_meters: METERS, consumption_report: { meter_id: 3, consumption: 3412, unit: "kWh", formula: "reading 2025-12-31 minus reading 2025-01-01" } },
  },
  {
    id: "farm-depreciation",
    title: "AfA der Landwirtschaft",
    question: "Wie hoch ist die AfA für die verpachtete Landwirtschaft im Jahr 2025, und welche Flächen gehören dazu?",
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
    expect: [{ tool: "euer_report", args: { business_id: 2, year: 2025 } }],
    results: {
      list_businesses: { rows: [{ id: 1, name: "PV-Anlage Dach", kind: "photovoltaik" }, { id: 2, name: "Landwirtschaft Musterhof", kind: "landwirtschaft" }] },
      euer_report: { year: 2025, income: [{ name: "Pachteinnahmen", sum: 860 }], expenses: [{ name: "Grundsteuer", sum: 96.4 }], afa: 2400, total_income: 860, total_expenses: 2496.4, result: -1636.4 },
    },
  },
  {
    id: "farm-euer-pdf",
    title: "EÜR als PDF",
    question: "Erstell mir die EÜR 2025 der Landwirtschaft als PDF.",
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
    expect: [{ tool: "quotes", args: { q: { $contains: "beispiel" } } }, { tool: "position_news", args: { key: "DE0000000001" } }],
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
    expect: [{ tool: "list_accounts" }, { tool: "portfolio_overview", args: { account_ids: { $present: true } } }],
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
    expect: [{ tool: "search_documents", args: { q: { $present: true } } }, { tool: "list_transactions" }],
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

  // ── proposals (stage 4) ─────────────────────────────────────────────────
  {
    id: "favorites-album-2025",
    title: "Album aus Filter vorschlagen",
    question: "Mach mir ein Album mit allen favorisierten Bildern von 2025.",
    expect: [{ tool: "create_album", args: { name: { $present: true } } }],
    results: {
      list_photos: { ids: [1201, 1202, 1203], total: 143, note: "143 photos; ids truncated" },
      create_album: PROPOSAL("Album „Favoriten 2025“ anlegen und 143 Fotos hinzufügen"),
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
        text: "Beispiel Versand GmbH · Beispielstraße 1 · 12345 Musterstadt\n\nMahnung\n\nZu unserer Rechnung BV-77-0042 vom 01.09.2026 über 59,90 € konnten wir noch keinen Zahlungseingang feststellen. Bitte überweisen Sie den Betrag bis zum 30.10.2026.",
      },
      render_letter: PROPOSAL("Brief „Ihre Mahnung zur Rechnung BV-77-0042“ an Beispiel Versand GmbH"),
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
];
