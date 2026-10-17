/**
 * The business register (documentation/plans/betriebe-euer.md, stage 1):
 * a business with its assets and parcels, the year's AfA and totals, the
 * owner's and the admin's view. Data is synthetic.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { inArray, sql } from "drizzle-orm";

import db from "../db/database";
import { financeAccount, financeAccountAccess, financeAccountType, financeBusiness, financeTag, financeTagTransaction, financeTransaction } from "../db/schema";
import {
  createAsset, createBusiness, createParcel, deleteBusiness, getAssetSchedule, getBusiness, getBusinessEuer, listBusinesses, updateAsset, updateBusiness,
} from "./businesses";
import { createEuerPdf } from "./euer-pdf";

const OWNER = 7310;
const OTHER = 7311;
const VIEW = ["module.finance", "finance.view"];
const MANAGE = [...VIEW, "finance.accounts.manage"];

function setAuth(userID: number, permissions: string[]) {
  vi.mocked(getAuthData).mockReturnValue({ userID: String(userID), permissions });
}

async function ensureUser(id: number) {
  await db.execute(sql`INSERT INTO users (id, email, name, password_hash) VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x') ON CONFLICT (id) DO NOTHING`);
}

beforeEach(async () => {
  await ensureUser(OWNER);
  await ensureUser(OTHER);
  await db.delete(financeBusiness);
});

describe("businesses", () => {
  it("creates a farm with its barn and parcels and reports the year's AfA and totals", async () => {
    setAuth(OWNER, MANAGE);
    const farm = await createBusiness({ name: "Hof Beispielheim", kind: "landwirtschaft" });
    expect(farm).toMatchObject({ kind: "landwirtschaft", tax_section: "anlage-l", asset_count: 0 });

    const barn = await createAsset({ id: farm.id, name: "Scheune", kind: "gebaeude", acquisition_date: "2020-04-15", acquisition_cost: 120000 });
    expect(barn.afa_rate_pct).toBe("2.000");
    const land = await createAsset({ id: farm.id, name: "Acker Beispielfeld", kind: "flaeche", acquisition_date: "2015-06-01", acquisition_cost: "80000", afa_rate_pct: 3 });
    expect(land.afa_rate_pct).toBe("0.000");
    await createParcel({ id: farm.id, asset_id: land.id, gemarkung: "Beispielheim", flur: "3", flurstueck: "12/4", area_m2: 24500, usage: "acker", lessee: "Max Muster", lease_from: "2024-10-01", annual_rent: "1225.00" });
    await createParcel({ id: farm.id, gemarkung: "Beispielheim", flurstueck: "15", area_m2: 8000, usage: "gruenland", annual_rent: 320 });

    const detail = await getBusiness({ id: farm.id, year: 2021 });
    expect(detail.assets.map((a) => [a.name, a.depreciation.afa, a.depreciation.book_value])).toEqual([
      ["Acker Beispielfeld", "0.00", "80000.00"],
      ["Scheune", "2400.00", "115800.00"],
    ]);
    expect(detail.totals).toEqual({ acquisition_cost: "200000.00", afa: "2400.00", book_value: "195800.00", annual_rent: "1545.00", area_m2: 32500 });
    expect(detail.parcels[0]).toMatchObject({ flurstueck: "12/4", lessee: "Max Muster", asset_id: land.id });
    expect((await listBusinesses()).items[0]).toMatchObject({ name: "Hof Beispielheim", asset_count: 2, parcel_count: 2 });

    const schedule = await getAssetSchedule({ assetId: barn.id, until_year: 2022 });
    expect(schedule.rows.map((r) => r.afa)).toEqual(["1800.00", "2400.00", "2400.00"]);
  });

  it("records a disposal and settles it against the book value", async () => {
    setAuth(OWNER, MANAGE);
    const pv = await createBusiness({ name: "PV Dach", kind: "photovoltaik" });
    expect(pv.tax_section).toBe("anlage-g");
    const plant = await createAsset({ id: pv.id, name: "PV-Anlage 9,9 kWp", kind: "pv_anlage", acquisition_date: "2019-01-10", acquisition_cost: 18000 });
    expect(plant.afa_rate_pct).toBe("5.000");
    const sold = await updateAsset({ assetId: plant.id, disposal_date: "2025-06-30", disposal_proceeds: 9000 });
    expect(sold.disposal_date).toBe("2025-06-30");
    const detail = await getBusiness({ id: pv.id, year: 2025 });
    expect(detail.assets[0]!.depreciation).toMatchObject({ months: 6, afa: "450.00", disposal_result: "-3150.00" });
  });

  it("keeps a business to its owner, lets the admin see it, and needs manage to change it", async () => {
    setAuth(OWNER, MANAGE);
    const farm = await createBusiness({ name: "Hof", kind: "landwirtschaft" });
    setAuth(OTHER, VIEW);
    expect((await listBusinesses()).items).toEqual([]);
    await expect(getBusiness({ id: farm.id })).rejects.toThrow("not found");
    await expect(createBusiness({ name: "x", kind: "gewerbe" })).rejects.toThrow("finance.accounts.manage");
    setAuth(OTHER, [...VIEW, "finance.admin"]);
    expect((await listBusinesses()).items).toHaveLength(1);
    expect((await updateBusiness({ id: farm.id, notes: "verpachtet" })).notes).toBe("verpachtet");
    setAuth(OWNER, MANAGE);
    await deleteBusiness({ id: farm.id });
    expect((await listBusinesses()).items).toEqual([]);
  });

  it("validates what it is given", async () => {
    setAuth(OWNER, MANAGE);
    await expect(createBusiness({ name: "", kind: "gewerbe" })).rejects.toThrow("name must not be empty");
    await expect(createBusiness({ name: "x", kind: "bakery" as never })).rejects.toThrow("kind must be one of");
    const farm = await createBusiness({ name: "Hof", kind: "landwirtschaft" });
    await expect(createAsset({ id: farm.id, name: "x", kind: "gebaeude", acquisition_date: "15.04.2020", acquisition_cost: 1 })).rejects.toThrow("YYYY-MM-DD");
    await expect(createAsset({ id: farm.id, name: "x", kind: "gebaeude", acquisition_date: "2020-04-15", acquisition_cost: -1 })).rejects.toThrow("non-negative");
    await expect(createParcel({ id: farm.id, gemarkung: "A", flurstueck: "1", asset_id: 999999 })).rejects.toThrow("does not belong");
  });
});

describe("EÜR", () => {
  const TAGS = ["Landwirtschaft-7310", "Pacht-7310", "Grundsteuer-7310"];

  async function account(label: string): Promise<number> {
    const [type] = await db.select({ id: financeAccountType.id }).from(financeAccountType).limit(1);
    const [row] = await db.insert(financeAccount)
      .values({ type_id: type!.id, currency_code: "EUR", account_number: `AN-${label}`, label })
      .returning({ id: financeAccount.id });
    return row!.id;
  }
  async function tagId(name: string): Promise<number> {
    const [t] = await db.insert(financeTag).values({ name, source: "user" })
      .onConflictDoUpdate({ target: [financeTag.name, financeTag.source], set: { name } })
      .returning({ id: financeTag.id });
    return t!.id;
  }
  async function booking(accountId: number, date: string, amount: string, tags: number[], flagged = true): Promise<number> {
    const [row] = await db.insert(financeTransaction)
      .values({ account_id: accountId, booking_date: `${date}T00:00:00`, amount, currency_code: "EUR", counterparty: "Beispiel Agrar GbR", purpose: "Pacht", is_tax_relevant: flagged, dedupe_hash: `test-euer-${accountId}-${date}-${amount}-${tags.join(".")}` })
      .returning({ id: financeTransaction.id });
    for (const t of tags) await db.insert(financeTagTransaction).values({ tag_id: t, transaction_id: row!.id });
    return row!.id;
  }

  beforeEach(async () => {
    const accounts = await db.select({ id: financeAccount.id }).from(financeAccount).where(inArray(financeAccount.label, ["Giro Hof 7310"]));
    const ids = accounts.map((a) => a.id);
    if (ids.length) {
      await db.delete(financeTransaction).where(inArray(financeTransaction.account_id, ids));
      await db.delete(financeAccountAccess).where(inArray(financeAccountAccess.account_id, ids));
      await db.delete(financeAccount).where(inArray(financeAccount.id, ids));
    }
    await db.delete(financeTag).where(inArray(financeTag.name, TAGS));
  });

  it("builds the year's EÜR from the tagged bookings and the register's AfA, and serves it as a PDF", async () => {
    setAuth(OWNER, MANAGE);
    const farm = await createBusiness({ name: "Hof Beispielheim", kind: "landwirtschaft", booking_tag: TAGS[0] });
    expect(farm.document_category).toBe("landwirtschaft");
    expect(farm.euer_lines.map((l) => l.name)).toContain("Pachteinnahmen");
    await updateBusiness({ id: farm.id, euer_lines: [
      { name: "Pachteinnahmen", kind: "income", tags: [TAGS[1]!], form_line: "Zeile 14" },
      { name: "Grundsteuer", kind: "expense", tags: [TAGS[2]!] },
    ] });
    await createAsset({ id: farm.id, name: "Stall", kind: "gebaeude", acquisition_date: "2020-01-01", acquisition_cost: 120000 });

    const acct = await account("Giro Hof 7310");
    await db.insert(financeAccountAccess).values({ account_id: acct, user_id: OWNER, level: "read" });
    const [lw, pacht, grund] = await Promise.all(TAGS.map(tagId));
    await booking(acct, "2025-03-01", "430.00", [lw!, pacht!]);
    await booking(acct, "2025-09-01", "430.00", [lw!, pacht!]);
    await booking(acct, "2025-02-10", "-96.40", [lw!, grund!], false);
    await booking(acct, "2024-09-01", "430.00", [lw!, pacht!]);
    await booking(acct, "2025-05-01", "-50.00", [pacht!]);

    const r = await getBusinessEuer({ id: farm.id, year: 2025 });
    expect(r.booking_count).toBe(3);
    expect(r.income.find((l) => l.name === "Pachteinnahmen")).toMatchObject({ count: 2, sum: 86000, form_line: "Zeile 14" });
    expect(r.expenses.find((l) => l.name === "Grundsteuer")).toMatchObject({ count: 1, sum: 9640 });
    expect(r.afa).toEqual({ sum: 240000, assets: [{ asset_id: expect.any(Number), name: "Stall", afa: 240000 }] });
    expect(r.total_income).toBe(86000);
    expect(r.total_expenses).toBe(9640 + 240000);
    expect(r.result).toBe(86000 - 249640);
    expect(r.unflagged).toBe(1);

    // Another reader without access to the account sees the business's lines but no bookings.
    setAuth(OTHER, VIEW);
    await expect(getBusinessEuer({ id: farm.id, year: 2025 })).rejects.toThrow(/not found/);

    setAuth(OWNER, MANAGE);
    const own = await updateBusiness({ id: farm.id, euer_lines: [{ name: "Pacht", kind: "income", tags: [TAGS[1]!] }] });
    expect(own.euer_lines).toEqual([{ name: "Pacht", kind: "income", tags: [TAGS[1]], form_line: null }]);
    const again = await getBusinessEuer({ id: farm.id, year: 2025 });
    expect(again.expenses.map((l) => l.name)).toEqual(["Sonstige Betriebsausgaben"]);
    expect(again.expenses[0]!.sum).toBe(9640);

    await expect(updateBusiness({ id: farm.id, euer_lines: [{ name: "A", kind: "income", tags: [] }, { name: "a", kind: "expense", tags: [] }] })).rejects.toThrow(/appears twice/);

    const pdf = createEuerPdf(again, "2026-10-17");
    const chunks: Buffer[] = [];
    pdf.on("data", (c: Buffer) => chunks.push(c));
    await new Promise<void>((resolve) => { pdf.on("end", () => resolve()); pdf.end(); });
    expect(Buffer.concat(chunks).subarray(0, 5).toString()).toBe("%PDF-");
  });
});

describe("photovoltaics", () => {
  it("derives the § 3 Nr. 72 EStG status from the capacity, takes the override, and marks the EÜR", async () => {
    setAuth(OWNER, MANAGE);
    const pv = await createBusiness({ name: "PV Dach", kind: "photovoltaik", pv_capacity_kwp: 9.8, pv_commissioned_on: "2023-05-02" });
    expect(pv).toMatchObject({ tax_section: "anlage-g", pv_capacity_kwp: "9.800", pv_commissioned_on: "2023-05-02", pv_tax_override: null });

    const d = await getBusiness({ id: pv.id, year: 2025 });
    expect(d.pv).toMatchObject({ capacity_kwp: "9.800", capacity_source: "business", status: { exempt: true, source: "rule" } });
    expect(d.pv!.status.reason).toContain("§ 3 Nr. 72 EStG");
    // No meter access in this test: the feed-in stays unknown, never an error.
    expect(d.pv!.feed_in).toBeNull();

    const before = await getBusiness({ id: pv.id, year: 2021 });
    expect(before.pv!.status.exempt).toBe(false);

    const euer = await getBusinessEuer({ id: pv.id, year: 2025 });
    expect(euer.tax_exempt).toMatchObject({ exempt: true });
    expect(euer.hints[0]).toContain("Steuerfrei");

    const overridden = await updateBusiness({ id: pv.id, pv_tax_override: "taxable" });
    expect(overridden.pv_tax_override).toBe("taxable");
    expect((await getBusiness({ id: pv.id, year: 2025 })).pv!.status).toMatchObject({ exempt: false, source: "override" });

    await updateBusiness({ id: pv.id, pv_tax_override: null, pv_capacity_kwp: null });
    expect((await getBusiness({ id: pv.id, year: 2025 })).pv!.status).toMatchObject({ exempt: null, source: "unknown" });

    await expect(updateBusiness({ id: pv.id, pv_capacity_kwp: -1 })).rejects.toThrow(/kWp/);
    await expect(updateBusiness({ id: pv.id, pv_tax_override: "maybe" as never })).rejects.toThrow(/exempt, taxable/);

    const farm = await createBusiness({ name: "Hof", kind: "landwirtschaft" });
    expect((await getBusiness({ id: farm.id })).pv).toBeNull();
  });
});
