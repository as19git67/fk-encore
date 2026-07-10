/**
 * One-off importer for the historical water-meter spreadsheet (Issue #792).
 *
 * The source is a Dropbox Excel sheet ("Zählerstände Wasser") that was
 * pre-extracted to `import/wasserzaehler_wasser.json`. It contains 15+ years
 * of monthly water readings across four physical meters (three device swaps).
 *
 * The import is expressed purely through the public service functions
 * (`createMeter` → `replaceDevice` → `addReading`), so every row goes through
 * the same monotonicity and device-swap validation a manual entry would —
 * there is no direct table access. That keeps the imported data provably
 * consistent with the invariants the module enforces everywhere else.
 *
 * Model mapping: every physical meter starts its own count at 0, so each
 * device's `start_value` is 0 and the sheet's `cumulative_meter_reading_m3`
 * equals the module's absolute total (Σ device consumption). A swap closes
 * the outgoing device with the sheet's `previous_meter_final_reading_m3`
 * (which may sit slightly above the last recorded reading) and installs the
 * next device at 0.
 *
 * Idempotent: a second run detects the already-imported meter (same owner +
 * name) and returns it untouched instead of duplicating everything.
 */

import { asc, and, eq } from "drizzle-orm";
import { APIError } from "encore.dev/api";
import db from "../db/database";
import { dbFirst } from "../db/adapter";
import { meters } from "../db/schema";
import { createMeter, replaceDevice } from "./meter.service";
import { addReading } from "./readings.service";

export interface WaterImportReading {
  date: string; // YYYY-MM-DD
  meter_reading_m3: number;
  cumulative_meter_reading_m3: number;
  meter_index: number;
}

export interface WaterImportChangeEvent {
  date: string; // YYYY-MM-DD
  new_meter_index: number;
  previous_meter_final_reading_m3: number;
}

export interface WaterImportData {
  metadata?: { unit?: string };
  meter_change_events: WaterImportChangeEvent[];
  readings: WaterImportReading[];
}

export interface WaterImportResult {
  meterId: number;
  devices: number;
  readings: number;
  /** True when the meter already existed and nothing was written. */
  alreadyImported: boolean;
}

const DEFAULT_NAME = "Wasser";
const DEFAULT_LOCATION = "Haus";

// Readings land at local noon and swaps at midnight of the event day, so a
// same-day swap always precedes that day's first reading on the new device
// and the date never drifts across time zones on display.
function readingTs(date: string): string {
  return `${date}T12:00:00Z`;
}
function swapTs(date: string): string {
  return `${date}T00:00:00Z`;
}

export interface ImportOptions {
  name?: string;
  location?: string;
}

export async function importWaterMeterHistory(
  userId: number,
  data: WaterImportData,
  opts: ImportOptions = {},
): Promise<WaterImportResult> {
  const name = opts.name ?? DEFAULT_NAME;
  const location = opts.location ?? DEFAULT_LOCATION;
  const unit = data.metadata?.unit === "m3" ? "m³" : (data.metadata?.unit ?? "m³");

  // Idempotency: bail out if this meter was already imported for this owner.
  const existing = await dbFirst<{ id: number }>(
    db
      .select({ id: meters.id })
      .from(meters)
      .where(and(eq(meters.owner_user_id, userId), eq(meters.name, name), eq(meters.type, "water"))),
  );
  if (existing) {
    return { meterId: existing.id, devices: 0, readings: 0, alreadyImported: true };
  }

  if (!data.readings?.length) {
    throw APIError.invalidArgument("import data has no readings");
  }

  // Group readings by physical meter, each sorted chronologically.
  const byIndex = new Map<number, WaterImportReading[]>();
  for (const r of data.readings) {
    const list = byIndex.get(r.meter_index) ?? [];
    list.push(r);
    byIndex.set(r.meter_index, list);
  }
  const indices = [...byIndex.keys()].sort((a, b) => a - b);
  for (const idx of indices) {
    byIndex.get(idx)!.sort((a, b) => a.date.localeCompare(b.date));
  }

  const changeByIndex = new Map<number, WaterImportChangeEvent>();
  for (const e of data.meter_change_events) changeByIndex.set(e.new_meter_index, e);

  // ── First device: created together with the meter ──────────────────────────
  const firstIdx = indices[0];
  const firstReadings = byIndex.get(firstIdx)!;
  const { id: meterId } = await createMeter(userId, {
    name,
    type: "water",
    unit,
    location,
    decimals: 1,
    notes: "Historischer Import aus Excel (Zählerstände Wasser).",
    device: { installedAt: swapTs(firstReadings[0].date), startValue: 0 },
  });

  let readingCount = 0;
  for (const r of firstReadings) {
    await addReading(userId, meterId, { value: r.meter_reading_m3, takenAt: readingTs(r.date) });
    readingCount++;
  }

  // ── Subsequent devices: one swap per meter index ───────────────────────────
  for (let i = 1; i < indices.length; i++) {
    const idx = indices[i];
    const event = changeByIndex.get(idx);
    if (!event) {
      throw APIError.invalidArgument(`missing meter_change_event for meter index ${idx}`);
    }
    await replaceDevice(userId, meterId, {
      swapAt: swapTs(event.date),
      finalValue: event.previous_meter_final_reading_m3,
      newStartValue: 0,
    });
    for (const r of byIndex.get(idx)!) {
      await addReading(userId, meterId, { value: r.meter_reading_m3, takenAt: readingTs(r.date) });
      readingCount++;
    }
  }

  return { meterId, devices: indices.length, readings: readingCount, alreadyImported: false };
}
