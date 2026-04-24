// Raw HTTP endpoints for guest identity on public album share-links.
//
// Raw endpoints (instead of typed api(...)) are required because
// guests authenticate via a cookie, and Encore's typed layer does not
// let handlers emit Set-Cookie.

import { api, APIError } from "encore.dev/api";
import log from "encore.dev/log";
import {
  buildClearSessionCookie,
  buildSessionCookie,
  GUEST_SESSION_COOKIE,
  parseCookies,
  parseJsonBody,
  readBody,
  writeError,
  writeHtml,
  writeJson,
  writeRedirect,
} from "./http";
import {
  logout as serviceLogout,
  register,
  resolveGuest,
  setNotifyOptIn,
  toGuestSelf,
  touchLastSeen,
  unsubscribeByToken,
  verify,
} from "./guests.service";

// POST /share/:token/guests/register
export const registerGuest = api.raw(
  { expose: true, method: "POST", path: "/share/:token/guests/register", auth: false },
  async (req, res) => {
    try {
      const token = extractPathParam(req.url, "/share/", "/guests/register");
      if (!token) throw APIError.invalidArgument("missing share token in path");

      const body = parseJsonBody<{ email?: string; display_name?: string }>(
        await readBody(req)
      );
      if (typeof body?.email !== "string" || typeof body?.display_name !== "string") {
        throw APIError.invalidArgument("`email` and `display_name` are required");
      }

      const result = await register({
        linkToken: token,
        email: body.email,
        displayName: body.display_name,
      });

      res.setHeader("Set-Cookie", buildSessionCookie(result.sessionToken, result.sessionMaxAgeMs));
      writeJson(res, 200, {
        verify_required: result.verifyRequired,
        guest_id: result.guestId,
      });
    } catch (err) {
      writeError(res, err);
    }
  }
);

// GET /share/:token/guests/verify?t=<verify_token>
export const verifyGuest = api.raw(
  { expose: true, method: "GET", path: "/share/:token/guests/verify", auth: false },
  async (req, res) => {
    try {
      const token = extractPathParam(req.url, "/share/", "/guests/verify");
      if (!token) throw APIError.invalidArgument("missing share token in path");

      const url = new URL(req.url ?? "", "http://placeholder");
      const verifyToken = url.searchParams.get("t");
      if (!verifyToken) throw APIError.invalidArgument("missing verify token");

      const result = await verify(token, verifyToken);
      res.setHeader(
        "Set-Cookie",
        buildSessionCookie(result.sessionToken, result.sessionMaxAgeMs)
      );
      writeRedirect(res, result.redirectPath);
    } catch (err) {
      // Render a friendly HTML page instead of JSON — users land here
      // via a mail client, not an API caller.
      if (err instanceof APIError) {
        writeHtml(
          res,
          err.code === "not_found" ? 404 : 400,
          renderErrorPage("Bestätigung fehlgeschlagen", err.message)
        );
        return;
      }
      log.error(err as any, "sharedalbum.verify.unhandled");
      writeHtml(res, 500, renderErrorPage("Bestätigung fehlgeschlagen", "Bitte später erneut versuchen."));
    }
  }
);

// GET /share/:token/guests/me
export const me = api.raw(
  { expose: true, method: "GET", path: "/share/:token/guests/me", auth: false },
  async (req, res) => {
    try {
      const token = extractPathParam(req.url, "/share/", "/guests/me");
      if (!token) throw APIError.invalidArgument("missing share token in path");

      const resolved = await resolveGuest(req, token);
      if (!resolved) {
        writeJson(res, 200, { guest: null });
        return;
      }
      await touchLastSeen(resolved.guest.id);
      writeJson(res, 200, { guest: toGuestSelf(resolved.guest) });
    } catch (err) {
      writeError(res, err);
    }
  }
);

// POST /share/:token/guests/notify-opt-in  — { opt_in: boolean }
export const notifyOptIn = api.raw(
  { expose: true, method: "POST", path: "/share/:token/guests/notify-opt-in", auth: false },
  async (req, res) => {
    try {
      const token = extractPathParam(req.url, "/share/", "/guests/notify-opt-in");
      if (!token) throw APIError.invalidArgument("missing share token in path");

      const resolved = await resolveGuest(req, token);
      if (!resolved) throw APIError.unauthenticated("no guest session");

      const body = parseJsonBody<{ opt_in?: boolean }>(await readBody(req));
      if (typeof body?.opt_in !== "boolean") {
        throw APIError.invalidArgument("`opt_in` (boolean) required");
      }

      await setNotifyOptIn(resolved.guest.id, body.opt_in);
      writeJson(res, 200, { opt_in: body.opt_in });
    } catch (err) {
      writeError(res, err);
    }
  }
);

// POST /share/:token/guests/logout
export const logout = api.raw(
  { expose: true, method: "POST", path: "/share/:token/guests/logout", auth: false },
  async (req, res) => {
    try {
      const cookies = parseCookies(req);
      const sessionToken = cookies[GUEST_SESSION_COOKIE];
      if (sessionToken) await serviceLogout(sessionToken);
      res.setHeader("Set-Cookie", buildClearSessionCookie());
      writeJson(res, 200, { ok: true });
    } catch (err) {
      writeError(res, err);
    }
  }
);

// GET /share/unsubscribe?t=<unsubscribe_token>
//
// One-click unsubscribe linked from every digest mail. Also works as
// the List-Unsubscribe GET target (RFC 8058). No cookie required —
// possession of the token is the authorization.
export const unsubscribe = api.raw(
  { expose: true, method: "GET", path: "/share/unsubscribe", auth: false },
  async (req, res) => {
    try {
      const url = new URL(req.url ?? "", "http://placeholder");
      const unsubToken = url.searchParams.get("t");
      if (!unsubToken) throw APIError.invalidArgument("missing unsubscribe token");

      await unsubscribeByToken(unsubToken);
      writeHtml(res, 200, renderUnsubscribePage());
    } catch (err) {
      if (err instanceof APIError) {
        writeHtml(
          res,
          err.code === "not_found" ? 404 : 400,
          renderErrorPage("Abmeldung fehlgeschlagen", err.message)
        );
        return;
      }
      log.error(err as any, "sharedalbum.unsubscribe.unhandled");
      writeHtml(res, 500, renderErrorPage("Abmeldung fehlgeschlagen", "Bitte später erneut versuchen."));
    }
  }
);

// POST /share/unsubscribe (RFC 8058 List-Unsubscribe-Post target).
export const unsubscribePost = api.raw(
  { expose: true, method: "POST", path: "/share/unsubscribe", auth: false },
  async (req, res) => {
    try {
      const url = new URL(req.url ?? "", "http://placeholder");
      const unsubToken = url.searchParams.get("t");
      if (!unsubToken) throw APIError.invalidArgument("missing unsubscribe token");
      await unsubscribeByToken(unsubToken);
      writeJson(res, 200, { ok: true });
    } catch (err) {
      writeError(res, err);
    }
  }
);

// ---------- Helpers ----------

/**
 * Extract a single path segment between two known fixed strings in the
 * request URL. Encore's `path: "/share/:token/..."` would normally
 * surface `token` as a typed param, but api.raw handlers get the raw
 * URL and have to parse it themselves.
 */
function extractPathParam(
  url: string | undefined,
  prefix: string,
  suffix: string
): string | null {
  if (!url) return null;
  const pathname = url.split("?")[0];
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  const suffixIdx = rest.indexOf(suffix);
  if (suffixIdx < 0) return null;
  const raw = rest.slice(0, suffixIdx);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function renderUnsubscribePage(): string {
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>Abgemeldet</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
</head><body style="font-family:sans-serif;max-width:480px;margin:3em auto;padding:0 1em;color:#222">
<h2>Du bist abgemeldet.</h2>
<p>Du bekommst keine weiteren Benachrichtigungen für geteilte Alben. Falls du das rückgängig machen möchtest, öffne den Album-Link und aktiviere die Benachrichtigungen wieder.</p>
</body></html>`;
}

function renderErrorPage(title: string, message: string): string {
  const safe = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>${safe(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
</head><body style="font-family:sans-serif;max-width:480px;margin:3em auto;padding:0 1em;color:#222">
<h2>${safe(title)}</h2>
<p>${safe(message)}</p>
</body></html>`;
}
