/**
 * The demo owner from DEMO_OWNER_EMAIL: a separate login with every module
 * role and never Admin, created by the first run, kept by every later one,
 * and not counted as content.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import db from "../db/database";
import { roles, userRoles, users } from "../db/schema";
import { demoOwnerFor, demoOwnerSetting, OWNER_ROLES } from "./owner";
import { contentCounts } from "./state";

const ADMIN = "demo-owner-admin@beispiel.test";
const OWNER = "demo-owner@beispiel.test";
let adminId: number;

async function roleNames(userId: number): Promise<string[]> {
  const rows = await db
    .select({ name: roles.name })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.role_id))
    .where(eq(userRoles.user_id, userId));
  return rows.map((r) => r.name).sort();
}

beforeAll(async () => {
  // The test database is not seeded: the roles may be missing.
  await db.insert(roles).values([...OWNER_ROLES, "Admin"].map((name) => ({ name }))).onConflictDoNothing();
  [{ id: adminId }] = await db.insert(users).values({ email: ADMIN, name: "Demo Admin", password_hash: "x" }).returning({ id: users.id });
});

afterAll(async () => {
  await db.delete(users).where(inArray(users.email, [ADMIN, OWNER, "demo-owner-admin-role@beispiel.test"]));
});

describe("demoOwnerSetting", () => {
  it("is off without DEMO_OWNER_EMAIL and reads email, password and name otherwise", () => {
    expect(demoOwnerSetting({})).toBeNull();
    expect(demoOwnerSetting({ DEMO_OWNER_EMAIL: "  " })).toBeNull();
    expect(demoOwnerSetting({ DEMO_OWNER_EMAIL: " Demo@Beispiel.test ", DEMO_OWNER_PASSWORD: "pw" })).toEqual({
      email: "demo@beispiel.test",
      password: "pw",
      name: "Demo",
    });
  });
});

describe("demoOwnerFor", () => {
  it("is the admin itself when no owner is configured", async () => {
    expect(await demoOwnerFor(adminId, null)).toBe(adminId);
  });

  it("refuses an owner without a password", async () => {
    await expect(demoOwnerFor(adminId, { email: OWNER, password: "", name: "Demo" })).rejects.toThrow("DEMO_OWNER_PASSWORD");
    expect(await db.select().from(users).where(eq(users.email, OWNER))).toHaveLength(0);
  });

  it("creates the owner with every module role and no Admin, and keeps it on the next run", async () => {
    const setting = { email: OWNER, password: "demo-pw", name: "Demo Besuch" };
    const id = await demoOwnerFor(adminId, setting);
    expect(id).not.toBe(adminId);
    expect(await roleNames(id)).toEqual([...OWNER_ROLES].sort());
    expect(OWNER_ROLES).not.toContain("Admin");
    expect(await demoOwnerFor(adminId, setting)).toBe(id);
    expect(await roleNames(id)).toEqual([...OWNER_ROLES].sort());
  });

  it("refuses the admin's own address and an owner that is an administrator", async () => {
    await expect(demoOwnerFor(adminId, { email: ADMIN, password: "pw", name: "x" })).rejects.toThrow("names the admin");
    const email = "demo-owner-admin-role@beispiel.test";
    const [u] = await db.insert(users).values({ email, name: "x", password_hash: "x" }).returning({ id: users.id });
    const [admin] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, "Admin"));
    await db.insert(userRoles).values({ user_id: u.id, role_id: admin.id });
    await expect(demoOwnerFor(adminId, { email, password: "pw", name: "x" })).rejects.toThrow("Admin role");
  });
});

describe("contentCounts", () => {
  it("does not count the demo owner as a user", async () => {
    await demoOwnerFor(adminId, { email: OWNER, password: "demo-pw", name: "Demo" });
    const before = process.env.DEMO_OWNER_EMAIL;
    try {
      delete process.env.DEMO_OWNER_EMAIL;
      const counted = (await contentCounts()).users;
      process.env.DEMO_OWNER_EMAIL = OWNER;
      expect((await contentCounts()).users).toBe(counted - 1);
    } finally {
      if (before === undefined) delete process.env.DEMO_OWNER_EMAIL;
      else process.env.DEMO_OWNER_EMAIL = before;
    }
  });
});
