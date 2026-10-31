/**
 * The demo depot in the database (documentation/plans/demodaten.md,
 * stage 3): the closes of the four funds from the configured quote
 * provider, and the depot account with its securities confirmed, the way
 * a user sets up a depot before uploading its papers. The trades and
 * holdings are not written here: the pipeline reads them from the
 * settlements and statements (`demo/depot.ts`).
 *
 * The quotes the provider delivers are kept like any position's: they
 * are shared by every depot holding the fund, so removing the demo leaves
 * them.
 */

import { eq } from "drizzle-orm";
import db from "../db/database";
import { financeAccount, financeAccountAccess, financeAccountType, financeDepotSecurity } from "../db/schema";
import { refreshQuotes, type ActivePosition } from "../finance/quote-refresh";
import { closesAfter } from "../finance/quote-store";
import type { Closes } from "./depot";
import { register } from "./registry";
import { DEMO_DEPOT_NUMBER, DEMO_SECURITIES } from "./securities";

export type ClosesResult = { closes: Closes } | { skipped: string };

/**
 * Loads the history of every demo fund and returns the closes from `from`
 * on. Without a provider, or when a fund has no history, the depot is left
 * out and the reason is returned instead: settlements at made-up prices
 * would contradict the quotes the depot shows.
 */
export async function loadDemoCloses(from: string): Promise<ClosesResult> {
  const positions: ActivePosition[] = DEMO_SECURITIES.map((s) => ({ key: s.isin, isin: s.isin, wkn: null, name: s.name, amount: 1, account_ids: [] }));
  try {
    const stats = await refreshQuotes(positions, new Date(), { retryUnresolved: true });
    if (stats.rate_limited) return { skipped: "Der Kursanbieter hat die Anfrage abgewiesen (zu viele Anfragen)." };
  } catch (err) {
    return { skipped: `Kein Kursanbieter erreichbar: ${(err as Error).message}` };
  }
  const closes: Closes = new Map();
  const dayBefore = new Date(Date.parse(`${from}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  for (const s of DEMO_SECURITIES) {
    const series = (await closesAfter(s.isin, dayBefore)).map((q) => ({ day: q.day, price: q.price }));
    if (!series.length) return { skipped: `Für ${s.name} liefert der Kursanbieter keine Kurshistorie.` };
    closes.set(s.isin, series);
  }
  return { closes };
}

/** Creates the depot account for the admin and confirms the funds it trades. Returns its id. */
export async function createDemoDepot(runId: number, ownerId: number, isins: string[]): Promise<number> {
  const [type] = await db.select({ id: financeAccountType.id }).from(financeAccountType).where(eq(financeAccountType.kind, "depot"));
  if (!type) throw new Error("finance_account_type 'depot' is missing — the seed has not run");
  const [row] = await db
    .insert(financeAccount)
    .values({ type_id: type.id, currency_code: "EUR", account_number: DEMO_DEPOT_NUMBER, iban: null, label: "Depot Demo-Bank" })
    .returning({ id: financeAccount.id });
  await register(runId, "finance_account", [row.id]);
  await db.insert(financeAccountAccess).values({ account_id: row.id, user_id: ownerId, level: "write" });
  const now = new Date().toISOString();
  const traded = DEMO_SECURITIES.filter((s) => isins.includes(s.isin));
  if (traded.length) {
    await db.insert(financeDepotSecurity).values(
      traded.map((s) => ({ account_id: row.id, isin: s.isin, wkn: null, name: s.name, status: "confirmed" as const, source: "user" as const, decided_at: now, decided_by: ownerId })),
    );
  }
  return row.id;
}
