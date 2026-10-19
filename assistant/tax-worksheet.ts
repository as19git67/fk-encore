/**
 * The worksheet for filling in a year's tax return (documentation/plans/
 * ki-assistent.md): per Anlage the documents flagged for the year, the
 * bookings marked tax-relevant in the year summed by tag, and the depot's
 * figures of the year — everything the household already holds, arranged
 * the way the forms ask for it. The sums are computed here, never by the
 * model.
 *
 * The documents' values come by form field (documentation/plans/
 * steuer-ausfuellhilfe.md, stage 3): each piece of evidence is read for the
 * values the form asks for, and the documents service sums them per Anlage,
 * line and Kennzahl with the law applied (`documents/tax-form-values.ts`).
 * A document never carries one amount of its own.
 */

import { documents, finance } from "~encore/clients";
import type { TaxFormValuesResponse } from "../documents/tax-form-values";

interface TaxDoc { id: number; title: string | null; original_filename?: string; doc_date: string | null; sender?: string | null; correspondent_display?: string | null }
interface TaxBucket { slug: string; name: string; group: string; documents: { document: TaxDoc; confidence: number | null; source: string }[] }
interface TaxListing { year: number | null; total_documents: number; sections: TaxBucket[] }
interface Booking { id: number; booking_date: string; amount: string; counterparty: string | null; purpose: string | null; tags?: { name: string }[] }
interface PortfolioYear { year: number; realized: string; sell_count: number; realized_complete: boolean; income: string; dividend_count: number; fees: string; taxes: string }

export interface WorksheetDocument {
  id: number;
  title: string;
  date: string | null;
  from: string | null;
  /** The classifier's confidence in the Anlage, null for a user's own assignment. */
  confidence: number | null;
}

export interface WorksheetSection {
  slug: string;
  name: string;
  group: string;
  documents: WorksheetDocument[];
}

export interface WorksheetTag {
  tag: string;
  count: number;
  sum: number;
  bookings: { id: number; date: string; amount: number; counterparty: string | null; purpose: string | null }[];
}

/** One business's EÜR of the year, as the form asks for it under its Anlage. */
export interface WorksheetBusiness {
  id: number;
  name: string;
  kind: string;
  tax_section: string;
  income: number;
  expenses: number;
  afa: number;
  result: number;
  bookings: number;
  hints: string[];
  /** PV: true when § 3 Nr. 72 EStG exempts the income, so nothing of it goes into the forms. */
  exempt: boolean | null;
}

/** The documents' values by form field, as the documents service sums them (amounts in cents). */
export type WorksheetForm = TaxFormValuesResponse;

export interface TaxWorksheet {
  year: number;
  /** Null when the values could not be loaded; the documents are still listed. */
  form: WorksheetForm | null;
  /** The businesses of the register with the year's EÜR each (stage 2 of betriebe-euer.md). */
  businesses: WorksheetBusiness[];
  sections: WorksheetSection[];
  documentCount: number;
  /** Tax-relevant bookings of the year by tag; a booking with several tags counts under each. */
  tags: WorksheetTag[];
  bookingCount: number;
  bookingTotal: number;
  depot: PortfolioYear | null;
  hints: string[];
}

/** Said when the values by form field could not be loaded. */
export const NO_FORM_HINT = "The values read from the documents could not be loaded: take each figure from the document itself.";
const BOOKING_LIMIT = 500;

function title(d: TaxDoc): string {
  return d.title ?? d.original_filename ?? `#${d.id}`;
}

export async function buildTaxWorksheet(input: { year: number; personId?: number; mayFinance: boolean }): Promise<TaxWorksheet> {
  const { year, personId, mayFinance } = input;
  const [thisYear, lastYear, form] = await Promise.all([
    documents.listTaxDocuments({ year, tax_return_person: personId }) as unknown as Promise<TaxListing>,
    documents.listTaxDocuments({ year: year - 1, tax_return_person: personId }).catch(() => null) as unknown as Promise<TaxListing | null>,
    // Values missing is no reason to lose the worksheet: it lists the documents without them.
    Promise.resolve()
      .then(() => documents.getTaxFormValues({ year, tax_return_person: personId }) as unknown as Promise<WorksheetForm | undefined>)
      .then((f) => f ?? null)
      .catch(() => null),
  ]);

  const distinct = new Map<number, TaxDoc>();
  for (const b of thisYear.sections) for (const e of b.documents) distinct.set(e.document.id, e.document);

  const sections: WorksheetSection[] = thisYear.sections
    .filter((b) => b.documents.length)
    .map((b) => {
      const docs = b.documents.map((e): WorksheetDocument => ({
        id: e.document.id,
        title: title(e.document),
        date: e.document.doc_date?.slice(0, 10) ?? null,
        from: e.document.correspondent_display ?? e.document.sender ?? null,
        confidence: e.source === "user" ? null : e.confidence,
      }));
      return { slug: b.slug, name: b.name, group: b.group, documents: docs };
    });

  const tags = new Map<string, WorksheetTag>();

  const businesses: WorksheetBusiness[] = [];
  let bookingCount = 0;
  let bookingTotal = 0;
  let depot: PortfolioYear | null = null;
  if (mayFinance) {
    try {
      const res = (await finance.listTransactions({ taxRelevant: true, from: `${year}-01-01`, to: `${year}-12-31`, limit: BOOKING_LIMIT })) as unknown as { items: Booking[]; total: number };
      bookingCount = res.total;
      for (const t of res.items) {
        const amount = Number(t.amount);
        bookingTotal += amount;
        const names = (t.tags ?? []).map((x) => x.name);
        for (const name of names.length ? names : ["(ohne Tag)"]) {
          const entry = tags.get(name) ?? { tag: name, count: 0, sum: 0, bookings: [] };
          entry.count++;
          entry.sum += amount;
          entry.bookings.push({ id: t.id, date: t.booking_date.slice(0, 10), amount, counterparty: t.counterparty, purpose: t.purpose });
          tags.set(name, entry);
        }
      }
    } catch {
      // Finance down: the worksheet still has the documents.
    }
    try {
      const list = (await finance.listBusinesses()) as unknown as { items: { id: number; name: string; kind: string; tax_section: string }[] };
      for (const b of list.items ?? []) {
        const r = (await finance.getBusinessEuer({ id: b.id, year })) as unknown as { total_income: number; total_expenses: number; result: number; afa: { sum: number }; booking_count: number; hints: string[]; tax_exempt?: { exempt: boolean | null; reason: string } };
        businesses.push({
          id: b.id, name: b.name, kind: b.kind, tax_section: b.tax_section,
          income: r.total_income / 100, expenses: r.total_expenses / 100, afa: r.afa.sum / 100, result: r.result / 100,
          bookings: r.booking_count, hints: r.hints, exempt: r.tax_exempt ? r.tax_exempt.exempt : null,
        });
      }
    } catch {
      // No business register, or finance down: the worksheet goes on without it.
    }
    try {
      const portfolio = (await finance.getPortfolio({})) as unknown as { years: PortfolioYear[] };
      depot = portfolio.years.find((y) => y.year === year) ?? null;
    } catch {
      depot = null;
    }
  }
  for (const t of tags.values()) {
    t.sum = Math.round(t.sum * 100) / 100;
    t.bookings.sort((a, b) => a.date.localeCompare(b.date));
  }

  const hints: string[] = [];
  if (lastYear) {
    const now = new Set(sections.map((s) => s.slug));
    for (const b of lastYear.sections) {
      if (b.documents.length && !now.has(b.slug)) hints.push(`${b.name}: ${b.documents.length} document(s) last year, none flagged for ${year} yet.`);
    }
  }
  hints.push(...formHints(form, year, distinct.size));
  if (!mayFinance) hints.push("Bookings and depot figures are left out: the user has no finance access.");

  return {
    year,
    form,
    businesses,
    sections,
    documentCount: distinct.size,
    tags: [...tags.values()].sort((a, b) => Math.abs(b.sum) - Math.abs(a.sum)),
    bookingCount,
    bookingTotal: Math.round(bookingTotal * 100) / 100,
    depot,
    hints,
  };
}

/** What the user should know about the values by form field. */
export function formHints(form: WorksheetForm | null, year: number, documentCount: number): string[] {
  if (!form) return documentCount ? [NO_FORM_HINT] : [];
  const hints: string[] = [];
  if (!form.exact) {
    hints.push(`There is no form catalogue for ${year} yet: the fields of ${form.catalogue_year} are used, and every line and Kennzahl must be checked on the ${year} form.`);
  }
  if (form.documents_unread) {
    hints.push(`${form.documents_unread} evidence document(s) of ${year} are not read yet: their values are missing from the form values; take them from the documents.`);
  }
  const open = form.values.reduce((n, v) => n + v.open, 0);
  if (open) hints.push(`${open} value(s) were read but not confirmed yet: check each against its document, then confirm or correct it.`);
  const rejected = form.skipped.filter((s) => s.status === "rejected").length;
  if (rejected) hints.push(`${rejected} value(s) could not be found in their document's text and are left out; correct them if the document says otherwise.`);
  if (form.previous?.missing.length) {
    hints.push(`${form.previous.missing.length} field(s) had a value in ${form.previous.year} but none yet in ${year} (${form.previous.missing.map((m) => m.label).join(", ")}): check whether evidence is still missing.`);
  }
  if (form.values.some((v) => !v.checked)) hints.push("Fields marked \"Kennzahl prüfen\" are not checked against the official form yet: find the line on the form.");
  return hints;
}

const eur = (n: number) => `${n.toFixed(2)} EUR`;
const centsEur = (c: number) => eur(c / 100);

/** The worksheet as the model reads it. */
export function worksheetText(w: TaxWorksheet): string {
  const out: string[] = [`Worksheet for the tax return of ${w.year}: ${w.documentCount} flagged document(s) in ${w.sections.length} Anlage(n), ${w.bookingCount} tax-relevant booking(s).`];
  out.push(...formText(w));
  if (w.sections.length) out.push(`\n== Flagged documents by Anlage ==`);
  for (const s of w.sections) {
    out.push(`\n== ${s.name} (${s.slug}) ==`);
    for (const d of s.documents) {
      out.push(`  ${d.id} | ${d.date ?? "-"} | ${d.title} | ${d.from ?? "-"}${d.confidence !== null ? ` | Anlage ${Math.round(d.confidence * 100)} %` : ""}`);
    }
  }
  if (w.tags.length) {
    out.push(`\n== Tax-relevant bookings of ${w.year} by tag (negative = paid) ==`);
    for (const t of w.tags) out.push(`  ${t.tag}: ${t.count} booking(s), ${eur(t.sum)}`);
    out.push(`  total: ${eur(w.bookingTotal)} over ${w.bookingCount} booking(s)`);
  } else if (w.bookingCount === 0) {
    out.push(`\nNo booking of ${w.year} is marked tax-relevant.`);
  }
  for (const b of w.businesses) {
    out.push(`\n== ${b.name} (${b.tax_section}, EÜR ${w.year}) ==`);
    if (b.exempt === true) out.push(`  TAX-EXEMPT under § 3 Nr. 72 EStG: nothing of this business goes into ${b.tax_section} or Anlage EÜR. For information: income ${eur(b.income)}, expenses ${eur(b.expenses)}.`);
    else out.push(`  Betriebseinnahmen ${eur(b.income)}; Betriebsausgaben ${eur(b.expenses)} (AfA ${eur(b.afa)} included); ${b.result >= 0 ? "Gewinn" : "Verlust"} ${eur(b.result)} from ${b.bookings} booking(s). Details: euer_report(business_id = ${b.id}).`);
    for (const h of b.hints) out.push(`  - ${h}`);
  }
  if (w.depot) {
    out.push(`\n== Depot ${w.year} (Anlage KAP, from the portfolio) ==`);
    out.push(`  income (dividends, interest): ${eur(Number(w.depot.income))} from ${w.depot.dividend_count} payment(s); realized gain: ${eur(Number(w.depot.realized))}${w.depot.realized_complete ? "" : " (incomplete)"} from ${w.depot.sell_count} sale(s); taxes withheld: ${eur(Number(w.depot.taxes))}; fees: ${eur(Number(w.depot.fees))}`);
  }
  if (w.hints.length) out.push("\nHints:\n" + w.hints.map((h) => `  - ${h}`).join("\n"));
  out.push(w.form?.values.length
    ? "\nState a document's figure only as listed under the form values above, with its line and Kennzahl; a value marked unconfirmed must be checked against its document. For anything not listed, point the user to the document."
    : "\nNo value of a document is known to the worksheet: never state one, and point the user to the document for each figure.");
  return out.join("\n");
}

const STATUS_TEXT: Record<string, string> = { read: "unconfirmed", confirmed: "confirmed", corrected: "corrected by the user", rejected: "rejected" };

/** The values by form field: Anlage → owner → line, Kennzahl, label, value and where it came from. */
export function formText(w: TaxWorksheet): string[] {
  const form = w.form;
  if (!form || (!form.values.length && !form.skipped.length && !form.previous?.missing.length)) return [];
  const out: string[] = [`\n== Values by form field (${form.joint ? "joint assessment" : "single assessment"}; form ${form.catalogue_year}${form.exact ? "" : ", unchecked"}) ==`];
  const groups = new Map<string, typeof form.values>();
  for (const v of form.values) {
    const k = `${v.anlage_name} — ${v.owner_label}`;
    groups.set(k, [...(groups.get(k) ?? []), v]);
  }
  for (const [name, values] of groups) {
    out.push(`  ${name}`);
    for (const v of values) {
      const state = v.open ? `${v.open} unconfirmed` : "all confirmed";
      const prev = form.previous && v.previous_cents !== null ? ` | ${form.previous.year}: ${centsEur(v.previous_cents)}` : "";
      out.push(`    ${v.place} | ${v.label} | ${centsEur(v.cents)}${prev} | ${state}${v.prefilled ? " | prefilled by the Finanzamt, check only" : ""}`);
      for (const c of v.contributions) {
        out.push(`      from document ${c.document_id} (${c.document_title}, ${c.evidence_kind_name}): ${c.field_label} ${centsEur(c.cents)}${c.cents !== c.value_cents ? ` (share of ${centsEur(c.value_cents)})` : ""}, ${STATUS_TEXT[c.status] ?? c.status}${c.page ? `, page ${c.page}` : ""}`);
      }
      if (v.form_note) out.push(`      form: ${v.form_note}`);
      for (const n of v.notes) out.push(`      note: ${n}`);
    }
  }
  if (form.previous?.missing.length) {
    out.push(`  Had a value in ${form.previous.year}, none yet in ${form.year}:`);
    for (const m of form.previous.missing) {
      out.push(`    ${m.anlage_name} — ${m.owner_label} | ${m.place} | ${m.label} | ${form.previous.year}: ${centsEur(m.previous_cents)} from ${m.previous_documents.map((d) => `document ${d.document_id} (${d.document_title})`).join(", ") || "-"}`);
    }
  }
  if (form.skipped.length) {
    out.push("  Not taken into the form:");
    for (const s of form.skipped) out.push(`    document ${s.document_id} (${s.document_title}): ${s.field_label}${s.printed ? ` "${s.printed}"` : ""} — ${s.reason}`);
  }
  return out;
}
