/**
 * Takes a demo run back (documentation/plans/demodaten.md): every
 * registered row and file, in reverse dependency order. What the pipelines
 * derived from a registered row (balances, access lists, tag links, roles
 * of the spouse) hangs off it by foreign key and goes with it.
 */

import fs from "node:fs/promises";
import { and, eq, inArray, notExists, sql } from "drizzle-orm";
import db from "../db/database";
import { albums, demoFile, demoItem, demoRun, financeAccount, financeTag, financeTagTransaction, userAssessmentSettings, users, userSubjectPersons } from "../db/schema";
import { removeEnergy } from "./energy-writer";
import { purgeDocument } from "../documents/purge";
import { removePhotos } from "./photo-writer";
import { registered } from "./registry";
import { deleteBookingsOf } from "./writer";

export async function removeRun(runId: number): Promise<void> {
  await db.update(demoRun).set({ status: "removing", stage: "remove" }).where(eq(demoRun.id, runId));

  // Albums and photos first: nothing else points at them, and each photo has a file and thumbnails.
  const demoAlbums = await registered(runId, "albums");
  if (demoAlbums.length) await db.delete(albums).where(inArray(albums.id, demoAlbums));
  await removePhotos(await registered(runId, "photos"));

  // Documents next: a receipt can point at a booking, and each has a file on disk.
  for (const id of await registered(runId, "documents")) await purgeDocument(id);

  // The PV business, the meters with their readings and the tariffs: a reading can point at a booking.
  await removeEnergy({
    businesses: await registered(runId, "finance_business"),
    meters: await registered(runId, "meters"),
    tariffs: await registered(runId, "meter_electricity_tariffs"),
  });

  const accounts = await registered(runId, "finance_account");
  await deleteBookingsOf(accounts);
  if (accounts.length) await db.delete(financeAccount).where(inArray(financeAccount.id, accounts));

  // Tags the run created; their links went with the bookings. A tag someone
  // else has used since (another run, a user) stays.
  const tags = await registered(runId, "finance_tag");
  if (tags.length) {
    await db
      .delete(financeTag)
      .where(
        and(
          inArray(financeTag.id, tags),
          notExists(db.select({ one: sql`1` }).from(financeTagTransaction).where(eq(financeTagTransaction.tag_id, financeTag.id))),
        ),
      );
  }

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
