import { Header, Gateway, APIError, Query } from "encore.dev/api";
import { authHandler } from "encore.dev/auth";
import { currentRequest } from "encore.dev";
import { validateToken } from "./auth.service";

console.log("[boot] user/auth-handler.ts: all imports resolved");

interface AuthParams {
  authorization?: Header<"Authorization">;
  /**
   * Fallback token for the callers that cannot send a header at all:
   * WebSocket upgrades, and the <img>/<iframe> URLs that point at the
   * photo and document file endpoints. Everything else uses the
   * Authorization header.
   *
   * A token here ends up in places a header never reaches — access logs,
   * browser history, a URL somebody pastes — so it does not buy the same
   * authority. See AuthData.scope.
   */
  token?: Query<string>;
}

/**
 * How the credential arrived, and therefore how much it is worth.
 *
 * `full` — an Authorization header. The caller's own permissions apply.
 *
 * `media` — the `?token=` query parameter. Same session, same user, but
 * `requirePermission` will only grant the handful of read permissions the
 * URL-bearing endpoints actually need. A leaked image URL is then good for
 * looking at photos and documents, not for deleting them, uploading, or
 * touching users and roles.
 */
export type AuthScope = "full" | "media";

interface AuthData {
  userID: string;
  permissions: string[];
  /** Absent means `full` — keeps hand-built AuthData in tests valid. */
  scope?: AuthScope;
}

/**
 * What a `?token=` credential may still do. Deliberately just enough for
 * the four endpoints that need a token in the URL:
 *
 *   GET /photos/file/*        module.photos + photos.view
 *   GET /photos/:id/render    module.photos + photos.view
 *   GET /photos/:id/export    module.photos + photos.view
 *   GET /documents/:id/file   module.documents + documents.view
 *
 * The realtime WebSocket also authenticates this way, but its channel
 * filter reads `permissions` directly rather than going through
 * requirePermission, so subscriptions are unaffected.
 */
export const MEDIA_SCOPE_PERMISSIONS: ReadonlySet<string> = new Set([
  "module.photos",
  "photos.view",
  "module.documents",
  "documents.view",
]);

/**
 * The bearer token of the request being handled, for the one caller that
 * needs the raw value: logout, which revokes exactly this session.
 *
 * Read from the request rather than remembered in a module variable. The
 * previous version stored it in a `let` that every authenticated request
 * overwrote, so under concurrency logout could delete another user's
 * session while leaving the caller's own intact — and still report success.
 */
export function getAuthToken(): string | undefined {
  const req = currentRequest();
  if (req?.type !== "api-call") return undefined;

  const rawHeader = req.headers["authorization"];
  const header = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (header) {
    const parts = header.split(" ");
    return parts.length === 2 && parts[0] === "Bearer" ? parts[1] : undefined;
  }

  // Mirror the gateway's WebSocket fallback below so a caller that
  // authenticated via `?token=` can log out too.
  const query = req.pathAndQuery?.split("?")[1];
  if (!query) return undefined;
  return new URLSearchParams(query).get("token") ?? undefined;
}

/**
 * Check if the current auth data has a specific permission. Throws
 * APIError.permissionDenied if not.
 *
 * This is the one place every gated endpoint passes through, which is why
 * the scope ceiling is applied here rather than at each call site.
 */
export function requirePermission(authData: AuthData, permission: string): void {
  if (authData.scope === "media" && !MEDIA_SCOPE_PERMISSIONS.has(permission)) {
    throw APIError.permissionDenied(
      `permission not available to a URL-borne token: ${permission}`,
    );
  }
  if (!authData.permissions.includes(permission)) {
    throw APIError.permissionDenied(`missing permission: ${permission}`);
  }
}

console.log("[boot] user/auth-handler.ts: calling authHandler()");
export const auth = authHandler<AuthParams, AuthData>(async (params): Promise<AuthData> => {
  let token: string | undefined;
  let scope: AuthScope = "full";
  const header = params.authorization;
  if (header) {
    const parts = header.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") {
      throw APIError.unauthenticated("invalid Authorization header format, expected: Bearer <token>");
    }
    token = parts[1];
  } else if (params.token) {
    // Browsers cannot attach an Authorization header to a WebSocket
    // upgrade or to an <img src>, so those callers pass the access token
    // as a query parameter. It is the same session token, but it travels
    // through access logs and browser history on the way, so it is
    // downgraded to the media scope — see MEDIA_SCOPE_PERMISSIONS.
    token = params.token;
    scope = "media";
  }

  if (!token) {
    throw APIError.unauthenticated("missing Authorization header");
  }

  // Belt and braces on top of the scope ceiling: a URL-borne credential has
  // no business driving a write. Skipped when the request meta is not
  // available here — the ceiling above is the load-bearing half.
  if (scope === "media") {
    const req = currentRequest();
    const method = req?.type === "api-call" ? req.method : undefined;
    if (method && method !== "GET" && method !== "HEAD") {
      throw APIError.unauthenticated("a token passed in the URL is read-only");
    }
  }

  try {
    const authData = await validateToken(token);
    return { ...authData, scope };
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
