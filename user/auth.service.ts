import crypto from "crypto";
import { compareSync, hashSync } from "bcryptjs";
import { eq, and, lt, gt, sql } from "drizzle-orm";
import db from "../db/database";
import { users, sessions, passwordResetTokens } from "../db/schema";
import { dbFirst, dbAll, dbExec, dbInsertReturning } from '../db/adapter';
import type {
  UserWithRolesAndPermissions,
  LoginRequest,
  LoginResponse,
  LogoutResponse,
  RequestPasswordResetRequest,
  RequestPasswordResetResponse,
  ResetPasswordRequest,
  ResetPasswordResponse,
} from "../db/types";
import { toUser, getRolesForUser, getPermissionsForUser } from "./user.service";
import { checkRateLimit, resetRateLimit, getClientIp } from "./rateLimiter";

const nowSql = sql`NOW()`

// ---------- Helpers ----------

async function cleanupExpiredSessions(): Promise<void> {
  await dbExec(
    db.delete(sessions).where(lt(sessions.expires_at, nowSql))
  );
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

  // Cleanup expired sessions
  await cleanupExpiredSessions();

  // Generate opaque token
  const token = crypto.randomBytes(32).toString("base64url");

  await dbExec(
    db.insert(sessions).values({
      token,
      user_id: row.id,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    })
  );

  const user: UserWithRolesAndPermissions = {
    ...toUser(row),
    roles: await getRolesForUser(row.id),
    permissions: await getPermissionsForUser(row.id),
  };

  return { user, token };
}

export async function logoutLogic(token: string): Promise<LogoutResponse> {
  await dbExec(db.delete(sessions).where(eq(sessions.token, token)));
  return { success: true, message: "Logged out successfully" };
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

  // In a production app, send an email with the reset link here.
  // For now, we log the token to the console for development.
  console.log(`[Password Reset] Token for ${user.email}: ${token}`);

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
