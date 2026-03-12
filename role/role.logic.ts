import db from "../db/database";
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
    .prepare(
      `SELECT u.id, u.email, u.name, u.created_at, u.updated_at
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       WHERE ur.role_id = ?`
    )
    .all(roleId) as User[];
}

export function getPermissionsForRole(roleId: number): Permission[] {
  return db
    .prepare(
      `SELECT p.id, p.key, p.description
       FROM permissions p
       JOIN role_permissions rp ON rp.permission_id = p.id
       WHERE rp.role_id = ?
       ORDER BY p.key`
    )
    .all(roleId) as Permission[];
}

// ---------- Business Logic ----------

export function createRoleLogic(req: CreateRoleRequest): Role {
  if (!req.name) {
    throw new Error("name is required");
  }

  const result = db
    .prepare(`INSERT INTO roles (name, description) VALUES (?, ?)`)
    .run(req.name, req.description ?? "");

  return db
    .prepare(`SELECT * FROM roles WHERE id = ?`)
    .get(result.lastInsertRowid) as Role;
}

export function getRoleLogic(id: number): RoleWithUsers {
  const role = db
    .prepare(`SELECT * FROM roles WHERE id = ?`)
    .get(id) as Role | undefined;

  if (!role) {
    throw new Error(`Role with id ${id} not found`);
  }

  return { ...role, users: getUsersForRole(id) };
}

export function listRolesLogic(): ListRolesResponse {
  const roles = db.prepare(`SELECT * FROM roles ORDER BY id`).all() as Role[];
  return {
    roles: roles.map((role) => ({
      ...role,
      permissions: getPermissionsForRole(role.id),
    })),
  };
}

export function updateRoleLogic(req: UpdateRoleRequest): Role {
  const existing = db
    .prepare(`SELECT * FROM roles WHERE id = ?`)
    .get(req.id) as Role | undefined;

  if (!existing) {
    throw new Error(`Role with id ${req.id} not found`);
  }

  const newName = req.name ?? existing.name;
  const newDescription = req.description ?? existing.description;

  db.prepare(`UPDATE roles SET name = ?, description = ? WHERE id = ?`).run(
    newName,
    newDescription,
    req.id
  );

  return db.prepare(`SELECT * FROM roles WHERE id = ?`).get(req.id) as Role;
}

export function deleteRoleLogic(id: number): DeleteResponse {
  const role = db.prepare(`SELECT name FROM roles WHERE id = ?`).get(id) as { name: string } | undefined;

  if (!role) {
    throw new Error(`Role with id ${id} not found`);
  }

  if (role.name === "Admin") {
    const adminUserCount = db
      .prepare(
        `SELECT COUNT(*) as count FROM user_roles WHERE role_id = ?`
      )
      .get(id) as { count: number };

    if (adminUserCount.count > 0) {
      throw new Error("Cannot delete the Admin role while users are assigned to it");
    }
  }

  const result = db.prepare(`DELETE FROM roles WHERE id = ?`).run(id);

  if (result.changes === 0) {
    throw new Error(`Role with id ${id} not found`);
  }

  return { success: true, message: `Role ${id} deleted` };
}

export function listPermissionsLogic(): ListPermissionsResponse {
  const permissions = db
    .prepare(`SELECT * FROM permissions ORDER BY key`)
    .all() as Permission[];
  return { permissions };
}

export function assignPermissionLogic(roleId: number, permissionId: number): RolePermissionsResponse {
  const role = db.prepare(`SELECT id FROM roles WHERE id = ?`).get(roleId) as Role | undefined;
  if (!role) {
    throw new Error(`Role with id ${roleId} not found`);
  }

  const permission = db.prepare(`SELECT id FROM permissions WHERE id = ?`).get(permissionId) as Permission | undefined;
  if (!permission) {
    throw new Error(`Permission with id ${permissionId} not found`);
  }

  const existing = db
    .prepare(`SELECT 1 FROM role_permissions WHERE role_id = ? AND permission_id = ?`)
    .get(roleId, permissionId);
  if (existing) {
    throw new Error("Permission already assigned to this role");
  }

  db.prepare(`INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)`).run(roleId, permissionId);

  return { roleId, permissions: getPermissionsForRole(roleId) };
}

export function revokePermissionLogic(roleId: number, permissionId: number): DeleteResponse {
  const result = db
    .prepare(`DELETE FROM role_permissions WHERE role_id = ? AND permission_id = ?`)
    .run(roleId, permissionId);

  if (result.changes === 0) {
    throw new Error("Permission assignment does not exist");
  }

  return { success: true, message: `Permission revoked from role ${roleId}` };
}

