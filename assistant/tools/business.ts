/**
 * Business read tools (documentation/plans/betriebe-euer.md, stage 1): the
 * register of businesses in the tax sense — a leased farm, a PV system — with
 * their fixed assets, the year's depreciation and the parcels. The finance
 * service checks `finance.view` and ownership; `finance.admin` sees all.
 */

import { finance } from "~encore/clients";
import { digestOf, int, table } from "../format";
import type { ToolSpec } from "../types";

const FINANCE = ["module.finance", "finance.view"];

interface BusinessItem { id: number; name: string; kind: string; tax_section: string; notes: string | null; asset_count: number; parcel_count: number }
interface DepreciationRow { year: number; months: number; afa: string; accumulated: string; book_value: string; disposal_result: string | null }
interface AssetItem { id: number; name: string; kind: string; acquisition_date: string; acquisition_cost: string; afa_rate_pct: string; afa_start_date: string | null; disposal_date: string | null; disposal_proceeds: string | null; depreciation: DepreciationRow }
interface ParcelItem { id: number; gemarkung: string; flur: string | null; flurstueck: string; area_m2: number | null; usage: string; lessee: string | null; lease_from: string | null; lease_to: string | null; annual_rent: string | null }
interface PvInfo { capacity_kwp: string | null; capacity_source: string | null; commissioned_on: string | null; tax_override: string | null; status: { exempt: boolean | null; reason: string; source: string }; feed_in: { revenue_eur: number | null; exported_kwh: number | null; complete: boolean } | null }
interface BusinessDetail { business: BusinessItem; year: number; assets: AssetItem[]; parcels: ParcelItem[]; totals: { acquisition_cost: string; afa: string; book_value: string; annual_rent: string; area_m2: number }; pv: PvInfo | null }

/** One line about a PV system's tax status and metered feed-in, for the model. */
function pvText(pv: PvInfo, year: number): string {
  const status = pv.status.exempt === true ? "tax-exempt (§ 3 Nr. 72 EStG): no EÜR, no Anlage G" : pv.status.exempt === false ? "taxable (Anlage G, EÜR)" : "status unknown";
  const parts = [
    `PV system: ${pv.capacity_kwp ? `${Number(pv.capacity_kwp)} kWp${pv.capacity_source === "meters" ? " (from the meters' tariff timeline)" : ""}` : "capacity not entered"}`,
    pv.commissioned_on ? `commissioned ${pv.commissioned_on}` : "",
    `${year}: ${status} — ${pv.status.reason}`,
    pv.feed_in && pv.feed_in.revenue_eur !== null ? `feed-in ${year} per meters ${pv.feed_in.revenue_eur.toFixed(2)} EUR${pv.feed_in.exported_kwh !== null ? ` for ${pv.feed_in.exported_kwh.toFixed(0)} kWh` : ""}${pv.feed_in.complete ? "" : " (readings incomplete)"}` : "",
  ];
  return parts.filter(Boolean).join("; ") + ".";
}

const KIND_LABEL: Record<string, string> = { landwirtschaft: "farm (Anlage L)", photovoltaik: "PV system (Anlage G)", gewerbe: "trade (Anlage G)", vermietung: "letting (Anlage V)" };

export const listBusinesses: ToolSpec = {
  name: "list_businesses",
  kind: "read",
  summary: "The user's businesses in the tax sense (leased farm, PV system, trade, letting) with id, kind, tax form and how many assets and parcels each has. Start here for questions about Landwirtschaft, Verpachtung, PV-Anlage, Anlagegüter, AfA or Flurstücke; whether the PV system is tax-exempt is in business_assets.",
  permissions: FINANCE,
  source: "hand",
  parameters: { type: "object", properties: {} },
  async run() {
    const res = await (finance.listBusinesses()) as unknown as { items: BusinessItem[] };
    const rows = res.items;
    return {
      text: table(
        ["id", "name", "kind", "tax_form", "assets", "parcels"],
        rows.map((b) => [b.id, b.name, KIND_LABEL[b.kind] ?? b.kind, b.tax_section, b.asset_count, b.parcel_count]),
        { cap: 40, note: rows.length ? "Call business_assets(business_id, year) for the assets with the year's depreciation and the parcels." : "No business is registered yet; the user can add one under Finanzen › Betriebe." },
      ),
      digest: digestOf("list_businesses", rows.length, rows.map((b) => b.id)),
      rowCount: rows.length,
      block: {
        kind: "businesses",
        tool: "list_businesses",
        rows: rows.map((b) => ({ id: b.id, name: b.name, kind: b.kind, tax_section: b.tax_section, asset_count: b.asset_count, parcel_count: b.parcel_count, route: `/finanzen/betriebe/${b.id}` })),
        route: "/finanzen/betriebe",
      },
    };
  },
};

export const businessAssets: ToolSpec = {
  name: "business_assets",
  kind: "read",
  summary: "The fixed assets of one business with acquisition cost, AfA rate and the depreciation of one year (months held, AfA, book value at year end), plus the parcels with area, lessee and annual rent, and the totals; for a PV system also its capacity, whether its income is tax-exempt under § 3 Nr. 72 EStG for the year and why, and the year's metered feed-in. The depreciation is computed by the server (linear, pro rata by month, residual 1 €); quote it, never recompute it.",
  permissions: FINANCE,
  source: "hand",
  parameters: {
    type: "object",
    properties: {
      business_id: { type: "integer", description: "id from list_businesses" },
      year: { type: "integer", description: "the tax year the depreciation is for (default: the current year)" },
    },
    required: ["business_id"],
  },
  async run(args) {
    const id = int(args.business_id);
    if (id === undefined) throw new Error("business_id is required");
    const year = int(args.year, { min: 1900, max: 2200 });
    const res = await (finance.getBusiness({ id, year })) as unknown as BusinessDetail;
    const assets = res.assets.map((a) => [a.id, a.name, a.kind, a.acquisition_date, a.acquisition_cost, `${Number(a.afa_rate_pct)}%`, a.depreciation.months, a.depreciation.afa, a.depreciation.book_value, a.disposal_date ? `sold ${a.disposal_date} for ${a.disposal_proceeds ?? "0"} (result ${a.depreciation.disposal_result ?? "0"})` : ""]);
    const parcels = res.parcels.map((p) => [p.id, `${p.gemarkung} ${p.flur ? `Flur ${p.flur} ` : ""}Flst. ${p.flurstueck}`, p.usage, p.area_m2, p.lessee, p.annual_rent, p.lease_to ? `until ${p.lease_to}` : ""]);
    const assetTable = table(
      ["id", "name", "kind", "acquired", "cost", "afa_rate", "months", `afa_${res.year}`, `book_value_end_${res.year}`, "disposal"],
      assets,
      { cap: 60, note: `${res.business.name} (${KIND_LABEL[res.business.kind] ?? res.business.kind}), year ${res.year}: ${res.assets.length} assets, acquisition cost ${res.totals.acquisition_cost}, AfA ${res.totals.afa}, book value ${res.totals.book_value}.${res.pv ? ` ${pvText(res.pv, res.year)}` : ""}` },
    );
    const parcelTable = res.parcels.length
      ? "\n" + table(["id", "parcel", "usage", "area_m2", "lessee", "annual_rent", "lease"], parcels, { cap: 60, note: `${res.parcels.length} parcels, ${res.totals.area_m2} m² in all, annual rent ${res.totals.annual_rent}.` })
      : "";
    return {
      text: assetTable + parcelTable,
      digest: `[earlier result of business_assets: business ${id} "${res.business.name}", year ${res.year}, ${res.assets.length} assets (AfA ${res.totals.afa}, book value ${res.totals.book_value}), ${res.parcels.length} parcels (rent ${res.totals.annual_rent})${res.pv ? `, PV ${res.pv.status.exempt === true ? "tax-exempt" : res.pv.status.exempt === false ? "taxable" : "status unknown"}` : ""}]`,
      rowCount: res.assets.length + res.parcels.length,
      block: {
        kind: "business_assets",
        tool: "business_assets",
        subtitle: `${res.business.name} · ${res.year} · AfA ${res.totals.afa} € · Buchwert ${res.totals.book_value} €${res.pv ? ` · ${res.pv.status.exempt === true ? "steuerfrei (§ 3 Nr. 72 EStG)" : res.pv.status.exempt === false ? "steuerpflichtig" : "Status offen"}` : ""}`,
        rows: [
          ...res.assets.map((a) => ({ id: a.id, name: a.name, kind: a.kind, acquisition_cost: a.acquisition_cost, afa_rate_pct: a.afa_rate_pct, afa: a.depreciation.afa, book_value: a.depreciation.book_value, route: `/finanzen/betriebe/${id}` })),
          ...res.parcels.map((p) => ({ id: p.id, name: `${p.gemarkung} Flst. ${p.flurstueck}`, kind: "parcel", usage: p.usage, area_m2: p.area_m2, lessee: p.lessee, annual_rent: p.annual_rent, route: `/finanzen/betriebe/${id}` })),
        ],
        route: `/finanzen/betriebe/${id}`,
      },
    };
  },
};

interface EuerLineItem { name: string; kind: "income" | "expense"; form_line: string | null; count: number; sum: number; other: boolean; bookings: { id: number; booking_date: string; counterparty: string | null; purpose: string | null; amount: string }[] }
interface EuerResult { year: number; business: string; tag: string | null; tax_exempt?: { exempt: boolean | null; reason: string }; income: EuerLineItem[]; expenses: EuerLineItem[]; afa: { sum: number; assets: { asset_id: number; name: string; afa: number }[] }; total_income: number; total_expenses: number; result: number; booking_count: number; unflagged: number; hints: string[] }

const eur = (c: number) => `${(c / 100).toFixed(2)} EUR`;

/** The EÜR as the model reads it: every figure printed, nothing left to add up. */
export function euerText(r: EuerResult): string {
  const out = [`EÜR ${r.year} of ${r.business}${r.tag ? ` (bookings tagged "${r.tag}")` : ""}: ${r.booking_count} bookings, AfA from the asset register. Amounts in EUR, each line in its own direction (income in, expenses out).`];
  if (r.tax_exempt?.exempt === true) out.push(`TAX-EXEMPT (§ 3 Nr. 72 EStG): ${r.tax_exempt.reason} This EÜR is for information only; nothing of it goes into Anlage G or Anlage EÜR.`);
  out.push("\n== Betriebseinnahmen ==");
  for (const l of r.income) out.push(`  ${l.form_line ? `${l.form_line} · ` : ""}${l.name}: ${eur(l.sum)} (${l.count} booking${l.count === 1 ? "" : "s"})`);
  out.push(`  Summe Betriebseinnahmen: ${eur(r.total_income)}`);
  out.push("\n== Betriebsausgaben ==");
  for (const l of r.expenses) out.push(`  ${l.form_line ? `${l.form_line} · ` : ""}${l.name}: ${eur(l.sum)} (${l.count} booking${l.count === 1 ? "" : "s"})`);
  out.push(`  AfA: ${eur(r.afa.sum)}${r.afa.assets.length ? ` (${r.afa.assets.map((a) => `${a.name} ${eur(a.afa)}`).join(", ")})` : ""}`);
  out.push(`  Summe Betriebsausgaben: ${eur(r.total_expenses)}`);
  out.push(`\n${r.result >= 0 ? "Gewinn" : "Verlust"}: ${eur(r.result)} (= ${eur(r.total_income)} − ${eur(r.total_expenses)})`);
  if (r.hints.length) out.push("\nHints:\n" + r.hints.map((h) => `  - ${h}`).join("\n"));
  return out.join("\n");
}

export const euerReport: ToolSpec = {
  name: "euer_report",
  kind: "read",
  summary: "The Einnahmen-Überschuss-Rechnung (EÜR) of one business for one year: the income and expense lines of the Anlage EÜR with their sums from the tagged bookings, the AfA from the asset register, the totals and the profit or loss, all computed by the server. Use it for 'EÜR', 'Gewinn der Landwirtschaft', 'Betriebseinnahmen/-ausgaben'; for the PDF, euer_pdf.",
  permissions: FINANCE,
  source: "hand",
  parameters: {
    type: "object",
    properties: {
      business_id: { type: "integer", description: "id from list_businesses" },
      year: { type: "integer", description: "the tax year (default: the current year)" },
    },
    required: ["business_id"],
  },
  async run(args) {
    const id = int(args.business_id);
    if (id === undefined) throw new Error("business_id is required");
    const year = int(args.year, { min: 1900, max: 2200 });
    const r = await (finance.getBusinessEuer({ id, year })) as unknown as EuerResult;
    const rows = [
      ...r.income.map((l) => ({ id: `income-${l.name}`, name: l.name, kind: "income", form_line: l.form_line, count: l.count, sum: l.sum / 100 })),
      ...r.expenses.map((l) => ({ id: `expense-${l.name}`, name: l.name, kind: "expense", form_line: l.form_line, count: l.count, sum: l.sum / 100 })),
      { id: "afa", name: "AfA (Anlagenverzeichnis)", kind: "afa", form_line: null, count: r.afa.assets.length, sum: r.afa.sum / 100 },
    ];
    return {
      text: euerText(r),
      digest: `[earlier result of euer_report: business ${id} "${r.business}", year ${r.year}, income ${eur(r.total_income)}, expenses ${eur(r.total_expenses)}, result ${eur(r.result)}]`,
      rowCount: r.income.length + r.expenses.length + 1,
      block: {
        kind: "euer",
        tool: "euer_report",
        subtitle: `${r.business} · ${r.year} · ${r.result >= 0 ? "Gewinn" : "Verlust"} ${(r.result / 100).toFixed(2)} €`,
        rows,
        route: `/finanzen/betriebe/${id}?year=${r.year}`,
      },
    };
  },
};

interface BusinessDocumentItem { id: number; document_id: number; target_kind: "business" | "asset" | "parcel"; target_id: number | null; target_name: string | null; note: string | null; document: { id: number; title: string | null; original_filename: string; doc_date: string | null; category_slug: string | null; correspondent_display: string | null; sender: string | null } | null }

const TARGET_LABEL: Record<string, string> = { business: "business", asset: "asset", parcel: "parcel" };

export const businessDocuments: ToolSpec = {
  name: "business_documents",
  kind: "read",
  summary: "The documents linked to one business: the lease contracts on its parcels, the invoices on its assets, the notices on the business itself, each with title, date, correspondent and what it is linked to. Use it for 'Pachtvertrag der Fläche', 'Rechnung zum Stall', 'Unterlagen der Landwirtschaft'.",
  permissions: FINANCE,
  source: "hand",
  parameters: {
    type: "object",
    properties: {
      business_id: { type: "integer", description: "id from list_businesses" },
    },
    required: ["business_id"],
  },
  async run(args) {
    const id = int(args.business_id);
    if (id === undefined) throw new Error("business_id is required");
    const res = await (finance.listBusinessDocuments({ id })) as unknown as { items: BusinessDocumentItem[] };
    const rows = res.items;
    const readable = rows.filter((r) => r.document);
    return {
      text: table(
        ["document_id", "title", "date", "from", "linked_to", "note"],
        rows.map((r) => [
          r.document_id,
          r.document ? (r.document.title ?? r.document.original_filename) : "(not readable)",
          r.document?.doc_date,
          r.document?.correspondent_display ?? r.document?.sender,
          `${TARGET_LABEL[r.target_kind]}${r.target_name ? ` ${r.target_name}` : ""}`,
          r.note,
        ]),
        { cap: 60, note: rows.length ? `${rows.length} linked document(s)${readable.length < rows.length ? `, ${rows.length - readable.length} not readable by the user` : ""}. Open one with get_document_summary(ids = …).` : "No document is linked to this business yet; the user links one on the business page." },
      ),
      digest: digestOf("business_documents", rows.length, rows.map((r) => r.document_id)),
      rowCount: rows.length,
      ref: readable.length ? { type: "document", ids: readable.map((r) => r.document_id) } : undefined,
      block: {
        kind: "documents",
        tool: "business_documents",
        rows: readable.map((r) => ({
          id: r.document_id, title: r.document!.title ?? r.document!.original_filename, date: r.document!.doc_date, from: r.document!.correspondent_display ?? r.document!.sender,
          subtitle: `${r.target_kind === "business" ? "Betrieb" : r.target_kind === "asset" ? "Anlagegut" : "Fläche"}${r.target_name ? ` ${r.target_name}` : ""}`, route: `/dokumente/${r.document_id}`,
        })),
        route: `/finanzen/betriebe/${id}`,
      },
    };
  },
};

export const BUSINESS_TOOLS = [listBusinesses, businessAssets, euerReport, businessDocuments];
