/**
 * Reading a map link without a trip (§9.2, §20).
 *
 * The endpoint the idea pool needed and did not have. What it must get
 * right is not the parsing — `map-link.test.ts` covers that — but the
 * three answers a caller has to tell apart: a place, a link that is not
 * a map link at all, and a short link nobody could follow.
 *
 * Coordinates are invented points near Augsburg.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { PageFetchError } from "./page-fetch";
import { users } from "../db/schema";
import { readMapLink, setRedirectResolver } from "./map-link-read";

afterEach(() => setRedirectResolver(null));

beforeEach(async () => {
  const [user] = await db
    .insert(users)
    .values({ email: `maplink-${Date.now()}@test.invalid`, name: "P", password_hash: "x" })
    .returning({ id: users.id });
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(user.id),
    permissions: ["photos.view"],
  });
});

describe("readMapLink", () => {
  it("reads an Apple Maps pin", async () => {
    const read = await readMapLink({
      url: "https://maps.apple.com/?ll=48.3705,10.8978&q=Beispielmuseum",
    });
    expect(read.isMapLink).toBe(true);
    expect(read.lat).toBe(48.3705);
    expect(read.lon).toBe(10.8978);
    expect(read.name).toBe("Beispielmuseum");
    expect(read.unresolved).toBe(false);
  });

  it("reads a Google Maps pin, which is the one the share sheet dropped", async () => {
    // The extension knew `ll=` and nothing else, so this link looked
    // like a link carrying nothing and the collection was not offered.
    const read = await readMapLink({
      url: "https://www.google.com/maps/place/Beispielpark/@48.3705,10.8978,15z",
    });
    expect(read.lat).toBe(48.3705);
    expect(read.lon).toBe(10.8978);
    expect(read.source).toBe("google");
  });

  it("reads a geo: URI and a bare coordinate", async () => {
    expect((await readMapLink({ url: "geo:48.3705,10.8978" })).lat).toBe(48.3705);
    expect((await readMapLink({ url: "48.3705, 10.8978" })).lon).toBe(10.8978);
  });

  it("says a page is not a map link, rather than inventing a place", async () => {
    const read = await readMapLink({ url: "https://example.test/reisebericht" });
    expect(read.isMapLink).toBe(false);
    expect(read.lat).toBeNull();
    expect(read.name).toBeNull();
  });

  it("does not read a shared document as a place named after its title", async () => {
    const read = await readMapLink({ url: "https://docs.google.com/document/d/abc123/edit" });
    expect(read.isMapLink).toBe(false);
  });

  it("follows a short link to the place behind it", async () => {
    // The commonest share out of Google Maps is a short link, which
    // holds nothing at all until somebody follows it. Doing that on
    // the server keeps the app from fetching whatever it was handed.
    setRedirectResolver(async () =>
      "https://www.google.com/maps/place/Beispielpark/@48.3705,10.8978,15z");
    const read = await readMapLink({ url: "https://maps.app.goo.gl/AbCdEfGhIjK" });
    expect(read.lat).toBe(48.3705);
    expect(read.unresolved).toBe(false);
  });

  it("tells a short link it could not follow from a link with no place", async () => {
    // Both come back without a coordinate, and the caller says
    // different things about them: one is worth trying again.
    setRedirectResolver(async () => null);
    const read = await readMapLink({ url: "https://maps.app.goo.gl/AbCdEfGhIjK" });
    expect(read.isMapLink).toBe(true);
    expect(read.lat).toBeNull();
    expect(read.unresolved).toBe(true);
  });

  it("survives a short link that cannot be reached at all", async () => {
    setRedirectResolver(async () => {
      throw new PageFetchError("dem Kurzlink konnte nicht gefolgt werden");
    });
    const read = await readMapLink({ url: "https://maps.app.goo.gl/AbCdEfGhIjK" });
    expect(read.unresolved).toBe(true);
  });

  it("keeps a name a link carries even without a coordinate", async () => {
    // "somewhere in Lisbon" is not a position (§15.3), but the name is
    // still worth handing back — it is what the caller searches with.
    const read = await readMapLink({
      url: "https://www.google.com/maps?q=Beispielmuseum+Musterstadt",
    });
    expect(read.lat).toBeNull();
    expect(read.name).toBe("Beispielmuseum Musterstadt");
  });

  it("refuses an empty url and a pasted document", async () => {
    await expect(readMapLink({ url: "   " })).rejects.toThrow(/url wird gebraucht/);
    await expect(readMapLink({ url: "x".repeat(5_000) })).rejects.toThrow(/länger als/);
  });
});
