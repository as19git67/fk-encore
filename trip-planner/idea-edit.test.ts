/**
 * Changing something already collected (§20).
 *
 * The tests are about the two ways an edit screen goes wrong quietly:
 * saving one field and wiping the others, and letting somebody write
 * into a collection that is not theirs.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { APIError } from "encore.dev/api";
import db from "../db/database";
import { ideaPool, ideaPoolShares, users } from "../db/schema";
import { addIdea } from "./ideas";
import { updateIdea } from "./idea-edit";

let userId: number;

/** A place OpenStreetMap does not know, so nothing is matched away. */
async function collectSomething() {
  const { entry } = await addIdea({
    lat: -20.5,
    lon: -70.5,
    name: "Die Bank am Hang",
    note: "schöner Blick",
    dwellMinutes: 20,
  });
  return entry;
}

beforeEach(async () => {
  await db.delete(ideaPool);
  await db.delete(ideaPoolShares);
  const [user] = await db
    .insert(users)
    .values({ email: `edit-${Date.now()}@test.invalid`, name: "Planner", password_hash: "x" })
    .returning({ id: users.id });
  userId = user.id;
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(user.id),
    permissions: ["photos.view"],
  });
});

describe("PATCH /trip-planner/ideas/:id", () => {
  it("changes one field and leaves the rest alone", async () => {
    const entry = await collectSomething();

    const { entry: written } = await updateIdea({ id: entry.id, title: "Unsere Bank" });

    expect(written.title).toBe("Unsere Bank");
    // The whole point of the three-state rule: a sheet that edits the
    // title must not take the note with it.
    expect(written.note).toBe("schöner Blick");
    expect(written.dwellMinutes).toBe(20);
  });

  it("clears a field somebody emptied", async () => {
    const entry = await collectSomething();

    const { entry: written } = await updateIdea({ id: entry.id, note: "" });

    expect(written.note).toBeNull();
    expect(written.title).toBe(entry.title);
  });

  it("takes a corrected stay length", async () => {
    const entry = await collectSomething();

    const { entry: written } = await updateIdea({ id: entry.id, dwellMinutes: 75 });

    expect(written.dwellMinutes).toBe(75);
  });

  it("never leaves an entry without one", async () => {
    const entry = await collectSomething();

    // Null means "clear" everywhere else; a spot with no stay length
    // cannot be planned, so here it keeps what it had.
    const { entry: written } = await updateIdea({ id: entry.id, dwellMinutes: null });

    expect(written.dwellMinutes).toBe(20);
  });

  it("refuses a stay length no visit looks like", async () => {
    const entry = await collectSomething();

    await expect(updateIdea({ id: entry.id, dwellMinutes: 4 })).rejects.toThrow(APIError);
    await expect(updateIdea({ id: entry.id, dwellMinutes: 900 })).rejects.toThrow(APIError);
  });

  it("keeps a link the app can open and refuses one it cannot", async () => {
    const entry = await collectSomething();

    const { entry: written } = await updateIdea({
      id: entry.id,
      sourceUrl: "https://beispiel.test/aussicht",
    });
    expect(written.sourceUrl).toBe("https://beispiel.test/aussicht");

    await expect(updateIdea({ id: entry.id, sourceUrl: "javascript:alert(1)" }))
      .rejects.toThrow(APIError);
  });

  it("takes the dates of something that ends, and refuses them backwards", async () => {
    const entry = await collectSomething();

    const { entry: written } = await updateIdea({
      id: entry.id,
      validFrom: "2026-04-01",
      validTo: "2026-06-30",
    });
    expect(written.validFrom).toBe("2026-04-01");
    expect(written.validTo).toBe("2026-06-30");

    await expect(updateIdea({ id: entry.id, validTo: "2026-01-01" }))
      .rejects.toThrow(APIError);
  });

  it("lets an exhibition that turned out to be permanent lose its end", async () => {
    const entry = await collectSomething();
    await updateIdea({ id: entry.id, validTo: "2026-06-30" });

    const { entry: written } = await updateIdea({ id: entry.id, validTo: null });

    expect(written.validTo).toBeNull();
  });

  it("does not switch the photo stop off for a screen that never mentions it", async () => {
    const entry = await collectSomething();
    await updateIdea({ id: entry.id, photoStop: true });

    const { entry: written } = await updateIdea({ id: entry.id, note: "Sonnenuntergang" });

    expect(written.note).toBe("Sonnenuntergang");
    const [row] = await db.select({ photoStop: ideaPool.photo_stop }).from(ideaPool);
    expect(row.photoStop).toBe(true);
  });

  it("does not know an entry from somebody else's collection", async () => {
    const entry = await collectSomething();
    const [stranger] = await db
      .insert(users)
      .values({ email: `stranger-${Date.now()}@test.invalid`, name: "X", password_hash: "x" })
      .returning({ id: users.id });
    vi.mocked(getAuthData).mockReturnValue({
      userID: String(stranger.id),
      permissions: ["photos.view"],
    });

    // Not "permission denied": a collection nobody was let into is not
    // theirs to know about.
    await expect(updateIdea({ id: entry.id, ownerId: userId, title: "meins jetzt" }))
      .rejects.toThrow(APIError);
  });

  it("lets somebody the collection is shared with correct an entry", async () => {
    const entry = await collectSomething();
    const [friend] = await db
      .insert(users)
      .values({ email: `friend-${Date.now()}@test.invalid`, name: "Anna", password_hash: "x" })
      .returning({ id: users.id });
    await db.insert(ideaPoolShares).values({ owner_id: userId, user_id: friend.id });
    vi.mocked(getAuthData).mockReturnValue({
      userID: String(friend.id),
      permissions: ["photos.view"],
    });

    const { entry: written } = await updateIdea({
      id: entry.id,
      ownerId: userId,
      note: "geht auch mit Kinderwagen",
    });

    expect(written.note).toBe("geht auch mit Kinderwagen");
  });

  it("says so when the entry is gone", async () => {
    await expect(updateIdea({ id: 999_999, title: "x" })).rejects.toThrow(APIError);
  });
});
