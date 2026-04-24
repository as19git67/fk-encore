/**
 * Manual sync trigger for a bankcontact.
 *
 * The cron in Etappe 6 will call the same code path (via an internal
 * endpoint); this file exposes the user-facing "Sync jetzt"-button
 * entry point.
 *
 * Return shape is deliberately a discriminated union, NOT HTTP 409:
 *   { state: "idle" }               → dialog finished cleanly
 *   { state: "tan-required",
 *     tanReference, challenge, ... } → UI opens TanDialog
 *   { state: "error", ... }          → credentials broken / network
 *
 * A typed response plays nicely with the Encore-generated client and
 * lets the Frontend switch on a single field instead of parsing
 * status codes. Etappe 5 will extend the "idle" branch to persist
 * the fetched transactions.
 *
 * Permission: `finance.accounts.manage`.
 */

import { randomUUID } from "node:crypto";
import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { eq } from "drizzle-orm";

import { requirePermission } from "../user/auth-handler";
import db from "../db/database";
import { financeBankcontact, financeTanSession } from "../db/schema";
import {
  runFetchAccounts,
  runSynchronize,
  type FintsClientSurface,
} from "./fints-client";
import { persistFetchResult } from "./statement-persist";

console.log("[boot] finance/statements.ts: all imports resolved");

// -----------------------------------------------------------------------

interface TriggerParams {
  bankcontactId: number;
}

export type SyncApiResponse =
  | {
      state: "idle";
      /** Accounts the cron saw on this run. */
      accounts_seen?: number;
      /** Rows inserted into finance_transaction (new only). */
      transactions_inserted?: number;
      /** Rows inserted into finance_account_balance. */
      balances_written?: number;
      /** True when any per-account fetch hit a mid-flight TAN we skipped. */
      partial?: boolean;
    }
  | {
      state: "tan-required";
      tanReference: string;
      challenge: string;
      tanMediaName?: string;
    }
  | { state: "error"; errorCode: string; errorMessage: string };

/**
 * Session-TTL for the TAN flow — 10 minutes matches the typical
 * bank-side timeout for a pending TAN challenge. Cleanup of expired
 * rows lives in tan-sessions.ts (Etappe 6 cron).
 */
const TAN_SESSION_TTL_MS = 10 * 60_000;

export const triggerSync = api(
  {
    expose: true,
    method: "POST",
    path: "/finance/statements",
    auth: true,
  },
  async (p: TriggerParams): Promise<SyncApiResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.accounts.manage");

    await assertBankcontactExists(p.bankcontactId);

    const result = await runSynchronize(p.bankcontactId);

    if (result.state === "tan-required") {
      const tanReference = randomUUID();
      await db.insert(financeTanSession).values({
        tan_reference: tanReference,
        user_id: Number(auth.userID),
        bankcontact_id: p.bankcontactId,
        banking_information: {
          bi: result.bankingInformation ?? {},
          fintsTanRef: result.tanReference ?? "",
        },
        challenge: result.tanChallenge ?? "",
        expires_at: new Date(Date.now() + TAN_SESSION_TTL_MS).toISOString(),
      });
      return {
        state: "tan-required",
        tanReference,
        challenge: result.tanChallenge ?? "",
        tanMediaName: result.tanMediaName,
      };
    }

    if (result.state === "error") {
      return {
        state: "error",
        errorCode: result.errorCode ?? "unknown",
        errorMessage: result.errorMessage ?? "FinTS dialog failed",
      };
    }

    // state === "idle" — run the statement/balance fetch against the
    // same client so we don't re-do the init-dialog TAN just to pull
    // data that was unreachable before.
    return await fetchAndPersist(p.bankcontactId, result.client);
  },
);

/**
 * Runs `runFetchAccounts` + `persistFetchResult` against the live
 * client and maps the outcome to `SyncApiResponse`. Shared by the
 * manual trigger (`statements.triggerSync`) and the cron/TAN-resume
 * paths.
 */
export async function fetchAndPersist(
  bankcontactId: number,
  client: unknown,
): Promise<SyncApiResponse> {
  if (!client) {
    // No client handed over (e.g. a legacy mock) — treat as idle
    // with no data.
    return { state: "idle", accounts_seen: 0, transactions_inserted: 0, balances_written: 0 };
  }
  const fetched = await runFetchAccounts(client as FintsClientSurface);
  const stats = await persistFetchResult(bankcontactId, fetched);
  console.log(
    `[finance.statements] bankcontact=${bankcontactId} synced: ` +
      `accounts=${stats.accounts_seen} (+${stats.accounts_created} new) ` +
      `tx=${stats.transactions_inserted} (${stats.transactions_skipped_duplicate} dup) ` +
      `balances=${stats.balances_written} partial=${fetched.partial}`,
  );
  return {
    state: "idle",
    accounts_seen: stats.accounts_seen,
    transactions_inserted: stats.transactions_inserted,
    balances_written: stats.balances_written,
    partial: fetched.partial || undefined,
  };
}

// -----------------------------------------------------------------------

async function assertBankcontactExists(id: number): Promise<void> {
  const [row] = await db
    .select({ id: financeBankcontact.id })
    .from(financeBankcontact)
    .where(eq(financeBankcontact.id, id))
    .limit(1);
  if (!row) throw APIError.notFound(`bankcontact ${id} not found`);
}
