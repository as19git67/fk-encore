/**
 * Invitations — the only way an account comes into existence.
 *
 * `POST /users` used to be open to anyone who could reach the app. New
 * accounts carried no roles, so it was never a way in, but it was an
 * account factory, and it made every authenticated-but-unauthorized gap
 * elsewhere anonymously reachable.
 *
 * Now somebody holding `users.create` names an address, and the token
 * mailed there is what `POST /users` requires. Two properties matter:
 *
 *   - the new account's email comes from the invite row, never from the
 *     registration request, so an invite cannot be redirected;
 *   - an invite carries no roles. Otherwise `users.create` alone would be
 *     enough to mint an admin. Roles stay behind `roles.assign`.
 */

import crypto from "crypto";
import { and, desc, eq, gt, isNull, lt, or } from "drizzle-orm";
import db from "../db/database";
import { users, userInvites } from "../db/schema";
import { dbAll, dbExec, dbFirst, dbInsertReturning } from "../db/adapter";
import { sendInviteEmail } from "./mail";

console.log("[boot] user/invite.service.ts: all imports resolved");

/**
 * Long enough that guessing is out of the question, so the accept path
 * needs no rate limit of its own. Same shape as the password-reset token.
 */
function generateToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * A week. Long enough to survive a holiday, short enough that a forgotten
 * invite does not stay redeemable indefinitely.
 */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function normalizeInviteEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface InviteSummary {
  id: number;
  email: string;
  invited_by_user_id: number | null;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
}

function toSummary(row: typeof userInvites.$inferSelect): InviteSummary {
  return {
    id: row.id,
    email: row.email,
    invited_by_user_id: row.invited_by_user_id,
    created_at: row.created_at,
    expires_at: row.expires_at,
    accepted_at: row.accepted_at,
  };
}

/**
 * Invite an address. Replaces any invite still open for it, so re-inviting
 * somebody who lost the mail issues a fresh link rather than leaving two
 * live tokens for one address.
 *
 * Throws when an account already exists. That does leak whether an address
 * is registered — but only to a caller who already holds `users.create`
 * and can list every user anyway, and telling them is the difference
 * between a useful error and a mail nobody can act on.
 */
export async function createInviteLogic(
  inviterId: number,
  rawEmail: string,
): Promise<InviteSummary> {
  const email = normalizeInviteEmail(rawEmail);
  if (!email || !email.includes("@")) {
    throw new Error("a valid email address is required");
  }

  const existingUser = await dbFirst<typeof users.$inferSelect>(
    db.select().from(users).where(eq(users.email, email)),
  );
  if (existingUser) {
    throw new Error(`a user with this email already exists`);
  }

  await dbExec(
    db.delete(userInvites).where(and(eq(userInvites.email, email), isNull(userInvites.accepted_at))),
  );

  const token = generateToken();
  const row = await dbInsertReturning<typeof userInvites.$inferSelect>(
    db
      .insert(userInvites)
      .values({
        token,
        email,
        invited_by_user_id: inviterId,
        expires_at: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
      })
      .returning(),
  );
  if (!row) throw new Error("failed to create invite");

  // The token only ever reaches the invitee's mailbox — it is deliberately
  // absent from the response, so an admin cannot register on somebody
  // else's behalf. Without SMTP configured the link is logged instead, the
  // same fallback the password-reset mail uses.
  await sendInviteEmail(email, token);

  return toSummary(row);
}

/** Invites an admin still has something to do about: open, or recently used. */
export async function listInvitesLogic(): Promise<InviteSummary[]> {
  const rows = await dbAll<typeof userInvites.$inferSelect>(
    db
      .select()
      .from(userInvites)
      .where(
        or(
          // still redeemable
          and(isNull(userInvites.accepted_at), gt(userInvites.expires_at, new Date().toISOString())),
          // or already redeemed — kept visible so the list shows what happened
          gt(userInvites.accepted_at, new Date(Date.now() - INVITE_TTL_MS).toISOString()),
        ),
      )
      .orderBy(desc(userInvites.created_at)),
  );
  return rows.map(toSummary);
}

/** Withdraw an invite that has not been used yet. */
export async function revokeInviteLogic(id: number): Promise<{ success: boolean }> {
  const row = await dbFirst<typeof userInvites.$inferSelect>(
    db.select().from(userInvites).where(eq(userInvites.id, id)),
  );
  if (!row) throw new Error("invite not found");
  if (row.accepted_at) throw new Error("invite has already been accepted");

  await dbExec(db.delete(userInvites).where(eq(userInvites.id, id)));
  return { success: true };
}

/**
 * Resolve a token to the address it was issued for, without consuming it.
 * Lets the registration page name the address and explain a dead link,
 * rather than failing only once the form is submitted.
 */
export async function lookupInviteLogic(token: string): Promise<{ email: string }> {
  const row = await liveInvite(token);
  return { email: row.email };
}

async function liveInvite(token: string): Promise<typeof userInvites.$inferSelect> {
  if (!token) throw new Error("invite not found");
  const row = await dbFirst<typeof userInvites.$inferSelect>(
    db.select().from(userInvites).where(eq(userInvites.token, token)),
  );
  // One message for every failure mode: an unknown, spent and expired token
  // are indistinguishable from outside.
  if (!row || row.accepted_at || new Date(row.expires_at) < new Date()) {
    throw new Error("invite not found");
  }
  return row;
}

/**
 * Redeem a token. Returns the address the account must be created for, and
 * marks the invite spent in the same statement — the conditional UPDATE is
 * what makes a double redemption lose rather than create two accounts.
 */
export async function consumeInviteLogic(token: string): Promise<{ email: string }> {
  const row = await liveInvite(token);

  const claimed = await dbInsertReturning<typeof userInvites.$inferSelect>(
    db
      .update(userInvites)
      .set({ accepted_at: new Date().toISOString() })
      .where(and(eq(userInvites.id, row.id), isNull(userInvites.accepted_at)))
      .returning(),
  );
  if (!claimed) throw new Error("invite not found");

  return { email: claimed.email };
}

/** Housekeeping: drop invites that expired long ago and were never used. */
export async function purgeStaleInvitesLogic(): Promise<void> {
  await dbExec(
    db
      .delete(userInvites)
      .where(
        and(
          isNull(userInvites.accepted_at),
          lt(userInvites.expires_at, new Date(Date.now() - INVITE_TTL_MS).toISOString()),
        ),
      ),
  );
}
