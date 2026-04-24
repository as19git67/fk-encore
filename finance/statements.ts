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
import { runSynchronize } from "./fints-client";

console.log("[boot] finance/statements.ts: all imports resolved");

// -----------------------------------------------------------------------

interface TriggerParams {
  bankcontactId: number;
}

export type SyncApiResponse =
  | { state: "idle" }
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

    // state === "idle"
    // Etappe 5 will persist transactions + balances here.
    return { state: "idle" };
  },
);

// -----------------------------------------------------------------------

async function assertBankcontactExists(id: number): Promise<void> {
  const [row] = await db
    .select({ id: financeBankcontact.id })
    .from(financeBankcontact)
    .where(eq(financeBankcontact.id, id))
    .limit(1);
  if (!row) throw APIError.notFound(`bankcontact ${id} not found`);
}
