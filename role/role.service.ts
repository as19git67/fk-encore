import { eq, and, count } from "drizzle-orm";
import db from "../db/database";
import {
  users,
  roles,
  userRoles,
  permissions,
  rolePermissions,
} from "../db/schema";
import { dbFirst, dbAll, dbExec, dbInsertReturning } from '../db/adapter';
import type {
  Role,
  RoleWithUsers,
  CreateRoleRequest,
  UpdateRoleRequest,
  ListRolesResponse,
  ListPermissionsResponse,
  DeleteResponse,
  User,
  Permission,
  RolePermissionsResponse,
} from "../db/types";

// ---------- Helpers ----------

export async function getUsersForRole(roleId: number): Promise<User[]> {
  const rows = await dbAll<{
    id: number;
    email: string;
    name: string;
    created_at: string | null;
    updated_at: string | null;
  }>(
    db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        created_at: users.created_at,
        updated_at: users.updated_at,
      })
      .from(users)
      .innerJoin(userRoles, eq(userRoles.user_id, users.id))
      .where(eq(userRoles.role_id, roleId))
  );
  return rows.map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    created_at: u.created_at ?? "",
    updated_at: u.updated_at ?? "",
  }));
}

export async function getPermissionsForRole(roleId: number): Promise<Permission[]> {
  const rows = await dbAll<{ id: number; key: string; description: string | null }>(
    db
      .select({
        id: permissions.id,
        key: permissions.key,
        description: permissions.description,
      })
      .from(permissions)
      .innerJoin(rolePermissions, eq(rolePermissions.permission_id, permissions.id))
      .where(eq(rolePermissions.role_id, roleId))
      .orderBy(permissions.key)
  );
  return rows.map((p) => ({ id: p.id, key: p.key, description: p.description ?? "" }));
}

// ---------- Business Logic ----------

export async function createRoleLogic(req: CreateRoleRequest): Promise<Role> {
  if (!req.name) {
    throw new Error("name is required");
  }

  const row = await dbInsertReturning<typeof roles.$inferSelect>(
    db
      .insert(roles)
      .values({ name: req.name, description: req.description ?? "" })
      .returning()
  );

  return { id: row!.id, name: row!.name, description: row!.description ?? "" };
}

export async function getRoleLogic(id: number): Promise<RoleWithUsers> {
  const role = await dbFirst<typeof roles.$inferSelect>(
    db.select().from(roles).where(eq(roles.id, id))
  );

  if (!role) {
    throw new Error(`Role with id ${id} not found`);
  }

  return {
    id: role.id,
    name: role.name,
    description: role.description ?? "",
    users: await getUsersForRole(id),
  };
}

export async function listRolesLogic(): Promise<ListRolesResponse> {
  const allRoles = await dbAll<typeof roles.$inferSelect>(
    db.select().from(roles).orderBy(roles.id)
  );
  const rolesWithPerms = await Promise.all(
    allRoles.map(async (role) => ({
      id: role.id,
      name: role.name,
      description: role.description ?? "",
      permissions: await getPermissionsForRole(role.id),
    }))
  );
  return { roles: rolesWithPerms };
}

export async function updateRoleLogic(req: UpdateRoleRequest): Promise<Role> {
  const existing = await dbFirst<typeof roles.$inferSelect>(
    db.select().from(roles).where(eq(roles.id, req.id))
  );

  if (!existing) {
    throw new Error(`Role with id ${req.id} not found`);
  }

  const newName = req.name ?? existing.name;
  const newDescription = req.description ?? existing.description;

  await dbExec(
    db.update(roles)
      .set({ name: newName, description: newDescription })
      .where(eq(roles.id, req.id))
  );

  const updated = (await dbFirst<typeof roles.$inferSelect>(
    db.select().from(roles).where(eq(roles.id, req.id))
  ))!;
  return { id: updated.id, name: updated.name, description: updated.description ?? "" };
}

export async function deleteRoleLogic(id: number): Promise<DeleteResponse> {
  const role = await dbFirst<{ name: string }>(
    db.select({ name: roles.name }).from(roles).where(eq(roles.id, id))
  );

  if (!role) {
    throw new Error(`Role with id ${id} not found`);
  }

  if (role.name === "Admin") {
    const result = await dbFirst<{ count: number }>(
      db
        .select({ count: count() })
        .from(userRoles)
        .where(eq(userRoles.role_id, id))
    );

    if (result && result.count > 0) {
      throw new Error("Cannot delete the Admin role while users are assigned to it");
    }
  }

  const result = await dbExec(db.delete(roles).where(eq(roles.id, id)));

  if (result.changes === 0) {
    throw new Error(`Role with id ${id} not found`);
  }

  return { success: true, message: `Role ${id} deleted` };
}

export async function listPermissionsLogic(): Promise<ListPermissionsResponse> {
  const allPerms = await dbAll<typeof permissions.$inferSelect>(
    db.select().from(permissions).orderBy(permissions.key)
  );
  return {
    permissions: allPerms.map((p) => ({
      id: p.id,
      key: p.key,
      description: p.description ?? "",
    })),
  };
}

export async function assignPermissionLogic(roleId: number, permissionId: number): Promise<RolePermissionsResponse> {
  const role = await dbFirst<{ id: number }>(
    db.select({ id: roles.id }).from(roles).where(eq(roles.id, roleId))
  );
  if (!role) {
    throw new Error(`Role with id ${roleId} not found`);
  }

  const perm = await dbFirst<{ id: number }>(
    db.select({ id: permissions.id }).from(permissions).where(eq(permissions.id, permissionId))
  );
  if (!perm) {
    throw new Error(`Permission with id ${permissionId} not found`);
  }

  const existing = await dbFirst<{ role_id: number }>(
    db
      .select({ role_id: rolePermissions.role_id })
      .from(rolePermissions)
      .where(
        and(
          eq(rolePermissions.role_id, roleId),
          eq(rolePermissions.permission_id, permissionId)
        )
      )
  );
  if (existing) {
    throw new Error("Permission already assigned to this role");
  }

  await dbExec(
    db.insert(rolePermissions).values({ role_id: roleId, permission_id: permissionId })
  );

  return { roleId, permissions: await getPermissionsForRole(roleId) };
}

export async function revokePermissionLogic(roleId: number, permissionId: number): Promise<DeleteResponse> {
  const result = await dbExec(
    db
      .delete(rolePermissions)
      .where(
        and(
          eq(rolePermissions.role_id, roleId),
          eq(rolePermissions.permission_id, permissionId)
        )
      )
  );

  if (result.changes === 0) {
    throw new Error("Permission assignment does not exist");
  }

  return { success: true, message: `Permission revoked from role ${roleId}` };
}
