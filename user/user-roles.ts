import { api, APIError } from "encore.dev/api";
import type {
  AssignRoleRequest,
  UserRolesResponse,
  DeleteResponse,
} from "../db/types";
import {
  assignRoleLogic,
  removeRoleLogic,
  getUserRolesLogic,
} from "./user-roles.logic";

/** Assign a role to a user — auth required */
export const assignRole = api(
  { expose: true, auth: true, method: "POST", path: "/users/:userId/roles" },
  async (req: AssignRoleRequest): Promise<UserRolesResponse> => {
    try {
      return assignRoleLogic(req);
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

/** Remove a role from a user — auth required */
export const removeRole = api(
  { expose: true, auth: true, method: "DELETE", path: "/users/:userId/roles/:roleId" },
  async ({ userId, roleId }: { userId: number; roleId: number }): Promise<DeleteResponse> => {
    try {
      return removeRoleLogic(userId, roleId);
    } catch (err: any) {
      if (err.message?.includes("does not exist")) {
        throw APIError.notFound(err.message);
      }
      throw err;
    }
  }
);

/** Get all roles for a user — auth required */
export const getUserRoles = api(
  { expose: true, auth: true, method: "GET", path: "/users/:userId/roles" },
  async ({ userId }: { userId: number }): Promise<UserRolesResponse> => {
    try {
      return getUserRolesLogic(userId);
    } catch (err: any) {
      if (err.message?.includes("not found")) {
        throw APIError.notFound(err.message);
      }
      throw err;
    }
  }
);
