/**
 * The month's SerpApi searches, shared by every watch of the travel module.
 *
 * One key serves the deployment, so hotel and flight watches of all users
 * spend the same budget (`monthlySearchBudget()`). Each check records the
 * searches it cost; this sums them since the start of the calendar month.
 */
import { gte, sql } from "drizzle-orm";
import db from "../db/database";
import { travelFlightChecks, travelHotelChecks } from "../db/schema";

/** SerpApi searches all checks used since the start of `now`'s calendar month (UTC). */
export async function searchesThisMonth(now: Date = new Date()): Promise<number> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const [hotels] = await db
    .select({ n: sql<number>`COALESCE(SUM(${travelHotelChecks.searches}), 0)` })
    .from(travelHotelChecks)
    .where(gte(travelHotelChecks.checked_at, start));
  const [flights] = await db
    .select({ n: sql<number>`COALESCE(SUM(${travelFlightChecks.searches}), 0)` })
    .from(travelFlightChecks)
    .where(gte(travelFlightChecks.checked_at, start));
  return Number(hotels?.n ?? 0) + Number(flights?.n ?? 0);
}

export class SearchBudgetExhausted extends Error {
  constructor(used: number, budget: number) {
    super(`Das Monatskontingent von ${budget} SerpApi-Suchen ist aufgebraucht (${used} verbraucht)`);
    this.name = "SearchBudgetExhausted";
  }
}
