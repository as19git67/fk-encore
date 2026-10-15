/**
 * Meter read tools. The meter service checks `meters.view` and owner/group
 * access per meter.
 */

import { call } from "../clients";
import { digestOf, int, isoDate, str, table } from "../format";
import type { ToolSpec } from "../types";

const METERS = ["module.meters", "meters.view"];

interface MeterItem { id: number; name: string; type: string; unit: string; location?: string | null; lastReadingValue: number | null; lastReadingAt: string | null }
interface Reading { id: number; value: number; takenAt: string; source: string }
interface Bucket { label: string; periodStart: string; periodEnd: string; consumption: number; coverage: number }
interface Report { meterId: number; name: string; unit: string; from: string | null; to: string | null; buckets: Bucket[]; totalConsumption: number }

export const listMeters: ToolSpec = {
  name: "list_meters",
  kind: "read",
  summary: "Utility meters (electricity, water, gas, heat) with id, unit and the latest reading.",
  permissions: METERS,
  source: "hand",
  parameters: { type: "object", properties: {} },
  async run() {
    const res = await call<{ meters: MeterItem[] }>("meter", "listMeters", {});
    const rows = res.meters;
    return {
      text: table(
        ["id", "name", "type", "unit", "location", "last_value", "last_read"],
        rows.map((m) => [m.id, m.name, m.type, m.unit, m.location, m.lastReadingValue, m.lastReadingAt?.slice(0, 10)]),
        { cap: 40 },
      ),
      digest: digestOf("list_meters", rows.length, rows.map((m) => m.id)),
      rowCount: rows.length,
      block: {
        kind: "meters",
        tool: "list_meters",
        rows: rows.map((m) => ({ id: m.id, name: m.name, unit: m.unit, last_value: m.lastReadingValue, last_read: m.lastReadingAt, route: `/zaehler/${m.id}` })),
        route: "/zaehler",
      },
    };
  },
};

export const latestReadings: ToolSpec = {
  name: "latest_readings",
  kind: "read",
  summary: "The most recent readings of one meter, newest first.",
  permissions: METERS,
  source: "hand",
  parameters: {
    type: "object",
    properties: {
      meter_id: { type: "integer", description: "id from list_meters" },
      limit: { type: "integer", description: "at most 20 (default 5)" },
    },
    required: ["meter_id"],
  },
  async run(args) {
    const id = int(args.meter_id);
    if (id === undefined) throw new Error("meter_id is required");
    const limit = int(args.limit, { min: 1, max: 20 }) ?? 5;
    const res = await call<{ readings: Reading[]; total: number }>("meter", "listReadings", { id, limit });
    return {
      text: table(["id", "taken", "value", "source"], res.readings.map((r) => [r.id, r.takenAt.slice(0, 10), r.value, r.source]), { total: res.total, cap: limit }),
      digest: digestOf("latest_readings", res.readings.length, res.readings.map((r) => r.id)),
      rowCount: res.readings.length,
      block: {
        kind: "readings",
        tool: "latest_readings",
        total: res.total,
        rows: res.readings.map((r) => ({ id: r.id, taken_at: r.takenAt, value: r.value })),
        route: `/zaehler/${id}`,
      },
    };
  },
};

export const consumptionReport: ToolSpec = {
  name: "consumption_report",
  kind: "read",
  summary: "Consumption of one meter over a date range, per day, week, month or year, with the server-computed total.",
  permissions: METERS,
  source: "hand",
  parameters: {
    type: "object",
    properties: {
      meter_id: { type: "integer", description: "id from list_meters" },
      from: { type: "string", description: "YYYY-MM-DD" },
      to: { type: "string", description: "YYYY-MM-DD" },
      granularity: { type: "string", enum: ["day", "week", "month", "year"], description: "default month" },
    },
    required: ["meter_id", "from", "to"],
  },
  async run(args) {
    const id = int(args.meter_id);
    if (id === undefined) throw new Error("meter_id is required");
    const granularity = str(args.granularity) ?? "month";
    const res = await call<Report>("meter", "getMeterReport", { id, granularity, from: isoDate(args.from), to: isoDate(args.to) });
    return {
      text: table(
        ["period", "consumption", "coverage"],
        res.buckets.map((b) => [b.label, b.consumption, `${Math.round(b.coverage * 100)}%`]),
        { cap: 24, note: `${res.name}: total ${res.totalConsumption} ${res.unit} from ${res.from ?? "…"} to ${res.to ?? "…"}. Coverage below 100% means the value is partly interpolated.` },
      ),
      digest: `[earlier result of consumption_report: meter ${res.meterId}, total ${res.totalConsumption} ${res.unit}]`,
      rowCount: res.buckets.length,
      block: {
        kind: "consumption",
        tool: "consumption_report",
        rows: res.buckets.map((b) => ({ period: b.label, consumption: b.consumption, coverage: b.coverage })),
        route: `/zaehler/${id}`,
      },
    };
  },
};

export const METER_TOOLS = [listMeters, latestReadings, consumptionReport];
