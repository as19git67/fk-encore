import { eq, and, count } from "drizzle-orm";
import db from "../db/database";
import { users, roles, userRoles } from "../db/schema";
import type {
  Role,
  AssignRoleRequest,
  UserRolesResponse,
  DeleteResponse,
} from "../db/types";

export function assignRoleLogic(req: AssignRoleRequest): UserRolesResponse {
  const user = db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, req.userId))
    .get();
  if (!user) {
    throw new Error(`User with id ${req.userId} not found`);
  }

  const role = db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.id, req.roleId))
    .get();
  if (!role) {
    throw new Error(`Role with id ${req.roleId} not found`);
  }

  db.insert(userRoles)
    .values({ user_id: req.userId, role_id: req.roleId })
    .run();

  const assignedRoles = db
    .select({
      id: roles.id,
      name: roles.name,
      description: roles.description,
    })
    .from(roles)
    .innerJoin(userRoles, eq(userRoles.role_id, roles.id))
    .where(eq(userRoles.user_id, req.userId))
    .all()
    .map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description ?? "",
    }));

  return { userId: req.userId, roles: assignedRoles };
}

export function removeRoleLogic(userId: number, roleId: number): DeleteResponse {
  // Check if this is the Admin role
  const role = db
    .select({ name: roles.name })
    .from(roles)
    .where(eq(roles.id, roleId))
    .get();

  if (role?.name === "Admin") {
    const result = db
      .select({ count: count() })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.role_id))
      .where(eq(roles.name, "Admin"))
      .get();

    if (result && result.count <= 1) {
      throw new Error("Cannot remove the Admin role from the last admin user");
    }
  }

  const result = db
    .delete(userRoles)
    .where(and(eq(userRoles.user_id, userId), eq(userRoles.role_id, roleId)))
    .run();

  if (result.changes === 0) {
    throw new Error("This role assignment does not exist");
  }

  return {
    success: true,
    message: `Role ${roleId} removed from user ${userId}`,
  };
}

export function getUserRolesLogic(userId: number): UserRolesResponse {
  const user = db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  if (!user) {
    throw new Error(`User with id ${userId} not found`);
  }

  const assignedRoles = db
    .select({
      id: roles.id,
      name: roles.name,
      description: roles.description,
    })
    .from(roles)
    .innerJoin(userRoles, eq(userRoles.role_id, roles.id))
    .where(eq(userRoles.user_id, userId))
    .all()
    .map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description ?? "",
    }));

  return { userId, roles: assignedRoles };
}
