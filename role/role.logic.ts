import db from "../db/database";
import type {
  Role,
  RoleWithUsers,
  CreateRoleRequest,
  UpdateRoleRequest,
  ListRolesResponse,
  DeleteResponse,
  User,
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
  return { roles };
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
  const result = db.prepare(`DELETE FROM roles WHERE id = ?`).run(id);

  if (result.changes === 0) {
    throw new Error(`Role with id ${id} not found`);
  }

  return { success: true, message: `Role ${id} deleted` };
}

