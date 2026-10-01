/**
 * Periodic sync of bank statements + cleanup of expired TAN sessions.
 *
 * Two CronJobs register themselves at module load:
 *
 *   - finance-sync-statements (every 5m): iterates
 *     finance_bankcontact rows, figures out which ones have a
 *     sync_times slot that matches the current tick (in the slot's
 *     own time zone), and runs the sync for each. Pushes a
 *     notification on tan-required and updates last_sync_at /
 *     last_sync_status.
 *
 *   - finance-tan-cleanup (every 1h): deletes rows in
 *     finance_tan_session whose expires_at has passed. The endpoint
 *     itself lives in tan-sessions.ts; we just wire the CronJob
 *     here so the two cron declarations live side-by-side.
 *
 * Transport-level deduplication of TAN-required push notifications
 * uses the browser-native `tag` attribute (same tag replaces the
 * previous one) — the server does not keep a rate-limit table yet;
 * that's tracked as a follow-up in finance-rate-limiting.md §5.
 *
 * Architecture: docs/finance-fints-integration.md §5 and
 * docs/finance-logging-monitoring.md §2.1.
 */

import { api, APIError } from "encore.dev/api";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import db from "../db/database";
import {
  financeAccount,
  financeAccountAccess,
  financeBankcontact,
  financeTanSession,
} from "../db/schema";
import { runSynchronize } from "./fints-client";
import { fetchAndPersist, type SyncApiResponse } from "./statements";
import { cleanupExpiredTanSessions } from "./tan-sessions";
import { sendToUser, type PushPayload } from "../push/push.service";
import type { FinanceSyncSlot } from "../db/schema";
import { everyMs, schedule } from "../lib/local-cron";

console.log("[boot] finance/statements-cron.ts: all imports resolved");

// -----------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------

/** CronJob fires every CRON_INTERVAL_MINUTES. */
const CRON_INTERVAL_MINUTES = 5;

/**
 * Half-width of the "is a slot due right now?" window, in minutes.
 * Must be ≥ CRON_INTERVAL_MINUTES / 2 so that every minute is
 * covered by exactly one tick. 3 minutes gives a little slack
 * against clock drift; overlapping ticks are harmless because the
 * inner loop serialises by bankcontact.
 */
const SLOT_MATCH_TOLERANCE_MIN = Math.ceil(CRON_INTERVAL_MINUTES / 2) + 1;

/** TAN session lifetime — see docs/finance-fints-integration.md §4. */
const TAN_SESSION_TTL_MS = 10 * 60_000;

// -----------------------------------------------------------------------
// Public internal endpoint
// -----------------------------------------------------------------------

interface SyncStatementsResponse {
  contacts_considered: number;
  contacts_due: number;
  ok: number;
  tan_required: number;
  errored: number;
}

export const syncStatements = api(
  {
    expose: false,
    method: "POST",
    path: "/internal/finance/sync-statements",
  },
  async (): Promise<SyncStatementsResponse> => {
    const now = new Date();
    const bankcontacts = await db.select().from(financeBankcontact);
    let due = 0;
    let ok = 0;
    let tanRequired = 0;
    let errored = 0;

    for (const bc of bankcontacts) {
      const slots = Array.isArray(bc.sync_times)
        ? (bc.sync_times as FinanceSyncSlot[])
        : [];
      if (!isAnySlotDue(now, slots)) continue;
      due++;

      try {
        const result = await runSynchronize(bc.id);
        if (result.state === "tan-required") {
          const tanReference = randomUUID();
          await db.insert(financeTanSession).values({
            tan_reference: tanReference,
            user_id: await firstResponsibleUser(bc.id),
            bankcontact_id: bc.id,
            banking_information: {
              bi: result.bankingInformation ?? {},
              fintsTanRef: result.tanReference ?? "",
            },
            challenge: result.tanChallenge ?? "",
            expires_at: new Date(Date.now() + TAN_SESSION_TTL_MS).toISOString(),
          });
          await notifyTanRequired(bc, tanReference, result.tanChallenge ?? "");
          await db
            .update(financeBankcontact)
            .set({
              last_sync_at: now.toISOString(),
              last_sync_status: "tan-required",
            })
            .where(eq(financeBankcontact.id, bc.id));
          tanRequired++;
          console.log(
            `[finance.cron] bankcontact=${bc.id} (${bc.name}) → tan-required, push sent`,
          );
        } else if (result.state === "idle") {
          // Pull statements + balances from the same live client —
          // avoids a second init-dialog-TAN round trip per cron tick.
          // Same plan and persistence as the manual triggerSync path
          // (linked accounts only, closed ones excluded, per-account
          // `from`). fetchAndPersist also handles a TAN the bank
          // demands mid-fetch for one account: it stores a
          // kind="statements" session and reports tan-required, so the
          // cron only has to notify the user. Without that the paused
          // account and every account queued behind it silently got
          // no data while the status still said "ok".
          const userId = await firstResponsibleUser(bc.id).catch(() => undefined);
          let resp: SyncApiResponse;
          try {
            resp = await fetchAndPersist(bc.id, result.client, { userId });
          } catch (fetchErr) {
            console.error(
              `[finance.cron] bankcontact=${bc.id} (${bc.name}) fetch/persist failed:`,
              fetchErr,
            );
            await db
              .update(financeBankcontact)
              .set({
                last_sync_at: now.toISOString(),
                last_sync_status: "error:fetch-failed",
              })
              .where(eq(financeBankcontact.id, bc.id));
            errored++;
            continue;
          }
          if (resp.state === "tan-required") {
            if (userId !== undefined) {
              await notifyTanRequired(bc, resp.tanReference ?? "", resp.challenge ?? "");
            }
            tanRequired++;
            console.log(
              `[finance.cron] bankcontact=${bc.id} (${bc.name}) → tan-required ` +
                `during statements fetch, push ${userId !== undefined ? "sent" : "skipped (no ACL)"}`,
            );
            continue;
          }
          if (resp.state === "error") {
            await db
              .update(financeBankcontact)
              .set({
                last_sync_at: now.toISOString(),
                last_sync_status: `error:${resp.errorCode}`,
              })
              .where(eq(financeBankcontact.id, bc.id));
            errored++;
            continue;
          }
          // fetchAndPersist wrote the status itself when it had a
          // client; without one (legacy mock) it returns zero counters
          // and leaves the row alone, so write it here as well.
          await db
            .update(financeBankcontact)
            .set({
              last_sync_at: now.toISOString(),
              last_sync_status: resp.partial ? "partial" : "ok",
            })
            .where(eq(financeBankcontact.id, bc.id));
          ok++;
          console.log(
            `[finance.cron] bankcontact=${bc.id} (${bc.name}) → ` +
              `${resp.partial ? "partial" : "ok"}: accounts=${resp.accounts_seen} ` +
              `(matched=${resp.accounts_matched} unknown=${resp.accounts_unknown}) ` +
              `tx=${resp.transactions_inserted} balances=${resp.balances_written}`,
          );
        } else {
          // state === "error"
          const code = result.errorCode ?? "unknown";
          await db
            .update(financeBankcontact)
            .set({
              last_sync_at: now.toISOString(),
              last_sync_status: `error:${code}`,
            })
            .where(eq(financeBankcontact.id, bc.id));
          errored++;
          console.error(
            `[finance.cron] bankcontact=${bc.id} (${bc.name}) → error: ${code} ${result.errorMessage ?? ""}`,
          );
        }
      } catch (err) {
        errored++;
        console.error(
          `[finance.cron] bankcontact=${bc.id} (${bc.name}) crashed:`,
          err,
        );
      }
    }

    console.log(
      `[finance.cron] sync tick: contacts=${bankcontacts.length} due=${due}`,
    );
    console.log(
      `[finance.cron] sync done: ok=${ok} tanRequired=${tanRequired} errored=${errored}`,
    );

    return {
      contacts_considered: bankcontacts.length,
      contacts_due: due,
      ok,
      tan_required: tanRequired,
      errored,
    };
  },
);

// -----------------------------------------------------------------------
// Slot evaluation
// -----------------------------------------------------------------------

/**
 * Returns true when at least one slot matches the given moment.
 * Exported for unit tests — production code only calls it via
 * syncStatements.
 */
export function isAnySlotDue(now: Date, slots: FinanceSyncSlot[]): boolean {
  return slots.some((slot) => isSlotDue(now, slot));
}

export function isSlotDue(now: Date, slot: FinanceSyncSlot): boolean {
  if (!Array.isArray(slot.weekdays) || slot.weekdays.length === 0) return false;
  if (!slot.time || !/^\d{2}:\d{2}$/.test(slot.time)) return false;
  const tz = slot.tz || "UTC";

  // Derive the slot's local representation via Intl.DateTimeFormat —
  // that handles DST transitions correctly without us needing a
  // timezone database.
  const parts = formatInTz(now, tz);
  const nowWeekday = parts.weekday;
  if (!slot.weekdays.includes(nowWeekday)) return false;

  const [slotHours, slotMinutes] = slot.time.split(":").map(Number);
  const slotMinutesTotal = slotHours * 60 + slotMinutes;
  const nowMinutesTotal = parts.hours * 60 + parts.minutes;
  const delta = Math.abs(nowMinutesTotal - slotMinutesTotal);
  // Handle midnight wraparound: both 23:59 and 00:01 should count as
  // "close" to 00:00 when tolerance is 2 minutes.
  const wraparound = Math.min(delta, 24 * 60 - delta);
  return wraparound <= SLOT_MATCH_TOLERANCE_MIN;
}

/**
 * Converts `date` into the given IANA time zone and extracts the
 * fields `isSlotDue` needs. Returns weekday as 0=Sunday … 6=Saturday
 * to match JavaScript's convention (and the slot schema in
 * docs/finance-data-model.md §2.3).
 */
function formatInTz(
  date: Date,
  timeZone: string,
): { weekday: number; hours: number; minutes: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const map = new Map<string, string>();
  for (const part of dtf.formatToParts(date)) {
    if (part.type !== "literal") map.set(part.type, part.value);
  }
  const weekdayName = map.get("weekday") ?? "Sun";
  const weekdayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    .indexOf(weekdayName);
  let hours = parseInt(map.get("hour") ?? "0", 10);
  if (hours === 24) hours = 0; // some locales emit 24:00 at midnight
  const minutes = parseInt(map.get("minute") ?? "0", 10);
  return {
    weekday: weekdayIndex >= 0 ? weekdayIndex : 0,
    hours,
    minutes,
  };
}

// -----------------------------------------------------------------------
// Who gets the push?
// -----------------------------------------------------------------------

/**
 * Picks the user ID that "owns" this bankcontact for the purpose of
 * TAN-required notifications. Preference order:
 *
 *   1. First ACL entry with level='write' on any account of this
 *      bankcontact (alphabetical by user_id for stability).
 *   2. First ACL entry with level='read' on any account of this
 *      bankcontact.
 *   3. Fall back to user_id=0 (no notifications possible, but the
 *      TAN session row still needs a FK target). Callers should
 *      skip the push in that case.
 *
 * Exported so tests can assert the selection logic without going
 * through the whole cron.
 */
export async function firstResponsibleUser(
  bankcontactId: number,
): Promise<number> {
  const rows = await db
    .select({
      user_id: financeAccountAccess.user_id,
      level: financeAccountAccess.level,
    })
    .from(financeAccountAccess)
    .innerJoin(
      financeAccount,
      eq(financeAccount.id, financeAccountAccess.account_id),
    )
    .where(eq(financeAccount.bankcontact_id, bankcontactId))
    .orderBy(financeAccountAccess.user_id);

  const write = rows.find((r) => r.level === "write");
  if (write) return write.user_id;
  const read = rows.find((r) => r.level === "read");
  if (read) return read.user_id;

  // No user is linked — TAN sessions still need a FK target, but we
  // can't notify anyone. Throw explicitly so the cron logs it rather
  // than silently linking to user 0 which may not exist.
  throw APIError.failedPrecondition(
    `bankcontact ${bankcontactId} has no ACL entries; cannot open a TAN session`,
  );
}

async function notifyTanRequired(
  bankcontact: typeof financeBankcontact.$inferSelect,
  tanReference: string,
  challenge: string,
): Promise<void> {
  let userId: number;
  try {
    userId = await firstResponsibleUser(bankcontact.id);
  } catch {
    return; // no one to notify
  }
  const payload: PushPayload = {
    title: `TAN erforderlich — ${bankcontact.name}`,
    body:
      challenge.length > 120
        ? `${challenge.slice(0, 117)}…`
        : challenge || "Bitte bestätigen Sie den Bank-Dialog in der TAN-App.",
    // Browser replaces any previous notification with the same tag,
    // which is our deduplication against cron retrying per-bankcontact.
    tag: `finance-tan-${bankcontact.id}`,
    data: {
      kind: "finance.tan_required",
      bankcontactId: bankcontact.id,
      tanReference,
    },
  };
  try {
    await sendToUser(userId, payload);
  } catch (err) {
    console.warn(
      `[finance.cron] push failed bankcontact=${bankcontact.id} user=${userId}:`,
      err,
    );
  }
}

// -----------------------------------------------------------------------
// Schedule registration (side effects at module load)
// -----------------------------------------------------------------------

// Local in-process scheduler — Encore CronJobs don't fire in self-host
// docker, see lib/local-cron.ts. The internal HTTP endpoints stay
// exposed for manual triggering.
schedule({
  name: "finance-sync-statements",
  description: "Iterate bankcontacts and run FinTS sync for slots that are due",
  service: "finance",
  scheduleLabel: `every ${CRON_INTERVAL_MINUTES}m`,
  nextFire: everyMs(CRON_INTERVAL_MINUTES * 60_000),
  run: () => syncStatements(),
});

schedule({
  name: "finance-tan-cleanup",
  description: "Delete expired TAN sessions",
  service: "finance",
  scheduleLabel: "every 1h",
  nextFire: everyMs(60 * 60_000),
  run: () => cleanupExpiredTanSessions(),
});
