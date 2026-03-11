import db from "../db/database";
import type {
  Role,
  AssignRoleRequest,
  UserRolesResponse,
  DeleteResponse,
} from "../db/types";

export function assignRoleLogic(req: AssignRoleRequest): UserRolesResponse {
  const user = db.prepare(`SELECT id FROM users WHERE id = ?`).get(req.userId);
  if (!user) {
    throw new Error(`User with id ${req.userId} not found`);
  }

  const role = db.prepare(`SELECT id FROM roles WHERE id = ?`).get(req.roleId);
  if (!role) {
    throw new Error(`Role with id ${req.roleId} not found`);
  }

  db.prepare(`INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)`).run(
    req.userId,
    req.roleId
  );

  const roles = db
    .prepare(
      `SELECT r.id, r.name, r.description
       FROM roles r
       JOIN user_roles ur ON ur.role_id = r.id
       WHERE ur.user_id = ?`
    )
    .all(req.userId) as Role[];

  return { userId: req.userId, roles };
}

export function removeRoleLogic(userId: number, roleId: number): DeleteResponse {
  const result = db
    .prepare(`DELETE FROM user_roles WHERE user_id = ? AND role_id = ?`)
    .run(userId, roleId);

  if (result.changes === 0) {
    throw new Error("This role assignment does not exist");
  }

  return { success: true, message: `Role ${roleId} removed from user ${userId}` };
}

export function getUserRolesLogic(userId: number): UserRolesResponse {
  const user = db.prepare(`SELECT id FROM users WHERE id = ?`).get(userId);
  if (!user) {
    throw new Error(`User with id ${userId} not found`);
  }

  const roles = db
    .prepare(
      `SELECT r.id, r.name, r.description
       FROM roles r
       JOIN user_roles ur ON ur.role_id = r.id
       WHERE ur.user_id = ?`
    )
    .all(userId) as Role[];

  return { userId, roles };
}

