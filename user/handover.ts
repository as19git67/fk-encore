import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import type { LoginResponse } from "../db/types";
import { createHandoverLogic, redeemHandoverLogic, type HandoverToken } from "./handover.service";
import { checkRateLimit, getClientIp } from "./rateLimiter";

console.log("[boot] user/handover.ts: all imports resolved");

/** Tokens one user may ask for in the window; each opens one web page. */
const CREATE_LIMIT = { maxAttempts: 60, windowMs: 10 * 60_000, message: "Too many handover requests." };

/**
 * A one-time token the signed-in app hands to the web app it opens
 * (`/handover#token=…` there). Only a full-scope session may ask: a token
 * that itself arrived in a URL has no business minting another session.
 */
export const createHandover = api(
  { expose: true, auth: true, method: "POST", path: "/auth/handover" },
  async (): Promise<HandoverToken> => {
    const auth = getAuthData()!;
    if (auth.scope === "media") {
      throw APIError.permissionDenied("a token passed in the URL cannot hand over a session");
    }
    checkRateLimit(`handover:${auth.userID}`, CREATE_LIMIT);
    return await createHandoverLogic(Number(auth.userID));
  },
);

interface RedeemHandoverRequest {
  token: string;
}

/**
 * Redeem — no auth required; the token is the credential. An unknown, spent
 * or expired token is a bad argument, not an unauthenticated call: the web
 * client treats a 401 as its own session dying and bounces to the login page.
 */
export const redeemHandover = api(
  { expose: true, method: "POST", path: "/auth/handover/redeem" },
  async (req: RedeemHandoverRequest): Promise<LoginResponse> => {
    const ip = getClientIp();
    if (ip) checkRateLimit(`handover-redeem:${ip}`);
    try {
      return await redeemHandoverLogic(req.token);
    } catch (err: any) {
      if (err.message?.includes("required") || err.message?.includes("invalid or expired")) {
        throw APIError.invalidArgument(err.message);
      }
      throw err;
    }
  },
);
