import { Header, Gateway, APIError } from "encore.dev/api";
import { authHandler } from "encore.dev/auth";
import { validateToken } from "./auth.service";

interface AuthParams {
  authorization: Header<"Authorization">;
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

export const auth = authHandler<AuthParams, AuthData>(async (params): Promise<AuthData> => {
  const header = params.authorization;
  if (!header) {
    throw APIError.unauthenticated("missing Authorization header");
  }

  const parts = header.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    throw APIError.unauthenticated("invalid Authorization header format, expected: Bearer <token>");
  }

  const token = parts[1];
  currentToken = token;

  try {
    return await validateToken(token);
  } catch {
    throw APIError.unauthenticated("invalid or expired token");
  }
});

export const gateway = new Gateway({
  authHandler: auth,
});
