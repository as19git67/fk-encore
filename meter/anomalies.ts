/**
 * Utility meters — anomaly endpoints + daily job registration
 * (Issue #792, Etappe 7 / #1015).
 *
 *   GET  /meters/anomalies                 pending (or all) findings on visible meters (meters.view)
 *   POST /meters/anomalies/:id/status      confirm / dismiss                          (meters.read_entry)
 *   POST /meters/anomalies/run             run the job now, optionally reset pending  (meters.manage)
 *   POST /internal/meters/anomaly-detection  job entry point (not exposed)
 */

import { api, APIError } from "encore.dev/api";
import type { Query } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { and, desc, eq, inArray } from "drizzle-orm";
import db from "../db/database";
import { dbAll, dbFirst } from "../db/adapter";
import {
  meterAnomalies,
  meters,
  type MeterAnomalyStatus,
  type MeterAnomalyType,
  type MeterType,
} from "../db/schema";
import { requirePermission } from "../user/auth-handler";
import { dailyAtUtc, schedule } from "../lib/local-cron";
import { loadUserGroupIds, visibleMetersWhere } from "./meter.service";
import { runMeterAnomalyDetection, type AnomalyRunResult } from "./anomalies.service";

function requireUser(permission: string): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, permission);
  return parseInt(auth.userID, 10);
}

export interface MeterAnomalyItem {
  id: number;
  meterId: number;
  meterName: string;
  meterType: MeterType;
  unit: string;
  decimals: number;
  type: MeterAnomalyType;
  status: MeterAnomalyStatus;
  score: number | null;
  intervalStart: string;
  intervalEnd: string;
  readingId: number | null;
  details: Record<string, unknown>;
  /** Human-readable German description generated from details. */
  message: string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface ListMeterAnomaliesResponse {
  anomalies: MeterAnomalyItem[];
  total: number;
}

function fmtNumber(value: unknown, decimals: number): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "–";
  return n.toLocaleString("de-DE", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
}

export function anomalyMessage(
  type: MeterAnomalyType,
  details: Record<string, unknown>,
  unit: string,
  decimals: number,
  intervalStart: string,
  intervalEnd: string,
): string {
  const span = `${fmtDate(intervalStart)} – ${fmtDate(intervalEnd)}`;
  const rate = fmtNumber(details.rate, Math.min(decimals + 1, 3));
  const mean = fmtNumber(details.baselineMean, Math.min(decimals + 1, 3));
  switch (type) {
    case "consumption_spike": {
      const factor = Number(details.baselineMean) > 0
        ? (Number(details.rate) / Number(details.baselineMean)).toLocaleString("de-DE", { maximumFractionDigits: 1 })
        : "–";
      return `Verbrauch ${rate} ${unit}/Tag (${span}) — das ${factor}-Fache des üblichen Werts von ${mean} ${unit}/Tag.`;
    }
    case "consumption_drop":
      return `Verbrauch nur ${rate} ${unit}/Tag (${span}) — deutlich unter dem üblichen Wert von ${mean} ${unit}/Tag.`;
    case "standstill":
      return `Zähler steht still: keine Betriebsstunden seit ${fmtNumber(details.days, 0)} Tagen (${span}), üblich sind ${mean} ${unit}/Tag.`;
    case "negative_consumption":
      return `Zählerstand rückläufig: ${fmtNumber(details.startValue, decimals)} → ${fmtNumber(details.endValue, decimals)} ${unit} (${span}) — vermutlich ein Tippfehler oder ein falscher Startwert nach Gerätewechsel.`;
  }
}

interface ListRequest {
  /** `pending` (default) or `all`. */
  status?: Query<string>;
}

export const listMeterAnomalies = api(
  { expose: true, method: "GET", path: "/meters/anomalies", auth: true },
  async ({ status }: ListRequest): Promise<ListMeterAnomaliesResponse> => {
    const userId = requireUser("meters.view");
    const scope = status ?? "pending";
    if (scope !== "pending" && scope !== "all") {
      throw APIError.invalidArgument("status must be 'pending' or 'all'");
    }

    const groupIds = await loadUserGroupIds(userId);
    const rows = await dbAll<{
      anomaly: typeof meterAnomalies.$inferSelect;
      meter: { id: number; name: string; type: MeterType; unit: string; decimals: number };
    }>(
      db
        .select({
          anomaly: meterAnomalies,
          meter: {
            id: meters.id,
            name: meters.name,
            type: meters.type,
            unit: meters.unit,
            decimals: meters.decimals,
          },
        })
        .from(meterAnomalies)
        .innerJoin(meters, eq(meters.id, meterAnomalies.meter_id))
        .where(
          and(
            visibleMetersWhere(userId, groupIds),
            scope === "pending" ? eq(meterAnomalies.status, "pending") : undefined,
          ),
        )
        .orderBy(desc(meterAnomalies.interval_end), desc(meterAnomalies.id))
        .limit(200),
    );

    const anomalies = rows.map(({ anomaly, meter }): MeterAnomalyItem => {
      const details = (anomaly.details ?? {}) as Record<string, unknown>;
      return {
        id: Number(anomaly.id),
        meterId: meter.id,
        meterName: meter.name,
        meterType: meter.type,
        unit: meter.unit,
        decimals: meter.decimals,
        type: anomaly.type,
        status: anomaly.status,
        score: anomaly.score === null ? null : Number(anomaly.score),
        intervalStart: anomaly.interval_start,
        intervalEnd: anomaly.interval_end,
        readingId: anomaly.reading_id === null ? null : Number(anomaly.reading_id),
        details,
        message: anomalyMessage(
          anomaly.type,
          details,
          meter.unit,
          meter.decimals,
          anomaly.interval_start,
          anomaly.interval_end,
        ),
        createdAt: anomaly.created_at,
        resolvedAt: anomaly.resolved_at,
      };
    });
    return { anomalies, total: anomalies.length };
  },
);

interface SetStatusRequest {
  id: number;
  status: string;
}

export const setMeterAnomalyStatus = api(
  { expose: true, method: "POST", path: "/meters/anomalies/:id/status", auth: true },
  async ({ id, status }: SetStatusRequest): Promise<{ ok: boolean }> => {
    const userId = requireUser("meters.read_entry");
    if (status !== "confirmed" && status !== "dismissed" && status !== "pending") {
      throw APIError.invalidArgument("status must be 'confirmed', 'dismissed' or 'pending'");
    }

    const groupIds = await loadUserGroupIds(userId);
    const row = await dbFirst<{ id: number }>(
      db
        .select({ id: meterAnomalies.id })
        .from(meterAnomalies)
        .innerJoin(meters, eq(meters.id, meterAnomalies.meter_id))
        .where(and(eq(meterAnomalies.id, id), visibleMetersWhere(userId, groupIds))),
    );
    if (!row) throw APIError.notFound("anomaly not found");

    await db
      .update(meterAnomalies)
      .set({
        status,
        resolved_at: status === "pending" ? null : new Date().toISOString(),
        resolved_by: status === "pending" ? null : userId,
      })
      .where(eq(meterAnomalies.id, id));
    return { ok: true };
  },
);

export const runMeterAnomalyDetectionJob = api(
  { expose: false, method: "POST", path: "/internal/meters/anomaly-detection" },
  async (): Promise<AnomalyRunResult> => {
    const result = await runMeterAnomalyDetection();
    console.log(
      `[meter.anomaly] done: meters=${result.meters} found=${result.anomaliesFound} ` +
        `created=${result.anomaliesCreated} withdrawn=${result.anomaliesWithdrawn}`,
    );
    return result;
  },
);

export const triggerMeterAnomalyDetection = api(
  { expose: true, method: "POST", path: "/meters/anomalies/run", auth: true },
  async ({ reset }: { reset?: boolean }): Promise<AnomalyRunResult> => {
    const userId = requireUser("meters.manage");
    if (reset) {
      // Only the caller's own visible meters are reset; other households
      // keep their inbox.
      const groupIds = await loadUserGroupIds(userId);
      const visible = await dbAll<{ id: number }>(
        db.select({ id: meters.id }).from(meters).where(visibleMetersWhere(userId, groupIds)),
      );
      if (visible.length > 0) {
        await db
          .delete(meterAnomalies)
          .where(
            and(
              inArray(meterAnomalies.meter_id, visible.map((m) => m.id)),
              eq(meterAnomalies.status, "pending"),
            ),
          );
      }
    }
    return runMeterAnomalyDetectionJob();
  },
);

// Daily, after the finance anomaly run (10:00 UTC) so both inboxes are
// fresh in the same late-morning window.
schedule({
  name: "meter-anomaly-detection",
  description: "Flag unusual consumption rates, standstills and backwards readings on utility meters",
  service: "meter",
  scheduleLabel: "daily 10:30 UTC",
  nextFire: dailyAtUtc(10, 30),
  run: () => runMeterAnomalyDetectionJob(),
});
