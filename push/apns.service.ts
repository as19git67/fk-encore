/**
 * APNs device tokens and the iOS leg of `sendToUser` (#765).
 *
 * Mirrors the Web Push subscription code: one row per device, an upsert
 * on re-registration (the phone hands the app the same token on every
 * launch, and a new one after a restore), pruning when Apple says the
 * token is dead. Sending is best-effort — a failure is logged, never
 * thrown, because push must not break the action that caused it.
 */

import { and, eq, sql } from "drizzle-orm";
import db from "../db/database";
import { dbAll, dbExec, dbFirst } from "../db/adapter";
import { apnsDeviceTokens } from "../db/schema";
import { apnsEnabled, sendApns } from "./apns-client";
import { isDeadToken, normaliseDeviceToken, parseEnvironment, type ApnsEnvironment } from "./apns-payload";
import type { PushPayload } from "./push.service";

export { apnsEnabled };

export interface RegisterDeviceInput {
  token: string;
  environment?: string;
  deviceName?: string | null;
}

/** Register or refresh a device. Returns null for a token that is not one. */
export async function saveDeviceToken(userId: number, input: RegisterDeviceInput): Promise<{ id: number } | null> {
  const token = normaliseDeviceToken(input.token);
  if (!token) return null;
  const environment = parseEnvironment(input.environment);
  const deviceName = input.deviceName?.trim().slice(0, 120) || null;

  // A token that moved to another account (a second person signing in on
  // the same phone) is re-homed: the phone is theirs now.
  const row = await dbFirst<{ id: number }>(
    db
      .insert(apnsDeviceTokens)
      .values({ user_id: userId, token, environment, device_name: deviceName })
      .onConflictDoUpdate({
        target: apnsDeviceTokens.token,
        set: { user_id: userId, environment, device_name: deviceName, updated_at: sql`NOW()` },
      })
      .returning({ id: apnsDeviceTokens.id }),
  );
  return row ? { id: row.id } : null;
}

export async function removeDeviceToken(userId: number, rawToken: string): Promise<{ removed: number }> {
  const token = normaliseDeviceToken(rawToken);
  if (!token) return { removed: 0 };
  const res = await dbExec(
    db.delete(apnsDeviceTokens).where(and(eq(apnsDeviceTokens.user_id, userId), eq(apnsDeviceTokens.token, token))),
  );
  return { removed: res.changes };
}

export async function removeAllDeviceTokensForUser(userId: number): Promise<{ removed: number }> {
  const res = await dbExec(db.delete(apnsDeviceTokens).where(eq(apnsDeviceTokens.user_id, userId)));
  return { removed: res.changes };
}

export interface DeviceTokenRow {
  id: number;
  token: string;
  environment: ApnsEnvironment;
  device_name: string | null;
}

export async function listUserDeviceTokens(userId: number): Promise<DeviceTokenRow[]> {
  const rows = await dbAll<{ id: number; token: string; environment: string; device_name: string | null }>(
    db
      .select({
        id: apnsDeviceTokens.id,
        token: apnsDeviceTokens.token,
        environment: apnsDeviceTokens.environment,
        device_name: apnsDeviceTokens.device_name,
      })
      .from(apnsDeviceTokens)
      .where(eq(apnsDeviceTokens.user_id, userId)),
  );
  return rows.map((r) => ({ ...r, environment: parseEnvironment(r.environment) }));
}

/**
 * Send to every iOS device of a user. Dead tokens are pruned; everything
 * else is logged. Returns nothing sent when APNs is not configured.
 */
export async function sendToUserDevices(userId: number, payload: PushPayload): Promise<{ sent: number; pruned: number }> {
  if (!apnsEnabled()) return { sent: 0, pruned: 0 };
  const devices = await listUserDeviceTokens(userId);
  if (devices.length === 0) return { sent: 0, pruned: 0 };

  let sent = 0;
  let pruned = 0;
  await Promise.all(
    devices.map(async (d) => {
      try {
        const result = await sendApns(d.token, d.environment, payload);
        if (result.status === 200) {
          sent += 1;
          await dbExec(
            db.update(apnsDeviceTokens).set({ last_used_at: sql`NOW()` }).where(eq(apnsDeviceTokens.id, d.id)),
          ).catch(() => undefined);
        } else if (isDeadToken(result.status, result.reason)) {
          await dbExec(db.delete(apnsDeviceTokens).where(eq(apnsDeviceTokens.id, d.id))).catch(() => undefined);
          pruned += 1;
        } else {
          console.warn(`[apns] send failed user=${userId} status=${result.status} reason=${result.reason ?? "?"}`);
        }
      } catch (err) {
        console.warn(`[apns] send error user=${userId}: ${(err as Error).message}`);
      }
    }),
  );
  return { sent, pruned };
}
