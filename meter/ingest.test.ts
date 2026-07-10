import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq } from "drizzle-orm";

import db from "../db/database";
import { users, meterApiKeys, meterReadings } from "../db/schema";
import { createMeter } from "./meter.service";
import { addReading } from "./readings.service";
import {
  createApiKey,
  listApiKeys,
  disableApiKey,
  deleteApiKey,
  resolveIngestKey,
  hashToken,
  touchLastUsed,
} from "./api-keys.service";
import { dbFirst } from "../db/adapter";
import { __resetRateLimiterForTests } from "../user/rateLimiter";

function setAuth(userID: string, perms: string[]) {
  vi.mocked(getAuthData).mockReturnValue({ userID, permissions: perms });
}

let userId: number;
const cleanupUserIds: number[] = [];

beforeEach(async () => {
  const [row] = await db
    .insert(users)
    .values({
      email: `ingest-${Date.now()}-${Math.random()}@example.com`,
      name: "Ingest Tester",
      password_hash: "x",
    })
    .returning({ id: users.id });
  userId = row.id;
  cleanupUserIds.push(userId);
  setAuth(String(userId), ["meters.view", "meters.read_entry", "meters.manage"]);
  __resetRateLimiterForTests();
});

afterEach(async () => {
  for (const id of cleanupUserIds.splice(0)) {
    await db.delete(users).where(eq(users.id, id));
  }
  vi.restoreAllMocks();
});

async function createTestMeter(name = "Test Meter") {
  return createMeter(userId, {
    name,
    type: "electricity",
    unit: "kWh",
    decimals: 1,
    device: {
      serialNumber: "SN-001",
      installedAt: "2024-01-01T00:00:00Z",
      startValue: 0,
    },
  });
}

describe("API key management", () => {
  it("creates a key and returns the plaintext token once", async () => {
    const { id: meterId } = await createTestMeter();
    const result = await createApiKey(userId, meterId, "Shelly EM");
    expect(result.token).toHaveLength(64);
    expect(result.name).toBe("Shelly EM");
    expect(result.meterId).toBe(meterId);
    expect(result.disabledAt).toBeNull();
  });

  it("lists keys without exposing the token", async () => {
    const { id: meterId } = await createTestMeter();
    await createApiKey(userId, meterId, "Key 1");
    await createApiKey(userId, meterId, "Key 2");

    const keys = await listApiKeys(userId, meterId);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toHaveProperty("token");
    expect(keys[1]).not.toHaveProperty("token");
  });

  it("disables a key (soft-delete)", async () => {
    const { id: meterId } = await createTestMeter();
    const { id: keyId } = await createApiKey(userId, meterId, "To Disable");

    await disableApiKey(userId, keyId);

    const keys = await listApiKeys(userId, meterId);
    const disabled = keys.find((k) => k.id === keyId)!;
    expect(disabled.disabledAt).not.toBeNull();
  });

  it("deletes a key permanently", async () => {
    const { id: meterId } = await createTestMeter();
    const { id: keyId } = await createApiKey(userId, meterId, "To Delete");

    await deleteApiKey(userId, keyId);

    const keys = await listApiKeys(userId, meterId);
    expect(keys.find((k) => k.id === keyId)).toBeUndefined();
  });

  it("rejects empty name", async () => {
    const { id: meterId } = await createTestMeter();
    await expect(createApiKey(userId, meterId, "  ")).rejects.toMatchObject({
      code: "invalid_argument",
    });
  });
});

describe("resolveIngestKey", () => {
  it("resolves a valid token to key + active device", async () => {
    const { id: meterId } = await createTestMeter();
    const { token } = await createApiKey(userId, meterId, "Valid Key");

    const { key, device } = await resolveIngestKey(token);
    expect(key.meter_id).toBe(meterId);
    expect(device.removed_at).toBeNull();
  });

  it("rejects an invalid token", async () => {
    await expect(resolveIngestKey("nonexistent-token-1234")).rejects.toMatchObject({
      code: "unauthenticated",
    });
  });

  it("rejects a disabled key", async () => {
    const { id: meterId } = await createTestMeter();
    const { id: keyId, token } = await createApiKey(userId, meterId, "Disabled");
    await disableApiKey(userId, keyId);

    await expect(resolveIngestKey(token)).rejects.toMatchObject({
      code: "unauthenticated",
    });
  });
});

describe("ingest integration", () => {
  it("inserts a reading via API key", async () => {
    const { id: meterId } = await createTestMeter();
    const { token, id: keyId } = await createApiKey(userId, meterId, "Ingest Key");
    const { key, device } = await resolveIngestKey(token);

    await db.insert(meterReadings).values({
      device_id: device.id,
      value: "100.000",
      taken_at: "2025-01-01T00:00:00Z",
      source: "api",
      api_key_id: key.id,
    });

    const row = await dbFirst<typeof meterReadings.$inferSelect>(
      db
        .select()
        .from(meterReadings)
        .where(eq(meterReadings.device_id, device.id)),
    );
    expect(row).not.toBeNull();
    expect(parseFloat(row!.value)).toBe(100);
    expect(row!.source).toBe("api");
    expect(row!.api_key_id).toBe(keyId);
  });

  it("duplicate (device_id, taken_at) raises unique constraint", async () => {
    const { id: meterId } = await createTestMeter();
    const { token } = await createApiKey(userId, meterId, "Dup Key");
    const { key, device } = await resolveIngestKey(token);

    await db.insert(meterReadings).values({
      device_id: device.id,
      value: "100.000",
      taken_at: "2025-06-01T12:00:00Z",
      source: "api",
      api_key_id: key.id,
    });

    await expect(
      db.insert(meterReadings).values({
        device_id: device.id,
        value: "100.000",
        taken_at: "2025-06-01T12:00:00Z",
        source: "api",
        api_key_id: key.id,
      }),
    ).rejects.toThrow();
  });

  it("touchLastUsed updates the timestamp", async () => {
    const { id: meterId } = await createTestMeter();
    const { id: keyId } = await createApiKey(userId, meterId, "Touch Key");

    expect(
      (await dbFirst<typeof meterApiKeys.$inferSelect>(
        db.select().from(meterApiKeys).where(eq(meterApiKeys.id, keyId)),
      ))!.last_used_at,
    ).toBeNull();

    await touchLastUsed(keyId);

    const updated = await dbFirst<typeof meterApiKeys.$inferSelect>(
      db.select().from(meterApiKeys).where(eq(meterApiKeys.id, keyId)),
    );
    expect(updated!.last_used_at).not.toBeNull();
  });

  it("monotonicity: value below start_value is rejected", async () => {
    const meter = await createMeter(userId, {
      name: "Mono Meter",
      type: "electricity",
      unit: "kWh",
      device: {
        installedAt: "2024-01-01T00:00:00Z",
        startValue: 100,
      },
    });

    // Add a reading below start_value (100) through the normal path
    await expect(
      addReading(userId, meter.id, { value: 50, takenAt: "2024-06-01T00:00:00Z" }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("hashToken produces consistent SHA-256 hex", () => {
    const token = "abc123";
    const hash1 = hashToken(token);
    const hash2 = hashToken(token);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });
});
