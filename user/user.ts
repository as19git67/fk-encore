import { api, APIError } from "encore.dev/api";
import type {
  UserWithRoles,
  CreateUserRequest,
  UpdateUserRequest,
  ListUsersResponse,
  DeleteResponse,
  ChangePasswordRequest,
} from "../db/types";
import {
  createUserLogic,
  getUserLogic,
  listUsersLogic,
  updateUserLogic,
  deleteUserLogic,
  changePasswordLogic,
  getUserIdsWithPermission,
} from "./user.service";
import { requirePermission } from "./auth-handler";
import { getAuthData } from "~encore/auth";

console.log("[boot] user/user.ts: all imports resolved");

/** Create a new user (Register) — no auth required */
export const createUser = api(
  { expose: true, method: "POST", path: "/users" },
  async (req: CreateUserRequest): Promise<UserWithRoles> => {
    try {
      return await createUserLogic(req);
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

/** Get a single user by ID (with roles) — requires users.read */
export const getUser = api(
  { expose: true, auth: true, method: "GET", path: "/users/:id" },
  async ({ id }: { id: number }): Promise<UserWithRoles> => {
    requirePermission(getAuthData()!, "users.read");
    try {
      return await getUserLogic(id);
    } catch (err: any) {
      if (err.message?.includes("not found")) {
        throw APIError.notFound(err.message);
      }
      throw err;
    }
  }
);

/** List all users — requires users.list */
export const listUsers = api(
  { expose: true, auth: true, method: "GET", path: "/users" },
  async (): Promise<ListUsersResponse> => {
    requirePermission(getAuthData()!, "users.list");
    return await listUsersLogic();
  }
);

/** Update an existing user — requires users.update */
export const updateUser = api(
  { expose: true, auth: true, method: "PUT", path: "/users/:id" },
  async (req: UpdateUserRequest): Promise<UserWithRoles> => {
    requirePermission(getAuthData()!, "users.update");
    try {
      return await updateUserLogic(req);
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

/** Change own password — only requires authentication */
export const changePassword = api(
  { expose: true, auth: true, method: "POST", path: "/auth/password" },
  async (req: ChangePasswordRequest): Promise<{ success: boolean }> => {
    const authData = getAuthData()!;
    try {
      await changePasswordLogic(Number(authData.userID), req.current_password, req.new_password);
      return { success: true };
    } catch (err: any) {
      if (err.message?.includes("incorrect")) {
        throw APIError.invalidArgument(err.message);
      }
      throw err;
    }
  }
);

/**
 * Internal: look up user ids that hold a given permission. Used by other
 * services (scan queue realtime fan-out, …) that need to address
 * permission-scoped audiences. Not exposed externally.
 */
export const listUserIdsWithPermission = api(
  { expose: false },
  async ({ permission }: { permission: string }): Promise<{ userIds: number[] }> => {
    const ids = await getUserIdsWithPermission(permission);
    return { userIds: ids };
  }
);

/** Delete a user — requires users.delete */
export const deleteUser = api(
  { expose: true, auth: true, method: "DELETE", path: "/users/:id" },
  async ({ id }: { id: number }): Promise<DeleteResponse> => {
    requirePermission(getAuthData()!, "users.delete");
    try {
      return await deleteUserLogic(id);
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
