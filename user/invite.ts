import { api, APIError, Query } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "./auth-handler";
import {
  createInviteLogic,
  listInvitesLogic,
  lookupInviteLogic,
  revokeInviteLogic,
  type InviteSummary,
} from "./invite.service";

console.log("[boot] user/invite.ts: all imports resolved");

export interface CreateInviteRequest {
  email: string;
}

export interface ListInvitesResponse {
  invites: InviteSummary[];
}

/**
 * Invite somebody to create an account — requires users.create.
 *
 * That permission has existed in the catalogue all along and was never
 * checked anywhere, because registration was open and there was nothing to
 * check it on. This is what it now means.
 *
 * The response deliberately does not contain the token: it goes to the
 * invited address and nowhere else, so holding users.create is not the same
 * as being able to register as somebody.
 */
export const createInvite = api(
  { expose: true, auth: true, method: "POST", path: "/users/invites" },
  async (req: CreateInviteRequest): Promise<InviteSummary> => {
    const authData = getAuthData()!;
    requirePermission(authData, "users.create");
    try {
      return await createInviteLogic(Number(authData.userID), req.email);
    } catch (err: any) {
      if (err.message?.includes("already exists")) {
        throw APIError.alreadyExists(err.message);
      }
      if (err.message?.includes("required")) {
        throw APIError.invalidArgument(err.message);
      }
      throw err;
    }
  },
);

/** Open and recently redeemed invites — requires users.create. */
export const listInvites = api(
  { expose: true, auth: true, method: "GET", path: "/users/invites" },
  async (): Promise<ListInvitesResponse> => {
    requirePermission(getAuthData()!, "users.create");
    return { invites: await listInvitesLogic() };
  },
);

/** Withdraw an invite that has not been used — requires users.create. */
export const revokeInvite = api(
  { expose: true, auth: true, method: "DELETE", path: "/users/invites/:id" },
  async ({ id }: { id: number }): Promise<{ success: boolean }> => {
    requirePermission(getAuthData()!, "users.create");
    try {
      return await revokeInviteLogic(id);
    } catch (err: any) {
      if (err.message?.includes("not found")) {
        throw APIError.notFound(err.message);
      }
      if (err.message?.includes("already been accepted")) {
        throw APIError.failedPrecondition(err.message);
      }
      throw err;
    }
  },
);

/**
 * Resolve an invite token to the address it was issued for.
 *
 * Unauthenticated by necessity — the person holding the link has no account
 * yet. It reveals one address to whoever already holds the 32-byte token
 * that was mailed to it, which is no more than the invite mail itself said,
 * and it lets the registration page name the address and explain a dead
 * link instead of failing on submit.
 */
export const checkInvite = api(
  { expose: true, auth: false, method: "GET", path: "/users/invites/check" },
  async ({ token }: { token: Query<string> }): Promise<{ email: string }> => {
    try {
      return await lookupInviteLogic(token);
    } catch {
      throw APIError.notFound("This invitation is invalid, already used, or expired.");
    }
  },
);
