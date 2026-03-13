import crypto from "crypto";
import { compareSync } from "bcryptjs";
import { eq, and, lt, gt, sql } from "drizzle-orm";
import db from "../db/database";
import { users, sessions } from "../db/schema";
import type {
  UserWithRolesAndPermissions,
  LoginRequest,
  LoginResponse,
  LogoutResponse,
} from "../db/types";
import { toUser, getRolesForUser, getPermissionsForUser } from "./user.service";

// ---------- Helpers ----------

function cleanupExpiredSessions(): void {
  db.delete(sessions)
    .where(lt(sessions.expires_at, sql`datetime('now')`))
    .run();
}

// ---------- Business Logic ----------

export function loginLogic(req: LoginRequest): LoginResponse {
  if (!req.email || !req.password) {
    throw new Error("email and password are required");
  }

  const row = db
    .select()
    .from(users)
    .where(eq(users.email, req.email))
    .get();

  if (!row) {
    throw new Error("invalid credentials");
  }

  const valid = compareSync(req.password, row.password_hash);
  if (!valid) {
    throw new Error("invalid credentials");
  }

  // Cleanup expired sessions
  cleanupExpiredSessions();

  // Generate opaque token
  const token = crypto.randomBytes(32).toString("base64url");

  db.insert(sessions)
    .values({
      token,
      user_id: row.id,
      expires_at: sql`datetime('now', '+24 hours')`,
    })
    .run();

  const user: UserWithRolesAndPermissions = {
    ...toUser(row),
    roles: getRolesForUser(row.id),
    permissions: getPermissionsForUser(row.id),
  };

  return { user, token };
}

export function logoutLogic(token: string): LogoutResponse {
  db.delete(sessions).where(eq(sessions.token, token)).run();
  return { success: true, message: "Logged out successfully" };
}

export function validateToken(token: string): { userID: string; permissions: string[] } {
  const session = db
    .select({ user_id: sessions.user_id })
    .from(sessions)
    .where(
      and(
        eq(sessions.token, token),
        gt(sessions.expires_at, sql`datetime('now')`)
      )
    )
    .get();

  if (!session) {
    throw new Error("invalid or expired token");
  }

  const perms = getPermissionsForUser(session.user_id);
  return { userID: String(session.user_id), permissions: perms };
}
