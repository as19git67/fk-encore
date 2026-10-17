/**
 * Businesses in the tax sense (documentation/plans/betriebe-euer.md,
 * stage 1): a leased farm, a PV system, a trade — each with its fixed
 * assets and, for a farm, its parcels. The register is the user's own;
 * `finance.admin` sees every business. The depreciation schedule comes
 * from `depreciation.ts` on request, never from a stored figure.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { meter } from "~encore/clients";
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";

import { requirePermission } from "../user/auth-handler";
import db from "../db/database";
import {
  financeBusiness,
  financeBusinessAsset,
  financeBusinessParcel,
  financeTag,
  financeTagTransaction,
  financeTransaction,
  type BusinessAssetKind,
  type BusinessKind,
  type BusinessTaxSection,
  type EuerLineDefinition,
  type ParcelUsage,
  type PvTaxOverride,
} from "../db/schema";
import { readableFinanceAccountIds } from "./account-acl";
import { depreciationOfYear, depreciationSchedule, type DepreciationYear } from "./depreciation";
import { buildEuer, defaultBookingTag, defaultDocumentCategory, defaultEuerLines, type EuerBooking, type EuerReport } from "./euer";
import { createEuerPdf } from "./euer-pdf";
import { pvTaxStatus, type PvTaxStatus } from "./pv";

console.log("[boot] finance/businesses.ts: all imports resolved");

const KINDS: readonly BusinessKind[] = ["landwirtschaft", "photovoltaik", "gewerbe", "vermietung"];
const SECTIONS: readonly BusinessTaxSection[] = ["anlage-l", "anlage-g", "anlage-v"];
const ASSET_KINDS: readonly BusinessAssetKind[] = ["gebaeude", "flaeche", "maschine", "pv_anlage", "sonstiges"];
const USAGES: readonly ParcelUsage[] = ["acker", "gruenland", "wald", "hof", "sonstiges"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface BusinessView {
  id: number;
  owner_user_id: number;
  name: string;
  kind: BusinessKind;
  tax_section: BusinessTaxSection;
  notes: string | null;
  booking_tag: string | null;
  document_category: string | null;
  euer_lines: EuerLineDefinition[];
  /** PV only: capacity in kWp as entered, commissioning date, and the exemption override. */
  pv_capacity_kwp: string | null;
  pv_commissioned_on: string | null;
  pv_tax_override: PvTaxOverride | null;
  asset_count: number;
  parcel_count: number;
  created_at: string;
  updated_at: string;
}

export interface AssetView {
  id: number;
  business_id: number;
  name: string;
  kind: BusinessAssetKind;
  acquisition_date: string;
  acquisition_cost: string;
  afa_rate_pct: string;
  afa_start_date: string | null;
  disposal_date: string | null;
  disposal_proceeds: string | null;
  notes: string | null;
  /** The requested year's row of the schedule. */
  depreciation: DepreciationYear;
}

export interface ParcelView {
  id: number;
  business_id: number;
  asset_id: number | null;
  gemarkung: string;
  flur: string | null;
  flurstueck: string;
  area_m2: number | null;
  usage: ParcelUsage;
  lessee: string | null;
  lease_from: string | null;
  lease_to: string | null;
  annual_rent: string | null;
  notes: string | null;
}

interface Caller { userId: number; admin: boolean; manage: boolean }

function caller(): Caller {
  const auth = getAuthData()!;
  requirePermission(auth, "finance.view");
  return {
    userId: Number(auth.userID),
    admin: auth.permissions.includes("finance.admin"),
    manage: auth.permissions.includes("finance.accounts.manage") || auth.permissions.includes("finance.admin"),
  };
}

function requireManage(c: Caller): void {
  if (!c.manage) throw APIError.permissionDenied("finance.accounts.manage is required to change businesses");
}

type BusinessRow = typeof financeBusiness.$inferSelect;

async function loadBusiness(c: Caller, id: number): Promise<BusinessRow> {
  const [row] = await db.select().from(financeBusiness).where(eq(financeBusiness.id, id)).limit(1);
  if (!row || (!c.admin && row.owner_user_id !== c.userId)) throw APIError.notFound(`business ${id} not found`);
  return row;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string, fallback?: T): T {
  if (value === undefined || value === null || value === "") {
    if (fallback !== undefined) return fallback;
    throw APIError.invalidArgument(`${field} is required (${allowed.join(", ")})`);
  }
  if (!(allowed as readonly string[]).includes(String(value))) throw APIError.invalidArgument(`${field} must be one of ${allowed.join(", ")}`);
  return value as T;
}

function isoDate(value: unknown, field: string, required = false): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) throw APIError.invalidArgument(`${field} is required (YYYY-MM-DD)`);
    return null;
  }
  const s = String(value);
  if (!ISO_DATE.test(s) || Number.isNaN(Date.parse(s))) throw APIError.invalidArgument(`${field} must be YYYY-MM-DD`);
  return s;
}

function money(value: unknown, field: string, required = false): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) throw APIError.invalidArgument(`${field} is required`);
    return null;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw APIError.invalidArgument(`${field} must be a non-negative amount`);
  return n.toFixed(2);
}

function text(value: unknown, field: string, required = false): string | null {
  const s = value === undefined || value === null ? "" : String(value).trim();
  if (!s) {
    if (required) throw APIError.invalidArgument(`${field} must not be empty`);
    return null;
  }
  if (s.length > 500) throw APIError.invalidArgument(`${field} is too long`);
  return s;
}

function currentYear(): number {
  return new Date().getFullYear();
}

async function counts(ids: number[]): Promise<Map<number, { assets: number; parcels: number }>> {
  const out = new Map<number, { assets: number; parcels: number }>();
  for (const id of ids) out.set(id, { assets: 0, parcels: 0 });
  if (!ids.length) return out;
  const assets = await db.select({ business_id: financeBusinessAsset.business_id }).from(financeBusinessAsset);
  for (const a of assets) if (out.has(a.business_id)) out.get(a.business_id)!.assets++;
  const parcels = await db.select({ business_id: financeBusinessParcel.business_id }).from(financeBusinessParcel);
  for (const p of parcels) if (out.has(p.business_id)) out.get(p.business_id)!.parcels++;
  return out;
}

function toBusiness(row: BusinessRow, c: { assets: number; parcels: number }): BusinessView {
  return {
    id: row.id, owner_user_id: row.owner_user_id, name: row.name, kind: row.kind, tax_section: row.tax_section, notes: row.notes,
    booking_tag: row.booking_tag, document_category: row.document_category, euer_lines: row.euer_lines,
    pv_capacity_kwp: row.pv_capacity_kwp, pv_commissioned_on: row.pv_commissioned_on, pv_tax_override: row.pv_tax_override,
    asset_count: c.assets, parcel_count: c.parcels, created_at: row.created_at, updated_at: row.updated_at,
  };
}

function toAsset(row: typeof financeBusinessAsset.$inferSelect, year: number): AssetView {
  return {
    id: row.id, business_id: row.business_id, name: row.name, kind: row.kind, acquisition_date: row.acquisition_date,
    acquisition_cost: row.acquisition_cost, afa_rate_pct: row.afa_rate_pct, afa_start_date: row.afa_start_date,
    disposal_date: row.disposal_date, disposal_proceeds: row.disposal_proceeds, notes: row.notes,
    depreciation: depreciationOfYear(row, year),
  };
}

function toParcel(row: typeof financeBusinessParcel.$inferSelect): ParcelView {
  return {
    id: row.id, business_id: row.business_id, asset_id: row.asset_id, gemarkung: row.gemarkung, flur: row.flur, flurstueck: row.flurstueck,
    area_m2: row.area_m2, usage: row.usage, lessee: row.lessee, lease_from: row.lease_from, lease_to: row.lease_to,
    annual_rent: row.annual_rent, notes: row.notes,
  };
}

// ── businesses ───────────────────────────────────────────────────────────────

export const listBusinesses = api(
  { expose: true, method: "GET", path: "/finance/businesses", auth: true },
  async (): Promise<{ items: BusinessView[] }> => {
    const c = caller();
    const rows = await db.select().from(financeBusiness)
      .where(c.admin ? undefined : eq(financeBusiness.owner_user_id, c.userId))
      .orderBy(asc(financeBusiness.name));
    const n = await counts(rows.map((r) => r.id));
    return { items: rows.map((r) => toBusiness(r, n.get(r.id)!)) };
  },
);

export interface BusinessInput {
  name?: string;
  kind?: BusinessKind;
  tax_section?: BusinessTaxSection;
  notes?: string | null;
  /** The user tag that marks a booking as this business's; null for none. */
  booking_tag?: string | null;
  /** The document category (slug) its receipts are classified into; null for none. */
  document_category?: string | null;
  /** The lines of the Anlage EÜR, replacing the whole list. */
  euer_lines?: EuerLineDefinition[];
  /** PV only: capacity in kWp (null clears), commissioning date, exemption override ("exempt", "taxable", null = derive). */
  pv_capacity_kwp?: string | number | null;
  pv_commissioned_on?: string | null;
  pv_tax_override?: PvTaxOverride | null;
}

function kwp(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 10000) throw APIError.invalidArgument("pv_capacity_kwp must be a capacity in kWp between 0 and 10000");
  return n.toFixed(3);
}

function pvOverride(value: unknown): PvTaxOverride | null {
  if (value === undefined || value === null || value === "") return null;
  if (value !== "exempt" && value !== "taxable") throw APIError.invalidArgument("pv_tax_override must be exempt, taxable or null");
  return value;
}

/** What the page and the tools say about a PV business: its status for the year and the meters' feed-in. */
export interface PvView {
  capacity_kwp: string | null;
  /** Where the capacity came from: the business, or the tariff timeline of the meters when the business has none. */
  capacity_source: "business" | "meters" | null;
  commissioned_on: string | null;
  tax_override: PvTaxOverride | null;
  status: PvTaxStatus;
  /** The year's feed-in from the energy report of the meters; null without meter access or tariffs. */
  feed_in: { revenue_eur: number | null; exported_kwh: number | null; complete: boolean } | null;
}

const MAX_EUER_LINES = 60;

function euerLines(value: unknown): EuerLineDefinition[] {
  if (!Array.isArray(value)) throw APIError.invalidArgument("euer_lines must be an array");
  if (value.length > MAX_EUER_LINES) throw APIError.invalidArgument(`at most ${MAX_EUER_LINES} EÜR lines`);
  const seen = new Set<string>();
  return value.map((raw, i) => {
    const l = (raw ?? {}) as Record<string, unknown>;
    const name = text(l.name, `euer_lines[${i}].name`, true)!;
    const key = name.toLowerCase();
    if (seen.has(key)) throw APIError.invalidArgument(`EÜR line "${name}" appears twice`);
    seen.add(key);
    const kind = oneOf(l.kind, ["income", "expense"] as const, `euer_lines[${i}].kind`);
    const tags = Array.isArray(l.tags)
      ? [...new Set(l.tags.map((t) => String(t ?? "").trim()).filter((t) => t.length > 0 && t.length <= 100))]
      : [];
    return { name, kind, tags, form_line: text(l.form_line, `euer_lines[${i}].form_line`) };
  });
}

/** The Anlage a kind files under unless told otherwise. */
const DEFAULT_SECTION: Record<BusinessKind, BusinessTaxSection> = {
  landwirtschaft: "anlage-l", photovoltaik: "anlage-g", gewerbe: "anlage-g", vermietung: "anlage-v",
};

export const createBusiness = api(
  { expose: true, method: "POST", path: "/finance/businesses", auth: true },
  async (req: BusinessInput): Promise<BusinessView> => {
    const c = caller();
    requireManage(c);
    const kind = oneOf(req.kind, KINDS, "kind");
    const [row] = await db.insert(financeBusiness).values({
      owner_user_id: c.userId,
      name: text(req.name, "name", true)!,
      kind,
      tax_section: oneOf(req.tax_section, SECTIONS, "tax_section", DEFAULT_SECTION[kind]),
      notes: text(req.notes, "notes"),
      booking_tag: req.booking_tag === undefined ? defaultBookingTag(kind) : text(req.booking_tag, "booking_tag"),
      document_category: req.document_category === undefined ? defaultDocumentCategory(kind) : text(req.document_category, "document_category"),
      euer_lines: req.euer_lines === undefined ? defaultEuerLines(kind) : euerLines(req.euer_lines),
      pv_capacity_kwp: kwp(req.pv_capacity_kwp),
      pv_commissioned_on: isoDate(req.pv_commissioned_on, "pv_commissioned_on"),
      pv_tax_override: pvOverride(req.pv_tax_override),
    }).returning();
    return toBusiness(row!, { assets: 0, parcels: 0 });
  },
);

export const getBusiness = api(
  { expose: true, method: "GET", path: "/finance/businesses/:id", auth: true },
  async ({ id, year }: { id: number; year?: number }): Promise<{ business: BusinessView; year: number; assets: AssetView[]; parcels: ParcelView[]; totals: { acquisition_cost: string; afa: string; book_value: string; annual_rent: string; area_m2: number }; pv: PvView | null }> => {
    const c = caller();
    const row = await loadBusiness(c, id);
    const y = Number.isInteger(year) && year! >= 1990 && year! <= 2100 ? year! : currentYear();
    const assets = (await db.select().from(financeBusinessAsset).where(eq(financeBusinessAsset.business_id, id)).orderBy(asc(financeBusinessAsset.acquisition_date), asc(financeBusinessAsset.id))).map((a) => toAsset(a, y));
    const parcels = (await db.select().from(financeBusinessParcel).where(eq(financeBusinessParcel.business_id, id)).orderBy(asc(financeBusinessParcel.gemarkung), asc(financeBusinessParcel.flurstueck))).map(toParcel);
    const held = assets.filter((a) => !a.disposal_date || a.disposal_date.slice(0, 4) >= String(y));
    const sum = (xs: string[]) => (xs.reduce((acc, x) => acc + Math.round(Number(x) * 100), 0) / 100).toFixed(2);
    const n = await counts([id]);
    return {
      business: toBusiness(row, n.get(id)!),
      year: y,
      assets,
      parcels,
      totals: {
        acquisition_cost: sum(held.map((a) => a.acquisition_cost)),
        afa: sum(assets.map((a) => a.depreciation.afa)),
        book_value: sum(assets.map((a) => a.depreciation.book_value)),
        annual_rent: sum(parcels.map((p) => p.annual_rent ?? "0")),
        area_m2: parcels.reduce((acc, p) => acc + (p.area_m2 ?? 0), 0),
      },
      pv: row.kind === "photovoltaik" ? await pvView(row, y) : null,
    };
  },
);

export const updateBusiness = api(
  { expose: true, method: "PATCH", path: "/finance/businesses/:id", auth: true },
  async ({ id, ...req }: BusinessInput & { id: number }): Promise<BusinessView> => {
    const c = caller();
    requireManage(c);
    const row = await loadBusiness(c, id);
    const kind = req.kind === undefined ? row.kind : oneOf(req.kind, KINDS, "kind");
    const [updated] = await db.update(financeBusiness).set({
      name: req.name === undefined ? row.name : text(req.name, "name", true)!,
      kind,
      tax_section: req.tax_section === undefined ? row.tax_section : oneOf(req.tax_section, SECTIONS, "tax_section"),
      notes: req.notes === undefined ? row.notes : text(req.notes, "notes"),
      booking_tag: req.booking_tag === undefined ? row.booking_tag : text(req.booking_tag, "booking_tag"),
      document_category: req.document_category === undefined ? row.document_category : text(req.document_category, "document_category"),
      euer_lines: req.euer_lines === undefined ? row.euer_lines : euerLines(req.euer_lines),
      pv_capacity_kwp: req.pv_capacity_kwp === undefined ? row.pv_capacity_kwp : kwp(req.pv_capacity_kwp),
      pv_commissioned_on: req.pv_commissioned_on === undefined ? row.pv_commissioned_on : isoDate(req.pv_commissioned_on, "pv_commissioned_on"),
      pv_tax_override: req.pv_tax_override === undefined ? row.pv_tax_override : pvOverride(req.pv_tax_override),
      updated_at: new Date().toISOString(),
    }).where(eq(financeBusiness.id, id)).returning();
    const n = await counts([id]);
    return toBusiness(updated!, n.get(id)!);
  },
);

// ── photovoltaics ────────────────────────────────────────────────────────────

/** The latest `pv_capacity_kwp` entry of the user's tariff timeline, when the meter module is reachable. */
async function meterCapacityKwp(): Promise<number | null> {
  try {
    const res = (await meter.listTariffs()) as unknown as { tariffs: { kind: string; validFrom: string; amount: number }[] };
    const rows = (res.tariffs ?? []).filter((t) => t.kind === "pv_capacity_kwp").sort((a, b) => a.validFrom.localeCompare(b.validFrom));
    const last = rows.at(-1);
    return last && Number.isFinite(last.amount) && last.amount > 0 ? last.amount : null;
  } catch {
    return null;
  }
}

/** The year's feed-in of the household's meters, from the energy report; null when there is none. */
async function meterFeedIn(year: number): Promise<PvView["feed_in"]> {
  try {
    const res = (await meter.getEnergyReport({ granularity: "year", from: `${year}-01-01`, to: `${year}-12-31` })) as unknown as {
      buckets: { complete: boolean }[];
      totals: { gridExport: number | null; costs: { feedInRevenueEur: number | null } | null };
    };
    if (!res.totals) return null;
    return {
      revenue_eur: res.totals.costs?.feedInRevenueEur ?? null,
      exported_kwh: res.totals.gridExport ?? null,
      complete: (res.buckets ?? []).length > 0 && res.buckets.every((b) => b.complete),
    };
  } catch {
    return null;
  }
}

async function pvView(row: BusinessRow, year: number): Promise<PvView> {
  let capacity = row.pv_capacity_kwp === null ? null : Number(row.pv_capacity_kwp);
  let source: PvView["capacity_source"] = capacity === null ? null : "business";
  if (capacity === null) {
    const fromMeters = await meterCapacityKwp();
    if (fromMeters !== null) { capacity = fromMeters; source = "meters"; }
  }
  return {
    capacity_kwp: capacity === null ? null : capacity.toFixed(3),
    capacity_source: source,
    commissioned_on: row.pv_commissioned_on,
    tax_override: row.pv_tax_override,
    status: pvTaxStatus({ capacityKwp: capacity, year, override: row.pv_tax_override }),
    feed_in: await meterFeedIn(year),
  };
}

// ── EÜR ──────────────────────────────────────────────────────────────────────

/** Loads the bookings of the year carrying the business's tag, with every tag they carry. */
async function euerBookings(c: Caller, tag: string | null, year: number): Promise<EuerBooking[]> {
  if (!tag) return [];
  const auth = getAuthData()!;
  const readable = await readableFinanceAccountIds(auth);
  if (readable !== null && readable.length === 0) return [];
  const rows = await db
    .select({
      id: financeTransaction.id,
      booking_date: financeTransaction.booking_date,
      counterparty: financeTransaction.counterparty,
      purpose: financeTransaction.purpose,
      amount: financeTransaction.amount,
      is_tax_relevant: financeTransaction.is_tax_relevant,
    })
    .from(financeTagTransaction)
    .innerJoin(financeTag, eq(financeTag.id, financeTagTransaction.tag_id))
    .innerJoin(financeTransaction, eq(financeTransaction.id, financeTagTransaction.transaction_id))
    .where(and(
      eq(financeTag.name, tag),
      gte(financeTransaction.booking_date, `${year}-01-01`),
      lte(financeTransaction.booking_date, `${year}-12-31`),
      ...(readable === null ? [] : [inArray(financeTransaction.account_id, readable)]),
    ));
  const ids = [...new Set(rows.map((r) => r.id))];
  const tagRows = ids.length
    ? await db.select({ transaction_id: financeTagTransaction.transaction_id, name: financeTag.name })
      .from(financeTagTransaction)
      .innerJoin(financeTag, eq(financeTag.id, financeTagTransaction.tag_id))
      .where(inArray(financeTagTransaction.transaction_id, ids))
    : [];
  const tags = new Map<number, string[]>();
  for (const t of tagRows) tags.set(t.transaction_id, [...(tags.get(t.transaction_id) ?? []), t.name]);
  const seen = new Set<number>();
  const out: EuerBooking[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({
      id: r.id, booking_date: r.booking_date.slice(0, 10), counterparty: r.counterparty, purpose: r.purpose, amount: r.amount,
      tags: tags.get(r.id) ?? [], is_tax_relevant: r.is_tax_relevant,
    });
  }
  void c;
  return out;
}

async function euerOf(c: Caller, id: number, year: number | undefined): Promise<EuerReport> {
  const row = await loadBusiness(c, id);
  const y = Number.isInteger(year) && year! >= 1990 && year! <= 2100 ? year! : currentYear();
  const assets = await db.select().from(financeBusinessAsset).where(eq(financeBusinessAsset.business_id, id)).orderBy(asc(financeBusinessAsset.id));
  const afa = assets
    .map((a) => ({ asset_id: a.id, name: a.name, afa: Math.round(Number(depreciationOfYear(a, y).afa) * 100) }))
    .filter((a) => a.afa !== 0);
  const bookings = await euerBookings(c, row.booking_tag, y);
  const report = buildEuer({ year: y, business: row.name, tag: row.booking_tag, lines: row.euer_lines, bookings, afa });
  if (row.kind === "photovoltaik") {
    const pv = await pvView(row, y);
    report.tax_exempt = { exempt: pv.status.exempt, reason: pv.status.reason };
    if (pv.status.exempt === true) report.hints.unshift(`Steuerfrei: ${pv.status.reason} The figures below are for information; nothing goes into Anlage G or Anlage EÜR.`);
    else if (pv.status.exempt === null) report.hints.unshift(pv.status.reason);
    if (pv.feed_in?.revenue_eur !== null && pv.feed_in?.revenue_eur !== undefined) {
      report.hints.push(`Meters: feed-in of ${y} from the energy report ${pv.feed_in.revenue_eur.toFixed(2)} EUR${pv.feed_in.exported_kwh !== null ? ` for ${pv.feed_in.exported_kwh.toFixed(0)} kWh` : ""}${pv.feed_in.complete ? "" : " (readings incomplete)"}; compare with the income lines.`);
    }
  }
  return report;
}

export const getBusinessEuer = api(
  { expose: true, method: "GET", path: "/finance/businesses/:id/euer", auth: true },
  async ({ id, year }: { id: number; year?: number }): Promise<EuerReport> => euerOf(caller(), id, year),
);

function slug(s: string): string {
  return s.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "euer";
}

export const businessEuerPdf = api.raw(
  { expose: true, method: "GET", path: "/finance/businesses/:id/euer/pdf", auth: true },
  async (req, res) => {
    let report: EuerReport;
    try {
      const c = caller();
      const url = new URL(req.url ?? "", "http://localhost");
      const id = Number(url.pathname.split("/").at(-3));
      if (!Number.isInteger(id)) throw APIError.invalidArgument("bad business id");
      const year = url.searchParams.get("year");
      report = await euerOf(c, id, year ? Number(year) : undefined);
    } catch (err) {
      const status = err instanceof APIError
        ? ({ not_found: 404, unauthenticated: 401, permission_denied: 403, invalid_argument: 400 } as Record<string, number>)[err.code] ?? 500
        : 500;
      res.statusCode = status;
      res.end(err instanceof Error ? err.message : "error");
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", `attachment; filename="euer-${slug(report.business)}-${report.year}.pdf"`);
    const pdf = createEuerPdf(report, new Date().toISOString().slice(0, 10));
    pdf.pipe(res);
    pdf.end();
  },
);

export const deleteBusiness = api(
  { expose: true, method: "DELETE", path: "/finance/businesses/:id", auth: true },
  async ({ id }: { id: number }): Promise<{ deleted: boolean }> => {
    const c = caller();
    requireManage(c);
    await loadBusiness(c, id);
    await db.delete(financeBusiness).where(eq(financeBusiness.id, id));
    return { deleted: true };
  },
);

// ── assets ───────────────────────────────────────────────────────────────────

export interface AssetInput {
  name?: string;
  kind?: BusinessAssetKind;
  acquisition_date?: string;
  acquisition_cost?: string | number;
  afa_rate_pct?: string | number;
  afa_start_date?: string | null;
  disposal_date?: string | null;
  disposal_proceeds?: string | number | null;
  notes?: string | null;
}

/** The rate a kind is usually written off at; land never. */
const DEFAULT_RATE: Record<BusinessAssetKind, string> = { gebaeude: "2", flaeche: "0", maschine: "10", pv_anlage: "5", sonstiges: "10" };

function rate(value: unknown, field: string, fallback: string): string {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw APIError.invalidArgument(`${field} must be a percentage between 0 and 100`);
  return n.toFixed(3);
}

export const createAsset = api(
  { expose: true, method: "POST", path: "/finance/businesses/:id/assets", auth: true },
  async ({ id, ...req }: AssetInput & { id: number }): Promise<AssetView> => {
    const c = caller();
    requireManage(c);
    await loadBusiness(c, id);
    const kind = oneOf(req.kind, ASSET_KINDS, "kind");
    const [row] = await db.insert(financeBusinessAsset).values({
      business_id: id,
      name: text(req.name, "name", true)!,
      kind,
      acquisition_date: isoDate(req.acquisition_date, "acquisition_date", true)!,
      acquisition_cost: money(req.acquisition_cost, "acquisition_cost", true)!,
      afa_rate_pct: kind === "flaeche" ? "0.000" : rate(req.afa_rate_pct, "afa_rate_pct", DEFAULT_RATE[kind]),
      afa_start_date: isoDate(req.afa_start_date, "afa_start_date"),
      disposal_date: isoDate(req.disposal_date, "disposal_date"),
      disposal_proceeds: money(req.disposal_proceeds, "disposal_proceeds"),
      notes: text(req.notes, "notes"),
    }).returning();
    return toAsset(row!, currentYear());
  },
);

async function loadAsset(c: Caller, assetId: number) {
  const [row] = await db.select().from(financeBusinessAsset).where(eq(financeBusinessAsset.id, assetId)).limit(1);
  if (!row) throw APIError.notFound(`asset ${assetId} not found`);
  await loadBusiness(c, row.business_id);
  return row;
}

export const updateAsset = api(
  { expose: true, method: "PATCH", path: "/finance/business-assets/:assetId", auth: true },
  async ({ assetId, ...req }: AssetInput & { assetId: number }): Promise<AssetView> => {
    const c = caller();
    requireManage(c);
    const row = await loadAsset(c, assetId);
    const kind = req.kind === undefined ? row.kind : oneOf(req.kind, ASSET_KINDS, "kind");
    const [updated] = await db.update(financeBusinessAsset).set({
      name: req.name === undefined ? row.name : text(req.name, "name", true)!,
      kind,
      acquisition_date: req.acquisition_date === undefined ? row.acquisition_date : isoDate(req.acquisition_date, "acquisition_date", true)!,
      acquisition_cost: req.acquisition_cost === undefined ? row.acquisition_cost : money(req.acquisition_cost, "acquisition_cost", true)!,
      afa_rate_pct: kind === "flaeche" ? "0.000" : req.afa_rate_pct === undefined ? row.afa_rate_pct : rate(req.afa_rate_pct, "afa_rate_pct", row.afa_rate_pct),
      afa_start_date: req.afa_start_date === undefined ? row.afa_start_date : isoDate(req.afa_start_date, "afa_start_date"),
      disposal_date: req.disposal_date === undefined ? row.disposal_date : isoDate(req.disposal_date, "disposal_date"),
      disposal_proceeds: req.disposal_proceeds === undefined ? row.disposal_proceeds : money(req.disposal_proceeds, "disposal_proceeds"),
      notes: req.notes === undefined ? row.notes : text(req.notes, "notes"),
      updated_at: new Date().toISOString(),
    }).where(eq(financeBusinessAsset.id, assetId)).returning();
    return toAsset(updated!, currentYear());
  },
);

export const deleteAsset = api(
  { expose: true, method: "DELETE", path: "/finance/business-assets/:assetId", auth: true },
  async ({ assetId }: { assetId: number }): Promise<{ deleted: boolean }> => {
    const c = caller();
    requireManage(c);
    await loadAsset(c, assetId);
    await db.delete(financeBusinessAsset).where(eq(financeBusinessAsset.id, assetId));
    return { deleted: true };
  },
);

/** The whole schedule of one asset, from its first year to `until_year`. */
export const getAssetSchedule = api(
  { expose: true, method: "GET", path: "/finance/business-assets/:assetId/schedule", auth: true },
  async ({ assetId, until_year }: { assetId: number; until_year?: number }): Promise<{ asset: AssetView; rows: DepreciationYear[] }> => {
    const c = caller();
    const row = await loadAsset(c, assetId);
    const until = Number.isInteger(until_year) && until_year! >= 1990 && until_year! <= 2100 ? until_year! : currentYear();
    return { asset: toAsset(row, until), rows: depreciationSchedule(row, until) };
  },
);

// ── parcels ──────────────────────────────────────────────────────────────────

export interface ParcelInput {
  asset_id?: number | null;
  gemarkung?: string;
  flur?: string | null;
  flurstueck?: string;
  area_m2?: number | null;
  usage?: ParcelUsage;
  lessee?: string | null;
  lease_from?: string | null;
  lease_to?: string | null;
  annual_rent?: string | number | null;
  notes?: string | null;
}

function area(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw APIError.invalidArgument("area_m2 must be a whole number of square metres");
  return n;
}

async function assetOfBusiness(businessId: number, assetId: number | null | undefined): Promise<number | null> {
  if (assetId === undefined || assetId === null) return null;
  const [row] = await db.select({ id: financeBusinessAsset.id }).from(financeBusinessAsset)
    .where(and(eq(financeBusinessAsset.id, assetId), eq(financeBusinessAsset.business_id, businessId))).limit(1);
  if (!row) throw APIError.invalidArgument(`asset ${assetId} does not belong to this business`);
  return row.id;
}

export const createParcel = api(
  { expose: true, method: "POST", path: "/finance/businesses/:id/parcels", auth: true },
  async ({ id, ...req }: ParcelInput & { id: number }): Promise<ParcelView> => {
    const c = caller();
    requireManage(c);
    await loadBusiness(c, id);
    const [row] = await db.insert(financeBusinessParcel).values({
      business_id: id,
      asset_id: await assetOfBusiness(id, req.asset_id),
      gemarkung: text(req.gemarkung, "gemarkung", true)!,
      flur: text(req.flur, "flur"),
      flurstueck: text(req.flurstueck, "flurstueck", true)!,
      area_m2: area(req.area_m2),
      usage: oneOf(req.usage, USAGES, "usage", "acker"),
      lessee: text(req.lessee, "lessee"),
      lease_from: isoDate(req.lease_from, "lease_from"),
      lease_to: isoDate(req.lease_to, "lease_to"),
      annual_rent: money(req.annual_rent, "annual_rent"),
      notes: text(req.notes, "notes"),
    }).returning();
    return toParcel(row!);
  },
);

async function loadParcel(c: Caller, parcelId: number) {
  const [row] = await db.select().from(financeBusinessParcel).where(eq(financeBusinessParcel.id, parcelId)).limit(1);
  if (!row) throw APIError.notFound(`parcel ${parcelId} not found`);
  await loadBusiness(c, row.business_id);
  return row;
}

export const updateParcel = api(
  { expose: true, method: "PATCH", path: "/finance/business-parcels/:parcelId", auth: true },
  async ({ parcelId, ...req }: ParcelInput & { parcelId: number }): Promise<ParcelView> => {
    const c = caller();
    requireManage(c);
    const row = await loadParcel(c, parcelId);
    const [updated] = await db.update(financeBusinessParcel).set({
      asset_id: req.asset_id === undefined ? row.asset_id : await assetOfBusiness(row.business_id, req.asset_id),
      gemarkung: req.gemarkung === undefined ? row.gemarkung : text(req.gemarkung, "gemarkung", true)!,
      flur: req.flur === undefined ? row.flur : text(req.flur, "flur"),
      flurstueck: req.flurstueck === undefined ? row.flurstueck : text(req.flurstueck, "flurstueck", true)!,
      area_m2: req.area_m2 === undefined ? row.area_m2 : area(req.area_m2),
      usage: req.usage === undefined ? row.usage : oneOf(req.usage, USAGES, "usage"),
      lessee: req.lessee === undefined ? row.lessee : text(req.lessee, "lessee"),
      lease_from: req.lease_from === undefined ? row.lease_from : isoDate(req.lease_from, "lease_from"),
      lease_to: req.lease_to === undefined ? row.lease_to : isoDate(req.lease_to, "lease_to"),
      annual_rent: req.annual_rent === undefined ? row.annual_rent : money(req.annual_rent, "annual_rent"),
      notes: req.notes === undefined ? row.notes : text(req.notes, "notes"),
      updated_at: new Date().toISOString(),
    }).where(eq(financeBusinessParcel.id, parcelId)).returning();
    return toParcel(updated!);
  },
);

export const deleteParcel = api(
  { expose: true, method: "DELETE", path: "/finance/business-parcels/:parcelId", auth: true },
  async ({ parcelId }: { parcelId: number }): Promise<{ deleted: boolean }> => {
    const c = caller();
    requireManage(c);
    await loadParcel(c, parcelId);
    await db.delete(financeBusinessParcel).where(eq(financeBusinessParcel.id, parcelId));
    return { deleted: true };
  },
);
