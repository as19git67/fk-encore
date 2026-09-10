// Guest identity on public album links.
//
// register() recognizes a returning guest by email and reuses their row,
// then hands out a session cookie immediately — before the magic-link mail
// is opened. The write gates used to check `guests.verified_at`, a property
// of the person set the first time they ever verified, so anyone holding a
// share link who knew another guest's address could register with it and
// inherit that identity: comment under their name, and edit or delete their
// comments, since ownership is checked by guest_id.
//
// These tests pin the rule register()'s own doc comment always claimed —
// "a device switch requires possession of the email account" — now that the
// session, not the guest, carries the verification.

import { describe, it, expect, beforeEach } from "vitest";
import type { IncomingMessage } from "http";
import { eq } from "drizzle-orm";

import db from "../db/database";
import {
  users,
  albums,
  albumPublicLinks,
  guests,
  guestSessions,
  guestLinkAccess,
} from "../db/schema";
import { createUserLogic } from "../user/user.service";
import { __resetRateLimiterForTests } from "../user/rateLimiter";
import * as photoService from "../photo/photo.service";
import {
  register,
  requireVerifiedSession,
  resolveGuest,
  toGuestSelf,
  verify,
} from "./guests.service";
import { GUEST_SESSION_COOKIE } from "./http";

/** Minimal stand-in for the request object resolveGuest reads cookies off. */
function reqWithSession(token: string): IncomingMessage {
  return { headers: { cookie: `${GUEST_SESSION_COOKIE}=${encodeURIComponent(token)}` } } as never;
}

let owner: { id: number };
let linkToken: string;

async function verifyTokenFor(email: string): Promise<string> {
  const [row] = await db.select().from(guests).where(eq(guests.email, email));
  return row!.verify_token!;
}

beforeEach(async () => {
  __resetRateLimiterForTests();
  await db.delete(guestSessions);
  await db.delete(guestLinkAccess);
  await db.delete(guests);
  await db.delete(albumPublicLinks);
  await db.delete(albums);
  await db.delete(users);

  owner = await createUserLogic({ email: "owner@test.local", name: "O", password: "pw" });
  const album = await photoService.createAlbumLogic(owner.id, { name: "Urlaub" });
  const link = await photoService.createAlbumPublicLinkLogic(owner.id, album.id);
  linkToken = link.token;
});

describe("a freshly registered session", () => {
  it("is not verified, so it cannot write", async () => {
    const { sessionToken } = await register({
      linkToken,
      email: "guest@test.local",
      displayName: "Gast",
    });

    const resolved = (await resolveGuest(reqWithSession(sessionToken), linkToken))!;
    expect(resolved).not.toBeNull();
    expect(() => requireVerifiedSession(resolved)).toThrow(/verifizieren/);
  });

  it("still resolves, so the visitor can read the album", async () => {
    const { sessionToken } = await register({
      linkToken,
      email: "guest@test.local",
      displayName: "Gast",
    });

    const resolved = await resolveGuest(reqWithSession(sessionToken), linkToken);
    expect(resolved?.guest.email).toBe("guest@test.local");
  });

  it("reports itself as unverified to the landing page", async () => {
    const { sessionToken } = await register({
      linkToken,
      email: "guest@test.local",
      displayName: "Gast",
    });
    const resolved = (await resolveGuest(reqWithSession(sessionToken), linkToken))!;

    expect(toGuestSelf(resolved.guest, resolved.session).verified).toBe(false);
  });
});

describe("opening the magic link", () => {
  it("verifies the session it issues", async () => {
    await register({ linkToken, email: "guest@test.local", displayName: "Gast" });
    const { sessionToken } = await verify(linkToken, await verifyTokenFor("guest@test.local"));

    const resolved = (await resolveGuest(reqWithSession(sessionToken), linkToken))!;
    expect(() => requireVerifiedSession(resolved)).not.toThrow();
    expect(toGuestSelf(resolved.guest, resolved.session).verified).toBe(true);
  });

  it("does not verify the session that asked for it", async () => {
    // The mail may well be opened on another device; that browser gets its
    // own cookie. The one that typed the address proved nothing.
    const { sessionToken: registering } = await register({
      linkToken,
      email: "guest@test.local",
      displayName: "Gast",
    });
    await verify(linkToken, await verifyTokenFor("guest@test.local"));

    const resolved = (await resolveGuest(reqWithSession(registering), linkToken))!;
    expect(() => requireVerifiedSession(resolved)).toThrow(/verifizieren/);
  });

  it("rejects a verify token that was already used", async () => {
    await register({ linkToken, email: "guest@test.local", displayName: "Gast" });
    const token = await verifyTokenFor("guest@test.local");
    await verify(linkToken, token);

    await expect(verify(linkToken, token)).rejects.toThrow(/ungültig|bereits verwendet/);
  });
});

describe("re-registering somebody else's address", () => {
  beforeEach(async () => {
    // A guest who verified properly, on their own device.
    await register({ linkToken, email: "victim@test.local", displayName: "Victim" });
    await verify(linkToken, await verifyTokenFor("victim@test.local"));
  });

  it("does not inherit the verified standing", async () => {
    // The attack this whole change exists for.
    const { sessionToken } = await register({
      linkToken,
      email: "victim@test.local",
      displayName: "Not Victim",
    });

    const resolved = (await resolveGuest(reqWithSession(sessionToken), linkToken))!;
    expect(resolved.guest.verified_at).not.toBeNull(); // the person is verified
    expect(() => requireVerifiedSession(resolved)).toThrow(/verifizieren/); // this browser is not
  });

  it("leaves the victim's own session working", async () => {
    const victimSessions = await db.select().from(guestSessions);
    const verified = victimSessions.find((s) => s.verified_at !== null)!;

    await register({ linkToken, email: "victim@test.local", displayName: "Not Victim" });

    const resolved = (await resolveGuest(reqWithSession(verified.id), linkToken))!;
    expect(() => requireVerifiedSession(resolved)).not.toThrow();
  });

  it("still does not overwrite the display name", async () => {
    await register({ linkToken, email: "victim@test.local", displayName: "Not Victim" });
    const [row] = await db.select().from(guests).where(eq(guests.email, "victim@test.local"));
    expect(row!.display_name).toBe("Victim");
  });
});

describe("rate limiting", () => {
  it("caps how often one address may be mailed", async () => {
    for (let i = 0; i < 3; i++) {
      await register({ linkToken, email: "target@test.local", displayName: "T" });
    }
    await expect(
      register({ linkToken, email: "target@test.local", displayName: "T" }),
    ).rejects.toThrow(/Zu viele Bestätigungsmails/);
  });

  it("caps how many invitations one share link may mint", async () => {
    for (let i = 0; i < 20; i++) {
      await register({ linkToken, email: `bulk${i}@test.local`, displayName: "B" });
    }
    await expect(
      register({ linkToken, email: "bulk20@test.local", displayName: "B" }),
    ).rejects.toThrow(/Zu viele Anmeldungen/);
  });

  it("keys the address limit on the normalized address", async () => {
    // Otherwise varying the case sidesteps it.
    for (let i = 0; i < 3; i++) {
      await register({ linkToken, email: "Target@Test.Local", displayName: "T" });
    }
    await expect(
      register({ linkToken, email: "target@test.local", displayName: "T" }),
    ).rejects.toThrow(/Zu viele Bestätigungsmails/);
  });
});

describe("session scoping is unchanged", () => {
  it("refuses a cookie from a different share link", async () => {
    const other = await photoService.createAlbumLogic(owner.id, { name: "Anderes" });
    const otherLink = await photoService.createAlbumPublicLinkLogic(owner.id, other.id);
    const { sessionToken } = await register({
      linkToken,
      email: "guest@test.local",
      displayName: "Gast",
    });

    expect(await resolveGuest(reqWithSession(sessionToken), otherLink.token)).toBeNull();
  });

  it("refuses a cookie once the link is revoked", async () => {
    const { sessionToken } = await register({
      linkToken,
      email: "guest@test.local",
      displayName: "Gast",
    });
    await db
      .update(albumPublicLinks)
      .set({ disabled_at: new Date().toISOString() })
      .where(eq(albumPublicLinks.token, linkToken));

    expect(await resolveGuest(reqWithSession(sessionToken), linkToken)).toBeNull();
  });
});
