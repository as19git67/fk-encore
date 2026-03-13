import { hashSync } from "bcryptjs";
import { eq, sql, count } from "drizzle-orm";
import db from "../db/database";
import { users, roles, userRoles, permissions, rolePermissions } from "../db/schema";
import type {
  User,
  UserWithRoles,
  CreateUserRequest,
  UpdateUserRequest,
  ListUsersResponse,
  DeleteResponse,
  Role,
} from "../db/types";

// ---------- Helpers ----------

export function toUser(row: typeof users.$inferSelect): User {
  const { password_hash, ...user } = row;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    created_at: user.created_at ?? "",
    updated_at: user.updated_at ?? "",
  };
}

export function getRolesForUser(userId: number): Role[] {
  return db
    .select({
      id: roles.id,
      name: roles.name,
      description: roles.description,
    })
    .from(roles)
    .innerJoin(userRoles, eq(userRoles.role_id, roles.id))
    .where(eq(userRoles.user_id, userId))
    .all()
    .map((r) => ({ id: r.id, name: r.name, description: r.description ?? "" }));
}

export function getPermissionsForUser(userId: number): string[] {
  const rows = db
    .selectDistinct({ key: permissions.key })
    .from(permissions)
    .innerJoin(rolePermissions, eq(rolePermissions.permission_id, permissions.id))
    .innerJoin(userRoles, eq(userRoles.role_id, rolePermissions.role_id))
    .where(eq(userRoles.user_id, userId))
    .orderBy(permissions.key)
    .all();
  return rows.map((r) => r.key);
}

// ---------- Business Logic ----------

export function createUserLogic(req: CreateUserRequest): UserWithRoles {
  if (!req.email || !req.name || !req.password) {
    throw new Error("email, name and password are required");
  }

  const passwordHash = hashSync(req.password, 10);

  const row = db
    .insert(users)
    .values({ email: req.email, name: req.name, password_hash: passwordHash })
    .returning()
    .get();

  return { ...toUser(row), roles: [] };
}

export function getUserLogic(id: number): UserWithRoles {
  const row = db
    .select()
    .from(users)
    .where(eq(users.id, id))
    .get();

  if (!row) {
    throw new Error(`User with id ${id} not found`);
  }

  return { ...toUser(row), roles: getRolesForUser(id) };
}

export function listUsersLogic(): ListUsersResponse {
  const rows = db.select().from(users).orderBy(users.id).all();
  return {
    users: rows.map((row) => ({
      ...toUser(row),
      roles: getRolesForUser(row.id),
    })),
  };
}

export function updateUserLogic(req: UpdateUserRequest): UserWithRoles {
  const existing = db
    .select()
    .from(users)
    .where(eq(users.id, req.id))
    .get();

  if (!existing) {
    throw new Error(`User with id ${req.id} not found`);
  }

  const newEmail = req.email ?? existing.email;
  const newName = req.name ?? existing.name;
  const newHash = req.password
    ? hashSync(req.password, 10)
    : existing.password_hash;

  db.update(users)
    .set({
      email: newEmail,
      name: newName,
      password_hash: newHash,
      updated_at: sql`datetime('now')`,
    })
    .where(eq(users.id, req.id))
    .run();

  const updated = db.select().from(users).where(eq(users.id, req.id)).get()!;

  return { ...toUser(updated), roles: getRolesForUser(req.id) };
}

export function deleteUserLogic(id: number): DeleteResponse {
  // Check if this user has the Admin role
  const userRolesList = getRolesForUser(id);
  const isAdmin = userRolesList.some((r) => r.name === "Admin");

  if (isAdmin) {
    // Count how many users have the Admin role
    const result = db
      .select({ count: count() })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.role_id))
      .where(eq(roles.name, "Admin"))
      .get();

    if (result && result.count <= 1) {
      throw new Error("Cannot delete the last admin user");
    }
  }

  const result = db.delete(users).where(eq(users.id, id)).run();

  if (result.changes === 0) {
    throw new Error(`User with id ${id} not found`);
  }

  return { success: true, message: `User ${id} deleted` };
}
