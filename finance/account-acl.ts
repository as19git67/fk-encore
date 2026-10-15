/**
 * Which finance accounts a caller may read — the one definition, free of
 * endpoints so other services (the collections of #1548) can ask it too.
 *
 * Access is the per-account ACL in `finance_account_access`; `finance.admin`
 * skips it.
 */

import { eq } from "drizzle-orm";
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
