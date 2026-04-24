// Business logic for guest identity on public album share-links.
//
// A guest is a person who visits a public album link without an
// account. Identification is global per email so the same person is
// recognized across multiple albums/links and notifications can be
// consolidated.
//
// Verification flow:
//   1. register() creates (or reuses) a guests row, sets a fresh
//      verify_token, sends a magic-link mail, and returns an unverified
//      session cookie value.
//   2. The mail links to verify(), which clears the token, sets
//      verified_at, and refreshes the session cookie.
//   3. After verification the guest can comment and subscribe to
//      notifications on any album link they've used.

import crypto from "crypto";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { APIError } from "encore.dev/api";
import type { IncomingMessage } from "http";
import db from "../db/database";
import {
  albumPublicLinks,
  albums,
  guestLinkAccess,
  guestSessions,
  guests,
} from "../db/schema";
import { dbFirst, dbExec, dbInsertReturning } from "../db/adapter";
import { sendGuestVerifyEmail } from "../user/mail";
import { GUEST_SESSION_COOKIE, GUEST_SESSION_TTL_MS, parseCookies } from "./http";

type Guest = typeof guests.$inferSelect;
type GuestSession = typeof guestSessions.$inferSelect;
type AlbumPublicLink = typeof albumPublicLinks.$inferSelect;

export interface ResolvedGuest {
  guest: Guest;
  session: GuestSession;
  publicLink: AlbumPublicLink;
}

// ---------- Link resolution ----------

/**
 * Look up a public-link row by its token and reject expired ones.
 * Shared with the photo service (getPublicAlbumLogic) but duplicated
 * here to avoid pulling photo/* into sharedalbum.
 */
export async function loadActiveLink(token: string): Promise<AlbumPublicLink> {
  const link = await dbFirst<AlbumPublicLink>(
    db.select().from(albumPublicLinks).where(eq(albumPublicLinks.token, token))
  );
  if (!link) {
    throw APIError.notFound("Dieser Link ist ungültig oder existiert nicht mehr.");
  }
  if (link.expires_at && new Date(link.expires_at) < new Date()) {
    throw APIError.notFound("Dieser Link ist abgelaufen.");
  }
  return link;
}

// ---------- Session / cookie resolution ----------

/**
 * Resolve the guest session cookie on a raw request. Returns null when
 * there is no valid session (no cookie / expired / orphaned).
 *
 * `requiredLinkToken` scopes the resolution to a given public-link
 * token: if the cookie belongs to a session bootstrapped via a
 * different link, or the link has since expired, this returns null.
 */
export async function resolveGuest(
  req: IncomingMessage,
  requiredLinkToken?: string
): Promise<ResolvedGuest | null> {
  const cookies = parseCookies(req);
  const token = cookies[GUEST_SESSION_COOKIE];
  if (!token) return null;

  const row = await dbFirst<{
    session: GuestSession;
    guest: Guest;
    link: AlbumPublicLink;
  }>(
    db
      .select({
        session: guestSessions,
        guest: guests,
        link: albumPublicLinks,
      })
      .from(guestSessions)
      .innerJoin(guests, eq(guests.id, guestSessions.guest_id))
      .innerJoin(albumPublicLinks, eq(albumPublicLinks.id, guestSessions.public_link_id))
      .where(
        and(
          eq(guestSessions.id, token),
          gt(guestSessions.expires_at, sql`NOW()`),
          or(
            isNull(albumPublicLinks.expires_at),
            gt(albumPublicLinks.expires_at, sql`NOW()`)
          )
        )
      )
  );
  if (!row) return null;
  if (requiredLinkToken && row.link.token !== requiredLinkToken) return null;
  return { guest: row.guest, session: row.session, publicLink: row.link };
}

// ---------- Register / verify ----------

export interface RegisterParams {
  linkToken: string;
  email: string;
  displayName: string;
}

export interface RegisterResult {
  sessionToken: string;
  sessionMaxAgeMs: number;
  /** True when a magic-link mail was sent (i.e. guest needs to verify). */
  verifyRequired: boolean;
  guestId: number;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function generateToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

/**
 * Register (or recognize) a guest on a public-link landing. Always
 * sends a magic-link mail — even for already-verified guests — so that
 * a device switch requires possession of the email account.
 */
export async function register(params: RegisterParams): Promise<RegisterResult> {
  const email = normalizeEmail(params.email);
  if (!email || !email.includes("@")) {
    throw APIError.invalidArgument("Bitte eine gültige E-Mail-Adresse angeben.");
  }
  const displayName = params.displayName.trim();
  if (displayName.length < 1 || displayName.length > 80) {
    throw APIError.invalidArgument("Name muss 1–80 Zeichen lang sein.");
  }

  const link = await loadActiveLink(params.linkToken);
  const album = await dbFirst<typeof albums.$inferSelect>(
    db.select().from(albums).where(eq(albums.id, link.album_id))
  );
  if (!album) throw APIError.notFound("Album nicht gefunden.");

  // Upsert guest by email. display_name is only set on creation so a
  // verified guest's chosen name isn't overwritten by a later visitor
  // typing their email with a different spelling.
  const verifyToken = generateToken();
  const existing = await dbFirst<Guest>(
    db.select().from(guests).where(eq(guests.email, email))
  );

  let guestId: number;
  if (existing) {
    guestId = existing.id;
    await dbExec(
      db
        .update(guests)
        .set({ verify_token: verifyToken })
        .where(eq(guests.id, guestId))
    );
  } else {
    const inserted = await dbInsertReturning<Guest>(
      db
        .insert(guests)
        .values({
          email,
          display_name: displayName,
          verify_token: verifyToken,
          unsubscribe_token: generateToken(),
        })
        .returning()
    );
    if (!inserted) throw new Error("failed to create guest");
    guestId = inserted.id;
  }

  // Track link access (idempotent upsert). ON CONFLICT updates
  // last_seen_at so analytics stay fresh across multiple visits.
  await dbExec(
    db
      .insert(guestLinkAccess)
      .values({
        guest_id: guestId,
        public_link_id: link.id,
      })
      .onConflictDoUpdate({
        target: [guestLinkAccess.guest_id, guestLinkAccess.public_link_id],
        set: { last_seen_at: sql`NOW()` },
      })
  );

  // Create an unverified session cookie immediately so the landing
  // page can render the "pending verification" state without a page
  // reload. The session remains usable for read-only viewing; writes
  // (comments, push-subscribe) must check guest.verified_at.
  const sessionToken = generateToken();
  await dbExec(
    db.insert(guestSessions).values({
      id: sessionToken,
      guest_id: guestId,
      public_link_id: link.id,
      expires_at: new Date(Date.now() + GUEST_SESSION_TTL_MS).toISOString(),
    })
  );

  await sendGuestVerifyEmail({
    email,
    displayName: existing?.display_name ?? displayName,
    albumName: album.name,
    linkToken: link.token,
    verifyToken,
  });

  return {
    sessionToken,
    sessionMaxAgeMs: GUEST_SESSION_TTL_MS,
    verifyRequired: true,
    guestId,
  };
}

export interface VerifyResult {
  guestId: number;
  sessionToken: string;
  sessionMaxAgeMs: number;
  redirectPath: string;
}

/**
 * Consume a verify_token issued by register(). Clears the token
 * (single-use) and sets verified_at. Returns a fresh session token so
 * the verifying browser — which may not be the one that registered —
 * gets its own cookie.
 */
export async function verify(linkToken: string, verifyToken: string): Promise<VerifyResult> {
  const link = await loadActiveLink(linkToken);

  const guest = await dbFirst<Guest>(
    db.select().from(guests).where(eq(guests.verify_token, verifyToken))
  );
  if (!guest) {
    throw APIError.notFound("Dieser Bestätigungslink ist ungültig oder bereits verwendet.");
  }

  await dbExec(
    db
      .update(guests)
      .set({
        verify_token: null,
        verified_at: sql`COALESCE(${guests.verified_at}, NOW())`,
      })
      .where(eq(guests.id, guest.id))
  );

  // Make sure link-access is on record (the register-side write may
  // have happened on another device).
  await dbExec(
    db
      .insert(guestLinkAccess)
      .values({
        guest_id: guest.id,
        public_link_id: link.id,
      })
      .onConflictDoUpdate({
        target: [guestLinkAccess.guest_id, guestLinkAccess.public_link_id],
        set: { last_seen_at: sql`NOW()` },
      })
  );

  const sessionToken = generateToken();
  await dbExec(
    db.insert(guestSessions).values({
      id: sessionToken,
      guest_id: guest.id,
      public_link_id: link.id,
      expires_at: new Date(Date.now() + GUEST_SESSION_TTL_MS).toISOString(),
    })
  );

  return {
    guestId: guest.id,
    sessionToken,
    sessionMaxAgeMs: GUEST_SESSION_TTL_MS,
    redirectPath: `/app/albums/shared/${encodeURIComponent(link.token)}`,
  };
}

// ---------- Me / logout ----------

export interface GuestSelf {
  id: number;
  email: string;
  display_name: string;
  verified: boolean;
  notify_opt_in: boolean;
}

export function toGuestSelf(guest: Guest): GuestSelf {
  return {
    id: guest.id,
    email: guest.email,
    display_name: guest.display_name,
    verified: guest.verified_at !== null,
    notify_opt_in: guest.notify_opt_in,
  };
}

export async function touchLastSeen(guestId: number): Promise<void> {
  await dbExec(
    db.update(guests).set({ last_seen_at: sql`NOW()` }).where(eq(guests.id, guestId))
  );
}

export async function logout(sessionToken: string): Promise<void> {
  await dbExec(db.delete(guestSessions).where(eq(guestSessions.id, sessionToken)));
}

// ---------- Unsubscribe ----------

export async function unsubscribeByToken(unsubscribeToken: string): Promise<Guest> {
  const guest = await dbFirst<Guest>(
    db.select().from(guests).where(eq(guests.unsubscribe_token, unsubscribeToken))
  );
  if (!guest) {
    throw APIError.notFound("Dieser Abmelde-Link ist ungültig.");
  }
  if (guest.notify_opt_in) {
    await dbExec(
      db.update(guests).set({ notify_opt_in: false }).where(eq(guests.id, guest.id))
    );
  }
  return { ...guest, notify_opt_in: false };
}

export async function setNotifyOptIn(guestId: number, optIn: boolean): Promise<void> {
  await dbExec(
    db.update(guests).set({ notify_opt_in: optIn }).where(eq(guests.id, guestId))
  );
}
