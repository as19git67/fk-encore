/**
 * Utility meters — per-user quick-entry configuration.
 *
 * The configuration stores only the selected meters and their order. The
 * actual reading capture still uses the normal reading endpoint so validation
 * and monotonicity rules stay in one place.
 */

import { asc, eq } from "drizzle-orm";
import { APIError } from "encore.dev/api";
import db from "../db/database";
import { dbAll } from "../db/adapter";
import { meterQuickEntryItems } from "../db/schema";
import { listMeters, type MeterListItem } from "./meter.service";

export interface QuickEntryItem extends MeterListItem {
  sortOrder: number;
}

export interface QuickEntryConfig {
  items: QuickEntryItem[];
  availableMeters: MeterListItem[];
}

export async function getQuickEntryConfig(userId: number): Promise<QuickEntryConfig> {
  const availableMeters = await listMeters(userId);
  const byId = new Map(availableMeters.map((meter) => [meter.id, meter]));
  const rows = await dbAll<typeof meterQuickEntryItems.$inferSelect>(
    db
      .select()
      .from(meterQuickEntryItems)
      .where(eq(meterQuickEntryItems.user_id, userId))
      .orderBy(asc(meterQuickEntryItems.sort_order)),
  );

  const items = rows
    .map((row) => {
      const meter = byId.get(row.meter_id);
      if (!meter) return null;
      return { ...meter, sortOrder: row.sort_order };
    })
    .filter((item): item is QuickEntryItem => item !== null);

  return { items, availableMeters };
}

export async function saveQuickEntryConfig(
  userId: number,
  meterIds: number[],
): Promise<QuickEntryConfig> {
  const uniqueMeterIds = [...new Set(meterIds.map((id) => Number(id)).filter(Number.isInteger))];
  if (uniqueMeterIds.length > 100) {
    throw APIError.invalidArgument("quick-entry list may contain at most 100 meters");
  }

  const availableMeters = await listMeters(userId);
  const visibleIds = new Set(availableMeters.map((meter) => meter.id));
  const invalidId = uniqueMeterIds.find((id) => !visibleIds.has(id));
  if (invalidId !== undefined) {
    throw APIError.invalidArgument(`meter ${invalidId} is not visible`);
  }

  await db.transaction(async (tx) => {
    await tx.delete(meterQuickEntryItems).where(eq(meterQuickEntryItems.user_id, userId));
    if (uniqueMeterIds.length === 0) return;
    await tx.insert(meterQuickEntryItems).values(
      uniqueMeterIds.map((meterId, index) => ({
        user_id: userId,
        meter_id: meterId,
        sort_order: index,
      })),
    );
  });

  return await getQuickEntryConfig(userId);
}
