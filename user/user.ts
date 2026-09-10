import { api, APIError } from "encore.dev/api";
import type {
  UserWithRoles,
  AcceptInviteRequest,
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
import { requireAdminToTouchAdminUser } from "./admin-guard";
import { getAuthData } from "~encore/auth";
import { passwordPolicyError } from "./password-policy";
import { consumeInviteLogic } from "./invite.service";

console.log("[boot] user/user.ts: all imports resolved");

/**
 * Redeem an invitation and create the account it was issued for.
 *
 * Unauthenticated, because the person doing it has no account yet — but no
 * longer open: this used to accept anyone who could reach the app, which
 * made it an account factory and made every
 * authenticated-but-unauthorized gap elsewhere anonymously reachable. The
 * gate is the token, mailed by somebody holding `users.create`.
 *
 * The address is not taken from the request. It comes out of the invite
 * row, so a token issued for one person cannot be used to register another.
 * Redeeming is what marks the invite spent, in the same statement that
 * reads it, so two submissions of the same link create one account.
 *
 * No roles are attached here, deliberately — see invite.service.ts.
 */
export const createUser = api(
  { expose: true, method: "POST", path: "/users" },
  async (req: AcceptInviteRequest): Promise<UserWithRoles> => {
    const policyError = passwordPolicyError(req.password);
    if (policyError) throw APIError.invalidArgument(policyError);

    if (!req.name?.trim()) {
      throw APIError.invalidArgument("name is required");
    }

    let email: string;
    try {
      ({ email } = await consumeInviteLogic(req.invite));
    } catch {
      throw APIError.permissionDenied(
        "This invitation is invalid, already used, or expired.",
      );
    }

    try {
      return await createUserLogic({ email, name: req.name, password: req.password });
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
    const authData = getAuthData()!;
    requirePermission(authData, "users.update");
    // users.update may set anyone's password, so on an administrator it is
    // a way to become one. See admin-guard.ts.
    await requireAdminToTouchAdminUser(
      Number(authData.userID),
      req.id,
      "change an administrator's account",
    );
    // A password is optional here; when one is supplied it sets somebody's
    // credentials and takes the same floor as every other path.
    if (req.password !== undefined) {
      const policyError = passwordPolicyError(req.password);
      if (policyError) throw APIError.invalidArgument(policyError);
    }
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
    const policyError = passwordPolicyError(req.new_password);
    if (policyError) throw APIError.invalidArgument(policyError);
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
    const authData = getAuthData()!;
    requirePermission(authData, "users.delete");
    await requireAdminToTouchAdminUser(
      Number(authData.userID),
      id,
      "delete an administrator",
    );
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
