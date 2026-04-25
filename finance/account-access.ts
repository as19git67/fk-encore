/**
 * Admin endpoints for the per-account ACL (finance_account_access).
 *
 *   GET /finance/admin/access/:accountId
 *       → [{ user_id, user_email, user_name, level }]
 *   PUT /finance/admin/access/:accountId
 *       → replaces the full ACL for the given account with the
 *         supplied list, computed as a diff against the current
 *         state (inserts, updates, deletes).
 *
 * The diff semantics matter: we only issue the minimum set of
 * writes so reordering the same list (idempotent replay) is a no-op
 * and so concurrent tag-level changes elsewhere don't get clobbered.
 *
 * Permission: `finance.admin` (`adminExcludedPermissions` in seed.ts
 * keeps this off the auto-assigned admin-role permission set).
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { and, eq, inArray } from "drizzle-orm";

import { requirePermission } from "../user/auth-handler";
import db from "../db/database";
import {
  financeAccount,
  financeAccountAccess,
  financeAccountLevelEnum,
  users,
} from "../db/schema";

console.log("[boot] finance/account-access.ts: all imports resolved");

// -----------------------------------------------------------------------

// Encore's static parser can't follow the generic indexed-access
// `(typeof X.enumValues)[number]`. Spell the two values out; runtime
// validation still uses financeAccountLevelEnum.enumValues so the two
// stay aligned.
type AclLevel = "read" | "write";

interface AccessEntry {
  user_id: number;
  user_email: string;
  user_name: string;
  level: AclLevel;
}

interface ListResponse {
  items: AccessEntry[];
}

interface IdParams {
  accountId: number;
}

export const listAccountAccess = api(
  {
    expose: true,
    method: "GET",
    path: "/finance/admin/access/:accountId",
    auth: true,
  },
  async ({ accountId }: IdParams): Promise<ListResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.admin");
    await assertAccountExists(accountId);

    const rows = await db
      .select({
        user_id: financeAccountAccess.user_id,
        level: financeAccountAccess.level,
        email: users.email,
        name: users.name,
      })
      .from(financeAccountAccess)
      .innerJoin(users, eq(users.id, financeAccountAccess.user_id))
      .where(eq(financeAccountAccess.account_id, accountId));

    return {
      items: rows.map((r) => ({
        user_id: r.user_id,
        user_email: r.email,
        user_name: r.name,
        level: r.level,
      })),
    };
  },
);

// -----------------------------------------------------------------------

interface PutEntry {
  user_id: number;
  level: AclLevel;
}

interface PutParams {
  accountId: number;
  entries: PutEntry[];
}

interface DiffStats {
  inserted: number;
  updated: number;
  deleted: number;
}

interface PutResponse {
  items: AccessEntry[];
  diff: DiffStats;
}

export const putAccountAccess = api(
  {
    expose: true,
    method: "PUT",
    path: "/finance/admin/access/:accountId",
    auth: true,
  },
  async (p: PutParams): Promise<PutResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.admin");
    await assertAccountExists(p.accountId);

    // ---- Validate inputs -------------------------------------------------
    const seen = new Set<number>();
    for (const entry of p.entries ?? []) {
      if (typeof entry.user_id !== "number") {
        throw APIError.invalidArgument("entries[].user_id must be a number");
      }
      if (seen.has(entry.user_id)) {
        throw APIError.invalidArgument(
          `duplicate user_id ${entry.user_id} in entries`,
        );
      }
      seen.add(entry.user_id);
      if (
        !(financeAccountLevelEnum.enumValues as readonly string[]).includes(
          entry.level,
        )
      ) {
        throw APIError.invalidArgument(
          `entries[].level must be one of: ${financeAccountLevelEnum.enumValues.join(", ")}`,
        );
      }
    }

    const desired = p.entries ?? [];
    if (desired.length > 0) {
      const userIds = desired.map((e) => e.user_id);
      const found = await db
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.id, userIds));
      const foundIds = new Set(found.map((r) => r.id));
      for (const entry of desired) {
        if (!foundIds.has(entry.user_id)) {
          throw APIError.invalidArgument(`user ${entry.user_id} not found`);
        }
      }
    }

    // ---- Compute diff ---------------------------------------------------
    const existing = await db
      .select()
      .from(financeAccountAccess)
      .where(eq(financeAccountAccess.account_id, p.accountId));
    const byUser = new Map(existing.map((e) => [e.user_id, e]));

    const toInsert: PutEntry[] = [];
    const toUpdate: PutEntry[] = [];
    const desiredUserIds = new Set<number>();

    for (const entry of desired) {
      desiredUserIds.add(entry.user_id);
      const prev = byUser.get(entry.user_id);
      if (!prev) {
        toInsert.push(entry);
      } else if (prev.level !== entry.level) {
        toUpdate.push(entry);
      }
    }
    const toDelete = existing
      .filter((e) => !desiredUserIds.has(e.user_id))
      .map((e) => e.user_id);

    // ---- Apply ----------------------------------------------------------
    //
    // Drizzle's node-postgres driver doesn't wrap these in a single
    // transaction for us; for the diff to be atomic we'd reach for
    // `db.transaction(…)`. That's an Etappe-polish item — current
    // footprint is small (at most N inserts + M updates + K deletes
    // for a single account, realistically < 20 rows) and the
    // endpoint is admin-only with low contention.

    for (const entry of toInsert) {
      await db.insert(financeAccountAccess).values({
        account_id: p.accountId,
        user_id: entry.user_id,
        level: entry.level,
      });
    }
    for (const entry of toUpdate) {
      await db
        .update(financeAccountAccess)
        .set({ level: entry.level })
        .where(
          and(
            eq(financeAccountAccess.account_id, p.accountId),
            eq(financeAccountAccess.user_id, entry.user_id),
          ),
        );
    }
    if (toDelete.length > 0) {
      await db
        .delete(financeAccountAccess)
        .where(
          and(
            eq(financeAccountAccess.account_id, p.accountId),
            inArray(financeAccountAccess.user_id, toDelete),
          ),
        );
    }

    // ---- Return the fresh list -----------------------------------------
    const rows = await db
      .select({
        user_id: financeAccountAccess.user_id,
        level: financeAccountAccess.level,
        email: users.email,
        name: users.name,
      })
      .from(financeAccountAccess)
      .innerJoin(users, eq(users.id, financeAccountAccess.user_id))
      .where(eq(financeAccountAccess.account_id, p.accountId));

    return {
      items: rows.map((r) => ({
        user_id: r.user_id,
        user_email: r.email,
        user_name: r.name,
        level: r.level,
      })),
      diff: {
        inserted: toInsert.length,
        updated: toUpdate.length,
        deleted: toDelete.length,
      },
    };
  },
);

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

async function assertAccountExists(id: number): Promise<void> {
  const [row] = await db
    .select({ id: financeAccount.id })
    .from(financeAccount)
    .where(eq(financeAccount.id, id))
    .limit(1);
  if (!row) throw APIError.notFound(`account ${id} not found`);
}
