import { and, asc, eq } from "drizzle-orm";
import { APIError } from "encore.dev/api";
import db from "../db/database";
import { dbAll, dbExec, dbFirst, dbInsertReturning } from "../db/adapter";
import {
  meterElectricityTariffs,
  type MeterElectricityTariffKind,
} from "../db/schema";
import {
  electricityPriceData,
  type ElectricityPriceImportEntry,
} from "./import/electricity-price-data";

export type ElectricityTariffKind = MeterElectricityTariffKind;
export type ElectricityTariffUnit =
  | "eur_per_kwh"
  | "eur_per_month"
  | "eur"
  | "ratio"
  | "kwh_per_100km"
  | "l_per_100km"
  | "eur_per_l"
  | "kg_per_kwh"
  | "kg_per_l"
  | "kw"
  | "eur_per_m3";

export interface ElectricityTariff {
  id: number;
  kind: ElectricityTariffKind;
  validFrom: string;
  amount: number;
  unit: ElectricityTariffUnit;
  taxStatus: string | null;
  name: string | null;
  capacityLimitKw: number | null;
  source: Record<string, unknown> | null;
}

export interface UpsertElectricityTariffInput {
  kind: ElectricityTariffKind;
  validFrom: string;
  amount: number;
  unit: ElectricityTariffUnit;
  taxStatus?: string | null;
  name?: string | null;
  capacityLimitKw?: number | null;
  source?: Record<string, unknown> | null;
}

export interface ElectricityPriceImportResult {
  created: number;
  updated: number;
  total: number;
  alreadyImported: boolean;
}

export interface EnergyTariffCostInput {
  periodStart: string;
  periodEnd: string;
  gridImport: number | null;
  gridExport: number | null;
  selfConsumption: number | null;
  totalConsumption: number | null;
}

export interface EnergyPeriodPrices {
  gridImportPricePerKwh: number | null;
  feedInPricePerKwh: number | null;
  selfConsumptionPricePerKwh: number | null;
  baseCostEur: number | null;
}

export interface EnergyTariffCostResult {
  gridImportCostEur: number | null;
  baseCostEur: number | null;
  feedInRevenueEur: number | null;
  avoidedGridCostEur: number | null;
  pvBenefitEur: number | null;
  netElectricityCostEur: number | null;
  noPvElectricityCostEur: number | null;
}

const TARIFF_KINDS: ElectricityTariffKind[] = [
  "grid_import",
  "base_price",
  "feed_in",
  "self_consumption_value",
  "pv_investment_net",
  "pv_investment_vat",
  "expected_return_rate",
  "gas_price",
  "gas_base_price",
  "boiler_efficiency",
  "heat_pump_scop",
  "ev_consumption",
  "petrol_consumption",
  "petrol_price",
  "grid_co2",
  "gas_co2",
  "petrol_co2",
  "pv_capacity_kwp",
  "water_price",
  "water_base_price",
  "sewage_price",
];

const TARIFF_UNITS: ElectricityTariffUnit[] = [
  "eur_per_kwh",
  "eur_per_month",
  "eur",
  "ratio",
  "kwh_per_100km",
  "l_per_100km",
  "eur_per_l",
  "kg_per_kwh",
  "kg_per_l",
  "kw",
  "eur_per_m3",
];

function parseValidFrom(value: string): string {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00.000Z`) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw APIError.invalidArgument("validFrom is not a valid date");
  }
  return date.toISOString();
}

function assertTariff(input: UpsertElectricityTariffInput) {
  if (!TARIFF_KINDS.includes(input.kind)) {
    throw APIError.invalidArgument("unknown tariff kind");
  }
  if (!TARIFF_UNITS.includes(input.unit)) {
    throw APIError.invalidArgument("unknown tariff unit");
  }
  if (!Number.isFinite(input.amount) || input.amount < 0) {
    throw APIError.invalidArgument("amount must be a non-negative number");
  }
}

function mapTariff(row: typeof meterElectricityTariffs.$inferSelect): ElectricityTariff {
  return {
    id: row.id,
    kind: row.kind,
    validFrom: row.valid_from,
    amount: Number(row.amount),
    unit: row.unit as ElectricityTariffUnit,
    taxStatus: row.tax_status,
    name: row.name,
    capacityLimitKw: row.capacity_limit_kw === null ? null : Number(row.capacity_limit_kw),
    source: (row.source as Record<string, unknown> | null) ?? null,
  };
}

export async function listElectricityTariffs(userId: number): Promise<ElectricityTariff[]> {
  const rows = await dbAll<typeof meterElectricityTariffs.$inferSelect>(
    db
      .select()
      .from(meterElectricityTariffs)
      .where(eq(meterElectricityTariffs.owner_user_id, userId))
      .orderBy(
        asc(meterElectricityTariffs.kind),
        asc(meterElectricityTariffs.valid_from),
        asc(meterElectricityTariffs.capacity_limit_kw),
        asc(meterElectricityTariffs.id),
      ),
  );
  return rows.map(mapTariff);
}

/**
 * Matches meter_electricity_tariffs_unique_idx: same kind, validity date,
 * unit and name (blank name folded together) already exists for this owner.
 * The frontend has the localized kind labels and turns this into a proper
 * message; this fallback text only matters for callers without that map.
 */
function duplicateTariffError(input: UpsertElectricityTariffInput): never {
  throw APIError.alreadyExists(
    `a ${input.kind} entry already exists for ${input.validFrom} (${input.unit}` +
      `${input.name ? `, ${input.name}` : ""})`,
  );
}

export async function createElectricityTariff(
  userId: number,
  input: UpsertElectricityTariffInput,
): Promise<ElectricityTariff> {
  assertTariff(input);
  try {
    const row = await dbInsertReturning<typeof meterElectricityTariffs.$inferSelect>(
      db
        .insert(meterElectricityTariffs)
        .values({
          owner_user_id: userId,
          kind: input.kind,
          valid_from: parseValidFrom(input.validFrom),
          amount: String(input.amount),
          unit: input.unit,
          tax_status: input.taxStatus ?? null,
          name: input.name?.trim() || null,
          capacity_limit_kw:
            input.capacityLimitKw === undefined || input.capacityLimitKw === null
              ? null
              : String(input.capacityLimitKw),
          source: input.source ?? null,
        })
        .returning(),
    );
    if (!row) throw APIError.internal("tariff was not created");
    return mapTariff(row);
  } catch (err: any) {
    // The native driver surfaces the SQLSTATE on `code`; drizzle wraps it and
    // exposes it on `cause.code`.
    if ((err?.code ?? err?.cause?.code) === "23505") duplicateTariffError(input);
    throw err;
  }
}

export async function updateElectricityTariff(
  userId: number,
  id: number,
  input: UpsertElectricityTariffInput,
): Promise<ElectricityTariff> {
  assertTariff(input);
  const existing = await dbFirst<typeof meterElectricityTariffs.$inferSelect>(
    db
      .select()
      .from(meterElectricityTariffs)
      .where(and(eq(meterElectricityTariffs.id, id), eq(meterElectricityTariffs.owner_user_id, userId))),
  );
  if (!existing) throw APIError.notFound("tariff not found");

  try {
    const row = await dbInsertReturning<typeof meterElectricityTariffs.$inferSelect>(
      db
        .update(meterElectricityTariffs)
        .set({
          kind: input.kind,
          valid_from: parseValidFrom(input.validFrom),
          amount: String(input.amount),
          unit: input.unit,
          tax_status: input.taxStatus ?? null,
          name: input.name?.trim() || null,
          capacity_limit_kw:
            input.capacityLimitKw === undefined || input.capacityLimitKw === null
              ? null
              : String(input.capacityLimitKw),
          source: input.source ?? existing.source ?? null,
          updated_at: new Date().toISOString(),
        })
        .where(eq(meterElectricityTariffs.id, id))
        .returning(),
    );
    if (!row) throw APIError.internal("tariff was not updated");
    return mapTariff(row);
  } catch (err: any) {
    if ((err?.code ?? err?.cause?.code) === "23505") duplicateTariffError(input);
    throw err;
  }
}

export async function deleteElectricityTariff(userId: number, id: number): Promise<void> {
  const result = await dbExec(
    db
      .delete(meterElectricityTariffs)
      .where(and(eq(meterElectricityTariffs.id, id), eq(meterElectricityTariffs.owner_user_id, userId))),
  );
  if (result.changes === 0) throw APIError.notFound("tariff not found");
}

async function findExistingImportEntry(userId: number, entry: ElectricityPriceImportEntry) {
  const validFrom = parseValidFrom(entry.validFrom);
  const rows = await dbAll<typeof meterElectricityTariffs.$inferSelect>(
    db
      .select()
      .from(meterElectricityTariffs)
      .where(
        and(
          eq(meterElectricityTariffs.owner_user_id, userId),
          eq(meterElectricityTariffs.kind, entry.kind),
          eq(meterElectricityTariffs.valid_from, validFrom),
          eq(meterElectricityTariffs.unit, entry.unit),
        ),
      ),
  );
  const name = entry.name ?? null;
  return rows.find((row) => (row.name ?? null) === name);
}

export async function importElectricityPrices(userId: number): Promise<ElectricityPriceImportResult> {
  let created = 0;
  let updated = 0;
  for (const entry of electricityPriceData) {
    const existing = await findExistingImportEntry(userId, entry);
    const input: UpsertElectricityTariffInput = {
      kind: entry.kind,
      validFrom: entry.validFrom,
      amount: entry.amount,
      unit: entry.unit,
      taxStatus: entry.taxStatus ?? null,
      name: entry.name ?? null,
      capacityLimitKw: entry.capacityLimitKw ?? null,
      source: entry.source ?? null,
    };
    if (existing) {
      await updateElectricityTariff(userId, existing.id, input);
      updated += 1;
    } else {
      await createElectricityTariff(userId, input);
      created += 1;
    }
  }
  return {
    created,
    updated,
    total: electricityPriceData.length,
    alreadyImported: created === 0,
  };
}

function startOfUtcDay(iso: string): Date {
  const date = new Date(iso);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function daysBetween(start: Date, end: Date): number {
  return Math.max(0, (end.getTime() - start.getTime()) / 86_400_000);
}

function addMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
}

function roundMoney(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

export class EnergyTariffTimeline {
  private byKind: Map<ElectricityTariffKind, ElectricityTariff[]>;

  constructor(tariffs: ElectricityTariff[]) {
    this.byKind = new Map();
    for (const tariff of tariffs) {
      const list = this.byKind.get(tariff.kind) ?? [];
      list.push(tariff);
      this.byKind.set(tariff.kind, list);
    }
    for (const list of this.byKind.values()) {
      list.sort((a, b) => a.validFrom.localeCompare(b.validFrom));
    }
  }

  hasCostTariffs(): boolean {
    return (this.byKind.get("grid_import")?.length ?? 0) > 0;
  }

  private entries(kind: ElectricityTariffKind): ElectricityTariff[] {
    return this.byKind.get(kind) ?? [];
  }

  private entryAt(kind: ElectricityTariffKind, at: Date): ElectricityTariff | null {
    const candidates = this.entries(kind).filter((entry) => new Date(entry.validFrom) <= at);
    if (candidates.length === 0) return null;
    if (kind === "feed_in") {
      return [...candidates].sort((a, b) => (a.capacityLimitKw ?? Infinity) - (b.capacityLimitKw ?? Infinity))[0];
    }
    return candidates[candidates.length - 1];
  }

  private weightedKwhPrice(kind: ElectricityTariffKind, start: Date, end: Date): number | null {
    const totalDays = daysBetween(start, end);
    if (totalDays <= 0) return null;
    let cursor = start;
    let weighted = 0;
    while (cursor < end) {
      const current = this.entryAt(kind, cursor);
      if (!current) return null;
      const nextChange = this.entries(kind)
        .map((entry) => new Date(entry.validFrom))
        .filter((date) => date > cursor && date < end)
        .sort((a, b) => a.getTime() - b.getTime())[0] ?? end;
      const segmentDays = daysBetween(cursor, nextChange);
      weighted += Number(current.amount) * segmentDays;
      cursor = nextChange;
    }
    return weighted / totalDays;
  }

  private baseCost(start: Date, end: Date, kind: ElectricityTariffKind = "base_price"): number | null {
    if (this.entries(kind).length === 0) return null;
    let cursor = start;
    let cost = 0;
    while (cursor < end) {
      const monthEnd = addMonth(cursor);
      const segmentEnd = monthEnd < end ? monthEnd : end;
      const tariff = this.entryAt(kind, cursor);
      if (!tariff) return null;
      const fullMonthDays = daysBetween(
        new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), 1)),
        monthEnd,
      );
      cost += Number(tariff.amount) * (daysBetween(cursor, segmentEnd) / fullMonthDays);
      cursor = segmentEnd;
    }
    return cost;
  }

  /**
   * The prices in force over a period, time-weighted across price changes.
   * Callers that value individual consumption shares (heating, hot water,
   * wallbox) need the same prices the bucket costs are built from.
   */
  pricesForPeriod(periodStart: string, periodEnd: string): EnergyPeriodPrices {
    const start = startOfUtcDay(periodStart);
    const end = startOfUtcDay(periodEnd);
    const gridImportPricePerKwh = this.weightedKwhPrice("grid_import", start, end);
    return {
      gridImportPricePerKwh,
      feedInPricePerKwh: this.weightedKwhPrice("feed_in", start, end),
      // Falls back to the grid price: a kWh used instead of bought is worth at
      // least what buying it would have cost.
      selfConsumptionPricePerKwh:
        this.weightedKwhPrice("self_consumption_value", start, end) ?? gridImportPricePerKwh,
      baseCostEur: this.baseCost(start, end),
    };
  }

  /**
   * The value of any dated entry over a period, time-weighted across changes.
   * Used for assumptions that move over time — gas and petrol prices — the
   * same way the electricity work price does.
   */
  weightedAmountForPeriod(
    kind: ElectricityTariffKind,
    periodStart: string,
    periodEnd: string,
  ): number | null {
    return this.weightedKwhPrice(kind, startOfUtcDay(periodStart), startOfUtcDay(periodEnd));
  }

  /**
   * Standing charge for a period, prorated across month boundaries, for any
   * per-month entry (electricity or gas).
   */
  monthlyChargeForPeriod(
    kind: ElectricityTariffKind,
    periodStart: string,
    periodEnd: string,
  ): number | null {
    return this.baseCost(startOfUtcDay(periodStart), startOfUtcDay(periodEnd), kind);
  }

  /** Latest value of a single-figure tariff entry such as the PV investment. */
  amountOf(kind: ElectricityTariffKind): number | null {
    const entries = this.entries(kind);
    if (entries.length === 0) return null;
    return Number(entries[entries.length - 1].amount);
  }

  costsForBucket(input: EnergyTariffCostInput): EnergyTariffCostResult {
    const start = startOfUtcDay(input.periodStart);
    const end = startOfUtcDay(input.periodEnd);
    const importPrice = this.weightedKwhPrice("grid_import", start, end);
    const feedInPrice = this.weightedKwhPrice("feed_in", start, end);
    const selfConsumptionPrice =
      this.weightedKwhPrice("self_consumption_value", start, end) ?? importPrice;
    const baseCost = this.baseCost(start, end);

    const gridImportCostEur =
      input.gridImport !== null && importPrice !== null ? input.gridImport * importPrice : null;
    const baseCostEur = baseCost;
    const feedInRevenueEur =
      input.gridExport !== null && feedInPrice !== null ? input.gridExport * feedInPrice : null;
    const avoidedGridCostEur =
      input.selfConsumption !== null && selfConsumptionPrice !== null
        ? input.selfConsumption * selfConsumptionPrice
        : null;
    const pvBenefitEur =
      avoidedGridCostEur !== null && feedInRevenueEur !== null
        ? avoidedGridCostEur + feedInRevenueEur
        : null;
    const netElectricityCostEur =
      gridImportCostEur !== null && baseCostEur !== null
        ? gridImportCostEur + baseCostEur - (feedInRevenueEur ?? 0)
        : null;
    const noPvElectricityCostEur =
      input.totalConsumption !== null && importPrice !== null && baseCostEur !== null
        ? input.totalConsumption * importPrice + baseCostEur
        : null;

    return {
      gridImportCostEur: roundMoney(gridImportCostEur),
      baseCostEur: roundMoney(baseCostEur),
      feedInRevenueEur: roundMoney(feedInRevenueEur),
      avoidedGridCostEur: roundMoney(avoidedGridCostEur),
      pvBenefitEur: roundMoney(pvBenefitEur),
      netElectricityCostEur: roundMoney(netElectricityCostEur),
      noPvElectricityCostEur: roundMoney(noPvElectricityCostEur),
    };
  }
}

export async function loadEnergyTariffTimeline(userId: number): Promise<EnergyTariffTimeline> {
  return new EnergyTariffTimeline(await listElectricityTariffs(userId));
}
