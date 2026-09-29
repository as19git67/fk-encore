// Retirement forecast — plan vs. actual (#1342).
//
// A snapshot is what a scenario expected on a day: the yearly series of
// wealth, plus the household's wealth at that moment. Later the page puts
// today's actual wealth next to what each snapshot expected for today.
// The second half compares the scenario's assumptions with what the
// bookings of the last twelve months say about spending and saving.
// No endpoints here; forecast-snapshots.ts serves them, the cron takes
// the monthly snapshot.

import { and, asc, desc, eq, gte, inArray, lt } from "drizzle-orm";

import db from "../db/database";
import {
  financeAccount,
  financeForecastItem,
  financeForecastPerson,
  financeForecastScenario,
  financeForecastSnapshot,
  financeTransaction,
  type ForecastSeriesPoint,
} from "../db/schema";
import { resolveHousehold, type HouseholdAccess } from "./forecast-household.service";
import { householdAccountIds } from "./forecast-bookings.service";
import { defaultScenario, simulate, type ForecastItem, type ForecastScenario, type SimulationResult } from "./forecast-engine";
import { loadHousehold, toEngineScenario, type Household } from "./forecast";

console.log("[boot] finance/forecast-snapshots.service.ts: all imports resolved");

// -----------------------------------------------------------------------
// Pure helpers
// -----------------------------------------------------------------------

const LIQUID = new Set(["cash", "depot", "other"]);

/** The yearly series a snapshot keeps: wealth and liquid wealth at each year's end. */
export function compactSeries(res: SimulationResult): ForecastSeriesPoint[] {
  return res.years.map((y) => ({ year: y.year, wealth: Math.round(y.wealthEnd), liquid: Math.round(y.liquidEnd) }));
}

/** Liquid wealth of the household today: the assets in the liquid pots as the forecast starts from them. */
export function liquidNow(items: ForecastItem[]): number {
  let s = 0;
  for (const it of items) if (it.type === "asset" && LIQUID.has(it.pot)) s += it.currentValue;
  return s;
}

/** All wealth today: every asset plus the surrender values of the life insurances. */
export function wealthNow(items: ForecastItem[]): number {
  let s = 0;
  for (const it of items) {
    if (it.type === "asset") s += it.currentValue;
    if (it.type === "life_insurance") s += it.surrenderValue;
  }
  return s;
}

/** A date as a decimal year, by month: 2026-07-xx → 2026.5. */
function decimalYear(date: string): number {
  return Number(date.slice(0, 4)) + (Number(date.slice(5, 7)) - 1) / 12;
}

/**
 * What a snapshot expected for `date`: linear between the wealth it started
 * from (at `takenAt`) and the year-end values of its series. null before the
 * snapshot was taken or beyond its horizon.
 */
export function plannedAt(
  series: ForecastSeriesPoint[],
  takenAt: string,
  start: { liquid: number; wealth: number },
  date: string,
): { liquid: number; wealth: number } | null {
  const t = decimalYear(date);
  const points: Array<{ t: number; liquid: number; wealth: number }> = [
    { t: decimalYear(takenAt), liquid: start.liquid, wealth: start.wealth },
    ...series.map((p) => ({ t: p.year + 1, liquid: p.liquid, wealth: p.wealth })),
  ].sort((a, b) => a.t - b.t);
  if (points.length === 0 || t < points[0].t - 1e-9 || t > points[points.length - 1].t + 1e-9) return null;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (t <= b.t + 1e-9) {
      const f = b.t === a.t ? 1 : (t - a.t) / (b.t - a.t);
      return { liquid: a.liquid + (b.liquid - a.liquid) * f, wealth: a.wealth + (b.wealth - a.wealth) * f };
    }
  }
  return { liquid: points[points.length - 1].liquid, wealth: points[points.length - 1].wealth };
}

export interface TxLite {
  accountId: number;
  /** YYYY-MM-DD… */
  date: string;
  amount: number;
  counterpartyIban: string | null;
}

export interface ActualFlows {
  /** Calendar months covered. */
  months: number;
  inflowMonthly: number;
  outflowMonthly: number;
  /** Inflows minus outflows per month: what the household put aside (or drew) on average. */
  savingsMonthly: number;
  /** Bookings left out as moves between the household's own accounts. */
  transfersExcluded: number;
}

const normIban = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, "").toUpperCase();

/**
 * Inflows and outflows of the household per month, without the money that
 * only moved between its own accounts: a booking whose counterparty is one
 * of the household's IBANs, or one that has its mirror image (same amount,
 * opposite sign, another account, within three days).
 */
export function actualsFromTransactions(txs: TxLite[], ownIbans: Iterable<string>, months: number): ActualFlows {
  const own = new Set([...ownIbans].map(normIban).filter((s) => s.length > 0));
  const day = (d: string) => Math.floor(Date.parse(d.slice(0, 10)) / 86_400_000);
  const excluded = new Set<number>();
  txs.forEach((t, i) => {
    if (t.counterpartyIban && own.has(normIban(t.counterpartyIban))) excluded.add(i);
  });
  // Mirror pairs, greedily, nearest first.
  const byAmount = new Map<string, number[]>();
  txs.forEach((t, i) => {
    if (excluded.has(i)) return;
    const key = Math.abs(t.amount).toFixed(2);
    const arr = byAmount.get(key) ?? [];
    arr.push(i);
    byAmount.set(key, arr);
  });
  for (const idxs of byAmount.values()) {
    if (idxs.length < 2) continue;
    const used = new Set<number>();
    for (const i of idxs) {
      if (used.has(i)) continue;
      let best: number | null = null;
      let bestGap = 4;
      for (const j of idxs) {
        if (j === i || used.has(j)) continue;
        if (txs[j].accountId === txs[i].accountId) continue;
        if (Math.sign(txs[j].amount) === Math.sign(txs[i].amount)) continue;
        const gap = Math.abs(day(txs[j].date) - day(txs[i].date));
        if (gap <= 3 && gap < bestGap) {
          best = j;
          bestGap = gap;
        }
      }
      if (best != null) {
        used.add(i);
        used.add(best);
        excluded.add(i);
        excluded.add(best);
      }
    }
  }
  let inflow = 0;
  let outflow = 0;
  txs.forEach((t, i) => {
    if (excluded.has(i)) return;
    if (t.amount > 0) inflow += t.amount;
    else outflow += -t.amount;
  });
  const m = Math.max(1, months);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    months,
    inflowMonthly: r2(inflow / m),
    outflowMonthly: r2(outflow / m),
    savingsMonthly: r2((inflow - outflow) / m),
    transfersExcluded: excluded.size,
  };
}

/** What the scenario's items say the household spends per month (living expenses and recurring expenses). */
export function plannedSpendingMonthly(items: ForecastItem[]): number {
  let s = 0;
  for (const it of items) {
    if (it.type === "living_expense") s += it.amount;
    if (it.type === "expense" && it.frequency === "monthly") s += it.amount;
    if (it.type === "expense" && it.frequency === "yearly") s += it.amount / 12;
  }
  return Math.round(s * 100) / 100;
}

/** What the simulation saves per month in its first full year: income minus expenses. */
export function plannedSavingsMonthly(res: SimulationResult): number | null {
  const y = res.years[1] ?? res.years[0];
  if (!y) return null;
  const months = res.years[1] ? 12 : 13 - res.startMonth;
  return Math.round(((y.totalIncome - y.totalExpenses) / months) * 100) / 100;
}

// -----------------------------------------------------------------------
// Snapshots
// -----------------------------------------------------------------------

export interface SnapshotDto {
  id: number;
  takenAt: string;
  scenarioId: number | null;
  scenarioName: string;
  source: "manual" | "cron";
  startLiquid: number;
  startWealth: number;
  series: ForecastSeriesPoint[];
  /** What this snapshot expected for today; null when today lies outside it. */
  plannedNow: { liquid: number; wealth: number } | null;
}

interface ScenarioRef {
  id: number | null;
  name: string;
  config: Record<string, unknown>;
}

function toDto(row: typeof financeForecastSnapshot.$inferSelect, now: string): SnapshotDto {
  const start = { liquid: Number(row.start_liquid), wealth: Number(row.start_wealth) };
  return {
    id: row.id,
    takenAt: row.taken_at,
    scenarioId: row.scenario_id,
    scenarioName: row.scenario_name,
    source: row.source,
    startLiquid: start.liquid,
    startWealth: start.wealth,
    series: row.series,
    plannedNow: plannedAt(row.series, row.taken_at, start, now),
  };
}

/** Simulates the scenario for the household and keeps the result as a snapshot. */
export async function takeSnapshot(
  ownerId: number,
  hh: Household,
  scenario: ScenarioRef | null,
  source: "manual" | "cron",
  now = new Date().toISOString(),
): Promise<SnapshotDto> {
  const sc: ForecastScenario = scenario ? toEngineScenario(scenario.config, scenario.name, scenario.id ?? undefined) : defaultScenario();
  const res = simulate({ persons: hh.persons, milestones: hh.milestones, items: hh.items, scenario: sc });
  const { name: _n, id: _i, ...config } = sc;
  const [row] = await db
    .insert(financeForecastSnapshot)
    .values({
      user_id: ownerId,
      scenario_id: scenario?.id ?? null,
      scenario_name: scenario?.name ?? "Standardannahmen",
      source,
      taken_at: now,
      start_liquid: liquidNow(hh.items).toFixed(2),
      start_wealth: wealthNow(hh.items).toFixed(2),
      series: compactSeries(res),
      config: config as unknown as Record<string, unknown>,
    })
    .returning();
  return toDto(row, now);
}

export async function listSnapshots(ownerId: number, now = new Date().toISOString()): Promise<SnapshotDto[]> {
  const rows = await db
    .select()
    .from(financeForecastSnapshot)
    .where(eq(financeForecastSnapshot.user_id, ownerId))
    .orderBy(desc(financeForecastSnapshot.taken_at), desc(financeForecastSnapshot.id));
  return rows.map((r) => toDto(r, now));
}

export async function deleteSnapshot(ownerId: number, id: number): Promise<boolean> {
  const deleted = await db
    .delete(financeForecastSnapshot)
    .where(and(eq(financeForecastSnapshot.id, id), eq(financeForecastSnapshot.user_id, ownerId)))
    .returning({ id: financeForecastSnapshot.id });
  return deleted.length > 0;
}

// -----------------------------------------------------------------------
// Actuals from the bookings
// -----------------------------------------------------------------------

export interface ActualsDto {
  flows: ActualFlows;
  /** Spending per month the scenario's items add up to. */
  plannedSpending: number;
  /** Savings per month the simulation expects in its first full year. */
  plannedSavings: number | null;
  /** The living-expense item the actual spending could be written to, if there is exactly one. */
  livingItemId: number | null;
  since: string;
}

/** First day of the month `months` full months ago, and the first day of this month (exclusive end). */
export function actualsWindow(now: Date, months = 12): { since: string; until: string } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - months, 1));
  return { since: start.toISOString().slice(0, 10), until: end.toISOString().slice(0, 10) };
}

export async function loadActuals(ownerId: number, hh: Household, res: SimulationResult, now = new Date()): Promise<ActualsDto | null> {
  const accountIds = await householdAccountIds(ownerId);
  if (accountIds.length === 0) return null;
  const { since, until } = actualsWindow(now);
  const [txRows, ibanRows] = await Promise.all([
    db
      .select({
        accountId: financeTransaction.account_id,
        date: financeTransaction.booking_date,
        amount: financeTransaction.amount,
        counterpartyIban: financeTransaction.counterparty_iban,
      })
      .from(financeTransaction)
      .where(
        and(
          inArray(financeTransaction.account_id, accountIds),
          gte(financeTransaction.booking_date, since),
          lt(financeTransaction.booking_date, until),
        ),
      ),
    db.select({ iban: financeAccount.iban }).from(financeAccount).where(inArray(financeAccount.id, accountIds)),
  ]);
  if (txRows.length === 0) return null;
  const flows = actualsFromTransactions(
    txRows.map((t) => ({ accountId: t.accountId, date: t.date, amount: Number(t.amount), counterpartyIban: t.counterpartyIban })),
    ibanRows.map((r) => r.iban).filter((s): s is string => !!s),
    12,
  );
  const living = hh.items.filter((it) => it.type === "living_expense");
  return {
    flows,
    plannedSpending: plannedSpendingMonthly(hh.items),
    plannedSavings: plannedSavingsMonthly(res),
    livingItemId: living.length === 1 ? living[0].id : null,
    since,
  };
}

// -----------------------------------------------------------------------
// The monthly cron
// -----------------------------------------------------------------------

/** Days after a cron snapshot before the next one is due. */
export const CRON_INTERVAL_DAYS = 27;

/**
 * One snapshot per saved scenario (and one for the defaults) for every
 * household that has none younger than `CRON_INTERVAL_DAYS`. Returns how
 * many snapshots were written.
 */
export async function snapshotDueHouseholds(now = new Date()): Promise<number> {
  const owners = await db.selectDistinct({ userId: financeForecastPerson.user_id }).from(financeForecastPerson);
  const cutoff = new Date(now.getTime() - CRON_INTERVAL_DAYS * 86_400_000).toISOString();
  let written = 0;
  for (const { userId } of owners) {
    const [recent] = await db
      .select({ id: financeForecastSnapshot.id })
      .from(financeForecastSnapshot)
      .where(and(eq(financeForecastSnapshot.user_id, userId), eq(financeForecastSnapshot.source, "cron"), gte(financeForecastSnapshot.taken_at, cutoff)))
      .limit(1);
    if (recent) continue;
    const access: HouseholdAccess = await resolveHousehold(userId, false);
    if (access.ownerId !== userId) continue; // not a household of their own
    const hh = await loadHousehold(userId, access);
    if (hh.persons.length === 0) continue;
    const scenarios = await db
      .select({ id: financeForecastScenario.id, name: financeForecastScenario.name, config: financeForecastScenario.config })
      .from(financeForecastScenario)
      .where(eq(financeForecastScenario.user_id, userId))
      .orderBy(asc(financeForecastScenario.id));
    await takeSnapshot(userId, hh, null, "cron", now.toISOString());
    written++;
    for (const s of scenarios) {
      await takeSnapshot(userId, hh, s, "cron", now.toISOString());
      written++;
    }
  }
  return written;
}

/** Sets the household's living expenses to what the bookings say. */
export async function adoptLiving(ownerId: number, itemId: number, monthly: number): Promise<void> {
  const [row] = await db
    .select()
    .from(financeForecastItem)
    .where(and(eq(financeForecastItem.id, itemId), eq(financeForecastItem.user_id, ownerId), eq(financeForecastItem.type, "living_expense")));
  if (!row) throw new Error("living expense item not found");
  await db
    .update(financeForecastItem)
    .set({ data: { ...row.data, amount: Math.round(monthly), valuesSource: { kind: "manual", updatedAt: new Date().toISOString() } } })
    .where(eq(financeForecastItem.id, itemId));
}
