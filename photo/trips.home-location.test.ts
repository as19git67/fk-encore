import { beforeEach, describe, expect, it } from "vitest";
import db from "../db/database";
import { photos, users } from "../db/schema";
import { getHomeCentroidForUser } from "./recaps.service";

/**
 * Covers `getHomeCentroidForUser`, the thin service wrapper `GET
 * /trips/home-location` (photo/trips.ts) exposes to the iOS Trip Mode
 * auto-end monitor. `computeHomeCentroid` itself has its own dedicated unit
 * tests (recaps.home.test.ts); this only locks the DB-backed wiring — that
 * only this user's photos are considered and that a user without geotagged
 * photos gets `null` instead of a query error.
 */

async function seedUser(email: string): Promise<number> {
  const [u] = await db
    .insert(users)
    .values({ email, name: "T", password_hash: "x" })
    .returning({ id: users.id });
  return u.id;
}

async function seedPhoto(
  userId: number,
  day: number,
  lat: number | null,
  lon: number | null
): Promise<void> {
  await db.insert(photos).values({
    user_id: userId,
    filename: `p-${userId}-${day}.jpg`,
    original_name: `p-${userId}-${day}.jpg`,
    mime_type: "image/jpeg",
    size: 1,
    taken_at: `2025-01-${String((day % 28) + 1).padStart(2, "0")}T10:00:00Z`,
    latitude: lat,
    longitude: lon,
  });
}

beforeEach(async () => {
  await db.delete(photos);
  await db.delete(users);
});

describe("getHomeCentroidForUser", () => {
  it("returns null for a user with no geotagged photos", async () => {
    const userId = await seedUser("empty@test.dev");
    await seedPhoto(userId, 1, null, null);

    expect(await getHomeCentroidForUser(userId)).toBeNull();
  });

  it("computes the centroid from only the requesting user's photos", async () => {
    const home = { lat: 48.14, lon: 11.58 };
    const userA = await seedUser("a@test.dev");
    const userB = await seedUser("b@test.dev");

    // A has many distinct-day photos at `home`; B's single, far-away photo
    // must not pull A's result off course.
    for (let day = 1; day <= 10; day++) {
      await seedPhoto(userA, day, home.lat, home.lon);
    }
    await seedPhoto(userB, 1, 35.68, 139.69);

    const result = await getHomeCentroidForUser(userA);
    expect(result).not.toBeNull();
    expect(result!.lat).toBeCloseTo(home.lat, 2);
    expect(result!.lon).toBeCloseTo(home.lon, 2);
  });
});
