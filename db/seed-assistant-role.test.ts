// The assistant used to come with every module role (#1528). It is a role of
// its own now (#1648), so an admin can grant a module without the chat or
// withdraw the chat without the module. Whoever had a module role when the
// split arrived keeps the chat — once. A later start must not hand it back
// to someone an admin took it from, which a backfill on every start would.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import db from "./database";
import { permissions, rolePermissions, roles, userRoles, users } from "./schema";
import { seed } from "./seed";

const EMAIL = "seed-assistant-test@example.test";

function enableSeed() {
  vi.stubEnv("VITEST", "");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("ADMIN_EMAIL", "seed-assistant-admin@example.test");
  vi.stubEnv("ADMIN_PASSWORD", "");
}

async function roleId(name: string): Promise<number> {
  const row = (await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)))[0];
  if (!row) throw new Error(`no role ${name}`);
  return row.id;
}

async function holdsAssistant(userId: number): Promise<boolean> {
  const rows = await db.select().from(userRoles)
    .where(and(eq(userRoles.user_id, userId), eq(userRoles.role_id, await roleId("Assistent User"))));
  return rows.length > 0;
}

let userId: number;

beforeEach(async () => {
  enableSeed();
  await seed(db);
  await db.delete(users).where(eq(users.email, EMAIL));
  userId = (await db.insert(users).values({ email: EMAIL, name: "Beispiel Nutzer", password_hash: "x" }).returning({ id: users.id }))[0]!.id;
  await db.insert(userRoles).values({ user_id: userId, role_id: await roleId("Finance User") });
  // The state before the split: no assistant role yet.
  await db.delete(roles).where(eq(roles.name, "Assistent User"));
});

afterEach(async () => {
  await db.delete(users).where(eq(users.email, EMAIL));
  vi.unstubAllEnvs();
});

describe("seed: the assistant role", () => {
  it("is the only role that carries module.assistant", async () => {
    await seed(db);
    const rows = await db
      .select({ role: roles.name })
      .from(rolePermissions)
      .innerJoin(roles, eq(roles.id, rolePermissions.role_id))
      .innerJoin(permissions, eq(permissions.id, rolePermissions.permission_id))
      .where(eq(permissions.key, "module.assistant"));
    expect(rows.map((r) => r.role).sort()).toEqual(["Admin", "Assistent User"]);
  });

  it("goes once to whoever held a module role when it appeared", async () => {
    await seed(db);
    expect(await holdsAssistant(userId)).toBe(true);
  });

  it("stays withdrawn across later starts", async () => {
    await seed(db);
    await db.delete(userRoles).where(and(eq(userRoles.user_id, userId), eq(userRoles.role_id, await roleId("Assistent User"))));
    await seed(db);
    expect(await holdsAssistant(userId)).toBe(false);
  });
});
