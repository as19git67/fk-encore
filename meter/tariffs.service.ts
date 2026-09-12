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
  | "eur_per_m3"
  // Kelvin-days (heating degree days).
  | "kd";

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

/**
 * One row of an uploaded tariff/assumption file. `kind` and `unit` stay plain
 * strings on purpose: typed as unions, a single typo would make the gateway
 * reject the whole file with an opaque message instead of naming the bad row.
 */
export interface TariffImportEntry {
  kind: string;
  validFrom: string;
  amount: number;
  unit: string;
  taxStatus?: string | null;
  name?: string | null;
  capacityLimitKw?: number | null;
  source?: Record<string, unknown> | null;
}

export interface TariffImportRowError {
  /** Zero-based position in the uploaded list. */
  index: number;
  message: string;
}

export interface TariffImportResult {
  created: number;
  updated: number;
  failed: number;
  /** Capped at MAX_REPORTED_ERRORS; `failed` carries the true count. */
  errors: TariffImportRowError[];
}

/** Guard against a wrong file turning into a very long import loop. */
const MAX_IMPORT_ENTRIES = 2000;
const MAX_REPORTED_ERRORS = 50;

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
  "heating_degree_days",
  "ev_charging_loss",
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
  "kd",
];

function parseValidFrom(value: string): string {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00.000Z`) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw APIError.invalidArgument("validFrom is not a valid date");
  }
  return date.toISOString();
}

/**
 * Plausible ranges per kind. A boiler efficiency typed as 90 instead of 0.9
 * or a petrol consumption of 0 l/100 km would not fail loudly anywhere
 * downstream — it would silently turn a comparison upside down.
 */
const AMOUNT_BOUNDS: Partial<Record<ElectricityTariffKind, { min: number; max: number; hint: string }>> = {
  boiler_efficiency: { min: 0.3, max: 1.2, hint: "a ratio such as 0.9" },
  heat_pump_scop: { min: 1, max: 8, hint: "a ratio such as 3.5" },
  ev_consumption: { min: 5, max: 60, hint: "kWh per 100 km" },
  petrol_consumption: { min: 2, max: 30, hint: "litres per 100 km" },
  ev_charging_loss: { min: 0, max: 0.5, hint: "a ratio such as 0.1" },
  expected_return_rate: { min: 0, max: 0.3, hint: "a ratio such as 0.05" },
  grid_co2: { min: 0, max: 2, hint: "kg per kWh" },
  gas_co2: { min: 0, max: 2, hint: "kg per kWh" },
  petrol_co2: { min: 0, max: 5, hint: "kg per litre" },
  heating_degree_days: { min: 0, max: 2000, hint: "Kelvin-days per month" },
};

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
  const bounds = AMOUNT_BOUNDS[input.kind];
  if (bounds && (input.amount < bounds.min || input.amount > bounds.max)) {
    throw APIError.invalidArgument(
      `${input.kind} must be between ${bounds.min} and ${bounds.max} (${bounds.hint})`,
    );
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

/** Natural key of an import row: the columns of the unique index. */
type TariffNaturalKey = {
  kind: string;
  validFrom: string;
  unit: string;
  name?: string | null;
};

async function findExistingImportEntry(userId: number, entry: TariffNaturalKey) {
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

/**
 * Imports a tariff/assumption file — the way historical series (petrol prices,
 * gas prices, …) get into the system without typing one dialog row per month.
 *
 * Idempotent by the same natural key the unique index uses: a row that is
 * already there is updated, not duplicated, so re-importing a corrected file
 * is safe. A bad row is reported with its position and does not stop the rest,
 * following the finance importer (`finance/data-import.ts`).
 */
export async function importTariffEntries(
  userId: number,
  entries: TariffImportEntry[],
): Promise<TariffImportResult> {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw APIError.invalidArgument("the file contains no entries");
  }
  if (entries.length > MAX_IMPORT_ENTRIES) {
    throw APIError.invalidArgument(
      `the file has ${entries.length} entries, at most ${MAX_IMPORT_ENTRIES} are imported at once`,
    );
  }

  const result: TariffImportResult = { created: 0, updated: 0, failed: 0, errors: [] };
  for (const [index, entry] of entries.entries()) {
    const input: UpsertElectricityTariffInput = {
      kind: entry.kind as ElectricityTariffKind,
      validFrom: entry.validFrom,
      amount: entry.amount,
      unit: entry.unit as ElectricityTariffUnit,
      taxStatus: entry.taxStatus ?? null,
      name: entry.name ?? null,
      capacityLimitKw: entry.capacityLimitKw ?? null,
      source: entry.source ?? null,
    };
    try {
      assertTariff(input);
      const existing = await findExistingImportEntry(userId, input);
      if (existing) {
        await updateElectricityTariff(userId, existing.id, input);
        result.updated += 1;
      } else {
        await createElectricityTariff(userId, input);
        result.created += 1;
      }
    } catch (err: any) {
      result.failed += 1;
      if (result.errors.length < MAX_REPORTED_ERRORS) {
        result.errors.push({ index, message: err?.message ?? "entry could not be imported" });
      }
    }
  }
  return result;
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

  /**
   * The entry in force at `at`: the one with the latest `validFrom` on or
   * before that instant.
   *
   * Feed-in tariffs come in *generations* (a price list dated the same day
   * with one row per capacity tier). The generation in force is the latest
   * dated one; within it the tier that applies to the system is the smallest
   * limit at or above the installed capacity (`pv_capacity_kwp` at that
   * time). Without a known capacity the lowest tier is used, without any
   * applicable tier the largest. Rows without a tier apply to any capacity.
   */
  private entryAt(kind: ElectricityTariffKind, at: Date): ElectricityTariff | null {
    const candidates = this.entries(kind).filter((entry) => new Date(entry.validFrom) <= at);
    if (candidates.length === 0) return null;
    if (kind !== "feed_in") return candidates[candidates.length - 1];

    const latestFrom = candidates[candidates.length - 1].validFrom;
    const generation = candidates.filter((entry) => entry.validFrom === latestFrom);
    const capacity = this.amountAt("pv_capacity_kwp", at);
    const applicable = generation.filter(
      (entry) =>
        entry.capacityLimitKw === null || capacity === null || entry.capacityLimitKw >= capacity,
    );
    const pool = applicable.length > 0 ? applicable : generation;
    return [...pool].sort(
      (a, b) => (a.capacityLimitKw ?? Infinity) - (b.capacityLimitKw ?? Infinity),
    )[0];
  }

  /** Change points of a kind strictly inside (after, before). */
  private changesBetween(kind: ElectricityTariffKind, after: Date, before: Date): Date[] {
    return this.entries(kind)
      .map((entry) => new Date(entry.validFrom))
      .filter((date) => date > after && date < before)
      .sort((a, b) => a.getTime() - b.getTime());
  }

  /**
   * Time-weighted price over [start, end). Days without any entry in force
   * (a tariff that starts mid-period) do not count towards the weighting;
   * only a period without a single priced day yields null. The result is
   * applied to the whole period's kWh — the assumption being that the price
   * in force for most of it is the best available estimate for the rest.
   */
  private weightedKwhPrice(kind: ElectricityTariffKind, start: Date, end: Date): number | null {
    if (daysBetween(start, end) <= 0) return null;
    let cursor = start;
    let weighted = 0;
    let pricedDays = 0;
    while (cursor < end) {
      const nextChange = this.changesBetween(kind, cursor, end)[0] ?? end;
      const current = this.entryAt(kind, cursor);
      if (current) {
        const segmentDays = daysBetween(cursor, nextChange);
        weighted += Number(current.amount) * segmentDays;
        pricedDays += segmentDays;
      }
      cursor = nextChange;
    }
    return pricedDays > 0 ? weighted / pricedDays : null;
  }

  /**
   * Standing charge over [start, end): each month prorated by days, and a
   * change of the charge inside a month split at the change date. Months
   * without an entry in force cost nothing; a period without a single
   * charged day yields null.
   */
  private baseCost(start: Date, end: Date, kind: ElectricityTariffKind = "base_price"): number | null {
    if (this.entries(kind).length === 0) return null;
    let cursor = start;
    let cost = 0;
    let charged = false;
    while (cursor < end) {
      const monthStart = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), 1));
      const monthEnd = addMonth(monthStart);
      const segmentEnd = monthEnd < end ? monthEnd : end;
      const fullMonthDays = daysBetween(monthStart, monthEnd);
      let sub = cursor;
      while (sub < segmentEnd) {
        const nextChange = this.changesBetween(kind, sub, segmentEnd)[0] ?? segmentEnd;
        const tariff = this.entryAt(kind, sub);
        if (tariff) {
          cost += Number(tariff.amount) * (daysBetween(sub, nextChange) / fullMonthDays);
          charged = true;
        }
        sub = nextChange;
      }
      cursor = segmentEnd;
    }
    return charged ? cost : null;
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

  /**
   * The value of a single-figure assumption in force at `at` (SCOP, boiler
   * efficiency, capacity, emission factors …). A value dated after `at`
   * does not apply — a future-dated change must not rewrite history — but
   * the earliest entry extends backwards, so one entry dated today still
   * covers the whole history the way a single assumption always did.
   */
  amountAt(kind: ElectricityTariffKind, at: Date | string): number | null {
    const entries = this.entries(kind);
    if (entries.length === 0) return null;
    const instant = typeof at === "string" ? new Date(at) : at;
    const inForce = entries.filter((entry) => new Date(entry.validFrom) <= instant);
    const chosen = inForce.length > 0 ? inForce[inForce.length - 1] : entries[0];
    return Number(chosen.amount);
  }

  /** The value in force now — the current assumption, never a future-dated one. */
  amountOf(kind: ElectricityTariffKind): number | null {
    return this.amountAt(kind, new Date());
  }

  /**
   * Every entry of a kind in force by `until` (default: now), for values that
   * accumulate rather than replace each other — an investment followed by an
   * extension is two rows and the system cost both.
   */
  sumUntil(kind: ElectricityTariffKind, until: Date = new Date()): number | null {
    const entries = this.entries(kind).filter((entry) => new Date(entry.validFrom) <= until);
    if (entries.length === 0) return null;
    return entries.reduce((sum, entry) => sum + Number(entry.amount), 0);
  }

  /** The entries a report actually drew on: every one in force somewhere in [start, end). */
  entriesForPeriod(kind: ElectricityTariffKind, start: Date | string, end: Date | string): ElectricityTariff[] {
    const from = typeof start === "string" ? new Date(start) : start;
    const to = typeof end === "string" ? new Date(end) : end;
    const entries = this.entries(kind);
    if (entries.length === 0) return [];
    const inForceAtStart = this.entryAt(kind, from) ?? entries[0];
    const later = entries.filter((entry) => {
      const date = new Date(entry.validFrom);
      return date > from && date < to;
    });
    const result = [inForceAtStart, ...later];
    return result.filter((entry, index) => result.findIndex((other) => other.id === entry.id) === index);
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
    // A missing standing charge is a charge of zero, not a reason to drop the
    // work-price part of the bill.
    const netElectricityCostEur =
      gridImportCostEur !== null
        ? gridImportCostEur + (baseCostEur ?? 0) - (feedInRevenueEur ?? 0)
        : null;
    const noPvElectricityCostEur =
      input.totalConsumption !== null && importPrice !== null
        ? input.totalConsumption * importPrice + (baseCostEur ?? 0)
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

/** Sum of per-bucket cost results; a figure is null only if it is null everywhere. */
export function sumCostResults(results: Array<EnergyTariffCostResult | null>): EnergyTariffCostResult | null {
  const present = results.filter((r): r is EnergyTariffCostResult => r !== null);
  if (present.length === 0) return null;
  const sum = (pick: (r: EnergyTariffCostResult) => number | null) => {
    const values = present.map(pick).filter((v): v is number => v !== null);
    return values.length === 0 ? null : roundMoney(values.reduce((a, b) => a + b, 0));
  };
  return {
    gridImportCostEur: sum((r) => r.gridImportCostEur),
    baseCostEur: sum((r) => r.baseCostEur),
    feedInRevenueEur: sum((r) => r.feedInRevenueEur),
    avoidedGridCostEur: sum((r) => r.avoidedGridCostEur),
    pvBenefitEur: sum((r) => r.pvBenefitEur),
    netElectricityCostEur: sum((r) => r.netElectricityCostEur),
    noPvElectricityCostEur: sum((r) => r.noPvElectricityCostEur),
  };
}

export async function loadEnergyTariffTimeline(userId: number): Promise<EnergyTariffTimeline> {
  return new EnergyTariffTimeline(await listElectricityTariffs(userId));
}
