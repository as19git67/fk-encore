/**
 * One-off importer for the historical electricity & operating-hour meters
 * (Issue #792).
 *
 * The source is a combined JSON extracted from several Excel workbooks and
 * LEW invoices, pre-transformed into `import/electricity-history-data.ts`.
 * It contains 17 logical meters (13 electricity + 4 operating-hours) with
 * 19 devices and ~2 000 readings spanning 2006–2026.
 *
 * Like the water import, this importer routes every row through the public
 * service functions (`createMeter` → `replaceDevice` → `addReading`), so
 * all monotonicity and device-swap invariants are enforced.
 *
 * Idempotent: a second run detects the primary meter ("Hausstrom") already
 * existing for this owner and returns it untouched.
 */

import { and, eq } from "drizzle-orm";
import { APIError } from "encore.dev/api";
import db from "../db/database";
import { dbFirst } from "../db/adapter";
import { meters } from "../db/schema";
import { createMeter, replaceDevice } from "./meter.service";
import { addReading } from "./readings.service";

// ── Types (shared with the generated data module) ───────────────────────────

export interface ElecImportDevice {
  serial: string | null;
  startValue: number;
  endValue: number | null;
  installedAt: string;
  removedAt: string | null;
  readings: [string, number][]; // [date, value]
}

export interface ElecImportMeter {
  key: string;
  name: string;
  type: "electricity" | "operating_hours";
  unit: string;
  location: string;
  decimals: number;
  devices: ElecImportDevice[];
}

export type ElecImportData = ElecImportMeter[];

export interface ElecImportResult {
  metersCreated: number;
  devicesCreated: number;
  readingsCreated: number;
  alreadyImported: boolean;
}

const SENTINEL_NAME = "Hausstrom";

function readingTs(date: string): string {
  return `${date}T12:00:00Z`;
}
function swapTs(date: string): string {
  return `${date}T00:00:00Z`;
}

export async function importElectricityHistory(
  userId: number,
  data: ElecImportData,
): Promise<ElecImportResult> {
  // Idempotency: bail out if the sentinel meter already exists.
  const existing = await dbFirst<{ id: number }>(
    db
      .select({ id: meters.id })
      .from(meters)
      .where(
        and(
          eq(meters.owner_user_id, userId),
          eq(meters.name, SENTINEL_NAME),
          eq(meters.type, "electricity"),
        ),
      ),
  );
  if (existing) {
    return { metersCreated: 0, devicesCreated: 0, readingsCreated: 0, alreadyImported: true };
  }

  if (!data.length) {
    throw APIError.invalidArgument("import data has no meters");
  }

  let metersCreated = 0;
  let devicesCreated = 0;
  let readingsCreated = 0;

  for (const meterDef of data) {
    if (!meterDef.devices.length) continue;

    const firstDev = meterDef.devices[0];

    const { id: meterId } = await createMeter(userId, {
      name: meterDef.name,
      type: meterDef.type,
      unit: meterDef.unit,
      location: meterDef.location,
      decimals: meterDef.decimals,
      notes: "Historischer Import aus Excel/PDF (Stromzähler).",
      device: {
        serialNumber: firstDev.serial ?? undefined,
        installedAt: swapTs(firstDev.installedAt),
        startValue: firstDev.startValue,
      },
    });
    metersCreated++;
    devicesCreated++;

    for (const [date, value] of firstDev.readings) {
      await addReading(userId, meterId, { value, takenAt: readingTs(date) });
      readingsCreated++;
    }

    // Subsequent devices → replaceDevice
    for (let i = 1; i < meterDef.devices.length; i++) {
      const prev = meterDef.devices[i - 1];
      const dev = meterDef.devices[i];

      if (prev.endValue === null) {
        throw APIError.invalidArgument(
          `device ${i - 1} of meter "${meterDef.name}" has no endValue but is followed by another device`,
        );
      }

      await replaceDevice(userId, meterId, {
        swapAt: swapTs(dev.installedAt),
        finalValue: prev.endValue,
        newSerialNumber: dev.serial ?? undefined,
        newStartValue: dev.startValue,
      });
      devicesCreated++;

      for (const [date, value] of dev.readings) {
        await addReading(userId, meterId, { value, takenAt: readingTs(date) });
        readingsCreated++;
      }
    }
  }

  return { metersCreated, devicesCreated, readingsCreated, alreadyImported: false };
}
