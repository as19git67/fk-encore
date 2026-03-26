import { describe, it, expect, beforeEach, vi } from "vitest";
import db from "../db/database";
import {
  sessions,
  rolePermissions,
  userRoles,
  users,
  permissions,
  roles,
  passkeys,
  challenges,
} from "../db/schema";
import { createUserLogic } from "./user.service";
import {
  passkeyRegisterOptionsLogic,
  passkeyAuthOptionsLogic,
  passkeyAuthVerifyLogic,
  listPasskeysLogic,
  deletePasskeyLogic,
} from "./passkey.service";

// Set required env vars for passkey service
process.env.RP_ORIGIN = "http://localhost:5173";
process.env.RP_NAME = "Test App";
process.env.RP_ID = "localhost";
process.env.NODE_ENV = "test";

beforeEach(async () => {
  await db.delete(challenges);
  await db.delete(passkeys);
  await db.delete(sessions);
  await db.delete(rolePermissions);
  await db.delete(userRoles);
  await db.delete(users);
  await db.delete(permissions);
  await db.delete(roles);
});

describe("Passkey Registration Options", () => {
  it("returns challenge and options for existing user", async () => {
    const user = await createUserLogic({
      email: "pk@example.com",
      name: "Passkey User",
      password: "secure123",
    });

    const result = await passkeyRegisterOptionsLogic(user.id);

    expect(result.challengeId).toBeDefined();
    expect(result.options).toBeDefined();
    expect(result.options.rp.id).toBe("localhost");
    expect(result.options.user.name).toBe("pk@example.com");
  });

  it("throws for non-existent user", async () => {
    await expect(passkeyRegisterOptionsLogic(99999)).rejects.toThrow(
      "not found"
    );
  });

  it("stores challenge in database", async () => {
    const user = await createUserLogic({
      email: "challenge@example.com",
      name: "Challenge User",
      password: "pw",
    });

    const result = await passkeyRegisterOptionsLogic(user.id);

    const storedChallenge = await db
      .select()
      .from(challenges)
      .where(
        (await import("drizzle-orm")).eq(challenges.id, result.challengeId)
      );
    expect(storedChallenge).toHaveLength(1);
    expect(storedChallenge[0].user_id).toBe(user.id);
  });

  it("excludes existing passkeys from options", async () => {
    const user = await createUserLogic({
      email: "existing@example.com",
      name: "Existing Passkey User",
      password: "pw",
    });

    // Insert a fake passkey for this user
    await db.insert(passkeys).values({
      credential_id: "existing-credential-id",
      user_id: user.id,
      public_key: "fakepublickey",
      counter: 0,
      device_type: "singleDevice",
      backed_up: 0,
      transports: "[]",
      name: "My Key",
    });

    const result = await passkeyRegisterOptionsLogic(user.id);

    const excluded = result.options.excludeCredentials ?? [];
    expect(excluded.some((c: { id: string }) => c.id === "existing-credential-id")).toBe(true);
  });

  it("throws when passkey is disabled", async () => {
    const user = await createUserLogic({
      email: "disabled@example.com",
      name: "Disabled User",
      password: "pw",
    });
    const credId = "disabled_cred_id";
    await db.insert(passkeys).values({
      credential_id: credId,
      user_id: user.id,
      public_key: "...",
      counter: 0,
      name: "Disabled Passkey",
      disabled: 1,
    });

    const { challengeId } = await passkeyAuthOptionsLogic();

    await expect(passkeyAuthVerifyLogic({
      challengeId,
      credential: {
        id: credId,
        rawId: credId,
        type: 'public-key',
        response: {} as any,
        clientExtensionResults: {},
        authenticatorAttachment: 'platform'
      }
    })).rejects.toThrow("invalid credentials");
  });
});

describe("Passkey Auth Options", () => {
  it("returns challenge and options for login", async () => {
    const result = await passkeyAuthOptionsLogic();

    expect(result.challengeId).toBeDefined();
    expect(result.options).toBeDefined();
    // Use console.log to debug the options structure if it fails again
    // console.log('Auth Options:', JSON.stringify(result.options, null, 2));
    expect(result.options.rpId || result.options.rpID || (result.options.rp && result.options.rp.id)).toBe("localhost");
  });

  it("stores anonymous challenge (no user_id)", async () => {
    const result = await passkeyAuthOptionsLogic();

    const storedChallenge = await db
      .select()
      .from(challenges)
      .where(
        (await import("drizzle-orm")).eq(challenges.id, result.challengeId)
      );
    expect(storedChallenge).toHaveLength(1);
    expect(storedChallenge[0].user_id).toBeNull();
  });
});

describe("List Passkeys", () => {
  it("returns empty list when user has no passkeys", async () => {
    const user = await createUserLogic({
      email: "nokeys@example.com",
      name: "No Keys",
      password: "pw",
    });

    const result = await listPasskeysLogic(user.id);
    expect(result.passkeys).toHaveLength(0);
  });

  it("returns all passkeys for user", async () => {
    const user = await createUserLogic({
      email: "haskeys@example.com",
      name: "Has Keys",
      password: "pw",
    });

    await db.insert(passkeys).values([
      {
        credential_id: "cred-1",
        user_id: user.id,
        public_key: "key1",
        counter: 0,
        device_type: "singleDevice",
        backed_up: 0,
        transports: "[]",
        name: "Key One",
      },
      {
        credential_id: "cred-2",
        user_id: user.id,
        public_key: "key2",
        counter: 5,
        device_type: "multiDevice",
        backed_up: 1,
        transports: '["usb"]',
        name: "Key Two",
      },
    ]);

    const result = await listPasskeysLogic(user.id);
    expect(result.passkeys).toHaveLength(2);
    expect(result.passkeys[0].name).toBe("Key One");
    expect(result.passkeys[1].backed_up).toBe(true);
    expect(result.passkeys[1].device_type).toBe("multiDevice");
  });

  it("only returns passkeys for the correct user", async () => {
    const userA = await createUserLogic({
      email: "a@example.com",
      name: "A",
      password: "pw",
    });
    const userB = await createUserLogic({
      email: "b@example.com",
      name: "B",
      password: "pw",
    });

    await db.insert(passkeys).values({
      credential_id: "cred-a",
      user_id: userA.id,
      public_key: "keyA",
      counter: 0,
      device_type: "singleDevice",
      backed_up: 0,
      name: "A Key",
    });

    const result = await listPasskeysLogic(userB.id);
    expect(result.passkeys).toHaveLength(0);
  });
});

describe("Delete Passkey", () => {
  it("deletes an existing passkey", async () => {
    const user = await createUserLogic({
      email: "delete@example.com",
      name: "Delete Me",
      password: "pw",
    });

    await db.insert(passkeys).values({
      credential_id: "to-delete",
      user_id: user.id,
      public_key: "key",
      counter: 0,
      device_type: "singleDevice",
      backed_up: 0,
      name: "Delete Me",
    });

    const result = await deletePasskeyLogic(user.id, "to-delete");
    expect(result.success).toBe(true);

    const remaining = await listPasskeysLogic(user.id);
    expect(remaining.passkeys).toHaveLength(0);
  });

  it("throws when passkey does not exist", async () => {
    const user = await createUserLogic({
      email: "nodelete@example.com",
      name: "No Delete",
      password: "pw",
    });

    await expect(
      deletePasskeyLogic(user.id, "nonexistent-credential")
    ).rejects.toThrow("passkey not found");
  });

  it("does not delete passkeys belonging to another user", async () => {
    const userA = await createUserLogic({
      email: "owner@example.com",
      name: "Owner",
      password: "pw",
    });
    const userB = await createUserLogic({
      email: "attacker@example.com",
      name: "Attacker",
      password: "pw",
    });

    await db.insert(passkeys).values({
      credential_id: "victims-key",
      user_id: userA.id,
      public_key: "key",
      counter: 0,
      device_type: "singleDevice",
      backed_up: 0,
      name: "Victim Key",
    });

    // userB tries to delete userA's passkey – must fail
    await expect(
      deletePasskeyLogic(userB.id, "victims-key")
    ).rejects.toThrow("passkey not found");

    // Passkey still exists
    const remaining = await listPasskeysLogic(userA.id);
    expect(remaining.passkeys).toHaveLength(1);
  });
});
