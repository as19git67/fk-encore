import crypto from "crypto";
import { compareSync } from "bcryptjs";
import db from "../db/database";
import type {
  UserRow,
  UserWithRolesAndPermissions,
  LoginRequest,
  LoginResponse,
  LogoutResponse,
} from "../db/types";
import { toUser, getRolesForUser, getPermissionsForUser } from "./user.service";

// ---------- Helpers ----------

function cleanupExpiredSessions(): void {
  db.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`).run();
}

// ---------- Business Logic ----------

export function loginLogic(req: LoginRequest): LoginResponse {
  if (!req.email || !req.password) {
    throw new Error("email and password are required");
  }

  const row = db
    .prepare(`SELECT * FROM users WHERE email = ?`)
    .get(req.email) as UserRow | undefined;

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

  db.prepare(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+24 hours'))`
  ).run(token, row.id);

  const user: UserWithRolesAndPermissions = {
    ...toUser(row),
    roles: getRolesForUser(row.id),
    permissions: getPermissionsForUser(row.id),
  };

  return { user, token };
}

export function logoutLogic(token: string): LogoutResponse {
  db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
  return { success: true, message: "Logged out successfully" };
}

export function validateToken(token: string): { userID: string; permissions: string[] } {
  const session = db
    .prepare(
      `SELECT user_id FROM sessions WHERE token = ? AND expires_at > datetime('now')`
    )
    .get(token) as { user_id: number } | undefined;

  if (!session) {
    throw new Error("invalid or expired token");
  }

  const permissions = getPermissionsForUser(session.user_id);
  return { userID: String(session.user_id), permissions };
}
