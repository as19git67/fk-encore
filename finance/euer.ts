/**
 * The Einnahmen-Überschuss-Rechnung of one business for one year
 * (documentation/plans/betriebe-euer.md, stage 2), as a pure function.
 *
 * The bookings of the year that carry the business's tag are sorted into
 * the lines of the Anlage EÜR by their other tags: a booking goes to the
 * first line that names one of its tags; a booking no line claims goes to
 * "Sonstige Betriebseinnahmen" or "Sonstige Betriebsausgaben" by its sign,
 * never dropped. The year's depreciation of the asset register is the one
 * expense line without bookings. Amounts are summed in cents.
 *
 *   Betriebseinnahmen  = sum of the income lines
 *   Betriebsausgaben   = sum of the expense lines + AfA
 *   Gewinn/Verlust     = Betriebseinnahmen − Betriebsausgaben
 *
 * An income line sums what came in as positive; an expense line sums what
 * went out as positive too, so both totals read as the form prints them.
 * A refund tagged into an expense line lowers it; income paid back lowers
 * the income line.
 */

import type { EuerLineDefinition, EuerLineKind } from "../db/schema";
import { cents } from "./grouped-report";

export interface EuerBooking {
  id: number;
  booking_date: string;
  counterparty: string | null;
  purpose: string | null;
  amount: string;
  /** Names of every tag on the booking, whatever its source. */
  tags: string[];
  is_tax_relevant: boolean;
}

export interface EuerAssetAfa {
  asset_id: number;
  name: string;
  /** Cents. */
  afa: number;
}

export interface EuerLine {
  name: string;
  kind: EuerLineKind;
  form_line: string | null;
  tags: string[];
  count: number;
  /** Cents, positive in the line's own direction (income in, expense out). */
  sum: number;
  bookings: EuerBooking[];
  /** The line no definition made: what nothing else claimed, by sign. */
  other: boolean;
}

export interface EuerReport {
  year: number;
  business: string;
  tag: string | null;
  income: EuerLine[];
  expenses: EuerLine[];
  /** The register's depreciation of the year, as an expense without bookings. */
  afa: { sum: number; assets: EuerAssetAfa[] };
  /** Cents. */
  total_income: number;
  total_expenses: number;
  result: number;
  booking_count: number;
  /** Bookings of the business that are not flagged tax-relevant; a hint, not an error. */
  unflagged: number;
  hints: string[];
  /** PV only (stage 3): the § 3 Nr. 72 EStG status; an exempt system's EÜR is for information. */
  tax_exempt?: { exempt: boolean | null; reason: string };
}

export const OTHER_INCOME = "Sonstige Betriebseinnahmen";
export const OTHER_EXPENSES = "Sonstige Betriebsausgaben";

function norm(tag: string): string {
  return tag.trim().toLowerCase();
}

export function buildEuer(input: {
  year: number;
  business: string;
  tag: string | null;
  lines: EuerLineDefinition[];
  bookings: EuerBooking[];
  afa: EuerAssetAfa[];
}): EuerReport {
  const lines: EuerLine[] = input.lines.map((l) => ({
    name: l.name,
    kind: l.kind,
    form_line: l.form_line ?? null,
    tags: l.tags,
    count: 0,
    sum: 0,
    bookings: [],
    other: false,
  }));
  const byTag = new Map<string, EuerLine>();
  for (const line of lines) {
    for (const tag of line.tags) if (!byTag.has(norm(tag))) byTag.set(norm(tag), line);
  }
  const otherIncome: EuerLine = { name: OTHER_INCOME, kind: "income", form_line: null, tags: [], count: 0, sum: 0, bookings: [], other: true };
  const otherExpenses: EuerLine = { name: OTHER_EXPENSES, kind: "expense", form_line: null, tags: [], count: 0, sum: 0, bookings: [], other: true };

  const sorted = [...input.bookings].sort((a, b) => a.booking_date.localeCompare(b.booking_date) || a.id - b.id);
  let unflagged = 0;
  for (const b of sorted) {
    const amount = cents(b.amount);
    let line: EuerLine | undefined;
    // The first line in the definition's order whose tag the booking carries.
    for (const candidate of lines) {
      if (candidate.tags.some((t) => b.tags.some((bt) => norm(bt) === norm(t)))) { line = candidate; break; }
    }
    if (!line) line = amount >= 0 ? otherIncome : otherExpenses;
    line.bookings.push(b);
    line.count++;
    line.sum += line.kind === "income" ? amount : -amount;
    if (!b.is_tax_relevant) unflagged++;
  }

  const income = [...lines.filter((l) => l.kind === "income"), ...(otherIncome.count ? [otherIncome] : [])];
  const expenses = [...lines.filter((l) => l.kind === "expense"), ...(otherExpenses.count ? [otherExpenses] : [])];
  const afaSum = input.afa.reduce((s, a) => s + a.afa, 0);
  const totalIncome = income.reduce((s, l) => s + l.sum, 0);
  const totalExpenses = expenses.reduce((s, l) => s + l.sum, 0) + afaSum;

  const hints: string[] = [];
  if (!input.tag) hints.push("The business has no booking tag yet; no booking can belong to it until one is set.");
  if (input.tag && !input.bookings.length) hints.push(`No booking of ${input.year} carries the tag "${input.tag}".`);
  if (otherIncome.count) hints.push(`${otherIncome.count} booking(s) went to "${OTHER_INCOME}": no line names one of their tags.`);
  if (otherExpenses.count) hints.push(`${otherExpenses.count} booking(s) went to "${OTHER_EXPENSES}": no line names one of their tags.`);
  if (unflagged) hints.push(`${unflagged} booking(s) of the business are not flagged tax-relevant.`);
  const negative = [...income, ...expenses].filter((l) => l.sum < 0);
  for (const l of negative) hints.push(`"${l.name}" sums to a negative amount: its bookings mostly run against the line's direction.`);

  return {
    year: input.year,
    business: input.business,
    tag: input.tag,
    income,
    expenses,
    afa: { sum: afaSum, assets: input.afa },
    total_income: totalIncome,
    total_expenses: totalExpenses,
    result: totalIncome - totalExpenses,
    booking_count: sorted.length,
    unflagged,
    hints,
  };
}

/** The lines a new business starts with; the user edits them on the page. */
export function defaultEuerLines(kind: string): EuerLineDefinition[] {
  switch (kind) {
    case "landwirtschaft":
      return [
        { name: "Pachteinnahmen", kind: "income", tags: ["Pacht", "Pachteinnahmen"], form_line: null },
        { name: "Jagdpacht", kind: "income", tags: ["Jagdpacht"], form_line: null },
        { name: "Grundsteuer", kind: "expense", tags: ["Grundsteuer"], form_line: null },
        { name: "Versicherungen", kind: "expense", tags: ["Versicherung", "Versicherungen"], form_line: null },
        { name: "Berufsgenossenschaft", kind: "expense", tags: ["Berufsgenossenschaft", "SVLFG"], form_line: null },
        { name: "Instandhaltung", kind: "expense", tags: ["Instandhaltung", "Reparatur"], form_line: null },
        { name: "Beratung und Verwaltung", kind: "expense", tags: ["Steuerberater", "Verwaltung"], form_line: null },
      ];
    case "photovoltaik":
      return [
        { name: "Einspeisevergütung", kind: "income", tags: ["Einspeisung", "Einspeisevergütung"], form_line: null },
        { name: "Versicherung", kind: "expense", tags: ["Versicherung"], form_line: null },
        { name: "Wartung und Reparatur", kind: "expense", tags: ["Wartung", "Reparatur", "Instandhaltung"], form_line: null },
        { name: "Zählergebühren", kind: "expense", tags: ["Zähler", "Messstellenbetrieb"], form_line: null },
      ];
    case "vermietung":
      return [
        { name: "Mieteinnahmen", kind: "income", tags: ["Miete", "Mieteinnahmen"], form_line: null },
        { name: "Nebenkosten (Umlagen)", kind: "income", tags: ["Nebenkosten"], form_line: null },
        { name: "Grundsteuer", kind: "expense", tags: ["Grundsteuer"], form_line: null },
        { name: "Hausgeld und Verwaltung", kind: "expense", tags: ["Hausgeld", "Verwaltung"], form_line: null },
        { name: "Instandhaltung", kind: "expense", tags: ["Instandhaltung", "Reparatur"], form_line: null },
        { name: "Versicherungen", kind: "expense", tags: ["Versicherung"], form_line: null },
      ];
    default:
      return [
        { name: "Betriebseinnahmen", kind: "income", tags: ["Einnahmen", "Umsatz"], form_line: null },
        { name: "Betriebsausgaben", kind: "expense", tags: ["Ausgaben", "Betriebsausgaben"], form_line: null },
      ];
  }
}

/** The tag a new business of this kind starts with. */
export function defaultBookingTag(kind: string): string {
  return ({ landwirtschaft: "Landwirtschaft", photovoltaik: "Photovoltaik", gewerbe: "Gewerbe", vermietung: "Vermietung" } as Record<string, string>)[kind] ?? "Betrieb";
}

/** The document category a new business of this kind starts with. */
export function defaultDocumentCategory(kind: string): string | null {
  return ({ landwirtschaft: "landwirtschaft", vermietung: "kapitalanlage-immobilie" } as Record<string, string>)[kind] ?? null;
}
