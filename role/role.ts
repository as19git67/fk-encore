import { api, APIError } from "encore.dev/api";
import type {
  Role,
  RoleWithUsers,
  CreateRoleRequest,
  UpdateRoleRequest,
  ListRolesResponse,
  DeleteResponse,
} from "../db/types";
import {
  createRoleLogic,
  getRoleLogic,
  listRolesLogic,
  updateRoleLogic,
  deleteRoleLogic,
} from "./role.logic";
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
      throw err;
    }
  }
);
