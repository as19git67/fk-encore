/**
 * Utility meters — API key management for external ingestion (Etappe 5).
 *
 * Each key is bound to exactly one meter. The plaintext token is a 32-byte
 * random hex string shown only once at creation; only a SHA-256 hash is
 * stored. Keys can be disabled (soft-delete) to preserve audit trails.
 */

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { APIError } from "encore.dev/api";
import db from "../db/database";
import { dbAll, dbFirst } from "../db/adapter";
import { meterApiKeys, meterDevices } from "../db/schema";
import { loadVisibleMeter } from "./meter.service";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export interface ApiKeyDto {
  id: number;
  meterId: number;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  disabledAt: string | null;
}

export interface CreateApiKeyResult extends ApiKeyDto {
  token: string;
}

export async function createApiKey(
  userId: number,
  meterId: number,
  name: string,
): Promise<CreateApiKeyResult> {
  await loadVisibleMeter(userId, meterId);

  const trimmed = (name ?? "").trim();
  if (!trimmed) throw APIError.invalidArgument("name must not be empty");

  const token = generateToken();
  const keyHash = hashToken(token);

  const [row] = await db
    .insert(meterApiKeys)
    .values({
      meter_id: meterId,
      name: trimmed,
      key_hash: keyHash,
      created_by: userId,
    })
    .returning({
      id: meterApiKeys.id,
      created_at: meterApiKeys.created_at,
    });

  return {
    id: row.id,
    meterId,
    name: trimmed,
    createdAt: row.created_at,
    lastUsedAt: null,
    disabledAt: null,
    token,
  };
}

export async function listApiKeys(
  userId: number,
  meterId: number,
): Promise<ApiKeyDto[]> {
  await loadVisibleMeter(userId, meterId);

  const rows = await dbAll<typeof meterApiKeys.$inferSelect>(
    db
      .select()
      .from(meterApiKeys)
      .where(eq(meterApiKeys.meter_id, meterId))
      .orderBy(meterApiKeys.created_at),
  );

  return rows.map((r) => ({
    id: r.id,
    meterId: r.meter_id,
    name: r.name,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    disabledAt: r.disabled_at,
  }));
}

export async function disableApiKey(
  userId: number,
  keyId: number,
): Promise<void> {
  const key = await dbFirst<typeof meterApiKeys.$inferSelect>(
    db.select().from(meterApiKeys).where(eq(meterApiKeys.id, keyId)),
  );
  if (!key) throw APIError.notFound("api key not found");

  await loadVisibleMeter(userId, key.meter_id);

  if (key.disabled_at) return;

  await db
    .update(meterApiKeys)
    .set({ disabled_at: new Date().toISOString() })
    .where(eq(meterApiKeys.id, keyId));
}

export async function deleteApiKey(
  userId: number,
  keyId: number,
): Promise<void> {
  const key = await dbFirst<typeof meterApiKeys.$inferSelect>(
    db.select().from(meterApiKeys).where(eq(meterApiKeys.id, keyId)),
  );
  if (!key) throw APIError.notFound("api key not found");

  await loadVisibleMeter(userId, key.meter_id);
  await db.delete(meterApiKeys).where(eq(meterApiKeys.id, keyId));
}

/**
 * Lookup a key by bearer token. Returns the key row plus the active device
 * of the associated meter, or throws if the key is invalid/disabled or the
 * meter has no active device.
 */
export async function resolveIngestKey(
  bearerToken: string,
): Promise<{
  key: typeof meterApiKeys.$inferSelect;
  device: typeof meterDevices.$inferSelect;
}> {
  const keyHash = hashToken(bearerToken);

  const key = await dbFirst<typeof meterApiKeys.$inferSelect>(
    db
      .select()
      .from(meterApiKeys)
      .where(eq(meterApiKeys.key_hash, keyHash)),
  );
  if (!key) throw APIError.unauthenticated("invalid api key");
  if (key.disabled_at) throw APIError.unauthenticated("api key is disabled");

  const [device] = await dbAll<typeof meterDevices.$inferSelect>(
    db
      .select()
      .from(meterDevices)
      .where(
        and(
          eq(meterDevices.meter_id, key.meter_id),
          isNull(meterDevices.removed_at),
        ),
      ),
  );
  if (!device) {
    throw APIError.failedPrecondition("meter has no active device");
  }

  return { key, device };
}

export async function touchLastUsed(keyId: number): Promise<void> {
  await db
    .update(meterApiKeys)
    .set({ last_used_at: new Date().toISOString() })
    .where(eq(meterApiKeys.id, keyId));
}
