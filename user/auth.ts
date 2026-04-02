import { api, APIError } from "encore.dev/api";
import type {
  LoginRequest, LoginResponse, LogoutResponse,
  RequestPasswordResetRequest, RequestPasswordResetResponse,
  ResetPasswordRequest, ResetPasswordResponse,
} from "../db/types";
import { loginLogic, logoutLogic, requestPasswordResetLogic, resetPasswordLogic } from "./auth.service";
import { getAuthToken } from "./auth-handler";

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
  async (): Promise<LogoutResponse> => {
    const token = getAuthToken();
    if (!token) {
      throw APIError.unauthenticated("no token provided");
    }
    return await logoutLogic(token);
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

