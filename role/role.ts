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
import { getAuthData } from "~encore/auth";

/** Create a new role — requires roles.create */
export const createRole = api(
  { expose: true, auth: true, method: "POST", path: "/roles" },
  async (req: CreateRoleRequest): Promise<Role> => {
    requirePermission(getAuthData()!, "roles.create");
    try {
      return createRoleLogic(req);
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
      return getRoleLogic(id);
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
    return listRolesLogic();
  }
);

/** Update an existing role — requires roles.update */
export const updateRole = api(
  { expose: true, auth: true, method: "PUT", path: "/roles/:id" },
  async (req: UpdateRoleRequest): Promise<Role> => {
    requirePermission(getAuthData()!, "roles.update");
    try {
      return updateRoleLogic(req);
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
    requirePermission(getAuthData()!, "roles.delete");
    try {
      return deleteRoleLogic(id);
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
    return listPermissionsLogic();
  }
);

/** Assign a permission to a role — requires roles.update */
export const assignPermission = api(
  { expose: true, auth: true, method: "POST", path: "/roles/:roleId/permissions" },
  async (req: AssignPermissionRequest): Promise<RolePermissionsResponse> => {
    requirePermission(getAuthData()!, "roles.update");
    try {
      return assignPermissionLogic(req.roleId, req.permissionId);
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
    requirePermission(getAuthData()!, "roles.update");
    try {
      return revokePermissionLogic(roleId, permissionId);
    } catch (err: any) {
      if (err.message?.includes("does not exist")) {
        throw APIError.notFound(err.message);
      }
      throw err;
    }
  }
);

