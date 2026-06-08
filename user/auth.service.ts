import crypto from "crypto";
import { compareSync, hashSync } from "bcryptjs";
import { eq, and, lt, gt, sql } from "drizzle-orm";
import db from "../db/database";
import { users, sessions, refreshTokens, passwordResetTokens } from "../db/schema";
import { dbFirst, dbAll, dbExec, dbInsertReturning } from '../db/adapter';
import type {
  UserWithRolesAndPermissions,
  LoginRequest,
  LoginResponse,
  LogoutResponse,
  RefreshRequest,
  RefreshResponse,
  RequestPasswordResetRequest,
  RequestPasswordResetResponse,
  ResetPasswordRequest,
  ResetPasswordResponse,
} from "../db/types";
import { toUser, getRolesForUser, getPermissionsForUser } from "./user.service";
import { checkRateLimit, resetRateLimit, getClientIp } from "./rateLimiter";
import { sendPasswordResetEmail } from "./mail";

console.log("[boot] user/auth.service.ts: all imports resolved");

const nowSql = sql`NOW()`

// ---------- Token Lifetimes ----------

const ACCESS_TOKEN_TTL = 15 * 60 * 1000;          // 15 minutes
const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
const REFRESH_GRACE_PERIOD = 30 * 1000;            // 30 s — old refresh token stays valid to absorb multi-tab races

// ---------- Helpers ----------

async function cleanupExpiredSessions(): Promise<void> {
  await dbExec(
    db.delete(sessions).where(lt(sessions.expires_at, nowSql))
  );
}

async function cleanupExpiredRefreshTokens(): Promise<void> {
  await dbExec(
    db.delete(refreshTokens).where(lt(refreshTokens.expires_at, nowSql))
  );
}

/** Creates a short-lived access token + a long-lived refresh token for a user. */
export async function createSessionTokens(userId: number): Promise<{ token: string; refreshToken: string }> {
  const token = crypto.randomBytes(32).toString("base64url");
  const refresh = crypto.randomBytes(32).toString("base64url");

  await dbExec(
    db.insert(sessions).values({
      token,
      user_id: userId,
      expires_at: new Date(Date.now() + ACCESS_TOKEN_TTL).toISOString(),
    })
  );

  await dbExec(
    db.insert(refreshTokens).values({
      token: refresh,
      user_id: userId,
      expires_at: new Date(Date.now() + REFRESH_TOKEN_TTL).toISOString(),
    })
  );

  return { token, refreshToken: refresh };
}

// ---------- Business Logic ----------

export async function loginLogic(req: LoginRequest): Promise<LoginResponse> {
  const ip = getClientIp();
  checkRateLimit(ip);

  if (!req.email || !req.password) {
    throw new Error("email and password are required");
  }

  const row = await dbFirst<typeof users.$inferSelect>(
    db.select().from(users).where(eq(users.email, req.email))
  );

  if (!row) {
    throw new Error("invalid credentials");
  }

  const valid = compareSync(req.password, row.password_hash);
  if (!valid) {
    throw new Error("invalid credentials");
  }

  resetRateLimit(ip);

  // Cleanup expired tokens
  await cleanupExpiredSessions();
  await cleanupExpiredRefreshTokens();

  const { token, refreshToken } = await createSessionTokens(row.id);

  const user: UserWithRolesAndPermissions = {
    ...toUser(row),
    roles: await getRolesForUser(row.id),
    permissions: await getPermissionsForUser(row.id),
  };

  return { user, token, refreshToken };
}

export async function logoutLogic(token: string, refreshToken?: string): Promise<LogoutResponse> {
  await dbExec(db.delete(sessions).where(eq(sessions.token, token)));
  if (refreshToken) {
    await dbExec(db.delete(refreshTokens).where(eq(refreshTokens.token, refreshToken)));
  }
  return { success: true, message: "Logged out successfully" };
}

export async function refreshTokenLogic(req: RefreshRequest): Promise<RefreshResponse> {
  const row = await dbFirst<{ token: string; user_id: number }>(
    db
      .select({ token: refreshTokens.token, user_id: refreshTokens.user_id })
      .from(refreshTokens)
      .where(
        and(
          eq(refreshTokens.token, req.refreshToken),
          gt(refreshTokens.expires_at, nowSql)
        )
      )
  );

  if (!row) {
    throw new Error("invalid or expired refresh token");
  }

  // Rotate: expire the old refresh token after a short grace period
  // instead of deleting it immediately. This absorbs race conditions
  // when multiple browser tabs hit 401 at the same time and both try
  // to refresh with the same token.
  await dbExec(
    db.update(refreshTokens)
      .set({ expires_at: new Date(Date.now() + REFRESH_GRACE_PERIOD).toISOString() })
      .where(eq(refreshTokens.token, req.refreshToken))
  );

  // Create new token pair
  const { token, refreshToken } = await createSessionTokens(row.user_id);

  const userRow = await dbFirst<typeof users.$inferSelect>(
    db.select().from(users).where(eq(users.id, row.user_id))
  );

  if (!userRow) {
    throw new Error("user not found");
  }

  const user: UserWithRolesAndPermissions = {
    ...toUser(userRow),
    roles: await getRolesForUser(userRow.id),
    permissions: await getPermissionsForUser(userRow.id),
  };

  return { token, refreshToken, user };
}

export async function validateToken(token: string): Promise<{ userID: string; permissions: string[] }> {
  const session = await dbFirst<{ user_id: number }>(
    db
      .select({ user_id: sessions.user_id })
      .from(sessions)
      .where(
        and(
          eq(sessions.token, token),
          gt(sessions.expires_at, nowSql)
        )
      )
  );

  if (!session) {
    throw new Error("invalid or expired token");
  }

  const perms = await getPermissionsForUser(session.user_id);
  return { userID: String(session.user_id), permissions: perms };
}

// ---------- Password Reset ----------

export async function requestPasswordResetLogic(req: RequestPasswordResetRequest): Promise<RequestPasswordResetResponse> {
  if (!req.email) {
    throw new Error("email is required");
  }

  const user = await dbFirst<typeof users.$inferSelect>(
    db.select().from(users).where(eq(users.email, req.email))
  );

  // Always return success to prevent email enumeration
  if (!user) {
    return { success: true, message: "Falls ein Konto mit dieser E-Mail existiert, wurde ein Zurücksetzungslink erstellt." };
  }

  // Clean up expired reset tokens
  await dbExec(
    db.delete(passwordResetTokens).where(lt(passwordResetTokens.expires_at, nowSql))
  );

  // Generate token (1 hour expiry)
  const token = crypto.randomBytes(32).toString("base64url");
  await dbExec(
    db.insert(passwordResetTokens).values({
      token,
      user_id: user.id,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    })
  );

  // Send the reset email (falls back to console.warn if SMTP not configured)
  await sendPasswordResetEmail(user.email, token);

  return { success: true, message: "Falls ein Konto mit dieser E-Mail existiert, wurde ein Zurücksetzungslink erstellt." };
}

export async function resetPasswordLogic(req: ResetPasswordRequest): Promise<ResetPasswordResponse> {
  if (!req.token || !req.new_password) {
    throw new Error("token and new_password are required");
  }

  if (req.new_password.length < 6) {
    throw new Error("password must be at least 6 characters");
  }

  const resetToken = await dbFirst<{ token: string; user_id: number; expires_at: string }>(
    db.select()
      .from(passwordResetTokens)
      .where(
        and(
          eq(passwordResetTokens.token, req.token),
          gt(passwordResetTokens.expires_at, nowSql)
        )
      )
  );

  if (!resetToken) {
    throw new Error("invalid or expired reset token");
  }

  // Update password
  const newHash = hashSync(req.new_password, 10);
  await dbExec(
    db.update(users)
      .set({ password_hash: newHash, updated_at: new Date().toISOString() })
      .where(eq(users.id, resetToken.user_id))
  );

  // Delete the used token and any other tokens for this user
  await dbExec(
    db.delete(passwordResetTokens).where(eq(passwordResetTokens.user_id, resetToken.user_id))
  );

  return { success: true, message: "Passwort wurde erfolgreich zurückgesetzt." };
}
