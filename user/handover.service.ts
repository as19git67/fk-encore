/**
 * Handing a session to the web app (documentation/plans/assistent-ios.md,
 * stage 5).
 *
 * The iOS app opens web pages it has no screen for in an in-app browser. The
 * web app keeps its own session in the browser's storage and knows nothing of
 * the app's, and the app's bearer token must not travel in a URL: a URL ends
 * up in access logs and the browser's history. So the app asks here for a
 * handover token — random, good for a minute, usable once — and opens the web
 * app's `/handover` page with it in the URL fragment (which never reaches the
 * server). That page redeems the token for an ordinary session and goes on to
 * the page the row pointed at.
 *
 * Redeeming deletes the token in the same statement that reads it, so a
 * replay finds nothing, and a token that was never redeemed is swept with the
 * next one issued.
 */

import crypto from "crypto";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import db from "../db/database";
import { handoverTokens } from "../db/schema";
import { dbExec, dbFirst } from "../db/adapter";
import type { LoginResponse } from "../db/types";
import { createSessionTokens, currentUserLogic } from "./auth.service";

/** How long a handover token may wait to be redeemed. */
export const HANDOVER_TTL_MS = 60_000;

const nowSql = sql`NOW()`;

export interface HandoverToken {
  token: string;
  /** ISO-8601; after this the token is refused. */
  expiresAt: string;
}

export async function createHandoverLogic(userId: number): Promise<HandoverToken> {
  await dbExec(db.delete(handoverTokens).where(lt(handoverTokens.expires_at, nowSql)));
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + HANDOVER_TTL_MS).toISOString();
  await dbExec(db.insert(handoverTokens).values({ token, user_id: userId, expires_at: expiresAt }));
  return { token, expiresAt };
}

/** The session the token stands for, as a login would return it; the token is spent. */
export async function redeemHandoverLogic(token: string): Promise<LoginResponse> {
  if (!token || typeof token !== "string") {
    throw new Error("token is required");
  }
  const row = await dbFirst<{ user_id: number }>(
    db
      .delete(handoverTokens)
      .where(and(eq(handoverTokens.token, token), gt(handoverTokens.expires_at, nowSql)))
      .returning({ user_id: handoverTokens.user_id }),
  );
  if (!row) {
    throw new Error("invalid or expired handover token");
  }
  const user = await currentUserLogic(row.user_id);
  const session = await createSessionTokens(row.user_id);
  return { user, ...session };
}
