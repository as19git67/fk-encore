import { api, APIError } from "encore.dev/api";
import type {
  LoginRequest, LoginResponse, LogoutResponse,
  RefreshRequest, RefreshResponse,
  RequestPasswordResetRequest, RequestPasswordResetResponse,
  ResetPasswordRequest, ResetPasswordResponse,
  UserWithRolesAndPermissions,
} from "../db/types";
import { getAuthData } from "~encore/auth";
import { currentUserLogic, loginLogic, logoutLogic, refreshTokenLogic, requestPasswordResetLogic, resetPasswordLogic } from "./auth.service";
import { getAuthToken } from "./auth-handler";

console.log("[boot] user/auth.ts: all imports resolved");

/** Login — no auth required */
export const login = api(
  { expose: true, method: "POST", path: "/auth/login" },
  async (req: LoginRequest): Promise<LoginResponse> => {
    try {
      return await loginLogic(req);
    } catch (err: any) {
      if (err.message?.includes("invalid credentials")) {
        throw APIError.unauthenticated(err.message);
      }
      if (err.message?.includes("required")) {
        throw APIError.invalidArgument(err.message);
      }
      throw err;
    }
  }
);

/** Logout — auth required */
export const logout = api(
  { expose: true, auth: true, method: "POST", path: "/auth/logout" },
  async (req: { refreshToken?: string }): Promise<LogoutResponse> => {
    const token = getAuthToken();
    if (!token) {
      throw APIError.unauthenticated("no token provided");
    }
    return await logoutLogic(token, req.refreshToken);
  }
);

/** Refresh — exchange a valid refresh token for a new token pair (no auth required) */
export const refresh = api(
  { expose: true, method: "POST", path: "/auth/refresh" },
  async (req: RefreshRequest): Promise<RefreshResponse> => {
    try {
      return await refreshTokenLogic(req);
    } catch (err: any) {
      if (err.message?.includes("invalid or expired")) {
        throw APIError.unauthenticated(err.message);
      }
      throw err;
    }
  }
);

/**
 * The signed-in user with their current roles and permissions — so the UI
 * picks up roles granted after login without logging out and in again.
 */
export const me = api(
  { expose: true, auth: true, method: "GET", path: "/auth/me" },
  async (): Promise<UserWithRolesAndPermissions> => {
    try {
      return await currentUserLogic(Number(getAuthData()!.userID));
    } catch (err: any) {
      if (err.message?.includes("not found")) {
        throw APIError.unauthenticated(err.message);
      }
      throw err;
    }
  }
);

/** Request password reset — no auth required */
export const requestPasswordReset = api(
  { expose: true, method: "POST", path: "/auth/request-password-reset" },
  async (req: RequestPasswordResetRequest): Promise<RequestPasswordResetResponse> => {
    try {
      return await requestPasswordResetLogic(req);
    } catch (err: any) {
      if (err.message?.includes("required")) {
        throw APIError.invalidArgument(err.message);
      }
      throw err;
    }
  }
);

/** Reset password with token — no auth required */
export const resetPassword = api(
  { expose: true, method: "POST", path: "/auth/reset-password" },
  async (req: ResetPasswordRequest): Promise<ResetPasswordResponse> => {
    try {
      return await resetPasswordLogic(req);
    } catch (err: any) {
      if (err.message?.includes("required") || err.message?.includes("at least")) {
        throw APIError.invalidArgument(err.message);
      }
      if (err.message?.includes("invalid or expired")) {
        throw APIError.invalidArgument(err.message);
      }
      throw err;
    }
  }
);

