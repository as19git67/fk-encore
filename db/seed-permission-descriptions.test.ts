// Three permissions reach further than their names suggest. Two of them are
// now fenced off from the Admin role by admin-guard.ts, and their
// descriptions say what is left rather than repeating a warning that is no
// longer true. roles.update is the one that stays admin-equivalent, because
// the only rule that would fix it would also stop administrators granting
// the two permissions the seed keeps off the Admin role on purpose.
//
// The wording lives in the permission's description, because that is the
// text the role editor prints next to each checkbox — the moment somebody
// is actually deciding to grant it. That only works if seed() keeps
// descriptions in step with the code; it used to insert them once and never
// look again, so an existing deployment would have kept the old wording
// forever.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import db from "./database";
import { permissions } from "./schema";
import { seed } from "./seed";

/** Still admin-equivalent: no restriction can make it safe. */
const ADMIN_EQUIVALENT = ["roles.update"];

/** Fenced off from the Admin role — the description must say so. */
const FENCED = ["users.update", "roles.assign"];

/** seed() is a deliberate no-op under vitest; clear the markers it checks. */
function enableSeed() {
  vi.stubEnv("VITEST", "");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("ADMIN_EMAIL", "seed-perm-test@example.test");
  vi.stubEnv("ADMIN_PASSWORD", "");
}

beforeEach(enableSeed);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("permission descriptions", () => {
  it("marks the one that is still admin-equivalent as such", async () => {
    await seed(db);

    const rows = await db
      .select()
      .from(permissions)
      .where(inArray(permissions.key, ADMIN_EQUIVALENT));

    expect(rows).toHaveLength(ADMIN_EQUIVALENT.length);
    for (const row of rows) {
      expect(row.description, row.key).toMatch(/equals full admin/);
    }
  });

  it("says what the fenced-off ones can and cannot reach", async () => {
    // Leaving "equals full admin" on these would be a lie now, and a
    // warning nobody believes is worse than none.
    await seed(db);

    const rows = await db
      .select()
      .from(permissions)
      .where(inArray(permissions.key, FENCED));

    expect(rows).toHaveLength(FENCED.length);
    for (const row of rows) {
      expect(row.description, row.key).not.toMatch(/equals full admin/);
      expect(row.description, row.key).toMatch(/administrator/i);
    }
  });

  it("does not cry wolf on an ordinary permission", async () => {
    await seed(db);

    const [row] = await db
      .select()
      .from(permissions)
      .where(eq(permissions.key, "photos.view"));

    expect(row!.description).not.toMatch(/equals full admin/);
  });

  it("corrects a description that has drifted from the code", async () => {
    // The convergence this rests on. Without it the warning would only ever
    // reach a database seeded from scratch.
    await seed(db);
    await db
      .update(permissions)
      .set({ description: "Update existing users" })
      .where(eq(permissions.key, "users.update"));

    await seed(db);

    const [row] = await db
      .select()
      .from(permissions)
      .where(eq(permissions.key, "users.update"));
    expect(row!.description).not.toBe("Update existing users");
    expect(row!.description).toMatch(/administrator/i);
  });

  it("leaves a description that already matches alone", async () => {
    await seed(db);
    const [before] = await db
      .select()
      .from(permissions)
      .where(eq(permissions.key, "users.update"));

    await seed(db);

    const [after] = await db
      .select()
      .from(permissions)
      .where(eq(permissions.key, "users.update"));
    expect(after!.description).toBe(before!.description);
    expect(after!.id).toBe(before!.id);
  });
});
