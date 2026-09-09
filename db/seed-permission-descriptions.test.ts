// Three permissions are effectively equivalent to full Admin, which the
// names do not suggest: users.update can change any user's password
// (including an administrator's), roles.assign can grant the Admin role to
// its own holder, and roles.update can attach any permission to a role the
// holder already has.
//
// The warning lives in the permission's description, because that is the
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

const ADMIN_EQUIVALENT = ["users.update", "roles.assign", "roles.update"];

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
  it("marks the admin-equivalent permissions as such", async () => {
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
    expect(row!.description).toMatch(/equals full admin/);
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
