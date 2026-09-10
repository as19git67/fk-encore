import { api, APIError } from "encore.dev/api";
import type {
  Role,
  RoleWithUsers,
  RoleWithPermissions,
  CreateRoleRequest,
  UpdateRoleRequest,
  ListRolesResponse,
  ListPermissionsResponse,
  AssignPermissionRequest,
  RolePermissionsResponse,
  DeleteResponse,
} from "../db/types";
import {
  createRoleLogic,
  getRoleLogic,
  listRolesLogic,
  updateRoleLogic,
  deleteRoleLogic,
  listPermissionsLogic,
  assignPermissionLogic,
  revokePermissionLogic,
} from "./role.service";
import { requirePermission } from "../user/auth-handler";
import { requireAdminToTouchAdminRole } from "../user/admin-guard";
import { getAuthData } from "~encore/auth";

/** Create a new role — requires roles.create */
export const createRole = api(
  { expose: true, auth: true, method: "POST", path: "/roles" },
  async (req: CreateRoleRequest): Promise<Role> => {
    requirePermission(getAuthData()!, "roles.create");
    try {
      return await createRoleLogic(req);
    } catch (err: any) {
      if (err.message?.includes("already exists")) {
        throw APIError.alreadyExists(err.message);
      }
      if (err.message?.includes("required")) {
        throw APIError.invalidArgument(err.message);
      }
      throw err;
    }
  }
);

/** Get a single role by ID — requires roles.read */
export const getRole = api(
  { expose: true, auth: true, method: "GET", path: "/roles/:id" },
  async ({ id }: { id: number }): Promise<RoleWithUsers> => {
    requirePermission(getAuthData()!, "roles.read");
    try {
      return await getRoleLogic(id);
    } catch (err: any) {
      if (err.message?.includes("not found")) {
        throw APIError.notFound(err.message);
      }
      throw err;
    }
  }
);

/** List all roles — requires roles.list */
export const listRoles = api(
  { expose: true, auth: true, method: "GET", path: "/roles" },
  async (): Promise<ListRolesResponse> => {
    requirePermission(getAuthData()!, "roles.list");
    return await listRolesLogic();
  }
);

/** Update an existing role — requires roles.update */
export const updateRole = api(
  { expose: true, auth: true, method: "PUT", path: "/roles/:id" },
  async (req: UpdateRoleRequest): Promise<Role> => {
    const authData = getAuthData()!;
    requirePermission(authData, "roles.update");
    await requireAdminToTouchAdminRole(
      Number(authData.userID),
      req.id,
      "rename the Admin role",
    );
    try {
      return await updateRoleLogic(req);
    } catch (err: any) {
      if (err.message?.includes("not found")) {
        throw APIError.notFound(err.message);
      }
      if (err.message?.includes("already exists")) {
        throw APIError.alreadyExists(err.message);
      }
      throw err;
    }
  }
);

/** Delete a role — requires roles.delete */
export const deleteRole = api(
  { expose: true, auth: true, method: "DELETE", path: "/roles/:id" },
  async ({ id }: { id: number }): Promise<DeleteResponse> => {
    const authData = getAuthData()!;
    requirePermission(authData, "roles.delete");
    await requireAdminToTouchAdminRole(
      Number(authData.userID),
      id,
      "delete the Admin role",
    );
    try {
      return await deleteRoleLogic(id);
    } catch (err: any) {
      if (err.message?.includes("not found")) {
        throw APIError.notFound(err.message);
      }
      if (err.message?.includes("Cannot delete")) {
        throw APIError.failedPrecondition(err.message);
      }
      throw err;
    }
  }
);

/** List all permissions — requires roles.read */
export const listPermissions = api(
  { expose: true, auth: true, method: "GET", path: "/permissions" },
  async (): Promise<ListPermissionsResponse> => {
    requirePermission(getAuthData()!, "roles.read");
    return await listPermissionsLogic();
  }
);

/** Assign a permission to a role — requires roles.update */
export const assignPermission = api(
  { expose: true, auth: true, method: "POST", path: "/roles/:roleId/permissions" },
  async (req: AssignPermissionRequest): Promise<RolePermissionsResponse> => {
    const authData = getAuthData()!;
    requirePermission(authData, "roles.update");
    // Stacking permissions onto other roles stays possible — see
    // admin-guard.ts on why that cannot be fixed by restriction. Editing
    // the Admin role's own set is a different matter.
    await requireAdminToTouchAdminRole(
      Number(authData.userID),
      req.roleId,
      "change the Admin role's permissions",
    );
    try {
      return await assignPermissionLogic(req.roleId, req.permissionId);
    } catch (err: any) {
      if (err.message?.includes("not found")) {
        throw APIError.notFound(err.message);
      }
      if (err.message?.includes("already assigned")) {
        throw APIError.alreadyExists(err.message);
      }
      throw err;
    }
  }
);

/** Revoke a permission from a role — requires roles.update */
export const revokePermission = api(
  { expose: true, auth: true, method: "DELETE", path: "/roles/:roleId/permissions/:permissionId" },
  async ({ roleId, permissionId }: { roleId: number; permissionId: number }): Promise<DeleteResponse> => {
    const authData = getAuthData()!;
    requirePermission(authData, "roles.update");
    await requireAdminToTouchAdminRole(
      Number(authData.userID),
      roleId,
      "change the Admin role's permissions",
    );
    try {
      return await revokePermissionLogic(roleId, permissionId);
    } catch (err: any) {
      if (err.message?.includes("does not exist")) {
        throw APIError.notFound(err.message);
      }
      throw err;
    }
  }
);

