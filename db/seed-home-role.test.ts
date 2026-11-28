// The house module (documentation/plans/haus-anlagen.md) starts with whoever
// reads the household's meters — once, when "Haus User" appears. A later
// start must not hand it back to someone an admin took it from.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import db from "./database";
import { permissions, rolePermissions, roles, userRoles, users } from "./schema";
import { seed } from "./seed";

const EMAIL = "seed-home-test@example.test";

function enableSeed() {
  vi.stubEnv("VITEST", "");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("ADMIN_EMAIL", "seed-home-admin@example.test");
  vi.stubEnv("ADMIN_PASSWORD", "");
}

async function roleId(name: string): Promise<number> {
  const row = (await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)))[0];
  if (!row) throw new Error(`no role ${name}`);
  return row.id;
}

async function holdsHome(userId: number): Promise<boolean> {
  const rows = await db.select().from(userRoles)
    .where(and(eq(userRoles.user_id, userId), eq(userRoles.role_id, await roleId("Haus User"))));
  return rows.length > 0;
}

let userId: number;

beforeEach(async () => {
  enableSeed();
  await seed(db);
  await db.delete(users).where(eq(users.email, EMAIL));
  userId = (await db.insert(users).values({ email: EMAIL, name: "Beispiel Nutzer", password_hash: "x" }).returning({ id: users.id }))[0]!.id;
  await db.insert(userRoles).values({ user_id: userId, role_id: await roleId("Zähler User") });
  // The state before the house module: no role yet.
  await db.delete(roles).where(eq(roles.name, "Haus User"));
});

afterEach(async () => {
  await db.delete(users).where(eq(users.email, EMAIL));
  vi.unstubAllEnvs();
});

describe("seed: the house role", () => {
  it("carries the house permissions", async () => {
    await seed(db);
    const rows = await db
      .select({ key: permissions.key })
      .from(rolePermissions)
      .innerJoin(permissions, eq(permissions.id, rolePermissions.permission_id))
      .where(eq(rolePermissions.role_id, await roleId("Haus User")));
    expect(rows.map((r) => r.key).sort()).toEqual(["home.manage", "home.view", "module.home"]);
  });

  it("goes once to whoever held the meters role when it appeared", async () => {
    await seed(db);
    expect(await holdsHome(userId)).toBe(true);
  });

  it("stays withdrawn across later starts", async () => {
    await seed(db);
    await db.delete(userRoles).where(and(eq(userRoles.user_id, userId), eq(userRoles.role_id, await roleId("Haus User"))));
    await seed(db);
    expect(await holdsHome(userId)).toBe(false);
  });
});
