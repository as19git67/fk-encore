/**
 * Takes a demo run back (documentation/plans/demodaten.md): every
 * registered row and file, in reverse dependency order. What the pipelines
 * derived from a registered row (balances, access lists, tag links, roles
 * of the spouse) hangs off it by foreign key and goes with it.
 */

import fs from "node:fs/promises";
import { eq, inArray } from "drizzle-orm";
import db from "../db/database";
import { demoFile, demoItem, demoRun, financeAccount, userAssessmentSettings, users, userSubjectPersons } from "../db/schema";
import { registered } from "./registry";
import { deleteBookingsOf } from "./writer";

export async function removeRun(runId: number): Promise<void> {
  await db.update(demoRun).set({ status: "removing", stage: "remove" }).where(eq(demoRun.id, runId));

  const accounts = await registered(runId, "finance_account");
  await deleteBookingsOf(accounts);
  if (accounts.length) await db.delete(financeAccount).where(inArray(financeAccount.id, accounts));

  const assessments = await registered(runId, "user_assessment_settings");
  if (assessments.length) await db.delete(userAssessmentSettings).where(inArray(userAssessmentSettings.id, assessments));

  const persons = await registered(runId, "user_subject_persons");
  if (persons.length) await db.delete(userSubjectPersons).where(inArray(userSubjectPersons.id, persons));

  const demoUsers = await registered(runId, "users");
  if (demoUsers.length) await db.delete(users).where(inArray(users.id, demoUsers));

  const files = await db.select({ path: demoFile.path }).from(demoFile).where(eq(demoFile.run_id, runId));
  for (const f of files) {
    await fs.rm(f.path, { force: true });
  }

  await db.delete(demoItem).where(eq(demoItem.run_id, runId));
  await db.delete(demoFile).where(eq(demoFile.run_id, runId));
  await db
    .update(demoRun)
    .set({ status: "removed", stage: null, removed_at: new Date().toISOString() })
    .where(eq(demoRun.id, runId));
}
