/**
 * Backfill of the tax values (documentation/plans/steuer-ausfuellhilfe.md,
 * stage 2).
 *
 * New evidence is read right after classify. Evidence classified before the
 * reading existed is queued here by an admin, optionally for one tax year;
 * `reread` queues documents read before again (after a prompt or a kind
 * changed). Confirmed and corrected values survive a re-read.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { sql } from "drizzle-orm";
import db from "../db/database";
import { requirePermission } from "../user/auth-handler";
import { queueTaxValuesIfEvidence } from "./tax-values";
import { triggerWorkers } from "./scan-worker";

const DEFAULT_BATCH = 200;
const MAX_BATCH = 2000;

export interface TaxValuesBackfillRequest {
  /** Only evidence of this tax year. */
  year?: number;
  /** Also documents read before. */
  reread?: boolean;
  /** Documents to look at in this call (default 200). */
  limit?: number;
}

export interface TaxValuesBackfillResponse {
  queued: number;
  /** Evidence documents of the year (or all years) not read yet, after this call. */
  remaining: number;
}

const yearFilter = (year: number | undefined) => (year === undefined ? sql`` : sql`AND d.tax_year = ${year}`);

async function unread(year: number | undefined, reread: boolean, limit: number): Promise<number[]> {
  const rows = await db.execute<{ id: number }>(sql`
    SELECT d.id
    FROM documents d
    WHERE d.status = 'ready'
      AND d.tax_role = 'beleg'
      AND d.tax_year IS NOT NULL
      AND d.extracted_text IS NOT NULL
      ${yearFilter(year)}
      ${reread ? sql`` : sql`AND NOT EXISTS (SELECT 1 FROM document_tax_reading r WHERE r.document_id = d.id)`}
      AND NOT EXISTS (
        SELECT 1 FROM document_scan_queue q
        WHERE q.document_id = d.id AND q.service = 'tax_values' AND q.status IN ('pending', 'processing')
      )
    ORDER BY d.tax_year DESC, d.id ASC
    LIMIT ${limit}
  `);
  return rows.rows.map((r) => Number(r.id));
}

async function countUnread(year: number | undefined): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n
    FROM documents d
    WHERE d.status = 'ready'
      AND d.tax_role = 'beleg'
      AND d.tax_year IS NOT NULL
      AND d.extracted_text IS NOT NULL
      ${yearFilter(year)}
      AND NOT EXISTS (SELECT 1 FROM document_tax_reading r WHERE r.document_id = d.id)
  `);
  return Number(rows.rows[0]?.n ?? 0);
}

/**
 * Queues the reading for evidence not read yet. A document none of whose
 * sections has a kind to read is skipped and still counts as remaining:
 * there is nothing to read until a kind for it exists.
 */
export async function queueTaxValuesBackfill(req: TaxValuesBackfillRequest): Promise<TaxValuesBackfillResponse> {
  const limit = Math.min(MAX_BATCH, Math.max(1, Math.floor(req.limit ?? DEFAULT_BATCH)));
  let queued = 0;
  for (const id of await unread(req.year, req.reread ?? false, limit)) {
    if (await queueTaxValuesIfEvidence(id)) queued++;
  }
  if (queued) triggerWorkers();
  return { queued, remaining: await countUnread(req.year) };
}

function requireAdmin(): void {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "module.documents");
  requirePermission(auth, "data.manage");
}

export const backfillTaxValues = api(
  { expose: true, method: "POST", path: "/documents/tax-values/backfill", auth: true },
  async (req: TaxValuesBackfillRequest): Promise<TaxValuesBackfillResponse> => {
    requireAdmin();
    if (req.year !== undefined && (!Number.isInteger(req.year) || req.year < 1990 || req.year > 2100)) {
      throw APIError.invalidArgument("year out of range");
    }
    return queueTaxValuesBackfill(req);
  },
);
