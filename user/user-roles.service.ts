import { eq, and, count } from "drizzle-orm";
import db from "../db/database";
import { users, roles, userRoles } from "../db/schema";
import { dbFirst, dbAll, dbExec } from '../db/adapter';
import type {
  Role,
  AssignRoleRequest,
  UserRolesResponse,
  DeleteResponse,
} from "../db/types";

export async function assignRoleLogic(req: AssignRoleRequest): Promise<UserRolesResponse> {
  const user = await dbFirst<{ id: number }>(
    db.select({ id: users.id }).from(users).where(eq(users.id, req.userId))
  );
  if (!user) {
    throw new Error(`User with id ${req.userId} not found`);
  }

  const role = await dbFirst<{ id: number }>(
    db.select({ id: roles.id }).from(roles).where(eq(roles.id, req.roleId))
  );
  if (!role) {
    throw new Error(`Role with id ${req.roleId} not found`);
  }

  await dbExec(
    db.insert(userRoles).values({ user_id: req.userId, role_id: req.roleId })
  );

  const assignedRoles = await dbAll<{ id: number; name: string; description: string | null }>(
    db
      .select({
        id: roles.id,
        name: roles.name,
        description: roles.description,
      })
      .from(roles)
      .innerJoin(userRoles, eq(userRoles.role_id, roles.id))
      .where(eq(userRoles.user_id, req.userId))
  );

  return {
    userId: req.userId,
    roles: assignedRoles.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description ?? "",
    })),
  };
}

export async function removeRoleLogic(userId: number, roleId: number): Promise<DeleteResponse> {
  // Check if this is the Admin role
  const role = await dbFirst<{ name: string }>(
    db.select({ name: roles.name }).from(roles).where(eq(roles.id, roleId))
  );

  if (role?.name === "Admin") {
    const result = await dbFirst<{ count: number }>(
      db
        .select({ count: count() })
        .from(userRoles)
        .innerJoin(roles, eq(roles.id, userRoles.role_id))
        .where(eq(roles.name, "Admin"))
    );

    if (result && result.count <= 1) {
      throw new Error("Cannot remove the Admin role from the last admin user");
    }
  }

  const result = await dbExec(
    db
      .delete(userRoles)
      .where(and(eq(userRoles.user_id, userId), eq(userRoles.role_id, roleId)))
  );

  if (result.changes === 0) {
    throw new Error("This role assignment does not exist");
  }

  return {
    success: true,
    message: `Role ${roleId} removed from user ${userId}`,
  };
}

export async function getUserRolesLogic(userId: number): Promise<UserRolesResponse> {
  const user = await dbFirst<{ id: number }>(
    db.select({ id: users.id }).from(users).where(eq(users.id, userId))
  );
  if (!user) {
    throw new Error(`User with id ${userId} not found`);
  }

  const assignedRoles = await dbAll<{ id: number; name: string; description: string | null }>(
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

  return {
    userId,
    roles: assignedRoles.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description ?? "",
    })),
  };
}
