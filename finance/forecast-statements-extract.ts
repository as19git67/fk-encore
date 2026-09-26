// Retirement forecast — reading insurer statements (issue #1343).
//
// Pure functions, no database and no network:
//
//   parseStatementText  — fixed patterns for the terms German statements
//                         use (Rückkaufswert, Ablaufleistung, Stand …).
//   parseLlmStatement   — validates what the language model returned.
//   mergeStatementValues— one value set from both, every value checked.
//   computeProposals    — where the statement disagrees with the item.
//   applyProposals      — the item data after the user accepted some.
//
// The patterns are a floor, not a ceiling: they find the common wording
// and nothing clever. The model reads the rest; whichever supplies a value,
// it has to pass the same plausibility checks before it is used.

import type { ForecastStatementValues } from "../db/schema";
import type { ItemType } from "./forecast-engine";

export type StatementValues = ForecastStatementValues;

export const EMPTY_VALUES: StatementValues = {
  referenceDate: null,
  surrenderValue: null,
  contractValue: null,
  guaranteedPayout: null,
  projectedPayout: null,
  premiumMonthly: null,
  premiumYearly: null,
  premiumEndDate: null,
  maturityDate: null,
  guaranteedMonthlyPension: null,
  projectedMonthlyPension: null,
  lumpSum: null,
  pensionStartDate: null,
};

type AmountField =
  | "surrenderValue"
  | "contractValue"
  | "guaranteedPayout"
  | "projectedPayout"
  | "premiumMonthly"
  | "premiumYearly"
  | "guaranteedMonthlyPension"
  | "projectedMonthlyPension"
  | "lumpSum";
type DateField = "referenceDate" | "premiumEndDate" | "maturityDate" | "pensionStartDate";

const AMOUNT_FIELDS: AmountField[] = [
  "surrenderValue",
  "contractValue",
  "guaranteedPayout",
  "projectedPayout",
  "premiumMonthly",
  "premiumYearly",
  "guaranteedMonthlyPension",
  "projectedMonthlyPension",
  "lumpSum",
];
const DATE_FIELDS: DateField[] = ["referenceDate", "premiumEndDate", "maturityDate", "pensionStartDate"];

/** Upper bounds a real statement stays under; anything above is a misread. */
const MAX_AMOUNT: Record<AmountField, number> = {
  surrenderValue: 10_000_000,
  contractValue: 10_000_000,
  guaranteedPayout: 10_000_000,
  projectedPayout: 10_000_000,
  premiumMonthly: 20_000,
  premiumYearly: 240_000,
  guaranteedMonthlyPension: 50_000,
  projectedMonthlyPension: 50_000,
  lumpSum: 10_000_000,
};

// -----------------------------------------------------------------------
// Numbers and dates as statements write them
// -----------------------------------------------------------------------

/**
 * "12.345,67", "12345,67", "12.345" (thousands), "1.234,5". A bare integer
 * without separators counts only next to a currency sign — otherwise years,
 * page numbers and contract numbers would be read as money.
 */
const AMOUNT_RE =
  /(?:(?:EUR|€)\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+,\d{1,2}|\d+)(?:\s*(?:EUR|€|Euro))?/g;

export function parseGermanAmount(s: string): number | null {
  const t = s.replace(/\s/g, "");
  // Dots only as thousands separators in groups of three; a comma for the cents.
  if (!/^(\d{1,3}(\.\d{3})+|\d+)(,\d{1,2})?$/.test(t)) return null;
  const n = Number(t.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function firstAmount(window: string): number | null {
  AMOUNT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = AMOUNT_RE.exec(window))) {
    const whole = m[0];
    const digits = m[1];
    const hasCurrency = /EUR|€|Euro/.test(whole);
    const formatted = digits.includes(",") || digits.includes(".");
    // A percentage is not an amount.
    const after = window.slice(m.index + whole.length, m.index + whole.length + 3);
    if (/^\s*%/.test(after)) continue;
    // A date fragment ("01.10.2032") is not an amount.
    if (/^\d{1,2}\.\d{1,2}\.\d{2,4}/.test(window.slice(m.index))) {
      AMOUNT_RE.lastIndex = m.index + 10;
      continue;
    }
    if (!formatted && !hasCurrency) continue;
    const n = parseGermanAmount(digits);
    if (n != null) return n;
  }
  return null;
}

const DATE_RE = /(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})/;

function firstDate(window: string): string | null {
  const m = DATE_RE.exec(window);
  if (!m) {
    // "Oktober 2032" / "10/2032" as a month.
    const my = /(\d{1,2})\/(\d{4})/.exec(window);
    if (my) return iso(Number(my[2]), Number(my[1]), 1);
    const named = new RegExp(`(${MONTHS.join("|")})\\s+(\\d{4})`, "i").exec(window);
    if (named) return iso(Number(named[2]), MONTHS.findIndex((x) => x.toLowerCase() === named[1].toLowerCase()) + 1, 1);
    return null;
  }
  return iso(Number(m[3]), Number(m[2]), Number(m[1]));
}

const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// -----------------------------------------------------------------------
// Fixed patterns
// -----------------------------------------------------------------------

interface Pattern {
  field: AmountField | DateField;
  label: RegExp;
  /** Labels that disqualify a hit (e.g. "Beitragszahlung" for the maturity). */
  not?: RegExp;
}

// Order matters where labels overlap: the more specific pattern comes first
// and claims its position, so "garantierte Ablaufleistung" is not also read
// as the projected one.
const PATTERNS: Pattern[] = [
  { field: "referenceDate", label: /\b(Stand|Stichtag|Wertstand|Bewertungsstichtag)\b[^\d\n]{0,25}/i },
  { field: "surrenderValue", label: /R(ü|ue)ckkaufs?wert[^\d\n]{0,40}/i },
  {
    field: "guaranteedPayout",
    label: /(garantierte[nrs]?\s+(Ablauf|Kapital)\w*|Garantiekapital|garantiertes\s+Kapital|Mindestablaufleistung)[^\d\n]{0,40}/i,
  },
  {
    field: "projectedPayout",
    label:
      /((voraussichtliche|prognostizierte|m(ö|oe)gliche|gesamte|mutma(ß|ss)liche)[nrs]?\s+(Ablauf|Kapital)\w*|Ablaufleistung\s+(inkl|einschl)\w*\.?[^\d\n]{0,40})[^\d\n]{0,40}/i,
  },
  {
    field: "contractValue",
    label: /((Fonds|Vertrags|Policen)guthaben|Deckungskapital|Vertragswert|Wert\s+Ihre[rs]\s+(Vertrag|Versicherung)\w*|Anteilswert)[^\d\n]{0,40}/i,
  },
  // A premium increase (Dynamik) states the old and the new premium; the new one counts.
  { field: "premiumMonthly", label: /neue[rn]?\s+(monatliche[rn]?\s+)?(Gesamt)?beitrag\w*[^\d\n]{0,30}/i },
  {
    field: "premiumMonthly",
    label: /(monatliche[rn]?\s+Beitrag\w*|Beitrag\w*\s+(monatlich|mtl\.?)|Monatsbeitrag)[^\d\n]{0,30}/i,
    not: /bisherig|alte[rn]?\s/i,
  },
  { field: "premiumYearly", label: /(j(ä|ae)hrliche[rn]?\s+Beitrag\w*|Jahresbeitrag|Beitrag\w*\s+j(ä|ae)hrlich)[^\d\n]{0,30}/i },
  {
    field: "premiumEndDate",
    label: /(Ablauf\s+der\s+Beitragszahlung|Beitragszahlung\w*\s+(bis|endet|Ende)|Beitragszahlungsende|Beitragsende)[^\d\n]{0,25}/i,
  },
  {
    field: "maturityDate",
    label: /(Ablauf\s+der\s+Versicherung|Versicherungsablauf|Vertragsablauf|Vertragsende|Ablauftermin|Ablaufdatum|Ablauf\s+am)[^\d\n]{0,25}/i,
    not: /Beitrag/i,
  },
  {
    field: "guaranteedMonthlyPension",
    label: /garantierte\s+(monatliche\s+)?(Alters|Lebens)?rente[^\d\n]{0,40}/i,
  },
  {
    field: "projectedMonthlyPension",
    label:
      /((voraussichtliche|prognostizierte|m(ö|oe)gliche)\s+(monatliche\s+)?(Regel)?(Alters)?rente|Regelaltersrente|k(ü|ue)nftige[nr]?\s+Regelaltersrente)[^\d\n]{0,60}/i,
  },
  { field: "lumpSum", label: /(Kapitalabfindung|einmalige\s+Kapitalzahlung|Kapitalwahl\w*)[^\d\n]{0,40}/i },
  { field: "pensionStartDate", label: /(Rentenbeginn|Leistungsbeginn|Beginn\s+der\s+(Alters)?rente)[^\d\n]{0,25}/i },
];

/** Values the fixed patterns find in a statement's text. */
export function parseStatementText(text: string): StatementValues {
  const out: StatementValues = { ...EMPTY_VALUES };
  if (!text) return out;
  const claimed: Array<[number, number]> = [];
  const overlaps = (a: number, b: number) => claimed.some(([s, e]) => a < e && b > s);
  for (const p of PATTERNS) {
    const re = new RegExp(p.label.source, p.label.flags.includes("g") ? p.label.flags : p.label.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const start = m.index;
      const end = start + m[0].length;
      if (overlaps(start, end)) continue;
      if ((out as unknown as Record<string, unknown>)[p.field] != null) break; // an earlier, more specific pattern had it
      if (p.not && p.not.test(text.slice(Math.max(0, start - 20), end))) continue;
      const window = text.slice(end, end + 90);
      const isDate = (DATE_FIELDS as string[]).includes(p.field);
      const v = isDate ? firstDate(window) : firstAmount(window);
      if (v == null) continue;
      (out as unknown as Record<string, unknown>)[p.field] = v;
      claimed.push([start, end]);
      break;
    }
  }
  return out;
}

// -----------------------------------------------------------------------
// Model output
// -----------------------------------------------------------------------

/** What the model is asked for; the prompt lists the same keys. */
export const LLM_FIELDS: Record<keyof StatementValues, string> = {
  referenceDate: "Stichtag/Stand der Mitteilung (YYYY-MM-DD)",
  surrenderValue: "Rückkaufswert in Euro",
  contractValue: "Vertragsguthaben/Fondsguthaben/Deckungskapital in Euro",
  guaranteedPayout: "garantierte Ablaufleistung/Kapitalleistung in Euro",
  projectedPayout: "voraussichtliche Ablaufleistung einschließlich Überschüssen in Euro",
  premiumMonthly: "monatlicher Beitrag in Euro (bei einer angekündigten Beitragserhöhung/Dynamik: der neue Beitrag)",
  premiumYearly: "jährlicher Beitrag in Euro",
  premiumEndDate: "Ende der Beitragszahlung (YYYY-MM-DD)",
  maturityDate: "Ablauf des Vertrags (YYYY-MM-DD)",
  guaranteedMonthlyPension: "garantierte monatliche Rente in Euro",
  projectedMonthlyPension: "voraussichtliche monatliche Rente in Euro (bei der gesetzlichen Rente: Regelaltersrente)",
  lumpSum: "Kapitalabfindung/Kapitalwahlrecht als Einmalbetrag in Euro",
  pensionStartDate: "Rentenbeginn (YYYY-MM-DD)",
};

function asNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const s = v.replace(/EUR|€|Euro/gi, "").trim();
    // Models also answer in English notation ("241.02"): one dot with cents is a decimal point.
    if (/^\d+\.\d{1,2}$/.test(s)) return Number(s);
    return parseGermanAmount(s);
  }
  return null;
}

function asDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  const isoM = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (isoM) return iso(Number(isoM[1]), Number(isoM[2]), Number(isoM[3]));
  return firstDate(s);
}

/** The model's JSON, reduced to typed values. Unknown keys and junk are dropped. */
export function parseLlmStatement(raw: unknown): StatementValues {
  const out: StatementValues = { ...EMPTY_VALUES };
  if (!raw || typeof raw !== "object") return out;
  const o = raw as Record<string, unknown>;
  for (const f of AMOUNT_FIELDS) out[f] = asNumber(o[f]);
  for (const f of DATE_FIELDS) out[f] = asDate(o[f]);
  return out;
}

// -----------------------------------------------------------------------
// Plausibility and merging
// -----------------------------------------------------------------------

/** Drops values no real statement would state. `today` is YYYY-MM-DD. */
export function validateValues(v: StatementValues, today: string): StatementValues {
  const out: StatementValues = { ...v };
  for (const f of AMOUNT_FIELDS) {
    const n = out[f];
    if (n == null) continue;
    if (!(n > 0) || n > MAX_AMOUNT[f]) out[f] = null;
  }
  const limit = addDays(today, 45);
  for (const f of DATE_FIELDS) {
    const d = out[f];
    if (d == null) continue;
    const y = Number(d.slice(0, 4));
    if (y < 1980 || y > 2100) out[f] = null;
  }
  // A statement cannot be dated in the future.
  if (out.referenceDate && out.referenceDate > limit) out.referenceDate = null;
  // Maturity and premium end lie after the reference date, and premiums end no later than maturity.
  if (out.referenceDate) {
    if (out.maturityDate && out.maturityDate <= out.referenceDate) out.maturityDate = null;
    if (out.premiumEndDate && out.premiumEndDate < out.referenceDate) out.premiumEndDate = null;
  }
  if (out.maturityDate && out.premiumEndDate && out.premiumEndDate > out.maturityDate) out.premiumEndDate = null;
  // The guarantee is not above the projection.
  if (out.guaranteedPayout != null && out.projectedPayout != null && out.guaranteedPayout > out.projectedPayout * 1.001) {
    out.guaranteedPayout = null;
  }
  if (
    out.guaranteedMonthlyPension != null &&
    out.projectedMonthlyPension != null &&
    out.guaranteedMonthlyPension > out.projectedMonthlyPension * 1.001
  ) {
    out.guaranteedMonthlyPension = null;
  }
  return out;
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * One value set. Both sources are validated first; the model's value wins
 * where both have one, because the patterns only look near a label and can
 * pick the wrong number of a table row. The patterns fill what the model left
 * out. `method` says whether the model contributed anything.
 */
export function mergeStatementValues(
  regex: StatementValues,
  llm: StatementValues | null,
  today: string,
): { values: StatementValues; method: "regex" | "llm" } {
  const r = validateValues(regex, today);
  if (!llm) return { values: r, method: "regex" };
  const l = validateValues(llm, today);
  const values: StatementValues = { ...EMPTY_VALUES };
  let usedLlm = false;
  for (const k of Object.keys(EMPTY_VALUES) as Array<keyof StatementValues>) {
    const lv = l[k];
    const rv = r[k];
    if (lv != null) {
      (values as unknown as Record<string, unknown>)[k] = lv;
      usedLlm = true;
    } else {
      (values as unknown as Record<string, unknown>)[k] = rv;
    }
  }
  return { values: validateValues(values, today), method: usedLlm ? "llm" : "regex" };
}

export function hasAnyValue(v: StatementValues): boolean {
  return (Object.keys(EMPTY_VALUES) as Array<keyof StatementValues>).some((k) => k !== "referenceDate" && v[k] != null);
}

// -----------------------------------------------------------------------
// Proposals
// -----------------------------------------------------------------------

export interface Proposal {
  /** Key in the item's data. */
  field: string;
  label: string;
  kind: "amount" | "date";
  current: number | string | null;
  proposed: number | string;
}

type Data = Record<string, unknown>;

const num = (d: Data, k: string): number | null => (typeof d[k] === "number" ? (d[k] as number) : null);

/** Date of a time reference in item data, or undefined when it is not a plain date (a milestone). */
function refDate(d: Data, k: string): string | null | undefined {
  const r = d[k];
  if (r == null) return null;
  if (typeof r === "object" && (r as { kind?: string }).kind === "date") return (r as { date: string }).date;
  return undefined;
}

const firstOfMonth = (isoDate: string) => `${isoDate.slice(0, 7)}-01`;

function amountDiffers(current: number | null, proposed: number): boolean {
  if (current == null) return true;
  return Math.abs(current - proposed) > Math.max(1, Math.abs(current) * 0.005);
}

/**
 * Where the statement says something else than the item. Only fields the
 * item type has are compared; a date that the user tied to a milestone is
 * left alone, because replacing it with a fixed date would cut that tie.
 */
export function computeProposals(type: ItemType, data: Data, v: StatementValues): Proposal[] {
  const out: Proposal[] = [];
  const amount = (field: string, label: string, proposed: number | null) => {
    if (proposed == null) return;
    const current = num(data, field);
    if (amountDiffers(current, proposed)) out.push({ field, label, kind: "amount", current, proposed: round2(proposed) });
  };
  const date = (field: string, label: string, proposed: string | null) => {
    if (proposed == null) return;
    const current = refDate(data, field);
    if (current === undefined) return; // tied to a milestone
    const p = firstOfMonth(proposed);
    if (current == null || firstOfMonth(current) !== p) out.push({ field, label, kind: "date", current, proposed: p });
  };
  const monthly = v.premiumMonthly ?? (v.premiumYearly != null ? v.premiumYearly / 12 : null);

  switch (type) {
    case "life_insurance":
      amount("surrenderValue", "Rückkaufswert", v.surrenderValue ?? v.contractValue);
      amount("guaranteedPayout", "Garantierte Ablaufleistung", v.guaranteedPayout);
      amount("projectedPayout", "Prognostizierte Ablaufleistung", v.projectedPayout);
      amount("monthlyPremium", "Beitrag pro Monat", monthly);
      date("maturity", "Ablauf", v.maturityDate);
      date("premiumEnd", "Beitrag bis", v.premiumEndDate);
      break;
    case "pension":
      amount("monthlyAmount", "Rente pro Monat", v.projectedMonthlyPension ?? v.guaranteedMonthlyPension);
      amount("lumpSumOption", "Kapitalwahlrecht", v.lumpSum);
      amount("monthlyContribution", "Eigener Beitrag pro Monat", monthly);
      date("start", "Rentenbeginn", v.pensionStartDate);
      break;
    case "asset":
      amount("currentValue", "Aktueller Wert", v.contractValue ?? v.surrenderValue);
      break;
    case "expense": {
      // A premium booked as an expense: compare in the item's own rhythm.
      const freq = data.frequency;
      if (freq === "yearly") amount("amount", "Beitrag pro Jahr", v.premiumYearly ?? (v.premiumMonthly != null ? v.premiumMonthly * 12 : null));
      else if (freq === "monthly") amount("amount", "Beitrag pro Monat", monthly);
      break;
    }
    default:
      break;
  }
  return out;
}

export interface ValuesSource {
  kind: "import" | "manual" | "statement";
  referenceDate?: string | null;
  documentId?: number | null;
  updatedAt: string;
}

/** The item's data with the accepted proposals written in and the source recorded. */
export function applyProposals(
  data: Data,
  proposals: Proposal[],
  source: { documentId: number; referenceDate: string | null; now: string },
): Data {
  const next: Data = { ...data };
  for (const p of proposals) {
    next[p.field] = p.kind === "date" ? { kind: "date", date: p.proposed as string } : p.proposed;
  }
  const vs: ValuesSource = {
    kind: "statement",
    documentId: source.documentId,
    referenceDate: source.referenceDate,
    updatedAt: source.now,
  };
  next.valuesSource = vs;
  return next;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// -----------------------------------------------------------------------
// Contract numbers as the documents pipeline writes them
// -----------------------------------------------------------------------

/**
 * "S-0122 5520-01", "s-01225520-01" and "S01225520/01" are one number.
 * Letters and digits only, lower case — the key for comparing an item's
 * contract number with a document's reference tag.
 */
export function contractKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Keys worth searching for: short ones would match everywhere. */
export function isSearchableKey(key: string): boolean {
  return key.length >= 5 && (key.match(/\d/g) ?? []).length >= 4;
}

/**
 * A pattern that finds a contract number in running text however it is
 * written: "L 1.234.567", "L1234567" and "1 234 567" are one number. Up to
 * two separators (space, dot, slash, dash) may stand between any two
 * characters. A key with a letter prefix also matches its digits alone,
 * because letters often speak for the product and are left out. The source
 * is valid as a JavaScript and as a PostgreSQL regular expression; match it
 * case-insensitively.
 */
export function contractPattern(key: string): string {
  const variants = [key];
  const m = /^([a-z]+)(\d.*)$/.exec(key);
  if (m && (m[2].match(/\d/g) ?? []).length >= 6) variants.push(m[2]);
  const spread = (k: string) => [...k].join("[\\s./-]{0,2}");
  return `(^|[^a-z0-9])(${variants.map(spread).join("|")})([^a-z0-9]|$)`;
}

// -----------------------------------------------------------------------
// What kind of document it is
// -----------------------------------------------------------------------

/**
 * statement: a Standmitteilung or similar with the contract's figures.
 * dynamic_increase: an announced premium increase (Dynamik, Beitragsanpassung).
 * dynamic_declined: the increase was declined or will not take place.
 * other: belongs to the contract but says nothing about its values.
 */
export type DocKind = "statement" | "dynamic_increase" | "dynamic_declined" | "other";
export const DOC_KINDS: readonly DocKind[] = ["statement", "dynamic_increase", "dynamic_declined", "other"];

const DYNAMIC = String.raw`(Dynamik\w*|dynamische[rn]?\s+(Erh(ö|oe)hung|Anpassung)|Beitragserh(ö|oe)hung|Erh(ö|oe)hung\s+(des|Ihres)\s+Beitrag\w*|Beitragsanpassung|planm(ä|ae)(ß|ss)ige\s+Erh(ö|oe)hung)`;
// Only confirmations: an announcement also says "you may object" and
// "after two objections the option lapses", which must not read as declined.
const DECLINED_RE = new RegExp(
  [
    String.raw`(Ihren|den)\s+Widerspruch\s+(gegen\s+[^.]{0,60}?)?(haben\s+wir\s+)?(erhalten|bestätig|zur\s+Kenntnis)`,
    String.raw`wie\s+(von\s+Ihnen\s+)?gewünscht[^.]{0,80}?(nicht|keine)`,
    String.raw`(Erh(ö|oe)hung|Dynamik\w*|Anpassung)\s+(wird|wurde)\s+(nicht|ausgesetzt)`,
    String.raw`(Beitrag|Beiträge)\s+(bleibt|bleiben)\s+(daher\s+)?unverändert`,
  ].join("|"),
  "i",
);
const INCREASE_RE = new RegExp(DYNAMIC, "i");

const LLM_KINDS: Record<string, DocKind> = {
  standmitteilung: "statement",
  dynamik_erhoehung: "dynamic_increase",
  dynamik_abgelehnt: "dynamic_declined",
  sonstiges: "other",
};

/** Asked of the model next to the values (key "documentKind"). */
export const LLM_KIND_FIELD =
  'Art des Schreibens, genau einer dieser Werte: "standmitteilung" (Stand/Werte des Vertrags), ' +
  '"dynamik_erhoehung" (angekündigte Beitragserhöhung/Dynamik), "dynamik_abgelehnt" (Bestätigung, dass eine Erhöhung ' +
  'nicht durchgeführt wird, z. B. nach Widerspruch), "sonstiges"';

/** The model's kind, or null when it gave none of the four. */
export function parseLlmKind(raw: unknown): DocKind | null {
  if (!raw || typeof raw !== "object") return null;
  const v = (raw as Record<string, unknown>).documentKind;
  if (typeof v !== "string") return null;
  return LLM_KINDS[v.trim().toLowerCase().replace("ö", "oe")] ?? null;
}

/**
 * The kind by the text and the documents module's type. A Standmitteilung
 * that mentions its Dynamik in passing stays a statement.
 */
export function classifyDocument(text: string, documentType: string | null): DocKind {
  if (documentType === "standmitteilung") return "statement";
  const head = text.slice(0, 6000);
  if (DECLINED_RE.test(head)) return "dynamic_declined";
  if (INCREASE_RE.test(head)) return "dynamic_increase";
  return "statement";
}

/** Item data keys that hold the premium; a declined increase leaves them alone. */
export const PREMIUM_FIELDS: ReadonlySet<string> = new Set(["monthlyPremium", "monthlyContribution", "amount"]);

/**
 * Values the user typed over what was read. Unlike validateValues nothing
 * is dropped silently: the names of implausible fields come back so the
 * user can fix them.
 */
export function checkUserValues(v: StatementValues): string[] {
  const bad: string[] = [];
  for (const f of AMOUNT_FIELDS) {
    const n = v[f];
    if (n == null) continue;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > MAX_AMOUNT[f]) bad.push(f);
  }
  for (const f of DATE_FIELDS) {
    const d = v[f];
    if (d == null) continue;
    const m = typeof d === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(d) : null;
    if (!m || iso(Number(m[1]), Number(m[2]), Number(m[3])) == null || Number(m[1]) < 1950 || Number(m[1]) > 2100) bad.push(f);
  }
  return bad;
}

/** Only the known keys, each a number, a string or null. */
export function pickValues(raw: Record<string, unknown>): StatementValues {
  const out: StatementValues = { ...EMPTY_VALUES };
  for (const f of AMOUNT_FIELDS) out[f] = typeof raw[f] === "number" ? (raw[f] as number) : null;
  for (const f of DATE_FIELDS) out[f] = typeof raw[f] === "string" && raw[f] !== "" ? (raw[f] as string) : null;
  return out;
}
