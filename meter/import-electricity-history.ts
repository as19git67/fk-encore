/**
 * One-off importer for the historical electricity & operating-hour meters
 * (Issue #792).
 *
 * The source is a combined JSON extracted from several Excel workbooks and
 * LEW invoices, pre-transformed into `import/electricity-history-data.ts`.
 * It contains historical logical meters (13 electricity + 4 operating-hours)
 * with ~2 000 readings spanning 2006–2026. The import deliberately condenses
 * old parallel meters that only existed before the PV-era into the modern
 * reporting meters:
 *
 *   Hausstrom + Wärmepumpe HT + Wärmepumpe NT → Netzstrom Bezug (1.8.0)
 *   Wärmepumpe HT + Wärmepumpe NT             → Wärmepumpe Komplett
 *
 * The original Excel files remain the audit trail; fk-encore stores the
 * report-friendly view that should be queried going forward.
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

const SENTINEL_NAME = "Netzstrom Bezug (1.8.0)";

const GRID_IMPORT_KEY = "netzstrom_bezug";
const GRID_IMPORT_LEGACY_KEYS = ["hausstrom", "waermepumpe_ht", "waermepumpe_nt"] as const;
const GRID_IMPORT_LEGACY_CUTOFF = "2021-05-01";

const HEAT_PUMP_TOTAL_KEY = "waermepumpe_komplett";
const HEAT_PUMP_LEGACY_KEYS = ["waermepumpe_ht", "waermepumpe_nt"] as const;
const HEAT_PUMP_LEGACY_CUTOFF = "2022-12-01";

const CONSOLIDATED_SOURCE_KEYS = new Set<string>([
  "hausstrom",
  "waermepumpe_ht",
  "waermepumpe_nt",
]);

const VIRTUAL_DEVICE_SWAPS: Record<
  string,
  { swapDate: string; sourceOffset: number; serialSuffix: string }
> = {
  netzstrom_bezug: {
    swapDate: "2024-12-01",
    sourceOffset: 22418,
    serialSuffix: "1.8.0-ab-2024-12",
  },
  netzstrom_lieferung: {
    swapDate: "2024-12-01",
    sourceOffset: 14919,
    serialSuffix: "2.8.0-ab-2024-12",
  },
};

function readingTs(date: string): string {
  return `${date}T12:00:00Z`;
}
function swapTs(date: string): string {
  return `${date}T00:00:00Z`;
}

function cloneDevice(device: ElecImportDevice): ElecImportDevice {
  return {
    ...device,
    readings: device.readings.map(([date, value]) => [date, value]),
  };
}

function normalizeReadingValue(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function cloneMeter(meter: ElecImportMeter): ElecImportMeter {
  return {
    ...meter,
    devices: meter.devices.map(cloneDevice),
  };
}

function firstReadingValue(device: ElecImportDevice): number | null {
  return device.readings[0]?.[1] ?? null;
}

function withDeviceStartingAtFirstReading(device: ElecImportDevice): ElecImportDevice {
  const first = firstReadingValue(device);
  return {
    ...cloneDevice(device),
    startValue: first ?? device.startValue,
  };
}

function absoluteReadingsByDate(meter: ElecImportMeter): Map<string, number> {
  const out = new Map<string, number>();
  let base = 0;

  for (const device of meter.devices) {
    for (const [date, value] of device.readings) {
      out.set(date, normalizeReadingValue(base + value - device.startValue, meter.decimals));
    }
    if (device.endValue !== null) {
      base = normalizeReadingValue(base + device.endValue - device.startValue, meter.decimals);
    }
  }

  return out;
}

function aggregateCommonAbsoluteReadings(
  data: ElecImportData,
  sourceKeys: readonly string[],
  cutoffDate: string,
  decimals: number,
): { readings: [string, number][]; finalValue: number; finalDate: string } {
  const sources = sourceKeys.map((key) => {
    const meter = data.find((m) => m.key === key);
    if (!meter) {
      throw APIError.invalidArgument(`missing import source meter "${key}"`);
    }
    return { key, readings: absoluteReadingsByDate(meter) };
  });

  const [first, ...rest] = sources;
  const dates = [...first.readings.keys()]
    .filter((date) => date < cutoffDate && rest.every((s) => s.readings.has(date)))
    .sort();

  if (dates.length === 0) {
    throw APIError.invalidArgument(`no common historical readings before ${cutoffDate}`);
  }
  if (!sources.every((s) => s.readings.has(cutoffDate))) {
    throw APIError.invalidArgument(`missing historical closing reading at ${cutoffDate}`);
  }

  const sumAt = (date: string) =>
    normalizeReadingValue(
      sources.reduce((sum, s) => sum + (s.readings.get(date) ?? 0), 0),
      decimals,
    );

  const readings = dates.map((date): [string, number] => [date, sumAt(date)]);
  return {
    readings,
    finalValue: sumAt(cutoffDate),
    finalDate: cutoffDate,
  };
}

export function consolidateHistoricalReportMeters(data: ElecImportData): ElecImportData {
  const gridImport = data.find((m) => m.key === GRID_IMPORT_KEY);
  const heatPumpTotal = data.find((m) => m.key === HEAT_PUMP_TOTAL_KEY);
  if (!gridImport || !heatPumpTotal) {
    throw APIError.invalidArgument("electricity import data is missing report target meters");
  }

  const gridLegacy = aggregateCommonAbsoluteReadings(
    data,
    GRID_IMPORT_LEGACY_KEYS,
    GRID_IMPORT_LEGACY_CUTOFF,
    gridImport.decimals,
  );
  const heatPumpLegacy = aggregateCommonAbsoluteReadings(
    data,
    HEAT_PUMP_LEGACY_KEYS,
    HEAT_PUMP_LEGACY_CUTOFF,
    heatPumpTotal.decimals,
  );

  return data
    .filter((meterDef) => !CONSOLIDATED_SOURCE_KEYS.has(meterDef.key))
    .map((meterDef): ElecImportMeter => {
      if (meterDef.key === GRID_IMPORT_KEY) {
        return {
          ...meterDef,
          devices: [
            {
              serial: "historisch-hausstrom-wp-ht-nt",
              startValue: 0,
              endValue: gridLegacy.finalValue,
              installedAt: gridLegacy.readings[0][0],
              removedAt: gridLegacy.finalDate,
              readings: gridLegacy.readings,
            },
            ...meterDef.devices.map(withDeviceStartingAtFirstReading),
          ],
        };
      }

      if (meterDef.key === HEAT_PUMP_TOTAL_KEY) {
        return {
          ...meterDef,
          devices: [
            {
              serial: "historisch-wp-ht-nt",
              startValue: 0,
              endValue: heatPumpLegacy.finalValue,
              installedAt: heatPumpLegacy.readings[0][0],
              removedAt: heatPumpLegacy.finalDate,
              readings: heatPumpLegacy.readings,
            },
            ...meterDef.devices.map(withDeviceStartingAtFirstReading),
          ],
        };
      }

      return cloneMeter(meterDef);
    });
}

export function applyHistoricalVirtualDeviceSwaps(data: ElecImportData): ElecImportData {
  return data.map((meterDef) => {
    const swap = VIRTUAL_DEVICE_SWAPS[meterDef.key];
    if (!swap) {
      return cloneMeter(meterDef);
    }

    const devices: ElecImportDevice[] = [];
    for (const device of meterDef.devices) {
      const before = device.readings.filter(([date]) => date < swap.swapDate);
      const after = device.readings
        .filter(([date]) => date >= swap.swapDate)
        .map(([date, value]): [string, number] => [
          date,
          normalizeReadingValue(value - swap.sourceOffset, meterDef.decimals),
        ]);

      if (before.length === 0 || after.length === 0) {
        devices.push(cloneDevice(device));
        continue;
      }

      const closingValue = before[before.length - 1][1];
      devices.push({
        ...device,
        endValue: closingValue,
        removedAt: swap.swapDate,
        readings: before.map(([date, value]) => [date, value]),
      });
      devices.push({
        serial: device.serial ? `${device.serial}-${swap.serialSuffix}` : swap.serialSuffix,
        startValue: 0,
        endValue: null,
        installedAt: swap.swapDate,
        removedAt: null,
        readings: after,
      });
    }

    return {
      ...meterDef,
      devices,
    };
  });
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

  const reportMeters = consolidateHistoricalReportMeters(data);

  for (const meterDef of applyHistoricalVirtualDeviceSwaps(reportMeters)) {
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
