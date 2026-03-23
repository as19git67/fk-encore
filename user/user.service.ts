import { hashSync, compareSync } from "bcryptjs";
import { eq, sql, count } from "drizzle-orm";
import db from "../db/database";
import { users, roles, userRoles, permissions, rolePermissions } from "../db/schema";
import { dbFirst, dbAll, dbExec, dbInsertReturning } from '../db/adapter';
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

export async function getRolesForUser(userId: number): Promise<Role[]> {
  const rows = await dbAll<{ id: number; name: string; description: string | null }>(
    db
      .select({
        id: roles.id,
        name: roles.name,
        description: roles.description,
      })
      .from(roles)
      .innerJoin(userRoles, eq(userRoles.role_id, roles.id))
      .where(eq(userRoles.user_id, userId))
  );
  return rows.map((r) => ({ id: r.id, name: r.name, description: r.description ?? "" }));
}

export async function getPermissionsForUser(userId: number): Promise<string[]> {
  const rows = await dbAll<{ key: string }>(
    db
      .selectDistinct({ key: permissions.key })
      .from(permissions)
      .innerJoin(rolePermissions, eq(rolePermissions.permission_id, permissions.id))
      .innerJoin(userRoles, eq(userRoles.role_id, rolePermissions.role_id))
      .where(eq(userRoles.user_id, userId))
      .orderBy(permissions.key)
  );
  return rows.map((r) => r.key);
}

// ---------- Business Logic ----------

export async function createUserLogic(req: CreateUserRequest): Promise<UserWithRoles> {
  if (!req.email || !req.name || !req.password) {
    throw new Error("email, name and password are required");
  }

  const passwordHash = hashSync(req.password, 10);

  const row = await dbInsertReturning<typeof users.$inferSelect>(
    db
      .insert(users)
      .values({ email: req.email, name: req.name, password_hash: passwordHash })
      .returning()
  );

  return { ...toUser(row!), roles: [] };
}

export async function getUserLogic(id: number): Promise<UserWithRoles> {
  const row = await dbFirst<typeof users.$inferSelect>(
    db.select().from(users).where(eq(users.id, id))
  );

  if (!row) {
    throw new Error(`User with id ${id} not found`);
  }

  return { ...toUser(row), roles: await getRolesForUser(id) };
}

export async function listUsersLogic(): Promise<ListUsersResponse> {
  const rows = await dbAll<typeof users.$inferSelect>(
    db.select().from(users).orderBy(users.id)
  );
  const usersWithRoles = await Promise.all(
    rows.map(async (row) => ({
      ...toUser(row),
      roles: await getRolesForUser(row.id),
    }))
  );
  return { users: usersWithRoles };
}

export async function updateUserLogic(req: UpdateUserRequest): Promise<UserWithRoles> {
  const existing = await dbFirst<typeof users.$inferSelect>(
    db.select().from(users).where(eq(users.id, req.id))
  );

  if (!existing) {
    throw new Error(`User with id ${req.id} not found`);
  }

  const newEmail = req.email ?? existing.email;
  const newName = req.name ?? existing.name;
  const newHash = req.password
    ? hashSync(req.password, 10)
    : existing.password_hash;

  await dbExec(
    db.update(users)
      .set({
        email: newEmail,
        name: newName,
        password_hash: newHash,
        updated_at: new Date().toISOString(),
      })
      .where(eq(users.id, req.id))
  );

  const updated = (await dbFirst<typeof users.$inferSelect>(
    db.select().from(users).where(eq(users.id, req.id))
  ))!;

  return { ...toUser(updated), roles: await getRolesForUser(req.id) };
}

export async function changePasswordLogic(userId: number, currentPassword: string, newPassword: string): Promise<void> {
  const row = await dbFirst<typeof users.$inferSelect>(
    db.select().from(users).where(eq(users.id, userId))
  );

  if (!row) {
    throw new Error(`User not found`);
  }

  if (!compareSync(currentPassword, row.password_hash)) {
    throw new Error("Current password is incorrect");
  }

  await dbExec(
    db.update(users)
      .set({ password_hash: hashSync(newPassword, 10), updated_at: new Date().toISOString() })
      .where(eq(users.id, userId))
  );
}

export async function deleteUserLogic(id: number): Promise<DeleteResponse> {
  // Check if this user has the Admin role
  const userRolesList = await getRolesForUser(id);
  const isAdmin = userRolesList.some((r) => r.name === "Admin");

  if (isAdmin) {
    // Count how many users have the Admin role
    const result = await dbFirst<{ count: number }>(
      db
        .select({ count: count() })
        .from(userRoles)
        .innerJoin(roles, eq(roles.id, userRoles.role_id))
        .where(eq(roles.name, "Admin"))
    );

    if (result && result.count <= 1) {
      throw new Error("Cannot delete the last admin user");
    }
  }

  const result = await dbExec(db.delete(users).where(eq(users.id, id)));

  if (result.changes === 0) {
    throw new Error(`User with id ${id} not found`);
  }

  return { success: true, message: `User ${id} deleted` };
}
