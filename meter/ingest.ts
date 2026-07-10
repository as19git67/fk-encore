/**
 * External meter reading ingestion (Etappe 5).
 *
 *   POST /api/meters/ingest
 *     Authorization: Bearer <token>
 *     { "value": 1234.5, "takenAt": "2026-07-09T06:00:00Z" }
 *
 * Auth via API key (not Encore auth handler). The key is bound to one meter;
 * the reading targets the meter's active device. Idempotent: a duplicate
 * (device_id, taken_at) returns 200 with `duplicate: true`. Monotonicity
 * violations return 422.
 */

import { api, APIError } from "encore.dev/api";
import type { IncomingMessage, ServerResponse } from "node:http";
import { and, asc, desc, eq, gt, lt } from "drizzle-orm";
import db from "../db/database";
import { dbAll } from "../db/adapter";
import { meterReadings } from "../db/schema";
import { resolveIngestKey, touchLastUsed } from "./api-keys.service";
import { checkRateLimit } from "../user/rateLimiter";

function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function jsonResponse(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function extractBearer(req: IncomingMessage): string {
  const header = req.headers["authorization"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw APIError.unauthenticated("missing Authorization header");
  const parts = value.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer" || !parts[1]) {
    throw APIError.unauthenticated("expected: Authorization: Bearer <token>");
  }
  return parts[1];
}

async function assertMonotonicIngest(
  deviceId: number,
  value: number,
  takenAt: string,
  startValue: number,
): Promise<void> {
  if (value < startValue) {
    throw APIError.invalidArgument(
      `value (${value}) must be >= device start value (${startValue})`,
    );
  }

  const [prev] = await dbAll<{ value: string }>(
    db
      .select({ value: meterReadings.value })
      .from(meterReadings)
      .where(
        and(
          eq(meterReadings.device_id, deviceId),
          lt(meterReadings.taken_at, takenAt),
        ),
      )
      .orderBy(desc(meterReadings.taken_at))
      .limit(1),
  );
  if (prev && value < parseFloat(prev.value)) {
    throw APIError.invalidArgument(
      `value (${value}) must be >= previous reading (${prev.value})`,
    );
  }

  const [next] = await dbAll<{ value: string }>(
    db
      .select({ value: meterReadings.value })
      .from(meterReadings)
      .where(
        and(
          eq(meterReadings.device_id, deviceId),
          gt(meterReadings.taken_at, takenAt),
        ),
      )
      .orderBy(asc(meterReadings.taken_at))
      .limit(1),
  );
  if (next && value > parseFloat(next.value)) {
    throw APIError.invalidArgument(
      `value (${value}) must be <= following reading (${next.value})`,
    );
  }
}

export const ingestReading = api.raw(
  { expose: true, method: "POST", path: "/api/meters/ingest", auth: false },
  async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const token = extractBearer(req);

      checkRateLimit(`ingest:${token.slice(0, 8)}`, {
        maxAttempts: 120,
        windowMs: 60_000,
        message: "Rate limit exceeded for this API key.",
      });

      const { key, device } = await resolveIngestKey(token);

      const body = await readJsonBody(req);
      const value = body?.value;
      if (typeof value !== "number" || !Number.isFinite(value)) {
        jsonResponse(res, 400, { error: "value must be a finite number" });
        return;
      }

      const takenAt = body.takenAt
        ? new Date(body.takenAt)
        : new Date();
      if (Number.isNaN(takenAt.getTime())) {
        jsonResponse(res, 400, { error: "takenAt is not a valid timestamp" });
        return;
      }
      const takenAtIso = takenAt.toISOString();

      const startValue = parseFloat(device.start_value);
      await assertMonotonicIngest(device.id, value, takenAtIso, startValue);

      try {
        await db.insert(meterReadings).values({
          device_id: device.id,
          value: value.toFixed(3),
          taken_at: takenAtIso,
          source: "api",
          api_key_id: key.id,
        });
      } catch (err: any) {
        if ((err?.code ?? err?.cause?.code) === "23505") {
          touchLastUsed(key.id).catch(() => {});
          jsonResponse(res, 200, { duplicate: true, takenAt: takenAtIso });
          return;
        }
        throw err;
      }

      touchLastUsed(key.id).catch(() => {});
      jsonResponse(res, 201, { duplicate: false, takenAt: takenAtIso });
    } catch (err: any) {
      if (err instanceof APIError) {
        const status =
          err.code === "unauthenticated" ? 401
          : err.code === "permission_denied" ? 403
          : err.code === "resource_exhausted" ? 429
          : err.code === "invalid_argument" ? 422
          : err.code === "failed_precondition" ? 400
          : 500;
        jsonResponse(res, status, { error: err.message });
        return;
      }
      if (err?.message === "body too large") {
        jsonResponse(res, 413, { error: "body too large" });
        return;
      }
      if (err?.message === "invalid JSON") {
        jsonResponse(res, 400, { error: "invalid JSON body" });
        return;
      }
      jsonResponse(res, 500, { error: "internal error" });
    }
  },
);
