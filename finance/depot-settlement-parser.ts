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

/**
 * "tax": the tax charged on income that was not paid out — a fund's
 * accumulated income (Thesaurierung) or the Vorabpauschale. Money leaves
 * the account; no shares move and nothing was earned in cash.
 */
export type SettlementKind = "buy" | "sell" | "dividend" | "tax";

/**
 * What kind of paper a document is — each has its own fields, its own
 * arithmetic and its own way to find the transaction it belongs to:
 *
 *   trade         buy or sell: quantity × price = Kurswert, Kurswert ±
 *                 charges = net; found by its net and date
 *   dividend      credit note: quantity × per-share = gross, gross − taxes
 *                 = net; found by its net, or its quantity and date
 *   tax_statement the taxes on a booking that has its own paper: before −
 *                 taxes = after; joins the booking of the same quantity
 *   accumulation  income a fund kept (or a Vorabpauschale): only the tax
 *                 charged, as money out; no arithmetic
 */
export type PaperType = "trade" | "dividend" | "tax_statement" | "accumulation";

export function paperTypeOf(
  r: Pick<SettlementInspection, "kind" | "taxStatement" | "accumulation"> | null,
): PaperType | null {
  if (!r) return null;
  if (r.accumulation) return "accumulation";
  if (r.taxStatement) return "tax_statement";
  if (r.kind === "dividend") return "dividend";
  if (r.kind === "buy" || r.kind === "sell") return "trade";
  return null;
}

/** Whether the net of this kind leaves the account (signed negative). */
export function isMoneyOut(kind: SettlementKind | null): boolean {
  return kind === "buy" || kind === "tax";
}

const NO_TAX_RE = /kein(?:en)?\s+steuerabzug|keine\s+steuern?\s+(?:einbehalten|abgeführt)|ohne\s+steuerabzug/i;
const ACCUMULATION_RE = /thesaurierung|thesaurierte\s+erträge|vorabpauschale|ausschüttungsgleiche\s+erträge/i;
const TRADE_RE = /wertpapier[\s-]*abrechnung|abrechnung\s+(?:kauf|verkauf)\b|wertpapierkauf|wertpapierverkauf|kaufabrechnung|verkaufsabrechnung|orderabrechnung|fondsabrechnung|ausführungsanzeige/i;
const PAYOUT_RE = /dividendengutschrift|ertragsgutschrift|erträgnisgutschrift|ausschüttung(?!sgleich)/i;

/**
 * A notice of income a fund kept (Thesaurierung, ausschüttungsgleiche
 * Erträge) or of the Vorabpauschale: no payout, at most a tax charge. Not
 * when the text is a trade's settlement or a payout's credit note that
 * merely mentions the word.
 */
export function looksLikeAccumulation(text: string): boolean {
  return ACCUMULATION_RE.test(text) && !TRADE_RE.test(text) && !PAYOUT_RE.test(text);
}

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
  /**
   * An account statement (a depot's settlement account) with no settlement
   * of its own in it: fees, interest, transfers and the back page's
   * boilerplate. Never a settlement; one that carries a trade's booking is.
   */
  accountStatement: boolean;
  /** The text prints wording only a settlement or dividend statement prints. */
  strong: boolean;
  /**
   * A credit note or settlement whose amount is before taxes: it prints
   * "Zu Ihren Gunsten vor Steuern" and leaves the taxes to a separate tax
   * statement. Its net is not what the account is credited.
   */
  taxPending: boolean;
  /** The exchange rate a statement in a foreign currency was converted at; its amounts here are in euros. */
  fx: ExchangeRate | null;
  /**
   * Accumulated income or a Vorabpauschale (see looksLikeAccumulation):
   * kind "tax", the net is the tax charged (negative), no gross, no price.
   */
  accumulation: boolean;
  /**
   * A tax statement on its own (see looksLikeTaxStatement): `gross` is the
   * amount before taxes, `net` the one after, and nothing but the tax is
   * ever written to a transaction.
   */
  taxStatement: boolean;
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
  /** Sum of taxes withheld (positive) — negative when taxes were refunded (a loss offset). */
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

const ACCOUNT_STATEMENT_RE = /kontoauszug|(?:alter|neuer)\s+(?:konto)?(?:stand|saldo)|kontostand\s+(?:am|per|vom)/i;

/**
 * An account statement in which settlement wording appears only in prose —
 * the back page's "Kontoauszug, Mitteilung oder Dividendenabrechnung" —
 * and not on a line of its own or a booking line.
 */
export function looksLikeAccountStatementOnly(text: string): boolean {
  if (!ACCOUNT_STATEMENT_RE.test(text)) return false;
  const prose = (line: string) => line.trim().length > 80 || /\s(?:oder|und)\s|mitteilung|hinweis|bitte/i.test(line);
  return !text.split("\n").some((l) => STRONG_RE.test(l) && !prose(l));
}

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
  `${STRONG_SETTLEMENT_PATTERN}|ausschüttung|dividende|thesaurierung|thesaurierte|vorabpauschale|abrechnung[^\n]{0,40}(kauf|verkauf)|(kauf|verkauf)[^\n]{0,40}abrechnung`;

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

// A rate ("12,34 %") is never an amount, nor is a footnote marker ("(1)").
// The amount stands on its label's line: a line break never belongs to it.
// Nor is a number that a date continues ("01.01.26") an amount, nor one a
// legal reference names ("nach § 12a EStG", "Abs. 3", "Nr. 5").
const AMOUNT = String.raw`(?<!(?:§|Abs\.|Nr\.|Art\.)\s?)(-? ?\d{1,3}(?:[. ]\d{3})*(?:,\d{1,8})?|-? ?\d{1,7}(?:[.,]\d{1,8})?)(?![\d.,]*\s*%)(?![\d.,]*\))(?![.,]?\d)`;
// A run of more than seven digits without a separator is an account or
// order number ("zu Gunsten des Kontos 0123456789"), not an amount.
/** What may stand between a label and its amount: text, or a footnote marker ("Kapitalertragsteuer (1) EUR …"). */
const GAP = String.raw`(?:[^\d\n-]|\(\d{1,2}\)){0,40}?`;
const CURRENCY = String.raw`(?:\s*(EUR|USD|CHF|GBP|€|\$))?`;

/** "Steuern", also as OCR reads it off a scan ("Steuem"). */
const STEUERN = String.raw`Steue(?:rn|m)`;
/** A tax refund's total, as the banks label it. */
const TAX_REFUND_LABELS = [
  String.raw`erstattete\s*${STEUERN}`,
  String.raw`${STEUERN}\s*erstattung`,
  String.raw`Steuer(?:r(?:ü|ue)ck)?erstattung`,
  String.raw`Steuerr(?:ü|ue)ckzahlung`,
  String.raw`Erstattung\s*(?:der\s*|von\s*)?(?:${STEUERN}|Kapitalertragsteuer)`,
  String.raw`erstattete\s*Kapitalertragsteuer`,
];

/**
 * A tax statement on its own ("Steuerliche Behandlung: <Geschäftsart>
 * vom <Datum>"): the taxes on a booking that has its own settlement or
 * credit note. It prints the quantity and the amounts before and after
 * taxes, but no price, no Kurswert and no charges — it only adds the tax
 * to a transaction that exists anyway. A settlement with its tax statement
 * appended still has its own heading and is read as a settlement.
 */
export function looksLikeTaxStatement(text: string): boolean {
  if (!TAX_STATEMENT_RE.test(text)) return false;
  const rest = text
    .split("\n")
    .filter((l) => !TAX_STATEMENT_RE.test(l))
    .join("\n");
  return !STRONG_RE.test(rest) && !/Kurswert/i.test(rest);
}

const TAX_STATEMENT_RE = /steuerliche\s+behandlung/i;

function normalize(text: string): string {
  return text
    // A total's underline ("abgeführte Steuern EUR ______ -12,34") would
    // push the amount out of reach of its label.
    .replace(/_{2,}/g, " ")
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\r/g, "")
    .replace(/\n{2,}/g, "\n")
    // OCR splits an amount after its decimal comma ("EUR -1.234, 56"): read
    // alone, "1.234" is a thousand and change. Joined only where the left
    // part is plainly an amount — thousands groups, or a currency before it.
    .replace(/(\d{1,3}(?:\.\d{3})+), (\d{2})(?![\d.,])/g, "$1,$2")
    .replace(/((?:EUR|USD|CHF|GBP|€) ?-? ?\d+), (\d{2})(?![\d.,])/g, "$1,$2");
}

const CURRENCY_ONLY_RE = /(?:EUR|USD|CHF|GBP|€)\s*$/;
const AMOUNT_ONLY_RE = /^-?\d{1,3}(?:\.\d{3})*,\d{2}$|^-?\d+,\d{2}$/;

/**
 * Text read off a two-column table can come out column by column: the
 * labels with their currency ("abgeführte Steuern EUR"), and further down
 * the amounts alone, one per line, in the same order. Each run of such
 * amounts is put back after the labels it belongs to, so that every label
 * is followed by its amount again. A run that does not match the number of
 * labels waiting for one is left as it is.
 */
export function rejoinColumnAmounts(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let waiting: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (AMOUNT_ONLY_RE.test(line)) {
      let j = i;
      while (j < lines.length && AMOUNT_ONLY_RE.test(lines[j]!.trim())) j++;
      const run = lines.slice(i, j).map((l) => l.trim());
      if (run.length === waiting.length) {
        run.forEach((amount, k) => {
          out[waiting[k]!] = `${out[waiting[k]!]} ${amount}`;
        });
        waiting = [];
        i = j - 1;
        continue;
      }
      out.push(...lines.slice(i, j));
      waiting = [];
      i = j - 1;
      continue;
    }
    if (CURRENCY_ONLY_RE.test(line) && !/\d/.test(line)) waiting.push(out.length);
    out.push(lines[i]!);
  }
  return out.join("\n");
}

/** First amount after any of the labels, as a positive number. */
function amountAfter(text: string, labels: string[], markers: string[]): number | null {
  for (const label of labels) {
    const re = new RegExp(String.raw`${label}${GAP}${AMOUNT}${CURRENCY}`, "i");
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
    const re = new RegExp(String.raw`${label}${GAP}${AMOUNT}${CURRENCY}`, "gi");
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
const FINAL_AMOUNT_RE =
  /ausmachender\s*betrag|endbetrag|gesamtbetrag|nettobetrag|zu\s*ihren\s*(?:gunsten|lasten)|effekten(?:gutschrift|belastung)|gutschrift\s*(?:in\s*)?höhe|belastung\s*(?:in\s*)?höhe/i;

export function settlementBlock(text: string): string | null {
  const lines = text.split("\n");
  const hits = lines.map((l, i) => (STRONG_RE.test(l) ? i : -1)).filter((i) => i >= 0);
  if (hits.length === 0) return null;
  const start = Math.max(0, hits[0]! - 3);
  // Only a heading ends the block — a short line without figures — not a
  // label with an amount ("Dividendengutschrift 120,00 EUR") and not the
  // back page's prose that happens to mention a settlement.
  const heading = (i: number) => lines[i]!.trim().length <= 60 && !/\d/.test(lines[i]!);
  // And only once the settlement printed its final amount: a credit note
  // may repeat its own kind as a sub-heading above its figures
  // ("Abrechnung Dividendengutschrift").
  const closed = (i: number) => FINAL_AMOUNT_RE.test(lines.slice(hits[0]!, i).join("\n"));
  const end = hits.find((i) => i > hits[0]! + 1 && heading(i) && closed(i)) ?? lines.length;
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

export interface ExchangeRate {
  /** The currency the statement's amounts are printed in. */
  foreign: string;
  /** Foreign units per euro ("Devisenkurs EUR/USD 1,2500"). */
  perEuro: number;
  /** The amount in euros printed next to the rate, when one is. */
  booked: number | null;
}

/**
 * "zum Devisenkurs: EUR/USD 1,250000  EUR 40,00": a statement in a foreign
 * currency says at what rate it was converted and, mostly, the euro amount
 * that was booked. Null for a statement in euros.
 */
export function exchangeRate(text: string): ExchangeRate | null {
  const m = new RegExp(
    String.raw`Devisenkurs\s*:?\s*(?:EUR\s*/\s*([A-Z]{3})|([A-Z]{3})\s*/\s*EUR)\s+(\d+[.,]\d+)(?:\s+EUR\s+${AMOUNT})?`,
    "i",
  ).exec(text);
  if (!m) return null;
  const quoted = parseGermanNumber(m[3]!);
  if (quoted === null || quoted <= 0) return null;
  const foreign = (m[1] ?? m[2])!.toUpperCase();
  if (foreign === "EUR") return null;
  const booked = m[4] === undefined ? null : parseGermanNumber(m[4]);
  return { foreign, perEuro: m[1] ? quoted : 1 / quoted, booked: booked === null ? null : Math.abs(booked) };
}

function detectCurrency(text: string): string | null {
  const m = /\b(EUR|USD|CHF|GBP)\b/.exec(text);
  if (m) return m[1]!.toUpperCase();
  if (text.includes("€")) return "EUR";
  return null;
}

/** The security name: the text on the line after "Wertpapierbezeichnung" or next to the ISIN. */
function detectName(text: string, isin: string | null, wkn: string | null): string | null {
  const raw = detectNameRaw(text, isin, wkn);
  const name = raw === null ? null : cleanSecurityName(raw);
  if (!name) return null;
  // A table layout prints the identifier in the next column: "Alpha AG  123456".
  const cleaned = [isin, wkn]
    .filter((id): id is string => id !== null)
    .reduce((n, id) => n.replace(new RegExp(String.raw`\s+${id}\s*$`), ""), name)
    .trim();
  return cleaned.length >= 3 ? cleaned : name;
}

function detectNameRaw(text: string, isin: string | null, wkn: string | null): string | null {
  // On the identifier's own line, between the quantity and the identifiers,
  // as a tax statement prints it: "Stk. 25 ALPHA INDUSTRIES AG , WKN / ISIN: …".
  const onIdLine = nameOnIdentifierLine(text, isin, wkn);
  if (onIdLine) return onIdLine;
  // The specific labels first: a bare "Wertpapier:" also heads lines of an
  // appended tax statement that are not the security's name. A label may
  // share its line with the identifier column's heading
  // ("Wertpapier-Bezeichnung   WKN/ISIN"); the name is then on the next line.
  for (const label of [String.raw`Wertpapier-?\s?bezeichnung`, String.raw`Bezeichnung`, String.raw`Gattung`, String.raw`Wertpapier`]) {
    const labelled = new RegExp(
      String.raw`${label}[ \t]*(?::\s*|(?:[ \t]+(?:WPKNR|WKN|ISIN)\b[^\n]*)?\n\s*)([^\n]{3,80})`,
      "i",
    ).exec(text);
    if (!labelled) continue;
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

function nameOnIdentifierLine(text: string, isin: string | null, wkn: string | null): string | null {
  const ids = [isin, wkn].filter((id): id is string => id !== null);
  if (ids.length === 0) return null;
  const line = text.split("\n").find((l) => ids.some((id) => l.includes(id)));
  if (!line) return null;
  const m = /^\s*(?:(?:Stk\.?|Stück|STK)\s*)*[\d.,]+\s+(.+?)\s*,?\s*(?:WKN|ISIN)\b/i.exec(line);
  if (!m) return null;
  const candidate = m[1]!.trim().replace(/\s{2,}/g, " ");
  return looksLikeName(candidate) ? candidate : null;
}

/** Labels and headings a statement prints around the security, never its name. */
const NOT_A_NAME =
  /^(stück|stk|nominale|kurs|kurswert|preis|wertpapier|kauf|verkauf|dividend|ertrag|erträgnis|ausschüttung|depot|schlusstag|handelstag|ausführung|valuta|datum|abrechnung|zahlbar|isin|wkn|betrag|brutto|netto|provision|steuer|kapitalertrag|anlageklasse|anlagestrategie|vermögensdepot|emittent|fondsgesellschaft|herrn?\b|frau\b|inhaber|kunde)/i;

/**
 * A security name as a table row prints it, without the columns around it:
 * "per 01.02.2026 Alpha AG" (the holding's date column), "STK 25 Alpha AG"
 * (the quantity column), "Alpha AG AAA111" (the identifier column). Null when what is left is a label, not a name.
 */
export function cleanSecurityName(raw: string): string | null {
  const name = raw
    .replace(/^(?:per\s+)?\d{1,2}\.\d{1,2}\.\d{2,4}\s+/i, "")
    // "Stück" as OCR also reads it ("Stiick", "Stuck").
    .replace(/^(?:STK|St(?:ü|ii|u)ck|St\.)\s*[\d.,]+\s+/i, "")
    // The identifier column at the end: an ISIN, or a WKN (six characters, at least one digit).
    .replace(/\s+[A-Z]{2}[A-Z0-9]{9}\d$/, "")
    .replace(/\s+(?=[A-Z0-9]*\d)[A-Z0-9]{6}$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (name.length < 2 || NOT_A_NAME.test(name)) return null;
  const letters = (name.match(/[A-Za-zÄÖÜäöüß]/g) ?? []).length;
  return letters >= 2 ? name : null;
}

/**
 * Whether a name read as the security's is a person's — the holder's name
 * from the address block, taken by a reader that looked in the wrong place.
 * `people` are the names it must not be (the users of this installation).
 */
export function isPersonName(name: string, people: readonly string[]): boolean {
  const words = new Set(name.toLowerCase().split(/[^a-zäöüß]+/).filter((w) => w.length >= 2));
  return people.some((person) => {
    const parts = person.toLowerCase().split(/[^a-zäöüß]+/).filter((w) => w.length >= 2);
    return parts.length > 0 && parts.every((p) => words.has(p));
  });
}

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
  const whole = rejoinColumnAmounts(normalize(raw));
  const wholeLower = whole.toLowerCase();
  // Amounts and labels are read from the settlement's own block, so the
  // fee bookings around it on an account statement do not count as its
  // fees; what the block lacks (depot number, currency) the whole text supplies.
  const text = settlementBlock(whole) ?? whole;
  const lower = text.toLowerCase();

  const taxStatement = looksLikeTaxStatement(whole);
  // A tax statement names the booking it belongs to on its heading line
  // ("Steuerliche Behandlung: <Geschäftsart> vom <Datum>").
  const taxLine = taxStatement ? (whole.split("\n").find((l) => TAX_STATEMENT_RE.test(l)) ?? null) : null;
  const accountStatement = looksLikeAccountStatementOnly(whole);
  const kind = looksLikeInsurancePaper(wholeLower) || looksLikeCostInformation(whole) || accountStatement
    ? null
    : (taxLine ? detectKind(taxLine.toLowerCase()) : null) ?? detectKind(lower);
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
    // Not "Stückzinsen" (accrued interest, an amount of money).
    amountAfter(text, [String.raw`Stück\s*/\s*Nominale`, String.raw`Stück(?!zins)`, String.raw`Stk\.?`, String.raw`\bSt\.`, String.raw`Nominale`, String.raw`Anzahl`, String.raw`Menge`], markers) ??
    (() => {
      const m = new RegExp(String.raw`${AMOUNT}\s*(?:Stück|Stk\.?|St\.)`, "i").exec(text);
      if (!m) return null;
      markers.push("n Stück");
      const n = parseGermanNumber(m[1]!);
      return n === null ? null : Math.abs(n);
    })());

  // A tax statement prints no price, Kurswert or charges: whatever those
  // labels reach there belongs to a table of tax bases.
  const price = taxStatement ? null : track("price", () => amountAfter(
    text,
    [String.raw`Ausführungskurs`, String.raw`Kurs\s*/\s*Preis`, String.raw`Kurswert\s*je`, String.raw`Preis\s*je`, String.raw`(?<!Devisen)Kurs(?!wert)`, String.raw`Dividende\s*(?:je|pro)\s*(?:Stück|Aktie|Anteil)`, String.raw`Ausschüttung\s*(?:je|pro)\s*(?:Stück|Anteil)`],
    markers,
  ) ?? (() => {
    // "USD 0,80 Dividende pro Stück": the amount in front of the label.
    const m = new RegExp(String.raw`${AMOUNT}[ \t]*(?:Dividende|Ausschüttung|Ertrag)\s*(?:je|pro)\s*(?:Stück|Aktie|Anteil)`, "i").exec(text);
    if (!m) return null;
    markers.push("n … pro Stück");
    const n = parseGermanNumber(m[1]!);
    return n === null ? null : Math.abs(n);
  })());

  const gross = taxStatement
    ? track("gross", () => amountAfter(text, [String.raw`Zu\s*Ihren\s*(?:Gunsten|Lasten)\s*vor\s*${STEUERN}`], markers))
    : track("gross", () => amountAfter(
    text,
    [String.raw`Kurswert`, String.raw`Bruttobetrag`, String.raw`Brutto`, String.raw`Dividendengutschrift`, String.raw`Ausschüttung\s*(?:brutto|gesamt)`],
    markers,
  ));

  // A printed total ("Summe Entgelte 6,40") is the fees; adding it to the
  // lines it sums would count them twice.
  // Charges a bank lists after the total of its own fees — the exchange's
  // and third parties' — belong to the fees all the same.
  const feesAfterTotal = [
    String.raw`(?:Variable\s*)?Börsenspesen`,
    String.raw`Fremde\s*Spesen`,
    String.raw`Fremdspesen`,
    String.raw`Maklercourtage`,
  ];
  const fees = taxStatement ? null : track("fees", () => {
    const total = new RegExp(
      String.raw`(Summe\s*(?:der\s*)?(?:Entgelte|Gebühren|Kosten|Spesen)|(?:Entgelte|Gebühren|Kosten)\s*gesamt)${GAP}${AMOUNT}`,
      "i",
    ).exec(text);
    const totalAmount = total ? parseGermanNumber(total[2]!) : null;
    if (total && totalAmount !== null) {
      markers.push(total[1]!.replace(/\s+/g, " "));
      const extra = sumAfter(text.slice(total.index + total[0].length), feesAfterTotal, markers) ?? 0;
      return Math.round((Math.abs(totalAmount) + extra) * 100) / 100;
    }
    return sumAfter(
    text,
    [
      String.raw`(?:Variable\s*)?Börsenspesen`,
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
  );
  });

  const netAbs = taxStatement
    ? track("net", () => amountAfter(text, [String.raw`Zu\s*Ihren\s*(?:Gunsten|Lasten)\s*nach\s*${STEUERN}`], markers))
    : track("net", () => amountAfter(
    text,
    [
      String.raw`Ausmachender\s*Betrag`,
      String.raw`Endbetrag`,
      String.raw`Gesamtbetrag`,
      String.raw`Nettobetrag`,
      // A settlement with its tax statement appended prints both; the
      // amount booked is the one after taxes.
      String.raw`Zu\s*Ihren\s*(?:Gunsten|Lasten)\s*nach\s*${STEUERN}`,
      String.raw`Betrag\s*zu\s*Ihren\s*(?:Gunsten|Lasten)(?!\s*vor\s*${STEUERN})`,
      String.raw`Zu\s*Ihren\s*(?:Gunsten|Lasten)(?!\s*vor\s*${STEUERN})`,
      // Not "zu Gunsten des Kontos …": an account number follows.
      String.raw`Zu\s*Lasten(?!\s*(?:des\s*)?Kontos?\b)`,
      String.raw`Zu\s*Gunsten(?!\s*(?:des\s*)?Kontos?\b)`,
      String.raw`Gutschrift\s*(?:in\s*)?Höhe\s*von`,
      String.raw`Belastung\s*(?:in\s*)?Höhe\s*von`,
      // A statement's booking line: "EFFEKTENGUTSCHRIFT PN:100  450,00 H".
      String.raw`Effekten(?:gutschrift|belastung)(?:\s*PN:?\s*\d+)?`,
    ],
    markers,
  ));
  const net = netAbs === null ? null : isMoneyOut(kind) ? -netAbs : netAbs;

  const tax = track("tax", () => (() => {
    // Taxes given back (a sale at a loss offsets earlier gains): the amount
    // raises the net instead of lowering it, so it is kept negative.
    const refund = amountAfter(text, TAX_REFUND_LABELS, markers);
    return refund === null ? null : -refund;
  })() ?? amountAfter(
    text,
    [String.raw`abgeführte\s*${STEUERN}`, String.raw`einbehaltene\s*${STEUERN}(?=\s*[:\s]*(?:EUR|-?\d))`, String.raw`Summe\s*${STEUERN}`, String.raw`${STEUERN}\s*gesamt`],
    markers,
  ) ?? (() => {
    // No printed total: on a tax statement, what lies between the amounts
    // before and after taxes is the tax — safer than adding up every tax
    // word in the tables and footnotes. More after than before: a refund.
    if (!taxStatement || gross === null || netAbs === null) return null;
    markers.push("vor − nach Steuern");
    return Math.round((gross - netAbs) * 100) / 100;
  })() ?? sumAfter(
    text,
    [
      String.raw`Kapitalertrag(?:s)?steuer(?!satz)`,
      String.raw`KESt`,
      String.raw`KapSt`,
      String.raw`Solidaritätszuschlag`,
      String.raw`Soli(?:daritätszuschlag)?\b`,
      String.raw`SolZ\b`,
      String.raw`Kirchensteuer(?!satz)`,
      String.raw`KiSt`,
      // Credited foreign tax is not withheld from this booking.
      String.raw`(?<!angerechnete\s(?:\S+\s)?)Quellensteuer`,
      String.raw`QuSt`,
      String.raw`Finanztransaktionssteuer`,
      String.raw`Stempelsteuer`,
    ],
    markers,
  ));


  const executedAt = track("executedAt", () =>
    (taxLine ? dateAfter(taxLine, [String.raw`Steuerliche\s*Behandlung[^\n]*?\bvom`], markers) : null) ??
    (kind === "dividend"
      ? dateAfter(text, [String.raw`Zahlbarkeitstag`, String.raw`Zahltag`, String.raw`zahlbar\s*ab`, String.raw`Valuta`, String.raw`Ex-?Tag`, String.raw`Datum`], markers)
      : dateAfter(text, [String.raw`Schlusstag(?:\s*/\s*-?Zeit)?`, String.raw`Ausführungstag`, String.raw`Handelstag`, String.raw`Geschäftstag`, String.raw`Ausführung\s*am`, String.raw`Valuta`, String.raw`Datum`], markers)));

  const taxPending =
    !taxStatement &&
    new RegExp(String.raw`Zu\s*Ihren\s*(?:Gunsten|Lasten)\s*vor\s*${STEUERN}`, "i").test(text) &&
    !new RegExp(String.raw`Zu\s*Ihren\s*(?:Gunsten|Lasten)\s*nach\s*${STEUERN}`, "i").test(text);

  // A statement in a foreign currency: every amount is converted at the
  // rate it prints, and the net is the euro amount it says was booked. A
  // depot transaction carries one currency — the account's — so that
  // Kurswert, taxes and the account booking can be checked against each other.
  const printedCurrency = detectCurrency(text) ?? detectCurrency(whole);
  const fx = taxStatement ? null : exchangeRate(text);
  const converted = fx !== null && printedCurrency === fx.foreign;
  const toEuro = (n: number | null, scale: number): number | null =>
    n === null || !converted ? n : Math.round((n / fx!.perEuro) * 10 ** scale) / 10 ** scale;
  if (converted) {
    markers.push("Devisenkurs");
    labels.currency = `Devisenkurs EUR/${fx!.foreign}`;
  }
  const netEuro = !converted
    ? net
    : (() => {
        const abs = fx!.booked ?? toEuro(netAbs, 2);
        return abs === null ? null : isMoneyOut(kind) ? -abs : abs;
      })();

  // Income a fund kept: the only money that moved is the tax charged on it.
  const accumulation =
    !looksLikeInsurancePaper(wholeLower) && !looksLikeCostInformation(whole) && looksLikeAccumulation(whole);
  if (accumulation) {
    // "kein Steuerabzug": a fund abroad, whose income is taxed in the
    // owner's return — nothing was charged, whatever tax words follow.
    const charged = NO_TAX_RE.test(whole) ? 0 : (tax ?? netAbs);
    return {
      kind: "tax",
      insurance: false,
      costInfo: false,
      accountStatement: false,
      strong: hasStrongSettlementWording(wholeLower),
      taxStatement: false,
      taxPending: false,
      accumulation: true,
      fx: null,
      isin,
      wkn,
      name: detectName(text, isin, wkn) ?? (text === whole ? null : detectName(whole, isin, wkn)),
      quantity,
      price: null,
      gross: null,
      fees: null,
      tax: charged,
      net: charged === null ? null : charged === 0 ? 0 : -charged,
      executedAt,
      currency: printedCurrency,
      depotNumber: extractDepotNumber(text) ?? extractDepotNumber(whole),
      markers,
      labels,
    };
  }

  return {
    kind,
    insurance: looksLikeInsurancePaper(wholeLower),
    costInfo: looksLikeCostInformation(whole),
    accountStatement,
    strong: hasStrongSettlementWording(wholeLower),
    taxStatement,
    taxPending,
    accumulation: false,
    fx: converted ? fx : null,
    isin,
    wkn,
    name: detectName(text, isin, wkn) ?? (text === whole ? null : detectName(whole, isin, wkn)),
    quantity,
    price: toEuro(price, 6),
    gross: toEuro(gross, 2),
    fees: toEuro(fees, 2),
    tax: toEuro(tax, 2),
    net: netEuro,
    executedAt,
    currency: converted ? "EUR" : printedCurrency,
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
