import { api, APIError } from "encore.dev/api";
import type { LoginRequest, LoginResponse, LogoutResponse } from "../db/types";
import { loginLogic, logoutLogic } from "./auth.service";
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

