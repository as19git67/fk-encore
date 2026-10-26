/**
 * Which finance accounts a caller may read — the one definition, free of
 * endpoints so other services (the collections of #1548) can ask it too.
 *
 * Access is the per-account ACL in `finance_account_access`; `finance.admin`
 * skips it for reading. Two rules answer two questions:
 *
 * - `readableFinanceAccountIds` — what the caller may see: lists, search,
 *   totals, reports and the assistant's queries over bookings.
 * - `ownFinanceAccountIds` — what counts as the caller's own: the personal
 *   views (anomalies, expected payments, portfolio). A `read` entry on
 *   someone else's account — a partner's giro shared to look things up —
 *   stays out of them, and so does every account a finance admin sees only
 *   through the bypass.
 */

import { and, eq } from "drizzle-orm";
import db from "../db/database";
import { financeAccountAccess } from "../db/schema";

export function hasFinanceAdmin(auth: { permissions: string[] }): boolean {
  return auth.permissions.includes("finance.admin");
}

/**
 * The account ids the caller may READ. Admins get `null` (meaning "no
 * filter"); everyone else gets an explicit list — an empty array means "no
 * access at all, produce zero results".
 */
export async function readableFinanceAccountIds(
  auth: { userID: string; permissions: string[] },
): Promise<number[] | null> {
  if (hasFinanceAdmin(auth)) return null;
  const rows = await db
    .select({ id: financeAccountAccess.account_id })
    .from(financeAccountAccess)
    .where(eq(financeAccountAccess.user_id, Number(auth.userID)));
  return rows.map((r) => r.id);
}

/**
 * The account ids that are the caller's OWN: those with a `write` entry.
 * No admin bypass — an admin's personal views show their accounts, not the
 * whole bank. An empty array means "nothing of one's own".
 */
export async function ownFinanceAccountIds(
  auth: { userID: string },
): Promise<number[]> {
  const rows = await db
    .select({ id: financeAccountAccess.account_id })
    .from(financeAccountAccess)
    .where(
      and(
        eq(financeAccountAccess.user_id, Number(auth.userID)),
        eq(financeAccountAccess.level, "write"),
      ),
    );
  return rows.map((r) => r.id);
}
