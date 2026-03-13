import { eq, and, count } from "drizzle-orm";
import db from "../db/database";
import {
  users,
  roles,
  userRoles,
  permissions,
  rolePermissions,
} from "../db/schema";
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

export function getUsersForRole(roleId: number): User[] {
  return db
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
    .all()
    .map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      created_at: u.created_at ?? "",
      updated_at: u.updated_at ?? "",
    }));
}

export function getPermissionsForRole(roleId: number): Permission[] {
  return db
    .select({
      id: permissions.id,
      key: permissions.key,
      description: permissions.description,
    })
    .from(permissions)
    .innerJoin(rolePermissions, eq(rolePermissions.permission_id, permissions.id))
    .where(eq(rolePermissions.role_id, roleId))
    .orderBy(permissions.key)
    .all()
    .map((p) => ({ id: p.id, key: p.key, description: p.description ?? "" }));
}

// ---------- Business Logic ----------

export function createRoleLogic(req: CreateRoleRequest): Role {
  if (!req.name) {
    throw new Error("name is required");
  }

  const row = db
    .insert(roles)
    .values({ name: req.name, description: req.description ?? "" })
    .returning()
    .get();

  return { id: row.id, name: row.name, description: row.description ?? "" };
}

export function getRoleLogic(id: number): RoleWithUsers {
  const role = db.select().from(roles).where(eq(roles.id, id)).get();

  if (!role) {
    throw new Error(`Role with id ${id} not found`);
  }

  return {
    id: role.id,
    name: role.name,
    description: role.description ?? "",
    users: getUsersForRole(id),
  };
}

export function listRolesLogic(): ListRolesResponse {
  const allRoles = db.select().from(roles).orderBy(roles.id).all();
  return {
    roles: allRoles.map((role) => ({
      id: role.id,
      name: role.name,
      description: role.description ?? "",
      permissions: getPermissionsForRole(role.id),
    })),
  };
}

export function updateRoleLogic(req: UpdateRoleRequest): Role {
  const existing = db.select().from(roles).where(eq(roles.id, req.id)).get();

  if (!existing) {
    throw new Error(`Role with id ${req.id} not found`);
  }

  const newName = req.name ?? existing.name;
  const newDescription = req.description ?? existing.description;

  db.update(roles)
    .set({ name: newName, description: newDescription })
    .where(eq(roles.id, req.id))
    .run();

  const updated = db.select().from(roles).where(eq(roles.id, req.id)).get()!;
  return { id: updated.id, name: updated.name, description: updated.description ?? "" };
}

export function deleteRoleLogic(id: number): DeleteResponse {
  const role = db
    .select({ name: roles.name })
    .from(roles)
    .where(eq(roles.id, id))
    .get();

  if (!role) {
    throw new Error(`Role with id ${id} not found`);
  }

  if (role.name === "Admin") {
    const result = db
      .select({ count: count() })
      .from(userRoles)
      .where(eq(userRoles.role_id, id))
      .get();

    if (result && result.count > 0) {
      throw new Error("Cannot delete the Admin role while users are assigned to it");
    }
  }

  const result = db.delete(roles).where(eq(roles.id, id)).run();

  if (result.changes === 0) {
    throw new Error(`Role with id ${id} not found`);
  }

  return { success: true, message: `Role ${id} deleted` };
}

export function listPermissionsLogic(): ListPermissionsResponse {
  const allPerms = db.select().from(permissions).orderBy(permissions.key).all();
  return {
    permissions: allPerms.map((p) => ({
      id: p.id,
      key: p.key,
      description: p.description ?? "",
    })),
  };
}

export function assignPermissionLogic(roleId: number, permissionId: number): RolePermissionsResponse {
  const role = db.select({ id: roles.id }).from(roles).where(eq(roles.id, roleId)).get();
  if (!role) {
    throw new Error(`Role with id ${roleId} not found`);
  }

  const perm = db
    .select({ id: permissions.id })
    .from(permissions)
    .where(eq(permissions.id, permissionId))
    .get();
  if (!perm) {
    throw new Error(`Permission with id ${permissionId} not found`);
  }

  const existing = db
    .select({ role_id: rolePermissions.role_id })
    .from(rolePermissions)
    .where(
      and(
        eq(rolePermissions.role_id, roleId),
        eq(rolePermissions.permission_id, permissionId)
      )
    )
    .get();
  if (existing) {
    throw new Error("Permission already assigned to this role");
  }

  db.insert(rolePermissions)
    .values({ role_id: roleId, permission_id: permissionId })
    .run();

  return { roleId, permissions: getPermissionsForRole(roleId) };
}

export function revokePermissionLogic(roleId: number, permissionId: number): DeleteResponse {
  const result = db
    .delete(rolePermissions)
    .where(
      and(
        eq(rolePermissions.role_id, roleId),
        eq(rolePermissions.permission_id, permissionId)
      )
    )
    .run();

  if (result.changes === 0) {
    throw new Error("Permission assignment does not exist");
  }

  return { success: true, message: `Permission revoked from role ${roleId}` };
}
