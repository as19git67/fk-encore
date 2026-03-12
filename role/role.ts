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

/** Create a new role — auth required */
export const createRole = api(
  { expose: true, auth: true, method: "POST", path: "/roles" },
  async (req: CreateRoleRequest): Promise<Role> => {
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

/** Get a single role by ID — auth required */
export const getRole = api(
  { expose: true, auth: true, method: "GET", path: "/roles/:id" },
  async ({ id }: { id: number }): Promise<RoleWithUsers> => {
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

/** List all roles — auth required */
export const listRoles = api(
  { expose: true, auth: true, method: "GET", path: "/roles" },
  async (): Promise<ListRolesResponse> => {
    return listRolesLogic();
  }
);

/** Update an existing role — auth required */
export const updateRole = api(
  { expose: true, auth: true, method: "PUT", path: "/roles/:id" },
  async (req: UpdateRoleRequest): Promise<Role> => {
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

/** Delete a role — auth required */
export const deleteRole = api(
  { expose: true, auth: true, method: "DELETE", path: "/roles/:id" },
  async ({ id }: { id: number }): Promise<DeleteResponse> => {
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
