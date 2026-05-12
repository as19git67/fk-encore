import { api } from "encore.dev/api";
import { sql } from "drizzle-orm";
import db from "../db/database";

export type AiModel = "insightface" | "embedding" | "landmark" | "llm";

export interface AcquireSlotRequest {
  model: AiModel;
  priority: number;
  requester: string;
}

export interface AcquireSlotResponse {
  slotId: number;
  status: "active" | "waiting";
  position: number;
}

export interface SlotIdRequest {
  slotId: number;
}

export interface PollSlotResponse {
  status: "active" | "waiting" | "cancelled";
  position: number;
}

export interface QueueModelStatus {
  model: string;
  activeSlot: { requester: string; since: string } | null;
  waitingCount: number;
  waitingByPriority: { p1: number; p2: number; p3: number };
}

export interface QueueStatusResponse {
  models: QueueModelStatus[];
}

export const acquireSlot = api(
  { method: "POST", path: "/ai-queue/acquire", expose: false },
  async (req: AcquireSlotRequest): Promise<AcquireSlotResponse> => {
    const insertRows = await db.execute<{ id: number }>(sql`
      INSERT INTO ai_model_slot (model_name, priority, requester, status, enqueued_at)
      VALUES (${req.model}, ${req.priority}, ${req.requester}, 'waiting', NOW())
      RETURNING id
    `);
    const slotId = Number(insertRows.rows[0].id);

    const activated = await db.execute(sql`
      UPDATE ai_model_slot
      SET status = 'active', activated_at = NOW()
      WHERE id = ${slotId}
        AND NOT EXISTS (
          SELECT 1 FROM ai_model_slot
          WHERE model_name = ${req.model} AND status = 'active'
        )
    `);

    const wasActivated = (activated as any).rowCount > 0;

    if (wasActivated) {
      return { slotId, status: "active", position: 0 };
    }

    const posRows = await db.execute<{ pos: number }>(sql`
      SELECT COUNT(*)::int AS pos
      FROM ai_model_slot
      WHERE model_name = ${req.model}
        AND status = 'waiting'
        AND id != ${slotId}
        AND (
          priority < ${req.priority}
          OR (priority = ${req.priority} AND enqueued_at < (
            SELECT enqueued_at FROM ai_model_slot WHERE id = ${slotId}
          ))
        )
    `);

    return { slotId, status: "waiting", position: (posRows.rows[0]?.pos ?? 0) + 1 };
  },
);

export const pollSlot = api(
  { method: "POST", path: "/ai-queue/poll", expose: false },
  async (req: SlotIdRequest): Promise<PollSlotResponse> => {
    const rows = await db.execute<{
      status: string;
      model_name: string;
      priority: number;
      enqueued_at: string;
    }>(sql`
      SELECT status, model_name, priority, enqueued_at
      FROM ai_model_slot
      WHERE id = ${req.slotId}
    `);

    const row = rows.rows[0];
    if (!row) {
      return { status: "cancelled", position: 0 };
    }

    if (row.status === "active") {
      return { status: "active", position: 0 };
    }

    const posRows = await db.execute<{ pos: number }>(sql`
      SELECT COUNT(*)::int AS pos
      FROM ai_model_slot
      WHERE model_name = ${row.model_name}
        AND status = 'waiting'
        AND id != ${req.slotId}
        AND (
          priority < ${row.priority}
          OR (priority = ${row.priority} AND enqueued_at < ${row.enqueued_at}::timestamptz)
        )
    `);

    return { status: "waiting", position: (posRows.rows[0]?.pos ?? 0) + 1 };
  },
);

export const releaseSlot = api(
  { method: "POST", path: "/ai-queue/release", expose: false },
  async (req: SlotIdRequest): Promise<void> => {
    const deleted = await db.execute<{ model_name: string }>(sql`
      DELETE FROM ai_model_slot
      WHERE id = ${req.slotId}
      RETURNING model_name
    `);

    const modelName = deleted.rows[0]?.model_name;
    if (!modelName) return;

    await db.execute(sql`
      UPDATE ai_model_slot
      SET status = 'active', activated_at = NOW()
      WHERE id = (
        SELECT id FROM ai_model_slot
        WHERE model_name = ${modelName} AND status = 'waiting'
        ORDER BY priority ASC, enqueued_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
    `);
  },
);

export const cancelSlot = api(
  { method: "POST", path: "/ai-queue/cancel", expose: false },
  async (req: SlotIdRequest): Promise<void> => {
    await db.execute(sql`
      DELETE FROM ai_model_slot
      WHERE id = ${req.slotId} AND status = 'waiting'
    `);
  },
);

export const getQueueStatus = api(
  { method: "GET", path: "/ai-queue/status", expose: false, auth: false },
  async (): Promise<QueueStatusResponse> => {
    const ALL_MODELS: AiModel[] = ["insightface", "embedding", "landmark", "llm"];

    const activeRows = await db.execute<{
      model_name: string;
      requester: string;
      activated_at: string;
    }>(sql`
      SELECT model_name, requester, activated_at
      FROM ai_model_slot
      WHERE status = 'active'
    `);

    const waitingRows = await db.execute<{
      model_name: string;
      priority: number;
      cnt: number;
    }>(sql`
      SELECT model_name, priority, COUNT(*)::int AS cnt
      FROM ai_model_slot
      WHERE status = 'waiting'
      GROUP BY model_name, priority
    `);

    const activeByModel = new Map<string, { requester: string; since: string }>();
    for (const r of activeRows.rows) {
      activeByModel.set(r.model_name, {
        requester: r.requester,
        since: r.activated_at,
      });
    }

    const waitingByModel = new Map<string, { p1: number; p2: number; p3: number }>();
    for (const r of waitingRows.rows) {
      if (!waitingByModel.has(r.model_name)) {
        waitingByModel.set(r.model_name, { p1: 0, p2: 0, p3: 0 });
      }
      const entry = waitingByModel.get(r.model_name)!;
      if (r.priority === 1) entry.p1 = r.cnt;
      else if (r.priority === 2) entry.p2 = r.cnt;
      else if (r.priority === 3) entry.p3 = r.cnt;
    }

    const models: QueueModelStatus[] = ALL_MODELS.map((m) => {
      const active = activeByModel.get(m) ?? null;
      const waiting = waitingByModel.get(m) ?? { p1: 0, p2: 0, p3: 0 };
      return {
        model: m,
        activeSlot: active,
        waitingCount: waiting.p1 + waiting.p2 + waiting.p3,
        waitingByPriority: waiting,
      };
    });

    return { models };
  },
);

export const cleanupStaleSlots = api(
  { method: "POST", path: "/ai-queue/cleanup", expose: false },
  async (): Promise<{ cleaned: number }> => {
    const STALE_TTL_MINUTES = parseInt(process.env.AI_QUEUE_STALE_TTL_MINUTES ?? "5", 10);

    const stale = await db.execute<{ id: number; model_name: string }>(sql`
      DELETE FROM ai_model_slot
      WHERE status = 'active'
        AND activated_at < NOW() - INTERVAL '1 minute' * ${STALE_TTL_MINUTES}
      RETURNING id, model_name
    `);

    const cleaned = stale.rows.length;

    const affectedModels = new Set(stale.rows.map((r) => r.model_name));
    for (const modelName of affectedModels) {
      await db.execute(sql`
        UPDATE ai_model_slot
        SET status = 'active', activated_at = NOW()
        WHERE id = (
          SELECT id FROM ai_model_slot
          WHERE model_name = ${modelName} AND status = 'waiting'
          ORDER BY priority ASC, enqueued_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
      `);
    }

    if (cleaned > 0) {
      console.log(`[ai-queue] cleaned ${cleaned} stale slot(s)`);
    }

    return { cleaned };
  },
);
