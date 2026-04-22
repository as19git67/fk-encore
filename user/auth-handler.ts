import { Header, Gateway, APIError, Query } from "encore.dev/api";
import { authHandler } from "encore.dev/auth";
import { validateToken } from "./auth.service";

console.log("[boot] user/auth-handler.ts: all imports resolved");

interface AuthParams {
  authorization?: Header<"Authorization">;
  /**
   * Fallback token used exclusively by WebSocket handshakes. Browsers
   * cannot set custom headers on WebSocket upgrades, so the realtime
   * subscribe endpoint receives the access token via query string.
   * Regular REST endpoints always use the Authorization header.
   */
  token?: Query<string>;
}

interface AuthData {
  userID: string;
  permissions: string[];
}

// Store the current token so logout can access it
let currentToken: string | undefined;

export function getAuthToken(): string | undefined {
  return currentToken;
}

/** Check if the current auth data has a specific permission. Throws APIError.permissionDenied if not. */
export function requirePermission(authData: AuthData, permission: string): void {
  if (!authData.permissions.includes(permission)) {
    throw APIError.permissionDenied(`missing permission: ${permission}`);
  }
}

console.log("[boot] user/auth-handler.ts: calling authHandler()");
export const auth = authHandler<AuthParams, AuthData>(async (params): Promise<AuthData> => {
  let token: string | undefined;
  const header = params.authorization;
  if (header) {
    const parts = header.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") {
      throw APIError.unauthenticated("invalid Authorization header format, expected: Bearer <token>");
    }
    token = parts[1];
  } else if (params.token) {
    // WebSocket handshake — browsers cannot attach the Authorization
    // header on upgrade requests, so the client passes the access
    // token as a query parameter. Tokens are already short-lived
    // (15 min) so the risk window is bounded.
    token = params.token;
  }

  if (!token) {
    throw APIError.unauthenticated("missing Authorization header");
  }

  currentToken = token;

  try {
    return await validateToken(token);
  } catch {
    throw APIError.unauthenticated("invalid or expired token");
  }
});
console.log("[boot] user/auth-handler.ts: authHandler() returned");

console.log("[boot] user/auth-handler.ts: calling new Gateway()");
export const gateway = new Gateway({
  authHandler: auth,
});
console.log("[boot] user/auth-handler.ts: new Gateway() returned");
