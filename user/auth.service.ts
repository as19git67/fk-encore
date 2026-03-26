import crypto from "crypto";
import { compareSync } from "bcryptjs";
import { eq, and, lt, gt, sql } from "drizzle-orm";
import db from "../db/database";
import { users, sessions } from "../db/schema";
import { dbFirst, dbAll, dbExec, dbInsertReturning } from '../db/adapter';
import type {
  UserWithRolesAndPermissions,
  LoginRequest,
  LoginResponse,
  LogoutResponse,
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
