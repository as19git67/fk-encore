// Retirement forecast — one-time import of a spreadsheet overview (#1337).
//
// Many households keep their plan in a workbook before they keep it
// here: one summary sheet with a row per contract, income or expense,
// and a sheet per contract with its details. This module reads such a
// workbook and proposes forecast items. Nothing is written here; the
// API shows the proposal, the user adjusts type and person per row, and
// only then are the items created — with `buildImportItem`, the same
// function that produced the proposal.
//
// The summary sheet is found by its headers, not by its name or column
// letters, so a reordered or renamed sheet still reads:
//
//   <label> | Betrag | jährliche Einnahmen | jährliche Ausgaben |
//   einmalige Einnahmen/Ausgaben | Beitragszahlung bis | Auszahlung im Jahr
//
// Detail sheets are key/value lists in columns A/B (Versicherungsnummer,
// Versicherte Person, Ablauf der Versicherung, Ablauf der
// Beitragszahlung, aktueller Anteilswert). A summary row is matched to
// its detail sheet by contract number.
//
// Pure apart from exceljs: no database, no Encore runtime.

import ExcelJS from "exceljs";

import type { ItemType } from "./forecast-engine";

// -----------------------------------------------------------------------
// Types (also the API shapes — spelled out for Encore's parser)
// -----------------------------------------------------------------------

export interface ImportDetail {
  contractNo: string | null;
  insuredPerson: string | null;
  insurer: string | null;
  /** YYYY-MM-DD */
  maturity: string | null;
  /** YYYY-MM-DD */
  premiumEnd: string | null;
  currentValue: number | null;
}

/** One summary row as read, before any interpretation. */
export interface ImportRaw {
  amount: number | null;
  incomeYearly: number | null;
  expenseYearly: number | null;
  once: number | null;
  contributionUntilYear: number | null;
  payoutYear: number | null;
  note: string | null;
  detail: ImportDetail | null;
}

export interface ImportPerson {
  id: number;
  label: string;
}

export interface ImportSuggestion {
  type: ItemType | null;
  personId: number | null;
  include: boolean;
  /** Why the row is proposed like this, or why it is left out. */
  reason: string | null;
}

export interface ImportRow {
  /** 1-based row in the summary sheet. */
  row: number;
  label: string;
  raw: ImportRaw;
  suggestion: ImportSuggestion;
  /** One line describing the item the suggestion would create. */
  summary: string | null;
}

export interface ImportPreview {
  sheet: string;
  rows: ImportRow[];
  /** Assumptions found in the workbook, for the scenario. */
  inflationRate: number | null;
  pensionGrowthRate: number | null;
  warnings: string[];
}

export interface BuiltItem {
  type: ItemType;
  label: string;
  personId: number | null;
  data: Record<string, unknown>;
}

export interface ImportOptions {
  /** Year the import is judged from — payouts before it are history. */
  currentYear: number;
  pensionGrowthRate: number;
}

// -----------------------------------------------------------------------
// Cells
// -----------------------------------------------------------------------

type Scalar = number | string | Date | null;

/** exceljs hands over formulas, rich text and hyperlinks as objects. */
function scalar(v: ExcelJS.CellValue): Scalar {
  if (v == null) return null;
  if (typeof v === "number" || typeof v === "string") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v;
  if (typeof v === "object") {
    const o = v as unknown as Record<string, unknown>;
    if ("result" in o) return scalar(o.result as ExcelJS.CellValue);
    if ("richText" in o && Array.isArray(o.richText)) {
      return (o.richText as Array<{ text?: string }>).map((t) => t.text ?? "").join("");
    }
    if ("text" in o && typeof o.text === "string") return o.text;
    if ("error" in o) return null;
  }
  return null;
}

function num(v: Scalar): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v instanceof Date) return null;
  const s = v.trim().replace(/\s/g, "").replace(/€/g, "");
  if (s === "") return null;
  // German "1.234,56" and plain "1234.56" both.
  const normalised = /,\d{1,2}$/.test(s) ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  const n = Number(normalised);
  return Number.isFinite(n) ? n : null;
}

function text(v: Scalar): string | null {
  if (v == null) return null;
  if (v instanceof Date) return isoDate(v);
  const s = String(v).trim();
  return s === "" ? null : s;
}

function isoDate(d: Date): string {
  // exceljs gives dates as UTC midnight.
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function dateOf(v: Scalar): string | null {
  if (v instanceof Date) return isoDate(v);
  if (typeof v === "string") {
    const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(v.trim());
    if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim());
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  }
  return null;
}

function year(v: Scalar): number | null {
  if (v instanceof Date) return v.getUTCFullYear();
  const n = num(v);
  return n != null && Number.isInteger(n) && n >= 1900 && n <= 2200 ? n : null;
}

function normKey(s: string): string {
  return s.toLowerCase().replace(/[\s/]+/g, "");
}

// -----------------------------------------------------------------------
// Reading the workbook
// -----------------------------------------------------------------------

type Column = "amount" | "incomeYearly" | "expenseYearly" | "once" | "contributionUntilYear" | "payoutYear";

const HEADERS: Array<[Column, RegExp]> = [
  ["incomeYearly", /j(ä|ae)hrliche\s+einnahmen/i],
  ["expenseYearly", /j(ä|ae)hrliche\s+ausgaben/i],
  ["once", /einmalig/i],
  ["contributionUntilYear", /beitrags?zahlung\s+bis/i],
  ["payoutYear", /auszahlung/i],
  ["amount", /^betrag\b/i],
];

interface SummaryLayout {
  sheet: ExcelJS.Worksheet;
  headerRow: number;
  labelCol: number;
  cols: Partial<Record<Column, number>>;
}

function findSummary(wb: ExcelJS.Workbook): SummaryLayout | null {
  for (const sheet of wb.worksheets) {
    for (let r = 1; r <= Math.min(sheet.rowCount, 10); r++) {
      const row = sheet.getRow(r);
      const cols: Partial<Record<Column, number>> = {};
      row.eachCell((cell, c) => {
        const t = text(scalar(cell.value));
        if (!t) return;
        for (const [col, re] of HEADERS) {
          if (cols[col] == null && re.test(t)) {
            cols[col] = c;
            break;
          }
        }
      });
      if (cols.incomeYearly != null && cols.expenseYearly != null) {
        const first = Math.min(...Object.values(cols).filter((c): c is number => c != null));
        return { sheet, headerRow: r, labelCol: first > 1 ? 1 : first, cols };
      }
    }
  }
  return null;
}

const DETAIL_KEYS: Record<string, keyof ImportDetail> = {
  versicherungsnummer: "contractNo",
  "versicherteperson": "insuredPerson",
  versicherungsgesellschaft: "insurer",
  "ablaufderversicherung": "maturity",
  "ablaufderbeitragszahlung": "premiumEnd",
  "aktuelleranteilswert": "currentValue",
};

function readDetail(sheet: ExcelJS.Worksheet): ImportDetail | null {
  const d: ImportDetail = {
    contractNo: null,
    insuredPerson: null,
    insurer: null,
    maturity: null,
    premiumEnd: null,
    currentValue: null,
  };
  let hits = 0;
  for (let r = 1; r <= Math.min(sheet.rowCount, 30); r++) {
    const row = sheet.getRow(r);
    const key = text(scalar(row.getCell(1).value));
    if (!key) continue;
    const field = DETAIL_KEYS[normKey(key)];
    if (!field) continue;
    const v = scalar(row.getCell(2).value);
    hits++;
    switch (field) {
      case "maturity":
      case "premiumEnd":
        d[field] = dateOf(v);
        break;
      case "currentValue":
        d.currentValue = num(v);
        break;
      default:
        d[field] = text(v);
    }
  }
  return hits >= 2 ? d : null;
}

/** A label/number pair anywhere in the workbook, e.g. "angenommene Rentenanpassung | 0,015". */
function findRate(wb: ExcelJS.Workbook, re: RegExp): number | null {
  for (const sheet of wb.worksheets) {
    for (let r = 1; r <= Math.min(sheet.rowCount, 200); r++) {
      const row = sheet.getRow(r);
      let found: number | null = null;
      row.eachCell((cell, c) => {
        if (found != null) return;
        const t = text(scalar(cell.value));
        if (!t || !re.test(t)) return;
        for (let k = c + 1; k <= c + 3; k++) {
          const n = num(scalar(row.getCell(k).value));
          if (n != null) {
            found = n > 1 ? n / 100 : n;
            return;
          }
        }
      });
      if (found != null) return found;
    }
  }
  return null;
}

// -----------------------------------------------------------------------
// Interpretation
// -----------------------------------------------------------------------

const PERSONAL: ReadonlySet<ItemType> = new Set(["salary", "health_insurance", "life_insurance", "pension"]);

function words(s: string): string[] {
  return s.toLowerCase().split(/[^a-zäöüß0-9]+/i).filter(Boolean);
}

function matchPerson(label: string, detail: ImportDetail | null, persons: ImportPerson[]): number | null {
  const byWord = (s: string) => {
    const w = new Set(words(s));
    const hits = persons.filter((p) => words(p.label).some((pw) => w.has(pw)));
    return hits.length === 1 ? hits[0].id : null;
  };
  return byWord(label) ?? (detail?.insuredPerson ? byWord(detail.insuredPerson) : null);
}

const isZero = (n: number | null) => n == null || Math.abs(n) < 0.005;

/**
 * A contract number written into the row label ("V-0000-01 (BU)",
 * "Anbieter 123456789 Name", "L 1.234.567"): a token with at least five
 * digits, optionally led by a short letter prefix.
 */
export function contractNoFromLabel(label: string): string | null {
  // Prefix: letters joined by a dash ("V-…"), or a single letter and a space ("L 1.234.567").
  const m = /(?:\b[A-Za-z]{1,4}-|\b[A-Za-z] )?\d[\d./-]{3,}[\dA-Za-z]*/.exec(label);
  if (!m) return null;
  const token = m[0].trim();
  return (token.match(/\d/g) ?? []).length >= 5 ? token : null;
}
const yearStart = (y: number) => `${y}-01-01`;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** What a row most likely is. `null` type means: leave it out. */
export function suggestType(label: string, raw: ImportRaw, currentYear: number): { type: ItemType | null; reason: string | null; include: boolean } {
  const { amount, incomeYearly: inc, expenseYearly: exp, once, payoutYear } = raw;
  const l = label.toLowerCase();
  if ([amount, inc, exp, once].every(isZero)) return { type: null, include: false, reason: "Kein Betrag" };

  if (/^bar\b|guthaben|tagesgeld|depot|konto/.test(l) && !isZero(amount)) {
    return { type: "asset", include: true, reason: null };
  }
  if (/einkommen|gehalt|lohn/.test(l) && (inc ?? 0) > 0) return { type: "salary", include: true, reason: null };
  if (/^leben$|lebenshaltung|haushaltsgeld/.test(l) && (exp ?? 0) < 0) return { type: "living_expense", include: true, reason: null };

  if ((exp ?? 0) < 0 && (once ?? 0) > 0) {
    const hasMaturity = payoutYear != null || raw.detail?.maturity != null;
    return hasMaturity
      ? { type: "life_insurance", include: true, reason: null }
      : { type: "life_insurance", include: false, reason: "Ablaufjahr fehlt – bitte ergänzen" };
  }
  if ((inc ?? 0) > 0 && payoutYear != null && payoutYear > currentYear) {
    return { type: "pension", include: true, reason: null };
  }
  if ((inc ?? 0) > 0) {
    const past = payoutYear != null && payoutYear <= currentYear;
    return { type: "income", include: true, reason: past ? "Auszahlungsjahr liegt in der Vergangenheit – bitte prüfen" : null };
  }
  if ((once ?? 0) > 0) {
    if (payoutYear != null && payoutYear < currentYear) {
      return { type: "income", include: false, reason: "Einmalzahlung liegt in der Vergangenheit" };
    }
    return { type: "income", include: true, reason: null };
  }
  if ((once ?? 0) < 0) return { type: "expense", include: true, reason: null };
  if ((exp ?? 0) < 0) return { type: "expense", include: true, reason: null };
  if ((exp ?? 0) > 0) {
    return { type: "expense", include: false, reason: "Positiver Wert unter „jährliche Ausgaben“ – bitte prüfen" };
  }
  if (!isZero(amount)) return { type: "asset", include: true, reason: null };
  return { type: null, include: false, reason: "Nicht zuzuordnen" };
}

/**
 * Turns a row into the data of a forecast item of the given type. The
 * user may have picked another type than the suggestion, so every type
 * takes what it can from the row. Returns an error text when the row
 * lacks something the type needs.
 */
export function buildImportItem(
  label: string,
  raw: ImportRaw,
  type: ItemType,
  personId: number | null,
  opts: ImportOptions,
): BuiltItem | { error: string } {
  const inc = raw.incomeYearly ?? 0;
  const exp = raw.expenseYearly ?? 0;
  const once = raw.once ?? 0;
  const detail = raw.detail;
  const endAfter = (y: number | null) => (y != null ? { kind: "date", date: yearStart(y + 1) } : null);
  const at = (date: string | null) => (date ? { kind: "date", date } : null);
  const yearlyAbs = Math.abs(exp) || Math.abs(inc);

  if (PERSONAL.has(type) && personId == null) return { error: "Dieser Eintrag braucht eine Person" };

  // The contract number is what later links the item to its statements in
  // the documents module (#1343); keep it on every item that has one.
  // A detail sheet may say "V-0000-03 (BU)"; the number alone is what documents carry.
  const contractNo = (detail?.contractNo ? contractNoFromLabel(detail.contractNo) ?? detail.contractNo : null) ?? contractNoFromLabel(label);
  const ref: Record<string, unknown> = {};
  if (contractNo) ref.contractNo = contractNo;
  if (detail?.insurer) ref.insurer = detail.insurer;
  const item = (data: Record<string, unknown>): BuiltItem => ({ type, label, personId, data: { ...data, ...ref } });

  switch (type) {
    case "salary":
      if (inc <= 0) return { error: "Keine jährlichen Einnahmen" };
      return item({ amount: round2(inc / 12), growthRate: 0 });

    case "income": {
      if (inc > 0) {
        return item({
          amount: round2(inc / 12),
          frequency: "monthly",
          growthRate: 0,
          taxRate: 0,
          end: endAfter(raw.contributionUntilYear),
        });
      }
      if (once > 0) {
        const y = raw.payoutYear ?? opts.currentYear;
        return item({ amount: round2(once), frequency: "once", growthRate: 0, taxRate: 0, start: at(yearStart(y)) });
      }
      return { error: "Keine Einnahme" };
    }

    case "expense": {
      if (once < 0 && isZero(exp)) {
        const y = raw.contributionUntilYear ?? raw.payoutYear ?? opts.currentYear;
        return item({ amount: round2(-once), frequency: "once", growthRate: 0, start: at(yearStart(y)) });
      }
      if (yearlyAbs <= 0) return { error: "Keine Ausgabe" };
      const loan = /zins|tilgung|kredit|darlehen/i.test(label);
      return item({
        amount: round2(yearlyAbs),
        frequency: "yearly",
        growthRate: loan ? 0 : null,
        end: endAfter(raw.contributionUntilYear),
      });
    }

    case "living_expense":
      if (yearlyAbs <= 0) return { error: "Keine Ausgabe" };
      return item({ amount: round2(yearlyAbs / 12) });

    case "asset": {
      const value = raw.amount ?? detail?.currentValue ?? (once > 0 ? once : null);
      if (value == null) return { error: "Kein Wert" };
      // "Bar … (incl. Depot)" is still mostly cash: the leading word wins.
      const pot = /^bar\b|konto|tagesgeld|guthaben/i.test(label)
        ? "cash"
        : /depot|fonds|aktie/i.test(label)
          ? "depot"
          : /immobil|haus|wohnung/i.test(label)
            ? "real_estate"
            : "cash";
      return item({ pot, currentValue: round2(value), returnRate: null, monthlyContribution: 0, contributionEnd: null });
    }

    case "life_insurance": {
      const maturity = raw.payoutYear != null ? yearStart(raw.payoutYear) : detail?.maturity ?? null;
      if (!maturity) return { error: "Ablaufjahr fehlt" };
      const premiumEnd =
        raw.contributionUntilYear != null
          ? yearStart(raw.contributionUntilYear + 1)
          : detail?.premiumEnd ?? null;
      const payout = once > 0 ? once : detail?.currentValue ?? 0;
      return item({
        surrenderValue: round2(detail?.currentValue ?? 0),
        monthlyPremium: round2(Math.abs(exp) / 12),
        premiumEnd: at(premiumEnd),
        guaranteedPayout: round2(payout),
        projectedPayout: round2(payout),
        maturity: at(maturity),
        payoutMode: "lump_sum",
        annuityAmount: 0,
        taxRate: 0,
      });
    }

    case "pension": {
      if (inc <= 0) return { error: "Keine jährliche Rente" };
      const start = raw.payoutYear != null ? yearStart(raw.payoutYear) : detail?.maturity ?? null;
      if (!start) return { error: "Rentenbeginn fehlt" };
      const kind = /riester|private/i.test(label) ? "private" : /^(gesetzliche\s+)?rente\b/i.test(label) ? "statutory" : "company";
      return item({
        kind,
        monthlyAmount: round2(inc / 12),
        start: at(start),
        regularAge: null,
        deductionPerMonth: 0,
        deductionOffsetCost: null,
        growthRate: opts.pensionGrowthRate,
        monthlyContribution: 0,
        contributionEnd: null,
        lumpSumOption: null,
        payoutMode: "annuity",
        taxRate: 0,
      });
    }

    case "health_insurance":
      if (yearlyAbs <= 0) return { error: "Kein Beitrag" };
      return item({
        employedAmount: round2(yearlyAbs / 12),
        bridgeMode: "statutory_voluntary",
        bridgeAmount: 0,
        retiredMode: "kvdr",
        retiredAmount: 0,
        privateGrowthRate: 0.03,
      });
  }
}

const eur = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });

/** "MM/YYYY" of a date ref; an end is exclusive, so it shows the month before. */
function refText(ref: unknown, isEnd = false): string {
  if (!ref || typeof ref !== "object") return "";
  const r = ref as { kind?: string; date?: string };
  if (r.kind !== "date" || !r.date) return "";
  let y = Number(r.date.slice(0, 4));
  let m = Number(r.date.slice(5, 7));
  if (isEnd) {
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return `${String(m).padStart(2, "0")}/${y}`;
}

/** One German line for the preview table. */
export function describeBuilt(b: BuiltItem): string {
  const d = b.data;
  const n = (k: string) => (typeof d[k] === "number" ? (d[k] as number) : 0);
  switch (b.type) {
    case "salary":
      return `${eur.format(n("amount"))}/Monat netto`;
    case "income":
    case "expense": {
      const f = d.frequency === "once" ? `einmalig ${refText(d.start)}` : d.frequency === "yearly" ? "pro Jahr" : "pro Monat";
      const until = refText(d.end, true);
      return `${eur.format(n("amount"))} ${f}${until ? ` bis ${until}` : ""}`;
    }
    case "living_expense":
      return `${eur.format(n("amount"))}/Monat`;
    case "asset":
      return `${eur.format(n("currentValue"))} (${d.pot === "depot" ? "Depot" : d.pot === "real_estate" ? "Immobilie" : "Konto"})`;
    case "life_insurance": {
      const until = refText(d.premiumEnd, true);
      return `Beitrag ${eur.format(n("monthlyPremium"))}/Monat${until ? ` bis ${until}` : ""}, Auszahlung ${eur.format(n("projectedPayout"))} ${refText(d.maturity)}`;
    }
    case "pension":
      return `${eur.format(n("monthlyAmount"))}/Monat ab ${refText(d.start)}`;
    case "health_insurance":
      return `${eur.format(n("employedAmount"))}/Monat`;
  }
}

// -----------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------

export async function readImportWorkbook(
  buffer: Buffer,
  persons: ImportPerson[],
  existingLabels: string[],
  currentYear: number,
): Promise<ImportPreview> {
  const wb = new ExcelJS.Workbook();
  try {
    // exceljs types its argument as the pre-generic Buffer.
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch (err) {
    throw new ImportFormatError(`Die Datei ist keine lesbare Excel-Arbeitsmappe (${err instanceof Error ? err.message : String(err)}).`);
  }
  const layout = findSummary(wb);
  if (!layout) {
    throw new ImportFormatError(
      "Keine Übersichtstabelle gefunden. Erwartet wird ein Blatt mit den Spalten „jährliche Einnahmen“ und „jährliche Ausgaben“.",
    );
  }

  // Detail sheets, indexed by contract number and by sheet name.
  const details = new Map<string, ImportDetail>();
  for (const sheet of wb.worksheets) {
    if (sheet === layout.sheet) continue;
    const d = readDetail(sheet);
    if (!d) continue;
    if (d.contractNo) details.set(normKey(d.contractNo), d);
    details.set(normKey(sheet.name), d);
  }
  const detailFor = (label: string): ImportDetail | null => {
    const key = normKey(label);
    if (details.has(key)) return details.get(key)!;
    for (const [k, d] of details) {
      if (k.length >= 5 && key.includes(k)) return d;
    }
    return null;
  };

  const inflationRate = findRate(wb, /inflation/i);
  const pensionGrowthRate = findRate(wb, /rentenanpassung|rentensteigerung/i);
  const opts: ImportOptions = { currentYear, pensionGrowthRate: pensionGrowthRate ?? 0.02 };
  const existing = new Set(existingLabels.map((l) => l.trim().toLowerCase()));
  const warnings: string[] = [];
  if (persons.length === 0) warnings.push("Es gibt noch keine Person – persönliche Einträge (Gehalt, Renten, Versicherungen) können erst danach übernommen werden.");

  const rows: ImportRow[] = [];
  const { sheet, headerRow, labelCol, cols } = layout;
  const knownCols = new Set<number>([labelCol, ...Object.values(cols).filter((c): c is number => c != null)]);
  for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const label = text(scalar(row.getCell(labelCol).value));
    if (!label) continue;
    const get = (col: Column) => (cols[col] != null ? scalar(row.getCell(cols[col]!).value) : null);
    let note: string | null = null;
    row.eachCell((cell, c) => {
      if (note || knownCols.has(c)) return;
      const t = scalar(cell.value);
      if (typeof t === "string" && t.trim()) note = t.trim();
    });
    const raw: ImportRaw = {
      amount: num(get("amount")),
      incomeYearly: num(get("incomeYearly")),
      expenseYearly: num(get("expenseYearly")),
      once: num(get("once")),
      contributionUntilYear: year(get("contributionUntilYear")),
      payoutYear: year(get("payoutYear")),
      note,
      detail: detailFor(label),
    };

    const s = suggestType(label, raw, currentYear);
    let personId = matchPerson(label, raw.detail, persons);
    let reason = s.reason;
    let include = s.include;
    if (s.type && PERSONAL.has(s.type) && personId == null && persons.length > 0) {
      personId = persons[0].id;
      reason = joinReasons(reason, "Person nicht erkannt – bitte prüfen");
    }
    if (existing.has(label.trim().toLowerCase())) {
      include = false;
      reason = joinReasons(reason, "Einen Eintrag mit diesem Namen gibt es schon");
    }

    let summary: string | null = null;
    if (s.type) {
      const built = buildImportItem(label, raw, s.type, personId, opts);
      if ("error" in built) {
        include = false;
        // "Ablaufjahr fehlt – bitte ergänzen" already says what the build error says.
        if (!reason || !reason.startsWith(built.error)) reason = joinReasons(reason, built.error);
      } else {
        summary = describeBuilt(built);
      }
    }
    rows.push({ row: r, label, raw, suggestion: { type: s.type, personId, include, reason }, summary });
  }

  return { sheet: sheet.name, rows, inflationRate, pensionGrowthRate, warnings };
}

export class ImportFormatError extends Error {}

/** Joins reasons, dropping empty and repeated ones. */
function joinReasons(...parts: Array<string | null | undefined>): string | null {
  const seen: string[] = [];
  for (const p of parts) if (p && !seen.includes(p)) seen.push(p);
  return seen.length ? seen.join("; ") : null;
}

export interface ImportEvaluation {
  summary: string | null;
  error: string | null;
}

/** What a row would become with the user's choices — for the preview after an edit. */
export function evaluateImportRow(
  label: string,
  raw: ImportRaw,
  type: ItemType,
  personId: number | null,
  opts: ImportOptions,
): ImportEvaluation {
  const b = buildImportItem(label, raw, type, personId, opts);
  return "error" in b ? { summary: null, error: b.error } : { summary: describeBuilt(b), error: null };
}
