// APNs device-token bookkeeping (#765): registration is idempotent per
// token, a token follows the account that last registered it, and
// removal is scoped to the caller.

import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import db from "../db/database";
import { dbAll } from "../db/adapter";
import { apnsDeviceTokens, users } from "../db/schema";
import { createUserLogic } from "../user/user.service";
import {
  listUserDeviceTokens,
  removeAllDeviceTokensForUser,
  removeDeviceToken,
  saveDeviceToken,
  sendToUserDevices,
} from "./apns.service";

const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);

describe("apns device tokens", () => {
  let alice: { id: number };
  let bob: { id: number };

  beforeEach(async () => {
    await db.delete(apnsDeviceTokens);
    await db.delete(users);
    alice = await createUserLogic({ email: "apns-a@test.local", name: "A", password: "pw" });
    bob = await createUserLogic({ email: "apns-b@test.local", name: "B", password: "pw" });
  });

  it("registers a device once, however often the app says so", async () => {
    const first = await saveDeviceToken(alice.id, { token: TOKEN_A, environment: "sandbox", deviceName: "iPhone" });
    const second = await saveDeviceToken(alice.id, { token: TOKEN_A.toUpperCase(), environment: "sandbox" });
    expect(first?.id).toBe(second?.id);
    const rows = await listUserDeviceTokens(alice.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].environment).toBe("sandbox");
    expect(rows[0].token).toBe(TOKEN_A);
  });

  it("rejects what is not a token", async () => {
    expect(await saveDeviceToken(alice.id, { token: "nope" })).toBeNull();
    expect(await listUserDeviceTokens(alice.id)).toEqual([]);
  });

  it("re-homes a token when another account registers it", async () => {
    await saveDeviceToken(alice.id, { token: TOKEN_A });
    await saveDeviceToken(bob.id, { token: TOKEN_A, environment: "production" });
    expect(await listUserDeviceTokens(alice.id)).toEqual([]);
    const bobs = await listUserDeviceTokens(bob.id);
    expect(bobs.map((r) => r.token)).toEqual([TOKEN_A]);
    expect(bobs[0].environment).toBe("production");
  });

  it("removes only the caller's own token", async () => {
    await saveDeviceToken(alice.id, { token: TOKEN_A });
    await saveDeviceToken(bob.id, { token: TOKEN_B });
    expect(await removeDeviceToken(alice.id, TOKEN_B)).toEqual({ removed: 0 });
    expect(await removeDeviceToken(alice.id, TOKEN_A)).toEqual({ removed: 1 });
    expect(await removeDeviceToken(alice.id, "junk")).toEqual({ removed: 0 });
    expect(await listUserDeviceTokens(bob.id)).toHaveLength(1);
  });

  it("removes every device on sign-out everywhere", async () => {
    await saveDeviceToken(alice.id, { token: TOKEN_A });
    await saveDeviceToken(alice.id, { token: TOKEN_B });
    expect(await removeAllDeviceTokensForUser(alice.id)).toEqual({ removed: 2 });
    expect(await dbAll(db.select().from(apnsDeviceTokens).where(eq(apnsDeviceTokens.user_id, alice.id)))).toEqual([]);
  });

  it("sends nothing while APNs is not configured", async () => {
    await saveDeviceToken(alice.id, { token: TOKEN_A });
    // No ApnsKeyId/ApnsTeamId/ApnsPrivateKey secrets in the test
    // environment: the leg is a no-op, and the token stays.
    expect(await sendToUserDevices(alice.id, { title: "t", body: "b" })).toEqual({ sent: 0, pruned: 0 });
    expect(await listUserDeviceTokens(alice.id)).toHaveLength(1);
  });
});
