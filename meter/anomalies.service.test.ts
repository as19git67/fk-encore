import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { meterAnomalies, meterDevices, meterReadings, meters, users } from "../db/schema";
import {
  detectMeterAnomalies,
  runMeterAnomalyDetection,
  type SeriesPoint,
} from "./anomalies.service";
import * as endpoints from "./anomalies";

const DAY = 86_400_000;
const NOW = new Date("2026-09-01T00:00:00.000Z");

/** Monthly readings ending at NOW: `months` intervals with the given consumption each. */
function monthlySeries(consumptions: number[], startValue = 0): SeriesPoint[] {
  const points: SeriesPoint[] = [];
  let value = startValue;
  const start = new Date(NOW.getTime() - consumptions.length * 30 * DAY);
  points.push({ readingId: 1, takenAt: start.toISOString(), value });
  consumptions.forEach((consumption, index) => {
    value += consumption;
    points.push({
      readingId: index + 2,
      takenAt: new Date(start.getTime() + (index + 1) * 30 * DAY).toISOString(),
      value,
    });
  });
  return points;
}

describe("detectMeterAnomalies", () => {
  it("is quiet on a steady series", () => {
    const series = monthlySeries([100, 102, 98, 101, 99, 100, 103, 97]);
    expect(detectMeterAnomalies(series, "water", NOW)).toEqual([]);
  });

  it("flags a consumption spike in the recent window", () => {
    const series = monthlySeries([100, 102, 98, 101, 99, 100, 103, 400]);
    const found = detectMeterAnomalies(series, "water", NOW);
    expect(found).toHaveLength(1);
    expect(found[0].type).toBe("consumption_spike");
    expect(found[0].readingId).toBe(9);
    expect(found[0].score).toBeGreaterThan(3);
    expect(found[0].details.baselineIntervals).toBe(7);
    expect(Number(found[0].details.rate)).toBeCloseTo(400 / 30, 2);
  });

  it("flags a drop to a fraction of the usual rate", () => {
    const series = monthlySeries([100, 102, 98, 101, 99, 100, 103, 20]);
    const found = detectMeterAnomalies(series, "water", NOW);
    expect(found.map((f) => f.type)).toEqual(["consumption_drop"]);
  });

  it("does not flag a seasonal rise that matches the same span a year earlier", () => {
    // 13 months: the first interval (a year ago) was already high.
    const series = monthlySeries([420, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 400]);
    expect(detectMeterAnomalies(series, "electricity", NOW)).toEqual([]);
  });

  it("does not judge old intervals — they only feed the baseline", () => {
    // The spike is ten intervals back, outside the recency window.
    const series = monthlySeries([100, 100, 100, 100, 400, 100, 100, 100, 100, 100, 100, 100, 100, 100]);
    expect(detectMeterAnomalies(series, "water", NOW)).toEqual([]);
  });

  it("needs a minimum baseline before it says anything", () => {
    const series = monthlySeries([100, 100, 100, 800]);
    expect(detectMeterAnomalies(series, "water", NOW)).toEqual([]);
  });

  it("flags a standstill of an operating-hours counter", () => {
    const series = monthlySeries([200, 210, 190, 205, 200, 0]);
    const found = detectMeterAnomalies(series, "operating_hours", NOW);
    expect(found.map((f) => f.type)).toEqual(["standstill"]);
    expect(found[0].details.days).toBe(30);
  });

  it("reports a zero interval on a consumption meter as a drop, not a standstill", () => {
    const series = monthlySeries([200, 210, 190, 205, 200, 0]);
    expect(detectMeterAnomalies(series, "water", NOW).map((f) => f.type)).toEqual([
      "consumption_drop",
    ]);
  });

  it("flags a backwards absolute total", () => {
    const series = monthlySeries([100, 100, 100, 100, 100, -50]);
    const found = detectMeterAnomalies(series, "water", NOW);
    expect(found.map((f) => f.type)).toEqual(["negative_consumption"]);
    expect(found[0].score).toBeNull();
    expect(found[0].details.consumption).toBe(-50);
  });

  it("ignores intervals shorter than half a day", () => {
    const series = monthlySeries([100, 100, 100, 100, 100]);
    const last = series[series.length - 1];
    series.push({
      readingId: 99,
      takenAt: new Date(new Date(last.takenAt).getTime() + 3_600_000).toISOString(),
      value: last.value + 500,
    });
    expect(detectMeterAnomalies(series, "water", NOW)).toEqual([]);
  });
});

// ── Job + endpoints against the database ────────────────────────────────────

function setAuth(userID: string, perms: string[]) {
  vi.mocked(getAuthData).mockReturnValue({ userID, permissions: perms });
}

async function createUser(label: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({
      email: `anomaly-${label}-${Date.now()}-${Math.random()}@example.com`,
      name: `Anomaly Tester ${label}`,
      password_hash: "x",
    })
    .returning({ id: users.id });
  return row.id;
}

async function createMeterWithSeries(
  ownerId: number,
  consumptions: number[],
  type: "water" | "operating_hours" = "water",
): Promise<{ meterId: number; readingIds: number[] }> {
  const [meter] = await db
    .insert(meters)
    .values({ name: `Test ${type}`, type, unit: type === "water" ? "m3" : "h", owner_user_id: ownerId })
    .returning({ id: meters.id });
  const [device] = await db
    .insert(meterDevices)
    .values({ meter_id: meter.id, installed_at: "2020-01-01T00:00:00Z", start_value: "0" })
    .returning({ id: meterDevices.id });
  const series = monthlySeries(consumptions);
  // The series ends at NOW (2026-09-01); the job runs with the real clock,
  // so shift everything to end "now" instead.
  const shift = Date.now() - NOW.getTime();
  const rows = await db
    .insert(meterReadings)
    .values(
      series.map((point) => ({
        device_id: device.id,
        value: point.value.toFixed(3),
        taken_at: new Date(new Date(point.takenAt).getTime() + shift).toISOString(),
        entered_by: ownerId,
      })),
    )
    .returning({ id: meterReadings.id });
  return { meterId: meter.id, readingIds: rows.map((r) => Number(r.id)) };
}

let userId: number;
const cleanupUserIds: number[] = [];

beforeEach(async () => {
  userId = await createUser("owner");
  cleanupUserIds.push(userId);
  setAuth(String(userId), ["meters.view", "meters.read_entry", "meters.manage"]);
});

afterEach(async () => {
  for (const id of cleanupUserIds.splice(0)) {
    await db.delete(users).where(eq(users.id, id));
  }
  vi.restoreAllMocks();
});

describe("runMeterAnomalyDetection", () => {
  it("persists findings once and withdraws them when the reading is corrected", async () => {
    const { meterId, readingIds } = await createMeterWithSeries(userId, [100, 102, 98, 101, 99, 100, 103, 400]);

    const first = await runMeterAnomalyDetection();
    expect(first.anomaliesCreated).toBeGreaterThanOrEqual(1);
    const rows = await db.select().from(meterAnomalies).where(eq(meterAnomalies.meter_id, meterId));
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("consumption_spike");
    expect(rows[0].status).toBe("pending");
    expect(Number(rows[0].reading_id)).toBe(readingIds[readingIds.length - 1]);

    // Re-run: idempotent.
    const second = await runMeterAnomalyDetection();
    const again = await db.select().from(meterAnomalies).where(eq(meterAnomalies.meter_id, meterId));
    expect(again).toHaveLength(1);
    expect(second.anomaliesWithdrawn).toBe(0);

    // Fix the typo (the last reading was one digit off) → the finding goes away.
    const lastId = readingIds[readingIds.length - 1];
    const [prev] = await db
      .select({ value: meterReadings.value })
      .from(meterReadings)
      .where(eq(meterReadings.id, readingIds[readingIds.length - 2]));
    await db
      .update(meterReadings)
      .set({ value: (parseFloat(prev.value) + 100).toFixed(3) })
      .where(eq(meterReadings.id, lastId));
    await runMeterAnomalyDetection();
    const after = await db.select().from(meterAnomalies).where(eq(meterAnomalies.meter_id, meterId));
    expect(after).toHaveLength(0);
  });

  it("keeps a confirmed finding even when the reading changes", async () => {
    const { meterId, readingIds } = await createMeterWithSeries(userId, [100, 102, 98, 101, 99, 100, 103, 400]);
    await runMeterAnomalyDetection();
    const [row] = await db.select().from(meterAnomalies).where(eq(meterAnomalies.meter_id, meterId));
    await endpoints.setMeterAnomalyStatus({ id: Number(row.id), status: "confirmed" });

    const lastId = readingIds[readingIds.length - 1];
    await db.update(meterReadings).set({ value: "803.000" }).where(eq(meterReadings.id, lastId));
    await runMeterAnomalyDetection();
    const after = await db.select().from(meterAnomalies).where(eq(meterAnomalies.meter_id, meterId));
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe("confirmed");
  });
});

describe("GET /meters/anomalies", () => {
  it("lists pending findings of visible meters with a German message", async () => {
    const { meterId } = await createMeterWithSeries(userId, [100, 102, 98, 101, 99, 100, 103, 400]);
    // Another household's meter must not show up.
    const otherId = await createUser("other");
    cleanupUserIds.push(otherId);
    await createMeterWithSeries(otherId, [100, 102, 98, 101, 99, 100, 103, 400]);
    await runMeterAnomalyDetection();

    const res = await endpoints.listMeterAnomalies({});
    expect(res.total).toBe(1);
    expect(res.anomalies[0].meterId).toBe(meterId);
    expect(res.anomalies[0].type).toBe("consumption_spike");
    expect(res.anomalies[0].message).toContain("Verbrauch");
    expect(res.anomalies[0].message).toContain("m3/Tag");
  });

  it("hides resolved findings unless status=all is requested", async () => {
    await createMeterWithSeries(userId, [100, 102, 98, 101, 99, 100, 103, 400]);
    await runMeterAnomalyDetection();
    const [item] = (await endpoints.listMeterAnomalies({})).anomalies;
    await endpoints.setMeterAnomalyStatus({ id: item.id, status: "dismissed" });

    expect((await endpoints.listMeterAnomalies({})).total).toBe(0);
    const all = await endpoints.listMeterAnomalies({ status: "all" });
    expect(all.total).toBe(1);
    expect(all.anomalies[0].status).toBe("dismissed");
    expect(all.anomalies[0].resolvedAt).not.toBeNull();
  });

  it("requires meters.view", async () => {
    setAuth(String(userId), []);
    await expect(endpoints.listMeterAnomalies({})).rejects.toMatchObject({ code: "permission_denied" });
  });
});

describe("POST /meters/anomalies/:id/status", () => {
  it("rejects a finding on a meter the caller cannot see", async () => {
    const otherId = await createUser("other");
    cleanupUserIds.push(otherId);
    const { meterId } = await createMeterWithSeries(otherId, [100, 102, 98, 101, 99, 100, 103, 400]);
    await runMeterAnomalyDetection();
    const [row] = await db.select().from(meterAnomalies).where(eq(meterAnomalies.meter_id, meterId));
    await expect(
      endpoints.setMeterAnomalyStatus({ id: Number(row.id), status: "dismissed" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("requires meters.read_entry", async () => {
    setAuth(String(userId), ["meters.view"]);
    await expect(
      endpoints.setMeterAnomalyStatus({ id: 1, status: "dismissed" }),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });
});

describe("POST /meters/anomalies/run", () => {
  it("requires meters.manage and returns the run summary", async () => {
    setAuth(String(userId), ["meters.view", "meters.read_entry"]);
    await expect(endpoints.triggerMeterAnomalyDetection({})).rejects.toMatchObject({
      code: "permission_denied",
    });
    setAuth(String(userId), ["meters.view", "meters.read_entry", "meters.manage"]);
    const res = await endpoints.triggerMeterAnomalyDetection({ reset: true });
    expect(res.meters).toBeGreaterThanOrEqual(0);
  });
});
