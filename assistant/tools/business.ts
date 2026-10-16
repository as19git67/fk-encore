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
interface BusinessDetail { business: BusinessItem; year: number; assets: AssetItem[]; parcels: ParcelItem[]; totals: { acquisition_cost: string; afa: string; book_value: string; annual_rent: string; area_m2: number } }

const KIND_LABEL: Record<string, string> = { landwirtschaft: "farm (Anlage L)", photovoltaik: "PV system (Anlage G)", gewerbe: "trade (Anlage G)", vermietung: "letting (Anlage V)" };

export const listBusinesses: ToolSpec = {
  name: "list_businesses",
  kind: "read",
  summary: "The user's businesses in the tax sense (leased farm, PV system, trade, letting) with id, kind, tax form and how many assets and parcels each has. Start here for questions about Landwirtschaft, Verpachtung, PV-Anlage, Anlagegüter, AfA or Flurstücke.",
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
  summary: "The fixed assets of one business with acquisition cost, AfA rate and the depreciation of one year (months held, AfA, book value at year end), plus the parcels with area, lessee and annual rent, and the totals. The depreciation is computed by the server (linear, pro rata by month, residual 1 €); quote it, never recompute it.",
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
      { cap: 60, note: `${res.business.name} (${KIND_LABEL[res.business.kind] ?? res.business.kind}), year ${res.year}: ${res.assets.length} assets, acquisition cost ${res.totals.acquisition_cost}, AfA ${res.totals.afa}, book value ${res.totals.book_value}.` },
    );
    const parcelTable = res.parcels.length
      ? "\n" + table(["id", "parcel", "usage", "area_m2", "lessee", "annual_rent", "lease"], parcels, { cap: 60, note: `${res.parcels.length} parcels, ${res.totals.area_m2} m² in all, annual rent ${res.totals.annual_rent}.` })
      : "";
    return {
      text: assetTable + parcelTable,
      digest: `[earlier result of business_assets: business ${id} "${res.business.name}", year ${res.year}, ${res.assets.length} assets (AfA ${res.totals.afa}, book value ${res.totals.book_value}), ${res.parcels.length} parcels (rent ${res.totals.annual_rent})]`,
      rowCount: res.assets.length + res.parcels.length,
      block: {
        kind: "business_assets",
        tool: "business_assets",
        subtitle: `${res.business.name} · ${res.year} · AfA ${res.totals.afa} € · Buchwert ${res.totals.book_value} €`,
        rows: [
          ...res.assets.map((a) => ({ id: a.id, name: a.name, kind: a.kind, acquisition_cost: a.acquisition_cost, afa_rate_pct: a.afa_rate_pct, afa: a.depreciation.afa, book_value: a.depreciation.book_value, route: `/finanzen/betriebe/${id}` })),
          ...res.parcels.map((p) => ({ id: p.id, name: `${p.gemarkung} Flst. ${p.flurstueck}`, kind: "parcel", usage: p.usage, area_m2: p.area_m2, lessee: p.lessee, annual_rent: p.annual_rent, route: `/finanzen/betriebe/${id}` })),
        ],
        route: `/finanzen/betriebe/${id}`,
      },
    };
  },
};

export const BUSINESS_TOOLS = [listBusinesses, businessAssets];
