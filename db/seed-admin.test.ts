// The initial-admin block is skipped when ADMIN_PASSWORD is unset, which is
// the normal state for a stack brought up without an .env. It used to skip via
// an early `return`, which also skipped everything after it — including the AI
// system user the curation features depend on. That only became reachable once
// the compose file stopped defaulting ADMIN_PASSWORD to a value, so pin it.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import db from "./database";
import { users } from "./schema";
import { seed } from "./seed";

const AI_USER_EMAIL = "ai@system.local";
const ADMIN_EMAIL = "seed-admin-test@example.test";

/** seed() is a deliberate no-op under vitest; clear the markers it checks. */
function enableSeed() {
  vi.stubEnv("VITEST", "");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("ADMIN_EMAIL", ADMIN_EMAIL);
}

beforeEach(async () => {
  await db.delete(users).where(eq(users.email, AI_USER_EMAIL));
  await db.delete(users).where(eq(users.email, ADMIN_EMAIL));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await db.delete(users).where(eq(users.email, AI_USER_EMAIL));
  await db.delete(users).where(eq(users.email, ADMIN_EMAIL));
});

describe("seed: ADMIN_PASSWORD unset", () => {
  it("creates no admin user", async () => {
    enableSeed();
    vi.stubEnv("ADMIN_PASSWORD", "");

    await seed(db);

    const admin = await db.select().from(users).where(eq(users.email, ADMIN_EMAIL));
    expect(admin).toHaveLength(0);
  });

  it("still creates the AI system user", async () => {
    enableSeed();
    vi.stubEnv("ADMIN_PASSWORD", "");

    await seed(db);

    const ai = await db.select().from(users).where(eq(users.email, AI_USER_EMAIL));
    expect(ai).toHaveLength(1);
  });
});

describe("seed: ADMIN_PASSWORD set", () => {
  it("creates both the admin and the AI system user", async () => {
    enableSeed();
    vi.stubEnv("ADMIN_PASSWORD", "a-real-password");

    await seed(db);

    const admin = await db.select().from(users).where(eq(users.email, ADMIN_EMAIL));
    const ai = await db.select().from(users).where(eq(users.email, AI_USER_EMAIL));
    expect(admin).toHaveLength(1);
    expect(ai).toHaveLength(1);
  });
});
