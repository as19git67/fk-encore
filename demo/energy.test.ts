/**
 * The meters and PV system of the demo household: the same seed gives the
 * same plan, every counter only rises, a PV system makes more in summer
 * than in winter, and the feed-in payments are the exported kWh times the
 * tariff, so the EÜR and the energy report agree.
 */
import { describe, expect, it } from "vitest";
import { planHousehold } from "./household";
import { FEED_IN_EUR_PER_KWH, PV_BOOKING_TAG, planEnergy } from "./energy";
import { pvTaxStatus } from "../finance/pv";

const full = planHousehold(20261026, "full", "2026-10-26");
const small = planHousehold(20261026, "small", "2026-10-26");

describe("planEnergy", () => {
  it("is the same for the same seed and reads every meter on the same days", () => {
    const a = planEnergy(7, "full", full);
    expect(planEnergy(7, "full", full)).toEqual(a);
    expect(planEnergy(8, "full", full)).not.toEqual(a);
    const days = a.meters[0].readings.map((r) => r.takenAt);
    // The first of each month of the span, and today.
    expect(days).toHaveLength(37);
    expect(days[0].slice(0, 10)).toBe(full.from);
    expect(days.at(-1)!.slice(0, 10)).toBe("2026-10-26");
    for (const m of a.meters) {
      expect(m.readings.map((r) => r.takenAt)).toEqual(days);
      expect(m.readings[0].value).toBe(m.startValue);
      for (let i = 1; i < m.readings.length; i++) expect(m.readings[i].value).toBeGreaterThanOrEqual(m.readings[i - 1].value);
    }
    expect(planEnergy(7, "small", small).meters[0].readings).toHaveLength(4);
  });

  it("makes more PV in June than in December and exports less than it makes", () => {
    const { meters } = planEnergy(7, "full", full);
    const delta = (key: string, month: string) => {
      const r = meters.find((m) => m.key === key)!.readings;
      const i = r.findIndex((x) => x.takenAt.startsWith(month));
      return r[i + 1].value - r[i].value;
    };
    expect(delta("pv_production", "2025-06")).toBeGreaterThan(4 * delta("pv_production", "2025-12"));
    expect(delta("grid_export", "2025-06")).toBeLessThan(delta("pv_production", "2025-06"));
    expect(delta("gas", "2025-01")).toBeGreaterThan(5 * delta("gas", "2025-07"));
  });

  it("pays each month's feed-in at the tariff and tags every booking for the PV business", () => {
    const { meters, bookings, tariffs, pv } = planEnergy(7, "full", full);
    const feedIn = bookings.filter((b) => b.kind === "pv_feed_in");
    // One per full month of the span whose payment day has come.
    expect(feedIn).toHaveLength(35);
    const exported = meters.find((m) => m.key === "grid_export")!.readings;
    const june = exported.findIndex((r) => r.takenAt.startsWith("2025-06"));
    const kwh = exported[june + 1].value - exported[june].value;
    const paid = feedIn.find((b) => b.date === "2025-07-15")!;
    // Readings are rounded to 0.1 kWh, the payment to the cent of the exact figure.
    expect(Math.abs(paid.cents - kwh * FEED_IN_EUR_PER_KWH * 100)).toBeLessThan(2);
    expect(bookings.every((b) => b.tags?.includes(PV_BOOKING_TAG) && b.account === "giro_self")).toBe(true);
    expect(bookings.filter((b) => b.cents < 0).map((b) => b.kind).sort()).toEqual(
      ["pv_insurance", "pv_insurance", "pv_insurance", "pv_meter_fee", "pv_meter_fee", "pv_meter_fee", "pv_service"].sort(),
    );
    expect(tariffs.find((t) => t.kind === "feed_in")).toMatchObject({ amount: FEED_IN_EUR_PER_KWH, validFrom: pv.commissionedOn });
  });

  it("puts up a system that falls under § 3 Nr. 72 EStG in the span", () => {
    const { pv } = planEnergy(7, "full", full);
    expect(pv.commissionedOn < full.from).toBe(true);
    expect(pvTaxStatus({ capacityKwp: pv.capacityKwp, year: 2025, override: null }).exempt).toBe(true);
  });
});
