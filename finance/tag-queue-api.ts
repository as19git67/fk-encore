/**
 * Admin REST endpoints for the finance AI tag suggestion queue.
 * Mirrors the photo scan-queue endpoints under /finance/tag-queue/*.
 * All endpoints require the `data.manage` permission.
 */

import { api } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import {
  getTagQueueStatus,
  requeueFailedTagJobs,
  cancelPendingTagJobs,
  enqueueTagSuggestion,
  type TagQueueServiceStatus,
} from "./tag-queue";
import { triggerTagWorker } from "./tag-worker";
import db from "../db/database";
import {
  financeTransaction,
  financeAccountAccess,
  financeTagTransaction,
  financeTagQueue,
} from "../db/schema";
import { eq, and, inArray, sql, notExists, type SQLWrapper } from "drizzle-orm";

export interface TagQueueStatusResponse {
  status: TagQueueServiceStatus;
}

export const getFinanceTagQueueStatus = api(
  {
    expose: true,
    method: "GET",
    path: "/finance/tag-queue/status",
    auth: true,
  },
  async (): Promise<TagQueueStatusResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "data.manage");
    return { status: await getTagQueueStatus() };
  },
);

export interface RetryFailedResponse {
  requeued: number;
}

export const retryFailedTagJobs = api(
  {
    expose: true,
    method: "POST",
    path: "/finance/tag-queue/retry-failed",
    auth: true,
  },
  async (): Promise<RetryFailedResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "data.manage");
    const requeued = await requeueFailedTagJobs();
    if (requeued > 0) triggerTagWorker();
    return { requeued };
  },
);

export interface CancelPendingResponse {
  cancelled: number;
}

export const cancelPendingTagJobsEndpoint = api(
  {
    expose: true,
    method: "POST",
    path: "/finance/tag-queue/cancel",
    auth: true,
  },
  async (): Promise<CancelPendingResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "data.manage");
    const cancelled = await cancelPendingTagJobs();
    return { cancelled };
  },
);

interface ReenqueueAllParams {
  accountId?: number;
}
interface ReenqueueAllResponse {
  enqueued: number;
}

/** Re-enqueue only untagged, unprocessed transactions (#332). */
export const reenqueueAllTagJobs = api(
  {
    expose: true,
    method: "POST",
    path: "/finance/tag-queue/reenqueue",
    auth: true,
  },
  async (p: ReenqueueAllParams): Promise<ReenqueueAllResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "data.manage");

    const conds: SQLWrapper[] = [];
    if (!auth.permissions.includes("finance.admin")) {
      const accessible = await db
        .select({ id: financeAccountAccess.account_id })
        .from(financeAccountAccess)
        .where(eq(financeAccountAccess.user_id, Number(auth.userID)));
      const ids = accessible.map((a) => a.id);
      if (ids.length === 0) return { enqueued: 0 };
      conds.push(inArray(financeTransaction.account_id, ids));
    }
    if (p.accountId !== undefined) {
      conds.push(eq(financeTransaction.account_id, p.accountId));
    }

    // Skip transactions that already have any tags (user or AI)
    conds.push(
      notExists(
        db
          .select({ _: sql`1` })
          .from(financeTagTransaction)
          .where(
            eq(financeTagTransaction.transaction_id, financeTransaction.id),
          ),
      ),
    );

    // Skip transactions already processed by the AI pipeline (status = 'done'),
    // including those where the user later rejected all AI suggestions.
    conds.push(
      notExists(
        db
          .select({ _: sql`1` })
          .from(financeTagQueue)
          .where(
            and(
              eq(financeTagQueue.transaction_id, financeTransaction.id),
              eq(financeTagQueue.status, "done"),
            ),
          ),
      ),
    );

    const rows = await db
      .select({ id: financeTransaction.id })
      .from(financeTransaction)
      .where(and(...conds));

    const userId = Number(auth.userID);
    for (const r of rows) {
      await enqueueTagSuggestion(r.id, userId);
    }
    if (rows.length > 0) triggerTagWorker();
    return { enqueued: rows.length };
  },
);
