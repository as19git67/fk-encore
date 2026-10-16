import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const EXPORT_DIR = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR || "/tmp"}/collection-schedules-test-${process.pid}`;
  process.env.COLLECTION_EXPORTS_DIR = dir;
  return dir;
});

import { getAuthData } from "~encore/auth";
import { eq, inArray, sql } from "drizzle-orm";
import fs from "fs";
import path from "path";

import db from "../db/database";
import {
  collectionSchedules,
  financeAccount,
  financeAccountAccess,
  financeAccountType,
  financeTransaction,
} from "../db/schema";
import { setMailTransportForTests } from "../user/mail";
import { createAnyCollection, getBasket, updateAnyCollection } from "./collections";
import { COLLECTION_EXPORTS_DIR } from "./exports";
import {
  createSchedule,
  deleteSchedule,
  listSchedules,
  runDueSchedules,
  runScheduleNow,
  setScheduleEnabled,
} from "./schedules";
import { elapsedPeriod, inPeriod, lastDay, nextRunAt, normalizeSpec, ScheduleSpecError } from "./schedule-dates";

const OWNER = 954_001;
const OTHER = 954_002;
const USERS = [OWNER, OTHER];
const PERMISSIONS = ["finance.view"];

function as(userId: number): void {
  vi.mocked(getAuthData).mockReturnValue({ userID: String(userId), permissions: PERMISSIONS });
}

let sent: Array<{ to: string[]; from: unknown; attachments: Array<{ filename: string }> }> = [];
const created = { accounts: [] as number[] };

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM document_collections WHERE user_id IN (${sql.join(USERS, sql`, `)})`);
  if (created.accounts.length) {
    await db.delete(financeTransaction).where(inArray(financeTransaction.account_id, created.accounts));
    await db.delete(financeAccountAccess).where(inArray(financeAccountAccess.account_id, created.accounts));
    await db.delete(financeAccount).where(inArray(financeAccount.id, created.accounts));
  }
  created.accounts = [];
  await db.execute(sql`DELETE FROM user_roles WHERE user_id IN (${sql.join(USERS, sql`, `)})`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${sql.join(USERS, sql`, `)})`);
}

const TEST_ROLE = "collections-schedules-test";

/** Runs happen with the owner's real permissions, so the owner gets a role with finance.view. */
async function grantFinanceView(userId: number): Promise<void> {
  await db.execute(sql`INSERT INTO permissions (key) VALUES ('finance.view') ON CONFLICT (key) DO NOTHING`);
  await db.execute(sql`INSERT INTO roles (name) VALUES (${TEST_ROLE}) ON CONFLICT (name) DO NOTHING`);
  await db.execute(sql`
    INSERT INTO role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM roles r, permissions p
    WHERE r.name = ${TEST_ROLE} AND p.key = 'finance.view'
    ON CONFLICT DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO user_roles (user_id, role_id)
    SELECT ${userId}, id FROM roles WHERE name = ${TEST_ROLE}
    ON CONFLICT DO NOTHING
  `);
}

beforeEach(async () => {
  await cleanup();
  for (const id of USERS) {
    await db.execute(sql`
      INSERT INTO users (id, email, name, password_hash)
      VALUES (${id}, ${`u${id}@schedules.test`}, ${`Person ${id}`}, 'x')
    `);
  }
  await grantFinanceView(OWNER);
  sent = [];
  setMailTransportForTests({
    sendMail: (async (mail: { to: string[]; from: unknown; attachments: Array<{ filename: string }> }) => {
      sent.push(mail);
      return {};
    }) as never,
  });
  as(OWNER);
});

afterEach(() => setMailTransportForTests(null));

afterAll(async () => {
  await cleanup();
  await db.execute(sql`DELETE FROM roles WHERE name = ${TEST_ROLE}`);
  await fs.promises.rm(EXPORT_DIR, { recursive: true, force: true });
});

let seq = 0;

async function bookings(dates: string[]): Promise<number> {
  const [type] = await db.select({ id: financeAccountType.id }).from(financeAccountType).limit(1);
  const [acc] = await db
    .insert(financeAccount)
    .values({ type_id: type!.id, currency_code: "EUR", account_number: `SCH-${++seq}`, label: "Kreditkarte" })
    .returning({ id: financeAccount.id });
  created.accounts.push(acc!.id);
  await db.insert(financeAccountAccess).values({ account_id: acc!.id, user_id: OWNER, level: "read" });
  const ids: number[] = [];
  for (const [i, date] of dates.entries()) {
    const [tx] = await db
      .insert(financeTransaction)
      .values({
        account_id: acc!.id,
        booking_date: date,
        amount: "-10.00",
        currency_code: "EUR",
        counterparty: `Händler ${i + 1}`,
        dedupe_hash: `schedules-${++seq}`,
      })
      .returning({ id: financeTransaction.id });
    ids.push(tx!.id);
  }
  const col = await createAnyCollection({
    name: "Kartenumsätze",
    members: ids.map((id) => ({ entity_type: "transaction" as const, entity_id: id })),
  });
  return col.id;
}

// ─── Dates ──────────────────────────────────────────────────────────────────

describe("schedule dates", () => {
  it("finds the next run strictly after a moment, at 04:00 UTC", () => {
    const wed = new Date("2026-10-14T12:00:00Z"); // a Wednesday
    expect(nextRunAt({ cadence: "weekly", weekday: 1 }, wed).toISOString()).toBe("2026-10-19T04:00:00.000Z");
    expect(nextRunAt({ cadence: "weekly", weekday: 3 }, wed).toISOString()).toBe("2026-10-21T04:00:00.000Z");
    expect(nextRunAt({ cadence: "weekly", weekday: 3 }, new Date("2026-10-14T03:00:00Z")).toISOString()).toBe(
      "2026-10-14T04:00:00.000Z",
    );
    expect(nextRunAt({ cadence: "monthly", day: 1 }, wed).toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(nextRunAt({ cadence: "monthly", day: 20 }, wed).toISOString()).toBe("2026-10-20T04:00:00.000Z");
    expect(nextRunAt({ cadence: "monthly", day: 5 }, new Date("2026-12-10T00:00:00Z")).toISOString()).toBe(
      "2027-01-05T04:00:00.000Z",
    );
    expect(nextRunAt({ cadence: "yearly", month: 1, day: 15 }, wed).toISOString()).toBe("2027-01-15T04:00:00.000Z");
  });

  it("refuses days that do not exist every month", () => {
    expect(() => normalizeSpec({ cadence: "monthly", day: 31 })).toThrow(ScheduleSpecError);
    expect(() => normalizeSpec({ cadence: "weekly", weekday: 0 })).toThrow(ScheduleSpecError);
    expect(() => normalizeSpec({ cadence: "yearly", day: 1 })).toThrow(ScheduleSpecError);
  });

  it("reports on the elapsed week, month or year", () => {
    const run = new Date("2026-03-01T04:00:00Z");
    expect(elapsedPeriod("monthly", run)).toEqual({ from: "2026-02-01", to: "2026-03-01" });
    expect(elapsedPeriod("yearly", run)).toEqual({ from: "2025-01-01", to: "2026-01-01" });
    expect(elapsedPeriod("weekly", run)).toEqual({ from: "2026-02-22", to: "2026-03-01" });
    expect(elapsedPeriod("monthly", new Date("2026-01-03T04:00:00Z"))).toEqual({ from: "2025-12-01", to: "2026-01-01" });
    expect(lastDay({ to: "2026-03-01" })).toBe("2026-02-28");
    expect(inPeriod("2026-02-28T23:00:00", { from: "2026-02-01", to: "2026-03-01" })).toBe(true);
    expect(inPeriod("2026-03-01", { from: "2026-02-01", to: "2026-03-01" })).toBe(false);
    expect(inPeriod(null, { from: "2026-02-01", to: "2026-03-01" })).toBe(false);
  });
});

// ─── Runs ───────────────────────────────────────────────────────────────────

describe("scheduled exports", () => {
  it("exports only last month's items on its day and mails them", async () => {
    const col = await bookings(["2026-01-20", "2026-02-03", "2026-02-27", "2026-03-02"]);
    const schedule = await createSchedule({
      id: col,
      cadence: "monthly",
      day: 1,
      scope: "period",
      options: { transaction: { format: "csv" } },
      recipients: ["steuer@beispiel.test"],
    });
    expect(schedule).toMatchObject({ cadence: "monthly", day: 1, scope: "period", enabled: true, can_edit: true });

    // Not due yet: nothing happens.
    expect(await runDueSchedules(new Date("2026-01-01T00:00:00Z"))).toEqual({ ran: 0, failed: 0 });

    await db.update(collectionSchedules).set({ next_run_at: "2026-03-01T04:00:00Z" }).where(eq(collectionSchedules.id, schedule.id));
    expect(await runDueSchedules(new Date("2026-03-01T04:10:00Z"))).toEqual({ ran: 1, failed: 0 });

    const [after] = (await listSchedules({ id: col })).items;
    expect(after).toMatchObject({ last_status: "done", last_error: null, failures: 0 });
    expect(after!.next_run_at.startsWith("2026-04-01")).toBe(true);

    const csv = (await fs.promises.readFile(path.join(COLLECTION_EXPORTS_DIR, String(after!.last_export_id)))).toString("utf8");
    expect(csv).toContain("Händler 2");
    expect(csv).toContain("Händler 3");
    expect(csv).not.toContain("Händler 1");
    expect(csv).not.toContain("Händler 4");

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual(["steuer@beispiel.test"]);
    expect(sent[0]!.from).toEqual({ name: `Person ${OWNER}`, address: `u${OWNER}@schedules.test` });
    expect(sent[0]!.attachments.map((a) => a.filename)).toEqual(["Kartenumsätze - Buchungen.csv"]);
    expect(after!.sender).toBe(`u${OWNER}@schedules.test`);
  });

  it("mails the owner from the app's address when only they get it", async () => {
    const col = await bookings(["2026-02-03"]);
    const schedule = await createSchedule({
      id: col,
      cadence: "monthly",
      day: 1,
      scope: "all",
      options: { transaction: { format: "csv" } },
      recipients: [`u${OWNER}@schedules.test`],
    });
    expect(schedule.sender).toBe("noreply@example.com");
    await db.update(collectionSchedules).set({ next_run_at: "2026-03-01T04:00:00Z" }).where(eq(collectionSchedules.id, schedule.id));
    expect(await runDueSchedules(new Date("2026-03-01T04:00:00Z"))).toEqual({ ran: 1, failed: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.from).toBe("noreply@example.com");
  });

  it("tries a failed run again six hours later", async () => {
    const col = await bookings(["2026-02-03"]);
    const schedule = await createSchedule({
      id: col,
      cadence: "monthly",
      day: 1,
      scope: "all",
      options: { transaction: { format: "csv" } },
      recipients: ["steuer@beispiel.test"],
    });
    setMailTransportForTests({
      sendMail: (async () => {
        throw new Error("connection refused");
      }) as never,
    });
    await db.update(collectionSchedules).set({ next_run_at: "2026-03-01T04:00:00Z" }).where(eq(collectionSchedules.id, schedule.id));
    expect(await runDueSchedules(new Date("2026-03-01T04:00:00Z"))).toEqual({ ran: 1, failed: 1 });
    const [after] = (await listSchedules({ id: col })).items;
    expect(after!.last_status).toBe("failed");
    expect(after!.last_error).toContain("connection refused");
    expect(after!.failures).toBe(1);
    expect(new Date(after!.next_run_at).toISOString()).toBe("2026-03-01T10:00:00.000Z");
  });

  it("pauses while the collection is archived", async () => {
    const col = await bookings(["2026-02-03"]);
    const schedule = await createSchedule({ id: col, cadence: "weekly", weekday: 1, scope: "all" });
    await updateAnyCollection({ id: col, archived: true });
    await db.update(collectionSchedules).set({ next_run_at: "2026-03-02T04:00:00Z" }).where(eq(collectionSchedules.id, schedule.id));
    await runDueSchedules(new Date("2026-03-02T05:00:00Z"));
    const [after] = (await listSchedules({ id: col })).items;
    expect(after!.last_status).toBe("skipped");
    expect(after!.last_export_id).toBeNull();
  });

  it("runs on demand without moving the next date", async () => {
    const col = await bookings(["2026-02-03"]);
    const schedule = await createSchedule({ id: col, cadence: "yearly", month: 1, day: 2, scope: "all", options: { transaction: { format: "pdf" } } });
    const { schedule: after, run } = await runScheduleNow({ scheduleId: schedule.id });
    expect(run?.status).toBe("done");
    expect(run?.mime_type).toBe("application/pdf");
    expect(after.next_run_at).toBe(schedule.next_run_at);
    expect(after.last_status).toBe("done");
  });

  it("only lets its owner change it, refuses the basket and bad recipients", async () => {
    const col = await bookings(["2026-02-03"]);
    const schedule = await createSchedule({ id: col, cadence: "monthly", day: 3, scope: "all" });
    await expect(
      createSchedule({ id: col, cadence: "monthly", day: 3, scope: "all", recipients: ["kein-adresse"] }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(createSchedule({ id: col, cadence: "monthly", day: 30, scope: "all" })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    const basket = await getBasket();
    await expect(createSchedule({ id: basket.id, cadence: "monthly", day: 3, scope: "all" })).rejects.toMatchObject({
      code: "failed_precondition",
    });

    as(OTHER);
    // A private collection of someone else reads as missing.
    await expect(deleteSchedule({ scheduleId: schedule.id })).rejects.toMatchObject({ code: "not_found" });

    as(OWNER);
    const paused = await setScheduleEnabled({ scheduleId: schedule.id, enabled: false });
    expect(paused.enabled).toBe(false);
    await deleteSchedule({ scheduleId: schedule.id });
    expect((await listSchedules({ id: col })).items).toHaveLength(0);
  });
});
