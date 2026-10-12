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

import { isinChecksumValid } from "./depot-derivation";
import {
  cleanSecurityName,
  hasStrongSettlementWording,
  normalizeText,
  parseGermanNumber,
  rejoinColumnAmounts,
} from "./depot-settlement-parser";

/** Headings a depot statement, a wealth overview or a reporting prints. */
export const STATEMENT_WORDS = [
  "depotauszug",
  "depotbestand",
  "depotübersicht",
  "depotbewertung",
  "depotaufstellung",
  "depotstatus",
  "vermögensübersicht",
  "vermögensaufstellung",
  "vermögensstatus",
  "vermögensreporting",
  "bestandsübersicht",
  "bestandsaufstellung",
  "bestandsmitteilung",
  "bestandsliste",
  "reporting",
] as const;

/** Regex source for the SQL pre-filter (Postgres `~*`), same words as above. */
export const STATEMENT_CANDIDATE_PATTERN = STATEMENT_WORDS.join("|");
const STATEMENT_RE = new RegExp(STATEMENT_CANDIDATE_PATTERN, "i");

/**
 * A statement by its wording: one of the heading words, and nothing only a
 * settlement or a credit note prints — those are read by the settlement
 * parser, whatever else they mention.
 */
export function looksLikeDepotStatement(text: string): boolean {
  return STATEMENT_RE.test(text) && !hasStrongSettlementWording(text);
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
      const isin = m[1]!;
      if (!isinChecksumValid(isin) || seen.has(isin)) continue;
      seen.add(isin);
      hits.push({ isin, wkn: null, line: i });
    }
  });
  lines.forEach((line, i) => {
    for (const m of line.matchAll(WKN_GLOBAL_RE)) {
      const wkn = m[1]!.toUpperCase();
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

/**
 * The rules' reading of a statement. `positions` has one entry per
 * identifier found; the figures are those labelled near it, null where no
 * label matched.
 */
export function inspectDepotStatement(raw: string | null | undefined): StatementInspection | null {
  if (!raw || raw.trim().length === 0) return null;
  const text = rejoinColumnAmounts(normalizeText(raw));
  const statement = looksLikeDepotStatement(text);
  const lines = text.split("\n");
  const hits = identifierHits(lines);
  const identifierLines = hits.map((h) => h.line);
  const positions: StatementPosition[] = hits.map((hit) => {
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
    positions,
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
    const isin = isinRaw && isinChecksumValid(isinRaw) ? isinRaw : null;
    const wknRaw = str(p.wkn)?.toUpperCase().replace(/\s/g, "") ?? null;
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
