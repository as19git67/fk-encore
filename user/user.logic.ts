import { hashSync } from "bcryptjs";
import db from "../db/database";
import type {
  User,
  UserRow,
  UserWithRoles,
  CreateUserRequest,
  UpdateUserRequest,
  ListUsersResponse,
  DeleteResponse,
  Role,
} from "../db/types";

// ---------- Helpers ----------

export function toUser(row: UserRow): User {
  const { password_hash, ...user } = row;
  return user;
}

export function getRolesForUser(userId: number): Role[] {
  return db
    .prepare(
      `SELECT r.id, r.name, r.description
       FROM roles r
       JOIN user_roles ur ON ur.role_id = r.id
       WHERE ur.user_id = ?`
    )
    .all(userId) as Role[];
}

export function getPermissionsForUser(userId: number): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT p.key
       FROM permissions p
       JOIN role_permissions rp ON rp.permission_id = p.id
       JOIN user_roles ur ON ur.role_id = rp.role_id
       WHERE ur.user_id = ?
       ORDER BY p.key`
    )
    .all(userId) as { key: string }[];
  return rows.map((r) => r.key);
}

// ---------- Business Logic ----------

export function createUserLogic(req: CreateUserRequest): UserWithRoles {
  if (!req.email || !req.name || !req.password) {
    throw new Error("email, name and password are required");
  }

  const passwordHash = hashSync(req.password, 10);

  const result = db
    .prepare(`INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)`)
    .run(req.email, req.name, passwordHash);

  const row = db
    .prepare(`SELECT * FROM users WHERE id = ?`)
    .get(result.lastInsertRowid) as UserRow;

  return { ...toUser(row), roles: [] };
}

export function getUserLogic(id: number): UserWithRoles {
  const row = db
    .prepare(`SELECT * FROM users WHERE id = ?`)
    .get(id) as UserRow | undefined;

  if (!row) {
    throw new Error(`User with id ${id} not found`);
  }

  return { ...toUser(row), roles: getRolesForUser(id) };
}

export function listUsersLogic(): ListUsersResponse {
  const rows = db.prepare(`SELECT * FROM users ORDER BY id`).all() as UserRow[];
  return {
    users: rows.map((row) => ({
      ...toUser(row),
      roles: getRolesForUser(row.id),
    })),
  };
}

export function updateUserLogic(req: UpdateUserRequest): UserWithRoles {
  const existing = db
    .prepare(`SELECT * FROM users WHERE id = ?`)
    .get(req.id) as UserRow | undefined;

  if (!existing) {
    throw new Error(`User with id ${req.id} not found`);
  }

  const newEmail = req.email ?? existing.email;
  const newName = req.name ?? existing.name;
  const newHash = req.password
    ? hashSync(req.password, 10)
    : existing.password_hash;

  db.prepare(
    `UPDATE users SET email = ?, name = ?, password_hash = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(newEmail, newName, newHash, req.id);

  const updated = db
    .prepare(`SELECT * FROM users WHERE id = ?`)
    .get(req.id) as UserRow;

  return { ...toUser(updated), roles: getRolesForUser(req.id) };
}

export function deleteUserLogic(id: number): DeleteResponse {
  // Check if this user has the Admin role
  const roles = getRolesForUser(id);
  const isAdmin = roles.some((r) => r.name === "Admin");

  if (isAdmin) {
    // Count how many users have the Admin role
    const adminCount = db
      .prepare(
        `SELECT COUNT(*) as count FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
         WHERE r.name = 'Admin'`
      )
      .get() as { count: number };

    if (adminCount.count <= 1) {
      throw new Error("Cannot delete the last admin user");
    }
  }

  const result = db.prepare(`DELETE FROM users WHERE id = ?`).run(id);

  if (result.changes === 0) {
    throw new Error(`User with id ${id} not found`);
  }

  return { success: true, message: `User ${id} deleted` };
}
