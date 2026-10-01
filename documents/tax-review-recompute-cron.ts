/**
 * Daily cron job: re-derive the tax-review flags of all Bezugspersonen.
 *
 * The derived `requires_tax_review` (migration 0145) depends on values that
 * change on their own as time passes — most visibly the child age limit
 * (§ 32 Abs. 4 EStG, see CHILD_AGE_LIMIT_YEARS): a child in the household
 * stops being "obviously the user's dependent" the year it turns 25. Nothing
 * in the request path notices that, so without this job the stored flag would
 * stay stale until someone happened to edit the person.
 *
 * The per-document decision is made against each document's own tax year
 * (see syncTaxReviewFlagForSubjectPerson), so the job is idempotent: on a day
 * where nothing aged over a boundary it writes nothing.
 */

import { api } from "encore.dev/api";
import { asc } from "drizzle-orm";

import db from "../db/database";
import { userSubjectPersons } from "../db/schema";
import { schedule, dailyAtUtc } from "../lib/local-cron";
import { recomputeDerivedTaxReviewForUser } from "./subject-persons";
import { syncTaxReviewFlagForAllSubjectPersons } from "./documents";

export interface TaxReviewRecomputeResult {
  users_processed: number;
  persons_flipped: number;
}

export async function runTaxReviewRecompute(): Promise<TaxReviewRecomputeResult> {
  // A typed query, not db.execute: with node-postgres the latter resolves to a
  // QueryResult object, and iterating that failed every nightly run.
  const rows = await db
    .selectDistinct({ user_id: userSubjectPersons.user_id })
    .from(userSubjectPersons)
    .orderBy(asc(userSubjectPersons.user_id));

  let personsFlipped = 0;
  for (const { user_id } of rows) {
    try {
      const flipped = await recomputeDerivedTaxReviewForUser(user_id);
      personsFlipped += flipped.length;
      // Always re-sync the documents, not only for flipped persons: the
      // per-document decision can change for individual tax years even when
      // the person-level (current-year) value stays the same.
      await syncTaxReviewFlagForAllSubjectPersons(user_id);
      if (flipped.length > 0) {
        console.log(
          `[documents] tax-review recompute: user=${user_id} flipped=${flipped
            .map((f) => `${f.id}→${f.newEffective}`)
            .join(", ")}`,
        );
      }
    } catch (err) {
      // One user's failure must not abort the whole sweep.
      console.error(
        `[documents] tax-review recompute for user=${user_id} failed:`,
        (err as Error).message,
      );
    }
  }

  return { users_processed: rows.length, persons_flipped: personsFlipped };
}

export const runTaxReviewRecomputeEndpoint = api(
  { expose: false, method: "POST", path: "/internal/documents/tax-review-recompute" },
  async (): Promise<TaxReviewRecomputeResult> => {
    return await runTaxReviewRecompute();
  },
);

// 04:15 Berlin (CEST) / 02:15 UTC — off-peak, before the morning batch window.
schedule({
  name: "documents-tax-review-recompute",
  description: "Re-derive Bezugspersonen tax-review flags (age limits, own returns)",
  service: "documents",
  scheduleLabel: "daily 02:15 UTC",
  nextFire: dailyAtUtc(2, 15),
  run: () => runTaxReviewRecomputeEndpoint(),
});
