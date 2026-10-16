/**
 * The business register (documentation/plans/betriebe-euer.md, stage 1):
 * a business with its assets and parcels, the year's AfA and totals, the
 * owner's and the admin's view. Data is synthetic.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { sql } from "drizzle-orm";

import db from "../db/database";
import { financeBusiness } from "../db/schema";
import {
  createAsset, createBusiness, createParcel, deleteBusiness, getAssetSchedule, getBusiness, listBusinesses, updateAsset, updateBusiness,
} from "./businesses";

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
