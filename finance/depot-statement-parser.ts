/**
 * Depot statement parser (documentation/plans/wertpapier-stamm.md, stage 2).
 *
 * A depot statement ("Depotauszug"), a wealth overview or a quarterly
 * reporting says what a depot held on a day: per security a quantity, a
 * price and a value. Read into holdings snapshots, these papers give the
 * reconciliation anchors over the whole history, and the oldest one is the
 * opening position.
 *
 * Pure functions, no database and no network:
 *
 *   looksLikeDepotStatement — the heading words, and no settlement wording
 *   inspectDepotStatement   — the rules' reading: statement date, depot
 *                             number, and a position per identifier found,
 *                             with the figures labelled near it
 *   parseLlmStatement       — validates the model's answer into the same shape
 *   mergeStatement          — one reading from both: the model's values
 *                             first, the rules' where the model has none or
 *                             where the rules' figures add up and the
 *                             model's do not
 *
 * The rules say nothing rather than guessing: a position without an
 * identifier is dropped, one without a quantity is reported, never stored.
 */

import { isinChecksumValid, repairIsin } from "./depot-derivation";
import {
  cleanSecurityName,
  hasStrongSettlementWording,
  normalizeText,
  parseGermanNumber,
  rejoinColumnAmounts,
  STATEMENT_WORDS,
} from "./depot-settlement-parser";

export { STATEMENT_WORDS };

/** Regex source for the SQL pre-filter (Postgres `~*`), same words as above. */
export const STATEMENT_CANDIDATE_PATTERN = STATEMENT_WORDS.join("|");
const STATEMENT_RE = new RegExp(STATEMENT_CANDIDATE_PATTERN, "i");

/**
 * A holdings table: its heading and, soon after, the header row naming the
 * value column ("Depotbestand … Kurswert"). A bank's periodic report
 * (Finanzreport) carries one among account sections and a list of trades
 * — whose settlement words must not hide the table. Postgres `~*` lets `.`
 * cross line breaks; the JavaScript twin spells that out.
 */
export const HOLDINGS_TABLE_PATTERN = String.raw`(depotbestand|depotübersicht|bestandsübersicht|vermögensaufstellung).{0,250}kurswert`;
const HOLDINGS_TABLE_RE = /(depotbestand|depotübersicht|bestandsübersicht|vermögensaufstellung)[\s\S]{0,250}kurswert/i;

/**
 * A statement by its wording: one of the heading words, and nothing only a
 * settlement or a credit note prints — those are read by the settlement
 * parser, whatever else they mention. A holdings table counts whatever
 * else the paper prints.
 */
export function looksLikeDepotStatement(text: string): boolean {
  if (HOLDINGS_TABLE_RE.test(text)) return true;
  return STATEMENT_RE.test(text) && !hasStrongSettlementWording(text);
}

/**
 * A WKN as OCR reads it, repaired: WKNs never use the letters I and O
 * (they would be mistaken for 1 and 0), so an I or O in one is a 1 or 0.
 */
export function repairWkn(raw: string): string {
  return raw.toUpperCase().replace(/O/g, "0").replace(/I/g, "1");
}

export interface StatementPosition {
  isin: string | null;
  wkn: string | null;
  name: string | null;
  /** Shares or units held (positive). */
  quantity: number | null;
  /** Price per unit on the statement's date. */
  price: number | null;
  /** Value of the position (quantity × price, as printed). */
  value: number | null;
  currency: string | null;
  /** The bank's cost basis per unit, where the statement prints one. */
  acquisitionPrice: number | null;
}

export interface StatementReadingValues {
  /** The day the holdings are stated for, YYYY-MM-DD. */
  asOf: string | null;
  /** Depot number printed on the statement, digits only. */
  depotNumber: string | null;
  positions: StatementPosition[];
}

export interface StatementInspection extends StatementReadingValues {
  /** The text reads as a depot statement (see looksLikeDepotStatement). */
  statement: boolean;
  /**
   * The WKNs a holdings table lists, empty when the paper has none. Where a
   * paper has one, the table is what the depot held: an identifier
   * elsewhere — a trade in the report's list, a booking on its account
   * pages — names a security that moved, not one the depot holds.
   */
  tableWkns: string[];
}

// ----------------------------------------------------------------------
// The rules
// ----------------------------------------------------------------------

const ISIN_GLOBAL_RE = /\b([A-Z]{2}[A-Z0-9]{9}\d)\b/g;
const WKN_GLOBAL_RE = /\b(?:WKN|WPKNR|WPK|WP-?KENN(?:NR|NUMMER)?)[.:\s/]+([A-Z0-9]{6})\b/gi;

/** A German amount: thousands with dots, decimals after a comma; or a plain number. */
const AMOUNT = String.raw`(-?\d{1,3}(?:\.\d{3})+(?:,\d{1,8})?|-?\d{1,9}(?:,\d{1,8})?)(?![\d.,]*\s*%)`;
const CURRENCY = String.raw`(?:\s*(?:EUR|USD|CHF|GBP|€|\$))?`;
/**
 * What may stand between a label and its figure on a statement's row:
 * punctuation, a currency, "in EUR", a footnote — never another word, or
 * "Anteile Rücknahmepreis 95,20" would read 95,20 as the quantity.
 */
const GAP = String.raw`(?:[ \t:.]|\bin\b|\(\w{0,10}\)|EUR|USD|CHF|GBP|€|\$)*?`;

const QUANTITY_LABELS = [String.raw`St(?:ü|ii|u)ck`, String.raw`Stk\.?`, String.raw`St\.`, "Anteile?", "Nominale?", "Bestand", "Menge", "Anzahl"];
const QUANTITY_AFTER_LABELS = [String.raw`St(?:ü|ii|u)ck`, String.raw`Stk\.?`, "Anteile?", "St\\."];
const PRICE_LABELS = [String.raw`R(?:ü|ue)cknahmepreis`, "Bewertungskurs", "Kurs", "Preis"];
const VALUE_LABELS = ["Kurswert", "Marktwert", "Gegenwert", "Bestandswert", "Depotwert", "Gesamtwert", "Wert"];
const ACQUISITION_LABELS = ["Einstandskurs", "Einstandspreis", "Einstand", "Kaufkurs", "Anschaffungskurs", "Durchschnittskurs"];

function amountAfter(text: string, labels: string[]): number | null {
  for (const label of labels) {
    const m = new RegExp(String.raw`(?:^|[^A-Za-zÄÖÜäöüß])${label}\b${GAP}${CURRENCY}\s*${AMOUNT}`, "i").exec(text);
    if (!m) continue;
    const n = parseGermanNumber(m[1]!);
    if (n !== null) return Math.abs(n);
  }
  return null;
}

function amountBefore(text: string, labels: string[]): number | null {
  for (const label of labels) {
    const m = new RegExp(String.raw`${AMOUNT}[ \t]*${label}\b`, "i").exec(text);
    if (!m) continue;
    const n = parseGermanNumber(m[1]!);
    if (n !== null) return Math.abs(n);
  }
  return null;
}

const STATEMENT_DATE_RE =
  /(?:per|zum|stand|stichtag|bewertungsstichtag|bewertung\s+(?:am|per|zum)|bestand\s+(?:am|per|zum|vom)|depotauszug\s+(?:am|per|zum|vom))\s*[:.]?\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/i;

/** "Depotauszug per 31.12.2025", "Stand: 31.03.2026" → 2025-12-31 / 2026-03-31. */
export function statementDate(text: string): string | null {
  const m = STATEMENT_DATE_RE.exec(text);
  if (!m) return null;
  const year = Number(m[3]);
  const month = Number(m[2]);
  const day = Number(m[1]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1990 || year > 2100) return null;
  return `${m[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const HOLDINGS_HEADING_RE = /depotbestand|depotübersicht|depotauszug|bestandsübersicht|vermögensaufstellung/i;

function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9äöüß]/g, "");
}

/**
 * Whether a statement's holdings part names the position — by ISIN, WKN
 * or its full name — although no row of it could be read (OCR swallowed
 * the identifier or the quantity). Such a position is not "not held" that
 * day; the paper simply could not be read for it.
 */
export function statementNamesPosition(
  raw: string | null | undefined,
  position: { isins: string[]; wkns: string[]; names: string[] },
): boolean {
  if (!raw) return false;
  const lines = normalizeText(raw).split("\n");
  const start = lines.findIndex((l) => HOLDINGS_HEADING_RE.test(l));
  const part = squash((start < 0 ? lines : lines.slice(start)).join("\n"));
  const ids = [...position.isins, ...position.wkns].map(squash).filter((s) => s.length >= 6);
  const names = position.names.map(squash).filter((s) => s.length >= 5);
  return ids.some((s) => part.includes(s)) || names.some((s) => part.includes(s));
}

/** One line of a report's transaction overview ("14.03.26   Verkauf   120,00 EUR …"). */
export interface ReportTrade {
  executedAt: string;
  kind: "buy" | "sell" | "dividend";
  /** The amount the line prints, unsigned. */
  amount: number;
}

const REPORT_TRADE_RE =
  /^\s*(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})\s+(Verkauf|Kauf|Sparplan(?:kauf)?|Zeichnung|Ausschüttung|Dividende|Ertrag)\s+-?(\d{1,3}(?:\.\d{3})*,\d{2})\s*(?:EUR|€)/i;

/**
 * The trades a periodic report's transaction overview lists, one per line
 * that starts with a date, a kind of trade and an amount. The report books
 * none of them — each has its account booking or its own paper — but it
 * shows which ones the quarter had, so it is linked to them.
 */
export function reportTrades(raw: string | null | undefined): ReportTrade[] {
  if (!raw) return [];
  const out: ReportTrade[] = [];
  for (const line of normalizeText(raw).split("\n")) {
    const m = REPORT_TRADE_RE.exec(line);
    if (!m) continue;
    const day = Number(m[1]);
    const month = Number(m[2]);
    const year = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    if (day < 1 || day > 31 || month < 1 || month > 12) continue;
    const amount = parseGermanNumber(m[5]!);
    if (amount === null || amount === 0) continue;
    const word = m[4]!.toLowerCase();
    const kind = word === "verkauf" ? "sell" : /kauf|sparplan|zeichnung/.test(word) ? "buy" : "dividend";
    out.push({
      executedAt: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      kind,
      amount: Math.abs(amount),
    });
  }
  return out;
}

/** Digits of the depot number the statement prints, when it does. */
function depotNumberOf(text: string): string | null {
  const m = /(?:Depot[-\s]?(?:nummer|nr\.?|konto(?:nummer)?)|Depot)\s*[:.]?\s*(\d[\d \t-]{3,20}\d)/i.exec(text);
  if (!m) return null;
  const digits = m[1]!.replace(/\D/g, "");
  return digits.length >= 5 ? digits : null;
}

interface IdentifierHit {
  isin: string | null;
  wkn: string | null;
  line: number;
}

/** Every ISIN (checksum valid) and prefixed WKN in the text, with the line it stands on. */
function identifierHits(lines: string[]): IdentifierHit[] {
  const hits: IdentifierHit[] = [];
  const seen = new Set<string>();
  lines.forEach((line, i) => {
    for (const m of line.matchAll(ISIN_GLOBAL_RE)) {
      const isin = repairIsin(m[1]!);
      if (!isinChecksumValid(isin) || seen.has(isin)) continue;
      seen.add(isin);
      hits.push({ isin, wkn: null, line: i });
    }
  });
  lines.forEach((line, i) => {
    for (const m of line.matchAll(WKN_GLOBAL_RE)) {
      // A table header ("WKN / Verwahrart") is no identifier: a WKN carries a digit.
      if (!/\d/.test(m[1]!)) continue;
      const wkn = repairWkn(m[1]!);
      if (seen.has(wkn)) continue;
      // The WKN of an ISIN already found on the same or a neighbouring line belongs to it.
      const owner = hits.find((h) => h.isin && Math.abs(h.line - i) <= 1 && h.wkn === null);
      seen.add(wkn);
      if (owner) owner.wkn = wkn;
      else hits.push({ isin: null, wkn, line: i });
    }
  });
  return hits;
}

/**
 * The lines a position's figures are printed on: the name's line above the
 * identifier and a few lines below it, but never across another position's
 * identifier. Two lines above would already be the previous position's
 * figures in a three-line layout.
 */
function blockAround(lines: string[], line: number, identifierLines: number[], before = 1, after = 3): string {
  let start = Math.max(0, line - before);
  let end = Math.min(lines.length - 1, line + after);
  for (const other of identifierLines) {
    if (other === line) continue;
    if (other < line && other >= start) start = other + 1;
    if (other > line && other <= end) end = other - 1;
  }
  return lines.slice(start, end + 1).join("\n");
}

function currencyOf(block: string): string | null {
  const m = /\b(EUR|USD|CHF|GBP)\b/.exec(block);
  if (m) return m[1]!;
  return /€/.test(block) ? "EUR" : null;
}

/** The security's name: on the identifier's line, else the line above it. */
function nameNear(lines: string[], line: number, isin: string | null, wkn: string | null): string | null {
  const strip = (l: string) =>
    l
      .replace(/\b(?:ISIN|WKN|WPKNR)\b[.:\s/]*/gi, " ")
      .replace(isin ?? "\u0000", " ")
      .replace(wkn ?? "\u0000", " ")
      .replace(/\b[A-Z]{2}[A-Z0-9]{9}\d\b/g, " ")
      .replace(/[|/]/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  const candidates = [strip(lines[line] ?? ""), strip(lines[line - 1] ?? "")];
  for (const c of candidates) {
    // A line that is only figures is a table row's numbers, not a name.
    if (!/[A-Za-zÄÖÜäöüß]{2}/.test(c)) continue;
    const withoutAmounts = c.replace(/-?\d{1,3}(?:\.\d{3})*(?:,\d+)?\s*(?:EUR|USD|CHF|GBP|€|%)?/g, " ").replace(/\s{2,}/g, " ").trim();
    const name = cleanSecurityName(withoutAmounts);
    if (name) return name;
  }
  return null;
}

// ----------------------------------------------------------------------
// Holdings table rows (a bank's periodic report)
// ----------------------------------------------------------------------
//
// One position, two or three lines, no labels on the row itself — the
// header row names the columns once per page:
//
//   AAA111 / Girosammelverwahrung 25,000 118,400 EUR 2.960,00 2.500,00 +460,00
//   ALPHA INDUSTRIES AG NA O.N. +0,00
//
// WKN and custody type, quantity, last price, currency, value, purchase
// value, gain; then the name with the accrued interest. A security held
// abroad puts a line with the country and the custodian ("über AKV")
// before its name. OCR reads "/" as "7", a WKN's 0 as O, and splits
// amounts after their separators ("7. 953, 00").

/** The slash between WKN and custody type, as OCR reads it too ("/", "|", "7", "2"). */
const ROW_SLASH = String.raw`[/|72]`;
const NUM = String.raw`[+-]?\d{1,3}(?:\.\d{3})+(?:,\d+)?|[+-]?\d+(?:,\d+)?`;
const HOLDING_ROW_RE = new RegExp(
  String.raw`^\s*([A-Z0-9]{6})\s*${ROW_SLASH}\s*(\S*(?:verwahrung|rechnung))\s+(${NUM})\s+(${NUM})\s+([A-Z]{3})\s+(${NUM})(?:\s+(${NUM}))?`,
  "i",
);
/** A line that heads a table or a page, never a name. */
const TABLE_CHROME_RE = /depotbestand|^\s*wkn\b|^\s*bezeichnung\b|verwahrart|seite\s+\d|finanzreport|kundennummer/i;
/** A line of amounts and currency codes only, no name. */
const FIGURES_ONLY_RE = /^(?:(?:EUR|USD|CHF|GBP)\b|[+-]?\d[\d.,]*|\s)+$/;
/** The custodian line of a security held abroad ("Irland über AKV"). */
const CUSTODIAN_RE = /\b(?:über|uber|ueber)\s+AKV\b|\bAKV\b/i;

/** "7. 953, 00" → "7.953,00": amounts OCR split after a separator. */
function rejoinSplitAmounts(line: string): string {
  return line
    .replace(/(\d)\. (\d{3})(?!\d)/g, "$1.$2")
    .replace(/(\d), (\d{2,3})(?!\d)/g, "$1,$2")
    // "1 234,00": a thousands point OCR read as a space. Only before an
    // amount with two decimals, never after a comma — "12,000 345,600" are
    // two columns.
    .replace(/(?<![\d,.])(\d{1,3}) (\d{3},\d{2})(?!\d)/g, "$1.$2");
}

function num(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseGermanNumber(raw.replace(/^\+/, ""));
  return n === null ? null : Math.abs(n);
}

/** The name on the lines after a row: past the custodian line, without the accrued interest. */
function rowName(lines: string[], row: number): string | null {
  for (let k = row + 1; k <= Math.min(lines.length - 1, row + 3); k++) {
    const line = lines[k]!;
    if (HOLDING_ROW_RE.test(rejoinSplitAmounts(line)) || TABLE_CHROME_RE.test(line)) return null;
    const stripped = rejoinSplitAmounts(line).replace(/\s*[+-]\s*\d[\d.,]*\s*$/, "").trim();
    if (stripped.length === 0 || CUSTODIAN_RE.test(stripped)) continue;
    // The row's figures OCR put on a line of their own ("EUR 1.000,00 +50,00").
    if (FIGURES_ONLY_RE.test(stripped)) continue;
    return cleanSecurityName(stripped);
  }
  return null;
}

/**
 * A holdings-table row as far as its WKN and custody type: looser than
 * HOLDING_ROW_RE, so a row whose figures OCR garbled still counts as one.
 */
const TABLE_ROW_START_RE = new RegExp(String.raw`^\s*([A-Z0-9]{6})\s*${ROW_SLASH}\s*\S*(?:verwahrung|rechnung)\b`, "i");
/** A row whose figures OCR moved off its line: the quantity is all that stands after the custody type. */
const ROW_QUANTITY_RE = new RegExp(String.raw`^\s*([A-Z0-9]{6})\s*${ROW_SLASH}\s*(\S*(?:verwahrung|rechnung))\s+(${NUM})\s*$`, "i");

/** The WKNs the holdings table of a paper lists, from every row that starts like one. */
export function tableRowWkns(lines: string[]): string[] {
  const out = new Set<string>();
  for (const raw of lines) {
    const m = TABLE_ROW_START_RE.exec(raw);
    if (!m) continue;
    const wkn = repairWkn(m[1]!);
    if (/\d/.test(wkn)) out.add(wkn);
  }
  return [...out];
}

/** Every row of a holdings table, with the line it stands on. */
export function holdingRows(lines: string[]): Array<StatementPosition & { line: number }> {
  const rows: Array<StatementPosition & { line: number }> = [];
  lines.forEach((raw, i) => {
    const m = HOLDING_ROW_RE.exec(rejoinSplitAmounts(raw));
    if (!m) {
      // The figures after the quantity went elsewhere: the row still says
      // how many the depot holds, which is what the holdings need.
      const q = ROW_QUANTITY_RE.exec(rejoinSplitAmounts(raw));
      const wkn = q ? repairWkn(q[1]!) : null;
      if (!q || !wkn || !/\d/.test(wkn)) return;
      rows.push({ line: i, isin: null, wkn, name: rowName(lines, i), quantity: num(q[3]), price: null, value: null, currency: null, acquisitionPrice: null });
      return;
    }
    const wkn = repairWkn(m[1]!);
    // Six characters before a custody type, but a WKN has a digit.
    if (!/\d/.test(wkn)) return;
    const quantity = num(m[3]);
    const price = num(m[4]);
    const value = num(m[6]);
    // The column after the value is the purchase value — unless it is the
    // gain already (signed), because the purchase value was not printed.
    const purchase = m[7] && !/^[+-]/.test(m[7]) ? num(m[7]) : null;
    rows.push({
      line: i,
      isin: null,
      wkn,
      name: rowName(lines, i),
      quantity,
      price,
      value,
      currency: m[5]!.toUpperCase(),
      acquisitionPrice:
        purchase !== null && quantity !== null && quantity > 0 ? Math.round((purchase / quantity) * 1e6) / 1e6 : null,
    });
  });
  return rows;
}

/**
 * The part of a long paper the model should read for the positions: the
 * first lines (date, depot number) and everything from the holdings
 * heading on. Null when the paper is short or has no such heading.
 */
export function holdingsSection(text: string, limit = 16_000): string | null {
  if (text.length <= limit) return null;
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /depotbestand|depotübersicht|bestandsübersicht|vermögensaufstellung/i.test(l));
  if (start <= 20) return null;
  return [...lines.slice(0, 15), "…", ...lines.slice(Math.max(15, start - 3))].join("\n");
}

/**
 * The rules' reading of a statement. `positions` has one entry per
 * identifier found; the figures are those labelled near it, null where no
 * label matched — or, in a holdings table, those of its row.
 */
export function inspectDepotStatement(raw: string | null | undefined): StatementInspection | null {
  if (!raw || raw.trim().length === 0) return null;
  const text = rejoinColumnAmounts(normalizeText(raw));
  const statement = looksLikeDepotStatement(text);
  const lines = text.split("\n");
  const rows = holdingRows(lines);
  const tableWkns = rows.length > 0 ? tableRowWkns(lines) : [];
  // A paper with a holdings table holds what the table lists: an identifier
  // outside it (a trade, a booking) gets no position of its own.
  const hits = rows.length > 0 ? [] : identifierHits(lines);
  const identifierLines = [...hits.map((h) => h.line), ...rows.map((r) => r.line)];
  const tablePositions: StatementPosition[] = rows.map(({ line: _line, ...p }) => p);
  const labelledPositions: StatementPosition[] = hits.map((hit) => {
    const block = blockAround(lines, hit.line, identifierLines);
    // "10,5 Anteile" before "Stück 25": a number right before its unit is the quantity for sure.
    const quantity = amountBefore(block, QUANTITY_AFTER_LABELS) ?? amountAfter(block, QUANTITY_LABELS);
    const price = amountAfter(block, PRICE_LABELS);
    const value = amountAfter(block, VALUE_LABELS);
    const acquisitionPrice = amountAfter(block, ACQUISITION_LABELS);
    return {
      isin: hit.isin,
      wkn: hit.wkn,
      name: nameNear(lines, hit.line, hit.isin, hit.wkn),
      quantity,
      price,
      value,
      currency: currencyOf(block),
      acquisitionPrice,
    };
  });
  return {
    statement,
    asOf: statementDate(text),
    depotNumber: depotNumberOf(text),
    positions: [...tablePositions, ...labelledPositions],
    tableWkns,
  };
}

// ----------------------------------------------------------------------
// The model's answer
// ----------------------------------------------------------------------

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 && t.toLowerCase() !== "null" ? t : null;
}

function amount(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? Math.abs(v) : null;
  const s = str(v);
  if (!s) return null;
  const cleaned = s.replace(/[^\d,.-]/g, "");
  const normalized = /,\d{1,8}$/.test(cleaned) ? cleaned.replace(/\./g, "").replace(",", ".") : cleaned.replace(/,/g, "");
  const n = Number(normalized);
  return Number.isFinite(n) ? Math.abs(n) : null;
}

function isoDate(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const de = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
  return de ? `${de[3]}-${de[2]!.padStart(2, "0")}-${de[1]!.padStart(2, "0")}` : null;
}

export interface LlmStatement extends StatementReadingValues {
  /** Whether the model took the text for a depot statement; null when it did not say. */
  isStatement: boolean | null;
}

/** The model's JSON → a reading in the rules' shape; anything malformed becomes null or is dropped. */
export function parseLlmStatement(raw: Record<string, unknown>): LlmStatement {
  let isStatement: boolean | null = null;
  const v = raw.is_statement;
  if (typeof v === "boolean") isStatement = v;
  else if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (t === "true" || t === "ja" || t === "yes") isStatement = true;
    if (t === "false" || t === "nein" || t === "no") isStatement = false;
  }
  const positions: StatementPosition[] = [];
  const list = Array.isArray(raw.positions) ? raw.positions : [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    // An identifier the model misread (a wrong check digit, a seventh character) is no identifier.
    const isinRaw = str(p.isin)?.toUpperCase().replace(/\s/g, "") ?? null;
    const isinFixed = isinRaw ? repairIsin(isinRaw) : null;
    const isin = isinFixed && isinChecksumValid(isinFixed) ? isinFixed : null;
    const wknRaw = str(p.wkn) ? repairWkn(str(p.wkn)!.replace(/\s/g, "")) : null;
    const wkn = wknRaw && /^[A-Z0-9]{6}$/.test(wknRaw) && /\d/.test(wknRaw) ? wknRaw : null;
    if (!isin && !wkn) continue;
    const currency = str(p.currency)?.toUpperCase() ?? null;
    positions.push({
      isin,
      wkn,
      name: str(p.name),
      quantity: amount(p.quantity),
      price: amount(p.price),
      value: amount(p.value),
      currency: currency === "€" ? "EUR" : currency,
      acquisitionPrice: amount(p.acquisition_price),
    });
  }
  const depotRaw = str(raw.depot_number);
  const depotDigits = depotRaw ? depotRaw.replace(/\D/g, "") : "";
  return {
    isStatement,
    asOf: isoDate(raw.as_of),
    depotNumber: depotDigits.length >= 5 ? depotDigits : null,
    positions,
  };
}

// ----------------------------------------------------------------------
// One reading from both
// ----------------------------------------------------------------------

/** quantity × price within one percent of the value: the three figures belong together. */
export function positionAddsUp(p: Pick<StatementPosition, "quantity" | "price" | "value">): boolean | null {
  if (p.quantity === null || p.price === null || p.value === null) return null;
  const expected = p.quantity * p.price;
  const tolerance = Math.max(0.011, Math.abs(p.value) * 0.01);
  return Math.abs(expected - p.value) <= tolerance;
}

export interface MergedPosition extends StatementPosition {
  /** quantity × price ≈ value; null when a figure is missing. */
  checked: boolean | null;
  /** Where the quantity came from. */
  source: "llm" | "rules" | "both";
}

export interface MergedStatement {
  asOf: string | null;
  depotNumber: string | null;
  positions: MergedPosition[];
}

function sameSecurity(a: StatementPosition, b: StatementPosition): boolean {
  return (a.isin !== null && a.isin === b.isin) || (a.wkn !== null && a.wkn === b.wkn);
}

/**
 * The model's reading first — it reads tables off OCR'd text better than
 * the labels do — with the rules filling in what the model left out. Where
 * both read a figure and the model's quantity × price does not give its
 * value while the rules' does, the rules' three figures stand.
 */
export function mergeStatement(
  rules: StatementReadingValues | null,
  llm: StatementReadingValues | null,
): MergedStatement {
  const out: MergedStatement = {
    asOf: rules?.asOf ?? llm?.asOf ?? null,
    depotNumber: rules?.depotNumber ?? llm?.depotNumber ?? null,
    positions: [],
  };
  const rulePositions = [...(rules?.positions ?? [])];
  for (const l of llm?.positions ?? []) {
    const idx = rulePositions.findIndex((r) => sameSecurity(r, l));
    const r = idx >= 0 ? rulePositions.splice(idx, 1)[0]! : null;
    let figures: Pick<StatementPosition, "quantity" | "price" | "value"> = {
      quantity: l.quantity ?? r?.quantity ?? null,
      price: l.price ?? r?.price ?? null,
      value: l.value ?? r?.value ?? null,
    };
    let source: MergedPosition["source"] = !r ? "llm" : l.quantity !== null ? "both" : "rules";
    if (r && positionAddsUp(figures) === false && positionAddsUp(r) === true) {
      figures = { quantity: r.quantity, price: r.price, value: r.value };
      source = "rules";
    }
    out.positions.push({
      isin: l.isin ?? r?.isin ?? null,
      wkn: l.wkn ?? r?.wkn ?? null,
      name: l.name ?? r?.name ?? null,
      ...figures,
      currency: l.currency ?? r?.currency ?? null,
      acquisitionPrice: l.acquisitionPrice ?? r?.acquisitionPrice ?? null,
      checked: positionAddsUp(figures),
      source,
    });
  }
  for (const r of rulePositions) {
    out.positions.push({ ...r, checked: positionAddsUp(r), source: "rules" });
  }
  return out;
}
