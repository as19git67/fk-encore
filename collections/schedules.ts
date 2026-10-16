/**
 * Scheduled exports of a collection (#1548, stage 9).
 *
 * A schedule says when (weekly, monthly, yearly), what (the whole collection,
 * or only what is dated in the elapsed period — "last month's card bookings
 * as PDF"), with which options (a profile, or the options at the time it was
 * made) and where the file goes: kept as a run for a week like any export,
 * filed as a document (PDFs), mailed to the recipients confirmed when the
 * schedule was set up.
 *
 * Runs happen as the person who set the schedule up, with their permissions
 * at the time of the run: what they can no longer see does not go out. An
 * archived collection pauses its schedules. A failed run tries again six
 * hours later, at most three times, then waits for the next regular date;
 * the last outcome is shown with the schedule.
 */

import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { api, APIError } from "encore.dev/api";
import log from "encore.dev/log";
import db from "../db/database";
import { dbAll, dbExec, dbFirst, dbInsertReturning } from "../db/adapter";
import { collectionSchedules, users } from "../db/schema";
import { loadReadableCollection, type CollectionRow } from "../documents/collection-access";
import { getPermissionsForUser } from "../user/user.service";
import { everyMs, schedule as scheduleJob } from "../lib/local-cron";
import { assertMayUseCollections, caller, isAdmin, type CollectionMember } from "./collections";
import type { Caller } from "./members";
import { ExportOptionsError, normalizeExportOptions, type ExportOptions } from "./export-options";
import { fileExportAsDocument, loadProfiles, runExportNow, toRun, type ExportRun } from "./exports";
import { mailExport, normalizeRecipients } from "./sending";
import {
  ScheduleSpecError,
  elapsedPeriod,
  inPeriod,
  lastDay,
  nextRunAt,
  normalizeSpec,
  type Cadence,
} from "./schedule-dates";

/** How often a failed run is tried again before waiting for the next date. */
const MAX_RETRIES = 3;
const RETRY_MS = 6 * 60 * 60 * 1000;

type ScheduleRow = typeof collectionSchedules.$inferSelect;

export interface CollectionSchedule {
  id: number;
  collection_id: number;
  profile_id: number | null;
  profile_name: string | null;
  cadence: "weekly" | "monthly" | "yearly";
  weekday: number | null;
  day: number | null;
  month: number | null;
  scope: "all" | "period";
  save_as_document: boolean;
  recipients: string[];
  single_files: boolean;
  message: string | null;
  enabled: boolean;
  next_run_at: string;
  last_run_at: string | null;
  last_status: "done" | "failed" | "skipped" | null;
  last_error: string | null;
  last_export_id: number | null;
  failures: number;
  /** Who set it up; runs happen as them. */
  owner_name: string | null;
  /** True when the caller may change or delete it. */
  can_edit: boolean;
}

async function toSchedules(rows: ScheduleRow[], c: Caller, collection: CollectionRow): Promise<CollectionSchedule[]> {
  if (rows.length === 0) return [];
  const profiles = new Map((await loadProfiles(collection.id)).map((p) => [p.id, p.name]));
  const owners = new Map(
    (
      await dbAll<{ id: number; name: string }>(
        db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(inArray(users.id, [...new Set(rows.map((r) => r.user_id))])),
      )
    ).map((u) => [u.id, u.name]),
  );
  const admin = isAdmin(c) || collection.user_id === c.userId;
  return rows.map((r) => ({
    id: r.id,
    collection_id: r.collection_id,
    profile_id: r.profile_id,
    profile_name: r.profile_id ? (profiles.get(r.profile_id) ?? null) : null,
    cadence: r.cadence,
    weekday: r.weekday,
    day: r.day,
    month: r.month,
    scope: r.scope,
    save_as_document: r.save_as_document,
    recipients: r.recipients,
    single_files: r.single_files,
    message: r.message,
    enabled: r.enabled,
    next_run_at: r.next_run_at,
    last_run_at: r.last_run_at,
    last_status: r.last_status,
    last_error: r.last_error,
    last_export_id: r.last_export_id,
    failures: r.failures,
    owner_name: owners.get(r.user_id) ?? null,
    can_edit: admin || r.user_id === c.userId,
  }));
}

async function readable(id: number): Promise<{ c: Caller; row: CollectionRow }> {
  const c = caller();
  assertMayUseCollections(c);
  return { c, row: await loadReadableCollection(c.userId, id, isAdmin(c)) };
}

async function loadEditable(scheduleId: number): Promise<{ c: Caller; schedule: ScheduleRow; collection: CollectionRow }> {
  const c = caller();
  assertMayUseCollections(c);
  const schedule = await dbFirst<ScheduleRow>(
    db.select().from(collectionSchedules).where(eq(collectionSchedules.id, scheduleId)),
  );
  if (!schedule) throw APIError.notFound("schedule not found");
  // Not readable reads as missing; readable but someone else's is forbidden.
  const collection = await loadReadableCollection(c.userId, schedule.collection_id, isAdmin(c)).catch(() => null);
  if (!collection) throw APIError.notFound("schedule not found");
  if (schedule.user_id !== c.userId && collection.user_id !== c.userId && !isAdmin(c)) {
    throw APIError.permissionDenied("only who set it up or the collection's owner may change a schedule");
  }
  return { c, schedule, collection };
}

// ─── Endpoints ──────────────────────────────────────────────────────────────

export const listSchedules = api(
  { expose: true, method: "GET", path: "/collections/:id/schedules", auth: true },
  async ({ id }: { id: number }): Promise<{ items: CollectionSchedule[] }> => {
    const { c, row } = await readable(id);
    const rows = await dbAll<ScheduleRow>(
      db
        .select()
        .from(collectionSchedules)
        .where(eq(collectionSchedules.collection_id, row.id))
        .orderBy(asc(collectionSchedules.next_run_at)),
    );
    return { items: await toSchedules(rows, c, row) };
  },
);

export interface CreateScheduleRequest {
  id: number;
  cadence: Cadence;
  weekday?: number | null;
  day?: number | null;
  month?: number | null;
  scope: "all" | "period";
  /** A profile of the collection; its options are read at each run. */
  profile_id?: number | null;
  /** Options to keep with the schedule when no profile is given. */
  options?: Record<string, unknown>;
  save_as_document?: boolean;
  recipients?: string[];
  single_files?: boolean;
  message?: string | null;
}

export const createSchedule = api(
  { expose: true, method: "POST", path: "/collections/:id/schedules", auth: true },
  async (req: CreateScheduleRequest): Promise<CollectionSchedule> => {
    const { c, row } = await readable(req.id);
    if (row.kind === "basket") throw APIError.failedPrecondition("the basket cannot be exported on a schedule; save it as a collection first");
    let spec;
    try {
      spec = normalizeSpec({ cadence: req.cadence, weekday: req.weekday, day: req.day, month: req.month });
    } catch (err) {
      if (err instanceof ScheduleSpecError) throw APIError.invalidArgument(err.message);
      throw err;
    }
    if (req.scope !== "all" && req.scope !== "period") throw APIError.invalidArgument("scope must be all or period");
    let profileId: number | null = null;
    let options: ExportOptions;
    if (req.profile_id) {
      const profile = (await loadProfiles(row.id)).find((p) => p.id === req.profile_id);
      if (!profile) throw APIError.notFound("profile not found");
      profileId = profile.id;
      options = profile.options;
    } else {
      try {
        options = normalizeExportOptions(req.options ?? {});
      } catch (err) {
        if (err instanceof ExportOptionsError) throw APIError.invalidArgument(err.message);
        throw err;
      }
    }
    const recipients = (req.recipients ?? []).length > 0 ? normalizeRecipients(req.recipients) : [];
    const saveAsDocument = req.save_as_document === true;
    if (saveAsDocument && !c.permissions.includes("documents.upload") && !c.permissions.includes("documents.edit")) {
      throw APIError.permissionDenied("missing permission: documents.upload");
    }
    const created = await dbInsertReturning<ScheduleRow>(
      db
        .insert(collectionSchedules)
        .values({
          collection_id: row.id,
          user_id: c.userId,
          profile_id: profileId,
          options: options as unknown as Record<string, unknown>,
          cadence: spec.cadence,
          weekday: spec.weekday,
          day: spec.day,
          month: spec.month,
          scope: req.scope,
          save_as_document: saveAsDocument,
          recipients,
          single_files: req.single_files === true,
          message: (req.message ?? "").trim().slice(0, 4000) || null,
          next_run_at: nextRunAt(spec, new Date()).toISOString(),
        })
        .returning(),
    );
    if (!created) throw APIError.internal("schedule not saved");
    return (await toSchedules([created], c, row))[0]!;
  },
);

export const setScheduleEnabled = api(
  { expose: true, method: "PATCH", path: "/collections/schedules/:scheduleId", auth: true },
  async ({ scheduleId, enabled }: { scheduleId: number; enabled: boolean }): Promise<CollectionSchedule> => {
    const { c, schedule, collection } = await loadEditable(scheduleId);
    const next = enabled ? nextRunAt(schedule, new Date()).toISOString() : schedule.next_run_at;
    await dbExec(
      db
        .update(collectionSchedules)
        .set({ enabled, next_run_at: next, failures: 0 })
        .where(eq(collectionSchedules.id, schedule.id)),
    );
    const fresh = await dbFirst<ScheduleRow>(db.select().from(collectionSchedules).where(eq(collectionSchedules.id, schedule.id)));
    return (await toSchedules([fresh!], c, collection))[0]!;
  },
);

export const deleteSchedule = api(
  { expose: true, method: "DELETE", path: "/collections/schedules/:scheduleId", auth: true },
  async ({ scheduleId }: { scheduleId: number }): Promise<{ ok: boolean }> => {
    const { schedule } = await loadEditable(scheduleId);
    await dbExec(db.delete(collectionSchedules).where(eq(collectionSchedules.id, schedule.id)));
    return { ok: true };
  },
);

/** Run a schedule now, out of turn; the next regular date stays. */
export const runScheduleNow = api(
  { expose: true, method: "POST", path: "/collections/schedules/:scheduleId/run", auth: true },
  async ({ scheduleId }: { scheduleId: number }): Promise<{ schedule: CollectionSchedule; run: ExportRun | null }> => {
    const { c, schedule, collection } = await loadEditable(scheduleId);
    const run = await runSchedule(schedule, new Date(), { keepNextRun: true });
    const fresh = await dbFirst<ScheduleRow>(db.select().from(collectionSchedules).where(eq(collectionSchedules.id, schedule.id)));
    return { schedule: (await toSchedules([fresh!], c, collection))[0]!, run };
  },
);

// ─── Running ────────────────────────────────────────────────────────────────

/** The options a run uses: the profile's current ones, else the stored ones. */
async function optionsFor(schedule: ScheduleRow): Promise<ExportOptions> {
  if (schedule.profile_id) {
    const profile = (await loadProfiles(schedule.collection_id)).find((p) => p.id === schedule.profile_id);
    if (profile) return profile.options;
  }
  return normalizeExportOptions(schedule.options);
}

/**
 * One run: export as the owner, then file and mail. Records the outcome on
 * the schedule and moves its next date (or a retry). Returns the export run.
 */
export async function runSchedule(
  schedule: ScheduleRow,
  now: Date,
  opts: { keepNextRun?: boolean } = {},
): Promise<ExportRun | null> {
  const record = async (status: "done" | "failed" | "skipped", error: string | null, exportId: number | null) => {
    const failures = status === "failed" ? schedule.failures + 1 : 0;
    let next = schedule.next_run_at;
    if (!opts.keepNextRun) {
      next =
        status === "failed" && failures <= MAX_RETRIES
          ? new Date(now.getTime() + RETRY_MS).toISOString()
          : nextRunAt(schedule, now).toISOString();
    }
    await dbExec(
      db
        .update(collectionSchedules)
        .set({
          last_run_at: now.toISOString(),
          last_status: status,
          last_error: error,
          last_export_id: exportId ?? schedule.last_export_id,
          failures: status === "failed" && failures > MAX_RETRIES ? 0 : failures,
          next_run_at: next,
        })
        .where(eq(collectionSchedules.id, schedule.id)),
    );
  };

  let c: Caller;
  let collection: CollectionRow;
  try {
    c = { userId: schedule.user_id, permissions: await getPermissionsForUser(schedule.user_id) };
    collection = await loadReadableCollection(c.userId, schedule.collection_id, isAdmin(c));
  } catch {
    await record("failed", "Die Mappe ist für den Besitzer des Zeitplans nicht mehr lesbar.", null);
    return null;
  }
  if (collection.archived_at) {
    await record("skipped", "Die Mappe ist archiviert; der Zeitplan pausiert.", null);
    return null;
  }

  try {
    const options = await optionsFor(schedule);
    let keep: ((m: CollectionMember) => boolean) | undefined;
    if (schedule.scope === "period") {
      const period = elapsedPeriod(schedule.cadence, now);
      // Meters are dated by their readings: the period goes into their options.
      options.meter = { ...options.meter, from: period.from, to: lastDay(period) };
      keep = (m) => m.entity_type === "meter" || inPeriod(m.date, period);
    }
    const exported = await runExportNow(c, collection, options, schedule.profile_id, keep);
    if (exported.status !== "done") {
      await record("failed", exported.error ?? "Export fehlgeschlagen.", exported.id);
      return toRun(exported);
    }
    const problems: string[] = [];
    if (schedule.save_as_document) {
      if (exported.mime_type === "application/pdf") {
        try {
          await fileExportAsDocument(exported, c.userId);
        } catch (err) {
          problems.push(`Als Dokument ablegen: ${(err as Error).message}`);
        }
      } else {
        problems.push("Als Dokument ablegen geht nur mit einem PDF.");
      }
    }
    if (schedule.recipients.length > 0) {
      try {
        await mailExport(exported, c, schedule.recipients, schedule.message, schedule.single_files);
      } catch (err) {
        problems.push(`E-Mail: ${(err as Error).message}`);
      }
    }
    await record(problems.length ? "failed" : "done", problems.join(" · ") || null, exported.id);
    return toRun(exported);
  } catch (err) {
    const message = err instanceof APIError ? err.message : (err as Error)?.message ?? String(err);
    await record("failed", message.slice(0, 500), null);
    return null;
  }
}

/** Every due schedule, run once. The hourly job; also callable from tests. */
export async function runDueSchedules(now = new Date()): Promise<{ ran: number; failed: number }> {
  const due = await dbAll<ScheduleRow>(
    db
      .select()
      .from(collectionSchedules)
      .where(and(eq(collectionSchedules.enabled, true), lte(collectionSchedules.next_run_at, now.toISOString())))
      .orderBy(asc(collectionSchedules.next_run_at)),
  );
  let failed = 0;
  for (const schedule of due) {
    try {
      await runSchedule(schedule, now);
      const after = await dbFirst<{ last_status: string | null }>(
        db.select({ last_status: collectionSchedules.last_status }).from(collectionSchedules).where(eq(collectionSchedules.id, schedule.id)),
      );
      if (after?.last_status === "failed") failed++;
    } catch (err) {
      failed++;
      log.warn("scheduled collection export failed", { schedule_id: schedule.id, error: (err as Error)?.message });
    }
  }
  return { ran: due.length, failed };
}

export const runCollectionSchedules = api(
  { expose: false, method: "POST", path: "/internal/collections/run-schedules" },
  async (): Promise<{ ran: number; failed: number }> => await runDueSchedules(),
);

scheduleJob({
  name: "collections-schedules",
  description: "Run the scheduled exports of collections that are due",
  service: "collections",
  scheduleLabel: "every hour",
  nextFire: everyMs(60 * 60_000),
  run: () => runCollectionSchedules(),
});
