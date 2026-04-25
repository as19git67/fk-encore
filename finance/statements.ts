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
import { and, eq, isNotNull } from "drizzle-orm";

import { requirePermission } from "../user/auth-handler";
import { checkRateLimit } from "../user/rateLimiter";
import db from "../db/database";
import {
  financeAccount,
  financeBankcontact,
  financeTanSession,
} from "../db/schema";
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

/**
 * Encore requires endpoint return types to be a named interface, not a
 * discriminated union — so every state variant's fields live on the
 * same interface as optional. Callers switch on `state` and treat the
 * rest of the fields as variant-specific:
 *
 *   state = "idle"          → accounts_seen / transactions_inserted /
 *                              balances_written / partial are meaningful
 *   state = "tan-required"  → tanReference + challenge (+tanMediaName)
 *   state = "error"         → errorCode + errorMessage
 */
/**
 * A bank-side account the sync saw that isn't linked to any
 * finance_account yet. The UI renders these in a "neue Konten bei
 * der Bank"-block so the user can import them as a new account, link
 * to an existing manual account, or ignore.
 */
export interface UnknownBankAccount {
  accountNumber: string;
  iban: string | null;
  accountKind: string;
  currency: string;
  label: string;
}

export interface SyncApiResponse {
  state: "idle" | "tan-required" | "error";
  /** state=idle — total accounts the bank reported. */
  accounts_seen?: number;
  /** state=idle — accounts that matched a linked finance_account and got data. */
  accounts_matched?: number;
  /** state=idle — accounts the bank reported but no linked finance_account exists for. */
  accounts_unknown?: number;
  /** state=idle — bank-side accounts waiting to be imported / linked in the UI. */
  unknown_accounts?: UnknownBankAccount[];
  /** state=idle — rows inserted into finance_transaction (new only). */
  transactions_inserted?: number;
  /** state=idle — rows inserted into finance_account_balance. */
  balances_written?: number;
  /** state=idle — true when any per-account fetch hit a mid-flight TAN we skipped. */
  partial?: boolean;
  /** state=tan-required — our public UUID for the pending session. */
  tanReference?: string;
  /** state=tan-required — human-readable challenge from the bank. */
  challenge?: string;
  /** state=tan-required — name of the selected TAN medium, if the bank identified one. */
  tanMediaName?: string;
  /** state=error — first non-zero bankAnswer code, e.g. "9910" for wrong PIN. */
  errorCode?: string;
  /** state=error — human-readable reason. */
  errorMessage?: string;
}

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

    // Rate-limit manual sync per user×bankcontact so a single user can't
    // spam the bank's FinTS endpoint. The cron fires independently.
    // See docs/finance-rate-limiting.md §2.
    checkRateLimit(`sync-trigger:${auth.userID}:${p.bankcontactId}`, {
      maxAttempts: 20,
      windowMs: 15 * 60_000,
      message: "Too many manual syncs for this bank contact.",
    });

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
    return {
      state: "idle",
      accounts_seen: 0,
      accounts_matched: 0,
      accounts_unknown: 0,
      transactions_inserted: 0,
      balances_written: 0,
      unknown_accounts: [],
    };
  }
  // Pre-compute the linked accounts so runFetchAccounts only issues
  // statement / balance calls (and SCA pushes) for accounts the user
  // actually wants in fk-encore. Unknown bank-side accounts still
  // surface in the response for the UI's "noch nicht zugeordnet"-
  // block, just without the per-account TAN cost.
  const linkedRows = await db
    .select({ fints_account_number: financeAccount.fints_account_number })
    .from(financeAccount)
    .where(
      and(
        eq(financeAccount.bankcontact_id, bankcontactId),
        isNotNull(financeAccount.fints_account_number),
      ),
    );
  const linkedAccountNumbers = new Set(
    linkedRows
      .map((r) => r.fints_account_number)
      .filter((n): n is string => n !== null && n.length > 0),
  );

  const fetched = await runFetchAccounts(client as FintsClientSurface, {
    linkedAccountNumbers,
  });
  const stats = await persistFetchResult(bankcontactId, fetched);
  console.log(
    `[finance.statements] bankcontact=${bankcontactId} synced: ` +
      `accounts=${stats.accounts_seen} (matched=${stats.accounts_matched} ` +
      `unknown=${stats.accounts_unknown}) ` +
      `tx=${stats.transactions_inserted} (${stats.transactions_skipped_duplicate} dup) ` +
      `balances=${stats.balances_written} partial=${fetched.partial}`,
  );
  return {
    state: "idle",
    accounts_seen: stats.accounts_seen,
    accounts_matched: stats.accounts_matched,
    accounts_unknown: stats.accounts_unknown,
    unknown_accounts: stats.unknown.map((u) => ({
      accountNumber: u.accountNumber,
      iban: u.iban,
      accountKind: u.accountKind,
      currency: u.currency,
      label: u.label,
    })),
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
