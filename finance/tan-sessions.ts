/**
 * TAN-Session endpoints.
 *
 * The sync trigger (statements.ts) drops a finance_tan_session row
 * whenever the FinTS dialog demands a TAN. The UI's TanDialog sends
 * back the user-entered TAN via `complete`, we replay the dialog via
 * runSynchronize(..., resumeOpts), and map the outcome back to the UI:
 *
 *   - state="idle"         → session deleted, return { state: "idle" }
 *   - state="tan-required" → wrong TAN, session kept so the user can
 *                            retry, return { state: "tan-required", ... }
 *   - state="error"        → session deleted, return { state: "error" }
 *
 * Decoupled TAN methods (pushTAN) pass undefined as `tan` — that's
 * legitimate and flows straight through to lib-fints.
 *
 * Session lookup is scoped to the calling user — one user must not be
 * able to submit a TAN against another user's pending dialog.
 *
 * Permission: `finance.accounts.manage`.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { eq, lt } from "drizzle-orm";

import { requirePermission } from "../user/auth-handler";
import { checkRateLimit, resetRateLimit } from "../user/rateLimiter";
import db from "../db/database";
import { financeTanSession } from "../db/schema";
import { runSynchronize } from "./fints-client";
import { fetchAndPersist, type SyncApiResponse } from "./statements";

console.log("[boot] finance/tan-sessions.ts: all imports resolved");

// -----------------------------------------------------------------------

interface CompleteParams {
  tanReference: string;
  /**
   * User-entered TAN. Undefined is legitimate for decoupled TAN methods
   * (e.g. pushTAN) where the user approves on a separate device.
   */
  tan?: string;
}

export const completeTanSession = api(
  {
    expose: true,
    method: "POST",
    path: "/finance/tan-sessions/complete",
    auth: true,
  },
  async (p: CompleteParams): Promise<SyncApiResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.accounts.manage");

    // Rate-limit per tan_reference, not per IP — NATed users must not lock
    // each other out. See docs/finance-rate-limiting.md §2.
    const rateKey = `tan-complete:${p.tanReference}`;
    checkRateLimit(rateKey, {
      maxAttempts: 5,
      windowMs: 10 * 60_000,
      message: "Too many TAN attempts for this session.",
    });

    const userId = Number(auth.userID);
    const [session] = await db
      .select()
      .from(financeTanSession)
      .where(eq(financeTanSession.tan_reference, p.tanReference))
      .limit(1);

    if (!session) {
      throw APIError.notFound("TAN session not found or expired");
    }
    if (session.user_id !== userId) {
      // Don't leak whether the session exists — 404 for a different-
      // user session mirrors the "not found" response above, making
      // enumeration of other users' pending sessions infeasible.
      throw APIError.notFound("TAN session not found or expired");
    }
    if (new Date(session.expires_at).getTime() < Date.now()) {
      // Row stays; cleanup cron removes it. Return a distinct error
      // code so the UI can tell the user to restart the dialog.
      throw APIError.deadlineExceeded("TAN session expired");
    }

    const info = session.banking_information as {
      bi: Record<string, unknown>;
      fintsTanRef: string;
    };

    const result = await runSynchronize(session.bankcontact_id, {
      tanReference: info.fintsTanRef,
      tanAnswer: p.tan,
      bankingInformation: info.bi,
    });

    if (result.state === "tan-required") {
      // Follow-up TAN (chained auth step) — counts as success for
      // rate-limiting purposes: the user is on the right path, reset
      // the counter so the next TAN attempt starts fresh.
      resetRateLimit(rateKey);
      await db
        .update(financeTanSession)
        .set({
          banking_information: {
            bi: result.bankingInformation ?? info.bi,
            fintsTanRef: result.tanReference ?? info.fintsTanRef,
          },
          challenge: result.tanChallenge ?? session.challenge,
        })
        .where(eq(financeTanSession.tan_reference, p.tanReference));
      return {
        state: "tan-required",
        tanReference: p.tanReference,
        challenge: result.tanChallenge ?? session.challenge,
        tanMediaName: result.tanMediaName,
      };
    }

    // Terminal outcome — drop the session.
    await db
      .delete(financeTanSession)
      .where(eq(financeTanSession.tan_reference, p.tanReference));

    if (result.state === "error") {
      return {
        state: "error",
        errorCode: result.errorCode ?? "unknown",
        errorMessage: result.errorMessage ?? "FinTS dialog failed",
      };
    }
    // state === "idle" — run the statement/balance fetch with the
    // still-open client so TAN is not re-triggered for a second time.
    // Pass the session owner so auto-created accounts get a write ACL
    // for them — same contract as the manual triggerSync path.
    resetRateLimit(rateKey);
    return await fetchAndPersist(session.bankcontact_id, result.client, {
      grantAclToUserId: session.user_id,
    });
  },
);

/**
 * Internal endpoint: delete all TAN sessions past their expires_at.
 * Wired to a CronJob in Etappe 6; exposed as `expose: false` so it
 * can't be hit from outside the cluster.
 */
export const cleanupExpiredTanSessions = api(
  {
    expose: false,
    method: "POST",
    path: "/internal/finance/tan-sessions/cleanup",
  },
  async (): Promise<{ deleted: number }> => {
    const nowIso = new Date().toISOString();
    const deleted = await db
      .delete(financeTanSession)
      .where(lt(financeTanSession.expires_at, nowIso))
      .returning({ ref: financeTanSession.tan_reference });
    return { deleted: deleted.length };
  },
);

