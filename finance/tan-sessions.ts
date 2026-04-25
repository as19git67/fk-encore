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
import { financeBankcontact, financeTanSession } from "../db/schema";
import {
  resumeFetchAfterTan,
  runSynchronize,
  takeCachedClient,
  type FintsClientSurface,
} from "./fints-client";
import { fetchAndPersist, type SyncApiResponse } from "./statements";
import { persistFetchResult } from "./statement-persist";

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

    // ── kind="statements" ─────────────────────────────────────────
    // Mid-fetch dialog: the loop in runFetchAccounts paused on a
    // coupled TAN (photoTAN/chipTAN). The live client that started
    // the dialog should still be in liveClientCache; if it isn't
    // (container restart, TTL expiry), we have to bail.
    if (session.kind === "statements") {
      return await resumeStatementsTan(session, p, rateKey);
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
          tan_media_name: result.tanMediaName ?? session.tan_media_name,
          tan_photo_mime: result.tanPhotoMime ?? null,
          tan_photo_base64: result.tanPhotoBase64 ?? null,
        })
        .where(eq(financeTanSession.tan_reference, p.tanReference));
      return {
        state: "tan-required",
        tanReference: p.tanReference,
        challenge: result.tanChallenge ?? session.challenge,
        tanMediaName: result.tanMediaName ?? session.tan_media_name ?? undefined,
        tanPhotoMime: result.tanPhotoMime,
        tanPhotoBase64: result.tanPhotoBase64,
      };
    }

    // Terminal outcome — drop the session.
    await db
      .delete(financeTanSession)
      .where(eq(financeTanSession.tan_reference, p.tanReference));

    if (result.state === "error") {
      await db
        .update(financeBankcontact)
        .set({
          last_sync_at: new Date().toISOString(),
          last_sync_status: `error:${result.errorCode ?? "unknown"}`,
        })
        .where(eq(financeBankcontact.id, session.bankcontact_id));
      return {
        state: "error",
        errorCode: result.errorCode ?? "unknown",
        errorMessage: result.errorMessage ?? "FinTS dialog failed",
      };
    }
    // state === "idle" — run the statement/balance fetch with the
    // still-open client so TAN is not re-triggered for a second time.
    // Only *linked* accounts receive data; unknown ones flow up in
    // the pending list for the user to resolve in the UI.
    resetRateLimit(rateKey);
    return await fetchAndPersist(session.bankcontact_id, result.client);
  },
);

/**
 * Resume a kind="statements" session: continue the paused
 * getAccountStatements call with the user's TAN, persist the data
 * we get back, then keep iterating any accounts queued behind it.
 *
 * If the live client is no longer in the in-memory cache (container
 * restart, TTL expiry), the bank's session is gone too — there's no
 * way to continue the dialog. Surface this as state="error" with a
 * distinct code so the UI tells the user to retrigger sync.
 */
async function resumeStatementsTan(
  session: typeof financeTanSession.$inferSelect,
  p: CompleteParams,
  rateKey: string,
): Promise<SyncApiResponse> {
  const cached = takeCachedClient(session.bankcontact_id);
  if (!cached) {
    await db
      .delete(financeTanSession)
      .where(eq(financeTanSession.tan_reference, p.tanReference));
    return {
      state: "error",
      errorCode: "live-client-evicted",
      errorMessage:
        "Die laufende Bank-Sitzung wurde gerade geschlossen — bitte den " +
        "Sync erneut starten.",
    };
  }
  const ctx = session.fetch_context;
  if (!ctx) {
    await db
      .delete(financeTanSession)
      .where(eq(financeTanSession.tan_reference, p.tanReference));
    return {
      state: "error",
      errorCode: "missing-fetch-context",
      errorMessage: "TAN-Session ohne Fetch-Kontext — bitte Sync erneut starten.",
    };
  }
  const info = session.banking_information as { fintsTanRef: string };

  const fetched = await resumeFetchAfterTan(cached, {
    tanReference: info.fintsTanRef,
    tan: p.tan,
    currentAccountNumber: ctx.currentAccountNumber,
    remainingAccountNumbers: ctx.remainingAccountNumbers,
  });
  const stats = await persistFetchResult(session.bankcontact_id, fetched);

  // Bank still wants TAN (wrong code or chained challenge) — refresh
  // the session with the new lib-fints reference + photo and prompt
  // again.
  if (fetched.pendingTan) {
    resetRateLimit(rateKey);
    await db
      .update(financeTanSession)
      .set({
        banking_information: { fintsTanRef: fetched.pendingTan.tanReference },
        challenge: fetched.pendingTan.tanChallenge ?? "",
        tan_media_name: fetched.pendingTan.tanMediaName ?? null,
        tan_photo_mime: fetched.pendingTan.tanPhotoMime ?? null,
        tan_photo_base64: fetched.pendingTan.tanPhotoBase64 ?? null,
        fetch_context: {
          currentAccountNumber: fetched.pendingTan.accountNumber,
          remainingAccountNumbers: fetched.pendingTan.remainingAccountNumbers,
          linkedAccountNumbers: ctx.linkedAccountNumbers,
        },
      })
      .where(eq(financeTanSession.tan_reference, p.tanReference));
    return {
      state: "tan-required",
      tanReference: p.tanReference,
      challenge: fetched.pendingTan.tanChallenge ?? "",
      tanMediaName: fetched.pendingTan.tanMediaName,
      tanPhotoMime: fetched.pendingTan.tanPhotoMime,
      tanPhotoBase64: fetched.pendingTan.tanPhotoBase64,
    };
  }

  // Done — drop session and report what was processed.
  resetRateLimit(rateKey);
  await db
    .delete(financeTanSession)
    .where(eq(financeTanSession.tan_reference, p.tanReference));

  console.log(
    `[finance.tan-sessions] resumed statements fetch for bankcontact=` +
      `${session.bankcontact_id}: tx=${stats.transactions_inserted} ` +
      `(${stats.transactions_skipped_duplicate} dup) ` +
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

