/**
 * Utility meters — advance payments vs. actual cost (Issue #792, report E3,
 * follow-up of Etappe 8 / #1018).
 *
 * Once payments are linked to readings, the question before the annual
 * settlement becomes answerable: what was paid in advance, what did the
 * measured consumption actually cost, and is a refund or a back payment
 * coming? Per metering point and calendar year:
 *
 *   paid      = Σ −amount of the linked transactions booked in that year
 *               (payments are negative bookings; a refund booked as a
 *               positive amount reduces the paid total)
 *   actual    = electricity: net electricity cost of the energy report
 *               (grid import + standing charge − feed-in revenue);
 *               water: water + sewage + standing charge from the economics
 *               report. Gas has no cost model yet → null.
 *   expected  = paid − actual  (positive: refund expected)
 *
 * Calendar years are an approximation of the supplier's billing year; the
 * report says so in the UI. The current year is marked partial.
 */

import { and, eq, inArray } from "drizzle-orm";
import db from "../db/database";
import { dbAll } from "../db/adapter";
import {
  financeTransaction,
  meterDevices,
  meterReadingTransactions,
  meterReadings,
  meters,
  type MeterType,
} from "../db/schema";
import { loadUserGroupIds, visibleMetersWhere } from "./meter.service";
import { getEnergyReportForUser } from "./reports.service";
import { getEconomicsReportForUser } from "./economics.service";
import { readableTransactionIds, type AuthContext } from "./reading-transactions.service";

export interface AdvancePaymentYear {
  year: number;
  /** Advance payments booked in that year, as a positive amount. */
  paidEur: number;
  transactions: number;
  /** Cost of the measured consumption; null without a cost model or tariffs. */
  actualCostEur: number | null;
  /** paid − actual; positive means a refund is to be expected. */
  expectedSettlementEur: number | null;
  /** True for the running year — both sides are still incomplete. */
  partial: boolean;
}

export interface AdvancePaymentMeter {
  meterId: number;
  name: string;
  type: MeterType;
  years: AdvancePaymentYear[];
}

export interface AdvancePaymentsReport {
  currency: "EUR";
  meters: AdvancePaymentMeter[];
}

export interface LinkedPayment {
  meterId: number;
  bookingDate: string;
  amount: number;
}

function roundEur(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Pure core: aggregate linked payments per meter/year and set them against the cost per year. */
export function buildAdvancePaymentsReport(
  meterRows: Array<{ id: number; name: string; type: MeterType }>,
  payments: LinkedPayment[],
  costByMeterYear: Map<number, Map<number, number | null>>,
  now: Date = new Date(),
): AdvancePaymentsReport {
  const currentYear = now.getUTCFullYear();
  const byMeter = new Map<number, Map<number, { paid: number; count: number }>>();
  for (const payment of payments) {
    const year = new Date(payment.bookingDate).getUTCFullYear();
    if (!Number.isFinite(year)) continue;
    const years = byMeter.get(payment.meterId) ?? new Map();
    const entry = years.get(year) ?? { paid: 0, count: 0 };
    entry.paid += -payment.amount;
    entry.count += 1;
    years.set(year, entry);
    byMeter.set(payment.meterId, years);
  }

  const result: AdvancePaymentMeter[] = [];
  for (const meter of meterRows) {
    const years = byMeter.get(meter.id);
    if (!years || years.size === 0) continue;
    const costs = costByMeterYear.get(meter.id) ?? new Map<number, number | null>();
    result.push({
      meterId: meter.id,
      name: meter.name,
      type: meter.type,
      years: [...years.entries()]
        .sort(([a], [b]) => a - b)
        .map(([year, entry]): AdvancePaymentYear => {
          const actual = costs.get(year) ?? null;
          const paid = roundEur(entry.paid);
          return {
            year,
            paidEur: paid,
            transactions: entry.count,
            actualCostEur: actual === null ? null : roundEur(actual),
            expectedSettlementEur: actual === null ? null : roundEur(paid - actual),
            partial: year >= currentYear,
          };
        }),
    });
  }
  return { currency: "EUR", meters: result };
}

export async function getAdvancePaymentsReportForUser(auth: AuthContext): Promise<AdvancePaymentsReport> {
  const groupIds = await loadUserGroupIds(auth.userId);
  const meterRows = await dbAll<{ id: number; name: string; type: MeterType }>(
    db
      .select({ id: meters.id, name: meters.name, type: meters.type })
      .from(meters)
      .where(visibleMetersWhere(auth.userId, groupIds))
      .orderBy(meters.name),
  );
  if (meterRows.length === 0) return { currency: "EUR", meters: [] };

  const linkRows = await dbAll<{
    meter_id: number;
    transaction_id: number;
    booking_date: string;
    amount: string;
  }>(
    db
      .select({
        meter_id: meterDevices.meter_id,
        transaction_id: meterReadingTransactions.transaction_id,
        booking_date: financeTransaction.booking_date,
        amount: financeTransaction.amount,
      })
      .from(meterReadingTransactions)
      .innerJoin(meterReadings, eq(meterReadings.id, meterReadingTransactions.reading_id))
      .innerJoin(meterDevices, eq(meterDevices.id, meterReadings.device_id))
      .innerJoin(financeTransaction, eq(financeTransaction.id, meterReadingTransactions.transaction_id))
      .where(and(inArray(meterDevices.meter_id, meterRows.map((m) => m.id)))),
  );
  if (linkRows.length === 0) return { currency: "EUR", meters: [] };

  const allowed = new Set(
    await readableTransactionIds(auth, linkRows.map((row) => Number(row.transaction_id))),
  );
  const payments: LinkedPayment[] = linkRows
    .filter((row) => allowed.has(Number(row.transaction_id)))
    .map((row) => ({
      meterId: row.meter_id,
      bookingDate: row.booking_date,
      amount: Number(row.amount),
    }));
  const linkedMeterIds = new Set(payments.map((p) => p.meterId));

  const costByMeterYear = new Map<number, Map<number, number | null>>();
  const linkedTypes = new Set(meterRows.filter((m) => linkedMeterIds.has(m.id)).map((m) => m.type));

  if (linkedTypes.has("electricity")) {
    const energy = await getEnergyReportForUser(auth.userId, "year", null, null);
    const electricityCosts = new Map<number, number | null>();
    for (const bucket of energy.buckets) {
      electricityCosts.set(Number(bucket.key), bucket.costs?.netElectricityCostEur ?? null);
    }
    for (const meter of meterRows) {
      if (meter.type === "electricity" && linkedMeterIds.has(meter.id)) {
        costByMeterYear.set(meter.id, electricityCosts);
      }
    }
  }

  if (linkedTypes.has("water")) {
    const economics = await getEconomicsReportForUser(auth.userId, "year", null, null);
    for (const water of economics.water) {
      if (!linkedMeterIds.has(water.meterId)) continue;
      const costs = new Map<number, number | null>();
      for (const bucket of water.buckets) costs.set(Number(bucket.key), bucket.totalCostEur);
      costByMeterYear.set(water.meterId, costs);
    }
  }

  return buildAdvancePaymentsReport(meterRows, payments, costByMeterYear);
}
