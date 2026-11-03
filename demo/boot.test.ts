/**
 * The boot switch DEMO_DATA: what each value asks for, that the admin from
 * ADMIN_EMAIL owns the run, that a missing admin or an existing demo keeps
 * the boot alone, and that a system holding data is never touched.
 *
 * The shared test database is not untouched; the happy path pretends it
 * is, the refusal path uses the real check.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { demoRun, users } from "../db/schema";
import { demoDataSetting, loadDemoAtBoot } from "./boot";
import { removeRun } from "./remove";
import * as state from "./state";

vi.mock("../photo/scan-worker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../photo/scan-worker")>()),
  triggerWorkers: () => {},
}));
vi.mock("./state", async (importOriginal) => {
  const real = await importOriginal<typeof import("./state")>();
  return { ...real, isUntouched: vi.fn(real.isUntouched) };
});
vi.setConfig({ testTimeout: 60_000 });

const ADMIN = "demo-boot-admin@beispiel.test";
const OWNER = "demo-boot-owner@beispiel.test";
let adminId: number;

beforeAll(async () => {
  const [u] = await db.insert(users).values({ email: ADMIN, name: "Demo Boot", password_hash: "x" }).returning({ id: users.id });
  adminId = u.id;
});

afterEach(async () => {
  vi.mocked(state.isUntouched).mockRestore();
  const run = await state.currentRun();
  if (run) {
    await removeRun(run.id);
    await db.delete(demoRun).where(eq(demoRun.id, run.id));
  }
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, adminId));
  await db.delete(users).where(eq(users.email, OWNER));
});

describe("demoDataSetting", () => {
  it("reads 1 and its spellings as the full demo, small as the E2E household, anything else as off", () => {
    for (const v of ["1", "true", "YES", "on", "full", " full "]) expect(demoDataSetting(v)).toEqual({ size: "full", text: "llm" });
    expect(demoDataSetting("small")).toEqual({ size: "small", text: "template" });
    for (const v of [undefined, "", "0", "false", "off", "big"]) expect(demoDataSetting(v)).toBeNull();
  });
});

describe("loadDemoAtBoot", () => {
  it("does nothing when the switch is off or the admin does not exist", async () => {
    expect(await loadDemoAtBoot(null, ADMIN)).toBe("off");
    expect(await loadDemoAtBoot({ size: "small", text: "template" }, "nobody@beispiel.test")).toBe("no_admin");
    expect(await state.currentRun()).toBeNull();
  });

  it("leaves a system that holds data alone", async () => {
    // The shared test database holds rows of other test files.
    expect(await state.isUntouched()).toBe(false);
    expect(await loadDemoAtBoot({ size: "small", text: "template" }, ADMIN)).toBe("refused");
    expect(await state.currentRun()).toBeNull();
  });

  it("loads the small demo for the admin into an untouched system and does not load it twice", async () => {
    vi.mocked(state.isUntouched).mockResolvedValue(true);
    expect(await loadDemoAtBoot({ size: "small", text: "template" }, ADMIN, { today: "2026-10-26" })).toBe("loaded");
    const run = await state.currentRun();
    expect(run).toMatchObject({ owner_user_id: adminId, size: "small", text_source: "template", status: "done" });
    expect(run!.summary).toMatchObject({ documents: 30, photos: 12, meters: 5, businesses: 1 });

    expect(await loadDemoAtBoot({ size: "small", text: "template" }, ADMIN)).toBe("exists");
    expect((await db.select().from(demoRun).where(eq(demoRun.owner_user_id, adminId))).length).toBe(1);
  });

  it("gives the demo to the demo owner from DEMO_OWNER_EMAIL, not to the admin", async () => {
    vi.mocked(state.isUntouched).mockResolvedValue(true);
    const owner = { email: OWNER, password: "demo-pw", name: "Demo" };
    expect(await loadDemoAtBoot({ size: "small", text: "template" }, ADMIN, { today: "2026-10-26" }, owner)).toBe("loaded");
    const [ownerRow] = await db.select({ id: users.id }).from(users).where(eq(users.email, OWNER));
    expect(await state.currentRun()).toMatchObject({ owner_user_id: ownerRow.id, status: "done" });
  });
});
