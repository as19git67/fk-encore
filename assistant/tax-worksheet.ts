/**
 * The worksheet for filling in a year's tax return (documentation/plans/
 * ki-assistent.md): per Anlage the documents flagged for the year with the
 * amount recognised in each, the bookings marked tax-relevant in the year
 * summed by tag, and the depot's figures of the year — everything the
 * household already holds, arranged the way the forms ask for it. The
 * sums are computed here, never by the model; recognised amounts are
 * marked as such, because an amount read from a scan is a suggestion.
 */

import { documents, finance } from "~encore/clients";

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
  /** The amount recognised in the document's text, in EUR; null when none was found. */
  amount: number | null;
  /** The classifier's confidence in the Anlage, null for a user's own assignment. */
  confidence: number | null;
}

export interface WorksheetSection {
  slug: string;
  name: string;
  group: string;
  documents: WorksheetDocument[];
  /** Sum of the recognised amounts, EUR. */
  sum: number;
  withoutAmount: number;
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

export interface TaxWorksheet {
  year: number;
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

/** How many documents get their amount looked up; beyond it the sum is partial and says so. */
const AMOUNT_LOOKUPS = 80;
const BOOKING_LIMIT = 500;

function title(d: TaxDoc): string {
  return d.title ?? d.original_filename ?? `#${d.id}`;
}

export async function buildTaxWorksheet(input: { year: number; personId?: number; mayFinance: boolean }): Promise<TaxWorksheet> {
  const { year, personId, mayFinance } = input;
  const [thisYear, lastYear] = await Promise.all([
    documents.listTaxDocuments({ year, tax_return_person: personId }) as unknown as Promise<TaxListing>,
    documents.listTaxDocuments({ year: year - 1, tax_return_person: personId }).catch(() => null) as unknown as Promise<TaxListing | null>,
  ]);

  // One amount lookup per distinct document, the first AMOUNT_LOOKUPS of them.
  const distinct = new Map<number, TaxDoc>();
  for (const b of thisYear.sections) for (const e of b.documents) distinct.set(e.document.id, e.document);
  const amounts = new Map<number, number | null>();
  let lookedUp = 0;
  for (const [id] of distinct) {
    if (lookedUp >= AMOUNT_LOOKUPS) break;
    lookedUp++;
    try {
      const r = (await documents.getDocumentReceiptSuggestion({ id })) as unknown as { amount: number | null };
      amounts.set(id, typeof r.amount === "number" && Number.isFinite(r.amount) ? r.amount : null);
    } catch {
      amounts.set(id, null);
    }
  }

  const sections: WorksheetSection[] = thisYear.sections
    .filter((b) => b.documents.length)
    .map((b) => {
      const docs = b.documents.map((e): WorksheetDocument => ({
        id: e.document.id,
        title: title(e.document),
        date: e.document.doc_date?.slice(0, 10) ?? null,
        from: e.document.correspondent_display ?? e.document.sender ?? null,
        amount: amounts.get(e.document.id) ?? null,
        confidence: e.source === "user" ? null : e.confidence,
      }));
      return {
        slug: b.slug, name: b.name, group: b.group, documents: docs,
        sum: Math.round(docs.reduce((acc, d) => acc + (d.amount ?? 0), 0) * 100) / 100,
        withoutAmount: docs.filter((d) => d.amount === null).length,
      };
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
  if (distinct.size > lookedUp) hints.push(`Amounts were looked up for the first ${lookedUp} of ${distinct.size} documents; the sums are partial.`);
  const noAmount = sections.reduce((n, s) => n + s.withoutAmount, 0);
  if (noAmount) hints.push(`${noAmount} document(s) carry no recognised amount; their figures have to be read from the document.`);
  if (!mayFinance) hints.push("Bookings and depot figures are left out: the user has no finance access.");

  return {
    year,
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

const eur = (n: number) => `${n.toFixed(2)} EUR`;

/** The worksheet as the model reads it. */
export function worksheetText(w: TaxWorksheet): string {
  const out: string[] = [`Worksheet for the tax return of ${w.year}: ${w.documentCount} flagged document(s) in ${w.sections.length} Anlage(n), ${w.bookingCount} tax-relevant booking(s).`];
  for (const s of w.sections) {
    out.push(`\n== ${s.name} (${s.slug}) ==`);
    for (const d of s.documents) {
      out.push(`  ${d.id} | ${d.date ?? "-"} | ${d.title} | ${d.from ?? "-"} | ${d.amount === null ? "no amount recognised" : eur(d.amount)}${d.confidence !== null ? ` | Anlage ${Math.round(d.confidence * 100)} %` : ""}`);
    }
    out.push(`  sum of recognised amounts: ${eur(s.sum)}${s.withoutAmount ? ` (${s.withoutAmount} without amount)` : ""}`);
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
  out.push("\nRecognised amounts are read from the documents' text and not checked; the user confirms every figure against the document before entering it.");
  return out.join("\n");
}
