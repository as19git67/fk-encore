/**
 * Settlement parser — reads a Wertpapierabrechnung or a dividend statement
 * (#1336, stage 4).
 *
 * The OCR text of a broker's settlement carries everything a depot
 * transaction needs and the giro booking lacks: quantity, price, gross
 * amount, the fees charged, the taxes withheld, the net amount and the
 * execution date. This module turns that text into a `SettlementExtraction`
 * deterministically — labelled amounts, German number format, the same
 * ISIN/WKN rules as the giro derivation — and says nothing rather than
 * guessing: a field it cannot find is `null`, and a text without a
 * recognisable kind and identifier is not a settlement at all.
 *
 * Layouts differ between brokers but the labels do not, much: "Stück",
 * "Ausführungskurs", "Kurswert", "Provision", "Kapitalertragsteuer",
 * "Ausmachender Betrag", "Schlusstag". The patterns below are anchored
 * on those labels and read the first amount after each. An llm-service
 * fallback can produce the same shape for layouts these miss.
 */

import { extractIsin, extractWkn } from "./depot-derivation";

export type SettlementKind = "buy" | "sell" | "dividend";

/** The fields the parser looks for, in the order a statement is usually read. */
export const SETTLEMENT_FIELDS = [
  "kind",
  "isin",
  "wkn",
  "name",
  "depotNumber",
  "executedAt",
  "quantity",
  "price",
  "gross",
  "fees",
  "tax",
  "net",
  "currency",
] as const;
export type SettlementField = (typeof SETTLEMENT_FIELDS)[number];

export interface SettlementInspection extends Omit<SettlementExtraction, "kind"> {
  kind: SettlementKind | null;
  /** The text is insurance paperwork (policy, surplus statement): never a settlement. */
  insurance: boolean;
  /** The text is a cost disclosure (MiFID "Kosteninformation"): never a settlement. */
  costInfo: boolean;
  /** The text prints wording only a settlement or dividend statement prints. */
  strong: boolean;
  /** The label each amount/date field was read after ("Kurswert", "Schlusstag", …). */
  labels: Partial<Record<SettlementField, string>>;
}

export interface SettlementExtraction {
  kind: SettlementKind;
  isin: string | null;
  wkn: string | null;
  /** Security name as printed after the identifier, when it is printed. */
  name: string | null;
  /** Number of shares/units (positive). */
  quantity: number | null;
  /** Price per unit. */
  price: number | null;
  /** Kurswert / Bruttobetrag (positive). */
  gross: number | null;
  /** Sum of fees and charges (positive). */
  fees: number | null;
  /** Sum of taxes withheld (positive). */
  tax: number | null;
  /** Cash moved, signed: negative for a buy, positive for a sell or a dividend. */
  net: number | null;
  /** Execution date (Schlusstag / Zahlbarkeitstag), YYYY-MM-DD. */
  executedAt: string | null;
  currency: string | null;
  /**
   * Depot number printed on the statement ("Depotnummer 1234567"), digits
   * only. Ties a statement to its depot when no snapshot holds the
   * security any more (sold before the first sync).
   */
  depotNumber: string | null;
  /** Which labels matched — for debugging a layout that reads wrong. */
  markers: string[];
}

const DIVIDEND_MARKERS = [
  "dividendengutschrift",
  "dividendenabrechnung",
  "ertragsgutschrift",
  "erträgnisgutschrift",
  "ausschüttung",
  "ertragsabrechnung",
  "dividende",
];

/**
 * Wording only a broker's settlement or dividend statement prints. One of
 * these makes the text a settlement whatever else it says; without one,
 * the weaker words below ("Ausschüttung", "Abrechnung", "Dividende") count
 * only when the text is not insurance paperwork.
 */
export const STRONG_SETTLEMENT_WORDS = [
  "wertpapierabrechnung",
  "wertpapier-abrechnung",
  "wertpapierkauf",
  "wertpapierverkauf",
  "kaufabrechnung",
  "verkaufsabrechnung",
  "orderabrechnung",
  "fondsabrechnung",
  "ausführungsanzeige",
  "dividendengutschrift",
  "dividendenabrechnung",
  "ertragsgutschrift",
  "erträgnisgutschrift",
  "ertragsabrechnung",
] as const;

const SETTLEMENT_MARKERS = [
  "wertpapierabrechnung",
  "wertpapier-abrechnung",
  "wertpapierkauf",
  "wertpapierverkauf",
  "ausführungsanzeige",
  "abrechnung",
];

/**
 * Insurance paperwork — a life or pension policy's statement, its
 * surplus participation, a policy letter. A unit-linked policy prints its
 * funds' ISINs and words like "Ausschüttung", so without this gate it
 * reads as a dividend statement. The depot never sees any of it.
 */
export const INSURANCE_WORDS = [
  "lebensversicherung",
  "rentenversicherung",
  "versicherungsschein",
  "versicherungsnehmer",
  "versicherungsnummer",
  "versicherungsvertrag",
  "überschussbeteiligung",
  "überschussanteil",
  "policennummer",
  "police-nr",
  "beitragsfrei",
  "ablaufleistung",
  "rückkaufswert",
] as const;

/**
 * A cost disclosure before or after an order (MiFID II "Kosteninformation",
 * "Kostenausweis", ex-ante/ex-post). It names the security, the quantity,
 * the price and the fees — and says the settlement comes separately. It
 * is not a booking, whatever settlement words its prose contains.
 */
const COST_INFO_RE = /kosten(?:vorab)?information|kostenausweis|ex-?ante-?kosten|ex-?post-?kosten/i;

/** True when the text is a cost disclosure and no line is a settlement's heading. */
export function looksLikeCostInformation(text: string): boolean {
  if (!COST_INFO_RE.test(text)) return false;
  // A settlement that appends a cost section still has its heading: a
  // short line with a strong word and no figures ("Wertpapierabrechnung Kauf").
  return !text.split("\n").some((l) => STRONG_RE.test(l) && l.trim().length <= 60 && !/\d/.test(l));
}

/** Regex sources for SQL pre-filters (Postgres `~*`), same words as above. */
export const STRONG_SETTLEMENT_PATTERN = STRONG_SETTLEMENT_WORDS.join("|");
export const INSURANCE_PATTERN = INSURANCE_WORDS.join("|");
/** Any text worth reading: a strong word, or one of the weaker settlement/dividend words. */
export const SETTLEMENT_CANDIDATE_PATTERN =
  `${STRONG_SETTLEMENT_PATTERN}|ausschüttung|dividende|abrechnung[^\n]{0,40}(kauf|verkauf)|(kauf|verkauf)[^\n]{0,40}abrechnung`;

const STRONG_RE = new RegExp(STRONG_SETTLEMENT_PATTERN, "i");
const INSURANCE_RE = new RegExp(INSURANCE_PATTERN, "i");

/** True when the text prints wording only a settlement or dividend statement prints. */
export function hasStrongSettlementWording(text: string): boolean {
  return STRONG_RE.test(text);
}

/** True when the text is insurance paperwork and nothing in it says settlement. */
export function looksLikeInsurancePaper(text: string): boolean {
  return INSURANCE_RE.test(text) && !STRONG_RE.test(text);
}

/** "1.234,56" → 1234.56 ; "1234.56" → 1234.56 ; "12,5" → 12.5 */
export function parseGermanNumber(raw: string): number | null {
  const s = raw.trim().replace(/\s/g, "");
  if (!s) return null;
  let normalized: string;
  if (/,\d{1,8}$/.test(s)) {
    normalized = s.replace(/\./g, "").replace(",", ".");
  } else if (/\.\d{1,2}$/.test(s) && !/\.\d{3}(?:\.|$)/.test(s)) {
    normalized = s.replace(/,/g, "");
  } else {
    normalized = s.replace(/[.,]/g, "");
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

const AMOUNT = String.raw`(-?\s?\d{1,3}(?:[.\s]\d{3})*(?:,\d{1,8})?|-?\s?\d+(?:[.,]\d{1,8})?)`;
const CURRENCY = String.raw`(?:\s*(EUR|USD|CHF|GBP|€|\$))?`;

function normalize(text: string): string {
  return text
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\r/g, "")
    .replace(/\n{2,}/g, "\n");
}

/** First amount after any of the labels, as a positive number. */
function amountAfter(text: string, labels: string[], markers: string[]): number | null {
  for (const label of labels) {
    const re = new RegExp(String.raw`${label}[^\d\n-]{0,40}?${AMOUNT}${CURRENCY}`, "i");
    const m = re.exec(text);
    if (!m) continue;
    const n = parseGermanNumber(m[1]!);
    if (n === null) continue;
    markers.push(label.replace(/\\/g, ""));
    return Math.abs(n);
  }
  return null;
}

/**
 * Sum of every amount following any of the labels (fees, taxes). Labels
 * overlap on purpose ("Provision" also sits inside "Orderprovision"), so
 * an amount is counted once by where it stands in the text, not once per
 * label that reaches it.
 */
function sumAfter(text: string, labels: string[], markers: string[]): number | null {
  const seen = new Set<number>();
  let sum = 0;
  for (const label of labels) {
    const re = new RegExp(String.raw`${label}[^\d\n-]{0,40}?${AMOUNT}${CURRENCY}`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const n = parseGermanNumber(m[1]!);
      if (n === null) continue;
      const at = m.index + m[0].indexOf(m[1]!);
      if (seen.has(at)) continue;
      seen.add(at);
      sum += Math.abs(n);
      markers.push(label.replace(/\\/g, ""));
    }
  }
  return seen.size > 0 ? Math.round(sum * 100) / 100 : null;
}

function dateAfter(text: string, labels: string[], markers: string[]): string | null {
  for (const label of labels) {
    const re = new RegExp(String.raw`${label}[^\d\n]{0,20}?(\d{1,2})\.(\d{1,2})\.(\d{4})`, "i");
    const m = re.exec(text);
    if (!m) continue;
    const day = m[1]!.padStart(2, "0");
    const month = m[2]!.padStart(2, "0");
    markers.push(label.replace(/\\/g, ""));
    return `${m[3]}-${month}-${day}`;
  }
  return null;
}

/**
 * The part of a bank statement that is the settlement. An account
 * statement ("Kontoauszug") can carry a whole Wertpapierabrechnung as one
 * booking, between fee bookings and the boilerplate on the back — which
 * mentions "Dividendenabrechnung" and would otherwise decide the kind.
 * The block runs from a few lines above the first strong word (the
 * booking line with the amount sits there) to the next strong word or
 * the end. Null when the text has no strong word: it is read whole.
 */
export function settlementBlock(text: string): string | null {
  const lines = text.split("\n");
  const hits = lines.map((l, i) => (STRONG_RE.test(l) ? i : -1)).filter((i) => i >= 0);
  if (hits.length === 0) return null;
  const start = Math.max(0, hits[0]! - 3);
  // Only a heading ends the block — a short line without figures — not a
  // label with an amount ("Dividendengutschrift 120,00 EUR") and not the
  // back page's prose that happens to mention a settlement.
  const heading = (i: number) => lines[i]!.trim().length <= 60 && !/\d/.test(lines[i]!);
  const end = hits.find((i) => i > hits[0]! + 1 && heading(i)) ?? lines.length;
  return lines.slice(start, end).join("\n");
}

function firstIndex(lower: string, words: readonly string[]): number {
  let best = -1;
  for (const w of words) {
    const i = lower.indexOf(w);
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  return best;
}

function detectKind(lower: string): SettlementKind | null {
  if (looksLikeInsurancePaper(lower)) return null;
  // Whichever wording comes first decides: a settlement's heading before
  // the back page's "Kontoauszug, Mitteilung oder Dividendenabrechnung".
  const dividendAt = firstIndex(lower, DIVIDEND_MARKERS);
  const settlementAt = firstIndex(lower, SETTLEMENT_MARKERS);
  if (dividendAt >= 0 && (settlementAt < 0 || dividendAt < settlementAt)) return "dividend";
  if (settlementAt < 0) return null;
  // Compound spellings count ("Wertpapierverkauf", "Fondskauf", "Ankauf"),
  // but not "kaufen" in the boilerplate.
  const sell = /\b(?:wertpapier|fonds)?(?:verkauf|veräußerung)(?:s?abrechnung)?\b/.test(lower);
  const buy = /\b(?:wertpapier|fonds|an)?kauf(?:abrechnung)?\b|\b(?:zeichnung|sparplan)\b/.test(lower);
  if (sell && !buy) return "sell";
  if (buy && !sell) return "buy";
  if (sell && buy) {
    // Both words appear (e.g. "Kauf" inside boilerplate): the first wins.
    return lower.indexOf("verkauf") < lower.indexOf("kauf") ? "sell" : "buy";
  }
  return null;
}

function detectCurrency(text: string): string | null {
  const m = /\b(EUR|USD|CHF|GBP)\b/.exec(text);
  if (m) return m[1]!.toUpperCase();
  if (text.includes("€")) return "EUR";
  return null;
}

/** The security name: the text on the line after "Wertpapierbezeichnung" or next to the ISIN. */
function detectName(text: string, isin: string | null, wkn: string | null): string | null {
  const labelled = /(?:Wertpapierbezeichnung|Bezeichnung|Wertpapier|Gattung)\s*[:\n]\s*([^\n]{3,80})/i.exec(text);
  if (labelled) {
    const candidate = labelled[1]!.trim();
    if (!/^(ISIN|WKN)\b/i.test(candidate)) return candidate.replace(/\s{2,}/g, " ");
  }
  const id = isin ?? wkn;
  if (id) {
    // On the identifier's own line, after it ("DE000… Alpha AG").
    const after = new RegExp(String.raw`${id}[ \t]*[\/|,:-]?[ \t]*([A-Za-zÄÖÜäöüß][^\n]{2,80})`).exec(text);
    if (after) {
      const candidate = after[1]!.trim().replace(/\s{2,}/g, " ");
      if (!/^(WKN|ISIN)\b/i.test(candidate)) return candidate;
    }
    // The line above the identifier's line, the usual broker layout:
    //   Alpha Industries AG
    //   ISIN DE000…  WKN …
    const lines = text.split("\n").map((l) => l.trim());
    const at = lines.findIndex((l) => l.includes(id));
    for (let i = at - 1; i >= 0 && i >= at - 2; i--) {
      const line = lines[i]!;
      if (line.length === 0) continue;
      if (looksLikeName(line)) return line.replace(/\s{2,}/g, " ");
      break;
    }
    // Or the line below it, as a statement's booking text prints it:
    //   VERKAUF  WKN 123456 / LU000…
    //   ALPHA GLOBAL FUND A   DEPOTNR.: 1234567
    const below = lines[at + 1];
    if (below) {
      const cut = below.replace(/\s+(?:depot|stück|stk|menge|nominale|kurs|isin|wkn|handelstag|schlusstag|valuta)\S*.*$/i, "").trim();
      if (looksLikeName(cut)) return cut.replace(/\s{2,}/g, " ");
    }
  }
  return null;
}

/** Labels and headings a statement prints around the security, never its name. */
const NOT_A_NAME =
  /^(stück|stk|nominale|kurs|kurswert|preis|wertpapier|kauf|verkauf|dividend|ertrag|erträgnis|ausschüttung|depot|schlusstag|handelstag|ausführung|valuta|datum|abrechnung|zahlbar|isin|wkn|betrag|brutto|netto|provision|steuer|kapitalertrag)/i;

function looksLikeName(line: string): boolean {
  if (line.length < 3 || line.length > 80) return false;
  if (line.includes(":")) return false;
  if (NOT_A_NAME.test(line)) return false;
  const letters = (line.match(/[A-Za-zÄÖÜäöüß]/g) ?? []).length;
  return letters >= 3 && letters >= line.replace(/\s/g, "").length / 2;
}

/**
 * A WKN printed next to the ISIN without its own "WKN" prefix, as in
 * "ISIN/WKN DE000…/123456" or "WKN/ISIN 123456/DE000…" — the prefixed
 * form is what extractWkn already reads.
 */
function wknNextToIsin(text: string, isin: string | null): string | null {
  if (!isin) return null;
  const after = new RegExp(String.raw`${isin}\s*[/|]\s*([A-Z0-9]{6})\b`).exec(text);
  if (after) return after[1]!;
  const before = new RegExp(String.raw`\b([A-Z0-9]{6})\s*[/|]\s*${isin}`).exec(text);
  if (before && /\d/.test(before[1]!)) return before[1]!;
  return null;
}

/** "Depotnummer 123 456 7", "Depot-Nr.: 1234567", "Depotkonto 12-345" → digits only. */
export function extractDepotNumber(text: string): string | null {
  const m = /(?:Depot[-\s]?(?:nummer|nr\.?|konto(?:nummer)?)|Depot)\s*[:.]?\s*(\d[\d \t-]{3,20}\d)/i.exec(text);
  if (!m) return null;
  const digits = m[1]!.replace(/\D/g, "");
  return digits.length >= 5 ? digits : null;
}

/**
 * Read every field the parser knows from one document's text, whether or
 * not it adds up to a settlement — the "what was recognised" view shows
 * partial results too. `kind` is null when no settlement wording was found.
 */
export function inspectSettlement(raw: string | null | undefined): SettlementInspection | null {
  if (!raw || raw.trim().length === 0) return null;
  const whole = normalize(raw);
  const wholeLower = whole.toLowerCase();
  // Amounts and labels are read from the settlement's own block, so the
  // fee bookings around it on an account statement do not count as its
  // fees; what the block lacks (depot number, currency) the whole text supplies.
  const text = settlementBlock(whole) ?? whole;
  const lower = text.toLowerCase();

  const kind = looksLikeInsurancePaper(wholeLower) || looksLikeCostInformation(whole) ? null : detectKind(lower);
  const isin = extractIsin(text) ?? extractIsin(whole);
  const wkn = extractWkn(text) ?? wknNextToIsin(text, isin) ?? extractWkn(whole);

  const markers: string[] = [];
  /** Which label each field was read after, for the "what was recognised" view. */
  const labels: Partial<Record<SettlementField, string>> = {};
  const track = <T,>(field: SettlementField, read: () => T): T => {
    const before = markers.length;
    const value = read();
    if (value !== null && value !== undefined && markers.length > before) {
      labels[field] = [...new Set(markers.slice(before))].join(" + ");
    }
    return value;
  };

  const quantity = track("quantity", () =>
    amountAfter(text, [String.raw`Stück\s*/\s*Nominale`, String.raw`Stück`, String.raw`Stk\.?`, String.raw`Nominale`, String.raw`Anzahl`, String.raw`Menge`], markers) ??
    (() => {
      const m = new RegExp(String.raw`${AMOUNT}\s*(?:Stück|Stk\.?|St\.)`, "i").exec(text);
      if (!m) return null;
      markers.push("n Stück");
      const n = parseGermanNumber(m[1]!);
      return n === null ? null : Math.abs(n);
    })());

  const price = track("price", () => amountAfter(
    text,
    [String.raw`Ausführungskurs`, String.raw`Kurs\s*/\s*Preis`, String.raw`Kurswert\s*je`, String.raw`Preis\s*je`, String.raw`Kurs(?!wert)`, String.raw`Dividende\s*(?:je|pro)\s*(?:Stück|Aktie|Anteil)`, String.raw`Ausschüttung\s*(?:je|pro)\s*(?:Stück|Anteil)`],
    markers,
  ));

  const gross = track("gross", () => amountAfter(
    text,
    [String.raw`Kurswert`, String.raw`Bruttobetrag`, String.raw`Brutto`, String.raw`Dividendengutschrift`, String.raw`Ausschüttung\s*(?:brutto|gesamt)`],
    markers,
  ));

  const fees = track("fees", () => sumAfter(
    text,
    [
      String.raw`Provision`,
      String.raw`Orderprovision`,
      String.raw`Grundgebühr`,
      String.raw`Handelsplatzgebühr`,
      String.raw`Handelsplatzentgelt`,
      String.raw`Transaktionsentgelt`,
      String.raw`Fremde\s*Spesen`,
      String.raw`Fremdspesen`,
      String.raw`Börsengebühr`,
      String.raw`Maklercourtage`,
      String.raw`Courtage`,
      String.raw`Abwicklungsgebühr`,
      String.raw`Gebühr(?:en)?(?!\s*frei)`,
      String.raw`Entgelt`,
    ],
    markers,
  ));

  const tax = track("tax", () => sumAfter(
    text,
    [
      String.raw`Kapitalertrag(?:s)?steuer`,
      String.raw`KESt`,
      String.raw`KapSt`,
      String.raw`Solidaritätszuschlag`,
      String.raw`Soli(?:daritätszuschlag)?\b`,
      String.raw`SolZ\b`,
      String.raw`Kirchensteuer`,
      String.raw`KiSt`,
      String.raw`Quellensteuer`,
      String.raw`QuSt`,
      String.raw`Finanztransaktionssteuer`,
      String.raw`Stempelsteuer`,
    ],
    markers,
  ));

  const netAbs = track("net", () => amountAfter(
    text,
    [
      String.raw`Ausmachender\s*Betrag`,
      String.raw`Endbetrag`,
      String.raw`Gesamtbetrag`,
      String.raw`Nettobetrag`,
      String.raw`Betrag\s*zu\s*Ihren\s*(?:Gunsten|Lasten)`,
      String.raw`Zu\s*Ihren\s*(?:Gunsten|Lasten)`,
      String.raw`Zu\s*Lasten`,
      String.raw`Zu\s*Gunsten`,
      String.raw`Gutschrift\s*(?:in\s*)?Höhe\s*von`,
      String.raw`Belastung\s*(?:in\s*)?Höhe\s*von`,
      // A statement's booking line: "EFFEKTENGUTSCHRIFT PN:925  224,56 H".
      String.raw`Effekten(?:gutschrift|belastung)(?:\s*PN:?\s*\d+)?`,
    ],
    markers,
  ));
  const net = netAbs === null ? null : kind === "buy" ? -netAbs : netAbs;

  const executedAt = track("executedAt", () =>
    kind === "dividend"
      ? dateAfter(text, [String.raw`Zahlbarkeitstag`, String.raw`Zahltag`, String.raw`Valuta`, String.raw`Ex-?Tag`, String.raw`Datum`], markers)
      : dateAfter(text, [String.raw`Schlusstag(?:\s*/\s*-?Zeit)?`, String.raw`Ausführungstag`, String.raw`Handelstag`, String.raw`Ausführung\s*am`, String.raw`Valuta`, String.raw`Datum`], markers));

  return {
    kind,
    insurance: looksLikeInsurancePaper(wholeLower),
    costInfo: looksLikeCostInformation(whole),
    strong: hasStrongSettlementWording(wholeLower),
    isin,
    wkn,
    name: detectName(text, isin, wkn) ?? (text === whole ? null : detectName(whole, isin, wkn)),
    quantity,
    price,
    gross,
    fees,
    tax,
    net,
    executedAt,
    currency: detectCurrency(text) ?? detectCurrency(whole),
    depotNumber: extractDepotNumber(text) ?? extractDepotNumber(whole),
    markers,
    labels,
  };
}

/**
 * Parse one document's text. Returns null when the text is not a
 * settlement: no kind, or neither ISIN nor WKN.
 */
export function parseSettlement(raw: string | null | undefined): SettlementExtraction | null {
  const s = inspectSettlement(raw);
  if (!s || !s.kind || (!s.isin && !s.wkn)) return null;
  return { ...s, kind: s.kind };
}

/** True when the extraction carries enough to create or enrich a transaction. */
export function isUsableSettlement(s: SettlementExtraction | null): s is SettlementExtraction {
  if (!s) return false;
  if (!s.isin && !s.wkn) return false;
  if (!s.executedAt) return false;
  return s.net !== null || s.gross !== null || (s.quantity !== null && s.price !== null);
}
