import { describe, it, expect, beforeEach } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";

import db from "../db/database";
import { userSubjectPersons } from "../db/schema";
import { runTaxReviewRecompute } from "./tax-review-recompute-cron";

// Every person below is invented.

const USERS = [990401, 990402];

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash)
        VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x')
        ON CONFLICT (id) DO NOTHING`,
  );
}

beforeEach(async () => {
  await db.delete(userSubjectPersons).where(inArray(userSubjectPersons.user_id, USERS));
  for (const id of USERS) await ensureUser(id);
});

describe("documents-tax-review-recompute cron", () => {
  it("walks every user with subject persons and re-derives stale flags", async () => {
    // A derived child flag left at true although a child in the household within
    // the age limit needs no review — the sweep must correct it.
    const [stale] = await db
      .insert(userSubjectPersons)
      .values({
        user_id: USERS[0],
        full_name: "Kind Beispiel",
        relation_tag: "kind",
        relation_kind: "child",
        birth_date: `${new Date().getFullYear() - 10}-05-05`,
        in_household: true,
        requires_tax_review: true,
        requires_tax_review_override: null,
      })
      .returning({ id: userSubjectPersons.id });
    // An explicit opt-in on another user stays as it is.
    const [pinned] = await db
      .insert(userSubjectPersons)
      .values({
        user_id: USERS[1],
        full_name: "Tante Beispiel",
        relation_tag: "tante",
        relation_kind: "other",
        requires_tax_review: true,
        requires_tax_review_override: true,
      })
      .returning({ id: userSubjectPersons.id });

    const result = await runTaxReviewRecompute();
    expect(result.users_processed).toBeGreaterThanOrEqual(2);

    const [after] = await db.select().from(userSubjectPersons).where(eq(userSubjectPersons.id, stale.id));
    expect(after.requires_tax_review).toBe(false);
    const [kept] = await db.select().from(userSubjectPersons).where(eq(userSubjectPersons.id, pinned.id));
    expect(kept.requires_tax_review).toBe(true);
    expect(result.persons_flipped).toBeGreaterThanOrEqual(1);

    // A second sweep finds nothing left to flip for these users.
    const again = await runTaxReviewRecompute();
    expect(again.users_processed).toBeGreaterThanOrEqual(2);
  });
});
